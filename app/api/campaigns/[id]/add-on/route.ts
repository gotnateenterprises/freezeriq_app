/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S2) — a campaign's Supporter Add-On, set by the tenant.
 *
 *   GET     the add-on, its share schedule (as plain ranges with lock states), add-ons sold, the share
 *           already earned, the meal share for reference, and the add-on bundles that can be chosen.
 *   PUT     { bundleId }  offer an add-on: first time ever, one tier, position 1+ at the campaign's CURRENT
 *           meal share; otherwise replace or resume (B2) — the campaign's schedule is always kept.
 *   DELETE  stop offering the add-on (B2: campaign_add_ons.removed_at). Nothing is deleted: the schedule,
 *           locked tiers and tier positions are kept and resume on the next PUT. Money earned stays.
 *   PATCH   { tiers: [{ startingQuantity, percent }] }  the share schedule. Tiers the campaign's tier
 *           progress has reached (LIFETIME positions, cancelled orders included — B1) are locked; new
 *           tiers start above it.
 *   PATCH   { showSharePercent: boolean }  (S4) whether the supporter page may state the share %. Display
 *           only; shown only while the schedule has one tier (lib/campaignAddOnShare.publicAddOnSupportPercent).
 *
 * ACCESS: session-authenticated, tenant-scoped. Every WRITE is a financial-terms change, so it needs an
 * ADMIN or super-admin — the same gate as the campaign's organization share
 * (lib/fundraiserOrgShare.mayManageFundraiserFinancialTerms).
 *
 * CONCURRENCY: every write takes the campaign selection lock — the lock every add-on order already takes
 * before it records its share — and rechecks inside it that the campaign has not been closed out. An
 * order therefore sees either the old add-on/schedule or the new one, never a mixture; a closed
 * campaign's add-on and schedule never change.
 *
 * PUBLIC (S4): the supporter page reads the CURRENT add-on through lib/publicCampaignAddOn.ts — its public
 * bundle fields, and the share % only when showSharePercent is on and the schedule has one tier. Nothing
 * else here (tier rows, units sold, money earned) ever reaches a supporter.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { lockCampaignSelection } from '@/lib/campaignSelectionLock';
import { isCampaignClosed } from '@/lib/campaignBundleSelection';
import { mayManageFundraiserFinancialTerms } from '@/lib/fundraiserOrgShare';
import { parseShareTierSchedule } from '@/lib/campaignAddOnShare';
import {
    assignCampaignAddOn,
    loadCampaignAddOnAdminView,
    removeCampaignAddOn,
    updateCampaignAddOnShareDisplay,
    updateCampaignAddOnShareTiers,
    type AddOnAdminResult,
} from '@/lib/campaignAddOnEarnings';

const ADD_ON_ADMIN_ONLY_MESSAGE = 'Only an administrator can change a fundraiser\'s add-on or its organization share.';
const ADD_ON_CLOSED_MESSAGE = 'This fundraiser has been closed out, so its add-on and add-on share can no longer change.';

type Loaded =
    | { ok: false; response: NextResponse }
    | {
        ok: true;
        businessId: string;
        user: { id: string | null; role: unknown; isSuperAdmin: boolean };
        campaign: { id: string; customer_id: string; org_share_percent: unknown; closed_at: Date | null; status: string };
    };

async function loadTenantCampaign(params: Promise<{ id: string }>): Promise<Loaded> {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (!session?.user?.businessId) {
        return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    const { id } = await params;
    const campaign = await prisma.fundraiserCampaign.findUnique({
        where: { id },
        select: {
            id: true,
            customer_id: true,
            org_share_percent: true,
            closed_at: true,
            status: true,
            customer: { select: { business_id: true } },
        },
    });
    // Another tenant's campaign is indistinguishable from a missing one.
    if (!campaign || campaign.customer?.business_id !== session.user.businessId) {
        return { ok: false, response: NextResponse.json({ error: 'Campaign not found' }, { status: 404 }) };
    }
    return {
        ok: true,
        businessId: session.user.businessId,
        user: {
            id: ((session.user as any).id as string | undefined) ?? null,
            role: (session.user as any).role,
            isSuperAdmin: (session.user as any).isSuperAdmin === true,
        },
        campaign: {
            id: campaign.id,
            customer_id: campaign.customer_id,
            org_share_percent: campaign.org_share_percent,
            closed_at: (campaign as any).closed_at ?? null,
            status: campaign.status,
        },
    };
}

async function respondWithView(loaded: Extract<Loaded, { ok: true }>, extra: Record<string, unknown> = {}) {
    const fresh = await prisma.fundraiserCampaign.findUnique({
        where: { id: loaded.campaign.id },
        select: { org_share_percent: true, closed_at: true, status: true },
    });
    const view = await loadCampaignAddOnAdminView(prisma, {
        campaign: {
            id: loaded.campaign.id,
            org_share_percent: fresh?.org_share_percent ?? loaded.campaign.org_share_percent,
            closed: isCampaignClosed({
                closed_at: (fresh as any)?.closed_at ?? null,
                status: fresh?.status ?? loaded.campaign.status,
            }),
        },
        businessId: loaded.businessId,
    });
    return NextResponse.json({
        ...view,
        canManage: mayManageFundraiserFinancialTerms(loaded.user),
        ...extra,
    });
}

class CampaignClosedForAddOn extends Error {
    readonly isCampaignClosedForAddOn = true as const;
}

/**
 * The write path shared by PUT, DELETE and PATCH: role gate, then ONE transaction that takes the campaign
 * lock, rechecks the campaign is still open, and runs the operation.
 */
async function runLockedWrite(
    loaded: Extract<Loaded, { ok: true }>,
    operation: (tx: any) => Promise<AddOnAdminResult>,
): Promise<NextResponse> {
    if (!mayManageFundraiserFinancialTerms(loaded.user)) {
        return NextResponse.json({ error: ADD_ON_ADMIN_ONLY_MESSAGE, code: 'ADDON_ADMIN_ONLY' }, { status: 403 });
    }
    let result: AddOnAdminResult;
    try {
        result = await prisma.$transaction(async (tx) => {
            await lockCampaignSelection(tx as any, loaded.campaign.id);
            const current = await tx.fundraiserCampaign.findUnique({
                where: { id: loaded.campaign.id },
                select: { closed_at: true, status: true },
            });
            if (!current || isCampaignClosed({ closed_at: (current as any).closed_at ?? null, status: current.status })) {
                throw new CampaignClosedForAddOn();
            }
            const outcome = await operation(tx);
            // A refusal must leave nothing behind; throwing rolls the transaction back.
            if (!outcome.ok) throw Object.assign(new Error(outcome.code), { addOnRefusal: outcome });
            return outcome;
        });
    } catch (e: any) {
        if (e?.isCampaignClosedForAddOn === true) {
            return NextResponse.json({ error: ADD_ON_CLOSED_MESSAGE, code: 'CAMPAIGN_CLOSED' }, { status: 409 });
        }
        if (e?.addOnRefusal) {
            const r = e.addOnRefusal as Extract<AddOnAdminResult, { ok: false }>;
            return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
        }
        throw e;
    }
    return respondWithView(loaded, { changed: result.ok ? result.changed : false });
}

async function readJson(req: Request): Promise<{ ok: true; body: any } | { ok: false; response: NextResponse }> {
    try {
        return { ok: true, body: await req.json() };
    } catch {
        return { ok: false, response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) };
    }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const loaded = await loadTenantCampaign(params);
        if (!loaded.ok) return loaded.response;
        return await respondWithView(loaded);
    } catch (e) {
        console.error('[campaign add-on] GET failed:', e);
        return NextResponse.json({ error: 'Could not load the fundraiser add-on.' }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const loaded = await loadTenantCampaign(params);
        if (!loaded.ok) return loaded.response;
        if (!mayManageFundraiserFinancialTerms(loaded.user)) {
            return NextResponse.json({ error: ADD_ON_ADMIN_ONLY_MESSAGE, code: 'ADDON_ADMIN_ONLY' }, { status: 403 });
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const bundleId = parsed.body?.bundleId;
        return await runLockedWrite(loaded, (tx) => assignCampaignAddOn(tx, {
            campaign: loaded.campaign,
            businessId: loaded.businessId,
            bundleId,
            userId: loaded.user.id,
        }));
    } catch (e) {
        console.error('[campaign add-on] PUT failed:', e);
        return NextResponse.json({ error: 'Could not save the fundraiser add-on.' }, { status: 500 });
    }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const loaded = await loadTenantCampaign(params);
        if (!loaded.ok) return loaded.response;
        return await runLockedWrite(loaded, (tx) => removeCampaignAddOn(tx, {
            campaignId: loaded.campaign.id,
            businessId: loaded.businessId,
        }));
    } catch (e) {
        console.error('[campaign add-on] DELETE failed:', e);
        return NextResponse.json({ error: 'Could not remove the fundraiser add-on.' }, { status: 500 });
    }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const loaded = await loadTenantCampaign(params);
        if (!loaded.ok) return loaded.response;
        if (!mayManageFundraiserFinancialTerms(loaded.user)) {
            return NextResponse.json({ error: ADD_ON_ADMIN_ONLY_MESSAGE, code: 'ADDON_ADMIN_ONLY' }, { status: 403 });
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        // S4: the share-display toggle travels alone; a body with tiers is a schedule edit, exactly as before.
        if (parsed.body && typeof parsed.body === 'object' && 'showSharePercent' in parsed.body && !('tiers' in parsed.body)) {
            const show = parsed.body.showSharePercent;
            if (typeof show !== 'boolean') {
                return NextResponse.json({ error: 'Choose whether to show the share on the supporter page.', code: 'INVALID_SHARE_DISPLAY' }, { status: 400 });
            }
            return await runLockedWrite(loaded, (tx) => updateCampaignAddOnShareDisplay(tx, {
                campaignId: loaded.campaign.id,
                businessId: loaded.businessId,
                showSharePercent: show,
            }));
        }
        const schedule = parseShareTierSchedule(parsed.body?.tiers);
        if (!schedule.ok) return NextResponse.json({ error: schedule.error, code: schedule.code }, { status: schedule.status });
        return await runLockedWrite(loaded, (tx) => updateCampaignAddOnShareTiers(tx, {
            campaignId: loaded.campaign.id,
            businessId: loaded.businessId,
            next: schedule.tiers,
        }));
    } catch (e) {
        console.error('[campaign add-on] PATCH failed:', e);
        return NextResponse.json({ error: 'Could not save the add-on share.' }, { status: 500 });
    }
}
