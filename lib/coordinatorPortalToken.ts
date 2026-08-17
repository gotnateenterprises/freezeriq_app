/**
 * FR-FLOW-1R — the coordinator portal credential.
 *
 * WHAT WAS WRONG
 * `FundraiserCampaign.portal_token` had no application generator at all. Every
 * campaign-creation path omitted the column, so every coordinator credential in
 * the product came from the Prisma schema default `@default(cuid())`.
 *
 * CUID v1 is a collision-resistant IDENTIFIER, not a secret. Its own author
 * deprecated it for security use. The value is a leading `c`, a base36
 * millisecond timestamp, a monotonic counter, a machine fingerprint, and only a
 * short random tail — so tokens minted near each other share leading characters
 * and sort chronologically. That is fine for a primary key and unacceptable for
 * a bearer credential that lives in a URL and is the ONLY thing standing between
 * a stranger and a coordinator's portal.
 *
 * WHAT THIS IS
 * 32 bytes from the OS CSPRNG, base64url-encoded: 256 bits of entropy, no
 * structure, URL-safe without escaping. This mirrors `mintRebookingToken` in
 * lib/rebookingToken.ts, which is the established precedent in this repository.
 *
 * WHY THE RAW TOKEN IS STORED (and rebooking's is not)
 * The rebooking credential is hashed at rest because it is minted, emailed once,
 * and never shown again. A coordinator portal link is different: the tenant has
 * to be able to re-open and re-send the SAME link from the CRM, which a digest
 * cannot support. Storing a 256-bit random value raw is the accepted trade for
 * this bounded repair. Hashing, expiry, and revocation remain open questions and
 * are deliberately NOT decided here.
 *
 * Server-only: `node:crypto` keeps this out of any client bundle by construction.
 */
import { randomBytes } from 'node:crypto';

/**
 * 32 bytes = 256 bits. Same size as the rebooking credential; guessing one is
 * not a meaningful attack even with unlimited attempts.
 */
export const COORDINATOR_PORTAL_TOKEN_BYTES = 32;

/**
 * base64url of 32 bytes is always 43 characters (256 bits / 6, no padding).
 * Exported so tests can assert the shape without re-deriving the arithmetic.
 */
export const COORDINATOR_PORTAL_TOKEN_LENGTH = 43;

/**
 * Mint a fresh coordinator portal credential.
 *
 * Every runtime path that creates a FundraiserCampaign must pass the result of
 * this function as `portal_token`. Omitting it silently falls back to the weak
 * schema default, which is the exact defect this module exists to end.
 */
export function mintCoordinatorPortalToken(): string {
    return randomBytes(COORDINATOR_PORTAL_TOKEN_BYTES).toString('base64url');
}

/**
 * True when a token has the structural signature of a legacy CUID v1 value:
 * a leading `c` and roughly 25 characters of lowercase base36.
 *
 * This is NOT a security control — a token is not safe merely because it fails
 * this check. It exists so tests can prove the new generator does not produce
 * the old shape, and so an operator auditing rotation can tell at a glance which
 * rows still hold a historically-exposed credential.
 */
export function looksLikeLegacyCuid(token: string | null | undefined): boolean {
    if (typeof token !== 'string') return false;
    return /^c[a-z0-9]{20,30}$/.test(token);
}
