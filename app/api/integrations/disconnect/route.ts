
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { provider } = await req.json();

        const allowedProviders = ['square', 'qbo', 'meta', 'stripe'];
        if (!provider || !allowedProviders.includes(provider)) {
            return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
        }

        await prisma.integration.deleteMany({
            where: {
                provider,
                business_id: businessId
            }
        });

        // Reset payment provider to safe default when disconnecting Square
        if (provider === 'square') {
            await prisma.storefrontConfig.updateMany({
                where: { business_id: businessId, payment_provider: 'square' },
                data: { payment_provider: 'stripe' }
            });
        }

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("Disconnect Error:", e);
        return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
    }
}
