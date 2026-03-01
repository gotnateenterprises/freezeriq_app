import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const businessId = session.user.businessId;

        // Fetch all message activities for this business
        const messages = await prisma.activity.findMany({
            where: {
                business_id: businessId,
                type: 'message'
            },
            orderBy: {
                timestamp: 'desc'
            }
        });

        // Group messages by Thread / Customer
        // The senderId usually identifies the person you are talking to on Facebook
        // We need to differentiate inbound (customer) vs outbound (kitchen)

        const threadsMap = new Map<string, any>();

        messages.forEach(msg => {
            const isOutbound = msg.status === 'replied_outbound' || msg.status === 'sent';

            // Default to an unknown ID if metadata is missing
            const metadataStr = typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata);
            let metadataObj: any = {};
            try {
                if (metadataStr) metadataObj = JSON.parse(metadataStr);
            } catch (e) { }

            // In a real Facebook webhook, the senderId is the other person when it's inbound,
            // and the recipientId is the other person when it's outbound.
            const threadId = metadataObj?.recipientId || metadataObj?.senderId || msg.customer_id || msg.customer_name || 'Unknown';
            const customerName = isOutbound && msg.customer_name === 'Kitchen' ? 'Customer' : msg.customer_name || threadId;

            if (!threadsMap.has(threadId)) {
                threadsMap.set(threadId, {
                    id: threadId,
                    customerName: customerName,
                    messages: [],
                    latestMessageTimestamp: msg.timestamp,
                    unread: !isOutbound && msg.status === 'new'
                });
            }

            const thread = threadsMap.get(threadId);

            // Keep the earliest customer name found if it's currently generic
            if (customerName !== 'Customer' && thread.customerName === 'Customer') {
                thread.customerName = customerName;
            }

            thread.messages.push({
                id: msg.id,
                content: msg.content,
                timestamp: msg.timestamp,
                isOutbound: isOutbound,
                status: msg.status
            });

            // Update unread status if any inbound message is 'new'
            if (!isOutbound && msg.status === 'new') {
                thread.unread = true;
            }
        });

        // Convert Map to Array and sort by latest message
        const threads = Array.from(threadsMap.values()).sort((a, b) =>
            new Date(b.latestMessageTimestamp).getTime() - new Date(a.latestMessageTimestamp).getTime()
        );

        // Sort messages within each thread chronologically (oldest first for chat view)
        threads.forEach(t => {
            t.messages.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        });

        return NextResponse.json({ threads });
    } catch (error: any) {
        console.error('Inbox Fetch Error:', error);
        return NextResponse.json({ error: 'Failed to fetch inbox threads', details: error.message }, { status: 500 });
    }
}
