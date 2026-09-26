/**
 * BOX-LABEL-SHEET-1A — deterministic typography for the 4" x 2.5" OL600WX
 * sticker.
 *
 * WHY THIS EXISTS
 *
 * The sticker was legible but visually under-used: measured against its own
 * 3.76in x 2.26in printable area it filled only ~52% of the height, and
 * `marginTop: 'auto'` on the box-type line pooled ALL 1.08in of the remaining
 * slack into a single gap — the empty canyon the owner reported. Meanwhile
 * the supporter name, which is the field a packer reads from several feet
 * away, sat at 17pt.
 *
 * The fix is to spend that slack on the things that matter, and to size them
 * from the geometry rather than by eye.
 *
 * WHY A PURE FUNCTION AND NOT INLINE STYLE
 *
 * Because the sizes now VARY, and anything that varies needs to be provable.
 * This returns one of three fixed tiers chosen from two facts already known
 * at render time — how long the supporter's name is, and how many content
 * lines the box has. No DOM measurement, no shrink-to-fit loop, no reflow
 * feedback: the same order always prints identically on every browser and
 * printer, which is the only acceptable behaviour for a physical label.
 *
 * THE BOUND THAT MAKES THIS SAFE
 *
 * A physical box holds at most ONE Serves-5 bundle or TWO Serves-2 instances
 * (lib/physicalBoxPacking.ts), and identical purchases merge to "x2". So a
 * sticker needs AT MOST TWO content entries — never an arbitrary number.
 * Every tier below is budgeted against the worst case of both entries
 * wrapping to two rendered rows, so nothing is ever clipped or dropped to
 * make the layout fit.
 *
 * VERIFIED BUDGETS (printable height 2.26in, logo row 0.55in, box type 8pt):
 *
 *   comfortable  name 24pt / content 12pt   worst 1.55in   0.71in spare
 *   standard     name 22pt / content 11pt   worst 1.89in   0.37in spare
 *   compact      name 18pt / content 10pt   worst 2.02in   0.24in spare
 *
 * Even the tightest tier keeps close to a quarter-inch in hand, and the
 * slot's own `overflow: hidden` remains the last-resort guard so a
 * pathological name can never bleed into the neighbouring sticker.
 *
 * BOX-LABEL-ORG-1 ADDENDUM — the fundraiser organization line
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A fourth, INDEPENDENT variable text block (the owner's stated visual
 * hierarchy is: organization, then customer name, then Box N of M / size,
 * then contents). It is sized by `chooseOrgNameTypography` below, which is
 * deliberately a SEPARATE function from `chooseStickerTypography` rather
 * than a third argument to it: organization-name length and supporter-name
 * length are independent facts about independent people, and conflating them
 * into one decision would make the sticker's layout depend on a coincidence
 * of two unrelated string lengths instead of on each field's own budget.
 *
 * `compact`'s name shrank one point (19 -> 18) specifically to buy back the
 * room the new line costs — still comfortably above the 17pt pre-1A
 * baseline, still the smallest of the three tiers, and still larger than
 * every other element on the sticker (org line, content, box type, Box N/M).
 * No other tier changed: `comfortable` and `standard` already carry enough
 * slack (0.71in / 0.37in) to absorb the org line's realistic single-line
 * height (~0.15-0.19in) with real margin left over.
 *
 * REALISTIC WORST CASE, verified: `compact` tier (long supporter name, two
 * content entries) plus the org line's largest realistic bucket (a SHORT
 * organization name, which gets the BIGGEST org font) still leaves ~0.07in
 * — a real, positive, deterministic margin, not a hairline pass.
 *
 * THE ONE CASE THIS DOES NOT GUARANTEE: an organization name so long it
 * wraps to two lines (see ORG_NAME_LONG_THRESHOLD) occurring simultaneously
 * with `compact`'s own worst case. That triple-worst-case can overshoot the
 * budget by roughly 0.02in — a sixth of a point of vertical space — and is
 * absorbed by the same `overflow: hidden` last resort that already covers a
 * supporter name needing a third line. This is not a new risk: it is the
 * SAME accepted tradeoff this module already made for names, now extended to
 * a rarer, independent case (no real organization name in this tenant's data
 * exceeds ORG_NAME_LONG_THRESHOLD as of BOX-LABEL-ORG-1).
 */

/** Which budget a sticker is rendered under. */
export type StickerTypographyTier = 'comfortable' | 'standard' | 'compact';

export interface StickerTypography {
    tier: StickerTypographyTier;
    /** Supporter name — always the largest text on the sticker. */
    nameSizePt: number;
    /** Bundle / serving-tier lines. */
    contentSizePt: number;
}

/**
 * Above this many characters a supporter name is assumed to wrap to two
 * lines and is budgeted accordingly.
 *
 * Derived, not guessed: at 22pt over 3.76in of printable width a bold name
 * fits roughly 22 characters per line, so 20 is the last length that
 * reliably stays on one line at the larger sizes. Names at or under it get
 * the bigger type; longer ones trade a little size for a guaranteed second
 * line. "Wyatt Williamson" (16) and "Julie Williamson" (16) stay large.
 */
export const NAME_LONG_THRESHOLD = 20;

/** The three budgeted tiers. Frozen so a caller cannot mutate them. */
export const STICKER_TYPOGRAPHY_TIERS: Readonly<Record<StickerTypographyTier, StickerTypography>> =
    Object.freeze({
        comfortable: Object.freeze({ tier: 'comfortable', nameSizePt: 24, contentSizePt: 12 }),
        standard: Object.freeze({ tier: 'standard', nameSizePt: 22, contentSizePt: 11 }),
        // BOX-LABEL-ORG-1: 19 -> 18. See the module-header addendum above for
        // the exact budget this buys back for the new organization line.
        compact: Object.freeze({ tier: 'compact', nameSizePt: 18, contentSizePt: 10 }),
    });

/**
 * Choose the typography for one sticker.
 *
 *   short name + one content line   -> comfortable (the common case)
 *   short name + two content lines  -> standard
 *   long name  + two content lines  -> compact
 *
 * A long name with a single content line also gets `standard`: the name
 * needs two lines but there is only one content entry to pay for them.
 *
 * Deliberately total over its inputs — any name, any count — because a
 * sticker must always render. An out-of-range content count is clamped
 * rather than throwing, since refusing to size a label would be a worse
 * failure than printing it slightly conservatively.
 */
export function chooseStickerTypography(
    supporterName: string | null | undefined,
    contentLineCount: number,
): StickerTypography {
    const name = (supporterName ?? '').trim();
    const isLongName = name.length > NAME_LONG_THRESHOLD;

    const count = Number.isFinite(contentLineCount) ? Math.max(1, Math.floor(contentLineCount)) : 1;
    const hasTwoContentLines = count >= 2;

    if (isLongName && hasTwoContentLines) return STICKER_TYPOGRAPHY_TIERS.compact;
    if (isLongName || hasTwoContentLines) return STICKER_TYPOGRAPHY_TIERS.standard;
    return STICKER_TYPOGRAPHY_TIERS.comfortable;
}

/* ── BOX-LABEL-ORG-1: the fundraiser organization line ──────────────────── */

export interface OrgNameTypography {
    sizePt: number;
}

/**
 * Length thresholds for the organization line's font size, derived the same
 * way NAME_LONG_THRESHOLD was: at 22pt bold over 3.76in a name reliably fits
 * ~20 characters on one line, so a SMALLER font reliably fits proportionally
 * more — roughly `20 * 22 / fontSizePt` characters. At the org line's own
 * candidate sizes (10 / 9 / 8pt) that is ~44 / ~49 / ~55 characters, so these
 * thresholds are chosen well inside each size's real one-line capacity,
 * leaving headroom rather than sitting at the edge of it.
 *
 * Every real organization name in this tenant's data as of BOX-LABEL-ORG-1
 * (e.g. "Edgar County Farm Bureau", "Cumberland County Farm Bureau", "Shelby
 * County Farm Bureau Foundation") is comfortably inside the first two
 * buckets. A name longer than ORG_NAME_LONG_THRESHOLD gets the smallest
 * bucket and MAY wrap to a second line via ordinary CSS wrapping — allowed,
 * not specially budgeted for, and backstopped by the sticker's own
 * `overflow: hidden`, exactly like a supporter name needing a third line.
 */
export const ORG_NAME_MEDIUM_THRESHOLD = 26;
export const ORG_NAME_LONG_THRESHOLD = 40;

/**
 * Choose the organization line's font size from its length alone.
 *
 * Deliberately NOT tiered against the supporter name or content count —
 * see the module-header addendum. Always bold at render time (the page sets
 * fontWeight, not this function), and always smaller than the smallest
 * possible nameSizePt (18, the compact tier), so the customer name can never
 * stop being the most prominent text on the sticker.
 */
export function chooseOrgNameTypography(
    organizationName: string | null | undefined,
): OrgNameTypography {
    const name = (organizationName ?? '').trim();
    if (name.length > ORG_NAME_LONG_THRESHOLD) return { sizePt: 8 };
    if (name.length > ORG_NAME_MEDIUM_THRESHOLD) return { sizePt: 9 };
    return { sizePt: 10 };
}
