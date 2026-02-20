
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// POST /api/training/progress
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { resourceId, completed } = await req.json();

        if (completed) {
            await prisma.userTrainingProgress.upsert({
                where: {
                    user_id_resource_id: {
                        user_id: session.user.id,
                        resource_id: resourceId
                    }
                },
                create: {
                    user_id: session.user.id,
                    resource_id: resourceId,
                    completed_at: new Date()
                },
                update: {} // Already completed
            });
        } else {
            await prisma.userTrainingProgress.deleteMany({
                where: {
                    user_id: session.user.id,
                    resource_id: resourceId
                }
            });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("[Training Progress API] Error:", error);
        return NextResponse.json({ error: "Failed to update progress" }, { status: 500 });
    }
}
