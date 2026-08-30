/**
 * OPS-PRINT-QUEUE-HOTFIX-1 — the one decision Manual Planner's calculatePlan
 * needs to make about a /api/production/plan response.
 *
 * A plain module on purpose: components/production/ProductionCalculator.tsx
 * is a "use client" component that pulls in next-auth/react (an ESM-only
 * build Jest's default transform cannot parse), so anything defined inline
 * there is only provable by reading the source, never by executing it. This
 * lives here instead so the actual decision is directly testable.
 *
 * Before this existed, calculatePlan called setResult(data) on ANY response
 * that didn't itself throw — including a non-2xx one. A stale/expired
 * session (401) or a genuine server error has no `rawIngredients` key, so
 * storing it in `result` let the Shopping List section's own
 * `Object.values(result.rawIngredients)` throw on `undefined`, crashing the
 * whole results tree — Print button included — with no message at all. A
 * sibling function in the same component, syncOnlineOrders, already checks
 * `res.ok` before trusting its response; this gives calculatePlan the same
 * guarantee.
 */

export interface PlanResult {
    rawIngredients: Record<string, {
        qty: number;
        netQty: number;
        unit: string;
        onHand: number;
        costPerUnit: number;
        costUnit?: string;
        supplier?: string;
        supplierUrl?: string;
        portalType?: string;
        searchUrlPattern?: string;
        displayName?: string;
        purchaseCost?: number;
        purchaseUnit?: string;
        purchaseQuantity?: number;
    }>;
    prepTasks: Record<string, { qty: number; unit: string; id: string; label_text?: string }>;
    assemblyTasks: Record<string, { qty: number; unit: string }>;
}

export function interpretPlanResponse(
    res: { ok: boolean },
    data: any,
): { ok: true; result: PlanResult } | { ok: false; message: string } {
    if (!res.ok) {
        return { ok: false, message: (data && data.error) || 'Failed to calculate plan' };
    }
    return { ok: true, result: data };
}
