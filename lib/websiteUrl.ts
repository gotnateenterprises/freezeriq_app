/**
 * FR-ACCEPTANCE-1 — normalising the website a person types into a public form.
 *
 * The inquiry form used `type="url"`, and a browser will not let that field
 * validate without a scheme. So a volunteer typing the only form of their own
 * address they have ever written down —
 *
 *     thebestbrewcoffee.com
 *
 * — was told it was invalid, with nothing on screen explaining that the fix was
 * to type "https://" first. People do not think of a scheme as part of their
 * website's name, and a fundraising enquiry is not the place to teach them.
 *
 * The server is the authority: whatever the input control does, this is what
 * decides. A bare domain becomes https, an http address is upgraded rather than
 * refused, and anything that could only be an attack is rejected outright.
 */

/** Long enough for any real address, short enough not to be a payload. */
export const WEBSITE_MAX_LENGTH = 300;

export type WebsiteResult =
    | { ok: true; url: string | null }
    | { ok: false; error: string };

/**
 * Normalise a submitted website.
 *
 * Blank stays blank — the field is optional and an organisation without a
 * website should not be blocked from asking about a fundraiser.
 */
export function normalizeWebsiteUrl(raw: unknown): WebsiteResult {
    if (raw === null || raw === undefined) return { ok: true, url: null };
    if (typeof raw !== 'string') return { ok: false, error: 'Enter a valid website address.' };

    const trimmed = raw.trim();
    if (trimmed === '') return { ok: true, url: null };
    if (trimmed.length > WEBSITE_MAX_LENGTH) {
        return { ok: false, error: `Website address must be ${WEBSITE_MAX_LENGTH} characters or fewer.` };
    }

    // Reject dangerous schemes BEFORE the bare-domain guess. Checking after
    // would let "javascript:alert(1)" through as a "scheme-less" string and
    // become "https://javascript:alert(1)", which parses and looks harmless
    // right up until something renders the original text instead.
    //
    // A scheme is only a scheme when the part before the colon contains no dot.
    // "example.org:8443/a" is a host and a port — far commoner in something a
    // person types than any exotic scheme — while "javascript", "data", "file"
    // and "vbscript" have no dot and are caught here.
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    if (schemeMatch && !schemeMatch[1].includes('.')) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme !== 'http' && scheme !== 'https') {
            return { ok: false, error: 'Enter a website address starting with https://' };
        }
    }

    // No scheme at all — the ordinary case this function exists for.
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return { ok: false, error: 'Enter a valid website address.' };
    }

    // http is upgraded rather than refused. Someone typing their own address
    // from memory is not making a security decision, and the destination is the
    // same site either way.
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:') {
        return { ok: false, error: 'Enter a website address starting with https://' };
    }

    // Credentials in a URL are refused rather than stripped: someone who pasted
    // one needs to know it was there.
    if (url.username || url.password) {
        return { ok: false, error: 'Remove the username or password from the website address.' };
    }

    // A hostname with no dot is not a public website — it is "localhost", a
    // typo, or a sentence that happened to parse.
    if (!url.hostname || !url.hostname.includes('.') || url.hostname.endsWith('.')) {
        return { ok: false, error: 'Enter a valid website address.' };
    }
    // Bare TLD-looking junk ("https://.com") parses but is not an address.
    if (url.hostname.startsWith('.') || /\.\./.test(url.hostname)) {
        return { ok: false, error: 'Enter a valid website address.' };
    }

    return { ok: true, url: url.toString() };
}
