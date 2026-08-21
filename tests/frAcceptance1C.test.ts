/**
 * FR-ACCEPTANCE-1C — the truth and reliability corrections found by walking
 * FR-ACCEPTANCE-1 through Production.
 *
 * Six defects, all of the same family: the product said something had happened
 * when it had not. A date confirmation claimed a reply. A dialog claimed a CRM
 * record it never checked. A simulated email advanced a real pipeline. A stock
 * template introduced one specific company under every tenant's name and
 * committed them all to its terms. A duplicate address filed one person's
 * inquiry under another person's record. And a harmless write collision threw
 * away a fundraiser lead that had already been written.
 *
 * Where these can be proven by RUNNING the code, they are. The React dialogs
 * cannot be — this repo has no jsdom and Jest matches only *.test.ts — so those
 * are asserted over source text, and each such block says so.
 */

import fs from 'fs';
import path from 'path';
import { createPrismaMock } from './helpers/routeHarness';
import { ensureInquiryOrganizationContact, namesMatch } from '@/lib/inquiryContact';
import { EMAIL_TEMPLATES } from '@/lib/emailTemplates';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const BIZ = 'biz-1';
const ORG = 'org-1';
const tx = (overrides: Record<string, any> = {}) => createPrismaMock({ results: overrides });

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 1 — confirming a date is not a reply
// Behavioural coverage drives the real PATCH handler in
// frFunnel1OpportunityApi.test.ts; this pins the source so it cannot creep back.
// ═══════════════════════════════════════════════════════════════════════════

describe('confirming a date does not fabricate a reply', () => {
    const code = stripComments(read('app/api/opportunities/[id]/route.ts'));

    it('first_response_at is written by exactly ONE action', () => {
        expect(code.match(/data\.first_response_at\s*=/g) || []).toHaveLength(1);
    });

    it('the surviving write is inside mark_responded, not confirm_date', () => {
        const marked = code.indexOf("case 'mark_responded'");
        const confirm = code.indexOf("case 'confirm_date'");
        const write = code.indexOf('data.first_response_at =');
        expect(marked).toBeGreaterThan(-1);
        expect(confirm).toBeGreaterThan(marked);
        expect(write).toBeGreaterThan(marked);
        expect(write).toBeLessThan(confirm);
    });

    it('confirm_date still sets what launch eligibility depends on', () => {
        const branch = code.slice(code.indexOf("case 'confirm_date'"), code.indexOf("case 'mark_lost'"));
        expect(branch).toMatch(/data\.confirmed_delivery_date = confirmed;/);
        expect(branch).toMatch(/data\.status = 'date_confirmed';/);
        expect(branch).not.toMatch(/first_response_at/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 2 — the dialog may not claim a CRM record it has not confirmed
// SOURCE-TEXT: React components are not executable in this repo's Jest setup.
// ═══════════════════════════════════════════════════════════════════════════

describe('the response dialog only claims what it has confirmed', () => {
    const dialog = read('components/crm2/RespondToInquiryDialog.tsx');
    const leads = read('components/crm2/FunnelLeadsPanel.tsx');
    const sendFn = dialog.slice(dialog.indexOf('const send ='), dialog.indexOf('}, [sending'));

    it('the record step is AWAITED, not fire-and-forget', () => {
        expect(sendFn).toMatch(/await onResponded\(\)/);
    });

    it('the callback can actually report failure', () => {
        expect(dialog).toMatch(/onResponded: \(\) => Promise<boolean>/);
    });

    it('a throw from the record step is not reported as a failed SEND', () => {
        // Without the catch it lands in the outer handler and toasts
        // "We couldn't send that email" about an email that did send.
        expect(sendFn).toMatch(/await onResponded\(\)\.catch\(\(\) => false\)/);
    });

    it('SEND OK + RECORD OK is the only path to the responded screen', () => {
        expect(sendFn).toMatch(/setRecordFailed\(!recorded\)/);
        expect(dialog).toMatch(/Your response was sent and this lead is now marked as responded\./);
    });

    it('SEND OK + RECORD FAIL leads with the irreversible fact and forbids resending', () => {
        expect(dialog).toMatch(/Sent, but not recorded/);
        expect(dialog).toMatch(/send it again/);
        expect(dialog).toMatch(/still shows as awaiting a reply/);
    });

    it('the recovery retries the RECORD only — never the send', () => {
        const retry = dialog.slice(dialog.indexOf('const retryRecord'), dialog.indexOf('return ('));
        expect(retry).toMatch(/onResponded\(\)/);
        expect(retry).not.toMatch(/fetch\(/);
        expect(retry).not.toMatch(/email\/send/);
    });

    it('the in-flight screen claims the send but not the record', () => {
        const inflight = dialog.slice(dialog.indexOf(') : recording ? ('), dialog.indexOf(') : recordFailed ? ('));
        expect(inflight).toMatch(/Recording it in your CRM/);
        expect(inflight).not.toMatch(/marked as responded/);
    });

    it('the panel reports whether the write landed', () => {
        const mutate = leads.slice(leads.indexOf('const mutate ='), leads.indexOf('if (loading)'));
        expect(mutate).toMatch(/Promise<boolean>/);
        expect(mutate).toMatch(/return true;/);
        expect(mutate).toMatch(/return false;/);
    });

    it('a refresh triggered by a save no longer unmounts the open dialog', () => {
        // load() sets `loading`, and the early return swaps the panel for a
        // spinner — which is why the dialog could never hear its own answer.
        expect(leads).toMatch(/const load = useCallback\(\(silent = false\)/);
        expect(leads).toMatch(/if \(!silent\) setLoading\(true\)/);
        const mutate = leads.slice(leads.indexOf('const mutate ='), leads.indexOf('if (loading)'));
        expect(mutate).toMatch(/load\(true\)/);
    });

    it('the retry button still shows its spinner (load is not wired to the event)', () => {
        expect(leads).toMatch(/onClick=\{\(\) => load\(\)\}/);
        expect(leads).not.toMatch(/onClick=\{load\}/);
    });

    it('MOCKED still records nothing — the earlier gate is intact', () => {
        const mockedIdx = sendFn.indexOf('if (data?.mocked)');
        expect(mockedIdx).toBeGreaterThan(-1);
        expect(mockedIdx).toBeLessThan(sendFn.indexOf('onResponded()'));
        const block = sendFn.slice(mockedIdx, sendFn.indexOf('}', sendFn.indexOf('return;', mockedIdx)) + 1);
        expect(block).not.toMatch(/onResponded/);
    });

    it('guard order is failure, then simulated, then send-success, then record', () => {
        const fail = sendFn.indexOf('if (!res.ok)');
        const mocked = sendFn.indexOf('if (data?.mocked)');
        const sentIdx = sendFn.indexOf('setSent(true)');
        const rec = sendFn.indexOf('onResponded()');
        expect(fail).toBeLessThan(mocked);
        expect(mocked).toBeLessThan(sentIdx);
        expect(sentIdx).toBeLessThan(rec);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 3 — the intro email belongs to the tenant sending it  (EXECUTED)
// ═══════════════════════════════════════════════════════════════════════════

describe('the lead intro email is the sending tenant', () => {
    const TENANT = {
        name: 'Prairie Table Meals',
        email: 'hello@prairietable.test',
        site: 'https://x.test/shop/prairie',
    };
    const render = (tenant?: any) => EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', tenant);

    it('carries no hardcoded Freezer Chef identity', () => {
        const { subject, html } = render(TENANT);
        expect(html).not.toMatch(/Freezer Chef/i);
        expect(subject).not.toMatch(/Freezer Chef/i);
        expect(html).not.toMatch(/MyFreezerChef/i);
    });

    it('carries no hardcoded personal identity', () => {
        expect(render(TENANT).html).not.toMatch(/Laurie/i);
    });

    it('promises no percentage at all', () => {
        const { html } = render(TENANT);
        expect(html).not.toMatch(/\d+\s*%/);
        expect(html).not.toMatch(/20%/);
    });

    it('signs with the tenant that is actually sending', () => {
        const { html } = render(TENANT);
        expect(html).toContain('Prairie Table Meals');
        expect(html).toContain('hello@prairietable.test');
        expect(html).toContain('https://x.test/shop/prairie');
    });

    it('names the inquiring organization', () => {
        const { html, subject } = render(TENANT);
        expect(html).toContain('Oak Ridge PTO');
        expect(subject).toContain('Oak Ridge PTO');
    });

    it('asks for a preferred date AND a backup', () => {
        const { html } = render(TENANT);
        expect(html).toMatch(/preferred date/i);
        expect(html).toMatch(/backup date/i);
    });

    it('a tenant that has configured only a name still gets a clean signature', () => {
        const { html } = render({ name: 'Solo Kitchen' });
        expect(html).toContain('Solo Kitchen');
        expect(html).not.toMatch(/mailto:/);
        expect(html).not.toMatch(/undefined/);
        expect(html).not.toMatch(/Freezer Chef/i);
    });

    it('renders safely with NO tenant at all rather than leaking a default', () => {
        const { html } = render(undefined);
        expect(html).not.toMatch(/undefined/);
        expect(html).not.toMatch(/Freezer Chef/i);
        expect(html).not.toMatch(/Laurie/i);
    });

    it('escapes tenant and organization text instead of injecting markup', () => {
        const { html } = EMAIL_TEMPLATES.lead_intro(
            '<script>alert(1)</script>',
            'Ben & Jerry <b>PTO</b>',
            { name: 'A <img src=x> Co' }
        );
        expect(html).not.toMatch(/<script>/);
        expect(html).not.toMatch(/<img src=x>/);
        expect(html).toContain('&amp;');
    });

    it('the thank-you template is tenant-safe too', () => {
        const { html } = EMAIL_TEMPLATES.thank_you('Dana', 'Oak Ridge PTO', TENANT);
        expect(html).toContain('Prairie Table Meals');
        expect(html).not.toMatch(/MyFreezerChef/i);
    });

    it('the route resolves the tenant from Business, never TenantBranding', () => {
        // TenantBranding.business_name DEFAULTS to the literal "Freezer Chef",
        // so an unconfigured tenant would sign as a competitor.
        const route = stripComments(read('app/api/email/send/route.ts'));
        expect(route).toMatch(/prisma\.business\.findUnique/);
        expect(route).toMatch(/select: \{ name: true, contact_email: true, slug: true \}/);
        expect(route).not.toMatch(/tenantBranding/i);
    });

    it('the dialog no longer lists a share among the email contents', () => {
        // The old blurb promised the email explained "how the fundraiser works,
        // what the organization keeps, and an invitation to pick a date". The
        // middle clause is now false, so it had to go — the replacement says
        // plainly that the share is settled later.
        const dialog = read('components/crm2/RespondToInquiryDialog.tsx');
        expect(dialog).not.toMatch(/how the fundraiser works, what the/);
        expect(dialog).toMatch(/quotes no percentage/);
        expect(dialog).toMatch(/settled when you confirm the date/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 4 — a duplicate address must not pick a person at random  (EXECUTED)
// ═══════════════════════════════════════════════════════════════════════════

describe('duplicate email addresses do not choose a person arbitrarily', () => {
    const submit = (m: any, over: Record<string, unknown> = {}) =>
        ensureInquiryOrganizationContact(m.client, {
            businessId: BIZ, customerId: ORG, name: 'Lindsey Vogt',
            email: 'lindsey@fairpoint.test', ...over,
        });

    /** First findMany = org-scoped, second = tenant-wide. */
    const staged = (orgScoped: any[], tenantWide: any[]) => {
        let call = 0;
        return tx({
            'fundraiserContactPoint.findMany': () => (++call === 1 ? orgScoped : tenantWide),
        });
    };

    it('reuses the person already attached to THIS organization', async () => {
        const m = staged([{ contact_id: 'org-person' }], []);
        const r = await submit(m);
        expect(r.contactId).toBe('org-person');
        expect(r.createdContact).toBe(false);
        expect(m.callsTo('fundraiserContact.create')).toHaveLength(0);
    });

    it('THREE people on one address, none attached here → creates rather than guessing', async () => {
        const m = staged([], [
            { contact_id: 'c-a', contact: { id: 'c-a', display_name: 'Lindsey Vogt' } },
            { contact_id: 'c-b', contact: { id: 'c-b', display_name: 'Lindsey Vogt' } },
            { contact_id: 'c-c', contact: { id: 'c-c', display_name: 'Lindsey Vogt' } },
        ]);
        const r = await submit(m);
        expect(r.createdContact).toBe(true);
        expect(['c-a', 'c-b', 'c-c']).not.toContain(r.contactId);
        const created = m.firstCall('fundraiserContact.create')!.args.data;
        expect(created.needs_review).toBe(true);
        expect(created.review_reason).toMatch(/IDENTITY REVIEW/);
        expect(created.review_reason).toMatch(/3 contacts/);
    });

    it('a SHARED INBOX with a different name is not filed as the person on file', async () => {
        const m = staged([], [
            { contact_id: 'karen', contact: { id: 'karen', display_name: 'Karen Seuring' } },
        ]);
        const r = await submit(m, { name: 'Marcus Webb' });
        expect(r.contactId).not.toBe('karen');
        expect(r.createdContact).toBe(true);
        expect(m.firstCall('fundraiserContact.create')!.args.data.needs_review).toBe(true);
    });

    it('one tenant-wide match with the SAME name is reused, and not flagged', async () => {
        const m = staged([], [
            { contact_id: 'same', contact: { id: 'same', display_name: 'Lindsey  VOGT' } },
        ]);
        const r = await submit(m);
        expect(r.contactId).toBe('same');
        expect(r.createdContact).toBe(false);
    });

    it('several candidates but exactly ONE name match resolves to that person', async () => {
        const m = staged([], [
            { contact_id: 'x', contact: { id: 'x', display_name: 'Karen Seuring' } },
            { contact_id: 'y', contact: { id: 'y', display_name: 'Lindsey Vogt' } },
        ]);
        const r = await submit(m);
        expect(r.contactId).toBe('y');
        expect(r.createdContact).toBe(false);
    });

    it('a brand-new address creates a plain contact with no review flag', async () => {
        const m = staged([], []);
        const r = await submit(m, { email: 'nobody@new.test' });
        expect(r.createdContact).toBe(true);
        const created = m.firstCall('fundraiserContact.create')!.args.data;
        expect(created.needs_review).toBeUndefined();
        expect(created.review_reason).toBeUndefined();
    });

    it('never merges two people and never rewrites an existing contact', async () => {
        const m = staged([], [
            { contact_id: 'p1', contact: { id: 'p1', display_name: 'Ann One' } },
            { contact_id: 'p2', contact: { id: 'p2', display_name: 'Ann One' } },
        ]);
        await submit(m, { name: 'Ann One' });
        expect(m.callsTo('fundraiserContact.update')).toHaveLength(0);
        expect(m.callsTo('fundraiserContact.updateMany')).toHaveLength(0);
    });

    it('every lookup stays inside this tenant AND this organization', async () => {
        const m = staged([], []);
        await submit(m);
        for (const c of m.callsTo('fundraiserContactPoint.findMany')) {
            expect(c.args.where.business_id).toBe(BIZ);
        }
        const orgScoped = m.callsTo('fundraiserContactPoint.findMany')[0];
        expect(orgScoped.args.where.contact.org_contacts.some).toMatchObject({
            customer_id: ORG, ended_at: null,
        });
        const rel = m.firstCall('fundraiserOrganizationContact.findFirst')!.args.where;
        expect(rel).toMatchObject({ business_id: BIZ, customer_id: ORG, ended_at: null });
    });

    it('every candidate query is deterministically ordered', async () => {
        const m = staged([], []);
        await submit(m);
        const calls = m.callsTo('fundraiserContactPoint.findMany');
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) {
            expect(c.args.orderBy).toEqual({ contact_id: 'asc' });
        }
    });

    it('the name guard is conservative on purpose', () => {
        expect(namesMatch('Lindsey Vogt', 'lindsey  vogt')).toBe(true);
        expect(namesMatch(' Ann One ', 'Ann One')).toBe(true);
        expect(namesMatch('Ann One', 'Ann Two')).toBe(false);
        expect(namesMatch('A. One', 'Ann One')).toBe(false);   // no initials guessing
        expect(namesMatch('', 'Ann One')).toBe(false);
        expect(namesMatch(null, null)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 5 — a contact collision is not the opportunity race
// ═══════════════════════════════════════════════════════════════════════════

describe('unique violations are classified by the constraint that actually fired', () => {
    const code = stripComments(read('app/api/public/fundraiser-request/route.ts'));

    it('the three address-book indexes are named explicitly', () => {
        expect(code).toMatch(/constraintKey\(\['contact_id', 'type', 'normalized_value'\]\)/);
        expect(code).toMatch(/constraintKey\(\['contact_id', 'type'\]\)/);
        expect(code).toMatch(/constraintKey\(\['contact_id', 'customer_id'\]\)/);
    });

    it('the opportunity race is named separately', () => {
        expect(code).toMatch(/OPEN_OPPORTUNITY_TARGET = constraintKey\(\['business_id', 'customer_id'\]\)/);
    });

    it('an UNRECOGNISED constraint is no longer retried as the opportunity race', () => {
        expect(code).toMatch(/if \(!isOpenOpportunityViolation\(txErr\) && !isAddressBookViolation\(txErr\)\)/);
        const guard = code.slice(code.indexOf('if (!isOpenOpportunityViolation'));
        expect(guard.slice(0, 500)).toMatch(/throw txErr;/);
    });

    it('the address-book writes sit behind a SAVEPOINT', () => {
        expect(code).toMatch(/SAVEPOINT fr_address_book/);
        expect(code).toMatch(/ROLLBACK TO SAVEPOINT fr_address_book/);
        expect(code).toMatch(/RELEASE SAVEPOINT fr_address_book/);
    });

    it('the savepoint wraps ONLY the contact work, so the lead survives it', () => {
        const sp = code.indexOf('SAVEPOINT fr_address_book');
        const call = code.indexOf('ensureInquiryOrganizationContact(tx, {');
        const ret = code.indexOf('return { customerId, opportunityId, inquiryId');
        expect(sp).toBeGreaterThan(-1);
        expect(sp).toBeLessThan(call);
        expect(call).toBeLessThan(ret);
    });

    it('only the three known address-book targets are swallowed', () => {
        expect(code).toMatch(
            /if \(!isUniqueViolation\(contactErr\) \|\| !isAddressBookViolation\(contactErr\)\) throw contactErr;/
        );
    });

    it('every swallowed attempt is logged — it used to be silent', () => {
        expect(code).toMatch(/\[FUNDRAISER_REQUEST\][\s\S]{0,240}lost a race/);
    });

    // The classification key is pure set logic, so check it actually separates
    // the five indexes reachable inside this transaction.
    const key = (cols: string[]) => [...cols].sort().join(',');

    it('the sorted column key distinguishes every reachable index', () => {
        const keys = [
            key(['business_id', 'submission_key']),          // inquiry replay
            key(['business_id', 'customer_id']),             // open opportunity
            key(['contact_id', 'type', 'normalized_value']), // one_current_value
            key(['contact_id', 'type']),                     // one_primary_current
            key(['contact_id', 'customer_id']),              // one_active
        ];
        expect(new Set(keys).size).toBe(5);
    });

    it('column order from Postgres does not change the classification', () => {
        expect(key(['customer_id', 'business_id'])).toBe(key(['business_id', 'customer_id']));
        expect(key(['normalized_value', 'contact_id', 'type']))
            .toBe(key(['contact_id', 'type', 'normalized_value']));
    });

    it('an empty target cannot be mistaken for a known constraint', () => {
        const known = new Set([
            key(['business_id', 'customer_id']),
            key(['contact_id', 'type', 'normalized_value']),
            key(['contact_id', 'type']),
            key(['contact_id', 'customer_id']),
        ]);
        expect(known.has(key([]))).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 5 (second half) — the savepoint must RECONCILE, not just survive
//
// Saving the lead is not the requirement. The requirement is that the
// organization ends up with a contact Launch Fundraiser can offer. The
// relationship is written LAST, so a collision on a contact-point index rolls
// back past a relationship that was never reached — the lead lives and the
// organization has nobody. These prove the second pass closes that.
// ═══════════════════════════════════════════════════════════════════════════

describe('a recoverable contact race still leaves the organization a usable contact', () => {
    const P2002 = (target: string[]) =>
        Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            clientVersion: '5.22.0',
            meta: { target },
            name: 'PrismaClientKnownRequestError',
        });

    const input = {
        businessId: BIZ, customerId: ORG,
        name: 'Dana Reed', email: 'dana@shared.test', phone: '555-0100',
    };

    it('END-TO-END: pass 1 loses on the contact-point index, pass 2 reconciles', async () => {
        // A single evolving mock, driven twice exactly as the route drives it.
        // Pass 1: nobody on file, so it tries to CREATE the point — and loses.
        // Pass 2: after ROLLBACK TO SAVEPOINT, READ COMMITTED shows the winner.
        let pass = 0;
        let pointCreateAttempts = 0;
        const m = createPrismaMock({
            results: {
                'fundraiserContactPoint.findMany': () =>
                    pass === 1
                        ? []                                   // pass 1: nothing anywhere
                        : [{                                   // pass 2: the winner is visible
                            contact_id: 'winner',
                            contact: { id: 'winner', display_name: 'Dana Reed' },
                        }],
                'fundraiserContactPoint.findFirst': () =>
                    pass === 1 ? null : { id: 'winner-point' }, // pass 2: the point exists
                'fundraiserContactPoint.create': () => {
                    pointCreateAttempts++;
                    throw P2002(['contact_id', 'type', 'normalized_value']);
                },
                'fundraiserOrganizationContact.findFirst': null, // winner never attached here
            },
        });

        // PASS 1 — the losing attempt.
        pass = 1;
        let firstErr: any = null;
        try {
            await ensureInquiryOrganizationContact(m.client, input);
        } catch (e) { firstErr = e; }

        expect(firstErr).not.toBeNull();
        expect(firstErr.code).toBe('P2002');
        expect(pointCreateAttempts).toBe(1);
        // THE DEFECT, made visible: pass 1 never reached the relationship.
        expect(m.callsTo('fundraiserOrganizationContact.create')).toHaveLength(0);

        // PASS 2 — post-rollback, the winner's rows are now visible.
        pass = 2;
        const r = await ensureInquiryOrganizationContact(m.client, input);

        // Reconciled onto the winner rather than duplicating them...
        expect(r.contactId).toBe('winner');
        expect(r.createdContact).toBe(false);
        // ...no second contact-point create was attempted (it already exists)...
        expect(pointCreateAttempts).toBe(1);
        // ...and THIS is the outcome that matters: the organization now has one.
        expect(r.createdRelationship).toBe(true);
        const rel = m.firstCall('fundraiserOrganizationContact.create')!.args.data;
        expect(rel.customer_id).toBe(ORG);
        expect(rel.business_id).toBe(BIZ);
        expect(rel.contact_id).toBe('winner');
        expect(rel.role).toBe('relationship_contact');
    });

    it('when the winner ALSO made the relationship, pass 2 finds it and does not duplicate', async () => {
        // The one_active collision. Here the required durable row provably
        // already exists, which is the other acceptable outcome.
        const m = createPrismaMock({
            results: {
                'fundraiserContactPoint.findMany': [{ contact_id: 'winner' }],
                'fundraiserContactPoint.findFirst': { id: 'winner-point' },
                'fundraiserOrganizationContact.findFirst': { id: 'winner-rel' },
            },
        });
        const r = await ensureInquiryOrganizationContact(m.client, input);
        expect(r.contactId).toBe('winner');
        expect(r.createdRelationship).toBe(false);
        expect(m.callsTo('fundraiserOrganizationContact.create')).toHaveLength(0);
        // Non-vacuous: the relationship the organization needs was actually
        // looked for, scoped correctly, and found.
        const where = m.firstCall('fundraiserOrganizationContact.findFirst')!.args.where;
        expect(where).toMatchObject({ business_id: BIZ, customer_id: ORG, ended_at: null });
    });

    it('reconciliation never attaches the contact to another organization', async () => {
        const m = createPrismaMock({
            results: {
                'fundraiserContactPoint.findMany': [{ contact_id: 'winner' }],
                'fundraiserContactPoint.findFirst': { id: 'p' },
                'fundraiserOrganizationContact.findFirst': null,
            },
        });
        await ensureInquiryOrganizationContact(m.client, input);
        for (const c of m.callsTo('fundraiserOrganizationContact.create')) {
            expect(c.args.data.customer_id).toBe(ORG);
            expect(c.args.data.business_id).toBe(BIZ);
        }
    });

    it('the route gives the address book a SECOND pass, not one', () => {
        const intakeCode = stripComments(read('app/api/public/fundraiser-request/route.ts'));
        expect(intakeCode).toMatch(/for \(let contactTry = 0; contactTry < 2 && !addressBookOk; contactTry\+\+\)/);
        // The retry must sit AFTER the rollback, or it would re-read the same
        // aborted snapshot and fail identically.
        const loop = intakeCode.slice(intakeCode.indexOf('let addressBookOk'));
        expect(loop.indexOf('ROLLBACK TO SAVEPOINT'))
            .toBeLessThan(loop.indexOf('if (!addressBookOk)'));
        expect(loop).toMatch(/addressBookOk = true;/);
    });

    it('a second defeat is reported as a missing contact, not silence', () => {
        const intakeCode = stripComments(read('app/api/public/fundraiser-request/route.ts'));
        const tail = intakeCode.slice(intakeCode.indexOf('if (!addressBookOk)'));
        expect(tail).toMatch(/console\.error/);
        expect(tail).toMatch(/KEPT/);
        expect(tail).toMatch(/no contact from this inquiry/);
    });

    it('the reconciliation depends on READ COMMITTED — the tx must not pin a snapshot', () => {
        // A SERIALIZABLE or REPEATABLE READ transaction takes its snapshot once,
        // so the second pass would see the same pre-race state and fail again.
        // This is the FR-FLOW-3 lesson, in a different place.
        const intakeCode = stripComments(read('app/api/public/fundraiser-request/route.ts'));
        expect(intakeCode).not.toMatch(/isolationLevel:\s*'Serializable'/);
        expect(intakeCode).not.toMatch(/isolationLevel:\s*'RepeatableRead'/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 6 — a simulated email advances nothing
// ═══════════════════════════════════════════════════════════════════════════

describe('safety mode advances no workflow anywhere', () => {
    const route = stripComments(read('app/api/email/send/route.ts'));

    it('the server records NOTHING on the mocked path', () => {
        const branch = route.slice(route.indexOf('if (!isLive)'), route.indexOf('const sender'));
        expect(branch).toMatch(/return NextResponse\.json\(\{ success: true, mocked: true \}\)/);
        expect(branch).not.toMatch(/progressStatus/);
        expect(branch).not.toMatch(/\.update\(/);
    });

    it('progress is advanced ONLY after a real provider send', () => {
        // A real send may still move the pipeline — that is the existing
        // contract and it is honest. The requirement is that every
        // progressStatus call sits AFTER the mocked branch has returned.
        const mockedReturn = route.indexOf('return NextResponse.json({ success: true, mocked: true })');
        expect(mockedReturn).toBeGreaterThan(-1);
        const calls = [...route.matchAll(/progressStatus\(/g)].map((m) => m.index as number);
        expect(calls.length).toBeGreaterThan(0);
        for (const i of calls) expect(i).toBeGreaterThan(mockedReturn);
    });

    it('the live progress block sits after the provider call and its error check', () => {
        const live = route.slice(route.indexOf('const sender'));
        expect(live).toMatch(/if \(customerId && context && verifiedCustomer\)/);
        // It runs only once the provider has been called AND reported no error.
        expect(live.indexOf('resend.emails.send')).toBeLessThan(live.indexOf('progressStatus('));
        expect(live.indexOf('data.error')).toBeLessThan(live.indexOf('progressStatus('));
    });

    for (const [label, file] of [
        ['CustomerOverview', 'components/crm/CustomerOverview.tsx'],
        ['FundraiserOverview', 'components/crm/FundraiserOverview.tsx'],
    ] as const) {
        describe(label, () => {
            const src = read(file);
            const at = src.indexOf('const handleSendEmail');
            const fn = src.slice(at, at + 3000);

            it('checks mocked before it advances anything', () => {
                const mocked = fn.indexOf('if (data.mocked)');
                expect(mocked).toBeGreaterThan(-1);
                expect(mocked).toBeLessThan(fn.indexOf("setStatus('SEND_INFO')"));
            });

            it('returns before the status chain and before the campaign PATCH', () => {
                const block = fn.slice(
                    fn.indexOf('if (data.mocked)'),
                    fn.indexOf('alert("Email Sent Successfully!")')
                );
                expect(block).toMatch(/return;/);
                expect(block).not.toMatch(/setStatus\(/);
                expect(block).not.toMatch(/handleCampaignStatusUpdate/);
            });

            it('tells the tenant nothing was sent and nothing moved', () => {
                expect(fn).toMatch(/No email was sent/);
                expect(fn).toMatch(/has not moved forward/);
            });

            it('no longer blames a missing API key for a switched-off environment', () => {
                expect(src).not.toMatch(/Email Simulated \(No API Key\)/);
            });
        });
    }

    it('the other callers cannot trigger a server-side progress write', () => {
        // The write required customerId AND context together. These send one or
        // neither, so they were never affected — recorded so that a future change
        // adding the missing field is caught here.
        for (const f of [
            'components/crm2/StartFundraiserWizard.tsx',
            'components/OrdersTable.tsx',
            'app/customers/page.tsx',
            'app/invoices/page.tsx',
        ]) {
            const src = read(f);
            const at = src.indexOf("fetch('/api/email/send'");
            expect(at).toBeGreaterThan(-1);
            const call = src.slice(at, at + 700);
            expect(call.includes('customerId') && call.includes('context:')).toBe(false);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// No schema change
// ═══════════════════════════════════════════════════════════════════════════

describe('FR-ACCEPTANCE-1C needs no schema change', () => {
    it('the migration ledger is untouched at 13', () => {
        const migrations = fs.readdirSync(path.join(ROOT, 'prisma/migrations'))
            .filter((d) => /^\d{14}_/.test(d));
        expect(migrations).toHaveLength(13);
        expect(migrations[migrations.length - 1]).toBe('20260821000000_fr_flow_3_campaign_delivery_time');
    });

    it('the review columns it relies on already exist', () => {
        const schema = read('prisma/schema.prisma');
        const model = schema.slice(
            schema.indexOf('model FundraiserContact '),
            schema.indexOf('model FundraiserContactPoint')
        );
        expect(model).toMatch(/needs_review\s+Boolean/);
        expect(model).toMatch(/review_reason\s+String\?/);
    });
});
