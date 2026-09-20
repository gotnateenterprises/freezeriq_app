import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET: List documents for a specific customer
//
// Fail closed on tenant identity, not just on a session. `users.business_id` is nullable, so an
// authenticated user can have `businessId === undefined`, and Prisma STRIPS an undefined value from a
// where clause — `{ customer_id, business_id: undefined }` would collapse to `{ customer_id }` and
// return another tenant's documents. Same shape, same fix as app/api/training/route.ts.
export async function GET(req: Request) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const businessId = session.user.businessId;

    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get('customerId');

    if (!customerId) return NextResponse.json({ error: 'Customer ID required' }, { status: 400 });

    try {
        const documents = await prisma.document.findMany({
            where: {
                customer_id: customerId,
                business_id: businessId // Security check: concrete, never undefined (guarded above)
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
