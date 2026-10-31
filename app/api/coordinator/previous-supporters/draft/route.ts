/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0A — "Open in my email": ONE previous supporter's
 * prepared draft, for the coordinator's own mail app.
 *
 * POST { ref } → { ok: true, mailto }
 *
 * The coordinator reviews and sends the draft from their own mailbox. FreezerIQ
 * sends nothing here, records nothing as sent, and writes nothing at all — the
 * handler only reads. That is why this path does not need the recorded
 * future-email permission FreezerIQ's own automated send does: it is the
 * coordinator personally writing to someone who supported their organization.
 *
 * PREVIOUS-SUPPORTER-EMAIL-2.0B: it DOES need the organization's mailing address —
 * the draft's footer names the organization and gives that address — and fails
 * closed without one. Nothing else (delivery address, pickup location, the
 * tenant's kitchen) is ever used in its place.
 *
 * ── AUTHORITY ───────────────────────────────────────────────────────────────
 *
 * Exactly the Previous Supporters route's: session cookie → campaign →
 * organization → tenant → prior campaigns. The body carries one opaque reference
 * and nothing else; it is matched only inside the audience recomputed here, so it
 * can name a previous supporter of THIS organization or nobody. One address per
 * request — there is no way to ask for a list.
 *
 * Opted-out supporters, unusable addresses and a fundraiser that is not open for
 * orders get no draft: the same rules the card uses to show the button.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { loadPreviousSupporterAudience } from '@/lib/previousSupporterAudience';
import {
    buildPersonalMailto,
    defaultInvitationMessage,
    defaultInvitationSubject,
} from '@/lib/previousSupporterEmail';
import {
    findSupporterByRef,
    INVITATION_CAMPAIGN_SELECT,
    loadCampaignEmailHistory,
    loadInvitationFacts,
    personalEmailAllowed,
} from '@/lib/previousSupporterInvitation';
import { describePersonalEmail, loadOrganizationMailingAddress } from '@/lib/previousSupporterAuthorities';

/** One answer for every reference that names nobody this coordinator may email. */
function notAvailable() {
    return NextResponse.json({ ok: false, error: 'That supporter cannot be emailed from here.' }, { status: 404 });
}

export async function POST(req: Request) {
    try {
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;

        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
            select: INVITATION_CAMPAIGN_SELECT,
        });
        if (!campaign?.customer?.business_id) return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
        const businessId = campaign.customer.business_id;
        const organizationCustomerId = campaign.customer_id;

        const { availability, facts } = await loadInvitationFacts(campaign);
        if (!availability.open || !facts) {
            return NextResponse.json({ ok: false, code: availability.code, error: availability.reason }, { status: 409 });
        }

        // 2.0B: THIS organization's own mailing address, in THIS tenant — or no draft.
        const mailingAddress = await loadOrganizationMailingAddress({ businessId, organizationCustomerId });
        const personal = describePersonalEmail(mailingAddress);
        if (!mailingAddress) {
            return NextResponse.json({ ok: false, code: personal.code, error: personal.reason }, { status: 409 });
        }

        let body: any = {};
        try { body = await req.json(); } catch { /* validated below */ }

        const audience = await loadPreviousSupporterAudience(prisma, {
            businessId, organizationCustomerId, excludeCampaignId: campaignId, now: new Date(),
        });
        const supporter = findSupporterByRef(campaignId, body?.ref, audience);
        if (!supporter) return notAvailable();
        const history = await loadCampaignEmailHistory(prisma, { businessId, customerId: organizationCustomerId, campaignId });
        if (!personalEmailAllowed(supporter, history, availability.open)) return notAvailable();

        const mailto = buildPersonalMailto({
            to: supporter.email,
            greetingName: supporter.displayName,
            subject: defaultInvitationSubject(campaign.customer?.name),
            message: defaultInvitationMessage(campaign.customer?.name),
            facts,
            sender: { organizationName: campaign.customer?.name ?? '', mailingAddress },
        });
        if (!mailto) return notAvailable();

        return NextResponse.json({ ok: true, mailto });
    } catch (e) {
        console.error('PREVIOUS-SUPPORTER-EMAIL-2.0A draft error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}
