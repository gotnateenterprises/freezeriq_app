import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { name, email, phone, orgName, deliveryLocation } = body;

        // Basic validation
        if (!name || !email || !phone || !orgName || !deliveryLocation) {
            return NextResponse.json(
                { error: 'Name, email, phone, organization, and delivery location are required.' },
                { status: 400 }
            );
        }

        // TODO: Send notification email to tenant when email service is wired

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('[FUNDRAISER_REQUEST]', error);
        return NextResponse.json(
            { error: error.message || 'Internal Error' },
            { status: 500 }
        );
    }
}
