import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET: List documents for a specific customer
export async function GET(req: Request) {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get('customerId');

    if (!customerId) return NextResponse.json({ error: 'Customer ID required' }, { status: 400 });

    try {
        const documents = await prisma.document.findMany({
            where: {
                customer_id: customerId,
                business_id: session.user.businessId // Security check
            },
            orderBy: { updated_at: 'desc' }
        });

        return NextResponse.json(documents);
    } catch (e) {
        console.error("Error fetching documents", e);
        return NextResponse.json({ error: "Failed to fetch documents" }, { status: 500 });
    }
}

// POST: Create a new Document (from template or scratch)
export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { name, content, customerId, status } = body;

    try {
        const doc = await prisma.document.create({
            data: {
                name,
                content,
                status: status || 'Draft',
                external_link: body.external_link,
                customer_id: customerId,
                business_id: session.user.businessId
            }
        });

        return NextResponse.json(doc);
    } catch (e) {
        console.error("Error creating document", e);
        return NextResponse.json({ error: "Failed to create document" }, { status: 500 });
    }
}
