
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

// SEC-PUBLIC-ROUTE-1. The POST above gates correctly; this GET did not gate at
// all. marketingClient is a module-level singleton (lib/marketing_client.ts:79)
// whose in-memory campaign array is appended by that authenticated POST, so an
// anonymous GET returned the subject and body of every campaign any tenant had
// sent from this server instance since cold start.
//
// Scoping note: the mock client stores no business_id, so there is nothing to
// filter on — the session guard is the whole available fix at this layer. When
// this is replaced by a real marketing backend, the per-tenant filter belongs in
// the client, and this comment should go with it.
export async function GET() {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const campaigns = await marketingClient.getCampaigns();
        return NextResponse.json(campaigns);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
