
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
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

        const [total, individuals, organizations, waitlist, subscribers] = await Promise.all([
            prisma.customer.count({ where: { business_id: businessId, archived: false } }),
            prisma.customer.count({ where: { business_id: businessId, type: 'direct_customer', archived: false } }),
            prisma.customer.count({ where: { business_id: businessId, type: { in: ['fundraiser_org', 'organization'] }, archived: false } }),
            prisma.customer.count({ where: { business_id: businessId, tags: { has: 'surplus_waitlist' }, archived: false } }),
            prisma.customer.count({ where: { business_id: businessId, stripe_subscription_id: { not: null }, archived: false } }),
        ]);

        return NextResponse.json({
            all: total,
            individual: individuals,
            organization: organizations,
            waitlist: waitlist,
            subscribers: subscribers
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
