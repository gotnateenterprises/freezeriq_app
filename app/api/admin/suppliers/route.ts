import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const suppliers = await prisma.supplier.findMany({
            where: { is_global: true },
            orderBy: { name: 'asc' },
            include: {
                _count: {
                    select: { ingredients: true }
                }
            }
        });

        return NextResponse.json(suppliers);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        const body = await req.json();
        const { name, portal_type, search_url_pattern, logo_url, website_url } = body;

        const supplier = await prisma.supplier.create({
            data: {
                name,
                portal_type,
                search_url_pattern,
                logo_url,
                website_url,
                is_global: true,
                business_id: null
            }
        });

        return NextResponse.json(supplier);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
