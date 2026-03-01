import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'freezeriq_secret_token';

// Facebook Webhook Verification
export async function GET(req: NextRequest) {
    const searchParams = req.nextUrl.searchParams;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === META_WEBHOOK_VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
        return new NextResponse(challenge, { status: 200 });
    } else {
        return new NextResponse('Forbidden', { status: 403 });
    }
}

// Handle Incoming Messenger Events
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // Check if this is a page webhook
        if (body.object === 'page') {
            // Iterate over each entry
            for (const entry of body.entry) {
                const pageId = entry.id; // This is the Facebook Page ID

                // Find the business ID associated with this Page ID
                const integration = await prisma.integration.findFirst({
                    where: { provider: 'meta', realm_id: pageId }
                });

                if (!integration) {
                    console.log("Webhook received for unknown Page ID:", pageId);
                    continue;
                }

                // Iterate over each messaging event
                const webhookEvent = entry.messaging?.[0];
                if (webhookEvent && webhookEvent.message) {
                    const senderId = webhookEvent.sender.id;
                    const messageText = webhookEvent.message.text;

                    // Fetch user info from Graph API (optional, best effort)
                    let senderName = 'Facebook User';
                    try {
                        const profileRes = await fetch(`https://graph.facebook.com/${senderId}?access_token=${integration.access_token}`);
                        if (profileRes.ok) {
                            const profileInfo = await profileRes.json();
                            if (profileInfo.first_name) {
                                senderName = `${profileInfo.first_name} ${profileInfo.last_name || ''}`.trim();
                            }
                        }
                    } catch (e) {
                        console.error('Failed to fetch FB profile name', e);
                    }

                    // Save the incoming message to our Activity Feed
                    await prisma.activity.create({
                        data: {
                            business_id: integration.business_id,
                            type: 'message',
                            external_id: webhookEvent.message.mid || `wh-${Date.now()}`,
                            customer_name: senderName,
                            content: messageText,
                            status: 'new', // Shows orange badge
                            metadata: {
                                senderId: senderId,
                                messageId: webhookEvent.message.mid,
                                pageId: pageId
                            },
                            timestamp: new Date()
                        }
                    });
                }
            }
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        } else {
            return new NextResponse('Not Found', { status: 404 });
        }
    } catch (error) {
        console.error('Meta Webhook Error:', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
