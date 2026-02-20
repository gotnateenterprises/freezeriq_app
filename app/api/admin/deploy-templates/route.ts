
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { TemplateService } from '@/lib/template_service';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    try {
        const session = await auth();

        // 1. Security Check
        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: 'Unauthorized. Admin only.' }, { status: 403 });
        }

        const { targetBusinessId, sourceBusinessSlug = 'freezeriq', categoryIds } = await req.json();

        if (!targetBusinessId) {
            return NextResponse.json({ error: 'Missing targetBusinessId' }, { status: 400 });
        }

        // 2. Identify Source
        const sourceBusiness = await prisma.business.findUnique({
            where: { slug: sourceBusinessSlug }
        });

        if (!sourceBusiness) {
            return NextResponse.json({ error: `Source business "${sourceBusinessSlug}" not found` }, { status: 404 });
        }

        // 3. Verify Target
        const targetBusiness = await prisma.business.findUnique({
            where: { id: targetBusinessId }
        });

        if (!targetBusiness) {
            return NextResponse.json({ error: 'Target business not found' }, { status: 404 });
        }

        // 4. Trigger Deployment
        const result = await TemplateService.cloneBusinessData(sourceBusiness.id, targetBusiness.id, categoryIds);

        return NextResponse.json({
            message: 'Template library deployed successfully',
            result
        });

    } catch (error: any) {
        console.error('[AdminAPI] Deployment error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
