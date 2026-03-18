import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { parse } from 'json2csv';

// Initialize Resend
// We will use a fallback logic so the app won't crash if the key isn't provided yet
const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

export async function POST(req: Request) {
    try {
        // Resolve session for tenant sender
        const { auth } = await import('@/auth');
        const session = await auth();
        const businessId = session?.user?.businessId;

        const body = await req.json();
        const { supplier, email, items } = body;

        if (!supplier || !email || !items || !items.length) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // 1. Format data for the CSV
        // We ensure we are ordering the Math.ceil() 'casesToOrder' if it exists, otherwise fallback to standard units
        const csvData = items.map((item: any) => ({
            SKU: item.id || '',
            Item_Name: item.name,
            Quantity_To_Order: item.casesToOrder !== undefined ? item.casesToOrder : Math.ceil(item.toBuy),
            Purchase_Unit: item.purchaseUnit || item.unit || 'Cases',
            Estimated_Cost: item.casesToOrder !== undefined && item.purchaseCost !== undefined
                ? `$${(item.casesToOrder * item.purchaseCost).toFixed(2)}`
                : `$${(item.toBuy * (item.costPerUnit || 0)).toFixed(2)}`,
            Recipe_Usage_Notes: `Requires ${item.toBuy.toFixed(2)} ${item.unit} for production`
        }));

        // 2. Generate CSV String
        const csvString = parse(csvData);

        // 3. Send Email via Resend
        // If there's no real API key, we simulate success for demo purposes to avoid crashing
        if (!process.env.RESEND_API_KEY) {
            console.warn("RESEND_API_KEY is not set. Simulating email send for:", email);
            console.log("CSV Output:\n", csvString);
            return NextResponse.json({ success: true, simulated: true });
        }

        // Resolve tenant-branded sender
        const { getTenantSender } = await import('@/lib/email');
        const sender = businessId
            ? await getTenantSender(businessId)
            : { from: 'FreezerIQ Orders <orders@freezeriq.com>' };

        const data = await resend.emails.send({
            from: sender.from,
            to: [email],
            replyTo: sender.replyTo,
            subject: `New Purchase Order: ${supplier}`,
            text: `Please find the attached Purchase Order for ${supplier}.\n\nThank you,\nFreezerIQ`,
            attachments: [
                {
                    filename: `${supplier.replace(/\s+/g, '_')}_PO_${new Date().toISOString().split('T')[0]}.csv`,
                    content: Buffer.from(csvString).toString('base64'),
                }
            ]
        });

        return NextResponse.json({ success: true, data });

    } catch (error) {
        console.error("Error generating PO:", error);
        return NextResponse.json({ error: 'Failed to generate PO' }, { status: 500 });
    }
}
