/**
 * FR-ACCEPTANCE-2A.1 — the automatic acknowledgement for a public inquiry.
 *
 * A volunteer fills in the public fundraiser form and, today, sees a thank-you
 * screen and then nothing until a human at the tenant notices the lead. This
 * sends them the tenant's approved introduction immediately, in the tenant's own
 * brand, exactly once per inquiry.
 *
 * ── WHY THIS IS NOT sendLeadNotificationEmail's TWIN ────────────────────────
 *
 * That function mails the TENANT about a new lead, and it gates on
 * RESEND_API_KEY alone. Tolerable when the recipient is the account owner: the
 * worst case is a developer mailing themselves.
 *
 * This mails a MEMBER OF THE PUBLIC. Copying that gate would mean any
 * environment holding a key — a branch preview, a local box with a copied
 * .env — would send real mail to real volunteers from a real tenant's brand.
 * So this requires EMAIL_LIVE as well, and the gate is resolved BEFORE anything
 * durable is written, so safety mode leaves no trace that could later be read as
 * "acknowledged".
 *
 * ── THE CLAIM BELONGS TO THE ROW, NOT TO THE REQUEST ────────────────────────
 *
 * The right to send is claimed with a conditional write on the inquiry itself,
 * never inferred from "this HTTP request created the row". That distinction is
 * what makes recovery possible: if a request persists an inquiry and dies before
 * reaching the provider, the inquiry is left claimable, and a later legitimate
 * retry resolving that same canonical inquiry can still send the acknowledgement
 * that was owed. A request-scoped flag would have stranded that person forever.
 *
 * The same conditional write is what stops a double submission sending twice.
 * One caller moves ack_claimed_at out of null; every concurrent caller matches
 * zero rows and stops before the provider is reached.
 *
 * This is the FR-ACCEPTANCE-2A coordinator-email idiom applied to a second
 * surface, deliberately unchanged, including the rule that only provider
 * acceptance may write the "sent" column.
 */

import { prisma } from '@/lib/db';
import { EMAIL_TEMPLATES } from '@/lib/emailTemplates';
import { resolveTenantBrand } from '@/lib/tenantBrand';
import { getTenantSender } from '@/lib/email';

/**
 * What happened, in enough detail for the tenant's own lead alert to tell the
 * truth about it. Every value is a fact, never a guess.
 */
export type AcknowledgementOutcome =
    /** Provider accepted AND ack_sent_at is recorded. */
    | 'sent'
    /** Provider accepted but recording it failed. The email is out; the row cannot prove it. */
    | 'sent_unrecorded'
    /** Safety mode. Nothing sent, nothing written, inquiry still needs a reply. */
    | 'skipped_not_live'
    /** Another attempt already got provider acceptance for this inquiry. */
    | 'skipped_already_sent'
    /** Another attempt holds the claim and never resolved. */
    | 'skipped_in_progress'
    /** No usable recipient on the inquiry. */
    | 'skipped_no_recipient'
    /** The provider EXPLICITLY rejected it. Claim released; a retry may happen later. */
    | 'rejected'
    /** The send threw. We cannot say whether it left. Claim held. */
    | 'uncertain'
    /** Something failed before the provider was reached. Nothing was sent. */
    | 'failed';

export interface AcknowledgementResult {
    outcome: AcknowledgementOutcome;
    /** Set only when the provider accepted AND the write succeeded. */
    sentAt: Date | null;
}

/** The outcomes that mean a real person still has nothing from us. */
export function acknowledgementNeedsAttention(outcome: AcknowledgementOutcome): boolean {
    return outcome === 'skipped_not_live'
        || outcome === 'skipped_no_recipient'
        || outcome === 'rejected'
        || outcome === 'failed';
}

/**
 * Attempt the one automatic acknowledgement for a canonical inquiry.
 *
 * NEVER throws — the caller is a public intake whose primary job is already
 * done, and a mail problem must not turn a saved lead into an error page.
 *
 * NEVER writes FundraiserOpportunity.first_response_at. That column means a
 * person at the tenant replied, and this is not that.
 */
export async function attemptInquiryAcknowledgement(
    inquiryId: string,
    businessId: string
): Promise<AcknowledgementResult> {
    /**
     * Whether this call currently holds the claim, and whether the provider has
     * been reached.
     *
     * These decide what the outer catch must do. Between taking the claim and
     * calling the provider there are several awaited statements — a business
     * lookup, a dynamic import — any of which can throw on a transient database
     * or module error. Without this, such a throw left ack_claimed_at set with
     * nothing sent and no way back: every later replay matched zero rows, the
     * inquiry became permanently un-acknowledgeable, and the CRM reported
     * "delivery was never confirmed" for a provider that was never reached.
     *
     * Once the provider HAS been called the claim must be held instead, because
     * from that moment we can no longer prove nothing went out.
     */
    let holdsClaim = false;
    let providerReached = false;
    try {
        // ── SAFETY GATE FIRST, BEFORE ANY DURABLE WRITE ─────────────────────
        //
        // Resolved ahead of the claim so that safety mode leaves ack_claimed_at
        // and ack_sent_at both null. If this ran after the claim, every inquiry
        // taken on a non-live environment would be permanently marked as
        // "acknowledgement in progress" and could never be acknowledged for real.
        const isLive = process.env.RESEND_API_KEY && process.env.EMAIL_LIVE === 'true';
        if (!isLive) {
            console.log(`[SAFETY MODE / MOCK EMAIL] inquiry acknowledgement for ${inquiryId} — nothing sent, nothing recorded`);
            return { outcome: 'skipped_not_live', sentAt: null };
        }

        // The recipient comes from the durable row, never from the request body.
        // The intake has already validated and stored it; re-reading it here
        // means no client can redirect an acknowledgement to an address of its
        // choosing by replaying a submission key.
        const inquiry = await prisma.fundraiserInquiry.findFirst({
            where: { id: inquiryId, business_id: businessId },
            select: {
                id: true,
                contact_name: true,
                contact_email: true,
                organization_name: true,
                ack_claimed_at: true,
                ack_sent_at: true,
            },
        });
        if (!inquiry) {
            console.error(`[INQUIRY_ACK] inquiry ${inquiryId} not found for business ${businessId}`);
            return { outcome: 'failed', sentAt: null };
        }
        const to = (inquiry.contact_email ?? '').trim();
        if (!to) {
            return { outcome: 'skipped_no_recipient', sentAt: null };
        }

        // ── THE CLAIM ───────────────────────────────────────────────────────
        //
        // One statement, condition in the WHERE clause. Postgres takes the row
        // lock and re-evaluates the qualifier under READ COMMITTED, so exactly
        // one concurrent caller sees count === 1.
        const claim = await prisma.fundraiserInquiry.updateMany({
            where: { id: inquiryId, ack_claimed_at: null, ack_sent_at: null },
            data: { ack_claimed_at: new Date() },
        });

        if (claim.count === 1) holdsClaim = true;

        if (claim.count === 0) {
            // Lost, or already done. Either way the provider must not be called
            // again. Read the row rather than guessing which it is, because the
            // two mean different things to the tenant.
            const current = await prisma.fundraiserInquiry.findUnique({
                where: { id: inquiryId },
                select: { ack_claimed_at: true, ack_sent_at: true },
            });
            if (current?.ack_sent_at) {
                return { outcome: 'skipped_already_sent', sentAt: current.ack_sent_at };
            }
            return { outcome: 'skipped_in_progress', sentAt: null };
        }

        // ── Brand ───────────────────────────────────────────────────────────
        //
        // The same authority FR-ACCEPTANCE-2A established: display_name falling
        // back to name, custom_domain falling back to the canonical storefront.
        // Never TenantBranding, whose business_name defaults to a literal.
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { name: true, display_name: true, custom_domain: true, contact_email: true, slug: true },
        });
        const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
        const brand = business ? resolveTenantBrand(business, base) : null;

        const { subject, html } = EMAIL_TEMPLATES.lead_intro(
            inquiry.contact_name,
            inquiry.organization_name,
            brand
                ? {
                      name: brand.name,
                      email: business?.contact_email ?? undefined,
                      site: brand.websiteUrl ?? undefined,
                      siteLabel: brand.websiteLabel ?? undefined,
                  }
                : undefined
        );

        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const sender = await getTenantSender(businessId);

        let data: Awaited<ReturnType<typeof resend.emails.send>>;
        // From here on we can no longer prove that nothing left the building, so
        // the claim is held on every path — including an unexpected throw.
        providerReached = true;
        try {
            data = await resend.emails.send({
                from: sender.from,
                to: [to],
                replyTo: sender.replyTo,
                subject,
                html,
            });
        } catch (sendErr) {
            // THREW. Whether the message left is unknown. Releasing the claim
            // would risk a second acknowledgement landing on someone who already
            // has one; holding it risks a person who got nothing. The tenant is
            // told the state is uncertain and can reply by hand, which is the
            // safer of the two — and the reason the CRM raises this above a
            // routine follow-up.
            console.error(
                `[INQUIRY_ACK] send outcome UNKNOWN for inquiry ${inquiryId} — claim held, ack_sent_at remains null`,
                sendErr
            );
            return { outcome: 'uncertain', sentAt: null };
        }

        if (data.error) {
            // An EXPLICIT rejection: the one outcome where we know for certain
            // nothing was queued. The claim describes an attempt that provably
            // did not happen, so it is released. ack_sent_at was never touched.
            console.error(`[INQUIRY_ACK] provider rejected the acknowledgement for inquiry ${inquiryId}:`, data.error);
            await prisma.fundraiserInquiry.updateMany({
                where: { id: inquiryId },
                data: { ack_claimed_at: null },
            }).catch((releaseErr) => {
                // Could not release. The row now blocks a retry for a send that
                // never happened — but it still does NOT claim one was sent.
                console.error(
                    `[INQUIRY_ACK] could not release the claim for inquiry ${inquiryId} — ` +
                    'ack_claimed_at is set but NO email was sent; ack_sent_at remains null',
                    releaseErr
                );
            });
            return { outcome: 'rejected', sentAt: null };
        }

        // ── THE ONLY WRITE THAT MAY SET ack_sent_at ─────────────────────────
        const sentAt = new Date();
        try {
            await prisma.fundraiserInquiry.update({
                where: { id: inquiryId },
                data: { ack_sent_at: sentAt },
            });
        } catch (recordErr) {
            // The email is in flight or already delivered. Saying it failed
            // would be false and would invite a duplicate, so the claim is HELD
            // and the durable state stays claimed-but-unconfirmed — which is
            // exactly what we can prove.
            console.error(
                `[INQUIRY_ACK] acknowledgement ACCEPTED by the provider for inquiry ${inquiryId} ` +
                'but ack_sent_at could not be recorded — claim held, do NOT resend',
                recordErr
            );
            return { outcome: 'sent_unrecorded', sentAt: null };
        }

        return { outcome: 'sent', sentAt };
    } catch (err) {
        // Belt and braces. This runs after a lead is already durable, so nothing
        // in here may propagate and turn a saved inquiry into a failed request.
        console.error(`[INQUIRY_ACK] unexpected failure for inquiry ${inquiryId}`, err);

        if (holdsClaim && !providerReached) {
            // We hold a claim for a send that PROVABLY never happened — the
            // throw came from a statement before the provider was reached. The
            // claim describes an attempt that did not occur, so it is released
            // and this inquiry stays recoverable. Leaving it set would strand
            // the person who wrote in: every later replay would match zero rows,
            // and the CRM would report an unconfirmed delivery for a provider
            // that was never called.
            await prisma.fundraiserInquiry.updateMany({
                where: { id: inquiryId, ack_sent_at: null },
                data: { ack_claimed_at: null },
            }).catch((releaseErr) => {
                console.error(
                    `[INQUIRY_ACK] could not release the claim for inquiry ${inquiryId} after a ` +
                    'pre-provider failure — ack_claimed_at is set but NO email was sent',
                    releaseErr
                );
            });
            return { outcome: 'failed', sentAt: null };
        }

        if (providerReached) {
            // The provider was called and the outcome is unknown. Holding the
            // claim is the safer of two bad options: a duplicate introduction to
            // someone who already has one is worse than one we cannot confirm.
            return { outcome: 'uncertain', sentAt: null };
        }

        return { outcome: 'failed', sentAt: null };
    }
}
