
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;
        const body = await req.json();

        // Validate Status
        const validStatuses = ['Lead', 'Agreement', 'Onboarding', 'Active', 'Production', 'Delivery', 'Archived'];

        if (body.status && !validStatuses.includes(body.status)) {
            return NextResponse.json({ error: "Invalid status" }, { status: 400 });
        }

        // Verify ownership (via Customer -> Business)
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { id },
            include: { customer: true }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
        }

        if (campaign.customer.business_id !== session.user.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        // Update
        const updated = await prisma.fundraiserCampaign.update({
            where: { id },
            data: {
                name: body.name,
                status: body.status,
                start_date: body.start_date ? new Date(body.start_date) : undefined,
                end_date: body.end_date ? new Date(body.end_date) : undefined,
                delivery_date: body.delivery_date ? new Date(body.delivery_date) : undefined,
                goal_amount: body.goal_amount ? Number(body.goal_amount) : undefined,
                about_text: body.about_text,
                mission_text: body.mission_text,
                payment_instructions: body.payment_instructions,
                external_payment_link: body.external_payment_link,
                checklist: body.checklist ?? undefined,
                // Terminology labels
                participant_label: body.participant_label ?? undefined,
                group_label: body.group_label ?? undefined,
                is_group_enabled: body.is_group_enabled ?? undefined,
            } as any
        });

        return NextResponse.json(updated);

    } catch (e) {
        console.error("Campaign Update Error:", e);
        return NextResponse.json({ error: "Server Error" }, { status: 500 });
    }
}
