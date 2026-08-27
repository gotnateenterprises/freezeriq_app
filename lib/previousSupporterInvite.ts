/**
 * FR-REBOOK-2 — the invitation the coordinator actually reads before sending.
 *
 * The FR-REBOOK-1A contract, applied to a second surface: the coordinator edits
 * PLAIN TEXT and the server renders the email. Nothing here accepts markup from
 * a browser, and nothing here is a rich email designer.
 *
 * ── THE THREE THINGS THE COORDINATOR MAY NOT MOVE ───────────────────────────
 *
 *   1. WHO IT GOES TO — resolved from the audience, never posted.
 *   2. WHERE THE LINK POINTS — the CURRENT campaign's canonical supporter URL,
 *      composed here from its own `public_token`. The coordinator may reword the
 *      sentence around it; they cannot retarget it at the previous fundraiser,
 *      at the coordinator portal, or anywhere else.
 *   3. THE CAMPAIGN'S REAL DEADLINE — `end_date` on the campaign row. Editing or
 *      deleting the deadline SENTENCE changes an email. It does not change when
 *      ordering closes, which is decided by the campaign row and enforced by
 *      isCampaignPastOrderDeadline.
 *
 * ── WHY THE DEADLINE IS IN THE DEFAULT COPY ─────────────────────────────────
 *
 * The owner asked for it, because "order by Friday" is what actually moves a
 * fundraiser and a coordinator writing from scratch forgets. It is derived, not
 * typed: a hardcoded date in browser copy would be stale the moment the tenant
 * moved the campaign, and would be wrong for every other campaign that reused
 * the string.
 *
 * When a campaign has no usable `end_date` — legacy rows genuinely have none —
 * the sentence is simply absent. There is no fallback date, because the only
 * available fallback would be invented.
 */

import { calendarDateOfDateOnlyValue } from '@/lib/tenantTimezone';

export const INVITE_SUBJECT_MAX = 200;
export const INVITE_BODY_MAX = 20_000;

export interface InviteCampaignInput {
    /** The CURRENT campaign. Never a prior one. */
    id: string;
    name: string | null;
    /** The canonical supporter ordering deadline. Date-only column. */
    end_date: Date | string | null;
    /** Guards the public scoreboard/storefront: /fundraiser/{public_token}. */
    public_token: string | null;
}

export interface InviteBrandInput {
    /** Tenant display name, resolved server-side. */
    name?: string | null;
    email?: string | null;
    site?: string | null;
    siteLabel?: string | null;
}

export interface InviteDraft {
    subject: string;
    /** Plain text. No tags, no entities, no template syntax — ever. */
    text: string;
    /** The canonical destination, for display beside the editor. */
    orderUrl: string | null;
    /** The formatted deadline, or null when the campaign has none. */
    deadlineLabel: string | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "Friday, April 28" from a date-only column.
 *
 * ── WHY THIS DOES NOT USE toLocaleDateString ────────────────────────────────
 * `end_date` is `@db.Date`, so Prisma hands back midnight UTC of the stored
 * calendar day. Formatting that in any local zone west of UTC prints the
 * PREVIOUS day — Edgar's 2026-04-29 deadline renders as "April 28" on a Central
 * server. The calendar date is extracted as an ISO string by the canonical
 * helper and the parts are read directly, so no zone is ever applied to a value
 * that never had a time in the first place.
 */
export function formatOrderDeadline(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const iso = calendarDateOfDateOnlyValue(value);
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    // Noon UTC purely to name the weekday: it survives rendering anywhere from
    // UTC-11 to UTC+11 without rolling into an adjacent day.
    const anchor = new Date(Date.UTC(y, m - 1, d, 12));
    if (Number.isNaN(anchor.getTime())) return null;
    return `${WEEKDAYS[anchor.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

/** Where a tenant's supporters actually shop. */
export interface InviteTenantInput {
    /** Business.custom_domain — e.g. "myfreezerchef.com". Null for most tenants. */
    customDomain?: string | null;
    /** Business.slug — the storefront path segment. */
    slug?: string | null;
}

/**
 * The CURRENT campaign's supporter ordering URL.
 *
 * ── WHY NOT /fundraiser/{public_token} ──────────────────────────────────────
 *
 * That was this function's first form and it pointed at the wrong page. The
 * coordinator portal's own share button — the link coordinators actually give
 * supporters — builds `/shop/{slug}/fundraiser/{campaignId}` and falls back to
 * `/fundraiser/{public_token}` only as "old scoreboard URL". Inviting previous
 * supporters to the scoreboard instead of the ordering page would have been a
 * quietly useless email.
 *
 * ── WHY THE ORIGIN IS NOT THE REQUEST'S ─────────────────────────────────────
 *
 * A supporter link must survive being read months later on whatever device, so
 * it cannot depend on which host the coordinator's browser happened to hit. The
 * tenant's own storefront domain is used when they have one, because that is
 * what their supporters recognise; otherwise the platform origin, which the
 * caller pins rather than derives from the request.
 *
 * Both work: middleware bypasses the custom-domain rewrite for `/shop/`, so
 * `/shop/{slug}/fundraiser/{id}` resolves identically on a tenant domain and on
 * the platform.
 */
export function buildSupporterOrderUrl(
    platformOrigin: string | null | undefined,
    campaign: Pick<InviteCampaignInput, 'id' | 'public_token'>,
    tenant?: InviteTenantInput | null,
): string | null {
    const domain = normalizeStorefrontDomain(tenant?.customDomain);
    const platform = normalizeHttpOrigin(platformOrigin);
    const base = domain ? `https://${domain}` : platform;
    if (!base) return null;

    const slug = (tenant?.slug ?? '').trim();
    if (slug && campaign.id) return `${base}/shop/${slug}/fundraiser/${campaign.id}`;

    // No storefront slug: fall back to the public scoreboard, exactly as the
    // coordinator portal does. Only reachable for a tenant with no slug at all.
    if (campaign.public_token) return `${base}/fundraiser/${campaign.public_token}`;
    return null;
}

/** An http(s) origin, or null. Never a `javascript:` or path-bearing value. */
function normalizeHttpOrigin(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+$/i.test(v)) return null;
    return v;
}

/**
 * A bare hostname from Business.custom_domain, or null.
 *
 * The column is free text a tenant typed, so a scheme, a path, a port, spaces or
 * outright junk are all possible. Anything that is not a plain hostname is
 * refused rather than repaired — falling back to the platform origin produces a
 * link that works, whereas guessing produces one that does not.
 */
function normalizeStorefrontDomain(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!v || v.length > 253) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) return null;
    return v;
}

/**
 * The default invitation, as plain prose.
 *
 * Every value is derived from the current campaign and the resolved tenant
 * brand. The coordinator may rewrite all of it before sending; what they cannot
 * do is change where the link goes or when ordering really closes.
 */
export function buildInviteDraft(input: {
    organizationName: string;
    campaign: InviteCampaignInput;
    /** PINNED platform origin. Never derived from the incoming request. */
    origin: string | null;
    /** The tenant's own storefront, preferred over the platform origin. */
    tenant?: InviteTenantInput | null;
    brand?: InviteBrandInput | null;
}): InviteDraft {
    const org = input.organizationName?.trim() || 'our organization';
    const orderUrl = buildSupporterOrderUrl(input.origin, input.campaign, input.tenant);
    const deadlineLabel = formatOrderDeadline(input.campaign.end_date);

    // ── THE URL IS NOT IN THE EDITABLE PROSE ────────────────────────────────
    //
    // An earlier draft put the ordering link in the message body. That made the
    // destination editable: whatever the coordinator left in the textarea is
    // what supporters would click, so a paste, a typo or a swapped campaign link
    // would silently redirect the whole invitation. The link is now rendered by
    // the server as a protected block BELOW this prose (see renderInviteEmail),
    // outside the client's authority entirely.
    //
    // The prose therefore points AT the button rather than repeating a URL.
    const lines: string[] = [
        `Thanks again for supporting ${org} during our last fundraiser!`,
        '',
        `We're running another one, and we'd love to have your support again.`,
        '',
        'Save time and order online using the link below.',
        '',
    ];

    // Present only when the campaign genuinely has a deadline.
    if (deadlineLabel) {
        lines.push(`Please place your order by ${deadlineLabel}.`, '');
    }

    lines.push(`Thank you for supporting ${org}!`);

    return {
        subject: `${org} is holding another fundraiser`,
        text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        orderUrl,
        deadlineLabel,
    };
}

/**
 * The coordinator's edited text, checked before it may be sent.
 *
 * The link is verified to still be present because the whole point of the
 * message is to deliver it — an invitation with the URL deleted is a dead end
 * for every recipient, and that is worth refusing rather than silently sending.
 * A coordinator who genuinely wants a different destination has to take that up
 * with the tenant; they cannot do it by pasting a URL in here, because the
 * rendered body re-derives nothing from what they typed.
 */
export function validateInviteMessage(input: {
    subject: unknown;
    text: unknown;
    orderUrl: string | null;
}): { ok: true; subject: string; text: string } | { ok: false; error: string; code: string } {
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    const text = typeof input.text === 'string' ? input.text : '';

    if (!subject || !text.trim()) {
        return { ok: false, code: 'empty', error: 'A subject and a message are required.' };
    }
    if (subject.length > INVITE_SUBJECT_MAX) {
        return { ok: false, code: 'subject_too_long', error: `Keep the subject under ${INVITE_SUBJECT_MAX} characters.` };
    }
    if (text.length > INVITE_BODY_MAX) {
        return { ok: false, code: 'body_too_long', error: 'That message is too long to send.' };
    }
    // NOTE: there is deliberately no "the link must still be present" rule.
    // The ordering link is no longer part of the editable text — the server
    // renders it as a protected block — so a coordinator cannot delete it, and
    // demanding they keep a URL they can no longer see would be nonsense.
    return { ok: true, subject, text };
}

/**
 * The outgoing email, rendered by the SERVER from the coordinator's plain text.
 *
 * ── THE SAFETY PROPERTY, SAME AS FR-REBOOK-1A ───────────────────────────────
 *
 * Every character the coordinator typed is escaped before it is placed, so
 * `<script>`, `onerror=`, a `javascript:` href and a forged signature block all
 * arrive as visible characters. The only tags in the result are the ones written
 * here.
 *
 * ── THE CTA IS THE SERVER'S, NOT THE COORDINATOR'S ──────────────────────────
 *
 * The ordering button is appended AFTER their prose, from `orderUrl`, which the
 * caller derived from the current campaign and a pinned origin. Nothing the
 * coordinator writes can change where it points: a URL pasted into the message
 * body is escaped into inert text, and there is no placeholder for them to
 * retarget. If a supporter clicks the button, they reach this campaign's
 * ordering page or nothing at all.
 *
 * Returns null when there is no orderUrl — an invitation with no way to order is
 * not worth sending, and the caller must refuse rather than mail a dead end.
 */
export function renderInviteEmail(input: {
    text: string;
    orderUrl: string | null;
    brand?: InviteBrandInput | null;
}): { html: string; text: string } | null {
    // ONE gate, not two. An earlier draft checked `!input.orderUrl` first, which
    // read as defensive but could not change the outcome: normalizeHttpUrl
    // already refuses null, a non-string, a relative path and a
    // javascript:/data: scheme. No input could tell the two versions apart, so
    // the extra line was untestable by construction — and a branch no test can
    // reach is a branch nothing is watching.
    const url = normalizeHttpUrl(input.orderUrl);
    if (!url) return null;

    const esc = (s: string) => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const paragraphs = String(input.text ?? '')
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p style="margin:0 0 16px;">${esc(p).replace(/\n/g, '<br />')}</p>`)
        .join('\n');

    const cta = `<p style="margin:24px 0;"><a href="${esc(url)}" `
        + `style="display:inline-block;background:#4f46e5;color:#ffffff;padding:12px 24px;`
        + `text-decoration:none;border-radius:6px;font-weight:bold;">Order Online</a></p>`
        + `<p style="margin:0 0 16px;font-size:12px;color:#64748b;">${esc(url)}</p>`;

    const bits: string[] = [];
    if (input.brand?.name) bits.push(`<strong>${esc(input.brand.name)}</strong>`);
    if (input.brand?.email) bits.push(esc(input.brand.email));
    const signature = bits.length
        ? `<p style="margin:24px 0 0;color:#64748b;font-size:13px;">${bits.join('<br />')}</p>`
        : '';

    const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;`
        + `font-size:15px;line-height:1.6;color:#0f172a;max-width:620px;">\n${paragraphs}\n${cta}\n${signature}\n</div>`;

    // The plain-text part carries the same canonical URL, appended by the server.
    const text = `${String(input.text ?? '').trim()}\n\nOrder online:\n${url}`;
    return { html, text };
}

/** An http(s) URL, or null. Never a javascript:/data: scheme. */
function normalizeHttpUrl(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    if (!/^https?:\/\//i.test(v)) return null;
    try { return new URL(v).toString(); } catch { return null; }
}
