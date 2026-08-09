/**
 * FR-RETENTION-5 — the Start Fundraiser handoff context.
 *
 * GET → everything the EXISTING StartFundraiserWizard needs to open pre-filled
 *       for one approved rebooking opportunity.
 *
 * This endpoint creates nothing. It is a read that assembles evidence, and the
 * tenant still walks the normal wizard before any fundraiser exists.
 *
 * TENANT ISOLATION: the client sends one opportunity id and nothing else.
 * business_id, customer_id and the seasonal lineup are all DERIVED here from the
 * session and the opportunity row — never accepted from the browser. The public
 * rebooking token plays no part in this path and is never read.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { resolveEligibleBundleFamilies } from '@/lib/campaignBundleSelection';
import {
    buildConversionPrefill,
    evaluateConversion,
    refusalHttpStatus,
    toDateInputValue,
    type ConvertibleOpportunity,
} from '@/lib/rebookingConversion';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const { id } = await ctx.params;

        const opp = await prisma.rebookingOpportunity.findFirst({
            // Scoped by business_id here as well as checked below — defence in
            // depth costs nothing and a findUnique by id alone would be a
            // cross-tenant read waiting to happen.
            where: { id, business_id: businessId },
            select: {
                id: true, business_id: true, customer_id: true, status: true, campaign_id: true,
                organization_name: true, coordinator_intent: true, coordinator_name: true,
                preferred_start_date: true, alternate_start_date: true, participant_estimate: true,
                seasonal_offering_id: true,
                submission: { select: { recipient: { select: { display_name: true } } } },
                source_revision: { select: { preferred_end_date: true, notes: true } },
            },
        });

        const shape: ConvertibleOpportunity | null = opp
            ? {
                id: opp.id, businessId: opp.business_id, customerId: opp.customer_id,
                status: opp.status, campaignId: opp.campaign_id,
            }
            : null;

        const verdict = evaluateConversion(shape, businessId);
        if (!verdict.ok) {
            return NextResponse.json(
                {
                    error: verdict.message,
                    refusal: verdict.refusal,
                    existingCampaignId: verdict.existingCampaignId,
                },
                { status: refusalHttpStatus(verdict.refusal!) },
            );
        }

        const offering = await prisma.seasonalOffering.findFirst({
            where: { business_id: businessId, id: opp!.seasonal_offering_id },
            select: {
                name: true, coordinator_bundle_limit: true,
                families: { select: { family_id: true }, orderBy: { position: 'asc' } },
            },
        });

        // The organization is re-read rather than trusted from the opportunity,
        // so the wizard cannot be handed a customer that has since been archived
        // or moved.
        const customer = await prisma.customer.findFirst({
            where: { id: opp!.customer_id, business_id: businessId },
            select: { id: true, name: true, archived: true },
        });
        if (!customer) {
            return NextResponse.json({ error: 'That organization could not be found.' }, { status: 404 });
        }

        const eligible = await resolveEligibleBundleFamilies(businessId);

        const prefill = buildConversionPrefill({
            organizationName: customer.name,
            lineupName: offering?.name ?? '',
            preferredStartDate: opp!.preferred_start_date,
            alternateStartDate: opp!.alternate_start_date,
            requestedEndDate: opp!.source_revision?.preferred_end_date ?? null,
            participantEstimate: opp!.participant_estimate,
            coordinatorIntent: opp!.coordinator_intent,
            coordinatorName: opp!.coordinator_name,
            respondentName: opp!.submission?.recipient?.display_name ?? 'The person who replied',
            lineupFamilyIds: (offering?.families ?? []).map((f) => f.family_id),
            eligibleFamilyIds: eligible.map((f) => f.familyId),
            coordinatorBundleLimit: offering?.coordinator_bundle_limit ?? 2,
        });

        const nameByFamily = new Map(eligible.map((f) => [f.familyId, f.serves5.name]));

        return NextResponse.json({
            opportunityId: opp!.id,
            customerId: customer.id,
            organizationName: customer.name,
            organizationArchived: customer.archived,
            lineupName: offering?.name ?? '',
            ...prefill,
            candidateFamilyNames: prefill.candidateFamilyIds.map((f) => nameByFamily.get(f) ?? f),
            // Shown as context the tenant confirms — never written anywhere by
            // this endpoint.
            requestedPreferredStart: toDateInputValue(opp!.preferred_start_date),
            requestedAlternateStart: toDateInputValue(opp!.alternate_start_date),
            respondentNotes: opp!.source_revision?.notes ?? null,
        });
    } catch (e) {
        console.error('[Rebooking handoff] GET failed:', e);
        return NextResponse.json({ error: 'Could not prepare the fundraiser handoff' }, { status: 500 });
    }
}
