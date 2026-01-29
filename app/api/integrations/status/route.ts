import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
    try {
        const integrations = await prisma.integration.findMany({
            select: { provider: true }
        });

        const status = {
            square: integrations.some(i => i.provider === 'square'),
            qbo: integrations.some(i => i.provider === 'qbo'),
            meta: integrations.some(i => i.provider === 'meta')
        };

        return NextResponse.json(status);
    } catch (e) {
        return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
    }
}
