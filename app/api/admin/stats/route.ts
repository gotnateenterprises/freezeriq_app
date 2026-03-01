import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
    try {
        const session = await auth();

        // SECURITY FIX: Strict Super Admin Check
        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized. Super Admin Access Required." }, { status: 403 });
        }


        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // 1. Total Businesses
        const totalBusinesses = await prisma.business.count();

        // 2. Active Users (Total across all businesses)
        const totalUsers = await prisma.user.count();

        // 3. New Signups (Last 30 Days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const newBusinesses = await prisma.business.count({
            where: {
                created_at: {
                    gte: thirtyDaysAgo
                }
            }
        });

        const newUsers = await prisma.user.count({
            where: {
                created_at: {
                    gte: thirtyDaysAgo
                }
            }
        });

        // 4. Revenue (Dynamic MRR Calculation)
        // Group businesses by their active subscription plan
        const planPricing: Record<string, number> = {
            FREE: 0,
            BASE: 99,
            PRO: 199,
            ULTIMATE: 299,
            ENTERPRISE: 499
        };

        const businessesByPlan = await prisma.business.groupBy({
            by: ['plan'],
            _count: {
                id: true
            },
            where: {
                // Assuming trailing/canceled businesses shouldn't count towards active MRR
                subscription_status: { in: ['active', 'trialing'] }
            }
        });

        let monthlyRecurringRevenue = 0;
        businessesByPlan.forEach(group => {
            const planKey = group.plan as string;
            const price = planPricing[planKey] || 0;
            monthlyRecurringRevenue += price * group._count.id;
        });

        return NextResponse.json({
            metrics: {
                totalBusinesses,
                totalUsers,
                newBusinesses,
                newUsers,
                mrr: monthlyRecurringRevenue
            },
            recentBusinesses: await prisma.business.findMany({
                take: 5,
                orderBy: { created_at: 'desc' },
                include: {
                    users: {
                        take: 1,
                        select: { email: true } // Show the owner/first user
                    }
                }
            })
        });

    } catch (error) {
        console.error("Super Admin Stats Error:", error);
        return NextResponse.json({ error: "Failed to fetch admin stats" }, { status: 500 });
    }
}
