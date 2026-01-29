
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
    try {
        const [total, individuals, organizations] = await Promise.all([
            prisma.organization.count(),
            prisma.organization.count({ where: { type: 'direct_customer' } }),
            prisma.organization.count({ where: { type: 'fundraiser_org' } }),
        ]);

        return NextResponse.json({
            all: total,
            individual: individuals,
            organization: organizations
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
