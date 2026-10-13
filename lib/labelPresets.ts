/**
 * PRODUCTION-LABEL-PRESETS-1 — the label stock FreezerIQ can print box labels on.
 *
 * A preset is a NAMED SHEET: which manufacturer product it is, what the operator
 * loads into the printer, the sheet geometry (lib/labelSheetLayout.ts) and the
 * text sizes budgeted for that label size (lib/labelTypography.ts). That is all
 * it is. It never decides what a label SAYS: the content of every box label —
 * organization, customer, Box N of M, LARGE/SMALL, bundles — comes from the
 * same server-resolved physical boxes (/api/production/box-labels ->
 * lib/physicalBoxPacking.ts) whichever preset is chosen, so switching stock can
 * move a sticker but can never add, drop or change a box.
 *
 * WHY CODE AND NOT THE DATABASE
 *
 * Two known products today, both verified against their manufacturer's
 * template. A frozen registry is deterministic, needs no lookup at print time
 * and cannot be edited into a broken sheet. The seam for later (tenant-entered
 * templates, more known catalog entries such as 'avery-5163' or
 * 'onlinelabels-xxxx') is this same LabelPreset shape: anything that produces
 * one — after passing sheetGeometryProblems() — prints through the same
 * renderer without touching it.
 *
 * NOTHING OUTSIDE THE REGISTRY IS EVER INTERPRETED
 *
 * resolveLabelPreset() accepts a preset id and returns the registry's own
 * frozen entry, or null. It never builds a preset from caller-supplied
 * dimensions, CSS or text, so an unknown or hostile id is refused rather than
 * guessed at.
 *
 * PURE: no React, no Prisma, no I/O.
 */
import { OL600_SHEET, AVERY_5163_SHEET, type LabelSheetGeometry } from './labelSheetLayout';
import { STICKER_FACES, type StickerFace } from './labelTypography';

export const LABEL_PRESET_IDS = ['onlinelabels-ol600wx', 'avery-15513'] as const;
export type LabelPresetId = (typeof LABEL_PRESET_IDS)[number];

export interface LabelPreset {
    id: LabelPresetId;
    /** The selector's option text. */
    displayName: string;
    /** One line under the selector: size, count and, where known, printer and material. */
    helperText: string;
    /** What the operator loads, as printed in the "Before printing" instructions. */
    stockName: string;
    manufacturer: string;
    model: string;
    /** The manufacturer template the geometry comes from. */
    templateFamily: string;
    /** Null when FreezerIQ has no record of it — never guessed. */
    materialLabel: string | null;
    /** Null when FreezerIQ has no record of it — never guessed. Informational only: nothing is blocked on it. */
    printerType: 'laser' | null;
    shape: 'rectangle';
    geometry: Readonly<LabelSheetGeometry>;
    face: StickerFace;
}

/**
 * The stock FreezerIQ has printed box labels on since BOX-LABEL-SHEET-1. Its
 * model is recorded in that phase's code and the owner's alignment test; its
 * material and printer type never were, so they stay null.
 */
const OL600WX_CURRENT: LabelPreset = Object.freeze({
    id: 'onlinelabels-ol600wx',
    displayName: 'OnlineLabels OL600WX — Current',
    helperText: '4" × 2.5" • 8 per sheet',
    stockName: 'OnlineLabels OL600 / OL600WX',
    manufacturer: 'OnlineLabels',
    model: 'OL600WX',
    templateFamily: 'OnlineLabels OL600 (4" × 2.5", 8 per sheet)',
    materialLabel: null,
    printerType: null,
    shape: 'rectangle',
    geometry: OL600_SHEET,
    face: STICKER_FACES['4x2.5'],
});

/**
 * Avery 15513 — 2" x 4" waterproof matte-white film, laser only, 10 per US
 * Letter sheet, on Avery's 5163 template (Avery lists 15513 among 5163's
 * products). Geometry: AVERY_5163_SHEET.
 */
const AVERY_15513: LabelPreset = Object.freeze({
    id: 'avery-15513',
    displayName: 'Waterproof Film — Avery 15513',
    helperText: 'Laser printer • Waterproof film • 2" × 4" • 10 per sheet',
    stockName: 'Avery 15513',
    manufacturer: 'Avery',
    model: '15513',
    templateFamily: 'Avery 5163 (2" × 4", 10 per sheet)',
    materialLabel: 'Waterproof matte-white film',
    printerType: 'laser',
    shape: 'rectangle',
    geometry: AVERY_5163_SHEET,
    face: STICKER_FACES['4x2'],
});

/** Every preset the selector offers, in the order it offers them. */
export const LABEL_PRESETS: readonly LabelPreset[] = Object.freeze([OL600WX_CURRENT, AVERY_15513]);

/** Doing nothing prints exactly what was printed before this phase. */
export const DEFAULT_LABEL_PRESET: LabelPreset = OL600WX_CURRENT;
export const DEFAULT_LABEL_PRESET_ID: LabelPresetId = OL600WX_CURRENT.id;

/** The registry's own entry for this id, or null for anything else. */
export function resolveLabelPreset(id: unknown): LabelPreset | null {
    if (typeof id !== 'string') return null;
    return LABEL_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** "US Letter 8.5 × 11" for Letter stock; otherwise the plain size. */
export function describePaper(geometry: LabelSheetGeometry): string {
    if (geometry.sheetWidthIn === 8.5 && geometry.sheetHeightIn === 11) return 'US Letter 8.5 × 11';
    return `${geometry.sheetWidthIn} × ${geometry.sheetHeightIn} in`;
}

/** An inch figure as the printing instructions show it: 0.18 -> "0.18", 0.15625 -> "0.16". */
export function formatInches(value: number): string {
    return String(Number(value.toFixed(2)));
}
