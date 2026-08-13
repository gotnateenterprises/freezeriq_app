/**
 * GE-5A — approve one recommendation.
 *
 * Approval is a human decision and the only way out of `candidate`. It records
 * intent; it does NOT send anything. GE-7 will later be allowed to act on an
 * approved action — which is exactly why the conditions are re-checked here
 * rather than trusted from whenever the candidate was proposed.
 *
 * If the world moved on in between, the action is retired instead of approved:
 * a suppressed coordinator becomes `suppressed`, a closed offering or disabled
 * policy becomes `expired` with a controlled reason.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { normalizeEmail } from '@/lib/seasonalAudience';
import { isRealCampaign } from '@/lib/growth/impact';
import {
    AUTOMATION_ACTION_TYPE,
    decideApproval,
    evaluateSuppression,
} from '@/lib/growth/automation';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const userId = (session.user as { id?: string }).id ?? null;
        const { id } = await params;
        const now = new Date();

        // Scoped read: another tenant's id is simply not found.
        const action = await prisma.automationAction.findFirst({
            where: { id, business_id: businessId, action_type: AUTOMATION_ACTION_TYPE as never },
            select: {
                id: true, status: true, expires_at: true,
                seasonal_offering_id: true, customer_id: true,
            },
        });
        if (!action) return NextResponse.json({ error: 'Action not found' }, { status: 404 });

        if (String(action.status) !== 'candidate') {
            return NextResponse.json({
                error: `Only a candidate can be approved. This action is ${String(action.status)}.`,
            }, { status: 409 });
        }

        const [policy, offering, org] = await Promise.all([
            prisma.automationPolicy.findUnique({
                where: {
                    business_id_action_type: {
                        business_id: businessId,
                        action_type: AUTOMATION_ACTION_TYPE as never,
                    },
                },
                select: { enabled: true },
            }),
            prisma.seasonalOffering.findFirst({
                where: { id: action.seasonal_offering_id, business_id: businessId },
                select: { status: true, archived_at: true, ends_at: true },
            }),
            prisma.customer.findFirst({
                where: { id: action.customer_id, business_id: businessId },
                select: {
                    archived: true,
                    campaigns: { select: { status: true } },
                    org_contacts: {
                        where: { ended_at: null },
                        select: {
                            contact: {
                                select: {
                                    contact_points: {
                                        where: { is_current: true },
                                        select: { normalized_value: true },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
        ]);

        if (!offering || !org) {
            return NextResponse.json({ error: 'Action target no longer exists' }, { status: 409 });
        }

        // Suppression re-read from the authoritative FR-RETENTION tables.
        const [prefs, suppressions] = await Promise.all([
            prisma.marketingPreference.findMany({
                where: { business_id: businessId, status: { not: 'subscribed' as never } },
                select: { normalized_email: true, effective_until: true },
            }),
            prisma.emailSuppressionEvent.findMany({
                where: { business_id: businessId },
                select: { normalized_email: true, effective_until: true },
            }),
        ]);
        const suppressedEmails = new Set<string>();
        for (const p of [...prefs, ...suppressions]) {
            if (!p.normalized_email) continue;
            if (p.effective_until && p.effective_until.getTime() <= now.getTime()) continue;
            suppressedEmails.add(normalizeEmail(p.normalized_email));
        }
        const emails = org.org_contacts
            .flatMap(oc => oc.contact.contact_points)
            .map(cp => cp.normalized_value)
            .filter((v): v is string => !!v);

        const decision = decideApproval({
            policyEnabled: !!policy?.enabled,
            offering: {
                status: String(offering.status),
                archived_at: offering.archived_at,
                ends_at: offering.ends_at,
            },
            target: {
                realCampaignCount: org.campaigns.filter(c => isRealCampaign({ status: String(c.status) })).length,
                archived: org.archived,
            },
            suppression: evaluateSuppression({ normalizedEmails: emails, suppressedEmails }),
            expiresAt: action.expires_at,
            now,
        });

        // Guarded update: the WHERE still requires `candidate`, so a concurrent
        // dismissal or sweep wins and this becomes a no-op rather than a
        // conflicting second transition.
        const guard = { id, business_id: businessId, status: 'candidate' as never };

        if (decision.outcome === 'suppress') {
            const r = await prisma.automationAction.updateMany({
                where: guard,
                data: { status: 'suppressed' as never, suppressed_at: now, suppressed_reason: decision.reason },
            });
            return NextResponse.json({
                status: r.count ? 'suppressed' : 'unchanged',
                reason: decision.reason,
            }, { status: 409 });
        }

        if (decision.outcome === 'expire') {
            const r = await prisma.automationAction.updateMany({
                where: guard,
                data: { status: 'expired' as never, expired_at: now, expired_reason: decision.reason },
            });
            return NextResponse.json({
                status: r.count ? 'expired' : 'unchanged',
                reason: decision.reason,
            }, { status: 409 });
        }

        const updated = await prisma.automationAction.updateMany({
            where: guard,
            data: { status: 'approved' as never, approved_at: now, approved_by_user_id: userId },
        });
        if (updated.count === 0) {
            return NextResponse.json({ error: 'Action changed before approval completed' }, { status: 409 });
        }

        return NextResponse.json({
            id, status: 'approved', approved_at: now,
            // Approval authorises future work. It is not that work.
            email_sent: false,
        });
    } catch (e: unknown) {
        console.error('[growth/automation/actions approve]', e);
        return NextResponse.json({ error: 'Failed to approve action' }, { status: 500 });
    }
}
