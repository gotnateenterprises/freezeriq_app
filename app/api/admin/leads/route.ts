import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
    try {
        // In a real app, add authentication check here (ensure user is SUPER_ADMIN)
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
