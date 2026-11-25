/**
 * generateTracker — Server-side utility
 *
 * Loads /templates/tracker.xlsx, injects campaign-specific data
 * into predefined cells, and returns the populated workbook as
 * an ArrayBuffer for streaming to the client.
 *
 * Cell mapping (DO NOT CHANGE):
 *   A1  → "[organizationName] FUNDRAISER"
 *   A2  → "Campaign: [campaignName]"
 *   A3  → "Ends: [formatted date]"
 *   A4  → "Order Online: [publicUrl]"
 *   B6  → [coordinatorName OR campaignName fallback]
 *   A10 → "[bundle1.name] ($[bundle1.price])"
 *   A11 → "[bundle2.name] ($[bundle2.price])"
 *   A12 → "Add-on: [addOn.name] ($[addOn.price]) — only with a meal bundle"   (S5, only with an add-on)
 *   E13 → "Add-On Qty" column header, E13:E33 styled like column D           (S5, only with an add-on)
 *
 * Rows below 13 are NOT modified — except the add-on quantity column above, for a campaign with an add-on.
 */
import path from 'path';

export interface TrackerInput {
    campaignName: string;
    organizationName: string;
    endDate: string;
    publicUrl: string;
    coordinatorName?: string;
    bundles: Array<{ name: string; price: number }>;
    /** FR-SUPPORTER-ADDON-UPSELL-1 (S5): the campaign's add-on at its supporter price, or absent. */
    addOn?: { name: string; price: number } | null;
}

export async function generateTracker(campaign: TrackerInput): Promise<ArrayBuffer> {
    // Dynamic import — keeps ExcelJS out of the client bundle
    const ExcelJS = (await import('exceljs')).default;

    const templatePath = path.resolve('./templates/tracker.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);

    const ws = workbook.worksheets[0];

    // --- Header Section ---
    ws.getCell('A1').value = `${campaign.organizationName} FUNDRAISER`;

    ws.getCell('A2').value = `Campaign: ${campaign.campaignName}`;

    const formattedDate = campaign.endDate
        ? new Date(campaign.endDate).toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
          })
        : 'TBD';
    ws.getCell('A3').value = `Ends: ${formattedDate}`;

    ws.getCell('A4').value = `Order Online: ${campaign.publicUrl}`;

    // --- Coordinator ---
    ws.getCell('B6').value = campaign.coordinatorName || campaign.campaignName;

    // --- Bundles (up to 2) ---
    if (campaign.bundles[0]) {
        const b = campaign.bundles[0];
        ws.getCell('A10').value = `${b.name} ($${Number(b.price).toFixed(2)})`;
    }
    // --- FR-SUPPORTER-ADDON-UPSELL-1 (S5): the campaign add-on, with its own quantity column ---
    // Only for a campaign that offers one; every other tracker is byte-for-byte what it was. The add-on is listed
    // apart from the meal bundles (row 12 is the template's blank row) and gets a dedicated "Add-On Qty" column,
    // so a paper order can record it without writing it into the Bundle column as if it were a meal. Its price is
    // the same supporter price the packet's flyer prints (tax-inclusive when the campaign is taxed).
    const addOnPrice = Number(campaign.addOn?.price);
    if (campaign.addOn && Number.isFinite(addOnPrice) && addOnPrice > 0) {
        const name = (campaign.addOn.name ?? '').trim() || 'Add-on';
        ws.getCell('A12').value = `Add-on: ${name} ($${addOnPrice.toFixed(2)}) — only with a meal bundle`;
        ws.getCell('E13').value = 'Add-On Qty';
        for (let r = 13; r <= ws.rowCount; r++) {
            const d = ws.getCell(`D${r}`);
            if (d.style && Object.keys(d.style).length > 0) ws.getCell(`E${r}`).style = { ...d.style };
        }
        ws.getColumn(5).width = 12;
        // Five columns no longer fit a portrait page at 100%: fit the width to one page, any number of pages tall.
        ws.pageSetup.fitToPage = true;
        ws.pageSetup.fitToWidth = 1;
        ws.pageSetup.fitToHeight = 0;
    }

    if (campaign.bundles[1]) {
        const b = campaign.bundles[1];
        ws.getCell('A11').value = `${b.name} ($${Number(b.price).toFixed(2)})`;
    }

    // --- Return buffer (no disk write) ---
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer as ArrayBuffer;
}
