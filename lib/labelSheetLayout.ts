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
 */

/**
 * The published OnlineLabels OL600 / OL600WX template, in inches.
 *
 * `horizontalPitchIn` and `verticalPitchIn` are the label-origin-to-
 * label-origin distances, i.e. size + gap. They are stored rather than
 * recomputed so a test can pin them against the manufacturer's own figures.
 */
export const OL600_SHEET = Object.freeze({
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
});

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
export const LAST_SLOT = OL600_SHEET.labelsPerSheet;

/** Where one slot's top-left corner sits on the sheet, in inches. */
export function slotOrigin(position: number): { leftIn: number; topIn: number } {
    const index = position - 1;
    const col = index % OL600_SHEET.columns;
    const row = Math.floor(index / OL600_SHEET.columns);
    return {
        leftIn: OL600_SHEET.marginLeftIn + col * OL600_SHEET.horizontalPitchIn,
        topIn: OL600_SHEET.marginTopIn + row * OL600_SHEET.verticalPitchIn,
    };
}

/** One slot on a printed sheet. `label` is null for a deliberately blank slot. */
export interface LabelSlot<T> {
    /** 1..8, in the reading order documented above. */
    position: number;
    leftIn: number;
    topIn: number;
    /** The physical box label occupying this slot, or null when blank. */
    label: T | null;
}

export interface LabelSheet<T> {
    /** 1-based sheet number, for "Sheet 2 of 3". */
    sheetNumber: number;
    /** Always exactly 8 slots, blank ones included. */
    slots: LabelSlot<T>[];
}

/** Clamp an operator-supplied start position into the real slot range. */
export function normalizeStartPosition(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return FIRST_SLOT;
    if (n < FIRST_SLOT) return FIRST_SLOT;
    if (n > LAST_SLOT) return LAST_SLOT;
    return n;
}

/**
 * Lay an ordered list of physical box labels onto OL600 sheets.
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
): LabelSheet<T>[] {
    const items = labels || [];
    if (items.length === 0) return [];

    const offset = normalizeStartPosition(startPosition) - 1;
    const perSheet = OL600_SHEET.labelsPerSheet;

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
            const { leftIn, topIn } = slotOrigin(position);

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
