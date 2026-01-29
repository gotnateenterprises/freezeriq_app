import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// GET: Fetch single run with tasks
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
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

        return NextResponse.json(run);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch run' }, { status: 500 });
    }
}

// DELETE: Delete a run
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

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
