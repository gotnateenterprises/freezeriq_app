/**
 * FR-HISTORY-1 — fundraiser lifecycle and navigation truth.
 *
 * What these prove, in order of how much they matter:
 *
 *   1. Closing a fundraiser does NOT file it away. Only payment does.
 *   2. A campaign that already has an invoice never offers to create another,
 *      and never claims to be un-invoiced.
 *   3. An organization that finished business years ago is not a current lead.
 *   4. The organization itself survives every campaign.
 *   5. A search result is visible — not hidden inside a collapsed section.
 *
 * The Production shapes used below are real, taken from a read-only audit:
 * "The Best Brew Test 2 Fundraiser" (Closed, settlement_total 250.00, PAID
 * invoice), Edgar/Coles (Archived, real orders, no invoice, not settled
 * externally), and the five historical organizations with PAID invoices and zero
 * campaign rows.
 */

import {
    classifyCampaignLifecycle,
    describeCampaignInvoice,
    resolveCampaignInvoiceState,
    readInvoiceStatuses,
    hasCampaignInvoice,
    hasOutstandingObligation,
    assessObligation,
    isCampaignClosedFamily,
    LIFECYCLE_BUCKET_META,
    LIFECYCLE_BUCKET_ORDER,
    CLOSED_STATUS_FAMILY,
    UNPAID_INVOICE_STATUSES,
    type CampaignLifecycleInput,
} from '@/lib/growth/campaignLifecycle';
import { triageCampaign, PRIORITY_RANK, type CampaignForTriage } from '@/lib/growth/nextAction';
import { SECTION_META } from '@/lib/growth/campaignSections';
import { detailSections } from '@/lib/growth/campaignContextUi';
import { settledNote } from '@/lib/growth/organizationUi';

const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

/** Strips comments so no assertion can pass on prose describing the fix. */
const code = (p: string): string =>
    read(p)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const NOW = new Date('2026-08-25T12:00:00.000Z');

const CAMPAIGNS_API = 'app/api/campaigns/route.ts';
const CUSTOMER_API = 'app/api/customers/[id]/route.ts';
const CARD = 'components/crm2/CampaignCard.tsx';
const LIST = 'components/crm2/CampaignPriorityList.tsx';
const PAGE = 'app/fundraisers/page.tsx';

/** The accepted Production campaign, after the owner recorded payment. */
const bestBrewPaid: CampaignLifecycleInput = {
    status: 'Closed',
    closed_at: '2026-08-24T00:00:00.000Z',
    settlement_total: 250,
    settled_externally: false,
    invoice_statuses: ['PAID'],
};

/** The same campaign the moment closeout finished, before it was invoiced. */
const bestBrewAtCloseout: CampaignLifecycleInput = {
    status: 'Closed',
    closed_at: '2026-08-24T00:00:00.000Z',
    settlement_total: 250,
    settled_externally: false,
    invoice_statuses: [],
};

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · closeout alone never completes a fundraiser', () => {
    it('closed with a DRAFT invoice is awaiting payment', () => {
        expect(classifyCampaignLifecycle({ ...bestBrewAtCloseout, invoice_statuses: ['DRAFT'] }))
            .toBe('closed_awaiting_payment');
    });

    it('closed with a SENT invoice is awaiting payment', () => {
        expect(classifyCampaignLifecycle({ ...bestBrewAtCloseout, invoice_statuses: ['SENT'] }))
            .toBe('closed_awaiting_payment');
    });

    it('closed with an OVERDUE or PENDING invoice is awaiting payment', () => {
        for (const s of ['OVERDUE', 'PENDING']) {
            expect(classifyCampaignLifecycle({ ...bestBrewAtCloseout, invoice_statuses: [s] }))
                .toBe('closed_awaiting_payment');
        }
    });

    it('closed with NO invoice but real sales is awaiting payment', () => {
        // Edgar / Coles: money plainly changed hands, FreezerIQ never recorded it.
        expect(classifyCampaignLifecycle(bestBrewAtCloseout)).toBe('closed_awaiting_payment');
    });

    it('closed with a PAID invoice is completed', () => {
        expect(classifyCampaignLifecycle(bestBrewPaid)).toBe('completed');
    });

    it('settled_externally is completed, whatever the invoices say', () => {
        expect(classifyCampaignLifecycle({ ...bestBrewAtCloseout, settled_externally: true }))
            .toBe('completed');
        expect(classifyCampaignLifecycle({
            ...bestBrewAtCloseout, settled_externally: true, invoice_statuses: ['SENT'],
        })).toBe('completed');
    });

    it('closed owing NOTHING is a record, not an obligation', () => {
        // Fourteen archived test campaigns in Production have no orders and no
        // invoice. Calling those "awaiting payment" would swap one untruth for another.
        expect(classifyCampaignLifecycle({
            status: 'Archived', closed_at: null, settlement_total: null,
            held_order_count: 0, invoice_statuses: [],
        })).toBe('completed');
    });

    it('a running campaign is open, and a lead is a lead', () => {
        expect(classifyCampaignLifecycle({ status: 'Active', invoice_statuses: [] })).toBe('open');
        expect(classifyCampaignLifecycle({ status: 'Lead', invoice_statuses: [] })).toBe('lead');
    });

    it('a PAID invoice completes a campaign even before it is closed', () => {
        // Isolates the PAID rule from the obligation rule. Without the explicit
        // PAID check this falls through to "not closed -> open", so an invoice the
        // organization has already paid would keep reading as live work.
        expect(classifyCampaignLifecycle({ status: 'Active', invoice_statuses: ['PAID'] }))
            .toBe('completed');
        expect(classifyCampaignLifecycle({ status: 'Active', invoice_statuses: [] }))
            .toBe('open');
    });

    it('settled_externally completes an unclosed campaign too', () => {
        expect(classifyCampaignLifecycle({ status: 'Active', settled_externally: true, invoice_statuses: [] }))
            .toBe('completed');
    });

    it('THE REGRESSION: the accepted invoice being PAID is what completes it', () => {
        // Same campaign, one field different. Before INV-D's payment it was work;
        // after it, a record. Nothing else about the row changed.
        expect(classifyCampaignLifecycle(bestBrewAtCloseout)).toBe('closed_awaiting_payment');
        expect(classifyCampaignLifecycle(bestBrewPaid)).toBe('completed');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · awaiting payment stays visible', () => {
    const triageInput = (c: CampaignLifecycleInput): CampaignForTriage =>
        ({ status: String(c.status), ...c } as any);

    it('triage files a closed-but-unpaid campaign as awaiting_payment, not completed', () => {
        const t = triageCampaign(triageInput({ ...bestBrewAtCloseout, invoice_statuses: ['SENT'] }), NOW);
        expect(t.priority).toBe('awaiting_payment');
        expect(t.rank).toBe(PRIORITY_RANK.awaiting_payment);
    });

    it('and gives it a real action instead of falling silent', () => {
        const t = triageCampaign(triageInput({ ...bestBrewAtCloseout, invoice_statuses: ['SENT'] }), NOW);
        expect(t.action).not.toBeNull();
        expect(t.action?.kind).toBe('invoice');
    });

    it('a PAID campaign is completed and carries no action', () => {
        const t = triageCampaign(triageInput(bestBrewPaid), NOW);
        expect(t.priority).toBe('completed');
        expect(t.action).toBeNull();
    });

    it('the awaiting-payment section is NEVER collapsed by default', () => {
        expect(SECTION_META.awaiting_payment.collapsedByDefault).toBe(false);
        expect(LIFECYCLE_BUCKET_META.closed_awaiting_payment.collapsedByDefault).toBe(false);
    });

    it('it outranks every non-alarming state', () => {
        expect(PRIORITY_RANK.awaiting_payment).toBeLessThan(PRIORITY_RANK.on_pace);
        expect(PRIORITY_RANK.awaiting_payment).toBeLessThan(PRIORITY_RANK.upcoming);
        expect(PRIORITY_RANK.awaiting_payment).toBeLessThan(PRIORITY_RANK.completed);
    });

    it('a payload with no invoice linkage fails CONSERVATIVELY — visible, not filed away', () => {
        // Absence is not evidence. This assertion previously expected 'completed',
        // which was the original defect wearing a new hat: a campaign that might
        // still be owed money quietly folding itself into a collapsed section.
        // Being wrong this way shows a paid fundraiser in the work list; being
        // wrong the other way loses money silently.
        const t = triageCampaign({ status: 'Closed', closed_at: '2026-08-24T00:00:00.000Z' } as any, NOW);
        expect(t.priority).toBe('awaiting_payment');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · zero obligation requires PROOF, never absence', () => {
    const closed = { status: 'Closed', closed_at: '2026-08-24T00:00:00.000Z' };

    it('"nothing owed" needs linkage AND a known-zero gross', () => {
        expect(assessObligation({ ...closed, invoice_statuses: [], settlement_total: 0, held_order_count: 0 }))
            .toBe('none');
        expect(classifyCampaignLifecycle({ ...closed, invoice_statuses: [], settlement_total: 0, held_order_count: 0 }))
            .toBe('completed');
    });

    it('omitted invoice linkage is UNKNOWN, never zero obligation', () => {
        expect(assessObligation({ ...closed, settlement_total: 0, held_order_count: 0 })).toBe('unknown');
        expect(classifyCampaignLifecycle({ ...closed, settlement_total: 0, held_order_count: 0 }))
            .toBe('closed_awaiting_payment');
    });

    it('an absent gross is UNKNOWN, not a zero', () => {
        // settlement_total and held_order_count both missing: we know an invoice
        // was never raised, but not whether there were any sales to invoice.
        expect(assessObligation({ ...closed, invoice_statuses: [] })).toBe('unknown');
        expect(classifyCampaignLifecycle({ ...closed, invoice_statuses: [] }))
            .toBe('closed_awaiting_payment');
    });

    it('gross > 0 with no invoice is OWED — the Edgar/Coles shape', () => {
        expect(assessObligation({ ...closed, invoice_statuses: [], settlement_total: 250 })).toBe('owed');
        expect(assessObligation({ ...closed, invoice_statuses: [], held_order_count: 17 })).toBe('owed');
    });

    it('held_order_count zero is a real zero when settlement_total is absent', () => {
        expect(assessObligation({ ...closed, invoice_statuses: [], held_order_count: 0 })).toBe('none');
    });

    it('a zero settlement_total beats a stale order count', () => {
        // settlement_total is authoritative once closeout has frozen it.
        expect(assessObligation({ ...closed, invoice_statuses: [], settlement_total: 0, held_order_count: 9 }))
            .toBe('none');
    });

    it('a non-numeric gross is not silently a zero', () => {
        expect(assessObligation({ ...closed, invoice_statuses: [], settlement_total: 'oops' as any }))
            .toBe('unknown');
    });

    it('every verdict is one of the three, for hostile inputs', () => {
        for (const c of [{}, { status: '' }, { invoice_statuses: null }, { settlement_total: NaN }] as any[]) {
            expect(['owed', 'none', 'unknown']).toContain(assessObligation(c));
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · a real opportunity outranks paid history', () => {
    const placeholder = (over: Partial<CampaignLifecycleInput>): CampaignLifecycleInput =>
        ({ status: 'Lead', is_placeholder: true, invoice_statuses: [], ...over });

    it('history with NO current interest is history', () => {
        expect(classifyCampaignLifecycle(placeholder({ has_settled_history: true, has_open_opportunity: false })))
            .toBe('completed');
    });

    it('history WITH a live opportunity is a LEAD — rebooking must not be hidden', () => {
        // The defect this review found: paid history alone was completing the
        // placeholder, which would bury a genuine new enquiry from a past client.
        expect(classifyCampaignLifecycle(placeholder({ has_settled_history: true, has_open_opportunity: true })))
            .toBe('lead');
    });

    it('a brand-new organization with an opportunity is a lead', () => {
        expect(classifyCampaignLifecycle(placeholder({ has_settled_history: false, has_open_opportunity: true })))
            .toBe('lead');
    });

    it('a brand-new organization with nothing yet is still a lead', () => {
        expect(classifyCampaignLifecycle(placeholder({ has_settled_history: false, has_open_opportunity: false })))
            .toBe('lead');
    });

    it('lead state is never inferred from paid history alone', () => {
        // Same history flag, opposite results — the opportunity is what decides.
        const withOpp = classifyCampaignLifecycle(placeholder({ has_settled_history: true, has_open_opportunity: true }));
        const without = classifyCampaignLifecycle(placeholder({ has_settled_history: true, has_open_opportunity: false }));
        expect(withOpp).not.toBe(without);
    });

    it('the API derives open opportunities from the durable funnel statuses', () => {
        const src = code(CAMPAIGNS_API);
        expect(src).toContain('customersWithOpenOpportunity');
        expect(src).toContain('has_open_opportunity: customersWithOpenOpportunity.has(c.id)');
        const gb = src.indexOf('prisma.fundraiserOpportunity.groupBy');
        expect(gb).toBeGreaterThan(-1);
        const block = src.slice(gb, gb + 400);
        expect(block).toContain('business_id: session.user.businessId');
        expect(block).toContain("'new'");
        expect(block).toContain("'in_conversation'");
        expect(block).toContain("'date_confirmed'");
        // converted and lost are NOT open.
        expect(block).not.toContain("'converted'");
        expect(block).not.toContain("'lost'");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · the stale "not yet invoiced" card', () => {
    it('a PAID campaign never reads as un-invoiced', () => {
        const d = describeCampaignInvoice(bestBrewPaid);
        expect(d.label).toBe('Paid');
        expect(d.label).not.toMatch(/not yet invoiced/i);
        expect(d.canCreateInvoice).toBe(false);
    });

    it('DRAFT reads as review-and-send', () => {
        const d = describeCampaignInvoice({ ...bestBrewAtCloseout, invoice_statuses: ['DRAFT'] });
        expect(d.label).toMatch(/draft/i);
        expect(d.canCreateInvoice).toBe(false);
    });

    it('SENT reads as awaiting payment', () => {
        const d = describeCampaignInvoice({ ...bestBrewAtCloseout, invoice_statuses: ['SENT'] });
        expect(d.label).toMatch(/awaiting payment/i);
        expect(d.canCreateInvoice).toBe(false);
    });

    it('settled_externally reads as settled outside FreezerIQ', () => {
        const d = describeCampaignInvoice({ ...bestBrewAtCloseout, settled_externally: true });
        expect(d.label).toMatch(/outside FreezerIQ/i);
        expect(d.canCreateInvoice).toBe(false);
    });

    it('Create invoice is offered ONLY when no invoice exists', () => {
        expect(describeCampaignInvoice(bestBrewAtCloseout).canCreateInvoice).toBe(true);
        for (const s of ['DRAFT', 'SENT', 'PENDING', 'OVERDUE', 'PAID', 'CANCELED']) {
            expect(describeCampaignInvoice({ ...bestBrewAtCloseout, invoice_statuses: [s] }).canCreateInvoice)
                .toBe(false);
        }
    });

    it('an uninformed payload offers nothing and claims nothing', () => {
        // The exact defect being replaced: a missing field read as "no invoice".
        const d = describeCampaignInvoice({ status: 'Closed', closed_at: '2026-08-24T00:00:00.000Z' });
        expect(d.known).toBe(false);
        expect(d.canCreateInvoice).toBe(false);
        expect(d.label).not.toMatch(/not yet invoiced/i);
        expect(resolveCampaignInvoiceState({ status: 'Closed' })).toBe('unknown');
    });

    it('reads BOTH payload shapes — flattened and the raw relation', () => {
        // /api/campaigns sends invoice_statuses; /api/customers/[id] sends the
        // `invoices` relation. A classifier that read only one would silently
        // reintroduce the bug on the other surface.
        expect(readInvoiceStatuses({ invoice_statuses: ['PAID'] })).toEqual(['PAID']);
        expect(readInvoiceStatuses({ invoices: [{ status: 'PAID' }] })).toEqual(['PAID']);
        expect(readInvoiceStatuses({})).toBeNull();
        expect(describeCampaignInvoice({ status: 'Closed', invoices: [{ status: 'PAID' }] }).label)
            .toBe('Paid');
    });

    it('the card no longer branches on the non-existent invoice_id', () => {
        const src = code(CARD);
        expect(src).not.toContain('c.invoice_id');
        expect(src).not.toContain('not yet invoiced');
        expect(src).toContain('describeCampaignInvoice(c)');
    });

    it('no campaign row anywhere carries invoice_id — it is not a column', () => {
        const schema = read('prisma/schema.prisma');
        const model = schema.slice(schema.indexOf('model FundraiserCampaign {'));
        const body = model.slice(0, model.indexOf('\n}'));
        expect(body).not.toMatch(/^\s*invoice_id\s/m);
    });

    it('an awaiting-payment campaign is OPERATIONALLY finished in the drawer', () => {
        // Ordering has closed, so closeout and bundle-selection must stay hidden
        // even though the campaign is not financially finished. Without this the
        // priority change made it fall through to 'active' and offer operational
        // widgets on a fundraiser nobody can order from any more.
        const owed = {
            status: 'Closed', closed_at: '2026-08-24T00:00:00.000Z',
            invoice_statuses: ['SENT'], settlement_total: 250,
        } as any;
        const s = detailSections(owed, NOW);
        expect(s.triage.priority).toBe('awaiting_payment');
        expect(s.lifecycle).toBe('completed');
        expect(s.showCloseout).toBe(false);
        expect(s.showBundleSelection).toBe(false);
        // The financial half is carried separately, not lost.
        expect(s.invoiceState.label).toMatch(/awaiting payment/i);
    });

    it('the drawer withdraws Create invoice once an invoice is known to exist', () => {
        const base = { status: 'Closed', closed_at: '2026-08-24T00:00:00.000Z' } as any;
        expect(detailSections({ ...base, invoice_statuses: ['PAID'] }, NOW).showInvoice).toBe(false);
        expect(detailSections({ ...base, invoice_statuses: ['SENT'] }, NOW).showInvoice).toBe(false);
        expect(detailSections({ ...base, invoice_statuses: [] }, NOW).showInvoice).toBe(true);
        // A silent payload keeps the capability rather than removing it on a guess.
        expect(detailSections(base, NOW).showInvoice).toBe(true);
    });

    it('the priority menu offers creation only when creation is possible', () => {
        const src = code(LIST);
        expect(src).toContain('describeCampaignInvoice(c)');
        expect(src).toContain('inv.canCreateInvoice');
        expect(src).not.toMatch(/if \(!c\.is_placeholder\) \{\s*menuItems\.push\(\{ key: 'invoice', label: 'Create invoice'/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · a historical organization is not a current lead', () => {
    /** Ag in the Class / Clark Co / Cumberland / Jasper: 0 campaigns, PAID invoice. */
    const historicalOrg: CampaignLifecycleInput = {
        status: 'Lead',
        is_placeholder: true,
        has_settled_history: true,
        invoice_statuses: [],
    };
    /** A genuine prospect: no campaign, no completed business. */
    const realProspect: CampaignLifecycleInput = {
        status: 'Lead',
        is_placeholder: true,
        has_settled_history: false,
        invoice_statuses: [],
    };

    it('an organization with a PAID invoice is history, not a lead', () => {
        expect(classifyCampaignLifecycle(historicalOrg)).toBe('completed');
        expect(classifyCampaignLifecycle(historicalOrg)).not.toBe('lead');
    });

    it('an organization with no completed business IS still a lead', () => {
        expect(classifyCampaignLifecycle(realProspect)).toBe('lead');
    });

    it('existence alone is never a lead signal — the flag is what decides', () => {
        expect(classifyCampaignLifecycle({ ...historicalOrg, has_settled_history: true })).toBe('completed');
        expect(classifyCampaignLifecycle({ ...historicalOrg, has_settled_history: false })).toBe('lead');
    });

    it('a real Lead-status campaign is unaffected by the placeholder rule', () => {
        expect(classifyCampaignLifecycle({ status: 'Lead', is_placeholder: false, invoice_statuses: [] }))
            .toBe('lead');
    });

    it('the API derives settled history from PAID invoices, tenant-scoped', () => {
        const src = code(CAMPAIGNS_API);
        expect(src).toContain('customersWithSettledHistory');
        expect(src).toContain('has_settled_history: customersWithSettledHistory.has(c.id)');

        // Asserted against the groupBy's OWN where clause. `business_id:
        // session.user.businessId` appears many times in this file, so a
        // whole-file search would pass even with THIS query left unscoped —
        // which would leak another tenant's payment history into the bucket.
        const gb = src.indexOf('prisma.invoice.groupBy');
        expect(gb).toBeGreaterThan(-1);
        const whereStart = src.indexOf('where: {', gb);
        const whereClause = src.slice(whereStart, src.indexOf('}', whereStart));
        expect(whereClause).toContain('business_id: session.user.businessId');
        expect(whereClause).toContain("status: 'PAID'");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · the organization survives its campaigns', () => {
    it('nothing in the lifecycle module archives, deletes or hides an organization', () => {
        const src = code('lib/growth/campaignLifecycle.ts');
        for (const forbidden of ['delete', 'archive(', 'setStatus', 'update(']) {
            expect(src.toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
    });

    it('completing a campaign changes only the CAMPAIGN bucket', () => {
        // The classifier is a pure read. Same organization, two campaign states.
        const before = classifyCampaignLifecycle(bestBrewAtCloseout);
        const after = classifyCampaignLifecycle(bestBrewPaid);
        expect(before).not.toBe(after);
        // and nothing about the input was mutated
        expect(bestBrewPaid.invoice_statuses).toEqual(['PAID']);
    });

    it('the customer stage pipeline is labelled, not repurposed', () => {
        const src = read('components/crm/FundraiserOverview.tsx');
        expect(src).toMatch(/Relationship stage/);
        expect(src).toMatch(/not the fundraiser/i);
        // It must still be CustomerStatus-driven and still editable.
        expect(src).toContain('currentStatus={status}');
        expect(src).toContain('allowManualChange={true}');
    });

    it('no code forces a customer to PAID or ARCHIVED when a campaign completes', () => {
        for (const f of ['lib/growth/campaignLifecycle.ts', CARD, LIST]) {
            const src = code(f);
            expect(src).not.toMatch(/customer[^\n]*status[^\n]*=[^\n]*(PAID|ARCHIVED|COMPLETE)/i);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · a search result is visible', () => {
    it('sections expand while the owner is narrowing', () => {
        const src = code(LIST);
        expect(src).toContain('isNarrowing');
        expect(src).toContain("filterStatus !== 'all'");
        expect(src).toContain('isNarrowing ? false : s.meta.collapsedByDefault');
    });

    it('an explicit collapse choice still wins', () => {
        // `collapsed[s.priority] ?? (...)` — a real click is honoured either way.
        expect(code(LIST)).toContain('collapsed[s.priority] ??');
    });

    it('the dashboard exposes an awaiting-payment filter', () => {
        const src = code(PAGE);
        expect(src).toContain("'awaiting'");
        expect(src).toContain("classifyCampaignLifecycle(f) === 'closed_awaiting_payment'");
        expect(src).toMatch(/awaiting: 'Awaiting payment'/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · the API sends what the UI needs', () => {
    it('/api/campaigns selects settlement and invoice truth', () => {
        const src = code(CAMPAIGNS_API);
        expect(src).toContain('settled_externally: true');
        expect(src).toContain('settlement_total: true');
        expect(src).toContain('invoices: { select: { status: true } }');
    });

    it('/api/campaigns emits them on the row', () => {
        const src = code(CAMPAIGNS_API);
        expect(src).toContain('invoice_statuses:');
        expect(src).toContain('settled_externally: Boolean');
    });

    it('/api/customers/[id] includes campaign invoices for the organization page', () => {
        expect(code(CUSTOMER_API)).toContain('include: { invoices: { select: { status: true } } }');
    });

    it('the invoice select carries STATUS only — money stays on the invoice page', () => {
        const src = code(CAMPAIGNS_API);
        expect(src).not.toMatch(/invoices: \{ select: \{[^}]*total_amount/);
        expect(src).not.toMatch(/invoices: \{ select: \{[^}]*paid_at/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · Edgar / Coles, without touching their data', () => {
    /** Their real Production shape today: Archived, real orders, no invoice. */
    const edgar: CampaignLifecycleInput = {
        status: 'Archived',
        closed_at: null,
        settlement_total: null,
        held_order_count: 17,
        settled_externally: false,
        invoice_statuses: [],
    };

    it('today they read as awaiting payment — which is what FreezerIQ actually knows', () => {
        expect(classifyCampaignLifecycle(edgar)).toBe('closed_awaiting_payment');
    });

    it('after the owner marks settled_externally they become completed', () => {
        expect(classifyCampaignLifecycle({ ...edgar, settled_externally: true })).toBe('completed');
    });

    it('and no invoice, date, method or reference is invented for them either way', () => {
        for (const c of [edgar, { ...edgar, settled_externally: true }]) {
            const d = describeCampaignInvoice(c);
            expect(d.label).not.toMatch(/\$|check|square|\d{4}-\d{2}-\d{2}/i);
            expect(hasCampaignInvoice(c)).toBe(false);
        }
    });

    it('the organization summary no longer says "none settled yet"', () => {
        // Their closeout never ran, so settledSales is 0 — but they WERE paid.
        // The words now report closeout, which is the fact the number carries.
        expect(settledNote({ lifetimeFundraiserSales: 2065, settledSales: 0 })).toBe('none closed out yet');
        expect(settledNote({ lifetimeFundraiserSales: 2065, settledSales: 0 })).not.toMatch(/settled/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-HISTORY-1 · module invariants', () => {
    it('every bucket has meta and a place in the order', () => {
        const buckets = Object.keys(LIFECYCLE_BUCKET_META).sort();
        expect([...LIFECYCLE_BUCKET_ORDER].sort()).toEqual(buckets);
    });

    it('awaiting payment is ordered ahead of completed', () => {
        expect(LIFECYCLE_BUCKET_ORDER.indexOf('closed_awaiting_payment'))
            .toBeLessThan(LIFECYCLE_BUCKET_ORDER.indexOf('completed'));
    });

    it('the closed family matches the one nextAction uses', () => {
        const { CLOSED_FAMILY } = require('@/lib/growth/nextAction');
        expect([...CLOSED_STATUS_FAMILY].sort()).toEqual([...CLOSED_FAMILY].sort());
    });

    it('the unpaid set matches INV-C outstanding, plus DRAFT', () => {
        const { OUTSTANDING_INVOICE_STATUSES } = require('@/lib/invoiceSendTruth');
        for (const s of OUTSTANDING_INVOICE_STATUSES) {
            expect(UNPAID_INVOICE_STATUSES as readonly string[]).toContain(s);
        }
        // DRAFT is additionally unpaid: generated but not yet issued.
        expect(UNPAID_INVOICE_STATUSES as readonly string[]).toContain('DRAFT');
    });

    it('the classifier is total — every input yields a bucket', () => {
        const inputs: CampaignLifecycleInput[] = [
            {}, { status: '' }, { status: 'Nonsense' }, { closed_at: 'garbage' },
            { invoice_statuses: [null, undefined] as any }, { settlement_total: 'x' },
            { is_placeholder: true }, { settled_externally: null },
        ];
        for (const i of inputs) {
            expect(['lead', 'open', 'closed_awaiting_payment', 'completed'])
                .toContain(classifyCampaignLifecycle(i));
        }
    });

    it('isCampaignClosedFamily accepts a stamp or a status', () => {
        expect(isCampaignClosedFamily({ closed_at: '2026-01-01' })).toBe(true);
        for (const s of CLOSED_STATUS_FAMILY) {
            expect(isCampaignClosedFamily({ status: s })).toBe(true);
        }
        expect(isCampaignClosedFamily({ status: 'Active' })).toBe(false);
    });

    it('a CANCELED-only invoice is not an obligation', () => {
        expect(hasOutstandingObligation({
            status: 'Closed', settlement_total: 250, invoice_statuses: ['CANCELED'],
        })).toBe(false);
    });
});
