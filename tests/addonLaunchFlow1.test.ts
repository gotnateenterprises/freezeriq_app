/**
 * FR-ADDON-LAUNCH-FLOW-1 (owner-approved 2026-11-25; decisions D1–D7, D11, D12) — the optional fundraiser add-on
 * in the tenant launch flows and the coordinator's setup.
 *
 *   A  the two rules: CONFIGURED (not removed) vs OFFERED TO SUPPORTERS (configured AND (included OR accepted))
 *   B  every reader, in every state: order authority, supporter page, printed materials, coordinator panel, setup
 *   C  the tenant's authorization (include / let the coordinator decide; safe override of a decline)
 *   D  the coordinator's answer (the coordinator's ONLY add-on write) and stale-offer protection
 *   E  the real routes: tenant PATCH offerMode; coordinator setup GET + POST (lock, no partial writes)
 *   F  the setup invitation: first-name greeting; per-mode wording; no prices or percentages; 0% honesty
 *   G  the coordinator setup screen
 *   H  the tenant launch flows (lead launch, Start Fundraiser wizard incl. rebooking, Campaign drawer)
 *   I  migration 6, financial invariants and scope
 *
 * Fictional data only (public repository).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    OFFER_STATE_SELECT,
    OFFER_STATE_WITH_DECIDED_AT_SELECT,
    isOfferedAddOnRow,
    isSupporterOfferedAddOnRow,
    loadCampaignAddOnAuthority,
    normalizeAddOnOfferMode,
    normalizeCoordinatorAddOnDecision,
} from '@/lib/campaignAddOns';
import {
    ADDON_DECLINED_CONFIRM_MESSAGE,
    assignCampaignAddOn,
    loadCampaignAddOnForMaterials,
    loadCampaignAddOnSchedule,
    loadCoordinatorAddOnView,
    loadCoordinatorSetupAddOnOffer,
    recordCoordinatorAddOnDecision,
    setCampaignAddOnOfferMode,
} from '@/lib/campaignAddOnEarnings';
import { loadPublicCampaignAddOn } from '@/lib/publicCampaignAddOn';
import { coordinatorSetupTemplate } from '@/lib/emailTemplates';
import { AddOnOfferSection, ADDON_NO_LABEL, ADDON_YES_LABEL, type CoordinatorAddOnOffer } from '@/components/coordinator/AddOnOfferSection';
import { coordinatorStatusLine } from '@/components/crm2/CampaignAddOnCard';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__alfPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__alfSession ?? null) }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => ((global as any).__alfAuthed && name === (global as any).__alfCookieName ? { name, value: 'alf1-session-secret' } : undefined),
        set: () => undefined,
        delete: () => undefined,
    }),
}));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const BASE = '284b43f';
const M6 = '20261128120000_supporter_addon_coordinator_choice';
const M6_SQL = `prisma/migrations/${M6}/migration.sql`;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// ── fictional world ──────────────────────────────────────────────────────────────────────────────
const BIZ_A = 'biz-alf1-aaaa';
const BIZ_B = 'biz-alf1-bbbb';
const ORG_A = 'org-alf1-maple';
const CAMP = 'aaaa4444-0000-4000-8000-0000000000a1';

interface BundleRow { id: string; name: string; price: string | null; is_active: boolean; business_id: string; bundle_type: string; description: string | null; image_url: string | null; meals: string[] }
const bundle = (o: Partial<BundleRow> & { id: string; name: string }): BundleRow => ({
    price: '25.00', is_active: true, business_id: BIZ_A, bundle_type: 'addon', description: 'Two sides and a dessert.',
    image_url: 'https://cdn.example.test/addon.png', meals: ['Garlic Green Beans', 'Brownie Bites'], ...o,
});
const BUNDLES: Record<string, BundleRow> = {
    ADDON: bundle({ id: 'b-alf1-addon', name: 'Sides & Dessert Bundle' }),
    ADDON2: bundle({ id: 'b-alf1-addon-2', name: 'Holiday Pie Add-On', price: '18.00', meals: ['Apple Pie'] }),
    OFF: bundle({ id: 'b-alf1-off', name: 'Retired Add-On', is_active: false }),
    UNPRICED: bundle({ id: 'b-alf1-np', name: 'Unpriced Add-On', price: null }),
    EMPTY: bundle({ id: 'b-alf1-empty', name: 'Empty Add-On', meals: [] }),
    MEAL: bundle({ id: 'b-alf1-meal', name: 'Comfort Foods (Serves 5)', bundle_type: 'meal', price: '125.00' }),
    FOREIGN: bundle({ id: 'b-alf1-foreign', name: 'Another Kitchen Add-On', business_id: BIZ_B }),
};
const findBundle = (id: string | undefined) => Object.values(BUNDLES).find((b) => b.id === id) ?? null;

interface World {
    addOn: null | Record<string, any>;
    tiers: Array<{ starting_quantity: number; percent: number }>;
    slices: Array<{ first_unit: number; quantity: number }>;
    writes: Array<{ op: string; args: any }>;
}
const newWorld = (addOn: Partial<Record<string, any>> | null, tiers: Array<[number, number]> = [[1, 10]]): World => ({
    addOn: addOn ? {
        id: 'cao-alf1', business_id: BIZ_A, customer_id: ORG_A, campaign_id: CAMP, bundle_id: BUNDLES.ADDON.id,
        removed_at: null, offer_mode: 'included', coordinator_decision: null, coordinator_decided_at: null,
        show_share_percent: false, ...addOn,
    } : null,
    tiers: tiers.map(([s, p]) => ({ starting_quantity: s, percent: p })),
    slices: [],
    writes: [],
});
const bundleOut = (b: BundleRow) => ({
    id: b.id, name: b.name, description: b.description, image_url: b.image_url, price: b.price, is_active: b.is_active,
    business_id: b.business_id, bundle_type: b.bundle_type,
    contents: b.meals.map((m, i) => ({ quantity: 1, position: i, recipe: { name: m, description: null, image_url: null, cook_time: null, allergens: null, macros: null } })),
    _count: { contents: b.meals.length },
});
/** The add-on world's own model methods (the rest of the client is the route harness's). */
const addOnModel = (W: World) => ({
    'campaignAddOn.findUnique': (args: any) => {
        const a = W.addOn;
        if (!a || a.campaign_id !== args?.where?.campaign_id) return null;
        const b = findBundle(a.bundle_id);
        return { ...a, bundle: b ? bundleOut(b) : null, share_tiers: W.tiers.map((t) => ({ ...t })) };
    },
    'campaignAddOn.update': (args: any) => { W.writes.push({ op: 'update', args }); Object.assign(W.addOn!, args.data); return W.addOn; },
    'campaignAddOn.updateMany': (args: any) => {
        W.writes.push({ op: 'updateMany', args });
        const a = W.addOn;
        const w = args.where ?? {};
        const hit = a && a.campaign_id === w.campaign_id && a.business_id === w.business_id
            && (w.bundle_id === undefined || a.bundle_id === w.bundle_id)
            && (!('removed_at' in w) || (w.removed_at === null ? a.removed_at === null : true))
            && (w.offer_mode === undefined || a.offer_mode === w.offer_mode);
        if (hit) Object.assign(a!, args.data);
        return { count: hit ? 1 : 0 };
    },
    'campaignAddOn.create': (args: any) => { W.writes.push({ op: 'create', args }); return args.data; },
    'campaignAddOn.count': () => (W.addOn && W.addOn.removed_at === null ? 1 : 0),
    'bundle.findFirst': (args: any) => {
        const b = findBundle(args?.where?.id);
        if (!b || (args?.where?.business_id !== undefined && b.business_id !== args.where.business_id)) return null;
        return bundleOut(b);
    },
    'bundle.findMany': (args: any) => Object.values(BUNDLES)
        .filter((b) => args?.where?.business_id === undefined || b.business_id === args.where.business_id)
        .filter((b) => args?.where?.bundle_type === undefined || b.bundle_type === args.where.bundle_type)
        .map(bundleOut),
    'orderItemAddOnShare.findMany': () => W.slices.map((s) => ({ ...s })),
    'orderItem.findMany': () => [],
});
const libDb = (W: World): any => createPrismaMock({ results: addOnModel(W) }).client;

beforeEach(() => {
    (global as any).__alfCookieName = coordinatorSessionCookieName();
    (global as any).__alfAuthed = false;
    (global as any).__alfSession = { user: { id: 'user-alf1-admin', businessId: BIZ_A, role: 'ADMIN', isSuperAdmin: false } };
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('A · two rules: configured vs offered to supporters', () => {
    it('A1. offered to supporters = not removed AND (included OR accepted)', () => {
        const row = (o: Record<string, unknown>) => ({ removed_at: null, offer_mode: 'included', coordinator_decision: null, ...o });
        const cases: Array<[Record<string, unknown>, boolean, boolean]> = [
            [{}, true, true],
            [{ coordinator_decision: 'declined' }, true, true], // tenant override of a decline (D3)
            [{ offer_mode: 'coordinator_choice' }, true, false],
            [{ offer_mode: 'coordinator_choice', coordinator_decision: 'accepted' }, true, true],
            [{ offer_mode: 'coordinator_choice', coordinator_decision: 'declined' }, true, false],
            [{ removed_at: new Date() }, false, false],
            [{ removed_at: new Date(), offer_mode: 'coordinator_choice', coordinator_decision: 'accepted' }, false, false],
            [{ offer_mode: 'coordinator_choice', coordinator_decision: 'maybe' }, true, false],
        ];
        for (const [o, configured, offered] of cases) {
            expect({ o, configured: isOfferedAddOnRow(row(o)), offered: isSupporterOfferedAddOnRow(row(o)) }).toEqual({ o, configured, offered });
        }
        expect(isSupporterOfferedAddOnRow(null)).toBe(false);
        // A row from before 1B (columns absent) behaves exactly as before: included.
        expect(isSupporterOfferedAddOnRow({ removed_at: null })).toBe(true);
    });

    it('A2. only exact values count', () => {
        expect(['coordinator_choice', 'included', 'COORDINATOR_CHOICE', '', null, undefined].map(normalizeAddOnOfferMode))
            .toEqual(['coordinator_choice', 'included', 'included', 'included', 'included', 'included']);
        expect(['accepted', 'declined', 'Accepted', 'yes', null].map(normalizeCoordinatorAddOnDecision))
            .toEqual(['accepted', 'declined', null, null, null]);
    });

    it('A3. the offer-state selects carry removed_at, so B2 still holds wherever they are used', () => {
        expect(OFFER_STATE_SELECT).toEqual({ removed_at: true, offer_mode: true, coordinator_decision: true });
        expect(OFFER_STATE_WITH_DECIDED_AT_SELECT).toEqual({ removed_at: true, offer_mode: true, coordinator_decision: true, coordinator_decided_at: true });
    });

    it('A4. every SUPPORTER-facing reader selects the offer state and applies the supporter rule', () => {
        const fn = (file: string, name: string) => {
            const src = strip(R(file));
            const at = src.indexOf(`export async function ${name}(`);
            expect(at).toBeGreaterThan(-1);
            const next = src.indexOf('\nexport ', at + 10);
            return src.slice(at, next < 0 ? undefined : next);
        };
        for (const [file, name] of [
            ['lib/campaignAddOns.ts', 'loadCampaignAddOnAuthority'],
            ['lib/publicCampaignAddOn.ts', 'loadPublicCampaignAddOn'],
            ['lib/campaignAddOnEarnings.ts', 'loadCoordinatorAddOnView'],
        ]) {
            const body = fn(file, name);
            expect({ name, selects: body.includes('...OFFER_STATE_SELECT'), rule: body.includes('isSupporterOfferedAddOnRow(') })
                .toEqual({ name, selects: true, rule: true });
        }
        // Printed materials go through the order authority.
        expect(fn('lib/campaignAddOnEarnings.ts', 'loadCampaignAddOnForMaterials')).toContain('loadCampaignAddOnAuthority(');
        // The schedule loader (tier edits, earnings recording) stays on the CONFIGURED rule.
        const schedule = fn('lib/campaignAddOnEarnings.ts', 'loadCampaignAddOnSchedule');
        expect(schedule).toContain('isOfferedAddOnRow(row)');
        expect(schedule).not.toContain('isSupporterOfferedAddOnRow');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('B · every reader, in every state', () => {
    const states: Array<[string, Partial<Record<string, any>>, boolean]> = [
        ['included', {}, true],
        ['coordinator choice, no answer yet', { offer_mode: 'coordinator_choice' }, false],
        ['coordinator accepted', { offer_mode: 'coordinator_choice', coordinator_decision: 'accepted' }, true],
        ['coordinator declined', { offer_mode: 'coordinator_choice', coordinator_decision: 'declined' }, false],
        ['tenant included after a decline', { offer_mode: 'included', coordinator_decision: 'declined' }, true],
        ['removed by the tenant', { removed_at: new Date('2026-11-20T00:00:00Z') }, false],
    ];

    it.each(states)('B1. %s → orders, supporter page, flyer/packet/tracker and coordinator panel agree', async (_label, state, offered) => {
        const db = libDb(newWorld(state));
        const ids = { campaignId: CAMP, businessId: BIZ_A };
        const authority = await loadCampaignAddOnAuthority(db, ids);
        const pub = await loadPublicCampaignAddOn(db, { ...ids, orderable: true });
        const materials = await loadCampaignAddOnForMaterials(db, { campaign: { id: CAMP }, businessId: BIZ_A, supporterPrice: (p) => p });
        const panel = await loadCoordinatorAddOnView(db, ids);
        expect({ authority: !!authority, pub: !!pub, materials: !!materials, panel: !!panel })
            .toEqual({ authority: offered, pub: offered, materials: offered, panel: offered });
        // The tenant's schedule stays editable whenever the add-on is configured (not removed).
        expect(!!(await loadCampaignAddOnSchedule(db, ids))).toBe(!state.removed_at);
    });

    it('B2. the setup offer: real name, image, price, meals, plain-words schedule; mode and answer', async () => {
        const offer = await loadCoordinatorSetupAddOnOffer(libDb(newWorld({ offer_mode: 'coordinator_choice' }, [[1, 10], [11, 15]])), { campaignId: CAMP, businessId: BIZ_A });
        expect(offer).toEqual({
            bundleId: BUNDLES.ADDON.id,
            name: 'Sides & Dessert Bundle',
            description: 'Two sides and a dessert.',
            imageUrl: 'https://cdn.example.test/addon.png',
            price: 25,
            meals: ['Garlic Green Beans', 'Brownie Bites'],
            shareSummary: 'Your organization earns 10% on the first 10 add-ons and 15% beginning with add-on 11.',
            shareTiers: [{ rangeLabel: expect.any(String), percent: 10 }, { rangeLabel: expect.any(String), percent: 15 }],
            earnsShare: true,
            mode: 'coordinator_choice',
            decision: null,
        });
        // Included mode carries no answer, even if an old one is stored.
        const inc = await loadCoordinatorSetupAddOnOffer(libDb(newWorld({ coordinator_decision: 'declined' })), { campaignId: CAMP, businessId: BIZ_A });
        expect(inc).toMatchObject({ mode: 'included', decision: null });
    });

    it('B3. no setup offer (and no invitation mention) for a removed, foreign, off, unpriced or empty add-on', async () => {
        for (const state of [
            { removed_at: new Date() }, { business_id: BIZ_B }, { bundle_id: BUNDLES.OFF.id }, { bundle_id: BUNDLES.UNPRICED.id },
            { bundle_id: BUNDLES.EMPTY.id }, { bundle_id: BUNDLES.FOREIGN.id },
        ]) {
            expect(await loadCoordinatorSetupAddOnOffer(libDb(newWorld(state)), { campaignId: CAMP, businessId: BIZ_A })).toBeNull();
        }
        expect(await loadCoordinatorSetupAddOnOffer(libDb(newWorld(null)), { campaignId: CAMP, businessId: BIZ_A })).toBeNull();
    });

    it('B4. a 0% schedule is honest: earnsShare is false', async () => {
        const offer = await loadCoordinatorSetupAddOnOffer(libDb(newWorld({}, [[1, 0]])), { campaignId: CAMP, businessId: BIZ_A });
        expect(offer).toMatchObject({ earnsShare: false, shareSummary: 'Your organization earns 0% on this add-on.' });
        const later = await loadCoordinatorSetupAddOnOffer(libDb(newWorld({}, [[1, 0], [21, 5]])), { campaignId: CAMP, businessId: BIZ_A });
        expect(later!.earnsShare).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('C · the tenant\'s authorization', () => {
    const ids = { campaignId: CAMP, businessId: BIZ_A };

    it('C1. include → let the coordinator decide clears any answer (the add-on stops being offered)', async () => {
        const W = newWorld({ coordinator_decision: 'accepted', coordinator_decided_at: new Date() });
        expect(await setCampaignAddOnOfferMode(libDb(W), { ...ids, offerMode: 'coordinator_choice' })).toEqual({ ok: true, changed: true });
        expect(W.addOn).toMatchObject({ offer_mode: 'coordinator_choice', coordinator_decision: null, coordinator_decided_at: null });
        expect(W.writes.map((w) => Object.keys(w.args.data).sort())).toEqual([['coordinator_decided_at', 'coordinator_decision', 'offer_mode']]);
    });

    it('C2. including one the coordinator DECLINED needs an explicit confirmation (D3); the decline stays on record', async () => {
        const W = newWorld({ offer_mode: 'coordinator_choice', coordinator_decision: 'declined', coordinator_decided_at: new Date('2026-11-26T15:00:00Z') });
        const refused = await setCampaignAddOnOfferMode(libDb(W), { ...ids, offerMode: 'included' });
        expect(refused).toEqual({ ok: false, status: 409, code: 'ADDON_DECLINED_CONFIRM_REQUIRED', error: ADDON_DECLINED_CONFIRM_MESSAGE });
        expect(W.writes).toHaveLength(0);
        for (const notTrue of ['true', 1, {}]) {
            expect((await setCampaignAddOnOfferMode(libDb(W), { ...ids, offerMode: 'included', confirmOverrideDecline: notTrue })).ok).toBe(false);
        }
        expect(await setCampaignAddOnOfferMode(libDb(W), { ...ids, offerMode: 'included', confirmOverrideDecline: true })).toEqual({ ok: true, changed: true });
        expect(W.addOn).toMatchObject({ offer_mode: 'included', coordinator_decision: 'declined' });
        expect(W.writes.map((w) => w.args.data)).toEqual([{ offer_mode: 'included' }]);
    });

    it('C3. coordinator choice → include, with no decline, needs no confirmation', async () => {
        const W = newWorld({ offer_mode: 'coordinator_choice' });
        expect((await setCampaignAddOnOfferMode(libDb(W), { ...ids, offerMode: 'included' })).ok).toBe(true);
        expect(W.addOn!.offer_mode).toBe('included');
    });

    it('C4. refused: an unknown mode, no add-on, a removed add-on, another tenant\'s row; the same mode changes nothing', async () => {
        expect(await setCampaignAddOnOfferMode(libDb(newWorld({})), { ...ids, offerMode: 'everyone' })).toMatchObject({ ok: false, status: 400, code: 'INVALID_OFFER_MODE' });
        expect(await setCampaignAddOnOfferMode(libDb(newWorld(null)), { ...ids, offerMode: 'included' })).toMatchObject({ ok: false, status: 409, code: 'NO_ADDON_ASSIGNED' });
        expect(await setCampaignAddOnOfferMode(libDb(newWorld({ removed_at: new Date() })), { ...ids, offerMode: 'coordinator_choice' })).toMatchObject({ ok: false, code: 'NO_ADDON_ASSIGNED' });
        expect(await setCampaignAddOnOfferMode(libDb(newWorld({ business_id: BIZ_B })), { ...ids, offerMode: 'coordinator_choice' })).toMatchObject({ ok: false, code: 'NO_ADDON_ASSIGNED' });
        const W = newWorld({});
        expect(await setCampaignAddOnOfferMode(libDb(W), { ...ids, offerMode: 'included' })).toEqual({ ok: true, changed: false });
        expect(W.writes).toHaveLength(0);
    });

    it('C5. replacing the bundle clears the coordinator\'s answer (D5); resuming the same bundle keeps it; the schedule is kept', async () => {
        const campaign = { id: CAMP, customer_id: ORG_A, org_share_percent: 20 };
        const W = newWorld({ offer_mode: 'coordinator_choice', coordinator_decision: 'accepted', coordinator_decided_at: new Date() }, [[1, 10], [11, 15]]);
        expect((await assignCampaignAddOn(libDb(W), { campaign, businessId: BIZ_A, bundleId: BUNDLES.ADDON2.id, userId: null })).ok).toBe(true);
        expect(W.addOn).toMatchObject({ bundle_id: BUNDLES.ADDON2.id, offer_mode: 'coordinator_choice', coordinator_decision: null });
        expect(isSupporterOfferedAddOnRow(W.addOn)).toBe(false);
        expect(W.tiers.map((t) => t.percent)).toEqual([10, 15]);
        expect(W.writes.filter((w) => w.op === 'create')).toHaveLength(0);

        const R2 = newWorld({ removed_at: new Date(), offer_mode: 'coordinator_choice', coordinator_decision: 'accepted' });
        expect((await assignCampaignAddOn(libDb(R2), { campaign, businessId: BIZ_A, bundleId: BUNDLES.ADDON.id, userId: null })).ok).toBe(true);
        expect(R2.addOn).toMatchObject({ removed_at: null, coordinator_decision: 'accepted' });
        expect(R2.writes[0].args.data).toEqual({ bundle_id: BUNDLES.ADDON.id, removed_at: null });
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('D · the coordinator\'s answer', () => {
    const run = (W: World, submitted: unknown) => recordCoordinatorAddOnDecision(libDb(W), { campaignId: CAMP, businessId: BIZ_A, submitted });
    const choice = () => newWorld({ offer_mode: 'coordinator_choice' });
    const shown = (o: Record<string, unknown> = {}) => ({ bundleId: BUNDLES.ADDON.id, mode: 'coordinator_choice', decision: 'accepted', ...o });

    it('D1. "Yes": writes ONLY the answer and when it was given, guarded to the bundle and mode shown', async () => {
        const W = choice();
        expect(await run(W, shown())).toEqual({ ok: true, recorded: true, decision: 'accepted' });
        expect(W.writes).toHaveLength(1);
        expect(W.writes[0].op).toBe('updateMany');
        expect(Object.keys(W.writes[0].args.data).sort()).toEqual(['coordinator_decided_at', 'coordinator_decision']);
        expect(W.writes[0].args.where).toEqual({ campaign_id: CAMP, business_id: BIZ_A, bundle_id: BUNDLES.ADDON.id, removed_at: null, offer_mode: 'coordinator_choice' });
        expect(isSupporterOfferedAddOnRow(W.addOn)).toBe(true);
    });

    it('D2. "No thanks": recorded; supporters are not offered it', async () => {
        const W = choice();
        expect(await run(W, shown({ decision: 'declined' }))).toEqual({ ok: true, recorded: true, decision: 'declined' });
        expect(isSupporterOfferedAddOnRow(W.addOn)).toBe(false);
    });

    it('D3. an answer is REQUIRED when the organizer asked — missing → 400; never shown → 409 (page reloads)', async () => {
        expect(await run(choice(), shown({ decision: null }))).toMatchObject({ ok: false, status: 400, code: 'ADDON_DECISION_REQUIRED' });
        expect(await run(choice(), undefined)).toMatchObject({ ok: false, status: 409, code: 'ADDON_OFFER_CHANGED' });
        expect(await run(choice(), shown({ mode: 'included', decision: null }))).toMatchObject({ ok: false, status: 409, code: 'ADDON_OFFER_CHANGED' });
    });

    it('D4. stale page: a different bundle, a removed add-on or a changed mode is refused — nothing written', async () => {
        const W = choice();
        expect(await run(W, shown({ bundleId: BUNDLES.ADDON2.id }))).toMatchObject({ ok: false, status: 409, code: 'ADDON_OFFER_CHANGED' });
        expect(await run(newWorld({ removed_at: new Date(), offer_mode: 'coordinator_choice' }), shown())).toMatchObject({ ok: false, status: 409, code: 'ADDON_OFFER_CHANGED' });
        expect(await run(newWorld({}), shown())).toMatchObject({ ok: false, status: 409, code: 'ADDON_OFFER_CHANGED' });
        expect(await run(newWorld(null), shown())).toMatchObject({ ok: false, status: 409, code: 'ADDON_OFFER_CHANGED' });
        expect(W.writes).toHaveLength(0);
    });

    it('D5. included or no add-on: nothing to answer; an included page\'s acknowledgement is accepted and ignored', async () => {
        for (const [W, sub] of [[newWorld({}), undefined], [newWorld(null), undefined], [newWorld({}), shown({ mode: 'included', decision: null })]] as const) {
            expect(await run(W, sub)).toEqual({ ok: true, recorded: false, decision: null });
            expect(W.writes).toHaveLength(0);
        }
    });

    it('D6. malformed answers are refused; the same answer again writes nothing', async () => {
        for (const bad of ['yes', [], { bundleId: '', decision: 'accepted' }, shown({ decision: 'maybe' })]) {
            expect(await run(choice(), bad)).toMatchObject({ ok: false, status: 400 });
        }
        const W = newWorld({ offer_mode: 'coordinator_choice', coordinator_decision: 'accepted' });
        expect(await run(W, shown())).toEqual({ ok: true, recorded: false, decision: 'accepted' });
        expect(W.writes).toHaveLength(0);
    });

    it('D7. the coordinator can never write a price, percentage, bundle, mode, display toggle or removal', () => {
        const src = strip(R('lib/campaignAddOnEarnings.ts'));
        const start = src.indexOf('export async function recordCoordinatorAddOnDecision(');
        const body = src.slice(start, src.indexOf('\nexport ', start + 10));
        const writes = body.match(/tx\.[a-zA-Z]+\.(update|updateMany|create|delete|deleteMany|upsert)\(/g) || [];
        expect(writes).toEqual(['tx.campaignAddOn.updateMany(']);
        expect(body.slice(body.indexOf('data:'), body.indexOf('data:') + 120)).toMatch(/^data: \{ coordinator_decision: decision, coordinator_decided_at: new Date\(\) \}/);
        // Exactly one data payload, and it holds only the answer; bundle / mode / removal appear only as GUARDS in `where`.
        expect(body.match(/\bdata:/g)).toHaveLength(1);
        const where = body.slice(body.indexOf('where: {', body.indexOf('tx.campaignAddOn.updateMany(')), body.indexOf('data:'));
        expect(where).toMatch(/bundle_id: bundleId,[\s\S]*removed_at: null,[\s\S]*offer_mode: ADDON_OFFER_COORDINATOR_CHOICE,/);
        expect(body).not.toMatch(/share_tiers|price|percent|show_share_percent|removed_at: new/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('E · the real routes', () => {
    let mock: PrismaMock;
    const campaignRow = (o: Record<string, unknown> = {}) => ({
        id: CAMP, name: 'Maple Fundraiser (fixture)', status: 'Active', closed_at: null, customer_id: ORG_A, org_share_percent: 20,
        bundle_selection_status: 'pending', bundle_selection_at: null, bundle_selection_limit: 1,
        customer: { business_id: BIZ_A, name: 'Maple Grove PTO (fixture)' }, ...o,
    });
    const use = (W: World, extra: Record<string, any> = {}) => {
        mock = createPrismaMock({
            results: {
                ...addOnModel(W),
                'coordinatorSession.findUnique': { id: 'session-alf1', campaign_id: CAMP, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null },
                'fundraiserCampaign.findFirst': campaignRow(),
                'fundraiserCampaign.findUnique': campaignRow(),
                'order.count': 0,
                'campaignBundle.findMany': [{ bundle: { id: 'b5-alf1', name: 'Fall Family (fixture)', sku: null, family_id: 'fam-alf1', serving_tier: 'family', business_id: BIZ_A, is_active: true } }],
                ...extra,
                'bundle.findMany': (args: any) => (args?.where?.bundle_type
                    ? addOnModel(W)['bundle.findMany'](args)
                    : [{ id: 'b2-alf1', name: 'Fall Family S2 (fixture)', family_id: 'fam-alf1', serving_tier: 'serves_2', business_id: BIZ_A, is_active: true }]),
            },
        });
        (global as any).__alfPrisma = mock.client;
        return mock;
    };
    const req = (url: string, init: RequestInit = {}) => new Request(`http://localhost${url}`, {
        ...init, headers: { origin: 'http://localhost', 'content-type': 'application/json', ...(init.headers || {}) },
    }) as any;
    const setup = () => require('@/app/api/coordinator/bundle-selection/route');
    const tenant = () => require('@/app/api/campaigns/[id]/add-on/route');
    const patch = async (body: unknown) => readJson(await tenant().PATCH(req(`/api/campaigns/${CAMP}/add-on`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: CAMP }) }));
    const post = async (body: unknown) => readJson(await setup().POST(req('/api/coordinator/bundle-selection', { method: 'POST', body: JSON.stringify(body) })));
    const writesTo = () => ['campaignBundle.create', 'campaignBundle.deleteMany', 'fundraiserCampaign.update', 'coordinatorActionEvent.create', 'campaignAddOn.updateMany']
        .flatMap((k) => mock.callsTo(k).map(() => k));

    it('E1. tenant PATCH { offerMode }: administrator only, under the campaign lock, returns the refreshed view', async () => {
        const W = newWorld({});
        use(W);
        (global as any).__alfSession = { user: { id: 'u-staff', businessId: BIZ_A, role: 'STAFF' } };
        expect((await patch({ offerMode: 'coordinator_choice' })).status).toBe(403);
        expect(W.addOn!.offer_mode).toBe('included');
        (global as any).__alfSession = { user: { id: 'u-admin', businessId: BIZ_A, role: 'ADMIN' } };
        const ok = await patch({ offerMode: 'coordinator_choice' });
        expect(ok.status).toBe(200);
        expect(ok.body.addOn).toMatchObject({ offerMode: 'coordinator_choice', coordinatorDecision: null, offeredToSupporters: false });
        expect(mock.client.$executeRawUnsafe).toHaveBeenCalled();
        expect(W.addOn!.offer_mode).toBe('coordinator_choice');
    });

    it('E2. tenant PATCH: a closed fundraiser is refused; another tenant\'s campaign is 404', async () => {
        const W = newWorld({});
        use(W, { 'fundraiserCampaign.findUnique': campaignRow({ closed_at: new Date('2026-11-20T00:00:00Z') }) });
        expect((await patch({ offerMode: 'coordinator_choice' })).body.code).toBe('CAMPAIGN_CLOSED');
        use(W, { 'fundraiserCampaign.findUnique': campaignRow({ customer: { business_id: BIZ_B } }) });
        expect((await patch({ offerMode: 'coordinator_choice' })).status).toBe(404);
        expect(W.addOn!.offer_mode).toBe('included');
    });

    it('E3. tenant PATCH: including a declined add-on without confirmation is 409; with it, 200', async () => {
        const W = newWorld({ offer_mode: 'coordinator_choice', coordinator_decision: 'declined' });
        use(W);
        expect((await patch({ offerMode: 'included' })).body.code).toBe('ADDON_DECLINED_CONFIRM_REQUIRED');
        const ok = await patch({ offerMode: 'included', confirmOverrideDecline: true });
        expect(ok.status).toBe(200);
        expect(ok.body.addOn).toMatchObject({ offerMode: 'included', coordinatorDecision: 'declined', offeredToSupporters: true });
    });

    it('E4. setup GET returns the offer for display (and null when there is none)', async () => {
        (global as any).__alfAuthed = true;
        use(newWorld({ offer_mode: 'coordinator_choice' }));
        const res = await readJson(await setup().GET(req('/api/coordinator/bundle-selection')));
        expect(res.status).toBe(200);
        expect(res.body.addOnOffer).toMatchObject({ name: 'Sides & Dessert Bundle', price: 25, mode: 'coordinator_choice', decision: null, earnsShare: true });
        expect(JSON.stringify(res.body.addOnOffer)).not.toMatch(/business_id|campaign_id|show_share_percent|starting_quantity/);
        use(newWorld(null));
        expect((await readJson(await setup().GET(req('/api/coordinator/bundle-selection')))).body.addOnOffer).toBeNull();
    });

    it('E5. setup POST, coordinator choice, NO answer: refused — no bundle activated, nothing written', async () => {
        (global as any).__alfAuthed = true;
        use(newWorld({ offer_mode: 'coordinator_choice' }));
        const res = await post({ familyIds: ['fam-alf1'] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ADDON_OFFER_CHANGED');
        expect(writesTo()).toEqual([]);
        expect(mock.client.$executeRawUnsafe).toHaveBeenCalled();
    });

    it('E6. setup POST "Yes": bundles activated AND the answer recorded in the same transaction; the event names it', async () => {
        (global as any).__alfAuthed = true;
        const W = newWorld({ offer_mode: 'coordinator_choice' });
        use(W);
        const res = await post({ familyIds: ['fam-alf1'], addOn: { bundleId: BUNDLES.ADDON.id, mode: 'coordinator_choice', decision: 'accepted', price: 0.01, percent: 99, offerMode: 'included' } });
        expect(res.status).toBe(200);
        expect(W.addOn).toMatchObject({ coordinator_decision: 'accepted', offer_mode: 'coordinator_choice', bundle_id: BUNDLES.ADDON.id });
        expect(W.tiers.map((t) => t.percent)).toEqual([10]);
        expect(mock.firstCall('coordinatorActionEvent.create')!.args.data.metadata).toMatchObject({ addOnDecision: 'accepted' });
        // The answer is written before the activation writes, after the lock.
        const order = mock.calls.map((c) => `${c.model}.${c.method}`);
        expect(order.indexOf('campaignAddOn.updateMany')).toBeLessThan(order.indexOf('campaignBundle.create'));
        expect(mock.callsTo('fundraiserCampaign.update')[0].args.data).toMatchObject({ bundle_selection_status: 'selected' });
        expect(JSON.stringify(mock.callsTo('fundraiserCampaign.update')[0].args.data)).not.toMatch(/addOn|offer_mode|coordinator_decision/);
    });

    it('E7. setup POST "No thanks": recorded; supporters are not offered it', async () => {
        (global as any).__alfAuthed = true;
        const W = newWorld({ offer_mode: 'coordinator_choice' });
        use(W);
        expect((await post({ familyIds: ['fam-alf1'], addOn: { bundleId: BUNDLES.ADDON.id, mode: 'coordinator_choice', decision: 'declined' } })).status).toBe(200);
        expect(W.addOn!.coordinator_decision).toBe('declined');
        expect(isSupporterOfferedAddOnRow(W.addOn)).toBe(false);
    });

    it('E8. setup POST naming another bundle (stale or forged): 409, nothing written', async () => {
        (global as any).__alfAuthed = true;
        use(newWorld({ offer_mode: 'coordinator_choice' }));
        const res = await post({ familyIds: ['fam-alf1'], addOn: { bundleId: BUNDLES.FOREIGN.id, mode: 'coordinator_choice', decision: 'accepted' } });
        expect(res.status).toBe(409);
        expect(writesTo()).toEqual([]);
    });

    it('E9. setup POST with no add-on configured: exactly as before (no add-on read writes, no event field)', async () => {
        (global as any).__alfAuthed = true;
        use(newWorld(null));
        const res = await post({ familyIds: ['fam-alf1'] });
        expect(res.status).toBe(200);
        expect(mock.callsTo('campaignAddOn.updateMany')).toHaveLength(0);
        expect(mock.firstCall('coordinatorActionEvent.create')!.args.data.metadata).not.toHaveProperty('addOnDecision');
    });

    it('E10. setup POST: the lock is the first statement and the answer check precedes the first write', () => {
        const src = strip(R('app/api/coordinator/bundle-selection/route.ts'));
        const tx = src.slice(src.indexOf('return await prisma.$transaction('));
        const lock = tx.indexOf('await lockCampaignSelection(tx, campaignId);');
        const answer = tx.indexOf('recordCoordinatorAddOnDecision(tx');
        const firstWrite = Math.min(...['tx.campaignBundle.deleteMany(', 'tx.campaignBundle.create(', 'tx.fundraiserCampaign.update(']
            .map((s) => tx.indexOf(s)).filter((i) => i >= 0));
        expect(lock).toBeGreaterThan(-1);
        expect(lock).toBeLessThan(answer);
        expect(answer).toBeLessThan(firstWrite);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('F · the setup invitation', () => {
    const URL = 'https://app.example.test/coordinator/access#fixture-credential-not-real';
    const TENANT = { name: 'Example Kitchen', email: 'hello@example.test' };
    const baseline = () => {
        const ts = require('typescript');
        const src = execSync(`git show ${BASE}:lib/emailTemplates.ts`, { cwd: ROOT, encoding: 'utf8' });
        const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
        const mod: any = { exports: {} };
        // eslint-disable-next-line no-new-func
        new Function('require', 'module', 'exports', out)((id: string) => require(id), mod, mod.exports);
        return mod.exports.coordinatorSetupTemplate;
    };
    const addOnPart = (html: string) => {
        const a = html.indexOf('*NEW* Add an optional');
        const b = html.indexOf('Also on your fundraiser');
        const at = a >= 0 ? a : b;
        return at < 0 ? '' : html.slice(at, html.indexOf('</li>', at) >= 0 && a >= 0 ? html.indexOf('</li>', at) : html.indexOf('</p>', at));
    };

    it('F1. no add-on: identical to the base invitation except the FIRST-name greeting (D12) and the owner\'s closing line', () => {
        const before = baseline()('Jordan Fixture', 'Maple Grove PTO', URL, TENANT);
        const now = coordinatorSetupTemplate('Jordan Fixture', 'Maple Grove PTO', URL, TENANT);
        expect(now.subject).toBe(before.subject);
        // Owner copy revision 3 (2026-11-27): the closing paragraph of every invitation.
        const OLD_CLOSING = '<p>Once that is done you will have your coordinator panel, where you can share the fundraiser and watch orders arrive as they come in.</p>';
        const NEW_CLOSING = '<p>Once that is done, you will have your Live Coordinator Panel, where you can immediately begin sharing your fundraiser and watch the orders arrive as they come in.</p>';
        expect(before.html).toContain(OLD_CLOSING);
        expect(now.html).toBe(before.html.replace('<p>Hi Jordan Fixture!</p>', '<p>Hi Jordan!</p>').replace(OLD_CLOSING, NEW_CLOSING));
        for (const addOn of [{ name: 'Pie', mode: 'coordinator_choice' as const, earnsShare: true }, { name: 'Pie', mode: 'included' as const, earnsShare: true }]) {
            expect(coordinatorSetupTemplate('Jordan', 'Maple Grove PTO', URL, TENANT, addOn).html).toContain(NEW_CLOSING);
        }
        expect(coordinatorSetupTemplate('', 'Maple Grove PTO', URL, TENANT, null).html).toContain('<p>Hi there!</p>');
        expect(coordinatorSetupTemplate('   ', 'Maple Grove PTO', URL, TENANT).html).toContain('<p>Hi there!</p>');
    });

    it('F2. coordinator decides: three steps, the approved wording with the real name, no figures', () => {
        const { html } = coordinatorSetupTemplate('Jordan Fixture', 'Maple Grove PTO', URL, TENANT, { name: 'Sides & Dessert Bundle', mode: 'coordinator_choice', earnsShare: true });
        // Owner copy revisions 2026-11-27: upbeat; "*NEW*" step; the goal / "completely optional" explanation lives on
        // the setup screen.
        expect(html).toContain('<p>There are three things to do, and they only take a couple minutes:</p>');
        expect(html).toContain('<li><strong>*NEW* Add an optional Sides &amp; Dessert Bundle menu</strong> — a fun extra your supporters can add to their freezer meal order. It gives them a little something more to enjoy with their meals, and every one sold helps your organization earn even more. See the full offer, price and organization earnings before you decide.</li>');
        const li = html.indexOf('<li><strong>Choose your meal bundles');
        expect(li).toBeLessThan(html.indexOf('*NEW* Add an optional'));
        expect(html.indexOf('*NEW* Add an optional')).toBeLessThan(html.indexOf('<li><strong>Confirm the remaining details'));
        expect(addOnPart(html)).not.toMatch(/\$|%|\d/);
        expect(html).not.toMatch(/meal bundle goal|completely optional|complete their meals/);
    });

    it('F3. 0% schedule: no claim that the organization earns more', () => {
        const choice = coordinatorSetupTemplate('Jordan', 'Maple Grove PTO', URL, TENANT, { name: 'Pie Add-On', mode: 'coordinator_choice', earnsShare: false }).html;
        expect(choice).toContain('— a fun extra your supporters can add to their freezer meal order. It gives them a little something more to enjoy with their meals. See the full offer and price before you decide.</li>');
        expect(choice).not.toMatch(/earn even more|earnings/);
        const inc = coordinatorSetupTemplate('Jordan', 'Maple Grove PTO', URL, TENANT, { name: 'Pie Add-On', mode: 'included', earnsShare: false }).html;
        expect(inc).toContain('a fun extra that gives them a little something more to enjoy. You\'ll see the price while you set up.</p>');
        expect(inc).not.toMatch(/earn even more|earnings/);
    });

    it('F4. included: explains the add-on without asking for a decision; two steps', () => {
        const { html } = coordinatorSetupTemplate('Jordan Fixture', 'Maple Grove PTO', URL, TENANT, { name: 'Sides & Dessert Bundle', mode: 'included', earnsShare: true });
        expect(html).toContain('<p>There are two things to do, and they take a few minutes:</p>');
        expect(html).toContain('<p><strong>Also on your fundraiser: a tasty bonus.</strong> Your supporters can add our <strong>Sides &amp; Dessert Bundle</strong> to their freezer meal order, a fun extra that gives them a little something more to enjoy, and every one sold helps your organization earn even more. You\'ll see the price and your organization\'s earnings while you set up.</p>');
        expect(html).not.toMatch(/Decide on|accept|decline|choose to offer|meal bundle goal/i);
        expect(addOnPart(html)).not.toMatch(/\$|%|\d/);
    });

    it('F5. the credential exists only as the button href; the add-on name is escaped', () => {
        for (const addOn of [null, { name: '<b>Pie</b> & "Co"', mode: 'coordinator_choice' as const, earnsShare: true }, { name: 'Pie', mode: 'included' as const, earnsShare: true }]) {
            const { html } = coordinatorSetupTemplate('Jordan', 'Maple Grove PTO', URL, TENANT, addOn);
            expect(html.split(URL).length - 1).toBe(1);
            expect(html).toContain(`href="${URL}"`);
            expect(html).not.toContain('<b>Pie</b>');
        }
    });

    it('F6. the route names the add-on from the authoritative loader, omits a declined one, and keeps the one-send claim', () => {
        const src = strip(R('app/api/campaigns/[id]/coordinator-email/route.ts'));
        expect(src).toMatch(/loadCoordinatorSetupAddOnOffer\(prisma, \{ campaignId, businessId \}\)/);
        expect(src).toMatch(/addOnOffer\.mode === 'coordinator_choice' && addOnOffer\.decision === 'declined'/);
        expect(src).toMatch(/\{ name: addOnOffer\.name, mode: addOnOffer\.mode, earnsShare: addOnOffer\.earnsShare \}/);
        expect(src).not.toMatch(/addOnOffer\.(price|shareSummary|shareTiers)/);
        const before = execSync(`git show ${BASE}:"app/api/campaigns/[id]/coordinator-email/route.ts"`, { cwd: ROOT, encoding: 'utf8' }).replace(/\r\n/g, '\n');
        const post = (s: string) => s.slice(s.indexOf('export async function POST'));
        expect(post(R('app/api/campaigns/[id]/coordinator-email/route.ts'))).toBe(post(before));
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('G · the coordinator setup screen', () => {
    const offer = (o: Partial<CoordinatorAddOnOffer> = {}): CoordinatorAddOnOffer => ({
        bundleId: BUNDLES.ADDON.id, name: 'Sides & Dessert Bundle', description: 'Two sides and a dessert.', imageUrl: 'https://cdn.example.test/addon.png',
        price: 25, meals: ['Garlic Green Beans', 'Brownie Bites'], shareSummary: 'Your organization earns 10% on this add-on.',
        shareTiers: [{ rangeLabel: '1+ sold', percent: 10 }], earnsShare: true, mode: 'coordinator_choice', decision: null, ...o,
    });
    const render = (o: Partial<CoordinatorAddOnOffer> = {}, answer: 'accepted' | 'declined' | null = null) =>
        renderToStaticMarkup(React.createElement(AddOnOfferSection, { offer: offer(o), answer, onAnswer: () => undefined }));

    it('G1. coordinator decides: heading, the real facts, the goal note, and two choices with NEITHER pre-selected', () => {
        const html = render();
        expect(html).toContain('Help your organization earn even more!');
        expect(html).toContain('Offer our Sides &amp; Dessert Bundle, a fun extra your supporters can add to their freezer meal order. It gives them a little something more to enjoy, and every one sold raises even more for your organization.');
        // Owner copy revision 2026-11-27: the goal explanation lives HERE, in the coordinator's own words.
        for (const s of ['$25.00', 'Garlic Green Beans', 'Brownie Bites', 'Your organization earns 10% on this add-on.', 'https://cdn.example.test/addon.png',
            'Supporters can add it to any order that includes a meal bundle.',
            'Add-ons earn money for your organization, but they won’t show up in your Bundles Sold count or on your fundraiser scoreboard.']) {
            expect({ s, ok: html.includes(s) }).toEqual({ s, ok: true });
        }
        expect(html).toContain(ADDON_YES_LABEL.replace("'", '&#x27;'));
        expect(html).toContain(ADDON_NO_LABEL.replace("'", '&#x27;'));
        expect(html.match(/type="radio"/g)).toHaveLength(2);
        expect(html).not.toMatch(/checked=""/);
        expect(render({}, 'accepted').match(/checked=""/g)).toHaveLength(1);
    });

    it('G2. included: informational — no choice to make', () => {
        const html = render({ mode: 'included' });
        expect(html).toContain('An optional add-on is included in your fundraiser');
        expect(html).toContain('Your organizer has included Sides &amp; Dessert Bundle, a fun extra your supporters can add to their freezer meal order.');
        expect(html).toContain('won’t show up in your Bundles Sold count or on your fundraiser scoreboard');
        expect(html).not.toMatch(/type="radio"/);
    });

    it('G3. 0%: no claim of extra earnings anywhere on the card', () => {
        const html = render({ earnsShare: false, shareSummary: 'Your organization earns 0% on this add-on.' });
        expect(html).toContain('A tasty bonus for your supporters');
        expect(html).toContain('Add-ons won’t show up in your Bundles Sold count or on your fundraiser scoreboard.');
        expect(html).not.toMatch(/earn even more|raises even more|earn money|additional money/);
    });

    it('G4. the step requires an answer and sends ONLY the offer it showed and the answer', () => {
        const src = strip(R('components/coordinator/BundleSelectionStep.tsx'));
        expect(src).toMatch(/const readyToSubmit = selectedCount === limit && !addOnAnswerNeeded;/);
        expect(src).toMatch(/if \(addOnOffer\?\.mode === 'coordinator_choice' && !addOnAnswer\) return;/);
        const body = src.slice(src.indexOf('addOn: {'), src.indexOf('addOn: {') + 260);
        expect(body).toMatch(/bundleId: addOnOffer\.bundleId,\s*mode: addOnOffer\.mode,\s*decision: addOnOffer\.mode === 'coordinator_choice' \? addOnAnswer : null,/);
        expect(body).not.toMatch(/price|percent|share/);
        // A changed offer reloads ONLY the offer — the coordinator's picks and typed logistics are kept.
        const stale = src.slice(src.indexOf("body?.code === 'ADDON_OFFER_CHANGED'"), src.indexOf('if (res.status === 409)'));
        expect(stale).not.toMatch(/fetchSelectionState|setSetupFields|selectedFamilyIds:/);
        expect(stale).toMatch(/setAddOnOffer\(offer\)/);
    });

    it('G5. the section sits after the meal choice, as its own section', () => {
        const src = R('components/coordinator/BundleSelectionStep.tsx');
        const cards = src.indexOf('{/* Candidate family cards */}');
        const addOn = src.indexOf('<AddOnOfferSection');
        const review = src.indexOf('{/* Review + submit */}');
        expect(cards).toBeGreaterThan(-1);
        expect(cards).toBeLessThan(addOn);
        expect(addOn).toBeLessThan(review);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('H · the tenant launch flows', () => {
    it('H1. lead → Launch Fundraiser: Step 2 (the add-on card) comes before Step 3 (the setup email)', () => {
        const src = R('components/crm2/LaunchFundraiserDialog.tsx');
        const success = src.slice(src.indexOf('/* ── Success: Awaiting Coordinator Setup'));
        const step2 = success.indexOf('Step 2 of 3 · Optional supporter add-on');
        const card = success.indexOf('<CampaignAddOnCard key={result.campaignId} campaignId={result.campaignId} />');
        const step3 = success.indexOf('Step 3 of 3 · Send the setup email');
        const review = success.indexOf('Review &amp; send coordinator email');
        expect([step2 > -1, card > step2, step3 > card, review > step3]).toEqual([true, true, true, true]);
        // The creation transaction is untouched: the add-on uses its own, existing API afterwards.
        expect(execSync(`git diff --name-only ${BASE} -- "app/api/opportunities/[id]/launch/route.ts" app/api/campaigns/route.ts lib/fundraiserLaunch.ts lib/fundraiserWizardSubmit.ts`, { cwd: ROOT, encoding: 'utf8' }).trim()).toBe('');
    });

    it('H2. Start Fundraiser wizard (direct and rebooking — one wizard): the add-on card in the launch kit', () => {
        const src = R('components/crm2/StartFundraiserWizard.tsx');
        const step3 = src.slice(src.indexOf('{step === 3 && kit && ('));
        expect(step3).toContain('<CampaignAddOnCard key={kit.campaign.id} campaignId={kit.campaign.id} />');
        expect(step3.indexOf('<CampaignAddOnCard')).toBeLessThan(step3.indexOf('Info-packet email'));
        expect(R('app/fundraisers/page.tsx')).toMatch(/rebooking=\{/);
    });

    it('H3. Campaign drawer: while awaiting setup and before the invitation, the add-on card comes FIRST — rendered once', () => {
        const src = strip(R('components/crm2/CampaignContextDrawer.tsx'));
        expect(src).toMatch(/const addOnBeforeInvitation = !c\.is_placeholder && awaitingCoordinatorSetup && !c\.coordinator_invite_sent_at;/);
        const early = src.indexOf('{addOnBeforeInvitation && (');
        const email = src.indexOf('<CoordinatorSetupEmailCard');
        const late = src.indexOf('{!c.is_placeholder && !addOnBeforeInvitation && (');
        expect(early).toBeGreaterThan(-1);
        expect(early).toBeLessThan(email);
        expect(late).toBeGreaterThan(email);
        expect(src.split('<CampaignAddOnCard').length - 1).toBe(2);
    });

    it('H4. the CRM card states where the coordinator\'s participation stands, in plain words', () => {
        expect(coordinatorStatusLine({ offerMode: 'coordinator_choice', coordinatorDecision: null })).toBe("Waiting for the coordinator's answer — supporters aren't offered it until they say yes.");
        expect(coordinatorStatusLine({ offerMode: 'coordinator_choice', coordinatorDecision: 'accepted', coordinatorDecidedAt: '2026-11-26T15:00:00Z' })).toMatch(/^The coordinator said yes on .+ — supporters are offered it\.$/);
        expect(coordinatorStatusLine({ offerMode: 'coordinator_choice', coordinatorDecision: 'declined' })).toBe("The coordinator said no thanks — supporters aren't offered it.");
        expect(coordinatorStatusLine({ offerMode: 'included', coordinatorDecision: 'declined' })).toBe('Included by you. The coordinator had said no thanks.');
        expect(coordinatorStatusLine({ offerMode: 'included' })).toBe('Supporters are offered it beside their meal bundles once ordering opens.');
        const src = R('components/crm2/CampaignAddOnCard.tsx');
        expect(src).toContain('Let the coordinator decide during setup');
        expect(src).toContain('Include it in this fundraiser');
        expect(src).toMatch(/confirmOverrideDecline: true/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('I · migration 6, financial invariants, scope', () => {
    it('I1. migration 6: three additive columns and two CHECKs, nothing else; existing rows read included/null', () => {
        const code = R(M6_SQL).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        expect(code.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)).toEqual([
            'ALTER TABLE "campaign_add_ons" ADD COLUMN "offer_mode" TEXT NOT NULL DEFAULT \'included\'',
            'ALTER TABLE "campaign_add_ons" ADD COLUMN "coordinator_decision" TEXT',
            'ALTER TABLE "campaign_add_ons" ADD COLUMN "coordinator_decided_at" TIMESTAMP(3)',
            'ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_offer_mode_check" CHECK ("offer_mode" IN (\'included\', \'coordinator_choice\'))',
            'ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_coordinator_decision_check" CHECK ("coordinator_decision" IS NULL OR "coordinator_decision" IN (\'accepted\', \'declined\'))',
        ]);
        expect(code).not.toMatch(/\b(UPDATE|DELETE|DROP|RENAME|INSERT)\b/i);
    });

    it('I2. the migration file\'s checksum (LF, as committed) is pinned', () => {
        expect(crypto.createHash('sha256').update(R(M6_SQL)).digest('hex')).toBe('deaecdcfce6305c51809993e48e1d40c680d23ba8d3fd730a29a3316b6e1a4e0');
    });

    it('I3. it is the newest migration and no committed migration changed', () => {
        const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        expect(dirs[dirs.length - 1]).toBe(M6);
        expect(dirs[dirs.length - 2]).toBe('20261127120000_supporter_addon_b2_removed_at');
        expect(execSync(`git diff --name-only ${BASE} -- prisma/migrations`, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
            .every((f) => f.startsWith(`prisma/migrations/${M6}/`))).toBe(true);
        const schema = R('prisma/schema.prisma');
        expect(schema).toMatch(/model CampaignAddOn \{[\s\S]*?offer_mode String @default\("included"\)\n[\s\S]*?coordinator_decision String\?\n  coordinator_decided_at DateTime\?\n[\s\S]*?@@map\("campaign_add_ons"\)/);
    });

    it('I4. no money path changes: pricing, tax, goal, earnings recording, closeout, invoices and the order routes', () => {
        const out = execSync(`git diff --name-only ${BASE} -- lib/pricing.ts lib/fundraiserTax.ts lib/fundraiserMetrics.ts lib/campaignAddOnShare.ts lib/fundraiserCloseoutMath.ts lib/quickbooks lib/invoice*.ts "app/api/campaigns/[id]/closeout" app/api/public/order/route.ts app/api/coordinator/route.ts app/api/orders lib/statusWorkflow.ts lib/kitchen_engine.ts lib/cost_engine.ts`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(out).toBe('');
        const src = strip(R('lib/campaignAddOnEarnings.ts'));
        const fnOf = (text: string) => { const at = text.indexOf('export async function recordAddOnShareEarnings('); return text.slice(at, text.indexOf('\nexport ', at + 10)); };
        const before = strip(execSync(`git show ${BASE}:lib/campaignAddOnEarnings.ts`, { cwd: ROOT, encoding: 'utf8' }).replace(/\r\n/g, '\n'));
        expect(fnOf(src)).toBe(fnOf(before));
        expect(fnOf(src).length).toBeGreaterThan(500);
    });

    it('I5. a decline after recorded add-on sales leaves every recorded share and tier position untouched', async () => {
        const W = newWorld({ offer_mode: 'coordinator_choice', coordinator_decision: 'accepted' }, [[1, 10], [6, 15]]);
        W.slices = [{ first_unit: 1, quantity: 7 }];
        const db = libDb(W);
        expect(await recordCoordinatorAddOnDecision(db, { campaignId: CAMP, businessId: BIZ_A, submitted: { bundleId: BUNDLES.ADDON.id, mode: 'coordinator_choice', decision: 'declined' } }))
            .toMatchObject({ ok: true, recorded: true });
        expect(W.slices).toEqual([{ first_unit: 1, quantity: 7 }]);
        expect(W.tiers.map((t) => [t.starting_quantity, t.percent])).toEqual([[1, 10], [6, 15]]);
        expect(W.writes.map((w) => w.op)).toEqual(['updateMany']);
        // The tenant can still edit future tiers while it is not offered (configured rule).
        expect(await loadCampaignAddOnSchedule(db, { campaignId: CAMP, businessId: BIZ_A })).not.toBeNull();
    });

    it('I6. untouched channels and features: supporter page, scoreboard, coordinator portal page, consent, Bundle Editor', () => {
        const out = execSync(`git diff --name-only ${BASE} -- "app/shop/[slug]/fundraiser" "app/fundraiser" app/coordinator lib/publicFundraiserPayload.ts components/fundraiser components/BundleEditor.tsx lib/bundleEditorSave.ts lib/bundleSkuGenerator.ts lib/supporterConsent.ts lib/fundraiserLead.ts app/api/flyer app/api/packet app/api/tracker`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(out).toBe('');
    });
});
