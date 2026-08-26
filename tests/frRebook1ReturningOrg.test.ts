/**
 * FR-REBOOK-1 — a returning organization starts its next fundraiser.
 *
 * What these prove, in order of how much they matter:
 *
 *   1. History NEVER blocks new business. A Closed, Archived, Completed or
 *      awaiting-payment prior campaign is a record, not an obstacle.
 *   2. The returning path REUSES the existing organization — one Edgar, two
 *      campaign histories, never two Edgars.
 *   3. It creates no fake inquiry, and therefore structurally cannot send an
 *      acknowledgement or intro email.
 *   4. It does not launch anything. The campaign is still created by the one
 *      canonical launch authority, from a date-confirmed opportunity.
 *   5. A genuinely running fundraiser is the only thing that stops a new cycle.
 *
 * The Edgar shape used below is real, from a read-only Production audit:
 * organization adc6f7c3…, CustomerStatus LEAD, one Archived campaign with
 * closed_at NULL, 17 non-canceled orders, $2,065 gross, zero invoices,
 * settled_externally false — so FR-HISTORY-1 shows it as "Closed — awaiting
 * payment". That campaign must not stand in the way of the next one.
 */

import {
    evaluateRebookingEligibility,
    canStartNextFundraiser,
    hasFundraiserHistory,
    rebookingActionLabel,
    isOperationallyOpen,
    openCampaignNotice,
    openOpportunityWhere,
    type RebookingCampaign,
} from '@/lib/fundraiserRebooking';
import { OPEN_OPPORTUNITY_STATUSES, TERMINAL_OPPORTUNITY_STATUSES } from '@/lib/fundraiserFunnel';
import { classifyCampaignLifecycle } from '@/lib/growth/campaignLifecycle';

const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

/** Comments stripped so nothing passes on prose describing the fix. */
const code = (p: string): string =>
    read(p)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const OPP_ROUTE = 'app/api/opportunities/route.ts';
const LAUNCH_ROUTE = 'app/api/opportunities/[id]/launch/route.ts';
const PUBLIC_ROUTE = 'app/api/public/fundraiser-request/route.ts';
const ORG_PAGE = 'app/fundraisers/[id]/page.tsx';
const LIB = 'lib/fundraiserRebooking.ts';

/** Edgar's real prior campaign. */
const edgarPrior: RebookingCampaign = {
    id: 'ea12979b-9ebd-44b2-9e06-2bcc8739c7a7',
    status: 'Archived',
    closed_at: null,
    settlement_total: null,
    settled_externally: false,
    invoice_statuses: [],
    held_order_count: 17,
};

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · history never blocks the next fundraiser', () => {
    it("Edgar's archived, awaiting-payment campaign does not block", () => {
        // It classifies as awaiting payment — money is genuinely outstanding —
        // and is still not an operational obstacle.
        expect(classifyCampaignLifecycle(edgarPrior)).toBe('closed_awaiting_payment');
        expect(isOperationallyOpen(edgarPrior)).toBe(false);
        expect(canStartNextFundraiser({ campaigns: [edgarPrior] })).toBe(true);
    });

    it('a prior CLOSED campaign does not block', () => {
        const c: RebookingCampaign = {
            status: 'Closed', closed_at: '2026-04-29T00:00:00.000Z',
            invoice_statuses: ['PAID'], settlement_total: 250,
        };
        expect(canStartNextFundraiser({ campaigns: [c] })).toBe(true);
    });

    it('a prior COMPLETED / PAID campaign does not block', () => {
        const c: RebookingCampaign = {
            status: 'Completed', closed_at: '2026-04-29T00:00:00.000Z',
            invoice_statuses: ['PAID'], settlement_total: 250,
        };
        expect(classifyCampaignLifecycle(c)).toBe('completed');
        expect(canStartNextFundraiser({ campaigns: [c] })).toBe(true);
    });

    it('a prior ARCHIVED campaign does not block', () => {
        expect(canStartNextFundraiser({
            campaigns: [{ status: 'Archived', invoice_statuses: [], settlement_total: 0, held_order_count: 0 }],
        })).toBe(true);
    });

    it('a settled-externally campaign does not block', () => {
        expect(canStartNextFundraiser({
            campaigns: [{ ...edgarPrior, settled_externally: true }],
        })).toBe(true);
    });

    it('several prior campaigns of every closed shape still do not block', () => {
        expect(canStartNextFundraiser({
            campaigns: [
                edgarPrior,
                { status: 'Closed', closed_at: '2026-01-01', invoice_statuses: ['SENT'], settlement_total: 100 },
                { status: 'Completed', invoice_statuses: ['PAID'], settlement_total: 500 },
                { status: 'Archived', invoice_statuses: [], settlement_total: 0, held_order_count: 0 },
            ],
        })).toBe(true);
    });

    it('an organization with NO history can start one too', () => {
        expect(canStartNextFundraiser({ campaigns: [] })).toBe(true);
        expect(canStartNextFundraiser({})).toBe(true);
    });

    it('bookkeeping is never the gate — awaiting payment is explicitly not open', () => {
        // The single most important negative in this phase.
        const owed: RebookingCampaign = {
            status: 'Closed', closed_at: '2026-04-29', invoice_statuses: ['SENT'], settlement_total: 250,
        };
        expect(classifyCampaignLifecycle(owed)).toBe('closed_awaiting_payment');
        expect(isOperationallyOpen(owed)).toBe(false);
        expect(canStartNextFundraiser({ campaigns: [owed] })).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · a running fundraiser informs, it does not refuse', () => {
    const running: RebookingCampaign = { status: 'Active', invoice_statuses: [] };

    /**
     * PLANNING IS NOT LAUNCHING.
     *
     * An earlier draft refused here, reasoning a second cycle was probably a
     * double-click. The evidence is against it on every axis, and these tests
     * pin each one so the restriction cannot creep back:
     *
     *   - the PUBLIC inquiry route creates an opportunity with no campaign
     *     precondition, so refusing would make the owner's own entrance stricter
     *     than the anonymous one;
     *   - the launch route's six guards contain no reference to another campaign;
     *   - the only unique indexes on fundraiser_campaigns are portal_token,
     *     public_token and the (customer_id, id) FK target;
     *   - a group running spring and autumn fundraisers plans the autumn one
     *     while spring is still selling.
     *
     * The double-click worry is solved lower down by the partial unique index
     * fundraiser_opportunities_one_open_per_org.
     */
    it('an operationally open campaign does NOT refuse a new planning cycle', () => {
        expect(isOperationallyOpen(running)).toBe(true);
        const r = evaluateRebookingEligibility({ campaigns: [running] });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.action).toBe('start');
            expect(r.hasOpenCampaign).toBe(true);
        }
    });

    it('the twice-yearly case works: plan autumn while spring is still selling', () => {
        const r = evaluateRebookingEligibility({ campaigns: [edgarPrior, running] });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.hasOpenCampaign).toBe(true);
    });

    it('the open campaign is surfaced as a notice, never as an error', () => {
        expect(openCampaignNotice({ campaigns: [running] }))
            .toMatch(/already has a fundraiser running/i);
        expect(openCampaignNotice({ campaigns: [running] })).toMatch(/still plan the next one/i);
        expect(openCampaignNotice({ campaigns: [running, { status: 'Active', invoice_statuses: [] }] }))
            .toMatch(/2 fundraisers running/i);
        // Silent when there is nothing to say.
        expect(openCampaignNotice({ campaigns: [edgarPrior] })).toBeNull();
        expect(openCampaignNotice({ campaigns: [] })).toBeNull();
    });

    it('no refusal code for an open campaign exists any more', () => {
        const src = code(LIB);
        expect(src).not.toContain('campaign_already_open');
        // The only refusal left is the one that was never in doubt.
        expect(src).toContain("'organization_archived'");
    });

    it('the owner-initiated path is no stricter than the public one', () => {
        // The public route creates an opportunity with no campaign precondition;
        // its only FundraiserCampaign use is identity disambiguation between
        // candidate customers. If that ever changes, this comparison is where the
        // divergence shows up first.
        const pub = code(PUBLIC_ROUTE);
        const oppBlock = pub.slice(
            pub.indexOf('const open = await tx.fundraiserOpportunity.findFirst'),
            pub.indexOf('fundraiserInquiry.create'),
        );
        expect(oppBlock).not.toContain('fundraiserCampaign');
        expect(oppBlock).not.toContain('closed_at');
    });

    it('an archived ORGANIZATION cannot start anything', () => {
        const r = evaluateRebookingEligibility({ archived: true, campaigns: [] });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('organization_archived');
    });

    it('the refusal is keyed on the lifecycle classifier, not a private rule', () => {
        // If FR-HISTORY-1's notion of "open" ever changes, this follows it rather
        // than drifting into a second opinion.
        expect(code(LIB)).toContain("classifyCampaignLifecycle(c) === 'open'");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · an open cycle is resumed, never duplicated', () => {
    it('an existing open opportunity is handed back', () => {
        const r = evaluateRebookingEligibility({
            campaigns: [edgarPrior], openOpportunityId: 'opp-123',
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.action).toBe('resume');
            expect(r.opportunityId).toBe('opp-123');
        }
    });

    it('no open opportunity means a new cycle starts', () => {
        const r = evaluateRebookingEligibility({ campaigns: [edgarPrior], openOpportunityId: null });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.action).toBe('start');
            expect(r.opportunityId).toBeNull();
        }
    });

    it('"open" means exactly what the funnel already means by it', () => {
        expect([...OPEN_OPPORTUNITY_STATUSES]).toEqual(['new', 'in_conversation', 'date_confirmed']);
        // Terminal statuses free the organization for another cycle — the funnel
        // was built for return business and this relies on that, not around it.
        expect([...TERMINAL_OPPORTUNITY_STATUSES]).toEqual(['converted', 'lost']);
    });

    it('the shared where-fragment is tenant-scoped and status-scoped', () => {
        const w: any = openOpportunityWhere('biz-1', 'cus-1');
        expect(w.business_id).toBe('biz-1');
        expect(w.customer_id).toBe('cus-1');
        expect(w.status.in).toEqual(['new', 'in_conversation', 'date_confirmed']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · the endpoint reuses the organization and invents nothing', () => {
    const src = code(OPP_ROUTE);
    const post = src.slice(src.indexOf('export async function POST('));

    it('exists as an authenticated, tenant-scoped POST', () => {
        expect(src).toContain('export async function POST(');
        expect(post).toContain('session?.user?.businessId');
        expect(post).toContain('{ error: \'Unauthorized\' }');
        expect(post).toContain('where: { id: customerId, business_id: businessId }');
    });

    it('NEVER creates a Customer — the organization must already exist', () => {
        expect(post).not.toContain('customer.create');
        expect(post).not.toContain('customer.upsert');
        expect(post).toContain('{ error: \'Organization not found\' }');
    });

    it('NEVER creates a FundraiserInquiry', () => {
        // Which is also what structurally prevents an acknowledgement email:
        // attemptInquiryAcknowledgement() takes an inquiry id.
        expect(post).not.toContain('fundraiserInquiry');
        expect(src).not.toContain('inquiryAcknowledgement');
    });

    it('NEVER creates a campaign — launch stays the canonical authority', () => {
        expect(post).not.toContain('fundraiserCampaign.create');
        expect(post).not.toContain('mintCoordinatorPortalToken');
    });

    it('NEVER touches CustomerStatus', () => {
        // FR-HISTORY-1: relationship stage is CRM truth shared with ordinary
        // customers, and a new fundraiser is not a reason to reset it to LEAD.
        expect(post).not.toMatch(/customer\.update/);
        expect(post).not.toMatch(/status:\s*'LEAD'/);
    });

    it('recovers from the one-open-per-org unique index instead of erroring', () => {
        // The index is raw SQL that Prisma cannot see, so the read-then-write
        // above is not atomic. A losing racer must resume, not 500.
        expect(post).toContain("e?.code !== 'P2002'");

        // Asserted INSIDE the recovery block. `resumed: true` also appears in the
        // eligibility-resume path, so a whole-handler search would pass with the
        // racer wrongly reporting a brand-new cycle.
        const recovery = post.slice(post.indexOf("e?.code !== 'P2002'"));
        // The catch block ends at its closing brace, before the normal return.
        const block = recovery.slice(0, recovery.indexOf('\n        }'));
        expect(block).toContain('fundraiserOpportunity.findFirst');
        expect(block).toContain('resumed: true');
        expect(block).not.toContain('resumed: false');
        // A genuine failure is still a failure — P2002 is not a blanket swallow.
        expect(recovery).toContain('if (!winner) throw e;');
    });

    it('the durable one-open-per-org index still exists', () => {
        const mig = read('prisma/migrations/20260817000000_fr_funnel_1_acquisition_foundation/migration.sql');
        expect(mig).toContain('fundraiser_opportunities_one_open_per_org');
        expect(mig).toMatch(/WHERE "status" IN \('new', 'in_conversation', 'date_confirmed'\)/);
    });

    it('sends no email of any kind', () => {
        for (const s of ['resend', 'sendEmail', 'Resend', '/api/email/send', 'acknowledg']) {
            expect(post.toLowerCase()).not.toContain(s.toLowerCase());
        }
    });

    it('creates the minimum truthful opportunity, with no invented dates', () => {
        expect(post).toContain('fundraiserOpportunity.create');
        // Asserted against the WRITE payload. The route legitimately READS
        // confirmed_delivery_date to report a resumed cycle, so a whole-handler
        // search would fail on a select and prove nothing about what is stored.
        const create = post.indexOf('fundraiserOpportunity.create');
        const dataStart = post.indexOf('data: {', create);
        const dataBlock = post.slice(dataStart, post.indexOf('}', dataStart));
        expect(dataBlock).toContain('business_id: businessId');
        expect(dataBlock).toContain('customer_id: customerId');
        expect(dataBlock).toContain("status: 'new'");
        for (const invented of [
            'confirmed_delivery_date', 'preferred_delivery_date',
            'alternate_delivery_date', 'participant_estimate', 'notes',
        ]) {
            expect(dataBlock).not.toContain(invented);
        }
    });

    it('returns the stored contact so the owner re-enters nothing', () => {
        expect(post).toContain('contact_name');
        expect(post).toContain('contact_email');
        expect(post).toContain('contact_phone');
    });

    it('refuses with 409 and a machine-readable code', () => {
        // Asserted as the EXACT guard: `if (false) {` still contains every string
        // inside the block it disables, so a mention-based assertion would pass
        // with the refusal wired to nothing.
        expect(post).toContain('if (!eligibility.ok) {');
        expect(post).toContain('code: eligibility.code');
        expect(post).toContain('{ status: 409 }');
        // And the refusal is reached BEFORE anything is created.
        expect(post.indexOf('if (!eligibility.ok) {'))
            .toBeLessThan(post.indexOf('fundraiserOpportunity.create'));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · convergence with the one launch pipeline', () => {
    it('there is still exactly ONE launch authority for opportunities', () => {
        const launch = code(LAUNCH_ROUTE);
        expect(launch).toContain('fundraiserCampaign.create');
        // The returning path adds no second one.
        expect(code(OPP_ROUTE)).not.toContain('fundraiserCampaign.create');
    });

    it('launch still demands a confirmed date — EXECUTED, not asserted on text', () => {
        const { checkOpportunityLaunchable } = require('@/lib/fundraiserLaunch');

        // A returning opportunity that has not agreed a date cannot launch.
        const notConfirmed = checkOpportunityLaunchable({
            campaign_id: null, status: 'in_conversation', confirmed_delivery_date: '2026-10-15',
        });
        expect(notConfirmed.ok).toBe(false);
        expect(notConfirmed.code).toBe('not_date_confirmed');

        // date_confirmed with no actual date is a contradiction, and refused.
        const noDate = checkOpportunityLaunchable({
            campaign_id: null, status: 'date_confirmed', confirmed_delivery_date: null,
        });
        expect(noDate.ok).toBe(false);
        expect(noDate.code).toBe('missing_confirmed_date');

        // Already launched cannot launch again.
        const already = checkOpportunityLaunchable({
            campaign_id: 'camp-1', status: 'date_confirmed', confirmed_delivery_date: '2026-10-15',
        });
        expect(already.ok).toBe(false);
        expect(already.code).toBe('already_converted');

        // And the happy path a returning organization reaches.
        const good = checkOpportunityLaunchable({
            campaign_id: null, status: 'date_confirmed', confirmed_delivery_date: '2026-10-15',
        });
        expect(good.ok).toBe(true);
    });

    it('the launch guard treats a returning opportunity exactly like a new one', () => {
        const { checkOpportunityLaunchable } = require('@/lib/fundraiserLaunch');
        // Identical inputs, whatever the organization's history — the guard reads
        // only the opportunity, so history cannot change the answer.
        const base = { campaign_id: null, status: 'date_confirmed', confirmed_delivery_date: '2026-10-15' };
        expect(checkOpportunityLaunchable(base).ok).toBe(true);
        expect(checkOpportunityLaunchable({ ...base, customer_id: 'edgar' } as any).ok).toBe(true);
    });

    it('the launch guard refuses on NOTHING about prior campaigns', () => {
        // Proves Edgar cannot be blocked by history at the launch step either.
        const guard = code('lib/fundraiserLaunch.ts');
        const fn = guard.slice(guard.indexOf('export function checkOpportunityLaunchable'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        for (const s of ['Archived', 'closed_at', 'settlement', 'settled_externally', 'campaigns']) {
            expect(body).not.toContain(s);
        }
    });

    it('the public inquiry path is untouched and still creates its own opportunity', () => {
        const pub = code(PUBLIC_ROUTE);
        expect(pub).toContain('fundraiserOpportunity.create');
        expect(pub).toContain('fundraiserInquiry.create');
        // Still reuses an open cycle rather than duplicating — the behaviour the
        // returning entrance mirrors.
        expect(pub).toContain('OPEN_OPPORTUNITY_STATUSES');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · the owner-facing action', () => {
    const raw = read(ORG_PAGE);
    const src = code(ORG_PAGE);

    it('lives on the fundraiser organization page, by campaign history', () => {
        expect(raw).toContain('Campaign History');
        expect(src).toContain('handleStartNextFundraiser');
    });

    it('is labelled for the situation', () => {
        expect(rebookingActionLabel({ campaigns: [edgarPrior] })).toBe('Start Next Fundraiser');
        expect(rebookingActionLabel({ campaigns: [] })).toBe('Start Fundraiser');
        expect(src).toContain('startNextLabel');
    });

    it('posts to the shared endpoint and nothing else', () => {
        expect(src).toContain("fetch('/api/opportunities'");
        expect(src).toContain("method: 'POST'");
        expect(src).toContain('customerId: id');
    });

    it('disables itself only for a real refusal, never for a running campaign', () => {
        expect(src).toContain('disabled={startingNext || !canStartNext}');
        expect(src).toContain('startNextBlockedReason');
        // `canStartNext` comes from the eligibility result, which no longer
        // refuses on an open campaign — so a live fundraiser cannot disable this.
        expect(src).toContain('const canStartNext = startNextEligibility.ok');
    });

    it('renders the running-campaign notice as visible text, not just a variable', () => {
        // Asserted on the RENDERED element. A test that only looked for the
        // identifier would pass with the paragraph hidden or removed.
        expect(raw).toMatch(/\{startNextNotice && \(/);
        const block = raw.slice(raw.indexOf('{startNextNotice && ('));
        const el = block.slice(0, block.indexOf('</p>'));
        expect(el).toContain('{startNextNotice}');
        expect(el).not.toContain('hidden');
        expect(el).toMatch(/className="[^"]*px-3\.5[^"]*"/);
    });

    it('derives eligibility from the shared rule, not a local copy', () => {
        expect(src).toContain('evaluateRebookingEligibility(');
    });

    it('hands off to the existing funnel rather than a bespoke wizard', () => {
        expect(src).toContain("router.push('/fundraisers?tab=leads')");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · the owner lands on the date conversation, not a fake inbox', () => {
    const { triageOpportunity, funnelBucket } = require('@/lib/growth/opportunityNextAction');
    const NOW_T = new Date('2026-08-26T12:00:00.000Z');

    /** What "Start Next Fundraiser" actually produces: no inquiry, ever. */
    const ownerInitiated: any = {
        id: 'opp-1', status: 'new', first_response_at: null, inquiries: [],
        received_at: null, preferred_delivery_date: null, alternate_delivery_date: null,
        confirmed_delivery_date: null, campaign_id: null, created_at: '2026-08-26T00:00:00.000Z',
    };

    it('does NOT tell the owner to respond to an inquiry that does not exist', () => {
        // The defect this review found: resolveInquiryResponse reports
        // needs_first_response for an empty inquiry list, so a returning
        // organization the owner had just chosen to call was labelled
        // "Respond to new inquiry — a new fundraiser inquiry has not been answered
        // yet". Nobody sent one and nobody is waiting.
        const t = triageOpportunity(ownerInitiated, NOW_T);
        expect(t.action?.kind).not.toBe('respond_to_inquiry');
        expect(t.action?.reason ?? '').not.toMatch(/inquiry/i);
    });

    it('asks for the date instead — which is the real next step', () => {
        const t = triageOpportunity(ownerInitiated, NOW_T);
        expect(t.action?.kind).toBe('await_preferred_dates');
        expect(t.action?.label).toMatch(/date/i);
    });

    it('progresses to confirmation once a date is proposed', () => {
        const withDate = { ...ownerInitiated, preferred_delivery_date: '2026-10-15' };
        const t = triageOpportunity(withDate, NOW_T);
        expect(['check_date_availability', 'confirm_delivery_date']).toContain(t.action?.kind);
    });

    it('the PUBLIC inquiry path is completely unchanged', () => {
        const fromForm = {
            ...ownerInitiated,
            received_at: '2026-08-26T00:00:00.000Z',
            inquiries: [{ received_at: '2026-08-26T00:00:00.000Z', ack_sent_at: null, ack_claimed_at: null, human_response_at: null }],
        };
        expect(triageOpportunity(fromForm, NOW_T).action?.kind).toBe('respond_to_inquiry');
    });

    it('the opportunity is visible in the funnel, not hidden', () => {
        expect(funnelBucket(ownerInitiated, NOW_T)).toBeTruthy();
    });

    it('the gate is an inquiry EXISTING, not a status', () => {
        const src = code('lib/growth/opportunityNextAction.ts');
        expect(src).toContain('const hasInquiry =');
        expect(src).toContain("hasInquiry && response.state === 'needs_first_response'");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1 · one organization, many campaigns', () => {
    it('history accumulates — the rule reads campaigns, never replaces them', () => {
        const before = [edgarPrior];
        const input = { campaigns: before };
        expect(hasFundraiserHistory(input)).toBe(true);
        expect(canStartNextFundraiser(input)).toBe(true);
        // The evaluation is a pure read; nothing about the prior campaign changed.
        expect(before).toHaveLength(1);
        expect(before[0].status).toBe('Archived');
        expect(before[0].settled_externally).toBe(false);
        expect(before[0].invoice_statuses).toEqual([]);
    });

    it('the module mutates nothing and writes nothing', () => {
        const src = code(LIB);
        for (const forbidden of ['prisma', '.create(', '.update(', '.delete(', 'fetch(']) {
            expect(src).not.toContain(forbidden);
        }
    });

    it('is total — every hostile input yields a decision', () => {
        const inputs: any[] = [
            {}, { campaigns: null }, { campaigns: [{}] }, { archived: null },
            { openOpportunityId: '' }, { campaigns: [{ status: null }] },
        ];
        for (const i of inputs) {
            const r = evaluateRebookingEligibility(i);
            expect(typeof r.ok).toBe('boolean');
        }
    });
});
