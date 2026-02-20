import { NextRequest, NextResponse } from 'next/server';
import { setStatus, progressStatus, archiveCustomer, unarchiveCustomer, type CustomerStatus } from '@/lib/statusWorkflow';
import { prisma } from '@/lib/db';

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> } // Updated to Promise for Next.js 15+ compat
) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;
        const body = await req.json();
        const { action, status } = body;

        let targetId = id;

        // Check if ID is UUID
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        if (!isUuid) {
            // It's a name (e.g. "John Doe")
            const name = decodeURIComponent(id);

            // 1. Find existing customer by name
            let customer = await prisma.customer.findFirst({
                where: {
                    name: name,
                    business_id: session.user.businessId
                }
            });

            // 2. If not found, create one (Materialize transient customer)
            if (!customer) {
                console.log(`Materializing transient customer: ${name}`);
                customer = await prisma.customer.create({
                    data: {
                        name: name,
                        contact_name: name,
                        business_id: session.user.businessId,
                        type: 'direct_customer',
                        status: 'LEAD',
                        source: 'Manual',
                        external_id: `man_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
                    }
                });

                // 3. Link existing orders
                await prisma.order.updateMany({
                    where: {
                        customer_name: name,
                        customer_id: null,
                        business_id: session.user.businessId
                    },
                    data: { customer_id: customer.id }
                });
            }

            targetId = customer.id;
        }

        // Perform Action on Resolved ID
        if (action === 'set' && status) {
            const result = await setStatus(targetId, status as CustomerStatus);
            return NextResponse.json(result);
        }

        if (action === 'progress') {
            const result = await progressStatus(targetId, 'manual');
            return NextResponse.json(result);
        }

        if (action === 'archive') {
            const result = await archiveCustomer(targetId);
            return NextResponse.json(result);
        }

        if (action === 'unarchive') {
            const result = await unarchiveCustomer(targetId);
            return NextResponse.json(result);
        }

        return NextResponse.json({ success: false, message: 'Invalid action' }, { status: 400 });

    } catch (error) {
        console.error('Error updating customer status:', error);
        return NextResponse.json({ success: false, message: 'Failed to update status' }, { status: 500 });
    }
}
