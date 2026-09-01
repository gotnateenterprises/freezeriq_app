/**
 * FULFILLMENT-CONTINUITY-1 — the delivery classification safety rail.
 *
 * WHY THIS SUITE EXISTS
 *
 * app/delivery/page.tsx renders one delivery stop per Order and is entirely
 * campaign-blind. The same map/render pair draws fundraiser supporter stops and
 * ordinary customer stops, with no discriminator between them — so the eventual
 * "one campaign = one stop" repair would have to be written inside the one code
 * path that also draws every regular customer's delivery.
 *
 * This suite pins the discriminator BEFORE that change is attempted. Nothing
 * imports lib/delivery/orderClassification.ts yet; no delivery behaviour has
 * changed. These are the fixtures the future repair must keep passing.
 *
 * The seven scenarios below are the ones named in the phase brief, plus the
 * ambiguity cases that stop the rule from guessing.
 */
import {
    classifyDeliveryOrder,
    isFundraiserFulfillmentOrder,
    isRegularCustomerDeliveryOrder,
    fundraiserGroupingKey,
    fundraiserDeliveryLocation,
    customerDeliveryLocation,
    groupOrdersForDelivery,
    FUNDRAISER_ORDER_SOURCE,
} from '@/lib/delivery/orderClassification';

const CAMPAIGN_A = 'campaign-fc1-a';
const CAMPAIGN_B = 'campaign-fc1-b';

/** A public supporter order: source fundraiser, campaign set, NO address. */
const supporterOrder = (campaignId: string, pickup: string | null = 'School gym, north entrance') => ({
    source: FUNDRAISER_ORDER_SOURCE,
    campaign_id: campaignId,
    delivery_address: null,
    campaign: { id: campaignId, pickup_location: pickup },
});

/** A coordinator-entered order: same campaign, but a free-text NOTE in the
 *  address column and the ORGANIZATION as its customer. */
const coordinatorOrder = (campaignId: string, note: string | null = 'Delivery to Room 24, ask for Dana') => ({
    source: FUNDRAISER_ORDER_SOURCE,
    campaign_id: campaignId,
    delivery_address: note,
    campaign: { id: campaignId, pickup_location: 'School gym, north entrance' },
});

const customerOrder = (address: string | null = '123 Main St, Paris, IL 61944') => ({
    source: 'storefront',
    campaign_id: null,
    delivery_address: address,
    campaign: null,
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. The seven required scenarios.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. required classification scenarios', () => {
    it('(1) two fundraiser orders in the same campaign classify into the SAME group', () => {
        const a = supporterOrder(CAMPAIGN_A);
        const b = supporterOrder(CAMPAIGN_A);

        expect(fundraiserGroupingKey(a)).toBe(CAMPAIGN_A);
        expect(fundraiserGroupingKey(b)).toBe(CAMPAIGN_A);
        expect(groupOrdersForDelivery([a, b])).toHaveLength(1);
    });

    it('(2) two campaigns at the SAME organization are DIFFERENT groups', () => {
        // One organization may run several campaigns at once. They are separate
        // production jobs and separate delivery stops.
        const a = supporterOrder(CAMPAIGN_A);
        const b = supporterOrder(CAMPAIGN_B);

        expect(fundraiserGroupingKey(a)).not.toBe(fundraiserGroupingKey(b));
        const groups = groupOrdersForDelivery([a, b]);
        expect(groups).toHaveLength(2);
        expect(groups.map((g) => g.campaignId).sort()).toEqual([CAMPAIGN_A, CAMPAIGN_B].sort());
    });

    it('(3) a public supporter order and a coordinator-entered order in one campaign group together', () => {
        // These two paths disagree about customer_id by design — the public path
        // links a per-supporter customer, the coordinator path links the
        // organization. Grouping on customer_id would split this campaign.
        const pub = supporterOrder(CAMPAIGN_A);
        const coord = coordinatorOrder(CAMPAIGN_A);

        expect(classifyDeliveryOrder(pub)).toBe('fundraiser');
        expect(classifyDeliveryOrder(coord)).toBe('fundraiser');
        expect(fundraiserGroupingKey(pub)).toBe(fundraiserGroupingKey(coord));

        const groups = groupOrdersForDelivery([pub, coord]);
        expect(groups).toHaveLength(1);
        expect(groups[0].orders).toHaveLength(2);
    });

    it('(4) an ordinary customer order remains ordinary delivery', () => {
        const o = customerOrder();
        expect(classifyDeliveryOrder(o)).toBe('customer');
        expect(isRegularCustomerDeliveryOrder(o)).toBe(true);
        expect(isFundraiserFulfillmentOrder(o)).toBe(false);
        expect(fundraiserGroupingKey(o)).toBeNull();
    });

    it('(5) ordinary orders never merge with each other or with a campaign', () => {
        const groups = groupOrdersForDelivery([
            customerOrder('123 Main St'),
            customerOrder('456 Oak Ave'),
            supporterOrder(CAMPAIGN_A),
        ]);

        expect(groups).toHaveLength(3);
        expect(groups.filter((g) => g.kind === 'customer')).toHaveLength(2);
        expect(groups.filter((g) => g.kind === 'fundraiser')).toHaveLength(1);
    });

    it('(6) a fundraiser order with a NULL address resolves its location from the campaign', () => {
        const o = supporterOrder(CAMPAIGN_A, 'School gym, north entrance');
        expect(o.delivery_address).toBeNull();

        expect(fundraiserDeliveryLocation(o)).toEqual({
            status: 'resolved',
            location: 'School gym, north entrance',
            campaignId: CAMPAIGN_A,
        });
    });

    it('(7) a legacy NOTE in delivery_address must NOT override the campaign pickup location', () => {
        const o = coordinatorOrder(CAMPAIGN_A, 'Delivery to Room 24, ask for Dana');

        const location = fundraiserDeliveryLocation(o);
        expect(location).toEqual({
            status: 'resolved',
            location: 'School gym, north entrance',
            campaignId: CAMPAIGN_A,
        });
        // The note must never leak into the resolved location.
        expect(JSON.stringify(location)).not.toContain('Room 24');
        // And it is not offered as a customer address either.
        expect(customerDeliveryLocation(o)).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The rule never guesses.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. ambiguity is reported, never resolved by guessing', () => {
    it('fundraiser source with no campaign_id is ambiguous, not a customer order', () => {
        const o = { source: FUNDRAISER_ORDER_SOURCE, campaign_id: null, delivery_address: null };
        expect(classifyDeliveryOrder(o)).toBe('ambiguous');
        expect(isFundraiserFulfillmentOrder(o)).toBe(false);
        expect(isRegularCustomerDeliveryOrder(o)).toBe(false);
    });

    it('a campaign_id on a non-fundraiser source is ambiguous, not a fundraiser order', () => {
        const o = { source: 'manual', campaign_id: CAMPAIGN_A, delivery_address: null };
        expect(classifyDeliveryOrder(o)).toBe('ambiguous');
        expect(fundraiserGroupingKey(o)).toBeNull();
    });

    it('a missing source is ambiguous', () => {
        expect(classifyDeliveryOrder({ campaign_id: null } as any)).toBe('ambiguous');
        expect(classifyDeliveryOrder(null)).toBe('ambiguous');
        expect(classifyDeliveryOrder({ source: '   ' } as any)).toBe('ambiguous');
    });

    it('an empty-string campaign_id is not a grouping key', () => {
        const o = { source: FUNDRAISER_ORDER_SOURCE, campaign_id: '', delivery_address: null };
        expect(fundraiserGroupingKey(o)).toBeNull();
        expect(classifyDeliveryOrder(o)).toBe('ambiguous');
    });

    it('ambiguous rows survive grouping in their own bucket rather than being dropped', () => {
        const bad = { source: FUNDRAISER_ORDER_SOURCE, campaign_id: null, delivery_address: null };
        const groups = groupOrdersForDelivery([supporterOrder(CAMPAIGN_A), bad]);

        expect(groups).toHaveLength(2);
        expect(groups.some((g) => g.kind === 'ambiguous')).toBe(true);
        expect(groups.flatMap((g) => g.orders)).toHaveLength(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Location resolution distinguishes "none recorded" from "not loaded".
// ═════════════════════════════════════════════════════════════════════════════
describe('3. fundraiserDeliveryLocation', () => {
    it('reports not_recorded when the campaign has no pickup location', () => {
        // The common case: no campaign-creation path writes pickup_location, so
        // a launched campaign holds NULL by default.
        expect(fundraiserDeliveryLocation(supporterOrder(CAMPAIGN_A, null))).toEqual({
            status: 'not_recorded',
            campaignId: CAMPAIGN_A,
        });
    });

    it('treats a blank pickup location as not recorded', () => {
        expect(fundraiserDeliveryLocation(supporterOrder(CAMPAIGN_A, '   '))).toEqual({
            status: 'not_recorded',
            campaignId: CAMPAIGN_A,
        });
    });

    it('reports campaign_not_loaded distinctly, so a caller cannot mistake it for "no location"', () => {
        const o = { source: FUNDRAISER_ORDER_SOURCE, campaign_id: CAMPAIGN_A, delivery_address: null };
        expect(fundraiserDeliveryLocation(o)).toEqual({ status: 'campaign_not_loaded' });
    });

    it('refuses to answer for a non-fundraiser order', () => {
        expect(fundraiserDeliveryLocation(customerOrder())).toEqual({ status: 'not_a_fundraiser_order' });
    });

    it('trims a padded location', () => {
        const r = fundraiserDeliveryLocation(supporterOrder(CAMPAIGN_A, '  Community Center  '));
        expect(r).toMatchObject({ status: 'resolved', location: 'Community Center' });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Ordinary customer delivery is preserved exactly.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. ordinary customer delivery is preserved', () => {
    it('uses Order.delivery_address', () => {
        expect(customerDeliveryLocation(customerOrder('123 Main St, Paris, IL'))).toBe('123 Main St, Paris, IL');
    });

    it('reports null when no address was recorded, rather than inventing one', () => {
        expect(customerDeliveryLocation(customerOrder(null))).toBeNull();
        expect(customerDeliveryLocation(customerOrder('  '))).toBeNull();
    });

    it('classifies every non-fundraiser source as ordinary customer work', () => {
        for (const source of ['storefront', 'manual', 'square', 'qbo', 'meta']) {
            expect(classifyDeliveryOrder({ source, campaign_id: null, delivery_address: 'x' })).toBe('customer');
        }
    });

    it('one ordinary order is always exactly one group — never collapsed', () => {
        const orders = [customerOrder('123 Main St'), customerOrder('123 Main St')];
        // Same address, deliberately: ordinary orders are NOT merged by address.
        expect(groupOrdersForDelivery(orders)).toHaveLength(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Structure — the boundary stays pure and inert.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. lib/delivery/orderClassification.ts structure', () => {
    const read = (p: string) =>
        require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

    it('imports nothing at all — no Prisma, no env, no network', () => {
        const src = read('lib/delivery/orderClassification.ts');
        expect(src).not.toMatch(/^\s*import\s/m);
        expect(src).not.toMatch(/require\(/);
        expect(src).not.toMatch(/process\.env/);
        expect(src).not.toMatch(/fetch\(/);
    });

    it('fundraiserDeliveryLocation never reads an address column', () => {
        const src = read('lib/delivery/orderClassification.ts');
        const start = src.indexOf('export function fundraiserDeliveryLocation');
        expect(start).toBeGreaterThan(-1);
        // Bound the slice to THIS function body, ending at its closing brace.
        // customerDeliveryLocation below it reads delivery_address legitimately,
        // and its doc comment names the column too.
        const rest = src.slice(start);
        const end = rest.indexOf('\n}');
        expect(end).toBeGreaterThan(-1);
        const fn = rest.slice(0, end);

        expect(fn).not.toMatch(/delivery_address/);
        expect(fn).toMatch(/pickup_location/);
    });

    it('changes no delivery behaviour yet — nothing in app/, components/ or lib/ imports it', () => {
        // Walked in Node rather than shelled out to a grep binary: a missing
        // binary would make this assertion pass vacuously, which is precisely
        // the false green it exists to prevent.
        const fs = require('fs');
        const path = require('path');

        const hits: string[] = [];
        let scanned = 0;
        const walk = (dir: string) => {
            let entries: any[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next') continue;
                    walk(full);
                } else if (/\.(ts|tsx)$/.test(e.name)) {
                    scanned++;
                    if (fs.readFileSync(full, 'utf8').includes('delivery/orderClassification')) {
                        hits.push(full.replace(/\\/g, '/'));
                    }
                }
            }
        };
        for (const root of ['app', 'components', 'lib']) walk(path.join(process.cwd(), root));

        // Prove the walk actually ran, so an empty result means "no importers"
        // rather than "scanned nothing". The module itself does not appear in
        // hits: it has no self-import.
        expect(scanned).toBeGreaterThan(100);
        expect(fs.existsSync(path.join(process.cwd(), 'lib/delivery/orderClassification.ts'))).toBe(true);
        expect(hits).toEqual([]);
    });
});
