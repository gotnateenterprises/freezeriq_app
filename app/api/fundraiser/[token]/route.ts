import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

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
                        fundraiser_info: true,
                    }
                },
                orders: {
                    orderBy: { created_at: 'desc' },
                    take: 10, // Just labels for ticker
                    select: {
                        customer_name: true,
                        total_amount: true,
                        created_at: true
                    }
                }
            }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
        }

        return NextResponse.json(campaign);

    } catch (e: any) {
        console.error("Fetch Public Scoreboard Error:", e);
        return NextResponse.json({ error: "Failed to fetch scoreboard data" }, { status: 500 });
    }
}
