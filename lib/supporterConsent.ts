/**
 * SUPPORTER-CONSENT-1 — the durable record of supporter permission, and the ONE authority that
 * reads it (server-only; the wording and checks live in lib/supporterConsentText.ts).
 *
 * Storage: supporter_contact_consents, append-only. A checked box on a successfully placed order
 * adds a `granted` row for (tenant, organization, channel, destination). A future withdrawal path
 * (e.g. an SMS STOP reply or a preference control) adds a `revoked` row. Rows are never updated.
 *
 * Current permission for a destination = its LATEST row for that organization is `granted` —
 * and, for email, the address is not unsubscribed. Email unsubscribes keep living where they always
 * have (marketing_preferences, tenant-wide by address, lib/outreachUnsubscribeWrite.ts); any
 * `unsubscribed` row vetoes the permission no matter when either happened, so an opt-out is never
 * undone by a later checkbox. (Lifting an opt-out stays the tenant's documented resubscribe flow.)
 *
 * Scope is exact: another organization, another tenant, or another address/number never inherits
 * a permission.
 */

import { prisma } from '@/lib/db';
import type { SupporterConsentChannel, SupporterConsentRow } from '@/lib/supporterConsentText';

interface ConsentEventRow {
    destination: string;
    action: 'granted' | 'revoked';
    created_at: Date | string;
}

/**
 * The generated Prisma client on the build server includes this model; a typed view keeps the
 * calls checked against the exact row shape without regenerating anyone's local client.
 */
interface SupporterConsentTable {
    createMany(args: { data: SupporterConsentRow[] }): Promise<{ count: number }>;
    findMany(args: {
        where: { business_id: string; customer_id: string; channel: SupporterConsentChannel };
        select: { destination: true; action: true; created_at: true };
        orderBy: Array<{ created_at: 'asc' } | { id: 'asc' }>;
    }): Promise<ConsentEventRow[]>;
}
const consentTable = (db: unknown): SupporterConsentTable =>
    (db as { supporterContactConsent: SupporterConsentTable }).supporterContactConsent;

/**
 * Record the rows built by buildSupporterConsentRows — called INSIDE the order transaction, after
 * the order row exists, so a failed order records nothing.
 */
export async function recordSupporterConsents(tx: unknown, rows: SupporterConsentRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await consentTable(tx).createMany({ data: rows });
    return res.count;
}

/** Destinations whose latest event is a grant. Rows must be in chronological order. */
export function currentlyGranted(rows: ReadonlyArray<ConsentEventRow>): Set<string> {
    const latest = new Map<string, 'granted' | 'revoked'>();
    for (const r of rows) {
        if (typeof r?.destination === 'string' && r.destination) latest.set(r.destination, r.action === 'granted' ? 'granted' : 'revoked');
    }
    return new Set([...latest].filter(([, a]) => a === 'granted').map(([d]) => d));
}

export interface ConsentScope {
    businessId: string | null | undefined;
    organizationCustomerId: string | null | undefined;
}

async function loadCurrentConsent(scope: ConsentScope, channel: SupporterConsentChannel, db: unknown): Promise<Set<string>> {
    const businessId = typeof scope.businessId === 'string' ? scope.businessId.trim() : '';
    const customerId = typeof scope.organizationCustomerId === 'string' ? scope.organizationCustomerId.trim() : '';
    if (!businessId || !customerId) return new Set();

    const rows = await consentTable(db).findMany({
        where: { business_id: businessId, customer_id: customerId, channel },
        select: { destination: true, action: true, created_at: true },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const granted = currentlyGranted(rows);
    if (channel !== 'email' || granted.size === 0) return granted;

    // An unsubscribe always wins over a permission, earlier or later.
    const optedOut = await (db as any).marketingPreference.findMany({
        where: { business_id: businessId, scope: 'email_address', status: 'unsubscribed', normalized_email: { in: [...granted] } },
        select: { normalized_email: true },
    }) as Array<{ normalized_email: string | null }>;
    for (const p of optedOut) if (p.normalized_email) granted.delete(p.normalized_email);
    return granted;
}

/** Normalized email addresses with current permission for THIS organization's future fundraiser email. */
export function loadSupporterEmailConsent(scope: ConsentScope, db: unknown = prisma): Promise<Set<string>> {
    return loadCurrentConsent(scope, 'email', db);
}

/**
 * +1 mobile numbers with current permission for THIS organization's future fundraiser texts.
 * Internal only: nothing sends marketing texts, and nothing may until STOP replies are processed.
 */
export function loadSupporterSmsConsent(scope: ConsentScope, db: unknown = prisma): Promise<Set<string>> {
    return loadCurrentConsent(scope, 'sms', db);
}
