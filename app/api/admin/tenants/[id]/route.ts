import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const UpdateBusinessSchema = z.object({
    plan: z.enum(['FREE', 'PRO', 'ULTIMATE'])
});

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();

        // 1. Security Check
        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: 'Unauthorized. Admin only.' }, { status: 403 });
        }

        const body = await req.json();
        const validation = UpdateBusinessSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json({ error: 'Invalid input', details: validation.error.format() }, { status: 400 });
        }

        const { plan } = validation.data;
        const { id } = await params;

        // 2. Update Business
        const updatedBusiness = await prisma.business.update({
            where: { id },
            data: {
                plan: plan as any
            }
        });

        return NextResponse.json({ success: true, business: updatedBusiness });

    } catch (error: any) {
        console.error('[AdminAPI] Update Tenant error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
