/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0 — choose previous supporters, review one email, and
 * FreezerIQ sends each of them their own personalized copy of it.
 *
 * The REAL coordinator route (GET + POST), the REAL send engine and the REAL Preview
 * email policy run here against an in-memory database that enforces the same two
 * uniqueness rules Postgres does for delivery attempts:
 *
 *   @@unique([idempotency_key])
 *   email_delivery_attempts_one_live_per_recipient  ON (outreach_message_id, outreach_recipient_id)
 *                                                   WHERE NOT is_test AND status <> 'failed'
 *
 * Resend itself is replaced by a recorder, so every "email" below is a captured
 * provider payload. All people, organizations, addresses and domains are fictional.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__pse2Prisma; } }));
jest.mock('@/lib/coordinatorSession', () => ({
    requireCoordinatorSession: jest.fn(async () => (global as any).__pse2Session),
}));
jest.mock('@/lib/email', () => ({
    getTenantSender: jest.fn(async () => ({
        from: 'Maple Kitchen via FreezerIQ <notifications@freezeriq.test>',
        replyTo: 'hello@maple-kitchen.example',
    })),
}));
jest.mock('resend', () => ({
    Resend: jest.fn().mockImplementation(() => ({
        emails: { send: async (payload: any) => (global as any).__pse2Send(payload) },
    })),
}));
// PREVIOUS-SUPPORTER-EMAIL-2.0A: the two authorities FreezerIQ must prove before it
// sends itself. By DEFAULT the real ones run (today: no consent, no address). A test
// that needs to exercise the automated path supplies an override FUNCTION of the
// scope, so a wrong-organization or wrong-tenant lookup gets nothing back.
jest.mock('@/lib/previousSupporterAuthorities', () => {
    const actual = jest.requireActual('@/lib/previousSupporterAuthorities');
    const g = global as any;
    return {
        ...actual,
        // 2.0B: the REAL address authority always runs (against the in-memory DB);
        // the mock only records which organization/tenant it was asked about.
        loadOrganizationMailingAddress: jest.fn(async (scope: any, db?: any) => {
            (g.__pse2AuthCalls ??= []).push(['address', scope]);
            return actual.loadOrganizationMailingAddress(scope, db);
        }),
        loadExplicitEmailConsent: jest.fn(async (scope: any) => {
            (g.__pse2AuthCalls ??= []).push(['consent', scope]);
            return g.__pse2Consent ? g.__pse2Consent(scope) : actual.loadExplicitEmailConsent(scope);
        }),
    };
});

jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__pse2Auth) }));

import { GET, POST } from '@/app/api/coordinator/previous-supporters/route';
import { POST as DRAFT } from '@/app/api/coordinator/previous-supporters/draft/route';
import { GET as MAILING_GET, PUT as MAILING_PUT } from '@/app/api/customers/[id]/mailing-address/route';
import { MailingAddressCardView } from '@/components/crm2/orgDashboard/OrganizationMailingAddressCard';
import {
    describeAutomatedSend,
    validateOrganizationMailingAddress,
    type OrganizationMailingAddress,
} from '@/lib/previousSupporterAuthorities';
import {
    buildPersonalMailto,
    defaultInvitationMessage,
    defaultInvitationSubject,
    findPrivateLinkInMessage,
    headerSafeReplyTo,
    isPreviousSupporterRef,
    isSendableSupporterAddress,
    organizationFromHeader,
    previousSupporterRef,
    renderPreviousSupporterEmail,
    supporterGreetingName,
    PERSONAL_OPT_OUT_LINE,
    PREVIOUS_SUPPORTER_CTA_LABEL,
    type InvitationFacts,
    type InvitationSender,
} from '@/lib/previousSupporterEmail';
import { describeInvitationAvailability } from '@/lib/previousSupporterInvitation';
import {
    buildInviteSendBody,
    pruneSelection,
    selectAllReady,
    summarizeSelection,
    supporterStatusLabel,
    toggleSelected,
    type SupporterRow,
} from '@/lib/previousSupporterSelection';
import { resolveCanonicalSupporterUrl } from '@/lib/fundraiserCanonicalUrl';
import { ChooseStep, FundraiserFacts, SelectionCounts, SendResultDetail, SupporterList } from '@/components/coordinator/PreviousSupporters';
import { findAll, textOf } from './helpers/hookRuntime';

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════════════════════════════════════════════════════════════════
// FICTIONAL WORLD
// ═══════════════════════════════════════════════════════════════════════════
const BIZ_A = 'biz-maple';
const BIZ_B = 'biz-birch';
const ORG_A = 'org-maple-grove';
const ORG_A2 = 'org-cedar-hill';
const ORG_B = 'org-birch-valley';
const CUR = 'camp-maple-current';
const PREV = 'camp-maple-previous';
const A2_PREV = 'camp-cedar-previous';
const B_PREV = 'camp-birch-previous';
const B_CUR = 'camp-birch-current';

const ORG_A_NAME = 'Maple Grove Booster Club (fixture)';
const ORG_A2_NAME = 'Cedar Hill PTA (fixture)';
const CANONICAL = 'https://www.freezeriqapp.com/shop/maple-kitchen/fundraiser/camp-maple-current';

const JAMIE = 'jamie.example@example.test';
const CASEY = 'casey.sample@example.test';
const ALEX = 'alex.failer@example.test';
const TAYLOR = 'taylor.optout@example.test';
const RILEY = 'riley.otherorg@example.test';
const QUINN = 'quinn.tenantb@example.test';
const QUINN_LINKED = 'quinn.crosslinked@example.test';
const SAM = 'sam.current@example.test';
const PAT_ODD = 'pat@odd.example?cc=evil';

const d = (s: string) => new Date(s);
let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;
const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function makeWorld() {
    const businesses = [
        { id: BIZ_A, name: 'Maple Kitchen', display_name: null, slug: 'maple-kitchen', custom_domain: null, contact_email: 'hello@maple-kitchen.example', timezone: 'America/Chicago' },
        { id: BIZ_B, name: 'Birch Meals', display_name: null, slug: 'birch-meals', custom_domain: null, contact_email: 'hi@birch-meals.example', timezone: 'America/Chicago' },
    ];
    // 2.0B: organizations carry their own mailing address — and, deliberately, a DIFFERENT
    // delivery address, so any confusion between the two shows up in a test.
    const mail = (line1: string, line2: string | null, city: string, state: string, postal: string) => ({
        mailing_address_line1: line1, mailing_address_line2: line2, mailing_city: city, mailing_state: state, mailing_postal_code: postal,
    });
    const customers: any[] = [
        { id: ORG_A, business_id: BIZ_A, type: 'fundraiser_org', name: ORG_A_NAME, contact_email: 'coordinator@maple-grove.example', contact_phone: null,
            delivery_address: 'Loading Dock B, 5 Warehouse Rd, Maple Grove, IL 61944', notes: 'fixture notes', ...mail('742 Fixture Lane', 'Suite 3', 'Maple Grove', 'IL', '61944') },
        { id: ORG_A2, business_id: BIZ_A, type: 'fundraiser_org', name: ORG_A2_NAME, contact_email: 'pta@cedar-hill.example', contact_phone: null,
            ...mail('88 Cedar Ave', null, 'Cedarville', 'IL', '62000') },
        { id: ORG_B, business_id: BIZ_B, type: 'fundraiser_org', name: 'Birch Valley Scouts (fixture)', contact_email: 'scouts@birch.example', contact_phone: null,
            ...mail('9 Birch Rd', null, 'Birchton', 'IN', '47000') },
        { id: 'cust-jamie', business_id: BIZ_A, name: 'Jamie Example', contact_email: JAMIE, contact_phone: null },
        { id: 'cust-jamie-caps', business_id: BIZ_A, name: 'Jamie Example', contact_email: 'Jamie.Example@Example.test', contact_phone: null },
        { id: 'cust-alex', business_id: BIZ_A, name: 'Alex Failer', contact_email: ALEX, contact_phone: null },
        { id: 'cust-pat', business_id: BIZ_A, name: 'Pat Oddmail', contact_email: PAT_ODD, contact_phone: null },
        { id: 'cust-taylor', business_id: BIZ_A, name: 'Taylor Optout', contact_email: TAYLOR, contact_phone: null },
        { id: 'cust-drew', business_id: BIZ_A, name: 'Drew Canceled', contact_email: 'drew.canceled@example.test', contact_phone: null },
        { id: 'cust-riley', business_id: BIZ_A, name: 'Riley Otherorg', contact_email: RILEY, contact_phone: null },
        { id: 'cust-quinn-linked', business_id: BIZ_B, name: 'Quinn Crosslinked', contact_email: QUINN_LINKED, contact_phone: null },
        { id: 'cust-quinn', business_id: BIZ_B, name: 'Quinn Tenantb', contact_email: QUINN, contact_phone: null },
        { id: 'cust-sam', business_id: BIZ_A, name: 'Sam Current', contact_email: SAM, contact_phone: null },
        { id: 'cust-jamie-b', business_id: BIZ_B, name: 'Jamie Example', contact_email: JAMIE, contact_phone: null },
    ];
    const campaigns: any[] = [
        {
            id: CUR, customer_id: ORG_A, name: 'Fall 2030 internal label', status: 'Active', closed_at: null,
            end_date: d('2030-11-19T00:00:00Z'), delivery_date: d('2030-11-21T00:00:00Z'),
            delivery_time: '4:00–6:00 PM', pickup_location: 'Maple Grove Community Hall, 100 Example Ave',
            bundle_selection_status: 'selected', bundle_selection_limit: 2, public_token: 'pub-current',
        },
        {
            id: PREV, customer_id: ORG_A, name: 'Spring 2026 internal label', status: 'Closed', closed_at: d('2026-05-10T00:00:00Z'),
            end_date: d('2026-04-29T00:00:00Z'), delivery_date: d('2026-05-06T00:00:00Z'),
            delivery_time: '9–11 AM', pickup_location: 'Old Gym Lobby',
            bundle_selection_status: 'selected', bundle_selection_limit: 1, public_token: 'pub-previous',
        },
        {
            id: A2_PREV, customer_id: ORG_A2, name: 'Cedar spring', status: 'Closed', closed_at: d('2026-05-10T00:00:00Z'),
            end_date: d('2026-04-01T00:00:00Z'), delivery_date: null, delivery_time: null, pickup_location: null,
            bundle_selection_status: 'not_required', bundle_selection_limit: 2, public_token: 'pub-cedar',
        },
        {
            id: B_PREV, customer_id: ORG_B, name: 'Birch spring', status: 'Closed', closed_at: d('2026-05-10T00:00:00Z'),
            end_date: d('2026-04-01T00:00:00Z'), delivery_date: null, delivery_time: null, pickup_location: null,
            bundle_selection_status: 'not_required', bundle_selection_limit: 2, public_token: 'pub-birch-prev',
        },
        {
            id: B_CUR, customer_id: ORG_B, name: 'Birch fall', status: 'Active', closed_at: null,
            end_date: d('2030-11-19T00:00:00Z'), delivery_date: null, delivery_time: null, pickup_location: null,
            bundle_selection_status: 'not_required', bundle_selection_limit: 2, public_token: 'pub-birch-cur',
        },
    ];
    const bundle = (id: string, name: string, tier: string, family: string, price = 100, business_id = BIZ_A, is_active = true) =>
        ({ id, name, serving_tier: tier, family_id: family, price, business_id, is_active });
    const bundles = [
        bundle('b-harvest-5', 'Harvest Table', 'serves_5', 'fam-harvest', 125),
        bundle('b-harvest-2', 'Harvest Table (Serves 2)', 'serves_2', 'fam-harvest', 60),
        bundle('b-italy-5', 'Little Italy', 'serves_5', 'fam-italy', 125),
        bundle('b-italy-2', 'Little Italy (Serves 2)', 'serves_2', 'fam-italy', 60),
        bundle('b-spring-5', 'Spring Comfort Menu', 'serves_5', 'fam-spring', 125),
        bundle('b-cand-5', 'Candidate Only Menu', 'serves_5', 'fam-cand', 125),
        bundle('b-cand-2', 'Candidate Only Menu (Serves 2)', 'serves_2', 'fam-cand', 60),
        bundle('b-extra-5', 'Tenant Catalog Extra', 'serves_5', 'fam-extra', 125),
    ];
    const campaignBundles = [
        // Selection order deliberately NOT alphabetical: Little Italy first.
        { id: 'cb1', campaign_id: CUR, bundle_id: 'b-italy-5', position: 0, state: 'active' },
        { id: 'cb2', campaign_id: CUR, bundle_id: 'b-italy-2', position: 1, state: 'active' },
        { id: 'cb3', campaign_id: CUR, bundle_id: 'b-harvest-5', position: 2, state: 'active' },
        { id: 'cb4', campaign_id: CUR, bundle_id: 'b-harvest-2', position: 3, state: 'active' },
        { id: 'cb5', campaign_id: CUR, bundle_id: 'b-cand-5', position: 4, state: 'candidate' },
        { id: 'cb6', campaign_id: CUR, bundle_id: 'b-cand-2', position: 5, state: 'candidate' },
        { id: 'cb7', campaign_id: PREV, bundle_id: 'b-spring-5', position: 0, state: 'active' },
    ];
    const order = (id: string, campaign_id: string, customer_id: string | null, extra: any = {}) =>
        ({ id, campaign_id, customer_id, canceled_at: null, customer_name: null, phone: null, email: null, ...extra });
    const orders = [
        order('o-jamie-1', PREV, 'cust-jamie'),
        order('o-jamie-2', PREV, 'cust-jamie-caps'),                                       // same person, other case
        order('o-casey', PREV, ORG_A, { customer_name: 'Casey Sample', email: CASEY }),   // coordinator-entered
        order('o-morgan', PREV, ORG_A, { customer_name: 'Morgan Noemail', phone: '555-0100' }),
        order('o-alex', PREV, 'cust-alex'),
        order('o-pat', PREV, 'cust-pat'),
        order('o-taylor', PREV, 'cust-taylor'),
        order('o-drew', PREV, 'cust-drew', { canceled_at: d('2026-04-20T00:00:00Z') }),
        order('o-quinn-linked', PREV, 'cust-quinn-linked'),                               // linked to ANOTHER tenant
        order('o-riley', A2_PREV, 'cust-riley'),                                          // another organization
        order('o-jamie-a2', A2_PREV, 'cust-jamie'),                                       // same person, another org
        order('o-quinn', B_PREV, 'cust-quinn'),                                           // another tenant
        order('o-jamie-b', B_PREV, 'cust-jamie-b'),                                       // same address, another tenant
        order('o-sam', CUR, 'cust-sam'),                                                  // a CURRENT supporter
    ];
    const prefs: any[] = [
        { business_id: BIZ_A, scope: 'email_address', normalized_email: TAYLOR, contact_id: null, status: 'unsubscribed', effective_until: null },
    ];
    // Last spring's invitation for the PREVIOUS campaign: it must not make anyone
    // "already emailed" for the current one.
    const batches: any[] = [{ id: 'batch-prev', business_id: BIZ_A, customer_id: ORG_A, campaign_id: PREV }];
    const recipients: any[] = [{ id: 'rcpt-prev-jamie', business_id: BIZ_A, outreach_batch_id: 'batch-prev', normalized_email: JAMIE, display_name: 'Jamie Example' }];
    const messages: any[] = [{ id: 'msg-prev', business_id: BIZ_A, outreach_batch_id: 'batch-prev', subject: 'old', text_body: 'old', html_body: 'old', version: 1 }];
    const attempts: any[] = [{
        id: 'att-prev-jamie', business_id: BIZ_A, outreach_batch_id: 'batch-prev', outreach_recipient_id: 'rcpt-prev-jamie',
        outreach_message_id: 'msg-prev', idempotency_key: 'msg-prev:rcpt-prev-jamie:g1', attempt_number: 1,
        status: 'accepted', is_test: false, created_at: d('2026-04-01T00:00:00Z'), accepted_at: d('2026-04-01T00:00:00Z'),
    }];
    const writes: string[] = [];
    const rawSql: string[] = [];
    // FundraiserCampaignCoordinator rows, by campaign id (CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT shape).
    const assignments: Record<string, any> = {};

    const withCustomer = (c: any) => {
        const cust = customers.find((x) => x.id === c.customer_id);
        const business = businesses.find((b) => b.id === cust?.business_id) ?? null;
        return { ...c, customer: cust ? { ...cust, business } : null };
    };
    const campaignMatches = (c: any, w: any = {}) =>
        (w.id === undefined || (typeof w.id === 'string' ? c.id === w.id : c.id !== w.id.not))
        && (!w.NOT || c.id !== w.NOT.id)
        && (w.customer_id === undefined || c.customer_id === w.customer_id)
        && (!w.customer?.business_id || customers.find((x) => x.id === c.customer_id)?.business_id === w.customer.business_id);

    const client: any = {
        fundraiserCampaign: {
            findFirst: async ({ where }: any) => { const c = campaigns.find((x) => campaignMatches(x, where)); return c ? withCustomer(c) : null; },
            findMany: async (args: any) => {
                const rows = campaigns.filter((c) => campaignMatches(c, args.where));
                if (args.distinct) return [...new Set(rows.map((r) => r.customer_id))].map((customer_id) => ({ customer_id }));
                return rows.map((r) => ({ id: r.id }));
            },
        },
        customer: {
            findFirst: async ({ where }: any) => customers.find((c) => (!where?.NOT || c.id !== where.NOT.id)
                && (!where?.business_id || c.business_id === where.business_id) && c.id.startsWith('org-')) ?? null,
        },
        fundraiserCampaignCoordinator: {
            findUnique: async ({ where }: any) => assignments[where.campaign_id] ?? null,
        },
        // 2.0B: the two raw statements the mailing-address authority and CRM route use.
        $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
            const sql = strings.join('?');
            rawSql.push(sql);
            // Honour the statement as written: the SELECTed columns, and whichever of the
            // id / business_id / type predicates the WHERE actually carries.
            const select = sql.match(/SELECT\s+([\s\S]+?)\s+FROM customers\s+WHERE\s+([\s\S]+?)(?:\s+LIMIT|\s*$)/);
            if (select) {
                const cols = select[1].split(',').map((c) => c.trim());
                const where = select[2];
                const vals = [...values];
                const id = /\bid = \?/.test(where) ? vals.shift() : undefined;
                const biz = /business_id = \?/.test(where) ? vals.shift() : undefined;
                const types = /type::text IN/.test(where) ? vals : null;
                const c = customers.find((x) => (id === undefined || x.id === id) && (biz === undefined || x.business_id === biz) && (!types || types.includes(x.type)));
                return c ? [Object.fromEntries(cols.map((k) => [k, c[k] ?? null]))] : [];
            }
            throw new Error(`unexpected raw query: ${sql}`);
        },
        $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
            const sql = strings.join('?');
            rawSql.push(sql);
            writes.push('customers.mailing_address');
            const update = sql.match(/UPDATE customers\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/);
            if (update) {
                const sets = [...update[1].matchAll(/(\w+) = \?/g)].map((m) => m[1]);
                const where = update[2];
                const vals = values.slice(sets.length);
                const id = /\bid = \?/.test(where) ? vals.shift() : undefined;
                const biz = /business_id = \?/.test(where) ? vals.shift() : undefined;
                const types = /type::text IN/.test(where) ? vals : null;
                const c = customers.find((x) => (id === undefined || x.id === id) && (biz === undefined || x.business_id === biz) && (!types || types.includes(x.type)));
                if (!c) return 0;
                sets.forEach((col, i) => { c[col] = values[i]; });
                return 1;
            }
            throw new Error(`unexpected raw statement: ${sql}`);
        },
        order: {
            findMany: async ({ where }: any) => orders
                .filter((o) => where.campaign_id.in.includes(o.campaign_id) && (where.canceled_at !== null || o.canceled_at === null))
                .map((o) => ({ ...o, customer: o.customer_id ? customers.find((c) => c.id === o.customer_id) ?? null : null })),
        },
        marketingPreference: {
            findMany: async ({ where }: any) => prefs.filter((p) => p.business_id === where.business_id && (where.OR
                ? where.OR.some((br: any) => br.scope === p.scope && (br.normalized_email
                    ? p.normalized_email === br.normalized_email
                    : (br.contact_id?.in ?? []).includes(p.contact_id)))
                : p.scope === where.scope && p.normalized_email != null)),
        },
        campaignBundle: {
            findMany: async ({ where, orderBy }: any) => {
                let rows = campaignBundles.filter((cb) => cb.campaign_id === where.campaign_id
                    && (where.state === undefined || cb.state === where.state)
                    && (!where.bundle_id?.in || where.bundle_id.in.includes(cb.bundle_id)));
                if (orderBy?.position) rows = [...rows].sort((a, b) => a.position - b.position);
                return rows.map((cb) => ({ ...cb, bundle: bundles.find((b) => b.id === cb.bundle_id) }));
            },
        },
        bundle: {
            findMany: async ({ where }: any) => bundles.filter((b) => b.business_id === where.business_id
                && (where.is_active === undefined || b.is_active === where.is_active)),
        },
        outreachBatch: {
            findFirst: async ({ where }: any) => batches.find((b) => b.business_id === where.business_id
                && b.customer_id === where.customer_id && b.campaign_id === where.campaign_id) ?? null,
            create: async ({ data }: any) => {
                writes.push('outreachBatch.create');
                if (batches.some((b) => b.campaign_id === data.campaign_id)) throw p2002();
                const row = { id: nid('batch'), ...data }; batches.push(row); return { id: row.id };
            },
        },
        outreachRecipient: {
            findMany: async ({ where }: any) => recipients.filter((r) => r.business_id === where.business_id && r.outreach_batch_id === where.outreach_batch_id),
            create: async ({ data }: any) => {
                writes.push('outreachRecipient.create');
                if (recipients.some((r) => r.outreach_batch_id === data.outreach_batch_id && r.normalized_email === data.normalized_email)) throw p2002();
                const row = { id: nid('rcpt'), ...data }; recipients.push(row); return { id: row.id };
            },
            findFirst: async ({ where }: any) => recipients.find((r) => r.outreach_batch_id === where.outreach_batch_id && r.normalized_email === where.normalized_email) ?? null,
        },
        outreachMessage: {
            findFirst: async ({ where }: any) => messages.find((m) => m.outreach_batch_id === where.outreach_batch_id) ?? null,
            create: async ({ data }: any) => {
                writes.push('outreachMessage.create');
                const row = { id: nid('msg'), version: 1, ...data }; messages.push(row); return { id: row.id, version: row.version };
            },
            update: async ({ where, data }: any) => {
                writes.push('outreachMessage.update');
                const m = messages.find((x) => x.id === where.id);
                const { version, ...rest } = data;
                Object.assign(m, rest);
                if (version?.increment) m.version += version.increment;
                return { id: m.id, version: m.version };
            },
        },
        emailDeliveryAttempt: {
            create: async ({ data }: any) => {
                writes.push('emailDeliveryAttempt.create');
                if (attempts.some((a) => a.idempotency_key === data.idempotency_key)) throw p2002();
                // email_delivery_attempts_one_live_per_recipient
                if (!data.is_test && attempts.some((a) => !a.is_test && a.status !== 'failed'
                    && a.outreach_message_id === data.outreach_message_id && a.outreach_recipient_id === data.outreach_recipient_id)) throw p2002();
                const row = { id: nid('att'), created_at: new Date(), ...data }; attempts.push(row); return { id: row.id };
            },
            update: async ({ where, data }: any) => { writes.push('emailDeliveryAttempt.update'); const a = attempts.find((x) => x.id === where.id); Object.assign(a, data); return a; },
            findMany: async ({ where }: any) => attempts
                .filter((a) => a.business_id === where.business_id && a.outreach_batch_id === where.outreach_batch_id
                    && (where.is_test === undefined || a.is_test === where.is_test)
                    && (where.outreach_message_id === undefined || a.outreach_message_id === where.outreach_message_id)
                    && (!where.outreach_recipient_id?.in || where.outreach_recipient_id.in.includes(a.outreach_recipient_id))
                    && (where.attempt_number === undefined || a.attempt_number === where.attempt_number)
                    && (where.status === undefined || a.status === where.status))
                .map((a) => ({ ...a, recipient: { normalized_email: recipients.find((r) => r.id === a.outreach_recipient_id)?.normalized_email ?? null } })),
        },
    };
    return { client, campaigns, prefs, attempts, recipients, messages, batches, writes, assignments, customers, rawSql };
}

// ── harness ──────────────────────────────────────────────────────────────────
let world: ReturnType<typeof makeWorld>;
let sent: any[];
let failFor: Set<string>;
const ENV_KEYS = ['OUTREACH_UNSUBSCRIBE_SECRET', 'RESEND_API_KEY', 'NEXTAUTH_URL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterAll(() => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});
beforeEach(() => {
    world = makeWorld();
    sent = [];
    failFor = new Set();
    (global as any).__pse2Prisma = world.client;
    (global as any).__pse2Session = { ok: true, campaignId: CUR, sessionId: 'sess-1' };
    (global as any).__pse2Send = async (p: any) => {
        sent.push(p);
        const to = [].concat(p.to ?? []).join(',');
        if ([...failFor].some((f) => to.includes(f))) return { data: null, error: { message: 'Invalid recipient email address' } };
        return { data: { id: `re_${sent.length}` }, error: null };
    };
    process.env.OUTREACH_UNSUBSCRIBE_SECRET = 'fixture-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
    process.env.RESEND_API_KEY = 're_fixture_not_a_real_key';
    delete process.env.NEXTAUTH_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL;
    // The REAL authorities by default: no recorded consent anywhere; Maple Grove's
    // organization mailing address IS on file in the in-memory DB (2.0B).
    (global as any).__pse2Consent = undefined;
    (global as any).__pse2AuthCalls = [];
    // A tenant (CRM) session for Maple Kitchen, for the mailing-address route.
    (global as any).__pse2Auth = { user: { businessId: BIZ_A } };
});

/** Maple Grove's ORGANIZATION mailing address, as stored in the fixture (never its pickup hall or delivery dock). */
const ORG_A_ADDRESS: OrganizationMailingAddress = { line1: '742 Fixture Lane', line2: 'Suite 3', city: 'Maple Grove', state: 'IL', postalCode: '61944' };
/** Grant RECORDED consent for the given addresses, for ORG_A in BIZ_A only. (The address comes from the DB.) */
function grantAutomated(consented: string[] = [JAMIE, CASEY, ALEX, TAYLOR]) {
    const ours = (s: any) => s?.businessId === BIZ_A && s?.organizationCustomerId === ORG_A;
    (global as any).__pse2Consent = (s: any) => new Set(ours(s) ? consented : []);
}
/** Remove an organization's mailing address in the fixture DB. */
function clearAddress(orgId = ORG_A) {
    Object.assign(world.customers.find((c) => c.id === orgId), {
        mailing_address_line1: null, mailing_address_line2: null, mailing_city: null, mailing_state: null, mailing_postal_code: null,
    });
}
const EXPECTED_FROM = '"Maple Grove Booster Club (fixture) via Maple Kitchen" <notifications@freezeriq.test>';

const URL_BASE = 'https://www.freezeriqapp.com/api/coordinator/previous-supporters';
async function get() {
    const res = await GET(new Request(URL_BASE));
    return { status: res.status, body: await res.json() };
}
async function post(body: any) {
    const res = await POST(new Request(URL_BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://www.freezeriqapp.com' },
        body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
}
const refOf = (email: string, campaignId = CUR) => previousSupporterRef(campaignId, email);
const send = (selected: string[], over: any = {}) => post({
    subject: defaultInvitationSubject(ORG_A_NAME), text: defaultInvitationMessage(ORG_A_NAME),
    selected, confirm: 'send_individual_emails', ...over,
});
async function draft(ref: unknown) {
    const res = await DRAFT(new Request(`${URL_BASE}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://www.freezeriqapp.com' },
        body: JSON.stringify({ ref }),
    }));
    return { status: res.status, body: await res.json() };
}
/** A mailto: URL split into its recipient and decoded fields. */
function parseMailto(m: string) {
    const u = new URL(m);
    return { to: decodeURIComponent(u.pathname), params: [...u.searchParams.keys()], subject: u.searchParams.get('subject') ?? '', body: u.searchParams.get('body') ?? '' };
}
const toOf = (p: any): string[] => [].concat(p.to ?? []);
const sentTo = (email: string) => sent.filter((p) => toOf(p).includes(email));
const rowFor = (body: any, name: string) => body.supporters.find((s: SupporterRow) => s.name === name);

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE EMAIL ITSELF (pure)
// ═══════════════════════════════════════════════════════════════════════════
const FACTS: InvitationFacts = {
    organizationName: ORG_A_NAME,
    bundleNames: ['Little Italy', 'Harvest Table'],
    deadlineLabel: 'Tuesday, November 19',
    pickup: { dateLabel: 'Thursday, November 21', time: '4:00–6:00 PM', location: 'Maple Grove Community Hall, 100 Example Ave' },
    orderUrl: CANONICAL,
};

const SENDER: InvitationSender = { organizationName: ORG_A_NAME, tenantName: 'Maple Kitchen', mailingAddress: ORG_A_ADDRESS };

describe('1 · the rendered email', () => {
    const render = (over: Partial<Parameters<typeof renderPreviousSupporterEmail>[0]> = {}) => renderPreviousSupporterEmail({
        greetingName: 'Jamie Example', subject: defaultInvitationSubject(ORG_A_NAME),
        message: defaultInvitationMessage(ORG_A_NAME), facts: FACTS, sender: SENDER,
        ...over,
    })!;

    it('reads like a personal re-invitation, in the owner\'s order', () => {
        const t = render().text;
        expect(t.startsWith('Hi Jamie,\n\nThank you again for supporting Maple Grove Booster Club (fixture)!')).toBe(true);
        const order = ['Hi Jamie,', 'Our fundraiser is back and ordering is now open', "This round we're offering:", '• Little Italy', '• Harvest Table',
            'Ordering ends: Tuesday, November 19', 'Pickup:', 'Thursday, November 21', '4:00–6:00 PM', 'Maple Grove Community Hall, 100 Example Ave',
            "You can view this round's meals and place your order here:", CANONICAL, 'Thank you for supporting Maple Grove Booster Club (fixture)!'];
        let at = -1;
        for (const piece of order) { const i = t.indexOf(piece); expect(i).toBeGreaterThan(at); at = i; }
    });

    it('a useful, calm subject — no shouting, no fake urgency', () => {
        const s = defaultInvitationSubject(ORG_A_NAME);
        expect(s).toBe('Maple Grove Booster Club (fixture) fundraiser is back — ordering is open');
        expect(s).not.toMatch(/\b[A-Z]{4,}\b|!/);
        expect(s).not.toMatch(/urgent|last chance|act now|hurry|don't miss/i);
        expect(s.length).toBeLessThanOrEqual(80);
    });

    it('the HTML part has the "View Meals & Order" button AND the plain clickable URL', () => {
        const h = render().html;
        expect(PREVIOUS_SUPPORTER_CTA_LABEL).toBe('View Meals & Order');
        expect(h).toContain('View Meals &amp; Order</a>');
        const hrefs = [...h.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs).toEqual([CANONICAL, CANONICAL]);
        expect(h).toContain(`>${CANONICAL}</a>`);
    });

    it('omits a missing fact gracefully — never "null", "undefined" or "TBD"', () => {
        const out = render({ facts: { ...FACTS, bundleNames: [], deadlineLabel: null, pickup: { dateLabel: null, time: null, location: null } } });
        expect(out.text).not.toMatch(/null|undefined|TBD|NaN/);
        expect(out.text).not.toContain('Pickup:');
        expect(out.text).not.toContain('Ordering ends');
        expect(out.text).not.toContain("This round we're offering");
        expect(out.text).toContain(CANONICAL);
        const timeOnly = render({ facts: { ...FACTS, pickup: { dateLabel: 'Thursday, November 21', time: null, location: 'Hall' } } }).text;
        expect(timeOnly).toContain('Pickup:\nThursday, November 21\nHall\n');
    });

    it('greets by first name, or neutrally when there is no reliable one', () => {
        expect(render({ greetingName: 'JAMIE EXAMPLE' }).text.startsWith('Hi Jamie,')).toBe(true);
        for (const none of [null, '', 'Previous supporter', 'Mrs. Example', '555-0100', 'jamie@example.test', 'The Example Family']) {
            expect(render({ greetingName: none as any }).text.startsWith('Hi there,')).toBe(true);
        }
        expect(supporterGreetingName("D'Angelo Example")).toBe("D'Angelo");
        expect(supporterGreetingName('Mary-Kate Example')).toBe('Mary-Kate');
        expect(supporterGreetingName('Zoë Example')).toBe('Zoë');
        expect(supporterGreetingName('DeShawn Example')).toBe('DeShawn');
    });

    it('escapes everything the coordinator typed; a pasted URL is inert text', () => {
        const out = render({ message: '<script>alert(1)</script>\n\nOrder at https://evil.test/x <img src=x onerror=alert(1)>' });
        expect(out.html).not.toContain('<script');
        expect(out.html).not.toContain('<img');
        expect(out.html).toContain('https://evil.test/x');
        expect([...out.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([CANONICAL, CANONICAL]);
        const tags = [...new Set([...out.html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()))];
        expect(tags.every((t) => ['div', 'p', 'br', 'strong', 'a', 'ul', 'li'].includes(t))).toBe(true);
    });

    it('free-text campaign facts cannot add lines, controls or headers', () => {
        const out = render({ subject: 'Hello\r\nBcc: someone@evil.test', facts: { ...FACTS, pickup: { dateLabel: 'x', time: '4 PM\r\nBcc: someone@evil.test', location: `Hall${String.fromCharCode(0)}${String.fromCharCode(0x2028)}Room 2` } } });
        expect(out.subject).toBe('Hello Bcc: someone@evil.test');
        expect(out.subject).not.toMatch(/[\r\n]/);
        expect(out.text).toContain('4 PM, Bcc: someone@evil.test');
        expect(out.text).not.toMatch(new RegExp('[\\u0000\\u2028]'));
    });

    it('refuses to render without a safe ordering URL rather than mail a dead end', () => {
        for (const bad of ['', 'javascript:alert(1)', '/shop/x', 'http://www.freezeriqapp.com/shop/x', 'https://user:pw@x.test/']) {
            expect(renderPreviousSupporterEmail({ greetingName: null, subject: 's', message: 'm', facts: { ...FACTS, orderUrl: bad }, sender: SENDER })).toBeNull();
        }
    });

    it('2.0A: refuses to render an automated email without its sender\'s name and mailing address', () => {
        expect(renderPreviousSupporterEmail({ greetingName: null, subject: 's', message: 'm', facts: FACTS, sender: null })).toBeNull();
        expect(renderPreviousSupporterEmail({ greetingName: null, subject: 's', message: 'm', facts: FACTS, sender: { ...SENDER, organizationName: '  ' } })).toBeNull();
        expect(renderPreviousSupporterEmail({ greetingName: null, subject: 's', message: 'm', facts: FACTS, sender: { ...SENDER, mailingAddress: null as any } })).toBeNull();
    });

    it('2.0A: the footer names the ORGANIZATION, its mailing address and the delivery relationship', () => {
        const out = render();
        expect(out.text.endsWith([
            '--', ORG_A_NAME, '742 Fixture Lane', 'Suite 3', 'Maple Grove, IL 61944', '',
            'Sent on behalf of Maple Grove Booster Club (fixture) using Maple Kitchen fundraising services.',
        ].join('\n'))).toBe(true);
        expect(out.html).toContain('<strong>Maple Grove Booster Club (fixture)</strong><br />742 Fixture Lane<br />Suite 3<br />Maple Grove, IL 61944</p>');
        expect(out.html).toContain('Sent on behalf of Maple Grove Booster Club (fixture) using Maple Kitchen fundraising services.');
        // The pickup hall is a pickup fact, printed once in "Pickup:" — never as the sender's address.
        const footer = out.text.slice(out.text.lastIndexOf('--'));
        expect(footer).not.toContain('Community Hall');
        expect(footer).not.toContain('100 Example Ave');
    });

    it('refuses a message that would hand supporters a private link', () => {
        expect(findPrivateLinkInMessage('Hi', 'Use https://www.freezeriqapp.com/coordinator/access#secret')).toMatch(/coordinator portal link/);
        expect(findPrivateLinkInMessage('Hi', 'see https://freezeriq-abc.vercel.app/shop')).toMatch(/preview link/);
        expect(findPrivateLinkInMessage('Hi', 'Ask your coordinator if you have questions.')).toBeNull();
    });
});

describe('1b · addresses and references', () => {
    it('only plain single addresses are ever written to', () => {
        for (const ok of [JAMIE, 'o\'brien+fall@sub.example.org', 'a@b.co']) expect(isSendableSupporterAddress(ok)).toBe(true);
        for (const bad of [PAT_ODD, 'a@b.test,c@d.test', 'a@b.test;c@d.test', 'x@y.test\r\nbcc:z@w.test', 'A@B.TEST', ' a@b.test', 'a..b@c.test',
            'a@b', '"a"@b.test', 'a%b@c.test', 'a@b.test>', null, undefined, '']) {
            expect(isSendableSupporterAddress(bad as any)).toBe(false);
        }
    });

    it('a reference is opaque, stable, and scoped to ONE campaign', () => {
        const r = refOf(JAMIE);
        expect(isPreviousSupporterRef(r)).toBe(true);
        expect(r).toBe(refOf(JAMIE));
        expect(r).not.toBe(refOf(JAMIE, PREV));
        expect(r).not.toContain('jamie');
        expect(isPreviousSupporterRef(JAMIE)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SELECTION
// ═══════════════════════════════════════════════════════════════════════════
const row = (ref: string | null, status: SupporterRow['status'], selectable: boolean): SupporterRow => ({
    ref, name: `P ${ref}`, emailMasked: ref ? 'p••@example.test' : null, orderCount: 1, reachable: selectable, exclusionReason: null,
    status, statusAt: null, canOpenEmail: !!ref,
    automated: { eligible: selectable, reason: selectable ? null : 'FreezerIQ send unavailable — future email permission not recorded' },
    selectable,
});
const ROWS: SupporterRow[] = [
    row('ps_aaaaaaaaaaaaaaaaaaaaaaa1', 'ready', true),
    row('ps_aaaaaaaaaaaaaaaaaaaaaaa2', 'ready', true),
    row('ps_aaaaaaaaaaaaaaaaaaaaaaa3', 'failed', true),
    row(null, 'emailed', false),
    row(null, 'opted_out', false),
    row(null, 'no_email', false),
    row(null, 'invalid_email', false),
];

describe('2 · Select All, individual selection, clear', () => {
    it('Select All takes ONLY supporters who can be emailed and have not been', () => {
        expect(selectAllReady(ROWS)).toEqual(['ps_aaaaaaaaaaaaaaaaaaaaaaa1', 'ps_aaaaaaaaaaaaaaaaaaaaaaa2']);
    });
    it('a failed send is retried only by ticking that person on purpose', () => {
        expect(toggleSelected([], 'ps_aaaaaaaaaaaaaaaaaaaaaaa3', ROWS)).toEqual(['ps_aaaaaaaaaaaaaaaaaaaaaaa3']);
    });
    it('individual toggling adds and removes; an ineligible row can never enter', () => {
        let s = toggleSelected([], 'ps_aaaaaaaaaaaaaaaaaaaaaaa2', ROWS);
        expect(s).toEqual(['ps_aaaaaaaaaaaaaaaaaaaaaaa2']);
        s = toggleSelected(s, 'ps_aaaaaaaaaaaaaaaaaaaaaaa2', ROWS);
        expect(s).toEqual([]);
        expect(toggleSelected([], 'ps_not_a_row_000000000000', ROWS)).toEqual([]);
        // Even a row that somehow carries a reference cannot be ticked when it is not selectable.
        expect(toggleSelected([], 'ps_bbbbbbbbbbbbbbbbbbbbbbb1', [row('ps_bbbbbbbbbbbbbbbbbbbbbbb1', 'emailed', false)])).toEqual([]);
        expect(pruneSelection(['ps_aaaaaaaaaaaaaaaaaaaaaaa1', 'ps_gone0000000000000000000'], ROWS)).toEqual(['ps_aaaaaaaaaaaaaaaaaaaaaaa1']);
    });
    it('the review counts say who is included and why others are not — counts only', () => {
        const sum = summarizeSelection(['ps_aaaaaaaaaaaaaaaaaaaaaaa1', 'ps_aaaaaaaaaaaaaaaaaaaaaaa3'], ROWS);
        expect(sum.selected).toBe(2);
        expect(sum.ready).toBe(2);
        expect(sum.notIncluded).toEqual(expect.arrayContaining([
            { label: 'already emailed for this fundraiser', count: 1 },
            { label: 'opted out of email', count: 1 },
            { label: 'no email address on file', count: 1 },
            { label: 'no usable email address', count: 1 },
        ]));
    });
    it('status wording never claims delivery', () => {
        for (const st of ['ready', 'emailed', 'sending', 'failed', 'opted_out', 'no_email', 'invalid_email'] as const) {
            expect(supporterStatusLabel({ status: st, statusAt: '2030-11-01T12:00:00Z' })).not.toMatch(/deliver/i);
        }
    });
    it('the send body is the two strings, the ticked references and the confirmation — nothing else', () => {
        expect(buildInviteSendBody({ subject: ' S ', text: 'T', selected: ['ps_aaaaaaaaaaaaaaaaaaaaaaa1'] }))
            .toEqual({ subject: 'S', text: 'T', selected: ['ps_aaaaaaaaaaaaaaaaaaaaaaa1'], confirm: 'send_individual_emails' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. GET — who, and what the current fundraiser says
// ═══════════════════════════════════════════════════════════════════════════
describe('3 · the coordinator view (real GET)', () => {
    it('lists this organization\'s previous supporters with an honest status each', async () => {
        const { status, body } = await get();
        expect(status).toBe(200);
        const names = body.supporters.map((s: SupporterRow) => s.name).sort();
        expect(names).toEqual(['Alex Failer', 'Casey Sample', 'Jamie Example', 'Morgan Noemail', 'Pat Oddmail', 'Taylor Optout']);
        // TODAY (real authorities, organization address on file): everyone with a usable address
        // can be emailed PERSONALLY; nobody can be sent by FreezerIQ, and each row says why.
        expect(rowFor(body, 'Jamie Example')).toMatchObject({ status: 'ready', canOpenEmail: true, selectable: false, orderCount: 2, ref: refOf(JAMIE),
            automated: { eligible: false, reason: 'FreezerIQ send unavailable — future email permission not recorded' } });
        expect(body.personal).toEqual({ available: true, code: 'available', reason: 'Prepared emails include the organization’s mailing address.' });
        expect(rowFor(body, 'Casey Sample')).toMatchObject({ status: 'ready', canOpenEmail: true, selectable: false });
        expect(rowFor(body, 'Morgan Noemail')).toMatchObject({ status: 'no_email', canOpenEmail: false, selectable: false, ref: null });
        expect(rowFor(body, 'Pat Oddmail')).toMatchObject({ status: 'invalid_email', canOpenEmail: false, selectable: false, ref: null });
        expect(rowFor(body, 'Taylor Optout')).toMatchObject({ status: 'opted_out', canOpenEmail: false, selectable: false, ref: null });
        // Rows the coordinator can act on come first.
        expect(body.supporters.slice(0, 3).every((s: SupporterRow) => s.canOpenEmail)).toBe(true);
        // With the automated path granted, the same rows become selectable.
        grantAutomated();
        const granted = (await get()).body;
        expect(rowFor(granted, 'Jamie Example')).toMatchObject({ selectable: true, automated: { eligible: true, reason: null } });
        expect(granted.supporters.slice(0, 3).every((s: SupporterRow) => s.selectable)).toBe(true);
    });

    it('dedupe: one person who ordered twice (any letter case) is ONE row with ONE reference', async () => {
        const { body } = await get();
        const jamies = body.supporters.filter((s: SupporterRow) => s.name === 'Jamie Example');
        expect(jamies).toHaveLength(1);
        expect(jamies[0].ref).toBe(refOf(JAMIE));
    });

    it('never ships a full address — masked only, and no other organization or tenant', async () => {
        const { body } = await get();
        const json = JSON.stringify(body);
        for (const e of [JAMIE, CASEY, ALEX, TAYLOR, RILEY, QUINN, QUINN_LINKED, SAM, 'Jamie.Example@Example.test']) expect(json).not.toContain(e);
        expect(json).not.toMatch(/Riley|Quinn|Sam Current|Drew/);   // other org, other tenant, current supporter, canceled
        expect(rowFor(body, 'Jamie Example').emailMasked).toMatch(/^j•+@example\.test$/);
        expect(json).not.toMatch(/portal_token|cust-|o-jamie|batch-|rcpt-/);
    });

    it('the draft facts are the CURRENT campaign\'s — never the previous one', async () => {
        const { body } = await get();
        expect(body.invitation).toEqual({ open: true, code: 'open', reason: 'Ordering is open.' });
        expect(body.draft.orderUrl).toBe(CANONICAL);
        expect(body.draft.facts).toEqual({
            bundleNames: ['Little Italy', 'Harvest Table'],
            deadlineLabel: 'Tuesday, November 19',
            pickup: { dateLabel: 'Thursday, November 21', time: '4:00–6:00 PM', location: 'Maple Grove Community Hall, 100 Example Ave' },
        });
        const json = JSON.stringify(body.draft);
        for (const old of ['Spring Comfort Menu', 'Wednesday, April 29', 'May 6', 'Old Gym Lobby', '9–11 AM', 'pub-previous', PREV]) expect(json).not.toContain(old);
        for (const notOurs of ['Candidate Only Menu', 'Tenant Catalog Extra']) expect(json).not.toContain(notOurs);
    });

    it('the ordering link is THE canonical supporter URL — a Preview host never becomes it', async () => {
        process.env.VERCEL_URL = 'freezeriq-abc123-team.vercel.app';
        const { body } = await get();
        expect(body.draft.orderUrl).toBe(resolveCanonicalSupporterUrl({ campaignId: CUR, slug: 'maple-kitchen', customDomain: null }));
        expect(body.draft.orderUrl).toBe(CANONICAL);
        expect(body.draft.orderUrl).not.toMatch(/vercel\.app|\?|#/);
    });

    it('last season\'s invitation for the PREVIOUS campaign does not count as emailed now', async () => {
        const { body } = await get();
        expect(rowFor(body, 'Jamie Example').status).toBe('ready');
        expect(body.counts.emailedThisFundraiser).toBe(0);
    });

    it('viewing creates nothing and contacts nobody', async () => {
        await get();
        expect(world.writes).toEqual([]);
        expect(sent).toHaveLength(0);
    });

    it.each([
        ['ordering_closed', { status: 'Closed', closed_at: d('2030-11-01T00:00:00Z') }],
        ['ordering_closed', { end_date: d('2020-01-01T00:00:00Z') }],
        ['not_open_yet', { status: 'Lead' }],
        ['menu_pending', { bundle_selection_status: 'pending' }],
    ])('no open fundraiser (%s) → nothing selectable, nothing sendable', async (code, patch) => {
        Object.assign(world.campaigns.find((c) => c.id === CUR), patch);
        const { body } = await get();
        expect(body.invitation.open).toBe(false);
        expect(body.invitation.code).toBe(code);
        expect(body.send).toMatchObject({ canSend: false, code });
        expect(body.supporters.every((s: SupporterRow) => !s.selectable && !s.canOpenEmail && s.ref === null)).toBe(true);
        expect(body.draft.facts).toBeNull();
        grantAutomated();
        const r = await send([refOf(JAMIE)]);
        expect(r.status).toBe(409);
        expect((await draft(refOf(JAMIE))).status).toBe(409);       // no personal draft to a closed fundraiser either
        expect(sent).toHaveLength(0);
    });

    it('availability is described for every order mode', () => {
        expect(describeInvitationAvailability({ allowed: true, mode: 'legacy' }, CANONICAL).open).toBe(true);
        expect(describeInvitationAvailability({ allowed: true, mode: 'selected' }, null).code).toBe('no_order_link');
        expect(describeInvitationAvailability({ allowed: false, mode: 'invalid', reasonCode: 'invalid' }, CANONICAL).code).toBe('menu_unavailable');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. POST — one separate, personalized email per selected supporter
// ═══════════════════════════════════════════════════════════════════════════
describe('4 · individual sends (real POST, real engine)', () => {
    // Everything in this section exercises FreezerIQ's OWN sending, so the two
    // authorities it requires are granted for Maple Grove (in BIZ_A) only.
    beforeEach(() => grantAutomated());

    it('nothing is sent without the explicit confirmation', async () => {
        const r = await post({ subject: 'Hi', text: 'Words', selected: [refOf(JAMIE)] });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('not_confirmed');
        // An old browser tab's "send to everyone" body sends nothing either.
        const legacy = await post({ subject: 'Hi', text: 'Words' });
        expect(legacy.status).toBe(400);
        expect(sent).toHaveLength(0);
        expect(world.writes).toEqual([]);
    });

    it('nothing is sent with an empty selection', async () => {
        const r = await send([]);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('nothing_selected');
        expect(sent).toHaveLength(0);
    });

    it('Select All → ONE email per supporter, each addressed only to that supporter', async () => {
        const { body: view } = await get();
        const r = await send(selectAllReady(view.supporters));
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, accepted: 3, failed: 0, skipped: 0, alreadySent: 0 });
        expect(sent).toHaveLength(3);
        expect(sent.map((p) => toOf(p)).sort()).toEqual([[ALEX], [CASEY], [JAMIE]]);
        const everyone = [JAMIE, CASEY, ALEX, TAYLOR, PAT_ODD, RILEY, QUINN, SAM];
        const people = ['Jamie', 'Casey', 'Alex', 'Taylor', 'Morgan', 'Pat', 'Riley', 'Quinn', 'Sam'];
        for (const p of sent) {
            expect(Object.keys(p)).not.toEqual(expect.arrayContaining(['cc']));
            expect(p.cc).toBeUndefined();
            expect(p.bcc).toBeUndefined();
            const own = toOf(p)[0];
            const blob = `${p.subject}\n${p.html}\n${p.text}\n${JSON.stringify(p.headers ?? {})}`;
            for (const other of everyone.filter((e) => e !== own)) expect(blob).not.toContain(other);
            const ownFirst = own === JAMIE ? 'Jamie' : own === CASEY ? 'Casey' : 'Alex';
            expect(p.text.startsWith(`Hi ${ownFirst},`)).toBe(true);
            expect(p.html).toContain(`Hi ${ownFirst},`);
            for (const otherName of people.filter((n) => n !== ownFirst)) expect(p.text).not.toMatch(new RegExp(`\\b${otherName}\\b`));
        }
    });

    it('every email states the CURRENT fundraiser and links to its canonical page', async () => {
        await send([refOf(JAMIE), refOf(CASEY)]);
        expect(sent).toHaveLength(2);
        for (const p of sent) {
            expect(p.text).toContain(`• Little Italy\n• Harvest Table`);
            expect(p.text).toContain('Ordering ends: Tuesday, November 19');
            expect(p.text).toContain('Pickup:\nThursday, November 21\n4:00–6:00 PM\nMaple Grove Community Hall, 100 Example Ave');
            expect(p.text).toContain(`You can view this round's meals and place your order here:\n${CANONICAL}`);
            expect(p.html).toContain(`href="${CANONICAL}"`);
            expect(p.html).toContain('View Meals &amp; Order');
            expect(p.subject).toBe('Maple Grove Booster Club (fixture) fundraiser is back — ordering is open');
            const blob = `${p.subject}${p.html}${p.text}`;
            for (const old of ['Spring Comfort Menu', 'April 29', 'May 6', 'Old Gym Lobby', '9–11 AM', 'pub-previous', PREV, 'pub-current', 'Candidate Only Menu', 'Tenant Catalog Extra', ORG_A2_NAME]) {
                expect(blob).not.toContain(old);
            }
            expect(blob).not.toMatch(/vercel\.app|\/coordinator|portal/);
            // 2.0A: the ORGANIZATION is the displayed sender, on the platform's own verified
            // address; replies reach the campaign's coordinator authority (here the
            // organization's on-file contact, as no coordinator is assigned).
            expect(p.from).toBe(EXPECTED_FROM);
            expect(p.replyTo).toBe('coordinator@maple-grove.example');
            expect(p.text).toContain('742 Fixture Lane\nSuite 3\nMaple Grove, IL 61944');
            expect(p.text).toContain('Sent on behalf of Maple Grove Booster Club (fixture) using Maple Kitchen fundraising services.');
            expect(p.text).toContain('You are receiving this because you supported a fundraiser run with Maple Grove Booster Club (fixture).');
        }
    });

    it('each email carries ITS OWN unsubscribe link and one-click headers', async () => {
        await send([refOf(JAMIE), refOf(CASEY)]);
        const links = sent.map((p) => (p.text.match(/https:\/\/www\.freezeriqapp\.com\/u\/\S+/) ?? [])[0]);
        expect(links.every(Boolean)).toBe(true);
        expect(new Set(links).size).toBe(2);
        for (const p of sent) {
            expect(p.headers['List-Unsubscribe']).toMatch(/^<https:\/\/www\.freezeriqapp\.com\/api\/unsubscribe\//);
            expect(p.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
            expect(p.html).toContain('Unsubscribe from promotional emails');
        }
    });

    it('individual selection sends to exactly the ticked supporter', async () => {
        const r = await send([refOf(CASEY)]);
        expect(r.body.accepted).toBe(1);
        expect(sent.map(toOf)).toEqual([[CASEY]]);
    });

    it('ineligible or foreign references send nothing and are counted, not trusted', async () => {
        const r = await send([
            refOf(TAYLOR),                       // opted out
            refOf(PAT_ODD),                      // not a usable address
            refOf(RILEY),                        // another organization
            refOf(QUINN), refOf(QUINN_LINKED),   // another tenant
            refOf(SAM),                          // a CURRENT supporter, not a previous one
            refOf(JAMIE, B_CUR),                 // a real person, but another campaign's reference
            'ps_000000000000000000000000',       // made up
            'jamie.example@example.test',        // not a reference at all — ignored
        ]);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ accepted: 0, outcome: 'nothing_to_send' });
        expect(r.body.notSent).toEqual({ noLongerEligible: 6, optedOut: 1, noUsableEmail: 1, alreadyEmailed: 0, noConsent: 0 });
        expect(sent).toHaveLength(0);
    });

    it('an opt-out recorded AFTER review is honoured at send time', async () => {
        const { body: view } = await get();
        world.prefs.push({ business_id: BIZ_A, scope: 'email_address', normalized_email: CASEY, contact_id: null, status: 'unsubscribed', effective_until: null });
        const r = await send(selectAllReady(view.supporters));
        expect(r.body.accepted).toBe(2);
        expect(r.body.notSent.optedOut).toBe(1);
        expect(sentTo(CASEY)).toHaveLength(0);
    });

    it('a request retry cannot send twice — the second answers "already emailed"', async () => {
        const sel = [refOf(JAMIE), refOf(CASEY)];
        await send(sel);
        const again = await send(sel);
        expect(again.body).toMatchObject({ accepted: 0 });
        expect(again.body.notSent.alreadyEmailed).toBe(2);
        expect(sent).toHaveLength(2);
    });

    it('a double-click (two concurrent requests) cannot send twice', async () => {
        const sel = [refOf(JAMIE), refOf(CASEY), refOf(ALEX)];
        const [a, b] = await Promise.all([send(sel), send(sel)]);
        expect(a.body.accepted + b.body.accepted).toBe(3);
        for (const e of [JAMIE, CASEY, ALEX]) expect(sentTo(e)).toHaveLength(1);
        expect(sent).toHaveLength(3);
    });

    it('editing the wording after a send still never re-mails someone already emailed', async () => {
        await send([refOf(JAMIE)]);
        const r = await send([refOf(JAMIE), refOf(CASEY)], { text: 'A completely rewritten message.' });
        expect(r.body.accepted).toBe(1);
        expect(sentTo(JAMIE)).toHaveLength(1);
        expect(sentTo(CASEY)).toHaveLength(1);
    });

    it('a partial provider failure is reported truthfully, per person', async () => {
        failFor.add(ALEX);
        const r = await send([refOf(JAMIE), refOf(CASEY), refOf(ALEX)]);
        expect(r.body).toMatchObject({ ok: true, accepted: 2, failed: 1, skipped: 0, outcome: 'completed_with_issues' });
        const statusByEmail = Object.fromEntries(world.attempts.filter((a) => a.outreach_batch_id !== 'batch-prev')
            .map((a) => [world.recipients.find((x) => x.id === a.outreach_recipient_id)!.normalized_email, a.status]));
        expect(statusByEmail).toEqual({ [JAMIE]: 'accepted', [CASEY]: 'accepted', [ALEX]: 'failed' });
        const { body: view } = await get();
        expect(rowFor(view, 'Jamie Example')).toMatchObject({ status: 'emailed', selectable: false });
        expect(rowFor(view, 'Alex Failer')).toMatchObject({ status: 'failed', selectable: true });
        expect(selectAllReady(view.supporters)).toEqual([]);              // Select All never re-sends anyone
        expect(view.counts.emailedThisFundraiser).toBe(2);
    });

    it('a failed supporter can be retried deliberately, once, without touching the others', async () => {
        failFor.add(ALEX);
        await send([refOf(JAMIE), refOf(ALEX)]);
        failFor.clear();
        const retry = await send([refOf(ALEX)]);
        expect(retry.body).toMatchObject({ accepted: 1, failed: 0 });
        expect(sentTo(ALEX)).toHaveLength(2);       // the refused attempt + the retry
        expect(sentTo(JAMIE)).toHaveLength(1);
        const again = await send([refOf(ALEX)]);
        expect(again.body.accepted).toBe(0);
        expect(sentTo(ALEX)).toHaveLength(2);
    });

    it('results never claim delivery', async () => {
        const r = await send([refOf(JAMIE)]);
        expect(JSON.stringify(r.body)).not.toMatch(/deliver/i);
        const { body } = await get();
        expect(JSON.stringify(body)).not.toMatch(/deliver/i);
        expect(rowFor(body, 'Jamie Example').status).toBe('emailed');
        expect(supporterStatusLabel(rowFor(body, 'Jamie Example'))).toMatch(/^Emailed /);
    });

    it('a private link pasted into the message is refused before anything is sent', async () => {
        const r = await send([refOf(JAMIE)], { text: 'Use https://www.freezeriqapp.com/coordinator/access#abc to help' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('private_link');
        expect(sent).toHaveLength(0);
    });

    it('with no unsubscribe capability nothing is sent and nobody is contacted', async () => {
        delete process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        const r = await send([refOf(JAMIE)]);
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('outreach_consent_unavailable');
        expect(sent).toHaveLength(0);
    });

    it('a Preview deployment can never mail a real supporter', async () => {
        process.env.VERCEL_ENV = 'preview';
        const r = await send([refOf(JAMIE), refOf(CASEY)]);
        expect(r.body.accepted).toBe(2);
        expect(sent).toHaveLength(2);
        for (const p of sent) {
            expect(toOf(p)).toEqual(['delivered@resend.dev']);
            expect(p.cc).toBeUndefined();
            expect(p.bcc).toBeUndefined();
            expect(p.subject.startsWith('[PREVIEW to: ')).toBe(true);
        }
    });

    it('uses no phone number and no SMS anywhere', async () => {
        await send([refOf(JAMIE), refOf(CASEY), refOf(ALEX)]);
        for (const p of sent) expect(JSON.stringify(p)).not.toContain('555-0100');
        for (const f of ['lib/previousSupporterEmail.ts', 'lib/previousSupporterInvitation.ts', 'lib/previousSupporterSelection.ts',
            'app/api/coordinator/previous-supporters/route.ts', 'components/coordinator/PreviousSupporters.tsx']) {
            expect(strip(R(f))).not.toMatch(/twilio|sms:|\bphone\b/i);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ISOLATION
// ═══════════════════════════════════════════════════════════════════════════
describe('5 · tenant and organization isolation', () => {
    it('another tenant\'s coordinator sees only their own supporters', async () => {
        (global as any).__pse2Session = { ok: true, campaignId: B_CUR, sessionId: 'sess-b' };
        const { body } = await get();
        expect(body.supporters.map((s: SupporterRow) => s.name).sort()).toEqual(['Jamie Example', 'Quinn Tenantb']);
        expect(JSON.stringify(body)).not.toMatch(/Casey|Alex|Taylor|Morgan|Pat|Riley/);
    });

    it('the same address in another tenant is a different supporter with its own history', async () => {
        // Each tenant's organization has its OWN address (in the DB) and its OWN consent records.
        const isA = (s: any) => s.businessId === BIZ_A && s.organizationCustomerId === ORG_A;
        const isB = (s: any) => s.businessId === BIZ_B && s.organizationCustomerId === ORG_B;
        (global as any).__pse2Consent = (s: any) => new Set(isA(s) ? [JAMIE] : isB(s) ? [JAMIE, QUINN] : []);
        await send([refOf(JAMIE)]);                                         // Maple's coordinator emails Jamie
        (global as any).__pse2Session = { ok: true, campaignId: B_CUR, sessionId: 'sess-b' };
        const { body } = await get();
        expect(rowFor(body, 'Jamie Example')).toMatchObject({ status: 'ready', ref: refOf(JAMIE, B_CUR), selectable: true });
        // And Maple's reference is meaningless here.
        const r = await send([refOf(JAMIE)]);
        expect(r.body.notSent.noLongerEligible).toBe(1);
        expect(sentTo(JAMIE)).toHaveLength(1);
        // Tenant B's own send carries tenant B's organization and address — never Maple's.
        const BIRCH = 'Birch Valley Scouts (fixture)';
        await send([refOf(JAMIE, B_CUR)], { subject: defaultInvitationSubject(BIRCH), text: defaultInvitationMessage(BIRCH) });
        const bMail = sentTo(JAMIE)[1];
        expect(bMail.from).toBe('"Birch Valley Scouts (fixture) via Birch Meals" <notifications@freezeriq.test>');
        expect(bMail.text).toContain('9 Birch Rd\nBirchton, IN 47000');
        expect(bMail.text).not.toMatch(/Maple|742 Fixture Lane/);
    });

    it('another organization in the same tenant never leaks in', async () => {
        grantAutomated();
        const { body } = await get();
        expect(JSON.stringify(body)).not.toContain('Riley');
        const r = await send([refOf(RILEY)]);
        expect(r.body.notSent.noLongerEligible).toBe(1);
        expect((await draft(refOf(RILEY))).status).toBe(404);
        expect(sent).toHaveLength(0);
    });

    it('an order linked to another tenant\'s customer contributes nobody', async () => {
        const { body } = await get();
        expect(JSON.stringify(body)).not.toContain('Quinn');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE CARD (hookless pieces, real elements)
// ═══════════════════════════════════════════════════════════════════════════
describe('6 · the coordinator card', () => {
    const noop = () => { /* */ };
    it('checkboxes exist only for supporters who can be emailed; Select all / Clear / count', () => {
        const calls: string[] = [];
        const tree = ChooseStep({
            rows: ROWS, selected: ['ps_aaaaaaaaaaaaaaaaaaaaaaa1'], truncated: false, invitationReason: null,
            onToggle: (r) => calls.push(`toggle:${r}`), onSelectAll: () => calls.push('all'), onClear: () => calls.push('clear'),
            onClose: noop, onNext: () => calls.push('next'),
        });
        const boxes = findAll(tree, (el) => el.type === 'input' && el.props.type === 'checkbox');
        expect(boxes).toHaveLength(7);
        expect(boxes.map((b) => !b.props.disabled)).toEqual([true, true, true, false, false, false, false]);
        expect(boxes[0].props.checked).toBe(true);
        boxes[1].props.onChange();
        const buttons = findAll(tree, (el) => el.type === 'button');
        const byText = (t: string) => buttons.find((b) => textOf(b).startsWith(t));
        expect(textOf(byText('Select all')!)).toBe('Select all not yet emailed (2)');
        byText('Select all')!.props.onClick();
        byText('Clear')!.props.onClick();
        byText('Review email')!.props.onClick();
        expect(calls).toEqual(['toggle:ps_aaaaaaaaaaaaaaaaaaaaaaa2', 'all', 'clear', 'next']);
        expect(textOf(tree)).toContain('1 selected');
        for (const b of [...buttons, ...boxes]) expect(String(b.props.className)).toMatch(/min-h-\[44px\]|h-5 w-5/);
    });

    it('the review shows counts, the read-only facts and the canonical link', () => {
        const counts = SelectionCounts({ selected: ['ps_aaaaaaaaaaaaaaaaaaaaaaa1'], rows: ROWS });
        const lines = findAll(counts, (el) => el.type === 'p').map((p) => textOf(p));
        expect(lines).toEqual([
            '1 supporter selected · 1 ready to email',
            'Not included: 1 already emailed for this fundraiser · 1 opted out of email · 1 no email address on file · 1 no usable email address',
        ]);
        const facts = textOf(FundraiserFacts({ facts: { bundleNames: FACTS.bundleNames, deadlineLabel: FACTS.deadlineLabel, pickup: FACTS.pickup }, orderUrl: CANONICAL }));
        expect(facts).toContain('Added to every email by FreezerIQ');
        expect(facts).toContain('Little Italy');
        expect(facts).toContain('Ordering ends: Tuesday, November 19');
        expect(facts).toContain(CANONICAL);
        const tree = FundraiserFacts({ facts: null, orderUrl: CANONICAL });
        expect(findAll(tree, (el) => el.type === 'input' || el.type === 'textarea')).toHaveLength(0);
    });

    it('results are truthful and never say "delivered" as a fact', () => {
        const t = textOf(SendResultDetail({ result: { accepted: 34, failed: 1, skipped: 1, alreadySent: 0, notSent: { noLongerEligible: 0, optedOut: 0, noUsableEmail: 2, alreadyEmailed: 3 } } }));
        expect(t).toBe('1 could not be sent · 1 skipped — opted out · 3 already had this invitation · 2 skipped — no usable email address');
        const list = textOf(SupporterList({ rows: ROWS, truncated: true }));
        expect(list).not.toMatch(/deliver/i);
        expect(list).toContain('…and more');
    });

    it('the container guards double-clicks, sends only from the review step, and says what "sent" means', () => {
        const card = strip(R('components/coordinator/PreviousSupporters.tsx'));
        expect(card).toContain('if (inFlight.current || selected.length === 0) return;');
        expect(card).toContain("`Send ${selected.length} Individual Email${selected.length === 1 ? '' : 's'}`");
        expect(card.split('onClick={send}').length - 1).toBe(1);
        expect(card.indexOf("step === 'review'")).toBeLessThan(card.indexOf('onClick={send}'));
        expect(card).toContain('means our email service accepted it. We can&rsquo;t confirm it reached the inbox.');
        // 2.0A: the ONLY navigation is handing the server-built personal draft to the
        // coordinator's mail app; the card never assembles a mailto: itself.
        expect(card).not.toMatch(/['"`]mailto:/);
        expect(card.match(/window\.location/g) ?? []).toHaveLength(1);
        expect(card).toContain('window.location.href = json.mailto;');
        expect(card).toContain("fetch('/api/coordinator/previous-supporters/draft'");
        expect(card).toContain('body: JSON.stringify({ ref }),');
    });

    it('2.0A: every row with a usable address offers "Open email to {name}"; opening is never called "sent"', () => {
        const rows: SupporterRow[] = [
            { ...row('ps_cccccccccccccccccccccc01', 'ready', false), name: 'Jamie Example' },
            { ...row('ps_cccccccccccccccccccccc02', 'emailed', false), name: 'Casey Sample', automated: { eligible: false, reason: null } },
            { ...row(null, 'no_email', false), name: 'Morgan Noemail', canOpenEmail: false, automated: { eligible: false, reason: null } },
        ];
        const opened: string[] = [];
        const tree = SupporterList({ rows, truncated: false, opened: ['ps_cccccccccccccccccccccc01'], busyRef: null,
            draftFor: { ref: 'ps_cccccccccccccccccccccc01', mailto: 'mailto:jamie.example@example.test?subject=x' }, onOpenEmail: (r) => opened.push(r) });
        const buttons = findAll(tree, (el) => el.type === 'button');
        expect(buttons.map((b) => textOf(b))).toEqual(['Open email to Jamie', 'Open email to Casey']);   // a previous FreezerIQ send does not remove it
        expect(buttons.every((b) => /min-h-\[44px\]/.test(b.props.className) && b.props['aria-label'])).toBe(true);
        buttons[0].props.onClick();
        expect(opened).toEqual(['ps_cccccccccccccccccccccc01']);
        const text = textOf(tree);
        expect(text).toContain('Email draft opened on this device');
        expect(text).toContain('FreezerIQ send unavailable — future email permission not recorded');
        expect(text).not.toMatch(/\bsent\b|deliver/i);
        const retry = findAll(tree, (el) => el.type === 'a');
        expect(retry.map((a) => a.props.href)).toEqual(['mailto:jamie.example@example.test?subject=x']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. SOURCE INVARIANTS
// ═══════════════════════════════════════════════════════════════════════════
describe('7 · shipped-source invariants', () => {
    const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
    const get_ = route.slice(route.indexOf('export async function GET('), route.indexOf('export async function POST('));
    const post_ = route.slice(route.indexOf('export async function POST('));

    it('the GET can never send', () => {
        expect(get_).not.toMatch(/runSend|ResendOutreachProvider|\.send\(|getTenantSender/);
    });

    it('the POST refuses before ANY write or provider call unless confirmed and selected', () => {
        const confirmAt = post_.indexOf('PREVIOUS_SUPPORTER_SEND_CONFIRMATION');
        const selectAt = post_.indexOf('if (!selection)');
        const firstWrite = post_.indexOf('resolveCampaignBatch(prisma');
        expect(confirmAt).toBeGreaterThan(-1);
        expect(selectAt).toBeGreaterThan(-1);
        expect(confirmAt).toBeLessThan(firstWrite);
        expect(selectAt).toBeLessThan(firstWrite);
        expect(post_.indexOf('await runSend({')).toBeGreaterThan(firstWrite);
    });

    it('reuses the ONE existing provider and engine — no second email system, no CC/BCC', () => {
        for (const f of ['app/api/coordinator/previous-supporters/route.ts', 'app/api/coordinator/previous-supporters/draft/route.ts',
            'lib/previousSupporterEmail.ts', 'lib/previousSupporterInvitation.ts', 'lib/previousSupporterAuthorities.ts']) {
            const src = strip(R(f));
            expect(src).not.toMatch(/from 'resend'|new Resend\(|nodemailer|sendgrid|postmark|mailgun|@aws-sdk\/client-ses/i);
            expect(src).not.toMatch(/\bbcc\b|\bcc:/i);
        }
        expect(post_).toContain('new ResendOutreachProvider()');
        expect(strip(R('lib/outreachSend.ts'))).toContain('to: r.normalizedEmail!,');
    });

    it('the database guard the double-send proof stands on is the shipped migration', () => {
        const sql = R('prisma/migrations/20260808000000_fr_retention_outreach_delivery/migration.sql');
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "email_delivery_attempts_one_live_per_recipient"\s+ON "email_delivery_attempts" \("outreach_message_id", "outreach_recipient_id"\)\s+WHERE NOT "is_test" AND "status" <> 'failed';/);
        expect(R('prisma/schema.prisma')).toMatch(/@@unique\(\[idempotency_key\]\)/);
    });

    it('a retry key exists only for a deliberate retry; every other caller keeps its old key', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { buildIdempotencyKey } = require('../lib/outreachSend');
        expect(buildIdempotencyKey('m', 'r', 3)).toBe('m:r:g3');
        expect(buildIdempotencyKey('m', 'r', 3, 0)).toBe('m:r:g3');
        expect(buildIdempotencyKey('m', 'r', 3, 2)).toBe('m:r:g3:r2');
    });

    it('REVISED (2.0B, owner-approved schema): the ONLY schema change since Production b215aa7 is the additive mailing-address migration', () => {
        const names = execSync('git --literal-pathspecs diff --name-only b215aa74601aa614b2f91cb904eef590b437898c -- prisma/', { encoding: 'utf8', cwd: ROOT })
            .split('\n').map((l) => l.trim()).filter(Boolean).sort();
        const untracked = execSync('git --literal-pathspecs ls-files --others --exclude-standard -- prisma/', { encoding: 'utf8', cwd: ROOT })
            .split('\n').map((l) => l.trim()).filter(Boolean);
        expect([...new Set([...names, ...untracked])].sort()).toEqual([
            'prisma/migrations/20261031120000_prev_supporter_email_2b_org_mailing_address/migration.sql',
            'prisma/schema.prisma',
        ]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. PREVIOUS-SUPPORTER-EMAIL-2.0A — consent, the organization's address, two paths
// ═══════════════════════════════════════════════════════════════════════════
describe('8 · 2.0A — who FreezerIQ may email itself, and "Open in my email"', () => {
    const ALL_READY = () => [refOf(JAMIE), refOf(CASEY), refOf(ALEX)];

    it('no organization mailing address → neither path: no FreezerIQ send and no prepared draft', async () => {
        clearAddress();
        const { body } = await get();
        expect(body.automated).toEqual({ available: false, code: 'mailing_address_required',
            reason: 'Automated email unavailable — organization mailing address required.' });
        expect(body.personal).toEqual({ available: false, code: 'mailing_address_required',
            reason: 'Email draft unavailable — organization mailing address required.' });
        expect(body.supporters.some((s: SupporterRow) => s.canOpenEmail || s.ref)).toBe(false);
        expect(body.send).toMatchObject({ canSend: false, code: 'mailing_address_required' });
        expect(body.counts.consented).toBe(0);
        expect(body.supporters.some((s: SupporterRow) => s.selectable)).toBe(false);
        expect(selectAllReady(body.supporters)).toEqual([]);
        const r = await send(ALL_READY());
        expect(r.status).toBe(409);
        expect(sent).toHaveLength(0);
        expect(world.writes).toEqual([]);
    });

    it('purchase history plus a valid organization address is STILL not permission (TODAY)', async () => {
        const { body } = await get();
        expect(body.automated.code).toBe('consent_not_recorded');
        expect(body.send).toMatchObject({ canSend: false, code: 'consent_not_recorded' });
        expect(rowFor(body, 'Jamie Example')).toMatchObject({ canOpenEmail: true, selectable: false,
            automated: { eligible: false, reason: 'FreezerIQ send unavailable — future email permission not recorded' } });
        const r = await send(ALL_READY());
        expect(r.status).toBe(409);
        expect(sent).toHaveLength(0);
    });

    it('recorded consent without the organization address is blocked too', async () => {
        grantAutomated([JAMIE, CASEY, ALEX]);
        clearAddress();
        const { body } = await get();
        expect(body.automated.code).toBe('mailing_address_required');
        expect(body.supporters.some((s: SupporterRow) => s.selectable)).toBe(false);
        expect((await send(ALL_READY())).status).toBe(409);
        expect(sent).toHaveLength(0);
    });

    it('consent is per person: only the supporter who gave it can be selected and sent', async () => {
        grantAutomated([JAMIE]);
        const { body } = await get();
        expect(body.counts.consented).toBe(1);
        expect(rowFor(body, 'Jamie Example').selectable).toBe(true);
        expect(rowFor(body, 'Casey Sample')).toMatchObject({ selectable: false, canOpenEmail: true,
            automated: { eligible: false, reason: 'FreezerIQ send unavailable — future email permission not recorded' } });
        expect(selectAllReady(body.supporters)).toEqual([refOf(JAMIE)]);
        const r = await send([refOf(JAMIE), refOf(CASEY)]);          // a forged tick for Casey is refused
        expect(r.body).toMatchObject({ accepted: 1 });
        expect(r.body.notSent.noConsent).toBe(1);
        expect(sentTo(JAMIE)).toHaveLength(1);
        expect(sentTo(CASEY)).toHaveLength(0);
    });

    it('a consent record for someone outside this organization or tenant adds nobody', async () => {
        grantAutomated([JAMIE, RILEY, QUINN, QUINN_LINKED, SAM]);
        const r = await send([refOf(RILEY), refOf(QUINN), refOf(QUINN_LINKED), refOf(SAM)]);
        expect(r.body.accepted).toBe(0);
        expect(r.body.notSent.noLongerEligible).toBe(4);
        expect(sent).toHaveLength(0);
    });

    it('the authorities are asked about THIS organization in THIS tenant — never another', async () => {
        await get();
        expect((global as any).__pse2AuthCalls).toEqual([
            ['address', { businessId: BIZ_A, organizationCustomerId: ORG_A }],
            ['consent', { businessId: BIZ_A, organizationCustomerId: ORG_A }],
        ]);
        (global as any).__pse2AuthCalls = [];
        (global as any).__pse2Session = { ok: true, campaignId: B_CUR, sessionId: 'sess-b' };
        await get();
        expect((global as any).__pse2AuthCalls.every(([, s]: any) => s.businessId === BIZ_B && s.organizationCustomerId === ORG_B)).toBe(true);
    });

    it('the real authorities invent nothing — no consent backfill, and the address is the organization\'s own columns only', async () => {
        const actual = jest.requireActual('@/lib/previousSupporterAuthorities');
        expect([...(await actual.loadExplicitEmailConsent({ businessId: BIZ_A, organizationCustomerId: ORG_A }))]).toEqual([]);
        expect(await actual.loadOrganizationMailingAddress({ businessId: BIZ_A, organizationCustomerId: ORG_A })).toEqual(ORG_A_ADDRESS);
        // Tenant AND organization both in the WHERE: a wrong tenant or another organization gets nothing back.
        expect(await actual.loadOrganizationMailingAddress({ businessId: BIZ_B, organizationCustomerId: ORG_A })).toBeNull();
        expect(await actual.loadOrganizationMailingAddress({ businessId: BIZ_A, organizationCustomerId: ORG_B })).toBeNull();
        expect(await actual.loadOrganizationMailingAddress({ businessId: '', organizationCustomerId: ORG_A })).toBeNull();
        const src = strip(R('lib/previousSupporterAuthorities.ts'));
        expect(src).not.toMatch(/pickup_location|delivery_address|origin_address|fundraiser_info|storefront|\.findMany|\.findFirst|\.create|\.update|\.upsert/);
        expect(src).toMatch(/SELECT mailing_address_line1, mailing_address_line2, mailing_city, mailing_state, mailing_postal_code\s+FROM customers\s+WHERE id = \$\{scope\.organizationCustomerId\} AND business_id = \$\{scope\.businessId\}/);
        const consentFn = src.slice(src.indexOf('export async function loadExplicitEmailConsent('), src.indexOf('export type AutomatedSendCode'));
        expect(consentFn).not.toMatch(/prisma|db\.|\$queryRaw/);
        for (const f of ['app/api/coordinator/previous-supporters/route.ts', 'app/api/coordinator/previous-supporters/draft/route.ts']) {
            const code = strip(R(f));
            expect(code).not.toMatch(/marketingPreference\.(create|update|upsert)|consent.*\.(create|update|upsert)/);
            expect(code).not.toMatch(/pickup_location|delivery_address|origin_address/);
        }
        // The route takes the address ONLY from the organization authority.
        const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
        expect(route).toContain('const mailingAddress = await loadOrganizationMailingAddress(scope);');
        expect(route).toContain('const senderIdentity = { organizationName, tenantName, mailingAddress };');
    });

    it('the organization address must be complete and well-formed', () => {
        const ok = validateOrganizationMailingAddress({ line1: '742 Fixture Lane', city: 'Maple Grove', state: 'il', postalCode: '61944-1234' });
        expect(ok).toEqual({ line1: '742 Fixture Lane', line2: null, city: 'Maple Grove', state: 'IL', postalCode: '61944-1234' });
        for (const bad of [
            null, {}, { city: 'Maple Grove', state: 'IL', postalCode: '61944' },
            { line1: '742 Fixture Lane', state: 'IL', postalCode: '61944' },
            { line1: '742 Fixture Lane', city: 'Maple Grove', postalCode: '61944' },
            { line1: '742 Fixture Lane', city: 'Maple Grove', state: 'IL' },
            { line1: 'Community Hall', city: 'Maple Grove', state: 'IL', postalCode: '61944' },     // a place, not a street address
            { line1: '742 Fixture Lane', city: 'Maple Grove', state: 'Illinois', postalCode: '61944' },
            { line1: '742 Fixture Lane', city: 'Maple Grove', state: 'IL', postalCode: '6194' },
            { line1: '742 Fixture Lane', city: 'Maple Grove 2', state: 'IL', postalCode: '61944' },
        ]) expect(validateOrganizationMailingAddress(bad)).toBeNull();
        expect(describeAutomatedSend({ mailingAddress: null, consentedCount: 9 }).code).toBe('mailing_address_required');
        expect(describeAutomatedSend({ mailingAddress: ok, consentedCount: 0 }).code).toBe('consent_not_recorded');
        expect(describeAutomatedSend({ mailingAddress: ok, consentedCount: 1 })).toMatchObject({ available: true, code: 'available' });
    });

    it('From shows the ORGANIZATION on the platform\'s own verified address — never another domain', () => {
        expect(organizationFromHeader({ organizationName: ORG_A_NAME, tenantName: 'Maple Kitchen', platformFrom: 'Maple Kitchen via FreezerIQ <notifications@freezeriq.test>' }))
            .toBe(EXPECTED_FROM);
        expect(organizationFromHeader({ organizationName: 'Smith, Jones "&" <Co>', tenantName: 'My Freezer Chef', platformFrom: 'notifications@freezeriq.test' }))
            .toBe('"Smith, Jones & Co via My Freezer Chef" <notifications@freezeriq.test>');
        for (const bad of [{ platformFrom: '' }, { platformFrom: 'not an address' }, { organizationName: '' }, { tenantName: '   ' }]) {
            expect(organizationFromHeader({ organizationName: ORG_A_NAME, tenantName: 'Maple Kitchen', platformFrom: 'x@freezeriq.test', ...bad })).toBeNull();
        }
    });

    it('Reply-To: the assigned coordinator, else the organization contact, else the tenant — only a plain address', async () => {
        grantAutomated();
        world.assignments[CUR] = { org_contact: { ended_at: null, contact: { display_name: 'Robin Coordinator', contact_points: [{ value: 'robin.coord@maple-grove.example' }] } } };
        await send([refOf(JAMIE)]);
        expect(sentTo(JAMIE)[0].replyTo).toBe('robin.coord@maple-grove.example');
        expect(headerSafeReplyTo('robin.coord@maple-grove.example')).toBe('robin.coord@maple-grove.example');
        for (const bad of ['a@b.test, c@d.test', 'Robin <r@b.test>', 'r@b.test\r\nBcc: x@y.test', 'not-an-email', '', null]) {
            expect(headerSafeReplyTo(bad as any)).toBeNull();
        }
        const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
        expect(route).toContain('const coordinator = resolveCampaignCoordinator({ assignment, organization: campaign.customer });');
        expect(route).toContain('const replyTo = headerSafeReplyTo(coordinator.email) ?? tenantSender.replyTo;');
    });

    describe('"Open in my email" (the personal draft route)', () => {
        it('is available today, without consent, once the organization\'s mailing address is on file', async () => {
            for (const e of [JAMIE, CASEY, ALEX]) {
                const r = await draft(refOf(e));
                expect(r.status).toBe(200);
                expect(parseMailto(r.body.mailto).to).toBe(e);
            }
        });

        it('stays available when FreezerIQ sending is allowed too', async () => {
            grantAutomated();
            expect((await draft(refOf(JAMIE))).status).toBe(200);
        });

        it('addresses ONLY the chosen supporter, with the current fundraiser and its canonical link', async () => {
            const r = await draft(refOf(CASEY));
            const m = parseMailto(r.body.mailto);
            expect(m.to).toBe(CASEY);
            expect(m.params).toEqual(['subject', 'body']);
            expect(r.body.mailto).not.toMatch(/[?&](cc|bcc|to)=/i);
            expect(m.subject).toBe('Maple Grove Booster Club (fixture) fundraiser is back — ordering is open');
            expect(m.body.startsWith('Hi Casey,\r\n\r\nThank you again for supporting Maple Grove Booster Club (fixture)!')).toBe(true);
            for (const piece of ['• Little Italy\r\n• Harvest Table', 'Ordering ends: Tuesday, November 19',
                'Pickup:\r\nThursday, November 21\r\n4:00–6:00 PM\r\nMaple Grove Community Hall, 100 Example Ave',
                `You can view this round's meals and place your order here:\r\n${CANONICAL}`, PERSONAL_OPT_OUT_LINE,
                // 2.0B: the solicitation footer with the ORGANIZATION's mailing address.
                '--\r\nFundraiser solicitation from Maple Grove Booster Club (fixture)\r\n742 Fixture Lane\r\nSuite 3\r\nMaple Grove, IL 61944\r\n\r\n'
                    + "If you'd rather not receive future fundraiser emails from us, just reply and let us know."]) {
                expect(m.body).toContain(piece);
            }
            expect(m.body.endsWith("If you'd rather not receive future fundraiser emails from us, just reply and let us know.")).toBe(true);
            // Never the delivery dock, another organization's or tenant's address, or the pickup hall as the address.
            const footer = m.body.slice(m.body.lastIndexOf('--\r\n'));
            for (const notOurs of ['Loading Dock', '5 Warehouse Rd', '88 Cedar Ave', 'Cedarville', '9 Birch Rd', 'Birchton', 'Community Hall', '100 Example Ave', 'Kitchen']) {
                expect(footer).not.toContain(notOurs);
            }
            for (const other of [JAMIE, ALEX, TAYLOR, RILEY, 'Jamie', 'Alex', 'Taylor', 'Spring Comfort Menu', 'April 29', 'Old Gym Lobby', 'pub-previous', PREV, 'vercel.app']) {
                expect(`${m.subject}${m.body}`).not.toContain(other);
            }
            expect(r.body.mailto).toContain('%0D%0A');
            expect(r.body.mailto.length).toBeLessThan(2000);
            expect(JSON.stringify(r.body)).not.toMatch(/sent|deliver/i);
        });

        it('opening a draft sends nothing, writes nothing and never marks anyone emailed', async () => {
            await draft(refOf(JAMIE));
            expect(sent).toHaveLength(0);
            expect(world.writes).toEqual([]);
            const { body } = await get();
            expect(rowFor(body, 'Jamie Example').status).toBe('ready');
            expect(body.counts.emailedThisFundraiser).toBe(0);
        });

        it('refuses opted-out, unusable, other-organization, other-tenant, other-campaign and made-up references', async () => {
            for (const ref of [refOf(TAYLOR), refOf(PAT_ODD), refOf(RILEY), refOf(QUINN), refOf(QUINN_LINKED), refOf(SAM), refOf(JAMIE, B_CUR), 'ps_000000000000000000000000', JAMIE, null]) {
                const r = await draft(ref);
                expect(r.status).toBe(404);
                expect(JSON.stringify(r.body)).not.toMatch(/@/);
            }
        });

        it('the building block itself refuses anything but one plain address', () => {
            const facts = FACTS;
            const sender = { organizationName: ORG_A_NAME, mailingAddress: ORG_A_ADDRESS };
            for (const to of [PAT_ODD, 'a@b.test,c@d.test', 'a@b.test?cc=c@d.test', 'x@y.test\r\nbcc:z@w.test', null]) {
                expect(buildPersonalMailto({ to: to as any, greetingName: 'Jamie', subject: 's', message: 'm', facts, sender })).toBeNull();
            }
            // 2.0B: no organization name or no complete address → no draft at all.
            expect(buildPersonalMailto({ to: JAMIE, greetingName: 'Jamie', subject: 's', message: 'm', facts, sender: null })).toBeNull();
            expect(buildPersonalMailto({ to: JAMIE, greetingName: 'Jamie', subject: 's', message: 'm', facts, sender: { ...sender, organizationName: ' ' } })).toBeNull();
            expect(buildPersonalMailto({ to: JAMIE, greetingName: 'Jamie', subject: 's', message: 'm', facts, sender: { ...sender, mailingAddress: null as any } })).toBeNull();
            const m = buildPersonalMailto({ to: JAMIE, greetingName: 'Jamie', subject: 'Hi\r\nBcc: x@y.test', message: 'm', facts, sender })!;
            expect(parseMailto(m).subject).toBe('Hi Bcc: x@y.test');
            expect(parseMailto(m).params).toEqual(['subject', 'body']);
        });
    });

    it('no automated send path reaches previous supporters around the consent gate', () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                const rel = `${dir}/${e.name}`;
                if (e.isDirectory()) walk(rel);
                else if (/\.(ts|tsx)$/.test(e.name)) files.push(rel);
            }
        };
        walk('app'); walk('lib'); walk('components');
        const callers = files.filter((f) => f !== 'lib/outreachSend.ts' && /\brunSend\(|new ResendOutreachProvider\(/.test(strip(R(f))));
        expect(callers.sort()).toEqual([
            'app/api/coordinator/previous-supporters/route.ts',
            'app/api/rebooking/seasonal-lineups/[id]/send/route.ts',
        ]);
        // The seasonal lineup send mails organizations' contacts, never the previous-supporter audience.
        expect(strip(R('app/api/rebooking/seasonal-lineups/[id]/send/route.ts'))).not.toMatch(/previousSupporter|derivePreviousSupporters/);
        // The previous-supporter send consults consent and the address before any write or provider call.
        const post = strip(R('app/api/coordinator/previous-supporters/route.ts'));
        const at = (s: string) => { const i = post.indexOf(s, post.indexOf('export async function POST(')); expect(i).toBeGreaterThan(-1); return i; };
        expect(at('loadAutomatedAuthorities(ctx, audience)')).toBeLessThan(at('if (!capability.canSend)'));
        expect(at('if (!capability.canSend)')).toBeLessThan(at('resolveCampaignBatch(prisma'));
        expect(at('resolveSelection({ campaignId, refs: body?.selected, audience, history, consent })')).toBeLessThan(at('await runSend({'));
        expect(post).toContain('automated,');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. PREVIOUS-SUPPORTER-EMAIL-2.0B — the organization's mailing address
// ═══════════════════════════════════════════════════════════════════════════
describe('9 · 2.0B — the organization mailing address (CRM, migration, both email paths)', () => {
    const MAILING_URL = (id: string) => `https://www.freezeriqapp.com/api/customers/${id}/mailing-address`;
    async function mGet(id: string) {
        const res = await MAILING_GET(new Request(MAILING_URL(id)), { params: Promise.resolve({ id }) });
        return { status: res.status, body: await res.json() };
    }
    async function mPut(id: string, body: any) {
        const res = await MAILING_PUT(new Request(MAILING_URL(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
            { params: Promise.resolve({ id }) });
        return { status: res.status, body: await res.json() };
    }
    const orgRow = (id = ORG_A) => ({ ...world.customers.find((c) => c.id === id) });

    it('CRM: no tenant session → 401, and the database is never touched', async () => {
        (global as any).__pse2Auth = null;
        expect((await mGet(ORG_A)).status).toBe(401);
        expect((await mPut(ORG_A, { line1: '1 X St', city: 'Y', state: 'IL', postalCode: '60000' })).status).toBe(401);
        expect(world.rawSql).toEqual([]);
        expect(world.writes).toEqual([]);
    });

    it('CRM: reads THIS tenant\'s ORGANIZATION only — never another tenant\'s, never a direct customer', async () => {
        const r = await mGet(ORG_A);
        expect(r).toEqual({ status: 200, body: {
            mailingAddress: { line1: '742 Fixture Lane', line2: 'Suite 3', city: 'Maple Grove', state: 'IL', postalCode: '61944' }, complete: true } });
        expect(JSON.stringify(r.body)).not.toMatch(/Loading Dock|delivery/i);
        expect((await mGet(ORG_B)).status).toBe(404);                 // another tenant's organization
        expect((await mGet('cust-jamie')).status).toBe(404);          // a supporter, not an organization
        expect(world.rawSql.every((sql) => /WHERE id = \? AND business_id = \? AND type::text IN \(\?, \?\)/.test(sql))).toBe(true);
    });

    it('CRM: save, reload — persisted; delivery address and every other field untouched', async () => {
        const before = orgRow();
        const saved = await mPut(ORG_A, { line1: '  1200 New Office Rd ', line2: '', city: 'Maple Grove', state: 'il', postalCode: '61945' });
        expect(saved.status).toBe(200);
        expect(saved.body).toEqual({ mailingAddress: { line1: '1200 New Office Rd', line2: '', city: 'Maple Grove', state: 'IL', postalCode: '61945' }, complete: true });
        const reloaded = await mGet(ORG_A);
        expect(reloaded.body).toEqual(saved.body);
        const after = orgRow();
        for (const k of Object.keys(before).filter((k) => !k.startsWith('mailing_'))) expect(after[k]).toEqual(before[k]);
        expect(after.delivery_address).toBe('Loading Dock B, 5 Warehouse Rd, Maple Grove, IL 61944');
        expect(orgRow(ORG_A2).mailing_address_line1).toBe('88 Cedar Ave');
        expect(orgRow(ORG_B).mailing_address_line1).toBe('9 Birch Rd');
        // And the very next prepared draft carries the NEW address.
        const d = await draft(refOf(JAMIE));
        expect(parseMailto(d.body.mailto).body).toContain('1200 New Office Rd\r\nMaple Grove, IL 61945');
    });

    it('CRM: an incomplete or malformed address is refused and nothing is written', async () => {
        const before = orgRow();
        for (const bad of [
            { line1: 'Community Hall', city: 'Maple Grove', state: 'IL', postalCode: '61944' },
            { line1: '1 Main St', city: 'Maple Grove', state: 'Illinois', postalCode: '61944' },
            { line1: '1 Main St', city: 'Maple Grove', state: 'IL', postalCode: '' },
            { city: 'Maple Grove' },
        ]) {
            const r = await mPut(ORG_A, bad);
            expect(r.status).toBe(400);
            expect(r.body.error).toBe('Enter a complete mailing address: street address, city, two-letter state and ZIP code.');
        }
        expect(orgRow()).toEqual(before);
        expect(world.writes).toEqual([]);
    });

    it('CRM: another tenant cannot change this organization\'s address', async () => {
        (global as any).__pse2Auth = { user: { businessId: BIZ_B } };
        const before = orgRow();
        expect((await mPut(ORG_A, { line1: '1 Hijack St', city: 'Elsewhere', state: 'IN', postalCode: '47000' })).status).toBe(404);
        expect(orgRow()).toEqual(before);
    });

    it('end to end: clearing the address turns prepared drafts OFF; saving one turns them back ON — FreezerIQ stays blocked', async () => {
        expect((await mPut(ORG_A, { line1: '', line2: '', city: '', state: '', postalCode: '' })).body.complete).toBe(false);
        let view = (await get()).body;
        expect(view.personal).toEqual({ available: false, code: 'mailing_address_required', reason: 'Email draft unavailable — organization mailing address required.' });
        expect(view.supporters.some((s: SupporterRow) => s.canOpenEmail)).toBe(false);
        const off = await draft(refOf(JAMIE));
        expect(off).toEqual({ status: 409, body: { ok: false, code: 'mailing_address_required', error: 'Email draft unavailable — organization mailing address required.' } });

        await mPut(ORG_A, { line1: '742 Fixture Lane', line2: 'Suite 3', city: 'Maple Grove', state: 'IL', postalCode: '61944' });
        view = (await get()).body;
        expect(view.personal.available).toBe(true);
        expect(rowFor(view, 'Jamie Example').canOpenEmail).toBe(true);
        const on = await draft(refOf(JAMIE));
        expect(on.status).toBe(200);
        expect(parseMailto(on.body.mailto).to).toBe(JAMIE);
        // The address alone never turns on FreezerIQ's own sending.
        expect(view.automated.code).toBe('consent_not_recorded');
        expect(view.supporters.some((s: SupporterRow) => s.selectable)).toBe(false);
        expect(sent).toHaveLength(0);
    });

    it('the old "send to everyone" body — and any send — still cannot get past the consent gate', async () => {
        const legacy = await post({ subject: 'Hi', text: 'Words' });
        expect(legacy.status).toBe(409);
        expect(legacy.body.code).toBe('consent_not_recorded');
        const confirmed = await send([refOf(JAMIE), refOf(CASEY), refOf(ALEX)]);
        expect(confirmed.status).toBe(409);
        expect(sent).toHaveLength(0);
        expect(world.writes).toEqual([]);
    });

    it('only the current organization\'s address appears — never another organization\'s, another tenant\'s, the delivery dock or the pickup hall', async () => {
        grantAutomated();
        await send([refOf(JAMIE)]);
        const d = await draft(refOf(CASEY));
        const texts = [sentTo(JAMIE)[0].text, parseMailto(d.body.mailto).body.replace(/\r\n/g, '\n')];
        for (const t of texts) {
            // The organization footer starts at its own "--" line (the engine's unsubscribe block uses "---").
            const start = t.indexOf('\n--\n');
            expect(start).toBeGreaterThan(-1);
            const footer = t.slice(start);
            expect(footer).toContain('742 Fixture Lane');
            expect(footer).toContain('Maple Grove, IL 61944');
            for (const notOurs of ['88 Cedar Ave', 'Cedarville', '9 Birch Rd', 'Birchton', 'Loading Dock', '5 Warehouse Rd', 'Community Hall', '100 Example Ave']) {
                expect(footer).not.toContain(notOurs);
            }
        }
    });

    it('the CRM card: clearly labelled, explained, and separate from the delivery address', () => {
        const noop = () => { /* */ };
        const saved = { line1: '742 Fixture Lane', line2: 'Suite 3', city: 'Maple Grove', state: 'IL', postalCode: '61944' };
        const view = textOf(MailingAddressCardView({ saved, complete: true, editing: false, draft: saved, state: 'idle', error: null, onEdit: noop, onCancel: noop, onChange: noop, onSave: noop }));
        expect(view).toContain('Organization mailing address');
        expect(view).toContain('Used in fundraiser email footer information.');
        expect(view).toContain('742 Fixture Lane');
        expect(view).toContain('Maple Grove, IL 61944');
        expect(view).not.toMatch(/Loading Dock|unavailable/);
        const empty = textOf(MailingAddressCardView({ saved: null, complete: false, editing: false, draft: saved, state: 'idle', error: null, onEdit: noop, onCancel: noop, onChange: noop, onSave: noop }));
        expect(empty).toContain('Not on file');
        expect(empty).toContain('Prepared fundraiser emails stay unavailable until a complete mailing address is on file.');

        const calls: string[] = [];
        const form = MailingAddressCardView({ saved, complete: true, editing: true, draft: saved, state: 'idle', error: 'Enter a complete mailing address: street address, city, two-letter state and ZIP code.',
            onEdit: noop, onCancel: () => calls.push('cancel'), onChange: (f, v) => calls.push(`${f}=${v}`), onSave: () => calls.push('save') });
        const inputs = findAll(form, (el) => el.type === 'input');
        expect(inputs.map((i) => i.props.id)).toEqual(['org-mailing-line1', 'org-mailing-line2', 'org-mailing-city', 'org-mailing-state', 'org-mailing-postalCode']);
        expect(inputs.map((i) => i.props.autoComplete)).toEqual(['address-line1', 'address-line2', 'address-level2', 'address-level1', 'postal-code']);
        const labels = findAll(form, (el) => el.type === 'label').map((l) => [l.props.htmlFor, textOf(l)]);
        expect(labels).toEqual([['org-mailing-line1', 'Street address'], ['org-mailing-line2', 'Address line 2 (optional)'], ['org-mailing-city', 'City'],
            ['org-mailing-state', 'State'], ['org-mailing-postalCode', 'ZIP code']]);
        inputs[2].props.onChange({ target: { value: 'Oak Park' } });
        findAll(form, (el) => el.type === 'form')[0].props.onSubmit({ preventDefault() { /* */ } });
        findAll(form, (el) => el.type === 'button' && textOf(el) === 'Cancel')[0].props.onClick();
        expect(calls).toEqual(['city=Oak Park', 'save', 'cancel']);
        expect(textOf(findAll(form, (el) => el.props?.role === 'alert')[0])).toContain('Enter a complete mailing address');
        for (const b of findAll(form, (el) => el.type === 'button' || el.type === 'input')) expect(String(b.props.className)).toMatch(/min-h-\[44px\]/);
    });

    it('the CRM card lives in Organization Details, for organizations, and saves only through its own route', () => {
        const section = R('components/crm2/orgDashboard/OrganizationDetailsSection.tsx');
        expect(section).toContain('{isOrganization && <OrganizationMailingAddressCard organizationId={customer.id} />}');
        const card = strip(R('components/crm2/orgDashboard/OrganizationMailingAddressCard.tsx'));
        expect(card.match(/fetch\(`\/api\/customers\/\$\{encodeURIComponent\(organizationId\)\}\/mailing-address`/g) ?? []).toHaveLength(2);
        expect(card).toContain("method: 'PUT'");
        expect(card).not.toMatch(/delivery_address|pickup_location/);
        const route = strip(R('app/api/customers/[id]/mailing-address/route.ts'));
        expect(route).not.toMatch(/delivery_address|pickup_location|origin_address|prisma\.customer\.(update|upsert)/);
        const update = route.slice(route.indexOf('UPDATE customers'), route.indexOf('WHERE id', route.indexOf('UPDATE customers')));
        expect([...update.matchAll(/(\w+) = \$\{/g)].map((m) => m[1])).toEqual(['mailing_address_line1', 'mailing_address_line2', 'mailing_city', 'mailing_state', 'mailing_postal_code']);
        expect(route).toContain("if (!session?.user?.businessId) {");
    });

    it('migration: one additive step — five nullable TEXT columns on customers, applied after every earlier migration', () => {
        const dir = '20261031120000_prev_supporter_email_2b_org_mailing_address';
        const all = fs.readdirSync(path.join(ROOT, 'prisma', 'migrations'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
        expect(all[all.length - 1]).toBe(dir);
        const sql = R(`prisma/migrations/${dir}/migration.sql`);
        const statements = sql.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
        expect(statements).toEqual(['mailing_address_line1', 'mailing_address_line2', 'mailing_city', 'mailing_state', 'mailing_postal_code']
            .map((c) => `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "${c}" TEXT;`));
        expect(statements.join('\n')).not.toMatch(/DROP|ALTER COLUMN|RENAME|UPDATE|DELETE|INSERT|NOT NULL|DEFAULT|delivery_address/i);
        const schema = R('prisma/schema.prisma');
        const customer = schema.slice(schema.indexOf('model Customer {'), schema.indexOf('\n}', schema.indexOf('model Customer {')));
        for (const c of ['mailing_address_line1', 'mailing_address_line2', 'mailing_city', 'mailing_state', 'mailing_postal_code']) {
            expect(customer).toMatch(new RegExp(`\\n\\s+${c}\\s+String\\?\\n`));
        }
        expect(customer).toMatch(/\n\s+delivery_address String\?\n/);
    });

    it('nothing in this release touches order, payment, tax, closeout, release or QuickBooks code', () => {
        const guarded = ['app/api/public/order', 'app/api/orders', 'app/api/checkout', 'app/api/coordinator/route.ts', 'app/api/campaigns',
            'app/api/tenant/invoices', 'app/api/integrations/quickbooks', 'lib/quickbooks', 'lib/fundraiserTax.ts', 'lib/pricing.ts',
            'lib/fundraiserCloseoutMath.ts', 'lib/invoiceSettlementTransition.ts', 'lib/orderStatus.ts', 'lib/supporterPayment.ts', 'lib/delivery'];
        const changed = execSync(`git --literal-pathspecs diff --name-only b215aa74601aa614b2f91cb904eef590b437898c -- ${guarded.join(' ')}`, { encoding: 'utf8', cwd: ROOT });
        const untracked = execSync(`git --literal-pathspecs ls-files --others --exclude-standard -- ${guarded.join(' ')}`, { encoding: 'utf8', cwd: ROOT });
        expect(`${changed}${untracked}`.trim()).toBe('');
    });
});