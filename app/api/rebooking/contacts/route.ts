/**
 * FR-RETENTION-1B-1 — Rebooking contacts (READ-ONLY).
 *
 * ACCESS MODEL: session-authenticated, tenant-scoped via session.user.businessId.
 * SCOPE: one row per DURABLE PERSON (FundraiserContact) — never one row per email
 *        address. Two people sharing an inbox stay two rows; the audience/send
 *        flow is where addresses get deduplicated, and that is a later checkpoint.
 *
 * Checkpoint 1 derives only the statuses that exist without outreach tables:
 *   ready_to_invite · cant_email · archived
 * Outreach-driven statuses (update sent, needs review, needs a coordinator,
 * ready to create, rebooked) arrive with Checkpoints 2–5.
 *
 * NOTE: campaign fields are deliberately limited to columns present in every
 * environment — the CB-1 `bundle_selection_*` columns are not selected here.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export type RebookingStatus =
    | 'ready_to_invite'
    | 'cant_email'
    | 'archived';

export interface RebookingOrgSummary {
    customer_id: string;
    name: string;
    archived: boolean;
    campaign_count: number;
    last_campaign_name: string | null;
    last_campaign_closed_at: string | null;
    last_settlement_total: number | null;
}

export interface RebookingContactRow {
    contact_id: string;
    display_name: string;
    email: string | null;
    email_masked: string | null;
    is_shared_inbox: boolean;
    shares_address_with: number;   // other contacts on the same address
    needs_review: boolean;
    review_reason: string | null;
    organizations: RebookingOrgSummary[];
    status: RebookingStatus;
    status_label: string;
    exclusion_reason: string | null;
    next_step: string;
}

function maskEmail(email: string | null): string | null {
    if (!email) return null;
    const [user, domain] = email.split('@');
    if (!domain) return email;
    return `${user.slice(0, 1)}•••@${domain}`;
}

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const contacts = await prisma.fundraiserContact.findMany({
            where: { business_id: businessId },
            select: {
                id: true,
                display_name: true,
                needs_review: true,
                review_reason: true,
                archived_at: true,
                contact_points: {
                    where: { is_current: true, type: 'email' },
                    select: { value: true, normalized_value: true, is_shared_inbox: true, is_primary: true },
                    orderBy: { is_primary: 'desc' },
                },
                org_contacts: {
                    where: { ended_at: null },
                    select: {
                        customer: {
                            select: {
                                id: true,
                                name: true,
                                archived: true,
                                campaigns: {
                                    select: {
                                        name: true,
                                        closed_at: true,
                                        settlement_total: true,
                                    },
                                    orderBy: { created_at: 'desc' },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: { display_name: 'asc' },
        });

        // How many DISTINCT contacts sit on each address — powers "2 people" badges
        // without ever merging them into one row.
        const addressCounts = new Map<string, number>();
        for (const c of contacts) {
            const e = c.contact_points[0]?.normalized_value;
            if (!e) continue;
            addressCounts.set(e, (addressCounts.get(e) ?? 0) + 1);
        }

        const rows: RebookingContactRow[] = contacts.map((c) => {
            const point = c.contact_points[0] ?? null;
            const email = point?.value ?? null;
            const normalized = point?.normalized_value ?? null;
            const sharesWith = normalized ? Math.max(0, (addressCounts.get(normalized) ?? 1) - 1) : 0;

            const organizations: RebookingOrgSummary[] = c.org_contacts.map((oc) => {
                const camps = oc.customer.campaigns;
                const last = camps[0] ?? null;
                return {
                    customer_id: oc.customer.id,
                    name: oc.customer.name,
                    archived: oc.customer.archived,
                    campaign_count: camps.length,
                    last_campaign_name: last?.name ?? null,
                    last_campaign_closed_at: last?.closed_at ? last.closed_at.toISOString() : null,
                    last_settlement_total: last?.settlement_total != null ? Number(last.settlement_total) : null,
                };
            });

            const allArchived = organizations.length > 0 && organizations.every((o) => o.archived);

            let status: RebookingStatus;
            let status_label: string;
            let exclusion_reason: string | null = null;
            let next_step: string;

            if (c.archived_at || allArchived) {
                status = 'archived';
                status_label = 'Archived';
                next_step = 'View history';
            } else if (!email) {
                status = 'cant_email';
                status_label = "Can't email";
                exclusion_reason = 'No email';
                next_step = 'Fix contact info';
            } else {
                status = 'ready_to_invite';
                status_label = 'Ready to invite';
                next_step = 'Included in next update';
            }

            return {
                contact_id: c.id,
                display_name: c.display_name,
                email,
                email_masked: maskEmail(email),
                is_shared_inbox: point?.is_shared_inbox ?? false,
                shares_address_with: sharesWith,
                needs_review: c.needs_review,
                review_reason: c.review_reason,
                organizations,
                status,
                status_label,
                exclusion_reason,
                next_step,
            };
        });

        const counts = {
            all: rows.length,
            ready_to_invite: rows.filter((r) => r.status === 'ready_to_invite').length,
            waiting: 0,       // populated in Checkpoint 3
            needs_action: rows.filter((r) => r.status === 'cant_email' || r.needs_review).length,
            done: 0,          // populated in Checkpoint 5
        };

        return NextResponse.json({ contacts: rows, counts });
    } catch (e: any) {
        console.error('[Rebooking Contacts] Failed:', e);
        return NextResponse.json({ error: 'Failed to load rebooking contacts' }, { status: 500 });
    }
}
