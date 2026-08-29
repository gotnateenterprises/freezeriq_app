/**
 * FR-SUPPORTER-CONTACT-1A — owner ruling: all four supporter contact fields
 * (First Name, Last Name, Email, Phone Number) are now required for every NEW
 * public fundraiser order. FR-SUPPORTER-CONTACT-1 made them distinct fields;
 * this phase makes all four mandatory, client AND server, without touching
 * the schema or historical data.
 */
import fs from 'fs';
import path from 'path';
import { purchaserDisplayName } from '../lib/purchaserName';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CLIENT = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const ROUTE = 'app/api/public/order/route.ts';
const EMAIL = 'lib/email.ts';
const SCHEMA = 'prisma/schema.prisma';

/** A minimal simulation of the client's canSubmit predicate, mirrored from source. */
function clientCanSubmit(f: { firstName: string; lastName: string; email: string; phone: string; hasOrderLines: boolean }): boolean {
    return f.hasOrderLines
        && f.firstName.trim().length > 0
        && f.lastName.trim().length > 0
        && f.email.trim().length > 0
        && f.phone.trim().length > 0;
}

/** A minimal simulation of the server's contact validation, mirrored from source. */
function serverValidate(customer: any): { ok: true } | { ok: false; missingFields: string[] } {
    if (!customer || typeof customer !== 'object') return { ok: false, missingFields: ['First name', 'Last name', 'Email', 'Phone number'] };
    const missing: string[] = [];
    if (typeof customer.firstName !== 'string' || !customer.firstName.trim()) missing.push('First name');
    if (typeof customer.lastName !== 'string' || !customer.lastName.trim()) missing.push('Last name');
    if (typeof customer.email !== 'string' || !customer.email.trim()) missing.push('Email');
    if (typeof customer.phone !== 'string' || !customer.phone.trim()) missing.push('Phone number');
    return missing.length ? { ok: false, missingFields: missing } : { ok: true };
}

// ── O#1 — COMPLETE VALID SUBMISSION SUCCEEDS ────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · a complete valid submission succeeds', () => {
    it('1. First + Last + Email + Phone all present → client and server both accept', () => {
        const valid = { firstName: 'Matilda', lastName: 'West', email: 'matilda@example.com', phone: '(217) 555-0142', hasOrderLines: true };
        expect(clientCanSubmit(valid)).toBe(true);
        expect(serverValidate(valid).ok).toBe(true);
    });
});

// ── O#2-4 — FIRST NAME ───────────────────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · First Name is required', () => {
    const base = { lastName: 'West', email: 'm@example.com', phone: '555-0142', hasOrderLines: true };

    it('2. missing First Name fails client', () => {
        expect(clientCanSubmit({ ...base, firstName: '' })).toBe(false);
    });
    it('3. missing First Name fails API', () => {
        const r = serverValidate({ ...base, firstName: undefined });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('First name');
    });
    it('4. whitespace-only First Name fails (client and API)', () => {
        expect(clientCanSubmit({ ...base, firstName: '   ' })).toBe(false);
        const r = serverValidate({ ...base, firstName: '   ' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('First name');
    });
});

// ── O#5-7 — LAST NAME ────────────────────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · Last Name is required (this is the actual behavior change)', () => {
    const base = { firstName: 'Matilda', email: 'm@example.com', phone: '555-0142', hasOrderLines: true };

    it('5. missing Last Name fails client', () => {
        expect(clientCanSubmit({ ...base, lastName: '' })).toBe(false);
    });
    it('6. missing Last Name fails API', () => {
        const r = serverValidate({ ...base, lastName: undefined });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('Last name');
    });
    it('7. whitespace-only Last Name fails (client and API)', () => {
        expect(clientCanSubmit({ ...base, lastName: '   ' })).toBe(false);
        const r = serverValidate({ ...base, lastName: '   ' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('Last name');
        // Pin the REAL source specifically requires .trim() on lastName —
        // not just a truthiness/typeof check, which a whitespace string would
        // pass. This is what actually distinguishes "   " from a real value.
        const route = strip(R(ROUTE));
        expect(route).toContain("!customer.lastName.trim()) missingContactFields.push('Last name')");
    });
});

// ── O#8-11 — EMAIL ────────────────────────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · Email remains required, policy unchanged', () => {
    const base = { firstName: 'Matilda', lastName: 'West', phone: '555-0142', hasOrderLines: true };

    it('8. missing Email fails client', () => {
        expect(clientCanSubmit({ ...base, email: '' })).toBe(false);
    });
    it('9. missing Email fails API', () => {
        const r = serverValidate({ ...base, email: undefined });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('Email');
    });
    it('10. whitespace-only Email fails (client and API)', () => {
        expect(clientCanSubmit({ ...base, email: '   ' })).toBe(false);
        const r = serverValidate({ ...base, email: '   ' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('Email');
    });
    it('11. a malformed-but-non-blank email is handled IDENTICALLY to before this phase — no new format validation was introduced', () => {
        // Part G: reuse the existing email validation authority, do not invent
        // a new regex. No format-validation authority exists in this repo
        // (confirmed by repo-wide search during FR-SUPPORTER-CONTACT-1) — the
        // established policy has only ever been "non-blank", so this phase
        // does not change that. A malformed string still passes the presence
        // check, exactly as it did before FR-SUPPORTER-CONTACT-1A.
        expect(clientCanSubmit({ ...base, email: 'not-an-email' })).toBe(true);
        expect(serverValidate({ ...base, email: 'not-an-email' }).ok).toBe(true);
        const route = strip(R(ROUTE));
        expect(route).not.toMatch(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/); // no email-format regex was added
    });
});

// ── O#12-14 — PHONE ───────────────────────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · Phone Number is required (this is the actual behavior change)', () => {
    const base = { firstName: 'Matilda', lastName: 'West', email: 'm@example.com', hasOrderLines: true };

    it('12. missing Phone fails client', () => {
        expect(clientCanSubmit({ ...base, phone: '' })).toBe(false);
    });
    it('13. missing Phone fails API', () => {
        const r = serverValidate({ ...base, phone: undefined });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('Phone number');
    });
    it('14. whitespace-only Phone fails (client and API)', () => {
        expect(clientCanSubmit({ ...base, phone: '   ' })).toBe(false);
        const r = serverValidate({ ...base, phone: '   ' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missingFields).toContain('Phone number');
        // Pin the REAL source specifically requires .trim() on phone — not
        // just a truthiness/typeof check, which a whitespace string would pass.
        const route = strip(R(ROUTE));
        expect(route).toContain("!customer.phone.trim()) missingContactFields.push('Phone number')");
    });
    it('preserves human-entered phone formats — no new formatting engine was introduced', () => {
        for (const phone of ['(309) 555-1212', '309-555-1212', '309 555 1212', '+1 309 555 1212']) {
            expect(clientCanSubmit({ ...base, phone })).toBe(true);
            expect(serverValidate({ ...base, phone }).ok).toBe(true);
        }
        const route = strip(R(ROUTE));
        // No phone-format regex was added — only presence is checked.
        expect(route).not.toMatch(/\\d\{3\}.*\\d\{3\}.*\\d\{4\}/);
    });
});

// ── O#15 — DIRECT API SUBMISSION CANNOT BYPASS ──────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · the server independently enforces all four fields (Part D/E)', () => {
    it('15. the API validates every field by NAMED property, independent of the client canSubmit gate — a direct API call cannot bypass it', () => {
        const route = strip(R(ROUTE));
        const i = route.indexOf('const missingContactFields');
        const block = route.slice(Math.max(0, i - 400), route.indexOf('missingContactFields.length > 0', i) + 40);
        expect(block).toContain("typeof customer.firstName !== 'string'");
        expect(block).toContain("typeof customer.lastName !== 'string'");
        expect(block).toContain("typeof customer.email !== 'string'");
        expect(block).toContain("typeof customer.phone !== 'string'");
        // Named-property checks, never positional/array access.
        expect(block).not.toMatch(/customer\[\d\]/);
        expect(route).toContain("code: 'CONTACT_INFO_REQUIRED'");
        expect(route).toContain('status: 400');
    });
});

// ── O#16-21 — PERSISTENCE CONTRACT ──────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · persistence contract for a valid new order', () => {
    const route = strip(R(ROUTE));

    it('16-17. Order.first_name and Order.last_name persist the submitted values', () => {
        const i = route.indexOf('tx.order.create(');
        const block = route.slice(i, route.indexOf('items: {', i));
        expect(block).toContain('first_name: purchaserFirstName || null');
        expect(block).toContain('last_name: purchaserLastName || null');
    });

    it('18. Order.customer_name is the canonical purchaserDisplayName(first, last) — never its own concatenation', () => {
        expect(route).toContain('purchaserDisplayName(purchaserFirstName, purchaserLastName)');
        // Now that both are guaranteed non-blank for every new order, the
        // canonical helper always produces a real "First Last" combination.
        expect(purchaserDisplayName('Matilda', 'West')).toBe('Matilda West');
    });

    it('19. Order.phone persists the submitted phone', () => {
        const i = route.indexOf('tx.order.create(');
        const block = route.slice(i, route.indexOf('items: {', i));
        expect(block).toMatch(/phone:\s*\(typeof customer\.phone === 'string'/);
    });

    it('20-21. email and phone reach Customer.contact_email / Customer.contact_phone', () => {
        expect(route).toContain('contact_email: customer.email');
        expect(route).toContain('contact_phone: customer.phone');
    });
});

// ── O#22-25 — COORDINATOR NOTIFICATION ──────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · coordinator notification stays dependable for every new order', () => {
    const route = strip(R(ROUTE));
    const email = strip(R(EMAIL));
    const fn = email.slice(email.indexOf('export async function sendFundraiserCoordinatorNotification'), email.indexOf('export async function sendLeadNotificationEmail'));

    it('22. Name reads order.customer_name (now always a real First+Last combination)', () => {
        expect(route).toContain('supporterName: order.customer_name');
        expect(fn).toContain('<strong>Name:</strong> ${escapeHtml(supporter)}');
    });

    it('23. Email reads the submitted email (now guaranteed present)', () => {
        expect(route).toContain('supporterEmail: customer.email || null');
        expect(fn).toContain('<strong>Email:</strong>');
    });

    it('24. Phone reads the submitted phone (now guaranteed present)', () => {
        expect(route).toContain('supporterPhone: customer.phone || null');
        expect(fn).toContain('<strong>Phone:</strong> ${escapeHtml(supporterPhone)}');
    });

    it('25. Supporting stays a separate concept — never merged with purchaser identity', () => {
        expect(route).toContain('participantName: order.participant_name');
        expect(fn).toContain('<strong>Supporting:</strong> ${escapeHtml(participantName)}');
        // participant_name is written from a DIFFERENT request field.
        expect(route).toContain('participant_name: customer.participantCode || null');
    });
});

// ── O#26-27 / Part K — HISTORICAL COMPATIBILITY ─────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · historical orders are untouched', () => {
    it('26. historical NULL first_name/last_name rows remain readable — the schema stays nullable', () => {
        const schema = R(SCHEMA);
        const model = schema.slice(schema.indexOf('model Order {'), schema.indexOf('model OrderItem {'));
        expect(model).toMatch(/first_name\s+String\?/);
        expect(model).toMatch(/last_name\s+String\?/);
        // Explicitly NOT required at the database level (Part J).
        expect(model).not.toMatch(/first_name\s+String[^?]/);
        expect(model).not.toMatch(/last_name\s+String[^?]/);
    });

    it('27. no backfill/reparse code exists anywhere in the order route', () => {
        const route = strip(R(ROUTE));
        expect(route).not.toContain('firstNameOf');
        expect(route).not.toMatch(/customer_name\.split/);
        expect(route).not.toMatch(/UPDATE\s+orders/i);
    });
});

// ── O#28 / Part J — NO SCHEMA CHANGE ─────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1A · no Prisma migration was created for this phase', () => {
    it('28. exactly the same 22 migrations as FR-SUPPORTER-CONTACT-1 — no new one added', () => {
        const migrations = fs.readdirSync(path.join(__dirname, '..', 'prisma/migrations'))
            .filter((d) => /^\d{14}_/.test(d))
            .sort();
        expect(migrations).toHaveLength(22);
        expect(migrations[21]).toBe('20260828150000_fr_supporter_contact_1_order_first_last_name');
        // The requirement is application-boundary only, per Part J — the
        // columns stay nullable (also asserted in test #26 above).
    });
});

// ── O#29-30 / Part M — MOBILE-LAYOUT-FIX-2 REGRESSION ───────────────────────
describe('FR-SUPPORTER-CONTACT-1A · MOBILE-LAYOUT-FIX-2 is not regressed', () => {
    it('29. the shared <main> min-w-0 shrink escape hatch is unchanged', () => {
        const layout = R('components/LayoutWrapper.tsx');
        const i = layout.indexOf('<main className=');
        const tag = layout.slice(i, layout.indexOf('>', i));
        expect(tag).toMatch(/\bmin-w-0\b/);
    });

    it('30. the required-field "*" markers do not introduce any fixed/min pixel width on the contact grid', () => {
        const client = strip(R(CLIENT));
        const i = client.indexOf("gridTemplateColumns: 'repeat(auto-fit");
        const gridBlock = client.slice(i, client.indexOf('</div>', i));
        // Still the same responsive track definition — nothing hardened to a
        // fixed px/rem width by the new required markers or attributes.
        expect(gridBlock).toContain("minmax(11rem, 1fr)");
        expect(gridBlock).not.toMatch(/width:\s*['"`]?\d/);
        expect(gridBlock).not.toMatch(/minWidth:\s*['"`]?[1-9]/); // only minWidth:0 allowed
    });
});
