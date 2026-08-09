/**
 * FR-RETENTION-4 — the secure rebooking credential.
 *
 * THE RULE, and there is only one that matters: the raw token is NEVER stored.
 * It is generated, handed straight to the email renderer for one recipient, and
 * then forgotten. What the database keeps is the SHA-256 digest, which cannot be
 * turned back into a working link. A stolen database dump therefore contains no
 * usable rebooking links — only the shadow of ones that were sent.
 *
 * That has a consequence worth stating out loud rather than discovering later:
 * we cannot re-display an existing link to the tenant, and we cannot "resend the
 * same link". Re-sending mints a NEW credential and invalidates the old digest.
 * That is the correct trade for not storing a replayable secret.
 *
 * WHOSE credential is it? The DELIVERY RECIPIENT's — the address the email went
 * to — not a person's. One inbox may represent several durable contacts and
 * several organizations, and we have no way to know which of them opened the
 * mail. The link therefore authenticates "whoever received this email", and the
 * form asks explicitly who is answering rather than assuming.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * How long a rebooking link stays usable.
 *
 * There was no shared TTL constant anywhere in this repository before this
 * checkpoint, so this is the first one and it is deliberately central rather
 * than inlined at a call site.
 *
 * 45 days is chosen against the actual behaviour it has to survive: a seasonal
 * update goes out, the person who received it is a volunteer, and they forward
 * it to whoever actually runs the fundraiser. That hand-off routinely takes
 * weeks. A 7-day link would expire mid-conversation and generate support work; a
 * link that never expires is a permanent unauthenticated credential sitting in a
 * forwarded email thread. Six weeks and change covers the realistic hand-off
 * without becoming indefinite.
 */
export const REBOOKING_TOKEN_TTL_DAYS = 45;

/** 32 bytes of CSPRNG output — not Math.random, which is not a secret source. */
const TOKEN_BYTES = 32;

export interface MintedRebookingToken {
    /**
     * The raw credential. Lives in memory only, for exactly as long as it takes
     * to render one email. Never log it, never persist it, never return it to a
     * tenant-facing API response.
     */
    raw: string;
    /** SHA-256 hex digest — the only form that is ever written down. */
    hash: string;
    issuedAt: Date;
    expiresAt: Date;
}

/** SHA-256 hex. Deterministic, so an incoming token can be looked up by digest. */
export function hashRebookingToken(rawToken: string): string {
    return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Mint a fresh credential.
 *
 * base64url so the token survives being pasted into an email client, a URL bar,
 * and a chat message without escaping. 32 bytes is 256 bits of entropy, which
 * makes guessing a valid link not worth attempting.
 */
export function mintRebookingToken(now: Date = new Date()): MintedRebookingToken {
    const raw = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(now.getTime() + REBOOKING_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    return { raw, hash: hashRebookingToken(raw), issuedAt: now, expiresAt };
}

/**
 * Constant-time digest comparison.
 *
 * Lookup is by digest equality in the database, so this is belt-and-braces for
 * any code path that compares two digests in application memory.
 */
export function digestsMatch(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/**
 * Why a link cannot be used right now.
 *
 * `revoked` and `expired` are DIFFERENT on purpose. An expired link is a timing
 * problem the respondent can fix by asking for a new one; a revoked link was
 * deliberately withdrawn and offering a self-service refresh for it would
 * undo the tenant's decision.
 */
export type RebookingTokenState =
    | 'valid'
    | 'expired'
    | 'revoked'
    | 'already_submitted';

export interface RebookingCredentialFacts {
    issuedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    /** True once a submission thread exists for this recipient. */
    hasSubmission: boolean;
}

/**
 * Classify a resolved credential.
 *
 * Order matters and is not arbitrary: revocation beats everything, because a
 * withdrawn link must not present itself as merely expired. An existing
 * submission is reported before expiry so a respondent who already answered sees
 * "you're all set", not "your link expired" — the second is technically true and
 * completely unhelpful.
 */
export function classifyRebookingCredential(
    facts: RebookingCredentialFacts,
    now: Date = new Date(),
): RebookingTokenState {
    if (facts.revokedAt) return 'revoked';
    if (facts.hasSubmission) return 'already_submitted';
    if (facts.expiresAt && facts.expiresAt <= now) return 'expired';
    return 'valid';
}

/**
 * A masked rendering of a link, for anywhere a human might see it who should not
 * be handed a working credential — the tenant's email preview, in particular.
 * Matches the approved prototype's `/rebook/•••`.
 */
export function maskRebookingUrl(origin: string): string {
    return `${origin.replace(/\/+$/, '')}/rebook/•••`;
}
