/**
 * FR-REBOOK-1A — the owner edits plain text; the server renders the email.
 *
 * WHY NOT LET THE BROWSER SEND HTML
 *
 * The first cut of the editable reply took an `html` string from the dialog and
 * handed it to the provider untouched. That is not a personalisation feature, it
 * is a general-purpose HTML email composer reachable by any authenticated user —
 * script tags, event-handler attributes, `javascript:` hrefs, spoofed sender
 * blocks and all. Nothing about the owner's request needs that: they wanted to
 * read the standard introduction and adjust the wording before it went out.
 *
 * So the contract is the narrow one. The dialog shows TEXT, the owner edits TEXT,
 * and this module turns text into the email. Every character the owner types is
 * escaped, so the worst a hostile paste can achieve is ugly wording — the markup
 * is chosen here, not accepted from anywhere.
 *
 * ONE TEMPLATE STILL. The default text is derived from the canonical
 * EMAIL_TEMPLATES.lead_intro by stripping its markup, rather than written out a
 * second time. The letter the owner edits is the letter the platform already
 * sends; only its clothes change.
 */

/**
 * Entities the canonical templates actually emit, plus the numeric forms.
 *
 * The set is taken from the templates rather than guessed: grepping
 * lib/emailTemplates.ts yields exactly &amp; &gt; &lt; &mdash; &quot; &rsquo;.
 * A missed entity is not harmless — it would show the owner a literal
 * "&mdash;" in the editor, and then be escaped to "&amp;mdash;" on the way out,
 * putting the raw entity in the volunteer's inbox. &amp; is decoded LAST so a
 * double-encoded "&amp;lt;" cannot become a bracket.
 */
function decodeEntities(s: string): string {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&rsquo;/g, '’')
        .replace(/&lsquo;/g, '‘')
        .replace(/&rdquo;/g, '”')
        .replace(/&ldquo;/g, '“')
        .replace(/&hellip;/g, '…')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, d) => {
            const n = Number(d);
            return Number.isFinite(n) && n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
        })
        // LAST, deliberately. Decoding &amp; first would turn a double-encoded
        // "&amp;lt;" into "&lt;" and then into a real "<" on the next pass.
        .replace(/&amp;/g, '&');
}

/**
 * The canonical template's body, as readable text the owner can edit.
 *
 * Block-level tags become line breaks so paragraphs and list items survive; every
 * other tag is dropped. `<style>` and `<script>` contents are removed outright
 * rather than flattened, so CSS never turns up as prose in the editor.
 */
export function htmlToEditableText(html: string): string {
    if (typeof html !== 'string') return '';
    return decodeEntities(
        html
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table)>/gi, '\n\n')
            .replace(/<li[^>]*>/gi, '• ')
            .replace(/<[^>]+>/g, ''),
    )
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n')
        .map((l) => l.replace(/[ \t]{2,}/g, ' ').trimEnd())
        .join('\n')
        .trim();
}

/** Escapes every character that could otherwise become markup. */
export function escapeForEmail(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export interface PlainTextEmailBrand {
    name?: string | null;
    email?: string | null;
    site?: string | null;
    siteLabel?: string | null;
}

/**
 * Turn the owner's edited text into the outgoing HTML body.
 *
 * ── THE SAFETY PROPERTY ─────────────────────────────────────────────────────
 * The ONLY tags in the result are the ones written here. The owner's text is
 * escaped before it is placed, so `<script>`, `onclick=`, `javascript:` and a
 * forged signature block all arrive as visible characters rather than as markup.
 * There is no path by which client input becomes an element, an attribute or a
 * URL.
 *
 * Blank lines separate paragraphs; single newlines become line breaks. That is
 * the whole formatting vocabulary, and it is enough for a letter.
 */
export function editableTextToEmailHtml(text: string, brand?: PlainTextEmailBrand): string {
    const paragraphs = String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p style="margin:0 0 16px;">${escapeForEmail(p).replace(/\n/g, '<br />')}</p>`)
        .join('\n');

    // The signature is composed from tenant fields resolved server-side, and is
    // escaped exactly like the body. A site link is rendered only when the stored
    // value is an http(s) URL — never a `javascript:` or `data:` scheme, whatever
    // is in the column.
    const site = typeof brand?.site === 'string' && /^https?:\/\//i.test(brand.site) ? brand.site : null;
    const bits: string[] = [];
    if (brand?.name) bits.push(`<strong>${escapeForEmail(brand.name)}</strong>`);
    if (brand?.email) bits.push(escapeForEmail(brand.email));
    if (site) {
        bits.push(`<a href="${escapeForEmail(site)}" style="color:#4f46e5;">${escapeForEmail(brand?.siteLabel || site)}</a>`);
    }
    const signature = bits.length
        ? `<p style="margin:24px 0 0;color:#64748b;font-size:13px;">${bits.join('<br />')}</p>`
        : '';

    return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:620px;">
${paragraphs}
${signature}
</div>`;
}
