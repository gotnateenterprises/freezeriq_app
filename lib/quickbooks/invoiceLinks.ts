/**
 * QB-INVOICE-1B — FOUNDATION for linking a FreezerIQ invoice to a QuickBooks invoice.
 *
 * Nothing in QB-INVOICE-1B calls these functions: there is no route, button or job
 * that creates a QuickBooks invoice. QB-INVOICE-1C will call them around its own
 * QuickBooks create request.
 *
 * What they guarantee (and the tests prove):
 *   - identifiers and audit metadata only: the invoice row is READ for its id
 *     alone and never written — not status, total_amount, paid_at or any
 *     fulfilment field — so a link can never mark anything sent or paid or release
 *     food;
 *   - LIFETIME (owner ruling, 2026-09-13): a FreezerIQ invoice has at most ONE
 *     QuickBooks invoice link, ever — UNIQUE (invoice_id) in the database, across every
 *     connection generation. Disconnect, Forget, a new generation or reconnecting the
 *     same company never makes it eligible for a second link;
 *   - HISTORY: a link keeps its generation. Forget ends the generation but never deletes
 *     it (and the database refuses to while a link references it), so every link stays
 *     auditable with the evidence of the connection it was made under;
 *   - one FreezerIQ invoice per QuickBooks invoice inside a generation (unique index);
 *   - a link is reserved, with its idempotency key, BEFORE any QuickBooks request,
 *     under the generation lock and only for the tenant's live generation, so a retry
 *     re-uses the key rather than creating a second QuickBooks invoice;
 *   - the QuickBooks invoice id is recorded exactly once (compare-and-set on NULL)
 *     and never changed; there is no update of anything else, and no delete, here.
 *
 * V1 RECORDING CONTRACT for QB-INVOICE-1C (owner ruling, 2026-09-13):
 *   1. Reserve under the live generation, passing the realm of the access token that
 *      will send the create; the reservation is refused unless the stored connection
 *      reaches that company under the lock.
 *   2. Send the create with the reservation's request_id as Intuit's `requestid`, using
 *      an access token for that SAME company (a refreshed token that reaches another
 *      company must abort, as lib/quickbooks/customerLinks.ts does).
 *   3. Record ONLY the Id from that create response, or from its requestid replay. Never
 *      an id found by a query or search, typed by a person, or matched by amount, number,
 *      date or customer.
 *   4. There is deliberately no company-wide uniqueness key across generations (no realm
 *      fingerprint): rules 1–3 make one QuickBooks invoice linked to two FreezerIQ
 *      invoices impossible by construction, because every recorded id was created by
 *      exactly one reservation. Linking PRE-EXISTING QuickBooks invoices would break that
 *      and requires a new, owner-approved cross-generation uniqueness design.
 * Recording does not require the generation to still be live: an invoice created under a
 * generation belongs to that generation's company, and the history must say so even if
 * the tenant forgot the connection while the request was in flight.
 */

import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { withLiveConnection, type GenerationDb } from '@/lib/quickbooks/connectionGenerations';

export type InvoiceLinkDb = Pick<typeof prisma, 'integration' | '$transaction' | 'invoice' | 'quickBooksConnection' | 'quickBooksInvoiceLink'>;

export interface InvoiceLinkDeps {
    db?: InvoiceLinkDb;
    env?: NodeJS.ProcessEnv;
}

export interface QuickBooksInvoiceLinkRecord {
    id: string;
    connectionId: string;
    requestId: string;
    qboInvoiceId: string | null;
    qboLinkedAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
    /** The generation the link was made under — kept after Forget, so the link stays auditable. */
    generation: {
        environment: string;
        companyName: string | null;
        authorizedBy: string | null;
        authorizedAt: Date | null;
        createdAt: Date;
        /** False once the tenant forgot that connection. The link stays; it is history. */
        live: boolean;
    };
}

export type ReserveResult =
    /** reserved: new. existing: this invoice's one link, already reserved under this same live generation. */
    | { outcome: 'reserved' | 'existing'; link: QuickBooksInvoiceLinkRecord }
    | { outcome: 'invoice_not_found' }
    /** The generation is not the tenant's live one, or the tenant is not connected to that company. Nothing written. */
    | { outcome: 'connection_not_current' }
    /** LIFETIME: the invoice already has its one QuickBooks invoice link, made under another generation. Refused. */
    | { outcome: 'already_linked'; link: QuickBooksInvoiceLinkRecord };

export type RecordResult = 'recorded' | 'already_recorded' | 'conflict' | 'not_found';

const QBO_INVOICE_ID = /^[0-9]{1,32}$/;

const LINK_SELECT = {
    id: true,
    connection_id: true,
    request_id: true,
    qbo_invoice_id: true,
    qbo_linked_at: true,
    created_by: true,
    created_at: true,
    connection: {
        select: { environment: true, company_name: true, authorized_by: true, authorized_at: true, created_at: true, live_business_id: true },
    },
} as const;

const toRecord = (r: any): QuickBooksInvoiceLinkRecord => ({
    id: r.id,
    connectionId: r.connection_id,
    requestId: r.request_id,
    qboInvoiceId: r.qbo_invoice_id ?? null,
    qboLinkedAt: r.qbo_linked_at ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    generation: {
        environment: r.connection.environment,
        companyName: r.connection.company_name ?? null,
        authorizedBy: r.connection.authorized_by ?? null,
        authorizedAt: r.connection.authorized_at ?? null,
        createdAt: r.connection.created_at,
        live: r.connection.live_business_id !== null,
    },
});

const resolveDb = (deps: InvoiceLinkDeps) => deps.db ?? (prisma as unknown as InvoiceLinkDb);

/** The invoice's QuickBooks invoice link in this tenant — live or historical — or null. There is never more than one. */
export async function getQuickBooksInvoiceLink(
    input: { businessId: string; invoiceId: string },
    deps: InvoiceLinkDeps = {},
): Promise<QuickBooksInvoiceLinkRecord | null> {
    const row = await resolveDb(deps).quickBooksInvoiceLink.findFirst({
        where: { business_id: input.businessId, invoice_id: input.invoiceId },
        select: LINK_SELECT,
    });
    return row ? toRecord(row) : null;
}

/**
 * Reserves the invoice's one link (and its idempotency key) under the tenant's live
 * generation. Idempotent under that generation: a second call returns the same
 * reservation. `realmId` is the company of the access token that will send the create.
 */
export async function reserveQuickBooksInvoiceLink(
    input: { businessId: string; invoiceId: string; connectionId: string; realmId: string; userId: string | null },
    deps: InvoiceLinkDeps = {},
): Promise<ReserveResult> {
    const db = resolveDb(deps);
    // Ownership only: the invoice's financial fields are never selected.
    const invoice = await db.invoice.findFirst({ where: { id: input.invoiceId, business_id: input.businessId }, select: { id: true } });
    if (!invoice) return { outcome: 'invoice_not_found' };

    const answer = (link: QuickBooksInvoiceLinkRecord): ReserveResult =>
        link.connectionId === input.connectionId ? { outcome: 'existing', link } : { outcome: 'already_linked', link };

    try {
        const locked = await withLiveConnection(
            { businessId: input.businessId, realmId: input.realmId },
            { db: db as unknown as GenerationDb, env: deps.env },
            async (tx, live): Promise<ReserveResult> => {
                if (live.generationId !== input.connectionId) return { outcome: 'connection_not_current' };
                const existing = await tx.quickBooksInvoiceLink.findFirst({
                    where: { business_id: input.businessId, invoice_id: input.invoiceId },
                    select: LINK_SELECT,
                });
                if (existing) return answer(toRecord(existing));
                const row = await tx.quickBooksInvoiceLink.create({
                    data: {
                        business_id: input.businessId,
                        invoice_id: input.invoiceId,
                        connection_id: input.connectionId,
                        request_id: randomUUID(),
                        created_by: input.userId,
                    },
                    select: LINK_SELECT,
                });
                return { outcome: 'reserved', link: toRecord(row) };
            },
        );
        return locked.ok ? locked.value : { outcome: 'connection_not_current' };
    } catch (e: any) {
        if (e?.code === 'P2003') return { outcome: 'invoice_not_found' }; // deleted in between
        if (e?.code !== 'P2002') throw e;
        // Lost a race for this invoice: whichever reservation won is its one link.
        const again = await getQuickBooksInvoiceLink(input, deps);
        if (!again) throw e;
        return answer(again);
    }
}

/**
 * Records the QuickBooks invoice id on a reserved link, exactly once — see the V1
 * recording contract above for where the id may come from. A different id for an
 * already-recorded link, or an id already linked to another invoice in the same
 * generation, is a conflict and changes nothing.
 */
export async function recordQuickBooksInvoiceId(
    input: { businessId: string; linkId: string; connectionId: string; qboInvoiceId: string; now?: Date },
    deps: InvoiceLinkDeps = {},
): Promise<RecordResult> {
    const db = resolveDb(deps);
    if (!QBO_INVOICE_ID.test(input.qboInvoiceId)) return 'conflict';
    try {
        const res = await db.quickBooksInvoiceLink.updateMany({
            where: { id: input.linkId, business_id: input.businessId, connection_id: input.connectionId, qbo_invoice_id: null },
            data: { qbo_invoice_id: input.qboInvoiceId, qbo_linked_at: input.now ?? new Date() },
        });
        if (res.count === 1) return 'recorded';
    } catch (e: any) {
        if (e?.code === 'P2002') return 'conflict';
        throw e;
    }
    const row = await db.quickBooksInvoiceLink.findFirst({
        where: { id: input.linkId, business_id: input.businessId, connection_id: input.connectionId },
        select: { qbo_invoice_id: true },
    });
    if (!row) return 'not_found';
    return row.qbo_invoice_id === input.qboInvoiceId ? 'already_recorded' : 'conflict';
}
