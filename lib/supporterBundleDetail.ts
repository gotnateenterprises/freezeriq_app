/**
 * FR-SUPPORTER-ORDER-CONVERSION-1 — what a supporter is shown about the meals in a bundle.
 *
 * The public fundraiser page already receives each bundle's meals in `bundle.items[].recipe`, through
 * the include-list in lib/publicFundraiserPayload.ts (name, description, image_url, cook_time,
 * allergens). This module only READS that shape; it widens nothing and invents nothing:
 *
 *  - ORDER. The array arrives in the authoritative bundle order — the page query sorts
 *    bundle_contents by `position` (ASC NULLS LAST, the same rule the flyer and packet use), and
 *    `position` itself never crosses to the client. So the order of the array IS the order: nothing
 *    here sorts, and nothing may.
 *  - TEXT. Only the stored public description is shown. A missing, blank or literal "null" value
 *    yields null, and the caller renders nothing for it — never a placeholder, never generated copy.
 *  - NAMES. A trailing "(Serves 2)" on a meal name only repeats the bundle's own size, which the card
 *    and the detail already state, so it is dropped for display. Nothing else about a name changes,
 *    and a name that would become empty keeps its stored form.
 *
 * Pure and React-free so it can be tested directly.
 */
import { resolveVariantSize } from './serving_multipliers';
import { getBundleUnitWeight } from './fundraiserMetrics';

export interface SupporterMeal {
    /** The stored meal name, trimmed. */
    name: string;
    /** The name as shown to a supporter (a trailing serving-size note removed). */
    displayName: string;
    description: string | null;
    imageUrl: string | null;
    cookTime: string | null;
    allergens: string | null;
}

/** A stored text value worth showing, or null. Never the strings "null" / "undefined". */
export function publicText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const t = value.trim();
    if (t.length === 0) return null;
    if (/^(null|undefined)$/i.test(t)) return null;
    return t;
}

/** An image URL safe to put in <img src>: http(s), root-relative, or an inline image. Otherwise null. */
export function publicImageUrl(value: unknown): string | null {
    const t = publicText(value);
    if (!t) return null;
    if (/^https?:\/\//i.test(t) || /^\/(?!\/)/.test(t) || /^data:image\//i.test(t)) return t;
    return null;
}

const TRAILING_SERVING_NOTE = /\s*\(\s*serv(?:es|ing)\s*\d+\s*\)\s*$/i;

export function supporterMealDisplayName(name: string): string {
    const stripped = name.replace(TRAILING_SERVING_NOTE, '').trim();
    return stripped.length > 0 ? stripped : name.trim();
}

/**
 * The bundle's meals, in the order they arrived. Rows without a real name are skipped (a meal is
 * never shown as "Meal" or as an empty row); every other row is kept, including meals that have no
 * photo or no description.
 */
export function supporterBundleMeals(bundle: { items?: unknown } | null | undefined): SupporterMeal[] {
    const items = Array.isArray(bundle?.items) ? (bundle!.items as any[]) : [];
    const meals: SupporterMeal[] = [];
    for (const item of items) {
        const recipe = item?.recipe;
        const name = publicText(recipe?.name);
        if (!name) continue;
        meals.push({
            name,
            displayName: supporterMealDisplayName(name),
            description: publicText(recipe?.description),
            imageUrl: publicImageUrl(recipe?.image_url),
            cookTime: publicText(recipe?.cook_time),
            allergens: publicText(recipe?.allergens),
        });
    }
    return meals;
}

/**
 * The size label for one orderable bundle — the same resolver /api/public/order uses to record
 * order_items.variant_size, and the same expression the bundle card uses, so a card, its detail view
 * and the recorded order cannot disagree about which size this is.
 */
export function supporterServesLabel(servingTier: unknown): 'serves 5' | 'serves 2' {
    return resolveVariantSize(typeof servingTier === 'string' ? servingTier : null) === 'serves_5' ? 'serves 5' : 'serves 2';
}

/** "1 bundle" / "½ bundle": what one of this size adds to the fundraiser goal (fundraiserMetrics' weights). */
export function supporterGoalCredit(servingTier: unknown): string {
    const weight = getBundleUnitWeight(resolveVariantSize(typeof servingTier === 'string' ? servingTier : null));
    const whole = Math.floor(weight);
    const half = Math.abs(weight - whole - 0.5) < 1e-9;
    const amount = half ? (whole === 0 ? '½' : `${whole}½`) : String(whole);
    return `${amount} bundle${weight > 1 ? 's' : ''}`;
}
