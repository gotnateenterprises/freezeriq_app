
import { NextResponse } from 'next/server';
import { marketingClient } from '@/lib/marketing_client';
import { prisma } from '@/lib/db';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { subject, body: messageBody, channel, audienceType, targetRecipient } = body;

        if (!subject || !messageBody) {
            return NextResponse.json({ error: 'Subject and Body are required' }, { status: 400 });
        }

        let audienceSize = 1;

        if (audienceType === 'all') {
            audienceSize = await prisma.organization.count();
        } else if (audienceType === 'individual') {
            audienceSize = await prisma.organization.count({ where: { type: 'direct_customer' } });
        } else if (audienceType === 'organization') {
            audienceSize = await prisma.organization.count({ where: { type: 'fundraiser_org' } });
        } else if (audienceType === 'single') {
            audienceSize = 1;
        }

        const result = await marketingClient.sendCampaign({
            subject,
            body: messageBody,
            channel: channel || 'email',
            audience_size: audienceSize || 1
        });

        return NextResponse.json(result);

    } catch (e: any) {
        return NextResponse.json({ error: e.message || 'Failed to send campaign' }, { status: 500 });
    }
}

export async function GET() {
    try {
        const campaigns = await marketingClient.getCampaigns();
        return NextResponse.json(campaigns);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
