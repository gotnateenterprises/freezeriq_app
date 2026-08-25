/**
 * INV-D — settlement truth.
 *
 * What these prove, in order of how much they matter:
 *
 *   1. PAID cannot be written without a method and a date.
 *   2. PAID cannot be written by the generic invoice editor at all, and cannot
 *      be silently reversed by it either.
 *   3. Approving an order for production no longer asserts payment.
 *   4. "Paid This Month" counts a payment once, in the month it arrived, and
 *      counts nothing for the historical invoices whose dates are unknown.
 *   5. Migration 17 adds columns and changes no data.
 *
 * Where a behaviour can be executed it is executed. The rules all live in
 * lib/invoiceSettlement.ts precisely so that they can be — the route and page
 * assertions below are the thin structural layer that proves the executed rules
 * are actually wired to the product, and the mutation battery run alongside this
 * file proves those structural assertions are load-bearing rather than decorative.
 */

import {
    SETTLEMENT_PAYMENT_METHODS,
    SETTLEMENT_REFERENCE_MAX_LENGTH,
    SETTLEABLE_INVOICE_STATUSES,
    SETTLEMENT_DATE_FLOOR_ISO,
    isSettlementPaymentMethod,
    isSettleableInvoiceStatus,
    validateSettlement,
    normalizeSettlementReference,
    calendarDateToUtcNoon,
    utcNoonToCalendarDate,
    isPaidInCurrentMonth,
    sumPaidThisMonth,
    hasDurableSettlement,
    isLegacyUnrecordedPayment,
    resolveUnsettledStatus,
    SETTLEMENT_FACT_FIELDS,
} from '@/lib/invoiceSettlement';
import {
    CLIENT_SETTABLE_INVOICE_STATUSES,
    GENERIC_EDIT_LOCKED_STATUSES,
    isGenericEditLockedStatus,
} from '@/lib/invoiceFulfillment';
import {
    OUTSTANDING_INVOICE_STATUSES,
    isOutstandingInvoiceStatus,
    sumOutstandingInvoices,
} from '@/lib/invoiceSendTruth';

const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

/** Strips comments so an assertion cannot pass on prose that merely describes the fix. */
const code = (p: string): string =>
    read(p)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const SETTLE_ROUTE = 'app/api/tenant/invoices/[id]/settle/route.ts';
const INVOICES_ROUTE = 'app/api/tenant/invoices/route.ts';
const ORDERS_ROUTE = 'app/api/orders/route.ts';
const INVOICES_PAGE = 'app/invoices/page.tsx';
const SCHEMA = 'prisma/schema.prisma';
const MIGRATION = 'prisma/migrations/20260825000000_inv_d_settlement_truth/migration.sql';

/** Fixed "now" so the future-date bound is deterministic. 2026-08-24, midday UTC. */
const NOW = new Date(Date.UTC(2026, 7, 24, 12, 0, 0));

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · payment method', () => {
    it('accepts exactly Square and Check', () => {
        expect(SETTLEMENT_PAYMENT_METHODS).toEqual(['square', 'check']);
        expect(isSettlementPaymentMethod('square')).toBe(true);
        expect(isSettlementPaymentMethod('check')).toBe(true);
    });

    it('rejects every other method, including ones the manual PDF dropdown offers', () => {
        for (const m of ['venmo', 'paypal', 'ach', 'cash', 'credit', 'debit', 'other', '']) {
            expect(isSettlementPaymentMethod(m)).toBe(false);
        }
        expect(isSettlementPaymentMethod(null)).toBe(false);
        expect(isSettlementPaymentMethod(undefined)).toBe(false);
        expect(isSettlementPaymentMethod(1)).toBe(false);
    });

    it('normalises case and surrounding whitespace before validating', () => {
        const r = validateSettlement({ method: '  CHECK ', paidAt: '2026-08-20' }, NOW);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.method).toBe('check');
    });

    it('refuses a settlement with no method at all', () => {
        const r = validateSettlement({ paidAt: '2026-08-20' }, NOW);
        expect(r.ok).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · payment date', () => {
    it('refuses a settlement with no date — this is the whole point of the phase', () => {
        const r = validateSettlement({ method: 'check' }, NOW);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/date/i);
    });

    it('refuses a malformed date', () => {
        for (const bad of ['', '   ', 'yesterday', '08/20/2026', '2026-8-20', '20260820']) {
            expect(validateSettlement({ method: 'check', paidAt: bad }, NOW).ok).toBe(false);
        }
    });

    it('refuses a date that is not a real calendar day', () => {
        // Date would silently roll 2026-02-30 forward into March.
        expect(validateSettlement({ method: 'check', paidAt: '2026-02-30' }, NOW).ok).toBe(false);
        expect(validateSettlement({ method: 'check', paidAt: '2026-13-01' }, NOW).ok).toBe(false);
        expect(validateSettlement({ method: 'check', paidAt: '2026-00-10' }, NOW).ok).toBe(false);
    });

    it('accepts today and the recent past', () => {
        expect(validateSettlement({ method: 'check', paidAt: '2026-08-24' }, NOW).ok).toBe(true);
        expect(validateSettlement({ method: 'check', paidAt: '2026-08-01' }, NOW).ok).toBe(true);
        expect(validateSettlement({ method: 'square', paidAt: '2026-03-25' }, NOW).ok).toBe(true);
    });

    it('accepts one day ahead, because the server does not know the tenant timezone', () => {
        // A tenant east of UTC can legitimately be on 2026-08-25 already.
        expect(validateSettlement({ method: 'check', paidAt: '2026-08-25' }, NOW).ok).toBe(true);
    });

    it('refuses a date genuinely in the future', () => {
        expect(validateSettlement({ method: 'check', paidAt: '2026-08-26' }, NOW).ok).toBe(false);
        expect(validateSettlement({ method: 'check', paidAt: '2027-01-01' }, NOW).ok).toBe(false);
    });

    it('refuses a date before FreezerIQ existed — catches a fat-fingered year', () => {
        expect(validateSettlement({ method: 'check', paidAt: '1926-08-20' }, NOW).ok).toBe(false);
        expect(validateSettlement({ method: 'check', paidAt: '2019-12-31' }, NOW).ok).toBe(false);
        expect(SETTLEMENT_DATE_FLOOR_ISO).toBe('2020-01-01');
    });

    it('anchors the stored date at UTC noon so it reads back as the day that was typed', () => {
        const d = calendarDateToUtcNoon('2026-08-24')!;
        expect(d.getUTCHours()).toBe(12);
        expect(utcNoonToCalendarDate(d)).toBe('2026-08-24');
        // The bug this prevents: UTC-midnight storage renders as the previous
        // day for every viewer west of UTC.
        const midnight = new Date('2026-08-24');
        expect(midnight.getUTCHours()).toBe(0);
        expect(new Date(midnight.getTime() - 5 * 3600_000).getUTCDate()).toBe(23);
        expect(new Date(d.getTime() - 5 * 3600_000).getUTCDate()).toBe(24);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · payment reference', () => {
    it('is optional and becomes null when blank or absent', () => {
        expect(normalizeSettlementReference(undefined)).toBeNull();
        expect(normalizeSettlementReference(null)).toBeNull();
        expect(normalizeSettlementReference('')).toBeNull();
        expect(normalizeSettlementReference('    ')).toBeNull();
        const r = validateSettlement({ method: 'check', paidAt: '2026-08-20' }, NOW);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.reference).toBeNull();
    });

    it('trims and collapses whitespace', () => {
        expect(normalizeSettlementReference('  check  1042  ')).toBe('check 1042');
        expect(normalizeSettlementReference('1042\n\n')).toBe('1042');
    });

    it('strips control characters rather than storing them', () => {
        expect(normalizeSettlementReference('10\x0042')).toBe('10 42');
        expect(normalizeSettlementReference('ref\x1b[31m')).toBe('ref [31m');
        expect(normalizeSettlementReference('a\x7fb')).toBe('a b');
    });

    it('caps length so the field stays a memo line', () => {
        const long = 'x'.repeat(500);
        expect(normalizeSettlementReference(long)!.length).toBe(SETTLEMENT_REFERENCE_MAX_LENGTH);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · which invoices may be settled', () => {
    it('allows exactly the issued-and-unpaid statuses', () => {
        expect(isSettleableInvoiceStatus('PENDING')).toBe(true);
        expect(isSettleableInvoiceStatus('SENT')).toBe(true);
        expect(isSettleableInvoiceStatus('OVERDUE')).toBe(true);
    });

    it('refuses DRAFT — nobody has been asked for the money yet', () => {
        expect(isSettleableInvoiceStatus('DRAFT')).toBe(false);
    });

    it('refuses PAID and CANCELED', () => {
        expect(isSettleableInvoiceStatus('PAID')).toBe(false);
        expect(isSettleableInvoiceStatus('CANCELED')).toBe(false);
    });

    it('is the SAME set as Total Outstanding — you can only settle a debt you claim', () => {
        // If these ever drift, one of the two numbers on the owner's screen is wrong.
        expect([...SETTLEABLE_INVOICE_STATUSES]).toEqual([...OUTSTANDING_INVOICE_STATUSES]);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · PAID is no longer the generic editor\'s to give or take', () => {
    it('removed PAID from the client-settable statuses', () => {
        expect([...CLIENT_SETTABLE_INVOICE_STATUSES]).toEqual(['PENDING', 'OVERDUE', 'CANCELED']);
        expect((CLIENT_SETTABLE_INVOICE_STATUSES as readonly string[])).not.toContain('PAID');
    });

    it('locks PAID and DRAFT against status changes through the generic editor', () => {
        expect([...GENERIC_EDIT_LOCKED_STATUSES]).toEqual(['PAID', 'DRAFT']);
        expect(isGenericEditLockedStatus('PAID')).toBe(true);
        expect(isGenericEditLockedStatus('DRAFT')).toBe(true);
        expect(isGenericEditLockedStatus('SENT')).toBe(false);
        expect(isGenericEditLockedStatus('PENDING')).toBe(false);
    });

    it('the invoice route enforces the lock against the PERSISTED status', () => {
        const src = code(INVOICES_ROUTE);
        expect(src).toContain('isGenericEditLockedStatus(persisted.status)');
        expect(src).toContain('status !== persisted.status');
    });

    it('an omitted status preserves the stored one instead of resetting to PENDING', () => {
        const src = code(INVOICES_ROUTE);
        // `status || 'PENDING'` on update would have silently destroyed an
        // INV-C SENT state on any edit that did not resend the field.
        expect(src).toContain("status: status ?? persisted?.status ?? 'PENDING'");
        expect(src).not.toContain("status: status || 'PENDING',\n                    fundraiser_profit_percent: isGenerated");
    });

    it('no longer invents a payment method the caller never sent', () => {
        const src = code(INVOICES_ROUTE);
        expect(src).not.toContain("payment_method: payment_method || 'check'");
        // POST: an omitted method means NULL, never 'check'.
        expect(src).toContain('payment_method: payment_method ?? null');
        // PUT: an omitted method preserves the stored one — and once the invoice
        // is PAID the stored one is frozen outright (settlement evidence).
        expect(src).toContain('(payment_method ?? persisted?.payment_method ?? null)');
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · the settlement endpoint', () => {
    const src = code(SETTLE_ROUTE);

    it('is tenant-scoped and answers 404 rather than revealing another tenant\'s invoice', () => {
        expect(src).toContain('where: { id: invoiceId, business_id: businessId }');
        expect(src).toContain("{ status: 404 }");
    });

    it('validates the settlement input before writing anything', () => {
        expect(src).toContain('validateSettlement(');
        expect(src.indexOf('validateSettlement(')).toBeLessThan(src.indexOf('updateMany'));
    });

    it('writes PAID only through a conditional transition out of a settleable status', () => {
        expect(src).toContain('status: { in: SETTLEABLE_INVOICE_STATUSES');
        expect(src).toContain('updateMany');
        expect(src).toContain('claimed.count !== 1');
    });

    it('never takes a status from the request body', () => {
        expect(src).not.toContain('body?.status');
        expect(src).not.toContain('body.status');
        expect(src).toContain("status: 'PAID'");
    });

    it('writes ONLY settlement fields — INV-B\'s frozen financials are not in the write set', () => {
        // Asserted against the `data:` payload specifically. The route legitimately
        // READS total_amount (for loyalty points), so a whole-file search for the
        // string would fail on a select and prove nothing about what is written.
        const upd = src.indexOf('tx.invoice.updateMany');
        expect(upd).toBeGreaterThan(-1);
        const dataStart = src.indexOf('data: {', upd);
        expect(dataStart).toBeGreaterThan(upd);
        const dataBlock = src.slice(dataStart, src.indexOf('},', dataStart));

        expect(dataBlock).toContain('paid_at');
        expect(dataBlock).toContain('payment_method');
        expect(dataBlock).toContain('payment_reference');

        expect(dataBlock).not.toContain('total_amount');
        expect(dataBlock).not.toContain('tax_amount');
        expect(dataBlock).not.toContain('fundraiser_profit');
        expect(dataBlock).not.toContain('items');
        expect(dataBlock).not.toContain('campaign_id');
    });

    it('treats a second settlement as idempotent instead of overwriting the first', () => {
        expect(src).toContain('alreadySettled');
        expect(src).toContain("invoice.status === 'PAID'");
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · approving an order no longer asserts payment', () => {
    it('the orders route contains no PAID write at all', () => {
        const src = code(ORDERS_ROUTE);
        expect(src).not.toContain("status: 'PAID'");
        expect(src).not.toMatch(/invoice\.update\(\s*\{[^}]*status:\s*'PAID'/);
    });

    it('still performs the order lifecycle transition it is actually responsible for', () => {
        const src = code(ORDERS_ROUTE);
        expect(src).toContain("dbSafeStatus === 'production_ready'");
    });

    it('payment now flows the other way — a recorded payment releases the order', () => {
        const src = code(SETTLE_ROUTE);
        expect(src).toContain("status: 'production_ready'");
        expect(src).toContain('invoice_id: invoice.id');
        // Campaign invoices are excluded exactly as INV-A excluded them.
        expect(src).toContain('!invoice.campaign_id');
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · Paid This Month', () => {
    it('counts a payment recorded inside the current calendar month', () => {
        expect(isPaidInCurrentMonth(new Date(Date.UTC(2026, 7, 1, 12)), NOW)).toBe(true);
        expect(isPaidInCurrentMonth(new Date(Date.UTC(2026, 7, 31, 12)), NOW)).toBe(true);
        expect(isPaidInCurrentMonth('2026-08-15T12:00:00.000Z', NOW)).toBe(true);
    });

    it('does not count a payment from another month or year', () => {
        expect(isPaidInCurrentMonth(new Date(Date.UTC(2026, 6, 31, 12)), NOW)).toBe(false);
        expect(isPaidInCurrentMonth(new Date(Date.UTC(2026, 8, 1, 12)), NOW)).toBe(false);
        expect(isPaidInCurrentMonth(new Date(Date.UTC(2025, 7, 15, 12)), NOW)).toBe(false);
    });

    it('does not count an invoice with no recorded payment date', () => {
        expect(isPaidInCurrentMonth(null, NOW)).toBe(false);
        expect(isPaidInCurrentMonth(undefined, NOW)).toBe(false);
        expect(isPaidInCurrentMonth('', NOW)).toBe(false);
        expect(isPaidInCurrentMonth('not a date', NOW)).toBe(false);
    });

    it('reports $0.00 for the five historical Production invoices, and that is correct', () => {
        // Real shape: PAID, no paid_at, $8,274.15 between them. The old rule
        // summed all of it and called it "this month".
        const historical = [
            { status: 'PAID', total_amount: '6420.00', paid_at: null },
            { status: 'PAID', total_amount: '845.00', paid_at: null },
            { status: 'PAID', total_amount: '870.00', paid_at: null },
            { status: 'PAID', total_amount: '860.00', paid_at: null },
            { status: 'PAID', total_amount: '1220.00', paid_at: null },
        ];
        expect(sumPaidThisMonth(historical, NOW)).toBe(0);
        // The old rule, for contrast.
        const oldRule = historical
            .filter((i) => i.status === 'PAID')
            .reduce((a, c) => a + Number(c.total_amount), 0);
        expect(oldRule).toBe(10215);
    });

    it('counts only PAID invoices, even if some other status carries a date', () => {
        const rows = [
            { status: 'SENT', total_amount: '202.50', paid_at: '2026-08-10T12:00:00.000Z' },
            { status: 'CANCELED', total_amount: '500.00', paid_at: '2026-08-10T12:00:00.000Z' },
            { status: 'PAID', total_amount: '202.50', paid_at: '2026-08-10T12:00:00.000Z' },
        ];
        expect(sumPaidThisMonth(rows, NOW)).toBe(202.5);
    });

    it('sums to the cent without float drift', () => {
        const rows = [
            { status: 'PAID', total_amount: '0.1', paid_at: '2026-08-02T12:00:00.000Z' },
            { status: 'PAID', total_amount: '0.2', paid_at: '2026-08-03T12:00:00.000Z' },
        ];
        expect(sumPaidThisMonth(rows, NOW)).toBe(0.3);
    });

    it('handles month and year boundaries exactly', () => {
        const jan = new Date(Date.UTC(2026, 0, 15, 12));   // mid-January 2026
        const dec = new Date(Date.UTC(2025, 11, 15, 12));  // mid-December 2025

        // First and last instant of the month, at the stored noon anchor.
        expect(isPaidInCurrentMonth(calendarDateToUtcNoon('2026-01-01'), jan)).toBe(true);
        expect(isPaidInCurrentMonth(calendarDateToUtcNoon('2026-01-31'), jan)).toBe(true);

        // One day either side falls out — including across the year boundary.
        expect(isPaidInCurrentMonth(calendarDateToUtcNoon('2025-12-31'), jan)).toBe(false);
        expect(isPaidInCurrentMonth(calendarDateToUtcNoon('2026-02-01'), jan)).toBe(false);
        expect(isPaidInCurrentMonth(calendarDateToUtcNoon('2026-01-01'), dec)).toBe(false);

        // Same month number, different year, must not collide.
        expect(isPaidInCurrentMonth(calendarDateToUtcNoon('2025-01-15'), jan)).toBe(false);

        // A leap-day settlement counts in its own month.
        expect(calendarDateToUtcNoon('2028-02-29')).not.toBeNull();
        expect(isPaidInCurrentMonth(calendarDateToUtcNoon('2028-02-29'), new Date(Date.UTC(2028, 1, 1, 12)))).toBe(true);
    });

    it('the noon anchor holds a month-edge date under local rendering, UTC-11..UTC+11', () => {
        // Models a viewer rendering the stored instant with LOCAL getters.
        // The failure this prevents: a 1st-of-month payment stored at UTC
        // midnight reads as the previous month for anyone west of UTC, moving
        // real revenue into the wrong reporting period.
        const first = calendarDateToUtcNoon('2026-08-01')!;
        const last = calendarDateToUtcNoon('2026-08-31')!;
        for (const offsetHours of [-11, -8, -5, 0, 5.5, 9, 11]) {
            expect(new Date(first.getTime() + offsetHours * 3600_000).getUTCMonth()).toBe(7);
            expect(new Date(last.getTime() + offsetHours * 3600_000).getUTCMonth()).toBe(7);
        }

        // Honest bound: no single anchor spans the real -12..+14 range, so a
        // UTC+12 viewer using local getters would see the next day. Asserted so
        // the limitation is recorded rather than discovered.
        expect(new Date(last.getTime() + 12 * 3600_000).getUTCMonth()).toBe(8);

        // Midnight storage fails far earlier — at every western offset.
        expect(new Date(new Date('2026-08-01').getTime() - 5 * 3600_000).getUTCMonth()).toBe(6);

        // And none of it reaches the actual total, which compares in UTC.
        expect(isPaidInCurrentMonth(last, new Date(Date.UTC(2026, 7, 24, 12)))).toBe(true);
    });

    it('is what the invoices page actually renders', () => {
        const src = code(INVOICES_PAGE);
        expect(src).toContain('sumPaidThisMonth(invoices, new Date())');
        // The old status-only reduce must be gone.
        expect(src).not.toContain("invoices.filter(i => i.status === 'PAID').reduce");
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · the owner-facing dialog', () => {
    const src = read(INVOICES_PAGE);

    it('collects a method and a date before recording anything', () => {
        expect(src).toContain('id="settle-paid-at"');
        expect(src).toContain('SETTLEMENT_PAYMENT_METHODS.map');
        expect(src).toContain('handleConfirmSettlement');
    });

    it('posts to the dedicated settle endpoint, not the generic invoice PUT', () => {
        expect(src).toContain('/settle`');
        expect(src).toContain("method: 'POST'");
        expect(code(INVOICES_PAGE)).not.toContain("status: 'PAID',");
    });

    it('offers Record Payment only for settleable invoices', () => {
        expect(src).toContain('isSettleableInvoiceStatus(inv.status) && (');
        expect(code(INVOICES_PAGE)).not.toContain("inv.status !== 'PAID' && (");
    });

    it('tells the owner plainly that FreezerIQ verified nothing', () => {
        expect(src).toMatch(/does not contact Square/i);
    });

    it('asks for a check number or Square reference — never banking details', () => {
        expect(src).toMatch(/Check number/i);
        expect(src).toMatch(/Square reference/i);
        for (const forbidden of ['routing', 'Routing', 'account number', 'Account Number']) {
            expect(src).not.toContain(forbidden);
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · Total Outstanding round-trips through settle and undo', () => {
    // The accepted Production invoice, at its real values.
    const accepted = { status: 'SENT', total_amount: '202.50' };
    const others = [
        { status: 'DRAFT', total_amount: '400.00' },   // excluded — not issued
        { status: 'PAID', total_amount: '5200.20' },   // excluded — collected
        { status: 'CANCELED', total_amount: '99.00' }, // excluded — never collectable
    ];

    it('SENT counts as outstanding', () => {
        expect(sumOutstandingInvoices([accepted, ...others])).toBe(202.5);
    });

    it('recording payment removes it from outstanding', () => {
        const settled = { status: 'PAID', total_amount: '202.50' };
        expect(sumOutstandingInvoices([settled, ...others])).toBe(0);
    });

    it('undoing the payment puts exactly the same amount back', () => {
        // A fundraiser invoice restores to SENT, which is an outstanding status —
        // so the receivable returns to precisely where it started.
        const restored = resolveUnsettledStatus(
            { campaign_id: 'camp-1', due_date: null },
            new Date(Date.UTC(2026, 7, 24, 12)),
        );
        expect(restored).toBe('SENT');
        expect(sumOutstandingInvoices([{ status: restored, total_amount: '202.50' }, ...others]))
            .toBe(202.5);
    });

    it('every status a correction can produce is an outstanding status', () => {
        // Otherwise a corrected invoice would vanish from the receivable while
        // still being unpaid.
        for (const s of ['SENT', 'PENDING', 'OVERDUE'] as const) {
            expect(isOutstandingInvoiceStatus(s)).toBe(true);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// UNDO PAYMENT — correcting a mistaken settlement
// ═══════════════════════════════════════════════════════════════════════════

describe('INV-D · what counts as a correctable payment', () => {
    const settled = {
        status: 'PAID',
        paid_at: new Date(Date.UTC(2026, 7, 10, 12)),
        payment_method: 'check',
    };

    it('a payment recorded through INV-D is correctable', () => {
        expect(hasDurableSettlement(settled)).toBe(true);
        expect(hasDurableSettlement({ ...settled, payment_method: 'square' })).toBe(true);
    });

    it('the five historical PAID invoices are NOT correctable', () => {
        // Real Production shape: PAID, payment_method 'check' from the old schema
        // default, and no paid_at because nobody recorded one.
        const legacy = { status: 'PAID', paid_at: null, payment_method: 'check' };
        expect(hasDurableSettlement(legacy)).toBe(false);
        expect(isLegacyUnrecordedPayment(legacy)).toBe(true);
    });

    it('an unpaid invoice is not correctable and is not legacy', () => {
        for (const s of ['DRAFT', 'SENT', 'PENDING', 'OVERDUE', 'CANCELED']) {
            expect(hasDurableSettlement({ ...settled, status: s })).toBe(false);
            expect(isLegacyUnrecordedPayment({ status: s, paid_at: null })).toBe(false);
        }
    });

    it('a PAID invoice whose method is outside the settlement contract is not correctable', () => {
        // Nothing can produce this today; refused rather than guessed at.
        expect(hasDurableSettlement({ ...settled, payment_method: 'venmo' })).toBe(false);
        expect(hasDurableSettlement({ ...settled, payment_method: null })).toBe(false);
    });

    it('an unparseable paid_at does not count as durable settlement', () => {
        expect(hasDurableSettlement({ ...settled, paid_at: 'not a date' })).toBe(false);
    });
});

describe('INV-D · which status a corrected invoice returns to', () => {
    const NOW_D = new Date(Date.UTC(2026, 7, 24, 12));

    it('a fundraiser invoice returns to SENT — it had to be sent to be settleable', () => {
        expect(resolveUnsettledStatus({ campaign_id: 'camp-1', due_date: null }, NOW_D)).toBe('SENT');
        // Even if its due date has passed: it is issued and outstanding, and SENT
        // is the state the send route actually left it in.
        expect(resolveUnsettledStatus({ campaign_id: 'camp-1', due_date: '2026-01-01' }, NOW_D)).toBe('SENT');
    });

    it('a manual invoice returns to its truthful unpaid state NOW', () => {
        expect(resolveUnsettledStatus({ campaign_id: null, due_date: '2026-09-30' }, NOW_D)).toBe('PENDING');
        expect(resolveUnsettledStatus({ campaign_id: null, due_date: '2026-08-01' }, NOW_D)).toBe('OVERDUE');
        expect(resolveUnsettledStatus({ campaign_id: null, due_date: null }, NOW_D)).toBe('PENDING');
    });

    it('never returns an invoice to DRAFT', () => {
        const cases = [
            { campaign_id: 'c', due_date: null },
            { campaign_id: null, due_date: '2020-01-01' },
            { campaign_id: null, due_date: null },
        ];
        for (const c of cases) expect(resolveUnsettledStatus(c, NOW_D)).not.toBe('DRAFT');
    });

    /**
     * THE INVARIANT THIS RULE DEPENDS ON.
     *
     * resolveUnsettledStatus derives a manual invoice's prior status instead of
     * storing it, which is only safe because a manual invoice can never have been
     * SENT. That holds because DRAFT is written in exactly one place (closeout,
     * which always sets campaign_id) and SENT is reachable only from DRAFT.
     *
     * If either ever changes, this test fails FIRST — before the correction path
     * starts silently erasing an issued state.
     */
    it('INVARIANT: DRAFT is written only by closeout, and only with a campaign_id', () => {
        const closeout = code('app/api/campaigns/[id]/closeout/route.ts');
        const draftWrite = closeout.slice(
            closeout.indexOf('tx.invoice.create'),
            closeout.indexOf('tx.invoice.create') + 700,
        );
        expect(draftWrite).toContain("status: 'DRAFT'");
        expect(draftWrite).toContain('campaign_id: campaignId');

        // And no other executable writer of DRAFT exists in the API surface.
        const writers: string[] = [];
        for (const f of [INVOICES_ROUTE, SETTLE_ROUTE, 'app/api/tenant/invoices/[id]/send/route.ts', ORDERS_ROUTE]) {
            if (/status:\s*'DRAFT'/.test(code(f).replace(/where:\s*\{[^}]*\}/g, ''))) writers.push(f);
        }
        expect(writers).toEqual([]);
    });

    it('INVARIANT: SENT is written only from DRAFT', () => {
        const send = code('app/api/tenant/invoices/[id]/send/route.ts');
        expect(send).toContain("status: 'DRAFT' as any");
        expect(send).toContain("data: { status: 'SENT' as any }");
        // The generic editor cannot set either one.
        expect((CLIENT_SETTABLE_INVOICE_STATUSES as readonly string[])).not.toContain('SENT');
        expect((CLIENT_SETTABLE_INVOICE_STATUSES as readonly string[])).not.toContain('DRAFT');
    });
});

describe('INV-D · the Undo Payment endpoint', () => {
    const src = code(SETTLE_ROUTE);
    /** DELETE handler only — POST contains near-identical strings, so a
     *  whole-file assertion would pass even if THIS handler lost the guard. */
    const del = src.slice(src.indexOf('export async function DELETE('));
    /** POST handler only, for the same reason in reverse. */
    const post = src.slice(src.indexOf('export async function POST('), src.indexOf('export async function DELETE('));

    it('exists as a DELETE on the settlement route — one authority, not two', () => {
        expect(src).toContain('export async function DELETE(');
    });

    it('is tenant-scoped and non-disclosing — asserted per handler', () => {
        for (const [name, handler] of [['POST', post], ['DELETE', del]] as const) {
            expect(handler).toContain('where: { id: invoiceId, business_id: businessId }');
            expect(handler).toContain('{ status: 404 }');
            expect(handler).toContain("{ error: 'Unauthorized' }");
            expect(name).toBeTruthy();
        }
    });

    it('refuses a legacy PAID invoice before doing anything else', () => {
        // Asserted as the EXACT guard, not merely a mention: `if (false && ...)`
        // still contains the call, and would otherwise pass.
        expect(del).toContain('if (isLegacyUnrecordedPayment(invoice)) {');
        expect(del).toContain('legacy_unrecorded_payment');
        expect(del.indexOf('isLegacyUnrecordedPayment')).toBeLessThan(del.indexOf('updateMany'));
    });

    /** The DELETE's invoice.updateMany `where` and `data` blocks, isolated. */
    const undoWrite = (() => {
        const upd = del.indexOf('tx.invoice.updateMany');
        const whereStart = del.indexOf('where: {', upd);
        const dataStart = del.indexOf('data: {', upd);
        return {
            where: del.slice(whereStart, dataStart),
            data: del.slice(dataStart, del.indexOf('},', dataStart)),
        };
    })();

    it('clears every settlement fact and restores the derived status', () => {
        for (const f of SETTLEMENT_FACT_FIELDS) {
            expect(undoWrite.data).toMatch(new RegExp(`${f}:\\s*null`));
        }
        expect(undoWrite.data).toContain('status: restoredStatus');
    });

    it('never touches financial facts', () => {
        for (const f of ['total_amount', 'tax_amount', 'fundraiser_profit', 'items', 'campaign_id']) {
            expect(undoWrite.data).not.toContain(f);
        }
    });

    it('uses a conditional transition guarded on PAID with a non-null paid_at', () => {
        expect(undoWrite.where).toContain("status: 'PAID' as any");
        expect(undoWrite.where).toContain('paid_at: { not: null }');
        expect(del).toContain('corrected.count !== 1');
    });

    it('carries the tenant condition on the WRITE, not merely on the lookup', () => {
        // Asserted against the updateMany `where` specifically. `business_id`
        // also appears in this handler's findFirst, so a whole-handler search
        // would still pass with the write left unscoped.
        expect(undoWrite.where).toContain('business_id: businessId');
    });

    it('treats a second undo as idempotent success, not a conflict', () => {
        expect(del).toContain("if (invoice.status !== 'PAID') {");
        expect(del).toContain('alreadyCorrected');
    });

    it('introduces no loyalty-points spend path', () => {
        // LOY-P0 has accrual paused, so there is nothing to reverse — and a
        // standing guard asserts every surviving points mutation increments.
        // A correction must not become the codebase's first decrement.
        expect(del).not.toMatch(/loyalty_balance:\s*\{\s*decrement/);
        expect(del).not.toContain('loyaltyPoint.delete');
    });

    it('does not revert linked fulfilment orders', () => {
        // Production is a physical fact; correcting a bookkeeping mistake does
        // not un-cook food, and the order's prior status is not recorded.
        expect(del).not.toContain('tx.order.updateMany');
        expect(del).not.toContain("status: 'pending'");
    });
});

describe('INV-D · settlement facts survive an ordinary invoice edit', () => {
    it('the generic PUT freezes payment_method once an invoice is PAID', () => {
        const src = code(INVOICES_ROUTE);
        expect(src).toContain("persisted?.status === 'PAID'");
        expect(src).toContain('? persisted.payment_method');
    });

    it('the generic PUT never writes paid_at or payment_reference at all', () => {
        const src = code(INVOICES_ROUTE);
        expect(src).not.toContain('paid_at:');
        expect(src).not.toContain('payment_reference:');
    });
});

describe('INV-D · the correction UX', () => {
    const src = read(INVOICES_PAGE);

    it('is offered only where there is a recorded payment to correct', () => {
        expect(src).toContain('hasDurableSettlement(inv) && (');
        expect(src).toContain('handleConfirmUndoPayment');
    });

    it('requires a confirmation step and is not part of invoice editing', () => {
        expect(src).toContain('undoingInvoice && (');
        expect(src).toMatch(/Undo Payment/);
        expect(src).toMatch(/Keep payment/);
    });

    it('states the consequence plainly', () => {
        expect(src).toMatch(/unpaid again/i);
        expect(src).toMatch(/clears the\s+recorded payment details/i);
        expect(src).toMatch(/not a\s+refund/i);
    });

    it('uses DELETE on the settle route', () => {
        expect(src).toMatch(/\/settle`,\s*\{\s*method: 'DELETE'/);
    });

    it('labels legacy PAID invoices honestly instead of implying a record', () => {
        expect(src).toContain('isLegacyUnrecordedPayment(inv)');
        expect(src).toMatch(/recorded before payment details were tracked/);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · the compose modal cannot re-invent a payment method', () => {
    const MODAL = 'components/crm/InvoiceComposeModal.tsx';

    it('offers an explicit "not specified" choice', () => {
        expect(read(MODAL)).toContain('<option value="">Not specified</option>');
    });

    it('does not coerce a NULL stored method to check when opening an invoice', () => {
        const src = code(MODAL);
        expect(src).not.toContain("invoiceToEdit.payment_method || 'check'");
        expect(src).toContain("setPaymentMethod(invoiceToEdit.payment_method ?? '')");
    });

    it('sends null rather than an empty string when left unspecified', () => {
        expect(code(MODAL)).toContain('payment_method: paymentMethod || null');
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · migration 17', () => {
    const sql = read(MIGRATION);
    const ddl = sql.replace(/^\s*--.*$/gm, '').trim();

    it('adds paid_at and payment_reference as nullable columns', () => {
        expect(ddl).toContain('ALTER TABLE "invoices" ADD COLUMN "paid_at" TIMESTAMP(3);');
        expect(ddl).toContain('ALTER TABLE "invoices" ADD COLUMN "payment_reference" TEXT;');
        expect(ddl).not.toMatch(/paid_at"\s+TIMESTAMP\(3\)\s+NOT NULL/);
    });

    it('drops the payment_method default without touching stored values', () => {
        expect(ddl).toContain('ALTER COLUMN "payment_method" DROP DEFAULT');
        expect(ddl).not.toMatch(/SET\s+DEFAULT/i);
    });

    it('adds settled_externally as a boolean defaulting to false', () => {
        expect(ddl).toContain('"settled_externally" BOOLEAN NOT NULL DEFAULT false');
        // A timestamp would have to be filled with a date nobody knows.
        expect(ddl).not.toMatch(/settled_externally_at/);
    });

    it('writes NO data — no backfill, no invoice touched, nothing marked settled', () => {
        expect(ddl).not.toMatch(/\bUPDATE\b/i);
        expect(ddl).not.toMatch(/\bINSERT\b/i);
        expect(ddl).not.toMatch(/\bDELETE\b/i);
        expect(ddl).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
        expect(ddl).not.toMatch(/=\s*true/i);
    });

    it('contains exactly the four approved statements', () => {
        const statements = ddl.split(';').map((s) => s.trim()).filter(Boolean);
        expect(statements).toHaveLength(4);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('INV-D · schema matches the migration', () => {
    // Comments stripped FIRST. The INV-D comment block explains why the
    // `@default("check")` was removed and therefore contains that exact string —
    // asserting against raw source would pass on prose describing the fix rather
    // than on the fix.
    const schema = read(SCHEMA).replace(/^\s*\/\/.*$/gm, '');
    const invoiceModel = schema.slice(
        schema.indexOf('model Invoice {'),
        schema.indexOf('model Invoice {') + 2000,
    );

    it('payment_method no longer carries a default', () => {
        expect(invoiceModel).not.toContain('@default("check")');
        expect(schema).not.toContain('@default("check")');
    });

    it('declares paid_at and payment_reference as optional', () => {
        expect(invoiceModel).toMatch(/paid_at\s+DateTime\?/);
        expect(invoiceModel).toMatch(/payment_reference\s+String\?/);
    });

    it('declares settled_externally on the campaign, defaulting to false', () => {
        expect(schema).toMatch(/settled_externally\s+Boolean\s+@default\(false\)/);
    });

    it('leaves the INV-B frozen financial fields exactly as they were', () => {
        expect(invoiceModel).toMatch(/total_amount\s+Decimal\s+@db\.Decimal\(10, 2\)/);
        expect(invoiceModel).toMatch(/tax_amount\s+Decimal\?\s+@default\(0\)/);
        expect(invoiceModel).toMatch(/fundraiser_profit_percent\s+Decimal\?\s+@default\(0\)/);
        expect(invoiceModel).toMatch(/fundraiser_profit_amount\s+Decimal\?\s+@default\(0\)/);
    });
});
