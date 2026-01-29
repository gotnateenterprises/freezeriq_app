import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// GET: List all production runs
export async function GET() {
    try {
        const runs = await prisma.productionRun.findMany({
            orderBy: { run_date: 'desc' },
            include: {
                _count: {
                    select: { tasks: true }
                }
            }
        });
        return NextResponse.json(runs);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 });
    }
}

// POST: Create a new production run
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { name, run_date } = body;

        const run = await prisma.productionRun.create({
            data: {
                name,
                run_date: new Date(run_date),
                status: 'planning'
            }
        });

        return NextResponse.json(run);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create run' }, { status: 500 });
    }
}
