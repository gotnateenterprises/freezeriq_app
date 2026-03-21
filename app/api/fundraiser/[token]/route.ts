import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/** Masks a full name to first name + last initial for public privacy. */
function maskName(name: string | null | undefined): string | null {
    if (!name) return null;
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) return parts[0]; // single name stays as-is
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}


export async function GET(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;

        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { public_token: token },
            select: {
                id: true,
                name: true,
                status: true,
                start_date: true,
                end_date: true,
                goal_amount: true,
                bundle_goal: true,
                total_sales: true,
                about_text: true,
                mission_text: true,
                payment_instructions: true,
                external_payment_link: true,
                delivery_date: true,
                pickup_location: true,
                customer: {
                    select: {
                        name: true,
                    }
                },
                orders: {
                    orderBy: { created_at: 'desc' },
                    select: {
                        customer_name: true,
                        created_at: true,
                        // Bundle-unit progress needs item-level data
                        items: {
                            select: {
                                quantity: true,
                                variant_size: true,
                            }
                        }
                    }
                }
            }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
        }

        // Privacy: mask supporter names to first name + last initial
        const maskedOrders = (campaign as any).orders.map((order: any) => ({
            ...order,
            customer_name: maskName(order.customer_name),
        }));

        return NextResponse.json({ ...(campaign as any), orders: maskedOrders });

    } catch (e: any) {
        console.error("Fetch Public Scoreboard Error:", e);
        return NextResponse.json({ error: "Failed to fetch scoreboard data" }, { status: 500 });
    }
}
