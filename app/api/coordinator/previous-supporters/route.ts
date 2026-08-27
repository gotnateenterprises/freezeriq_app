/**
 * FR-REBOOK-2 — the previous-supporter audience, for the coordinator running
 * THIS campaign.
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
 * ── READ ONLY, DELIBERATELY ─────────────────────────────────────────────────
 *
 * GET only. Viewing an audience creates nothing: no Customer, no Order, no
 * participation record, and no change to any past campaign. A previous supporter
 * joins the new fundraiser by placing a new order and in no other way.
 *
 * There is no POST. Live sending is gated on an outreach consent prerequisite
 * that this repository does not yet satisfy — see FR-REBOOK-2 / Part M. The
 * audience, the counts and the draft are all real; the send button is not armed,
 * and the reason travels in the payload so the UI states it rather than
 * inventing one.
 *
 * ── WHAT LEAVES THE SERVER ──────────────────────────────────────────────────
 *
 * Counts, first names and masked addresses. No full email list, no export, no
 * "copy all", and never a supporter belonging to another organization. The list
 * is bounded so a large history cannot turn this into a data dump.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import {
    derivePreviousSupporters,
    describePreviousSupporters,
    maskSupporterEmail,
    normalizeSupporterEmail,
} from '@/lib/previousSupporters';
import { buildInviteDraft } from '@/lib/previousSupporterInvite';
import { evaluateSuppression } from '@/lib/outreachSend';
import { resolveTenantBrand } from '@/lib/tenantBrand';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { validateInviteMessage, renderInviteEmail } from '@/lib/previousSupporterInvite';
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

/** A page of names, not a mailing list. */
const SUPPORTER_PREVIEW_LIMIT = 50;

/**
 * Why the send control is not armed.
 *
 * Stated as a machine code plus prose so the UI never has to guess, and so this
 * turns into a real capability by deleting one constant rather than by rewriting
 * the surface.
 */
export interface SendCapability {
    canSend: boolean;
    code: 'ready' | 'no_reachable_audience' | 'no_order_link' | 'outreach_consent_unavailable';
    reason: string;
}

/**
 * Whether this coordinator can actually send right now — derived, never assumed.
 *
 * Each refusal names a DIFFERENT missing precondition, because "you cannot send"
 * with no reason is what made the earlier disabled button read as a bug. Edgar
 * lands on no_reachable_audience: 17 real previous supporters, none with an email
 * address, so there is genuinely nobody to write to.
 */
export function resolveSendCapability(input: {
    reachableCount: number;
    orderUrl: string | null;
    unsubscribeReady: boolean;
}): SendCapability {
    if (!input.unsubscribeReady) {
        return {
            canSend: false,
            code: 'outreach_consent_unavailable',
            reason: 'Sending is not configured yet, so invitations cannot go out. Nothing has been sent.',
        };
    }
    if (!input.orderUrl) {
        return {
            canSend: false,
            code: 'no_order_link',
            reason: 'This fundraiser has no online ordering page yet, so there is nowhere to send supporters.',
        };
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
        select: {
            id: true,
            name: true,
            end_date: true,
            public_token: true,
            customer_id: true,
            customer: {
                select: {
                    id: true,
                    name: true,
                    business_id: true,
                    business: {
                        select: {
                            id: true, name: true, display_name: true,
                            custom_domain: true, contact_email: true, slug: true,
                        },
                    },
                },
            },
        },
    });
    if (!campaign?.customer?.business_id) return null;
    return {
        campaign,
        businessId: campaign.customer.business_id,
        organizationCustomerId: campaign.customer_id,
    };
}

/** The audience, recomputed from durable data every time it is asked for. */
async function computeAudience(input: {
    businessId: string; organizationCustomerId: string; campaignId: string;
}) {
    const { businessId, organizationCustomerId, campaignId } = input;

    // ── PRIOR campaigns of THIS organization only ───────────────────────
    // The current campaign is excluded by id: someone who ordered today is a
    // current supporter, not a previous one.
    const priorCampaigns = await prisma.fundraiserCampaign.findMany({
        where: { customer_id: organizationCustomerId, id: { not: campaignId } },
        select: { id: true },
    });
    const priorCampaignIds = priorCampaigns.map((c) => c.id);

    // Every organization in this tenant. An organization is never a supporter.
    const organizationRows = await prisma.fundraiserCampaign.findMany({
        where: { customer: { business_id: businessId } },
        select: { customer_id: true },
        distinct: ['customer_id'],
    });
    const organizationCustomerIds = new Set(organizationRows.map((r) => r.customer_id));

    const orders = priorCampaignIds.length
        ? await prisma.order.findMany({
            where: { campaign_id: { in: priorCampaignIds }, canceled_at: null },
            select: {
                id: true, campaign_id: true, canceled_at: true, customer_id: true,
                customer_name: true, phone: true,
                customer: {
                    select: {
                        id: true, business_id: true, contact_email: true,
                        contact_phone: true, name: true,
                    },
                },
            },
        })
        : [];

    // ── Durable opt-out truth, re-read every time ───────────────────────
    // Decided by evaluateSuppression — the SAME rule checkSuppressionAtSend
    // applies — rather than by this route's own guess.
    const now = new Date();
    const prefs = await prisma.marketingPreference.findMany({
        where: { business_id: businessId, scope: 'email_address', normalized_email: { not: null } },
        select: { scope: true, status: true, effective_until: true, normalized_email: true },
    });
    const byEmail = new Map<string, typeof prefs>();
    for (const pr of prefs) {
        const key = normalizeSupporterEmail(pr.normalized_email);
        if (!key) continue;
        if (!byEmail.has(key)) byEmail.set(key, []);
        byEmail.get(key)!.push(pr);
    }
    const suppressedEmails = new Set(
        [...byEmail.entries()]
            .filter(([, rows]) => evaluateSuppression(rows, now).suppressed)
            .map(([email]) => email),
    );

    return derivePreviousSupporters({
        businessId,
        organizationCustomerId,
        priorCampaignIds,
        organizationCustomerIds,
        orders,
        suppressedEmails,
    });
}

/** The invitation draft. Origin is PINNED — never the request's host. */
function buildDraftFor(campaign: NonNullable<Awaited<ReturnType<typeof loadCampaignContext>>>['campaign'], origin: string) {
    const brand = campaign.customer?.business
        ? resolveTenantBrand(campaign.customer.business, origin)
        : null;
    return buildInviteDraft({
        organizationName: campaign.customer?.name ?? '',
        campaign: {
            id: campaign.id,
            name: campaign.name,
            end_date: campaign.end_date,
            public_token: campaign.public_token,
        },
        origin,
        tenant: {
            customDomain: campaign.customer?.business?.custom_domain ?? null,
            slug: campaign.customer?.business?.slug ?? null,
        },
        brand: brand ? { name: brand.name, site: brand.websiteUrl, siteLabel: brand.websiteLabel } : null,
    });
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
        const origin = resolveOutreachOrigin(req);
        const audience = await computeAudience({ businessId, organizationCustomerId, campaignId });
        const draft = buildDraftFor(campaign, origin);

        return NextResponse.json({
            ...describePreviousSupporters(audience),
            counts: {
                supporters: audience.supporterCount,
                reachable: audience.reachableCount,
                noEmail: audience.noEmailCount,
                suppressed: audience.suppressedCount,
                legitimateOrders: audience.legitimateOrders,
                duplicatesCollapsed: audience.duplicatesCollapsed,
            },
            // Names and masked addresses only. Never a usable mailing list.
            supporters: audience.supporters.slice(0, SUPPORTER_PREVIEW_LIMIT).map((s) => ({
                name: s.displayName,
                emailMasked: s.email ? maskSupporterEmail(s.email) : null,
                orderCount: s.orderCount,
                reachable: s.reachable,
                exclusionReason: s.exclusionReason,
            })),
            truncated: audience.supporterCount > SUPPORTER_PREVIEW_LIMIT,
            draft: {
                subject: draft.subject,
                text: draft.text,
                orderUrl: draft.orderUrl,
                deadlineLabel: draft.deadlineLabel,
            },
            send: resolveSendCapability({
                reachableCount: audience.reachableCount,
                orderUrl: draft.orderUrl,
                unsubscribeReady: Boolean(unsubscribeSecret()),
            }),
        });
    } catch (e) {
        console.error('FR-REBOOK-2 previous-supporters error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}

/**
 * POST — send the invitation to this campaign's previous supporters.
 *
 * ── THE CLIENT SENDS TWO STRINGS ────────────────────────────────────────────
 *
 * `subject` and `text`, and nothing else is read. There is no recipient list, no
 * campaign id, no organization id, no business id, no batch id and no ordering
 * URL in the request, so there is no parameter to tamper with. Every one of
 * those is recomputed here from the coordinator's session, exactly as the GET
 * recomputes them — the preview and the send read the same authority, so a stale
 * or doctored preview cannot widen who gets mailed.
 *
 * ── THE ENGINE IS THE DEPLOYED ONE ──────────────────────────────────────────
 *
 * runSend, not a parallel path: it claims an EmailDeliveryAttempt per recipient
 * BEFORE calling the provider, re-checks suppression immediately before each
 * delivery, attaches the OUTREACH-CONSENT-1 footer and List-Unsubscribe headers
 * that the coordinator cannot remove, and refuses the whole run if it cannot.
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
        const draft = buildDraftFor(campaign, origin);

        // ── CAN WE SEND AT ALL? Re-derived, never trusted from the client. ──
        const capability = resolveSendCapability({
            reachableCount: audience.reachableCount,
            orderUrl: draft.orderUrl,
            unsubscribeReady: Boolean(unsubscribeSecret()),
        });
        if (!capability.canSend) {
            return NextResponse.json({ ok: false, ...capability }, { status: 409 });
        }

        // ── THE COORDINATOR'S WORDS, BOUNDED AND PLAIN ──────────────────────
        let body: any = {};
        try { body = await req.json(); } catch { /* validated below */ }
        const validated = validateInviteMessage({
            subject: body?.subject, text: body?.text, orderUrl: draft.orderUrl,
        });
        if (!validated.ok) {
            return NextResponse.json({ ok: false, code: validated.code, error: validated.error }, { status: 400 });
        }

        // The server renders the email. `text` never becomes markup, and the
        // ordering CTA is appended here from the canonical URL.
        const brand = campaign.customer?.business
            ? resolveTenantBrand(campaign.customer.business, origin) : null;
        const rendered = renderInviteEmail({
            text: validated.text,
            orderUrl: draft.orderUrl,
            brand: brand ? { name: brand.name, email: campaign.customer?.business?.contact_email } : null,
        });
        if (!rendered) {
            return NextResponse.json(
                { ok: false, code: 'no_order_link', error: capability.reason }, { status: 409 });
        }
        const subject = safeSubject(validated.subject);

        // ── THE DURABLE BATCH — one per campaign, forever ───────────────────
        const batch = await resolveCampaignBatch(prisma, {
            businessId, customerId: organizationCustomerId, campaignId,
        });
        const recipientRows = await syncCampaignRecipients(prisma, {
            businessId, batchId: batch.id, supporters: audience.supporters,
        });
        const message = await resolveCampaignMessage(prisma, {
            businessId, batchId: batch.id, subject, html: rendered.html, text: rendered.text,
        });

        const sender = await getTenantSender(businessId);
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
            })),
            // Identical content for everyone; the footer and headers are added
            // per recipient inside the engine.
            render: () => ({ subject, html: rendered.html, text: rendered.text }),
            from: sender.from,
            replyTo: sender.replyTo,
            now: new Date(),
            unsubscribe: { origin, brandName: brand?.name ?? null },
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
        });
    } catch (e) {
        console.error('FR-REBOOK-2 previous-supporters send error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}
