/**
 * GE-5A — automation policy (per-tenant on/off).
 *
 * GET  — this tenant's policies.
 * PUT  — explicitly enable or disable one action family.
 *
 * Enabling is always a deliberate tenant act. Nothing else in GE-5A creates a
 * policy row: the evaluator refuses when one is missing rather than helpfully
 * writing one, because a system that switches itself on is exactly what this
 * phase exists to prevent.
 *
 * DISABLE IS ATOMIC. Flipping the switch and retiring the work it authorised
 * happen in ONE transaction, so there is no committed moment where the policy
 * reads "off" while an approved action still looks actionable to GE-7. History
 * is retired, never deleted — rows move to `expired` with a reason.
 *
 * Sends no email. Creates no OutreachBatch.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { AUTOMATION_ACTION_TYPE, ACTIVE_STATUSES } from '@/lib/growth/automation';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        // Tenant identity comes from the session and only from the session.
        const businessId = session.user.businessId;

        const policies = await prisma.automationPolicy.findMany({
            where: { business_id: businessId },
            select: {
                action_type: true,
                enabled: true,
                updated_by_user_id: true,
                updated_at: true,
            },
        });

        // Absence is a meaningful answer, so report the family as disabled
        // rather than omitting it and letting the caller guess.
        const known = new Set(policies.map(p => String(p.action_type)));
        const rows = [
            ...policies.map(p => ({ ...p, action_type: String(p.action_type) })),
            ...(known.has(AUTOMATION_ACTION_TYPE)
                ? []
                : [{
                    action_type: AUTOMATION_ACTION_TYPE,
                    enabled: false,
                    updated_by_user_id: null,
                    updated_at: null,
                }]),
        ];

        return NextResponse.json({ policies: rows });
    } catch (e: unknown) {
        console.error('[growth/automation/policy GET]', e);
        return NextResponse.json({ error: 'Failed to load automation policy' }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const userId = (session.user as { id?: string }).id ?? null;

        const body = await req.json().catch(() => ({}));
        // Any business_id in the payload is ignored outright — not validated,
        // not compared. There is no path by which a client can name a tenant.
        const actionType = String(body.action_type ?? AUTOMATION_ACTION_TYPE);
        const enabled = body.enabled;

        if (actionType !== AUTOMATION_ACTION_TYPE) {
            return NextResponse.json({ error: 'Unknown action type' }, { status: 400 });
        }
        if (typeof enabled !== 'boolean') {
            return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 });
        }

        const now = new Date();

        const result = await prisma.$transaction(async (tx) => {
            const policy = await tx.automationPolicy.upsert({
                where: {
                    business_id_action_type: {
                        business_id: businessId,
                        action_type: AUTOMATION_ACTION_TYPE as never,
                    },
                },
                create: {
                    business_id: businessId,
                    action_type: AUTOMATION_ACTION_TYPE as never,
                    enabled,
                    updated_by_user_id: userId,
                },
                update: { enabled, updated_by_user_id: userId },
                select: { enabled: true, action_type: true, updated_at: true },
            });

            // Same transaction: nothing the policy authorised may outlive it.
            let retired = 0;
            if (!enabled) {
                const swept = await tx.automationAction.updateMany({
                    where: {
                        business_id: businessId,
                        action_type: AUTOMATION_ACTION_TYPE as never,
                        status: { in: ACTIVE_STATUSES as never },
                    },
                    data: {
                        status: 'expired' as never,
                        expired_at: now,
                        expired_reason: 'policy_disabled',
                    },
                });
                retired = swept.count;
            }

            return { policy, retired };
        });

        return NextResponse.json({
            action_type: String(result.policy.action_type),
            enabled: result.policy.enabled,
            // Truthful on a repeat call: disabling an already-disabled policy
            // reports 0 rather than implying work happened.
            retired_actions: result.retired,
        });
    } catch (e: unknown) {
        console.error('[growth/automation/policy PUT]', e);
        return NextResponse.json({ error: 'Failed to update automation policy' }, { status: 500 });
    }
}
