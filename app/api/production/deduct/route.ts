
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { convertUnit } from '@/lib/unit_converter';

// SEC-PUBLIC-ROUTE-1. This handler had no auth() call and neither lookup carried
// business_id, so an anonymous POST with a plausible ingredient NAME could zero
// out another tenant's stock — no UUID needed. Submitting qty:0 also turned it
// into a lossless read oracle for any tenant's inventory levels, because the
// response echoes `previous` and `unit` from the matched row.
//
// KEEP + AUTHENTICATE, not retire. This route has zero in-repo callers today,
// and docs/ai/KITCHEN_DELIVERY_HANDOFF.md:239 proposes archiving it — but that
// line is a hedged proposal inside an unbuilt phase (it says "re-verify with
// grep first"), and the repository's root commit is a squash that already
// contains this file, so git can prove "no in-repo caller since 2026-01-29" but
// is structurally incapable of proving "no caller ever". The name-keyed payload
// with an optional id, caller-supplied units, and a human-readable per-item
// report is the shape of something driven from outside the React app. Retiring
// on that evidence would trade a certain cheap fix for an unverified assumption
// and give any real caller a silent 404 instead of a diagnosable 401.
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const body = await req.json();
        // Array of { name: 'Ground Beef', qty: 10, unit: 'lb' }
        const { ingredients } = body;

        if (!ingredients || !Array.isArray(ingredients)) {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        const results = [];

        // Transaction is safer but lets do simple loop for speed/errors
        for (const item of ingredients) {
            let dbItem;

            if (item.id) {
                // Precise lookup by ID, scoped to this tenant (findFirst, not
                // findUnique, so business_id can participate in the where clause).
                dbItem = await prisma.ingredient.findFirst({
                    where: { id: item.id, business_id: businessId }
                });
            } else {
                // Fallback: Find by name (case insensitive), within this tenant only.
                // orderBy makes the winner deterministic when a tenant has duplicates.
                dbItem = await prisma.ingredient.findFirst({
                    where: { name: { equals: item.name, mode: 'insensitive' }, business_id: businessId },
                    orderBy: { name: 'asc' }
                });
            }

            if (dbItem) {
                // Normalize Quantity
                let deductionQty = Number(item.qty);

                // Attempt conversion if units mismatch
                if (item.unit && dbItem.unit && item.unit.toLowerCase() !== dbItem.unit.toLowerCase()) {
                    deductionQty = convertUnit(Number(item.qty), item.unit, dbItem.unit);

                    // Safety Check: If conversion failed (returned same qty) but units are definitely different,
                    // we might want to flag this. For MVP, we proceed but maybe we'll add a 'warning' status.
                }

                const newStock = Math.max(0, Number(dbItem.stock_quantity) - deductionQty); // Prevent negative stock

                await prisma.ingredient.update({
                    where: { id: dbItem.id },
                    data: { stock_quantity: newStock }
                });

                results.push({
                    name: item.name,
                    status: 'deducted',
                    previous: Number(dbItem.stock_quantity),
                    deducted: deductionQty,
                    remaining: newStock,
                    unit: dbItem.unit
                });
            } else {
                results.push({ name: item.name, status: 'not_found' });
            }
        }

        return NextResponse.json({ success: true, results });

    } catch (e) {
        console.error("Depletion Error:", e);
        return NextResponse.json({ error: "Failed to deduct stock" }, { status: 500 });
    }
}
