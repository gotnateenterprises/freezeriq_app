/**
 * QB-INVOICE-1C — "Send via QuickBooks" for one FreezerIQ fundraiser invoice.
 *
 * THE LIFECYCLE (owner-locked). Every arrow is preceded by a read-back that must pass the contract in
 * lib/quickbooks/invoiceContract.ts, or the lifecycle stops:
 *
 *   the tenant reviews the DRAFT and clicks Send via QuickBooks (a review token binds the click to what it saw)
 *   → PRE-CREATE GATE     live connection; US company; verified settings; no company default CC/BCC or custom
 *                         numbering; the organization's active QuickBooks customer; invoice still DRAFT and
 *                         reconciling to the cent; financial values unchanged since review
 *   → RESERVE             the invoice's ONE QuickBooks link and its derived Intuit requestid (QB-INVOICE-1B)
 *   → CREATE, unsent      no recipient, EmailStatus NotSet, all four payment flags false, no DocNumber
 *   → READ BACK           'created'                                         → status created
 *   → UPDATE recipients   BillEmail (+ one CC) with all four flags restated false
 *   → READ BACK           'recipients'                                      → status recipients_set
 *   → UPDATE payment      the tenant's card/ACH options, recipients restated (skipped when none)
 *   → READ BACK           EmailSent already? QuickBooks auto-sent after the verified update: verify 'sent',
 *                         record it as the send event, and never call Send.  Otherwise 'payment_options'
 *                                                                           → status payment_options_set
 *   → SEND                POST /invoice/{id}/send on the SAME invoice, to its verified recipients
 *   → VERIFY              the send response and a fresh read-back pass 'sent'
 *   → MARK SENT           lifecycle 'sent' and FreezerIQ invoice DRAFT→SENT, in ONE transaction
 *
 * FAIL-CLOSED. A failed read-back parks the lifecycle in needs_review: nothing is sent, the FreezerIQ invoice
 * stays not-SENT, the QuickBooks invoice is kept for controlled repair, and no second QuickBooks invoice can ever
 * be created — the link's UNIQUE(invoice_id), this table's UNIQUE(invoice_id) and the derived requestid make that
 * structural. Transient failures (QuickBooks unavailable, a lost response, a stale SyncToken) keep the status
 * and record a problem; the next attempt resumes from the last verified step after reading QuickBooks again.
 *
 * THE REVIEW IS THE AUTHORIZATION. The lifecycle stores what was reviewed — the item/account/term mapping, the
 * invoice date, the payment options and the recipients — and a hash over the exact create body and read-back
 * expectation. Resuming or re-sending rebuilds both from the stored review and the CURRENT FreezerIQ invoice;
 * any difference refuses to continue. The stored mapping is re-verified against QuickBooks every time.
 *
 * CONCURRENCY. A lease (compare-and-set on lease_id) lets exactly one request drive a lifecycle; a second click
 * answers in_progress. Each QuickBooks write is preceded by a lease-renewing write, so a request whose lease
 * expired can no longer reach QuickBooks. A create whose answer was lost is replayed with the SAME requestid,
 * only within CREATE_RETRY_WINDOW_MS (Intuit does not document how long it remembers a requestid).
 *
 * SENT means QuickBooks reports that it emailed the invoice — not that it was delivered, and not that it was
 * paid. Nothing here reads or writes PAID, payments, fulfillment or release. No Payments scope, no webhook.
 *
 * Nothing logged or returned carries a token, the realm id, the connection id or a raw QuickBooks id.
 */

import { createHash, randomBytes } from 'crypto';
import { prisma } from '@/lib/db';
import type { QuickBooksConfig } from '@/lib/quickbooks/config';
import { QuickBooksConnectionError, type Deps } from '@/lib/quickbooks/connection';
import {
    createQuickBooksInvoice,
    IntuitError,
    intuitErrorDetail,
    PAYMENT_FLAGS_OFF,
    readCustomer,
    readQuickBooksInvoice,
    sendQuickBooksInvoice,
    updateQuickBooksInvoiceDelivery,
    type QuickBooksInvoiceCreateBody,
    type QuickBooksInvoiceSnapshot,
    type QuickBooksPaymentFlags,
} from '@/lib/quickbooks/intuitClient';
import { verifyQuickBooksInvoice, type ContractResult, type ContractStage, type ExpectedQuickBooksInvoice } from '@/lib/quickbooks/invoiceContract';
import { getQuickBooksInvoiceLink, recordQuickBooksInvoiceId, reserveQuickBooksInvoiceLink, type InvoiceLinkDb } from '@/lib/quickbooks/invoiceLinks';
import { planQuickBooksInvoice, type InvoiceMapping, type InvoicePlanProblem } from '@/lib/quickbooks/invoicePayload';
import { normalizeRecipient, normalizeRecipients, type RecipientProblem } from '@/lib/quickbooks/invoiceRecipients';
import {
    loadVerifiedInvoiceSettings,
    verifyInvoiceMappingLive,
    type InvoiceSettingsDb,
    type SettingsBlocker,
    type SettingsProblem,
} from '@/lib/quickbooks/invoiceSettings';
import {
    ConnectionChangedError,
    connectionProblem,
    isConnectionProblem,
    liveConnection,
    withAccess,
    type LiveConnection,
    type LiveConnectionDeps,
} from '@/lib/quickbooks/liveConnection';
import { calendarDateInTimeZone } from '@/lib/tenantTimezone';
import { CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT, resolveCampaignCoordinator, type CoordinatorAssignmentRow } from '@/lib/campaignCoordinatorContact';

export type InvoiceSendDb = Pick<typeof prisma,
    'integration' | '$transaction' | 'quickBooksConnection' | 'quickBooksCustomerLink' | 'quickBooksInvoiceLink'
    | 'quickBooksInvoiceSettings' | 'quickBooksInvoiceSend' | 'invoice'>;

export interface InvoiceSendDeps extends Omit<Deps, 'db'> {
    db?: InvoiceSendDb;
    /** Test seam: lease ids. */
    newLeaseId?: () => string;
}

/** How long one request may drive a lifecycle without renewing its lease. */
export const LEASE_MS = 2 * 60 * 1000;
/** How long after the first create attempt a create whose answer was lost may still be replayed. */
export const CREATE_RETRY_WINDOW_MS = 10 * 60 * 1000;

const REVIEW_TOKEN = /^[a-f0-9]{64}$/;
const OBJECT_ID = /^[0-9]{1,32}$/;

export class InvoiceNotFoundError extends Error {
    constructor() {
        super('Invoice not found for this tenant');
        Object.setPrototypeOf(this, InvoiceNotFoundError.prototype); // ES5 target
        this.name = 'InvoiceNotFoundError';
    }
}

/** Thrown if a repair session ever reaches the create step. Nothing was sent to Intuit when it is thrown. */
export class CreateForbiddenError extends Error {
    constructor() {
        super('QuickBooks invoice create is forbidden on a repair session');
        Object.setPrototypeOf(this, CreateForbiddenError.prototype); // ES5 target
    }
}

class LeaseLostError extends Error {
    constructor() {
        super('QuickBooks invoice send lease lost');
        Object.setPrototypeOf(this, LeaseLostError.prototype);
        this.name = 'LeaseLostError';
    }
}

class InvoiceLeftDraftError extends Error {
    constructor() {
        super('The FreezerIQ invoice left DRAFT during the QuickBooks send');
        Object.setPrototypeOf(this, InvoiceLeftDraftError.prototype);
        this.name = 'InvoiceLeftDraftError';
    }
}

// ── public shapes ───────────────────────────────────────────────────────────

/** Why sending (or resuming, or re-sending) cannot happen right now. Nothing was written. */
export type SendBlocker =
    | 'not_connected' | 'reconnect_required' | 'quickbooks_unavailable'
    | 'invoice_not_campaign' | 'invoice_not_draft' | 'invoice_not_sent' | 'not_sent_via_quickbooks'
    | 'customer_not_linked' | 'customer_link_invalid' | 'timezone_invalid'
    | 'linked_to_another_connection' | 'changed_since_review' | 'qbo_invoice_changed' | 'update_rejected' | 'lifecycle_unreadable'
    /** This stopped lifecycle is not one the create-stage recheck may touch (it is the ONLY repair that exists). */
    | 'recheck_not_available'
    | 'settings_missing' | SettingsProblem | SettingsBlocker | InvoicePlanProblem;

/** Why a lifecycle is paused (retryable) or stopped (needs_review). Codes only — never a name, email or amount. */
export type SendProblem =
    | 'quickbooks_unavailable' | 'connection_changed' | 'stale_object'
    | 'create_rejected' | 'create_outcome_unknown' | 'create_record_conflict'
    | 'update_rejected' | 'update_outcome_unknown'
    | 'send_rejected' | 'send_outcome_unknown'
    | 'qbo_invoice_missing' | 'qbo_invoice_changed' | 'invoice_status_changed' | 'unexpected_email_status' | 'unexpected_state'
    | 'verification_failed_created' | 'verification_failed_recipients' | 'verification_failed_payment_options' | 'verification_failed_sent';

export interface SendPreviewLine { role: 'bundle' | 'share' | 'tax'; description: string; quantity: number; unitPrice: number; amount: number }

/** What the tenant reviews before sending: exactly the QuickBooks invoice FreezerIQ will create. */
export interface SendPreview {
    quickBooksCustomerName: string;
    txnDate: string;
    dueDate: string;
    lines: SendPreviewLine[];
    totals: { bundles: number; share: number; tax: number; total: number };
    memo: string | null;
}

export type InvoiceSendStep = 'reserved' | 'created' | 'recipients_set' | 'payment_options_set';

export type InvoiceSendView =
    | { state: 'blocked'; blockers: SendBlocker[] }
    | {
        state: 'ready';
        reviewToken: string;
        preview: SendPreview;
        /** The campaign's assigned coordinator, else the organization contact on file — always reviewed, never used unreviewed. */
        suggestedRecipient: string | null;
        suggestedRecipientSource: 'assigned' | 'organization' | 'none';
        /** The tenant's optional default CC from the QuickBooks invoice settings. */
        suggestedCc: string | null;
        payment: { card: boolean; ach: boolean };
    }
    | {
        state: 'in_progress';
        step: InvoiceSendStep;
        /** Another request is driving it right now. */
        busy: boolean;
        docNumber: string | null;
        recipientTo: string;
        recipientCc: string | null;
        problem: SendProblem | null;
        problemDetail: string | null;
    }
    | {
        state: 'needs_review';
        docNumber: string | null;
        recipientTo: string;
        recipientCc: string | null;
        problem: SendProblem | null;
        problemDetail: string | null;
        /** The create-stage read-back failed on an invoice QuickBooks already holds: it may be re-read and re-checked. */
        recheckable: boolean;
    }
    | {
        state: 'sent';
        busy: boolean;
        docNumber: string | null;
        /** When QuickBooks last emailed the invoice (its DeliveryTime). */
        sentAt: string | null;
        autoSent: boolean;
        sendCount: number;
        recipientTo: string;
        recipientCc: string | null;
        deliveryErrorType: string | null;
        deliveryCheckedAt: string | null;
        /** The FreezerIQ invoice's status (only a SENT invoice can be re-sent). */
        invoiceStatus: string | null;
        lastProblem: SendProblem | null;
    };

export type SendActionResult =
    | { outcome: 'sent' | 'in_progress' | 'needs_review'; view: InvoiceSendView }
    | { outcome: 'blocked'; blockers: SendBlocker[] }
    /** What the tenant reviewed no longer matches FreezerIQ or QuickBooks. Nothing was sent. */
    | { outcome: 'stale'; view: InvoiceSendView }
    | { outcome: 'invalid'; reason: RecipientProblem | 'review_token' };

// ── internals: loading ──────────────────────────────────────────────────────

interface Resolved {
    db: InvoiceSendDb;
    fetchImpl: NonNullable<Deps['fetchImpl']>;
    env?: NodeJS.ProcessEnv;
    now: () => number;
    sleep?: Deps['sleep'];
    newLeaseId: () => string;
}

function resolve(deps: InvoiceSendDeps): Resolved {
    return {
        db: deps.db ?? (prisma as unknown as InvoiceSendDb),
        fetchImpl: deps.fetchImpl ?? fetch,
        env: deps.env,
        now: deps.now ?? Date.now,
        sleep: deps.sleep,
        newLeaseId: deps.newLeaseId ?? (() => randomBytes(16).toString('hex')),
    };
}

const liveDeps = (d: Resolved): LiveConnectionDeps => ({ db: d.db, fetchImpl: d.fetchImpl, env: d.env, now: d.now, sleep: d.sleep });
const settingsDeps = (d: Resolved) => ({ db: d.db as unknown as InvoiceSettingsDb, fetchImpl: d.fetchImpl, env: d.env, now: d.now, sleep: d.sleep });
const linkDeps = (d: Resolved) => ({ db: d.db as unknown as InvoiceLinkDb, env: d.env });

const INVOICE_SELECT = {
    id: true, customer_id: true, campaign_id: true, status: true,
    total_amount: true, tax_amount: true, tax_rate_percent: true, tax_status: true,
    fundraiser_profit_amount: true, fundraiser_profit_percent: true,
    items: { select: { id: true, description: true, variant_size: true, quantity: true, unit_price: true, total: true } },
    business: { select: { timezone: true } },
    customer: { select: { contact_email: true, contact_name: true } },
    campaign: { select: { primary_coordinator: { select: CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT } } },
};

interface LoadedInvoice {
    id: string; customer_id: string; campaign_id: string | null; status: string;
    total_amount: unknown; tax_amount: unknown; tax_rate_percent: unknown; tax_status: string | null;
    fundraiser_profit_amount: unknown; fundraiser_profit_percent: unknown;
    items: Array<{ id: string; description: string; variant_size: string | null; quantity: unknown; unit_price: unknown; total: unknown }>;
    business: { timezone: string } | null;
    customer: { contact_email: string | null; contact_name: string | null } | null;
    campaign: { primary_coordinator: CoordinatorAssignmentRow | null } | null;
}

async function loadInvoice(d: Resolved, businessId: string, invoiceId: string): Promise<LoadedInvoice> {
    const invoice = await d.db.invoice.findFirst({ where: { id: invoiceId, business_id: businessId }, select: INVOICE_SELECT });
    if (!invoice) throw new InvoiceNotFoundError();
    return invoice as unknown as LoadedInvoice;
}

type SendRow = NonNullable<Awaited<ReturnType<InvoiceSendDb['quickBooksInvoiceSend']['findUnique']>>>;

async function readRow(d: Resolved, businessId: string, invoiceId: string): Promise<SendRow | null> {
    const row = await d.db.quickBooksInvoiceSend.findUnique({ where: { invoice_id: invoiceId } });
    return row && row.business_id === businessId ? row : null;
}

/** A lifecycle has reached QuickBooks once a create was attempted (or it stopped). Before that, a new review may replace it. */
const reachedQuickBooks = (row: SendRow) => !(row.status === 'reserved' && row.create_requested_at === null);

/**
 * The ONE stopped state a repair may act on, from the lifecycle row alone: the CREATE-stage read-back failed on an
 * invoice QuickBooks had already accepted (`create_requested_at` is the durable proof the create was dispatched),
 * FreezerIQ never emailed anything, and the send was never recorded. Every other `needs_review` stays terminal —
 * there is no general-purpose force-resume. The deeper conditions (a current-generation link, an existing
 * `qboInvoiceId`, a still-DRAFT FreezerIQ invoice, the unchanged review) are re-proven live by the action itself.
 */
const recheckableRow = (row: SendRow) => row.status === 'needs_review'
    && row.problem === 'verification_failed_created'
    && row.create_requested_at !== null
    && row.send_count === 0
    && row.sent_at === null;
const leaseActive = (row: SendRow, now: number) => row.lease_id !== null && row.lease_until !== null && row.lease_until.getTime() > now;

/** The mapping the tenant reviewed, as stored on the lifecycle. Ids only. */
function reviewedOf(row: SendRow): { mapping: InvoiceMapping; txnDate: string; payment: QuickBooksPaymentFlags } | null {
    const m = row.mapping as Record<string, unknown> | null;
    const id = (v: unknown): v is string => typeof v === 'string' && OBJECT_ID.test(v);
    const optional = (v: unknown): v is string | null => v === null || id(v);
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const { salesItemId, salesAccountId, shareItemId, shareAccountId, taxItemId, taxAccountId, termId, termDueDays } = m;
    if (!id(salesItemId) || !id(salesAccountId) || !optional(shareItemId) || !optional(shareAccountId)
        || !optional(taxItemId) || !optional(taxAccountId) || !id(termId)
        || typeof termDueDays !== 'number' || !Number.isInteger(termDueDays)) return null;
    return {
        mapping: { salesItemId, salesAccountId, shareItemId, shareAccountId, taxItemId, taxAccountId, termId, termDueDays },
        txnDate: row.txn_date,
        payment: { card: row.allow_online_card, ach: row.allow_online_ach, paypal: false, affirm: false },
    };
}

// ── internals: the gate ─────────────────────────────────────────────────────

interface Context {
    /** The FreezerIQ invoice as loaded for this gate. */
    freezeriq: LoadedInvoice;
    live: LiveConnection;
    qboCustomerId: string;
    qboCustomerName: string;
    mapping: InvoiceMapping;
    payment: QuickBooksPaymentFlags;
    defaultCc: string | null;
    txnDate: string;
    body: QuickBooksInvoiceCreateBody;
    expected: ExpectedQuickBooksInvoice;
}

type Evaluation = { ok: true; ctx: Context } | { ok: false; blockers: SendBlocker[] };
const blocked = (blocker: SendBlocker): Evaluation => ({ ok: false, blockers: [blocker] });

/**
 * The gate. `reviewed` absent: a first send, from the tenant's current verified settings and today's tenant-local
 * date. `reviewed` present: resume or re-send, from the lifecycle's stored review, re-verified live.
 */
async function evaluate(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig },
    d: Resolved,
    opts: { expectStatus: 'DRAFT' | 'SENT'; reviewed?: { mapping: InvoiceMapping; txnDate: string; payment: QuickBooksPaymentFlags } },
): Promise<Evaluation> {
    const invoice = await loadInvoice(d, input.businessId, input.invoiceId);
    if (!invoice.campaign_id) return blocked('invoice_not_campaign');
    if (invoice.status !== opts.expectStatus) return blocked(opts.expectStatus === 'DRAFT' ? 'invoice_not_draft' : 'invoice_not_sent');

    const live = await liveConnection(input.businessId, input.config, liveDeps(d));
    if (isConnectionProblem(live)) return blocked(live.state === 'unavailable' ? 'quickbooks_unavailable' : live.state);

    const customerLink = await d.db.quickBooksCustomerLink.findUnique({
        where: { business_id_customer_id: { business_id: input.businessId, customer_id: invoice.customer_id } },
        select: { connection_id: true, qbo_customer_id: true },
    });
    if (!customerLink || customerLink.connection_id !== live.connectionId) return blocked('customer_not_linked');

    try {
        let mapping: InvoiceMapping;
        let payment: QuickBooksPaymentFlags;
        let defaultCc: string | null = null;
        let txnDate: string | null;
        if (opts.reviewed) {
            const checked = await verifyInvoiceMappingLive(
                { businessId: input.businessId, config: input.config, live, mapping: opts.reviewed.mapping, payment: opts.reviewed.payment }, settingsDeps(d));
            if (!checked.ok) return blocked(checked.problem);
            ({ mapping, payment, txnDate } = opts.reviewed);
        } else {
            const settings = await loadVerifiedInvoiceSettings({ businessId: input.businessId, config: input.config, live }, settingsDeps(d));
            if (!settings.ok) return blocked(settings.problem);
            ({ mapping, payment, defaultCc } = settings);
            txnDate = calendarDateInTimeZone(invoice.business?.timezone ?? '', new Date(d.now()));
            if (!txnDate) return blocked('timezone_invalid');
        }

        const customer = await withAccess(input.businessId, input.config, live, liveDeps(d),
            (a) => readCustomer(input.config, a.accessToken, a.realmId, customerLink.qbo_customer_id, d.fetchImpl));
        if (!customer || !customer.active || customer.subCustomer) return blocked('customer_link_invalid');

        const plan = planQuickBooksInvoice({
            invoice: {
                id: invoice.id, campaignId: invoice.campaign_id,
                totalAmount: invoice.total_amount, taxAmount: invoice.tax_amount, taxRatePercent: invoice.tax_rate_percent, taxStatus: invoice.tax_status,
                shareAmount: invoice.fundraiser_profit_amount, sharePercent: invoice.fundraiser_profit_percent,
                items: invoice.items.map((i) => ({ id: i.id, description: i.description, variantSize: i.variant_size, quantity: i.quantity, unitPrice: i.unit_price, total: i.total })),
            },
            mapping,
            qboCustomerId: customerLink.qbo_customer_id,
            txnDate,
        });
        if (!plan.ok) return blocked(plan.problem);

        return {
            ok: true,
            ctx: {
                freezeriq: invoice, live, qboCustomerId: customerLink.qbo_customer_id, qboCustomerName: customer.displayName,
                mapping, payment, defaultCc, txnDate, body: plan.body, expected: plan.expected,
            },
        };
    } catch (e) {
        if (e instanceof QuickBooksConnectionError) {
            const p = connectionProblem(e);
            return blocked(p.state === 'unavailable' ? 'quickbooks_unavailable' : p.state);
        }
        if (e instanceof IntuitError || e instanceof ConnectionChangedError) {
            console.warn(`[quickbooks] invoice send gate unavailable: ${e instanceof IntuitError ? intuitErrorDetail(e) : 'connection_changed'}`);
            return blocked('quickbooks_unavailable');
        }
        throw e;
    }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Binds a click to the exact QuickBooks invoice that would be created, its read-back expectation and the payment options. */
function reviewTokenFor(ctx: Context): string {
    return reviewTokenOf(ctx.live.connectionId, ctx.freezeriq.id, ctx.body, ctx.expected, ctx.payment);
}

function reviewTokenOf(
    connectionId: string, invoiceId: string, body: QuickBooksInvoiceCreateBody, expected: ExpectedQuickBooksInvoice, payment: QuickBooksPaymentFlags,
): string {
    return sha256(JSON.stringify([
        'freezeriq/quickbooks-invoice-send-review/v1', connectionId, invoiceId,
        body, expected, payment.card, payment.ach,
    ]));
}

const reviewHashFor = (reviewToken: string, to: string, cc: string | null) =>
    sha256(`freezeriq/quickbooks-invoice-send-hash/v1|${reviewToken}|${to}|${cc ?? ''}`);

/** A fresh Intuit requestid for each recipient/payment-option update (at most 46 characters for any realistic revision). */
const updateRequestId = (invoiceId: string, revision: number) =>
    `qbupd-${revision}-${sha256(`freezeriq/quickbooks-invoice-update/v1|${invoiceId}|${revision}`).slice(0, 32)}`;

function previewOf(ctx: Context): SendPreview {
    const e = ctx.expected;
    return {
        quickBooksCustomerName: ctx.qboCustomerName,
        txnDate: e.txnDate,
        dueDate: e.dueDate,
        lines: e.lines.map((l) => ({ role: l.role, description: l.description, quantity: l.qtyHundredths / 100, unitPrice: l.unitPriceCents / 100, amount: l.amountCents / 100 })),
        totals: { bundles: e.preTaxCents / 100, share: e.shareCents / 100, tax: e.taxCents / 100, total: e.totalCents / 100 },
        memo: e.memo,
    };
}

function viewOf(row: SendRow, now: number, invoiceStatus: string | null = null): InvoiceSendView {
    const iso = (x: Date | null) => (x ? x.toISOString() : null);
    const problem = row.problem as SendProblem | null;
    if (row.status === 'sent') {
        return {
            state: 'sent', busy: leaseActive(row, now), docNumber: row.qbo_doc_number, sentAt: iso(row.sent_at), autoSent: row.auto_sent,
            sendCount: row.send_count, recipientTo: row.recipient_to, recipientCc: row.recipient_cc,
            deliveryErrorType: row.delivery_error_type, deliveryCheckedAt: iso(row.delivery_checked_at), invoiceStatus, lastProblem: problem,
        };
    }
    if (row.status === 'needs_review') {
        return {
            state: 'needs_review', docNumber: row.qbo_doc_number, recipientTo: row.recipient_to, recipientCc: row.recipient_cc,
            problem, problemDetail: row.problem_detail, recheckable: recheckableRow(row),
        };
    }
    return {
        state: 'in_progress', step: row.status, busy: leaseActive(row, now), docNumber: row.qbo_doc_number,
        recipientTo: row.recipient_to, recipientCc: row.recipient_cc, problem, problemDetail: row.problem_detail,
    };
}

async function currentOutcome(d: Resolved, businessId: string, invoiceId: string): Promise<SendActionResult> {
    const row = await readRow(d, businessId, invoiceId);
    if (!row) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };
    const view = viewOf(row, d.now());
    return { outcome: row.status === 'sent' ? 'sent' : row.status === 'needs_review' ? 'needs_review' : 'in_progress', view };
}

// ── GET ─────────────────────────────────────────────────────────────────────

/** The lifecycle's state — or, before one reached QuickBooks, the gate's answer and exactly what would be sent. */
export async function getQuickBooksInvoiceSendView(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig }, deps: InvoiceSendDeps = {},
): Promise<InvoiceSendView> {
    const d = resolve(deps);
    const row = await readRow(d, input.businessId, input.invoiceId);
    if (row?.status === 'sent') {
        const invoice = await d.db.invoice.findFirst({ where: { id: input.invoiceId, business_id: input.businessId }, select: { status: true } });
        return viewOf(row, d.now(), invoice?.status ?? null);
    }
    if (row && (reachedQuickBooks(row) || leaseActive(row, d.now()))) return viewOf(row, d.now());

    const ev = await evaluate(input, d, { expectStatus: 'DRAFT' });
    if (!ev.ok) return { state: 'blocked', blockers: ev.blockers };
    // Owner rule: the campaign coordinator receives the invoice, the tenant can override, plus optional CCs.
    const coordinator = resolveCampaignCoordinator({ assignment: ev.ctx.freezeriq.campaign?.primary_coordinator ?? null, organization: ev.ctx.freezeriq.customer });
    const suggestedRecipient = normalizeRecipient(coordinator.email);
    return {
        state: 'ready',
        reviewToken: reviewTokenFor(ev.ctx),
        preview: previewOf(ev.ctx),
        suggestedRecipient,
        suggestedRecipientSource: suggestedRecipient ? coordinator.source : 'none',
        suggestedCc: ev.ctx.defaultCc,
        payment: { card: ev.ctx.payment.card, ach: ev.ctx.payment.ach },
    };
}

// ── start / resume ──────────────────────────────────────────────────────────

/**
 * POST Send via QuickBooks, from the review dialog. Starts the lifecycle after the gate, OR — when this invoice's
 * lifecycle already reached QuickBooks — continues it, but only for the very same recipients. Idempotent: a sent
 * invoice answers sent; a concurrent click answers in_progress.
 */
export async function startQuickBooksInvoiceSend(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig; userId: string | null; reviewToken: unknown; recipientTo: unknown; recipientCc: unknown },
    deps: InvoiceSendDeps = {},
): Promise<SendActionResult> {
    const d = resolve(deps);
    if (typeof input.reviewToken !== 'string' || !REVIEW_TOKEN.test(input.reviewToken)) return { outcome: 'invalid', reason: 'review_token' };
    const recipients = normalizeRecipients(input.recipientTo, input.recipientCc);
    if (!recipients.ok) return { outcome: 'invalid', reason: recipients.reason };

    const existing = await readRow(d, input.businessId, input.invoiceId);
    if (existing && reachedQuickBooks(existing)) {
        if (existing.status === 'sent' || existing.status === 'needs_review') return currentOutcome(d, input.businessId, input.invoiceId);
        if (existing.recipient_to !== recipients.to || existing.recipient_cc !== recipients.cc) return { outcome: 'stale', view: viewOf(existing, d.now()) };
        return resumeLifecycle(input, d, existing);
    }

    const ev = await evaluate(input, d, { expectStatus: 'DRAFT' });
    if (!ev.ok) return { outcome: 'blocked', blockers: ev.blockers };
    const ctx = ev.ctx;
    const token = reviewTokenFor(ctx);
    if (token !== input.reviewToken) return { outcome: 'stale', view: await getQuickBooksInvoiceSendView(input, deps) };

    // RESERVE the invoice's one link (QB-INVOICE-1B) under the live generation, for the company this token reaches.
    const reserved = await reserveQuickBooksInvoiceLink(
        { businessId: input.businessId, invoiceId: input.invoiceId, connectionId: ctx.live.connectionId, realmId: ctx.live.access.realmId, userId: input.userId },
        linkDeps(d),
    );
    if (reserved.outcome === 'invoice_not_found') throw new InvoiceNotFoundError();
    if (reserved.outcome === 'connection_not_current') return { outcome: 'blocked', blockers: ['quickbooks_unavailable'] };
    if (reserved.outcome === 'already_linked') return { outcome: 'blocked', blockers: ['linked_to_another_connection'] };

    const leaseId = d.newLeaseId();
    const now = d.now();
    const review = {
        review_hash: reviewHashFor(token, recipients.to, recipients.cc),
        recipient_to: recipients.to,
        recipient_cc: recipients.cc,
        allow_online_card: ctx.payment.card,
        allow_online_ach: ctx.payment.ach,
        txn_date: ctx.txnDate,
        mapping: { ...ctx.mapping },
        started_by: input.userId,
    };
    let row: SendRow | null;
    if (!existing) {
        try {
            row = await d.db.quickBooksInvoiceSend.create({
                data: {
                    business_id: input.businessId, invoice_id: input.invoiceId, status: 'reserved', ...review,
                    lease_id: leaseId, lease_until: new Date(now + LEASE_MS),
                },
            });
        } catch (e: any) {
            if (e?.code !== 'P2002') throw e;
            return currentOutcome(d, input.businessId, input.invoiceId); // a concurrent click won
        }
    } else {
        // Nothing reached QuickBooks yet, and no one holds the lease: this review replaces the old one.
        const claimed = await d.db.quickBooksInvoiceSend.updateMany({
            where: {
                business_id: input.businessId, invoice_id: input.invoiceId, status: 'reserved', create_requested_at: null,
                OR: [{ lease_id: null }, { lease_until: { lt: new Date(now) } }],
            },
            data: { ...review, lease_id: leaseId, lease_until: new Date(now + LEASE_MS) },
        });
        if (claimed.count !== 1) return currentOutcome(d, input.businessId, input.invoiceId);
        row = await readRow(d, input.businessId, input.invoiceId);
    }
    if (!row) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };

    return run({
        d, config: input.config, businessId: input.businessId, invoiceId: input.invoiceId, userId: input.userId, leaseId, row, ctx,
        link: { id: reserved.link.id, connectionId: reserved.link.connectionId, requestId: reserved.link.requestId, qboInvoiceId: reserved.link.qboInvoiceId },
    });
}

/** POST resume: continue an interrupted lifecycle from its last verified step, with exactly what was reviewed. */
export async function resumeQuickBooksInvoiceSend(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig; userId: string | null },
    deps: InvoiceSendDeps = {},
): Promise<SendActionResult> {
    const d = resolve(deps);
    const row = await readRow(d, input.businessId, input.invoiceId);
    if (!row) {
        await loadInvoice(d, input.businessId, input.invoiceId); // 404 for another tenant's invoice
        return { outcome: 'blocked', blockers: ['not_sent_via_quickbooks'] };
    }
    if (row.status === 'sent' || row.status === 'needs_review') return currentOutcome(d, input.businessId, input.invoiceId);
    // Nothing reached QuickBooks yet: a fresh review decides (today's date, current settings) — unless a request is creating it now.
    if (!reachedQuickBooks(row)) {
        return leaseActive(row, d.now()) ? currentOutcome(d, input.businessId, input.invoiceId) : { outcome: 'stale', view: await getQuickBooksInvoiceSendView(input, deps) };
    }
    return resumeLifecycle(input, d, row);
}

async function resumeLifecycle(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig; userId: string | null }, d: Resolved, row: SendRow,
): Promise<SendActionResult> {
    const reviewed = reviewedOf(row);
    if (!reviewed) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };
    const ev = await evaluate(input, d, { expectStatus: 'DRAFT', reviewed });
    if (!ev.ok) return { outcome: 'blocked', blockers: ev.blockers };
    if (reviewHashFor(reviewTokenFor(ev.ctx), row.recipient_to, row.recipient_cc) !== row.review_hash) {
        return { outcome: 'stale', view: viewOf(row, d.now()) };
    }
    const link = await getQuickBooksInvoiceLink(input, linkDeps(d));
    if (!link) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };
    if (link.connectionId !== ev.ctx.live.connectionId) return { outcome: 'blocked', blockers: ['linked_to_another_connection'] };

    const leaseId = d.newLeaseId();
    const now = d.now();
    const claimed = await d.db.quickBooksInvoiceSend.updateMany({
        where: { business_id: input.businessId, invoice_id: input.invoiceId, status: row.status, OR: [{ lease_id: null }, { lease_until: { lt: new Date(now) } }] },
        data: { lease_id: leaseId, lease_until: new Date(now + LEASE_MS) },
    });
    if (claimed.count !== 1) return currentOutcome(d, input.businessId, input.invoiceId);
    const fresh = await readRow(d, input.businessId, input.invoiceId);
    if (!fresh) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };

    return run({
        d, config: input.config, businessId: input.businessId, invoiceId: input.invoiceId, userId: input.userId, leaseId, row: fresh, ctx: ev.ctx,
        link: { id: link.id, connectionId: link.connectionId, requestId: link.requestId, qboInvoiceId: link.qboInvoiceId },
    });
}

// ── recheck: the ONE repair a stopped lifecycle allows ──────────────────────

/**
 * POST recheck — re-read the SAME QuickBooks invoice and re-run the CREATE-stage read-back contract.
 *
 * `needs_review` is terminal by design, with exactly one exception: a lifecycle whose create-stage read-back failed
 * on an invoice QuickBooks had ALREADY accepted. That state is recoverable without touching QuickBooks at all —
 * the contract itself may have been wrong about a company's own tax metadata (Automated Sales Tax stamps zero-value
 * tax detail onto every invoice), or a read may have caught the invoice before QuickBooks settled it. So this path
 * reads, verifies, and does one of exactly two things:
 *
 *   - it passes: the lifecycle returns to its post-create stage — the SAME row, the SAME QuickBooks invoice, the
 *     SAME reviewed recipients and payment options — and the owner's existing Resume action carries it on from
 *     there. Nothing is emailed here: a repair is not a send, and the send semantics are left exactly as they are.
 *   - it fails: the lifecycle stays stopped, now recording what failed this time.
 *
 * It can NEVER create a QuickBooks invoice: an existing `qboInvoiceId` is a precondition, the create step refuses a
 * repair session outright (`noCreate`), and no QuickBooks write of any kind is issued on this path.
 */
export async function recheckQuickBooksInvoiceCreate(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig; userId: string | null },
    deps: InvoiceSendDeps = {},
): Promise<SendActionResult> {
    const d = resolve(deps);
    const row = await readRow(d, input.businessId, input.invoiceId);
    if (!row) {
        await loadInvoice(d, input.businessId, input.invoiceId); // 404 for another tenant's invoice
        return { outcome: 'blocked', blockers: ['not_sent_via_quickbooks'] };
    }
    // (1) stopped, (2) by a create-stage verification failure, (5) after the create was dispatched, (7) never sent.
    if (!recheckableRow(row)) return { outcome: 'blocked', blockers: ['recheck_not_available'] };

    const reviewed = reviewedOf(row);
    if (!reviewed) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };
    // (6) the FreezerIQ invoice must still be the DRAFT that was reviewed — the gate a resume runs, unchanged.
    const ev = await evaluate(input, d, { expectStatus: 'DRAFT', reviewed });
    if (!ev.ok) return { outcome: 'blocked', blockers: ev.blockers };
    if (reviewHashFor(reviewTokenFor(ev.ctx), row.recipient_to, row.recipient_cc) !== row.review_hash) {
        return { outcome: 'stale', view: viewOf(row, d.now()) };
    }
    const link = await getQuickBooksInvoiceLink(input, linkDeps(d));
    if (!link) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] }; // (3) the durable link must exist
    if (link.connectionId !== ev.ctx.live.connectionId) return { outcome: 'blocked', blockers: ['linked_to_another_connection'] }; // (8)
    // (4) THE invariant of this path: it repairs an invoice QuickBooks already holds. No recorded id, no recheck.
    if (!link.qboInvoiceId) return { outcome: 'blocked', blockers: ['recheck_not_available'] };

    const leaseId = d.newLeaseId();
    const now = d.now();
    const claimed = await d.db.quickBooksInvoiceSend.updateMany({
        where: {
            business_id: input.businessId, invoice_id: input.invoiceId,
            status: 'needs_review', problem: 'verification_failed_created', send_count: 0,
            OR: [{ lease_id: null }, { lease_until: { lt: new Date(now) } }],
        },
        data: { lease_id: leaseId, lease_until: new Date(now + LEASE_MS) },
    });
    if (claimed.count !== 1) return currentOutcome(d, input.businessId, input.invoiceId);
    const fresh = await readRow(d, input.businessId, input.invoiceId);
    if (!fresh) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };

    return recheckCreated({
        d, config: input.config, businessId: input.businessId, invoiceId: input.invoiceId, userId: input.userId, leaseId, row: fresh, ctx: ev.ctx,
        link: { id: link.id, connectionId: link.connectionId, requestId: link.requestId, qboInvoiceId: link.qboInvoiceId },
        noCreate: true,
    });
}

/** The repair under the lease: ONE read of the invoice QuickBooks already holds, then the create-stage contract. */
async function recheckCreated(s: Session): Promise<SendActionResult> {
    return guarded(s, async () => {
        if (!s.link.qboInvoiceId) throw new CreateForbiddenError(); // proven by the caller; the last line of defence
        const inv = await read(s);
        if (!inv) return await park(s, 'qbo_invoice_missing', null, true);
        const v = verify(s, inv, 'created');
        if (!v.ok) return await park(s, 'verification_failed_created', failureDetail(v), true);
        // Back to the post-create stage, exactly as the create step leaves it. The owner resumes from here.
        await writeRow(s, {
            status: 'created', qbo_doc_number: inv.docNumber, qbo_sync_token: inv.syncToken,
            created_verified_at: new Date(s.d.now()), ...clearProblem,
        });
        await releaseLease(s);
        return await currentOutcome(s.d, s.businessId, s.invoiceId);
    });
}

// ── the session: one lease-holding run over a lifecycle ─────────────────────

interface Session {
    d: Resolved;
    config: QuickBooksConfig;
    businessId: string;
    invoiceId: string;
    userId: string | null;
    leaseId: string;
    row: SendRow;
    ctx: Context;
    link: { id: string; connectionId: string; requestId: string; qboInvoiceId: string | null };
    /**
     * A REPAIR session: it exists only to re-read an invoice QuickBooks already holds, so it may never create one.
     * The create step refuses outright when this is set — a structural guard, so no future wiring of the repair
     * into the step loop could ever reach a create.
     */
    noCreate?: boolean;
}

type StepResult = SendActionResult | 'next';

/** Lease-guarded write that also renews the lease. Throws LeaseLostError when another request took over. */
async function writeRow(s: Session, data: Record<string, unknown>): Promise<void> {
    const leaseUntil = new Date(s.d.now() + LEASE_MS);
    const res = await s.d.db.quickBooksInvoiceSend.updateMany({
        where: { business_id: s.businessId, invoice_id: s.invoiceId, lease_id: s.leaseId },
        data: { ...data, lease_until: leaseUntil } as any,
    });
    if (res.count !== 1) throw new LeaseLostError();
    s.row = { ...s.row, ...data, lease_until: leaseUntil } as SendRow;
}

/** Records a problem and releases the lease. `stop` parks the lifecycle in needs_review. */
async function park(s: Session, problem: SendProblem, detail: string | null, stop: boolean, extra: Record<string, unknown> = {}): Promise<SendActionResult> {
    const res = await s.d.db.quickBooksInvoiceSend.updateMany({
        where: { business_id: s.businessId, invoice_id: s.invoiceId, lease_id: s.leaseId },
        data: {
            ...extra,
            ...(stop ? { status: 'needs_review' } : {}),
            problem, problem_detail: detail ? detail.slice(0, 500) : null, problem_at: new Date(s.d.now()),
            lease_id: null, lease_until: null,
        } as any,
    });
    if (res.count !== 1) throw new LeaseLostError();
    // The same sanitized detail that was just persisted, so a support case can be traced from the logs too.
    console.warn(`[quickbooks] invoice send ${stop ? 'stopped for review' : 'paused'}: ${problem}${detail ? ` ${detail}` : ''}`);
    return currentOutcome(s.d, s.businessId, s.invoiceId);
}

async function releaseLease(s: Session): Promise<void> {
    await s.d.db.quickBooksInvoiceSend.updateMany({
        where: { business_id: s.businessId, invoice_id: s.invoiceId, lease_id: s.leaseId },
        data: { lease_id: null, lease_until: null },
    });
}

const call = <T>(s: Session, fn: (a: LiveConnection['access']) => Promise<T>): Promise<T> =>
    withAccess(s.businessId, s.config, s.ctx.live, liveDeps(s.d), fn);

const read = (s: Session) => call(s, (a) => readQuickBooksInvoice(s.config, a.accessToken, a.realmId, s.link.qboInvoiceId!, s.d.fetchImpl));

function verify(
    s: Session, inv: QuickBooksInvoiceSnapshot, stage: ContractStage,
    opts: { sendRequestedAt?: Date; recipients?: { to: string | null; cc: string | null } } = {},
): ContractResult {
    const recipients = opts.recipients ?? (stage === 'created' ? { to: null, cc: null } : { to: s.row.recipient_to, cc: s.row.recipient_cc });
    const payment = stage === 'created' || stage === 'recipients' ? PAYMENT_FLAGS_OFF : s.ctx.payment;
    return verifyQuickBooksInvoice(inv, s.ctx.expected, {
        billEmail: recipients.to,
        billEmailCc: recipients.cc,
        payment: { ...payment },
        qboInvoiceId: s.link.qboInvoiceId ?? undefined,
        docNumber: s.row.qbo_doc_number ?? undefined,
        sendRequestedAt: opts.sendRequestedAt,
    }, stage);
}

const failureDetail = (r: ContractResult) => r.failures.map((f) => f.check).join(',');
/**
 * What a failed Intuit call leaves behind on the lifecycle row. The shared sanitized formatter, so the durable
 * `problem_detail` carries the reason code, the HTTP status, Intuit's Fault codes AND `intuit_tid` — everything
 * Intuit support needs to trace one request, and nothing else (Intuit App Assessment, Error Handling Q3).
 */
const faultDetail = (e: unknown) => intuitErrorDetail(e);
const throttled = (e: unknown) => e instanceof IntuitError && e.status === 429;
/** Intuit validated and refused the write: nothing was written. */
const refused = (e: unknown) => e instanceof IntuitError && !throttled(e) && ['rejected', 'duplicate_name', 'not_found'].includes(e.kind);
/** The write may or may not have happened. */
const ambiguous = (e: unknown) => e instanceof IntuitError
    && (e.kind === 'network' || e.kind === 'malformed' || (e.kind === 'http' && (e.status === undefined || e.status >= 500)));
const transient = (e: unknown) => e instanceof IntuitError || e instanceof QuickBooksConnectionError;
const clearProblem = { problem: null, problem_detail: null, problem_at: null };

async function run(s: Session): Promise<SendActionResult> {
    return guarded(s, async () => {
        for (let guard = 0; guard < 8; guard++) {
            const status = s.row.status;
            const step: StepResult | null = status === 'reserved' ? await stepCreate(s)
                : status === 'created' ? await stepRecipients(s)
                    : status === 'recipients_set' ? await stepPaymentOptions(s)
                        : status === 'payment_options_set' ? await stepSend(s)
                            : null;
            if (step === null) {
                await releaseLease(s);
                return currentOutcome(s.d, s.businessId, s.invoiceId);
            }
            if (step !== 'next') return step;
        }
        return await park(s, 'unexpected_state', 'step_limit', true);
    });
}

/** The interruption policy every lease-holding body shares: a lost lease, a changed connection, a silent QuickBooks. */
async function guarded(s: Session, body: () => Promise<SendActionResult>): Promise<SendActionResult> {
    try {
        return await body();
    } catch (e) {
        try {
            if (e instanceof LeaseLostError) return await currentOutcome(s.d, s.businessId, s.invoiceId);
            if (e instanceof ConnectionChangedError) return await park(s, 'connection_changed', null, true);
            if (transient(e)) {
                return await park(s, 'quickbooks_unavailable', e instanceof IntuitError ? intuitErrorDetail(e) : (e as QuickBooksConnectionError).kind, false);
            }
        } catch (inner) {
            if (inner instanceof LeaseLostError) return currentOutcome(s.d, s.businessId, s.invoiceId);
            throw inner;
        }
        // Unforeseen: release the lease so the lifecycle is not stuck, then surface the error.
        await releaseLease(s).catch(() => undefined);
        throw e;
    }
}

// ── steps ───────────────────────────────────────────────────────────────────

async function stepCreate(s: Session): Promise<StepResult> {
    // A repair session may NEVER create an invoice. Unreachable today (repairs never enter the step loop) and kept
    // so it stays unreachable: this throws before the requestid, the body or any Intuit call is touched.
    if (s.noCreate) throw new CreateForbiddenError();
    if (!s.link.qboInvoiceId) {
        const firstAttempt = s.row.create_requested_at;
        if (firstAttempt && s.d.now() - firstAttempt.getTime() > CREATE_RETRY_WINDOW_MS) {
            return park(s, 'create_outcome_unknown', 'retry_window_passed', true);
        }
        // Persisted under the lease BEFORE the request: from here on this review can never be replaced.
        await writeRow(s, firstAttempt ? {} : { create_requested_at: new Date(s.d.now()) });

        let created: QuickBooksInvoiceSnapshot | null = null;
        for (let attempt = 1; !created; attempt++) {
            try {
                created = await call(s, (a) => createQuickBooksInvoice(s.config, a.accessToken, a.realmId, s.ctx.body, s.link.requestId, s.d.fetchImpl));
            } catch (e) {
                if (throttled(e)) return park(s, 'quickbooks_unavailable', 'throttled', false);
                if (refused(e)) return park(s, 'create_rejected', faultDetail(e), true);
                if (!ambiguous(e)) throw e;
                if (attempt >= 2) return park(s, 'create_outcome_unknown', faultDetail(e), false);
                // One immediate replay with the SAME requestid: Intuit answers with the invoice it already created, if any.
            }
        }
        // Persist the link immediately: ONLY the id from FreezerIQ's own create (or its requestid replay).
        const recorded = await recordQuickBooksInvoiceId(
            { businessId: s.businessId, linkId: s.link.id, connectionId: s.link.connectionId, qboInvoiceId: created.id, now: new Date(s.d.now()) },
            linkDeps(s.d),
        );
        if (recorded !== 'recorded' && recorded !== 'already_recorded') return park(s, 'create_record_conflict', recorded, true);
        s.link.qboInvoiceId = created.id;
    }

    const inv = await read(s);
    if (!inv) return park(s, 'qbo_invoice_missing', null, true);
    const v = verify(s, inv, 'created');
    if (!v.ok) return park(s, 'verification_failed_created', failureDetail(v), true);
    await writeRow(s, { status: 'created', qbo_doc_number: inv.docNumber, qbo_sync_token: inv.syncToken, created_verified_at: new Date(s.d.now()), ...clearProblem });
    return 'next';
}

/** A lease-guarded update of recipients and payment flags ONLY (all four flags always restated). null = applied. */
async function applyDelivery(s: Session, cur: QuickBooksInvoiceSnapshot, payment: QuickBooksPaymentFlags): Promise<SendActionResult | null> {
    const revision = s.row.revision + 1;
    await writeRow(s, { revision });
    try {
        await call(s, (a) => updateQuickBooksInvoiceDelivery(s.config, a.accessToken, a.realmId, {
            id: cur.id, syncToken: cur.syncToken,
            fields: { billEmail: s.row.recipient_to, billEmailCc: s.row.recipient_cc, payment: { ...payment } },
        }, updateRequestId(s.invoiceId, revision), s.d.fetchImpl));
        return null;
    } catch (e) {
        if (throttled(e)) return park(s, 'quickbooks_unavailable', 'throttled', false);
        if (e instanceof IntuitError && e.kind === 'stale_object') return park(s, 'stale_object', null, false);
        if (refused(e)) return park(s, 'update_rejected', faultDetail(e), true);
        if (ambiguous(e)) return park(s, 'update_outcome_unknown', faultDetail(e), false);
        throw e;
    }
}

async function stepRecipients(s: Session): Promise<StepResult> {
    const cur = await read(s);
    if (!cur) return park(s, 'qbo_invoice_missing', null, true);
    let after = cur;
    const already = verify(s, cur, 'recipients');
    if (!already.ok) {
        // Only an invoice still exactly as created may receive its recipients.
        if (!verify(s, cur, 'created').ok) return park(s, 'verification_failed_recipients', failureDetail(already), true);
        const parked = await applyDelivery(s, cur, PAYMENT_FLAGS_OFF);
        if (parked) return parked;
        const updated = await read(s);
        if (!updated) return park(s, 'qbo_invoice_missing', null, true);
        const v = verify(s, updated, 'recipients');
        if (!v.ok) return park(s, 'verification_failed_recipients', failureDetail(v), true);
        after = updated;
    }
    await writeRow(s, { status: 'recipients_set', qbo_sync_token: after.syncToken, recipients_verified_at: new Date(s.d.now()), ...clearProblem });
    return 'next';
}

async function stepPaymentOptions(s: Session): Promise<StepResult> {
    const cur = await read(s);
    if (!cur) return park(s, 'qbo_invoice_missing', null, true);
    const online = s.ctx.payment.card || s.ctx.payment.ach;
    if (cur.emailStatus === 'EmailSent') {
        // Only FreezerIQ's own payment-option update (applied, answer lost) explains a send at this point.
        if (!online) return park(s, 'unexpected_email_status', 'EmailSent', true);
        return acceptSent(s, cur, s.row.recipients_verified_at ?? s.row.created_verified_at ?? new Date(s.d.now()), true);
    }
    let after = cur;
    const already = verify(s, cur, 'payment_options');
    if (!already.ok) {
        // With no online options 'payment_options' and 'recipients' are the same check, so this is a real failure.
        if (!online || !verify(s, cur, 'recipients').ok) return park(s, 'verification_failed_payment_options', failureDetail(already), true);
        const requestedAt = new Date(s.d.now());
        const parked = await applyDelivery(s, cur, s.ctx.payment);
        if (parked) return parked;
        const updated = await read(s);
        if (!updated) return park(s, 'qbo_invoice_missing', null, true);
        // BRANCH B: QuickBooks emailed the invoice when its verified payment options were applied. Never Send again.
        if (updated.emailStatus === 'EmailSent') return acceptSent(s, updated, requestedAt, true);
        const v = verify(s, updated, 'payment_options');
        if (!v.ok) return park(s, 'verification_failed_payment_options', failureDetail(v), true);
        after = updated;
    }
    await writeRow(s, { status: 'payment_options_set', qbo_sync_token: after.syncToken, payment_options_verified_at: new Date(s.d.now()), ...clearProblem });
    return 'next';
}

async function stepSend(s: Session): Promise<StepResult> {
    const cur = await read(s);
    if (!cur) return park(s, 'qbo_invoice_missing', null, true);
    if (cur.emailStatus === 'EmailSent') {
        if (s.row.send_requested_at) return acceptSent(s, cur, s.row.send_requested_at, false); // our Send, answer lost
        if (s.ctx.payment.card || s.ctx.payment.ach) {
            return acceptSent(s, cur, s.row.payment_options_verified_at ?? s.row.recipients_verified_at ?? new Date(s.d.now()), true);
        }
        return park(s, 'unexpected_email_status', 'EmailSent', true);
    }
    const pre = verify(s, cur, 'payment_options');
    if (!pre.ok) return park(s, 'verification_failed_payment_options', failureDetail(pre), true);

    const requestedAt = new Date(s.d.now());
    await writeRow(s, { send_requested_at: requestedAt });
    let response: QuickBooksInvoiceSnapshot | null = null;
    try {
        response = await call(s, (a) => sendQuickBooksInvoice(s.config, a.accessToken, a.realmId, cur.id, s.d.fetchImpl));
    } catch (e) {
        // Refused or throttled: nothing was sent. The SAME invoice is sent on the next attempt.
        if (throttled(e)) return park(s, 'quickbooks_unavailable', 'throttled', false, { send_requested_at: null });
        if (refused(e)) return park(s, 'send_rejected', faultDetail(e), false, { send_requested_at: null });
        if (!ambiguous(e)) throw e;
    }
    const after = await read(s);
    if (!after) return park(s, 'qbo_invoice_missing', null, true);
    if (after.emailStatus !== 'EmailSent') {
        return response ? park(s, 'verification_failed_sent', 'email_status_sent', true) : park(s, 'send_outcome_unknown', null, false);
    }
    if (response) {
        const r = verify(s, response, 'sent', { sendRequestedAt: requestedAt });
        if (!r.ok) return park(s, 'verification_failed_sent', `response:${failureDetail(r)}`, true);
    }
    return acceptSent(s, after, requestedAt, false);
}

/** Verifies a read-back as SENT, then records it: lifecycle 'sent' and FreezerIQ invoice DRAFT→SENT, atomically. */
async function acceptSent(s: Session, inv: QuickBooksInvoiceSnapshot, requestedAt: Date, autoSent: boolean): Promise<SendActionResult> {
    const v = verify(s, inv, 'sent', { sendRequestedAt: requestedAt });
    if (!v.ok) return park(s, 'verification_failed_sent', failureDetail(v), true);
    const sentAt = new Date(Date.parse(inv.delivery!.time!));
    const now = new Date(s.d.now());
    const evidence = {
        sent_at: sentAt, send_count: s.row.send_count + 1, auto_sent: autoSent, qbo_sync_token: inv.syncToken,
        delivery_error_type: v.deliveryErrorType, delivery_checked_at: now,
    };
    try {
        await s.d.db.$transaction(async (tx) => {
            const lifecycle = await tx.quickBooksInvoiceSend.updateMany({
                where: { business_id: s.businessId, invoice_id: s.invoiceId, lease_id: s.leaseId },
                data: { ...evidence, status: 'sent', sent_by: s.userId, ...clearProblem, lease_id: null, lease_until: null },
            });
            if (lifecycle.count !== 1) throw new LeaseLostError();
            // The one FreezerIQ invoice write QuickBooks code makes: DRAFT → SENT, only from DRAFT, never PAID.
            const invoice = await tx.invoice.updateMany({
                where: { id: s.invoiceId, business_id: s.businessId, status: 'DRAFT' },
                data: { status: 'SENT' },
            });
            if (invoice.count !== 1) throw new InvoiceLeftDraftError();
        });
    } catch (e) {
        if (!(e instanceof InvoiceLeftDraftError)) throw e;
        // QuickBooks emailed it, but the FreezerIQ invoice left DRAFT in between: keep the evidence, stop for review.
        return park(s, 'invoice_status_changed', null, true, evidence);
    }
    console.info(`[quickbooks] invoice sent via QuickBooks${autoSent ? ' (QuickBooks sent it when the verified payment options were applied)' : ''}`);
    return currentOutcome(s.d, s.businessId, s.invoiceId);
}

// ── QB-INVOICE-1D: the invoice FreezerIQ sent, re-derived for the payment check ──

/** Why the payment check cannot even start from what was sent. Codes only. */
export type SentReviewBlocker =
    | 'invoice_not_sent' | 'invoice_not_campaign' | 'not_sent_via_quickbooks' | 'lifecycle_unreadable'
    | 'linked_to_another_connection' | 'customer_not_linked' | 'changed_since_review' | InvoicePlanProblem;

export type SentReview =
    | {
        ok: true;
        /** What the QuickBooks invoice must still say — the send's own read-back expectation. */
        expected: ExpectedQuickBooksInvoice;
        /** The QuickBooks invoice FreezerIQ's own create returned (the link, recorded once). */
        qboInvoiceId: string;
        /** QuickBooks' number for it, recorded when the create was verified. */
        docNumber: string | null;
    }
    | { ok: false; blocker: SentReviewBlocker };

/**
 * QB-INVOICE-1D: the QuickBooks invoice FreezerIQ SENT for this FreezerIQ invoice, re-derived from the lifecycle's
 * STORED review and the CURRENT FreezerIQ invoice with the same planner and the same review hash that the send, the
 * resume and the re-send use — so there is exactly one definition of "the invoice we sent", and a FreezerIQ invoice
 * whose money changed since it was sent can never be reconciled against it.
 *
 * It deliberately does NOT re-verify the tenant's QuickBooks settings or the customer's status: those decide
 * whether an invoice may be SENT, not whether a payment for an invoice already sent is real — a company CC added
 * later, or a customer made inactive after paying, must not block recognising the payment. Only the live
 * connection generation must match: the link, the lifecycle and the customer link all belong to it.
 *
 * Reads only. Writes nothing to FreezerIQ and calls nothing in QuickBooks.
 */
export async function loadSentReview(
    input: { businessId: string; invoiceId: string; connectionId: string }, deps: InvoiceSendDeps = {},
): Promise<SentReview> {
    const d = resolve(deps);
    const invoice = await loadInvoice(d, input.businessId, input.invoiceId); // InvoiceNotFoundError outside the tenant
    if (invoice.status !== 'SENT') return { ok: false, blocker: 'invoice_not_sent' };
    if (!invoice.campaign_id) return { ok: false, blocker: 'invoice_not_campaign' };

    const row = await readRow(d, input.businessId, input.invoiceId);
    if (!row || row.status !== 'sent') return { ok: false, blocker: 'not_sent_via_quickbooks' };
    const reviewed = reviewedOf(row);
    if (!reviewed) return { ok: false, blocker: 'lifecycle_unreadable' };

    const link = await getQuickBooksInvoiceLink(input, linkDeps(d));
    if (!link?.qboInvoiceId) return { ok: false, blocker: 'lifecycle_unreadable' };
    if (link.connectionId !== input.connectionId) return { ok: false, blocker: 'linked_to_another_connection' };

    const customerLink = await d.db.quickBooksCustomerLink.findUnique({
        where: { business_id_customer_id: { business_id: input.businessId, customer_id: invoice.customer_id } },
        select: { connection_id: true, qbo_customer_id: true },
    });
    if (!customerLink || customerLink.connection_id !== input.connectionId) return { ok: false, blocker: 'customer_not_linked' };

    const plan = planQuickBooksInvoice({
        invoice: {
            id: invoice.id, campaignId: invoice.campaign_id,
            totalAmount: invoice.total_amount, taxAmount: invoice.tax_amount, taxRatePercent: invoice.tax_rate_percent, taxStatus: invoice.tax_status,
            shareAmount: invoice.fundraiser_profit_amount, sharePercent: invoice.fundraiser_profit_percent,
            items: invoice.items.map((i) => ({ id: i.id, description: i.description, variantSize: i.variant_size, quantity: i.quantity, unitPrice: i.unit_price, total: i.total })),
        },
        mapping: reviewed.mapping,
        qboCustomerId: customerLink.qbo_customer_id,
        txnDate: reviewed.txnDate,
    });
    if (!plan.ok) return { ok: false, blocker: plan.problem };

    const token = reviewTokenOf(input.connectionId, invoice.id, plan.body, plan.expected, reviewed.payment);
    if (reviewHashFor(token, row.recipient_to, row.recipient_cc) !== row.review_hash) return { ok: false, blocker: 'changed_since_review' };

    return { ok: true, expected: plan.expected, qboInvoiceId: link.qboInvoiceId, docNumber: row.qbo_doc_number };
}

// ── delivery follow-up ──────────────────────────────────────────────────────

export type DeliveryCheckResult =
    | { outcome: 'checked'; view: InvoiceSendView }
    | { outcome: 'not_sent'; view: InvoiceSendView | null }
    | { outcome: 'unavailable'; view: InvoiceSendView };

/**
 * Reads the QuickBooks invoice's delivery state and records it on the lifecycle. Read-only against QuickBooks;
 * never writes the FreezerIQ invoice, its status (PAID included) or any money.
 */
export async function checkQuickBooksInvoiceDelivery(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig }, deps: InvoiceSendDeps = {},
): Promise<DeliveryCheckResult> {
    const d = resolve(deps);
    const row = await readRow(d, input.businessId, input.invoiceId);
    if (!row) {
        await loadInvoice(d, input.businessId, input.invoiceId); // 404 for another tenant's invoice
        return { outcome: 'not_sent', view: null };
    }
    if (row.status !== 'sent') return { outcome: 'not_sent', view: viewOf(row, d.now()) };
    const invoiceStatus = async () => (await d.db.invoice.findFirst({ where: { id: input.invoiceId, business_id: input.businessId }, select: { status: true } }))?.status ?? null;
    const unavailable = async (): Promise<DeliveryCheckResult> => ({ outcome: 'unavailable', view: viewOf(row, d.now(), await invoiceStatus()) });

    const link = await getQuickBooksInvoiceLink(input, linkDeps(d));
    if (!link?.qboInvoiceId) return unavailable();
    const live = await liveConnection(input.businessId, input.config, liveDeps(d));
    if (isConnectionProblem(live) || live.connectionId !== link.connectionId) return unavailable();
    let inv: QuickBooksInvoiceSnapshot | null;
    try {
        inv = await withAccess(input.businessId, input.config, live, liveDeps(d),
            (a) => readQuickBooksInvoice(input.config, a.accessToken, a.realmId, link.qboInvoiceId!, d.fetchImpl));
    } catch (e) {
        if (e instanceof IntuitError || e instanceof QuickBooksConnectionError || e instanceof ConnectionChangedError) return unavailable();
        throw e;
    }
    if (!inv) return unavailable();
    // Delivery fields only, and never while a re-send holds the lease.
    await d.db.quickBooksInvoiceSend.updateMany({
        where: { business_id: input.businessId, invoice_id: input.invoiceId, status: 'sent', lease_id: null },
        data: { delivery_error_type: inv.delivery?.errorType ?? null, delivery_checked_at: new Date(d.now()) },
    });
    const fresh = (await readRow(d, input.businessId, input.invoiceId)) ?? row;
    return { outcome: 'checked', view: viewOf(fresh, d.now(), await invoiceStatus()) };
}

// ── re-send to corrected recipients: the SAME QuickBooks invoice ─────────────

/**
 * After a delivery problem: correct the recipients and have QuickBooks email the SAME invoice again. Only a
 * FreezerIQ invoice that is still SENT (so never a PAID one) whose QuickBooks invoice still carries exactly what
 * was sent. The recipient update restates every payment flag; the send is verified. The FreezerIQ invoice is not
 * written. V1 cannot remove a CC that QuickBooks already holds (a sparse update keeps it).
 */
export async function resendQuickBooksInvoice(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig; userId: string | null; recipientTo: unknown; recipientCc: unknown },
    deps: InvoiceSendDeps = {},
): Promise<SendActionResult> {
    const d = resolve(deps);
    const recipients = normalizeRecipients(input.recipientTo, input.recipientCc);
    if (!recipients.ok) return { outcome: 'invalid', reason: recipients.reason };
    const row = await readRow(d, input.businessId, input.invoiceId);
    if (!row || row.status !== 'sent') {
        if (!row) await loadInvoice(d, input.businessId, input.invoiceId); // 404 for another tenant's invoice
        return { outcome: 'blocked', blockers: ['not_sent_via_quickbooks'] };
    }
    const reviewed = reviewedOf(row);
    if (!reviewed) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };
    const ev = await evaluate(input, d, { expectStatus: 'SENT', reviewed });
    if (!ev.ok) return { outcome: 'blocked', blockers: ev.blockers };
    const token = reviewTokenFor(ev.ctx);
    if (reviewHashFor(token, row.recipient_to, row.recipient_cc) !== row.review_hash) return { outcome: 'blocked', blockers: ['changed_since_review'] };
    const link = await getQuickBooksInvoiceLink(input, linkDeps(d));
    if (!link?.qboInvoiceId) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };
    if (link.connectionId !== ev.ctx.live.connectionId) return { outcome: 'blocked', blockers: ['linked_to_another_connection'] };

    const leaseId = d.newLeaseId();
    const now = d.now();
    const claimed = await d.db.quickBooksInvoiceSend.updateMany({
        where: { business_id: input.businessId, invoice_id: input.invoiceId, status: 'sent', OR: [{ lease_id: null }, { lease_until: { lt: new Date(now) } }] },
        data: { lease_id: leaseId, lease_until: new Date(now + LEASE_MS) },
    });
    if (claimed.count !== 1) return currentOutcome(d, input.businessId, input.invoiceId);
    const fresh = await readRow(d, input.businessId, input.invoiceId);
    if (!fresh) return { outcome: 'blocked', blockers: ['lifecycle_unreadable'] };
    const s: Session = {
        d, config: input.config, businessId: input.businessId, invoiceId: input.invoiceId, userId: input.userId, leaseId, row: fresh, ctx: ev.ctx,
        link: { id: link.id, connectionId: link.connectionId, requestId: link.requestId, qboInvoiceId: link.qboInvoiceId },
    };
    const target = { to: recipients.to, cc: recipients.cc };
    /** Releases the lease, recording why the re-send did not complete. The lifecycle stays 'sent'. */
    const refuse = async (problem: SendProblem, detail: string | null, answer: SendActionResult): Promise<SendActionResult> => {
        await s.d.db.quickBooksInvoiceSend.updateMany({
            where: { business_id: s.businessId, invoice_id: s.invoiceId, lease_id: s.leaseId },
            data: { problem, problem_detail: detail ? detail.slice(0, 500) : null, problem_at: new Date(s.d.now()), lease_id: null, lease_until: null },
        });
        console.warn(`[quickbooks] invoice re-send not completed: ${problem}${detail ? ` ${detail}` : ''}`);
        return answer;
    };

    try {
        const cur = await read(s);
        if (!cur) return refuse('qbo_invoice_missing', null, { outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        // Still exactly the invoice that was sent — to whoever it is currently addressed. Checked at
        // 'resend_recipients' because an interrupted re-send leaves the invoice updated and so, by QuickBooks'
        // own doing, without a DeliveryTime; every financial, identity and recipient check still applies.
        const before = verify(s, cur, 'resend_recipients', { recipients: { to: cur.billEmail, cc: cur.billEmailCc } });
        if (!before.ok || cur.billEmail === null) return refuse('qbo_invoice_changed', failureDetail(before), { outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        if (cur.billEmailCc !== null && target.cc === null) {
            await releaseLease(s);
            return { outcome: 'invalid', reason: 'cc' };
        }
        if (cur.billEmail !== target.to || cur.billEmailCc !== target.cc) {
            const revision = s.row.revision + 1;
            await writeRow(s, { revision });
            try {
                await call(s, (a) => updateQuickBooksInvoiceDelivery(s.config, a.accessToken, a.realmId, {
                    id: cur.id, syncToken: cur.syncToken, fields: { billEmail: target.to, billEmailCc: target.cc, payment: { ...s.ctx.payment } },
                }, updateRequestId(s.invoiceId, revision), s.d.fetchImpl));
            } catch (e) {
                if (refused(e)) return refuse('update_rejected', faultDetail(e), { outcome: 'blocked', blockers: ['update_rejected'] });
                if (!ambiguous(e) && !throttled(e) && !(e instanceof IntuitError && e.kind === 'stale_object')) throw e;
                return refuse('update_outcome_unknown', faultDetail(e), { outcome: 'blocked', blockers: ['quickbooks_unavailable'] });
            }
            const updated = await read(s);
            const v = updated ? verify(s, updated, 'resend_recipients', { recipients: target }) : null;
            if (!updated || !v || !v.ok) {
                return refuse('qbo_invoice_changed', v ? failureDetail(v) : 'qbo_invoice_missing', { outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
            }
        }

        const requestedAt = new Date(s.d.now());
        await writeRow(s, {}); // renew the lease immediately before QuickBooks sends
        let response: QuickBooksInvoiceSnapshot | null = null;
        try {
            response = await call(s, (a) => sendQuickBooksInvoice(s.config, a.accessToken, a.realmId, cur.id, s.d.fetchImpl));
        } catch (e) {
            if (refused(e) || throttled(e)) return refuse('send_rejected', faultDetail(e), { outcome: 'blocked', blockers: ['quickbooks_unavailable'] });
            if (!ambiguous(e)) throw e;
        }
        const after = await read(s);
        const sent = after ? verify(s, after, 'sent', { sendRequestedAt: requestedAt, recipients: target }) : null;
        if (!after || !sent || !sent.ok) {
            return response
                ? refuse('verification_failed_sent', sent ? failureDetail(sent) : 'qbo_invoice_missing', { outcome: 'blocked', blockers: ['qbo_invoice_changed'] })
                : refuse('send_outcome_unknown', null, { outcome: 'blocked', blockers: ['quickbooks_unavailable'] });
        }
        if (response) {
            const r = verify(s, response, 'sent', { sendRequestedAt: requestedAt, recipients: target });
            if (!r.ok) return refuse('verification_failed_sent', `response:${failureDetail(r)}`, { outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        }
        const done = await s.d.db.quickBooksInvoiceSend.updateMany({
            where: { business_id: s.businessId, invoice_id: s.invoiceId, lease_id: s.leaseId },
            data: {
                recipient_to: target.to, recipient_cc: target.cc, review_hash: reviewHashFor(token, target.to, target.cc),
                sent_at: new Date(Date.parse(after.delivery!.time!)), send_count: s.row.send_count + 1, sent_by: s.userId,
                qbo_sync_token: after.syncToken, delivery_error_type: sent.deliveryErrorType, delivery_checked_at: new Date(s.d.now()),
                ...clearProblem, lease_id: null, lease_until: null,
            },
        });
        if (done.count !== 1) throw new LeaseLostError();
        console.info('[quickbooks] invoice re-sent via QuickBooks to corrected recipients');
        return currentOutcome(d, input.businessId, input.invoiceId);
    } catch (e) {
        if (e instanceof LeaseLostError) return currentOutcome(d, input.businessId, input.invoiceId);
        await releaseLease(s).catch(() => undefined);
        if (transient(e) || e instanceof ConnectionChangedError) {
            console.warn(`[quickbooks] invoice re-send unavailable: ${e instanceof IntuitError ? intuitErrorDetail(e) : 'connection'}`);
            return { outcome: 'blocked', blockers: ['quickbooks_unavailable'] };
        }
        throw e;
    }
}
