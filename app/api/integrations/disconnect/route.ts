
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const { provider } = await req.json();

        if (!provider || (provider !== 'square' && provider !== 'qbo' && provider !== 'meta')) {
            return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
        }

        await prisma.integration.deleteMany({
            where: { provider }
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("Disconnect Error:", e);
        return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
    }
}
