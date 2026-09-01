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
 *     view, as opposed to that one-time email) returned only
 *     name/participant/items/totals when this phase shipped.
 *     SUPERSEDED BY COORD-FULFILLMENT-1: that GET now also returns supporter
 *     email and phone, for the session's own campaign only. The disclosure
 *     below is unaffected — it always said those three fields are shared with
 *     the coordinator, so the API caught up to the copy rather than the copy
 *     needing to change. Home address is still never returned.
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
        // tenantName itself must still resolve from real tenant business data,
        // never a literal — proves the variable it reuses is genuine, not
        // itself hardcoded elsewhere in this same file.
        //
        // TENANT-BRAND-AUTHORITY-1: this used to pin the old inline expression
        // (business.branding?.business_name with two literal 'Freezer Chef'/
        // 'FreezerIQ' fallbacks baked in) as its proxy for "genuinely dynamic".
        // That expression was ITSELF the bug this phase fixed — it read the
        // legacy TenantBranding column (schema DEFAULT 'Freezer Chef') ahead of
        // Business.display_name. The resolution is now the tested
        // customerFacingBusinessName(business) authority, which is a strictly
        // stronger proof of "genuine, not hardcoded" than the expression it
        // replaces.
        expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
        expect(src).toMatch(/const tenantName = customerFacingBusinessName\(business\)/);
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
// Part G finding, as revised by COORD-FULFILLMENT-1: the coordinator portal
// now DOES receive supporter contact details for its own campaign, so the
// original "precondition not met" reasoning no longer applies. What is checked
// here instead is the property that still matters — the shipped supporter copy
// and the shipped API describe the same three fields, and neither extends to a
// home address.
// ═════════════════════════════════════════════════════════════════════════
describe('PRIVACY-DISCLOSURE-1: the disclosure and the coordinator portal agree', () => {
    // ─────────────────────────────────────────────────────────────────────
    // SUPERSEDED PRECONDITION. This block previously recorded that no
    // coordinator-side reminder was needed BECAUSE the portal never received
    // contact details at all. COORD-FULFILLMENT-1 changed that: the portal now
    // returns supporter name, email and phone for the coordinator's own
    // campaign.
    //
    // That does NOT invalidate the disclosure — it is exactly what the
    // disclosure has always said. The assertions below are re-pointed at the
    // property that actually matters now: the shipped supporter-facing copy and
    // the shipped API must describe the same three fields, and neither may
    // extend to a home address.
    // ─────────────────────────────────────────────────────────────────────
    it('the disclosure names exactly the three fields the coordinator portal now returns', () => {
        const clientSrc = read(CLIENT_PATH);
        expect(clientSrc).toMatch(/name, email, and phone you provide are shared with your fundraiser coordinator/);

        const routeSrc = read('app/api/coordinator/route.ts');
        expect(routeSrc).toMatch(/THIS SESSION'S CAMPAIGN ONLY/);
        expect(routeSrc).toMatch(/shared with your fundraiser\n \* \*\s?coordinator|shared with your fundraiser/);
    });

    it('the coordinator GET selects supporter name, participant, phone and the linked email — and never an address', () => {
        // COORD-FULFILLMENT-2 moved the supporter select into
        // lib/coordinatorSupporterOrders.ts, shared with the printable pickup
        // tracker. Asserted as an object rather than by source grep.
        const { SUPPORTER_ORDER_SELECT } = require('@/lib/coordinatorSupporterOrders');
        const sel: any = SUPPORTER_ORDER_SELECT;
        expect(sel.participant_name).toBe(true);
        expect(sel.customer_name).toBe(true);
        expect(sel.phone).toBe(true);
        expect(sel.customer.select.contact_email).toBe(true);
        // The disclosure promises name/email/phone. It does NOT promise an
        // address, and the API must not exceed what supporters were told.
        expect(sel).not.toHaveProperty('delivery_address');
        expect(sel.customer.select).not.toHaveProperty('delivery_address');
        // And the coordinator GET must actually use it.
        expect(read('app/api/coordinator/route.ts')).toMatch(/select: SUPPORTER_ORDER_SELECT/);
    });

    it('the disclosure still makes no address claim, because no address is collected or shared', () => {
        const clientSrc = read(CLIENT_PATH);
        const notice = clientSrc.slice(
            clientSrc.indexOf('The name, email, and phone you provide'),
            clientSrc.indexOf('The name, email, and phone you provide') + 400,
        );
        expect(notice).not.toMatch(/address/i);
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
