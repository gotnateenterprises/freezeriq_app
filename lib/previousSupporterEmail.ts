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
 * SERVER-SIDE (node:crypto for the opaque supporter reference).
 */
import { createHash } from 'crypto';
import { firstNameOf } from '@/lib/personName';
import { safeSubject } from '@/lib/emailTemplates';
import { normalizeSupporterEmail } from '@/lib/previousSupporters';

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

export interface InvitationBrand {
    name?: string | null;
    email?: string | null;
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

/**
 * ONE supporter's email, rendered by the server.
 *
 * Returns null without a usable ordering URL: an invitation with no way to order
 * is not worth sending, and the caller refuses rather than mailing a dead end.
 * There is exactly one addressee per call — this function has no recipient list
 * to leak, and the greeting is the only per-person value in the result.
 */
export function renderPreviousSupporterEmail(input: {
    greetingName: string | null;
    subject: string;
    message: string;
    facts: InvitationFacts;
    brand?: InvitationBrand | null;
}): { subject: string; html: string; text: string } | null {
    const url = safeOrderUrl(input.facts?.orderUrl);
    if (!url) return null;

    const org = organizationLabel(input.facts.organizationName);
    const greeting = greetingLine(input.greetingName ? supporterGreetingName(input.greetingName) : null);
    const message = cleanMessage(input.message);
    const f = invitationFactSections(input.facts);
    const brandName = oneLine(input.brand?.name, 120);
    const brandEmail = oneLine(input.brand?.email, 254);

    // ── Plain text ────────────────────────────────────────────────────────
    const text: string[] = [greeting, ''];
    if (message) text.push(message, '');
    if (f.offering.length) text.push(`This round we're offering:`, ...f.offering.map((n) => `• ${n}`), '');
    if (f.deadline) text.push(`Ordering ends: ${f.deadline}`, '');
    if (f.pickup.length) text.push('Pickup:', ...f.pickup, '');
    text.push(`You can view this round's meals and place your order here:`, url, '');
    text.push(`Thank you for supporting ${org}!`);
    if (brandName || brandEmail) text.push('', ...[brandName, brandEmail].filter(Boolean));

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
    if (brandName || brandEmail) {
        html.push(`<p style="margin:24px 0 0;color:#64748b;font-size:13px;">`
            + [brandName ? `<strong>${esc(brandName)}</strong>` : '', brandEmail ? esc(brandEmail) : ''].filter(Boolean).join('<br />')
            + `</p>`);
    }

    return {
        subject: safeSubject(input.subject),
        html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;`
            + `color:#0f172a;max-width:620px;">\n${html.join('\n')}\n</div>`,
        text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    };
}
