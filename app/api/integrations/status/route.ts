import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const integrations = await prisma.integration.findMany({
            where: { business_id: businessId },
            select: { provider: true }
        });

        const status = {
            square: integrations.some(i => i.provider === 'square'),
            qbo: integrations.some(i => i.provider === 'qbo'),
            meta: integrations.some(i => i.provider === 'meta'),
            instagram: integrations.some(i => i.provider === 'instagram')
        };

        return NextResponse.json(status);
    } catch (e) {
        return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
    }
}
