/**
 * QB-INVOICE-1D — scope guards. 1D is "Check QuickBooks payment": an explicit admin read of ONE invoice and at most
 * ONE payment, and — only on proof of one exact full payment — the existing settlement transition. These source-level
 * checks keep it from quietly becoming more: no QuickBooks write, no payment search, no Payments scope, no webhook, no
 * polling, no second PAID writer, no second kitchen release, no automatic un-pay, and nothing sent to an AI service.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { QUICKBOOKS_SCOPE } from '@/lib/quickbooks/config';

const ROOT = process.cwd();
const R = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(join(ROOT, dir))) return out;
    for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    }
    return out;
}
const SOURCE = ['app', 'lib', 'components'].flatMap((d) => walk(d));
const PAYMENT = 'lib/quickbooks/invoicePayment.ts';
const TRANSITION = 'lib/invoiceSettlementTransition.ts';
const SETTLE_ROUTE = 'app/api/tenant/invoices/[id]/settle/route.ts';
const INVOICE_ROUTE = 'app/api/integrations/quickbooks/invoices/[invoiceId]/route.ts';

describe('QB-INVOICE-1D · read-only against QuickBooks', () => {
    const code = strip(R(PAYMENT));

    it('the payment check imports and calls only the two payment-evidence READS from the Intuit client', () => {
        const imported = /import \{([^}]*)\} from '@\/lib\/quickbooks\/intuitClient';/.exec(code)![1].split(',').map((s) => s.trim().replace(/^type /, '')).filter(Boolean).sort();
        expect(imported).toEqual(['IntuitError', 'PAYMENT_FLAGS_OFF', 'QuickBooksLinkedTxnRef', 'QuickBooksPaymentSnapshot', 'intuitErrorDetail', 'readQuickBooksInvoicePaymentLinks', 'readQuickBooksPayment'].sort());
        for (const write of ['createQuickBooksInvoice', 'updateQuickBooksInvoiceDelivery', 'sendQuickBooksInvoice', 'createCustomer', 'createQuickBooksServiceItem', 'revokeToken']) {
            expect({ write, used: code.includes(write) }).toEqual({ write, used: false });
        }
    });

    it('the Intuit client has no payment write, no payment query and no payment search — one read by id', () => {
        const client = strip(R('lib/quickbooks/intuitClient.ts'));
        expect(client).not.toMatch(/select \* from Payment|from\s+Payment\s+where/i);
        expect([...client.matchAll(/readEntity\(config, accessToken, realmId, 'payment'/g)]).toHaveLength(1);
        expect(client).not.toMatch(/['"`]\/payment\b/); // no /payment create or update path
        expect(client.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g)).toHaveLength(7); // unchanged since 1C
    });

    it('the OAuth scope is still exactly accounting: no Payments scope, no Payments API', () => {
        expect(QUICKBOOKS_SCOPE).toBe('com.intuit.quickbooks.accounting');
        expect(SOURCE.filter((f) => /com\.intuit\.quickbooks\.payment|payments\.intuit\.com|\/quickbooks\/v4\/payments/i.test(strip(R(f))))).toEqual([]);
    });

    it('it is an explicit admin action: no webhook, cron, interval or background poller reaches it', () => {
        expect(code).not.toMatch(/setInterval|setTimeout|cron|webhook/i);
        expect(existsSync(join(ROOT, 'app/api/webhooks/quickbooks'))).toBe(false);
        expect(existsSync(join(ROOT, 'app/api/cron'))).toBe(false);
        const callers = SOURCE.filter((f) => f !== PAYMENT && /checkQuickBooksInvoicePayment\(/.test(strip(R(f))));
        expect(callers).toEqual([INVOICE_ROUTE]);
    });

    it('nothing sends QuickBooks payment data to an AI service', () => {
        for (const f of [PAYMENT, 'lib/quickbooks/intuitClient.ts', INVOICE_ROUTE, 'lib/quickbooks/invoiceSendView.ts']) {
            expect({ f, hit: /\b(anthropic|openai|gemini|llm)\b|@ai-sdk/i.test(R(f)) }).toEqual({ f, hit: false });
        }
    });
});

describe('QB-INVOICE-1D · one PAID writer, one kitchen release — repo-wide', () => {
    const PAID_WRITE = /data:\s*\{[^}]*status:\s*'PAID'/;
    const RELEASE = /updateMany\(\{\s*where:\s*\{[^}]*status:\s*'fundraiser_hold'[^}]*\},\s*data:\s*\{\s*status:\s*'production_ready'/;

    it('exactly ONE file in app/ lib/ components/ writes an invoice PAID: the shared transition', () => {
        expect(SOURCE.filter((f) => PAID_WRITE.test(strip(R(f))))).toEqual([TRANSITION]);
    });

    it('exactly ONE file releases fundraiser food to the kitchen: the same transition, inside its winner-only branch', () => {
        expect(SOURCE.filter((f) => RELEASE.test(strip(R(f))))).toEqual([TRANSITION]);
        const code = strip(R(TRANSITION));
        expect(code.indexOf('if (result.count !== 1) return result;')).toBeGreaterThan(-1);
        expect(code.indexOf('if (result.count !== 1) return result;')).toBeLessThan(code.indexOf("status: 'fundraiser_hold'"));
    });

    it('exactly two callers run the transition: Record Payment and the QuickBooks payment check', () => {
        expect(SOURCE.filter((f) => f !== TRANSITION && /settleInvoiceInTransaction\(/.test(strip(R(f)))).sort()).toEqual([PAYMENT, SETTLE_ROUTE].sort());
    });

    it('the QuickBooks check settles only from SENT, only as "quickbooks", and writes nothing itself', () => {
        const code = strip(R(PAYMENT));
        expect(code).toMatch(/fromStatuses: \['SENT'\]/);
        expect(code).toMatch(/method: 'quickbooks' as const/);
        expect(code).not.toMatch(/\.invoice\s*\.\s*(update|updateMany|create|upsert|delete)/);
        expect(code).not.toMatch(/\.(order|orderItem|fundraiserCampaign)\s*\./);
        expect(code).not.toMatch(/status:\s*'PAID'|production_ready|fundraiser_hold/);
    });

    it('Record Payment settles from any outstanding status, as before', () => {
        expect(strip(R(SETTLE_ROUTE))).toMatch(/fromStatuses: SETTLEABLE_INVOICE_STATUSES/);
    });
});

describe('QB-INVOICE-1D · no automatic un-pay, and no human "QuickBooks" claim', () => {
    it('nothing in the QuickBooks code clears a payment or puts food back on hold', () => {
        for (const f of walk('lib/quickbooks').concat(walk('app/api/integrations/quickbooks'))) {
            const code = strip(R(f));
            // Clearing a payment is Undo Payment's shape (paid_at: null); QuickBooks code never has it.
            expect({ f, clearsPayment: /paid_at:\s*null/.test(code) }).toEqual({ f, clearsPayment: false });
            // Reverting a release would write fundraiser_hold back; QuickBooks code never mentions the status at all.
            expect({ f, touchesHold: /fundraiser_hold/.test(code) }).toEqual({ f, touchesHold: false });
        }
    });

    it('Record Payment’s dropdown and validation still offer only Square and Check', () => {
        const page = R('app/invoices/page.tsx');
        expect(page).toContain('SETTLEMENT_PAYMENT_METHODS.map');
        expect(strip(R('lib/invoiceSettlement.ts'))).toMatch(/SETTLEMENT_PAYMENT_METHODS = \['square', 'check'\] as const/);
    });

    it('Undo Payment refuses a verified settlement through a method-agnostic rule, before anything else', () => {
        const del = strip(R(SETTLE_ROUTE)).split('export async function DELETE(')[1];
        expect(del.indexOf('isVerifiedSettlement(invoice)')).toBeGreaterThan(-1);
        expect(del.indexOf('isVerifiedSettlement(invoice)')).toBeLessThan(del.indexOf('isLegacyUnrecordedPayment(invoice)'));
        expect(del.indexOf('isVerifiedSettlement(invoice)')).toBeLessThan(del.indexOf('updateMany'));
    });
});

describe('QB-INVOICE-1D · the UI offers the check only where it can mean something', () => {
    it('the dialog shows "Check QuickBooks payment" only for a sent invoice FreezerIQ still shows as Sent, separate from Check delivery', () => {
        const dialog = R('components/invoices/QuickBooksInvoiceSendDialog.tsx');
        expect(dialog).toMatch(/view\.canCheckPayment && \(\s*<button[^>]*onClick=\{checkPayment\}/);
        expect(dialog).toContain('Check QuickBooks payment');
        expect(dialog).toContain('Check delivery');
        expect(strip(R('lib/quickbooks/invoiceSendView.ts'))).toMatch(/canCheckPayment: !payload\.busy && payload\.invoiceStatus === 'SENT'/);
    });

    it('the invoices list labels a verified payment "QuickBooks Payments" via the one label function', () => {
        const page = R('app/invoices/page.tsx');
        expect(page).toContain('settlementMethodLabel(inv.payment_method)');
        expect(page).not.toMatch(/SETTLEMENT_METHOD_LABELS\[inv\.payment_method/);
    });
});
