import { NextRequest, NextResponse } from 'next/server';
import { TokenManager } from '@/lib/auth/token_manager';
import { prisma } from '@/lib/db';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { recipientId, message, activityId } = body;

        if (!recipientId || !message) {
            return NextResponse.json({ error: 'Missing recipientId or message' }, { status: 400 });
        }

        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const tokenManager = new TokenManager('meta', businessId);
        const tokens = await tokenManager.getTokens();

        if (!tokens || !tokens.access_token) {
            return NextResponse.json({ error: 'Meta integration not connected' }, { status: 400 });
        }

        // Send message via Facebook Graph API
        const fbRes = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${tokens.access_token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: recipientId },
                message: { text: message }
            })
        });

        const fbData = await fbRes.json();

        if (!fbRes.ok) {
            console.error('Meta API Error:', fbData);
            return NextResponse.json({ error: fbData.error?.message || 'Failed to send message' }, { status: fbRes.status });
        }

        // Update activity status if activityId is provided
        if (activityId) {
            await prisma.activity.update({
                where: { id: activityId },
                data: { status: 'replied' }
            });
        }

        // Create a new activity for the outgoing message
        await prisma.activity.create({
            data: {
                external_id: fbData.message_id || `sent-${Date.now()}`,
                type: 'message',
                content: `Reply: ${message}`,
                status: 'sent',
                metadata: {
                    recipientId,
                    direction: 'outgoing',
                    fb_mid: fbData.message_id
                }
            }
        });

        return NextResponse.json({ success: true, messageId: fbData.message_id });

    } catch (e: any) {
        console.error('Messenger Reply Error:', e);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
