
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const catalogs = await prisma.catalog.findMany({
            where: { business_id: session.user.businessId },
            include: {
                _count: {
                    select: { bundles: true }
                },
                bundles: {
                    include: {
                        contents: {
                            include: {
                                recipe: { select: { name: true } }
                            },
                            orderBy: { position: 'asc' }
                        }
                    },
                    where: { is_active: true }
                }
            },
            orderBy: { start_date: 'desc' }
        });

        return NextResponse.json(catalogs);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const data = await req.json();

        if (!data.name || !data.start_date || !data.end_date) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const catalog = await prisma.catalog.create({
            data: {
                name: data.name,
                start_date: new Date(data.start_date),
                end_date: new Date(data.end_date),
                is_active: data.is_active ?? true,
                business_id: session.user.businessId
            }
        });

        return NextResponse.json(catalog);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
