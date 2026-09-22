/**
 * QB-INVOICE-1C — what the tenant reads and which buttons exist, from the pure view modules behind the settings card
 * and the "Send via QuickBooks" dialog.
 */

import { blockerText, INVALID_TEXT, invoiceRowAction, PROBLEM_TEXT, QUICKBOOKS_INITIAL_SEND_STATUS, RECHECK_ACTION_LABEL, RECHECK_TEXT, RECIPIENT_SOURCE_TEXT, RESEND_INTERRUPTED_TEXT, RESEND_INTERRUPTION_DETAIL, SENT_MEANING, sendDialogView, STEP_TEXT } from '@/lib/quickbooks/invoiceSendView';
import { helperItemPrompt, ROLE_LABELS, SETTINGS_BLOCKER_TEXT, SETTINGS_NOTICE_TEXT, SETTINGS_PROBLEM_TEXT, settingsCardSummary } from '@/lib/quickbooks/invoiceSettingsView';

const ALL_BLOCKERS = [
    'not_connected', 'reconnect_required', 'quickbooks_unavailable', 'invoice_not_campaign', 'invoice_not_draft', 'invoice_not_sent', 'not_sent_via_quickbooks',
    'customer_not_linked', 'customer_link_invalid', 'timezone_invalid', 'linked_to_another_connection', 'changed_since_review', 'qbo_invoice_changed', 'update_rejected',
    'lifecycle_unreadable', 'recheck_not_available', 'settings_missing', 'not_campaign_invoice', 'no_lines', 'too_many_lines', 'total_not_positive', 'money_invalid', 'line_does_not_reconcile',
    'invoice_does_not_reconcile', 'tax_status_conflict', 'share_item_not_configured', 'tax_item_not_configured', 'description_invalid', 'date_invalid',
    ...Object.keys(SETTINGS_BLOCKER_TEXT), ...Object.keys(SETTINGS_PROBLEM_TEXT),
] as const;

const everyText = () => [
    ...ALL_BLOCKERS.map((b) => blockerText(b as any)), ...Object.values(PROBLEM_TEXT), ...Object.values(STEP_TEXT), SENT_MEANING,
    ...Object.values(RECIPIENT_SOURCE_TEXT), ...Object.values(INVALID_TEXT), RECHECK_TEXT, RECHECK_ACTION_LABEL,
    ...Object.values(SETTINGS_BLOCKER_TEXT), ...Object.values(SETTINGS_NOTICE_TEXT), ...Object.values(SETTINGS_PROBLEM_TEXT),
    ...Object.values(ROLE_LABELS).flatMap((r) => [r.title, r.help]),
];

describe('QB-INVOICE-1C · wording', () => {
    it('every blocker has its own sentence (no generic fallback), and no text abbreviates QuickBooks or claims payment', () => {
        const fallback = 'This invoice cannot be sent through QuickBooks right now.';
        for (const b of ALL_BLOCKERS) expect({ b, text: blockerText(b as any) === fallback }).toEqual({ b, text: false });
        for (const t of everyText()) {
            expect(t).not.toMatch(/\bQBO?\b|Intuit|Pay Now/);
            // The one sentence that mentions payment says what SENT does NOT mean.
            if (t !== SENT_MEANING) expect(t).not.toMatch(/\b(is|was|been|marked) paid\b/i);
        }
    });

    it('SENT is explained as QuickBooks reporting the email — not delivery, not payment', () => {
        expect(SENT_MEANING).toMatch(/QuickBooks reports it emailed the invoice/);
        expect(SENT_MEANING).toMatch(/does not mean the email was delivered/);
        expect(SENT_MEANING).toMatch(/does not mean the invoice was paid/);
    });

    it('the helper item prompt names the item, the account, and that nothing else is created', () => {
        expect(helperItemPrompt('share', 'Organization Fundraiser Share', 'Discounts given')).toBe(
            'Create a non-taxable Service item named “Organization Fundraiser Share” in your QuickBooks company, posting to “Discounts given”, and use it as the organization share item? FreezerIQ creates nothing else and changes no account.',
        );
    });
});

describe('QB-INVOICE-1C · which actions the dialog offers', () => {
    const sent = { state: 'sent', busy: false, docNumber: '1052', sentAt: '2026-09-15T19:00:30.000Z', autoSent: false, sendCount: 1, recipientTo: 'a@example.invalid', recipientCc: null, deliveryErrorType: null, deliveryCheckedAt: null, invoiceStatus: 'SENT', lastProblem: null } as const;

    it('ready → Send only; blocked → nothing; paused → Resume unless another request is running; stopped → nothing', () => {
        const pick = (v: ReturnType<typeof sendDialogView>) => ({ send: v.canSend, resume: v.canResume, check: v.canCheckDelivery, resend: v.canResend });
        expect(pick(sendDialogView({ state: 'ready', reviewToken: 'x', preview: {} as any, suggestedRecipient: null, suggestedCc: null, payment: { card: false, ach: false } }))).toEqual({ send: true, resume: false, check: false, resend: false });
        expect(pick(sendDialogView({ state: 'blocked', blockers: ['settings_missing'] }))).toEqual({ send: false, resume: false, check: false, resend: false });
        expect(pick(sendDialogView({ state: 'in_progress', step: 'created', busy: false, docNumber: '1052', recipientTo: 'a@example.invalid', recipientCc: null, problem: 'stale_object', problemDetail: null }))).toEqual({ send: false, resume: true, check: false, resend: false });
        expect(pick(sendDialogView({ state: 'in_progress', step: 'created', busy: true, docNumber: null, recipientTo: 'a@example.invalid', recipientCc: null, problem: null, problemDetail: null }))).toEqual({ send: false, resume: false, check: false, resend: false });
        expect(pick(sendDialogView({ state: 'needs_review', docNumber: '1052', recipientTo: 'a@example.invalid', recipientCc: null, problem: 'verification_failed_created', problemDetail: 'total_equals_freezeriq_total', recheckable: false }))).toEqual({ send: false, resume: false, check: false, resend: false });
        expect(pick(sendDialogView({ state: 'disabled' }))).toEqual({ send: false, resume: false, check: false, resend: false });
    });

    it('sent → check delivery and send again (only while the FreezerIQ invoice is still SENT — never once PAID)', () => {
        expect(sendDialogView(sent)).toMatchObject({ title: 'Sent via QuickBooks — invoice 1052', tone: 'ok', canCheckDelivery: true, canResend: true });
        expect(sendDialogView({ ...sent, invoiceStatus: 'PAID' })).toMatchObject({ canCheckDelivery: true, canResend: false });
        const undeliverable = sendDialogView({ ...sent, deliveryErrorType: 'Undeliverable' });
        expect(undeliverable.tone).toBe('warn');
        expect(undeliverable.messages.join(' ')).toMatch(/delivery problem \(Undeliverable\)\. Correct the recipient and send the same invoice again/);
        expect(sendDialogView({ ...sent, autoSent: true }).messages[0]).toMatch(/when its verified online payment options were applied/);
    });

    it('an interrupted re-send says plainly that nothing was emailed again — a real mismatch still gets the mismatch warning', () => {
        // Known to be the re-send's own interruption: FreezerIQ never reached the send.
        for (const problem of ['update_rejected', 'update_outcome_unknown'] as const) {
            const text = sendDialogView({ ...sent, lastProblem: problem }).messages.join(' ');
            expect(text).toContain(RESEND_INTERRUPTED_TEXT);
            expect(text).toContain(RESEND_INTERRUPTION_DETAIL[problem]!);
            expect(text).not.toMatch(/no longer matches what FreezerIQ sent/);
        }
        // An authoritative mismatch — the QuickBooks invoice itself changed — keeps its existing warning.
        const mismatch = sendDialogView({ ...sent, lastProblem: 'qbo_invoice_changed' }).messages.join(' ');
        expect(mismatch).toMatch(/The last attempt to send it again did not complete: The QuickBooks invoice no longer matches what FreezerIQ sent\./);
        expect(mismatch).not.toContain(RESEND_INTERRUPTED_TEXT);
        // So does anything the send itself reached, where "nothing was emailed again" would not be provable.
        for (const problem of ['send_rejected', 'send_outcome_unknown', 'verification_failed_sent', 'qbo_invoice_missing'] as const) {
            const text = sendDialogView({ ...sent, lastProblem: problem }).messages.join(' ');
            expect(text).toContain(PROBLEM_TEXT[problem]);
            expect(text).not.toContain(RESEND_INTERRUPTED_TEXT);
        }
        expect(sendDialogView(sent).messages.join(' ')).not.toContain('did not complete');
    });

    /**
     * The ONE repair the dialog offers, and only for a send the create-stage read-back stopped. Every other stopped
     * send stays terminal — there is no general "force resume" button anywhere in this view.
     */
    it('a create-stage stop offers Recheck QuickBooks invoice; every other stopped send offers nothing', () => {
        const stopped = (over: Record<string, unknown>) => sendDialogView({
            state: 'needs_review', docNumber: '1052', recipientTo: 'a@example.invalid', recipientCc: null,
            problem: 'verification_failed_created', problemDetail: 'quickbooks_tax_did_not_affect_total', recheckable: false, ...over,
        } as any);
        const offered = stopped({ recheckable: true });
        expect(offered).toMatchObject({ canRecheck: true, canSend: false, canResume: false, canCheckDelivery: false, canResend: false, canCheckPayment: false });
        expect(offered.messages.join(' ')).toContain(RECHECK_TEXT);
        expect(RECHECK_ACTION_LABEL).toBe('Recheck QuickBooks invoice');
        // It promises exactly what the code does: the same invoice, no new invoice, no send, and Resume finishes it.
        expect(RECHECK_TEXT).toMatch(/re-reads the SAME QuickBooks invoice/);
        expect(RECHECK_TEXT).toMatch(/No new invoice is created and nothing is emailed by the recheck/);
        expect(RECHECK_TEXT).toMatch(/you finish it with Resume/);
        expect(RECHECK_TEXT).toMatch(/If it still does not match, it stays stopped/);
        for (const over of [{}, { problem: 'verification_failed_recipients' }, { problem: 'create_rejected' }, { problem: 'qbo_invoice_missing' }, { problem: null }]) {
            const other = stopped(over);
            expect(other.canRecheck).toBe(false);
            expect(other.messages.join(' ')).not.toContain(RECHECK_TEXT);
        }
    });

    it('a stopped send says nothing more is sent, the invoice is not marked Sent, and no second QuickBooks invoice is created', () => {
        expect(sendDialogView({ state: 'needs_review', docNumber: null, recipientTo: 'a@example.invalid', recipientCc: null, problem: null, problemDetail: null, recheckable: false }).messages.join(' '))
            .toMatch(/Nothing further is sent, the FreezerIQ invoice is not marked Sent, and no second QuickBooks invoice will be created/);
    });
});

describe('QB-INVOICE-1C · the invoice row action says what it will do', () => {
    it('nothing started → review and send; part-way → resume; stopped for review → review; sent → the QuickBooks number; delivery problem → that first', () => {
        expect(invoiceRowAction(null, 'DRAFT')).toEqual({ label: 'Review & send', tone: 'neutral' });
        expect(invoiceRowAction(undefined, 'DRAFT')).toEqual({ label: 'Review & send', tone: 'neutral' });
        for (const status of ['reserved', 'created', 'recipients_set', 'payment_options_set']) {
            expect(invoiceRowAction({ status, qbo_doc_number: status === 'reserved' ? null : '1052', delivery_error_type: null }, 'DRAFT'))
                .toEqual({ label: 'Resume QuickBooks send', tone: 'warn' });
        }
        // A lifecycle stopped for review offers no resume in the dialog, so the row must not promise one.
        expect(invoiceRowAction({ status: 'needs_review', qbo_doc_number: '1052', delivery_error_type: null }, 'DRAFT'))
            .toEqual({ label: 'Review QuickBooks send', tone: 'warn' });
        expect(invoiceRowAction({ status: 'needs_review', qbo_doc_number: null, delivery_error_type: 'Undeliverable' }, 'DRAFT'))
            .toEqual({ label: 'Review QuickBooks send', tone: 'warn' });
        expect(invoiceRowAction({ status: 'sent', qbo_doc_number: '1052', delivery_error_type: null }, 'SENT'))
            .toEqual({ label: 'View QuickBooks invoice #1052', tone: 'ok' });
        expect(invoiceRowAction({ status: 'sent', qbo_doc_number: '1052', delivery_error_type: 'Undeliverable' }, 'SENT'))
            .toEqual({ label: 'Review delivery issue', tone: 'warn' });
        // A delivery problem outranks the number, and a sent invoice without one still reads sensibly.
        expect(invoiceRowAction({ status: 'sent', qbo_doc_number: null, delivery_error_type: null }, 'SENT'))
            .toEqual({ label: 'View QuickBooks invoice', tone: 'ok' });
        expect(invoiceRowAction({ status: 'sent', qbo_doc_number: '1052' }, 'SENT')!.label).toBe('View QuickBooks invoice #1052');
        // Every label is visible text, never an abbreviation.
        for (const send of [null, { status: 'created', qbo_doc_number: '1052', delivery_error_type: null }, { status: 'sent', qbo_doc_number: '1052', delivery_error_type: 'Undeliverable' }]) {
            const action = invoiceRowAction(send, 'DRAFT')!;
            expect(action.label.trim().length).toBeGreaterThan(0);
            expect(action.label).not.toMatch(/\bQB\b|\bQBO\b/);
        }
    });

    it('a FIRST send is offered from a draft and from nothing else — a paid invoice gets no QuickBooks action', () => {
        // The gate allows a first send only from DRAFT (`invoice_not_draft`), so the row offers it only there.
        expect(QUICKBOOKS_INITIAL_SEND_STATUS).toBe('DRAFT');
        expect(invoiceRowAction(null, 'DRAFT')).toEqual({ label: 'Review & send', tone: 'neutral' });
        for (const status of ['PAID', 'PENDING', 'OVERDUE', 'CANCELED', 'SENT', 'draft', '', null, undefined]) {
            expect({ status, action: invoiceRowAction(null, status) }).toEqual({ status, action: null });
            expect({ status, action: invoiceRowAction(undefined, status) }).toEqual({ status, action: null });
        }
        // An invoice QuickBooks already holds keeps its action whatever the FreezerIQ status became - including
        // PAID, where "view the QuickBooks invoice" is still true, and a delivery problem still needs attention.
        expect(invoiceRowAction({ status: 'sent', qbo_doc_number: '1052', delivery_error_type: null }, 'PAID'))
            .toEqual({ label: 'View QuickBooks invoice #1052', tone: 'ok' });
        expect(invoiceRowAction({ status: 'sent', qbo_doc_number: '1052', delivery_error_type: 'Undeliverable' }, 'PAID'))
            .toEqual({ label: 'Review delivery issue', tone: 'warn' });
        expect(invoiceRowAction({ status: 'needs_review', qbo_doc_number: '1052', delivery_error_type: null }, 'PAID'))
            .toEqual({ label: 'Review QuickBooks send', tone: 'warn' });
        expect(invoiceRowAction({ status: 'created', qbo_doc_number: '1052', delivery_error_type: null }, 'CANCELED'))
            .toEqual({ label: 'Resume QuickBooks send', tone: 'warn' });
    });
});

describe('QB-INVOICE-1C · settings card summary', () => {
    it('hidden when disabled; states map to plain labels', () => {
        expect(settingsCardSummary({ state: 'disabled' }).visible).toBe(false);
        expect(settingsCardSummary(null)).toMatchObject({ visible: true, label: 'Checking QuickBooks invoice settings…' });
        expect(settingsCardSummary({ state: 'not_connected' })).toMatchObject({ label: 'Connect QuickBooks to set up invoices', showRecheck: false });
        const ready: any = { state: 'ready', companyName: 'Sandbox Company 1', blockers: [], notices: [], onlinePaymentsEnabled: true, options: {}, saved: null, ready: false, helperItems: {} };
        expect(settingsCardSummary(ready)).toMatchObject({ tone: 'warn', label: 'Not set up yet' });
        expect(settingsCardSummary({ ...ready, blockers: ['company_default_cc'] })).toMatchObject({ tone: 'bad' });
        expect(settingsCardSummary({ ...ready, saved: { problems: ['term_changed'] } })).toMatchObject({ tone: 'warn', label: 'Needs attention' });
        expect(settingsCardSummary({ ...ready, saved: { problems: [] }, ready: true })).toMatchObject({ tone: 'ok', label: 'Ready to send invoices through QuickBooks' });
    });
});
