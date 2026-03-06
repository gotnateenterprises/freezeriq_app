import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET: Fetch single run with tasks
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id } = await params;
        const run = await prisma.productionRun.findUnique({
            where: { id },
            include: {
                tasks: true // Fetch tasks associated with this run
            }
        });

        if (!run) {
            return NextResponse.json({ error: 'Run not found' }, { status: 404 });
        }

        if (run.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        return NextResponse.json(run);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch run' }, { status: 500 });
    }
}

// DELETE: Delete a run
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id } = await params;

        // Ownership Check
        const existing = await prisma.productionRun.findUnique({ where: { id } });
        if (!existing) return NextResponse.json({ error: 'Not Found' }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

        // Delete tasks first (cascade usually handles this but good to be safe if not configured)
        await prisma.productionTask.deleteMany({
            where: { production_run_id: id }
        });

        await prisma.productionRun.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete run' }, { status: 500 });
    }
}
