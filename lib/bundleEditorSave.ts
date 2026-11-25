/**
 * BUNDLE-EDITOR-UX-1 — what "Save Bundle" sends, and how a NEW bundle gets its SKU.
 *
 * The API is unchanged: POST /api/bundles (new) and PUT /api/bundles/[id] (existing) receive the same form
 * values the editor always sent. The only addition is on the client, for NEW bundles:
 *
 *   - Bundle.sku is required (API + database) and unique across ALL tenants, but a tenant should never have
 *     to understand SKUs. When a new bundle is saved with no SKU, one is generated in the existing format
 *     with the neutral "OT" prefix (lib/bundleSkuGenerator.ts).
 *   - The database is the uniqueness authority. If a generated SKU happens to collide, the API answers 409
 *     "SKU must be unique" and nothing is written (the create is one transaction); a fresh SKU is generated
 *     and the save is retried, a bounded number of times.
 *   - A SKU the tenant TYPED is never replaced: a collision is reported so they can change it.
 *   - An EXISTING bundle's SKU is never generated or changed here — whatever the form holds is sent as-is
 *     (a Square POS mapping may depend on it).
 */
import { generateBundleSku } from './bundleSkuGenerator';

export const MAX_AUTO_SKU_ATTEMPTS = 5;
const DUPLICATE_SKU = /sku must be unique/i;

export type SaveBundleResult =
    | { ok: true; sku: string | null; autoSku: boolean; attempts: number }
    | { ok: false; error: string; status: number | null; skuProblem: boolean; attempts: number };

export async function saveBundle(input: {
    isNew: boolean;
    bundleId?: string | null;
    data: Record<string, unknown>;
    fetchImpl?: typeof fetch;
    random?: () => number;
}): Promise<SaveBundleResult> {
    const doFetch = input.fetchImpl ?? fetch;
    const url = input.isNew ? '/api/bundles' : `/api/bundles/${input.bundleId}`;
    const method = input.isNew ? 'POST' : 'PUT';

    const typed = typeof input.data.sku === 'string' ? input.data.sku.trim() : '';
    const autoSku = input.isNew && typed === '';
    const candidate = () => generateBundleSku({
        platform: 'other',
        servingTier: input.data.serving_tier,
        bundleType: input.data.bundle_type,
        random: input.random,
    });

    let attempts = 0;
    let payload: Record<string, unknown> = autoSku ? { ...input.data, sku: candidate() } : input.data;
    for (;;) {
        attempts++;
        let res: Response;
        try {
            res = await doFetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch {
            return { ok: false, error: 'Failed to save bundle.', status: null, skuProblem: false, attempts };
        }
        if (res.ok) {
            return { ok: true, sku: typeof payload.sku === 'string' ? payload.sku : null, autoSku, attempts };
        }
        const body: any = await res.json().catch(() => null);
        const error = typeof body?.error === 'string' && body.error ? body.error : 'Failed to save bundle.';
        const duplicateSku = res.status === 409 && DUPLICATE_SKU.test(error);
        if (duplicateSku && autoSku && attempts < MAX_AUTO_SKU_ATTEMPTS) {
            payload = { ...input.data, sku: candidate() };
            continue;
        }
        return { ok: false, error, status: res.status, skuProblem: duplicateSku || /\bsku\b/i.test(error), attempts };
    }
}
