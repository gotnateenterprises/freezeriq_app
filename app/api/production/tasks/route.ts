import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// POST: Add a task to a run
export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await request.json();
        const { production_run_id, item_id, item_type, total_qty_needed, unit } = body;

        // Ownership Check
        const run = await prisma.productionRun.findUnique({ where: { id: production_run_id } });
        if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
        if (run.business_id !== session.user.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

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
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await request.json();
        const { id, status, total_qty_needed } = body;

        // Ownership Check
        const existingTask = await prisma.productionTask.findUnique({
            where: { id },
            include: { production_run: true }
        });
        if (!existingTask) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        if (existingTask.production_run?.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        const task = await prisma.productionTask.update({
            where: { id },
            data: {
                status: status || undefined,
                total_qty_needed: total_qty_needed || undefined
            }
        });

        // INVENTORY DEDUCTION LOGIC
        // If status changed to 'done', deduct. If changed FROM 'done' to something else, revert.
        const becomingDone = status === 'done' && existingTask.status !== 'done';
        const unmarkingDone = status && status !== 'done' && existingTask.status === 'done';

        if (becomingDone || unmarkingDone) {
            const multiplier = becomingDone ? -1 : 1; // Deduct if becoming done (-qty), Revert if unmarking (+qty)
            const qtyNeeded = total_qty_needed || existingTask.total_qty_needed;

            if (existingTask.item_type === 'recipe') {
                // Fetch recipe ingredients
                const recipeItems = await prisma.recipeItem.findMany({
                    where: { parent_recipe_id: existingTask.item_id },
                    include: { child_ingredient: true }
                });

                for (const item of recipeItems) {
                    if (item.child_ingredient_id) {
                        const amountToChange = Number(item.quantity) * qtyNeeded * multiplier;
                        await prisma.ingredient.update({
                            where: { id: item.child_ingredient_id },
                            data: {
                                stock_quantity: {
                                    increment: amountToChange
                                }
                            }
                        });
                    }
                }
            } else if (existingTask.item_type === 'ingredient') {
                await prisma.ingredient.update({
                    where: { id: existingTask.item_id },
                    data: {
                        stock_quantity: {
                            increment: qtyNeeded * multiplier
                        }
                    }
                });
            }
        }

        return NextResponse.json(task);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
    }
}

// DELETE: Remove a task
export async function DELETE(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 });

        // Ownership Check
        const existingTask = await prisma.productionTask.findUnique({
            where: { id },
            include: { production_run: true }
        });
        if (!existingTask) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        if (existingTask.production_run?.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        await prisma.productionTask.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
    }
}
