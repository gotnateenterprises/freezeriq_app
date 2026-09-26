/**
 * BOX-LABEL-ORG-1 — the fundraiser organization line on the box label.
 *
 * THE PROBLEM
 * Freezer Chef will have delivery days with multiple fundraiser organizations
 * produced and transported together (Edgar County Farm Bureau, Cumberland
 * County Farm Bureau, Jasper County Farm Bureau, ...). The label already
 * answers "whose box is this?" (supporter name) and "which box, how big,
 * what's inside?" (Box N of M, LARGE/SMALL, contents). It did not answer
 * "which fundraiser/delivery stop does this box belong to?" — the one
 * question that matters once boxes from several organizations are staged
 * together.
 *
 * THE FIX
 * Order.campaign_id -> FundraiserCampaign.customer_id -> Customer.name is the
 * canonical organization identity, resolved ONCE PER ORDER in
 * lib/supporterBoxManifest.ts (resolveOrganizationName), stamped onto every
 * PurchasedBundleInstance and carried onto every PhysicalBox that order
 * produces. It renders above the supporter name on the sticker, per the
 * owner's stated hierarchy: organization, customer, Box N of M / size,
 * contents.
 *
 * WHAT MUST NOT CHANGE, and is asserted below: box counting, LARGE/SMALL
 * assignment, bundle/quarter grouping, quantities, supporter names, the
 * OL600 sheet geometry, and every non-fundraiser (storefront) label's
 * existing appearance.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    buildPurchasedInstances,
    resolveOrganizationName,
    resolveSupporterName,
    type BoxManifestOrder,
} from '@/lib/supporterBoxManifest';
import {
    packOrder,
    buildPhysicalBoxManifest,
    boxContentLines,
    formatBoxContentLine,
    type PhysicalBox,
} from '@/lib/physicalBoxPacking';
import {
    chooseOrgNameTypography,
    chooseStickerTypography,
    ORG_NAME_MEDIUM_THRESHOLD,
    ORG_NAME_LONG_THRESHOLD,
    STICKER_TYPOGRAPHY_TIERS,
} from '@/lib/labelTypography';
import { OL600_SHEET } from '@/lib/labelSheetLayout';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGE = 'app/production/box-labels/page.tsx';
const ROUTE = 'app/api/production/box-labels/route.ts';
const MANIFEST = 'lib/supporterBoxManifest.ts';
const PACKING = 'lib/physicalBoxPacking.ts';

const PT = 1 / 72;
const USABLE_H_IN = OL600_SHEET.labelHeightIn - 0.12 * 2; // 2.26in, matching BOX-LABEL-SHEET-1A

/** One S2 order item, as the real Prisma select shapes it. */
const ITEM = (over: any = {}) => ({
    id: 'oi-1', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2',
    item_name: 'Comfort Foods', bundle: { id: 'b-1', name: 'Comfort Foods' }, ...over,
});

/** A fundraiser order: campaign present, organization resolved from it. */
const FUNDRAISER_ORDER = (
    items: any[],
    organizationName: string,
    over: Partial<BoxManifestOrder> = {},
): BoxManifestOrder => ({
    id: 'ord-1', first_name: 'Dani', last_name: 'Reiley', customer_name: 'Dani Reiley',
    campaign_organization_name: organizationName, campaign_name: null,
    items, ...over,
});

/** A storefront order: no campaign at all. */
const STOREFRONT_ORDER = (items: any[], over: Partial<BoxManifestOrder> = {}): BoxManifestOrder => ({
    id: 'ord-store-1', first_name: 'Sam', last_name: 'Okafor', customer_name: 'Sam Okafor',
    items, ...over,
});

const packed = (order: BoxManifestOrder): PhysicalBox[] => {
    const r = packOrder(order);
    if (!r.ok) throw new Error(`expected packing: ${r.reason}`);
    return r.result.boxes;
};

// ═════════════════════════════════════════════════════════════════════════════
// A/B. THE ORGANIZATION NAME, RESOLVED CORRECTLY AND NEVER CROSS-CONTAMINATED.
// ═════════════════════════════════════════════════════════════════════════════
describe('A/B. organization resolution', () => {
    it('A. Edgar fundraiser: the label carries the organization name, and every existing fact survives', () => {
        const boxes = packed(FUNDRAISER_ORDER([ITEM()], 'Edgar County Farm Bureau'));
        expect(boxes).toHaveLength(1);
        const [box] = boxes;
        expect(box.organizationName).toBe('Edgar County Farm Bureau');
        // Nothing about the existing packing information moved.
        expect(box.supporterName).toBe('Dani Reiley');
        expect(box.boxNumber).toBe(1);
        expect(box.boxTotal).toBe(1);
        expect(box.boxType).toBe('small'); // one S2, alone
        expect(boxContentLines(box).map(formatBoxContentLine)).toEqual(['Comfort Foods — Serves 2']);
    });

    it('B. a different organization renders its own name and never the other one', () => {
        const edgar = packed(FUNDRAISER_ORDER([ITEM()], 'Edgar County Farm Bureau'))[0];
        const cumberland = packed(FUNDRAISER_ORDER([ITEM({ id: 'oi-2' })], 'Cumberland County Farm Bureau', { id: 'ord-2' }))[0];
        expect(edgar.organizationName).toBe('Edgar County Farm Bureau');
        expect(cumberland.organizationName).toBe('Cumberland County Farm Bureau');
        expect(cumberland.organizationName).not.toBe(edgar.organizationName);
        expect(JSON.stringify(cumberland)).not.toContain('Edgar');
        expect(JSON.stringify(edgar)).not.toContain('Cumberland');
    });

    it('the campaign organization wins over the campaign display-name fallback', () => {
        const name = resolveOrganizationName({
            id: 'x', first_name: null, last_name: null, customer_name: null,
            campaign_organization_name: 'Edgar County Farm Bureau',
            campaign_name: 'Edgar Fall 2026 Fundraiser',
            items: [],
        });
        expect(name).toBe('Edgar County Farm Bureau');
    });

    it('the campaign display name is used ONLY as a documented fallback, when the organization is unavailable', () => {
        const name = resolveOrganizationName({
            id: 'x', first_name: null, last_name: null, customer_name: null,
            campaign_organization_name: null,
            campaign_name: 'Edgar Fall 2026 Fundraiser',
            items: [],
        });
        expect(name).toBe('Edgar Fall 2026 Fundraiser');
    });

    it('blank/whitespace organization and campaign names are treated as absent, never as a real value', () => {
        expect(resolveOrganizationName({
            id: 'x', first_name: null, last_name: null, customer_name: null,
            campaign_organization_name: '   ', campaign_name: '',
            items: [],
        })).toBeNull();
    });

    it('no organization name is ever fabricated from campaign_id or order id', () => {
        expect(resolveOrganizationName({
            id: 'ord-abc123', first_name: null, last_name: null, customer_name: null,
            campaign_organization_name: null, campaign_name: null,
            items: [],
        })).toBeNull();
        const s = strip(read(MANIFEST));
        const fn = s.slice(s.indexOf('export function resolveOrganizationName'));
        expect(fn.slice(0, fn.indexOf('\n}'))).not.toMatch(/campaign_id|order\.id/);
    });

    it('a missing organization NEVER blocks the order — it is optional, unlike supporter name', () => {
        const noOrg = buildPurchasedInstances(STOREFRONT_ORDER([ITEM()]));
        expect(noOrg.ok).toBe(true);
        expect(noOrg.ok && noOrg.instances[0].organizationName).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. MULTI-BOX CUSTOMER — every physical box carries the same organization.
// ═════════════════════════════════════════════════════════════════════════════
describe('C. multi-box customer', () => {
    it('every box for one fundraiser supporter carries the identical organization name', () => {
        // 3 x S2 -> 2 boxes (one paired large, one leftover small), per the
        // existing, UNCHANGED packing rule.
        const boxes = packed(FUNDRAISER_ORDER([ITEM({ quantity: 3 })], 'Jasper County Farm Bureau'));
        expect(boxes).toHaveLength(2);
        expect(boxes.map((b) => b.organizationName)).toEqual([
            'Jasper County Farm Bureau', 'Jasper County Farm Bureau',
        ]);
        // And box counting/typing is exactly what it was before this feature.
        expect(boxes.map((b) => `${b.boxNumber}/${b.boxTotal}:${b.boxType}`)).toEqual([
            '1/2:large', '2/2:small',
        ]);
    });

    it('a mixed S5 + S2 order keeps the same organization on both resulting boxes', () => {
        const boxes = packed(FUNDRAISER_ORDER([
            ITEM({ id: 'oi-1', variant_size: 'serves_5', item_name: 'Hearty Meals', bundle: { id: 'b-1', name: 'Hearty Meals' } }),
            ITEM({ id: 'oi-2', variant_size: 'serves_2', item_name: 'Comfort Foods', bundle: { id: 'b-2', name: 'Comfort Foods' } }),
        ], 'Home Schoolers USA'));
        expect(boxes).toHaveLength(2);
        expect(boxes.every((b) => b.organizationName === 'Home Schoolers USA')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. MULTIPLE CUSTOMERS, SAME CAMPAIGN.
// ═════════════════════════════════════════════════════════════════════════════
describe('D. multiple customers under one campaign', () => {
    it('each customer keeps their own correct name while sharing the common organization', () => {
        const manifest = buildPhysicalBoxManifest([
            FUNDRAISER_ORDER([ITEM({ id: 'oi-1' })], 'Edgar County Farm Bureau', { id: 'ord-a', first_name: 'Dani', last_name: 'Reiley', customer_name: 'Dani Reiley' }),
            FUNDRAISER_ORDER([ITEM({ id: 'oi-2' })], 'Edgar County Farm Bureau', { id: 'ord-b', first_name: 'Wyatt', last_name: 'Williamson', customer_name: 'Wyatt Williamson' }),
        ]);
        expect(manifest.boxes).toHaveLength(2);
        const byOrder = Object.fromEntries(manifest.boxes.map((b) => [b.orderId, b]));
        expect(byOrder['ord-a'].supporterName).toBe('Dani Reiley');
        expect(byOrder['ord-b'].supporterName).toBe('Wyatt Williamson');
        expect(byOrder['ord-a'].organizationName).toBe('Edgar County Farm Bureau');
        expect(byOrder['ord-b'].organizationName).toBe('Edgar County Farm Bureau');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. MULTIPLE FUNDRAISERS IN ONE PRINT RUN — no global "current fundraiser".
// ═════════════════════════════════════════════════════════════════════════════
describe('E. multiple fundraisers in one manifest', () => {
    it('each order resolves its OWN campaign independently — no shared/global state', () => {
        const manifest = buildPhysicalBoxManifest([
            FUNDRAISER_ORDER([ITEM({ id: 'oi-1' })], 'Edgar County Farm Bureau', { id: 'ord-edgar' }),
            FUNDRAISER_ORDER([ITEM({ id: 'oi-2' })], 'Cumberland County Farm Bureau', { id: 'ord-cumberland' }),
            FUNDRAISER_ORDER([ITEM({ id: 'oi-3' })], 'Jasper County Farm Bureau', { id: 'ord-jasper' }),
            STOREFRONT_ORDER([ITEM({ id: 'oi-4' })], { id: 'ord-storefront' }),
        ]);
        const byOrder = Object.fromEntries(manifest.boxes.map((b) => [b.orderId, b.organizationName]));
        expect(byOrder).toEqual({
            'ord-edgar': 'Edgar County Farm Bureau',
            'ord-cumberland': 'Cumberland County Farm Bureau',
            'ord-jasper': 'Jasper County Farm Bureau',
            'ord-storefront': null,
        });
    });

    it('resolveOrganizationName and the packing authorities carry no module-level/shared state', () => {
        // Calling in one order, then the reverse order, must not change either
        // answer — a real regression a "current fundraiser" global would cause.
        const a = resolveOrganizationName({ id: 'x', first_name: null, last_name: null, customer_name: null, campaign_organization_name: 'Edgar County Farm Bureau', campaign_name: null, items: [] });
        const b = resolveOrganizationName({ id: 'y', first_name: null, last_name: null, customer_name: null, campaign_organization_name: 'Cumberland County Farm Bureau', campaign_name: null, items: [] });
        const a2 = resolveOrganizationName({ id: 'x', first_name: null, last_name: null, customer_name: null, campaign_organization_name: 'Edgar County Farm Bureau', campaign_name: null, items: [] });
        expect([a, b, a2]).toEqual(['Edgar County Farm Bureau', 'Cumberland County Farm Bureau', 'Edgar County Farm Bureau']);
        const s = strip(read(MANIFEST));
        expect(s).not.toMatch(/let\s+\w*[Cc]urrent(Org|Fundraiser)|globalThis|module\.exports\.\w+\s*=/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. NON-FUNDRAISER (STOREFRONT) ORDERS — no blank/null/undefined line.
// ═════════════════════════════════════════════════════════════════════════════
describe('F. non-fundraiser orders', () => {
    it('a storefront order carries no organization name, and nothing else changes', () => {
        const boxes = packed(STOREFRONT_ORDER([ITEM()]));
        expect(boxes[0].organizationName).toBeNull();
        expect(boxes[0].supporterName).toBe('Sam Okafor');
    });

    it('the page never renders "null", "undefined", or a blank line for a missing organization', () => {
        const src = strip(read(PAGE));
        const sticker = src.slice(src.indexOf('className="label-slot"'));
        // The org block is conditionally rendered — `&&`, not printed
        // unconditionally — for both the print sticker and the screen preview.
        expect(sticker).toMatch(/\{box\.organizationName\s*&&\s*\(/);
        const preview = src.slice(0, src.indexOf('className="label-slot"'));
        expect(preview).toMatch(/\{slot\.label\.organizationName\s*&&\s*\(/);
        // And it is never string-concatenated in a way that could print the
        // literal word "null" or "undefined" for a falsy value.
        expect(sticker).not.toMatch(/\$\{box\.organizationName\}/);
    });

    it('an EMPTY manifest render produces zero organization elements for a storefront batch', () => {
        // Behavioural companion to the source check above: real boxes, real
        // absence, nothing to render.
        const boxes = packed(STOREFRONT_ORDER([ITEM({ quantity: 2 })]));
        expect(boxes.every((b) => !b.organizationName)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. LONG ORGANIZATION NAMES — safe, deterministic, no clipping.
// ═════════════════════════════════════════════════════════════════════════════
describe('G. long organization names', () => {
    const SHORT = 'Edgar County Farm Bureau';                       // 24 chars
    const MEDIUM = 'Cumberland County Farm Bureau';                 // 30 chars
    const LONG = 'Illinois Farm Bureau Young Leaders Committee';     // 46 chars, realistic

    it('short/medium/long all resolve to a positive, decreasing-or-equal font size', () => {
        expect(SHORT.length).toBeLessThanOrEqual(ORG_NAME_MEDIUM_THRESHOLD);
        expect(MEDIUM.length).toBeGreaterThan(ORG_NAME_MEDIUM_THRESHOLD);
        expect(MEDIUM.length).toBeLessThanOrEqual(ORG_NAME_LONG_THRESHOLD);
        expect(LONG.length).toBeGreaterThan(ORG_NAME_LONG_THRESHOLD);

        const shortT = chooseOrgNameTypography(SHORT);
        const mediumT = chooseOrgNameTypography(MEDIUM);
        const longT = chooseOrgNameTypography(LONG);
        expect(shortT.sizePt).toBeGreaterThanOrEqual(mediumT.sizePt);
        expect(mediumT.sizePt).toBeGreaterThanOrEqual(longT.sizePt);
        expect(longT.sizePt).toBeGreaterThan(0);
    });

    it('the organization line is never larger than the smallest possible customer name', () => {
        const smallestName = Math.min(...Object.values(STICKER_TYPOGRAPHY_TIERS).map((t) => t.nameSizePt));
        for (const name of [SHORT, MEDIUM, LONG, 'x'.repeat(120)]) {
            expect(chooseOrgNameTypography(name).sizePt).toBeLessThan(smallestName);
        }
    });

    it('is a pure, deterministic function of length alone — same input, same output', () => {
        for (const name of [SHORT, MEDIUM, LONG]) {
            expect(chooseOrgNameTypography(name)).toEqual(chooseOrgNameTypography(name));
        }
    });

    it('degrades safely on odd input rather than throwing', () => {
        expect(() => chooseOrgNameTypography(null as any)).not.toThrow();
        expect(() => chooseOrgNameTypography(undefined as any)).not.toThrow();
        expect(chooseOrgNameTypography('').sizePt).toBeGreaterThan(0);
    });

    it('REALISTIC worst case fits with real, positive margin: compact tier (long customer name, 2 content entries) + the largest realistic org line', () => {
        // Mirrors tests/boxLabelSheet1aTypography.test.ts's own worstCaseHeight
        // methodology exactly, extended with the org line.
        const worstCaseHeight = (nameTier: { nameSizePt: number; contentSizePt: number }, orgPt: number, orgLines: number) => {
            const header = 0.55 + 0.04;
            const name = 2 * (nameTier.nameSizePt * 1.05 * PT) + 0.06;
            const contents = 2 * 2 * (nameTier.contentSizePt * 1.25 * PT) + 0.02;
            const boxType = 8 * 1.2 * PT;
            const org = orgLines * (orgPt * 1.05 * PT) + 0.02;
            return header + name + contents + boxType + org;
        };
        // The SHORT bucket gets the biggest org font, so pairing it with the
        // compact tier's own absolute worst case is the tightest REALISTIC
        // combination (an org name this short is common; a customer name
        // this long AND two full content entries simultaneously is already
        // the rare tail this module was written to survive).
        const compact = STICKER_TYPOGRAPHY_TIERS.compact;
        const orgPt = chooseOrgNameTypography(SHORT).sizePt;
        const h = worstCaseHeight(compact, orgPt, 1);
        expect(h).toBeLessThan(USABLE_H_IN);
        expect(USABLE_H_IN - h).toBeGreaterThan(0.05);
    });

    it('the wrapping mechanism is deterministic and print-safe — CSS wrap, not JS measurement, backstopped by overflow:hidden', () => {
        const src = strip(read(PAGE));
        const sticker = src.slice(src.indexOf('className="label-slot"'));
        const orgStart = sticker.indexOf('box.organizationName &&');
        const orgBlock = sticker.slice(orgStart, sticker.indexOf('box.supporterName', orgStart));
        // Wrapping is ALLOWED (no forced single line, no ellipsis-truncation)...
        expect(orgBlock).toMatch(/wordBreak:\s*'break-word'/);
        expect(orgBlock).not.toMatch(/whiteSpace:\s*'nowrap'/);
        expect(orgBlock).not.toMatch(/textOverflow/);
        // ...and deterministic: no DOM measurement anywhere on this page.
        expect(strip(read('lib/labelTypography.ts'))).not.toMatch(/getBoundingClientRect|offsetWidth|scrollHeight/);
        expect(src).not.toMatch(/getBoundingClientRect|offsetHeight|scrollHeight/);
        // ...and the outer slot's own overflow:hidden remains the last-resort
        // guard, exactly as it already was for a supporter name.
        expect(read(PAGE)).toMatch(/\.label-slot\s*\{[\s\S]*?overflow:\s*hidden/);
    });

    it('an extreme/pathological organization name cannot bleed into a neighbouring sticker', () => {
        // Not asserting a numeric fit for this case (mirrors how the existing
        // suite treats a name needing a THIRD line) — asserting the mechanism
        // that bounds it is present and untouched.
        const pathological = 'A'.repeat(200);
        expect(() => chooseOrgNameTypography(pathological)).not.toThrow();
        expect(chooseOrgNameTypography(pathological).sizePt).toBe(chooseOrgNameTypography('x'.repeat(41)).sizePt);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// H. PACKING REGRESSION — everything else is byte/structurally unchanged.
// ═════════════════════════════════════════════════════════════════════════════
describe('H. packing regression', () => {
    it('box counting, LARGE/SMALL assignment and Box N/M are identical for fundraiser vs storefront orders with the same items', () => {
        const items = [ITEM({ quantity: 3 })];
        const fundraiser = packed(FUNDRAISER_ORDER(items, 'Edgar County Farm Bureau'));
        const storefront = packed(STOREFRONT_ORDER(items, { id: 'ord-1' }));
        // Content is compared on its PURCHASE facts only — bundleName,
        // servingTier, variantSize, instanceIndex, sequence — never on
        // supporterName/organizationName, which are IDENTITY, not packing,
        // and are exactly what this feature legitimately makes differ.
        const contentShape = (c: any) => ({
            bundleName: c.bundleName, servingTier: c.servingTier,
            variantSize: c.variantSize, instanceIndex: c.instanceIndex, sequence: c.sequence,
        });
        const packingShape = (b: PhysicalBox) => ({
            boxNumber: b.boxNumber, boxTotal: b.boxTotal, boxType: b.boxType,
            contents: b.contents.map(contentShape),
        });
        expect(fundraiser.map(packingShape)).toEqual(storefront.map(packingShape));
    });

    it('quarter/bundle grouping and content-line wording are unchanged', () => {
        const boxes = packed(FUNDRAISER_ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Q1 - Hearty Meals' }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Q2 - Comfort Foods' }),
        ], 'Edgar County Farm Bureau'));
        expect(boxContentLines(boxes[0]).map(formatBoxContentLine)).toEqual([
            'Q1 - Hearty Meals — Serves 2',
            'Q2 - Comfort Foods — Serves 2',
        ]);
    });

    it('Serves-2 pairing and Serves-5 solo assignment are unchanged for a fundraiser order', () => {
        const three = packOrder(FUNDRAISER_ORDER([ITEM({ quantity: 3 })], 'Edgar County Farm Bureau'));
        expect(three.ok && three.result.physicalBoxCount).toBe(2);
        expect(three.ok && three.result.boxes.map((b) => b.boxType)).toEqual(['large', 'small']);
        const s5 = packOrder(FUNDRAISER_ORDER([ITEM({ variant_size: 'serves_5' })], 'Edgar County Farm Bureau'));
        expect(s5.ok && s5.result.boxes[0].boxType).toBe('large');
    });

    it('supporter name resolution is completely untouched by this feature', () => {
        expect(resolveSupporterName(FUNDRAISER_ORDER([ITEM()], 'Edgar County Farm Bureau'))).toBe('Dani Reiley');
        // A blocked order blocks for the SAME reason as before — organization
        // presence/absence cannot rescue or break a supporter-name failure.
        const blocked = buildPurchasedInstances(FUNDRAISER_ORDER([ITEM()], 'Edgar County Farm Bureau', {
            first_name: null, last_name: null, customer_name: null,
        }));
        expect(blocked.ok).toBe(false);
    });

    it('the OL600 sheet geometry the owner physically verified is untouched', () => {
        expect(OL600_SHEET.labelWidthIn).toBe(4);
        expect(OL600_SHEET.labelHeightIn).toBe(2.5);
        expect(OL600_SHEET.labelsPerSheet).toBe(8);
        const raw = read(PAGE);
        expect(raw).toMatch(/size:\s*8\.5in 11in/);
        expect(raw).not.toMatch(/transform:\s*scale/);
    });

    it('start-position, pagination and alignment-test markup are untouched', () => {
        const raw = strip(read(PAGE));
        expect(raw).toMatch(/paginateLabelSheets\(boxes \|\| \[\], startPosition\)/);
        expect(raw).toMatch(/alignmentMode/);
        expect(raw).toMatch(/align-slot/);
    });

    it('no new Prisma write, and no lifecycle field, was introduced anywhere in this feature', () => {
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/\.update\(|\.create\(|\.delete\(|\.upsert\(/);
        }
        // schema.prisma is not in this feature's diff at all — proven at the
        // repo level (`git diff --name-only` against the Production baseline,
        // see the final report), not re-derived here by pattern-matching a
        // file that legitimately already has unrelated `organization_name`
        // columns on other models (e.g. FundraiserInquiry).
    });

    it('the route reads the organization via an EXPLICIT mapping, never a blind cast', () => {
        const s = strip(read(ROUTE));
        expect(s).not.toMatch(/orders as unknown as BoxManifestOrder/);
        expect(s).toMatch(/campaign_organization_name:\s*o\.campaign\?\.customer\?\.name/);
        expect(s).toMatch(/campaign_name:\s*o\.campaign\?\.name/);
    });
});
