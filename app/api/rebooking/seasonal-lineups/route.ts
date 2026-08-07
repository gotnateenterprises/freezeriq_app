/**
 * FR-RETENTION-2 — Seasonal Lineups (list + create/update draft).
 *
 * ACCESS MODEL: session-authenticated, tenant-scoped via session.user.businessId.
 * business_id is NEVER read from the client.
 *
 * Sends no email, issues no token, and creates nothing outside the lineup.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { validateLineup, type LineupInput } from '@/lib/seasonalLineup';
import { resolveEligibleBundleFamilies } from '@/lib/campaignBundleSelection';

export interface LineupSummary {
    id: string;
    name: string;
    startsAt: string;
    endsAt: string;
    status: string;
    coordinatorBundleLimit: number;
    familyIds: string[];
    subjectOverride: string | null;
    salesLetter: string | null;
    internalNotes: string | null;
    /** True once an audience exists, so the UI can stop offering free edits. */
    hasAudience: boolean;
    updatedAt: string;
}

function serialize(o: {
    id: string; name: string; starts_at: Date; ends_at: Date; status: string;
    coordinator_bundle_limit: number; subject_override: string | null;
    sales_letter: string | null; internal_notes: string | null; updated_at: Date;
    families: { family_id: string }[]; _count?: { outreach_batches: number };
}): LineupSummary {
    return {
        id: o.id,
        name: o.name,
        startsAt: o.starts_at.toISOString(),
        endsAt: o.ends_at.toISOString(),
        status: o.status,
        coordinatorBundleLimit: o.coordinator_bundle_limit,
        familyIds: o.families.map((f) => f.family_id),
        subjectOverride: o.subject_override,
        salesLetter: o.sales_letter,
        internalNotes: o.internal_notes,
        hasAudience: (o._count?.outreach_batches ?? 0) > 0,
        updatedAt: o.updated_at.toISOString(),
    };
}

const SELECT = {
    id: true, name: true, starts_at: true, ends_at: true, status: true,
    coordinator_bundle_limit: true, subject_override: true, sales_letter: true,
    internal_notes: true, updated_at: true,
    families: { select: { family_id: true }, orderBy: { position: 'asc' } },
    _count: { select: { outreach_batches: true } },
} as const;

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;

        const [lineups, families] = await Promise.all([
            prisma.seasonalOffering.findMany({
                where: { business_id: businessId, archived_at: null },
                select: SELECT,
                orderBy: { updated_at: 'desc' },
            }),
            resolveEligibleBundleFamilies(businessId),
        ]);

        return NextResponse.json({ lineups: lineups.map(serialize), eligibleFamilies: families });
    } catch (e) {
        console.error('[Seasonal Lineups] GET failed:', e);
        return NextResponse.json({ error: 'Failed to load seasonal lineups' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;

        const body = await req.json();
        const lineupId: string | null = typeof body.id === 'string' && body.id ? body.id : null;

        const input: LineupInput = {
            name: body.name,
            startsAt: body.startsAt,
            endsAt: body.endsAt,
            familyIds: Array.isArray(body.familyIds) ? body.familyIds : [],
            coordinatorBundleLimit: body.coordinatorBundleLimit,
        };

        const validation = await validateLineup(businessId, input);
        if (!validation.ok || !validation.normalized) {
            return NextResponse.json({ errors: validation.errors }, { status: 400 });
        }
        const n = validation.normalized;

        // Editing: the lineup must belong to this tenant, and must not already
        // be locked by a reviewed audience.
        if (lineupId) {
            const existing = await prisma.seasonalOffering.findFirst({
                where: { id: lineupId, business_id: businessId },
                select: { id: true, status: true, _count: { select: { outreach_batches: true } } },
            });
            if (!existing) return NextResponse.json({ error: 'Seasonal lineup not found' }, { status: 404 });
            if (existing.status === 'in_use') {
                return NextResponse.json(
                    { errors: ['This lineup has already been used for an update, so it can no longer be changed.'] },
                    { status: 409 },
                );
            }
        }

        const saved = await prisma.$transaction(async (tx) => {
            const offering = lineupId
                ? await tx.seasonalOffering.update({
                    where: { id: lineupId },
                    data: {
                        name: n.name, starts_at: n.startsAt, ends_at: n.endsAt,
                        coordinator_bundle_limit: n.coordinatorBundleLimit,
                        subject_override: body.subjectOverride ?? null,
                        sales_letter: body.salesLetter ?? null,
                        internal_notes: body.internalNotes ?? null,
                    },
                })
                : await tx.seasonalOffering.create({
                    data: {
                        business_id: businessId,
                        name: n.name, starts_at: n.startsAt, ends_at: n.endsAt,
                        coordinator_bundle_limit: n.coordinatorBundleLimit,
                        subject_override: body.subjectOverride ?? null,
                        sales_letter: body.salesLetter ?? null,
                        internal_notes: body.internalNotes ?? null,
                        created_by_user_id: (session.user as { id?: string }).id ?? null,
                    },
                });

            // Families are replaced wholesale — simpler and race-free compared
            // with diffing, and the set is always small.
            await tx.seasonalOfferingFamily.deleteMany({ where: { seasonal_offering_id: offering.id } });
            for (let i = 0; i < n.familyIds.length; i++) {
                await tx.seasonalOfferingFamily.create({
                    data: {
                        business_id: businessId,
                        seasonal_offering_id: offering.id,
                        family_id: n.familyIds[i],
                        position: i,
                    },
                });
            }

            return tx.seasonalOffering.findFirstOrThrow({
                where: { id: offering.id, business_id: businessId },
                select: SELECT,
            });
        });

        return NextResponse.json({ lineup: serialize(saved) });
    } catch (e) {
        console.error('[Seasonal Lineups] POST failed:', e);
        return NextResponse.json({ error: 'Failed to save seasonal lineup' }, { status: 500 });
    }
}
