/**
 * INV-A — invoice fulfilment policy.
 *
 * The failure mode pinned here is the phantom order: a campaign invoice whose
 * aggregated bundle lines get turned into a second, duplicate production Order,
 * telling the kitchen to make the entire fundraiser twice.
 *
 * Also pins that INV-A's enum expansion did not quietly widen the ordinary
 * invoice API to let clients mint DRAFT/SENT.
 */

import {
    shouldCreateFulfillmentOrder,
    isClientSettableInvoiceStatus,
    CLIENT_SETTABLE_INVOICE_STATUSES,
} from '@/lib/invoiceFulfillment';

describe('1. ordinary invoices keep their existing fulfilment behaviour', () => {
    it('bundle-backed lines still produce a fulfilment order', () => {
        expect(shouldCreateFulfillmentOrder({ campaignId: null, fulfillableItemCount: 1 })).toBe(true);
        expect(shouldCreateFulfillmentOrder({ campaignId: null, fulfillableItemCount: 9 })).toBe(true);
    });

    it('custom-only lines still produce nothing', () => {
        expect(shouldCreateFulfillmentOrder({ campaignId: null, fulfillableItemCount: 0 })).toBe(false);
    });

    it('undefined campaign linkage behaves exactly like null', () => {
        expect(shouldCreateFulfillmentOrder({ campaignId: undefined, fulfillableItemCount: 3 })).toBe(true);
    });
});

describe('2. a campaign-linked invoice NEVER creates a fulfilment order', () => {
    it('is suppressed even when every line is bundle-backed', () => {
        expect(shouldCreateFulfillmentOrder({ campaignId: 'camp-1', fulfillableItemCount: 12 })).toBe(false);
    });

    it('is suppressed for a single line just as firmly', () => {
        expect(shouldCreateFulfillmentOrder({ campaignId: 'camp-1', fulfillableItemCount: 1 })).toBe(false);
    });

    it('is suppressed with no fulfillable lines too', () => {
        expect(shouldCreateFulfillmentOrder({ campaignId: 'camp-1', fulfillableItemCount: 0 })).toBe(false);
    });

    it('campaign linkage always wins over line shape', () => {
        // The campaign's own orders are the fulfilment record. Duplicating them
        // would double the food the kitchen is told to produce.
        for (const n of [0, 1, 5, 100]) {
            expect(shouldCreateFulfillmentOrder({ campaignId: 'camp-x', fulfillableItemCount: n })).toBe(false);
        }
    });
});

describe('3. DRAFT and SENT are not client-settable through the ordinary API', () => {
    it('the legacy statuses remain settable', () => {
        expect(CLIENT_SETTABLE_INVOICE_STATUSES).toEqual(['PENDING', 'OVERDUE', 'CANCELED']);
        for (const s of ['PENDING', 'OVERDUE', 'CANCELED']) {
            expect(isClientSettableInvoiceStatus(s)).toBe(true);
        }
    });

    it('refuses PAID — INV-D moved it to the settlement endpoint', () => {
        // This route can only ever set a bare status; it has no method, date or
        // reference to record alongside it, which is exactly how Production
        // acquired five PAID invoices that cannot say when they were paid.
        expect(isClientSettableInvoiceStatus('PAID')).toBe(false);
    });

    it('refuses DRAFT — that belongs to INV-B’s server-side generator', () => {
        expect(isClientSettableInvoiceStatus('DRAFT')).toBe(false);
    });

    it('refuses SENT — that belongs to INV-C’s deliberate human send', () => {
        expect(isClientSettableInvoiceStatus('SENT')).toBe(false);
    });

    it('refuses junk and non-strings', () => {
        expect(isClientSettableInvoiceStatus('draft')).toBe(false);
        expect(isClientSettableInvoiceStatus('')).toBe(false);
        expect(isClientSettableInvoiceStatus(null)).toBe(false);
        expect(isClientSettableInvoiceStatus(undefined)).toBe(false);
        expect(isClientSettableInvoiceStatus(1)).toBe(false);
    });
});
