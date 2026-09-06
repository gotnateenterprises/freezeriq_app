
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// SEC-PUBLIC-ROUTE-1. This handler had no auth() call, and deductItem matched
// packaging rows with `contains` and NO business_id — so findFirst returned
// whichever tenant's row matched the hardcoded name first, platform-wide. That
// made it both an anonymous inventory-decrement primitive AND a live correctness
// bug: the legitimate print-batch flow could already be decrementing another
// tenant's stock. It also echoed the matched row's real name back in the
// response, leaking it.
//
// NOTE for whoever touches this next: after the tenant predicate, a tenant whose
// PackagingItem rows are named differently will now silently match nothing
// (deductItem returns quietly when item is null). Moving this matching off
// free-text `name` onto PackagingItem.type is a real follow-up, but it is a
// behaviour change, not a security fix, and is deliberately NOT bundled here.
//
// ══════════════════════════════════════════════════════════════════════════
// OPS-6B — THIS ROUTE NOW CONSUMES PAPER, AND NOTHING ELSE.
// ══════════════════════════════════════════════════════════════════════════
//
// It used to accept `largeBoxes`, `smallBoxes` and a whole `packaging` object
// straight from the request body and decrement tape, trays, lids and bags from
// those numbers. Every part of that was unsound:
//
//   - THE NUMBERS WERE THE CLIENT'S. Nothing recomputed them server-side, so a
//     browser could POST { largeBoxes: 9999 } and take 334 rolls of tape out of
//     a tenant's inventory. (A failing-first test proved exactly that.)
//   - THEY CAME FROM THE STALE BOX HEURISTIC, which counted purchased bundles
//     classified by a mutable `Bundle.serving_tier` — the same defect that made
//     the Delivery dashboard claim 49 boxes for a week that had 2.
//   - PRINTING IS REPEATABLE. Jams, reprints, a second copy for the van, or
//     simply reloading and re-confirming all decremented again, unbounded:
//     there was no job id, no dedupe and no state consulted. Consumption bound
//     to a repeatable act is wrong by construction.
//   - IT DID NOT MATCH PHYSICAL REALITY. Printing a label consumes a label
//     SHEET. It does not consume a tray, a lid, a bag, or tape.
//
// Box-derived consumption moved to app/api/delivery/handoff/route.ts, where it
// is computed server-side from the frozen OrderItem.variant_size of the orders
// actually released, and where a compare-and-set on a NULL
// `released_to_delivery_at` makes applying it twice impossible.
//
// Sheets stay here on purpose. A reprint genuinely does burn more paper, so
// this one remaining decrement is honestly non-idempotent rather than sloppily
// so — and it is the only thing this route still touches.
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        // Only `sheetsUsed` is read. Any largeBoxes/smallBoxes/packaging a
        // stale client still sends is IGNORED — deliberately not destructured,
        // so it cannot be reintroduced by accident.
        const { sheetsUsed } = await req.json();

        const sheets = typeof sheetsUsed === 'number' && Number.isFinite(sheetsUsed)
            ? Math.max(0, Math.floor(sheetsUsed))
            : 0;

        const deductedItems: any = {};

        // Deduct by partial name match, tenant-scoped, with a zero floor —
        // app/api/production/deduct/route.ts already sets that precedent
        // ("Prevent negative stock"); this route lacked it and negative stock
        // was reachable.
        const deductItem = async (partialName: string, qty: number) => {
            if (qty <= 0) return;
            const item = await prisma.packagingItem.findFirst({
                where: { business_id: businessId, name: { contains: partialName, mode: 'insensitive' } },
                orderBy: { name: 'asc' }
            });
            if (!item) return;

            const applied = Math.min(qty, item.quantity);
            if (applied > 0) {
                await prisma.packagingItem.update({
                    where: { id: item.id },
                    data: { quantity: Math.max(0, item.quantity - applied) }
                });
            }
            deductedItems[partialName] = { name: item.name, qty: applied };
        };

        await deductItem('Avery', sheets); // Label sheets — the one print consumable.

        return NextResponse.json({
            success: true,
            deducted: {
                sheets,
                details: deductedItems
            }
        });

    } catch (e: any) {
        console.error("Print Job Deduction Error");
        return NextResponse.json({ error: 'Failed to record the print job' }, { status: 500 });
    }
}
