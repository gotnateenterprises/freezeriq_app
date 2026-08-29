/**
 * FR-SUPPORTER-CONTACT-1 — separate First Name / Last Name / Email / Phone on
 * the supporter fundraiser checkout form, and the mobile overflow this same
 * code caused (the one CSS Grid in the file, with no min-width guard on its
 * children — that's what a purchaser named Matilda West actually hit: "Your
 * name" and "Phone" sat in two identical boxes and read exactly like a
 * First/Last pair).
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
const MIGRATION = 'prisma/migrations/20260828150000_fr_supporter_contact_1_order_first_last_name/migration.sql';

// ── V#1-5 — EXPLICIT FIELDS, NO AMBIGUOUS FULL NAME ─────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · the checkout form has four explicit fields', () => {
    const client = strip(R(CLIENT));

    it('1-4. First Name, Last Name, Email, Phone Number all exist as distinct inputs', () => {
        // FR-SUPPORTER-CONTACT-1A appended a required-field "*" to each
        // placeholder (this form's only visible label) — see the dedicated
        // FR-SUPPORTER-CONTACT-1A suite for the full required-field contract.
        expect(client).toContain('placeholder="First Name *"');
        expect(client).toContain('placeholder="Last Name *"');
        expect(client).toContain('placeholder="Email (for your confirmation) *"');
        expect(client).toContain('placeholder="Phone Number *"');
    });

    it('5. the old ambiguous "Your name" field is gone — no buyerName state or input remains', () => {
        expect(client).not.toContain('Your name');
        expect(client).not.toMatch(/\bbuyerName\b/);
    });

    it('FR-SUPPORTER-CONTACT-1A: all four fields are now required in canSubmit (owner ruling supersedes the original first-name-only rule)', () => {
        const i = client.indexOf('const canSubmit');
        const block = client.slice(i, client.indexOf(';', client.lastIndexOf('&&', client.indexOf('!submitting', i))) + 1);
        expect(block).toContain('firstName.trim().length > 0');
        expect(block).toContain('lastName.trim().length > 0');
        expect(block).toContain('buyerEmail.trim().length > 0');
        expect(block).toContain('buyerPhone.trim().length > 0');
    });
});

// ── Part E — INPUT SEMANTICS ─────────────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · correct HTML semantics per field', () => {
    const client = strip(R(CLIENT));

    it('First Name: type text, autocomplete given-name', () => {
        const i = client.indexOf('placeholder="First Name *"');
        const tag = client.slice(client.lastIndexOf('<input', i), client.indexOf('/>', i) + 2);
        expect(tag).toContain('type="text"');
        expect(tag).toContain('autoComplete="given-name"');
    });

    it('Last Name: type text, autocomplete family-name', () => {
        const i = client.indexOf('placeholder="Last Name *"');
        const tag = client.slice(client.lastIndexOf('<input', i), client.indexOf('/>', i) + 2);
        expect(tag).toContain('type="text"');
        expect(tag).toContain('autoComplete="family-name"');
    });

    it('Email: type email, autocomplete email', () => {
        const i = client.indexOf('placeholder="Email (for your confirmation) *"');
        const tag = client.slice(client.lastIndexOf('<input', i), client.indexOf('/>', i) + 2);
        expect(tag).toContain('type="email"');
        expect(tag).toContain('autoComplete="email"');
    });

    it('Phone: type tel (never type number), autocomplete tel', () => {
        const i = client.indexOf('placeholder="Phone Number *"');
        const tag = client.slice(client.lastIndexOf('<input', i), client.indexOf('/>', i) + 2);
        expect(tag).toContain('type="tel"');
        expect(tag).toContain('autoComplete="tel"');
        expect(tag).not.toContain('type="number"');
    });
});

// ── V#6-10 — SUBMISSION MAPS TO NAMED PROPERTIES ────────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · submission payload and server read are named-property, not positional', () => {
    it('6-9. the client payload carries firstName/lastName/email/phone as distinct customer properties', () => {
        const client = strip(R(CLIENT));
        const i = client.indexOf('customer: {');
        const block = client.slice(i, client.indexOf('},', i));
        expect(block).toContain('firstName: firstName.trim()');
        expect(block).toContain('lastName: lastName.trim()');
        expect(block).toContain('email: buyerEmail.trim()');
        expect(block).toContain('phone: buyerPhone.trim()');
        // The old single combined field is gone from the payload.
        expect(block).not.toMatch(/^\s*name:/m);
    });

    it('10. the server reads customer.firstName/lastName/email/phone by name, never positionally', () => {
        const route = strip(R(ROUTE));
        expect(route).toContain('customer.firstName');
        expect(route).toContain('customer.lastName');
        expect(route).toContain('customer.email');
        expect(route).toContain('customer.phone');
        // No array-index or destructuring-by-position access to the customer object.
        expect(route).not.toMatch(/customer\[\d\]/);
        expect(route).not.toMatch(/const\s*\[\s*\w+\s*,\s*\w+\s*\]\s*=\s*customer\b/);
    });
});

// ── V#11 — CANONICAL DISPLAY NAME ───────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · purchaserDisplayName (Part G)', () => {
    it('11. first + last produces "Matilda West"', () => {
        expect(purchaserDisplayName('Matilda', 'West')).toBe('Matilda West');
    });

    it('first only produces "Matilda"', () => {
        expect(purchaserDisplayName('Matilda', '')).toBe('Matilda');
        expect(purchaserDisplayName('Matilda', null)).toBe('Matilda');
        expect(purchaserDisplayName('Matilda', undefined)).toBe('Matilda');
    });

    it('last only produces "West"', () => {
        expect(purchaserDisplayName('', 'West')).toBe('West');
        expect(purchaserDisplayName(null, 'West')).toBe('West');
    });

    it('neither produces "A supporter", never null/undefined/empty', () => {
        expect(purchaserDisplayName('', '')).toBe('A supporter');
        expect(purchaserDisplayName(null, null)).toBe('A supporter');
        expect(purchaserDisplayName(undefined, undefined)).toBe('A supporter');
    });

    it('trims whitespace safely and never produces a double space', () => {
        expect(purchaserDisplayName('  Matilda  ', '  West  ')).toBe('Matilda West');
        expect(purchaserDisplayName('   ', 'West')).toBe('West');
        expect(purchaserDisplayName('Matilda', '   ')).toBe('Matilda');
        for (const [f, l] of [['Matilda', 'West'], ['Matilda', ''], ['', 'West'], ['', '']] as const) {
            expect(purchaserDisplayName(f, l)).not.toMatch(/\s{2,}/);
        }
    });

    it('the route uses THIS helper, not its own inline concatenation', () => {
        const route = strip(R(ROUTE));
        expect(route).toContain("import { purchaserDisplayName } from '@/lib/purchaserName'");
        expect(route).toContain('purchaserDisplayName(purchaserFirstName, purchaserLastName)');
        // No local "first + ' ' + last"-style concatenation reimplementing the rule.
        expect(route).not.toMatch(/firstName\s*\+\s*['"`]\s+['"`]\s*\+\s*.*[Ll]ast/);
    });
});

// ── V#12-15 — FIELDS CANNOT SWAP / CROSS-IDENTITY ───────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · no field can swap into another', () => {
    it('12-13. lastName and phone are read from distinct request properties, never each other', () => {
        const route = strip(R(ROUTE));
        // The exact bug class this phase exists to prevent: assigning
        // customer.lastName to a phone-shaped destination or vice versa.
        expect(route).not.toMatch(/phone:\s*customer\.lastName/);
        expect(route).not.toMatch(/last_name:\s*customer\.phone/);
        expect(route).toContain('last_name: purchaserLastName || null');
        expect(route).toContain("phone: (typeof customer.phone === 'string'");
    });

    it('14. Supporting (participantCode/participant_name) never merges with the purchaser\'s own name fields', () => {
        const route = strip(R(ROUTE));
        expect(route).not.toMatch(/participant_name:\s*purchaserName/);
        expect(route).not.toMatch(/customer_name:\s*customer\.participantCode/);
        expect(route).toContain('participant_name: customer.participantCode || null');
    });

    it('15. the coordinator\'s own identity (coordinatorEmail) never substitutes for purchaser identity (supporterName/supporterEmail)', () => {
        const route = strip(R(ROUTE));
        const i = route.indexOf('sendFundraiserCoordinatorNotification({');
        const call = route.slice(i, route.indexOf('});', i) + 3);
        expect(call).toContain('supporterName: order.customer_name');
        expect(call).toContain('supporterEmail: customer.email');
        expect(call).toContain('coordinatorEmail,');
        // coordinatorEmail must not be assigned to a supporter-labeled field.
        expect(call).not.toMatch(/supporterEmail:\s*coordinatorEmail/);
        expect(call).not.toMatch(/supporterName:\s*coordinatorEmail/);
    });
});

// ── V#16-17 / Part K — HISTORICAL COMPATIBILITY ─────────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · historical orders are never guessed or rewritten', () => {
    it('16. the migration is additive-only — no UPDATE/INSERT touching existing rows', () => {
        const sql = R(MIGRATION).toUpperCase();
        expect(sql).toContain('ADD COLUMN');
        expect(sql).not.toContain('UPDATE ');
        expect(sql).not.toContain('INSERT INTO');
    });

    it('17. no code anywhere derives first_name/last_name by splitting an existing customer_name', () => {
        const route = strip(R(ROUTE));
        // The one legitimate name-splitting helper in the repo is scoped to
        // organization contact greetings (lib/personName.ts) and is not
        // imported here — this route only ever COMBINES via purchaserDisplayName,
        // never SPLITS a historical combined name into first/last.
        expect(route).not.toContain('firstNameOf');
        expect(route).not.toMatch(/customer_name\.split/);
        expect(route).not.toMatch(/\.split\(['"]\s['"]\)/);
    });

    it('Order.first_name/last_name are nullable — historical rows read as NULL, not an invented value', () => {
        const schema = R(SCHEMA);
        const model = schema.slice(schema.indexOf('model Order {'), schema.indexOf('model OrderItem {'));
        expect(model).toMatch(/first_name\s+String\?/);
        expect(model).toMatch(/last_name\s+String\?/);
        // customer_name (backward-compat field) is untouched — still nullable, still written.
        expect(model).toMatch(/customer_name\s+String\?/);
    });
});

// ── V#18-23 — COORDINATOR NOTIFICATION ──────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · coordinator "new fundraiser order" email', () => {
    const email = strip(R(EMAIL));
    const fn = email.slice(email.indexOf('export async function sendFundraiserCoordinatorNotification'), email.indexOf('export async function sendLeadNotificationEmail'));

    it('18. the full purchaser name appears in the subject, now sanitized like the confirmation email', () => {
        expect(fn).toContain('subject: safeSubject(`New fundraiser order — ${supporter} ·');
    });

    it('19-20. the full purchaser name appears in the opening line AND a labeled Name: row', () => {
        expect(fn).toMatch(/<strong>\$\{escapeHtml\(supporter\)\}<\/strong> just placed an order/);
        expect(fn).toContain('<strong>Name:</strong> ${escapeHtml(supporter)}');
    });

    it('21. Email shows the purchaser email', () => {
        expect(fn).toContain('<strong>Email:</strong>');
        expect(fn).toContain('supporterEmail');
    });

    it('22. Phone shows the purchaser phone', () => {
        expect(fn).toContain('<strong>Phone:</strong> ${escapeHtml(supporterPhone)}');
    });

    it('23. Supporting shows the actual supported person, a distinct field from purchaser name/email/phone', () => {
        expect(fn).toContain('<strong>Supporting:</strong> ${escapeHtml(participantName)}');
    });

    it('redundant "Org Fundraiser (Org)" naming is suppressed only when the campaign name already echoes the org name', () => {
        expect(fn).toContain('campaignNameEchoesOrg');
        expect(fn).toContain('organizationName && !campaignNameEchoesOrg');
        // A genuinely distinct custom campaign name still shows the org name —
        // this is a conditional fix, not a blanket removal.
        const distinct = 'X Fundraiser'.toLowerCase().includes('Home Schoolers USA'.toLowerCase());
        expect(distinct).toBe(false);
    });
});

// ── V#24-30 — MOBILE ─────────────────────────────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · mobile: the one CSS Grid in the file now has a min-width guard', () => {
    const client = strip(R(CLIENT));

    it('24. the buyer-contact grid uses auto-fit + minmax, not a fixed "1fr 1fr" that forces overflow', () => {
        expect(client).toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))'");
        expect(client).not.toContain("gridTemplateColumns: '1fr 1fr'");
    });

    it('25. every input in that grid has minWidth: 0 — the exact prior overflow mechanism (grid items default to content-based min-width)', () => {
        for (const field of ['First Name *', 'Last Name *', 'Phone Number *']) {
            const i = client.indexOf(`placeholder="${field}"`);
            const tag = client.slice(client.lastIndexOf('<input', i), client.indexOf('/>', i) + 2);
            expect(tag).toContain('minWidth: 0');
        }
        const emailIdx = client.indexOf('placeholder="Email (for your confirmation) *"');
        const emailTag = client.slice(client.lastIndexOf('<input', emailIdx), client.indexOf('/>', emailIdx) + 2);
        expect(emailTag).toContain('minWidth: 0');
    });

    it('27. all four fields live in the SAME grid, so they stack together at narrow widths, not two separate pairs', () => {
        const i = client.indexOf("gridTemplateColumns: 'repeat(auto-fit");
        const gridBlock = client.slice(i, client.indexOf('</div>', i));
        expect(gridBlock).toContain('placeholder="First Name *"');
        expect(gridBlock).toContain('placeholder="Last Name *"');
        expect(gridBlock).toContain('placeholder="Email (for your confirmation) *"');
        expect(gridBlock).toContain('placeholder="Phone Number *"');
    });

    it('30. the previously-fixed mobile-overflow guards from FR-SHARE-COPY-1 are still present (no regression)', () => {
        expect(client).toContain("flexWrap: 'wrap'"); // order-line row
        expect(client).toContain("maxWidth: '40%'"); // tenant badge
        expect(client).toContain("overflowWrap: 'anywhere'"); // about_text
    });
});

// ── V#31-33 — SECURITY / TENANT ISOLATION ───────────────────────────────────
describe('FR-SUPPORTER-CONTACT-1 · contact data stays scoped and never leaks publicly', () => {
    it('31-32. the order write is scoped to the server-resolved business/campaign, never a client-supplied tenant id', () => {
        const route = strip(R(ROUTE));
        expect(route).toContain('business_id: businessId');
        expect(route).toContain('campaign_id: campaign ? campaign.id : null');
        // businessId itself is resolved server-side from the slug, not trusted from the body.
        expect(route).toContain('where: { slug: normalizeSlug(slug) ?? NO_SUCH_SLUG }');
    });

    it('33. the coordinator notification is gated on a server-resolved campaign + coordinator email, never the public request', () => {
        const route = strip(R(ROUTE));
        const i = route.indexOf('if (campaign) {');
        const block = route.slice(i, route.indexOf('sendFundraiserCoordinatorNotification', i));
        expect(block).toContain('orgContactEmail?.trim()');
    });

    it('email HTML escapes every purchaser-controlled value in the coordinator notification', () => {
        const email = strip(R(EMAIL));
        const fn = email.slice(email.indexOf('export async function sendFundraiserCoordinatorNotification'), email.indexOf('export async function sendLeadNotificationEmail'));
        for (const field of ['supporter', 'supporterEmail', 'supporterPhone', 'participantName', 'campaignName', 'organizationName']) {
            expect(fn).toContain(`escapeHtml(${field})`);
        }
    });
});
