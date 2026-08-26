/**
 * FR-RETENTION-3 — the send engine.
 *
 * Two properties matter more than anything else here:
 *
 *   1. NEVER send twice. A delivery attempt row is CLAIMED for each recipient
 *      before the provider is called, guarded by a unique idempotency key. Two
 *      concurrent Send requests race on the database, not on a disabled button;
 *      the loser sees the constraint violation and yields.
 *
 *   2. NEVER send to someone who opted out after review. The reviewed audience
 *      is the upper bound and is never widened, but suppression is re-checked
 *      immediately before each delivery so an opt-out during the review window
 *      is honoured.
 */

import type { PrismaClient, DeliveryFailureCategory } from '@prisma/client';
import type { OutreachEmailProvider, ProviderSendInput } from '@/lib/outreachProvider';
import { sealUnsubscribeToken, unsubscribeSecret } from '@/lib/outreachUnsubscribeToken';
import { applyUnsubscribeFooter } from '@/lib/outreachUnsubscribeFooter';

export interface SendableRecipient {
    recipientId: string;
    /** From the frozen snapshot — never re-derived from live contact data. */
    normalizedEmail: string | null;
    displayName: string;
    contactIds: string[];
    organizationNames: string[];
}

export interface SendOutcome {
    recipientId: string;
    result: 'accepted' | 'failed' | 'skipped_suppressed' | 'already_attempted';
    providerMessageId?: string | null;
    failureCategory?: DeliveryFailureCategory;
    failureDetail?: string;
}

export interface SendSummary {
    attempted: number;
    accepted: number;
    failed: number;
    skipped: number;
    alreadyAttempted: number;
    outcomes: SendOutcome[];
    /** Honest batch verdict the tenant sees. */
    batchStatus: 'completed' | 'completed_with_issues' | 'failed_before_send';
    /**
     * Set ONLY when the run was refused outright, before any recipient was
     * claimed or any provider call made. Distinguishes "the server cannot send
     * this safely" from "every delivery failed", which look identical in the
     * counts but need opposite responses: the first is a configuration problem
     * to report and retry unchanged, the second is a delivery problem.
     */
    refusal?: 'missing_unsubscribe_capability';
}

/** Deterministic — the same recipient and message always produce the same key. */
export function buildIdempotencyKey(messageId: string, recipientId: string, generation: number): string {
    return `${messageId}:${recipientId}:g${generation}`;
}

/**
 * Re-evaluates suppression at send time for one recipient.
 *
 * Only checks CURRENT state for the people this address represents plus the
 * address itself. Returns a reason when the send must be skipped.
 */
export async function checkSuppressionAtSend(
    prisma: PrismaClient,
    businessId: string,
    recipient: SendableRecipient,
    now: Date,
): Promise<{ suppressed: boolean; reason: string | null }> {
    if (!recipient.normalizedEmail) {
        return { suppressed: true, reason: 'No email address on file.' };
    }

    const prefs = await prisma.marketingPreference.findMany({
        where: {
            business_id: businessId,
            OR: [
                { scope: 'contact', contact_id: { in: recipient.contactIds } },
                { scope: 'email_address', normalized_email: recipient.normalizedEmail },
            ],
        },
        select: { scope: true, status: true, effective_until: true },
    });

    for (const p of prefs) {
        if (p.status === 'unsubscribed') {
            return {
                suppressed: true,
                reason: p.scope === 'email_address'
                    ? 'Someone at this address unsubscribed after the audience was reviewed.'
                    : 'This person unsubscribed after the audience was reviewed.',
            };
        }
        // An elapsed pause is not a suppression.
        if ((p.status === 'paused' || p.status === 'not_interested')
            && (!p.effective_until || p.effective_until > now)) {
            return { suppressed: true, reason: 'This contact was paused after the audience was reviewed.' };
        }
    }

    return { suppressed: false, reason: null };
}

export interface SendRunInput {
    prisma: PrismaClient;
    provider: OutreachEmailProvider;
    businessId: string;
    batchId: string;
    messageId: string;
    generation: number;
    recipients: SendableRecipient[];
    /**
     * Per-recipient rendered content.
     *
     * MAY BE ASYNC (FR-RETENTION-4). It is invoked AFTER the attempt row is
     * claimed and BEFORE the provider call — the one moment where we know this
     * particular delivery is definitely going to happen. That is exactly where
     * a per-recipient rebooking credential must be minted: minting earlier would
     * rotate the credential of someone whose email already went out, and minting
     * later would be after the point of no return.
     */
    render: (r: SendableRecipient) => { subject: string; html: string; text: string }
    | Promise<{ subject: string; html: string; text: string }>;
    from: string;
    replyTo?: string;
    now: Date;
    /**
     * OUTREACH-CONSENT-1 — where the per-recipient unsubscribe link points.
     *
     * REQUIRED, and required for a reason: this is promotional outreach, and a
     * promotional email a recipient cannot opt out of is the thing the whole
     * consent prerequisite exists to prevent. Making it optional would let a
     * future caller omit it by accident and never learn that they had.
     */
    unsubscribe: { origin: string; brandName?: string | null };
}

/**
 * Sends one audience. Sequential on purpose: it keeps provider pressure
 * predictable and makes per-recipient outcomes unambiguous.
 *
 * A failure for one recipient never rolls back the recipients already accepted
 * — their attempt rows persist, so a future retry can target only what failed
 * without re-sending to anyone who already received the message.
 */
export async function runSend(input: SendRunInput): Promise<SendSummary> {
    const { prisma, provider, businessId, batchId, messageId, generation, recipients, render, from, replyTo, now, unsubscribe } = input;

    const outcomes: SendOutcome[] = [];

    // ── OUTREACH-CONSENT-1 — REFUSE THE WHOLE RUN WITHOUT AN OPT-OUT ─────────
    //
    // Checked once, before the first claim, so a misconfigured server sends
    // nobody a promotional email it could not let them escape — rather than
    // failing recipient by recipient and leaving a trail of half-sent batches.
    // No attempt row is written, so the batch stays cleanly retryable once the
    // secret is configured.
    if (!unsubscribeSecret() || !unsubscribe?.origin) {
        return {
            attempted: 0, accepted: 0, failed: 0, skipped: 0, alreadyAttempted: 0,
            outcomes: [],
            batchStatus: 'failed_before_send',
            refusal: 'missing_unsubscribe_capability',
        };
    }

    for (const r of recipients) {
        const key = buildIdempotencyKey(messageId, r.recipientId, generation);

        // ── CLAIM ────────────────────────────────────────────────────────────
        // Create the attempt row BEFORE contacting the provider. If a
        // concurrent request already claimed this recipient, the unique index
        // rejects us and we skip — no second email.
        let attemptId: string;
        try {
            const created = await prisma.emailDeliveryAttempt.create({
                data: {
                    business_id: businessId,
                    outreach_batch_id: batchId,
                    outreach_recipient_id: r.recipientId,
                    outreach_message_id: messageId,
                    idempotency_key: key,
                    attempt_number: generation,
                    status: 'queued',
                    is_test: false,
                },
                select: { id: true },
            });
            attemptId = created.id;
        } catch {
            // Already claimed by another request or an earlier run.
            outcomes.push({ recipientId: r.recipientId, result: 'already_attempted' });
            continue;
        }

        // ── SUPPRESSION RECHECK ──────────────────────────────────────────────
        const suppression = await checkSuppressionAtSend(prisma, businessId, r, now);
        if (suppression.suppressed) {
            await prisma.emailDeliveryAttempt.update({
                where: { id: attemptId },
                data: { status: 'skipped_suppressed', skipped_at: now, failure_detail: suppression.reason },
            });
            outcomes.push({ recipientId: r.recipientId, result: 'skipped_suppressed', failureDetail: suppression.reason ?? undefined });
            continue;
        }

        // ── SEND ─────────────────────────────────────────────────────────────
        // If rendering itself fails (for example the rebooking credential could
        // not be written), the attempt is recorded as failed rather than left
        // dangling in `queued` — and because failed attempts stay retryable, the
        // recipient is not locked out of a later send.
        let content: { subject: string; html: string; text: string };
        try {
            content = await render(r);
        } catch {
            await prisma.emailDeliveryAttempt.update({
                where: { id: attemptId },
                data: {
                    status: 'failed',
                    failed_at: new Date(),
                    failure_category: 'unknown',
                    failure_detail: "We couldn't prepare this person's email.",
                },
            });
            outcomes.push({
                recipientId: r.recipientId,
                result: 'failed',
                failureCategory: 'unknown',
                failureDetail: "We couldn't prepare this person's email.",
            });
            continue;
        }

        // ── OUTREACH-CONSENT-1 — THE FOOTER THE SENDER CANNOT REMOVE ─────────
        //
        // Applied to the OUTPUT of render(), so nothing a tenant or coordinator
        // typed can delete it, reword it or retarget it: their text is already
        // finished by the time this runs. The token is sealed per recipient, so
        // one person's opt-out link can never appear in another's email.
        const withFooter = applyUnsubscribeFooter(content, {
            token: (await sealUnsubscribeToken({ businessId, email: r.normalizedEmail! })) ?? '',
            origin: unsubscribe.origin,
            brandName: unsubscribe.brandName ?? null,
        });

        if (!withFooter) {
            // No footer means no send. Recorded as failed and therefore
            // retryable — the recipient is not silently dropped.
            const detail = "We couldn't add an unsubscribe link to this email.";
            await prisma.emailDeliveryAttempt.update({
                where: { id: attemptId },
                data: { status: 'failed', failed_at: new Date(), failure_category: 'unknown', failure_detail: detail },
            });
            outcomes.push({ recipientId: r.recipientId, result: 'failed', failureCategory: 'unknown', failureDetail: detail });
            continue;
        }

        const payload: ProviderSendInput = {
            to: r.normalizedEmail!,
            subject: withFooter.subject,
            html: withFooter.html,
            text: withFooter.text,
            from,
            replyTo,
            headers: withFooter.headers,
        };

        const result = await provider.send(payload);

        if (result.outcome === 'accepted') {
            await prisma.emailDeliveryAttempt.update({
                where: { id: attemptId },
                // `accepted`, never `delivered` — see lib/outreachProvider.
                data: { status: 'accepted', accepted_at: new Date(), provider_message_id: result.providerMessageId },
            });
            outcomes.push({ recipientId: r.recipientId, result: 'accepted', providerMessageId: result.providerMessageId });
        } else {
            await prisma.emailDeliveryAttempt.update({
                where: { id: attemptId },
                data: { status: 'failed', failed_at: new Date(), failure_category: result.category, failure_detail: result.detail },
            });
            outcomes.push({ recipientId: r.recipientId, result: 'failed', failureCategory: result.category, failureDetail: result.detail });
        }
    }

    const accepted = outcomes.filter((o) => o.result === 'accepted').length;
    const failed = outcomes.filter((o) => o.result === 'failed').length;
    const skipped = outcomes.filter((o) => o.result === 'skipped_suppressed').length;
    const alreadyAttempted = outcomes.filter((o) => o.result === 'already_attempted').length;

    const batchStatus: SendSummary['batchStatus'] =
        accepted === 0 && (failed > 0 || outcomes.length === 0) ? 'failed_before_send'
            : failed > 0 || skipped > 0 ? 'completed_with_issues'
                : 'completed';

    return { attempted: outcomes.length, accepted, failed, skipped, alreadyAttempted, outcomes, batchStatus };
}
