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
import { SUPPORTER_ORDER_SELECT } from '@/lib/coordinatorSupporterOrders';
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
// COORD-FULFILLMENT-1: the campaign query became an explicit `select` allowlist
// (it was `include`, which shipped every scalar including portal_token), so this
// helper no longer anchors on `include: {`. It now brace-matches the orders
// sub-block, which is boundary-independent and cannot silently slice the wrong
// window if the surrounding comments change again.
function ordersSelectBlock(): string {
    const src = read(COORD_ROUTE);
    const start = src.indexOf('orders: {', src.indexOf('export async function GET'));
    if (start < 0) throw new Error('orders select block not found in ' + COORD_ROUTE);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces slicing the orders select block');
}

/** The whole GET handler, bounded by the next top-level export. */
function getHandler(): string {
    const src = read(COORD_ROUTE);
    const start = src.indexOf('export async function GET');
    const next = src.indexOf('export async function POST', start);
    return src.slice(start, next > start ? next : src.length);
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
        // Bounded by the handler itself rather than a character count, which a
        // added comment can silently push the assertion target out of.
        const getFn = getHandler();
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
    it('6/7/8/9/10. the shared supporter select carries customer_name, participant_name, created_at, and per-item quantity/variant_size/item_name', () => {
        // COORD-FULFILLMENT-2 moved this shape into
        // lib/coordinatorSupporterOrders.ts so the live tracker, the printable
        // pickup tracker and the XLSX sheet cannot describe a supporter
        // differently. Asserting the OBJECT is strictly stronger than the source
        // grep it replaces: it survives formatting, and a surface that forgets
        // to use it is caught by the companion test below.
        const sel: any = SUPPORTER_ORDER_SELECT;
        expect(sel.customer_name).toBe(true);
        expect(sel.participant_name).toBe(true);
        expect(sel.created_at).toBe(true);
        expect(sel.items.select.quantity).toBe(true);
        expect(sel.items.select.variant_size).toBe(true);
        expect(sel.items.select.item_name).toBe(true);
    });

    it('6/7/8/9/10. the coordinator GET actually USES that shared select', () => {
        expect(ordersSelectBlock()).toMatch(/select: SUPPORTER_ORDER_SELECT/);
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
describe('COORD-LIVE-TRACKER-1: privacy boundary — REVISED by COORD-FULFILLMENT-1', () => {
    // ─────────────────────────────────────────────────────────────────────
    // SUPERSEDED RULING. This block used to assert that the coordinator must
    // never receive supporter email or phone. That was the ruling at the time
    // and it is no longer the owner's contract: a coordinator running a
    // fundraiser has to be able to reach the people who ordered from it, and
    // the supporter-facing disclosure has always told buyers their name, email
    // and phone are shared with their fundraiser coordinator.
    //
    // The assertions are rewritten to the CURRENT ruling rather than deleted,
    // so the boundary that genuinely still holds — no home address, no
    // credential, no other campaign — stays enforced. The authorisation half is
    // proven behaviourally against the real handler in
    // tests/coordFulfillment1.test.ts; what remains here is the source-level
    // shape of the query.
    // ─────────────────────────────────────────────────────────────────────
    it('13/14/15. the shared supporter select DOES fetch supporter phone and the linked customer email', () => {
        const sel: any = SUPPORTER_ORDER_SELECT;
        expect(sel.phone).toBe(true);
        expect(sel.customer.select.contact_email).toBe(true);
    });

    it('13/14/15/16. the shared supporter select still excludes delivery_address and any processor/payment id', () => {
        // The one contact field still out of scope: fundraiser supporters are
        // not delivered to individually.
        const sel: any = SUPPORTER_ORDER_SELECT;
        expect(sel).not.toHaveProperty('delivery_address');
        expect(sel.customer.select).not.toHaveProperty('delivery_address');
        expect(sel).not.toHaveProperty('processor_payment_id');
        expect(sel).not.toHaveProperty('payment_processor');
        // And the route still says so in its own words.
        expect(read(COORD_ROUTE)).toMatch(/STILL EXCLUDES delivery_address/);
    });

    it('the campaign projection is an allowlist that never fetches portal_token', () => {
        const getFn = getHandler();
        expect(getFn).toMatch(/select:\s*\{/);
        expect(getFn).not.toMatch(/portal_token:\s*true/);
        // `include` on the campaign returns every scalar, which is how the
        // credential shipped in the first place.
        expect(getFn).not.toMatch(/findFirst\(\{[\s\S]{0,120}include:/);
    });

    it('RecentOrders renders contact as actionable links but still never reads an address or processor property', () => {
        const src = read(RECENT_ORDERS);
        expect(src).toMatch(/\.email\b/);
        expect(src).toMatch(/\.phone\b/);
        expect(src).toMatch(/mailto:/);
        expect(src).toMatch(/tel:/);
        // Checked as property-access patterns, not bare words, so the file's
        // own prose about the boundary cannot trip a false positive.
        expect(src).not.toMatch(/\.delivery_address|\.deliveryAddress/);
        expect(src).not.toMatch(/\.processor/i);
    });

    it('the top-level GET handler doc comment states the CURRENT contact scope', () => {
        const src = read(COORD_ROUTE);
        expect(src).toMatch(/THIS SESSION'S CAMPAIGN ONLY/);
        expect(src).toMatch(/Home address is never returned/);
        expect(src).toMatch(/never carries portal_token/);
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
