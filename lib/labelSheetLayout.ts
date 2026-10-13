/**
 * BOX-LABEL-SHEET-1 — the ONE OnlineLabels OL600 / OL600WX sheet authority.
 *
 * WHAT CHANGED, AND WHAT DID NOT
 *
 * Every phase up to OPS-6A.3 printed ONE physical box onto ONE 4x6 page. The
 * owner's real stock is OL600WX: 4" x 2.5" stickers, eight to a US Letter
 * sheet. So sixteen physical boxes must become two sheets, not sixteen pages.
 *
 * This module changes PAGINATION ONLY. It knows nothing about bundles, tiers,
 * supporters or packing, and it must never learn: the physical-box truth is
 * decided upstream by lib/physicalBoxPacking.ts and arrives here as an already
 * ordered list. One physical box is still exactly one sticker — this module
 * only decides which slot on which sheet that sticker lands in.
 *
 * MANUFACTURER GEOMETRY IS THE CONTRACT
 *
 * The numbers below are OnlineLabels' published OL600 template, not a
 * convenient approximation, and they close arithmetically in both axes:
 *
 *   width   0.18 + 4 + 0.14 + 4 + 0.18  = 8.50
 *   height  0.50 + (4 x 2.5) + 0.50     = 11.00
 *
 * They are asserted in tests precisely so a future "tidy up" cannot round
 * 0.18 to 0.25 or drop the 0.14 gutter and silently shift every sticker.
 *
 * A PRINTER CAVEAT WORTH KNOWING
 *
 * OnlineLabels warn that the 0.18" side margins can fall inside some
 * printers' non-printable area. The correct response is NOT to bend this
 * geometry to suit an unknown printer — that would misalign the stock for
 * everyone else. It is to print at 100% / Actual Size with browser margins
 * off, and to verify against real stock before committing labels. Any
 * printer-specific calibration is a separate, explicit concern.
 *
 * PURE BY CONSTRUCTION: no Prisma, no React, no I/O, no clock, no randomness.
 * That is what lets the screen preview, the printed sheet and the tests all
 * consume the same pagination instead of each deriving their own.
 *
 * PRODUCTION-LABEL-PRESETS-1 — MORE THAN ONE SHEET
 *
 * The functions below now take the sheet they lay out as an argument, and
 * default to OL600 so every existing caller keeps the exact output it had.
 * The geometry is still the only thing that varies: a sheet decides where a
 * sticker sits, never what is printed on it. Which sheets exist, and what
 * they are called, is lib/labelPresets.ts.
 */

/**
 * One manufacturer sheet template, in inches, measured from the true top-left
 * corner of the paper. Everything a renderer needs to place stickers on stock.
 *
 * `horizontalPitchIn` and `verticalPitchIn` are the label-origin-to-
 * label-origin distances, i.e. size + gap. They are stored rather than
 * recomputed so a test can pin them against the manufacturer's own figures.
 */
export interface LabelSheetGeometry {
    sheetWidthIn: number;
    sheetHeightIn: number;

    labelWidthIn: number;
    labelHeightIn: number;

    columns: number;
    rows: number;
    labelsPerSheet: number;

    marginTopIn: number;
    marginBottomIn: number;
    marginLeftIn: number;
    marginRightIn: number;

    horizontalGapIn: number;
    verticalGapIn: number;

    horizontalPitchIn: number;
    verticalPitchIn: number;

    /** The die-cut corner radius, or null when the manufacturer does not publish one. */
    cornerRadiusIn: number | null;

    orientation: 'portrait';
}

/**
 * The published OnlineLabels OL600 / OL600WX template, in inches.
 */
export const OL600_SHEET: Readonly<LabelSheetGeometry> = Object.freeze({
    sheetWidthIn: 8.5,
    sheetHeightIn: 11,

    labelWidthIn: 4,
    labelHeightIn: 2.5,

    columns: 2,
    rows: 4,
    labelsPerSheet: 8,

    marginTopIn: 0.5,
    marginBottomIn: 0.5,
    marginLeftIn: 0.18,
    marginRightIn: 0.18,

    horizontalGapIn: 0.14,
    verticalGapIn: 0,

    horizontalPitchIn: 4.14,
    verticalPitchIn: 2.5,

    cornerRadiusIn: 0.125,

    orientation: 'portrait',
});

/**
 * PRODUCTION-LABEL-PRESETS-1 — the Avery 5163 template: 2" x 4", ten to a US
 * Letter sheet. Avery 15513 (waterproof film) is printed on this template;
 * Avery lists 15513 among the products that use template 5163.
 *
 * Source: Microsoft Word's built-in Avery definition "5163 Shipping Labels"
 * (Avery US Letter), which is where Avery's own help tells customers to read a
 * template's margins and pitch. Word lays it out as a 0.5" top margin, two 4"
 * columns with a 0.1875" spacer, and five 2" rows. Word records the side
 * margin as 11.2pt (0.1556"), a rounding: with two 4" columns and the 0.1875"
 * spacer, the sheet only closes to 8.5" at 5/32" (0.15625"), the value used
 * here. The difference is 0.0007" — invisible to any printer.
 *
 *   width   0.15625 + 4 + 0.1875 + 4 + 0.15625 = 8.50
 *   height  0.5 + (5 x 2) + 0.5                 = 11.00
 *
 * Avery does not publish this sheet's corner radius, so none is invented: the
 * alignment test draws the bounding rectangle.
 */
export const AVERY_5163_SHEET: Readonly<LabelSheetGeometry> = Object.freeze({
    sheetWidthIn: 8.5,
    sheetHeightIn: 11,

    labelWidthIn: 4,
    labelHeightIn: 2,

    columns: 2,
    rows: 5,
    labelsPerSheet: 10,

    marginTopIn: 0.5,
    marginBottomIn: 0.5,
    marginLeftIn: 0.15625,
    marginRightIn: 0.15625,

    horizontalGapIn: 0.1875,
    verticalGapIn: 0,

    horizontalPitchIn: 4.1875,
    verticalPitchIn: 2,

    cornerRadiusIn: null,

    orientation: 'portrait',
});

/**
 * Why a sheet template cannot be printed on, or [] when it is sound.
 *
 * Every registered template is checked by tests today; the same check is what
 * a future tenant-entered template must pass before any renderer sees it.
 */
export function sheetGeometryProblems(sheet: LabelSheetGeometry): string[] {
    const problems: string[] = [];
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    const positive = ['sheetWidthIn', 'sheetHeightIn', 'labelWidthIn', 'labelHeightIn'] as const;
    for (const key of positive) {
        if (!(Number.isFinite(sheet[key]) && sheet[key] > 0)) problems.push(`${key} must be a positive number`);
    }
    if (!Number.isInteger(sheet.columns) || sheet.columns < 1) problems.push('columns must be a whole number of at least 1');
    if (!Number.isInteger(sheet.rows) || sheet.rows < 1) problems.push('rows must be a whole number of at least 1');
    if (sheet.labelsPerSheet !== sheet.columns * sheet.rows) problems.push('labelsPerSheet must equal columns x rows');
    if (!close(sheet.horizontalPitchIn, sheet.labelWidthIn + sheet.horizontalGapIn)) problems.push('horizontal pitch must equal label width + gap');
    if (!close(sheet.verticalPitchIn, sheet.labelHeightIn + sheet.verticalGapIn)) problems.push('vertical pitch must equal label height + gap');
    const width = sheet.marginLeftIn + sheet.columns * sheet.labelWidthIn
        + (sheet.columns - 1) * sheet.horizontalGapIn + sheet.marginRightIn;
    const height = sheet.marginTopIn + sheet.rows * sheet.labelHeightIn
        + (sheet.rows - 1) * sheet.verticalGapIn + sheet.marginBottomIn;
    if (!close(width, sheet.sheetWidthIn)) problems.push(`the columns and margins add up to ${width}in, not the ${sheet.sheetWidthIn}in sheet width`);
    if (!close(height, sheet.sheetHeightIn)) problems.push(`the rows and margins add up to ${height}in, not the ${sheet.sheetHeightIn}in sheet height`);
    return problems;
}

/**
 * Slot numbering, 1-based, reading order across then down:
 *
 *     1  2
 *     3  4
 *     5  6
 *     7  8
 *
 * This matches how a person reads a physical sheet and how OnlineLabels'
 * own template numbers its positions, so "start at position 4" means the
 * same thing to the operator holding the sheet as it does to this code.
 */
export const FIRST_SLOT = 1;
/** OL600's last slot. For any other sheet, use lastSlot(sheet). */
export const LAST_SLOT = OL600_SHEET.labelsPerSheet;

/** The last slot number on a sheet: 8 on OL600, 10 on Avery 5163. */
export function lastSlot(sheet: LabelSheetGeometry = OL600_SHEET): number {
    return sheet.labelsPerSheet;
}

/** Where one slot's top-left corner sits on the sheet, in inches. */
export function slotOrigin(
    position: number,
    sheet: LabelSheetGeometry = OL600_SHEET,
): { leftIn: number; topIn: number } {
    const index = position - 1;
    const col = index % sheet.columns;
    const row = Math.floor(index / sheet.columns);
    return {
        leftIn: sheet.marginLeftIn + col * sheet.horizontalPitchIn,
        topIn: sheet.marginTopIn + row * sheet.verticalPitchIn,
    };
}

/** One slot on a printed sheet. `label` is null for a deliberately blank slot. */
export interface LabelSlot<T> {
    /** 1..labelsPerSheet, in the reading order documented above. */
    position: number;
    leftIn: number;
    topIn: number;
    /** The physical box label occupying this slot, or null when blank. */
    label: T | null;
}

export interface LabelSheet<T> {
    /** 1-based sheet number, for "Sheet 2 of 3". */
    sheetNumber: number;
    /** Always exactly labelsPerSheet slots, blank ones included. */
    slots: LabelSlot<T>[];
}

/** Clamp an operator-supplied start position into the sheet's real slot range. */
export function normalizeStartPosition(value: unknown, sheet: LabelSheetGeometry = OL600_SHEET): number {
    const n = Number(value);
    const last = lastSlot(sheet);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return FIRST_SLOT;
    if (n < FIRST_SLOT) return FIRST_SLOT;
    if (n > last) return last;
    return n;
}

/**
 * Lay an ordered list of physical box labels onto sheets (OL600 by default).
 *
 * START POSITION — SAVING A PART-USED SHEET
 *
 * A sheet with its first three stickers already peeled off is still useful.
 * `startPosition` leaves that many slots blank on the FIRST sheet only;
 * every subsequent sheet starts at position 1, because those sheets are
 * fresh. So six labels starting at position 4 fill slots 4-8 of sheet one
 * and slot 1 of sheet two.
 *
 * This is PRINT PLACEMENT ONLY. It cannot change how many physical boxes
 * exist, what a box contains, or its "Box N of M" — those are decided by
 * lib/physicalBoxPacking.ts before anything reaches this function, and a
 * blank slot is simply an unused sticker, not a missing box.
 *
 * NOTHING IS LOST OR REPEATED: labels are consumed strictly in order, once
 * each, and the returned sheets always contain exactly the input labels.
 */
export function paginateLabelSheets<T>(
    labels: readonly T[],
    startPosition: number = FIRST_SLOT,
    sheet: LabelSheetGeometry = OL600_SHEET,
): LabelSheet<T>[] {
    const items = labels || [];
    if (items.length === 0) return [];

    const offset = normalizeStartPosition(startPosition, sheet) - 1;
    const perSheet = sheet.labelsPerSheet;

    // Blank lead-in slots occupy real space on the first sheet, so they count
    // toward how many sheets are needed.
    const totalSlots = offset + items.length;
    const sheetCount = Math.ceil(totalSlots / perSheet);

    const sheets: LabelSheet<T>[] = [];
    let next = 0;

    for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
        const slots: LabelSlot<T>[] = [];

        for (let position = FIRST_SLOT; position <= perSheet; position++) {
            const absoluteSlot = sheetIndex * perSheet + (position - 1);
            const { leftIn, topIn } = slotOrigin(position, sheet);

            // Blank while we are still inside the lead-in, or once the labels
            // have run out on the final sheet.
            const isLeadIn = absoluteSlot < offset;
            const label = !isLeadIn && next < items.length ? items[next++] : null;

            slots.push({ position, leftIn, topIn, label });
        }

        sheets.push({ sheetNumber: sheetIndex + 1, slots });
    }

    return sheets;
}

/** Every label actually placed, in sheet then slot order. Traceability. */
export function placedLabels<T>(sheets: readonly LabelSheet<T>[]): T[] {
    const out: T[] = [];
    for (const sheet of sheets || []) {
        for (const slot of sheet.slots) {
            if (slot.label !== null) out.push(slot.label);
        }
    }
    return out;
}

/** How many slots on a sheet are occupied. Used by the on-screen preview. */
export function occupiedSlotCount<T>(sheet: LabelSheet<T>): number {
    return sheet.slots.filter((s) => s.label !== null).length;
}
