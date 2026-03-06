
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET /api/admin/training/progress
// Super Admin only: Fetch progress for all users grouped by business
export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        // 1. Get all users with their business and progress counts
        const users = await prisma.user.findMany({
            where: { isActive: true },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                business: {
                    select: { name: true }
                },
                _count: {
                    select: { training_progress: true }
                }
            },
            orderBy: {
                business: { name: 'asc' }
            }
        });

        // 2. Get total active training resources count to calculate percentage
        const totalResources = await prisma.trainingResource.count({
            where: { isActive: true }
        });

        // 3. Format response
        const report = users.map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            businessName: user.business?.name || 'Global / Unassigned',
            completedCount: user._count.training_progress,
            totalCount: totalResources,
            percentage: totalResources > 0 ? Math.round((user._count.training_progress / totalResources) * 100) : 0
        }));

        return NextResponse.json(report);
    } catch (error) {
        console.error("[Admin Training Progress API] Error:", error);
        return NextResponse.json({ error: "Failed to fetch progress report" }, { status: 500 });
    }
}
