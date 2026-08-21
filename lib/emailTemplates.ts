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
    /** The tenant's business name. Never blank. */
    name: string;
    /** Reply address, when the tenant has configured one. */
    email?: string;
    /** Absolute URL of the tenant's storefront, when they have a slug. */
    site?: string;
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
        lines.push(`<a href="${escapeHtml(tenant.site)}">${escapeHtml(tenant.site)}</a>`);
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
     * It promises no percentage, no delivery weekday, and no unloading time.
     * Those are the tenant's to set and the platform cannot vouch for them.
     */
    'lead_intro': (name: string, orgName?: string, tenant?: TemplateTenant) => {
        const org = escapeHtml(orgName || 'your organization');
        return {
            subject: `Let's get ${orgName || 'your group'} a fundraiser date`,
            html: `
            <p>Hi ${escapeHtml(name || 'there')}!</p>
            <p>Thank you for asking about a fundraiser for <strong>${org}</strong> — I'd love to help.</p>
            <p>A meal fundraiser is an easy one to run: families are going to eat dinner anyway, so you are not asking anyone to buy something they do not need. We handle the cooking, the packing and the sorting, and your volunteers hand out boxes.</p>

            <h3>The next step is picking a date</h3>
            <p>Almost everything else follows from the delivery day, so that is the piece worth settling first.</p>
            <ul>
                <li><strong>A preferred date</strong> — the delivery or pickup day that suits ${org} best.</li>
                <li><strong>A backup date</strong> — delivery days fill up, and having a second option usually saves a week of back-and-forth.</li>
            </ul>

            <h3>What happens after that</h3>
            <ol>
                <li><strong>We confirm the details</strong> — your date, your delivery location, and what your organization earns.</li>
                <li><strong>You get everything you need to share it</strong> — flyers and order forms, your own online order page, and a coordinator dashboard for watching orders arrive in real time.</li>
                <li><strong>Delivery day</strong> — we bring the meals to you and your families collect them.</li>
            </ol>

            <p><strong>Which dates are you thinking about?</strong><br>
            Just reply with a preferred day and a backup, and I'll check what's open.</p>

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
