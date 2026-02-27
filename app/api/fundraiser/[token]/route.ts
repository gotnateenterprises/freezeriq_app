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
                customer: {
                    select: {
                        name: true,
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

        // Fetch Specific Bundles assigned to the Fundraiser via Invoice
        let bundles: any[] = [];
        const businessId = (campaign.customer as any)?.business_id;

        const latestInvoice = await prisma.invoice.findFirst({
            where: { customer_id: (campaign as any).customer_id },
            orderBy: { created_at: 'desc' },
            include: {
                items: {
                    include: {
                        bundle: {
                            select: {
                                id: true,
                                name: true,
                                price: true,
                                serving_tier: true,
                                description: true,
                                image_url: true
                            }
                        }
                    }
                }
            }
        });

        if (latestInvoice && latestInvoice.items.length > 0) {
            bundles = latestInvoice.items
                .filter((item: any) => item.bundle)
                .map((item: any) => item.bundle);
            bundles = Array.from(new Map(bundles.map(b => [b.id, b])).values());
        } else if (businessId) {
            bundles = await prisma.bundle.findMany({
                where: {
                    business_id: businessId,
                    is_active: true
                },
                select: {
                    id: true,
                    name: true,
                    price: true,
                    serving_tier: true,
                    description: true,
                    image_url: true
                }
            });
        }

        return NextResponse.json({ ...campaign, availableBundles: bundles });

    } catch (e: any) {
        console.error("Fetch Public Scoreboard Error:", e);
        return NextResponse.json({ error: "Failed to fetch scoreboard data" }, { status: 500 });
    }
}
