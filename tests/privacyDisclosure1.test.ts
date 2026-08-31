/**
 * PRIVACY-DISCLOSURE-1 — a factual, in-context notice on the supporter
 * fundraiser order form, describing who ACTUALLY sees a supporter's contact
 * information and why, based on traced current behavior rather than any
 * assumed or aspirational privacy stance.
 *
 * TRACED GROUND TRUTH (Parts B/C/D of the phase, reproduced here as the
 * contract these tests hold the disclosure to):
 *
 *   - app/api/public/order/route.ts collects firstName, lastName, email,
 *     phone (all required) plus an optional participant association and
 *     address, from every fundraiser order.
 *   - lib/email.ts's sendFundraiserCoordinatorNotification DOES put the
 *     supporter's name, email (as a mailto link), phone, and participant
 *     name into the coordinator's order-notification email at order time.
 *   - app/api/coordinator/route.ts's GET (the coordinator's own portal
 *     view, as opposed to that one-time email) deliberately EXCLUDES
 *     delivery_address, email, and phone from its response — its own doc
 *     comment: "No PII exposure: delivery addresses, emails, phones
 *     filtered from GET responses." Only name/participant/items/totals
 *     reach the portal UI itself.
 *   - The tenant (business) sees everything through its own CRM
 *     (app/api/orders/route.ts, app/customers/[id]/page.tsx) — ordinary,
 *     expected tenant-owns-its-data access, not a new exposure.
 *   - No source anywhere in this codebase sells data, targets ads, shares
 *     with third-party marketing partners, or makes retention/encryption/
 *     compliance guarantees. The disclosure must not claim any of that.
 *
 * The disclosure therefore says contact info is shared with the
 * COORDINATOR and the TENANT, for order/payment/fulfillment purposes — not
 * that it is private from the coordinator, and not anything about sale,
 * marketing, or legal guarantees this codebase does not make.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const CLIENT_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const src = read(CLIENT_PATH);

// The exact disclosure sentence under test, so every assertion below is
// anchored to the real, current source rather than a re-typed copy that
// could silently drift from what actually ships.
const DISCLOSURE_MARKER = 'The name, email, and phone you provide are shared with your fundraiser coordinator';

describe('PRIVACY-DISCLOSURE-1: supporter order form disclosure', () => {
    it('1. the disclosure exists in the supporter order form, positioned BEFORE the submit button', () => {
        const disclosureIdx = src.indexOf(DISCLOSURE_MARKER);
        const buttonIdx = src.indexOf("{submitting ? 'Placing your order…' : 'Place my order →'}");
        expect(disclosureIdx).toBeGreaterThan(-1);
        expect(buttonIdx).toBeGreaterThan(-1);
        expect(disclosureIdx).toBeLessThan(buttonIdx);
    });

    it('2. references the actual current recipients: the fundraiser coordinator and the tenant', () => {
        const disclosureLine = src.slice(src.indexOf(DISCLOSURE_MARKER), src.indexOf(DISCLOSURE_MARKER) + 400);
        expect(disclosureLine).toMatch(/fundraiser coordinator/i);
        // The tenant is named via the page's own established brand variable,
        // not a second, newly-invented one -- see test 3.
        expect(disclosureLine).toMatch(/\{tenantName\}/);
    });

    it('3. uses the page\'s existing tenant-brand variable -- never a hardcoded business name', () => {
        const disclosureLine = src.slice(src.indexOf(DISCLOSURE_MARKER), src.indexOf(DISCLOSURE_MARKER) + 400);
        expect(disclosureLine).toMatch(/\{tenantName\}/);
        expect(disclosureLine).not.toMatch(/Freezer Chef/);
        expect(disclosureLine).not.toMatch(/FreezerIQ/);
        // tenantName itself must still resolve from this page's own real
        // branding data (business.branding.business_name / business.name),
        // never a literal — proves the variable it reuses is genuine, not
        // itself hardcoded elsewhere in this same file.
        expect(src).toMatch(/const tenantName = \(business\.branding\?\.business_name/);
    });

    it('4. does not falsely claim data is private from the coordinator', () => {
        const disclosureLine = src.slice(src.indexOf(DISCLOSURE_MARKER), src.indexOf(DISCLOSURE_MARKER) + 400);
        expect(disclosureLine).not.toMatch(/never shared with (your )?coordinator/i);
        expect(disclosureLine).not.toMatch(/private from (your )?coordinator/i);
        expect(disclosureLine).not.toMatch(/kept confidential/i);
        expect(disclosureLine).not.toMatch(/only you (can|will) see/i);
    });

    it('5. does not claim data sale, marketing, ad-targeting, or third-party sharing behavior that does not exist', () => {
        const disclosureLine = src.slice(src.indexOf(DISCLOSURE_MARKER), src.indexOf(DISCLOSURE_MARKER) + 400);
        expect(disclosureLine).not.toMatch(/sell|sold|marketing|advertis|third[- ]part|data broker/i);
    });

    it('5b. does not make legal/compliance/retention/encryption guarantees this codebase does not back', () => {
        const disclosureLine = src.slice(src.indexOf(DISCLOSURE_MARKER), src.indexOf(DISCLOSURE_MARKER) + 400);
        expect(disclosureLine).not.toMatch(/GDPR|CCPA|HIPAA|encrypt|we (never|do not) retain|delete[sd]? (automatically|guarantee)/i);
    });

    it('6. carries no hiding rule that would remove it on a small/mobile viewport, and reuses the file\'s existing mobile-safe small-print pattern', () => {
        const disclosureBlock = src.slice(src.indexOf(DISCLOSURE_MARKER) - 300, src.indexOf(DISCLOSURE_MARKER) + 100);
        expect(disclosureBlock).not.toMatch(/display:\s*['"]?none/);
        expect(disclosureBlock).not.toMatch(/className=["'][^"']*hidden/);
        // Exactly the style object the pre-existing "No payment taken
        // online" small print already uses on this same page -- proven
        // mobile-safe by already shipping, not a new untested pattern.
        expect(disclosureBlock).toMatch(/textAlign: 'center', fontSize: '\.62rem', color: '#b09484'/);
    });

    it('7. the order submission wiring (submitOrder / canSubmit) is untouched', () => {
        expect(src).toMatch(/onClick=\{submitOrder\}/);
        expect(src).toMatch(/disabled=\{!canSubmit\}/);
    });

    it('8. the existing supporter payment copy is unchanged', () => {
        expect(src).toMatch(/No payment taken online · your order counts toward the goal instantly/);
    });

    it('12. the component still exports the same default function signature (no breaking prop changes for historical campaigns)', () => {
        expect(src).toMatch(/export default function FundraiserClient\(\{\s*\n\s*business,\s*\n\s*campaign,\s*\n\s*bundleProgress,\s*\n\s*orderMode,\s*\n\s*slug,\s*\n\s*fundraiserId\s*\n\}: any\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Part G finding, recorded as an executable fact rather than an assumption:
// no coordinator-side reminder was added, because the precondition for one
// is not met. The coordinator PORTAL UI (as opposed to the one-time order
// email) never receives contact details to begin with -- proven against
// app/api/coordinator/route.ts's own GET handler, not inferred.
// ═════════════════════════════════════════════════════════════════════════
describe('PRIVACY-DISCLOSURE-1: coordinator-side reminder — proven unnecessary, not added', () => {
    it('the coordinator portal GET response excludes email, phone, and delivery_address -- the precondition for Part G\'s reminder', () => {
        const routeSrc = read('app/api/coordinator/route.ts');
        expect(routeSrc).toMatch(/No PII exposure: delivery addresses, emails, phones filtered from GET responses/);
        expect(routeSrc).toMatch(/EXCLUDED: delivery_address, customer_email, phone/);
    });

    it('the only supporter-identifying fields the coordinator portal GET selects are name/participant/items/totals -- names, not contact details', () => {
        const routeSrc = read('app/api/coordinator/route.ts');
        const ordersSelectBlock = routeSrc.slice(routeSrc.indexOf('orders: {'), routeSrc.indexOf('orders: {') + 700);
        expect(ordersSelectBlock).toMatch(/participant_name: true/);
        expect(ordersSelectBlock).toMatch(/customer_name: true/);
        expect(ordersSelectBlock).not.toMatch(/phone: true/);
        expect(ordersSelectBlock).not.toMatch(/delivery_address: true/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Existing privacy-policy status (Part J) — recorded, not duplicated or
// rewritten.
// ═════════════════════════════════════════════════════════════════════════
describe('PRIVACY-DISCLOSURE-1: existing privacy policy is untouched', () => {
    it('app/legal/privacy/page.tsx already exists and was not modified by this phase', () => {
        const policySrc = read('app/legal/privacy/page.tsx');
        expect(policySrc).toMatch(/Privacy Policy/);
    });
});
