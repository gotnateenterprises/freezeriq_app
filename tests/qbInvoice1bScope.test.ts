/**
 * QB-INVOICE-1B — scope guards. 1B is customer mapping plus an invoice-link schema
 * FOUNDATION. These source-level checks keep it from quietly becoming more: no
 * QuickBooks invoice creation or sending, no payments, no webhooks, no email
 * matching, no generic external_id, no user action that reaches the invoice-link
 * primitives, history that no code rewrites, the V1 invoice-id recording contract, and
 * an additive migration with the lifetime and history constraints.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { customerLinkCardView } from '@/lib/quickbooks/customerLinkView';
import * as intuitClient from '@/lib/quickbooks/intuitClient';
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
        else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(rel);
    }
    return out;
}
const SOURCE = ['app', 'lib', 'components'].flatMap((d) => walk(d));
const QB_FILES = [
    ...walk('lib/quickbooks'),
    ...walk('app/api/integrations/quickbooks'),
    'components/crm/QuickBooksCustomerLinkCard.tsx',
    'components/settings/QuickBooksConnectionCard.tsx',
];

// QB-INVOICE-1C (owner brief "QuickBooks Invoice Create + Verify + Send") deliberately added QuickBooks invoice
// behaviour. The 1B guarantees below still hold for everything 1B built; where 1C legitimately crosses a 1B line,
// the exact crossing is named here and its own boundaries are pinned in tests/qbInvoice1cScope.test.ts.
const QB_INVOICE_1C_INVOICE_UI = [
    'components/settings/QuickBooksInvoiceSettingsCard.tsx',
    'lib/quickbooks/invoiceSendView.ts',
    'lib/quickbooks/invoiceSettingsView.ts',
];

describe('QB-INVOICE-1B · no QuickBooks invoice behaviour exists', () => {
    it('no source file builds a QuickBooks payment request, and only the Intuit client builds invoice or send requests (QB-INVOICE-1C)', () => {
        const offenders = SOURCE.filter((f) => {
            const code = strip(R(f));
            const money = /\/v3\/company\/[^'"`]*\/(payment|salesreceipt|estimate|creditmemo)/i.test(code)
                || (f.startsWith('lib/quickbooks/') && /['"`]\/(payment|salesreceipt|estimate|creditmemo)\b/i.test(code));
            const invoice = /\/v3\/company\/[^'"`]*\/invoice/i.test(code)
                || (f.startsWith('lib/quickbooks/') && /['"`]\/invoice\b|\/send\b|sendInvoice|createInvoice|Invoice"\s*:/i.test(code));
            return money || (invoice && f !== 'lib/quickbooks/intuitClient.ts');
        });
        expect(offenders).toEqual([]);
    });

    it('the invoice-link primitives are reachable only from the QB-INVOICE-1C send lifecycle — no route, page or component', () => {
        const users = SOURCE.filter((f) => f !== 'lib/quickbooks/invoiceLinks.ts'
            && /reserveQuickBooksInvoiceLink|recordQuickBooksInvoiceId|getQuickBooksInvoiceLink|quickBooksInvoiceLink\b|lib\/quickbooks\/invoiceLinks/.test(R(f)));
        expect(users).toEqual(['lib/quickbooks/invoiceSend.ts']);
    });

    it('no 1A/1B QuickBooks UI offers to send, invoice or collect payment', () => {
        for (const f of [...QB_FILES.filter((p) => (p.endsWith('.tsx') || p.includes('View')) && !QB_INVOICE_1C_INVOICE_UI.includes(p)), 'app/customers/[id]/page.tsx']) {
            const text = R(f);
            expect({ f, hit: /send via quickbooks|create quickbooks invoice|quickbooks invoice|pay now|record payment/i.test(strip(text)) && f !== 'app/customers/[id]/page.tsx' })
                .toEqual({ f, hit: false });
        }
        const card = strip(R('components/crm/QuickBooksCustomerLinkCard.tsx'));
        expect([...card.matchAll(/<button[\s\S]*?>\s*([^<{]+?)\s*<\/button>/g)].map((m) => m[1].trim()))
            .toEqual(['Link QuickBooks customer', 'Create QuickBooks customer', 'Check again']);
    });

    it('the organization page adds only the card — no invoice, send or payment control', () => {
        const page = R('app/customers/[id]/page.tsx');
        expect(page).toContain("import QuickBooksCustomerLinkCard from '@/components/crm/QuickBooksCustomerLinkCard';");
        expect(page.match(/QuickBooksCustomerLinkCard/g)).toHaveLength(3); // import name, import path, element
        expect(strip(page)).not.toMatch(/\/api\/integrations\/quickbooks|send via|quickbooks invoice/i); // the page itself calls nothing
    });
});

describe('QB-INVOICE-1B · least privilege and data minimisation', () => {
    it('the OAuth scope is still exactly accounting, and no Payments scope appears anywhere', () => {
        expect(QUICKBOOKS_SCOPE).toBe('com.intuit.quickbooks.accounting');
        expect(SOURCE.filter((f) => /com\.intuit\.quickbooks\.payment/.test(strip(R(f))))).toEqual([]);
    });

    it('no QuickBooks webhook: the QuickBooks routes are exactly the five known handlers plus the two QB-INVOICE-1C routes', () => {
        const routes = walk('app/api/integrations/quickbooks').filter((f) => f.endsWith('route.ts')).sort();
        expect(routes).toEqual([
            'app/api/integrations/quickbooks/callback/route.ts',
            'app/api/integrations/quickbooks/connect/route.ts',
            'app/api/integrations/quickbooks/customers/[customerId]/route.ts',
            'app/api/integrations/quickbooks/disconnect/route.ts',
            'app/api/integrations/quickbooks/invoice-settings/route.ts',
            'app/api/integrations/quickbooks/invoices/[invoiceId]/route.ts',
            'app/api/integrations/quickbooks/status/route.ts',
        ]);
        expect(QB_FILES.filter((f) => /webhook|verifier|intuit-signature/i.test(strip(R(f))))).toEqual([]);
    });

    it('matching never uses email or any contact detail, and the organization is read for id and name only', () => {
        // QB-INVOICE-1C's invoice section of the Intuit client names invoice RECIPIENTS; customer lookup, read and
        // create — everything customer MATCHING uses — stay free of any contact detail.
        const client = R('lib/quickbooks/intuitClient.ts');
        const customerSection = client.slice(client.indexOf('// ── QB-INVOICE-1B: Customer lookup'), client.indexOf('// ── QB-INVOICE-1C'));
        expect(customerSection.length).toBeGreaterThan(1000);
        for (const [f, text] of [['lib/quickbooks/customerLinks.ts', R('lib/quickbooks/customerLinks.ts')], ['lib/quickbooks/intuitClient.ts (customer section)', customerSection]]) {
            expect({ f, hit: /email|PrimaryEmailAddr|contact_|phone|address/i.test(strip(text)) }).toEqual({ f, hit: false });
        }
        expect(strip(R('lib/quickbooks/customerLinks.ts'))).toMatch(/customer\.findFirst\(\{ where: \{ id: customerId, business_id: businessId \}, select: \{ id: true, name: true \} \}\)/);
    });

    it('no generic external_id is used or added for QuickBooks', () => {
        expect(QB_FILES.filter((f) => /external_id|externalId/.test(strip(R(f))))).toEqual([]);
        const schema = R('prisma/schema.prisma');
        for (const model of ['QuickBooksConnection', 'QuickBooksCustomerLink', 'QuickBooksInvoiceLink']) {
            const block = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(schema)![0];
            expect({ model, externalId: /external_id/.test(block) }).toEqual({ model, externalId: false });
        }
    });

    it('the Intuit client exports exactly the 1A calls plus Customer lookup, read and minimal create — and the QB-INVOICE-1C invoice and setup calls', () => {
        const fns = Object.entries(intuitClient).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
        expect(fns).toEqual([
            'IntuitError', 'assertUnsentInvoiceCreateBody', 'buildAuthorizationUrl', 'createCustomer', 'createQuickBooksInvoice', 'createQuickBooksServiceItem',
            'displayNameProblem', 'exchangeAuthorizationCode', 'fetchCompanyInfo', 'findCustomersByDisplayName', 'findInactiveCustomersByDisplayName', 'isValidRealmId',
            'listQuickBooksAccounts', 'listQuickBooksItems', 'listQuickBooksTerms', 'parseQuickBooksInvoice', 'readCustomer', 'readQuickBooksAccount', 'readQuickBooksInvoice',
            'readQuickBooksItem', 'readQuickBooksPreferences', 'readQuickBooksTerm', 'refreshAccessToken', 'revokeToken', 'sendQuickBooksInvoice', 'updateQuickBooksInvoiceDelivery',
        ]);
    });

    it('the QuickBooks invoice-link model holds no money, tax, status or payment column', () => {
        const block = /model QuickBooksInvoiceLink \{[\s\S]*?\n\}/.exec(R('prisma/schema.prisma'))![0];
        // QB-INVOICE-1C adds only the `send` back-relation (and a composite unique key) — no column.
        const fields = [...block.matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((m) => m[1]).filter((f) => !['business', 'invoice', 'connection', 'send'].includes(f));
        expect(fields.sort()).toEqual(['business_id', 'connection_id', 'created_at', 'created_by', 'id', 'invoice_id', 'qbo_invoice_id', 'qbo_linked_at', 'request_id']);
    });

    it('a connection generation holds non-secret evidence only — no token, realm id or anything derived from one', () => {
        const block = /model QuickBooksConnection \{[\s\S]*?\n\}/.exec(R('prisma/schema.prisma'))![0];
        const fields = [...block.matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((m) => m[1])
            .filter((f) => !['business', 'integration', 'customer_links', 'invoice_links', 'invoice_settings'].includes(f)); // invoice_settings: QB-INVOICE-1C back-relation
        expect(fields.sort()).toEqual(['authorized_at', 'authorized_by', 'business_id', 'company_name', 'created_at', 'environment', 'id', 'live_business_id', 'live_provider']);
        expect(strip(block)).not.toMatch(/realm|token|secret|fingerprint|hash/i);
    });
});

describe('QB-INVOICE-1B · history is never rewritten, and the V1 recording contract', () => {
    it('no code updates or deletes a connection generation, a customer link or an invoice link — a customer link is only ever created (ACCEPTANCE C: never replaced), and the one write to an invoice link records its QuickBooks invoice', () => {
        const offenders = SOURCE.filter((f) => /quickBooksConnection\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b|quickBooksCustomerLink\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b|quickBooksInvoiceLink\s*\.\s*(update|upsert|delete|deleteMany)\b/.test(strip(R(f)))
            || /\b(UPDATE|DELETE\s+FROM)\s+"?quickbooks_(connections|customer_links|invoice_links)\b/i.test(strip(R(f))));
        expect(offenders).toEqual([]);
        const writes = SOURCE.flatMap((f) => [...strip(R(f)).matchAll(/quickBooksInvoiceLink\s*\.\s*updateMany\(\{[\s\S]*?data: \{([^}]*)\}/g)].map((m) => ({ f, data: m[1].trim() })));
        expect(writes).toEqual([{ f: 'lib/quickbooks/invoiceLinks.ts', data: 'qbo_invoice_id: input.qboInvoiceId, qbo_linked_at: input.now ?? new Date()' }]);
    });

    it('a QuickBooks invoice id can only come from a create response: nothing queries or searches QuickBooks invoices, and no route or UI accepts one', () => {
        // QB-INVOICE-1C reads an invoice ONLY by the id FreezerIQ's own create recorded, and only the Intuit client
        // builds that path; no source anywhere selects from Invoice.
        expect(SOURCE.filter((f) => /from\s+Invoice\b/i.test(strip(R(f)).replace(/import[^;]*;/g, '')))).toEqual([]);
        expect(SOURCE.filter((f) => /\/invoice\//i.test(strip(R(f)).replace(/import[^;]*;/g, '')) && f.startsWith('lib/quickbooks/'))).toEqual(['lib/quickbooks/intuitClient.ts']);
        expect(SOURCE.filter((f) => (f.startsWith('app/') || f.startsWith('components/')) && /qbo_?invoice_?id|qboInvoiceId/i.test(R(f)))).toEqual([]);
        // recordQuickBooksInvoiceId is referenced by nothing outside its own module (see the reachability test above),
        // and its module documents the contract it must be called under.
        const doc = R('lib/quickbooks/invoiceLinks.ts');
        expect(doc).toMatch(/V1 RECORDING CONTRACT/);
        expect(doc).toMatch(/Record ONLY the Id from that create response, or from its requestid replay/);
        expect(doc).toMatch(/requires a new, owner-approved cross-generation uniqueness design/);
    });
});

describe('QB-INVOICE-1B · the migration is additive', () => {
    const MIGRATION = 'prisma/migrations/20260913120000_qb_invoice_1b_quickbooks_links/migration.sql';

    it('is the 26th migration, after f8073eb’s 25 (followed only by QB-INVOICE-1C’s), and changes no existing column or row', () => {
        const dirs = readdirSync(join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        expect(dirs).toHaveLength(27);
        expect(dirs[25]).toBe('20260913120000_qb_invoice_1b_quickbooks_links');
        expect(dirs[26]).toBe('20260915170000_qb_invoice_1c_invoice_send');
        const sql = R(MIGRATION).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|\bUPDATE\s+"|\bDELETE\s+FROM|\bINSERT\s+INTO|\bTRUNCATE\b/i);
        // Every ALTER TABLE adds a constraint to a NEW table; the only statement on an existing table is one unique index.
        for (const m of sql.matchAll(/ALTER TABLE "(\w+)"/g)) expect(m[1]).toMatch(/^quickbooks_/);
        expect([...sql.matchAll(/ON "(\w+)"/g)].map((m) => m[1]).filter((t) => !t.startsWith('quickbooks_'))).toEqual(['invoices']);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "invoices_business_id_id_key" ON "invoices"\("business_id", "id"\)/);
    });

    const statements = () => R(MIGRATION).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

    it('LIFETIME: one QuickBooks invoice link per FreezerIQ invoice across every generation; one FreezerIQ invoice per QuickBooks invoice inside a generation', () => {
        const sql = statements();
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_links_invoice_id_key" ON "quickbooks_invoice_links"\("invoice_id"\);/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_links_connection_id_qbo_invoice_id_key" ON "quickbooks_invoice_links"\("connection_id", "qbo_invoice_id"\);/);
        expect(sql).not.toMatch(/"quickbooks_invoice_links"\("invoice_id", "connection_id"\)|invoice_id_connection_id/);
        expect(/model QuickBooksInvoiceLink \{[\s\S]*?\n\}/.exec(R('prisma/schema.prisma'))![0]).toMatch(/^\s+invoice_id\s+String\s+@unique$/m);
    });

    it('Forget ENDS a generation (SET NULL) and deletes customer links; invoice links keep their generation with RESTRICT', () => {
        const sql = statements();
        expect(sql).toMatch(/"quickbooks_connections_live_business_id_live_provider_fkey" FOREIGN KEY \("live_business_id", "live_provider"\) REFERENCES "integrations"\("business_id", "provider"\) ON DELETE SET NULL ON UPDATE NO ACTION;/);
        expect(sql).toMatch(/"quickbooks_customer_links_business_id_provider_fkey" FOREIGN KEY \("business_id", "provider"\) REFERENCES "integrations"\("business_id", "provider"\) ON DELETE CASCADE ON UPDATE NO ACTION;/);
        expect(sql).toMatch(/"quickbooks_customer_links_live_connection_fkey" FOREIGN KEY \("business_id", "provider", "connection_id"\) REFERENCES "quickbooks_connections"\("live_business_id", "live_provider", "id"\) ON DELETE CASCADE ON UPDATE NO ACTION;/);
        expect(sql).toMatch(/"quickbooks_invoice_links_business_id_connection_id_fkey" FOREIGN KEY \("business_id", "connection_id"\) REFERENCES "quickbooks_connections"\("business_id", "id"\) ON DELETE RESTRICT ON UPDATE NO ACTION;/);
        expect(sql).toMatch(/"quickbooks_invoice_links_business_id_invoice_id_fkey" FOREIGN KEY \("business_id", "invoice_id"\) REFERENCES "invoices"\("business_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION;/);
        // Nothing reaching generations or invoice links from integrations can delete them.
        expect(sql).not.toMatch(/ALTER TABLE "quickbooks_(connections|invoice_links)"[^;]*REFERENCES "integrations"[^;]*ON DELETE CASCADE/);
        expect(sql).not.toMatch(/ALTER TABLE "quickbooks_invoice_links"[^;]*REFERENCES "quickbooks_connections"[^;]*ON DELETE (CASCADE|SET NULL)/);
        // Live pair consistency and environment.
        expect(sql).toMatch(/"quickbooks_connections_live_check" CHECK \(\s*\("live_business_id" IS NULL AND "live_provider" IS NULL\)\s*OR \("live_business_id" IS NOT NULL AND "live_provider" IS NOT NULL\s+AND "live_business_id" = "business_id" AND "live_provider" = 'quickbooks'\)\s*\)/);
        expect(sql).toMatch(/"quickbooks_invoice_links_confirmation_check" CHECK \(\s*\("qbo_invoice_id" IS NULL AND "qbo_linked_at" IS NULL\)\s*OR \("qbo_invoice_id" IS NOT NULL AND "qbo_invoice_id" <> '' AND "qbo_linked_at" IS NOT NULL\)\s*\)/);
        expect(sql).toMatch(/"quickbooks_connections_environment_check" CHECK \("environment" IN \('sandbox', 'production'\)\)/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_connections_live_business_id_live_provider_key" ON "quickbooks_connections"\("live_business_id", "live_provider"\);/);
    });

    it('TENANT CONSISTENCY is structural: tenant-bearing key columns are NOT NULL, and each link reaches its invoice or organization AND its generation through one business_id', () => {
        const sql = statements();
        const table = (name: string) => new RegExp(`CREATE TABLE IF NOT EXISTS "${name}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)![1];
        // A composite foreign key is not checked when any of its referencing columns is NULL (MATCH SIMPLE).
        for (const [name, columns] of [
            ['quickbooks_connections', ['business_id']],
            ['quickbooks_customer_links', ['business_id', 'customer_id', 'connection_id', 'provider']],
            ['quickbooks_invoice_links', ['business_id', 'invoice_id', 'connection_id']],
        ] as const) {
            for (const column of columns) {
                expect({ name, column, notNull: new RegExp(`"${column}" TEXT NOT NULL`).test(table(name)) }).toEqual({ name, column, notNull: true });
            }
        }
        // Generation: the live pair is NULL, or exactly (its own business_id, 'quickbooks').
        expect(table('quickbooks_connections')).toMatch(/"live_business_id" IS NOT NULL AND "live_provider" IS NOT NULL\s+AND "live_business_id" = "business_id" AND "live_provider" = 'quickbooks'/);
        // Invoice link: invoice and generation through the same business_id.
        expect(sql).toMatch(/"quickbooks_invoice_links_business_id_invoice_id_fkey" FOREIGN KEY \("business_id", "invoice_id"\) REFERENCES "invoices"\("business_id", "id"\)/);
        expect(sql).toMatch(/"quickbooks_invoice_links_business_id_connection_id_fkey" FOREIGN KEY \("business_id", "connection_id"\) REFERENCES "quickbooks_connections"\("business_id", "id"\)/);
        // Customer link: organization and LIVE generation through the same business_id.
        expect(sql).toMatch(/"quickbooks_customer_links_business_id_customer_id_fkey" FOREIGN KEY \("business_id", "customer_id"\) REFERENCES "customers"\("business_id", "id"\)/);
        expect(sql).toMatch(/"quickbooks_customer_links_live_connection_fkey" FOREIGN KEY \("business_id", "provider", "connection_id"\) REFERENCES "quickbooks_connections"\("live_business_id", "live_provider", "id"\)/);
        // The parent keys those foreign keys target.
        const schema = R('prisma/schema.prisma');
        expect(/model Invoice \{[\s\S]*?\n\}/.exec(schema)![0]).toMatch(/^\s+business_id\s+String\s*$/m);
        expect(/model Invoice \{[\s\S]*?\n\}/.exec(schema)![0]).toMatch(/@@unique\(\[business_id, id\]\)/);
        expect(/model Customer \{[\s\S]*?\n\}/.exec(schema)![0]).toMatch(/@@unique\(\[business_id, id\]\)/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_connections_business_id_id_key" ON "quickbooks_connections"\("business_id", "id"\);/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_connections_live_business_id_live_provider_id_key" ON "quickbooks_connections"\("live_business_id", "live_provider", "id"\);/);
    });
});

describe('QB-INVOICE-1B · card view model', () => {
    const exact = { state: 'unlinked', organizationName: 'Lincoln PTA', lookup: { result: 'exact_match', qboDisplayName: 'Lincoln PTA', confirmation: 'c'.repeat(40) } } as const;
    const none = { state: 'unlinked', organizationName: 'Lincoln PTA', lookup: { result: 'no_match', proposedDisplayName: 'Lincoln PTA', confirmation: 'd'.repeat(40) } } as const;

    it('disabled hides the card; states without a safe action offer none', () => {
        expect(customerLinkCardView({ state: 'disabled' }).visible).toBe(false);
        for (const s of [
            { state: 'not_connected' }, { state: 'reconnect_required' }, { state: 'unavailable' }, { state: 'error' },
            { state: 'name_unusable', organizationName: 'A:B', problem: 'forbidden_character' },
            { state: 'linked', organizationName: 'X', qboDisplayName: 'X' },
            { state: 'unlinked', organizationName: 'X', lookup: { result: 'resolution_required', reason: 'inactive_match', qboDisplayName: 'X' } },
            { state: 'relink_required', organizationName: 'X', reason: 'inactive', qboDisplayName: 'X', lookup: { result: 'resolution_required', reason: 'inactive_match', qboDisplayName: 'X' } },
        ] as any[]) {
            const v = customerLinkCardView(s);
            expect({ state: s.state, link: v.link, create: v.create }).toEqual({ state: s.state, link: null, create: null });
        }
    });

    it('an exact match offers only a link, with a prompt quoting both names', () => {
        const v = customerLinkCardView(exact as any);
        expect(v.create).toBeNull();
        expect(v.link!.prompt).toContain('“Lincoln PTA”');
        expect(v.link!.prompt).toMatch(/will not change anything in QuickBooks/);
    });

    it('no match offers only a create, quoting the exact display name and stating that only the name is sent', () => {
        const v = customerLinkCardView(none as any);
        expect(v.link).toBeNull();
        expect(v.create).toMatchObject({ displayName: 'Lincoln PTA', confirmation: 'd'.repeat(40) });
        expect(v.create!.prompt).toContain('“Lincoln PTA”');
        expect(v.create!.prompt).toMatch(/Only the name is sent/);
    });

    it('ACCEPTANCE C: relink required is terminal — it never offers Link or Create, for any reason, even if a lookup with confirmations were attached', () => {
        for (const lookup of [none.lookup, exact.lookup, null]) {
            for (const reason of ['inactive', 'missing', 'sub_customer', 'stale_connection']) {
                const v = customerLinkCardView({ state: 'relink_required', organizationName: 'Lincoln PTA', reason, qboDisplayName: 'Lincoln PTA (deleted)', lookup } as any);
                expect({ reason, result: lookup?.result ?? null, label: v.label, link: v.link, create: v.create, recheck: v.showRecheck })
                    .toEqual({ reason, result: lookup?.result ?? null, label: 'Relink required', link: null, create: null, recheck: true });
                expect(v.detail).not.toMatch(/No QuickBooks customer has exactly this name|Confirm to link/);
                expect(v.detail).toMatch(/Resolve it in QuickBooks .* then check again\. FreezerIQ will not create or link a replacement\./);
            }
        }
    });

    it('with no stored link, the lookup’s single action is still offered (no match → Create only; exact match → Link only)', () => {
        expect(customerLinkCardView(none as any)).toMatchObject({ link: null, create: { displayName: 'Lincoln PTA' } });
        expect(customerLinkCardView(exact as any).create).toBeNull();
        expect(customerLinkCardView(exact as any).link).not.toBeNull();
    });
});
