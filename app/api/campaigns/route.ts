import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';


// Helper to safely serialize BigInt
function safeJSON(data: any) {
    return JSON.parse(JSON.stringify(data, (key, value) =>
        typeof value === 'bigint'
            ? value.toString()
            : value // return everything else unchanged
    ));
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json();
        const {
            customerId,
            name,
            goalAmount,
            endDate,
            missionText, // Optional
            aboutText, // Optional
            participantLabel, // Optional
            groupLabel // Optional
        } = body;

        if (!customerId || !name) {
            return NextResponse.json({ error: "Customer ID and Name are required" }, { status: 400 });
        }

        // Verify customer exists and belongs to user's business (if applicable)
        // For Super Admin/FreezerIQ, we assume access to all, but good practice to check business_id if we were stricter.

        const campaign = await prisma.fundraiserCampaign.create({
            data: {
                customer_id: customerId,
                name,
                goal_amount: goalAmount ? Number(goalAmount) : undefined,
                end_date: endDate ? new Date(endDate) : undefined,
                // @ts-ignore - Stale client
                mission_text: missionText,
                // @ts-ignore - Stale client
                about_text: aboutText,
                // @ts-ignore - Stale client
                participant_label: participantLabel || 'Seller',
                // @ts-ignore - Stale client
                group_label: groupLabel,
                // @ts-ignore - Stale client
                is_group_enabled: !!groupLabel,
                status: 'Active',
                // Generate tokens automatically via default(cuid()) in schema, 
                // but we can also set them explicitly if we wanted specific formats. 
                // Schema has @default(cuid()), so we leave them out.
            }
        });

        return NextResponse.json(campaign);

    } catch (e: any) {
        console.error("Failed to create campaign:", e);
        return NextResponse.json({ error: e.message || "Internal Server Error" }, { status: 500 });
    }
}

export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { searchParams } = new URL(req.url);
        const customerId = searchParams.get('customerId');

        try {
            // Fetch Business Slug for Public URL construction
            const business = await prisma.business.findUnique({
                where: { id: session.user.businessId },
                select: { slug: true }
            });
            const businessSlug = business?.slug || 'demo';

            // 1. Fetch Customers (Scoped to Business)
            const customers = await prisma.customer.findMany({
                where: {
                    business_id: session.user.businessId,
                    type: { in: ['fundraiser_org', 'organization'] as any }, // Cast to any to avoid Enum issues if stale
                    ...(customerId ? { id: customerId } : {})
                },
                orderBy: { name: 'asc' }
            });

            // 2. Fetch Campaigns (Scoped to Business)
            // We fetch ALL campaigns for this business to map them, 
            // or we could filter by the customer IDs we just found, but business_id is enough safety.
            const campaigns = await prisma.fundraiserCampaign.findMany({
                where: {
                    customer: {
                        business_id: session.user.businessId
                    },
                    ...(customerId ? { customer_id: customerId } : {})
                },
                orderBy: { created_at: 'desc' },
                select: {
                    id: true,
                    name: true,
                    status: true,
                    start_date: true,
                    end_date: true,
                    goal_amount: true,
                    total_sales: true,
                    participant_label: true,
                    group_label: true,
                    is_group_enabled: true,
                    customer_id: true,
                    created_at: true,
                    portal_token: true
                } as any // Use 'as any' for select to avoid TS errors on potential missing fields
            });

            // 3. In-Memory Join
            const results: any[] = [];
            const campaignMap = new Map<string, any[]>();

            // Group campaigns by customer
            for (const camp of campaigns) {
                const cid = (camp as any).customer_id;
                if (!campaignMap.has(cid)) {
                    campaignMap.set(cid, []);
                }
                campaignMap.get(cid)?.push(camp);
            }

            for (const c of customers) {
                const customerCampaigns = campaignMap.get(c.id) || [];

                if (customerCampaigns.length > 0) {
                    for (const fc of customerCampaigns) {
                        results.push({
                            id: fc.id,
                            name: fc.name,
                            status: fc.status,
                            start_date: fc.start_date,
                            end_date: fc.end_date,
                            goal_amount: Number(fc.goal_amount || 0),
                            sales_total: Number(fc.total_sales || 0),
                            customer_id: c.id,
                            customer: { name: c.name, contact_name: (c as any).contact_name || null },
                            is_placeholder: false,
                            business_slug: businessSlug,
                            participant_label: (fc as any).participant_label || 'Seller',
                            group_label: (fc as any).group_label,
                            is_group_enabled: (fc as any).is_group_enabled,
                            portal_token: (fc as any).portal_token
                        });
                    }
                } else {
                    // Lead Placeholder
                    results.push({
                        id: `new-${c.id}`,
                        name: `${c.name} Fundraiser`,
                        status: 'Lead',
                        customer_id: c.id,
                        customer: { name: c.name, contact_name: (c as any).contact_name || null },
                        is_placeholder: true,
                        business_slug: businessSlug,
                        goal_amount: 0,
                        sales_total: 0
                    });
                }
            }

            return NextResponse.json(safeJSON(results));

        } catch (dbError) {
            console.error("Database Error in Campaign Fetch:", dbError);
            return NextResponse.json({ error: "Database Error" }, { status: 500 });
        }

    } catch (e: any) {
        console.error("Failed to fetch campaigns:", e);
        return NextResponse.json({ error: e.message || "Unknown Error" }, { status: 500 });
    }
}
