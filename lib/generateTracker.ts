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
 *
 * Rows below 13 are NOT modified.
 */
import path from 'path';

export interface TrackerInput {
    campaignName: string;
    organizationName: string;
    endDate: string;
    publicUrl: string;
    coordinatorName?: string;
    bundles: Array<{ name: string; price: number }>;
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
    if (campaign.bundles[1]) {
        const b = campaign.bundles[1];
        ws.getCell('A11').value = `${b.name} ($${Number(b.price).toFixed(2)})`;
    }

    // --- Return buffer (no disk write) ---
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer as ArrayBuffer;
}
