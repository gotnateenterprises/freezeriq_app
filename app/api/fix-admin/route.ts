import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
    try {
        console.log("🔗 Fixing admin business association in production...");

        const admin = await prisma.user.findUnique({ where: { email: 'nate475@gmail.com' } });

        if (!admin) {
            return NextResponse.json({ error: "Admin nate475@gmail.com not found!" }, { status: 404 });
        }

        // Find the business that was just imported (My Freezer Chef)
        const fallback = await prisma.business.findFirst({
            where: { name: 'My Freezer Chef' }
        });

        if (!fallback) {
            return NextResponse.json({ error: "My Freezer Chef business not found!" }, { status: 404 });
        }

        await prisma.user.update({
            where: { id: admin.id },
            data: { business_id: fallback.id, is_super_admin: true }
        });

        return NextResponse.json({
            success: true,
            message: `Admin perfectly linked to ${fallback.name} successfully.`
        });
    } catch (error: any) {
        console.error('Error linking admin:', error);
        return NextResponse.json(
            { error: 'Failed to link admin', details: error.message },
            { status: 500 }
        );
    }
}
