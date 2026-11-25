/**
 * BUNDLE-POSTER-USE-AS-IMAGE-1 — the signed receipt that lets a generated poster become the bundle's
 * official image, and nothing else.
 *
 * Generating a poster stores nothing: the JPEG goes back to the tenant's browser. "Use as Bundle Image"
 * sends those bytes back, and the server must be able to tell that they are exactly a poster IT made,
 * for THIS tenant and THIS bundle, with the settings the panel still shows, from the bundle as it is
 * now. So the poster route signs a receipt over:
 *
 *   - the tenant (business id) and the bundle id;
 *   - the SHA-256 of the poster bytes it returned;
 *   - the settings it was made with (theme, a digest of the cleaned background instructions, badge);
 *   - a fingerprint of everything the poster shows (bundle name, tier, description, the linked
 *     recipes in order with their names and photo links);
 *   - an expiry.
 *
 * The publish route accepts a poster only when the receipt verifies and every one of those still
 * matches. A URL is never accepted, so nothing is ever fetched on the tenant's say-so; arbitrary
 * bytes, another tenant's poster, another bundle's poster, an out-of-date poster or one whose controls
 * have since changed are all refused before storage is touched.
 *
 * HMAC-SHA256 with the app's existing Auth.js secret (the same source as lib/auth/oauthState.ts),
 * domain-separated by a fixed prefix so a receipt can never be mistaken for any other signed value.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PosterBundleRow } from '@/lib/poster/posterModel';
import { ADD_ON_BUNDLE_TYPE, BUNDLE_TYPE_SELECT, normalizeBundleType } from '@/lib/campaignAddOns';
import type { PosterThemeId } from '@/lib/poster/posterThemes';

/** A poster lives in one browser tab; half a day is plenty to look at it and decide. */
export const POSTER_RECEIPT_TTL_SECONDS = 12 * 60 * 60;
export const BUNDLE_IMAGE_UPDATED_MESSAGE = 'Bundle image updated successfully.';
/** Well above a 1600 × 2000 JPEG and under Vercel's 4.5 MB request-body limit. */
export const POSTER_PUBLISH_MAX_BYTES = 4 * 1024 * 1024;
const RECEIPT_MAX_LENGTH = 4096;
const DOMAIN = 'freezeriq/bundle-poster-receipt/v1\n';

/** The bundle columns a poster is drawn from — read identically by the poster and publish routes. */
export const POSTER_BUNDLE_SELECT = {
    id: true,
    name: true,
    serving_tier: true,
    // FR-SUPPORTER-ADDON-UPSELL-1: an add-on's poster prints no serving size (posterModel.posterSizeLabel).
    // Spread (typed {}) so this still compiles against a Prisma client generated before bundle_type existed.
    ...BUNDLE_TYPE_SELECT,
    description: true,
    contents: {
        orderBy: { position: 'asc' as const },
        select: { position: true, recipe: { select: { id: true, name: true, image_url: true } } },
    },
} as const;

export interface PosterReceipt {
    v: 1;
    /** Tenant the poster was made for. */
    biz: string;
    /** Bundle the poster was made for. */
    bundle: string;
    /** SHA-256 (hex) of the exact JPEG bytes returned. */
    sha: string;
    /** posterBundleFingerprint of the bundle as it was read for this poster. */
    fp: string;
    theme: PosterThemeId;
    /** posterNotesDigest of the cleaned background instructions. */
    notes: string;
    badge: boolean;
    /** Expiry, epoch seconds. */
    exp: number;
}

export function sha256Hex(data: string | Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

/** The cleaned instructions are not put in the receipt; only a digest is. */
export function posterNotesDigest(cleanedInstructions: string): string {
    return sha256Hex(`notes:${cleanedInstructions}`);
}

/**
 * Everything a poster shows, as one digest. Any change to the bundle's name, size, description, its
 * recipes, their order, names or photo links makes a poster made earlier out of date. The bundle's
 * own image, price, SKU and flags are deliberately not part of it: the poster does not show them.
 */
export function posterBundleFingerprint(bundle: PosterBundleRow): string {
    const contents = [...bundle.contents]
        .map((c) => [c.position ?? null, c.recipe?.id ?? null, c.recipe?.name ?? null, c.recipe?.image_url ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    // An add-on's poster differs (no serving size), so its type is part of what a receipt vouches for. Meal
    // bundles hash exactly as before, so their fingerprints are unchanged.
    const addOn = normalizeBundleType(bundle.bundle_type) === ADD_ON_BUNDLE_TYPE ? [ADD_ON_BUNDLE_TYPE] : [];
    return sha256Hex(JSON.stringify([bundle.id, bundle.name, bundle.serving_tier ?? null, bundle.description ?? null, contents, ...addOn]));
}

/** The signing secret, or null when the deployment has none (then nothing can be published). */
export function posterSigningSecret(env: Record<string, string | undefined> = process.env): string | null {
    const s = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
    return typeof s === 'string' && s.length > 0 ? s : null;
}

const b64url = (b: Buffer) => b.toString('base64url');
const mac = (secret: string, body: string) => createHmac('sha256', secret).update(DOMAIN + body).digest();

export function signPosterReceipt(fields: Omit<PosterReceipt, 'v' | 'exp'>, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const receipt: PosterReceipt = { v: 1, ...fields, exp: nowSeconds + POSTER_RECEIPT_TTL_SECONDS };
    const body = b64url(Buffer.from(JSON.stringify(receipt), 'utf8'));
    return `${body}.${b64url(mac(secret, body))}`;
}

export type ReceiptCheck =
    | { ok: true; receipt: PosterReceipt }
    | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

const HEX64 = /^[0-9a-f]{64}$/;

/** Every failure is a refusal; a receipt is never partly trusted. */
export function verifyPosterReceipt(raw: unknown, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): ReceiptCheck {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > RECEIPT_MAX_LENGTH || !secret) return { ok: false, reason: 'malformed' };
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot !== raw.lastIndexOf('.') || dot === raw.length - 1) return { ok: false, reason: 'malformed' };
    const body = raw.slice(0, dot);
    const given = Buffer.from(raw.slice(dot + 1), 'base64url');
    const expected = mac(secret, body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };

    let r: any;
    try {
        r = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!r || typeof r !== 'object' || Array.isArray(r) || r.v !== 1) return { ok: false, reason: 'malformed' };
    if (typeof r.biz !== 'string' || !r.biz || typeof r.bundle !== 'string' || !r.bundle) return { ok: false, reason: 'malformed' };
    if (!HEX64.test(r.sha) || !HEX64.test(r.fp) || !HEX64.test(r.notes)) return { ok: false, reason: 'malformed' };
    if (typeof r.theme !== 'string' || typeof r.badge !== 'boolean') return { ok: false, reason: 'malformed' };
    if (typeof r.exp !== 'number' || !Number.isFinite(r.exp)) return { ok: false, reason: 'malformed' };
    if (r.exp <= nowSeconds) return { ok: false, reason: 'expired' };
    return { ok: true, receipt: { v: 1, biz: r.biz, bundle: r.bundle, sha: r.sha, fp: r.fp, theme: r.theme, notes: r.notes, badge: r.badge, exp: r.exp } };
}

/**
 * The storage object name. Same shape as the existing bundle image upload
 * (app/api/bundles/upload-image: `bundle_<businessId>_<…>`); uploadToS3 adds a unique time prefix and,
 * on a Preview, the `preview/` folder.
 */
export function posterObjectName(businessId: string): string {
    return `bundle_${businessId}_poster.jpg`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The storage key of a poster THIS request just uploaded, recovered from the public URL uploadToS3
 * returned — or null when it cannot be recovered exactly (then nothing is deleted). Used only to
 * remove a just-uploaded poster when the bundle could not be updated.
 */
export function uploadedPosterKey(url: string, businessId: string, env: Record<string, string | undefined> = process.env): string | null {
    const domain = env.S3_PUBLIC_DOMAIN;
    if (!domain || typeof url !== 'string') return null;
    const base = domain.endsWith('/') ? domain.slice(0, -1) : domain;
    if (!url.startsWith(`${base}/`)) return null;
    const key = url.slice(base.length + 1);
    const shape = new RegExp(`^(?:preview/)?\\d{10,}-${escapeRe(posterObjectName(businessId))}$`);
    return shape.test(key) ? key : null;
}
