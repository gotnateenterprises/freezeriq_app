import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        if (!body.name) return NextResponse.json({ error: "Name required" }, { status: 400 });

        const supplier = await prisma.supplier.create({
            data: {
                name: body.name,
                business_id: session.user.businessId
            }
        });

        return NextResponse.json(supplier);
    } catch (e) {
        return NextResponse.json({ error: "Failed to create supplier" }, { status: 500 });
    }
}
