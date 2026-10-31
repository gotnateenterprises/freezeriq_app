/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0 — the re-invitation a previous supporter actually receives.
 *
 * ── WHO vs WHAT ─────────────────────────────────────────────────────────────
 *
 * Historical orders decide WHO is invited (lib/previousSupporters.ts). This module
 * decides WHAT they read, and every fact in it comes from the CURRENT campaign:
 * the bundle lineup, the ordering deadline, the pickup date/time/location and the
 * canonical ordering URL (lib/fundraiserCanonicalUrl.ts — the same URL the
 * supporter page, the coordinator dashboard, the QR code and the flyer use). No
 * previous campaign's date, token or bundle can reach a draft, because nothing
 * from a previous campaign is ever passed in.
 *
 * ── THREE LAYERS, ONE OWNER EACH ────────────────────────────────────────────
 *
 *   1. The greeting — "Hi Jamie," — per recipient, from THAT recipient's own
 *      record. The coordinator never types it, so it cannot be copied wrongly
 *      from one supporter to another.
 *   2. The coordinator's message — plain text they may rewrite freely. It is
 *      escaped, never interpreted, and it cannot move the ordering link.
 *   3. The campaign facts and the "View Meals & Order" link — rendered here from
 *      server data, BELOW the coordinator's words. Deleting or editing a sentence
 *      in the message changes neither where the link points nor when ordering
 *      really closes.
 *
 * The unsubscribe footer is a fourth layer and is not here at all: the send
 * engine (lib/outreachSend.ts) appends it to the OUTPUT of this renderer.
 *
 * ── TWO WAYS THE SAME MESSAGE LEAVES (PREVIOUS-SUPPORTER-EMAIL-2.0A) ────────
 *
 *   "Open in my email"  buildPersonalMailto — a mailto: draft for ONE supporter that
 *                       opens in the coordinator's own mail app; they review and send
 *                       it from their own mailbox. FreezerIQ sends nothing. Since
 *                       2.0B it, too, carries the organization's mailing address and
 *                       is not built without one.
 *   automated send      renderPreviousSupporterEmail — FreezerIQ delivers it, so the
 *                       ORGANIZATION is presented as the sender ("{Org} via {tenant}",
 *                       from the platform's verified address) and its mailing address
 *                       and the delivery relationship are stated in the footer. Who
 *                       may receive it is decided in lib/previousSupporterAuthorities.
 *
 * SERVER-SIDE (node:crypto for the opaque supporter reference).
 */
import { createHash } from 'crypto';
import { firstNameOf } from '@/lib/personName';
import { safeSubject } from '@/lib/emailTemplates';
import { normalizeSupporterEmail } from '@/lib/previousSupporters';
import { mailingAddressLines, type OrganizationMailingAddress } from '@/lib/previousSupporterAuthorities';

/** The button label in the HTML part. The plain-text part always carries the URL itself. */
export const PREVIOUS_SUPPORTER_CTA_LABEL = 'View Meals & Order';

/**
 * The literal the confirmation button posts. A POST without it sends nothing, so an
 * old browser tab (which posted only a subject and a message to mean "send to
 * everyone") or any stray request cannot start a send.
 */
export const PREVIOUS_SUPPORTER_SEND_CONFIRMATION = 'send_individual_emails';

/** Upper bound on one send request's selection. */
export const PREVIOUS_SUPPORTER_SELECTION_MAX = 500;

export interface InvitationPickup {
    /** "Thursday, November 19" — the campaign's own delivery_date, or null. */
    dateLabel: string | null;
    /** The campaign's own free-text pickup time, or null. */
    time: string | null;
    /** The campaign's own pickup location, or null. */
    location: string | null;
}

/** Everything a re-invitation states, all from the CURRENT campaign. */
export interface InvitationFacts {
    organizationName: string;
    /** Menu (bundle family) names in campaign selection order. Empty = no lineup line. */
    bundleNames: string[];
    /** "Tuesday, November 17" — the campaign's end_date, or null. */
    deadlineLabel: string | null;
    pickup: InvitationPickup;
    /** The canonical supporter ordering URL. */
    orderUrl: string;
}

/**
 * Who an AUTOMATED email presents as its sender. The organization running the
 * fundraiser is the designated sender; the tenant (Business.name — the same
 * authority getTenantSender uses for the From header) is the service that delivers
 * it. The mailing address is the organization's, never the pickup location.
 */
export interface InvitationSender {
    organizationName: string;
    tenantName: string;
    mailingAddress: OrganizationMailingAddress;
}

// ── Identity of one supporter inside one campaign ───────────────────────────

/**
 * The opaque handle the coordinator's browser uses to say "this supporter".
 *
 * Derived from the campaign and the normalized address, so it is stable across
 * page loads, means nothing outside this campaign, and carries no address. The
 * server never trusts it as identity: it only ever looks it up inside the
 * audience it has just recomputed from the coordinator's own session, so a
 * forged or foreign reference matches nobody.
 */
export function previousSupporterRef(campaignId: string, normalizedEmail: string): string {
    const digest = createHash('sha256')
        .update(`previous-supporter:${campaignId}:${normalizedEmail}`)
        .digest('hex');
    return `ps_${digest.slice(0, 24)}`;
}

const REF_PATTERN = /^ps_[a-f0-9]{24}$/;

export function isPreviousSupporterRef(value: unknown): value is string {
    return typeof value === 'string' && REF_PATTERN.test(value);
}

/**
 * Whether an address is plain enough to be a single recipient, and nothing else.
 *
 * Stricter than normalizeSupporterEmail on purpose. That rule decides who COUNTS as
 * reachable and is shared with the organization dashboard; this one decides who
 * FreezerIQ will actually write to, so anything that could be read as a second
 * address, a header, a parameter or a list (`,` `;` `?` `&` `%` `<` `>` quotes,
 * whitespace, control characters) is refused rather than repaired. A refused
 * address is reported as "not usable", never guessed at.
 */
export function isSendableSupporterAddress(email: string | null | undefined): boolean {
    if (typeof email !== 'string') return false;
    if (normalizeSupporterEmail(email) !== email) return false;
    if (email.length > 254 || email.includes('..')) return false;
    return /^[a-z0-9](?:[a-z0-9._+'-]{0,62}[a-z0-9_+'-])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(email);
}

// ── Personalization ─────────────────────────────────────────────────────────

const GREETING_STOP_WORDS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'rev', 'prof', 'sir', 'the', 'previous']);

/**
 * Every C0/C1 control, DEL, and the Unicode line/paragraph separators. Built from
 * escapes (as lib/emailTemplates does) so the source holds no raw control bytes.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
/** The same, minus newline: the coordinator's paragraphs survive. */
const MESSAGE_CONTROL_CHARS = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
/** A letter, then letters, apostrophes or hyphens — up to 40. Constructed, so the `u` flag works on this TS target. */
const PLAIN_NAME = new RegExp("^\\p{L}[\\p{L}'\\u2019-]{0,39}$", 'u');

/**
 * The first name to greet ONE supporter by, or null for the neutral greeting.
 *
 * firstNameOf (lib/personName) takes the first word. On top of that, a word that is
 * a title or an article ("Mrs", "The"), carries digits or an @, or is not a plain
 * name is refused, because "Hi Mrs," or "Hi 555-0100," is worse than "Hi there,".
 * The fallback label the derivation uses for a nameless order ("Previous supporter")
 * is never a name.
 */
export function supporterGreetingName(displayName: string | null | undefined): string | null {
    const clean = String(displayName ?? '').replace(CONTROL_CHARS, ' ').trim();
    if (!clean || clean.toLowerCase() === 'previous supporter') return null;
    const first = (firstNameOf(clean) ?? '').replace(/[.,;:!]+$/, '');
    if (!PLAIN_NAME.test(first)) return null;
    if (GREETING_STOP_WORDS.has(first.toLowerCase())) return null;
    // "JAMIE" and "jamie" both become "Jamie"; a deliberate "DeShawn" is left alone.
    if (first === first.toLowerCase() || first === first.toUpperCase()) {
        return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }
    return first;
}

export function greetingLine(name: string | null): string {
    return name ? `Hi ${name},` : 'Hi there,';
}

// ── The coordinator's editable defaults ─────────────────────────────────────

function organizationLabel(name: string | null | undefined): string {
    return oneLine(name, 120) || 'our organization';
}

/** One strong default — not a menu of templates. Calm, specific, not a marketing blast. */
export function defaultInvitationSubject(organizationName: string | null | undefined): string {
    return safeSubject(`${organizationLabel(organizationName)} fundraiser is back — ordering is open`);
}

export function defaultInvitationMessage(organizationName: string | null | undefined): string {
    const org = organizationLabel(organizationName);
    return `Thank you again for supporting ${org}!\n\n`
        + `Our fundraiser is back and ordering is now open, and we'd love to have your support again.`;
}

/**
 * Refuses a message that would hand supporters a private link.
 *
 * The coordinator portal link carries the coordinator's own login, and a Vercel
 * deployment link is never a supporter destination. Neither can retarget the
 * system "View Meals & Order" link, but either one pasted into a message that
 * goes to forty people is a credential leak or a dead end — so the send is
 * refused with an explanation instead.
 */
export function findPrivateLinkInMessage(subject: string, text: string): string | null {
    const all = `${subject}\n${text}`.toLowerCase();
    if (/\/coordinator(\/|\b)|portal_token|coordinator\/access/.test(all)) {
        return 'Your message contains a coordinator portal link, which is your private login. Remove it — FreezerIQ adds the supporter ordering link to every email for you.';
    }
    if (/vercel\.app|_vercel_share|_vercel_jwt/.test(all)) {
        return 'Your message contains a temporary preview link that supporters cannot use. Remove it — FreezerIQ adds the supporter ordering link to every email for you.';
    }
    return null;
}

// ── The system-controlled facts block ───────────────────────────────────────

/** A free-text campaign value as ONE safe line: no newlines, no controls, bounded. */
function oneLine(value: unknown, max = 200): string {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/\r\n?|\n/g, ', ')
        .replace(CONTROL_CHARS, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[,\s]+|[,\s]+$/g, '')
        .slice(0, max)
        .trim();
}

export interface InvitationFactSections {
    offering: string[];
    deadline: string | null;
    pickup: string[];
}

/** The facts, flattened and with every absent value omitted — never "null", never "TBD". */
export function invitationFactSections(facts: InvitationFacts): InvitationFactSections {
    const offering = (facts.bundleNames ?? []).map((n) => oneLine(n, 120)).filter(Boolean);
    const pickup = [facts.pickup?.dateLabel, facts.pickup?.time, facts.pickup?.location]
        .map((v) => oneLine(v))
        .filter(Boolean);
    return { offering, deadline: oneLine(facts.deadlineLabel) || null, pickup };
}

/** An absolute https URL (http only for local development), or null. */
function safeOrderUrl(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    try {
        const u = new URL(raw.trim());
        const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
        if (u.username || u.password) return null;
        return u.toString();
    } catch {
        return null;
    }
}

const esc = (s: string) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The coordinator's text with Windows line endings and controls removed, newlines kept. */
function cleanMessage(text: string): string {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(MESSAGE_CONTROL_CHARS, ' ')
        .trim();
}

/** The shared body: greeting, the coordinator's message, the current facts, the link, the thanks. */
function invitationTextLines(input: { greeting: string; message: string; facts: InvitationFacts; url: string }): string[] {
    const f = invitationFactSections(input.facts);
    const org = organizationLabel(input.facts.organizationName);
    const text: string[] = [input.greeting, ''];
    if (input.message) text.push(input.message, '');
    if (f.offering.length) text.push(`This round we're offering:`, ...f.offering.map((n) => `• ${n}`), '');
    if (f.deadline) text.push(`Ordering ends: ${f.deadline}`, '');
    if (f.pickup.length) text.push('Pickup:', ...f.pickup, '');
    text.push(`You can view this round's meals and place your order here:`, input.url, '');
    text.push(`Thank you for supporting ${org}!`);
    return text;
}

/** "Sent on behalf of {org} using {tenant} fundraising services." — the delivery relationship, stated. */
export function deliveryDisclosure(sender: Pick<InvitationSender, 'organizationName' | 'tenantName'>): string {
    return `Sent on behalf of ${organizationLabel(sender.organizationName)} using ${oneLine(sender.tenantName, 120) || 'FreezerIQ'} fundraising services.`;
}

/**
 * ONE supporter's AUTOMATED email, rendered by the server.
 *
 * Returns null without a usable ordering URL or without a complete sender (the
 * organization's name and mailing address): an invitation with no way to order is
 * not worth sending, and one without its sender's address may not be sent. The
 * caller refuses rather than mailing either. There is exactly one addressee per
 * call — this function has no recipient list to leak, and the greeting is the only
 * per-person value in the result.
 */
export function renderPreviousSupporterEmail(input: {
    greetingName: string | null;
    subject: string;
    message: string;
    facts: InvitationFacts;
    sender: InvitationSender | null;
}): { subject: string; html: string; text: string } | null {
    const url = safeOrderUrl(input.facts?.orderUrl);
    if (!url) return null;
    const senderOrg = oneLine(input.sender?.organizationName, 120);
    const address = input.sender?.mailingAddress ? mailingAddressLines(input.sender.mailingAddress).map((l) => oneLine(l, 120)).filter(Boolean) : [];
    if (!input.sender || !senderOrg || address.length < 2) return null;

    const org = organizationLabel(input.facts.organizationName);
    const greeting = greetingLine(input.greetingName ? supporterGreetingName(input.greetingName) : null);
    const message = cleanMessage(input.message);
    const f = invitationFactSections(input.facts);
    const disclosure = deliveryDisclosure(input.sender);

    // ── Plain text ────────────────────────────────────────────────────────
    const text = invitationTextLines({ greeting, message, facts: input.facts, url });
    text.push('', '--', senderOrg, ...address, '', disclosure);

    // ── HTML — every variable escaped; the only tags are the ones written here ──
    const P = 'margin:0 0 16px;';
    const html: string[] = [`<p style="${P}">${esc(greeting)}</p>`];
    for (const para of message.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
        html.push(`<p style="${P}">${esc(para).replace(/\n/g, '<br />')}</p>`);
    }
    if (f.offering.length) {
        html.push(`<p style="margin:0 0 6px;">This round we&#39;re offering:</p>`
            + `<ul style="margin:0 0 16px;padding-left:20px;">${f.offering.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`);
    }
    if (f.deadline) html.push(`<p style="${P}"><strong>Ordering ends:</strong> ${esc(f.deadline)}</p>`);
    if (f.pickup.length) {
        html.push(`<p style="${P}"><strong>Pickup:</strong><br />${f.pickup.map(esc).join('<br />')}</p>`);
    }
    html.push(`<p style="margin:0 0 12px;">You can view this round&#39;s meals and place your order here:</p>`
        + `<p style="margin:0 0 8px;"><a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;`
        + `padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">${esc(PREVIOUS_SUPPORTER_CTA_LABEL)}</a></p>`
        + `<p style="margin:0 0 16px;font-size:13px;"><a href="${esc(url)}" style="color:#4f46e5;">${esc(url)}</a></p>`);
    html.push(`<p style="${P}">Thank you for supporting ${esc(org)}!</p>`);
    html.push(`<p style="margin:24px 0 0;color:#64748b;font-size:13px;"><strong>${esc(senderOrg)}</strong><br />`
        + `${address.map(esc).join('<br />')}</p>`
        + `<p style="margin:8px 0 0;color:#64748b;font-size:12px;">${esc(disclosure)}</p>`);

    return {
        subject: safeSubject(input.subject),
        html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;`
            + `color:#0f172a;max-width:620px;">\n${html.join('\n')}\n</div>`,
        text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    };
}

// ── Sender identity for AUTOMATED email ─────────────────────────────────────

/**
 * `"{Organization} via {tenant}" <platform address>`.
 *
 * The address is taken, unchanged, from the platform sender FreezerIQ already
 * uses (lib/email.getTenantSender — the verified EMAIL_FROM address); only the
 * display name changes, so no organization's domain is ever claimed. The name is
 * quoted, with quotes, backslashes, angle brackets and controls removed, so a
 * comma or colon in an organization's name cannot split the header.
 */
export function organizationFromHeader(input: {
    organizationName: string | null | undefined;
    tenantName: string | null | undefined;
    platformFrom: string | null | undefined;
}): string | null {
    const raw = String(input.platformFrom ?? '').trim();
    const address = (raw.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] ?? (/^[^<>\s"]+@[^<>\s"]+$/.test(raw) ? raw : '')).trim();
    if (!address) return null;
    const clean = (s: unknown) => oneLine(s, 100).replace(/["\\<>]/g, '').trim();
    const org = clean(input.organizationName);
    const tenant = clean(input.tenantName);
    if (!org || !tenant) return null;
    return `"${org} via ${tenant}" <${address}>`;
}

/** Any control character (non-global, so .test carries no state between calls). */
const HEADER_CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/**
 * A Reply-To value only when it is one plain address — no list, no display name,
 * no header characters. Anything else is refused so the caller falls back.
 */
export function headerSafeReplyTo(raw: string | null | undefined): string | null {
    const v = String(raw ?? '').trim();
    if (!v || v.length > 254 || !normalizeSupporterEmail(v)) return null;
    if (/[\s,;<>"()\\]/.test(v) || HEADER_CONTROL.test(v)) return null;
    return v;
}

// ── "Open in my email" — the coordinator's own mailbox ──────────────────────

/** Said in the personal draft, because the coordinator — not FreezerIQ — is writing to them. */
export const PERSONAL_OPT_OUT_LINE = "If you'd rather not receive future fundraiser emails from us, just reply and let us know.";

/** The personal draft's footer heading: plain about what the email is and who it is from. */
export function solicitationLine(organizationName: string | null | undefined): string {
    return `Fundraiser solicitation from ${organizationLabel(organizationName)}`;
}

/**
 * A mailto: draft for ONE previous supporter, for the coordinator's own mail app.
 *
 * Only `to` is the supporter's address, and only when it is a plain single address
 * (isSendableSupporterAddress), so it can never smuggle a second recipient, a CC or
 * a header. The subject is header-safe; the body is the same greeting, message,
 * current facts and canonical link as the automated email, then (2.0B) a footer
 * that says plainly it is a fundraiser solicitation from the organization, gives
 * the ORGANIZATION's mailing address, and invites them to say no to future
 * contact. No organization name or complete address, no draft. Line breaks are
 * %0D%0A, as RFC 6068 asks. FreezerIQ sends nothing — and records nothing as
 * sent — when this is opened.
 */
export function buildPersonalMailto(input: {
    to: string | null | undefined;
    greetingName: string | null;
    subject: string;
    message: string;
    facts: InvitationFacts;
    sender: { organizationName: string; mailingAddress: OrganizationMailingAddress } | null;
}): string | null {
    if (!isSendableSupporterAddress(input.to)) return null;
    const url = safeOrderUrl(input.facts?.orderUrl);
    if (!url) return null;
    const senderOrg = oneLine(input.sender?.organizationName, 120);
    const address = input.sender?.mailingAddress ? mailingAddressLines(input.sender.mailingAddress).map((l) => oneLine(l, 120)).filter(Boolean) : [];
    if (!senderOrg || address.length < 2) return null;
    const greeting = greetingLine(input.greetingName ? supporterGreetingName(input.greetingName) : null);
    const lines = invitationTextLines({ greeting, message: cleanMessage(input.message), facts: input.facts, url });
    lines.push('', '--', solicitationLine(senderOrg), ...address, '', PERSONAL_OPT_OUT_LINE);
    const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().replace(/\n/g, '\r\n');
    return `mailto:${input.to}?subject=${encodeURIComponent(safeSubject(input.subject))}&body=${encodeURIComponent(body)}`;
}