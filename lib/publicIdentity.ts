/**
 * FR-PUBLIC-IDENTITY-1 — exact identity resolution for unauthenticated routes.
 *
 * WHAT WAS WRONG
 * Every public route resolved a tenant (and the fundraiser route a customer)
 * with Prisma's `mode: 'insensitive'`. On PostgreSQL that compiles to ILIKE, so
 * the *user-supplied value became a LIKE pattern*:
 *
 *   slug          "%"                  -> resolved to an ARBITRARY Business.
 *   contact_email "%@theirdomain.org"  -> matched an ARBITRARY existing Customer.
 *   contact_email "a_b@x.com"          -> matched "aXb@x.com", a different person.
 *
 * The first is a cross-tenant misroute of an unauthenticated write. The second
 * lets an anonymous submitter attach to, enrich and tag a Customer they have
 * nothing to do with. Neither needed a crafted payload to go wrong: `_` is a
 * perfectly ordinary character in a real email address.
 *
 * THE RULE THIS MODULE ENFORCES
 * An identifier is not a search query. A slug and an email address are matched
 * LITERALLY. Case-insensitivity is preserved, because that is a genuine part of
 * the contract — it is only the *pattern* semantics that were never intended.
 *
 * Nothing here is fundraiser-specific; the fundraiser organization-disambiguation
 * contract lives in lib/fundraiserCustomerResolution.ts so unrelated public flows
 * do not inherit it.
 */

// ── Tenant slug ──────────────────────────────────────────────────────────────

/**
 * The canonical stored slug shape, verified against Production: all 3 business
 * slugs are lowercase, trimmed, and contain only [a-z0-9-].
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Defensive bound; the longest real slug is far shorter. */
export const SLUG_MAX_LENGTH = 100;

/**
 * Sentinel for callers that must still issue a query when the submitted slug is
 * not a valid slug at all. It cannot equal any stored slug (SLUG_PATTERN forbids
 * every character in it), so the query returns nothing — preserving each route's
 * existing not-found behaviour without a second code path.
 */
export const NO_SUCH_SLUG = '::invalid-slug::';

/**
 * Normalize a submitted slug to canonical form, or null when it cannot be one.
 *
 * Returning null rather than throwing lets each caller keep its existing
 * not-found behaviour (some 404, some silently succeed), so this hotfix changes
 * no response contract — only which Business can be reached.
 */
export function normalizeSlug(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const slug = raw.trim().toLowerCase();
    if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH) return null;
    // Rejects '%', '_', '\' and anything else that is not a real slug character.
    return SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Resolve a tenant by slug, literally.
 *
 * Uses plain `equals` with NO `mode`, so Prisma emits `=` rather than ILIKE.
 * That is exact AND still case-insensitive in effect, because the input is
 * lowercased above and every stored slug is already lowercase.
 */
export async function findBusinessBySlug<T>(
    client: { business: { findFirst: (args: any) => Promise<T | null> } },
    rawSlug: unknown,
    select: Record<string, boolean>
): Promise<T | null> {
    const slug = normalizeSlug(rawSlug);
    if (!slug) return null;
    return client.business.findFirst({ where: { slug }, select });
}

// ── Email identity ───────────────────────────────────────────────────────────

export const EMAIL_MAX_LENGTH = 254;

/**
 * Normalize an email to its identity form: trimmed and lowercased.
 *
 * Deliberately does NOT strip or reject `%`, `_` or `\`. Those are legal in an
 * address — one Production customer's email already contains an underscore —
 * and rejecting valid addresses to work around a query bug would be the wrong
 * repair. The fix is to stop treating the value as a pattern.
 */
export function normalizeEmailIdentity(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const email = raw.trim().toLowerCase();
    if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return null;
    return email;
}

// ── Identity-resolution serialization ────────────────────────────────────────

/**
 * THE RACE THIS CLOSES
 * Resolving an organization is read-then-write: read every candidate on the
 * email, decide, then create if nothing fits. Twelve simultaneous inquiries for
 * the same ambiguous organization all read "no holding record yet" before any of
 * them wrote one, and all of them created one. Measured on a real database:
 * FIVE holding records from twelve requests — and once several existed, every
 * later inquiry hit the multi-record branch and was dropped, so the organization
 * was permanently wedged.
 *
 * WHY A LOCK AND NOT A CONSTRAINT
 * `UNIQUE (business_id, contact_email)` cannot be added: Production already
 * holds 5 duplicate groups across 13 customers spanning three Customer types,
 * and 6 customers have no email at all. Serialization asserts nothing about
 * Customer's global semantics and needs no schema.
 *
 * Deliberately self-contained: this hotfix must build against the current
 * Production schema and imports nothing from the funnel work.
 */

/** Namespace, so an unrelated future advisory lock cannot share semantics. */
export const IDENTITY_LOCK_NAMESPACE = 'freezeriq:fundraiser-inquiry-customer';

/**
 * Deterministic lock key for one (tenant, email-identity) pair.
 *
 * Built from the SAME normalization the candidate lookup matches on, so any two
 * requests that could resolve to the same customer set necessarily contend on
 * the same lock. Conservative by design: two different organizations sharing a
 * mailbox serialize briefly, which is harmless.
 */
export function identityLockKey(businessId: string, email: string): string {
    return `${IDENTITY_LOCK_NAMESPACE}:${businessId}:${normalizeEmailIdentity(email) ?? ''}`;
}

/**
 * SQL that takes the transaction-scoped lock.
 *
 * TRANSACTION-scoped (`_xact_`), so COMMIT, ROLLBACK, or a crashed worker all
 * release it — there is no unlock call that can leak. The key is hashed to the
 * advisory integer domain BY POSTGRES via `md5`, a documented and version-stable
 * function; hashing in JavaScript would be unspecified across runtimes and could
 * let two same-identity requests take different locks. The value is bound as a
 * parameter, never interpolated. This is synchronization, not a credential —
 * a hash collision merely serializes two unrelated identities, while identical
 * key text always yields an identical integer, which is the property that
 * matters.
 */
export const IDENTITY_LOCK_SQL =
    `SELECT pg_advisory_xact_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)`;

export interface CustomerIdentityRow {
    id: string;
    type: string | null;
    status: string | null;
    source: string | null;
    name: string | null;
    contact_name: string | null;
    contact_phone: string | null;
    notes: string | null;
    tags: string[];
}

/**
 * Every customer in ONE tenant whose email matches literally, case-insensitively.
 *
 * Raw parameterized SQL because Prisma offers no case-insensitive-LITERAL
 * operator: `equals` alone is case-sensitive, and `mode: 'insensitive'` is the
 * ILIKE behaviour this module exists to remove. `$queryRaw` is a tagged
 * template, so both values are bound parameters — the submitted address is never
 * concatenated into SQL and cannot be interpreted as a pattern.
 *
 * Returns ALL matches rather than one, so callers that must disambiguate can see
 * that there is something to disambiguate. A `findFirst` here is precisely how a
 * duplicate group gets resolved arbitrarily.
 */
export async function findCustomersByEmailIdentity(
    client: { $queryRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]> },
    businessId: string,
    rawEmail: unknown
): Promise<CustomerIdentityRow[]> {
    const email = normalizeEmailIdentity(rawEmail);
    if (!email || !businessId) return [];
    const rows = await client.$queryRaw`
        SELECT id, type::text AS type, status::text AS status, source, name,
               contact_name, contact_phone, notes, tags
        FROM customers
        WHERE business_id = ${businessId}
          AND lower(btrim(contact_email)) = ${email}
        ORDER BY id
    `;
    return rows as CustomerIdentityRow[];
}
