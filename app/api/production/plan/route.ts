import { NextResponse } from 'next/server';
import { KitchenEngine } from '@/lib/kitchen_engine';
import { PrismaAdapter } from '@/lib/prisma_adapter';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { resolveVariantSize } from '@/lib/serving_multipliers';
import { planServingTier } from '@/lib/mealLabel';
import { ADD_ON_BUNDLE_TYPE, BUNDLE_TYPE_SELECT, normalizeBundleType } from '@/lib/campaignAddOns';
import { annotateAssemblyTasks, classifyPlanAssemblyRows, planHasAddOnLine } from '@/lib/planAddOnRows';

export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const requestBody = await request.json();

        if (
            !requestBody.use_live_orders && !requestBody.orders &&
            !requestBody.syncedOrders && !requestBody.manualOrders &&
            (!requestBody.bundle_id || !requestBody.quantity)
        ) {
            return NextResponse.json(
                { error: 'Missing orders array or legacy bundle_id/quantity' },
                { status: 400 }
            );
        }

        // Initialize Engine
        const db = new PrismaAdapter(session.user.businessId);
        const engine = new KitchenEngine(db);

        let orders = [];

        if (requestBody.use_live_orders) {
            // Fetch REAL orders from DB
            orders = await db.getProductionOrders();
        } else if (Array.isArray(requestBody.syncedOrders) || Array.isArray(requestBody.manualOrders) || Array.isArray(requestBody.orders)) {
            // OPS-4A — two distinct tier authorities, never conflated:
            //   syncedOrders: a real Auto-Synced order. OrderItem.variant_size is
            //     a frozen historical snapshot (docs/ai/FUNDRAISER_FULFILLMENT_
            //     CONTRACT.md §4) and is trusted exactly as OPS-4 shipped it —
            //     the Bundle table is never consulted for these lines.
            //   manualOrders: a hand-picked bundle_id + quantity with nothing
            //     sold behind it. There is no snapshot, so the tenant-scoped
            //     Bundle's OWN current serving_tier is the sole authority.
            //     A client-supplied variant_size/serving_tier on one of these
            //     lines is NEVER read — it cannot be spoofed, because the code
            //     below does not look at it.
            //   orders (legacy/unlabeled): treated as manual, the safe default
            //     when a caller's intent isn't declared.
            const syncedLines: any[] = Array.isArray(requestBody.syncedOrders) ? requestBody.syncedOrders : [];
            const manualLines: any[] = [
                ...(Array.isArray(requestBody.manualOrders) ? requestBody.manualOrders : []),
                ...(Array.isArray(requestBody.orders) ? requestBody.orders : []),
            ];

            const syncedResolved = syncedLines.map((o: any) => ({
                bundle_id: o.bundle_id,
                quantity: Number(o.quantity),
                variant_size: resolveVariantSize(o.variant_size ?? o.serving_tier ?? 'family')
            }));

            const manualBundleIds = [...new Set(manualLines.map((o: any) => o.bundle_id).filter(Boolean))];
            const manualBundles = manualBundleIds.length
                ? await prisma.bundle.findMany({
                    where: { id: { in: manualBundleIds }, business_id: session.user.businessId },
                    select: { id: true, serving_tier: true },
                })
                : [];
            const manualTierByBundleId = new Map(manualBundles.map((b) => [b.id, b.serving_tier]));

            const manualResolved = manualLines.map((o: any) => ({
                bundle_id: o.bundle_id,
                quantity: Number(o.quantity),
                variant_size: resolveVariantSize(manualTierByBundleId.get(o.bundle_id) ?? 'family')
            }));

            orders = [...syncedResolved, ...manualResolved];
        } else {
            // Legacy Single Mode (Simulator)
            // Resolve variant_size from request body; default to family (serves_5) if not supplied.
            orders = [{
                bundle_id: requestBody.bundle_id,
                quantity: Number(requestBody.quantity),
                variant_size: resolveVariantSize(requestBody.variant_size ?? requestBody.serving_tier ?? 'family')
            }];
        }

        const result = await engine.generateProductionRun(orders);

        // FR-SUPPORTER-ADDON-UPSELL-1 (S4): a campaign add-on line carries the stored
        // 'serves_5' snapshot, so the engine builds its recipes as Serves-5 rows. Mark
        // those rows (lib/planAddOnRows.ts) so a meal label says "Add-On", never
        // "Serves 5". Reads only each line's bundle TYPE and contents, tenant-scoped —
        // never its tier, which stays exactly as OPS-4/OPS-4A resolved it above. Labels
        // only: no quantity changes. Never blocks the plan: on failure the rows go out
        // unmarked, as before S4.
        let assemblyTasks = result.assemblyTasks;
        let mainLineSizes = orders.map((o: any) => o?.variant_size);
        let hasMixedAddOnRow = false;
        try {
            const planBundleIds = [...new Set(orders.map((o: any) => o?.bundle_id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))];
            const planBundles: any[] = planBundleIds.length
                ? await prisma.bundle.findMany({
                    where: { id: { in: planBundleIds }, business_id: session.user.businessId },
                    select: { id: true, ...BUNDLE_TYPE_SELECT, contents: { select: { recipe_id: true } } } as any,
                })
                : [];
            if (planHasAddOnLine(orders, planBundles ?? [])) {
                // Every line here already carries its resolved tier (an add-on line always
                // carries its stored 'serves_5'), so the rows' keys match the engine's.
                const kinds = classifyPlanAssemblyRows(orders, planBundles ?? []);
                assemblyTasks = annotateAssemblyTasks(result.assemblyTasks, kinds);
                hasMixedAddOnRow = [...kinds.values()].includes('mixed');
                const addOnIds = new Set((planBundles ?? []).filter((b: any) => normalizeBundleType(b.bundle_type) === ADD_ON_BUNDLE_TYPE).map((b: any) => b.id));
                mainLineSizes = orders.filter((o: any) => !addOnIds.has(o?.bundle_id)).map((o: any) => o?.variant_size);
            }
        } catch (addOnErr) {
            console.error('[campaign add-on] plan add-on row labels skipped:', addOnErr);
        }

        // OPS-5: expose the serving tier this plan can TRUTHFULLY claim, so the
        // meal-label path can consume an already-resolved authority instead of
        // inventing a third one.
        //
        // `orders` above already carries the authoritative per-line tier that
        // OPS-4/OPS-4A established: a sold line's frozen OrderItem.variant_size
        // snapshot, or a manual line's tenant-scoped Bundle.serving_tier. This
        // reads that same array - it re-derives nothing and queries nothing.
        //
        // planServingTier() returns null unless every line agrees, because
        // KitchenEngine's prepTasks (the source the print batch is built from)
        // are keyed by recipe name alone: a Serves-5 and a Serves-2 line for the
        // same recipe merge into ONE entry, after which no per-recipe tier is
        // recoverable. A null tier makes the label omit the claim rather than
        // guess. Purely additive - no existing field changes.
        //
        // FR-SUPPORTER-ADDON-UPSELL-1 (S4): measured over the MEAL lines only — an
        // add-on line's stored 'serves_5' is not a serving size — and withheld
        // entirely when a recipe row mixes add-on and meal food, since that row's
        // labels cannot then claim either.
        return NextResponse.json({
            ...result,
            assemblyTasks,
            servingTier: hasMixedAddOnRow ? null : planServingTier(mainLineSizes),
        });

    } catch (e: any) {
        console.error("Production Plan Error:", e);
        return NextResponse.json(
            {
                error: `Failed to generate production plan: ${e.message}`,
                details: e.stack,
                debug_orders: 'See server console'
            },
            { status: 500 }
        );
    }
}
