/**
 * FR-ACCEPTANCE-1C — the platform's stock email bodies, made tenant-safe.
 *
 * These lived inside app/api/email/send/route.ts, where two things were wrong
 * with them.
 *
 * The first is that they were not a SaaS template at all. `lead_intro` — the
 * message a tenant sends the moment a volunteer asks about a fundraiser —
 * described "a Freezer Chef fundraiser", promised the organization "20% of
 * every sale", restricted delivery to Tuesday/Wednesday/Thursday, and signed
 * off as Laurie at MyFreezerChef.com. The From header was already resolved per
 * tenant, so the second tenant to sign up would have sent mail from their own
 * address, in their own name, introducing a competitor and committing to that
 * competitor's terms. There is no configuration that fixes that; the identity
 * was compiled in.
 *
 * The second is the 20% itself. An organization's share is a per-campaign
 * number, set during launch — there is no campaign when the intro goes out, so
 * whatever the email said was a guess. Quoting a number the platform cannot
 * honour is worse than quoting none: the volunteer forwards it to their board,
 * and the tenant discovers the commitment when they try to charge something
 * else. The share is now named as something confirmed when the date is booked,
 * which is the point at which it becomes a real, stored value.
 *
 * They live in lib/ rather than the route because Next type-checks route
 * modules and rejects exports that are not handlers — from here a test can call
 * them directly and read what a tenant would actually receive, instead of
 * grepping the source and hoping.
 */

/**
 * Deliberately a local copy of lib/email.ts's escaper rather than an import.
 *
 * That module constructs a Resend client at module scope, so importing it here
 * would drag a mail provider — and an API key requirement — into a file whose
 * only job is to turn three strings into markup. Keeping this module free of
 * dependencies is what lets a test render these bodies and read what a tenant
 * would actually receive, instead of grepping the source and hoping.
 *
 * Names, organisation names and tenant names are all user-controlled and must
 * never reach an email body as raw markup.
 */
/**
 * Make a user-derived value safe to place in a SUBJECT header.
 *
 * Organization and business names reach the subject line, and both are typed by
 * people. A name containing CR or LF would be emitted into a mail header, where
 * a newline ends the header and whatever follows becomes a NEW one — that is
 * how `Bcc:` gets appended to somebody else's message. Whether a given provider
 * happens to sanitize this is not something a caller should have to rely on.
 *
 * Control characters are stripped rather than escaped, because a subject has no
 * escaping mechanism: there is no representation of a newline inside a header
 * value. Runs of whitespace collapse so a stripped name still reads normally.
 */
/**
 * C0 control characters and DEL — everything a mail header value must never
 * carry. Built with explicit escapes so the source stays free of raw control
 * bytes.
 */
const SUBJECT_CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');

export function safeSubject(value: string): string {
    return value
        // Controls only. Nothing printable is touched, so a name like
        // "Ben & Jerry's" survives intact.
        .replace(SUBJECT_CONTROL_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

import { firstNameOf } from '@/lib/personName';

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The sending tenant, resolved from `Business` — the same row getTenantSender
 * builds the From header from, so the signature and the envelope agree.
 *
 * `name` is required because Business.name is NOT NULL: there is no such thing
 * as a tenant without a name, so no template needs a fallback for one. The
 * other two are genuinely optional and every use is conditional.
 */
export interface TemplateTenant {
    /**
     * The CUSTOMER-FACING business name — `display_name` falling back to `name`,
     * resolved by lib/tenantBrand. Never blank.
     */
    name: string;
    /** Reply address, when the tenant has configured one. */
    email?: string;
    /**
     * Absolute URL of the tenant's public site: their own domain when they have
     * one, the storefront URL otherwise.
     */
    site?: string;
    /**
     * How that URL is shown to a human — "myfreezerchef.com", not the full
     * href. A volunteer should see the tenant's address, not a long platform
     * path. Falls back to `site` when absent.
     */
    siteLabel?: string;
}

/**
 * The signature block, rendered from whatever the tenant actually has.
 *
 * A tenant that has configured nothing but their name still gets a correct,
 * complete sign-off — the contact lines simply do not appear. That matters more
 * than it looks: the failure we are replacing was a signature that was always
 * present and always wrong.
 */
function signature(tenant?: TemplateTenant): string {
    const name = tenant?.name?.trim();
    if (!name) return '<p>Warmly,</p>';
    const lines = [`<strong>${escapeHtml(name)}</strong>`];
    if (tenant?.email) {
        lines.push(`<a href="mailto:${escapeHtml(tenant.email)}">${escapeHtml(tenant.email)}</a>`);
    }
    if (tenant?.site) {
        // The href is the real URL; the text is the tenant's own address.
        const label = (tenant.siteLabel ?? '').trim() || tenant.site;
        lines.push(`<a href="${escapeHtml(tenant.site)}">${escapeHtml(label)}</a>`);
    }
    return `<p>Warmly,</p>\n            <p>${lines.join('<br>')}</p>`;
}

export const EMAIL_TEMPLATES = {
    /**
     * The reply to a brand-new fundraiser inquiry.
     *
     * Its job is to answer a person who just raised their hand: thank them, show
     * you know who they are, and move the conversation to the one thing that
     * unblocks everything else — a date. It asks for a backup date in the same
     * breath because delivery days are finite and a single preferred date turns
     * into another round of email when it is taken.
     *
     * FUNDRAISER-INQUIRY-AUTORESPONSE-COPY-1 (owner-approved, superseding the
     * FR-ACCEPTANCE-2A / 2A.1 / 2A.2 paragraphs this replaced): still promises
     * no FIXED percentage and no personal sign-off — "agreed fundraising
     * percentage" remains a per-campaign number nobody has set yet when this
     * goes out, and the voice stays the business's, never one named person's.
     * The delivery weekday (Tue/Wed/Thu) and the two-week order deadline ARE
     * named — they are true platform-wide operational facts, confirmed against
     * the live product (see the test file's header), not a guess.
     */
    'lead_intro': (name: string, orgName?: string, tenant?: TemplateTenant) => {
        const org = escapeHtml(orgName || 'your organization');
        // FR-ACCEPTANCE-2A.2 — greet by first name.
        //
        // Presentation only: the submitted name is stored and reported exactly as
        // it arrived everywhere else (the CRM, the coordinator record, the reply
        // notification). Only this greeting reads a shortened form of it.
        const greetingName = firstNameOf(name) || 'there';
        return {
            subject: safeSubject(`Let's get ${orgName || 'your group'} on the fundraiser calendar`),
            html: `
            <p>Hi ${escapeHtml(greetingName)}!</p>
            <p>Thanks for reaching out about a fundraiser for <strong>${org}</strong> — we'd love to help you get one started.</p>
            <p>Our meal fundraisers are designed to be simple: your supporters get something families already need&mdash;dinner&mdash;while every bundle sold helps support your organization.</p>
            <p>We handle the meal prep, freezing, packing, and delivery. You focus on sharing the fundraiser and getting your community involved.</p>

            <h3>The first step: let's pick your date</h3>
            <p>Everything starts with your delivery/pickup date. Our preferred delivery days are Tuesday, Wednesday, or Thursday. Just send us:</p>
            <ul>
                <li><strong>Your preferred date and time</strong></li>
                <li><strong>A backup date and time</strong></li>
            </ul>
            <p>Dates can fill up, so having a second choice usually helps us get everything confirmed quickly.</p>

            <h3>Who will coordinate the fundraiser?</h3>
            <p>We'll also need the name, email address, and phone number of the person who will be the main fundraiser coordinator. <strong>If that's you, just let us know.</strong></p>

            <h3>Then we make the rest simple</h3>
            <ol>
                <li><strong>We confirm your fundraiser.</strong> We'll finalize your date, pickup/delivery location, and your organization's fundraising percentage.</li>
                <li><strong>We give you everything you need to share it.</strong> You'll receive your own online supporter ordering page, a shareable link and QR code, plus tools to help you spread the word by text, email, social media, flyers, and group chats. Supporters can order right from their phones and easily share the fundraiser with friends, family, coworkers, and others&mdash;helping your reach grow beyond the people you see every day.</li>
                <li><strong>Your Coordinator Panel becomes your fundraiser home base.</strong> Everything you need to keep the fundraiser moving is in one place&mdash;your shareable ordering link and QR code, printable materials, supporter orders and contact information, payment tracking, goal progress, and pickup-day organization. As orders come in, the panel keeps everything together for you, so you can see who ordered, what they ordered, who has paid, and what still needs attention. When pickup day arrives, your order information is already organized into the tracking tools you need for distribution. <strong>Less paperwork. Less chasing. More time to share the fundraiser and build momentum.</strong></li>
                <li><strong>We prepare everything for pickup day.</strong> Final orders are due two weeks before delivery. Your organization keeps its agreed fundraising percentage, and we'll invoice the remaining balance shortly after the order deadline, with payment due upon receipt. Then we prepare, freeze, pack, and deliver the meals to your organization for distribution.</li>
            </ol>

            <h3>Ready to get a date on the calendar?</h3>
            <p>Just hit <strong>reply</strong> and send us:</p>
            <ol>
                <li><strong>Your preferred delivery date and time</strong></li>
                <li><strong>Your backup date and time</strong></li>
                <li><strong>Your coordinator's name, email, and phone number</strong> &mdash; or simply tell us it will be you</li>
            </ol>
            <p><strong>We'll take it from there.</strong></p>

            ${signature(tenant)}
        `,
        };
    },
    'thank_you': (name: string, orgName?: string, tenant?: TemplateTenant) => ({
        subject: `Congratulations on a Successful Fundraiser!`,
        html: `
            <p>Hi ${escapeHtml(name || 'there')}!</p>
            <p>Congratulations again on a fantastic fundraiser for <strong>${escapeHtml(orgName || 'your organization')}</strong>! It was a pleasure working with you to bring delicious, stress-free meals to your community.</p>
            <p>We hope everyone is enjoying their meals. We'd love to help you reach your next goal—it's never too early to get a tentative date on the calendar for your next round!</p>

            <p><strong>Could you help us out?</strong><br>
            If you loved your experience, would you mind sharing a brief testimonial? We’d love to feature your success so other groups can see how easy fundraising can be.</p>

            <p>Just reply to this email with your thoughts!</p>

            ${signature(tenant)}
        `,
    }),
};

/**
 * FR-ACCEPTANCE-2A — the coordinator's setup invitation.
 *
 * THE SECURE LINK IS THE HREF AND NOTHING ELSE.
 *
 * The coordinator credential lives in the URL fragment
 * (`/coordinator/access#<credential>`), which browsers never transmit — that
 * is the whole of FR-COORD-SEC. Two rules follow and both are load-bearing:
 *
 *   1. The raw URL is NEVER printed as visible text. A coordinator who can
 *      see a secret can paste it into a chat, and a support screenshot
 *      becomes a credential leak. They see a button.
 *   2. There is no plain-text alternative offered anywhere in this body for
 *      the same reason.
 *
 * A separate operator gate applies before this ships: provider click
 * tracking rewrites hrefs through a redirect host, which would carry the
 * fragment into a query string and into that host's logs. That must be off.
 */
export const coordinatorSetupTemplate = (
    coordinatorName: string,
    orgName: string,
    setupUrl: string,
    tenant?: TemplateTenant
) => ({
    // FR-ACCEPTANCE-2A.1: the organization name leads.
    //
    // "Your ${orgName} fundraiser…" reads fine for "Oak Ridge PTO" and badly for
    // any name that already starts with an article — "Your The Best Brew Test 3
    // fundraiser is ready to set up". Dropping the possessive costs nothing and
    // fixes every such name at once.
    //
    // safeSubject still strips control characters, and its trim() now governs
    // the first character rather than the literal "Your ".
    subject: safeSubject(`${orgName} fundraiser is ready to set up`),
    html: `
        <p>Hi ${escapeHtml(coordinatorName || 'there')}!</p>
        <p>Good news — the fundraiser for <strong>${escapeHtml(orgName)}</strong> is set up on our end and ready for you to finish.</p>

        <p>There are two things to do, and they take a few minutes:</p>
        <ol>
            <li><strong>Choose your meal bundles</strong> — pick the options your families will be able to order.</li>
            <li><strong>Confirm the remaining details</strong> — pickup time, location, and how your supporters will pay.</li>
        </ol>

        <p>Once that is done you will have your coordinator panel, where you can share the fundraiser and watch orders arrive as they come in.</p>

        <p style="margin: 28px 0;">
            <a href="${escapeHtml(setupUrl)}" style="background:#4f46e5;color:#ffffff;padding:14px 24px;border-radius:10px;font-weight:bold;text-decoration:none;display:inline-block;">Select Bundles &amp; Set Up Fundraiser</a>
        </p>

        <p style="font-size:13px;color:#64748b;">This link is personal to you — please don't forward it.</p>

        ${signature(tenant)}
    `,
});
