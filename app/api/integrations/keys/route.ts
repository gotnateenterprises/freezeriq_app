import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

// GET: Check if keys exist (masked)
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const integrations = await prisma.integration.findMany({
            where: {
                business_id: businessId,
                provider: { in: ['openai', 'gemini'] }
            },
            select: { provider: true }
        });

        const keys = {
            openai: integrations.some(i => i.provider === 'openai'),
            gemini: integrations.some(i => i.provider === 'gemini')
        };

        return NextResponse.json(keys);
    } catch (error) {
        console.error('Failed to fetch keys:', error);
        return NextResponse.json({ error: 'Failed to fetch keys' }, { status: 500 });
    }
}

// POST: Save keys
export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const body = await request.json();
        const { provider, key } = body;

        if (!['openai', 'gemini'].includes(provider)) {
            return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
        }

        if (!key) {
            // If key is empty, maybe delete? For now assume update/create
            await prisma.integration.deleteMany({
                where: { business_id: businessId, provider }
            });
            return NextResponse.json({ success: true, status: 'removed' });
        }

        await prisma.integration.upsert({
            where: {
                business_id_provider: {
                    business_id: businessId,
                    provider
                }
            },
            update: {
                access_token: key, // We store API Key in access_token field
                updated_at: new Date()
            },
            create: {
                business_id: businessId,
                provider,
                access_token: key
            }
        });

        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('Failed to save key:', error);
        return NextResponse.json({ error: 'Failed to save key' }, { status: 500 });
    }
}
