/**
 * FR-RETENTION-1B-1 — Rebooking contacts (READ-ONLY).
 *
 * ACCESS MODEL: session-authenticated, tenant-scoped via session.user.businessId.
 * SCOPE: one row per DURABLE PERSON (FundraiserContact) — never one row per email
 *        address. Two people sharing an inbox stay two rows; the audience/send
 *        flow is where addresses get deduplicated, and that is a later checkpoint.
 *
 * FR-RETENTION-6 — this route now derives the FULL launched lifecycle by reading
 * the outreach tables that Checkpoints 2–5 shipped. Until CP6 it still derived
 * only the three pre-outreach states, which left every emailable contact frozen
 * at "Ready to invite" no matter how much real outreach had happened.
 *
 * READ-ONLY: this GET performs no writes. Every status is derived from existing
 * rows; nothing here creates, updates, or claims anything.
 *
 * ATTRIBUTION RULE THAT MATTERS: one delivery recipient (one inbox) may
 * represent several durable people. A delivery attempt is fairly attributed to
 * everyone on that inbox — the email really did arrive there. An OPPORTUNITY is
 * not: it belongs to a specific organization, so it is attributed to this
 * contact only when its customer_id is one of THIS contact's organizations.
 * Without that check, two people sharing an inbox would each inherit the
 * other's fundraiser.
 *
 * NOTE: campaign fields are deliberately limited to columns present in every
 * environment — the CB-1 `bundle_selection_*` columns are not selected here.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    bucketForStatus,
    deriveRebookingRowState,
    resolveActivePreference,
    type PreferenceRow,
    type RebookingBucket,
    type RowState,
} from '@/lib/rebookingRowState';

export type { RebookingStatus, RebookingBucket } from '@/lib/rebookingRowState';

export interface RebookingOrgSummary {
    customer_id: string;
    name: string;
    archived: boolean;
    campaign_count: number;
    last_campaign_name: string | null;
    last_campaign_closed_at: string | null;
    last_settlement_total: number | null;
}

export type RebookingContactRow = RowState & {
    contact_id: string;
    display_name: string;
    // CRM-CC-3 privacy hygiene: the RAW address is no longer serialized. Every
    // consumer (RebookingTab, AttentionStrip) reads only the masked form, so
    // shipping the full address to the browser served no purpose. The raw
    // value still flows through masking/suppression logic server-side.
    email_masked: string | null;
    is_shared_inbox: boolean;
    shares_address_with: number;   // other contacts on the same address
    needs_review: boolean;
    review_reason: string | null;
    organizations: RebookingOrgSummary[];
    /** Which filter chip this row answers to. */
    bucket: RebookingBucket;
};

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
                // FR-RETENTION-6 — the outreach evidence CP1 could not read.
                outreach_links: {
                    select: {
                        recipient: {
                            select: {
                                refresh_requested_at: true,
                                // Test sends are excluded by the query, not by a later
                                // filter: a tenant emailing themselves must never make a
                                // real contact look contacted.
                                attempts: {
                                    where: { is_test: false },
                                    select: { status: true },
                                },
                                // The submission id comes off the opportunity itself
                                // (`submission_id`), so the submissions relation is
                                // deliberately not joined here.
                                opportunities: {
                                    select: {
                                        id: true,
                                        submission_id: true,
                                        customer_id: true,
                                        status: true,
                                        coordinator_intent: true,
                                        coordinator_name: true,
                                        campaign_id: true,
                                    },
                                },
                            },
                        },
                    },
                },
                // Contact-scoped preferences. Address-scoped ones are fetched
                // separately below, because they key on the email, not the person.
                marketing_prefs: {
                    where: { scope: 'contact' },
                    select: { status: true, effective_at: true, effective_until: true },
                    orderBy: { effective_at: 'desc' },
                },
            },
            orderBy: { display_name: 'asc' },
        });

        // Address-scoped suppressions apply to everyone on that inbox, so they
        // cannot be resolved from the per-contact relation above.
        const addressPrefs = await prisma.marketingPreference.findMany({
            where: { business_id: businessId, scope: 'email_address', normalized_email: { not: null } },
            select: { normalized_email: true, status: true, effective_at: true, effective_until: true },
            orderBy: { effective_at: 'desc' },
        });
        const addressPrefByEmail = new Map<string, PreferenceRow[]>();
        for (const p of addressPrefs) {
            const key = p.normalized_email as string;
            const list = addressPrefByEmail.get(key);
            if (list) list.push(p);
            else addressPrefByEmail.set(key, [p]);
        }

        // How many DISTINCT contacts sit on each address — powers "2 people" badges
        // without ever merging them into one row.
        const addressCounts = new Map<string, number>();
        for (const c of contacts) {
            const e = c.contact_points[0]?.normalized_value;
            if (!e) continue;
            addressCounts.set(e, (addressCounts.get(e) ?? 0) + 1);
        }

        // One clock for the whole response, so two rows can never disagree about
        // whether the same pause has lapsed.
        const now = new Date();

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

            // ── Outreach evidence for this person ──────────────────────────────
            const recipients = c.outreach_links.map((l) => l.recipient);
            // "Accepted" is the honest ceiling without delivery webhooks: the
            // provider took the message. Queued is not yet sent; skipped and
            // failed never reached anyone.
            const wasSent = recipients.some((r) => r.attempts.some((a) => a.status === 'accepted'));
            const askedForFreshLink = recipients.some((r) => r.refresh_requested_at !== null);

            // Only opportunities for THIS contact's own organizations — see the
            // attribution rule in the file header.
            const ownOrgIds = new Set(organizations.map((o) => o.customer_id));
            const opportunities = recipients
                .flatMap((r) => r.opportunities)
                .filter((o) => ownOrgIds.has(o.customer_id));

            const state = deriveRebookingRowState({
                isArchived: Boolean(c.archived_at) || allArchived,
                hasEmail: Boolean(email),
                wasSent,
                askedForFreshLink,
                opportunities,
                activePreference: resolveActivePreference(
                    [...c.marketing_prefs, ...(normalized ? addressPrefByEmail.get(normalized) ?? [] : [])],
                    now,
                ),
            });

            return {
                ...state,
                bucket: bucketForStatus(state.status, c.needs_review),
                contact_id: c.id,
                display_name: c.display_name,
                email_masked: maskEmail(email),
                is_shared_inbox: point?.is_shared_inbox ?? false,
                shares_address_with: sharesWith,
                needs_review: c.needs_review,
                review_reason: c.review_reason,
                organizations,
            };
        });

        // FR-RETENTION-6 — every count comes from the SAME derived bucket the
        // filter uses. CP1 counted with one definition and filtered with another,
        // which is how "Waiting" and "Done" could sit at zero forever.
        const inBucket = (b: RebookingBucket) => rows.filter((r) => r.bucket === b).length;
        const counts = {
            all: rows.length,
            ready_to_invite: inBucket('ready_to_invite'),
            waiting: inBucket('waiting'),
            needs_action: inBucket('needs_action'),
            done: inBucket('done'),
        };

        return NextResponse.json({ contacts: rows, counts });
    } catch (e: any) {
        console.error('[Rebooking Contacts] Failed:', e);
        return NextResponse.json({ error: 'Failed to load rebooking contacts' }, { status: 500 });
    }
}
