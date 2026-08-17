/**
 * FR-PUBLIC-IDENTITY-1 — public identity resolution must be LITERAL.
 *
 * Every public route resolved a tenant (and the fundraiser route a customer)
 * with Prisma's `mode: 'insensitive'`, which compiles to ILIKE on PostgreSQL.
 * The submitted value therefore became a LIKE pattern:
 *
 *   slug  "%"                 -> an ARBITRARY Business (cross-tenant misroute)
 *   email "%@their-domain"    -> an ARBITRARY existing Customer
 *   email "a_b@x.com"         -> "aXb@x.com", a different person entirely
 *
 * These tests pin the repair. Case-insensitivity is preserved deliberately —
 * only the pattern semantics were ever unintended.
 */

import {
    SLUG_PATTERN,
    NO_SUCH_SLUG,
    normalizeSlug,
    normalizeEmailIdentity,
    findBusinessBySlug,
    findCustomersByEmailIdentity,
    identityLockKey,
    IDENTITY_LOCK_SQL,
    IDENTITY_LOCK_NAMESPACE,
} from '@/lib/publicIdentity';
import {
    normalizeOrganizationName,
    resolveFundraiserCustomer,
    hasEvidenceAtTier,
    isReviewIdentity,
    EVIDENCE_TIERS,
    IDENTITY_REVIEW_TAG,
} from '@/lib/fundraiserCustomerResolution';

const row = (over: Record<string, any> = {}) => ({
    id: 'c1', type: 'organization', status: 'LEAD', source: 'Manual',
    name: 'Some Org', contact_name: null, contact_phone: null, notes: null, tags: [],
    ...over,
});

// ── Slug ─────────────────────────────────────────────────────────────────────

describe('slug is an identifier, never a pattern', () => {
    it('accepts real slugs', () => {
        for (const s of ['tenant-a', 'my-freezer-chef', 'abc123', 'a']) {
            expect(normalizeSlug(s)).toBe(s);
            expect(SLUG_PATTERN.test(s)).toBe(true);
        }
    });

    it('is case-insensitive and trims, matching the previous contract', () => {
        expect(normalizeSlug('  TENANT-A  ')).toBe('tenant-a');
        expect(normalizeSlug('My-Freezer-Chef')).toBe('my-freezer-chef');
    });

    it('REJECTS every LIKE metacharacter', () => {
        for (const bad of ['%', '_', '\\', 'tenant-%', '%a', '_enant-a', 'ten_nt', 'a%b']) {
            expect(normalizeSlug(bad)).toBeNull();
        }
    });

    it('rejects non-strings, empties and absurd lengths', () => {
        for (const bad of [null, undefined, 42, {}, '', '   ', 'x'.repeat(200)]) {
            expect(normalizeSlug(bad as any)).toBeNull();
        }
    });

    it('the not-found sentinel can never equal a real slug', () => {
        expect(SLUG_PATTERN.test(NO_SUCH_SLUG)).toBe(false);
        expect(normalizeSlug(NO_SUCH_SLUG)).toBeNull();
    });

    it('findBusinessBySlug queries with plain equality — never ILIKE', async () => {
        const calls: any[] = [];
        const client = { business: { findFirst: async (a: any) => { calls.push(a); return { id: 'bizA' }; } } };
        await findBusinessBySlug(client as any, '  TENANT-A ', { id: true });
        expect(calls[0].where).toEqual({ slug: 'tenant-a' });
        expect(JSON.stringify(calls[0])).not.toContain('insensitive');
    });

    it('findBusinessBySlug does not even query for a wildcard slug', async () => {
        let queried = false;
        const client = { business: { findFirst: async () => { queried = true; return { id: 'bizA' }; } } };
        const result = await findBusinessBySlug(client as any, '%', { id: true });
        expect(result).toBeNull();
        expect(queried).toBe(false);
    });
});

// ── Email ────────────────────────────────────────────────────────────────────

describe('email identity is literal and case-insensitive', () => {
    it('normalizes case and whitespace', () => {
        expect(normalizeEmailIdentity('  Amy@Lincoln.ORG ')).toBe('amy@lincoln.org');
    });

    it('does NOT reject legal addresses containing LIKE metacharacters', () => {
        // One Production customer's address already contains an underscore.
        expect(normalizeEmailIdentity('a_b@example.com')).toBe('a_b@example.com');
        expect(normalizeEmailIdentity('odd%name@example.com')).toBe('odd%name@example.com');
    });

    it('rejects non-strings, empties and over-length values', () => {
        for (const bad of [null, undefined, 42, '', '   ', 'x'.repeat(300)]) {
            expect(normalizeEmailIdentity(bad as any)).toBeNull();
        }
    });

    it('binds the address as a PARAMETER, never as a pattern', async () => {
        const seen: any[] = [];
        const client = {
            $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
                seen.push({ sql: strings.join('?'), values });
                return [];
            },
        };
        await findCustomersByEmailIdentity(client as any, 'bizA', '  A_B@Example.COM ');
        expect(seen[0].values).toEqual(['bizA', 'a_b@example.com']);
        expect(seen[0].sql).toContain('lower(btrim(contact_email))');
        expect(seen[0].sql).not.toMatch(/ILIKE/i);
        expect(seen[0].sql).not.toMatch(/LIKE/i);
    });

    it('always scopes to one tenant', async () => {
        const seen: any[] = [];
        const client = {
            $queryRaw: async (s: TemplateStringsArray, ...v: any[]) => { seen.push({ sql: s.join('?'), values: v }); return []; },
        };
        await findCustomersByEmailIdentity(client as any, 'bizA', 'x@y.com');
        expect(seen[0].sql).toContain('business_id');
        expect(seen[0].values[0]).toBe('bizA');
    });

    it('short-circuits without querying when the email is unusable', async () => {
        let queried = false;
        const client = { $queryRaw: async () => { queried = true; return []; } };
        expect(await findCustomersByEmailIdentity(client as any, 'bizA', '')).toEqual([]);
        expect(await findCustomersByEmailIdentity(client as any, '', 'a@b.com')).toEqual([]);
        expect(queried).toBe(false);
    });
});

// ── Identity-resolution serialization ────────────────────────────────────────

describe('FR-PUBLIC-IDENTITY-1R2 — identity lock', () => {
    const BIZ = 'biz-aaaa-1111';

    it('derives the key from the SAME normalization the lookup matches on', () => {
        expect(identityLockKey(BIZ, '  Amy@Lincoln.ORG '))
            .toBe(identityLockKey(BIZ, 'amy@lincoln.org'));
    });

    it('namespaces the lock so unrelated advisory locks cannot collide in meaning', () => {
        expect(IDENTITY_LOCK_NAMESPACE).toBe('freezeriq:fundraiser-inquiry-customer');
        expect(identityLockKey(BIZ, 'a@b.com'))
            .toBe(`freezeriq:fundraiser-inquiry-customer:${BIZ}:a@b.com`);
    });

    it('separates tenants — the same email in two tenants never contends', () => {
        expect(identityLockKey('biz-A', 'a@b.com')).not.toBe(identityLockKey('biz-B', 'a@b.com'));
    });

    it('separates identities inside one tenant', () => {
        expect(identityLockKey(BIZ, 'a@b.com')).not.toBe(identityLockKey(BIZ, 'c@d.com'));
    });

    it('hashes in POSTGRES, never in JavaScript', () => {
        // V8 string hashing is unspecified; two runtimes disagreeing would let
        // same-identity requests take different locks.
        expect(IDENTITY_LOCK_SQL).toContain('pg_advisory_xact_lock');
        expect(IDENTITY_LOCK_SQL).toContain('md5($1)');
        expect(IDENTITY_LOCK_SQL).toContain('bit(64)');
    });

    it('uses the TRANSACTION-scoped variant so no unlock can leak', () => {
        expect(IDENTITY_LOCK_SQL).toContain('_xact_');
        expect(IDENTITY_LOCK_SQL).not.toContain('pg_advisory_unlock');
        expect(IDENTITY_LOCK_SQL).not.toMatch(/pg_try_advisory/);
        expect(IDENTITY_LOCK_SQL).not.toMatch(/pg_advisory_lock\(/);
    });

    it('binds the key as a parameter — no interpolation surface', () => {
        expect(IDENTITY_LOCK_SQL).toContain('$1');
        expect(IDENTITY_LOCK_SQL).not.toMatch(/\$\{/);
    });
});

// ── Organization identity ────────────────────────────────────────────────────

describe('organization name normalization is conservative', () => {
    it('collapses case and ordinary whitespace only', () => {
        expect(normalizeOrganizationName('  Lincoln   PTA ')).toBe('lincoln pta');
        expect(normalizeOrganizationName('LINCOLN PTA')).toBe('lincoln pta');
    });

    it('does NOT strip meaningful punctuation', () => {
        // "St. Mary's" and "St Marys" may be different organizations; this module
        // has no basis for deciding they are the same.
        expect(normalizeOrganizationName("St. Mary's")).not.toBe(normalizeOrganizationName('St Marys'));
    });

    it('rejects empty input', () => {
        expect(normalizeOrganizationName('   ')).toBeNull();
        expect(normalizeOrganizationName(null)).toBeNull();
    });
});

describe('duplicate organization resolution', () => {
    it('creates when there is no candidate', () => {
        const r = resolveFundraiserCustomer({ candidates: [], organizationName: 'New Org' });
        expect(r).toEqual({ kind: 'create', reason: 'no_candidates' });
    });

    it('reuses a sole PERSON row whatever organization they inquire for', () => {
        // FR-FLOW-1R contract: tag the existing person so the CRM shows them;
        // never duplicate them just because they named an organization.
        const only = row({ id: 'retail', type: 'direct_customer', name: 'A Person' });
        const r = resolveFundraiserCustomer({ candidates: [only], organizationName: 'Totally Different Org' });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') expect(r.customer.id).toBe('retail');
    });

    it('does NOT collapse a sole ORGANIZATION that has a different name', () => {
        // Serializing on email makes this reachable: the first request creates
        // "Alpha PTA", and the next one for "Beta Boosters" would otherwise find
        // Alpha as the sole candidate and silently reuse it.
        const only = row({ id: 'alpha', type: 'fundraiser_org', name: 'Alpha PTA' });
        const r = resolveFundraiserCustomer({ candidates: [only], organizationName: 'Beta Boosters' });
        expect(r.kind).toBe('create');
        if (r.kind === 'create') expect(r.reason).toBe('no_candidates');
    });

    it('reuses a sole ORGANIZATION when the name matches', () => {
        const only = row({ id: 'alpha', type: 'fundraiser_org', name: '  ALPHA   pta ' });
        const r = resolveFundraiserCustomer({ candidates: [only], organizationName: 'Alpha PTA' });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') expect(r.customer.id).toBe('alpha');
    });

    it('reuses a sole organization when no organization name was submitted', () => {
        const only = row({ id: 'alpha', type: 'fundraiser_org', name: 'Alpha PTA' });
        const r = resolveFundraiserCustomer({ candidates: [only], organizationName: '   ' });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') expect(r.customer.id).toBe('alpha');
    });

    it('picks the candidate whose organization NAME matches', () => {
        const candidates = [
            row({ id: 'alpha', name: 'Alpha PTA' }),
            row({ id: 'beta', name: 'Beta Boosters' }),
            row({ id: 'retail', type: 'direct_customer', name: 'A Person' }),
        ];
        const r = resolveFundraiserCustomer({ candidates, organizationName: '  alpha   pta ' });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') { expect(r.customer.id).toBe('alpha'); expect(r.reason).toBe('name_match'); }
    });

    it('SHARED EMAIL, DIFFERENT ORGANIZATION: creates instead of attaching', () => {
        const candidates = [row({ id: 'alpha', name: 'Alpha PTA' }), row({ id: 'beta', name: 'Beta Boosters' })];
        const r = resolveFundraiserCustomer({ candidates, organizationName: 'Gamma Choir' });
        expect(r).toEqual({ kind: 'create', reason: 'no_candidates' });
    });

    it('breaks a NAME tie using the strongest evidence tier', () => {
        const candidates = [row({ id: 'x1', name: 'Twin Org' }), row({ id: 'x2', name: 'Twin Org' })];
        const r = resolveFundraiserCustomer({
            candidates, organizationName: 'Twin Org', campaignOwnerIds: new Set(['x2']),
        });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') { expect(r.customer.id).toBe('x2'); expect(r.reason).toBe('fundraiser_evidence'); }
    });

    it('falls to the next tier when the strongest one does not isolate a row', () => {
        const candidates = [row({ id: 'x1', name: 'Twin Org' }), row({ id: 'x2', name: 'Twin Org' })];
        const r = resolveFundraiserCustomer({
            candidates, organizationName: 'Twin Org',
            campaignOwnerIds: new Set(['x1', 'x2']),   // tier 1 matches BOTH
            orgContactIds: new Set(['x1']),            // tier 2 isolates one
        });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') expect(r.customer.id).toBe('x1');
    });

    it('REFUSES to guess when nothing isolates a candidate', () => {
        const candidates = [row({ id: 'x1', name: 'Twin Org' }), row({ id: 'x2', name: 'Twin Org' })];
        const r = resolveFundraiserCustomer({ candidates, organizationName: 'Twin Org' });
        expect(r.kind).toBe('create');
        if (r.kind === 'create') { expect(r.reason).toBe('ambiguous'); expect(r.candidateCount).toBe(2); }
    });

    it('never picks by id — the result is independent of candidate ORDER', () => {
        const candidates = [
            row({ id: 'zzz', name: 'Alpha PTA' }),
            row({ id: 'aaa', name: 'Beta Boosters' }),
        ];
        const forward = resolveFundraiserCustomer({ candidates, organizationName: 'Alpha PTA' });
        const reversed = resolveFundraiserCustomer({ candidates: [...candidates].reverse(), organizationName: 'Alpha PTA' });
        expect(forward).toEqual(reversed);
        if (forward.kind === 'reuse') expect(forward.customer.id).toBe('zzz');
    });

    it('a direct_customer and a fundraiser organization stay distinct', () => {
        const candidates = [
            row({ id: 'retail', type: 'direct_customer', name: 'Jo Smith' }),
            row({ id: 'org', type: 'fundraiser_org', name: 'Lincoln PTA' }),
        ];
        const r = resolveFundraiserCustomer({ candidates, organizationName: 'Lincoln PTA' });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') expect(r.customer.id).toBe('org');
    });

    it('evidence tiers are ordered strongest-first', () => {
        expect([...EVIDENCE_TIERS]).toEqual(['campaign', 'org_contact', 'classification']);
        const r = row({ id: 'q', type: 'direct_customer', tags: [] });
        expect(hasEvidenceAtTier(r, 'campaign', new Set(['q']), new Set())).toBe(true);
        expect(hasEvidenceAtTier(r, 'classification', new Set(), new Set())).toBe(false);
        expect(hasEvidenceAtTier(row({ id: 'q', tags: ['fundraiser_inquiry'], type: 'direct_customer' }),
            'classification', new Set(), new Set())).toBe(true);
    });

    it('exports a bounded ambiguity marker', () => {
        expect(IDENTITY_REVIEW_TAG).toBe('identity_review_needed');
    });
});

/**
 * FR-PUBLIC-IDENTITY-1R — the gap that let the first version through review.
 *
 * The original resolver refused to guess (correct) and then created a fresh
 * holding record EVERY time (wrong). A returning organization bred duplicates
 * without limit, and each new duplicate made the next tie harder. The original
 * suite never submitted an ambiguous inquiry twice, so nothing caught it.
 */
describe('repeated ambiguity converges', () => {
    const reviewRow = (id: string, name = 'Twin Org') =>
        row({ id, name, type: 'fundraiser_org', tags: ['fundraiser_inquiry', IDENTITY_REVIEW_TAG] });
    const legacy = (id: string, name = 'Twin Org') => row({ id, name, type: 'organization', tags: [] });

    it('the FIRST ambiguous submission creates a holding record', () => {
        const r = resolveFundraiserCustomer({
            candidates: [legacy('l1'), legacy('l2')], organizationName: 'Twin Org',
        });
        expect(r.kind).toBe('create');
        if (r.kind === 'create') expect(r.reason).toBe('ambiguous');
    });

    it('the SECOND identical submission REUSES it instead of creating another', () => {
        const r = resolveFundraiserCustomer({
            candidates: [legacy('l1'), legacy('l2'), reviewRow('rev')], organizationName: 'Twin Org',
        });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') { expect(r.customer.id).toBe('rev'); expect(r.reason).toBe('review_identity'); }
    });

    it('the THIRD submission reuses the same one — the count stops growing', () => {
        const candidates = [legacy('l1'), legacy('l2'), reviewRow('rev')];
        const second = resolveFundraiserCustomer({ candidates, organizationName: 'Twin Org' });
        const third = resolveFundraiserCustomer({ candidates, organizationName: 'Twin Org' });
        expect(second).toEqual(third);
    });

    it('a holding record NEVER outranks a uniquely defensible real organization', () => {
        // One legacy row now owns campaign history: real evidence must win.
        const r = resolveFundraiserCustomer({
            candidates: [legacy('l1'), legacy('l2'), reviewRow('rev')],
            organizationName: 'Twin Org',
            campaignOwnerIds: new Set(['l2']),
        });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') { expect(r.customer.id).toBe('l2'); expect(r.reason).toBe('fundraiser_evidence'); }
    });

    it('a sole REAL candidate still wins over a holding record', () => {
        // Real history is evaluated on its own first, so one real row is reused
        // as the sole candidate and the holding record is never consulted.
        const r = resolveFundraiserCustomer({
            candidates: [legacy('l1'), reviewRow('rev')], organizationName: 'Twin Org',
        });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') { expect(r.customer.id).toBe('l1'); expect(r.reason).toBe('sole_candidate'); }
    });

    it('a holding record for a DIFFERENT organization is not reused', () => {
        const r = resolveFundraiserCustomer({
            candidates: [legacy('l1'), legacy('l2'), reviewRow('rev', 'Other Org')],
            organizationName: 'Twin Org',
        });
        expect(r.kind).toBe('create');
        if (r.kind === 'create') expect(r.reason).toBe('ambiguous');
    });

    it('MULTIPLE holding records converge on a canonical one — no new row, no lost lead', () => {
        // The previous behaviour dropped the inquiry here. That branch turned out
        // to be reachable through the concurrency race, so it now picks a stable
        // canonical placeholder instead. Ordering by id is safe ONLY because
        // every row in this set is an equivalent synthetic holding record for the
        // same tenant, email and organization name.
        const r = resolveFundraiserCustomer({
            candidates: [legacy('l1'), legacy('l2'), reviewRow('rev-b'), reviewRow('rev-a')],
            organizationName: 'Twin Org',
        });
        expect(r.kind).toBe('reuse');
        if (r.kind === 'reuse') {
            expect(r.reason).toBe('canonical_review_identity');
            expect(r.customer.id).toBe('rev-a'); // stable, lowest id
        }
    });

    it('canonical selection is order-independent', () => {
        const rows = [legacy('l1'), legacy('l2'), reviewRow('rev-b'), reviewRow('rev-a')];
        const forward = resolveFundraiserCustomer({ candidates: rows, organizationName: 'Twin Org' });
        const reversed = resolveFundraiserCustomer({ candidates: [...rows].reverse(), organizationName: 'Twin Org' });
        expect(forward).toEqual(reversed);
    });

    it('canonical selection NEVER applies to real organizations', () => {
        // Two real rows, no holding record: still ambiguous, still no guess.
        const r = resolveFundraiserCustomer({
            candidates: [legacy('zzz'), legacy('aaa')], organizationName: 'Twin Org',
        });
        expect(r.kind).toBe('create');
        if (r.kind === 'create') expect(r.reason).toBe('ambiguous');
    });

    it('converges for a shared mailbox too — new org, repeated', () => {
        // "Gamma Choir" shares a mailbox with Alpha/Beta and has no real row.
        const shared = [row({ id: 'alpha', name: 'Alpha PTA' }), row({ id: 'beta', name: 'Beta Boosters' })];
        const first = resolveFundraiserCustomer({ candidates: shared, organizationName: 'Gamma Choir' });
        expect(first.kind).toBe('create');
        const second = resolveFundraiserCustomer({
            candidates: [...shared, reviewRow('gamma-rev', 'Gamma Choir')], organizationName: 'Gamma Choir',
        });
        expect(second.kind).toBe('reuse');
        if (second.kind === 'reuse') expect(second.customer.id).toBe('gamma-rev');
    });

    it('isReviewIdentity only matches the approved marker', () => {
        expect(isReviewIdentity(reviewRow('r'))).toBe(true);
        expect(isReviewIdentity(legacy('l'))).toBe(false);
        expect(isReviewIdentity(row({ tags: ['fundraiser_inquiry'] }))).toBe(false);
    });
});
