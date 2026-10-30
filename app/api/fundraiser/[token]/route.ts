import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { toPublicScoreboard } from '@/lib/publicFundraiserPayload';

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

        // FR-SUPPORTER-SHARE-INTEGRITY-1: select, and return, only what the
        // public scoreboard renders (lib/publicFundraiserPayload.toPublicScoreboard).
        // It used to also return the lifecycle status, the dollar goal, the dates,
        // the fundraiser's DOLLAR sales, and each supporter's order total — none of
        // which the scoreboard shows. Progress is in weighted bundles, from items.
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { public_token: token },
            select: {
                name: true,
                bundle_selection_status: true,
                bundle_goal: true,
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
                    where: { canceled_at: null },
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

        // Privacy: supporter names are masked to first name + last initial.
        return NextResponse.json(toPublicScoreboard(campaign as any, maskName));

    } catch (e: any) {
        console.error("Fetch Public Scoreboard Error:", e);
        return NextResponse.json({ error: "Failed to fetch scoreboard data" }, { status: 500 });
    }
}
