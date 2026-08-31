/**
 * OPS-3 — the fundraiser Production batch.
 *
 * WHAT THIS IS
 *
 * A fundraiser is ONE production job, not N supporter orders. A campaign
 * accumulates public supporter orders and coordinator-entered orders all
 * season; the kitchen needs them as a single grouped requirement — "Brew
 * Test 4: 8 × Fall Keto Serves 5, 3 × Fall Keto Serves 2" — not as a flood
 * of individual rows. This module is the pure, testable aggregation that
 * produces that grouping.
 *
 * WHAT THIS IS NOT
 *
 * Not a merge. Nothing here writes, deletes, or rewrites an Order or an
 * OrderItem. Every batch carries `sourceOrderIds` and every line carries
 * `sourceOrderItemIds`, so the aggregate is always traceable back to the
 * rows it summarises. The source orders remain the fulfilment truth for
 * labels, participant attribution, and audit.
 *
 * Not ingredient math. This counts ORDERED BUNDLE UNITS per serving tier and
 * stops there. Recipe scaling, serving multipliers, and shopping-list
 * quantities belong to the KitchenEngine (and to OPS-4, which owns the
 * serving-tier calculation defect). Nothing here multiplies anything.
 *
 * Not the fundraiser sales metric. `totalUnitCount` is a RAW count of bundle
 * units, deliberately NOT the weighted figure lib/fundraiserMetrics.ts
 * computes (where Serves 2 counts 0.5 toward a fundraising goal). A kitchen
 * making three Serves-2 bundles makes three things, not one and a half. The
 * two numbers answer different questions and are kept apart on purpose —
 * this module never imports the fundraising metric.
 *
 * GROUPING AUTHORITY
 *
 * FundraiserCampaign.id, and nothing else. Never the organization/customer
 * id, never the organization name, never the campaign name. Two campaigns
 * run by the same organization are two production jobs; that is the whole
 * reason the key is campaign identity rather than who the group is.
 */

/** VariantSize as it reaches us from Prisma — 'serves_5' | 'serves_2'. */
export type BatchVariantSize = string;

export interface BatchOrderItem {
    id: string;
    /** Stable Bundle identity. Null only for non-bundle lines (manual upsell). */
    bundle_id: string | null;
    quantity: number;
    variant_size: BatchVariantSize | null;
    /** Name snapshot taken at order time. */
    item_name: string | null;
    bundle?: { id: string; name: string | null } | null;
}

export interface BatchOrderCampaign {
    id: string;
    name: string | null;
    delivery_date: Date | string | null;
    end_date: Date | string | null;
    customer?: { name: string | null } | null;
    invoices?: { id: string; status: string; paid_at: Date | string | null }[] | null;
}

export interface BatchOrder {
    id: string;
    campaign_id: string | null;
    total_amount?: number | string | null;
    items?: BatchOrderItem[] | null;
    campaign?: BatchOrderCampaign | null;
}

export interface BatchLine {
    /** Stable Bundle id when the line has one; null for a non-bundle line. */
    bundleId: string | null;
    /** Real Bundle name — never a positional "Bundle 1"/"Bundle 2" label. */
    bundleName: string;
    /** Raw stored tier, preserved exactly as ordered. */
    variantSize: BatchVariantSize;
    /** Presentation form of the same fact, e.g. "Serves 5". */
    servingTierLabel: string;
    /** Sum of ordered quantities for this (bundle, tier) pair. */
    quantity: number;
    /** Every OrderItem this line summarises. Traceability, not decoration. */
    sourceOrderItemIds: string[];
}

export interface FundraiserBatch {
    campaignId: string;
    campaignName: string;
    organizationName: string;
    deliveryDate: string | null;
    orderDeadline: string | null;
    orderCount: number;
    /** RAW ordered bundle units. See the header: NOT the weighted sales metric. */
    totalUnitCount: number;
    salesTotal: number;
    /** The campaign invoice's status, or null when no invoice exists yet. */
    invoiceStatus: string | null;
    /** True only for the authoritative paid state. */
    invoicePaid: boolean;
    lines: BatchLine[];
    /** Every Order this batch summarises. */
    sourceOrderIds: string[];
}

/**
 * The one authoritative paid fact (INV-D): `invoices.status = 'PAID'`.
 *
 * Deliberately status-only. `paid_at` is settlement EVIDENCE written
 * alongside the status by the settle route, but five historical PAID rows
 * predate that route and carry a NULL `paid_at`; requiring it would silently
 * re-open real, already-settled invoices. Exported so a release gate and a
 * display badge can never disagree about what paid means.
 */
export const PAID_INVOICE_STATUS = 'PAID';

export function isInvoicePaidStatus(status: unknown): boolean {
    return status === PAID_INVOICE_STATUS;
}

/** Presentation only: "serves_5" -> "Serves 5". Never used as an identity key. */
export function formatServingTier(variantSize: string | null | undefined): string {
    const raw = (variantSize || '').trim();
    if (!raw) return '';
    const spaced = raw.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Date-only ISO (YYYY-MM-DD) for display, or null. Never invents a date. */
function calendarDate(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * The line's aggregation key.
 *
 * Stable Bundle id when one exists. A line with no bundle_id (a manual
 * upsell) falls back to its NAME snapshot — never to its position in the
 * items array, which is the defect class that produced "Bundle 1"/"Bundle 2"
 * columns in the printed tracker before FR-COORD-ORDER-TRACKER-1.
 */
function lineKey(item: BatchOrderItem, variantSize: string): string {
    const identity = item.bundle_id
        ? `id:${item.bundle_id}`
        : `name:${(item.item_name || '').trim().toLowerCase()}`;
    return `${identity}|${variantSize}`;
}

/**
 * Group held/released fundraiser orders into one batch per CAMPAIGN.
 *
 * Orders with no campaign_id are skipped: they are not fundraiser batch work,
 * and inventing a campaign for them would fabricate a relationship. The caller
 * is responsible for passing only the orders it means to aggregate (the
 * status/source filter is a query concern, not an aggregation concern).
 *
 * Batches come back newest-delivery-first, then by campaign name, then by id,
 * so the order is deterministic for a given input.
 */
export function buildFundraiserBatches(orders: BatchOrder[]): FundraiserBatch[] {
    const batches = new Map<string, FundraiserBatch & { _lines: Map<string, BatchLine> }>();

    for (const order of orders || []) {
        const campaignId = order.campaign_id;
        if (!campaignId) continue;

        let batch = batches.get(campaignId);
        if (!batch) {
            const c = order.campaign;
            const paidInvoice = (c?.invoices || []).find((i) => isInvoicePaidStatus(i.status));
            const anyInvoice = (c?.invoices || [])[0] ?? null;
            batch = {
                campaignId,
                campaignName: c?.name || 'Fundraiser',
                organizationName: c?.customer?.name || '',
                deliveryDate: calendarDate(c?.delivery_date),
                orderDeadline: calendarDate(c?.end_date),
                orderCount: 0,
                totalUnitCount: 0,
                salesTotal: 0,
                invoiceStatus: paidInvoice?.status ?? anyInvoice?.status ?? null,
                invoicePaid: Boolean(paidInvoice),
                lines: [],
                sourceOrderIds: [],
                _lines: new Map<string, BatchLine>(),
            };
            batches.set(campaignId, batch);
        }

        batch.orderCount += 1;
        batch.sourceOrderIds.push(order.id);
        batch.salesTotal += Number(order.total_amount ?? 0) || 0;

        for (const item of order.items || []) {
            const variantSize = (item.variant_size || 'serves_5') as string;
            const key = lineKey(item, variantSize);
            let line = batch._lines.get(key);
            if (!line) {
                line = {
                    bundleId: item.bundle_id ?? null,
                    bundleName: item.bundle?.name || item.item_name || 'Item',
                    variantSize,
                    servingTierLabel: formatServingTier(variantSize),
                    quantity: 0,
                    sourceOrderItemIds: [],
                };
                batch._lines.set(key, line);
            }
            const qty = Number(item.quantity) || 0;
            line.quantity += qty;
            line.sourceOrderItemIds.push(item.id);
            batch.totalUnitCount += qty;
        }
    }

    return Array.from(batches.values())
        .map(({ _lines, ...b }) => ({
            ...b,
            lines: Array.from(_lines.values()).sort(
                (a, z) => a.bundleName.localeCompare(z.bundleName) || a.variantSize.localeCompare(z.variantSize),
            ),
        }))
        .sort(
            (a, z) =>
                (a.deliveryDate || '9999-12-31').localeCompare(z.deliveryDate || '9999-12-31')
                || a.campaignName.localeCompare(z.campaignName)
                || a.campaignId.localeCompare(z.campaignId),
        );
}
