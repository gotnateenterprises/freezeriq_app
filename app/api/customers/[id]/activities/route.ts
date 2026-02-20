
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;

    try {
        const activities = await prisma.activity.findMany({
            where: {
                business_id: session.user.businessId,
                customer_id: id
            },
            orderBy: { timestamp: 'desc' }
        });
        return NextResponse.json(activities);
    } catch (e) {
        return NextResponse.json({ error: "Failed to fetch activities" }, { status: 500 });
    }
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;

    try {
        const body = await req.json();
        const { type, content } = body;

        // Verify customer exists and belongs to business
        const customer = await prisma.customer.findFirst({
            where: { id, business_id: session.user.businessId }
        });

        if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

        const activity = await prisma.activity.create({
            data: {
                business_id: session.user.businessId,
                customer_id: id,
                customer_name: customer.name,
                type: type || 'note', // note, call, email, meeting
                content: content,
                source: 'crm_manual',
                external_id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                status: 'read'
            }
        });

        return NextResponse.json(activity);
    } catch (e) {
        console.error("Activity create error", e);
        return NextResponse.json({ error: "Failed to create activity" }, { status: 500 });
    }
}
