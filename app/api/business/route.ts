import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId;

        if (!businessId) {
            return NextResponse.json({ error: 'No business associated' }, { status: 404 });
        }

        const business = await prisma.business.findUnique({
            where: { id: businessId }
        });

        if (!business) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

        return NextResponse.json(business);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId;
        const role = (session?.user as any)?.role;

        if (!businessId || role !== 'ADMIN') {
            return NextResponse.json({ error: 'Unauthorized. Admin role required.' }, { status: 403 });
        }

        const body = await req.json();
        const { name, logo_url } = body;

        const updated = await prisma.business.update({
            where: { id: businessId },
            data: {
                name: name || undefined,
                logo_url: logo_url || undefined
            }
        });

        return NextResponse.json(updated);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
