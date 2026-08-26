/**
 * OUTREACH-CONSENT-1 — the system unsubscribe footer and its headers.
 *
 * ── WHY THE FOOTER IS APPLIED AFTER RENDERING, NOT INSIDE IT ────────────────
 *
 * The coordinator writes the message. If the footer were part of what they
 * write — or part of a template they can edit — then removing it would be a
 * matter of pressing backspace, and the opt-out guarantee would depend on
 * nobody doing that. So `applyUnsubscribeFooter` runs on the OUTPUT of the
 * render step, inside the send engine, after every caller has had their say.
 *
 * The coordinator's text is above the line. Everything below it belongs to the
 * platform: they cannot delete it, reword it, or point it somewhere else,
 * because their input never reaches this function.
 *
 * ── WHY A MESSAGE WITH NO TOKEN CANNOT BE SENT ──────────────────────────────
 *
 * `applyUnsubscribeFooter` returns null when it has no token to embed. That is
 * the whole prerequisite expressed as a type: the send path must refuse rather
 * than fall back to a footerless promotional email. Silently sending without an
 * opt-out is the exact behaviour this feature exists to make impossible.
 *
 * ── TRANSACTIONAL MAIL IS NOT TOUCHED ───────────────────────────────────────
 *
 * Order receipts, invoices, password resets and coordinator setup mail are
 * transactional: the recipient asked for them by doing something, and there is
 * no opt-out from being told what happened to your own order. Nothing in this
 * module is imported by those paths, and `List-Unsubscribe` on a receipt would
 * be a false promise — we cannot stop sending someone their own confirmation.
 */

import { buildUnsubscribePageUrl, buildUnsubscribeEndpointUrl } from '@/lib/outreachUnsubscribeToken';

export interface UnsubscribeFooterInput {
    /** The sealed token for THIS recipient. Never shared between recipients. */
    token: string;
    /** Absolute origin, e.g. https://www.freezeriqapp.com */
    origin: string;
    /** Tenant name as the recipient would recognise it. */
    brandName?: string | null;
}

export interface RenderedOutreachContent {
    subject: string;
    html: string;
    text: string;
}

export interface OutreachContentWithFooter extends RenderedOutreachContent {
    /** Provider headers for this one recipient. */
    headers: Record<string, string>;
}

/** Escapes the tenant name; nothing else in the footer is variable. */
function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The tenant name, flattened to a single line.
 *
 * The HTML footer escapes it; the PLAIN-TEXT footer has no escaping to hide
 * behind, so a business name containing newlines could otherwise write its own
 * lines below the separator — "To unsubscribe, visit evil.test" reads exactly as
 * authoritative as the real instruction that follows it. Control characters go
 * too, since they can reorder or hide text in a mail client.
 */
function flattenBrandName(brandName?: string | null): string {
    const raw = typeof brandName === 'string' ? brandName : '';
    // eslint-disable-next-line no-control-regex
    const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return flat ? flat.slice(0, 120) : 'this organization';
}

export function unsubscribeFooterText(pageUrl: string, brandName?: string | null): string {
    const who = flattenBrandName(brandName);
    return `You are receiving this because you supported a fundraiser run with ${who}.\n`
        + `To stop receiving promotional fundraiser emails at this address, visit:\n${pageUrl}`;
}

export function unsubscribeFooterHtml(pageUrl: string, brandName?: string | null): string {
    // Flattened as well as escaped: escaping stops markup, but a 4,000-character
    // "name" would still deface the footer the recipient needs to read.
    const who = escapeHtml(flattenBrandName(brandName));
    const href = escapeHtml(pageUrl);
    return `<hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 12px;" />`
        + `<p style="margin:0;color:#64748b;font-size:12px;line-height:1.5;">`
        + `You are receiving this because you supported a fundraiser run with ${who}.<br />`
        + `<a href="${href}" style="color:#64748b;">Unsubscribe from promotional emails</a>`
        + `</p>`;
}

/**
 * Headers that let a mailbox provider offer its own one-click opt-out.
 *
 * `List-Unsubscribe-Post` is only correct alongside an HTTPS URL that accepts a
 * POST, so both are emitted together or neither is. The endpoint named here is
 * the API route, whose GET redirects to the human page — so a provider or
 * scanner following the link with a GET changes nothing.
 */
export function unsubscribeHeaders(endpointUrl: string): Record<string, string> {
    return {
        'List-Unsubscribe': `<${endpointUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
}

/**
 * Appends the system footer to already-rendered content.
 *
 * Returns null when no token is available, which the send path must treat as a
 * refusal to send.
 */
export function applyUnsubscribeFooter(
    content: RenderedOutreachContent,
    input: UnsubscribeFooterInput | null,
): OutreachContentWithFooter | null {
    if (!input?.token || !input.origin) return null;

    const pageUrl = buildUnsubscribePageUrl(input.origin, input.token);
    const endpointUrl = buildUnsubscribeEndpointUrl(input.origin, input.token);

    return {
        subject: content.subject,
        html: `${content.html}\n${unsubscribeFooterHtml(pageUrl, input.brandName)}`,
        text: `${content.text}\n\n---\n${unsubscribeFooterText(pageUrl, input.brandName)}`,
        headers: unsubscribeHeaders(endpointUrl),
    };
}
