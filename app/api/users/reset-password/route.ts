import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { sendPasswordResetEmail } from '@/lib/email';

export async function POST(req: Request) {
    const session = await auth();
    if (!session || session.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        return NextResponse.json({ error: 'Business ID missing from session' }, { status: 400 });
    }

    try {
        const { userId } = await req.json();

        if (!userId) return NextResponse.json({ error: 'User ID required' }, { status: 400 });

        // Fetch user to get email and check business_id
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, business_id: true }
        });

        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

        // Ownership check
        if (user.business_id !== businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // Generate temp password
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        // Update user
        await prisma.user.update({
            where: { id: userId },
            data: { password: hashedPassword }
        });

        // Send Email
        await sendPasswordResetEmail(user.email, tempPassword);

        console.log(`[ADMIN] Reset password for user ${userId} (${user.email})`);

        return NextResponse.json({ success: true, message: 'Email sent' });

    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
    }
}
