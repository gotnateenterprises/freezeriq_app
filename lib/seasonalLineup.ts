/**
 * FR-RETENTION-2 — Seasonal Lineup validation and audience loading.
 *
 * Tenant naming: the model is SeasonalOffering; every tenant-facing string says
 * "Seasonal Lineup". Nothing here returns a technical status or an internal id
 * to the UI.
 */

import { prisma } from '@/lib/db';
import { resolveEligibleBundleFamilies } from '@/lib/campaignBundleSelection';
import type { AudienceContactInput, AudiencePreferenceInput } from '@/lib/seasonalAudience';

export interface LineupInput {
    name: string;
    startsAt: string;
    endsAt: string;
    familyIds: string[];
    coordinatorBundleLimit: number;
}

export interface ValidationResult {
    ok: boolean;
    /** Plain-language messages, safe to show a tenant verbatim. */
    errors: string[];
    normalized?: {
        name: string;
        startsAt: Date;
        endsAt: Date;
        familyIds: string[];
        coordinatorBundleLimit: number;
    };
}

/**
 * Validates a lineup against tenant-owned, currently-eligible families.
 *
 * Every family is re-checked against the CB-4 resolver on write — the client's
 * list is never trusted, so a stale tab, a cross-tenant id, or a family that
 * lost its Serves-2 sibling since the page loaded is all caught here.
 */
export async function validateLineup(businessId: string, input: LineupInput): Promise<ValidationResult> {
    const errors: string[] = [];

    const name = (input.name ?? '').trim();
    if (!name) errors.push('Give this lineup a name.');

    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) errors.push('Choose a start date.');
    if (!endsAt || Number.isNaN(endsAt.getTime())) errors.push('Choose an end date.');
    if (startsAt && endsAt && !Number.isNaN(startsAt.getTime()) && !Number.isNaN(endsAt.getTime()) && endsAt < startsAt) {
        errors.push('The end date must be on or after the start date.');
    }

    const requested = Array.from(new Set(input.familyIds ?? []));
    if (requested.length === 0) errors.push('Choose at least one bundle for this season.');

    let eligibleIds: string[] = [];
    if (requested.length > 0) {
        const eligible = await resolveEligibleBundleFamilies(businessId);
        const eligibleSet = new Set(eligible.map((f) => f.familyId));
        // Anything not in the tenant's own eligible set is rejected — this is
        // simultaneously the cross-tenant check and the still-eligible check.
        const rejected = requested.filter((id) => !eligibleSet.has(id));
        if (rejected.length > 0) {
            errors.push(
                rejected.length === 1
                    ? "One of the bundles you chose isn't available any more. Refresh and choose again."
                    : `${rejected.length} of the bundles you chose aren't available any more. Refresh and choose again.`,
            );
        }
        eligibleIds = requested.filter((id) => eligibleSet.has(id));
    }

    const limit = Number(input.coordinatorBundleLimit);
    if (!Number.isInteger(limit) || limit < 1) {
        errors.push('Coordinators must be able to choose at least one bundle.');
    } else if (eligibleIds.length > 0 && limit > eligibleIds.length) {
        errors.push(`Coordinators can't choose ${limit} bundles when only ${eligibleIds.length} are in this lineup.`);
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
        ok: true,
        errors: [],
        normalized: { name, startsAt: startsAt!, endsAt: endsAt!, familyIds: eligibleIds, coordinatorBundleLimit: limit },
    };
}

/**
 * Loads the audience candidate population for a tenant: durable contacts that
 * currently represent at least one organization, plus their current primary
 * email and their current marketing preferences.
 */
export async function loadAudienceInputs(businessId: string): Promise<{
    contacts: AudienceContactInput[];
    preferences: AudiencePreferenceInput[];
}> {
    const contacts = await prisma.fundraiserContact.findMany({
        where: { business_id: businessId },
        select: {
            id: true,
            display_name: true,
            archived_at: true,
            needs_review: true,
            review_reason: true,
            contact_points: {
                where: { is_current: true, type: 'email' },
                select: { value: true, is_primary: true },
                orderBy: { is_primary: 'desc' },
            },
            org_contacts: {
                where: { ended_at: null },
                select: { customer: { select: { id: true, name: true, archived: true } } },
            },
        },
        orderBy: { display_name: 'asc' },
    });

    const preferences = await prisma.marketingPreference.findMany({
        where: { business_id: businessId },
        select: { scope: true, contact_id: true, normalized_email: true, status: true, effective_until: true },
    });

    return {
        contacts: contacts.map((c) => ({
            contactId: c.id,
            displayName: c.display_name,
            archivedAt: c.archived_at,
            needsReview: c.needs_review,
            reviewReason: c.review_reason,
            email: c.contact_points[0]?.value ?? null,
            organizations: c.org_contacts.map((oc) => ({
                customerId: oc.customer.id,
                name: oc.customer.name,
                archived: oc.customer.archived,
            })),
        })),
        preferences: preferences.map((p) => ({
            scope: p.scope,
            contactId: p.contact_id,
            normalizedEmail: p.normalized_email,
            status: p.status,
            effectiveUntil: p.effective_until,
        })),
    };
}
