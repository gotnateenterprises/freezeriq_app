/**
 * FR-REBOOK-2 — the previous-supporter audience, for the coordinator running
 * THIS campaign. PREVIOUS-SUPPORTER-EMAIL-2.0 — and the individual, personalized
 * invitations the coordinator chooses to send them.
 *
 * ── AUTHORITY ───────────────────────────────────────────────────────────────
 *
 * Everything is derived from the coordinator's session cookie:
 *
 *     session cookie -> campaign id -> organization -> tenant -> prior campaigns
 *
 * Nothing in the request may influence that chain. There is no campaign id, no
 * organization id, no business id and no customer id in the query string or the
 * body, so there is no parameter to tamper with — a coordinator cannot reach
 * another organization's supporters by editing a URL, because no URL says which
 * organization they are asking about.
 *
 * ── WHAT LEAVES THE SERVER ──────────────────────────────────────────────────
 *
 * Counts, names, masked addresses and an opaque per-campaign reference for each
 * supporter who can be emailed. No full email address, no export, no "copy all",
 * and never a supporter belonging to another organization. The list is bounded
 * so a large history cannot turn this into a data dump.
 *
 * ── WHO vs WHAT (PREVIOUS-SUPPORTER-EMAIL-2.0) ──────────────────────────────
 *
 * Historical orders decide WHO may be invited. The CURRENT campaign decides WHAT
 * they read — its menu, its deadline, its pickup details and its canonical
 * ordering URL (lib/previousSupporterInvitation.ts). Invitations exist only while
 * this fundraiser is actually open for supporter orders.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { describePreviousSupporters } from '@/lib/previousSupporters';
import { loadPreviousSupporterAudience } from '@/lib/previousSupporterAudience';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { validateInviteMessage } from '@/lib/previousSupporterInvite';
import {
    resolveCampaignBatch,
    syncCampaignRecipients,
    resolveCampaignMessage,
} from '@/lib/previousSupporterBatch';
import { runSend } from '@/lib/outreachSend';
import { ResendOutreachProvider } from '@/lib/outreachProvider';
import { unsubscribeSecret } from '@/lib/outreachUnsubscribeToken';
import { getTenantSender } from '@/lib/email';
import { safeSubject } from '@/lib/emailTemplates';
import {
    defaultInvitationMessage,
    defaultInvitationSubject,
    findPrivateLinkInMessage,
    headerSafeReplyTo,
    organizationFromHeader,
    renderPreviousSupporterEmail,
    PREVIOUS_SUPPORTER_SEND_CONFIRMATION,
} from '@/lib/previousSupporterEmail';
import {
    buildSupporterRows,
    countConsented,
    INVITATION_CAMPAIGN_SELECT,
    loadCampaignEmailHistory,
    loadInvitationFacts,
    resolveSelection,
    type InvitationAvailability,
} from '@/lib/previousSupporterInvitation';
import {
    describeAutomatedSend,
    loadExplicitEmailConsent,
    loadOrganizationMailingAddress,
    type AutomatedSendGate,
} from '@/lib/previousSupporterAuthorities';
import { CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT, resolveCampaignCoordinator, type CoordinatorAssignmentRow } from '@/lib/campaignCoordinatorContact';

/**
 * A page of names, not a mailing list. Large enough that a real organization's
 * whole email-reachable history fits — the coordinator selects from it — while
 * still bounded. Only masked addresses are ever in it.
 */
const SUPPORTER_PREVIEW_LIMIT = 200;

/**
 * Why the send control is not armed.
 *
 * Stated as a machine code plus prose so the UI never has to guess, and so this
 * turns into a real capability by deleting one constant rather than by rewriting
 * the surface.
 */
export interface SendCapability {
    canSend: boolean;
    code:
        | 'ready' | 'no_reachable_audience' | 'no_order_link' | 'outreach_consent_unavailable'
        | 'ordering_closed' | 'not_open_yet' | 'menu_pending' | 'menu_unavailable'
        | 'mailing_address_required' | 'consent_not_recorded';
    reason: string;
}

/**
 * Whether this coordinator can actually send right now — derived, never assumed.
 *
 * Each refusal names a DIFFERENT missing precondition, because "you cannot send"
 * with no reason is what made the earlier disabled button read as a bug. Edgar
 * lands on no_reachable_audience: 17 real previous supporters, none with an email
 * address, so there is genuinely nobody to write to.
 *
 * PREVIOUS-SUPPORTER-EMAIL-2.0: `invitation` is whether THIS fundraiser is open
 * for supporter orders right now. An invitation to a closed, unlaunched or
 * menu-less fundraiser is refused with that fundraiser's own reason.
 *
 * PREVIOUS-SUPPORTER-EMAIL-2.0A: `automated` is whether FreezerIQ may send at all —
 * the organization's mailing address and RECORDED future-email permission
 * (lib/previousSupporterAuthorities). The handlers always pass it, together with a
 * reachableCount that counts only consented supporters.
 */
export function resolveSendCapability(input: {
    reachableCount: number;
    orderUrl: string | null;
    unsubscribeReady: boolean;
    invitation?: InvitationAvailability | null;
    automated?: AutomatedSendGate | null;
}): SendCapability {
    if (!input.unsubscribeReady) {
        return {
            canSend: false,
            code: 'outreach_consent_unavailable',
            reason: 'Sending is not configured yet, so invitations cannot go out. Nothing has been sent.',
        };
    }
    if (input.invitation && !input.invitation.open && input.invitation.code !== 'no_order_link') {
        return { canSend: false, code: input.invitation.code as SendCapability['code'], reason: input.invitation.reason };
    }
    if (!input.orderUrl) {
        return {
            canSend: false,
            code: 'no_order_link',
            reason: 'This fundraiser has no online ordering page yet, so there is nowhere to send supporters.',
        };
    }
    if (input.automated && !input.automated.available) {
        return { canSend: false, code: input.automated.code as SendCapability['code'], reason: input.automated.reason };
    }
    if (input.reachableCount <= 0) {
        return {
            canSend: false,
            code: 'no_reachable_audience',
            reason: 'No previous supporters with a usable email address were found, so there is nobody to invite.',
        };
    }
    return {
        canSend: true,
        code: 'ready',
        reason: `${input.reachableCount} previous ${input.reachableCount === 1 ? 'supporter' : 'supporters'} can be invited by email.`,
    };
}

/**
 * Everything the preview and the send must agree about, resolved from the
 * coordinator's campaign and nothing else.
 *
 * GET and POST both call these. That is deliberate: if the send recomputed the
 * audience through a second code path, a divergence between them would mean the
 * coordinator approved one list and a different list got mailed.
 */
async function loadCampaignContext(campaignId: string) {
    const campaign = await prisma.fundraiserCampaign.findFirst({
        where: { id: campaignId },
        select: INVITATION_CAMPAIGN_SELECT,
    });
    if (!campaign?.customer?.business_id) return null;
    return {
        campaign,
        businessId: campaign.customer.business_id,
        organizationCustomerId: campaign.customer_id,
    };
}

/**
 * The audience, recomputed from durable data every time it is asked for.
 *
 * FR-ORG-DASHBOARD-1A: the assembly (prior campaigns, organizations, orders,
 * email-address opt-outs through evaluateSuppression) moved, unchanged, into
 * lib/previousSupporterAudience.ts so the tenant's organization dashboard counts
 * email-ready supporters through this exact path rather than a copy of it.
 *
 * The current campaign is excluded by id: someone who ordered today is a
 * current supporter, not a previous one.
 */
async function computeAudience(input: {
    businessId: string; organizationCustomerId: string; campaignId: string;
}) {
    return loadPreviousSupporterAudience(prisma, {
        businessId: input.businessId,
        organizationCustomerId: input.organizationCustomerId,
        excludeCampaignId: input.campaignId,
        now: new Date(),
    });
}

type CampaignContext = NonNullable<Awaited<ReturnType<typeof loadCampaignContext>>>;

/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0A — what FreezerIQ must PROVE before sending itself:
 * the organization's mailing address and each person's recorded future-email
 * permission. Both authorities answer "none" today (lib/previousSupporterAuthorities),
 * so `automated.available` is false and no previous supporter is selectable — while
 * "Open in my email" stays available. Read for THIS campaign's organization only.
 */
async function loadAutomatedAuthorities(ctx: CampaignContext, audience: Awaited<ReturnType<typeof computeAudience>>) {
    const scope = { businessId: ctx.businessId, organizationCustomerId: ctx.organizationCustomerId };
    const mailingAddress = await loadOrganizationMailingAddress(scope);
    const consent = await loadExplicitEmailConsent(scope);
    const consentedCount = countConsented(audience, consent);
    return { mailingAddress, consent, consentedCount, automated: describeAutomatedSend({ mailingAddress, consentedCount }) };
}

export async function GET(req: Request) {
    try {
        // Authority: the session cookie, never the URL.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;

        const ctx = await loadCampaignContext(campaignId);
        if (!ctx) {
            // Same shape a missing campaign gets: a coordinator learns nothing
            // about what does or does not exist.
            return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
        }
        const { campaign, businessId, organizationCustomerId } = ctx;
        const audience = await computeAudience({ businessId, organizationCustomerId, campaignId });
        const { availability, facts } = await loadInvitationFacts(campaign);
        const history = await loadCampaignEmailHistory(prisma, {
            businessId, customerId: organizationCustomerId, campaignId,
        });
        const { consent, consentedCount, automated } = await loadAutomatedAuthorities(ctx, audience);
        const supporters = buildSupporterRows({
            campaignId, audience, history, invitationsOpen: availability.open,
            gate: automated, consent, limit: SUPPORTER_PREVIEW_LIMIT,
        });

        return NextResponse.json({
            ...describePreviousSupporters(audience),
            counts: {
                supporters: audience.supporterCount,
                reachable: audience.reachableCount,
                noEmail: audience.noEmailCount,
                suppressed: audience.suppressedCount,
                legitimateOrders: audience.legitimateOrders,
                duplicatesCollapsed: audience.duplicatesCollapsed,
                // Already handled for THIS fundraiser — not the same as reachable.
                emailedThisFundraiser: [...history.values()].filter((h) => h.status === 'emailed').length,
                // With RECORDED future-email permission — the only people FreezerIQ may email itself.
                consented: consentedCount,
            },
            // Names, masked addresses and opaque references. Never a usable mailing list.
            supporters,
            truncated: audience.supporterCount > SUPPORTER_PREVIEW_LIMIT,
            invitation: { open: availability.open, code: availability.code, reason: availability.reason },
            // FreezerIQ's own sending: available only with the organization's
            // mailing address AND recorded permission. Coordinator-facing wording.
            automated: { available: automated.available, code: automated.code, reason: automated.reason },
            // The coordinator edits the subject and the message. The facts below
            // are shown read-only: the server adds them to every email.
            draft: {
                subject: defaultInvitationSubject(campaign.customer?.name),
                text: defaultInvitationMessage(campaign.customer?.name),
                orderUrl: facts?.orderUrl ?? null,
                deadlineLabel: facts?.deadlineLabel ?? null,
                facts: facts
                    ? { bundleNames: facts.bundleNames, deadlineLabel: facts.deadlineLabel, pickup: facts.pickup }
                    : null,
            },
            send: resolveSendCapability({
                reachableCount: consentedCount,
                orderUrl: facts?.orderUrl ?? null,
                unsubscribeReady: Boolean(unsubscribeSecret()),
                invitation: availability,
                automated,
            }),
        });
    } catch (e) {
        console.error('FR-REBOOK-2 previous-supporters error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}

/**
 * POST — FreezerIQ sends ONE SEPARATE, PERSONALIZED EMAIL to each previous
 * supporter the coordinator selected and confirmed — and ONLY to those with
 * recorded permission for future fundraiser email, when the organization's
 * mailing address is on file. (The coordinator's own "Open in my email" draft is
 * a different route, ./draft, and sends nothing.)
 *
 * ── WHAT THE CLIENT SENDS ───────────────────────────────────────────────────
 *
 * The edited `subject` and `text`, the opaque references the coordinator ticked,
 * and the confirmation literal. No address, no campaign id, no organization id,
 * no business id, no batch id and no ordering URL. Every one of those is
 * recomputed here from the coordinator's session, exactly as the GET recomputes
 * them, and the references are matched only inside that recomputed audience —
 * so a selection can narrow who is emailed, never widen it.
 *
 * ── ONE MESSAGE PER PERSON, FROM THE ORGANIZATION ───────────────────────────
 *
 * runSend makes one provider call per recipient with that single address in
 * `to` — no CC, no BCC, no shared list. The greeting is rendered per recipient
 * from that recipient's own row. The From display name is "{Organization} via
 * {tenant}" on the platform's own verified address; Reply-To is the campaign's
 * coordinator (lib/campaignCoordinatorContact), else the tenant's contact.
 *
 * ── NEVER TWICE ─────────────────────────────────────────────────────────────
 *
 * runSend claims an EmailDeliveryAttempt per recipient BEFORE calling the
 * provider; the partial unique index email_delivery_attempts_one_live_per_recipient
 * then refuses any second queued/accepted/skipped attempt for the same person on
 * this campaign's one message row — whatever the wording, however many times
 * Send is clicked or retried. Only an attempt that definitely FAILED can be
 * retried, and only when the coordinator selects that person again.
 */
export async function POST(req: Request) {
    try {
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;

        const ctx = await loadCampaignContext(campaignId);
        if (!ctx) return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
        const { campaign, businessId, organizationCustomerId } = ctx;

        const origin = resolveOutreachOrigin(req);
        const audience = await computeAudience({ businessId, organizationCustomerId, campaignId });
        const { availability, facts } = await loadInvitationFacts(campaign);
        const { mailingAddress, consent, consentedCount, automated } = await loadAutomatedAuthorities(ctx, audience);

        // ── CAN WE SEND AT ALL? Re-derived, never trusted from the client. ──
        const capability = resolveSendCapability({
            reachableCount: consentedCount,
            orderUrl: facts?.orderUrl ?? null,
            unsubscribeReady: Boolean(unsubscribeSecret()),
            invitation: availability,
            automated,
        });
        if (!capability.canSend) {
            return NextResponse.json({ ok: false, ...capability }, { status: 409 });
        }
        if (!facts || !mailingAddress) {
            return NextResponse.json({ ok: false, code: automated.code, reason: automated.reason }, { status: 409 });
        }

        // ── THE EXPLICIT CONFIRMATION, THEN THE COORDINATOR'S WORDS ─────────
        let body: any = {};
        try { body = await req.json(); } catch { /* validated below */ }
        if (body?.confirm !== PREVIOUS_SUPPORTER_SEND_CONFIRMATION) {
            return NextResponse.json(
                { ok: false, code: 'not_confirmed', error: 'Review the email and confirm before anything is sent. Nothing was sent.' },
                { status: 400 },
            );
        }
        const validated = validateInviteMessage({
            subject: body?.subject, text: body?.text, orderUrl: facts.orderUrl,
        });
        if (!validated.ok) {
            return NextResponse.json({ ok: false, code: validated.code, error: validated.error }, { status: 400 });
        }
        const privateLink = findPrivateLinkInMessage(validated.subject, validated.text);
        if (privateLink) {
            return NextResponse.json({ ok: false, code: 'private_link', error: privateLink }, { status: 400 });
        }

        // ── WHO, out of the audience the SERVER just recomputed ─────────────
        const history = await loadCampaignEmailHistory(prisma, {
            businessId, customerId: organizationCustomerId, campaignId,
        });
        const selection = resolveSelection({ campaignId, refs: body?.selected, audience, history, consent });
        if (!selection) {
            return NextResponse.json(
                { ok: false, code: 'nothing_selected', error: 'Choose at least one supporter to email. Nothing was sent.' },
                { status: 400 },
            );
        }

        // ── WHO IT IS FROM ──────────────────────────────────────────────────
        // The organization is the designated sender; the platform's verified
        // address is the technical From. Never the organization's own domain.
        const tenantSender = await getTenantSender(businessId);
        const organizationName = campaign.customer?.name ?? '';
        const tenantName = campaign.customer?.business?.name ?? '';
        const from = organizationFromHeader({ organizationName, tenantName, platformFrom: tenantSender.from });
        if (!from) {
            return NextResponse.json({ ok: false, code: 'sender_unavailable', error: 'The sender could not be prepared, so nothing was sent.' }, { status: 409 });
        }
        const assignment = await prisma.fundraiserCampaignCoordinator.findUnique({
            where: { campaign_id: campaignId },
            select: CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT,
        }) as CoordinatorAssignmentRow | null;
        const coordinator = resolveCampaignCoordinator({ assignment, organization: campaign.customer });
        const replyTo = headerSafeReplyTo(coordinator.email) ?? tenantSender.replyTo;
        const senderIdentity = { organizationName, tenantName, mailingAddress };

        const subject = safeSubject(validated.subject);
        // The neutral rendering is what the batch records as "the message": the
        // only per-person difference in what actually goes out is the greeting.
        const record = renderPreviousSupporterEmail({ greetingName: null, subject, message: validated.text, facts, sender: senderIdentity });
        if (!record) {
            return NextResponse.json(
                { ok: false, code: 'no_order_link', error: capability.reason }, { status: 409 });
        }

        const notSent = selection.notSent;
        if (selection.toSend.length === 0) {
            return NextResponse.json({
                ok: true, accepted: 0, failed: 0, skipped: 0, alreadySent: 0, outcome: 'nothing_to_send', notSent,
            });
        }

        // ── THE DURABLE BATCH — one per campaign, forever ───────────────────
        const batch = await resolveCampaignBatch(prisma, {
            businessId, customerId: organizationCustomerId, campaignId,
        });
        const recipientRows = await syncCampaignRecipients(prisma, {
            businessId, batchId: batch.id, supporters: selection.toSend,
        });
        const message = await resolveCampaignMessage(prisma, {
            businessId, batchId: batch.id, subject, html: record.html, text: record.text,
        });

        // A deliberate retry of someone whose attempt at this exact wording
        // FAILED needs its own claim key. Anyone with a live attempt is still
        // refused by the database, whatever key is used.
        const priorFailed = await prisma.emailDeliveryAttempt.findMany({
            where: {
                business_id: businessId, outreach_batch_id: batch.id, outreach_message_id: message.id,
                outreach_recipient_id: { in: recipientRows.map((r) => r.recipientId) },
                attempt_number: message.version, status: 'failed', is_test: false,
            },
            select: { outreach_recipient_id: true },
        });
        const retries = new Map<string, number>();
        for (const a of priorFailed) retries.set(a.outreach_recipient_id, (retries.get(a.outreach_recipient_id) ?? 0) + 1);

        const summary = await runSend({
            prisma,
            provider: new ResendOutreachProvider(),
            businessId,
            batchId: batch.id,
            messageId: message.id,
            generation: message.version,
            recipients: recipientRows.map((r) => ({
                recipientId: r.recipientId,
                normalizedEmail: r.normalizedEmail,
                displayName: r.displayName,
                contactIds: [],
                organizationNames: [],
                retryOrdinal: retries.get(r.recipientId) ?? 0,
            })),
            // ONE recipient per call: the greeting comes from THIS recipient's own
            // row, and nothing about any other supporter is in scope here. The
            // footer and headers are added per recipient inside the engine.
            render: (r) => {
                const rendered = renderPreviousSupporterEmail({
                    greetingName: r.displayName, subject, message: validated.text, facts, sender: senderIdentity,
                });
                if (!rendered) throw new Error('no ordering link');
                return rendered;
            },
            from,
            replyTo,
            now: new Date(),
            unsubscribe: { origin, brandName: organizationName || null },
        });

        if (summary.refusal) {
            return NextResponse.json(
                {
                    ok: false,
                    code: summary.refusal,
                    error: 'Sending is not configured yet, so nothing was sent. Nobody was contacted.',
                },
                { status: 503 },
            );
        }

        // ── TRUTHFUL COUNTS ─────────────────────────────────────────────────
        // Never "sent to 34" when 31 were accepted. `accepted` means the provider
        // took it, which is not the same as delivered, and the wording says so.
        return NextResponse.json({
            ok: true,
            batchResolution: batch.how,
            accepted: summary.accepted,
            failed: summary.failed,
            skipped: summary.skipped,
            alreadySent: summary.alreadyAttempted,
            outcome: summary.batchStatus,
            notSent,
        });
    } catch (e) {
        console.error('FR-REBOOK-2 previous-supporters send error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}