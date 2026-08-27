/**
 * OUTREACH-CONSENT-1 — public unsubscribe, suppression, footer and headers.
 *
 * The centrepiece is the end-to-end test: a recipient who is eligible before
 * unsubscribing, unsubscribes through the public flow, and is then refused by
 * the SEND-TIME check — not by UI filtering. UI filtering is a courtesy; the
 * server check is the guarantee.
 */
process.env.TZ = 'America/Chicago';
process.env.OUTREACH_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret-at-least-32-chars-long';

import fs from 'fs';
import path from 'path';
import {
    sealUnsubscribeToken,
    openUnsubscribeToken,
    unsubscribeSecret,
    unsubscribeVerificationSecrets,
    buildUnsubscribePageUrl,
    buildUnsubscribeEndpointUrl,
} from '../lib/outreachUnsubscribeToken';
import {
    applyUnsubscribeFooter,
    unsubscribeHeaders,
    unsubscribeFooterText,
    unsubscribeFooterHtml,
} from '../lib/outreachUnsubscribeFooter';
import { recordUnsubscribe } from '../lib/outreachUnsubscribeWrite';
import { checkSuppressionAtSend, runSend, type SendableRecipient } from '../lib/outreachSend';
import { normalizeEmail } from '../lib/seasonalAudience';

const BIZ = 'biz-1';
const OTHER = 'biz-2';
const EMAIL = 'bonnie@example.com';
const ORIGIN = 'https://www.freezeriqapp.com';

// ── Part L / token security ────────────────────────────────────────────────
describe('OUTREACH-CONSENT-1 · token', () => {
    it('resolves the tenant and address it was sealed with', async () => {
        const t = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        expect(t).toBeTruthy();
        await expect(openUnsubscribeToken(t)).resolves.toEqual({
            businessId: BIZ, normalizedEmail: EMAIL,
        });
    });

    it('exposes NO tenant id or address in cleartext', async () => {
        const t = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        expect(t).not.toContain(BIZ);
        expect(t).not.toContain('bonnie');
        expect(t).not.toContain('example.com');
        // Nor after a naive base64 decode of any segment.
        for (const seg of t.split('.').slice(1)) {
            const decoded = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
            expect(decoded).not.toContain(BIZ);
            expect(decoded).not.toContain('bonnie');
        }
    });

    it('normalizes the address on the way in', async () => {
        const t = (await sealUnsubscribeToken({ businessId: BIZ, email: '  Bonnie@Example.COM ' }))!;
        const p = await openUnsubscribeToken(t);
        expect(p!.normalizedEmail).toBe(EMAIL);
        expect(p!.normalizedEmail).toBe(normalizeEmail('  Bonnie@Example.COM '));
    });

    it('refuses a random, modified, truncated or malformed token', async () => {
        const t = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const [v, iv, body] = t.split('.');
        const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

        for (const bad of [
            'totally-random',
            '',
            'v1.short.short',
            `${v}.${iv}`,                       // truncated segment count
            `${v}.${iv}.${body.slice(0, -4)}`,  // truncated ciphertext
            `${v}.${iv}.${flip(body)}`,         // flipped ciphertext byte
            `${v}.${flip(iv)}.${body}`,         // flipped IV
            `v2.${iv}.${body}`,                 // unknown version
            `${v}.${iv}.${body}!!`,             // non-base64url
            'a'.repeat(5000),
            null, undefined, 42, {},
        ]) {
            await expect(openUnsubscribeToken(bad as any)).resolves.toBeNull();
        }
    });

    it('a token minted under a different secret does not open', async () => {
        const t = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const original = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = 'a-completely-different-secret-32-chars-x';
        await expect(openUnsubscribeToken(t)).resolves.toBeNull();
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = original;
        await expect(openUnsubscribeToken(t)).resolves.not.toBeNull();
    });

    it('a token for another tenant resolves to THAT tenant, never the current one', async () => {
        const t = (await sealUnsubscribeToken({ businessId: OTHER, email: EMAIL }))!;
        const p = await openUnsubscribeToken(t);
        expect(p!.businessId).toBe(OTHER);
        expect(p!.businessId).not.toBe(BIZ);
    });

    it('fails closed with no secret, or one too short to be a secret', async () => {
        const original = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        for (const weak of ['', '   ', 'short']) {
            process.env.OUTREACH_UNSUBSCRIBE_SECRET = weak;
            expect(unsubscribeSecret()).toBeNull();
            await expect(sealUnsubscribeToken({ businessId: BIZ, email: EMAIL })).resolves.toBeNull();
            await expect(openUnsubscribeToken('v1.aa.bb')).resolves.toBeNull();
        }
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = original;
    });

    it('survives a key rotation when the retired secret is retained', async () => {
        const OLD = 'the-original-unsubscribe-secret-32-chars';
        const NEW = 'the-rotated-unsubscribe-secret-32-chars!';
        const originalCurrent = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        const originalPrev = process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS;

        // A link mailed out before the rotation.
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = OLD;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = '';
        const oldLink = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;

        // Rotation WITHOUT retaining the old secret: the old link dies. This is
        // the failure the previous design had no way to avoid.
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = NEW;
        await expect(openUnsubscribeToken(oldLink)).resolves.toBeNull();

        // Rotation WITH the retired secret retained: the old link still works,
        // and new links seal under the new key.
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = OLD;
        await expect(openUnsubscribeToken(oldLink)).resolves.toEqual({
            businessId: BIZ, normalizedEmail: EMAIL,
        });
        const newLink = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        expect(newLink).not.toBe(oldLink);
        await expect(openUnsubscribeToken(newLink)).resolves.toEqual({
            businessId: BIZ, normalizedEmail: EMAIL,
        });

        // A link sealed under a secret that was never retained stays dead.
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = 'some-unrelated-retained-secret-32-chars';
        await expect(openUnsubscribeToken(oldLink)).resolves.toBeNull();

        process.env.OUTREACH_UNSUBSCRIBE_SECRET = originalCurrent;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = originalPrev;
    });

    it('accepts several retained generations, comma or newline separated', async () => {
        const A = 'generation-a-unsubscribe-secret-32-chars';
        const B = 'generation-b-unsubscribe-secret-32-chars';
        const C = 'generation-c-unsubscribe-secret-32-chars';
        const originalCurrent = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        const originalPrev = process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS;

        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = '';
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = A;
        const fromA = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = B;
        const fromB = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;

        process.env.OUTREACH_UNSUBSCRIBE_SECRET = C;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = `${A},\n  ${B}  `;
        expect(unsubscribeVerificationSecrets()).toEqual([C, A, B]);
        await expect(openUnsubscribeToken(fromA)).resolves.not.toBeNull();
        await expect(openUnsubscribeToken(fromB)).resolves.not.toBeNull();

        process.env.OUTREACH_UNSUBSCRIBE_SECRET = originalCurrent;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = originalPrev;
    });

    it('retired secrets are verification-only — never used to seal', async () => {
        const originalCurrent = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        const originalPrev = process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS;
        // No current secret at all, only a retained one: sealing must refuse
        // rather than quietly mint under a key that is on its way out.
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = '';
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = 'a-retired-but-retained-secret-32-chars!!';
        expect(unsubscribeSecret()).toBeNull();
        await expect(sealUnsubscribeToken({ businessId: BIZ, email: EMAIL })).resolves.toBeNull();
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = originalCurrent;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = originalPrev;
    });

    it('ignores retained values too short to be secrets, and caps the list', async () => {
        const originalPrev = process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = 'short,,   ,also-short';
        expect(unsubscribeVerificationSecrets()).toEqual([process.env.OUTREACH_UNSUBSCRIBE_SECRET!.trim()]);
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS =
            Array.from({ length: 12 }, (_, i) => `retained-secret-generation-${i}-padding-32`).join(',');
        expect(unsubscribeVerificationSecrets().length).toBeLessThanOrEqual(5);
        process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = originalPrev;
    });

    it('tolerates a secret pasted with surrounding whitespace', async () => {
        const original = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        const clean = 'whitespace-tolerance-unsubscribe-secret!!';
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = clean;
        const t = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        // The same secret, as it arrives from a dashboard paste.
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = `  ${clean}\n`;
        await expect(openUnsubscribeToken(t)).resolves.toEqual({ businessId: BIZ, normalizedEmail: EMAIL });
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = original;
    });

    it('refuses to seal an implausible address or a missing tenant', async () => {
        for (const bad of ['', '   ', 'no-at', 'a@b', 'a b@c.com']) {
            await expect(sealUnsubscribeToken({ businessId: BIZ, email: bad })).resolves.toBeNull();
        }
        await expect(sealUnsubscribeToken({ businessId: '  ', email: EMAIL })).resolves.toBeNull();
    });

    it('two seals of the same input differ, and both resolve', async () => {
        const a = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const b = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        expect(a).not.toBe(b);                     // random IV, not a stable fingerprint
        expect(await openUnsubscribeToken(a)).toEqual(await openUnsubscribeToken(b));
    });
});

/**
 * A test-local sealer, using the same HKDF+AES-GCM parameters as the module.
 *
 * It exists to seal payloads the real `sealUnsubscribeToken` would never
 * produce — an unnormalized address, an implausible one, a chosen IV. Without
 * it, the inbound and outbound normalization layers can only be tested as a
 * pair, and each one looks redundant because the other covers for it.
 */
const KEY_INFO = 'freezeriq/outreach-unsubscribe/v1';
async function craftToken(payload: object, ivBytes?: number[]): Promise<string> {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw',
        enc.encode(process.env.OUTREACH_UNSUBSCRIBE_SECRET!), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(KEY_INFO), info: enc.encode(KEY_INFO) },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = ivBytes ? new Uint8Array(ivBytes) : crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
        enc.encode(JSON.stringify(payload))));
    const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `v1.${b64url(iv)}.${b64url(ct)}`;
}

/** Decrypts a real token so the SEALED payload itself can be inspected. */
async function peekSealedPayload(token: string): Promise<any> {
    const enc = new TextEncoder();
    const [, ivPart, bodyPart] = token.split('.');
    const un = (s: string) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    const base = await crypto.subtle.importKey('raw',
        enc.encode(process.env.OUTREACH_UNSUBSCRIBE_SECRET!), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(KEY_INFO), info: enc.encode(KEY_INFO) },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un(ivPart) }, key, un(bodyPart));
    return JSON.parse(new TextDecoder().decode(opened));
}

describe('OUTREACH-CONSENT-1 · each normalization layer, independently', () => {
    it('SEALING normalizes: the ciphertext itself holds the canonical address', async () => {
        const t = (await sealUnsubscribeToken({ businessId: BIZ, email: '  Bonnie@Example.COM ' }))!;
        // Inspected without going through openUnsubscribeToken, so the outbound
        // normalizer cannot cover for a missing inbound one.
        const sealed = await peekSealedPayload(t);
        expect(sealed.e).toBe('bonnie@example.com');
        expect(sealed.b).toBe(BIZ);
    });

    it('OPENING normalizes: a token sealed with a raw address still resolves canonically', async () => {
        // The shape an older build with a laxer rule would have produced.
        const t = await craftToken({ b: BIZ, e: '  Bonnie@Example.COM ' });
        await expect(openUnsubscribeToken(t)).resolves.toEqual({
            businessId: BIZ, normalizedEmail: 'bonnie@example.com',
        });
    });

    it('OPENING rejects an implausible address even when it was sealed successfully', async () => {
        for (const bad of ['not-an-address', 'a@b', '', '   ', 'a b@c.com']) {
            await expect(openUnsubscribeToken(await craftToken({ b: BIZ, e: bad }))).resolves.toBeNull();
        }
    });

    it('OPENING rejects a payload with a missing or blank tenant', async () => {
        await expect(openUnsubscribeToken(await craftToken({ e: EMAIL }))).resolves.toBeNull();
        await expect(openUnsubscribeToken(await craftToken({ b: '   ', e: EMAIL }))).resolves.toBeNull();
        await expect(openUnsubscribeToken(await craftToken({ b: 42, e: EMAIL }))).resolves.toBeNull();
    });

    it('is not malleable — a standard-base64 alias of a valid token is refused', async () => {
        // An IV whose base64url encoding is all '-' and '_', so the alias is
        // unambiguous. Both spellings decode to identical bytes, so only a
        // charset check can tell them apart.
        const iv = [0xFB, 0xFF, 0xFF, 0xFB, 0xFF, 0xFF, 0xFB, 0xFF, 0xFF, 0xFB, 0xFF, 0xFF];
        const real = await craftToken({ b: BIZ, e: EMAIL }, iv);
        const [v, ivPart, body] = real.split('.');
        expect(ivPart).toBe('-___-___-___-___');

        await expect(openUnsubscribeToken(real)).resolves.not.toBeNull();
        const alias = `${v}.${ivPart.replace(/-/g, '+').replace(/_/g, '/')}.${body}`;
        expect(alias).not.toBe(real);
        await expect(openUnsubscribeToken(alias)).resolves.toBeNull();
    });
});

// ── Part G / H — footer and headers ────────────────────────────────────────
describe('OUTREACH-CONSENT-1 · footer and headers', () => {
    const content = { subject: 'Our fundraiser', html: '<p>Hello</p>', text: 'Hello' };

    it('appends a recipient-specific link to both bodies', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const out = applyUnsubscribeFooter(content, { token, origin: ORIGIN, brandName: 'Freezer Chef' })!;
        const page = buildUnsubscribePageUrl(ORIGIN, token);
        expect(out.html).toContain(page);
        expect(out.text).toContain(page);
        expect(out.html).toContain('Unsubscribe from promotional emails');
        // The coordinator's own words survive untouched above the footer.
        expect(out.html).toContain('<p>Hello</p>');
        expect(out.text.startsWith('Hello')).toBe(true);
        expect(out.subject).toBe('Our fundraiser');
    });

    it('emits List-Unsubscribe and the one-click POST header together', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const out = applyUnsubscribeFooter(content, { token, origin: ORIGIN })!;
        expect(out.headers['List-Unsubscribe']).toBe(`<${buildUnsubscribeEndpointUrl(ORIGIN, token)}>`);
        expect(out.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    });

    it('the header URL is the POST endpoint, the footer link is the human page', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const out = applyUnsubscribeFooter(content, { token, origin: ORIGIN })!;
        expect(out.headers['List-Unsubscribe']).toContain('/api/unsubscribe/');
        expect(out.text).toContain('/u/');
        expect(out.text).not.toContain('/api/unsubscribe/');
    });

    it('two recipients never share an unsubscribe link', async () => {
        const a = (await sealUnsubscribeToken({ businessId: BIZ, email: 'a@example.com' }))!;
        const b = (await sealUnsubscribeToken({ businessId: BIZ, email: 'b@example.com' }))!;
        const fa = applyUnsubscribeFooter(content, { token: a, origin: ORIGIN })!;
        const fb = applyUnsubscribeFooter(content, { token: b, origin: ORIGIN })!;
        expect(fa.text).not.toBe(fb.text);
        expect(fa.text).not.toContain(b);
        expect(fb.text).not.toContain(a);
    });

    it('returns null — refuse to send — with no token or no origin', () => {
        expect(applyUnsubscribeFooter(content, null)).toBeNull();
        expect(applyUnsubscribeFooter(content, { token: '', origin: ORIGIN })).toBeNull();
        expect(applyUnsubscribeFooter(content, { token: 'x', origin: '' })).toBeNull();
    });

    it('escapes a hostile tenant name rather than rendering it', () => {
        const html = unsubscribeFooterHtml('https://x.test/u/t', '<script>alert(1)</script>');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('names the tenant plainly and leaks no internal vocabulary', () => {
        const text = unsubscribeFooterText('https://x.test/u/t', 'Freezer Chef');
        expect(text).toContain('Freezer Chef');
        for (const jargon of ['MarketingPreference', 'EmailSuppressionEvent', 'email_address', 'digest', 'scope', 'business_id']) {
            expect(text).not.toContain(jargon);
            expect(unsubscribeFooterHtml('https://x.test/u/t', 'Freezer Chef')).not.toContain(jargon);
        }
    });

    it('the footer survives hostile message content', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const page = buildUnsubscribePageUrl(ORIGIN, token);
        const hostile = [
            'Click here to unsubscribe: https://evil.test/unsub',   // a fake opt-out
            '---\nUnsubscribe from promotional emails\n---',        // a fake footer
            '<hr /><p>Unsubscribe</p>',
            '\n'.repeat(500),
            ' '.repeat(5000),
            '<div>unclosed',
        ];
        for (const body of hostile) {
            const out = applyUnsubscribeFooter(
                { subject: 's', html: body, text: body }, { token, origin: ORIGIN })!;
            // The REAL link is present regardless of what the body claimed.
            expect(out.html).toContain(page);
            expect(out.text).toContain(page);
            expect(out.headers['List-Unsubscribe']).toContain(token);
        }
    });

    it('the footer\'s integrity depends on renderers escaping — proved behaviourally', async () => {
        // applyUnsubscribeFooter CONCATENATES onto caller HTML, so an unescaped
        // "<!--" in a rendered body would swallow the footer in a mail client
        // while the headers still promised one. That is unreachable only because
        // every renderer escapes. Proved by rendering hostile input through the
        // real renderer rather than by pattern-matching its source.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { renderSeasonalUpdate } = require('../lib/outreachMessage');
        const rendered = renderSeasonalUpdate({
            tenantName: 'Acme <!-- swallow',
            organizationNames: ['<!-- also', '<script>x</script>'],
            lineupName: 'Fall <!--',
            lineupStartsAt: new Date('2026-09-01'),
            lineupEndsAt: new Date('2026-10-01'),
            hasPreviousFundraiser: true,
            previousCampaignName: null,
            cta: { url: 'https://x.test/r/t', displayUrl: 'x.test/r/t' },
        });
        // The comment opener never survives as markup.
        expect(rendered.html).not.toContain('<!--');
        expect(rendered.html).not.toContain('<script>');

        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const out = applyUnsubscribeFooter(rendered, { token, origin: ORIGIN })!;
        expect(out.html).toContain(buildUnsubscribePageUrl(ORIGIN, token));
        // Nothing left open that could hide the appended footer.
        expect((out.html.match(/<!--/g) ?? []).length).toBe(0);
    });

    it('headers are exactly the two, and nothing else', () => {
        expect(Object.keys(unsubscribeHeaders('https://x.test/api/unsubscribe/t')).sort())
            .toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
    });
});

// ── Part I — write authority ───────────────────────────────────────────────
type PrefRow = {
    id: string; business_id: string; scope: string; contact_id: string | null;
    normalized_email: string | null; status: string; effective_until: Date | null;
    source: string; recorded_by_user_id: string | null; effective_at?: Date; permission_note?: string | null;
};

function fakePrisma() {
    const prefs: PrefRow[] = [];
    const events: any[] = [];
    let n = 0;
    const api: any = {
        marketingPreference: {
            findFirst: async ({ where, select }: any) => {
                const hit = prefs.find((p) =>
                    p.business_id === where.business_id
                    && (where.scope === undefined || p.scope === where.scope)
                    && (where.contact_id === undefined || p.contact_id === where.contact_id)
                    && (where.normalized_email === undefined || p.normalized_email === where.normalized_email));
                return hit ? { ...hit } : null;
            },
            findMany: async ({ where }: any) => prefs.filter((p) => {
                if (p.business_id !== where.business_id) return false;
                if (!where.OR) return true;
                return where.OR.some((o: any) =>
                    (o.scope === 'contact' && p.scope === 'contact' && o.contact_id?.in?.includes(p.contact_id))
                    || (o.scope === 'email_address' && p.scope === 'email_address' && o.normalized_email === p.normalized_email));
            }).map((p) => ({ ...p })),
            update: async ({ where, data }: any) => {
                const row = prefs.find((p) => p.id === where.id)!;
                Object.assign(row, data);
                return { ...row };
            },
            create: async ({ data }: any) => {
                const row = { id: `p${++n}`, contact_id: null, normalized_email: null, ...data } as PrefRow;
                prefs.push(row);
                return { ...row };
            },
        },
        emailSuppressionEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
        $transaction: async (fn: any) => fn(api),
        __prefs: prefs,
        __events: events,
    };
    return api;
}

describe('OUTREACH-CONSENT-1 · durable write', () => {
    it('writes exactly one tenant+address preference following the real schema', async () => {
        const p = fakePrisma();
        const r = await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL });
        expect(r).toEqual({ changed: true, alreadyUnsubscribed: false });
        expect(p.__prefs).toHaveLength(1);
        expect(p.__prefs[0]).toMatchObject({
            business_id: BIZ,
            scope: 'email_address',
            normalized_email: EMAIL,
            status: 'unsubscribed',
            effective_until: null,        // an opt-out does not lapse
            source: 'contact_request',    // the recipient asked, not the tenant
            recorded_by_user_id: null,
        });
        expect(p.__prefs[0].contact_id ?? null).toBeNull();
    });

    it('appends an unsubscribe history event beside it', async () => {
        const p = fakePrisma();
        await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL });
        expect(p.__events).toHaveLength(1);
        expect(p.__events[0]).toMatchObject({
            business_id: BIZ, event_type: 'unsubscribe',
            normalized_email: EMAIL, source: 'contact_request', effective_until: null,
        });
    });

    it('is idempotent — repeats do not pile up rows', async () => {
        const p = fakePrisma();
        await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL });
        const second = await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL });
        const third = await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL });
        expect(second).toEqual({ changed: false, alreadyUnsubscribed: true });
        expect(third.alreadyUnsubscribed).toBe(true);
        expect(p.__prefs).toHaveLength(1);
        expect(p.__events).toHaveLength(1);   // no growing pile of identical history
    });

    it('upgrades an existing time-boxed pause into a permanent opt-out', async () => {
        const p = fakePrisma();
        await p.marketingPreference.create({
            data: {
                business_id: BIZ, scope: 'email_address', normalized_email: EMAIL,
                status: 'paused', effective_until: new Date('2027-01-01'), source: 'tenant',
                recorded_by_user_id: 'u1',
            },
        });
        await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL });
        expect(p.__prefs).toHaveLength(1);
        expect(p.__prefs[0].status).toBe('unsubscribed');
        expect(p.__prefs[0].effective_until).toBeNull();
        expect(p.__prefs[0].source).toBe('contact_request');
    });

    it('never touches another tenant\'s preference for the same address', async () => {
        const p = fakePrisma();
        await recordUnsubscribe(p, { businessId: OTHER, normalizedEmail: EMAIL });
        const mine = await p.marketingPreference.findFirst({
            where: { business_id: BIZ, scope: 'email_address', normalized_email: EMAIL },
        });
        expect(mine).toBeNull();
        expect(p.__prefs).toHaveLength(1);
        expect(p.__prefs[0].business_id).toBe(OTHER);
    });
});

// ── Part J — the end-to-end suppression proof ──────────────────────────────
describe('OUTREACH-CONSENT-1 · send-time suppression honours the public opt-out', () => {
    const recipient: SendableRecipient = {
        recipientId: 'r1', normalizedEmail: EMAIL, displayName: 'Bonnie', contactIds: [], organizationNames: [],
    };

    it('eligible before, suppressed after, refused BEFORE the provider', async () => {
        const p = fakePrisma();
        const now = new Date('2026-08-26T12:00:00Z');

        // 1. Before: the send-time authority says this person is reachable.
        await expect(checkSuppressionAtSend(p, BIZ, recipient, now))
            .resolves.toEqual({ suppressed: false, reason: null });

        // 2. The public unsubscribe flow runs — token in, durable state out.
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const payload = (await openUnsubscribeToken(token))!;
        await recordUnsubscribe(p, payload, now);

        // 3. After: the SERVER check refuses, not a UI filter.
        const after = await checkSuppressionAtSend(p, BIZ, recipient, now);
        expect(after.suppressed).toBe(true);
        expect(after.reason).toBeTruthy();
    });

    it('runSend skips the unsubscribed recipient and never calls the provider', async () => {
        const p = fakePrisma();
        const now = new Date('2026-08-26T12:00:00Z');
        const calls: any[] = [];

        // Delivery-attempt plumbing runSend needs.
        const attempts: any[] = [];
        p.emailDeliveryAttempt = {
            create: async ({ data, select }: any) => {
                if (attempts.some((a) => a.idempotency_key === data.idempotency_key)) throw new Error('unique');
                const row = { id: `a${attempts.length + 1}`, ...data };
                attempts.push(row);
                return select ? { id: row.id } : row;
            },
            update: async ({ where, data }: any) => {
                const row = attempts.find((a) => a.id === where.id)!;
                Object.assign(row, data);
                return row;
            },
        };

        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        await recordUnsubscribe(p, (await openUnsubscribeToken(token))!, now);

        const summary = await runSend({
            prisma: p, businessId: BIZ, batchId: 'b', messageId: 'm', generation: 1,
            recipients: [recipient],
            provider: { send: async (i: any) => { calls.push(i); return { outcome: 'accepted', providerMessageId: 'x' }; } },
            render: () => ({ subject: 's', html: '<p>h</p>', text: 't' }),
            from: 'a@b.co', now,
            unsubscribe: { origin: ORIGIN, brandName: 'Freezer Chef' },
        });

        expect(calls).toHaveLength(0);                       // provider never contacted
        expect(summary.skipped).toBe(1);
        expect(summary.accepted).toBe(0);
        expect(attempts[0].status).toBe('skipped_suppressed');
    });

    it('an unsubscribed person is NOT restored by appearing in a new campaign', async () => {
        const p = fakePrisma();
        const now = new Date('2026-08-26T12:00:00Z');
        await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL }, now);
        // A fresh audience, a new recipient row, a different campaign — the
        // preference is keyed on tenant+address and survives all of it.
        const laterRecipient: SendableRecipient = {
            recipientId: 'r-new', normalizedEmail: EMAIL, displayName: 'Bonnie',
            contactIds: ['c-new'], organizationNames: ['Another Org'],
        };
        const check = await checkSuppressionAtSend(p, BIZ, laterRecipient, new Date('2027-05-01T00:00:00Z'));
        expect(check.suppressed).toBe(true);
    });

    it('the opt-out is tenant-scoped — another tenant is unaffected', async () => {
        const p = fakePrisma();
        const now = new Date('2026-08-26T12:00:00Z');
        await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL }, now);
        await expect(checkSuppressionAtSend(p, BIZ, recipient, now)).resolves.toMatchObject({ suppressed: true });
        await expect(checkSuppressionAtSend(p, OTHER, recipient, now)).resolves.toEqual({ suppressed: false, reason: null });
    });

    it('runSend refuses the whole run when no unsubscribe capability exists', async () => {
        const p = fakePrisma();
        const calls: any[] = [];
        const original = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = '';
        const summary = await runSend({
            prisma: p, businessId: BIZ, batchId: 'b', messageId: 'm', generation: 1,
            recipients: [recipient],
            provider: { send: async (i: any) => { calls.push(i); return { outcome: 'accepted', providerMessageId: 'x' }; } },
            render: () => ({ subject: 's', html: '<p>h</p>', text: 't' }),
            from: 'a@b.co', now: new Date(),
            unsubscribe: { origin: ORIGIN },
        });
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = original;
        expect(calls).toHaveLength(0);
        expect(summary.batchStatus).toBe('failed_before_send');
        expect(summary.attempted).toBe(0);
    });
});

// ── The route handler, actually invoked ────────────────────────────────────
//
// Source assertions cannot tell "returns refuse()" from "returns ok" — the
// mutation battery proved exactly that. So the handlers are imported and run
// against a fake prisma, and the assertions are about what comes back and what
// was written.
const routePrisma = fakePrisma();
jest.mock('@/lib/db', () => ({ prisma: routePrismaRef.current }));
const routePrismaRef = { current: routePrisma } as { current: any };

describe('OUTREACH-CONSENT-1 · route handler behaviour', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const route = require('../app/api/unsubscribe/[token]/route');
    const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
    const req = () => new Request('https://www.freezeriqapp.com/api/unsubscribe/x', { method: 'POST' });

    beforeEach(() => {
        routePrisma.__prefs.length = 0;
        routePrisma.__events.length = 0;
    });

    it('POST with a valid token unsubscribes exactly that address', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const res = await route.POST(req(), ctx(token));
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ ok: true, alreadyUnsubscribed: false });
        expect(routePrisma.__prefs).toHaveLength(1);
        expect(routePrisma.__prefs[0]).toMatchObject({
            business_id: BIZ, normalized_email: EMAIL, status: 'unsubscribed',
        });
    });

    it('POST is idempotent — a repeat says already, and writes nothing more', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        await route.POST(req(), ctx(token));
        const second = await route.POST(req(), ctx(token));
        expect(second.status).toBe(200);
        await expect(second.json()).resolves.toMatchObject({ ok: true, alreadyUnsubscribed: true });
        expect(routePrisma.__prefs).toHaveLength(1);
        expect(routePrisma.__events).toHaveLength(1);
    });

    it('POST with an invalid token REFUSES and writes nothing', async () => {
        for (const bad of ['nonsense', '', 'v1.aa.bb', 'v9.aa.bb']) {
            const res = await route.POST(req(), ctx(bad));
            expect(res.status).toBe(400);
            await expect(res.json()).resolves.toMatchObject({ ok: false });
            expect(routePrisma.__prefs).toHaveLength(0);
            expect(routePrisma.__events).toHaveLength(0);
        }
    });

    it('POST cannot be redirected at another address by the request body', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const hostile = new Request('https://www.freezeriqapp.com/api/unsubscribe/x', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'victim@example.com', businessId: OTHER, status: 'unsubscribed' }),
        });
        await route.POST(hostile, ctx(token));
        expect(routePrisma.__prefs).toHaveLength(1);
        expect(routePrisma.__prefs[0].normalized_email).toBe(EMAIL);
        expect(routePrisma.__prefs[0].normalized_email).not.toBe('victim@example.com');
        expect(routePrisma.__prefs[0].business_id).toBe(BIZ);
    });

    it('accepts the RFC 8058 one-click POST a mailbox provider actually sends', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        // The exact shape: form-encoded body, no cookies, no Origin, cross-site.
        const oneClick = new Request('https://www.freezeriqapp.com/api/unsubscribe/x', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
        });
        const res = await route.POST(oneClick, ctx(token));
        expect(res.status).toBe(200);
        expect(routePrisma.__prefs).toHaveLength(1);
        expect(routePrisma.__prefs[0].normalized_email).toBe(EMAIL);
    });

    it('does NOT require same-origin — that would reject every provider one-click', () => {
        // A deliberate difference from the coordinator routes, which DO require
        // it. If someone later "hardens" this endpoint the same way, mailbox
        // one-click unsubscribe silently stops working and nobody finds out.
        const src = R(ROUTE);
        expect(src).not.toContain('isSameOriginMutation');
        expect(src).not.toContain('requiresSameOriginCheck');
    });

    it('GET does NOT unsubscribe — a scanner fetch leaves no trace', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const res = await route.GET(new Request('https://x.test/api/unsubscribe/t'), ctx(token));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('/u/');
        expect(routePrisma.__prefs).toHaveLength(0);
        expect(routePrisma.__events).toHaveLength(0);
    });

    it('no response ever contains the address or the token', async () => {
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const body = await (await route.POST(req(), ctx(token))).text();
        expect(body).not.toContain(EMAIL);
        expect(body).not.toContain(token);
        expect(body).not.toContain(BIZ);
    });
});

// ── Shipped-source contracts ───────────────────────────────────────────────
const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ROUTE = 'app/api/unsubscribe/[token]/route.ts';
const PAGE = 'app/u/[token]/page.tsx';

describe('OUTREACH-CONSENT-1 · public route (shipped source)', () => {
    const route = strip(R(ROUTE));

    it('GET redirects and never writes', () => {
        const get = route.slice(route.indexOf('export async function GET('), route.indexOf('export async function POST('));
        expect(get).toContain('NextResponse.redirect');
        expect(get).not.toContain('recordUnsubscribe');
        expect(get).not.toContain('openUnsubscribeToken');
        for (const w of ['.create(', '.update(', '.upsert(', '.delete(']) expect(get).not.toContain(w);
    });

    it('POST resolves the token and writes only the resolved payload', () => {
        const post = route.slice(route.indexOf('export async function POST('));
        expect(post).toContain('openUnsubscribeToken(token)');
        expect(post).toContain('recordUnsubscribe(prisma, payload)');
    });

    it('reads NO email, tenant, scope or status from the client', () => {
        expect(route).not.toContain('req.json()');
        expect(route).not.toContain('searchParams');
        for (const f of ['body?.email', 'body?.businessId', 'body?.business_id', 'body?.scope', 'body?.status']) {
            expect(route).not.toContain(f);
        }
    });

    it('gives one non-disclosing answer for every bad token', () => {
        expect(route).toContain("error: 'This unsubscribe link is not valid.'");
        expect(route).not.toMatch(/not\s+found|unknown\s+tenant|no\s+such\s+address/i);
    });

    it('never logs the token', () => {
        const logs = route.split('\n').filter((l) => /console\.(log|error|warn)/.test(l));
        expect(logs.length).toBeGreaterThan(0);
        for (const l of logs) expect(l).not.toMatch(/\btoken\b/);
    });

    it('touches no supporter, order, campaign or invoice data', () => {
        for (const m of ['order.', 'customer.', 'fundraiserCampaign', 'invoice']) {
            expect(route).not.toContain(m);
        }
    });
});

describe('OUTREACH-CONSENT-1 · public page (shipped source)', () => {
    const page = strip(R(PAGE));

    it('does nothing on load — only the button acts', () => {
        expect(page).not.toContain('useEffect');
        expect(page).toContain('onClick={submit}');
        expect(page).toContain("method: 'POST'");
    });

    it('never displays the address', () => {
        expect(page).not.toContain('normalizedEmail');
        expect(page).not.toMatch(/\{email\}/);
    });

    it('uses plain language, not internal vocabulary', () => {
        for (const jargon of ['MarketingPreference', 'EmailSuppressionEvent', 'email_address', 'business_id', 'digest', 'token payload']) {
            expect(page).not.toContain(jargon);
        }
        expect(page).toContain('Unsubscribe from promotional emails');
    });

    it('makes no promise it cannot keep', () => {
        expect(page).toContain('promotional');
        expect(page).not.toMatch(/all emails|never email you|any email/i);
    });
});

describe('OUTREACH-CONSENT-1 · send-path integration (shipped source)', () => {
    const send = strip(R('lib/outreachSend.ts'));

    it('applies the footer to render()\'s OUTPUT, so no caller can omit it', () => {
        const applyAt = send.indexOf('applyUnsubscribeFooter(content');
        expect(applyAt).toBeGreaterThan(send.indexOf('content = await render(r)'));
        expect(applyAt).toBeLessThan(send.indexOf('provider.send(payload)'));
    });

    it('sends the footered bodies and headers, never the raw rendered ones', () => {
        const payload = send.slice(send.indexOf('const payload: ProviderSendInput = {'));
        const args = payload.slice(0, payload.indexOf('};'));
        expect(args).toContain('html: withFooter.html');
        expect(args).toContain('text: withFooter.text');
        expect(args).toContain('headers: withFooter.headers');
        expect(args).not.toContain('html: content.html');
        expect(args).not.toContain('text: content.text');
    });

    it('requires an unsubscribe capability rather than defaulting one', () => {
        expect(send).toContain('unsubscribe: { origin: string; brandName?: string | null };');
        expect(send).toContain('if (!unsubscribeSecret() || !unsubscribe?.origin)');
        expect(send).toContain("batchStatus: 'failed_before_send'");
    });

    it('a missing footer fails the recipient rather than sending without one', () => {
        expect(send).toContain('if (!withFooter) {');
        expect(send).toContain("We couldn't add an unsubscribe link to this email.");
    });
});

describe('OUTREACH-CONSENT-1 · the seasonal preview send is not a back door', () => {
    const seasonalRaw = R('app/api/rebooking/seasonal-lineups/[id]/send/route.ts');
    const seasonal = strip(seasonalRaw);
    // Sliced on the RAW source: the section marker is a comment, and strip()
    // would delete it, silently turning indexOf into -1 and making this "branch"
    // the whole file.
    const realSendAt = seasonalRaw.indexOf('── REAL SEND');
    const testAt = seasonalRaw.indexOf("if (mode === 'test')");
    const testBranch = seasonalRaw.slice(testAt, realSendAt);

    it('the slice really is only the preview branch', () => {
        expect(testAt).toBeGreaterThan(-1);
        expect(realSendAt).toBeGreaterThan(testAt);
        expect(testBranch).toContain('isTest: true');
        expect(testBranch).not.toContain('runSend(');   // the real send is outside it
    });

    it('the preview refuses an address that already unsubscribed', () => {
        // This branch calls the provider DIRECTLY, so it inherits none of
        // runSend's protections unless they are applied here.
        expect(testBranch).toContain('checkSuppressionAtSend(');
        expect(testBranch).toContain('if (previewSuppression.suppressed) {');
        expect(testBranch).toContain('{ status: 409 }');
        // And it checks the CANONICAL normalized form, not the raw typed value.
        expect(testBranch).toContain('normalizeEmail(destination)');
    });

    it('the preview carries the same footer and headers as the real send', () => {
        expect(testBranch).toContain('applyUnsubscribeFooter(rendered');
        expect(testBranch).toContain('headers: previewContent.headers');
        expect(testBranch).toContain('html: previewContent.html');
        // The raw rendered body must not be what goes out.
        expect(testBranch).not.toContain('html: rendered.html');
        expect(testBranch).not.toContain('text: rendered.text');
    });

    it('the preview refuses rather than sending without an opt-out', () => {
        expect(testBranch).toContain('if (!previewContent) {');
        expect(testBranch).toContain('{ status: 503 }');
    });

    it('the preview token is sealed for the actual destination', () => {
        expect(testBranch).toContain('sealUnsubscribeToken({ businessId, email: destination })');
    });

    it('the real send is the only other provider path, and it goes through runSend', () => {
        const providerCalls = (seasonal.match(/provider\.send\(/g) ?? []).length;
        expect(providerCalls).toBe(1);          // only the preview calls it directly
        expect(seasonal).toContain('await runSend({');
        expect(seasonal).toContain('unsubscribe: { origin: resolveOutreachOrigin(req), brandName: business.name }');
    });
});

describe('OUTREACH-CONSENT-1 · adversarial review fixes', () => {
    it('a concurrent unsubscribe losing the unique-index race still succeeds', async () => {
        // marketing_preferences_one_per_email is a PARTIAL unique index in raw
        // SQL, invisible to Prisma. Read-then-write is not atomic against it, and
        // the loser must not be told "something went wrong" about an opt-out that
        // did in fact take effect.
        const p = fakePrisma();
        let firstInsert = true;
        const realCreate = p.marketingPreference.create;
        p.marketingPreference.create = async (args: any) => {
            if (firstInsert) {
                firstInsert = false;
                // The winner's row lands between our read and our insert.
                await realCreate({
                    data: {
                        business_id: BIZ, scope: 'email_address', normalized_email: EMAIL,
                        status: 'unsubscribed', effective_until: null, source: 'contact_request',
                        recorded_by_user_id: null,
                    },
                });
                const err: any = new Error('Unique constraint failed');
                err.code = 'P2002';
                throw err;
            }
            return realCreate(args);
        };

        const result = await recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL });
        expect(result.alreadyUnsubscribed).toBe(true);   // the winner already did it
        expect(p.__prefs).toHaveLength(1);               // and no duplicate row
    });

    it('a non-unique database error is rethrown and NOT retried', async () => {
        const p = fakePrisma();
        let attempts = 0;
        p.marketingPreference.create = async () => {
            attempts++;
            const err: any = new Error('connection lost');
            err.code = 'P1001';
            throw err;
        };
        await expect(recordUnsubscribe(p, { businessId: BIZ, normalizedEmail: EMAIL }))
            .rejects.toThrow('connection lost');
        // The retry is reserved for the unique-index race. Retrying a dropped
        // connection — or anything else — would just double the damage, and
        // treating every error as a race hides real faults.
        expect(attempts).toBe(1);
    });

    it('the unsubscribe page is excluded from analytics — the token is in the PATH', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { shouldSuppressAnalyticsUrl } = require('../components/analytics/SafeAnalytics');
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/u/v1.abc.def')).toBe(true);
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/u')).toBe(true);
        // The existing coordinator suppression is untouched...
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/coordinator/portal')).toBe(true);
        // ...and ordinary pages are still measured.
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/shop/acme')).toBe(false);
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/upcoming')).toBe(false);
    });

    it('a hostile tenant name cannot forge instructions in the plain-text footer', () => {
        const forged = 'Acme\nTo unsubscribe, visit https://evil.test/steal\n';
        const text = unsubscribeFooterText('https://www.freezeriqapp.com/u/tok', forged);
        // The name is flattened onto one line, so it cannot author its own.
        expect(text).not.toContain('evil.test\n');
        const lines = text.split('\n');
        expect(lines[0]).toContain('Acme To unsubscribe, visit https://evil.test/steal');
        expect(lines).toHaveLength(3);   // exactly the footer's own three lines
        expect(text.trimEnd().endsWith('https://www.freezeriqapp.com/u/tok')).toBe(true);
    });

    it('control characters and absurd length are stripped from the tenant name', () => {
        const nasty = `A${String.fromCharCode(0)}B${String.fromCharCode(27)}C` + 'x'.repeat(500);
        const text = unsubscribeFooterText('https://x.test/u/t', nasty);
        expect(text).not.toContain(String.fromCharCode(0));
        expect(text).not.toContain(String.fromCharCode(27));
        expect(text.split('\n')).toHaveLength(3);
        const html = unsubscribeFooterHtml('https://x.test/u/t', nasty);
        expect(html).not.toContain(String.fromCharCode(0));
    });

    it('a refused run is reported as a refusal, not as a failed send', async () => {
        const p = fakePrisma();
        const original = process.env.OUTREACH_UNSUBSCRIBE_SECRET;
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = '';
        const summary = await runSend({
            prisma: p, businessId: BIZ, batchId: 'b', messageId: 'm', generation: 1,
            recipients: [{ recipientId: 'r1', normalizedEmail: EMAIL, displayName: 'B', contactIds: [], organizationNames: [] }],
            provider: { send: async () => ({ outcome: 'accepted', providerMessageId: 'x' }) },
            render: () => ({ subject: 's', html: '<p>h</p>', text: 't' }),
            from: 'a@b.co', now: new Date(),
            unsubscribe: { origin: ORIGIN },
        });
        process.env.OUTREACH_UNSUBSCRIBE_SECRET = original;
        expect(summary.refusal).toBe('missing_unsubscribe_capability');
        expect(summary.attempted).toBe(0);
    });

    it('the missing-secret gate runs BEFORE the batch is moved to sending', () => {
        // This ordering is the whole defect. The route only accepts an
        // 'audience_ready' batch, and it sets 'sending' before runSend could
        // report a refusal — so checking late would strand the batch outside the
        // one status it can send from, permanently, over a config problem.
        const seasonal = strip(R('app/api/rebooking/seasonal-lineups/[id]/send/route.ts'));
        const gateAt = seasonal.indexOf('if (!unsubscribeSecret()) {');
        const sendingAt = seasonal.indexOf("data: { status: 'sending' }");
        const readyGateAt = seasonal.indexOf("batch.status !== 'audience_ready'");
        expect(gateAt).toBeGreaterThan(-1);
        expect(sendingAt).toBeGreaterThan(-1);
        expect(gateAt).toBeGreaterThan(readyGateAt);   // sits with the other readiness gates
        expect(gateAt).toBeLessThan(sendingAt);        // and before any state moves
        expect(seasonal).toContain("code: 'missing_unsubscribe_capability'");
    });

    it('the runSend backstop restores the batch instead of stranding it', () => {
        const seasonal = strip(R('app/api/rebooking/seasonal-lineups/[id]/send/route.ts'));
        const block = seasonal.slice(seasonal.indexOf('if (summary.refusal) {'));
        const body = block.slice(0, block.indexOf('        }'));
        expect(body).toContain("status: 'audience_ready'");
        expect(body).toContain("status: 'approved'");
        expect(body).toContain('send_started_at: null');
    });

    // NOTE: scripts/local-only-cp4-integration.ts also calls runSend and was
    // fixed to pass `unsubscribe`, but scripts/ is gitignored — asserting on it
    // here would fail on any fresh clone, so it is deliberately not tested.
});

describe('OUTREACH-CONSENT-1 · unsubscribe origin authority', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveOutreachOrigin, CANONICAL_COORDINATOR_ORIGIN } = require('../lib/fundraiserUrls');

    it('pins the platform origin in Production, whatever host served the request', () => {
        const original = process.env.NODE_ENV;
        (process.env as any).NODE_ENV = 'production';
        for (const hostile of [
            new Request('https://attacker.test/api/x'),
            new Request('https://freezeriq-app.vercel.app/api/x'),   // the .env.production NEXTAUTH_URL
            new Request('https://some-preview-abc123.vercel.app/api/x'),
            new Request('http://localhost:3000/api/x'),
        ]) {
            expect(resolveOutreachOrigin(hostile)).toBe(CANONICAL_COORDINATOR_ORIGIN);
        }
        expect(resolveOutreachOrigin()).toBe(CANONICAL_COORDINATOR_ORIGIN);
        (process.env as any).NODE_ENV = original;
    });

    it('a Production unsubscribe link can never be localhost, preview or attacker-controlled', async () => {
        const original = process.env.NODE_ENV;
        (process.env as any).NODE_ENV = 'production';
        const token = (await sealUnsubscribeToken({ businessId: BIZ, email: EMAIL }))!;
        const out = applyUnsubscribeFooter(
            { subject: 's', html: '<p>h</p>', text: 't' },
            { token, origin: resolveOutreachOrigin(new Request('https://attacker.test/x')) },
        )!;
        expect(out.text).toContain('https://www.freezeriqapp.com/u/');
        for (const bad of ['attacker.test', 'localhost', 'vercel.app']) {
            expect(out.text).not.toContain(bad);
            expect(out.headers['List-Unsubscribe']).not.toContain(bad);
        }
        (process.env as any).NODE_ENV = original;
    });

    it('the send routes use the PINNED resolver, not the request origin', () => {
        const seasonal = strip(R('app/api/rebooking/seasonal-lineups/[id]/send/route.ts'));
        expect(seasonal).toContain('unsubscribe: { origin: resolveOutreachOrigin(req)');
        expect(seasonal).not.toContain('unsubscribe: { origin, ');
        expect(seasonal).toContain('const testOrigin = resolveOutreachOrigin(req)');
    });

    it('the GET redirect uses the pinned origin, not NEXTAUTH_URL', () => {
        const route = strip(R(ROUTE));
        expect(route).toContain('resolveOutreachOrigin()');
        // NEXTAUTH_URL is a vercel.app host in .env.production — it must not be
        // where a real recipient is sent to opt out.
        expect(route).not.toContain('NEXTAUTH_URL');
    });
});

describe('OUTREACH-CONSENT-1 · transactional mail untouched', () => {
    it('no transactional sender imports the outreach footer or headers', () => {
        for (const f of ['lib/emailTemplates.ts', 'lib/email.ts', 'app/api/email/send/route.ts',
            'app/api/opportunities/[id]/respond/route.ts']) {
            const src = R(f);
            expect(src).not.toContain('outreachUnsubscribeFooter');
            expect(src).not.toContain('List-Unsubscribe');
        }
    });

    it('the provider passes headers through only when given them', () => {
        const prov = strip(R('lib/outreachProvider.ts'));
        expect(prov).toContain('...(input.headers ? { headers: input.headers } : {})');
    });
});

describe('OUTREACH-CONSENT-1 · FR-REBOOK-2 stays disarmed', () => {
    it('Previous Supporters sends THROUGH this consent engine, never around it', () => {
        const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
        // Armed now — and armed means it must go through runSend, which attaches
        // the footer and headers and re-checks suppression per recipient.
        expect(route).toContain('export async function POST(');
        expect(route).toContain('await runSend({');
        expect(route).toContain('unsubscribe: { origin, brandName:');
        expect(route).toContain('unsubscribeReady: Boolean(unsubscribeSecret())');
        // No direct provider call that would bypass all of it.
        expect(route).not.toMatch(/provider\.send\(/);
        expect(route).not.toContain('resend.emails.send');
    });

    it('the coordinator still edits plain text, with no HTML composer added', () => {
        const card = strip(R('components/coordinator/PreviousSupporters.tsx'));
        expect(card).not.toContain('dangerouslySetInnerHTML');
        expect(card).not.toContain('setHtml(');
        expect(card).toContain('setText(');
    });
});
