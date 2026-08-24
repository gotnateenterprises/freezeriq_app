/**
 * FR-ACCEPTANCE-2A.2 — the fundraiser lead signal on the dashboard a tenant
 * actually lands on.
 *
 * THE PRODUCTION FAILURE THIS SUITE EXISTS FOR
 *
 * The card shipped, passed every gate, and was invisible in Production. The
 * reason was not the card, the gate, the API or the data — all four were
 * correct. It was mounted in the wrong file.
 *
 * This repository has TWO near-duplicate dashboards:
 *
 *   app/page.tsx            serves "/"           <- where users land
 *   app/DashboardClient.tsx serves "/dashboard"  <- where the card was added
 *
 * next-auth redirects to "/" after login (auth.config.ts), and its authorized()
 * callback lists "/" first among dashboard paths. So the owner opened FreezerIQ,
 * landed on "/", and saw a dashboard that had never heard of the card.
 *
 * The previous test suite could not catch this: it asserted the card's own
 * behaviour and the gate expression, both of which were fine. Nothing asserted
 * WHERE it was mounted. So these tests are deliberately about the PARENT WIRING,
 * and they assert BOTH entry points — because the duplication is what made the
 * mistake invisible, and the duplication is still there.
 */

import { resolveInquiryResponse } from '@/lib/growth/inquiryResponseState';
import { triageOpportunity, funnelBucket } from '@/lib/growth/opportunityNextAction';

const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');

/** Every route that renders a tenant-facing main dashboard. */
const DASHBOARDS = [
    { route: '/', file: 'app/page.tsx' },
    { route: '/dashboard', file: 'app/DashboardClient.tsx' },
];

// ═══════════════════════════════════════════════════════════════════════════
// THE REGRESSION — both dashboards mount the card
// ═══════════════════════════════════════════════════════════════════════════

describe('the fundraiser lead signal is mounted on EVERY main dashboard', () => {
    it.each(DASHBOARDS)('$route ($file) renders FundraiserLeadAttentionCard', ({ file }) => {
        const src = stripComments(read(file));
        expect(src).toMatch(/<FundraiserLeadAttentionCard\s+hasAccess=\{hasFundraiserAccess\}\s*\/>/);
        expect(src).toMatch(/import \{ FundraiserLeadAttentionCard \} from '@\/components\/FundraiserLeadAttentionCard'/);
    });

    it('THE BUG: "/" is the dashboard users land on, and it was the one missing the card', () => {
        // Pins the reason the omission mattered, so a future reader knows which
        // of the two files is the one a tenant sees first.
        const authConfig = read('auth.config.ts');
        // Logged-in users hitting /login are redirected to "/".
        expect(authConfig).toMatch(/Response\.redirect\(new URL\('\/', nextUrl\)\)/);
        // And "/" is treated as a dashboard route by the authorization callback.
        expect(authConfig).toMatch(/nextUrl\.pathname === '\/'/);
    });

    it('the two dashboards remain near-duplicates, which is why both are asserted', () => {
        // If this ever fails because one was deleted or they were merged, the
        // duplication is gone and DASHBOARDS above should be updated — that is a
        // deliberate prompt to re-check, not a spurious failure.
        const root = read('app/page.tsx');
        const client = read('app/DashboardClient.tsx');
        for (const marker of ['Weekly In Progress', 'Production Demand', 'CalendarWidget', 'Food Cost']) {
            expect(root).toContain(marker);
            expect(client).toContain(marker);
        }
    });

    it('the card sits ABOVE the metrics row, inside the first viewport', () => {
        // Part G: discoverable on open, without displacing the KPI grid.
        for (const { file } of DASHBOARDS) {
            const src = read(file);
            const card = src.indexOf('<FundraiserLeadAttentionCard');
            const metrics = src.indexOf('{/* Metrics Row */}');
            expect(card).toBeGreaterThan(-1);
            expect(metrics).toBeGreaterThan(-1);
            expect(card).toBeLessThan(metrics);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCESS — one canonical contract across all three surfaces
// ═══════════════════════════════════════════════════════════════════════════

describe('the fundraiser access gate is the SAME contract everywhere', () => {
    /** Normalised access expression, so formatting differences do not register. */
    const gateOf = (file: string, varName: string) => {
        const src = stripComments(read(file));
        const m = new RegExp(`const ${varName} = ([\\s\\S]*?);`).exec(src);
        return m ? m[1].replace(/\s+/g, ' ').trim() : null;
    };

    it('all three surfaces allow exactly ENTERPRISE, ULTIMATE, FREE, or super admin', () => {
        const gates = [
            gateOf('app/page.tsx', 'hasFundraiserAccess'),
            gateOf('app/DashboardClient.tsx', 'hasFundraiserAccess'),
            gateOf('app/fundraisers/page.tsx', 'hasAccess'),
        ];
        for (const g of gates) {
            expect(g).not.toBeNull();
            for (const plan of ['ENTERPRISE', 'ULTIMATE', 'FREE']) expect(g).toContain(plan);
            expect(g).toMatch(/[sS]uperAdmin/);
        }
    });

    it('the dashboards are never STRICTER than the Fundraiser CRM itself', () => {
        // A stricter dashboard hides a lead the tenant could actually open — the
        // failure mode this check exists to prevent. Same three plans on all.
        const plansIn = (g: string | null) =>
            ['ENTERPRISE', 'ULTIMATE', 'FREE', 'BASE', 'PRO'].filter((p) => (g ?? '').includes(p)).sort();
        const crm = plansIn(gateOf('app/fundraisers/page.tsx', 'hasAccess'));
        expect(plansIn(gateOf('app/page.tsx', 'hasFundraiserAccess'))).toEqual(crm);
        expect(plansIn(gateOf('app/DashboardClient.tsx', 'hasFundraiserAccess'))).toEqual(crm);
    });

    it('"/" reads the LIVE session, so the super-admin tenant switcher is respected', async () => {
        // The switcher updates the JWT client-side. useSession() sees that; a
        // session captured once in a server component and passed as a prop
        // would not.
        const root = stripComments(read('app/page.tsx'));
        expect(root).toMatch(/useSession\(\)/);
        expect(root).toMatch(/session\?\.user\?\.plan/);

        // SEC-TENANT-1: this used to grep auth.config.ts for the literal string
        // `trigger === 'update' && session?.businessId` — which pinned the
        // cross-tenant vulnerability in place and would have blocked its fix.
        // The switcher's real requirement is BEHAVIOURAL: a super admin's
        // view-as update must move the effective tenant. Asserted as such, using
        // the server-signed grant the switch endpoint issues.
        process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-sec-tenant-1';
        const { authConfig } = await import('@/auth.config');
        const { signViewAsGrant, VIEW_AS_GRANT_TTL_SECONDS } = await import('@/lib/auth/viewAsGrant');

        const grant = await signViewAsGrant({
            sub: 'user-super', bid: 'biz-b', name: 'B', plan: 'ULTIMATE', status: 'active',
            exp: Math.floor(Date.now() / 1000) + VIEW_AS_GRANT_TTL_SECONDS,
        }, process.env.AUTH_SECRET as string);

        const token = await (authConfig.callbacks as any).jwt({
            token: { sub: 'user-super', businessId: 'biz-a', plan: 'FREE', isSuperAdmin: true, businessName: 'A' },
            trigger: 'update',
            session: { viewAsGrant: grant },
        });
        expect(token.businessId).toBe('biz-b');
        expect(token.plan).toBe('ULTIMATE');
    });

    it('the session actually carries plan and isSuperAdmin', async () => {
        // If either were absent the gate would silently evaluate false — which is
        // a plausible-looking alternative cause of the same symptom.
        const { authConfig } = await import('@/auth.config');
        const token = await (authConfig.callbacks as any).jwt({
            token: {},
            user: { role: 'ADMIN', permissions: null, businessId: 'biz-a', plan: 'ULTIMATE', isSuperAdmin: true },
        });
        expect(token.plan).toBe('ULTIMATE');
        expect(token.isSuperAdmin).toBe(true);

        const s = await (authConfig.callbacks as any).session({ session: { user: {} }, token });
        expect((s.user as any).plan).toBe('ULTIMATE');
        expect((s.user as any).isSuperAdmin).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// TENANT SAFETY
// ═══════════════════════════════════════════════════════════════════════════

describe('tenant isolation', () => {
    it('the card never sends a business id — the server derives it from the session', () => {
        const card = stripComments(read('components/FundraiserLeadAttentionCard.tsx'));
        expect(card).toMatch(/fetch\('\/api\/opportunities\?open=1'\)/);
        expect(card).not.toMatch(/business_?[Ii]d/);
    });

    it('the endpoint scopes to the session business and cannot be widened by a param', () => {
        const route = stripComments(read('app/api/opportunities/route.ts'));
        expect(route).toMatch(/if \(!session\?\.user\?\.businessId\)/);
        expect(route).toMatch(/business_id: businessId/);
        // The only query parameter it honours is `open`.
        const params = [...route.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]);
        expect(params).toEqual(['open']);
    });

    it('no dashboard surface counts opportunities globally', () => {
        for (const { file } of DASHBOARDS) {
            const src = stripComments(read(file));
            expect(src).not.toMatch(/prisma\./);
            expect(src).not.toMatch(/fundraiserOpportunity/);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE OWNER'S ACTUAL LEAD — executed against the real derivation
// ═══════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-08-23T22:00:00.000Z');
const hAgo = (h: number) => new Date(NOW.getTime() - h * 36e5);
const dAgo = (d: number) => new Date(NOW.getTime() - d * 864e5);

/** The card's visibility rule, mirrored so it can be executed here. */
const card = (rows: { priority: string }[]) => ({
    renders: rows.length > 0,
    active: rows.length,
    urgent: rows.filter((r) => r.priority === 'needs_attention').length,
});

describe('the live Best Brew Test 4 shape is surfaced', () => {
    // Exactly what Production holds today: one inquiry, acknowledgement accepted,
    // no human follow-up, no dates, well inside the escalation threshold.
    const test4 = {
        status: 'new',
        inquiries: [{ received_at: hAgo(6), ack_claimed_at: hAgo(6), ack_sent_at: hAgo(6) }],
    };

    it('derives the healthy, NON-urgent state', () => {
        const t = triageOpportunity(test4, NOW);
        const r = resolveInquiryResponse(null, test4.inquiries);
        expect(r.state).toBe('auto_ack_sent');
        expect(t.priority).toBe('on_pace');
        expect(funnelBucket(test4, NOW)).toBe('waiting_on_date');
        expect(t.action?.label).toBe('Waiting for preferred dates');
    });

    it('IS rendered — urgency does not gate visibility', () => {
        const v = card([{ priority: triageOpportunity(test4, NOW).priority }]);
        expect(v.renders).toBe(true);
        expect(v.active).toBe(1);
        expect(v.urgent).toBe(0);
    });

    it('an urgent lead renders AND is annotated', () => {
        const overdue = { status: 'new', inquiries: [{ received_at: hAgo(30) }] };
        expect(triageOpportunity(overdue, NOW).priority).toBe('needs_attention');
        const v = card([
            { priority: triageOpportunity(test4, NOW).priority },
            { priority: triageOpportunity(overdue, NOW).priority },
        ]);
        expect(v.active).toBe(2);
        expect(v.urgent).toBe(1);
    });

    it('zero active leads renders nothing', () => {
        expect(card([]).renders).toBe(false);
    });

    it('converted and lost are excluded at the source, so they can never be counted', () => {
        for (const status of ['converted', 'lost']) {
            const o = { status, inquiries: [{ received_at: dAgo(30) }] };
            expect(funnelBucket(o, NOW)).toBe('closed');
        }
        const funnel = stripComments(read('lib/fundraiserFunnel.ts'));
        expect(funnel).toMatch(/OPEN_OPPORTUNITY_STATUSES = \['new', 'in_conversation', 'date_confirmed'\]/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION + THE LEADS BADGE
// ═══════════════════════════════════════════════════════════════════════════

describe('navigation and the Fundraiser Dashboard badge', () => {
    it('the card links to the real Leads view, never /pipeline', () => {
        const src = read('components/FundraiserLeadAttentionCard.tsx');
        expect(src).toMatch(/LEADS_HREF = '\/fundraisers\?tab=leads'/);
        expect(src).not.toMatch(/(href|push)\s*[=(]\s*['"`]\/pipeline/);
    });

    it('/fundraisers honours ?tab=leads', () => {
        const page = read('app/fundraisers/page.tsx');
        expect(page).toMatch(/searchParams\.get\('tab'\)/);
        expect(page).toMatch(/TAB_KEYS as readonly string\[\]\)\.includes\(/);
    });

    it('the Leads badge is fed independently of the active tab', () => {
        // Unaffected by this patch, re-asserted because the same root cause class
        // (a signal wired into a surface nobody is looking at) applies.
        const page = stripComments(read('app/fundraisers/page.tsx'));
        expect(page).toMatch(/fetch\('\/api\/opportunities\?open=1'\)/);
        expect(page).toMatch(/leadsCount !== null && leadsCount > 0/);
        expect(page).toMatch(/onCountChange=\{setLeadsCount\}/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ACCEPTED 2A.2 STATE MODEL IS UNTOUCHED
// ═══════════════════════════════════════════════════════════════════════════

describe('this patch changed presentation only', () => {
    it('the three human-response facts are unchanged', () => {
        const route = stripComments(read('app/api/opportunities/[id]/route.ts'));
        expect(route).toMatch(/if \(!current\.first_response_at\) data\.first_response_at = new Date\(\);/);
        expect((route.match(/data\.first_response_at =/g) || []).length).toBe(1);
        expect((route.match(/human_response_at: new Date\(\)/g) || []).length).toBe(1);
        expect(route).toMatch(/last_human_followup_at: \{ lt: followUpAt \}/);
    });

    it('migration 16 is still the latest, and no migration 17 was added', () => {
        const migrations = require('fs')
            .readdirSync(require('path').join(process.cwd(), 'prisma/migrations'))
            .filter((d: string) => /^\d{14}_/.test(d)).sort();
        expect(migrations).toHaveLength(16);
        expect(migrations[15]).toBe('20260823010000_fr_acceptance_2a2_human_followup');
    });

    it('the acknowledgement and follow-up contracts are untouched', () => {
        const ack = stripComments(read('lib/inquiryAcknowledgement.ts'));
        expect(ack).toMatch(/where: \{ id: inquiryId, ack_claimed_at: null, ack_sent_at: null \}/);
        expect(ack).not.toMatch(/human_response_at|last_human_followup_at/);
        const panel = read('components/crm2/FunnelLeadsPanel.tsx');
        expect(panel).toMatch(/\{ keepalive: true \}/);
        expect(panel).toMatch(/✓ Followed up/);
    });
});
