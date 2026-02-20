
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const businesses = await prisma.business.findMany({
            select: {
                id: true,
                name: true,
                slug: true
            },
            orderBy: {
                name: 'asc'
            }
        });

        return NextResponse.json(businesses);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { businessId } = body;

        if (!businessId) {
            return NextResponse.json({ error: "Business ID is required" }, { status: 400 });
        }

        // Update the user's business_id in the database
        await prisma.user.update({
            where: { id: session.user.id },
            data: { business_id: businessId }
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
