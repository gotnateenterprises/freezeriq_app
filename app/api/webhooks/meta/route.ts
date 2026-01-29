import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { TokenManager } from '@/lib/auth/token_manager';

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'freezeriq_meta_verify';

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // Webhooks can contain multiple entries
        if (body.object === 'page') {
            for (const entry of body.entry) {
                // 1. Handle Messaging (Direct Messages)
                if (entry.messaging) {
                    for (const message of entry.messaging) {
                        await handleMessage(message);
                    }
                }

                // 2. Handle Feed (Comments) or Leadgen (Leads)
                if (entry.changes) {
                    for (const change of entry.changes) {
                        if (change.field === 'feed') {
                            await handleFeedChange(change.value);
                        } else if (change.field === 'leadgen') {
                            await handleLeadgen(change.value);
                        }
                    }
                }
            }
        }

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("Meta Webhook Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

async function handleMessage(messaging: any) {
    const senderId = messaging.sender.id;
    const text = messaging.message?.text;

    if (!text) return;

    await prisma.activity.create({
        data: {
            type: 'message',
            external_id: messaging.message.mid,
            content: text,
            customer_name: `User ${senderId}`,
            metadata: { senderId }
        }
    });
}

async function handleFeedChange(value: any) {
    // Only interested in comments for now
    if (value.item !== 'comment' || value.verb !== 'add') return;

    await prisma.activity.create({
        data: {
            type: 'comment',
            external_id: value.comment_id,
            content: value.message,
            customer_name: value.from?.name || 'Unknown User',
            metadata: {
                postId: value.post_id,
                fromId: value.from?.id
            }
        }
    });
}

async function handleLeadgen(value: any) {
    const leadgenId = value.leadgen_id;
    const pageId = value.page_id;

    // To get lead details, we need the Page Access Token
    const tokenManager = new TokenManager('meta');
    const integration = await prisma.integration.findFirst({
        where: { provider: 'meta', realm_id: pageId }
    });

    if (!integration) return;

    const res = await fetch(`https://graph.facebook.com/v18.0/${leadgenId}?access_token=${integration.access_token}`);
    const leadData = await res.json();

    if (leadData.field_data) {
        // Map field data (email, full_name, etc)
        const emailField = leadData.field_data.find((f: any) => f.name === 'email')?.values[0];
        const nameField = leadData.field_data.find((f: any) => f.name === 'full_name')?.values[0];

        if (emailField) {
            await prisma.organization.upsert({
                where: { external_id: leadgenId },
                update: {
                    status: 'Lead',
                    contact_email: emailField,
                    contact_name: nameField
                },
                create: {
                    external_id: leadgenId,
                    name: nameField || 'New Meta Lead',
                    contact_email: emailField,
                    contact_name: nameField,
                    status: 'Lead',
                    source: 'Meta'
                }
            });

            // Also add to activity feed
            await prisma.activity.create({
                data: {
                    type: 'lead',
                    external_id: leadgenId,
                    content: `New lead captured: ${nameField || emailField}`,
                    customer_name: nameField,
                    metadata: { email: emailField }
                }
            });
        }
    }
}
