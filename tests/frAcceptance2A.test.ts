/**
 * FR-ACCEPTANCE-2A — communication, tenant brand authority, coordinator handoff.
 *
 * The owner walked a real fundraiser end to end in Production and found that the
 * product was speaking in the wrong voice: a generic page promising a fixed 20%
 * that is now per-campaign, an autoresponder signed with the internal business
 * name and linking to a platform URL instead of the tenant's own domain, and a
 * coordinator handoff that ended with "copy this link and send it yourself".
 *
 * Where these can be proven by RUNNING the code — the brand resolver and every
 * rendered email body — they are. React components are not executable in this
 * repo's Jest setup (node environment, no jsdom, *.test.ts only), so those are
 * asserted over source text and each block says so.
 */

import fs from 'fs';
import path from 'path';
import { EMAIL_TEMPLATES, coordinatorSetupTemplate } from '@/lib/emailTemplates';
import {
    customerFacingBusinessName,
    customerFacingWebsite,
    resolveTenantBrand,
} from '@/lib/tenantBrand';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const PLATFORM = 'https://www.freezeriqapp.com';

/** C0 controls + DEL, built from escapes so this file stays free of raw bytes. */
const CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F]');

// ═══════════════════════════════════════════════════════════════════════════
// PART A — Business.display_name as the customer-facing brand  (EXECUTED)
// ═══════════════════════════════════════════════════════════════════════════

describe('the customer-facing business name', () => {
    it('uses display_name when the tenant has one', () => {
        expect(customerFacingBusinessName({ name: 'My Freezer Chef', display_name: 'Freezer Chef' }))
            .toBe('Freezer Chef');
    });

    it('falls back to name when display_name is null or absent', () => {
        expect(customerFacingBusinessName({ name: 'Bob Test', display_name: null })).toBe('Bob Test');
        expect(customerFacingBusinessName({ name: 'Bob Test' })).toBe('Bob Test');
    });

    it('a whitespace-only display_name can never produce a blank brand', () => {
        // A text input can produce this. An empty brand in an email footer is
        // worse than the internal name.
        expect(customerFacingBusinessName({ name: 'Bob Test', display_name: '   ' })).toBe('Bob Test');
        expect(customerFacingBusinessName({ name: 'Bob Test', display_name: '' })).toBe('Bob Test');
    });

    it('trims a display_name rather than emitting padding', () => {
        expect(customerFacingBusinessName({ name: 'X', display_name: '  Freezer Chef  ' })).toBe('Freezer Chef');
    });

    it('TenantBranding is never consulted as business authority', () => {
        // Its business_name column DEFAULTS to the literal "Freezer Chef" and is
        // keyed on user_id, so reading it would sign an unconfigured tenant's
        // mail as another company.
        const brand = stripComments(read('lib/tenantBrand.ts'));
        expect(brand).not.toMatch(/tenantBranding/i);
        expect(brand).not.toMatch(/business_name/);
        const route = stripComments(read('app/api/email/send/route.ts'));
        expect(route).not.toMatch(/tenantBranding/i);
    });

    it('nothing in the brand resolver knows what "Freezer Chef" is', () => {
        const brand = stripComments(read('lib/tenantBrand.ts'));
        expect(brand).not.toMatch(/Freezer Chef/);
        expect(brand).not.toMatch(/myfreezerchef/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D — the tenant's own website, not the platform's  (EXECUTED)
// ═══════════════════════════════════════════════════════════════════════════

describe('the customer-facing website', () => {
    it('prefers the tenant custom domain over the platform storefront path', () => {
        const site = customerFacingWebsite(
            { name: 'My Freezer Chef', custom_domain: 'myfreezerchef.com', slug: 'my-freezer-chef' },
            PLATFORM
        );
        expect(site.url).toBe('https://myfreezerchef.com');
        expect(site.label).toBe('myfreezerchef.com');
        expect(site.url).not.toContain('freezeriqapp.com');
        expect(site.url).not.toContain('/shop/');
    });

    it('accepts a custom domain however the tenant typed it', () => {
        for (const raw of ['myfreezerchef.com', 'https://myfreezerchef.com', 'https://myfreezerchef.com/', '  myfreezerchef.com  ']) {
            expect(customerFacingWebsite({ name: 'X', custom_domain: raw }, PLATFORM).url)
                .toBe('https://myfreezerchef.com');
        }
    });

    it('falls back to the canonical storefront URL when there is no custom domain', () => {
        const site = customerFacingWebsite({ name: 'Bob Test', custom_domain: null, slug: 'bob-test' }, PLATFORM);
        expect(site.url).toBe('https://www.freezeriqapp.com/shop/bob-test');
        expect(site.label).toBe('www.freezeriqapp.com/shop/bob-test');
    });

    it('returns nothing rather than a broken link when there is neither', () => {
        expect(customerFacingWebsite({ name: 'X' }, PLATFORM).url).toBeNull();
        expect(customerFacingWebsite({ name: 'X', slug: 'x' }, null).url).toBeNull();
    });

    it('rejects junk in custom_domain instead of building an invalid URL', () => {
        for (const bad of ['   ', 'not a domain', 'nodot']) {
            const site = customerFacingWebsite({ name: 'X', custom_domain: bad, slug: 'x' }, PLATFORM);
            expect(site.url).toBe('https://www.freezeriqapp.com/shop/x');
        }
    });

    it('resolveTenantBrand returns both facts together', () => {
        const brand = resolveTenantBrand(
            { name: 'My Freezer Chef', display_name: 'Freezer Chef', custom_domain: 'myfreezerchef.com', slug: 'my-freezer-chef' },
            PLATFORM
        );
        expect(brand).toEqual({
            name: 'Freezer Chef',
            websiteUrl: 'https://myfreezerchef.com',
            websiteLabel: 'myfreezerchef.com',
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART C / C2 — the lead autoresponder  (EXECUTED)
// ═══════════════════════════════════════════════════════════════════════════

describe('the lead autoresponder', () => {
    const TENANT = {
        name: 'Freezer Chef',
        email: 'Laurie@myfreezerchef.com',
        site: 'https://myfreezerchef.com',
        siteLabel: 'myfreezerchef.com',
    };
    const render = (tenant?: any) => EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', tenant);

    it('uses the owner-approved meal paragraph verbatim', () => {
        const { html } = render(TENANT);
        expect(html).toContain('A meal fundraiser is an easy way to raise money by offering families something they already need');
        expect(html).toContain('We handle the meal prep, freezing, packing, and delivery to your organization, and your team simply sorts and distributes the orders at the designated pickup time and location.');
    });

    it('the old meal paragraph is gone', () => {
        const { html } = render(TENANT);
        expect(html).not.toContain('families are going to eat dinner anyway');
        expect(html).not.toContain('your volunteers hand out boxes');
    });

    it('uses the owner-approved delivery-date paragraph, naming Tue/Wed/Thu', () => {
        const { html } = render(TENANT);
        expect(html).toContain('Most of the fundraiser timeline is built around the delivery date');
        expect(html).toMatch(/Tuesday, Wednesday, or Thursday/);
        expect(html).toMatch(/day, date, and time/);
    });

    it('the old delivery intro is gone', () => {
        expect(render(TENANT).html).not.toContain('Almost everything else follows from the delivery day');
    });

    it('still asks for BOTH a preferred and a backup date', () => {
        const { html } = render(TENANT);
        expect(html).toMatch(/preferred date/i);
        expect(html).toMatch(/backup date/i);
    });

    it('carries the owner-approved final-orders and invoice paragraph', () => {
        const { html } = render(TENANT);
        expect(html).toContain('final orders are due two weeks before the delivery date');
        expect(html).toContain('keep its fundraising percentage off the top');
        expect(html).toContain('invoice for the remaining balance due');
        expect(html).toContain('payment due upon receipt');
    });

    it('promises no percentage anywhere', () => {
        const { html, subject } = render(TENANT);
        expect(html).not.toMatch(/\d+\s*%/);
        expect(subject).not.toMatch(/\d+\s*%/);
    });

    it('asks who will coordinate — the owner-approved wording', () => {
        const { html } = render(TENANT);
        expect(html).toContain('Who will be the main contact/coordinator for the fundraiser?');
        expect(html).toContain('their name, email address, and phone number');
        expect(html).toContain('If that will be you, just let us know.');
    });

    it('the coordinator question assigns nobody — it only asks', () => {
        // Information gathering. Nothing in this template, or the intake path,
        // may turn a name in a reply into a campaign coordinator.
        const tpl = stripComments(read('lib/emailTemplates.ts'));
        expect(tpl).not.toMatch(/fundraiserCampaignCoordinator/);
        const contact = stripComments(read('lib/inquiryContact.ts'));
        expect(contact).not.toMatch(/fundraiserCampaignCoordinator/);
        expect(contact).toMatch(/role: 'relationship_contact'/);
        expect(contact).not.toMatch(/role: 'coordinator'/);
    });

    it('signs with the CUSTOMER-FACING brand', () => {
        const { html } = render(TENANT);
        expect(html).toContain('Freezer Chef');
    });

    it('shows the tenant domain as text and links to it', () => {
        const { html } = render(TENANT);
        expect(html).toContain('>myfreezerchef.com<');
        expect(html).toContain('href="https://myfreezerchef.com"');
        expect(html).not.toContain('freezeriqapp.com/shop/');
    });

    it('a tenant with only a name still renders cleanly', () => {
        const { html } = render({ name: 'Bob Test' });
        expect(html).toContain('Bob Test');
        expect(html).not.toMatch(/undefined/);
        expect(html).not.toMatch(/mailto:/);
    });

    it('escapes hostile input in the body', () => {
        const { html } = EMAIL_TEMPLATES.lead_intro('<script>alert(1)</script>', 'A & B <b>PTO</b>', { name: 'X <img src=x>' });
        expect(html).not.toMatch(/<script>/);
        expect(html).not.toMatch(/<img src=x>/);
        expect(html).toContain('&amp;');
    });

    it('the send route resolves the brand through the shared resolver', () => {
        const route = stripComments(read('app/api/email/send/route.ts'));
        expect(route).toMatch(/resolveTenantBrand/);
        expect(route).toMatch(/select: \{ name: true, display_name: true, custom_domain: true, contact_email: true, slug: true \}/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART B — the public "How It Works" page
// ═══════════════════════════════════════════════════════════════════════════

describe('the public fundraiser page', () => {
    const page = read('app/shop/[slug]/raise-funds/page.tsx');

    it('promises no fixed percentage anywhere', () => {
        expect(page).not.toMatch(/\d+%/);
        expect(page).not.toMatch(/20 ?%/);
    });

    it('uses the truthful agreed-percentage wording instead', () => {
        expect(page).toMatch(/agreed fundraising percentage/);
    });

    it('the contradictory "10 days before delivery" payment claim is gone', () => {
        expect(page).not.toMatch(/10 days before delivery/);
    });

    it('states the owner-approved two-week final-orders contract', () => {
        expect(page).toMatch(/two weeks before delivery/);
        expect(page).toMatch(/payment due upon receipt/);
    });

    it('Set Deadlines & Promote names all three things the tenant provides', () => {
        const step = page.slice(page.indexOf("title: 'Set Deadlines & Promote'"), page.indexOf("title: 'Set Deadlines & Promote'") + 400);
        expect(step).toMatch(/marketing materials/i);
        expect(step).toMatch(/coordinator panel/i);
        expect(step).toMatch(/ordering page/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART G / H — the coordinator setup email  (EXECUTED)
// ═══════════════════════════════════════════════════════════════════════════

describe('the coordinator setup email', () => {
    const SECRET = 'https://www.freezeriqapp.com/coordinator/access#tok_abc123SECRET';
    const TENANT = {
        name: 'Freezer Chef',
        email: 'Laurie@myfreezerchef.com',
        site: 'https://myfreezerchef.com',
        siteLabel: 'myfreezerchef.com',
    };
    const render = () => coordinatorSetupTemplate('Dana', 'Oak Ridge PTO', SECRET, TENANT);

    it('names the organization in the subject', () => {
        expect(render().subject).toBe('Your Oak Ridge PTO fundraiser is ready to set up');
    });

    it('explains bundles, remaining details, and the coordinator panel', () => {
        const { html } = render();
        expect(html).toMatch(/Choose your meal bundles/i);
        expect(html).toMatch(/Confirm the remaining details/i);
        expect(html).toMatch(/coordinator panel/i);
    });

    it('has ONE clear call to action', () => {
        const { html } = render();
        expect(html).toContain('Select Bundles &amp; Set Up Fundraiser');
        expect((html.match(/<a href=/g) || []).length).toBeGreaterThanOrEqual(1);
    });

    it('THE SECURE URL IS THE HREF AND NOTHING ELSE', () => {
        const { html } = render();
        // Present exactly once, and only as an href attribute.
        expect(html).toContain(`href="${SECRET}"`);
        const occurrences = (html.match(/tok_abc123SECRET/g) || []).length;
        expect(occurrences).toBe(1);
    });

    it('the raw URL is never printed as visible text', () => {
        const { html } = render();
        // Strip every tag; whatever a human reads must not contain the secret.
        const visible = html.replace(/<[^>]+>/g, ' ');
        expect(visible).not.toContain('tok_abc123SECRET');
        expect(visible).not.toContain('coordinator/access');
        expect(visible).not.toContain('#');
    });

    it('the credential stays in the fragment — never a query or a path', () => {
        const { html } = render();
        expect(html).not.toMatch(/coordinator\/access\?[^"]*tok_/);
        expect(html).not.toMatch(/coordinator\/tok_/);
        expect(html).not.toMatch(/[?&]token=/);
    });

    it('warns the coordinator not to forward it', () => {
        expect(render().html).toMatch(/don't forward it|don&#39;t forward it/);
    });

    it('signs with the customer-facing brand and tenant domain', () => {
        const { html } = render();
        expect(html).toContain('Freezer Chef');
        expect(html).toContain('href="https://myfreezerchef.com"');
    });

    it('is NOT reachable through the generic client-addressed send route', () => {
        // /api/email/send takes `to` from the request body. A coordinator
        // credential must never be addressable that way.
        const tpl = read('lib/emailTemplates.ts');
        const map = tpl.slice(tpl.indexOf('export const EMAIL_TEMPLATES'), tpl.indexOf('export const coordinatorSetupTemplate'));
        expect(map).not.toMatch(/coordinator_setup/);
        expect(tpl).toMatch(/export const coordinatorSetupTemplate/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART G / I / J / K — the coordinator email route
// ═══════════════════════════════════════════════════════════════════════════

describe('the coordinator email route', () => {
    const route = stripComments(read('app/api/campaigns/[id]/coordinator-email/route.ts'));

    it('requires a session', () => {
        expect((route.match(/if \(!session\?\.user\?\.businessId\)/g) || []).length).toBe(2);
        expect(route).toMatch(/status: 401/);
    });

    it('scopes the campaign to the caller tenant', () => {
        expect(route).toMatch(/where: \{ id: campaignId, customer: \{ business_id: businessId \} \}/);
    });

    it('the RECIPIENT comes from the coordinator relationship, never the request body', () => {
        expect(route).toMatch(/fundraiserCampaignCoordinator\.findUnique/);
        // The POST handler never parses a body at all.
        const post = route.slice(route.indexOf('export async function POST'));
        expect(post).not.toMatch(/req\.json\(\)/);
        expect(post).not.toMatch(/body\?\.(to|email)/);
    });

    it('refuses a coordinator whose relationship has ended', () => {
        expect(route).toMatch(/coordinator\.org_contact\.ended_at/);
    });

    it('refuses when the coordinator has no email on file', () => {
        expect(route).toMatch(/no email address on file/);
    });

    it('PREVIEW writes nothing and sends nothing', () => {
        const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
        expect(get).not.toMatch(/resend/i);
        expect(get).not.toMatch(/\.update\(/);
        expect(get).not.toMatch(/setup_email_sent_at: /);
        expect(get).toMatch(/sent: false/);
    });

    it('PREVIEW does not hand the credential back to the browser', () => {
        const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
        // setupUrl is destructured out deliberately and never returned.
        expect(get).not.toMatch(/setupUrl,/);
    });

    it('SAFETY MODE sends nothing and claims nothing', () => {
        const post = route.slice(route.indexOf('export async function POST'));
        const start = post.indexOf('if (!isLive)');
        const branch = post.slice(start, post.indexOf('return;', start) > -1
            ? post.indexOf('mocked: true') + 40
            : post.indexOf('mocked: true') + 40);
        expect(branch).toMatch(/mocked: true/);
        expect(branch).not.toMatch(/setup_email_sent_at/);
        expect(branch).not.toMatch(/resend/i);
    });

    it('PROVIDER FAILURE releases the claim and never writes sent_at', () => {
        const post = route.slice(route.indexOf('export async function POST'));
        const fail = post.slice(post.indexOf('if (data.error)'));
        // The CLAIM is released — the provider told us nothing was queued.
        expect(fail).toMatch(/setup_email_claimed_at: null/);
        expect(fail).toMatch(/status: 500/);
        // sent_at was never set on this path, so nothing about it is touched
        // before the caller is told the send failed.
        expect(fail.slice(0, fail.indexOf('status: 500'))).not.toMatch(/setup_email_sent_at/);
    });

    it('sent_at is written exactly once, AFTER the provider accepts', () => {
        // THE SEMANTIC GATE. An earlier draft used sent_at as the claim, which
        // meant a crash between claiming and sending left a row asserting an
        // email had gone out when none had. sent_at may only follow acceptance.
        const post = route.slice(route.indexOf('export async function POST'));
        expect((post.match(/setup_email_sent_at: new Date\(\)/g) || []).length).toBe(1);
        expect(post.indexOf('resend.emails.send')).toBeLessThan(post.indexOf('setup_email_sent_at: new Date()'));
        expect(post.indexOf('if (data.error)')).toBeLessThan(post.indexOf('setup_email_sent_at: new Date()'));
    });

    it('uses the canonical secure-link builder, not a hand-rolled URL', () => {
        expect(route).toMatch(/buildCoordinatorAccessUrl/);
        expect(route).not.toMatch(/coordinator\/access#/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART E — adding a coordinator from the launch flow
// ═══════════════════════════════════════════════════════════════════════════

describe('the organization contact endpoint', () => {
    const route = stripComments(read('app/api/organizations/[id]/contacts/route.ts'));

    it('requires a session', () => {
        expect(route).toMatch(/if \(!session\?\.user\?\.businessId\)/);
        expect(route).toMatch(/status: 401/);
    });

    it('re-reads the organization under the caller tenant before writing', () => {
        expect(route).toMatch(/prisma\.customer\.findFirst/);
        expect(route).toMatch(/where: \{ id: customerId, business_id: businessId \}/);
        const gate = route.indexOf('prisma.customer.findFirst');
        expect(gate).toBeLessThan(route.indexOf('fundraiserContact.create'));
    });

    it('every write is scoped to the caller tenant', () => {
        for (const m of route.match(/business_id: \w+/g) || []) {
            expect(m).toBe('business_id: businessId');
        }
    });

    it('adds a CONTACT, never a coordinator', () => {
        expect(route).toMatch(/role: 'relationship_contact'/);
        expect(route).not.toMatch(/role: 'coordinator'/);
        expect(route).not.toMatch(/fundraiserCampaignCoordinator/);
    });

    it('reuses a person already attached to this organization instead of duplicating', () => {
        expect(route).toMatch(/org_contacts: \{ some: \{ customer_id: customerId, ended_at: null \} \}/);
        expect(route).toMatch(/created: false/);
    });

    it('tells the client NOT to auto-select the new person', () => {
        expect(route).toMatch(/autoSelect: false/);
    });

    it('requires a usable email — a coordinator has to receive a link', () => {
        expect(route).toMatch(/isPlausibleEmail/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART E / F / I — the launch dialog  (SOURCE-TEXT: React is not executable here)
// ═══════════════════════════════════════════════════════════════════════════

describe('the launch dialog', () => {
    const dlg = read('components/crm2/LaunchFundraiserDialog.tsx');

    it('offers an inline add-contact path', () => {
        expect(dlg).toMatch(/Add a different coordinator/);
        expect(dlg).toMatch(/\/api\/organizations\/\$\{ctx\.organization\.id\}\/contacts/);
    });

    it('creating a contact does NOT select them', () => {
        const add = dlg.slice(dlg.indexOf('const addContact'), dlg.indexOf('const openEmailReview'));
        expect(add).not.toMatch(/setOrgContactId/);
        expect(add).toMatch(/coordinatorCandidates: fresh\.coordinatorCandidates/);
    });

    it('refreshing candidates preserves the tenant\'s in-progress choices', () => {
        const add = dlg.slice(dlg.indexOf('const addContact'), dlg.indexOf('const openEmailReview'));
        // Merges into prev rather than replacing the whole context.
        expect(add).toMatch(/setCtx\(\(prev\) => \(prev \? \{ \.\.\.prev, coordinatorCandidates/);
        expect(add).not.toMatch(/setName\(/);
        expect(add).not.toMatch(/setPicked\(/);
    });

    it('the picker still opens unselected', () => {
        expect(dlg).toMatch(/<option value="">Choose a coordinator…<\/option>/);
    });

    it('review is a GET and does not send', () => {
        const open = dlg.slice(dlg.indexOf('const openEmailReview'), dlg.indexOf('const sendCoordinatorEmail'));
        expect(open).not.toMatch(/method: 'POST'/);
        expect(open).not.toMatch(/setEmailSentAt\(new Date/);
    });

    it('launching alone never marks the email sent', () => {
        const submit = dlg.slice(dlg.indexOf('const submit = useCallback'), dlg.indexOf('const addContact'));
        expect(submit).not.toMatch(/setEmailSentAt/);
        expect(submit).not.toMatch(/coordinator-email/);
    });

    it('a mocked send claims nothing', () => {
        const send = dlg.slice(dlg.indexOf('const sendCoordinatorEmail'), dlg.indexOf('const copy = useCallback'));
        const start = send.indexOf('if (data?.mocked)');
        const mocked = send.slice(start, send.indexOf('return;', start) + 7);
        expect(mocked).toMatch(/No email was sent/);
        expect(mocked).not.toMatch(/setEmailSentAt/);
    });

    it('guard order: failure, then mocked, then sent', () => {
        const send = dlg.slice(dlg.indexOf('const sendCoordinatorEmail'), dlg.indexOf('const copy = useCallback'));
        // The !res.ok branch now also distinguishes alreadySent / uncertain, so
        // compare against the SUCCESS-path write, which is the last of the three.
        const success = send.lastIndexOf('setEmailSentAt(new Date().toISOString())');
        expect(send.indexOf('if (!res.ok)')).toBeLessThan(send.indexOf('if (data?.mocked)'));
        expect(send.indexOf('if (data?.mocked)')).toBeLessThan(success);
    });

    it('review-and-send is the primary path; copy tools remain as fallback', () => {
        expect(dlg).toMatch(/Review &amp; send coordinator email/);
        expect(dlg).toMatch(/manual fallback/);
        expect(dlg).toMatch(/Copy Setup Link/);
    });

    it('the preview does not print the secure link as text', () => {
        const modal = dlg.slice(dlg.indexOf('{emailPreview && ('));
        expect(modal).not.toMatch(/emailPreview\.setupUrl/);
        expect(modal).toMatch(/not shown as text on purpose/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL REVIEW — the gates that actually found defects
// ═══════════════════════════════════════════════════════════════════════════

describe('ADVERSARIAL: subject headers cannot be injected', () => {
    // An organization name is typed by a person and reaches the subject line. A
    // newline there ends the header, and whatever follows becomes a new one —
    // that is how a Bcc gets appended to someone else's message.
    const HOSTILE = 'Acme\r\nBcc: attacker@evil.test\r\nX-Injected: 1';

    it('the coordinator subject carries no CR or LF', () => {
        const { subject } = coordinatorSetupTemplate('Dana', HOSTILE, 'https://x.test/a#S', { name: 'B' });
        expect(subject).not.toMatch(/[\r\n]/);
        // No control character of any kind survives into the header.
        expect(subject).not.toMatch(CONTROL_CHARS);
    });

    it('the lead_intro subject carries no CR or LF', () => {
        const { subject } = EMAIL_TEMPLATES.lead_intro('Dana', HOSTILE, { name: 'B' });
        expect(subject).not.toMatch(/[\r\n]/);
    });

    it('every C0 control character and DEL is stripped', () => {
        const ctrl = 'A' + String.fromCharCode(0, 1, 7, 11, 12, 27, 127) + 'B';
        const { subject } = coordinatorSetupTemplate('D', ctrl, 'https://x.test/a#S', { name: 'B' });
        // eslint-disable-next-line no-control-regex
        expect(subject).not.toMatch(new RegExp('[\\u0000-\\u001F\\u007F]'));
    });

    it('printable punctuation SURVIVES — sanitising must not mangle real names', () => {
        const { subject } = coordinatorSetupTemplate('D', "Ben & Jerry's PTO - Group #2", 'https://x.test/a#S', { name: 'B' });
        expect(subject).toContain("Ben & Jerry's PTO - Group #2");
    });
});

describe('ADVERSARIAL: HTML escaping holds under hostile input', () => {
    it('no tag ever gains an event-handler attribute', () => {
        const { html } = coordinatorSetupTemplate(
            'D" onmouseover=alert(1) x="',
            'Org" onfocus="evil()',
            'https://x.test/coordinator/access#SECRET',
            { name: 'N" onclick="evil()', email: 'a@b.test" onblur="x', site: 'https://s.test', siteLabel: 'lbl"' }
        );
        // Inspect only what is INSIDE tags — an attribute can exist nowhere else.
        const tags = html.match(/<[^>]*>/g) || [];
        for (const t of tags) {
            // An escaped quote inside a value is not an attribute boundary.
            const withoutValues = t.replace(/="[^"]*"/g, '=""');
            expect(withoutValues).not.toMatch(/\son[a-z]+\s*=/i);
        }
    });

    it('no extra anchor can be injected', () => {
        const { html } = coordinatorSetupTemplate(
            '</a><a href="https://evil.test">click</a>', 'Org', 'https://x.test/a#S', { name: 'B' }
        );
        // CTA only — the signature has no site here.
        expect((html.match(/<a /g) || []).length).toBe(1);
        expect(html).not.toContain('href="https://evil.test"');
    });

    it('a hostile custom_domain never reaches an href through the real resolver', () => {
        for (const bad of ['https://s.test" onload="x', '<b>x.com</b>', 'a.com\r\nX: 1', 'java script:alert(1)']) {
            const site = customerFacingWebsite({ name: 'T', custom_domain: bad, slug: 't' }, PLATFORM);
            expect(site.url).toBe('https://www.freezeriqapp.com/shop/t');
        }
    });

    it('a legitimate domain still passes', () => {
        for (const good of ['myfreezerchef.com', 'shop.myfreezerchef.com', 'my-freezer-chef.co.uk']) {
            expect(customerFacingWebsite({ name: 'T', custom_domain: good, slug: 't' }, PLATFORM).url)
                .toBe(`https://${good}`);
        }
    });
});

describe('ADVERSARIAL: exactly one invitation, enforced by the database', () => {
    const route = stripComments(read('app/api/campaigns/[id]/coordinator-email/route.ts'));
    const post = route.slice(route.indexOf('export async function POST'));

    it('the right to send is CLAIMED before the provider is ever called', () => {
        // A read-then-send cannot survive two concurrent requests: both read
        // null, both send. The condition has to live in the WHERE clause.
        const claim = post.indexOf('updateMany({');
        expect(claim).toBeGreaterThan(-1);
        expect(claim).toBeLessThan(post.indexOf('resend.emails.send'));
    });

    it('the claim is its own column, conditional on BOTH timestamps being null', () => {
        expect(post).toMatch(/where: \{ campaign_id: id, setup_email_claimed_at: null, setup_email_sent_at: null \}/);
        expect(post).toMatch(/data: \{ setup_email_claimed_at: new Date\(\) \}/);
    });

    it('losing the claim stops BEFORE the provider, and distinguishes sent from unresolved', () => {
        const lost = post.slice(post.indexOf('if (claim.count === 0)'), post.indexOf('const { Resend }'));
        expect(lost).toMatch(/alreadySent: true/);
        expect(lost).toMatch(/unresolved: true/);
        expect(lost).toMatch(/status: 409/);
        expect(lost).not.toMatch(/resend/i);
        // "sent" is decided by sent_at, never by the claim alone.
        expect(lost).toMatch(/if \(current\?\.setup_email_sent_at\)/);
    });

    it('safety mode never consumes the claim', () => {
        // A simulated send must leave the real invitation still available.
        expect(post.indexOf('if (!isLive)')).toBeLessThan(post.indexOf('updateMany({'));
    });

    it('an EXPLICIT provider rejection releases the claim — nothing was sent', () => {
        const rejected = post.slice(post.indexOf('if (data.error)'));
        expect(rejected).toMatch(/setup_email_claimed_at: null/);
        expect(rejected).toMatch(/status: 500/);
    });

    it('an UNKNOWN outcome HOLDS the claim rather than risking a duplicate credential', () => {
        const thrown = post.slice(post.indexOf('catch (sendErr)'), post.indexOf('if (data.error)'));
        expect(thrown).toMatch(/uncertain: true/);
        expect(thrown).not.toMatch(/setup_email_sent_at: null/);
        expect(thrown).toMatch(/Check with the coordinator/);
    });

    it('a failed release is logged loudly — only a human can reconcile it', () => {
        expect(post).toMatch(/could not release the claim/);
    });

    it('a failed sent_at write leaves claimed-but-not-sent, never a false sent', () => {
        // Genuine partial success: the coordinator has the email and we could
        // not write that down. The claim is HELD so no normal request can send a
        // second credential, and the row rests at exactly what is known.
        const partial = post.slice(post.indexOf('catch (recordErr)'));
        expect(partial).toMatch(/success: true/);
        expect(partial).toMatch(/recorded: false/);
        expect(partial.slice(0, partial.indexOf('return NextResponse'))).not.toMatch(/setup_email_claimed_at: null/);
        expect(post).toMatch(/SENT but NOT RECORDED/);
    });

    it('CRASH between claim and send is representable, and is not "sent"', () => {
        // The durable row after a crash is claimed_at set, sent_at null. Nothing
        // reads that as sent: the GET names the state, and it is not 'sent'.
        const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
        expect(get).toMatch(/const state = alreadySentAt \? 'sent' : claimedAt \? 'unresolved' : 'ready'/);
    });

    it('no general resend feature was added', () => {
        const dlg = read('components/crm2/LaunchFundraiserDialog.tsx');
        expect(dlg).not.toMatch(/Send it again/);
        expect(dlg).toMatch(/use Copy Setup Link below rather/);
    });

    it('the UI reflects already-sent as state, not as a retryable failure', () => {
        const dlg = read('components/crm2/LaunchFundraiserDialog.tsx');
        const send = dlg.slice(dlg.indexOf('const sendCoordinatorEmail'), dlg.indexOf('const copy = useCallback'));
        const already = send.slice(send.indexOf('if (data?.alreadySent)'), send.indexOf('if (data?.uncertain)'));
        expect(already).toMatch(/already been sent/);
        expect(already).toMatch(/setEmailSentAt/);
        expect(already).not.toMatch(/toast\.error/);
    });

    it('an uncertain outcome does not invite a retry', () => {
        const dlg = read('components/crm2/LaunchFundraiserDialog.tsx');
        const send = dlg.slice(dlg.indexOf('const sendCoordinatorEmail'), dlg.indexOf('const copy = useCallback'));
        const start = send.indexOf('if (data?.uncertain)');
        const block = send.slice(start, send.indexOf('return;', start) + 7);
        expect(block).not.toMatch(/Please try again/);
        expect(block).not.toMatch(/fetch\(/);
    });

    it('no credential or full secure URL is ever logged', () => {
        for (const m of post.match(/console\.(error|log|warn)\([\s\S]{0,400}?\);/g) || []) {
            expect(m).not.toMatch(/setupUrl/);
            expect(m).not.toMatch(/portal_token/);
            expect(m).not.toMatch(/coordinator\/access/);
        }
    });
});

describe('ADVERSARIAL: coordinator reassignment cannot inherit a stale invitation', () => {
    it('the assignment row is CREATEd once and never updated to a new person', () => {
        // campaign_id is the PRIMARY KEY, so a second create for the same
        // campaign is rejected by the database, not merely by the UI.
        const schema = read('prisma/schema.prisma');
        const coord = schema.slice(schema.indexOf('model FundraiserCampaignCoordinator'));
        expect(coord.slice(0, coord.indexOf('\n}'))).toMatch(/campaign_id\s+String\s+@id/);
    });

    it('no code path re-points an existing assignment at a different contact', () => {
        // If a later phase adds reassignment, this test fails and the author has
        // to decide what happens to setup_email_sent_at — which is the point.
        const hits: string[] = [];
        for (const f of [
            'app/api/opportunities/[id]/launch/route.ts',
            'app/api/campaigns/[id]/coordinator-email/route.ts',
        ]) {
            const src = stripComments(read(f));
            for (const m of src.match(/fundraiserCampaignCoordinator\.\w+/g) || []) hits.push(`${f}:${m}`);
        }
        // Exactly one create (launch). No upsert anywhere.
        expect(hits.filter((h) => h.endsWith('.create'))).toHaveLength(1);
        expect(hits.filter((h) => h.endsWith('.upsert'))).toHaveLength(0);
        // Every write from the email route touches ONLY the two email
        // timestamps — the claim, its release, and the sent record.
        // org_contact_id is never reassigned, so no invitation state can follow
        // a different person.
        const email = stripComments(read('app/api/campaigns/[id]/coordinator-email/route.ts'));
        const writes = email.match(/fundraiserCampaignCoordinator\.(updateMany|update)\(\{[\s\S]{0,240}?\}\)/g) || [];
        expect(writes.length).toBeGreaterThanOrEqual(3);
        for (const m of writes) {
            expect(m).not.toMatch(/org_contact_id/);
            expect(m).toMatch(/setup_email_(claimed|sent)_at/);
        }
    });
});

describe('ADVERSARIAL: the generic email route cannot mail a coordinator credential', () => {
    it('coordinatorSetupTemplate is imported by exactly one module', () => {
        const roots = ['app', 'lib', 'components'];
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                const rel = `${dir}/${e.name}`;
                if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
                if (!/\.tsx?$/.test(e.name)) continue;
                const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
                if (/coordinatorSetupTemplate/.test(src) && !rel.startsWith('lib/emailTemplates')) hits.push(rel);
            }
        };
        roots.forEach(walk);
        expect(hits).toEqual(['app/api/campaigns/[id]/coordinator-email/route.ts']);
    });

    it('the client-addressed template map does not contain it', () => {
        const tpl = read('lib/emailTemplates.ts');
        const map = tpl.slice(tpl.indexOf('export const EMAIL_TEMPLATES'), tpl.indexOf('export const coordinatorSetupTemplate'));
        expect(map).not.toMatch(/coordinator_setup/);
        // And the generic route can only reach keys of that map.
        const route = stripComments(read('app/api/email/send/route.ts'));
        expect(route).toMatch(/EMAIL_TEMPLATES\[template as keyof typeof EMAIL_TEMPLATES\]/);
        expect(route).not.toMatch(/coordinatorSetupTemplate/);
    });

    it('template names a caller could actually request', () => {
        expect(Object.keys(EMAIL_TEMPLATES).sort()).toEqual(['lead_intro', 'thank_you']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Schema + migration
// ═══════════════════════════════════════════════════════════════════════════

describe('FR-ACCEPTANCE-2A schema', () => {
    const schema = read('prisma/schema.prisma');
    const MIGRATION = 'prisma/migrations/20260822000000_fr_acceptance_2a_display_name_setup_email/migration.sql';

    it('adds display_name as nullable with no default', () => {
        const business = schema.slice(schema.indexOf('model Business {'), schema.indexOf('model Customer'));
        expect(business).toMatch(/display_name\s+String\?/);
        expect(business).not.toMatch(/display_name\s+String\?\s*@default/);
    });

    it('leaves name, custom_domain and TenantBranding untouched', () => {
        const business = schema.slice(schema.indexOf('model Business {'), schema.indexOf('model Customer'));
        // `name` is still a plain required String — not renamed, not made optional.
        expect(business).toMatch(/^\s+name\s+String\s*$/m);
        expect(business).toMatch(/custom_domain\s+String\?\s+@unique/);
        const tb = schema.slice(schema.indexOf('model TenantBranding'), schema.indexOf('model TenantBranding') + 900);
        expect(tb).toMatch(/business_name\s+String\s+@default\("Freezer Chef"\)/);
        expect(tb).toMatch(/user_id\s+String\s+@unique/);
    });

    it('adds setup_email_sent_at as nullable with no default', () => {
        const coord = schema.slice(schema.indexOf('model FundraiserCampaignCoordinator'));
        const block = coord.slice(0, coord.indexOf('\n}'));
        expect(block).toMatch(/setup_email_sent_at DateTime\?/);
        expect(block).not.toMatch(/setup_email_sent_at DateTime\?\s*@default/);
    });

    it('the migration is exactly three additive columns', () => {
        const sql = read(MIGRATION);
        const statements = sql.split('\n').filter((l) => /^\s*[A-Z]/.test(l) && !l.startsWith('--'));
        expect(statements).toHaveLength(3);
        expect(sql).toMatch(/ALTER TABLE "businesses" ADD COLUMN "display_name" TEXT;/);
        expect(sql).toMatch(/ALTER TABLE "fundraiser_campaign_coordinators" ADD COLUMN "setup_email_claimed_at" TIMESTAMP\(3\);/);
        expect(sql).toMatch(/ALTER TABLE "fundraiser_campaign_coordinators" ADD COLUMN "setup_email_sent_at" TIMESTAMP\(3\);/);
    });

    it('the migration destroys nothing and backfills nothing', () => {
        // Comments stripped: the rationale necessarily names what it refuses to do.
        const sql = read(MIGRATION).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        expect(sql).not.toMatch(/\bDROP\b/);
        expect(sql).not.toMatch(/\bUPDATE\b/);
        expect(sql).not.toMatch(/\bINSERT\b/);
        expect(sql).not.toMatch(/\bDELETE\b/);
        expect(sql).not.toMatch(/DEFAULT/);
        expect(sql).not.toMatch(/tenant_branding/);
    });

    it('is not yet applied — the ledger on disk is the previous 13 plus this one', () => {
        const migrations = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d));
        expect(migrations).toHaveLength(14);
        expect(migrations[migrations.length - 1]).toBe('20260822000000_fr_acceptance_2a_display_name_setup_email');
    });
});
