import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';

export async function GET(request: Request) {
    try {
        const email = process.env.ADMIN_EMAIL;
        const password = process.env.ADMIN_PASSWORD;

        if (!email || !password) {
            return NextResponse.json(
                { error: 'ADMIN_EMAIL or ADMIN_PASSWORD missing in environment variables' },
                { status: 500 }
            );
        }

        console.log(`Seeding Admin: ${email}`);

        // 1. Hash Password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 2. Upsert User
        const user = await prisma.user.upsert({
            where: { email },
            update: {
                password: hashedPassword,
                role: 'ADMIN',
                permissions: ['VIEW_FINANCIALS', 'MANAGE_TEAM', 'EDIT_RECIPES', 'VIEW_INVOICES'],
                isActive: true,
            },
            create: {
                email,
                password: hashedPassword,
                name: 'System Admin',
                role: 'ADMIN',
                permissions: ['VIEW_FINANCIALS', 'MANAGE_TEAM', 'EDIT_RECIPES', 'VIEW_INVOICES'],
                isActive: true,
            },
        });

        // 3. Upsert default tenant branding if it doesn't exist
        const defaultBranding = await prisma.tenantBranding.findUnique({
            where: { user_id: user.id }
        });

        if (!defaultBranding) {
            await prisma.tenantBranding.create({
                data: {
                    user_id: user.id,
                    business_name: 'Freezer IQ',
                    primary_color: '#10b981',
                    secondary_color: '#6366f1',
                    accent_color: '#f59e0b',
                }
            });
        }

        return NextResponse.json({
            success: true,
            message: `Admin configured: ${user.email} (${user.role})`
        });
    } catch (error: any) {
        console.error('Error seeding admin:', error);
        return NextResponse.json(
            { error: 'Failed to seed admin', details: error.message },
            { status: 500 }
        );
    }
}
