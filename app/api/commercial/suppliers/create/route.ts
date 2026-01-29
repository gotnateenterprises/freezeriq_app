import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        if (!body.name) return NextResponse.json({ error: "Name required" }, { status: 400 });

        const supplier = await prisma.supplier.create({
            data: { name: body.name }
        });

        return NextResponse.json(supplier);
    } catch (e) {
        return NextResponse.json({ error: "Failed to create supplier" }, { status: 500 });
    }
}
