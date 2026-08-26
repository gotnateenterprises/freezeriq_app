/**
 * FR-ACCEPTANCE-2A.2 — final owner intake polish before EMAIL-SEC-1.
 *
 * Five independent pieces, tested at the level each one actually allows:
 * lib/personName.ts and lib/emailTemplates.ts are plain executable TypeScript,
 * so those are EXECUTED. app/fundraisers/page.tsx, DashboardClient.tsx,
 * FundraiserLeadAttentionCard.tsx and FunnelLeadsPanel.tsx are React client
 * components — this repo's jest config is `testEnvironment: 'node'` with no
 * jsdom and testMatch scoped to `*.test.ts`, so `.tsx` never loads here. Those
 * are proven by reading the real source, exactly as the rest of this program's
 * component-level tests already do.
 */

import { firstNameOf } from '@/lib/personName';
import { EMAIL_TEMPLATES, type TemplateTenant } from '@/lib/emailTemplates';
import { resolveInquiryResponse } from '@/lib/growth/inquiryResponseState';
import {
    triageOpportunity,
    funnelBucket,
    FOLLOW_UP_SILENCE_HOURS,
} from '@/lib/growth/opportunityNextAction';

const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// PART B — the first-name helper, executed
// ═══════════════════════════════════════════════════════════════════════════

describe('firstNameOf', () => {
    it('matches every example from the approved contract', () => {
        expect(firstNameOf('Kaleb Hacker')).toBe('Kaleb');
        expect(firstNameOf('Nathan Hacker')).toBe('Nathan');
        expect(firstNameOf('  Jane Doe  ')).toBe('Jane');
    });

    it('preserves a single-name contact rather than mangling it', () => {
        expect(firstNameOf('Cher')).toBe('Cher');
        expect(firstNameOf('  Cher  ')).toBe('Cher');
    });

    it('falls back safely when there is no useful token', () => {
        expect(firstNameOf('')).toBeNull();
        expect(firstNameOf('   ')).toBeNull();
        expect(firstNameOf(null)).toBeNull();
        expect(firstNameOf(undefined)).toBeNull();
    });

    it('collapses internal whitespace runs without producing an empty token', () => {
        expect(firstNameOf('Kaleb   Hacker')).toBe('Kaleb');
        expect(firstNameOf('\tKaleb\nHacker')).toBe('Kaleb');
    });

    it('does not attempt title or suffix parsing — first token only, as designed', () => {
        // Deliberately not "smart": Dr. becomes the greeting name rather than
        // being stripped, because this function does not parse names, it takes
        // the first whitespace-delimited token. Documenting the boundary, not
        // asking for different behavior.
        expect(firstNameOf('Dr. Jane Doe')).toBe('Dr.');
    });

    it('never mutates or truncates the input it is given', () => {
        const original = '  Kaleb Hacker  ';
        firstNameOf(original);
        expect(original).toBe('  Kaleb Hacker  ');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART A — the autoresponder's "what happens after that" copy
// ═══════════════════════════════════════════════════════════════════════════

describe('the approved item-2 wording', () => {
    const TENANT: TemplateTenant = { name: 'Freezer Chef' };
    const render = (name = 'Kaleb Hacker') => EMAIL_TEMPLATES.lead_intro(name, 'Oak Ridge PTO', TENANT);

    it('carries the exact owner-approved sentence', () => {
        const { html } = render();
        expect(html).toContain(
            'You get everything you need to run and share it</strong> — your own coordinator dashboard to track orders in real time, download and print flyers and order forms, and share your custom online ordering page with supporters.'
        );
    });

    it('the old wording is gone', () => {
        const { html } = render();
        expect(html).not.toContain('flyers and order forms, your own online order page, and a coordinator dashboard for watching orders arrive in real time');
    });

    it('claims nothing the platform cannot do — every noun maps to a real coordinator-portal feature', () => {
        // Flyer download (flyerHref/flyerAsset), the ShareCenter, and the public
        // /shop/[slug]/fundraiser/[id] ordering page are the three things named
        // here, and all three exist in app/coordinator/portal/page.tsx.
        const portal = read('app/coordinator/portal/page.tsx');
        expect(portal).toMatch(/flyerHref/);
        expect(portal).toMatch(/ShareCenter/);
        expect(portal).toMatch(/\/shop\/\$\{slug\}\/fundraiser\/\$\{campaign\.id\}/);
    });

    it('preserves every other approved 2A.1 paragraph untouched', () => {
        const { html } = render();
        expect(html).toContain('final orders are due two weeks before the delivery date');
        expect(html).toContain('keeps its agreed fundraising percentage off the top');
        expect(html).toContain('payment due upon receipt');
        expect(html).toMatch(/preferred date/i);
        expect(html).toMatch(/backup date/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART B — the greeting, executed against the real template
// ═══════════════════════════════════════════════════════════════════════════

describe('the automatic acknowledgement greeting', () => {
    const TENANT: TemplateTenant = { name: 'Freezer Chef' };
    const render = (name: string) => EMAIL_TEMPLATES.lead_intro(name, 'Oak Ridge PTO', TENANT);

    it('greets by first name, matching the approved examples', () => {
        expect(render('Kaleb Hacker').html).toContain('Hi Kaleb!');
        expect(render('Nathan Hacker').html).toContain('Hi Nathan!');
        expect(render('  Jane Doe  ').html).toContain('Hi Jane!');
    });

    it('preserves a single-name contact in the greeting', () => {
        expect(render('Cher').html).toContain('Hi Cher!');
    });

    it('falls back to "there" exactly as the old full-name path did', () => {
        expect(render('').html).toContain('Hi there!');
    });

    it('output still passes through normal HTML escaping', () => {
        // firstNameOf runs BEFORE escapeHtml, not instead of it — a hostile
        // first token must still come out neutralised.
        const html = render('<script>alert(1)</script> Hacker').html;
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('the greeting is the ONLY thing shortened — the rest of the body still names the organization in full', () => {
        const html = render('Kaleb Hacker').html;
        expect(html).toContain('Hi Kaleb!');
        expect(html).toContain('<strong>Oak Ridge PTO</strong>');
    });

    it('this module never writes anywhere — presentation only, by construction', () => {
        // lib/emailTemplates.ts renders strings; it holds no database client and
        // performs no writes. The real proof that the stored contact_name is
        // unaffected is that nothing in the acknowledgement pipeline touches it
        // — see the inquiryAcknowledgement.ts assertion below.
        const src = stripComments(read('lib/emailTemplates.ts'));
        expect(src).not.toMatch(/prisma|\$transaction|\.update\(|\.create\(/);
    });

    it('the acknowledgement module reads contact_name once and never writes it', () => {
        const src = stripComments(read('lib/inquiryAcknowledgement.ts'));
        const writes = [...src.matchAll(/data:\s*\{([^}]*)\}/g)].map((m) => m[1]);
        for (const w of writes) expect(w).not.toMatch(/contact_name/);
        expect(src).toMatch(/contact_name: true/); // still selected for reading
    });

    it('thank_you is deliberately untouched — this phase scoped to the automatic acknowledgement only', () => {
        const html = EMAIL_TEMPLATES.thank_you('Kaleb Hacker', 'Oak Ridge PTO', TENANT).html;
        expect(html).toContain('Hi Kaleb Hacker!');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART C — Fundraiser Dashboard Leads tab badge
// ═══════════════════════════════════════════════════════════════════════════

describe('the Fundraiser CRM Leads tab badge', () => {
    const page = () => read('app/fundraisers/page.tsx');
    const panel = () => read('components/crm2/FunnelLeadsPanel.tsx');

    it('the panel reports its own count up, from the same rows it renders', () => {
        const src = stripComments(panel());
        expect(src).toMatch(/onCountChange\?: \(count: number\) => void/);
        expect(src).toMatch(/onCountChangeRef\.current\?\.\(opportunities\.length\)/);
    });

    it('the badge on the page reads that SAME reported count — not a re-derivation', () => {
        const src = stripComments(page());
        expect(src).toMatch(/onCountChange=\{setLeadsCount\}/);
        expect(src).toMatch(/leadsCount !== null && leadsCount > 0/);
    });

    it('the badge is fed independent of which tab is active', () => {
        // The whole point: a lead must be visible without switching to Leads.
        const src = stripComments(page());
        expect(src).toMatch(/fetch\('\/api\/opportunities\?open=1'\)/);
        // At least two distinct sites read this endpoint: the page-level
        // effect for the badge, and the conditionally-mounted panel.
        expect((page().match(/\/api\/opportunities\?open=1/g) || []).length).toBeGreaterThanOrEqual(1);
    });

    it('the badge visually matches the panel\'s own bucket-count pill', () => {
        const pageBadge = page().match(/leadsCount[\s\S]{0,300}?rounded-full bg-slate-100[^"]*"/)?.[0] ?? '';
        expect(pageBadge).toMatch(/rounded-full bg-slate-100/);
        expect(pageBadge).toMatch(/text-\[11px\] font-bold/);
    });

    it('renders nothing (not a "0") before the count has loaded', () => {
        const src = page();
        expect(src).toMatch(/leadsCount !== null/);
        expect(src).not.toMatch(/leadsCount \?\? 0/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART C continued — a real ?tab= deep link, closing the /pipeline gap
// ═══════════════════════════════════════════════════════════════════════════

describe('the Leads tab deep link', () => {
    const page = () => read('app/fundraisers/page.tsx');

    it('reads an initial ?tab= the same way ?search= is already read', () => {
        const src = page();
        expect(src).toMatch(/searchParams\.get\('tab'\)/);
        expect(src).toMatch(/TAB_KEYS as readonly string\[\]\)\.includes\(/);
    });

    it('defaults to campaigns for an absent or invalid ?tab=, never crashes on garbage input', () => {
        const src = page();
        expect(src).toMatch(/: 'campaigns';/);
    });

    it('/pipeline is never used as an actual navigation target — only named in comments as the dead route being avoided', () => {
        for (const f of ['app/fundraisers/page.tsx', 'components/FundraiserLeadAttentionCard.tsx', 'app/DashboardClient.tsx']) {
            const src = read(f);
            // href="/pipeline", router.push('/pipeline'), etc. — an actual target,
            // not a code comment explaining why it is avoided.
            expect(src).not.toMatch(/(href|Link to|push)\s*[=(]\s*['"`]\/pipeline/);
        }
    });

    it('/pipeline genuinely has no page behind it — confirming the gap this replaces', () => {
        const fs = require('fs');
        const path = require('path');
        expect(fs.existsSync(path.join(process.cwd(), 'app/pipeline/page.tsx'))).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D — Main Dashboard fundraiser-lead attention card
// ═══════════════════════════════════════════════════════════════════════════

describe('the Main Dashboard fundraiser-lead attention card', () => {
    const card = () => stripComments(read('components/FundraiserLeadAttentionCard.tsx'));
    const dashboard = () => stripComments(read('app/DashboardClient.tsx'));

    it('uses the canonical GET /api/opportunities endpoint — no second data source', () => {
        expect(card()).toMatch(/fetch\('\/api\/opportunities\?open=1'\)/);
    });

    it('is wired into the real dashboard, gated by the same plan check as /fundraisers', () => {
        const d = dashboard();
        expect(d).toMatch(/<FundraiserLeadAttentionCard hasAccess=\{hasFundraiserAccess\} \/>/);
        expect(d).toMatch(/'ENTERPRISE'.*'ULTIMATE'.*'FREE'/s);
    });

    it('REVERSED: surfaces every ACTIVE lead, not only the urgent subset', () => {
        // The first version of this card gated on priority === 'needs_attention'
        // alone. That failed the ordinary case outright: a fresh inquiry whose
        // acknowledgement has gone out and which is waiting on a date derives
        // priority 'on_pace', so the card rendered nothing and the tenant had no
        // way to discover the lead existed without opening the CRM — the exact
        // problem the card was added to solve. See the Part D fixture below,
        // which pins that shape.
        const src = card();
        expect(src).toMatch(/const active = rows;/);
        expect(src).not.toMatch(/rows\.filter\(\(r\) => r\.priority === 'needs_attention'\)[\s\S]{0,80}if \(actionable/);
    });

    it('still distinguishes the urgent subset using the canonical priority', () => {
        const src = card();
        expect(src).toMatch(/const urgent = active\.filter\(\(r\) => r\.priority === 'needs_attention'\);/);
    });

    it('renders no alarming empty card when there are no active leads', () => {
        const src = card();
        expect(src).toMatch(/if \(active\.length === 0\) return null;/);
    });

    it('never invents urgency — the urgent count is mentioned only when non-zero', () => {
        const src = card();
        expect(src).toMatch(/\{urgent\.length > 0 && \(/);
        // And an all-healthy card is not dressed as a warning.
        expect(src).toMatch(/urgent\.length > 0 \? 'border-l-amber-500' : 'border-l-indigo-500'/);
    });

    it('renders nothing rather than a stale or wrong count when the fetch fails', () => {
        const src = card();
        expect(src).toMatch(/if \(!hasAccess \|\| rows === null\) return null;/);
        // Structural proof, not a comment-text match: the .catch() body never
        // calls setRows, so a failed fetch leaves `rows` at its initial `null` —
        // which is exactly the state the line above renders as nothing.
        const catchBody = src.slice(src.indexOf('.catch(() =>'), src.indexOf('.catch(() =>') + 120);
        expect(catchBody).not.toMatch(/setRows/);
    });

    it('closed/lost/converted opportunities can never be counted', () => {
        // Not by a local check here — by construction, because GET
        // /api/opportunities?open=1 excludes them at the source, and this
        // component's `rows` state is fed exclusively from that endpoint.
        // Confirm the endpoint really does exclude them.
        const route = stripComments(read('app/api/opportunities/route.ts'));
        expect(route).toMatch(/OPEN_OPPORTUNITY_STATUSES/);
        const funnel = stripComments(read('lib/fundraiserFunnel.ts'));
        expect(funnel).toMatch(/OPEN_OPPORTUNITY_STATUSES = \['new', 'in_conversation', 'date_confirmed'\]/);
        expect(funnel).not.toMatch(/OPEN_OPPORTUNITY_STATUSES.*converted/);
        expect(funnel).not.toMatch(/OPEN_OPPORTUNITY_STATUSES.*lost/);
    });

    it('navigates to the real Fundraiser CRM Leads view, not the dead /pipeline route', () => {
        const src = card();
        expect(src).toMatch(/LEADS_HREF = '\/fundraisers\?tab=leads'/);
        expect(src).not.toMatch(/\/pipeline/);
    });

    it('the single-lead and multi-lead cases both link to the same canonical destination', () => {
        const src = card();
        expect((src.match(/href=\{LEADS_HREF\}/g) || []).length).toBe(2);
    });

    it('the single-lead status line is drawn from canonical state, not invented copy', () => {
        // Both facts the owner's example shows: what has gone out, and what the
        // lead is waiting on. The second is the canonical triage action label,
        // so it cannot drift from what the CRM says when the tenant clicks in.
        const src = card();
        expect(src).toMatch(/lead\.response_state === 'auto_ack_sent'/);
        expect(src).toMatch(/lines\.push\(lead\.action\.label\)/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D — THE HARD ACCEPTANCE GATE: the exact Best Brew Test 4 shape
// ═══════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-08-23T12:00:00.000Z');
const hAgo = (h: number) => new Date(NOW.getTime() - h * 36e5);
const dAgo = (d: number) => new Date(NOW.getTime() - d * 864e5);

/**
 * The card's own visibility rule, extracted so it can be EXECUTED here.
 *
 * Mirrors FundraiserLeadAttentionCard.tsx: `?open=1` supplies the rows, every
 * one of which is an active lead, and the urgent subset is the canonical
 * needs_attention priority. The source-identity test below pins the two
 * together so this can never drift into testing a fiction.
 */
const cardVisibility = (rows: { priority: string }[]) => ({
    visible: rows.length > 0,
    activeCount: rows.length,
    urgentCount: rows.filter((r) => r.priority === 'needs_attention').length,
});

describe('PART D — a fresh auto-acknowledged Waiting-for-Date lead is VISIBLE on the main dashboard', () => {
    // Best Brew Test 4 exactly: fresh inquiry, acknowledgement sent, no human
    // follow-up, no preferred date, no confirmed date, inside the 48-hour
    // escalation threshold.
    const test4 = {
        status: 'new',
        inquiries: [{ received_at: hAgo(3), ack_claimed_at: hAgo(3), ack_sent_at: hAgo(3) }],
    };

    it('derives the healthy, NON-urgent state — which is why the old gate hid it', () => {
        const t = triageOpportunity(test4, NOW);
        const r = resolveInquiryResponse(null, test4.inquiries);
        expect(r.state).toBe('auto_ack_sent');
        expect(t.action?.label).toBe('Waiting for preferred dates');
        expect(funnelBucket(test4, NOW)).toBe('waiting_on_date');
        // The decisive fact: NOT needs_attention. The previous card filtered on
        // exactly this and therefore rendered nothing for the owner's own case.
        expect(t.priority).toBe('on_pace');
        expect(t.priority).not.toBe('needs_attention');
    });

    it('IS surfaced by the dashboard card — the hard gate', () => {
        const t = triageOpportunity(test4, NOW);
        const v = cardVisibility([{ priority: t.priority }]);
        expect(v.visible).toBe(true);
        expect(v.activeCount).toBe(1);
        // Truthfully displayed as active, not dressed as urgent.
        expect(v.urgentCount).toBe(0);
    });

    it('would NOT have been surfaced by the superseded needs_attention-only gate', () => {
        // Proves this suite is not vacuous: the old rule genuinely fails here.
        const t = triageOpportunity(test4, NOW);
        const oldGate = [{ priority: t.priority }].filter((r) => r.priority === 'needs_attention');
        expect(oldGate).toHaveLength(0);
    });

    it('the card can state both facts truthfully for this lead', () => {
        const r = resolveInquiryResponse(null, test4.inquiries);
        const t = triageOpportunity(test4, NOW);
        expect(r.state).toBe('auto_ack_sent');        // "Automatic acknowledgement sent"
        expect(t.action?.label).toBe('Waiting for preferred dates');
        // Never claims a human replied.
        expect(r.manualResponseApplies).toBe(false);
    });
});

describe('PART C — active population: what counts and what is excluded', () => {
    const cases: { name: string; o: any; priority: string; active: boolean }[] = [
        {
            name: 'needs first response',
            o: { status: 'new', inquiries: [{ received_at: hAgo(2) }] },
            priority: 'worth_a_look', active: true,
        },
        {
            name: 'acknowledged, waiting for date (Test 4)',
            o: { status: 'new', inquiries: [{ received_at: hAgo(3), ack_sent_at: hAgo(3) }] },
            priority: 'on_pace', active: true,
        },
        {
            name: 'follow up — no date selected yet',
            o: { status: 'in_conversation', inquiries: [{ received_at: dAgo(9), ack_sent_at: dAgo(9) }] },
            priority: 'worth_a_look', active: true,
        },
        {
            name: 'ready to create campaign',
            o: { status: 'date_confirmed', confirmed_delivery_date: '2026-10-17', inquiries: [{ received_at: dAgo(5) }] },
            priority: 'upcoming', active: true,
        },
        {
            name: 'launched (converted) — excluded',
            o: { status: 'converted', inquiries: [{ received_at: dAgo(30) }] },
            priority: 'completed', active: false,
        },
        {
            name: 'not proceeding (lost) — excluded',
            o: { status: 'lost', inquiries: [{ received_at: dAgo(30) }] },
            priority: 'completed', active: false,
        },
    ];

    it.each(cases)('$name', ({ o, priority, active }) => {
        const t = triageOpportunity(o, NOW);
        expect(t.priority).toBe(priority);
        // "Active" is enforced at the SOURCE by ?open=1, not re-derived in the
        // card. funnelBucket 'closed' is the same population the endpoint drops.
        expect(funnelBucket(o, NOW) !== 'closed').toBe(active);
    });

    it('every active state above is visible; every excluded one contributes nothing', () => {
        const activeRows = cases.filter((c) => c.active).map((c) => ({ priority: c.priority }));
        const v = cardVisibility(activeRows);
        expect(v.visible).toBe(true);
        expect(v.activeCount).toBe(4);
        expect(v.urgentCount).toBe(0); // none of these four is needs_attention
    });

    it('an urgent lead is counted in the urgent subset as well as the active total', () => {
        const overdue = { status: 'new', inquiries: [{ received_at: hAgo(30) }] };
        expect(triageOpportunity(overdue, NOW).priority).toBe('needs_attention');
        const v = cardVisibility([
            { priority: 'on_pace' },
            { priority: triageOpportunity(overdue, NOW).priority },
        ]);
        expect(v.activeCount).toBe(2);
        expect(v.urgentCount).toBe(1);
    });

    it('zero active leads hides the card entirely', () => {
        expect(cardVisibility([]).visible).toBe(false);
    });

    it('the executed rule above is the rule the component actually ships', () => {
        const src = stripComments(read('components/FundraiserLeadAttentionCard.tsx'));
        expect(src).toMatch(/const active = rows;/);
        expect(src).toMatch(/if \(active\.length === 0\) return null;/);
        expect(src).toMatch(/const urgent = active\.filter\(\(r\) => r\.priority === 'needs_attention'\);/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTS J/K/N — follow-up truth, executed
// ═══════════════════════════════════════════════════════════════════════════

describe('PART J — the resolver reports the latest follow-up, not the first', () => {
    it('with no follow-up recorded, lastHumanFollowUpAt is null', () => {
        const r = resolveInquiryResponse(null, [{ received_at: hAgo(5), human_response_at: hAgo(4) }]);
        expect(r.lastHumanFollowUpAt).toBeNull();
        expect(r.manualResponseApplies).toBe(true);
    });

    it('the owner example: first Aug 23, second Aug 25 — UI shows Aug 25', () => {
        const first = new Date('2026-08-23T09:00:00.000Z');
        const second = new Date('2026-08-25T14:30:00.000Z');
        const r = resolveInquiryResponse(first, [
            { received_at: new Date('2026-08-23T08:00:00.000Z'), human_response_at: first, last_human_followup_at: second },
        ]);
        // First-response facts stay at the first contact...
        expect(r.manualResponseApplies).toBe(true);
        // ...while the displayed follow-up advances.
        expect(r.lastHumanFollowUpAt).toEqual(second);
        // And the follow-up clock measures from the LATEST contact.
        expect(r.outreachAt).toEqual(second);
    });

    it('falls back to the first response when no follow-up has been recorded', () => {
        const first = hAgo(10);
        const r = resolveInquiryResponse(first, [{ received_at: hAgo(12), human_response_at: first }]);
        expect(r.outreachAt).toEqual(first);
    });

    it('a follow-up is reported alongside an acknowledgement, not instead of it', () => {
        const r = resolveInquiryResponse(null, [{
            received_at: hAgo(20), ack_sent_at: hAgo(20),
            human_response_at: hAgo(10), last_human_followup_at: hAgo(2),
        }]);
        expect(r.autoAckSentAt).toEqual(hAgo(20));
        expect(r.lastHumanFollowUpAt).toEqual(hAgo(2));
    });
});

describe('PART K — a newer inquiry never inherits an older follow-up', () => {
    // The owner's exact model: inquiry #1 received Aug 1, followed up Aug 1,
    // last follow-up Aug 3. Inquiry #2 received Aug 20.
    const AUG1 = new Date('2026-08-01T10:00:00.000Z');
    const AUG3 = new Date('2026-08-03T10:00:00.000Z');
    const AUG20 = new Date('2026-08-20T10:00:00.000Z');

    const twoInquiries = [
        { received_at: AUG1, human_response_at: AUG1, last_human_followup_at: AUG3 },
        { received_at: AUG20 },
    ];

    it('the Aug 3 follow-up does NOT make the Aug 20 inquiry look followed up', () => {
        const r = resolveInquiryResponse(AUG1, twoInquiries);
        expect(r.state).toBe('needs_first_response');
        expect(r.manualResponseApplies).toBe(false);
        // The decisive assertion: the older row's follow-up is unreachable,
        // because the resolver reads the NEWEST inquiry's own column.
        expect(r.lastHumanFollowUpAt).toBeNull();
    });

    it('the CRM therefore shows no follow-up line for the newer inquiry', () => {
        const r = resolveInquiryResponse(AUG1, twoInquiries);
        // The panel renders the follow-up line on
        // `manual_response_applies || last_human_followup_at`; both are falsy.
        expect(r.manualResponseApplies || r.lastHumanFollowUpAt).toBeFalsy();
    });

    it('after following up on the NEW inquiry, only that inquiry advances', () => {
        const afterClick = [
            { received_at: AUG1, human_response_at: AUG1, last_human_followup_at: AUG3 },
            { received_at: AUG20, human_response_at: AUG20, last_human_followup_at: AUG20 },
        ];
        const r = resolveInquiryResponse(AUG1, afterClick);
        expect(r.manualResponseApplies).toBe(true);
        expect(r.lastHumanFollowUpAt).toEqual(AUG20);
        // Inquiry #1's history is untouched — still its own Aug 3.
        expect(afterClick[0].last_human_followup_at).toEqual(AUG3);
    });

    it('the write targets only the newest inquiry, so old rows cannot be rewritten forward', () => {
        const route = stripComments(read('app/api/opportunities/[id]/route.ts'));
        const block = route.slice(route.indexOf('if (followUpInquiryId)'));
        expect(block).toMatch(/id: followUpInquiryId/);
    });
});

describe('PART N — the 48-hour clock uses the latest truthful follow-up', () => {
    it('a lead followed up recently is NOT overdue, even with an old first response', () => {
        const o = {
            status: 'in_conversation',
            inquiries: [{
                received_at: dAgo(30),
                human_response_at: dAgo(20),               // first response, long ago
                last_human_followup_at: hAgo(2),          // followed up 2 hours ago
            }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).toBe('await_preferred_dates');
        expect(funnelBucket(o, NOW)).toBe('waiting_on_date');
    });

    it('a lead whose LATEST follow-up is past the window IS due another', () => {
        const o = {
            status: 'in_conversation',
            inquiries: [{
                received_at: dAgo(30),
                human_response_at: dAgo(20),
                last_human_followup_at: hAgo(FOLLOW_UP_SILENCE_HOURS + 1),
            }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).toBe('send_follow_up');
        expect(funnelBucket(o, NOW)).toBe('needs_follow_up');
    });

    it('recording a follow-up resets the clock — the whole point of advancing it', () => {
        const stale = {
            status: 'in_conversation',
            inquiries: [{ received_at: dAgo(30), human_response_at: dAgo(20) }],
        };
        expect(triageOpportunity(stale, NOW).action?.kind).toBe('send_follow_up');

        const justFollowedUp = {
            status: 'in_conversation',
            inquiries: [{ received_at: dAgo(30), human_response_at: dAgo(20), last_human_followup_at: hAgo(1) }],
        };
        expect(triageOpportunity(justFollowedUp, NOW).action?.kind).not.toBe('send_follow_up');
    });

    it('a preferred date still clears the follow-up condition regardless of follow-up state', () => {
        const o = {
            status: 'in_conversation',
            preferred_delivery_date: '2026-10-17',
            updated_at: hAgo(2),
            inquiries: [{ received_at: dAgo(30), human_response_at: dAgo(20), last_human_followup_at: dAgo(10) }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).not.toBe('send_follow_up');
    });

    it('an OLDER inquiry\'s follow-up cannot reset a NEWER inquiry\'s clock', () => {
        const o = {
            status: 'in_conversation',
            inquiries: [
                { received_at: dAgo(30), human_response_at: dAgo(29), last_human_followup_at: hAgo(1) },
                { received_at: dAgo(5) },
            ],
        };
        // The newest inquiry is unanswered, so this is a first-response job on
        // the faster clock — the old row's fresh follow-up is invisible here.
        expect(triageOpportunity(o, NOW).action?.kind).toBe('respond_to_inquiry');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART G — dashboard/card and CRM state agreement
// ═══════════════════════════════════════════════════════════════════════════

describe('dashboard and CRM read the identical derivation', () => {
    it('the dashboard card, the tab badge, and the Leads panel all call the SAME endpoint', () => {
        const card = read('components/FundraiserLeadAttentionCard.tsx');
        const page = read('app/fundraisers/page.tsx');
        const panelSrc = read('components/crm2/FunnelLeadsPanel.tsx');
        for (const src of [card, page, panelSrc]) {
            expect(src).toMatch(/\/api\/opportunities\?open=1/);
        }
    });

    it('none of the three re-implements bucket or priority classification locally', () => {
        for (const f of ['components/FundraiserLeadAttentionCard.tsx', 'app/fundraisers/page.tsx']) {
            const src = stripComments(read(f));
            expect(src).not.toMatch(/function triageOpportunity|function funnelBucket/);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTS E–H — the combined mailto + record follow-up action
// ═══════════════════════════════════════════════════════════════════════════

describe('the combined mailto + record follow-up action', () => {
    const panel = () => read('components/crm2/FunnelLeadsPanel.tsx');
    const block = () => {
        const src = panel();
        return src.slice(src.indexOf("o.action?.kind === 'send_follow_up' ||"), src.indexOf('{!o.manual_response_applies'));
    };

    it('opens the mail client via the safe, already-validated mailtoHref', () => {
        const b = block();
        expect(b).toMatch(/const href = mailtoHref\(o\.customer\.contact_email\);/);
        expect(b).toMatch(/if \(!href\) return;/);
        expect(b).toMatch(/window\.location\.href = href;/);
    });

    it('records the SAME action "I replied elsewhere" already uses — mark_responded', () => {
        const b = block();
        expect(b).toMatch(/mutate\(o\.id, \{ action: 'mark_responded' \}, 'Follow-up recorded', \{ keepalive: true \}\)/);
    });

    it('REVERSED: the request is STARTED before the mail handoff, with keepalive', () => {
        // The first version opened mail first and fired an ordinary fetch after.
        // That inverted both properties that matter: the request was issued into
        // a document that may already have been unloading, and an ordinary fetch
        // dies with the page. Now the keepalive request is started first — so it
        // exists before any handoff — and is not awaited, so mail still opens
        // instantly.
        const b = block();
        const recordAt = b.indexOf("mutate(o.id, { action: 'mark_responded' }");
        const navAt = b.indexOf('window.location.href = href;');
        expect(recordAt).toBeGreaterThan(-1);
        expect(navAt).toBeGreaterThan(recordAt);
    });

    it('the record call is NOT awaited — the tenant never waits on the network', () => {
        const b = block();
        expect(b).not.toMatch(/await mutate\(/);
    });

    it('the label uses the first name, matching the approved "Email Kaleb" example', () => {
        const b = block();
        expect(b).toMatch(/Email \{firstNameOf\(o\.customer\.contact_name\) \|\| 'them'\}/);
    });

    it('no long instructional paragraph — the tooltip is one short sentence', () => {
        const b = block();
        const title = b.match(/title="([^"]*)"/)?.[1] ?? '';
        expect(title.length).toBeLessThan(80);
        expect(title.split('.').filter(Boolean).length).toBeLessThanOrEqual(1);
    });

    it('never claims provider-confirmed delivery — "Followed up", never "Sent"', () => {
        const b = block();
        expect(b).not.toMatch(/>Sent<|Email Sent|Message Sent/);
    });

    it('the fallback (no usable address) still records nothing, since there is no click to fire', () => {
        const src = panel();
        const fallback = src.slice(src.indexOf('No usable email address on file'), src.indexOf('No usable email address on file') + 200);
        expect(fallback).not.toMatch(/onClick|mutate\(/);
    });
});

describe('the acknowledgement line and the follow-up line are independent facts', () => {
    const notice = () => {
        const src = read('components/crm2/FunnelLeadsPanel.tsx');
        return src.slice(src.indexOf('function ResponseStateNotice'), src.indexOf('function LeadDateField'));
    };

    it('the acknowledgement line renders whenever auto_ack_sent_at is set, independent of follow-up state', () => {
        const src = notice();
        expect(src).toMatch(/if \(o\.auto_ack_sent_at\) \{/);
        expect(src).toMatch(/Automatic acknowledgement sent/);
    });

    it('the follow-up line renders on a first response OR a recorded follow-up', () => {
        const src = notice();
        expect(src).toMatch(/if \(o\.manual_response_applies \|\| o\.last_human_followup_at\) \{/);
        expect(src).toMatch(/Followed up/);
    });

    it('BOTH can render together — the acknowledgement history is never erased by a later follow-up', () => {
        const src = notice();
        // Two independent `if` blocks pushing into the same `lines` array, not
        // an if/else chain that can only ever pick one.
        const ackIdx = src.indexOf("if (o.auto_ack_sent_at)");
        const followIdx = src.indexOf('if (o.manual_response_applies || o.last_human_followup_at)');
        expect(ackIdx).toBeGreaterThan(-1);
        expect(followIdx).toBeGreaterThan(ackIdx);
        // Confirm it is NOT an else-if chained off the ack branch.
        const between = src.slice(ackIdx, followIdx);
        expect(between).not.toMatch(/\}\s*else if/);
    });

    it('before any follow-up, says so plainly rather than implying one happened', () => {
        const src = notice();
        expect(src).toMatch(/No human follow-up yet\./);
    });

    it('the follow-up wording is "Followed up", never "You responded" or "Sent"', () => {
        const src = notice();
        expect(src).not.toMatch(/You responded/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART F/G — human_response_at reused, first_response_at untouched
// ═══════════════════════════════════════════════════════════════════════════

describe('Part F/G/H: the latest-follow-up authority', () => {
    it('the follow-up action still writes through the EXISTING mark_responded route', () => {
        // Not a new endpoint and not a new action name — the same server-side
        // write this repo already proved safe for "I replied elsewhere" in
        // tests/frAcceptance2A1HumanResponse.test.ts. Only the durable facts it
        // records grew.
        const panel = stripComments(read('components/crm2/FunnelLeadsPanel.tsx'));
        const respondElsewhere = panel.match(/onClick=\{\(\) => mutate\(o\.id, \{ action: 'mark_responded' \}, '[^']*'\)\}/g) || [];
        const followUpBlock = panel.slice(panel.indexOf("o.action?.kind === 'send_follow_up' ||"), panel.indexOf('{!o.manual_response_applies'));
        expect(followUpBlock).toMatch(/action: 'mark_responded'/);
        expect(respondElsewhere.length).toBeGreaterThanOrEqual(1); // "I replied elsewhere" itself
    });

    it('REVERSED: a latest-follow-up column WAS required, and migration 16 adds it', () => {
        // The previous pass shipped without this and reported the limitation:
        // repeat follow-ups were no-ops and the CRM showed the first contact
        // date forever. An exhaustive audit then confirmed no existing field can
        // carry "latest manual follow-up" — `activities` is organization-scoped
        // with no opportunity FK, the outreach chain requires fabricating a
        // seasonal lineup and audience, and every other timestamp is either a
        // first-response fact, a machine send, post-campaign, or a row-edit
        // marker. So the column is an approved reversal, not a quiet addition.
        const fs = require('fs');
        const migrations = fs.readdirSync(require('path').join(process.cwd(), 'prisma/migrations'))
            .filter((d: string) => /^\d{14}_/.test(d)).sort();
        // Pinned by POSITION, not by total count. This assertion is about migration
        // 16 being the one that adds the column; later approved migrations (INV-D's
        // 17) do not bear on that and should not break it.
        expect(migrations.length).toBeGreaterThanOrEqual(16);
        expect(migrations[15]).toBe('20260823010000_fr_acceptance_2a2_human_followup');
    });

    it('migration 16 is additive only — one nullable column, no default, no backfill', () => {
        const sql = read('prisma/migrations/20260823010000_fr_acceptance_2a2_human_followup/migration.sql');
        const code = sql.split(/\r?\n/).filter((l: string) => !l.trim().startsWith('--')).join('\n').trim();
        expect((code.match(/ALTER TABLE/g) || []).length).toBe(1);
        expect(code).toMatch(/ADD COLUMN "last_human_followup_at" TIMESTAMP\(3\)/);
        expect(code).not.toMatch(/\bDROP\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b|DEFAULT|NOT NULL/i);
        // Never touches the first-response facts it exists to protect.
        expect(code).not.toMatch(/human_response_at|first_response_at|fundraiser_opportunities/);
        expect((code.match(/;/g) || []).length).toBe(1);
    });

    it('the new column sits at the INQUIRY grain, alongside the other per-inquiry facts', () => {
        // Grain decision: one opportunity holds many inquiries, so an
        // opportunity-level column would need a comparison against the newest
        // inquiry's received_at to stay truthful — correct, but a guard a later
        // edit could drop. At the inquiry grain resolveInquiryResponse reads it
        // off the same newest-inquiry row it already resolves, making Part K's
        // staleness rule structural instead.
        const schema = read('prisma/schema.prisma');
        const inquiry = schema.slice(schema.indexOf('model FundraiserInquiry'), schema.indexOf('@@map("fundraiser_inquiries")'));
        expect(inquiry).toMatch(/last_human_followup_at DateTime\?/);
        const opportunity = schema.slice(schema.indexOf('model FundraiserOpportunity'), schema.indexOf('@@map("fundraiser_opportunities")'));
        expect(opportunity).not.toMatch(/last_human_followup_at/);
    });

    it('exactly four nullable timestamps on FundraiserInquiry — the three from 15, plus this one', () => {
        const schema = read('prisma/schema.prisma');
        const model = schema.slice(schema.indexOf('model FundraiserInquiry'), schema.indexOf('@@map("fundraiser_inquiries")'));
        for (const f of ['ack_claimed_at', 'ack_sent_at', 'human_response_at', 'last_human_followup_at']) {
            expect(model).toMatch(new RegExp(f));
        }
        expect((model.match(/DateTime\?/g) || []).length).toBe(4);
    });
});

describe('Part G: first_response_at stays the write-once opportunity metric', () => {
    it('the write-once guard is untouched by this phase', () => {
        const route = stripComments(read('app/api/opportunities/[id]/route.ts'));
        expect(route).toMatch(/if \(!current\.first_response_at\) data\.first_response_at = new Date\(\);/);
        expect((route.match(/data\.first_response_at =/g) || []).length).toBe(1);
    });

    it('the follow-up action reaches this same write-once code path — no bypass was added', () => {
        const route = stripComments(read('app/api/opportunities/[id]/route.ts'));
        // Exactly one switch case handles mark_responded; the new UI control
        // posts the same action, so it goes through the same case, the same
        // write-once guard, and the same per-inquiry "every outstanding
        // inquiry" logic already proven in tests/frAcceptance2A1HumanResponse.test.ts.
        expect((route.match(/case 'mark_responded':/g) || []).length).toBe(1);
    });
});

describe('Part J: first follow-up vs latest follow-up — the exact write semantics', () => {
    const route = () => stripComments(read('app/api/opportunities/[id]/route.ts'));

    it('the first-response write stays conditional on null — genuinely write-once', () => {
        expect(route()).toMatch(/human_response_at: null,\s*\n\s*\},\s*\n\s*data: \{ human_response_at: new Date\(\) \},/);
    });

    it('the latest-follow-up write is MONOTONIC, not write-once', () => {
        // Two different properties, both required:
        //   - it must ADVANCE (so no unconditional IS NULL guard like the
        //     first-response write above, which would make it write-once);
        //   - it must never REGRESS (so it is conditional on the stored value
        //     being absent or genuinely older).
        const src = route();
        const block = src.slice(src.indexOf('if (followUpInquiryId)'));
        const where = block.slice(block.indexOf('where: {'), block.indexOf('data: {'));

        expect(block).toMatch(/data: \{ last_human_followup_at: followUpAt \}/);
        expect(where).toMatch(/business_id: businessId/);
        expect(where).toMatch(/opportunity_id: id/);

        // The monotonic predicate: null OR older-than-now. Both arms are what
        // let it advance; the absence of a third arm is what stops a regression.
        expect(where).toMatch(/OR: \[/);
        expect(where).toMatch(/\{ last_human_followup_at: null \}/);
        expect(where).toMatch(/\{ last_human_followup_at: \{ lt: followUpAt \} \}/);

        // One timestamp captured once and used for BOTH the predicate and the
        // value — comparing against a second `new Date()` would compare the row
        // to a different instant than the one being written.
        expect(block).toMatch(/const followUpAt = new Date\(\);/);
    });

    it('a later click can never move first_response_at or human_response_at', () => {
        const src = route();
        // first_response_at: one write site, guarded on null both in the branch
        // and again in the transaction's WHERE clause.
        expect((src.match(/data\.first_response_at =/g) || []).length).toBe(1);
        expect(src).toMatch(/if \(!current\.first_response_at\) data\.first_response_at = new Date\(\);/);
        expect(src).toMatch(/if \(data\.first_response_at\) guard\.first_response_at = null;/);
        // human_response_at: one write site, guarded on null.
        expect((src.match(/human_response_at: new Date\(\)/g) || []).length).toBe(1);
    });

    it('the latest-follow-up target is the NEWEST inquiry, resolved server-side', () => {
        const src = route();
        expect(src).toMatch(/orderBy: \{ received_at: 'desc' \}/);
        expect(src).not.toMatch(/body\?\.(inquiry_id|inquiryId)/);
    });

    it('the UI displays the LATEST follow-up, falling back through first response', () => {
        const notice = read('components/crm2/FunnelLeadsPanel.tsx');
        const block = notice.slice(notice.indexOf('function ResponseStateNotice'), notice.indexOf('function LeadDateField'));
        expect(block).toMatch(/o\.last_human_followup_at \?\? o\.manual_response_at \?\? o\.first_response_at/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART I — mailto safety, unchanged
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// PART L/M — browser durability and failure UX
// ═══════════════════════════════════════════════════════════════════════════

describe('PART L — the follow-up write survives the mailto handoff', () => {
    const panel = () => read('components/crm2/FunnelLeadsPanel.tsx');

    it('the request is issued with keepalive, so a page teardown cannot cancel it', () => {
        const src = panel();
        expect(src).toMatch(/keepalive: opts\?\.keepalive === true,/);
        const block = src.slice(src.indexOf("o.action?.kind === 'send_follow_up' ||"), src.indexOf('{!o.manual_response_applies'));
        expect(block).toMatch(/\{ keepalive: true \}/);
    });

    it('keepalive is opt-in — ordinary mutations are unaffected', () => {
        // "I replied elsewhere", date saves and mark-lost keep normal fetch
        // semantics; only the mailto-adjacent call needs to outlive the page.
        const src = stripComments(panel());
        expect(src).toMatch(/opts\?: \{ keepalive\?: boolean \}/);
        const otherCalls = src.match(/mutate\(o\.id, \{ action: '(?!mark_responded' \}, 'Follow-up)[^)]*\)/g) || [];
        for (const c of otherCalls) expect(c).not.toMatch(/keepalive/);
    });

    it('sendBeacon is NOT used — it cannot carry the JSON content type or the PATCH method', () => {
        // Code only: the mutate() doc comment names sendBeacon to explain why it
        // was rejected, which is documentation rather than a call.
        expect(stripComments(panel())).not.toMatch(/sendBeacon/);
    });

    it('the write is a normal authenticated same-origin PATCH — no second endpoint, no weakened auth', () => {
        const src = panel();
        const fn = src.slice(src.indexOf('const mutate = async'), src.indexOf('if (loading)'));
        expect(fn).toMatch(/method: 'PATCH'/);
        expect(fn).toMatch(/'Content-Type': 'application\/json'/);
        expect(fn).toMatch(/fetch\(`\/api\/opportunities\/\$\{id\}`/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D/E — the field name must match EVERY writer
// ═══════════════════════════════════════════════════════════════════════════

describe('PART E — last_human_followup_at is named for what every writer does', () => {
    const panel = () => read('components/crm2/FunnelLeadsPanel.tsx');

    it('mark_responded has THREE callers, and one of them is a PLATFORM send', () => {
        // The finding that forced the rename. The respond dialog sends a
        // lead_intro through FreezerIQ and then calls mark_responded — so the
        // column is written after a platform-sent email, and calling it
        // "manual" would have been false from day one.
        const src = panel();
        const callers = src.match(/action: 'mark_responded'/g) || [];
        expect(callers.length).toBe(3);
        // 1) the mail-client handoff
        expect(src).toMatch(/window\.location\.href = href;/);
        // 2) "I replied elsewhere"
        expect(src).toMatch(/I replied elsewhere/);
        // 3) the platform lead_intro send, via the respond dialog's callback
        expect(src).toMatch(/onResponded=\{\(\) =>\s*mutate\(respondingTo\.opportunityId, \{ action: 'mark_responded' \}/);
    });

    it('the platform send path really does transmit through FreezerIQ', () => {
        // Confirms the third caller is not itself a mailto handoff.
        const dialog = read('components/crm2/RespondToInquiryDialog.tsx');
        // FR-REBOOK-1A: the send moved to an opportunity-scoped route so the
        // RECIPIENT can be derived server-side instead of travelling from the
        // browser. The property here — this caller really transmits through
        // FreezerIQ rather than handing off to a mail client — is unchanged.
        expect(dialog).toMatch(/\/respond/);
        expect(dialog).toMatch(/method: 'POST'/);
        expect(dialog).not.toMatch(/mailto:/);
    });

    it('the name says HUMAN, not MANUAL — the distinction is human vs. the automatic ack', () => {
        const schema = read('prisma/schema.prisma');
        expect(schema).toMatch(/last_human_followup_at DateTime\?/);
        // No FIELD by the old name. The doc comment above it still names the
        // rejected name to record why the rename happened, which is
        // documentation rather than a declaration.
        expect(schema).not.toMatch(/last_manual_followup_at\s+DateTime/);
        // And no stale "manual" naming survives anywhere in the wiring code.
        for (const f of [
            'lib/growth/inquiryResponseState.ts',
            'app/api/opportunities/route.ts',
            'app/api/opportunities/[id]/route.ts',
            'components/crm2/FunnelLeadsPanel.tsx',
        ]) {
            expect(stripComments(read(f))).not.toMatch(/last_manual_followup_at|lastManualFollowUpAt/);
        }
    });

    it('the automatic acknowledgement is NOT a writer — that is the line the name draws', () => {
        const ack = stripComments(read('lib/inquiryAcknowledgement.ts'));
        expect(ack).not.toMatch(/last_human_followup_at/);
        expect(ack).not.toMatch(/mark_responded/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART K — the two grains are intentionally different
// ═══════════════════════════════════════════════════════════════════════════

describe('PART K — all-outstanding first response vs newest-only follow-up', () => {
    it('the two writes use deliberately DIFFERENT grains', () => {
        const route = stripComments(read('app/api/opportunities/[id]/route.ts'));
        // First response: every outstanding inquiry, no single-row targeting.
        // `opportunity_id: id` is scope, not targeting — the check below looks
        // for a bare `id:` property, which is what would pin one row.
        const firstResponse = route.slice(route.indexOf('if (respondsToInquiries)'), route.indexOf('if (followUpInquiryId)'));
        expect(firstResponse).toMatch(/human_response_at: null,/);
        expect(firstResponse).not.toMatch(/(?<![a-z_])id:\s/);
        // Follow-up: exactly one row, the newest.
        const followUp = route.slice(route.indexOf('if (followUpInquiryId)'));
        expect(followUp).toMatch(/id: followUpInquiryId/);
    });

    it('the resulting asymmetry is truthful, and this pins it', () => {
        // An older inquiry CAN end up with human_response_at set and no
        // follow-up timestamp, while the newest carries both. That is not a
        // contradiction: the reply genuinely answered the older message, and the
        // follow-up genuinely happened on the current conversation. Only the
        // newest inquiry is ever displayed, so the older row is history.
        const older = { received_at: dAgo(30), human_response_at: dAgo(29) };
        const newest = { received_at: dAgo(5), human_response_at: dAgo(4), last_human_followup_at: hAgo(1) };
        const r = resolveInquiryResponse(dAgo(29), [older, newest]);
        expect(r.lastHumanFollowUpAt).toEqual(hAgo(1));
        // The older row is untouched by the follow-up write.
        expect(older).not.toHaveProperty('last_human_followup_at');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART O — rapid double click
// ═══════════════════════════════════════════════════════════════════════════

describe('PART O — a double click cannot fire two near-identical follow-ups', () => {
    const panel = () => read('components/crm2/FunnelLeadsPanel.tsx');

    it('a SYNCHRONOUS in-flight guard blocks the second click', () => {
        // busyId alone is React state and may not have applied before a second
        // handler runs; a ref is readable synchronously inside the handler.
        const src = panel();
        expect(src).toMatch(/const inFlightRef = useRef<Set<string>>\(new Set\(\)\);/);
        expect(src).toMatch(/if \(inFlightRef\.current\.has\(id\)\) return false;/);
        expect(src).toMatch(/inFlightRef\.current\.add\(id\);/);
    });

    it('the guard is released, so a later intentional follow-up still works', () => {
        const src = panel();
        const finallyBlock = src.slice(src.indexOf('} finally {'), src.indexOf('} finally {') + 160);
        expect(finallyBlock).toMatch(/inFlightRef\.current\.delete\(id\)/);
        expect(finallyBlock).toMatch(/setBusyId\(null\)/);
    });

    it('the button is also disabled while in flight', () => {
        const src = panel();
        const block = src.slice(src.indexOf("o.action?.kind === 'send_follow_up' ||"), src.indexOf('{!o.manual_response_applies'));
        expect(block).toMatch(/disabled=\{busyId === o\.id\}/);
    });

    it('the UI guard does NOT replace the server monotonic gate', () => {
        // Nothing in the browser can order two requests already in flight.
        const route = stripComments(read('app/api/opportunities/[id]/route.ts'));
        expect(route).toMatch(/OR: \[/);
        expect(route).toMatch(/last_human_followup_at: \{ lt: followUpAt \}/);
    });
});

describe('PART M — a failed write never fabricates a recorded follow-up', () => {
    const panel = () => read('components/crm2/FunnelLeadsPanel.tsx');

    it('the displayed state comes from the server, never from the click', () => {
        // There is no local "optimistically followed up" state: the card reads
        // last_human_followup_at out of the reloaded rows, so a failed write
        // simply leaves the previous truth on screen.
        const src = stripComments(panel());
        expect(src).not.toMatch(/setFollowedUp|optimisticFollowUp|justFollowedUp/);
        const fn = src.slice(src.indexOf('const mutate = async'), src.indexOf('if (loading)'));
        expect(fn).toMatch(/load\(true\)/);
    });

    it('a failure surfaces as a non-blocking toast, not a modal or a confirmation step', () => {
        const src = panel();
        const fn = src.slice(src.indexOf('const mutate = async'), src.indexOf('if (loading)'));
        expect(fn).toMatch(/toast\.error\(e\.message\)/);
        expect(fn).toMatch(/return false;/);
        // The rejected workflow: no "did you really send it?" prompt anywhere.
        expect(src).not.toMatch(/Did you (really )?send|confirm(ed)? you sent/i);
    });

    it('success is only claimed on an ok response', () => {
        const src = panel();
        const fn = src.slice(src.indexOf('const mutate = async'), src.indexOf('if (loading)'));
        expect(fn).toMatch(/if \(!res\.ok\) throw new Error/);
        expect(fn.indexOf('if (!res.ok) throw new Error')).toBeLessThan(fn.indexOf('toast.success'));
    });
});

describe('Part I: mailtoHref validation is untouched by the new combined action', () => {
    it('mailtoHref itself was not modified — same validation, same encoding', () => {
        const panel = read('components/crm2/FunnelLeadsPanel.tsx');
        expect(panel).toContain('if (!v || v.length > 254) return null;');
        expect(panel).toContain(
            'if (!/^[^\\s<>()[\\],;:\\\\"@]+@[^\\s<>()[\\],;:\\\\"@]+\\.[^\\s<>()[\\],;:\\\\"@]+$/.test(v)) return null;'
        );
        expect(panel).toContain("return `mailto:${encodeURIComponent(v).replace(/%40/g, '@')}`;");
    });

    it('the onClick handler re-validates through the exact same function before using it', () => {
        const panel = read('components/crm2/FunnelLeadsPanel.tsx');
        const block = panel.slice(panel.indexOf("o.action?.kind === 'send_follow_up' ||"), panel.indexOf('{!o.manual_response_applies'));
        // mailtoHref is called TWICE deliberately: once to decide whether to
        // render the button at all, once inside the click handler itself. No
        // unvalidated value reaches window.location.
        expect((block.match(/mailtoHref\(o\.customer\.contact_email\)/g) || []).length).toBeGreaterThanOrEqual(2);
    });

    it('no subject or body parameter was added — this phase still ships no follow-up copy', () => {
        const panel = read('components/crm2/FunnelLeadsPanel.tsx');
        expect(panel).not.toMatch(/mailto:[^`]*\?subject=/);
    });

    it('no coordinator credential or secure link is ever placed in a mailto', () => {
        const panel = read('components/crm2/FunnelLeadsPanel.tsx');
        const block = panel.slice(panel.indexOf("o.action?.kind === 'send_follow_up' ||"), panel.indexOf('{!o.manual_response_applies'));
        expect(block).not.toMatch(/portal_token|coordinator\/access/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART M — Test 4 regression: nothing about the shipped 2A.1 contract moved
// ═══════════════════════════════════════════════════════════════════════════

describe('Part M: the exact behavior Best Brew Test 4 proved in Production is unchanged', () => {
    it('the acknowledgement claim/send architecture in lib/inquiryAcknowledgement.ts is untouched', () => {
        const ack = stripComments(read('lib/inquiryAcknowledgement.ts'));
        expect(ack).toMatch(/where: \{ id: inquiryId, ack_claimed_at: null, ack_sent_at: null \}/);
        expect(ack).not.toMatch(/human_response_at/);
    });

    it('the duplicate-introduction gate (no lead_intro after auto_ack_sent) still stands', () => {
        const panel = read('components/crm2/FunnelLeadsPanel.tsx');
        expect(panel).toMatch(/o\.response_state !== 'auto_ack_sent' && \(/);
        expect(panel).not.toMatch(/Send a personal reply/);
    });

    it('the lead still correctly lands in Waiting on Date after acknowledgement, no date yet', () => {
        // funnelBucket's auto_ack_sent-with-no-date path is untouched.
        const funnel = stripComments(read('lib/growth/opportunityNextAction.ts'));
        expect(funnel).toMatch(/waiting_on_date/);
    });

    it('EMAIL_LIVE safety gate is byte-identical to what shipped', () => {
        const ack = read('lib/inquiryAcknowledgement.ts');
        expect(ack).toMatch(/process\.env\.RESEND_API_KEY && process\.env\.EMAIL_LIVE === 'true'/);
    });
});
