import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: 'Unauthorized. Admin only.' }, { status: 403 });
        }

        // @ts-ignore - Prisma Client might be stale due to file lock during build
        const leads = await prisma.businessLead.findMany({
            orderBy: { created_at: 'desc' }
        });

        return NextResponse.json({ leads });
    } catch (error) {
        console.error('Error fetching leads:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
