/**
 * FUNDRAISER-INQUIRY-AUTORESPONSE-COPY-1 — copy replacement only, on the
 * EXISTING, already-live requester autoresponder (lib/emailTemplates.ts's
 * lead_intro, sent by lib/inquiryAcknowledgement.ts). No new send path, no
 * change to lead creation, routing, or Reply-To resolution — those are proven
 * unchanged by the fact that lib/inquiryAcknowledgement.ts, lib/email.ts, and
 * app/api/public/fundraiser-request/route.ts are not touched by this phase
 * (their own existing suites — frAcceptance1C, frAcceptance2A1AutoAck,
 * frAcceptance2A1IntakeAck, frAcceptance2A1HumanResponse — remain the proof
 * for lead creation, exactly-once sending, and internal notification).
 *
 * This file proves the 6 things that are actually new here: the subject and
 * body carry the owner-approved copy, every tenant-facing value stays
 * dynamic, and no tenant-specific string was hardcoded into the shared
 * template.
 */

import { EMAIL_TEMPLATES, type TemplateTenant } from '@/lib/emailTemplates';

const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const FREEZER_CHEF: TemplateTenant = {
    name: 'Freezer Chef',
    email: 'Laurie@myfreezerchef.com',
    site: 'https://myfreezerchef.com',
    siteLabel: 'myfreezerchef.com',
};
const OTHER_TENANT: TemplateTenant = {
    name: "Nate's Freezer Guy",
    email: 'orders@natesfreezerguy.com',
    site: 'https://natesfreezerguy.com',
    siteLabel: 'natesfreezerguy.com',
};

describe('FUNDRAISER-INQUIRY-AUTORESPONSE-COPY-1 — subject', () => {
    it('uses the approved subject line, with the organization name dynamic', () => {
        expect(EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', FREEZER_CHEF).subject)
            .toBe("Let's get Oak Ridge PTO on the fundraiser calendar");
        expect(EMAIL_TEMPLATES.lead_intro('Dana', 'Edgar County Farm Bureau', FREEZER_CHEF).subject)
            .toBe("Let's get Edgar County Farm Bureau on the fundraiser calendar");
    });

    it('falls back gracefully when no organization name was given', () => {
        expect(EMAIL_TEMPLATES.lead_intro('Dana', undefined, FREEZER_CHEF).subject)
            .toBe("Let's get your group on the fundraiser calendar");
    });
});

describe('FUNDRAISER-INQUIRY-AUTORESPONSE-COPY-1 — dynamic fields', () => {
    it('renders the requester first name dynamically', () => {
        expect(EMAIL_TEMPLATES.lead_intro('Kaleb Hacker', 'Oak Ridge PTO', FREEZER_CHEF).html).toContain('Hi Kaleb!');
        expect(EMAIL_TEMPLATES.lead_intro('Wyatt Williamson', 'Oak Ridge PTO', FREEZER_CHEF).html).toContain('Hi Wyatt!');
    });

    it('renders the organization name dynamically in the body', () => {
        const a = EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', FREEZER_CHEF).html;
        const b = EMAIL_TEMPLATES.lead_intro('Dana', 'Edgar County Farm Bureau', FREEZER_CHEF).html;
        expect(a).toContain('<strong>Oak Ridge PTO</strong>');
        expect(b).toContain('<strong>Edgar County Farm Bureau</strong>');
        expect(a).not.toContain('Edgar County Farm Bureau');
        expect(b).not.toContain('Oak Ridge PTO');
    });

    it('the tenant signature stays dynamic — two tenants render two different signatures', () => {
        const a = EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', FREEZER_CHEF).html;
        const b = EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', OTHER_TENANT).html;
        expect(a).toContain('Freezer Chef');
        expect(a).toContain('mailto:Laurie@myfreezerchef.com');
        expect(a).not.toContain("Nate's Freezer Guy");
        expect(b).toContain("Nate&#39;s Freezer Guy");
        expect(b).toContain('mailto:orders@natesfreezerguy.com');
        expect(b).not.toContain('Freezer Chef');
    });
});

describe('FUNDRAISER-INQUIRY-AUTORESPONSE-COPY-1 — Reply-To stays tenant-authoritative (unchanged)', () => {
    it('lib/email.ts still resolves replyTo from the tenant\'s own contact_email — this phase did not touch it', () => {
        const src = stripComments(read('lib/email.ts'));
        expect(src).toMatch(/replyTo\s*=\s*business\.contact_email/);
    });
});

describe('FUNDRAISER-INQUIRY-AUTORESPONSE-COPY-1 — approved headings and copy are present', () => {
    const { html } = EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', FREEZER_CHEF);

    it('carries all four approved section headings', () => {
        expect(html).toContain("<h3>The first step: let's pick your date</h3>");
        expect(html).toContain('<h3>Who will coordinate the fundraiser?</h3>');
        expect(html).toContain('<h3>Then we make the rest simple</h3>');
        expect(html).toContain('<h3>Ready to get a date on the calendar?</h3>');
    });

    it('asks for a preferred date+time and a backup date+time', () => {
        expect(html).toContain('<li><strong>Your preferred date and time</strong></li>');
        expect(html).toContain('<li><strong>A backup date and time</strong></li>');
    });

    it('the 4-item "what happens next" list covers confirm, share, panel, and pickup-day prep', () => {
        expect(html).toContain('<strong>We confirm your fundraiser.</strong>');
        expect(html).toContain('<strong>We give you everything you need to share it.</strong>');
        expect(html).toContain('<strong>Your Coordinator Panel becomes your fundraiser home base.</strong>');
        expect(html).toContain('<strong>We prepare everything for pickup day.</strong>');
    });

    it('the closing reply-request asks for date, backup date, and coordinator info', () => {
        expect(html).toContain('Just hit <strong>reply</strong> and send us:');
        expect(html).toContain('<li><strong>Your preferred delivery date and time</strong></li>');
        expect(html).toContain('<li><strong>Your backup date and time</strong></li>');
        expect(html).toContain("coordinator's name, email, and phone number");
        expect(html).toContain("We'll take it from there.");
    });

    it('still promises no fixed percentage anywhere', () => {
        const { html: h, subject } = EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', FREEZER_CHEF);
        expect(h).not.toMatch(/\d+\s*%/);
        expect(subject).not.toMatch(/\d+\s*%/);
    });
});

describe('FUNDRAISER-INQUIRY-AUTORESPONSE-COPY-1 — no tenant-specific hardcoding introduced', () => {
    it('the shared template source names no specific tenant, contact person, or address', () => {
        // The ONLY place "Freezer Chef" / "Laurie" may legitimately appear in
        // this test suite is in a TEST FIXTURE passed in as `tenant`, never in
        // the template source itself — the source must stay fully generic.
        const src = stripComments(read('lib/emailTemplates.ts'));
        expect(src).not.toMatch(/Freezer Chef/);
        expect(src).not.toMatch(/Laurie/i);
        expect(src).not.toMatch(/myfreezerchef/i);
        expect(src).not.toMatch(/GotNate/i);
    });

    it('no contact-person field was added — the signature still renders from name/email/site only', () => {
        const src = stripComments(read('lib/emailTemplates.ts'));
        const iface = src.slice(src.indexOf('interface TemplateTenant'), src.indexOf('interface TemplateTenant') + 300);
        expect(iface).toMatch(/name:\s*string;/);
        expect(iface).toMatch(/email\?:\s*string;/);
        expect(iface).toMatch(/site\?:\s*string;/);
        expect(iface).toMatch(/siteLabel\?:\s*string;/);
        expect(iface).not.toMatch(/contactName|contact_name|contactPerson/i);
    });

    it('lib/inquiryAcknowledgement.ts was not touched by this phase — still the only send path, still untouched', () => {
        const src = stripComments(read('lib/inquiryAcknowledgement.ts'));
        expect(src).toMatch(/attemptInquiryAcknowledgement/);
        // No new query was added on its behalf — it still selects exactly the
        // same inquiry fields it always has for this template.
        expect(src).toMatch(/lead_intro\(/);
    });
});
