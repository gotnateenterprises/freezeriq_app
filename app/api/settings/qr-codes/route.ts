import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    try {
        const session = await auth();
        const userId = session?.user?.id;
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { business_id: true }
        });

        if (!user?.business_id) return NextResponse.json({ error: 'No business context' }, { status: 400 });

        const qrCodes = await prisma.qRCode.findMany({
            where: { business_id: user.business_id },
            orderBy: { created_at: 'desc' }
        });

        return NextResponse.json(qrCodes);
    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: 'Failed to fetch QR codes' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        const userId = session?.user?.id;
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { business_id: true }
        });

        if (!user?.business_id) return NextResponse.json({ error: 'No business context' }, { status: 400 });

        const { name, url_target } = await req.json();

        if (!name || !url_target) return NextResponse.json({ error: 'Name and URL are required' }, { status: 400 });

        const newQr = await prisma.qRCode.create({
            data: {
                name,
                url_target,
                business_id: user.business_id
            }
        });

        return NextResponse.json(newQr);
    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: 'Failed to create QR code' }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const session = await auth();
        const userId = session?.user?.id;
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { business_id: true }
        });

        if (!user?.business_id) return NextResponse.json({ error: 'No business context' }, { status: 400 });

        const { id } = await req.json();

        if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

        const existing = await prisma.qRCode.findFirst({
            where: {
                id,
                business_id: user.business_id
            }
        });

        if (!existing) return NextResponse.json({ error: 'QR Code not found' }, { status: 404 });

        await prisma.qRCode.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: 'Failed to delete QR code' }, { status: 500 });
    }
}
