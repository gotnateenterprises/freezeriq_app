import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// POST: Add a task to a run
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { production_run_id, item_id, item_type, total_qty_needed, unit } = body;

        const task = await prisma.productionTask.create({
            data: {
                production_run_id,
                item_id,
                item_type,
                total_qty_needed,
                unit,
                status: 'todo'
            }
        });

        return NextResponse.json(task);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }
}

// PATCH: Update task (status or quantity)
export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { id, status, total_qty_needed } = body;

        const task = await prisma.productionTask.update({
            where: { id },
            data: {
                status: status || undefined,
                total_qty_needed: total_qty_needed || undefined
            }
        });

        return NextResponse.json(task);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
    }
}

// DELETE: Remove a task
export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 });

        await prisma.productionTask.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
    }
}
