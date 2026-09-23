/**
 * QB-INVOICE-1C — wording and view logic for the "Send via QuickBooks" dialog. Pure and client-safe (types only
 * from the server module), so every sentence a tenant reads — and every button the dialog offers — is tested.
 *
 * The dialog says plainly what each state means: a QuickBooks invoice is created unsent and checked before
 * QuickBooks emails it; SENT means QuickBooks reports it emailed the invoice, not that it was delivered or paid;
 * a stopped send keeps the same QuickBooks invoice and never creates another.
 */

import type { InvoiceSendStep, InvoiceSendView, SendBlocker, SendProblem } from '@/lib/quickbooks/invoiceSend';
import type { PaymentCheckResult, PaymentReviewReason } from '@/lib/quickbooks/invoicePayment';
import { SETTINGS_BLOCKER_TEXT, SETTINGS_PROBLEM_TEXT } from '@/lib/quickbooks/invoiceSettingsView';
import { settlementMethodLabel } from '@/lib/invoiceSettlement';

export type InvoiceSendPayload = InvoiceSendView | { state: 'disabled' } | { state: 'error' };

const OWN_BLOCKER_TEXT: Record<Exclude<SendBlocker, keyof typeof SETTINGS_BLOCKER_TEXT | keyof typeof SETTINGS_PROBLEM_TEXT>, string> = {
    not_connected: 'QuickBooks is not connected. Connect it in Settings → Integrations.',
    reconnect_required: 'QuickBooks needs to be reconnected in Settings → Integrations.',
    quickbooks_unavailable: 'QuickBooks could not be reached. Nothing was sent — try again in a moment.',
    invoice_not_campaign: 'Only fundraiser invoices created at closeout can be sent through QuickBooks.',
    invoice_not_draft: 'Only a draft invoice can be sent through QuickBooks.',
    invoice_not_sent: 'Only an invoice that is still marked Sent can be sent again. A paid invoice is never re-sent.',
    not_sent_via_quickbooks: 'This invoice has not been sent through QuickBooks.',
    customer_not_linked: 'Link this organization to its QuickBooks customer first (open the organization and use its QuickBooks card).',
    customer_link_invalid: 'The organization’s QuickBooks customer is inactive, missing or a sub-customer. Check the organization’s QuickBooks card.',
    timezone_invalid: 'Your business time zone is not set, so the invoice date cannot be determined.',
    linked_to_another_connection: 'This invoice belongs to an earlier QuickBooks connection. It needs an administrator’s review.',
    changed_since_review: 'The invoice changed after it was sent through QuickBooks. FreezerIQ will not send it again.',
    qbo_invoice_changed: 'The QuickBooks invoice no longer matches what FreezerIQ sent — for example it was edited or paid in QuickBooks. FreezerIQ will not send it again.',
    update_rejected: 'QuickBooks refused the new recipient. Check the address and try again.',
    lifecycle_unreadable: 'This invoice’s QuickBooks record could not be read. It needs an administrator’s review.',
    recheck_not_available: 'This stopped send cannot be rechecked. Only a send that stopped because the new QuickBooks invoice did not match FreezerIQ can be re-read.',
    cancel_not_available: 'This invoice cannot be canceled. Only an invoice QuickBooks has emailed and nobody has paid can be canceled here.',
    invoice_paid: 'This invoice is already recorded as paid, so it is not canceled. Correct the payment first.',
    paid_in_quickbooks: 'QuickBooks shows a payment or a credit applied to this invoice, so FreezerIQ did not void it. Nothing was changed — check the invoice in QuickBooks.',
    cancel_conflict: 'The QuickBooks invoice was voided, but this invoice changed at the same moment, so FreezerIQ did not cancel it. It needs an administrator’s review: the QuickBooks invoice is now worth nothing.',
    settings_missing: 'Set up the QuickBooks invoice settings first (Settings → Integrations).',
    not_campaign_invoice: 'Only fundraiser invoices created at closeout can be sent through QuickBooks.',
    no_lines: 'This invoice has no lines to send.',
    too_many_lines: 'This invoice has more lines than FreezerIQ sends to QuickBooks.',
    total_not_positive: 'This invoice’s total is not above zero, so it cannot be sent.',
    money_invalid: 'One of this invoice’s amounts could not be read exactly, so nothing was sent.',
    line_does_not_reconcile: 'A line’s quantity times price does not equal its total to the cent, so nothing was sent.',
    invoice_does_not_reconcile: 'The lines, organization share and tax do not add up to the invoice total to the cent, so nothing was sent.',
    tax_status_conflict: 'The organization is tax exempt but the invoice carries tax, so nothing was sent.',
    share_item_not_configured: 'This invoice has an organization share. Choose the organization share item in the QuickBooks invoice settings first.',
    tax_item_not_configured: 'This invoice carries supporter sales tax. Choose the supporter sales tax item in the QuickBooks invoice settings first.',
    description_invalid: 'A line description is empty or too long for QuickBooks.',
    date_invalid: 'The invoice date or due date could not be determined.',
};

export function blockerText(blocker: SendBlocker): string {
    return (OWN_BLOCKER_TEXT as Record<string, string>)[blocker]
        ?? (SETTINGS_BLOCKER_TEXT as Record<string, string>)[blocker]
        ?? (SETTINGS_PROBLEM_TEXT as Record<string, string>)[blocker]
        ?? 'This invoice cannot be sent through QuickBooks right now.';
}

export const PROBLEM_TEXT: Record<SendProblem, string> = {
    quickbooks_unavailable: 'QuickBooks could not be reached. Resume to continue from the last verified step.',
    connection_changed: 'The QuickBooks connection changed during the send. It needs an administrator’s review.',
    stale_object: 'The QuickBooks invoice was changed at the same moment. Resume to read it again and continue.',
    create_rejected: 'QuickBooks refused to create the invoice. Nothing was created. It needs an administrator’s review.',
    create_outcome_unknown: 'QuickBooks did not confirm whether it created the invoice. Resume to ask again with the same request — it can never create a second invoice.',
    create_record_conflict: 'QuickBooks answered with an invoice FreezerIQ cannot record. It needs an administrator’s review.',
    update_rejected: 'QuickBooks refused the recipient or payment options. Nothing was sent. It needs an administrator’s review.',
    update_outcome_unknown: 'QuickBooks did not confirm an update. Resume to read the invoice again and continue.',
    send_rejected: 'QuickBooks refused to email the invoice. Nothing was sent. Resume to try again with the same invoice.',
    send_outcome_unknown: 'QuickBooks did not confirm the email. Resume to read the invoice again — it is never sent twice by FreezerIQ without checking.',
    qbo_invoice_missing: 'The QuickBooks invoice can no longer be found. It needs an administrator’s review.',
    qbo_invoice_changed: 'The QuickBooks invoice no longer matches what FreezerIQ sent.',
    invoice_status_changed: 'QuickBooks emailed the invoice, but the FreezerIQ invoice was no longer a draft. It needs an administrator’s review.',
    unexpected_email_status: 'QuickBooks reports the invoice was emailed at a step where FreezerIQ did not send it. Nothing more was sent. It needs an administrator’s review.',
    unexpected_state: 'The send stopped in an unexpected state. It needs an administrator’s review.',
    verification_failed_created: 'The new QuickBooks invoice did not match FreezerIQ exactly, so nothing was sent. The same QuickBooks invoice is kept for review.',
    verification_failed_recipients: 'The QuickBooks invoice’s recipients did not match what you reviewed, so nothing was sent. It needs an administrator’s review.',
    verification_failed_payment_options: 'The QuickBooks invoice did not match after its payment options were set, so nothing was sent. It needs an administrator’s review.',
    void_rejected: 'QuickBooks refused to void the invoice, so nothing was canceled. The invoice is unchanged in both places.',
    void_outcome_unknown: 'QuickBooks did not confirm the void, so nothing was canceled in FreezerIQ. Try Cancel invoice again — it reads QuickBooks first and never voids twice.',
    cancel_conflict: 'The QuickBooks invoice was voided, but this invoice changed at the same moment. FreezerIQ changed nothing else; check both.',
    verification_failed_voided: 'QuickBooks did not read back as a voided invoice, so the FreezerIQ invoice was left as it was. It needs an administrator’s review.',
    verification_failed_sent: 'QuickBooks’ record of the email did not match what FreezerIQ expected. It needs an administrator’s review.',
};

export const STEP_TEXT: Record<InvoiceSendStep, string> = {
    reserved: 'Creating the QuickBooks invoice',
    created: 'QuickBooks invoice created and verified; adding recipients',
    recipients_set: 'Recipients verified; setting payment options',
    payment_options_set: 'Verified; asking QuickBooks to email the invoice',
};

/**
 * The ONE repair the dialog offers, and only for a send stopped by the create-stage read-back. It promises exactly
 * what the code does: one read of the SAME QuickBooks invoice, never a second invoice, and never a send — a match
 * hands the invoice back to the normal send workflow, which the owner still finishes with Resume.
 */
export const RECHECK_TEXT = 'Recheck QuickBooks invoice re-reads the SAME QuickBooks invoice — the one already created — and checks it against FreezerIQ again. No new invoice is created and nothing is emailed by the recheck. If it matches, the send continues where it stopped and you finish it with Resume. If it still does not match, it stays stopped.';
export const RECHECK_ACTION_LABEL = 'Recheck QuickBooks invoice';

/**
 * QB-INVOICE-CANCEL-1 — the one way to stop collecting on an invoice QuickBooks already emailed. It promises
 * exactly what the code does: the SAME QuickBooks invoice is voided (kept, worth nothing, never deleted and never
 * replaced), the FreezerIQ invoice becomes Canceled, nothing is marked paid, and no held food is released.
 */
export const CANCEL_ACTION_LABEL = 'Cancel invoice';
export const CANCEL_STATUSES_TEXT = 'Only an invoice QuickBooks has emailed and nobody has paid can be canceled.';
export const cancelExplainer = (docNumber: string | null) =>
    `FreezerIQ will void QuickBooks invoice ${docNumber ? `#${docNumber}` : 'this invoice'} and mark this invoice Canceled. `
    + 'The same QuickBooks invoice is kept for your records — voided, worth nothing and no longer payable. '
    + 'No replacement invoice is created, no payment is recorded, and the fundraiser’s food stays on hold. '
    + 'Voiding a QuickBooks invoice cannot be undone.';
export const cancelConfirmPrompt = (docNumber: string | null) =>
    `Type ${docNumber ? `${docNumber}` : 'the QuickBooks invoice number'} to confirm.`;
const canceledText = (docNumber: string | null) =>
    `This invoice is canceled. QuickBooks invoice ${docNumber ? `#${docNumber}` : ''} was voided: it is kept for your records, is worth nothing and can no longer be paid. `
    + 'No payment was recorded, and the fundraiser’s food is still on hold.';
/** The FreezerIQ invoice statuses the dialog may offer "Cancel invoice" for (the service re-proves them). */
const CANCELABLE_STATUSES = ['SENT', 'PENDING', 'OVERDUE'];

/**
 * QB-INVOICE-CANCEL-1 — the unresolved cancellation. FreezerIQ committed to voiding the QuickBooks invoice and
 * recorded that decision before touching QuickBooks, but the outcome was never confirmed here — the connection
 * dropped, or this very process stopped. The invoice must NOT look like an ordinary collectible invoice: until
 * it is reconciled, QuickBooks' copy may already be worth nothing, so every payment action is withheld.
 */
export const CANCEL_PENDING_TITLE = 'Cancellation pending';
export const CANCEL_PENDING_TEXT = 'FreezerIQ started canceling this QuickBooks invoice but did not finish confirming the result. '
    + 'Payment actions are temporarily blocked. Choose Resume cancellation to safely check the same QuickBooks invoice and finish the cancellation.';
export const RESUME_CANCEL_ACTION_LABEL = 'Resume cancellation';
export const RESUME_CANCEL_TEXT = 'Resume cancellation reads the SAME QuickBooks invoice — the one already started — and finishes from wherever it stopped. '
    + 'If QuickBooks already voided it, nothing is voided a second time. No new invoice is created, no payment is recorded, and the fundraiser’s food stays on hold.';

/**
 * Is this sent lifecycle's cancellation still unresolved? Canceled is settled (the invoice says so). Anything
 * else with a recorded decision to void — the intent, or a void that did not verify — is pending, including a
 * payload whose invoice status was not loaded: not knowing is a reason to withhold payment actions, not to
 * offer them. A payload carrying neither field (an older one) is never read as pending.
 */
export function cancellationPending(payload: {
    invoiceStatus?: string | null; canceledAt?: string | null; cancelPendingAt?: string | null;
}): boolean {
    if (payload.invoiceStatus === 'CANCELED') return false;
    const requested = payload.cancelPendingAt ?? null;
    const voided = payload.canceledAt ?? null;
    // A completed cancellation whose invoice status simply was not loaded keeps reading as canceled, as before.
    if (requested === null) return false;
    return voided === null || (payload.invoiceStatus ?? null) !== null;
}

export const SENT_MEANING = 'Sent means QuickBooks reports it emailed the invoice. It does not mean the email was delivered, and it does not mean the invoice was paid.';
export const SEND_EXPLAINER = 'FreezerIQ creates this invoice in QuickBooks unsent, checks every line and total against FreezerIQ, adds the recipients, and only then asks QuickBooks to email it. If anything does not match, nothing is sent and the same QuickBooks invoice is kept for review.';

export const INVALID_TEXT: Record<string, string> = {
    recipient: 'Enter one valid email address for the recipient.',
    cc: 'Enter valid CC addresses separated by commas (up to five, 100 characters in all, not the recipient), or leave it empty. A CC already on the QuickBooks invoice cannot be removed.',
    review_token: 'Review the invoice again before sending.',
};

export const RECIPIENT_SOURCE_TEXT: Record<'assigned' | 'organization' | 'none', string> = {
    assigned: 'Suggested: the campaign’s assigned coordinator.',
    organization: 'Suggested: the organization’s contact on file (no usable coordinator email is assigned to this campaign).',
    none: 'No coordinator or organization email is on file. Enter who should receive this invoice.',
};

/**
 * The re-send is the ONLY thing that records a problem on an invoice that is already sent (every other step parks
 * the lifecycle instead), and these two problems are known to be the re-send's own interruption: QuickBooks refused
 * the corrected recipient, or did not confirm it. FreezerIQ never reached the send in either case, and a recipient
 * update carries no money — so the plain reassurance below is provable. Every other problem keeps its own wording,
 * including `qbo_invoice_changed`, which means the QuickBooks invoice itself no longer matches what was sent.
 */
export const RESEND_INTERRUPTED_TEXT = 'The re-send did not complete. Nothing was emailed again. Your QuickBooks invoice is unchanged financially.';
export const RESEND_INTERRUPTION_DETAIL: Partial<Record<SendProblem, string>> = {
    update_rejected: 'QuickBooks refused the corrected recipient, so the re-send stopped before sending.',
    update_outcome_unknown: 'QuickBooks did not confirm the corrected recipient, so the re-send stopped before sending.',
};

/** What the invoice row's QuickBooks action says, from the facts the invoice list carries. */
export interface InvoiceRowSendState {
    status: string;
    qbo_doc_number: string | null;
    delivery_error_type?: string | null;
    /** QB-INVOICE-CANCEL-1: FreezerIQ's durable decision to void the QuickBooks invoice, and the recorded void. */
    void_requested_at?: Date | string | null;
    voided_at?: Date | string | null;
}

const stamp = (x: Date | string | null | undefined) => (x == null ? null : typeof x === 'string' ? x : x.toISOString());

/**
 * QB-INVOICE-CANCEL-1 — may this invoice still be settled? An invoice whose cancellation is unresolved may
 * already be worth nothing in QuickBooks, so the list must not offer Record Payment for it. The settlement
 * transition refuses it anyway; this only stops FreezerIQ offering an action it will refuse.
 */
export function settlementBlockedByCancellation(send: InvoiceRowSendState | null | undefined): boolean {
    if (!send) return false;
    return stamp(send.void_requested_at) !== null || stamp(send.voided_at) !== null;
}

export interface InvoiceRowAction {
    label: string;
    tone: 'neutral' | 'ok' | 'warn';
}

/**
 * The ONE FreezerIQ invoice status a first send can start from. The gate refuses every other one with
 * `invoice_not_draft` before it reaches QuickBooks (lib/quickbooks/invoiceSend.ts), so a row must not offer
 * a first send from a paid, cancelled or otherwise issued invoice either. An invoice QuickBooks already
 * holds keeps its own action whatever the FreezerIQ status later becomes — including PAID, where "view the
 * QuickBooks invoice" is still true and useful.
 */
export const QUICKBOOKS_INITIAL_SEND_STATUS = 'DRAFT';

/**
 * One visible, state-aware action per invoice row, instead of an icon that meant five different things:
 * nothing started yet and still a draft → review and send; a lifecycle that stopped part-way → resume the
 * SAME invoice; one stopped FOR REVIEW → review it, because that state deliberately offers no resume; sent →
 * view QuickBooks' own number; sent but QuickBooks reported a delivery problem → deal with that first.
 * `null` means the row offers no QuickBooks action at all.
 */
export function invoiceRowAction(send: InvoiceRowSendState | null | undefined, invoiceStatus: string | null | undefined): InvoiceRowAction | null {
    if (!send) return invoiceStatus === QUICKBOOKS_INITIAL_SEND_STATUS ? { label: 'Review & send', tone: 'neutral' } : null;
    if (send.status === 'needs_review') return { label: 'Review QuickBooks send', tone: 'warn' };
    if (send.status !== 'sent') return { label: 'Resume QuickBooks send', tone: 'warn' };
    // QB-INVOICE-CANCEL-1: an unresolved cancellation is what this row is about — not its delivery, not its number.
    if (cancellationPending({ invoiceStatus, canceledAt: stamp(send.voided_at), cancelPendingAt: stamp(send.void_requested_at) })) {
        return { label: 'Finish canceling QuickBooks invoice', tone: 'warn' };
    }
    if (send.delivery_error_type) return { label: 'Review delivery issue', tone: 'warn' };
    return { label: send.qbo_doc_number ? `View QuickBooks invoice #${send.qbo_doc_number}` : 'View QuickBooks invoice', tone: 'ok' };
}

export interface SendDialogView {
    title: string;
    tone: 'neutral' | 'ok' | 'warn' | 'bad';
    messages: string[];
    canSend: boolean;
    canResume: boolean;
    canCheckDelivery: boolean;
    canResend: boolean;
    /** QB-INVOICE-1D: an invoice QuickBooks emailed and FreezerIQ still shows as Sent (never Paid). */
    canCheckPayment: boolean;
    /** A send stopped by the create-stage read-back: the SAME QuickBooks invoice may be re-read and re-checked. */
    canRecheck: boolean;
    /** QB-INVOICE-CANCEL-1: an emailed, unpaid invoice may be canceled — voiding the SAME QuickBooks invoice. */
    canCancel: boolean;
    /** QB-INVOICE-CANCEL-1: a cancellation FreezerIQ began but never confirmed may be finished, idempotently. */
    canResumeCancel: boolean;
}

const base: SendDialogView = {
    title: '', tone: 'neutral', messages: [], canSend: false, canResume: false, canCheckDelivery: false, canResend: false, canCheckPayment: false, canRecheck: false, canCancel: false, canResumeCancel: false,
};

// ── QB-INVOICE-1D: "Check QuickBooks payment" ──────────────────────────────

/** Said beside the button: what the check does, and what it can never know. Explicit, not monitoring. */
export const PAYMENT_CHECK_EXPLAINER =
    'FreezerIQ checks QuickBooks only when you ask. It marks this invoice paid only when QuickBooks shows one payment for the full amount applied to this invoice; '
    + 'anything else — a partial payment, several payments, a credit or an adjustment — is shown to you and nothing is recorded. '
    + 'A bank (ACH) payment can still be returned by the bank after QuickBooks records it, and FreezerIQ never reverses a payment automatically.';

export const PAYMENT_REVIEW_TEXT: Record<PaymentReviewReason, string> = {
    changed_since_review: 'This invoice changed in FreezerIQ after it was sent through QuickBooks, so FreezerIQ will not match a payment to it.',
    invoice_status_changed: 'The invoice changed while its payment was being checked. Nothing was recorded — check again.',
    qbo_invoice_missing: 'The QuickBooks invoice can no longer be found, so no payment was recorded.',
    qbo_invoice_changed: 'The QuickBooks invoice no longer matches what FreezerIQ sent (for example, it was edited in QuickBooks), so no payment was recorded.',
    balance_inconsistent: 'QuickBooks shows a balance FreezerIQ cannot reconcile with this invoice, so no payment was recorded.',
    payment_evidence_unreadable: 'QuickBooks shows nothing owed, but the payment details could not be read, so no payment was recorded.',
    no_payment_evidence: 'QuickBooks shows nothing owed, but no payment is linked to this invoice (for example, it was written off or adjusted). No payment was recorded — if the money arrived, record it by hand.',
    unsupported_linked_transaction: 'QuickBooks shows this invoice settled by something other than a payment. No payment was recorded.',
    multiple_payments: 'QuickBooks shows this invoice paid by more than one payment. FreezerIQ records only a single full payment automatically — confirm the payments in QuickBooks, then record the payment by hand.',
    payment_missing: 'The payment QuickBooks links to this invoice can no longer be found (it may have been deleted). No payment was recorded.',
    payment_not_for_this_invoice: 'The QuickBooks payment linked here is not applied to this invoice. No payment was recorded.',
    payment_customer_mismatch: 'The QuickBooks payment linked here belongs to a different customer. No payment was recorded.',
    payment_currency_mismatch: 'The QuickBooks payment linked here is not in US dollars. No payment was recorded.',
    payment_includes_other_transactions: 'The QuickBooks payment linked here also applies a credit, an adjustment or another invoice, or it was voided. FreezerIQ records only a single cash payment for exactly this invoice automatically. No payment was recorded.',
    payment_unapplied_amount: 'The QuickBooks payment linked here was larger than this invoice (part of it is unapplied). No payment was recorded.',
    payment_amount_mismatch: 'The QuickBooks payment linked here does not equal this invoice’s total. No payment was recorded.',
    payment_date_invalid: 'The QuickBooks payment linked here has a date FreezerIQ cannot accept (missing, too old, or in the future). No payment was recorded.',
};

export interface PaymentCheckMessage { tone: 'ok' | 'neutral' | 'warn' | 'bad'; text: string }

/** One sentence for each answer the payment check can give. Pure. */
export function paymentCheckMessage(result: PaymentCheckResult | { outcome?: undefined; error?: string } | null): PaymentCheckMessage {
    const money = (n: number) => `$${n.toFixed(2)}`;
    switch (result?.outcome) {
        case 'paid':
            return { tone: 'ok', text: `QuickBooks shows one payment for the full amount on this invoice. FreezerIQ marked it paid via QuickBooks Payments${result.settlement.paidOn ? ` on ${result.settlement.paidOn}` : ''}.` };
        case 'already_paid': {
            const label = settlementMethodLabel(result.settlement.method);
            return { tone: 'ok', text: `This invoice is already recorded as paid${label ? ` (${label}${result.settlement.paidOn ? `, ${result.settlement.paidOn}` : ''})` : ''}. Nothing was changed.` };
        }
        case 'not_paid':
            return { tone: 'neutral', text: 'QuickBooks shows no payment on this invoice yet. Nothing was changed.' };
        case 'partially_paid':
            return { tone: 'warn', text: `QuickBooks shows part of this invoice paid (${money(result.balanceDue)} still due). FreezerIQ records only a full payment automatically, so nothing was changed.` };
        case 'needs_review':
            return { tone: 'warn', text: PAYMENT_REVIEW_TEXT[result.reason] ?? 'QuickBooks shows something FreezerIQ will not treat as a payment on its own. Nothing was recorded.' };
        case 'blocked':
            return { tone: 'warn', text: result.blocker === 'invoice_not_sent' ? 'Only an invoice that is still marked Sent can be checked for a QuickBooks payment.' : blockerText(result.blocker) };
        case 'unavailable':
            return { tone: 'bad', text: 'QuickBooks could not be reached. Nothing was changed — try again in a moment.' };
        default:
            return { tone: 'bad', text: (result as any)?.error ?? 'Could not check QuickBooks for a payment.' };
    }
}

export function sendDialogView(payload: InvoiceSendPayload | null): SendDialogView {
    if (payload === null) return { ...base, title: 'Checking QuickBooks…' };
    switch (payload.state) {
        case 'disabled': return { ...base, title: 'QuickBooks is not available', messages: ['QuickBooks is not available in this environment.'] };
        case 'error': return { ...base, title: 'Could not load', tone: 'bad', messages: ['FreezerIQ could not load this invoice’s QuickBooks state. Try again.'] };
        case 'blocked': return { ...base, title: 'Cannot send through QuickBooks yet', tone: 'warn', messages: payload.blockers.map(blockerText) };
        case 'ready': return { ...base, title: 'Review and send via QuickBooks', messages: [SEND_EXPLAINER, SENT_MEANING], canSend: true };
        case 'in_progress':
            return {
                ...base,
                title: payload.busy ? 'Sending through QuickBooks…' : 'Send through QuickBooks paused',
                tone: payload.problem ? 'warn' : 'neutral',
                messages: [STEP_TEXT[payload.step], ...(payload.problem ? [PROBLEM_TEXT[payload.problem]] : [])],
                canResume: !payload.busy,
            };
        case 'needs_review':
            return {
                ...base,
                title: 'Stopped — needs review',
                tone: 'bad',
                messages: [payload.problem ? PROBLEM_TEXT[payload.problem] : PROBLEM_TEXT.unexpected_state,
                    'Nothing further is sent, the FreezerIQ invoice is not marked Sent, and no second QuickBooks invoice will be created.',
                    ...(payload.recheckable ? [RECHECK_TEXT] : [])],
                canRecheck: payload.recheckable,
            };
        case 'sent': {
            const messages = [
                payload.autoSent
                    ? 'QuickBooks emailed this invoice when its verified online payment options were applied. FreezerIQ recorded that as the send and did not send it again.'
                    : 'QuickBooks emailed this invoice.',
                SENT_MEANING,
            ];
            if (payload.deliveryErrorType) messages.push(`QuickBooks reports a delivery problem (${payload.deliveryErrorType}). Correct the recipient and send the same invoice again.`);
            if (payload.lastProblem) {
                const interrupted = RESEND_INTERRUPTION_DETAIL[payload.lastProblem];
                messages.push(interrupted
                    ? `${RESEND_INTERRUPTED_TEXT} ${interrupted}`
                    : `The last attempt to send it again did not complete: ${PROBLEM_TEXT[payload.lastProblem]}`);
            }
            if (payload.invoiceStatus === 'PAID') messages.push('FreezerIQ records this invoice as paid.');
            // QB-INVOICE-CANCEL-1: an unresolved cancellation comes FIRST. QuickBooks' copy may already be void,
            // so this invoice is not collectible: no Record Payment, no QuickBooks payment check, no Send again,
            // and no second Cancel — only the one idempotent action that finishes what was started.
            if (cancellationPending(payload)) {
                return {
                    ...base,
                    title: CANCEL_PENDING_TITLE,
                    tone: 'warn',
                    messages: [CANCEL_PENDING_TEXT, RESUME_CANCEL_TEXT,
                        ...(payload.lastProblem ? [PROBLEM_TEXT[payload.lastProblem]] : [])],
                    canResumeCancel: !payload.busy,
                };
            }
            // A canceled invoice keeps its history and offers nothing further. A payload that carries no
            // cancellation at all (an older one, or a missing field) is NEVER read as canceled.
            if ((payload.canceledAt ?? null) !== null || payload.invoiceStatus === 'CANCELED') {
                return {
                    ...base,
                    title: payload.docNumber ? `Canceled — QuickBooks invoice ${payload.docNumber} voided` : 'Canceled — QuickBooks invoice voided',
                    tone: 'neutral',
                    messages: [...messages, canceledText(payload.docNumber)],
                };
            }
            return {
                ...base,
                title: payload.docNumber ? `Sent via QuickBooks — invoice ${payload.docNumber}` : 'Sent via QuickBooks',
                tone: payload.deliveryErrorType ? 'warn' : 'ok',
                messages,
                canCheckDelivery: !payload.busy,
                canResend: !payload.busy && payload.invoiceStatus === 'SENT',
                canCheckPayment: !payload.busy && payload.invoiceStatus === 'SENT',
                canCancel: !payload.busy && payload.docNumber !== null && CANCELABLE_STATUSES.includes(payload.invoiceStatus ?? ''),
            };
        }
        default: return { ...base, title: 'Could not load', tone: 'bad' };
    }
}
