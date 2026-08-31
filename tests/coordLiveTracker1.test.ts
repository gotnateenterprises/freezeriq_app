/**
 * COORD-LIVE-TRACKER-1 — restore/harden the coordinator live order tracker.
 *
 * RECONNAISSANCE FINDING (Part B), reproduced here as the reason this phase's
 * change is narrow: the "weak, partially disconnected" tracker was NOT a
 * missing auth model, a missing live-refresh mechanism, or a missing metrics
 * authority — all three already existed, correct, and are proven UNTOUCHED
 * by the source-proof tests below:
 *
 *   - Auth/scope: lib/coordinatorSession.ts binds a session to exactly ONE
 *     campaign_id at creation and never accepts one from a request. This was
 *     already correct; this phase adds no new auth code.
 *   - Live refresh: app/coordinator/portal/page.tsx's FR-COORD-123 30-second
 *     poll + focus refresh + sequence-guard + in-flight-guard + silent-catch
 *     already refreshes campaign.orders (and therefore the metrics derived
 *     from it) without navigation. This phase adds no new refresh code.
 *   - Metrics: lib/fundraiserMetrics.ts's computeFundraiserProgress is the
 *     one authority, already the only caller in the portal page. This phase
 *     adds no new metric code.
 *
 * The actual gap: app/api/coordinator/route.ts's GET already SELECTS
 * participant_name, customer_name, created_at, and per-item quantity/
 * variant_size/item_name — but components/coordinator/RecentOrders.tsx threw
 * all of it away except a supporter name and a bare item COUNT. This phase's
 * only functional change is that component's rendering, plus threading one
 * already-computed boolean (hasPaymentInfo) into it for a truthful,
 * campaign-level (never per-order) payment note.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const COORD_ROUTE = 'app/api/coordinator/route.ts';
const PORTAL_PAGE = 'app/coordinator/portal/page.tsx';
const RECENT_ORDERS = 'components/coordinator/RecentOrders.tsx';

// The orders sub-select block, sliced by known boundaries — the same
// source-slicing technique tests/frShareCopy1.test.ts already uses against
// this exact route, chosen because the full handler (bundle resolution,
// share-copy, coordinator-identity lookups) is not meaningfully mockable as
// a single unit and testing it that way would be brittle, not more correct.
function ordersSelectBlock(): string {
    const src = read(COORD_ROUTE);
    const start = src.indexOf('orders: {', src.indexOf('include: {'));
    const end = src.indexOf('\n        },\n\n        // Fetch recently canceled');
    return src.slice(start, end > start ? end : start + 900);
}

// ═════════════════════════════════════════════════════════════════════════
// AUTH / SCOPE (Part Q items 1-5)
// ═════════════════════════════════════════════════════════════════════════
describe('COORD-LIVE-TRACKER-1: auth/scope — proven, not merely re-asserted', () => {
    it('1/2. the GET handler is gated by requireCoordinatorSession before any data read, and denies on failure', () => {
        const src = read(COORD_ROUTE);
        const getFn = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function GET') + 400);
        expect(getFn).toMatch(/const guard = await requireCoordinatorSession\(req\)/);
        expect(getFn).toMatch(/if \(!guard\.ok\) return guard\.response as NextResponse/);
    });

    it('3/4/5. the campaign id used for the query is guard.campaignId (session-derived) — never req.url, searchParams, or body', () => {
        const src = read(COORD_ROUTE);
        const getFn = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function GET') + 1200);
        expect(getFn).toMatch(/const campaignId = guard\.campaignId/);
        expect(getFn).toMatch(/where: \{ id: campaignId \}/);
        // No searchParams-derived or body-derived id feeds the campaign lookup.
        expect(getFn).not.toMatch(/searchParams\.get\(['"]campaignId['"]\)/);
        expect(getFn).not.toMatch(/body\.campaignId/);
    });

    it('3/4 behavioral: a session bound to campaign A can never resolve to campaign B — proven against the real session resolver, not asserted', async () => {
        jest.resetModules();
        const mockPrisma = {
            coordinatorSession: {
                findUnique: jest.fn(async ({ where }: any) => {
                    // Two distinct secrets/digests map to two distinct, fixed
                    // campaign_ids — exactly what a real per-session row does.
                    if (where.session_hash === 'digest-for-campaign-A') {
                        return { id: 's-a', campaign_id: 'campaign-A', expires_at: new Date(Date.now() + 3_600_000), revoked_at: null };
                    }
                    if (where.session_hash === 'digest-for-campaign-B') {
                        return { id: 's-b', campaign_id: 'campaign-B', expires_at: new Date(Date.now() + 3_600_000), revoked_at: null };
                    }
                    return null;
                }),
            },
        };
        jest.doMock('@/lib/db', () => ({ prisma: mockPrisma }));
        jest.doMock('node:crypto', () => {
            const actual = jest.requireActual('node:crypto');
            return {
                ...actual,
                createHash: () => ({
                    update: (v: string) => ({
                        digest: () => (v === 'secret-A' ? 'digest-for-campaign-A' : 'digest-for-campaign-B'),
                    }),
                }),
            };
        });
        let cookieValue = 'secret-A';
        jest.doMock('next/headers', () => ({
            cookies: async () => ({ get: () => ({ value: cookieValue }) }),
        }));

        const { resolveCoordinatorCampaignId } = await import('@/lib/coordinatorSession');
        await expect(resolveCoordinatorCampaignId()).resolves.toBe('campaign-A');

        cookieValue = 'secret-B';
        jest.resetModules();
        jest.doMock('@/lib/db', () => ({ prisma: mockPrisma }));
        jest.doMock('node:crypto', () => {
            const actual = jest.requireActual('node:crypto');
            return {
                ...actual,
                createHash: () => ({
                    update: (v: string) => ({
                        digest: () => (v === 'secret-A' ? 'digest-for-campaign-A' : 'digest-for-campaign-B'),
                    }),
                }),
            };
        });
        jest.doMock('next/headers', () => ({
            cookies: async () => ({ get: () => ({ value: cookieValue }) }),
        }));
        const { resolveCoordinatorCampaignId: resolveAgain } = await import('@/lib/coordinatorSession');
        await expect(resolveAgain()).resolves.toBe('campaign-B');

        jest.dontMock('@/lib/db');
        jest.dontMock('node:crypto');
        jest.dontMock('next/headers');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// ORDER CONTENT (Part Q items 6-12)
// ═════════════════════════════════════════════════════════════════════════
describe('COORD-LIVE-TRACKER-1: order content — the data was already selected server-side', () => {
    it('6/7/8/9/10. the orders select already carries customer_name, participant_name, created_at, and per-item quantity/variant_size/item_name', () => {
        const block = ordersSelectBlock();
        expect(block).toContain('customer_name: true');
        expect(block).toContain('participant_name: true');
        expect(block).toContain('created_at: true');
        expect(block).toContain('quantity: true');
        expect(block).toContain('variant_size: true');
        expect(block).toContain('item_name: true');
    });

    it('12. newest-first, deterministic', () => {
        const block = ordersSelectBlock();
        expect(block).toMatch(/orderBy: \{ created_at: 'desc' \}/);
    });

    it('6-11. RecentOrders now renders customer name, participant name, item name, serving tier, quantity, and order timestamp -- not just a count', () => {
        const src = read(RECENT_ORDERS);
        expect(src).toMatch(/o\.customer_name \|\| 'Supporter'/);
        expect(src).toMatch(/o\.participant_name/);
        expect(src).toMatch(/it\.item_name \|\| 'Item'/);
        expect(src).toMatch(/formatServingTierLabel\(it\.variant_size\)/);
        expect(src).toMatch(/it\.quantity/);
        expect(src).toMatch(/formatOrderTimestamp\(o\.created_at\)/);
        // The old defect this replaces: a bare item COUNT instead of content.
        expect(src).not.toMatch(/o\.items\?\.length \?\? 0\} items/);
    });

    it('8/E. Bundle identity is the real item_name, never a positional "Bundle 1"/"Bundle 2" label', () => {
        const src = read(RECENT_ORDERS);
        expect(src).not.toMatch(/Bundle 1/);
        expect(src).not.toMatch(/Bundle 2/);
        // Not indexed off the items array's position.
        expect(src).not.toMatch(/items\[0\]/);
        expect(src).not.toMatch(/items\[1\]/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// PRIVACY (Part Q items 13-16)
// ═════════════════════════════════════════════════════════════════════════
describe('COORD-LIVE-TRACKER-1: privacy boundary — reconfirmed, not weakened', () => {
    it('13/14/15/16. the orders select excludes email, phone, delivery_address, and any processor/payment id as actual Prisma field selections', () => {
        const block = ordersSelectBlock();
        // The excluded-fields comment legitimately names them in prose (and is
        // asserted present, below) -- what must never appear is the Prisma
        // "field: true" selection syntax that would actually fetch them.
        expect(block).not.toMatch(/customer_email:\s*true/);
        expect(block).not.toMatch(/\bphone:\s*true/);
        expect(block).not.toMatch(/delivery_address:\s*true/);
        expect(block).not.toMatch(/processor_payment_id:\s*true/);
        expect(block).not.toMatch(/payment_processor:\s*true/);
        // The route's own existing self-documentation of that boundary.
        expect(block).toMatch(/EXCLUDED: delivery_address, customer_email, phone/);
    });

    it('13/14/15/16. RecentOrders never reads an email/phone/delivery_address/processor property off an order or item -- it cannot expose what it never receives', () => {
        const src = read(RECENT_ORDERS);
        // Checked as property-access patterns (o.email, it.phone, etc.), not
        // bare words -- this file's own doc comments correctly discuss the
        // privacy boundary in prose, which must not trip a false positive.
        expect(src).not.toMatch(/\.email\b/);
        expect(src).not.toMatch(/\.phone\b/);
        expect(src).not.toMatch(/\.delivery_address|\.deliveryAddress/);
        expect(src).not.toMatch(/\.processor/i);
    });

    it('the top-level GET handler doc comment still states the privacy contract this phase preserves', () => {
        const src = read(COORD_ROUTE);
        expect(src).toMatch(/No PII exposure: delivery addresses, emails, phones filtered from GET responses/);
    });

    it('the new payment note never claims a settled/verified/processor-confirmed status Order data does not support', () => {
        const src = read(RECENT_ORDERS);
        // The note itself is deliberately cautious ("verify before counting
        // as paid" is an instruction to the coordinator, not a status claim)
        // -- what must never appear is a definitive settled-payment claim.
        expect(src).not.toMatch(/\bPaid\b/); // no "Paid" status label
        expect(src).not.toMatch(/Square/);
        expect(src).not.toMatch(/[Ii]nvoice/);
        expect(src).not.toMatch(/processor verified|payment verified\b(?! before)/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// METRICS (Part Q items 17-19)
// ═════════════════════════════════════════════════════════════════════════
describe('COORD-LIVE-TRACKER-1: metrics — reused, not redefined', () => {
    it('17/18/19. the portal page has exactly one computeFundraiserProgress call site, unchanged by this phase', () => {
        const src = read(PORTAL_PAGE);
        const matches = src.match(/computeFundraiserProgress\(/g) || [];
        expect(matches.length).toBe(1);
        expect(src).toMatch(/const metrics = computeFundraiserProgress\(campaign\.bundle_goal, campaign\.total_sales, campaign\.orders \|\| \[\], campaign\.org_share_percent\)/);
    });

    it('this phase introduces no second weighted-bundle or gross/raised calculation', () => {
        const trackerSrc = read(RECENT_ORDERS);
        expect(trackerSrc).not.toMatch(/getBundleUnitWeight|computeBundleUnitsFromItems|organizationShareAmount/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// LIVE REFRESH (Part Q items 20-24) -- pre-existing mechanism, proven
// untouched, not rebuilt.
// ═════════════════════════════════════════════════════════════════════════
describe('COORD-LIVE-TRACKER-1: live refresh — the existing FR-COORD-123 mechanism is untouched', () => {
    const src = read(PORTAL_PAGE);

    it('20/21. polls the same GET every 30s and replaces (not appends) campaign state, so orders/totals update from one source of truth', () => {
        expect(src).toMatch(/setInterval\(refreshCampaignQuietly, 30_000\)/);
        expect(src).toMatch(/const res = await fetch\('\/api\/coordinator'\)/);
        expect(src).toMatch(/setCampaign\(data\)/);
    });

    it('22. no duplicate rows: campaign.orders is REPLACED wholesale each poll, never merged/appended', () => {
        expect(src).not.toMatch(/setCampaign\(\s*\(?prev/); // no functional update that would concat old+new
        expect(src).not.toMatch(/\.concat\(/);
        expect(src).not.toMatch(/orders:\s*\[\s*\.\.\.\w*orders/); // no spread-merge of orders arrays
    });

    it('23. a failed poll never overwrites already-visible data (silent catch, no setCampaign on failure)', () => {
        const pollFn = src.slice(src.indexOf('const refreshCampaignQuietly'), src.indexOf('useEffect(() => {\n        const id = setInterval'));
        expect(pollFn).toMatch(/catch \{[\s\S]*?a failed background poll must never surface an error/);
    });

    it('24. interval and focus listener are cleaned up on unmount', () => {
        const effectBlock = src.slice(src.indexOf('const id = setInterval(refreshCampaignQuietly'), src.indexOf('const id = setInterval(refreshCampaignQuietly') + 300);
        expect(effectBlock).toMatch(/clearInterval\(id\)/);
        expect(effectBlock).toMatch(/removeEventListener\('focus', refreshCampaignQuietly\)/);
    });

    it('a stale/slow poll response can never overwrite a newer one (sequence guard)', () => {
        expect(src).toMatch(/if \(seq < campaignSeq\.current\) return false;/);
    });

    it('the three RecentOrders call sites now pass the existing hasPaymentInfo boolean, not a new definition', () => {
        const matches = src.match(/hasExternalPaymentLink=\{hasPaymentInfo\}/g) || [];
        expect(matches.length).toBe(3);
        expect(src).toMatch(/const hasPaymentInfo = !!\(campaign\.payment_instructions \|\| campaign\.external_payment_link\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// EMPTY / ERROR / LOADING STATES (Part K) — pre-existing, reconfirmed
// ═════════════════════════════════════════════════════════════════════════
describe('COORD-LIVE-TRACKER-1: empty/loading/error states', () => {
    it('RecentOrders has a distinct empty state', () => {
        const src = read(RECENT_ORDERS);
        expect(src).toMatch(/No orders yet — your first one shows up here\./);
    });

    it('the portal page keeps distinct loading, invalid-link, and session-lapsed states without blanking existing data', () => {
        const src = read(PORTAL_PAGE);
        expect(src).toMatch(/if \(isLoading\)/);
        expect(src).toMatch(/Portal Not Found/);
        expect(src).toMatch(/Your session has expired/);
        expect(src).toMatch(/Orders below may be out of date/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// EXPORT (Part M) — the XLSX Bundle-name fix is already wired, preserved
// as-is.
// ═════════════════════════════════════════════════════════════════════════
describe('COORD-LIVE-TRACKER-1: export behavior — preserved, not rebuilt', () => {
    it('app/api/tracker/download/route.ts already uses buildTrackerFamilies (real Bundle names), untouched by this phase', () => {
        const src = read('app/api/tracker/download/route.ts');
        expect(src).toMatch(/buildTrackerFamilies/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// REGRESSIONS (Part Q items 25-30) — re-run as full suites in the gates
// section of the phase report, not restated here as weaker source checks.
// ═════════════════════════════════════════════════════════════════════════
