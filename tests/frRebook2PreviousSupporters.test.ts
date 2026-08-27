/**
 * FR-REBOOK-2 — previous-supporter audience, invitation draft and send authority.
 *
 * The fixtures below are the REAL Production shapes, not convenient ones. Edgar
 * County Farm Bureau's 17 orders each carry a distinct human in
 * `Order.customer_name` with a phone, and all 17 point at the ORGANIZATION's own
 * Customer row. FR-REBOOK-1A shipped broken precisely because a helper was
 * tested against an input its only caller could not produce; these tests use the
 * shapes the caller actually produces.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
    derivePreviousSupporters,
    describePreviousSupporters,
    normalizeSupporterEmail,
    normalizeSupporterPhone,
    maskSupporterEmail,
    type PreviousSupporterOrderInput,
} from '../lib/previousSupporters';
import {
    buildInviteDraft,
    buildSupporterOrderUrl,
    formatOrderDeadline,
    validateInviteMessage,
    INVITE_SUBJECT_MAX,
    INVITE_BODY_MAX,
} from '../lib/previousSupporterInvite';

const BIZ = 'biz-1';
const ORG = 'org-edgar';
const OTHER_ORG = 'org-coles';
const PRIOR = 'camp-prior';
const CURRENT = 'camp-current';
const ORGS = new Set([ORG, OTHER_ORG]);

/** A storefront supporter: their own direct_customer row carries the address. */
function individualOrder(
    id: string,
    over: Partial<PreviousSupporterOrderInput> & { email?: string | null; custId?: string } = {},
): PreviousSupporterOrderInput {
    const custId = over.custId ?? `cust-${id}`;
    return {
        id,
        campaign_id: over.campaign_id !== undefined ? over.campaign_id : PRIOR,
        canceled_at: over.canceled_at ?? null,
        customer_id: custId,
        customer_name: over.customer_name ?? `Person ${id}`,
        phone: over.phone ?? null,
        customer: {
            id: custId,
            business_id: over.customer?.business_id ?? BIZ,
            contact_email: over.email !== undefined ? over.email : `${id}@example.com`,
            contact_phone: null,
            name: `Person ${id}`,
        },
    };
}

/** Edgar's shape: the person is on the ORDER; the customer is the organization. */
function coordinatorEnteredOrder(
    id: string,
    name: string,
    phone: string | null,
    over: Partial<PreviousSupporterOrderInput> = {},
): PreviousSupporterOrderInput {
    return {
        id,
        campaign_id: over.campaign_id !== undefined ? over.campaign_id : PRIOR,
        canceled_at: over.canceled_at ?? null,
        customer_id: ORG,
        customer_name: name,
        phone,
        customer: {
            id: ORG,
            business_id: BIZ,
            contact_email: 'manager@edgarcfb.org',   // the COORDINATOR's address
            contact_phone: '217-465-8511',
            name: 'Edgar County Farm Bureau',
        },
    };
}

const base = {
    businessId: BIZ,
    organizationCustomerId: ORG,
    priorCampaignIds: [PRIOR],
    organizationCustomerIds: ORGS,
    suppressedEmails: new Set<string>(),
};

describe('FR-REBOOK-2 · audience derivation', () => {
    it('includes a supporter from a prior campaign', () => {
        const a = derivePreviousSupporters({ ...base, orders: [individualOrder('a')] });
        expect(a.supporterCount).toBe(1);
        expect(a.reachableCount).toBe(1);
        expect(a.supporters[0].email).toBe('a@example.com');
    });

    it('does NOT treat a current-campaign order as historical', () => {
        // The only difference is which campaign it belongs to.
        const a = derivePreviousSupporters({
            ...base,
            orders: [individualOrder('now', { campaign_id: CURRENT })],
        });
        expect(a.legitimateOrders).toBe(0);
        expect(a.supporterCount).toBe(0);
    });

    it('deduplicates a repeat purchaser into one invitation', () => {
        const a = derivePreviousSupporters({
            ...base,
            orders: [individualOrder('r1', { email: 'repeat@example.com' }),
                individualOrder('r2', { email: 'repeat@example.com' }),
                individualOrder('r3', { email: 'repeat@example.com' })],
        });
        expect(a.supporterCount).toBe(1);
        expect(a.supporters[0].orderCount).toBe(3);
        expect(a.duplicatesCollapsed).toBe(2);
        expect(a.legitimateOrders).toBe(3);
    });

    it('deduplicates the same address across DUPLICATE Customer rows', () => {
        // /api/public/order matches contact_email EXACTLY, so differing case
        // genuinely produces two Customer rows for one human.
        const a = derivePreviousSupporters({
            ...base,
            orders: [individualOrder('c1', { email: 'Bob@Example.com', custId: 'cust-A' }),
                individualOrder('c2', { email: 'bob@example.com', custId: 'cust-B' }),
                individualOrder('c3', { email: '  BOB@example.com  ', custId: 'cust-C' })],
        });
        expect(a.supporterCount).toBe(1);
        expect(a.supporters[0].orderCount).toBe(3);
    });

    it('does NOT merge different people who share a name', () => {
        const a = derivePreviousSupporters({
            ...base,
            orders: [individualOrder('n1', { email: 'js1@example.com', customer_name: 'John Smith' }),
                individualOrder('n2', { email: 'js2@example.com', customer_name: 'John Smith' })],
        });
        expect(a.supporterCount).toBe(2);
    });

    it('does NOT merge two emailless people who share a name', () => {
        const a = derivePreviousSupporters({
            ...base,
            orders: [coordinatorEnteredOrder('x1', 'John Smith', '2175550001'),
                coordinatorEnteredOrder('x2', 'John Smith', '2175550002')],
        });
        expect(a.supporterCount).toBe(2);
        // And the key never contains the name that would have merged them.
        expect(a.supporters.every((s) => !s.key.includes('John'))).toBe(true);
    });

    it('excludes a canceled order', () => {
        const a = derivePreviousSupporters({
            ...base,
            orders: [individualOrder('ok'), individualOrder('bad', { canceled_at: new Date('2026-01-01') })],
        });
        expect(a.legitimateOrders).toBe(1);
        expect(a.supporterCount).toBe(1);
        expect(a.supporters[0].email).toBe('ok@example.com');
    });

    it('excludes another organization\'s campaign', () => {
        const a = derivePreviousSupporters({
            ...base,
            orders: [individualOrder('theirs', { campaign_id: 'camp-coles' })],
        });
        expect(a.supporterCount).toBe(0);
    });

    it('excludes another tenant\'s customer', () => {
        const foreign = individualOrder('foreign');
        foreign.customer!.business_id = 'biz-2';
        const a = derivePreviousSupporters({ ...base, orders: [foreign] });
        expect(a.legitimateOrders).toBe(0);
        expect(a.supporterCount).toBe(0);
    });

    it('never counts a supporter with no usable email as sendable', () => {
        const a = derivePreviousSupporters({
            ...base,
            orders: [individualOrder('none', { email: null }),
                individualOrder('blank', { email: '   ' }),
                individualOrder('bad', { email: 'not-an-address' })],
        });
        expect(a.reachableCount).toBe(0);
        expect(a.supporterCount).toBe(3);
        expect(a.noEmailCount).toBe(3);
    });

    it('excludes a suppressed supporter from the sendable count', () => {
        const a = derivePreviousSupporters({
            ...base,
            suppressedEmails: new Set(['out@example.com']),
            orders: [individualOrder('in'), individualOrder('o', { email: 'out@example.com' })],
        });
        expect(a.supporterCount).toBe(2);
        expect(a.reachableCount).toBe(1);
        expect(a.suppressedCount).toBe(1);
        expect(a.supporters.find((s) => s.email === 'out@example.com')!.reachable).toBe(false);
    });

    it('an organization with no history gets a truthful empty state', () => {
        const a = derivePreviousSupporters({ ...base, orders: [] });
        expect(a.supporterCount).toBe(0);
        const d = describePreviousSupporters(a);
        expect(d.canInvite).toBe(false);
        expect(d.headline).toBe('No previous supporters yet');
    });
});

describe('FR-REBOOK-2 · the real Edgar shape', () => {
    // 17 real people, all pointing at the organization's own Customer row.
    const NAMES = ['Bonnie Marrs', 'Wyatt Williamson', 'Rebecca Schiver', 'Lori Brengle',
        'Dani Reeley', 'Mary Beth Walls', 'Sam Ford', 'Pat Nichols', 'Chris Vance',
        'Dale Ping', 'Jo Ann Rice', 'Kim Ochs', 'Terry Bell', 'Ann Frost',
        'Ray Cline', 'Nan Wells', 'Ed Barker'];
    const edgarOrders = NAMES.map((n, i) => coordinatorEnteredOrder(`e${i}`, n, `21746500${String(i).padStart(2, '0')}`));

    it('counts all 17 as real supporters', () => {
        const a = derivePreviousSupporters({ ...base, orders: edgarOrders });
        expect(a.legitimateOrders).toBe(17);
        expect(a.supporterCount).toBe(17);
    });

    it('NEVER adopts the organization\'s own address as a supporter\'s', () => {
        const a = derivePreviousSupporters({ ...base, orders: edgarOrders });
        expect(a.supporters.some((s) => s.email === 'manager@edgarcfb.org')).toBe(false);
        expect(a.supporters.every((s) => s.email === null)).toBe(true);
        // The disaster this prevents: 17 people collapsing into the coordinator.
        expect(a.supporterCount).not.toBe(1);
    });

    it('reports zero reachable, and the card refuses to offer an invitation', () => {
        const a = derivePreviousSupporters({ ...base, orders: edgarOrders });
        expect(a.reachableCount).toBe(0);
        expect(a.noEmailCount).toBe(17);
        const d = describePreviousSupporters(a);
        expect(d.canInvite).toBe(false);
        expect(d.detail).toContain('No previous supporters with a usable email address were found');
        // Truthful about the history it DOES have — not "no supporters".
        expect(d.headline).toContain('17 people');
    });

    it('another organization\'s order can never enter Edgar\'s audience', () => {
        const coles = coordinatorEnteredOrder('c1', 'Someone Else', '2175559999');
        coles.customer_id = OTHER_ORG;
        coles.customer!.id = OTHER_ORG;
        coles.campaign_id = 'camp-coles';
        const a = derivePreviousSupporters({ ...base, orders: [...edgarOrders, coles] });
        expect(a.legitimateOrders).toBe(17);
        expect(a.supporters.some((s) => s.displayName === 'Someone Else')).toBe(false);
    });

    it('a DIFFERENT organization linked to OUR OWN campaign still supplies no address', () => {
        // The campaign filter cannot help here: this order is on Edgar's own
        // prior campaign. Only the "an organization is never a supporter" rule
        // stands between Coles' coordinator inbox and Edgar's invitation list.
        const stray = coordinatorEnteredOrder('s1', 'Marge Whitaker', '2175557777');
        stray.customer_id = OTHER_ORG;
        stray.customer!.id = OTHER_ORG;
        stray.customer!.name = 'Coles County Farm Bureau';
        stray.customer!.contact_email = 'manager@colescfb.org';
        expect(stray.campaign_id).toBe(PRIOR);

        const a = derivePreviousSupporters({ ...base, orders: [stray] });
        expect(a.legitimateOrders).toBe(1);
        expect(a.supporters.some((s) => s.email === 'manager@colescfb.org')).toBe(false);
        expect(a.reachableCount).toBe(0);
        // The human on the order slip is still counted, by name and phone.
        expect(a.supporters[0].displayName).toBe('Marge Whitaker');
        expect(a.supporters[0].phone).toBe('2175557777');
    });
});

describe('FR-REBOOK-2 · normalization helpers', () => {
    it('normalizes case and surrounding space', () => {
        expect(normalizeSupporterEmail('  Bob@Example.COM ')).toBe('bob@example.com');
    });
    it('rejects addresses that cannot be delivered', () => {
        for (const bad of ['', '   ', 'no-at-sign', 'a@b', '@example.com', 'a@', 'a b@example.com',
            'two@@example.com', 'a@.com', 'a@example.', null, undefined, 42 as any]) {
            expect(normalizeSupporterEmail(bad as any)).toBeNull();
        }
    });
    it('recognises one phone number written several ways', () => {
        expect(normalizeSupporterPhone('(217) 465-8511')).toBe('2174658511');
        expect(normalizeSupporterPhone('+1 217.465.8511')).toBe('2174658511');
        expect(normalizeSupporterPhone('217-465-8511')).toBe('2174658511');
        expect(normalizeSupporterPhone('12345')).toBeNull();
    });
    it('masks an address rather than printing it', () => {
        const m = maskSupporterEmail('bonnie@example.com');
        expect(m).not.toBe('bonnie@example.com');
        expect(m.startsWith('b')).toBe(true);
        expect(m.endsWith('@example.com')).toBe(true);
    });
});

describe('FR-REBOOK-2 · the invitation draft', () => {
    const campaign = {
        id: CURRENT, name: 'Fall Fundraiser',
        end_date: new Date('2026-04-29T00:00:00.000Z'),   // a @db.Date column: midnight UTC
        public_token: 'pub-current',
    };
    const draftInput = {
        organizationName: 'Edgar County Farm Bureau',
        campaign,
        origin: 'https://www.freezeriqapp.com',
        brand: { name: 'Freezer Chef' },
    };

    it('uses the CURRENT campaign\'s supporter ordering URL', () => {
        // The ordering URL is shown BESIDE the editor, not inside the editable
        // prose — the server appends the real CTA (see renderInviteEmail).
        const d = buildInviteDraft({ ...draftInput, tenant: { slug: 'freezer-chef', customDomain: null } });
        expect(d.orderUrl).toBe('https://www.freezeriqapp.com/shop/freezer-chef/fundraiser/camp-current');
        expect(d.text).not.toContain('http');
    });

    it('never emits a coordinator portal link', () => {
        const d = buildInviteDraft(draftInput);
        expect(d.text).not.toContain('/coordinator');
        expect(d.text).not.toContain('#');
    });

    it('a prior campaign\'s token cannot become the link', () => {
        // The builder reads public_token off the campaign it was handed; there is
        // no parameter through which an old token could arrive.
        const old = buildSupporterOrderUrl('https://www.freezeriqapp.com', { public_token: 'pub-old' });
        const now = buildSupporterOrderUrl('https://www.freezeriqapp.com', { public_token: 'pub-current' });
        expect(old).not.toBe(now);
        expect(buildInviteDraft(draftInput).orderUrl).toBe(now);
    });

    it('refuses a non-http origin rather than emitting a broken link', () => {
        expect(buildSupporterOrderUrl('javascript:alert(1)', { public_token: 't' })).toBeNull();
        expect(buildSupporterOrderUrl(null, { public_token: 't' })).toBeNull();
        expect(buildSupporterOrderUrl('https://x.com', { public_token: null })).toBeNull();
    });

    it('a campaign with no public token yields NO link rather than a stale one', () => {
        const d = buildInviteDraft({ ...draftInput, campaign: { ...campaign, public_token: null } });
        expect(d.orderUrl).toBeNull();
        expect(d.text).not.toContain('/fundraiser/');
        expect(d.text).not.toContain('http');
    });

    it('includes the CURRENT campaign deadline, formatted for humans', () => {
        const d = buildInviteDraft(draftInput);
        expect(d.deadlineLabel).toBe('Wednesday, April 29');
        expect(d.text).toContain('Please place your order by Wednesday, April 29.');
    });

    it('does not shift a date-only deadline by a day', () => {
        // The bug this kills: formatting midnight-UTC in a western zone prints
        // the previous calendar day.
        expect(formatOrderDeadline(new Date('2026-04-29T00:00:00.000Z'))).toBe('Wednesday, April 29');
        expect(formatOrderDeadline('2026-01-01')).toBe('Thursday, January 1');
        expect(formatOrderDeadline('2026-12-31')).toBe('Thursday, December 31');
    });

    it('invents NO deadline when the campaign has none', () => {
        const d = buildInviteDraft({ ...draftInput, campaign: { ...campaign, end_date: null } });
        expect(d.deadlineLabel).toBeNull();
        expect(d.text).not.toMatch(/place your order by/i);
        expect(d.text).not.toMatch(/deadline/i);
        // And still a complete letter; the link is appended by the server.
        expect(d.text).toContain('another one');
        expect(d.text).toContain('order online using the link below');
    });

    it('invents no deadline from an unreadable value', () => {
        expect(formatOrderDeadline('not-a-date')).toBeNull();
        expect(formatOrderDeadline(null)).toBeNull();
        expect(formatOrderDeadline(undefined)).toBeNull();
        const d = buildInviteDraft({ ...draftInput, campaign: { ...campaign, end_date: 'not-a-date' } });
        expect(d.deadlineLabel).toBeNull();
        expect(d.text).not.toMatch(/place your order by/i);
    });

    it('a PRIOR campaign deadline cannot leak into the invitation', () => {
        const priorDeadline = formatOrderDeadline('2025-09-15');
        const d = buildInviteDraft(draftInput);
        expect(d.text).not.toContain(priorDeadline!);
        expect(d.text).toContain('Wednesday, April 29');
    });

    it('is normal prose — no markup, entities or template syntax', () => {
        const d = buildInviteDraft(draftInput);
        for (const s of [d.subject, d.text]) {
            expect(s).not.toMatch(/<[a-z/!]/i);
            expect(s).not.toMatch(/&[a-z#0-9]+;/i);
            expect(s).not.toMatch(/\{\{|\}\}|\$\{/);
        }
        expect(d.text).toContain('Edgar County Farm Bureau');
    });

    it('deleting the deadline sentence is accepted and changes no campaign data', () => {
        const d = buildInviteDraft(draftInput);
        const edited = d.text.replace('Please place your order by Wednesday, April 29.', '').trim();
        expect(edited).not.toMatch(/place your order by/i);
        const v = validateInviteMessage({ subject: d.subject, text: edited, orderUrl: d.orderUrl });
        expect(v.ok).toBe(true);
        // The campaign object handed in is untouched — the email is not the deadline.
        expect(campaign.end_date).toEqual(new Date('2026-04-29T00:00:00.000Z'));
        expect(buildInviteDraft(draftInput).deadlineLabel).toBe('Wednesday, April 29');
    });
});

describe('FR-REBOOK-2 · edited message validation', () => {
    const orderUrl = 'https://www.freezeriqapp.com/fundraiser/pub-current';
    const good = { subject: 'Hi', text: `Order here: ${orderUrl}`, orderUrl };

    it('accepts a rewritten subject and message', () => {
        const v = validateInviteMessage({ ...good, subject: 'Our fall fundraiser is live', text: `Totally new words. ${orderUrl}` });
        expect(v).toMatchObject({ ok: true, subject: 'Our fall fundraiser is live' });
        if (v.ok) expect(v.text).toContain('Totally new words.');
    });
    it('refuses an empty subject or message', () => {
        expect(validateInviteMessage({ ...good, subject: '   ' }).ok).toBe(false);
        expect(validateInviteMessage({ ...good, text: '   ' }).ok).toBe(false);
    });
    it('refuses non-string payloads', () => {
        expect(validateInviteMessage({ ...good, subject: 42 as any }).ok).toBe(false);
        expect(validateInviteMessage({ ...good, text: { toString: () => 'x' } as any }).ok).toBe(false);
    });
    it('bounds subject and body length', () => {
        expect(validateInviteMessage({ ...good, subject: 'x'.repeat(INVITE_SUBJECT_MAX + 1) }).ok).toBe(false);
        expect(validateInviteMessage({ ...good, text: orderUrl + 'x'.repeat(INVITE_BODY_MAX) }).ok).toBe(false);
    });
    it('accepts a message with no URL in it — the link is not the coordinator to delete', () => {
        const v = validateInviteMessage({ ...good, text: 'Come buy things.' });
        expect(v.ok).toBe(true);
    });
});

// ── Shipped-source contracts ────────────────────────────────────────────────
const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ROUTE = 'app/api/coordinator/previous-supporters/route.ts';
const CARD = 'components/coordinator/PreviousSupporters.tsx';

describe('FR-REBOOK-2 · coordinator authority (shipped source)', () => {
    const route = strip(R(ROUTE));

    it('derives scope from the session cookie, never the request', () => {
        expect(route).toContain('requireCoordinatorSession(req)');
        expect(route).toContain('const campaignId = guard.campaignId');
    });

    it('reads NO campaign, organization, business, batch or recipient id from the client', () => {
        expect(route).not.toMatch(/searchParams/);
        expect(route).not.toMatch(/body\?\.(campaignId|businessId|customerId|organizationId|batchId|recipients|emails|to)\b/);
        // The GET reads no body at all.
        const get = route.slice(route.indexOf('export async function GET('), route.indexOf('export async function POST('));
        expect(get).not.toMatch(/await req\.json\(\)/);
        // The POST reads one — deliberately, and takes exactly two strings from it.
        const post = route.slice(route.indexOf('export async function POST('));
        expect(post).toContain('subject: body?.subject, text: body?.text');
        expect((post.match(/body\?\./g) ?? [])).toHaveLength(2);
    });

    it('scopes prior campaigns to the coordinator\'s own organization', () => {
        expect(route).toContain('customer_id: organizationCustomerId');
        expect(route).toContain('id: { not: campaignId }');
    });

    it('passes the tenant id through to the derivation', () => {
        expect(route).toContain('businessId,');
        expect(route).toContain('derivePreviousSupporters({');
    });

    it('exposes GET and the armed send POST, with no direct provider call', () => {
        expect(route).toContain('export async function GET(');
        expect(route).toContain('export async function POST(');
        expect(route).not.toContain('export async function PUT(');
        // The send goes through runSend, which owns the unsubscribe footer, the
        // List-Unsubscribe headers and the send-time suppression re-check. A
        // direct provider call here would bypass all three.
        expect(route).not.toMatch(/provider\.send\(/);
        expect(route).not.toContain('resend.emails.send');
    });

    it('GET creates nothing at all', () => {
        const get = route.slice(route.indexOf('export async function GET('), route.indexOf('export async function POST('));
        for (const w of ['.create(', '.createMany(', '.update(', '.updateMany(', '.upsert(', '.delete(']) {
            expect(get).not.toContain(w);
        }
    });

    it('the send POST writes ONLY outreach rows — never an order or campaign', () => {
        const post = route.slice(route.indexOf('export async function POST('));
        for (const w of ['order.create', 'order.update', 'fundraiserCampaign.update', 'customer.update',
            'invoice.', 'fundraiserOpportunity']) {
            expect(post).not.toContain(w);
        }
        // Its durable writes all go through the batch helpers.
        expect(post).toContain('resolveCampaignBatch(prisma');
        expect(post).toContain('syncCampaignRecipients(prisma');
        expect(post).toContain('resolveCampaignMessage(prisma');
    });

    it('returns masked addresses and a bounded list, never a mailing list', () => {
        expect(route).toContain('emailMasked: s.email ? maskSupporterEmail(s.email) : null');
        expect(route).toContain('SUPPORTER_PREVIEW_LIMIT');
        // The full address is never placed in the payload.
        const payload = route.slice(route.indexOf('return NextResponse.json({'));
        expect(payload).not.toMatch(/email:\s*s\.email/);
    });

    it('re-reads durable opt-out truth at view time, through the SEND rule', () => {
        expect(route).toContain('marketingPreference.findMany');
        expect(route).toContain('suppressedEmails');
        // OUTREACH-PREFERENCE-DISPLAY-1: this route used to decide suppression
        // itself with `status: { not: 'subscribed' }`, which ignored
        // effective_until and so let an ELAPSED pause exclude a supporter the
        // send path considered perfectly reachable. It now consumes
        // evaluateSuppression — the same function checkSuppressionAtSend uses.
        expect(route).toContain('evaluateSuppression(rows, now)');
        expect(route).toContain('effective_until: true');
        expect(route).not.toContain("status: { not: 'subscribed' }");
    });

    it('states the send capability with a machine code, derived per request', () => {
        expect(route).toContain('resolveSendCapability({');
        for (const code of ['ready', 'no_reachable_audience', 'no_order_link', 'outreach_consent_unavailable']) {
            expect(route).toContain(`'${code}'`);
        }
    });

    it('builds the draft from the CURRENT campaign\'s own deadline and token', () => {
        // Now inside the shared buildDraftFor helper that GET and POST both use,
        // so the preview and the send cannot diverge.
        const call = route.slice(route.indexOf('return buildInviteDraft({'));
        const args = call.slice(0, call.indexOf('    });'));
        expect(args).toContain('end_date: campaign.end_date');
        expect(args).toContain('public_token: campaign.public_token');
        expect(args).toContain('id: campaign.id');
        expect(args).not.toContain('end_date: null');
        expect(args).not.toContain('public_token: null');
        expect(args).not.toContain('priorCampaign');
    });
});

describe('FR-REBOOK-2 · coordinator card (shipped source)', () => {
    const card = strip(R(CARD));

    it('shows an audience COUNT, never a To/CC address list', () => {
        expect(card).toContain('previous {c.reachable === 1');
        expect(card).not.toMatch(/\.map\([^)]*\)\s*\.join\(', '\)/);
        expect(card).not.toContain('emailMasked}@');
    });

    it('edits plain text and never composes HTML', () => {
        expect(card).toContain('setText(');
        expect(card).toContain('setSubject(');
        expect(card).not.toContain('setHtml(');
        expect(card).not.toContain('dangerouslySetInnerHTML');
    });

    it('starts from the SERVER draft rather than browser-authored copy', () => {
        expect(card).toContain('setSubject(json.draft.subject)');
        expect(card).toContain('setText(json.draft.text)');
        expect(card).not.toMatch(/Thanks again for supporting/);
        expect(card).not.toMatch(/\/fundraiser\//);
    });

    it('keeps the send control disabled and explains why in the server\'s words', () => {
        expect(card).toContain('disabled={!data.send.canSend || sending');
        expect(card).toContain('{data.send.reason}');
    });

    it('renders nothing for an organization with no history', () => {
        expect(card).toContain('if (data.counts.supporters === 0) return null;');
    });
});

describe('FR-REBOOK-2 · nothing is copied into the new campaign', () => {
    it('the derivation module performs no I/O at all', () => {
        const lib = strip(R('lib/previousSupporters.ts'));
        expect(lib).not.toContain('prisma');
        expect(lib).not.toContain('fetch(');
        expect(lib).not.toMatch(/\.(create|update|upsert|delete)\(/);
    });

    it('deriving twice does not mutate its input orders', () => {
        const orders = [individualOrder('a'), individualOrder('a2', { email: 'a@example.com' })];
        const before = JSON.stringify(orders);
        derivePreviousSupporters({ ...base, orders });
        derivePreviousSupporters({ ...base, orders });
        expect(JSON.stringify(orders)).toBe(before);
    });
});

describe('FR-REBOOK-2 · staged scope', () => {
    it('brings no schema change of its own beyond the approved Migration 18', () => {
        // FR-REBOOK-2 itself adds no schema. Migration 18 does — approved
        // separately, after review proved the hardened outreach delivery chain
        // could only belong to a SeasonalOffering and so had nowhere to record a
        // campaign invitation.
        //
        // This compares the WORKING TREE against HEAD, so it is at most
        // "<= 1, and if 1 it must be M18". Once this work is committed the diff
        // is legitimately empty and this test says nothing — an earlier version
        // asserted exactly 1 and would have failed the build the moment it was
        // committed. The DURABLE governance is the migration-list guard in
        // tests/frAcceptance2A2Dashboard.test.ts, which pins the full approved
        // set by name and fails for any unapproved addition, committed or not.
        //
        // --name-only, not --stat: --stat abbreviates long paths to ".../x".
        const names = execSync('git --literal-pathspecs diff --name-only HEAD -- prisma/', { encoding: 'utf8' });
        const migrations = names.split('\n').filter((l) => l.includes('migration.sql'));
        expect(migrations.length).toBeLessThanOrEqual(1);
        for (const m of migrations) {
            expect(m).toContain('20260826000000_m18_outreach_batch_campaign_ownership');
        }
    });
});
