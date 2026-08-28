/**
 * FR-TAX-1 — organization tax status, exemption document, and the frozen
 * per-campaign tax snapshot.
 *
 * Failure modes pinned here:
 *  - UNKNOWN (nobody asked) quietly behaving as TAX_EXEMPT
 *  - a hardcoded 1% reappearing anywhere in the new tax path
 *  - a campaign reading the organization's CURRENT status or the tenant's
 *    CURRENT default rate instead of its own frozen snapshot, so a later edit
 *    retroactively rewrites a fundraiser's tax treatment
 *  - a taxable campaign computing zero tax, or an exempt one computing any
 *  - tax-exemption paperwork becoming reachable without a tenant session, or
 *    reachable by the WRONG tenant
 *  - the exemption document's bytes riding along in ordinary CRM responses
 *  - the invoice/closeout tax base being silently switched while the correct
 *    base is still an open accounting question
 */

import {
    ORG_TAX_STATUSES,
    ORG_TAX_STATUS_LABELS,
    isOrgTaxStatus,
    parseTaxRatePercent,
    formatTaxRate,
    resolveCampaignTaxSnapshot,
    computeCampaignTax,
    TAXABLE_BASE_STATUS,
    MIN_TAX_RATE_PERCENT,
    MAX_TAX_RATE_PERCENT,
} from '@/lib/fundraiserTax';
import {
    validateTaxDocument,
    safeDocumentFilename,
    TAX_DOCUMENT_ALLOWED_TYPES,
    TAX_DOCUMENT_MAX_BYTES,
} from '@/lib/taxDocumentPolicy';

const fs = require('fs');
const path = require('path');
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/**
 * Strip block and line comments. Several assertions below check that a
 * forbidden IDENTIFIER does not appear in a file; the docstrings deliberately
 * DISCUSS those identifiers to explain why they are absent, and a comment is
 * documentation, not a code path.
 */
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════════════════════════════════════════════════════════════════
// ORGANIZATION (matrix 1-5)
// ═══════════════════════════════════════════════════════════════════════════

describe('1-3. organization tax status and exemption number persist', () => {
    it('the three statuses are exactly UNKNOWN / TAXABLE / TAX_EXEMPT', () => {
        expect([...ORG_TAX_STATUSES]).toEqual(['UNKNOWN', 'TAXABLE', 'TAX_EXEMPT']);
        expect(isOrgTaxStatus('TAXABLE')).toBe(true);
        expect(isOrgTaxStatus('TAX_EXEMPT')).toBe(true);
        expect(isOrgTaxStatus('UNKNOWN')).toBe(true);
    });

    it('an unrecognised status is refused rather than written', () => {
        for (const bad of ['exempt', 'taxable', 'EXEMPT', '', null, undefined, 1, true, {}]) {
            expect(isOrgTaxStatus(bad as unknown)).toBe(false);
        }
    });

    it('the customer route writes tax_status ONLY when it is a recognised value', () => {
        const src = read('app', 'api', 'customers', '[id]', 'route.ts');
        expect(src).toMatch(/isOrgTaxStatus\(body\.tax_status\)\s*\?\s*\{\s*tax_status:/);
    });

    it('the customer route persists an exemption number, and omission leaves it alone', () => {
        const src = read('app', 'api', 'customers', '[id]', 'route.ts');
        expect(src).toMatch(/body\.tax_exemption_number !== undefined/);
        expect(src).toMatch(/tax_exemption_number: String\(body\.tax_exemption_number\)/);
    });

    it('schema defaults organizations to UNKNOWN, never TAX_EXEMPT', () => {
        const schema = read('prisma', 'schema.prisma');
        expect(schema).toMatch(/tax_status\s+OrgTaxStatus\s+@default\(UNKNOWN\)/);
        expect(schema).not.toMatch(/tax_status\s+OrgTaxStatus\s+@default\(TAX_EXEMPT\)/);
    });
});

describe('4-5. tenant isolation on organization tax data', () => {
    it('the tax-document route resolves the organization scoped to the caller\'s own business', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        expect(src).toMatch(/where:\s*\{\s*id,\s*business_id:\s*businessId\s*\}/);
    });

    it('both handlers require a tenant session before touching anything', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        const handlers = src.split(/export async function /).slice(1);
        expect(handlers.length).toBe(2); // POST + GET
        for (const h of handlers) {
            expect(h).toMatch(/const session = await auth\(\)/);
            expect(h).toMatch(/if \(!session\?\.user\?\.businessId\)/);
            expect(h).toMatch(/status: 401/);
        }
    });

    it('the download re-scopes the document read by business_id as well as customer_id', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        expect(src).toMatch(/where:\s*\{\s*customer_id:\s*org\.id,\s*business_id:\s*businessId\s*\}/);
    });

    it('no coordinator- or public-authenticated helper is imported by the document route', () => {
        // Comments are stripped: the docstring legitimately EXPLAINS why
        // coordinator sessions cannot reach here, which is documentation
        // rather than a code path.
        const src = stripComments(read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts'));
        expect(src).not.toMatch(/requireCoordinatorSession|portal_token|public_token/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENTS (matrix 6-14)
// ═══════════════════════════════════════════════════════════════════════════

describe('6-9. document type and size policy', () => {
    it('accepts PDF, JPG and PNG', () => {
        expect([...TAX_DOCUMENT_ALLOWED_TYPES]).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
        for (const t of TAX_DOCUMENT_ALLOWED_TYPES) {
            expect(validateTaxDocument({ contentType: t, sizeBytes: 1024 }).ok).toBe(true);
        }
    });

    it('rejects everything else, including executables and office macros', () => {
        for (const t of ['application/x-msdownload', 'text/html', 'image/svg+xml',
                         'application/vnd.ms-excel', 'application/octet-stream', '', null]) {
            expect(validateTaxDocument({ contentType: t, sizeBytes: 1024 }).ok).toBe(false);
        }
    });

    it('rejects an oversized file', () => {
        const r = validateTaxDocument({ contentType: 'application/pdf', sizeBytes: TAX_DOCUMENT_MAX_BYTES + 1 });
        expect(r.ok).toBe(false);
    });

    it('rejects an empty file', () => {
        expect(validateTaxDocument({ contentType: 'application/pdf', sizeBytes: 0 }).ok).toBe(false);
    });

    it('the route re-checks the ACTUAL byte length, not just client-reported size', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        expect(src).toMatch(/buffer\.byteLength\s*>\s*TAX_DOCUMENT_MAX_BYTES/);
    });
});

describe('10-13. the document is private, tenant-scoped, and never public', () => {
    it('the document is stored against the organization AND its business', () => {
        const schema = read('prisma', 'schema.prisma');
        expect(schema).toMatch(/model OrganizationTaxDocument \{[\s\S]*?customer_id\s+String\s+@unique/);
        expect(schema).toMatch(/model OrganizationTaxDocument \{[\s\S]*?business_id\s+String/);
    });

    it('the document route never imports the PUBLIC S3 helper', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        expect(src).not.toMatch(/@\/lib\/s3|uploadToS3/);
    });

    it('no public URL is ever produced for the document', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        expect(src).not.toMatch(/amazonaws\.com|r2\.dev|S3_PUBLIC_DOMAIN|https?:\/\//);
    });

    it('the download refuses to be cached by any shared cache', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        expect(src).toMatch(/'Cache-Control':\s*'private, no-store, max-age=0'/);
    });

    it('the filename echoed into Content-Disposition is sanitised', () => {
        expect(safeDocumentFilename('ok-cert.pdf')).toBe('ok-cert.pdf');
        expect(safeDocumentFilename('../../etc/passwd')).not.toContain('..');
        expect(safeDocumentFilename('../../etc/passwd')).not.toContain('/');
        expect(safeDocumentFilename('a"b.pdf')).not.toContain('"');
        expect(safeDocumentFilename('bad\r\nSet-Cookie: x=1')).not.toMatch(/[\r\n]/);
        expect(safeDocumentFilename('')).toBe('tax-exemption-document');
        expect(safeDocumentFilename(null)).toBe('tax-exemption-document');
    });

    it('the CRM organization response returns document METADATA only, never bytes', () => {
        const src = read('app', 'api', 'customers', '[id]', 'route.ts');
        const sel = src.match(/organizationTaxDocument\.findFirst\(\{[\s\S]*?\}\);/);
        expect(sel).toBeTruthy();
        expect(sel![0]).toMatch(/select:/);
        expect(sel![0]).not.toMatch(/\bdata:\s*true\b/);
    });
});

describe('14. replace semantics', () => {
    it('uploading again REPLACES the current document rather than accumulating', () => {
        const src = read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts');
        expect(src).toMatch(/organizationTaxDocument\.upsert/);
        expect(src).toMatch(/where:\s*\{\s*customer_id:\s*org\.id\s*\}/);
    });

    it('a replace never migrates the document to another tenant', () => {
        const src = stripComments(read('app', 'api', 'customers', '[id]', 'tax-document', 'route.ts'));
        const update = src.split('update: {')[1]?.split('},')[0] ?? '';
        expect(update.length).toBeGreaterThan(0);
        expect(update).not.toMatch(/business_id/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAIGN SNAPSHOT (matrix 15-22)
// ═══════════════════════════════════════════════════════════════════════════

describe('15-17. launch prefills and snapshots the right treatment', () => {
    it('15. TAX_EXEMPT organization -> exempt snapshot at 0%', () => {
        const snap = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAX_EXEMPT',
            tenantDefaultRatePercent: 1,
        });
        expect(snap).toEqual({ status: 'TAX_EXEMPT', ratePercent: 0 });
    });

    it('16. TAXABLE organization -> snapshots the tenant default rate', () => {
        const snap = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE',
            tenantDefaultRatePercent: 1.25,
        });
        expect(snap).toEqual({ status: 'TAXABLE', ratePercent: 1.25 });
    });

    it('17. UNKNOWN -> the SAFE default: taxable at the tenant rate, never exempt', () => {
        for (const status of ['UNKNOWN', null, undefined] as const) {
            const snap = resolveCampaignTaxSnapshot({
                organizationStatus: status as any,
                tenantDefaultRatePercent: 1,
            });
            expect(snap.status).toBe('TAXABLE');
            expect(snap.status).not.toBe('TAX_EXEMPT');
            expect(snap.ratePercent).toBe(1);
        }
    });

    it('a missing/garbage tenant default degrades to 0%, still TAXABLE', () => {
        const snap = resolveCampaignTaxSnapshot({
            organizationStatus: 'UNKNOWN',
            tenantDefaultRatePercent: 'not-a-number',
        });
        expect(snap).toEqual({ status: 'TAXABLE', ratePercent: 0 });
    });
});

describe('18-20. who may set the campaign tax treatment', () => {
    it('18. an explicit tenant override wins over the organization default', () => {
        const exemptOverride = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE',
            tenantDefaultRatePercent: 1,
            override: { status: 'TAX_EXEMPT' },
        });
        expect(exemptOverride).toEqual({ status: 'TAX_EXEMPT', ratePercent: 0 });

        const taxableOverride = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAX_EXEMPT',
            tenantDefaultRatePercent: 1,
            override: { status: 'TAXABLE', ratePercent: 2.5 },
        });
        expect(taxableOverride).toEqual({ status: 'TAXABLE', ratePercent: 2.5 });
    });

    it('19. the coordinator portal never writes campaign tax fields', () => {
        for (const f of [
            ['app', 'api', 'coordinator', 'route.ts'],
            ['app', 'api', 'coordinator', 'bundle-selection', 'route.ts'],
            ['app', 'api', 'tracker', 'download', 'route.ts'],
        ]) {
            const src = read(...f);
            expect(src).not.toMatch(/tax_status:|tax_rate_percent:/);
        }
    });

    it('20. no public/supporter route writes campaign tax fields', () => {
        for (const f of [
            ['app', 'api', 'public', 'order', 'route.ts'],
            ['app', 'api', 'fundraiser', '[token]', 'route.ts'],
        ]) {
            const src = read(...f);
            expect(src).not.toMatch(/tax_status:|tax_rate_percent:/);
        }
    });

    it('the generic organization-profile form cannot reach campaign tax fields', () => {
        const src = read('app', 'api', 'customers', '[id]', 'route.ts');
        const campaignSync = src.split('fundraiserCampaign.update(')[1] ?? '';
        expect(campaignSync).not.toMatch(/tax_status|tax_rate_percent/);
    });
});

describe('21-22. the snapshot is FROZEN — later changes never rewrite it', () => {
    it('21. changing the organization status later does not alter an existing snapshot', () => {
        // The snapshot is a value computed once and stored. Recomputing with a
        // changed organization status yields a DIFFERENT value — which is
        // exactly why the stored one must be read back rather than recomputed.
        const atLaunch = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAX_EXEMPT',
            tenantDefaultRatePercent: 1,
        });
        const ifRecomputedLater = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE',
            tenantDefaultRatePercent: 1,
        });
        expect(atLaunch).not.toEqual(ifRecomputedLater);

        // A campaign carrying the launch snapshot keeps computing exempt.
        expect(computeCampaignTax({ snapshot: atLaunch, taxableBase: 1000 }).taxAmount).toBe(0);
    });

    it('22. changing the tenant default rate later does not alter an existing snapshot', () => {
        const atLaunch = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE',
            tenantDefaultRatePercent: 1,
        });
        expect(atLaunch.ratePercent).toBe(1);
        expect(computeCampaignTax({ snapshot: atLaunch, taxableBase: 1000 }).taxAmount).toBe(10);

        // Tenant later raises its default to 3%; the frozen snapshot is unmoved.
        const laterDefault = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE',
            tenantDefaultRatePercent: 3,
        });
        expect(laterDefault.ratePercent).toBe(3);
        expect(atLaunch.ratePercent).toBe(1);
    });

    it('every campaign-creation path writes the snapshot at launch', () => {
        const create = read('app', 'api', 'campaigns', 'route.ts');
        expect((create.match(/tax_status: taxSnapshot\.status/g) || []).length).toBe(3);
        expect((create.match(/tax_rate_percent: taxSnapshot\.ratePercent/g) || []).length).toBe(3);

        const launch = read('app', 'api', 'opportunities', '[id]', 'launch', 'route.ts');
        expect(launch).toMatch(/tax_status: launchTaxSnapshot\.status/);
        expect(launch).toMatch(/tax_rate_percent: launchTaxSnapshot\.ratePercent/);
    });

    it('the campaign snapshot columns are nullable — pre-FR-TAX-1 campaigns took no snapshot', () => {
        const schema = read('prisma', 'schema.prisma');
        expect(schema).toMatch(/tax_status\s+OrgTaxStatus\?/);
        expect(schema).toMatch(/tax_rate_percent\s+Decimal\?\s+@db\.Decimal\(5, 2\)/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// CALCULATION (matrix 23-26)
// ═══════════════════════════════════════════════════════════════════════════

describe('23-25. the one tax calculation', () => {
    it('23. an exempt campaign is always zero, whatever the base', () => {
        for (const base of [0, 1, 1000, 6420.55]) {
            const r = computeCampaignTax({ snapshot: { status: 'TAX_EXEMPT', ratePercent: 0 }, taxableBase: base });
            expect(r.taxAmount).toBe(0);
            expect(r.taxApplied).toBe(false);
        }
    });

    it('23b. TAX_EXEMPT is authoritative on its OWN, even if a rate rode along with it', () => {
        // Defence in depth: the status alone must decide. If an inconsistent
        // snapshot ever carried both TAX_EXEMPT and a non-zero rate — a bad
        // backfill, a hand-edited row, a future writer that forgets to zero the
        // rate — the exemption must still win. Without this, the status check
        // could be deleted entirely and a zero rate would mask it.
        const r = computeCampaignTax({
            snapshot: { status: 'TAX_EXEMPT', ratePercent: 1 } as any,
            taxableBase: 6420,
        });
        expect(r.taxAmount).toBe(0);
        expect(r.taxApplied).toBe(false);
        expect(r.ratePercent).toBe(0);
    });

    it('24. a taxable campaign uses its OWN snapshotted rate', () => {
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 1 }, taxableBase: 6420 }).taxAmount)
            .toBe(64.20);
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 2.5 }, taxableBase: 1000 }).taxAmount)
            .toBe(25);
        // A different campaign at a different snapshotted rate, same base.
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 0.5 }, taxableBase: 6420 }).taxAmount)
            .toBe(32.10);
    });

    it('25. currency rounds to cents, half-up, once at the edge', () => {
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 1 }, taxableBase: 845 }).taxAmount)
            .toBe(8.45);
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 1 }, taxableBase: 333.33 }).taxAmount)
            .toBe(3.33);
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 7.25 }, taxableBase: 19.99 }).taxAmount)
            .toBe(1.45);
    });

    it('a missing snapshot computes nothing rather than guessing a rate', () => {
        const r = computeCampaignTax({ snapshot: null, taxableBase: 1000 });
        expect(r.taxApplied).toBe(false);
        expect(r.taxAmount).toBe(0);
    });

    it('a zero or negative snapshotted rate applies no tax', () => {
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 0 }, taxableBase: 1000 }).taxAmount).toBe(0);
        expect(computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: -1 }, taxableBase: 1000 }).taxAmount).toBe(0);
    });

    it('rate parsing is server-authoritative and bounded 0-100', () => {
        expect(parseTaxRatePercent('1')).toEqual({ ok: true, percent: 1 });
        expect(parseTaxRatePercent(1.005).ok).toBe(true);
        expect(MIN_TAX_RATE_PERCENT).toBe(0);
        expect(MAX_TAX_RATE_PERCENT).toBe(100);
        for (const bad of [-0.01, 100.01, NaN, Infinity, 'abc', '', null, undefined, true, [], {}]) {
            expect(parseTaxRatePercent(bad as unknown).ok).toBe(false);
        }
    });

    it('formatTaxRate renders naturally and never as engineering notation', () => {
        expect(formatTaxRate(1)).toBe('1%');
        expect(formatTaxRate('1.00')).toBe('1%');
        expect(formatTaxRate(1.25)).toBe('1.25%');
        expect(formatTaxRate(null)).toBe('—');
    });
});

describe('26. nothing in the FR-TAX-1 path hardcodes 1%', () => {
    const NEW_FILES = [
        ['lib', 'fundraiserTax.ts'],
        ['lib', 'taxDocumentPolicy.ts'],
        ['app', 'api', 'tenant', 'tax-settings', 'route.ts'],
        ['app', 'api', 'customers', '[id]', 'tax-document', 'route.ts'],
        ['components', 'crm', 'OrganizationTaxPanel.tsx'],
    ];

    it('no new tax file contains a literal 1% rate constant', () => {
        for (const f of NEW_FILES) {
            const src = read(...f)
                // Strip comments: the docstrings legitimately DISCUSS 1% and the
                // Illinois history, which is documentation, not a computation.
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            expect(src).not.toMatch(/FOOD_TAX_RATE_PERCENT/);
            expect(src).not.toMatch(/[*/]\s*0\.01\b/);
            expect(src).not.toMatch(/=\s*1\.0\s*;/);
        }
    });

    it('the tenant default rate is a stored column, not a constant', () => {
        const schema = read('prisma', 'schema.prisma');
        expect(schema).toMatch(/default_food_tax_percent Decimal\s+@default\(0\) @db\.Decimal\(5, 2\)/);
        // Explicitly NOT defaulted to 1.00 — Illinois repealed the statewide 1%
        // grocery tax on 2026-01-01; any local 1% is a tenant-verified fact.
        expect(schema).not.toMatch(/default_food_tax_percent Decimal\s+@default\(1/);
    });

    it('the campaign snapshot rate comes from the tenant setting, not a literal', () => {
        const src = read('app', 'api', 'campaigns', 'route.ts');
        expect(src).toMatch(/tenantDefaultRatePercent: taxBusiness\?\.default_food_tax_percent/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRACKER / INVOICE / SQUARE (matrix 27-29)
// ═══════════════════════════════════════════════════════════════════════════

describe('27-28. tracker and invoice remain truthful while the tax base is unresolved', () => {
    it('27. the coordinator tracker still says "No Tax", which is still true', () => {
        // FR-COORD-ORDER-TRACKER-1 established this label because the fundraiser
        // flow charges supporters no tax. FR-TAX-1 does not change that: it adds
        // tax on the ORGANIZATION sale, which the tracker does not represent.
        const src = read('lib', 'coordinatorOrderTracker.ts');
        expect(src).toMatch(/Total Cost \(No Tax\)/);
    });

    it('27b. FR-COORD-ORDER-TRACKER-1\'s bundle-family fixes are untouched', () => {
        const src = read('lib', 'coordinatorOrderTracker.ts');
        expect(src).toMatch(/buildTrackerFamilies/);
        expect(src).toMatch(/resolveMaterialBundles/);
    });

    it('28. closeout tax behaviour is NOT rewired while the base is unresolved', () => {
        const closeout = read('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts');
        expect(closeout).not.toMatch(/computeCampaignTax|fundraiserTax/);

        const math = read('lib', 'fundraiserCloseoutMath.ts');
        // Still the pre-existing behaviour, deliberately preserved.
        expect(math).toMatch(/grossSales \* FOOD_TAX_RATE_PERCENT \/ 100/);
    });

    it('28b. the unresolved base is recorded in code, not left as folklore', () => {
        expect(TAXABLE_BASE_STATUS).toBe('UNRESOLVED_PENDING_OWNER_CONFIRMATION');
        const src = read('lib', 'fundraiserTax.ts');
        expect(src).toMatch(/UNRESOLVED_PENDING_OWNER_CONFIRMATION/);
        expect(src).toMatch(/taxableBase/);
    });

    it('28c. the calculator takes its base as a parameter so one call site changes later', () => {
        const r = computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 1 }, taxableBase: 5136 });
        expect(r.taxableBase).toBe(5136);
        expect(r.taxAmount).toBe(51.36);
        // Same rate, the other candidate base — proving the choice is the
        // caller's and the module bakes in neither.
        const onGross = computeCampaignTax({ snapshot: { status: 'TAXABLE', ratePercent: 1 }, taxableBase: 6420 });
        expect(onGross.taxAmount).toBe(64.20);
    });
});

describe('29. no Square payment implementation was introduced', () => {
    it('no FR-TAX-1 file touches Square, payment links or checkout', () => {
        for (const f of [
            ['lib', 'fundraiserTax.ts'],
            ['lib', 'taxDocumentPolicy.ts'],
            ['app', 'api', 'tenant', 'tax-settings', 'route.ts'],
            ['app', 'api', 'customers', '[id]', 'tax-document', 'route.ts'],
        ]) {
            const src = read(...f);
            expect(src.toLowerCase()).not.toMatch(/square|payment_link|paymentlink|createpayment/);
        }
    });

    it('invoice settlement is still manual-only — no processor verification was added', () => {
        const src = read('app', 'api', 'tenant', 'invoices', '[id]', 'settle', 'route.ts');
        expect(src).not.toMatch(/fundraiserTax|computeCampaignTax/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Labels
// ═══════════════════════════════════════════════════════════════════════════

describe('presentation', () => {
    it('every status has exactly one human label, defined once', () => {
        expect(Object.keys(ORG_TAX_STATUS_LABELS).sort()).toEqual([...ORG_TAX_STATUSES].sort());
        expect(ORG_TAX_STATUS_LABELS.UNKNOWN).toBe('Not set');
        expect(ORG_TAX_STATUS_LABELS.TAX_EXEMPT).toBe('Tax exempt');
    });

    it('the helper text warns that being a school/church does not imply exemption', () => {
        const { ORG_TAX_STATUS_HELPER_TEXT } = require('@/lib/fundraiserTax');
        expect(ORG_TAX_STATUS_HELPER_TEXT).toMatch(/school|church|charity/i);
        expect(ORG_TAX_STATUS_HELPER_TEXT).toMatch(/taxable/i);
    });
});
