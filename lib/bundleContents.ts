/**
 * BUNDLE-PERSISTENCE-FIX — the single authority that turns a submitted bundle
 * contents array into the exact set of rows that will be written.
 *
 * The defect this exists to prevent: create and import each resolved recipes
 * inside their write loop and guarded the insert with `if (recipeId)`, so an
 * entry that failed to resolve was skipped in silence and the caller still got
 * a success response. Import compounded it by deleting the existing contents
 * *before* that loop ran, so a five-recipe bundle whose payload named two
 * unmatchable recipes was left holding three rows with no error anywhere.
 * BUNDLE-AUDIT-1 found Production state consistent with exactly that: seven
 * sibling pairs with mismatched counts, one of them 5-versus-3.
 *
 * Resolution therefore happens up front and completely, against the database
 * but without touching it, so a caller either gets every row it asked for or
 * gets an error and no mutation at all. Callers are expected to run the
 * returned rows inside their own transaction.
 */

export class BundleContentsError extends Error {
    readonly status: number;

    /**
     * Discriminator. tsconfig targets ES5, and down-level emit breaks the
     * prototype chain for Error subclasses, so `instanceof` silently returns
     * false and a clean 422 degrades into an opaque 500. `setPrototypeOf`
     * below repairs that, and this flag means callers survive it either way.
     */
    readonly isBundleContentsError = true;

    constructor(message: string, status = 422) {
        super(message);
        Object.setPrototypeOf(this, BundleContentsError.prototype);
        this.name = 'BundleContentsError';
        this.status = status;
    }
}

/** Use this rather than `instanceof` — see the note above. */
export function isBundleContentsError(e: unknown): e is BundleContentsError {
    return (
        typeof e === 'object' && e !== null &&
        (e as { isBundleContentsError?: unknown }).isBundleContentsError === true
    );
}

/** A row ready to be written. `position` is dense and 0-based. */
export interface ResolvedBundleContent {
    recipe_id: string;
    position: number;
    quantity: number;
}

type RecipeRef = { sku?: string | null; name?: string | null } | null | undefined;

/**
 * The shapes the three callers actually send. The editor sends `recipe_id`;
 * exports nest the recipe under `child_recipe` (create) or `recipe` (import).
 */
export interface SubmittedBundleContent {
    recipe_id?: string | null;
    quantity?: unknown;
    child_recipe?: RecipeRef;
    recipe?: RecipeRef;
}

/** Only the two reads this module performs, so tests can pass a double. */
export interface RecipeReader {
    recipe: {
        findFirst(args: any): Promise<{ id: string } | null>;
        findMany(args: any): Promise<{ id: string }[]>;
    };
}

/**
 * Quantity is deliberately forgiving of a missing value (the editor defaults to
 * 1.0) but never of a nonsensical one — NaN, zero and negatives would otherwise
 * reach the database and silently distort costing.
 */
function normalizeQuantity(raw: unknown): number {
    const q = Number(raw);
    return Number.isFinite(q) && q > 0 ? q : 1;
}

function describe(item: SubmittedBundleContent, index: number): string {
    const ref = item.child_recipe ?? item.recipe;
    const label = item.recipe_id
        ? `recipe_id "${item.recipe_id}"`
        : ref?.sku
            ? `SKU "${ref.sku}"`
            : ref?.name
                ? `name "${ref.name}"`
                : 'no recipe reference';
    return `item ${index + 1} (${label})`;
}

/**
 * Resolve every submitted entry to an owned recipe, or throw.
 *
 * Guarantees, in order:
 *  1. every entry resolves — an unmatchable entry is an error, never a skip;
 *  2. every resolved recipe belongs to `businessId`;
 *  3. the resolved count matches the submitted count;
 *  4. duplicates collapse to one row with summed quantity (see PART D);
 *  5. positions are dense, 0-based and follow submission order.
 *
 * Performs reads only. The caller writes the result inside a transaction.
 */
export async function resolveBundleContents(
    db: RecipeReader,
    items: SubmittedBundleContent[],
    businessId: string,
): Promise<ResolvedBundleContent[]> {
    if (!Array.isArray(items)) {
        throw new BundleContentsError('Bundle contents must be an array.', 400);
    }
    if (items.length === 0) return [];

    // ---- 1. Resolve each entry, in submission order -----------------------
    const resolved: { recipe_id: string; quantity: number }[] = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i] ?? {};
        const ref = item.child_recipe ?? item.recipe;
        let recipeId: string | null =
            typeof item.recipe_id === 'string' && item.recipe_id.trim() ? item.recipe_id : null;

        // SKU is the portable identifier used by exports. Recipe.sku is globally
        // unique, so this lookup must stay scoped or it resolves across tenants.
        if (!recipeId && ref?.sku) {
            const bySku = await db.recipe.findFirst({
                where: { sku: ref.sku, business_id: businessId },
                select: { id: true },
            });
            if (bySku) recipeId = bySku.id;
        }

        if (!recipeId && ref?.name) {
            const byName = await db.recipe.findFirst({
                where: { name: ref.name, business_id: businessId },
                select: { id: true },
            });
            if (byName) recipeId = byName.id;
        }

        if (!recipeId) {
            // The whole point of this phase: this used to be `if (recipeId)`.
            throw new BundleContentsError(
                `Could not match ${describe(item, i)} to a recipe in this business. ` +
                `No changes were made.`,
            );
        }

        resolved.push({ recipe_id: recipeId, quantity: normalizeQuantity(item.quantity) });
    }

    // ---- 2. Ownership, in one query --------------------------------------
    // Entries resolved by SKU or name are already scoped, but an explicit
    // recipe_id from the client is not — and that is the path the editor uses.
    const distinctIds = [...new Set(resolved.map((r) => r.recipe_id))];
    const owned = await db.recipe.findMany({
        where: { id: { in: distinctIds }, business_id: businessId },
        select: { id: true },
    });

    if (owned.length !== distinctIds.length) {
        throw new BundleContentsError(
            'One or more recipes do not belong to this business. No changes were made.',
            403,
        );
    }

    // ---- 3. Count consistency --------------------------------------------
    // Redundant against step 1 by construction, and deliberately kept: it is the
    // assertion that fails loudly if a future edit reintroduces a skip.
    if (resolved.length !== items.length) {
        throw new BundleContentsError(
            `Expected ${items.length} recipes but resolved ${resolved.length}. No changes were made.`,
        );
    }

    // ---- 4. Canonical deduplication (PART D) ------------------------------
    // The recipe picker can append the same recipe twice and each row carries a
    // quantity, so two rows for one recipe means "two of it", not two
    // relationships. Merging here keeps that intent without relying on a
    // database unique constraint that does not exist.
    const merged = new Map<string, { recipe_id: string; quantity: number }>();
    for (const row of resolved) {
        const seen = merged.get(row.recipe_id);
        if (seen) seen.quantity += row.quantity;
        else merged.set(row.recipe_id, { ...row });
    }

    // ---- 5. Deterministic positions --------------------------------------
    return [...merged.values()].map((row, index) => ({
        recipe_id: row.recipe_id,
        position: index,
        quantity: row.quantity,
    }));
}
