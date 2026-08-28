
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { decideOrgShareChange, isOrgShareRejected } from '@/lib/fundraiserOrgShare';
import { decideBundleGoalChange, isBundleGoalRejected } from '@/lib/fundraiserMetrics';
import { isCampaignClosed } from '@/lib/campaignBundleSelection';

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

        // ── INV-A: per-campaign organization share ────────────────────────────
        // Editable only while the fundraiser is financially open. Once closeout
        // has frozen settlement_total, the share is part of the frozen financial
        // contract: the invoice must stay reproducible from
        // (frozen gross, frozen percent), so silently changing it afterwards
        // would retroactively rewrite what the organization owes.
        //
        // An explicit share change must clear BOTH gates: the caller is
        // authorized to set financial terms (403), AND the campaign is still
        // financially open (409). Authorization is checked first so an
        // unauthorized caller cannot probe a campaign's closeout state.
        // Non-financial edits on this route keep their existing permissions.
        const orgShareDecision = decideOrgShareChange({
            requested: body.orgSharePercent,
            user: {
                role: (session.user as any).role,
                isSuperAdmin: (session.user as any).isSuperAdmin === true,
            },
            campaignClosed: isCampaignClosed({
                closed_at: (campaign as any).closed_at ?? null,
                status: campaign.status,
            }),
        });
        if (isOrgShareRejected(orgShareDecision)) {
            return NextResponse.json({ error: orgShareDecision.error }, { status: orgShareDecision.status });
        }
        const orgSharePercentValue: number | undefined = orgShareDecision.change
            ? orgShareDecision.percent
            : undefined;

        // ── FR-GOAL-CONFIG-1: tenant-controlled weighted bundle goal ───────────
        // Same closeout gate as the organization share above: once a fundraiser
        // is financially closed, changing the denominator would retroactively
        // rewrite what "on track" meant during a campaign that already ended.
        // Unlike org share this carries no role gate — the goal is not a
        // financial contract term, so any tenant user permitted on this route
        // (already scoped to this business above) may set it. Omission leaves
        // the stored goal untouched; the numerator is never touched here at all.
        const bundleGoalDecision = decideBundleGoalChange({
            requested: body.bundleGoal,
            campaignClosed: isCampaignClosed({
                closed_at: (campaign as any).closed_at ?? null,
                status: campaign.status,
            }),
        });
        if (isBundleGoalRejected(bundleGoalDecision)) {
            return NextResponse.json({ error: bundleGoalDecision.error }, { status: bundleGoalDecision.status });
        }
        const bundleGoalValue: number | undefined = bundleGoalDecision.change
            ? bundleGoalDecision.goal
            : undefined;

        // Update
        const updated = await prisma.fundraiserCampaign.update({
            where: { id },
            data: {
                ...(orgSharePercentValue !== undefined
                    ? { org_share_percent: orgSharePercentValue }
                    : {}),
                ...(bundleGoalValue !== undefined
                    ? { bundle_goal: bundleGoalValue }
                    : {}),
                name: body.name,
                status: body.status,
                start_date: body.start_date ? new Date(body.start_date) : undefined,
                end_date: body.end_date ? new Date(body.end_date) : undefined,
                delivery_date: body.delivery_date ? new Date(body.delivery_date) : undefined,
                pickup_location: body.pickup_location ?? undefined,
                checks_payable: body.checks_payable ?? undefined,
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
