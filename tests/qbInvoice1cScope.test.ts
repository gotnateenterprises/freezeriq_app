/**
 * QB-INVOICE-1C — scope guards. 1C is "Send via QuickBooks": tenant mapping, one verified QuickBooks invoice per
 * FreezerIQ invoice, and the send lifecycle. These source-level checks keep it from quietly becoming more — no
 * payments (1D), no webhook, no polling, no fulfillment or PAID behaviour, nothing at fundraiser close, no invoice
 * search, no second path to QuickBooks writes — and keep its boundaries exactly where the owner put them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { QUICKBOOKS_SCOPE, resolveQuickBooksConfig } from '@/lib/quickbooks/config';
import { sandboxEnv } from './helpers/quickbooksFakes';

const ROOT = process.cwd();
const R = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(join(ROOT, dir))) return out;
    for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(rel);
    }
    return out;
}
const SOURCE = ['app', 'lib', 'components'].flatMap((d) => walk(d));
const QB_LIB = walk('lib/quickbooks');
const QB_ROUTES = walk('app/api/integrations/quickbooks');
const SEND = 'lib/quickbooks/invoiceSend.ts';
const INVOICE_ROUTE = 'app/api/integrations/quickbooks/invoices/[invoiceId]/route.ts';
const SETTINGS_ROUTE = 'app/api/integrations/quickbooks/invoice-settings/route.ts';
const MIGRATION = 'prisma/migrations/20260915170000_qb_invoice_1c_invoice_send/migration.sql';
const users = (pattern: RegExp) => SOURCE.filter((f) => pattern.test(strip(R(f))));

describe('QB-INVOICE-1C · no 1D: no payments, webhooks, polling, PAID or fulfillment behaviour', () => {
    it('the OAuth scope is still exactly accounting; nothing mentions the Payments scope or the Payments API', () => {
        expect(QUICKBOOKS_SCOPE).toBe('com.intuit.quickbooks.accounting');
        expect(users(/com\.intuit\.quickbooks\.payment|payments\.intuit\.com|\/quickbooks\/v4\/payments/i)).toEqual([]);
    });

    it('no webhook, cron or polling reaches QuickBooks', () => {
        expect([...QB_LIB, ...QB_ROUTES].filter((f) => /webhook|intuit-signature|setInterval|cron/i.test(strip(R(f))))).toEqual([]);
        expect(existsSync(join(ROOT, 'app/api/cron'))).toBe(false);
        expect(existsSync(join(ROOT, 'app/api/webhooks/quickbooks'))).toBe(false);
    });

    it('QuickBooks code never writes PAID, payment facts, orders, fulfillment or release — and nothing at fundraiser close calls it', () => {
        for (const f of [...QB_LIB, ...QB_ROUTES]) {
            const code = strip(R(f));
            expect({ f, hit: /'PAID'|paid_at|payment_method|payment_reference|production_ready|fundraiser_hold|released_to_delivery|loyalty/.test(code) }).toEqual({ f, hit: false });
            expect({ f, hit: /\.(order|orderItem|fundraiserCampaign)\s*\./.test(code) }).toEqual({ f, hit: false });
        }
        expect(strip(R('app/api/campaigns/[id]/closeout/route.ts'))).not.toMatch(/quickbooks/i);
        expect(strip(R('app/api/tenant/invoices/[id]/settle/route.ts'))).not.toMatch(/quickbooks/i);
    });

    it('SENT is written only from DRAFT, inside the verified lifecycle transaction, and only after the sent read-back', () => {
        const code = strip(R(SEND));
        const accept = code.slice(code.indexOf('async function acceptSent('), code.indexOf('export type DeliveryCheckResult'));
        expect(accept.indexOf("verify(s, inv, 'sent'")).toBeGreaterThan(-1);
        expect(accept.indexOf("verify(s, inv, 'sent'")).toBeLessThan(accept.indexOf('$transaction'));
        expect(accept).toMatch(/\$transaction\(async \(tx\) => \{[\s\S]*tx\.quickBooksInvoiceSend\.updateMany[\s\S]*tx\.invoice\.updateMany\(\{\s*where: \{ id: s\.invoiceId, business_id: s\.businessId, status: 'DRAFT' \},\s*data: \{ status: 'SENT' \},/);
        expect(code.match(/status: 'SENT'/g)).toHaveLength(1);
        expect(code).not.toMatch(/data: \{[^}]*status: 'DRAFT'/);
    });
});

describe('QB-INVOICE-1C · one path to every QuickBooks invoice write', () => {
    it('create, update and send are called only by the lifecycle — the create always with the link’s reserved requestid', () => {
        for (const fn of ['createQuickBooksInvoice', 'updateQuickBooksInvoiceDelivery', 'sendQuickBooksInvoice']) {
            expect({ fn, users: users(new RegExp(`\\b${fn}\\(`)).filter((f) => f !== 'lib/quickbooks/intuitClient.ts') }).toEqual({ fn, users: [SEND] });
        }
        const code = strip(R(SEND));
        expect(code.match(/createQuickBooksInvoice\(/g)).toHaveLength(1);
        expect(code).toMatch(/createQuickBooksInvoice\(s\.config, a\.accessToken, a\.realmId, s\.ctx\.body, s\.link\.requestId, s\.d\.fetchImpl\)/);
        // The id recorded is only ever the create's own answer.
        expect(code).toMatch(/recordQuickBooksInvoiceId\(\s*\{ businessId: s\.businessId, linkId: s\.link\.id, connectionId: s\.link\.connectionId, qboInvoiceId: created\.id,/);
        // Reads are by the recorded link id only.
        for (const m of code.matchAll(/readQuickBooksInvoice\([^)]*\)/g)) expect(m[0]).toMatch(/link\.qboInvoiceId!/);
    });

    it('every recipients update restates all four payment flags (a partial update would re-enable them)', () => {
        const code = strip(R(SEND));
        const calls = [...code.matchAll(/updateQuickBooksInvoiceDelivery\([\s\S]*?fields: \{([^}]*\})/g)].map((m) => m[1]);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const c of calls) expect(c).toMatch(/payment: \{ \.\.\.(payment|s\.ctx\.payment) \}/);
        expect(strip(R('lib/quickbooks/intuitClient.ts'))).toMatch(/local-payment-flags-incomplete/);
    });

    it('the lifecycle never supplies a DocNumber, a recipient at create, native tax or a sendTo', () => {
        const payload = strip(R('lib/quickbooks/invoicePayload.ts'));
        expect(payload).not.toMatch(/DocNumber|BillEmail|TxnTaxDetail|NeedToSend|DiscountLineDetail/);
        expect(strip(R('lib/quickbooks/intuitClient.ts'))).not.toMatch(/sendTo/);
    });

    it('nothing searches QuickBooks for "similar" invoices, and nothing sends QuickBooks data to an AI service', () => {
        expect(users(/select \* from Invoice|from\s+Invoice\s+where/i)).toEqual([]);
        for (const f of [...QB_LIB, ...QB_ROUTES]) expect({ f, hit: /\b(anthropic|openai|gemini|llm)\b|@ai-sdk/i.test(R(f)) }).toEqual({ f, hit: false });
    });

    it('only the two 1C routes reach the 1C services; FreezerIQ never emails through QuickBooks code', () => {
        // Runtime imports only: the client-safe view modules import TYPES, which compile away.
        expect(users(/^import (?!type )[^;]*from '@\/lib\/quickbooks\/invoiceSend';/m)).toEqual([INVOICE_ROUTE]);
        expect(users(/^import (?!type )[^;]*from '@\/lib\/quickbooks\/invoiceSettings';/m).filter((f) => f.startsWith('app/') || f.startsWith('components/'))).toEqual([SETTINGS_ROUTE]);
        for (const f of ['components/invoices/QuickBooksInvoiceSendDialog.tsx', 'components/settings/QuickBooksInvoiceSettingsCard.tsx', 'lib/quickbooks/invoiceSendView.ts', 'lib/quickbooks/invoiceSettingsView.ts']) {
            expect({ f, runtimeServerImport: /^import (?!type )[^;]*from '@\/lib\/(db|quickbooks\/(invoiceSend|invoiceSettings|connection|intuitClient|liveConnection))';/m.test(R(f)) }).toEqual({ f, runtimeServerImport: false });
        }
        for (const f of [...QB_LIB, ...QB_ROUTES]) expect({ f, hit: /from 'resend'|@\/lib\/email/.test(R(f)) }).toEqual({ f, hit: false });
    });
});

describe('QB-INVOICE-1C · route guards are the 1B shape', () => {
    for (const route of [INVOICE_ROUTE, SETTINGS_ROUTE]) {
        it(`${route}: session, ADMIN (not View As), JSON-only writes, disabled before any service call, no-store`, () => {
            const code = strip(R(route));
            const handlers = [...code.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)].map((m) => m[1]);
            expect(handlers.length).toBeGreaterThan(0);
            for (const h of handlers) {
                const body = code.slice(code.indexOf(`export async function ${h}(`)).split(/\nexport async function /)[0];
                expect({ h, session: /if \(!session\?\.user\?\.id\) return json\(\{ error: 'Unauthorized' \}, 401\)/.test(body) }).toEqual({ h, session: true });
                expect({ h, admin: body.indexOf('mayManageQuickBooks(session.user') > -1 && body.indexOf('mayManageQuickBooks(session.user') < body.indexOf('resolveQuickBooksConfig()') }).toEqual({ h, admin: true });
                if (h !== 'GET') expect({ h, json: /application\/json[\s\S]{0,80}415|isJson\(req\)\) return json\(\{ error: 'Expected application\/json' \}, 415\)/.test(body) }).toEqual({ h, json: true });
                const disabled = body.indexOf('if (!resolved.enabled)');
                const service = body.search(/await (get|start|resume|resend|check|save|create)QuickBooks/);
                expect({ h, disabledFirst: disabled > -1 && disabled < service }).toEqual({ h, disabledFirst: true });
                expect(body).not.toMatch(/Access-Control-Allow/);
            }
            // SEC-INTUIT-ATTEST-1 aligned every route-level Cache-Control under app/api to the
            // exact value next.config.js sets, because on Vercel a handler's own header overrides
            // the config one. tests/secIntuitAttest1.test.ts owns that invariant repo-wide.
            expect(code).toMatch(/const NO_STORE = \{ 'Cache-Control': 'no-store, no-cache, must-revalidate' \}/);
            expect(code).not.toMatch(/body\.(businessId|userId|connectionId|realmId|qboInvoiceId|qboCustomerId)/);
        });
    }

    it('QuickBooks is still disabled in Preview, and in Production without the explicit enable', () => {
        expect(resolveQuickBooksConfig(sandboxEnv({ VERCEL: '1', VERCEL_ENV: 'preview' })).enabled).toBe(false);
        expect(resolveQuickBooksConfig(sandboxEnv({ VERCEL: '1', VERCEL_ENV: 'production', QBO_ENVIRONMENT: 'production' })).enabled).toBe(false);
    });
});

describe('QB-INVOICE-1C · UI', () => {
    it('the Send via QuickBooks button exists only in its dialog, mounted by the invoices page for admins acting as themselves', () => {
        // The words also appear in the refusal the FreezerIQ email route returns (lib/quickbooks/invoiceLock.ts).
        expect(SOURCE.filter((f) => /Send via QuickBooks/.test(strip(R(f))))).toEqual(['lib/quickbooks/invoiceLock.ts', 'components/invoices/QuickBooksInvoiceSendDialog.tsx']);
        expect(SOURCE.filter((f) => /['"`]Send via QuickBooks['"`]/.test(strip(R(f))))).toEqual(['components/invoices/QuickBooksInvoiceSendDialog.tsx']);
        const page = R('app/invoices/page.tsx');
        expect(page).toContain("const mayUseQuickBooks = session?.user?.role === 'ADMIN' && !(session?.user as any)?.isViewingAsTenant;");
        expect(page).toMatch(/\{quickBooksInvoice && mayUseQuickBooks && \(\s*<QuickBooksInvoiceSendDialog/);
        expect(page).toMatch(/\{mayUseQuickBooks && inv\.campaign_id && \(/);
        const settings = R('app/settings/page.tsx');
        expect(settings).toMatch(/session\?\.user\?\.role === 'ADMIN' && !\(session\?\.user as any\)\?\.isViewingAsTenant && \(\s*<QuickBooksInvoiceSettingsCard \/>/);
    });

    it('the QuickBooks invoice UI never shows a raw QuickBooks id, the realm or a connection id, and never says Pay Now or record payment', () => {
        for (const f of ['components/invoices/QuickBooksInvoiceSendDialog.tsx', 'components/settings/QuickBooksInvoiceSettingsCard.tsx', 'lib/quickbooks/invoiceSendView.ts', 'lib/quickbooks/invoiceSettingsView.ts', 'app/invoices/page.tsx']) {
            const code = strip(R(f));
            expect({ f, hit: /qbo_?(invoice|customer|item|account|term)_?id|qbo(Invoice|Customer|Item|Account|Term)Id|realm|connection_?id|connectionId/i.test(code) }).toEqual({ f, hit: false });
            expect({ f, hit: /pay now|record payment/i.test(code) && f !== 'app/invoices/page.tsx' }).toEqual({ f, hit: false });
            expect({ f, hit: /\bQBO?\b/.test(code.replace(/qbo_doc_number/g, '')) }).toEqual({ f, hit: false });
        }
    });
});

describe('QB-INVOICE-1C · schema and migration', () => {
    const sql = () => R(MIGRATION).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

    it('additive only: two new tables, one enum, one unique index on an existing (1B) table — no existing column or row changes', () => {
        const s = sql();
        expect(s).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|\bUPDATE\s+"|\bDELETE\s+FROM|\bINSERT\s+INTO|\bTRUNCATE\b|ADD COLUMN/i);
        expect([...s.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1])).toEqual(['quickbooks_invoice_settings', 'quickbooks_invoice_sends']);
        for (const m of s.matchAll(/ALTER TABLE "(\w+)"/g)) expect(['quickbooks_invoice_settings', 'quickbooks_invoice_sends']).toContain(m[1]);
        expect([...s.matchAll(/ON "(\w+)"/g)].map((m) => m[1]).filter((t) => !['quickbooks_invoice_settings', 'quickbooks_invoice_sends'].includes(t))).toEqual(['quickbooks_invoice_links']);
        expect(s).toMatch(/CREATE TYPE "QuickBooksInvoiceSendStatus" AS ENUM \('reserved', 'created', 'recipients_set', 'payment_options_set', 'sent', 'needs_review'\)/);
    });

    it('LIFETIME and HISTORY: one lifecycle per invoice; it never outlives its link or its invoice; settings die with the live connection', () => {
        const s = sql();
        expect(s).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_sends_invoice_id_key" ON "quickbooks_invoice_sends"\("invoice_id"\);/);
        expect(s).toMatch(/"quickbooks_invoice_sends_invoice_fkey" FOREIGN KEY \("business_id", "invoice_id"\) REFERENCES "invoices"\("business_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION;/);
        expect(s).toMatch(/"quickbooks_invoice_sends_link_fkey" FOREIGN KEY \("business_id", "invoice_id"\) REFERENCES "quickbooks_invoice_links"\("business_id", "invoice_id"\) ON DELETE RESTRICT ON UPDATE NO ACTION;/);
        expect(s).toMatch(/"quickbooks_invoice_settings_business_id_provider_fkey" FOREIGN KEY \("business_id", "provider"\) REFERENCES "integrations"\("business_id", "provider"\) ON DELETE CASCADE/);
        expect(s).toMatch(/"quickbooks_invoice_settings_live_connection_fkey" FOREIGN KEY \("business_id", "provider", "connection_id"\) REFERENCES "quickbooks_connections"\("live_business_id", "live_provider", "id"\) ON DELETE CASCADE/);
        expect(s).not.toMatch(/ALTER TABLE "quickbooks_invoice_sends"[^;]*REFERENCES "(invoices|quickbooks_invoice_links)"[^;]*ON DELETE (CASCADE|SET NULL)/);
    });

    it('CHECK constraints the lifecycle relies on', () => {
        const s = sql();
        for (const name of ['review_hash_check', 'txn_date_check', 'mapping_check', 'recipient_check', 'lease_check', 'counters_check', 'created_check', 'sent_check']) {
            expect(s).toContain(`"quickbooks_invoice_sends_${name}"`);
        }
        for (const name of ['provider_check', 'sales_check', 'term_check', 'share_pair_check', 'tax_pair_check', 'default_cc_check']) {
            expect(s).toContain(`"quickbooks_invoice_settings_${name}"`);
        }
        expect(s).toMatch(/"status" <> 'sent' OR \("sent_at" IS NOT NULL AND "send_count" >= 1\)/);
    });

    it('neither table holds money, a token, a realm id or a secret', () => {
        const schema = R('prisma/schema.prisma');
        for (const model of ['QuickBooksInvoiceSettings', 'QuickBooksInvoiceSend']) {
            const block = strip(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(schema)![0]).replace(/\/\/\/.*$/gm, '');
            const fields = [...block.matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((m) => m[1]);
            expect({ model, money: fields.filter((f) => /amount|total|tax_amount|balance|price|paid/.test(f)) }).toEqual({ model, money: [] });
            expect({ model, secret: fields.filter((f) => /token|realm|secret|password/.test(f) && f !== 'qbo_sync_token') }).toEqual({ model, secret: [] });
        }
    });
});
