import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';

export async function GET() {
    try {
        const session = await auth();

        // 1. Security Check
        // 1. Security Check
        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: 'Unauthorized. Admin only.' }, { status: 403 });
        }

        // 2. Fetch all businesses with basic stats
        const businesses = await prisma.business.findMany({
            include: {
                _count: {
                    select: {
                        users: true,
                        recipes: true,
                        ingredients: true
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        return NextResponse.json(businesses);

    } catch (error: any) {
        console.error('[AdminAPI] Tenants fetch error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

const CreateBusinessSchema = z.object({
    name: z.string().min(2),
    slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
    plan: z.enum(['FREE', 'PRO', 'ULTIMATE']),
    adminName: z.string().min(2),
    adminEmail: z.string().email(),
    adminPassword: z.string().min(6)
});

export async function POST(req: Request) {
    try {
        const session = await auth();

        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        const body = await req.json();
        const validation = CreateBusinessSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json({ error: 'Invalid input', details: validation.error.format() }, { status: 400 });
        }

        const { name, slug, plan, adminName, adminEmail, adminPassword } = validation.data;

        // Uniqueness Checks
        const existingBusiness = await prisma.business.findUnique({ where: { slug } });
        if (existingBusiness) return NextResponse.json({ error: 'Slug taken' }, { status: 400 });

        const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });
        if (existingUser) return NextResponse.json({ error: 'Email taken' }, { status: 400 });

        const hashedPassword = await bcrypt.hash(adminPassword, 10);

        const newBusiness = await prisma.$transaction(async (tx) => {
            const business = await tx.business.create({
                data: { name, slug, plan: plan as any, subscription_status: 'active' }
            });

            await tx.user.create({
                data: {
                    name: adminName,
                    email: adminEmail,
                    password: hashedPassword,
                    role: 'ADMIN',
                    business_id: business.id,
                    is_super_admin: false
                }
            });
            return business;
        });

        return NextResponse.json({ success: true, business: newBusiness });

    } catch (error: any) {
        console.error('[AdminAPI] Create Tenant error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
