/**
 * COORDINATOR-PAYMENT-METHOD-UX-1 — how a fundraiser's supporters may pay their coordinator.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
 *
 * This stores what a coordinator TELLS supporters they accept ("cash, checks to
 * Lincoln PTO, Venmo @lincoln-pto"). It is not a payment record and never
 * becomes one: FreezerIQ processes no fundraiser payment, cannot see a Venmo or
 * Cash App transfer, and learns that a supporter paid only when the coordinator
 * marks the order paid (lib/supporterPayment.ts — Order.paid_at, written by
 * exactly one route). Nothing in this module reads or writes an order.
 *
 * External links built here (Venmo / Cash App / PayPal.Me / a Bank / ACH payment
 * page / an Other link) are conveniences that OPEN another app or site. They are
 * labelled "Open Venmo", never "Pay now", because nothing here can know whether a
 * payment happened.
 *
 * ── STORAGE ─────────────────────────────────────────────────────────────────
 *
 * FundraiserCampaign.payment_methods (JSONB, nullable, campaign-scoped):
 *
 *   NULL                       never configured — a legacy campaign. Its free-text
 *                              payment_instructions / external_payment_link keep
 *                              rendering exactly as before; nothing is inferred
 *                              from that prose.
 *   { v: 1, methods: [...] }   configured through the coordinator's payment form
 *                              (methods may be empty).
 *
 * The Check payee is deliberately NOT stored here. FundraiserCampaign.checks_payable
 * is already the one authority for it (flyers, packets and trackers print it), so a
 * second copy could only drift. Selecting Check is what makes that payee
 * supporter-facing.
 *
 * Every value is validated on WRITE and re-validated on READ, so a row written by
 * any other path can never render as a link it should not be.
 *
 * Pure and dependency-light (only the shared coordinator-setup rules), so the same
 * functions run in the coordinator form, the routes, the supporter page and the
 * confirmation email.
 */

import {
    checkChecksPayable,
    checkPaymentInstructions,
    checkPaymentLink,
    type SetupOk,
    type SetupRefusal,
} from '@/lib/coordinatorSetup';

// ── The method list (locked) ─────────────────────────────────────────────────

/** The supported methods, in the order supporters always see them. */
export const PAYMENT_METHOD_TYPES = ['cash', 'check', 'venmo', 'paypal', 'cashapp', 'bank_ach', 'other'] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethodType, string>> = {
    cash: 'Cash',
    check: 'Check',
    venmo: 'Venmo',
    paypal: 'PayPal',
    cashapp: 'Cash App',
    bank_ach: 'Bank / ACH',
    other: 'Other',
};

export function isPaymentMethodType(v: unknown): v is PaymentMethodType {
    return typeof v === 'string' && (PAYMENT_METHOD_TYPES as readonly string[]).includes(v);
}

// ── Supporter-facing wording (one place) ─────────────────────────────────────

/**
 * The owner's default due guidance. No campaign stores a due period (audited
 * 2026-11-02: "within 3 days" existed only as example text in the coordinator
 * form), so this is the product default rather than a per-campaign value.
 */
export const PAYMENT_DUE_GUIDANCE = 'Payment is due to the coordinator within three days.';
/** Shown only when a campaign tells supporters nothing at all about paying. */
export const PAYMENT_CONTACT_FALLBACK = 'Please contact your fundraiser coordinator to arrange payment.';
export const CASH_GUIDANCE = 'Pay your fundraiser coordinator directly.';
export const LEGACY_LINK_LABEL = 'Payment link';
export const LEGACY_LINK_ACTION = 'Open payment link';
/**
 * COORDINATOR-BANK-ACH-LINK-1 — the organization's own bank or payment-provider page.
 * FreezerIQ can say only that the link passed its rules: never "securely", "instant"
 * or "paid", because it cannot see the outside page or whether anyone completed it.
 */
export const BANK_ACH_GUIDANCE = "Pay from your bank account on your organization's payment page.";
export const BANK_ACH_ACTION = 'Open bank payment';
/** Before an order exists no payment link is offered; this says when the bank one appears. */
export const BANK_ACH_AFTER_ORDER = 'The bank payment link appears after you place your order.';

// ── Field limits and formats ─────────────────────────────────────────────────

/** Venmo usernames: 5–30 letters, numbers, hyphens or underscores (Venmo help centre). */
const VENMO_HANDLE_RE = /^[A-Za-z0-9_-]{5,30}$/;
/** $Cashtags: up to 20 characters with at least one letter (Cash App help); letters, numbers, underscores. */
const CASHTAG_RE = /^(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{1,20}$/;
/** PayPal.Me names: up to 20 letters or numbers (PayPal help). */
const PAYPAL_ME_RE = /^[A-Za-z0-9]{1,20}$/;
/** A deliberately plain address shape — this is display text, never a mail link. */
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[A-Za-z]{2,}$/;
export const EMAIL_MAX = 254;
export const OTHER_LABEL_MAX = 40;
export const OTHER_DETAILS_MAX = 300;
/** The Bank / ACH note follows the same multi-line convention as an Other method's instructions. */
export const BANK_ACH_NOTE_MAX = OTHER_DETAILS_MAX;

/** C0/C1 control characters. Newlines are handled separately for multi-line fields. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const CONTROL_ANY_RE = /[\u0000-\u001F\u007F-\u009F]/;
/** Line/paragraph separators and bidi overrides: invisible, and able to reorder what a supporter reads. */
const INVISIBLE_RE = new RegExp('[\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]');

const refuse = (code: string, error: string): SetupRefusal => ({ ok: false, code, error });

/** Single-line text: trimmed, bounded, no markup, no control or invisible characters. */
function singleLine(value: unknown, max: number, code: string, label: string): SetupOk<{ value: string | null }> | SetupRefusal {
    if (value === null || value === undefined) return { ok: true, value: null };
    if (typeof value !== 'string') return refuse(`${code}_invalid`, `${label} must be text.`);
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: null };
    if (CONTROL_ANY_RE.test(trimmed) || INVISIBLE_RE.test(trimmed)) return refuse(`${code}_unsafe`, `${label} contains characters that can't be shown.`);
    if (/[<>]/.test(trimmed)) return refuse(`${code}_unsafe`, `${label} cannot contain < or >.`);
    if (trimmed.length > max) return refuse(`${code}_too_long`, `${label} must be ${max} characters or fewer.`);
    return { ok: true, value: trimmed };
}

/** Multi-line text: as singleLine, but the coordinator's own line breaks survive (normalised to \n). */
function multiLine(value: unknown, max: number, code: string, label: string): SetupOk<{ value: string | null }> | SetupRefusal {
    if (value === null || value === undefined) return { ok: true, value: null };
    if (typeof value !== 'string') return refuse(`${code}_invalid`, `${label} must be text.`);
    const normalized = value.replace(/\r\n?/g, '\n').trim();
    if (normalized === '') return { ok: true, value: null };
    if (CONTROL_RE.test(normalized) || INVISIBLE_RE.test(normalized)) return refuse(`${code}_unsafe`, `${label} contains characters that can't be shown.`);
    if (/[<>]/.test(normalized)) return refuse(`${code}_unsafe`, `${label} cannot contain < or >.`);
    if (normalized.length > max) return refuse(`${code}_too_long`, `${label} must be ${max} characters or fewer.`);
    return { ok: true, value: normalized };
}

/** A pasted profile URL's last path segment, when the host is the expected one. */
function segmentFromUrl(raw: string, hosts: readonly string[], prefixes: readonly string[]): string | null {
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (!hosts.includes(url.hostname.toLowerCase())) return null;
    const path = url.pathname.replace(/\/+$/, '');
    for (const p of prefixes) {
        if (path.toLowerCase().startsWith(p)) {
            const rest = path.slice(p.length);
            if (!rest || rest.includes('/')) return null;
            try { return decodeURIComponent(rest); } catch { return null; }
        }
    }
    return null;
}

/** "@lincoln-pto", "lincoln-pto" or a venmo.com profile link → "lincoln-pto". */
export function normalizeVenmoHandle(value: unknown): SetupOk<{ value: string }> | SetupRefusal {
    const text = singleLine(value, 200, 'venmo', 'Venmo username');
    if (!text.ok) return text;
    if (!text.value) return refuse('venmo_required', 'Enter your Venmo username, like @lincoln-pto.');
    let handle = text.value;
    if (/^https?:\/\//i.test(handle)) {
        handle = segmentFromUrl(handle, ['venmo.com', 'www.venmo.com', 'account.venmo.com'], ['/u/', '/']) ?? '';
    }
    handle = handle.replace(/^@/, '');
    if (!VENMO_HANDLE_RE.test(handle)) {
        return refuse('venmo_invalid', 'A Venmo username is 5–30 letters, numbers, - or _ (like @lincoln-pto).');
    }
    return { ok: true, value: handle };
}

/** "$LincolnPTO", "LincolnPTO" or a cash.app link → "LincolnPTO". */
export function normalizeCashtag(value: unknown): SetupOk<{ value: string }> | SetupRefusal {
    const text = singleLine(value, 200, 'cashapp', 'Cash App $Cashtag');
    if (!text.ok) return text;
    if (!text.value) return refuse('cashapp_required', 'Enter your $Cashtag, like $LincolnPTO.');
    let tag = text.value;
    if (/^https?:\/\//i.test(tag)) {
        tag = segmentFromUrl(tag, ['cash.app', 'www.cash.app'], ['/']) ?? '';
    }
    tag = tag.replace(/^\$/, '');
    if (!CASHTAG_RE.test(tag)) {
        return refuse('cashapp_invalid', 'A $Cashtag is up to 20 letters, numbers or _ and includes a letter (like $LincolnPTO).');
    }
    return { ok: true, value: tag };
}

export type PaypalAccount = { email: string; me?: undefined } | { me: string; email?: undefined };

/**
 * A PayPal email, or a PayPal.Me name/link. A link is only ever offered for a
 * PayPal.Me name — never constructed from an email address, because there is no
 * supported email-to-link format.
 */
export function normalizePaypalAccount(value: unknown): SetupOk<{ value: PaypalAccount }> | SetupRefusal {
    const text = singleLine(value, EMAIL_MAX, 'paypal', 'PayPal');
    if (!text.ok) return text;
    if (!text.value) return refuse('paypal_required', 'Enter your PayPal email or PayPal.Me link.');
    const raw = text.value;
    if (raw.includes('@')) {
        if (!EMAIL_RE.test(raw)) return refuse('paypal_invalid', 'Enter a valid PayPal email address.');
        return { ok: true, value: { email: raw } };
    }
    let name: string | null = raw;
    if (/^https?:\/\//i.test(raw)) {
        name = segmentFromUrl(raw, ['paypal.me', 'www.paypal.me'], ['/'])
            ?? segmentFromUrl(raw, ['paypal.com', 'www.paypal.com'], ['/paypalme/']);
    } else if (/^(www\.)?paypal\.me\//i.test(raw)) {
        name = raw.replace(/^(www\.)?paypal\.me\//i, '').replace(/\/+$/, '');
    }
    if (!name || !PAYPAL_ME_RE.test(name)) {
        return refuse('paypal_invalid', 'Enter a PayPal email, or a PayPal.Me link like paypal.me/LincolnPTO.');
    }
    return { ok: true, value: { me: name } };
}

// ── Stored shape ─────────────────────────────────────────────────────────────

export type StoredPaymentMethod =
    | { type: 'cash' }
    | { type: 'check' }
    | { type: 'venmo'; handle: string }
    | { type: 'paypal'; email?: string; me?: string }
    | { type: 'cashapp'; cashtag: string }
    | { type: 'bank_ach'; link: string; note?: string }
    | { type: 'other'; label: string; details: string; link?: string };

export interface StoredPaymentMethods {
    v: 1;
    methods: StoredPaymentMethod[];
}

/** What the coordinator form sends: one entry per SELECTED method, nothing for an unselected one. */
export interface PaymentMethodInput {
    type?: unknown;
    handle?: unknown;
    account?: unknown;
    cashtag?: unknown;
    label?: unknown;
    details?: unknown;
    link?: unknown;
    note?: unknown;
}

const methodError = (type: PaymentMethodType, r: SetupRefusal): SetupRefusal & { method: PaymentMethodType } =>
    ({ ...r, method: type });

/** Validate one selected method. */
export function checkPaymentMethod(input: PaymentMethodInput | null | undefined):
    SetupOk<{ value: StoredPaymentMethod }> | (SetupRefusal & { method?: PaymentMethodType }) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return refuse('payment_method_invalid', 'Choose a payment method from the list.');
    }
    const type = input.type;
    if (!isPaymentMethodType(type)) return refuse('payment_method_invalid', 'Choose a payment method from the list.');

    switch (type) {
        case 'cash':
        case 'check':
            return { ok: true, value: { type } };
        case 'venmo': {
            const r = normalizeVenmoHandle(input.handle);
            return r.ok ? { ok: true, value: { type, handle: r.value } } : methodError(type, r);
        }
        case 'cashapp': {
            const r = normalizeCashtag(input.cashtag);
            return r.ok ? { ok: true, value: { type, cashtag: r.value } } : methodError(type, r);
        }
        case 'paypal': {
            const r = normalizePaypalAccount(input.account);
            if (!r.ok) return methodError(type, r);
            return { ok: true, value: r.value.email ? { type, email: r.value.email } : { type, me: r.value.me } };
        }
        case 'bank_ach': {
            // COORDINATOR-BANK-ACH-LINK-1: the payment page the organization's bank or provider gave
            // it. The link IS the method, so it is required, and the shared https rule is the only URL
            // rule (no bank allowlist — every organization banks somewhere different). The optional
            // note is ordinary supporter-facing text. Nothing else is asked for or stored: never a
            // routing number, account number or bank login.
            const link = checkPaymentLink(input.link);
            if (!link.ok) return methodError(type, link);
            if (!link.value) return methodError(type, refuse('bank_ach_link_required', 'Paste your bank payment link. It must start with https://'));
            const note = multiLine(input.note, BANK_ACH_NOTE_MAX, 'bank_ach_note', 'The note for supporters');
            if (!note.ok) return methodError(type, note);
            return { ok: true, value: note.value ? { type, link: link.value, note: note.value } : { type, link: link.value } };
        }
        case 'other': {
            const label = singleLine(input.label, OTHER_LABEL_MAX, 'other_label', 'The method name');
            if (!label.ok) return methodError(type, label);
            if (!label.value) return methodError(type, refuse('other_label_required', 'Name the other payment method, like "Pay at pickup".'));
            const details = multiLine(input.details, OTHER_DETAILS_MAX, 'other_details', 'The other method\'s instructions');
            if (!details.ok) return methodError(type, details);
            if (!details.value) return methodError(type, refuse('other_details_required', 'Tell supporters how to use this method.'));
            const link = checkPaymentLink(input.link);
            if (!link.ok) return methodError(type, link);
            return { ok: true, value: link.value ? { type, label: label.value, details: details.value, link: link.value } : { type, label: label.value, details: details.value } };
        }
    }
    return refuse('payment_method_invalid', 'Choose a payment method from the list.');
}

/**
 * Validate the coordinator's whole selection (the form sends an array of the
 * selected methods). Unknown types, duplicates and anything malformed are refused
 * rather than dropped, so the coordinator learns what was wrong. Output is in the
 * canonical supporter order regardless of the order sent.
 */
export function checkPaymentMethods(raw: unknown):
    SetupOk<{ value: StoredPaymentMethods }> | (SetupRefusal & { method?: PaymentMethodType }) {
    if (raw === null) return { ok: true, value: { v: 1, methods: [] } };
    if (!Array.isArray(raw)) return refuse('payment_methods_invalid', 'Payment methods must be a list.');
    if (raw.length > PAYMENT_METHOD_TYPES.length) return refuse('payment_methods_invalid', 'Choose each payment method at most once.');
    const seen = new Set<PaymentMethodType>();
    const out: StoredPaymentMethod[] = [];
    for (const entry of raw) {
        const r = checkPaymentMethod(entry as PaymentMethodInput);
        if (!r.ok) return r;
        if (seen.has(r.value.type)) return refuse('payment_methods_duplicate', 'Choose each payment method at most once.');
        seen.add(r.value.type);
        out.push(r.value);
    }
    out.sort((a, b) => PAYMENT_METHOD_TYPES.indexOf(a.type) - PAYMENT_METHOD_TYPES.indexOf(b.type));
    return { ok: true, value: { v: 1, methods: out } };
}

/** Stored → the form's input shape, so a stored row can be re-validated with the same rules. */
function storedToInput(m: any): PaymentMethodInput | null {
    if (!m || typeof m !== 'object') return null;
    switch (m.type) {
        case 'cash': case 'check': return { type: m.type };
        case 'venmo': return { type: 'venmo', handle: m.handle };
        case 'cashapp': return { type: 'cashapp', cashtag: m.cashtag };
        case 'paypal': return { type: 'paypal', account: typeof m.email === 'string' ? m.email : m.me };
        case 'bank_ach': return { type: 'bank_ach', link: m.link, note: m.note ?? null };
        case 'other': return { type: 'other', label: m.label, details: m.details, link: m.link ?? null };
        default: return null;
    }
}

/**
 * Read a stored value tolerantly: null for anything that is not a v1 config, and
 * every method re-validated with the write rules — an invalid or duplicate entry
 * is dropped, never rendered.
 */
export function readStoredPaymentMethods(json: unknown): StoredPaymentMethods | null {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    const obj = json as { v?: unknown; methods?: unknown };
    if (obj.v !== 1 || !Array.isArray(obj.methods)) return null;
    const seen = new Set<PaymentMethodType>();
    const methods: StoredPaymentMethod[] = [];
    for (const m of obj.methods.slice(0, 20)) {
        const r = checkPaymentMethod(storedToInput(m));
        if (!r.ok || seen.has(r.value.type)) continue;
        seen.add(r.value.type);
        methods.push(r.value);
    }
    methods.sort((a, b) => PAYMENT_METHOD_TYPES.indexOf(a.type) - PAYMENT_METHOD_TYPES.indexOf(b.type));
    return { v: 1, methods };
}

// ── Links (convenience only) ─────────────────────────────────────────────────

export function venmoProfileUrl(handle: string): string { return `https://venmo.com/u/${handle}`; }
export function cashAppUrl(cashtag: string): string { return `https://cash.app/$${cashtag}`; }
export function paypalMeUrl(name: string): string { return `https://paypal.me/${name}`; }

// ── The public, supporter-facing projection ──────────────────────────────────

/**
 * One method as a supporter sees it. Only these keys ever cross to a supporter
 * page, a confirmation or an email — never the stored object.
 */
export interface PublicPaymentMethod {
    type: PaymentMethodType;
    /** "Cash", "Venmo", or the coordinator's own name for an Other method. */
    label: string;
    /** "@lincoln-pto", "Make checks payable to Lincoln PTO", Other instructions… or null. */
    detail: string | null;
    /** A validated https link that only OPENS the payment app or page. */
    href: string | null;
    /** "Open Venmo" — never "Pay now". */
    actionLabel: string | null;
}

export const PUBLIC_PAYMENT_METHOD_KEYS = ['type', 'label', 'detail', 'href', 'actionLabel'] as const;

/**
 * The supporter-facing methods for a campaign: null when the campaign has never
 * configured methods (legacy), otherwise the validated list. The Check payee
 * appears only when Check is selected — an unselected method contributes nothing.
 */
export function toPublicPaymentMethods(stored: unknown, checksPayable: unknown): PublicPaymentMethod[] | null {
    const config = readStoredPaymentMethods(stored);
    if (!config) return null;
    return config.methods.map((m): PublicPaymentMethod => {
        switch (m.type) {
            case 'cash':
                return { type: 'cash', label: 'Cash', detail: CASH_GUIDANCE, href: null, actionLabel: null };
            case 'check': {
                const payee = checkChecksPayable(checksPayable);
                const name = payee.ok ? payee.value : null;
                return { type: 'check', label: 'Check', detail: name ? `Make checks payable to ${name}` : null, href: null, actionLabel: null };
            }
            case 'venmo':
                return { type: 'venmo', label: 'Venmo', detail: `@${m.handle}`, href: venmoProfileUrl(m.handle), actionLabel: 'Open Venmo' };
            case 'cashapp':
                return { type: 'cashapp', label: 'Cash App', detail: `$${m.cashtag}`, href: cashAppUrl(m.cashtag), actionLabel: 'Open Cash App' };
            case 'paypal':
                return m.me
                    ? { type: 'paypal', label: 'PayPal', detail: `paypal.me/${m.me}`, href: paypalMeUrl(m.me), actionLabel: 'Open PayPal' }
                    : { type: 'paypal', label: 'PayPal', detail: m.email ?? null, href: null, actionLabel: null };
            case 'bank_ach':
                return {
                    type: 'bank_ach',
                    label: PAYMENT_METHOD_LABELS.bank_ach,
                    detail: m.note ? `${BANK_ACH_GUIDANCE}\n${m.note}` : BANK_ACH_GUIDANCE,
                    href: m.link,
                    actionLabel: BANK_ACH_ACTION,
                };
            case 'other':
                return { type: 'other', label: m.label, detail: m.details, href: m.link ?? null, actionLabel: m.link ? 'Open link' : null };
        }
    });
}

/** True when a supporter could have paid without handing money to the coordinator. */
export function offersOnlinePayment(methods: readonly PublicPaymentMethod[] | null | undefined): boolean {
    return (methods ?? []).some((m) => m.type === 'venmo' || m.type === 'paypal' || m.type === 'cashapp' || m.type === 'bank_ach' || m.type === 'other');
}

/**
 * COORDINATOR-BANK-ACH-LINK-1 — where a payment link goes, for an "Opens pay.examplebank.test"
 * line: the host of the link as the shared https rule normalises it (an internationalised name
 * stays in its xn-- form, so a look-alike domain is visible). Parsed from the validated URL, never
 * cut out of the raw string; never the path or query, and never credentials (the rule refuses
 * those). null for anything that is not a valid payment link.
 */
export function paymentLinkDestination(href: unknown): string | null {
    const checked = checkPaymentLink(href);
    if (!checked.ok || !checked.value) return null;
    return new URL(checked.value).host;
}

// ── One view, every surface ──────────────────────────────────────────────────

export interface SupporterPaymentView {
    /** "Payment is due to the coordinator within three days." — or null (see below). */
    dueLine: string | null;
    methods: PublicPaymentMethod[];
    /** The coordinator's general instructions, as plain text. */
    instructions: string | null;
    /** A legacy campaign-wide payment link: clickable only when it passes the shared https rule. */
    legacyLink: { text: string; href: string | null; actionLabel: string } | null;
    /** Shown only when nothing else tells the supporter how to pay. */
    fallback: string | null;
}

/**
 * The single rule for what a supporter is told about paying. Used by the order
 * page, the confirmation and the confirmation email, so they cannot disagree.
 *
 * DUE LINE. Shown for every campaign that uses the payment-method form, and for
 * a legacy campaign only when it has no written instructions of its own. Legacy
 * campaigns' own wording is the existing authority for their terms — audited
 * 2026-11-02, real instructions say "cash or check at pick up", "on receipt" and
 * "by October 7th" — so the default is never stamped over them.
 *
 * Nothing here can mark, imply or display "paid".
 */
export function buildSupporterPaymentView(input: {
    methods: readonly PublicPaymentMethod[] | null | undefined;
    instructions: unknown;
    legacyLink: unknown;
}): SupporterPaymentView {
    const structured = Array.isArray(input.methods);
    const methods = structured ? (input.methods as unknown[]).map(renderableMethod).filter((m): m is PublicPaymentMethod => m !== null) : [];
    const instructionsCheck = typeof input.instructions === 'string'
        ? checkPaymentInstructions(input.instructions.replace(/\r\n?/g, '\n'))
        : null;
    // A legacy value that fails today's rule (e.g. it contains "<") is still the
    // coordinator's words: shown as plain text (React and the email both escape it).
    const instructions = instructionsCheck && instructionsCheck.ok
        ? instructionsCheck.value
        : (typeof input.instructions === 'string' && input.instructions.trim() ? input.instructions.trim() : null);

    const legacyLink = legacyPaymentLinkView(input.legacyLink);

    const dueLine = structured || !instructions ? PAYMENT_DUE_GUIDANCE : null;
    const fallback = methods.length === 0 && !instructions && !legacyLink ? PAYMENT_CONTACT_FALLBACK : null;
    return { dueLine, methods, instructions, legacyLink, fallback };
}

/**
 * COORDINATOR-PAYMENT-METHOD-UX-1A — a campaign's legacy payment link, the way every
 * surface must show it (order page, confirmation, email, and the public scoreboard):
 * clickable only when it passes the shared https rule (checkPaymentLink); a value that
 * does not is still the coordinator's typing, so it may be shown — as text, never as an
 * href. Not a second rule: buildSupporterPaymentView uses this very function.
 */
export function legacyPaymentLinkView(raw: unknown): SupporterPaymentView['legacyLink'] {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const checked = checkPaymentLink(raw);
    return { text: raw.trim(), href: checked.ok ? checked.value : null, actionLabel: LEGACY_LINK_ACTION };
}

/**
 * Defence in depth for a projection that came from somewhere else (a response
 * body, a page payload): rebuilt from the five public keys only, text fields
 * forced to strings, and a link kept only if it passes the shared https rule
 * unchanged. Anything else is dropped rather than rendered.
 */
function renderableMethod(m: unknown): PublicPaymentMethod | null {
    if (!m || typeof m !== 'object') return null;
    const x = m as Record<string, unknown>;
    if (!isPaymentMethodType(x.type) || typeof x.label !== 'string' || !x.label.trim()) return null;
    let href: string | null = null;
    if (x.href !== null && x.href !== undefined) {
        const checked = checkPaymentLink(x.href);
        if (!checked.ok || checked.value !== x.href) return null;
        href = checked.value;
    }
    // A Bank / ACH entry is its link: without a valid one there is nothing truthful to show.
    if (x.type === 'bank_ach' && !href) return null;
    return {
        type: x.type,
        label: x.label.trim(),
        detail: typeof x.detail === 'string' && x.detail.trim() ? x.detail.trim() : null,
        href,
        actionLabel: href && typeof x.actionLabel === 'string' && x.actionLabel.trim() ? x.actionLabel.trim() : null,
    };
}

// ── The coordinator form ─────────────────────────────────────────────────────

/** Form state: every method's checkbox and its fields. Unselected fields are never sent. */
export interface PaymentMethodsFormValue {
    selected: Record<PaymentMethodType, boolean>;
    venmoHandle: string;
    paypalAccount: string;
    cashappTag: string;
    bankLink: string;
    bankNote: string;
    otherLabel: string;
    otherDetails: string;
    otherLink: string;
}

export function emptyPaymentMethodsForm(): PaymentMethodsFormValue {
    return {
        selected: { cash: false, check: false, venmo: false, paypal: false, cashapp: false, bank_ach: false, other: false },
        venmoHandle: '', paypalAccount: '', cashappTag: '', bankLink: '', bankNote: '', otherLabel: '', otherDetails: '', otherLink: '',
    };
}

/** Seed the form from a stored value (legacy NULL → nothing selected; old prose is never parsed). */
export function paymentMethodsFormFromStored(stored: unknown): PaymentMethodsFormValue {
    const form = emptyPaymentMethodsForm();
    const config = readStoredPaymentMethods(stored);
    if (!config) return form;
    for (const m of config.methods) {
        form.selected[m.type] = true;
        if (m.type === 'venmo') form.venmoHandle = `@${m.handle}`;
        if (m.type === 'cashapp') form.cashappTag = `$${m.cashtag}`;
        if (m.type === 'paypal') form.paypalAccount = m.email ?? (m.me ? `paypal.me/${m.me}` : '');
        if (m.type === 'bank_ach') { form.bankLink = m.link; form.bankNote = m.note ?? ''; }
        if (m.type === 'other') { form.otherLabel = m.label; form.otherDetails = m.details; form.otherLink = m.link ?? ''; }
    }
    return form;
}

/** The wire payload: one entry per selected method — a deselected method sends nothing at all. */
export function paymentMethodsInputFromForm(form: PaymentMethodsFormValue): PaymentMethodInput[] {
    const out: PaymentMethodInput[] = [];
    for (const type of PAYMENT_METHOD_TYPES) {
        if (!form.selected[type]) continue;
        if (type === 'venmo') out.push({ type, handle: form.venmoHandle });
        else if (type === 'paypal') out.push({ type, account: form.paypalAccount });
        else if (type === 'cashapp') out.push({ type, cashtag: form.cashappTag });
        else if (type === 'bank_ach') out.push({ type, link: form.bankLink, note: form.bankNote });
        else if (type === 'other') out.push({ type, label: form.otherLabel, details: form.otherDetails, link: form.otherLink });
        else out.push({ type });
    }
    return out;
}

/** Per-method problems for inline display; the server re-checks everything regardless. */
export function paymentMethodsFormErrors(form: PaymentMethodsFormValue): Partial<Record<PaymentMethodType, string>> {
    const errors: Partial<Record<PaymentMethodType, string>> = {};
    for (const entry of paymentMethodsInputFromForm(form)) {
        const r = checkPaymentMethod(entry);
        if (!r.ok) errors[entry.type as PaymentMethodType] = r.error;
    }
    return errors;
}

// ── The coordinator's post-launch Payment Settings save ──────────────────────

export interface CoordinatorPaymentSettingsValues {
    payment_instructions?: string | null;
    external_payment_link?: string | null;
    checks_payable?: string | null;
    payment_methods?: StoredPaymentMethods;
}

/**
 * Validate a Payment Settings save. Only keys the request actually carries are
 * returned (an absent key leaves its column untouched, which is how this route
 * always behaved); every present key is validated with the setup form's rules —
 * the previous version of this route wrote whatever it was sent.
 */
export function checkCoordinatorPaymentSettings(body: unknown):
    SetupOk<{ values: CoordinatorPaymentSettingsValues }> | (SetupRefusal & { method?: PaymentMethodType }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('payment_settings_invalid', 'Invalid request.');
    const b = body as Record<string, unknown>;
    const values: CoordinatorPaymentSettingsValues = {};
    if (b.paymentInstructions !== undefined) {
        const r = checkPaymentInstructions(b.paymentInstructions);
        if (!r.ok) return r;
        values.payment_instructions = r.value;
    }
    if (b.externalPaymentLink !== undefined) {
        const r = checkPaymentLink(b.externalPaymentLink);
        if (!r.ok) return r;
        values.external_payment_link = r.value;
    }
    if (b.checksPayable !== undefined) {
        const r = checkChecksPayable(b.checksPayable);
        if (!r.ok) return r;
        values.checks_payable = r.value;
    }
    if (b.paymentMethods !== undefined) {
        const r = checkPaymentMethods(b.paymentMethods);
        if (!r.ok) return r;
        values.payment_methods = r.value;
    }
    return { ok: true, values };
}
