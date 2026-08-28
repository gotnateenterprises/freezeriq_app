/**
 * FR-COORD-ORDER-TRACKER-1 — dynamic Bundle-family resolution for the
 * coordinator's downloadable Order Tracker XLSX.
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
 *
 * app/api/tracker/download/route.ts used to read a campaign's bundles through
 * resolveCampaignOrderMode()'s activeOrderableBundleIds — a FLAT, UNORDERED,
 * family-blind list (for a 2-family "selected" campaign this is 4 rows: both
 * serving tiers of both families, in whatever order Postgres happened to
 * return them) — and then indexed it positionally: bundles[0] -> "Bundle 1"
 * column, bundles[1] -> "Bundle 2" column. Nothing grouped by family_id or
 * filtered by serving_tier, so "Bundle 1"/"Bundle 2" could just as easily be
 * the SAME family's Serves-5 and Serves-2 (duplicating one menu into both
 * columns while silently dropping the other family) as two distinct menus.
 * That is the exact defect class lib/coordinatorMaterialBundles.ts was built
 * to close for the flyer/packet/promo-scripts materials — its own docstring
 * names "the tracker" as an intended consumer that was never wired up.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────
 *
 * Group by family_id (the structural CB-1 sibling key) BEFORE ever assigning
 * a "Bundle 1"/"Bundle 2" slot, mirroring the already-correct pattern in
 * app/api/campaigns/[id]/bundle-selection/route.ts (CB-6). Reuses
 * resolveMaterialBundles() for the SAME fail-closed price/tier validation the
 * flyer/packet/promo-scripts materials already trust — not a second pricing
 * system — and stripServingSuffix() for the SAME family-naming convention.
 */

import type { Worksheet } from 'exceljs';
import {
    resolveMaterialBundles,
    stripServingSuffix,
    type MaterialBundleRow,
    type MaterialBundlesResult,
} from '@/lib/coordinatorMaterialBundles';

/** A raw bundle row plus its resolved meal list — the caller does the Prisma fetch. */
export interface TrackerBundleRow extends MaterialBundleRow {
    /** Recipe/meal names for this specific bundle variant, position-ordered. */
    meals: string[];
}

export interface TrackerFamilyVariant {
    bundleId: string;
    price: number;
    meals: string[];
}

export interface TrackerFamily {
    /** The family's human-facing display name — the Serves-5 variant's own
     *  name, unmodified (the codebase-wide convention: "Family name = Serves
     *  5 name", also used by CB-6's bundle-selection route). */
    familyName: string;
    serves5: TrackerFamilyVariant | null;
    serves2: TrackerFamilyVariant | null;
}

export type TrackerFamiliesResult =
    | { ok: true; families: TrackerFamily[] }
    | Extract<MaterialBundlesResult, { ok: false }>;

/**
 * Groups validated bundle rows into one TrackerFamily per family_id (or, for
 * legacy rows that predate family_id, per serving-suffix-stripped name —
 * identical fallback key to groupMaterialMenus()), preserving the caller's
 * row order as the family display order (a JS Map keeps first-seen order).
 *
 * Fails closed via resolveMaterialBundles(): an unresolvable serving tier or
 * a missing/non-positive price refuses the WHOLE tracker with a named error,
 * rather than silently printing a wrong or blank price — the same contract
 * the flyer/packet/promo-scripts materials already rely on.
 */
export function buildTrackerFamilies(rows: readonly TrackerBundleRow[]): TrackerFamiliesResult {
    const resolved = resolveMaterialBundles(rows);
    if (!resolved.ok) return resolved;

    const mealsByBundleId = new Map(rows.map((r) => [r.id, r.meals]));
    const families = new Map<string, TrackerFamily>();

    for (const b of resolved.bundles) {
        const key = b.familyId ?? `name:${stripServingSuffix(b.name).toLowerCase()}`;
        let fam = families.get(key);
        if (!fam) {
            fam = { familyName: stripServingSuffix(b.name), serves5: null, serves2: null };
            families.set(key, fam);
        }

        const variant: TrackerFamilyVariant = {
            bundleId: b.id,
            price: b.price,
            meals: mealsByBundleId.get(b.id) ?? [],
        };

        if (b.servingTier === 'serves_2') {
            fam.serves2 = variant;
        } else {
            fam.serves5 = variant;
            // The family variant's name is the menu's name — its Serves-2
            // sibling carries the "(Serves 2)" suffix, never the heading.
            fam.familyName = stripServingSuffix(b.name);
        }
    }

    return { ok: true, families: Array.from(families.values()) };
}

/**
 * Truncates a family name to a clean WORD boundary — used only for the
 * narrow manual-order-log columns (D9/E9/F9/G9, ~8.5 characters wide). The
 * wide reference-area columns (B23/C23, ~26.5 characters wide) always get
 * the full, untruncated family name.
 */
export function shortFamilyLabel(name: string, maxLen = 14): string {
    const trimmed = name.trim();
    if (trimmed.length <= maxLen) return trimmed;

    const words = trimmed.split(/\s+/);
    let out = '';
    for (const w of words) {
        const next = out ? `${out} ${w}` : w;
        if (next.length > maxLen) break;
        out = next;
    }
    // A trailing standalone "-" (e.g. from "Name - Season Year" that fit up
    // to the dash but not beyond it) reads as a cut-off label, not a name.
    out = out.replace(/\s*-\s*$/, '').trim();
    return out || trimmed.slice(0, maxLen);
}

/**
 * Builds the row-9 manual-order-log label for one (family, tier) column.
 *
 * The tier's price banner (row 8, D8:E8 / F8:G8 — each ONE merged cell
 * shared by both families) can only ever show ONE number. When both
 * families share the same price for that tier — the common case — that
 * number lives in row 8 and this label stays short (just the family name +
 * tier). When they genuinely differ, row 8 can't truthfully show either
 * number, so THIS label carries the specific price instead — the per-column
 * truth is never lost, and D8/F8 never show a price that's wrong for one of
 * the two columns.
 */
function narrowTierLabel(familyName: string, tierSuffix: 'S5' | 'S2', price: number | null, uniform: boolean): string {
    const short = shortFamilyLabel(familyName);
    if (price !== null && !uniform) return `${short} ${tierSuffix} $${price.toFixed(2)}`;
    return `${short} ${tierSuffix}`;
}

export interface TrackerCampaignInfo {
    endDate: Date | null;
    payee: string | null;
}

/**
 * Populates every campaign-specific cell of the tracking_sheet.xlsx template
 * from the campaign's resolved families — at most the first two, matching
 * the template's fixed two-column layout (unchanged from before this fix:
 * a third+ selected family was, and remains, not representable in this
 * template without a broader redesign, deliberately out of scope here).
 *
 * A pure function over an already-loaded worksheet, so it can be exercised
 * directly in tests against the real template with no Prisma/session mocking.
 */
export function populateTrackerWorksheet(
    worksheet: Worksheet,
    families: readonly TrackerFamily[],
    campaign: TrackerCampaignInfo,
): void {
    // B4 — order deadline. Unchanged logic, relocated from the route.
    let formattedDeadline = '(Insert Date)';
    if (campaign.endDate) {
        formattedDeadline = campaign.endDate.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
    }
    const cellB4 = worksheet.getCell('B4');
    if (cellB4.value && typeof cellB4.value === 'string') {
        cellB4.value = cellB4.value.replace('(Insert Date)', formattedDeadline);
    } else {
        cellB4.value = `All orders and money must be submitted by your group's deadline: ${formattedDeadline}`;
    }

    // B5 — checks payable to. Unchanged logic, relocated from the route.
    const payee = campaign.payee || '_______________________';
    const cellB5 = worksheet.getCell('B5');
    if (cellB5.value && typeof cellB5.value === 'string') {
        cellB5.value = cellB5.value.replace('(insert pay to organization)', payee);
    } else {
        cellB5.value = `All checks should be made payable to:  ${payee}`;
    }

    const [famA, famB] = families;

    // Row 23 — reference-area family headers. Wide columns: full names, no
    // truncation. A missing second family clears the header rather than
    // leaving the template's stale generic "Bundle 2" text implying a menu
    // that was never selected.
    worksheet.getCell('B23').value = famA ? famA.familyName : '';
    worksheet.getCell('C23').value = famB ? famB.familyName : '';

    // Rows 24-28 — the canonical (Serves-5) meal list per family. Falls back
    // to the Serves-2 side only if a family somehow has no Serves-5 variant,
    // never the reverse — this is the exact fix for the reported defect
    // ("the lower/reference area appears to list Serves-2 ... information
    // where the actual selected family/base Bundle information should
    // appear").
    const mealsA = famA?.serves5?.meals ?? famA?.serves2?.meals ?? [];
    const mealsB = famB?.serves5?.meals ?? famB?.serves2?.meals ?? [];
    for (let i = 0; i < 5; i++) {
        worksheet.getCell(`B${24 + i}`).value = mealsA[i] || '';
        worksheet.getCell(`C${24 + i}`).value = mealsB[i] || '';
    }

    // Row 9 — narrow manual-order-log headers (D/E under the Serves-2 price
    // group, F/G under Serves-5). Each column belongs to exactly ONE family's
    // ONE tier — D9/F9 are always family A's, E9/G9 are always family B's,
    // proving the Serves-5/Serves-2 sibling pairing never crosses families.
    const s2PriceA = famA?.serves2?.price ?? null;
    const s2PriceB = famB?.serves2?.price ?? null;
    const s5PriceA = famA?.serves5?.price ?? null;
    const s5PriceB = famB?.serves5?.price ?? null;
    // With no second family there is nothing to disagree with — treat a
    // single family's own price as trivially "uniform" so row 8 still shows
    // the real number instead of falling back to the no-second-family case.
    const s2Uniform = famB ? (s2PriceA !== null && s2PriceA === s2PriceB) : s2PriceA !== null;
    const s5Uniform = famB ? (s5PriceA !== null && s5PriceA === s5PriceB) : s5PriceA !== null;

    worksheet.getCell('D9').value = famA ? narrowTierLabel(famA.familyName, 'S2', s2PriceA, s2Uniform) : '';
    worksheet.getCell('E9').value = famB ? narrowTierLabel(famB.familyName, 'S2', s2PriceB, s2Uniform) : '';
    worksheet.getCell('F9').value = famA ? narrowTierLabel(famA.familyName, 'S5', s5PriceA, s5Uniform) : '';
    worksheet.getCell('G9').value = famB ? narrowTierLabel(famB.familyName, 'S5', s5PriceB, s5Uniform) : '';

    // Row 8 — the merged per-tier price banners (D8:E8, F8:G8). Each spans
    // BOTH bundle columns, so it can only show a real, verified price when
    // both families genuinely share it; otherwise it stays generic rather
    // than showing a number that would be wrong for one of the two columns
    // (row 9 above already carries the specific number in that case).
    worksheet.getCell('D8').value = s2Uniform ? `Serves 2- $${s2PriceA!.toFixed(2)}` : 'Serves 2';
    worksheet.getCell('F8').value = s5Uniform ? `Serves 5- $${s5PriceA!.toFixed(2)}` : 'Serves 5';

    // I9 — "Total Cost" is a blank, hand-filled cell (no formula, no tax
    // computation anywhere in this workbook or in the real fundraiser order
    // flow — fundraiser supporter orders are never taxed). Labeled explicitly
    // so a coordinator computing this by hand never adds a tax that the real
    // checkout never charges.
    //
    // FR-TAX-1B REVIEWED AND DELIBERATELY UNCHANGED. That phase made the
    // ORGANIZATION's closeout invoice taxable, which raises the question of
    // whether "(No Tax)" is still honest here. It is: this sheet is a
    // per-SUPPORTER collection tally — one row per purchaser, no
    // organization-level settlement total anywhere on it — and supporters
    // remain untaxed. The organization's tax lives on its invoice, a
    // different document with its own Taxable Selling Price and Tax lines.
    // Adding organization-level tax to these supporter rows would be the
    // actively wrong change: it would tell a coordinator to collect money
    // from supporters that no supporter owes.
    worksheet.getCell('I9').value = 'Total Cost (No Tax)';
}
