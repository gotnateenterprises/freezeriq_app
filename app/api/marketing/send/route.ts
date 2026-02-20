
import { NextResponse } from 'next/server';
import { marketingClient } from '@/lib/marketing_client';
import { prisma } from '@/lib/db';

export async function POST(request: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const user = session.user as any;
        const businessId = user.businessId;
        const plan = user.plan;
        const isSuperAdmin = user.isSuperAdmin;

        if (!businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const hasAccess = plan === 'ENTERPRISE' || plan === 'ULTIMATE' || plan === 'FREE' || isSuperAdmin;
        if (!hasAccess) {
            return NextResponse.json({ error: "Upgrade Now" }, { status: 403 });
        }

        const body = await request.json();
        const { subject, body: messageBody, channel, audienceType, targetRecipient } = body;

        if (!subject || !messageBody) {
            return NextResponse.json({ error: 'Subject and Body are required' }, { status: 400 });
        }

        let audienceSize = 1;

        if (audienceType === 'all') {
            audienceSize = await prisma.customer.count({ where: { business_id: businessId, archived: false } });
        } else if (audienceType === 'individual') {
            audienceSize = await prisma.customer.count({ where: { business_id: businessId, type: 'direct_customer', archived: false } });
        } else if (audienceType === 'organization') {
            audienceSize = await prisma.customer.count({ where: { business_id: businessId, type: { in: ['fundraiser_org', 'organization'] }, archived: false } });
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
