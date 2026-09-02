
import { Recipe } from "@/types";

export interface PrintJob {
    recipeName: string;
    ingredients: string;
    expiryDate: string;
    quantity: number;
    user: string;
    /** The serving-tier label this job's callers already send (e.g. "Serves 2"). */
    unit?: string;
    // New Fields for Final Label
    allergens?: string;
    notes?: string;
    isFinalLabel?: boolean;
    // Tenant Branding
    businessName?: string;
    logoUrl?: string;
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
}

export interface LabelPrinter {
    printLabel(job: PrintJob): Promise<{ success: boolean; message: string; mock: boolean }>;
}

class MockLabelPrinter implements LabelPrinter {
    async printLabel(job: PrintJob): Promise<{ success: boolean; message: string; mock: boolean }> {
        // OPS-5D: `copies` logged explicitly, not the ambiguous `quantity`
        // field name the wire payload still uses for DCG compatibility — a
        // reader of these logs must be able to tell copy count from serving
        // tier at a glance. No PII: this job carries recipe/branding data
        // only, never a supporter name or address.
        console.log(`🖨️ [MOCK PRINT] recipe=${job.recipeName} copies=${job.quantity} tier=${job.unit}`);
        await new Promise(resolve => setTimeout(resolve, 800)); // Simulate network delay
        // OPS-5D: no physical printer is connected in mock mode, so this
        // message must never claim delivery — callers surface `mock` to the
        // operator rather than a bare "sent successfully."
        return {
            success: true,
            mock: true,
            message: `MOCK: ${job.quantity} label${job.quantity === 1 ? '' : 's'} prepared for "${job.recipeName}" (${job.isFinalLabel ? 'Final' : 'Prep'}) — no physical printer connected, nothing was actually printed.`,
        };
    }
}

class DateCodeGeniePrinter implements LabelPrinter {
    private apiKey: string;
    private locationId: string;
    private printerProfileId: string;

    constructor(apiKey: string, locationId: string, printerProfileId: string) {
        this.apiKey = apiKey;
        this.locationId = locationId;
        this.printerProfileId = printerProfileId;
    }

    async printLabel(job: PrintJob): Promise<{ success: boolean; message: string; mock: boolean }> {
        try {
            // Construct Payload for DCG Cloud Print
            // Note: Schema is inferred. Expects ProfileID/LocationID and Content.
            const payload = {
                printer_profile_id: this.printerProfileId, // From ENV
                location_id: this.locationId, // From ENV
                label_data: {
                    item_name: job.recipeName,
                    ingredients_text: job.ingredients,
                    allergens_text: job.allergens || '',
                    use_by_date: job.expiryDate,
                    quantity: job.quantity,
                    user_initials: job.user
                },
                // Metadata for tracking
                metadata: {
                    source: "FreezerIQ™",
                    timestamp: new Date().toISOString()
                }
            };

            const response = await fetch('https://www.datecodegenie.com/api/cloud_printing', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Using most common auth header for DCG
                    'Authorization': `Bearer ${this.apiKey}`,
                    // Fallback/Legacy header often used by DCG
                    'X-API-KEY': this.apiKey
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                return { success: true, mock: false, message: "Label sent to DateCodeGenie!" };
            } else {
                const errText = await response.text();
                console.error(`DCG Print Error: ${response.status}`, errText);
                return { success: false, mock: false, message: `DCG Error: ${response.statusText}` };
            }
        } catch (e) {
            console.error("DCG Network Error", e);
            return { success: false, mock: false, message: "Network Error contacting Printer API" };
        }
    }
}

export function getLabelPrinter(): LabelPrinter {
    // Toggle this or use ENV vars
    const useRealPrinter = process.env.DCG_API_KEY && process.env.DCG_LOCATION_ID;

    if (useRealPrinter) {
        return new DateCodeGeniePrinter(
            process.env.DCG_API_KEY!,
            process.env.DCG_LOCATION_ID!,
            process.env.DCG_PROFILE_ID || ''
        );
    }

    return new MockLabelPrinter();
}
