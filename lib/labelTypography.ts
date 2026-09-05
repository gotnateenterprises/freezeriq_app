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
 *   compact      name 19pt / content 10pt   worst 2.05in   0.21in spare
 *
 * Even the tightest tier keeps a fifth of an inch in hand, and the slot's
 * own `overflow: hidden` remains the last-resort guard so a pathological
 * name can never bleed into the neighbouring sticker.
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
        compact: Object.freeze({ tier: 'compact', nameSizePt: 19, contentSizePt: 10 }),
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
