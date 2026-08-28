/**
 * Campaign Closeout API
 *
 * ACCESS MODEL: Session-authenticated, tenant-scoped, ADMIN or super-admin.
 * ACTOR: Business owner / tenant administrator
 * SCOPE: Single campaign by ID, tenant-scoped via business_id
 *
 * PURPOSE: Officially closes a fundraiser campaign. In a single transaction:
 *   1. Freezes settlement_total from active non-canceled orders
 *   2. Claims the campaign into 'Closed', recording closed_at and closed_by
 *   3. Batch-promotes fundraiser_hold orders to production_ready
 *
 * IDEMPOTENT: Re-calling on an already-closed campaign returns success
 * without re-promoting orders or overwriting an existing settlement_total, and
 * returns the campaign's existing invoice rather than manufacturing a second.
 *
 * DOES NOT: process payments, send emails, mark an invoice SENT or PAID, record
 * a check, or claim Square received anything. It creates a DRAFT invoice and
 * stops. Settlement is INV-D.
 *
 * ── INV-A HARDENING ──────────────────────────────────────────────────────────
 * AUTHORIZATION: closeout freezes money, releases held orders, and records the
 * responsible actor — so it is ADMIN-or-super-admin, not merely
 * "any authenticated tenant user". The rule itself lives in
 * lib/campaignCloseout.ts so it can be unit-tested directly; this introduces no
 * permission framework and no change to how any other route authorizes.
 *
 * closed_by: stores a persisted User.id ONLY. It previously fell back to the
 * session email, which produced a column holding two different identifier types
 * that could not be joined to User. A closeout that cannot resolve a real user
 * id now fails rather than writing an unusable actor.
 *
 * CONCURRENCY: the pre-transaction read-then-check was a TOCTOU window — two
 * concurrent requests could both pass it and the second would overwrite
 * closed_at/closed_by/settlement_total. The authoritative guard is now a
 * conditional updateMany inside the transaction (the house pattern: see the
 * one-campaign opportunity claim in app/api/campaigns/route.ts and the
 * ConcurrentChangeError shape in app/api/orders/bulk-status). Order promotion —
 * and, later, INV-B's invoice creation — run only after count === 1 proves this
 * request won the claim.
 *
 * ── INV-B: THE SETTLEMENT RACE, NOW CLOSED ───────────────────────────────────
 * INV-A recorded this as deliberately unclosed: an order committing between the
 * settlement read and the commit was promoted but not counted, and it noted that
 * fixing it needed the public order writer to join a shared lock.
 *
 * That writer ALREADY joins one. FR-FLOW-3 gave app/api/public/order/route.ts a
 * `lockCampaignSelection` call as its transaction's first statement, after the
 * INV-A note was written — so the note's claim that it "takes no lock on the
 * campaign row" has been stale ever since. The lock exists, it is
 * transaction-scoped, and it is honoured at every isolation level.
 *
 * So closeout simply joins the SAME lock, first, before reading anything. No
 * second locking system and no isolation-level change. The invariant that buys:
 * a supporter order either commits before the snapshot and is counted, or queues
 * behind closeout and finds the campaign closed. There is no interleaving where
 * a valid order lands outside the invoice.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CLOSED_STATUSES, isCampaignClosed } from '@/lib/campaignBundleSelection';
import { mayCloseOutCampaign } from '@/lib/campaignCloseout';
import { lockCampaignSelection } from '@/lib/campaignSelectionLock';
import {
    aggregateBundleLines,
    assertLinesReconcile,
    computeCloseoutFinancials,
    CloseoutReconciliationError,
    FOOD_TAX_DEFAULT_APPLIED,
    roundCents,
    type AggregatedLine,
} from '@/lib/fundraiserCloseoutMath';
// FR-TAX-1B: the campaign's frozen tax rate, and the explicit rule for
// campaigns that carry no snapshot at all.
import { resolveCloseoutTaxRate } from '@/lib/fundraiserTax';

/** Thrown inside the transaction when the conditional claim is not won. */
class CampaignAlreadyClosedError extends Error {
    constructor() {
        super('Campaign was closed by another request');
        // INV-B. Subclassing Error under an ES5 target breaks `instanceof`, and
        // the catch below routes on exactly that check — so the LOSING side of a
        // concurrent closeout was falling through to the generic handler and
        // returning 500 instead of the idempotent success INV-A designed. The
        // guard worked; only its answer was wrong. Found by an executed
        // two-admin test, not by reading the code.
        Object.setPrototypeOf(this, CampaignAlreadyClosedError.prototype);
        this.name = 'CampaignAlreadyClosedError';
    }
}

/** Prisma's unique-violation code; here it can only be invoices_one_per_campaign. */
const UNIQUE_VIOLATION = 'P2002';

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        // ── Auth: mirror pattern from app/api/campaigns/[id]/route.ts ──
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: campaignId } = await params;
        const businessId = (session.user as any).businessId;

        // ── INV-A: role gate. Authenticated but insufficient → 403. ──
        if (!mayCloseOutCampaign({
            role: (session.user as any).role,
            isSuperAdmin: (session.user as any).isSuperAdmin === true,
        })) {
            return NextResponse.json(
                { error: 'Only an administrator can close out a fundraiser.' },
                { status: 403 }
            );
        }

        // ── INV-A: closed_by must be a persisted User.id, never an email. ──
        // session.user.id comes from token.sub; confirm it resolves to a real
        // user in THIS tenant before writing it as the financial actor.
        const sessionUserId = (session.user as any).id as string | undefined;
        const sessionEmail = session.user.email ?? undefined;

        // SEC-TENANT-1. This lookup used to require the actor to be a MEMBER of
        // the tenant being closed out. That held for a super admin only because
        // View As permanently rewrote users.business_id onto the viewed tenant —
        // the destructive write this phase removed. A platform super admin is
        // never a member of the tenant they are inspecting, so keeping the
        // membership clause would make closeout impossible for them.
        //
        // INV-A's actual requirement is that closed_by resolves to a PERSISTED
        // User.id rather than an email; tenant membership was only ever a proxy
        // for that. A super admin's id is persisted, so it satisfies the invariant
        // directly. Ordinary users are still required to be members.
        const actingSuperAdmin = (session.user as any).isSuperAdmin === true;
        const scope = actingSuperAdmin ? {} : { business_id: businessId };

        const actor = sessionUserId
            ? await prisma.user.findFirst({
                where: { id: sessionUserId, ...scope },
                select: { id: true },
            })
            : sessionEmail
                ? await prisma.user.findFirst({
                    where: { email: sessionEmail, ...scope },
                    select: { id: true },
                })
                : null;

        if (!actor) {
            return NextResponse.json(
                { error: 'Could not identify the acting user. Please sign in again.' },
                { status: 403 }
            );
        }
        const userId = actor.id;

        // ── INV-B: the owner's food-tax decision for THIS campaign ──
        // An explicit business choice, never inferred from a jurisdiction. Absent
        // from the body means "use the product default", which is derived from
        // history (all five prior fundraiser invoices charged it) rather than
        // assumed — see FOOD_TAX_DEFAULT_APPLIED.
        let applyFoodTax = FOOD_TAX_DEFAULT_APPLIED;
        try {
            const body = await req.json();
            if (body && typeof body.applyFoodTax === 'boolean') applyFoodTax = body.applyFoodTax;
        } catch {
            // No body, or not JSON. Keep the default.
        }

        // ── Ownership check: campaign must belong to this tenant ──
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { id: campaignId },
            include: { customer: { select: { id: true, business_id: true } } }
        });

        if (!campaign) {
            return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
        }

        if (campaign.customer.business_id !== businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // ── Fast-path idempotency: already closed → success, nothing promoted.
        //    This is a courtesy short-circuit only; the authoritative guard is
        //    the conditional claim inside the transaction below.
        if (isCampaignClosed(campaign)) {
            // Return the campaign's existing invoice. A retry after a successful
            // closeout must converge on the same document, not look like a no-op.
            const existingInvoice = await prisma.invoice.findFirst({
                where: { campaign_id: campaignId },
                select: { id: true, status: true },
            });
            return NextResponse.json({
                success: true,
                idempotent: true,
                campaign_id: campaignId,
                status: campaign.status,
                closed_at: campaign.closed_at,
                settlement_total: campaign.settlement_total
                    ? Number(campaign.settlement_total)
                    : null,
                promoted_order_count: 0,
                invoice_id: existingInvoice?.id ?? null,
                invoice_status: existingInvoice?.status ?? null,
            });
        }

        // ── Execute closeout in a transaction ──
        let result: {
            settlementTotal: number;
            closedAt: Date;
            promotedCount: number;
            invoiceId: string;
            lines: AggregatedLine[];
            financials: ReturnType<typeof computeCloseoutFinancials>;
        };
        try {
            result = await prisma.$transaction(async (tx) => {
                // 0. JOIN THE CAMPAIGN LOCK, FIRST — before reading a single order.
                //    app/api/public/order/route.ts takes this same lock as its own
                //    first statement, so a supporter checkout and this snapshot
                //    genuinely queue behind one another. Taking it here rather than
                //    after the read is the whole point: a read performed before the
                //    lock could still be overtaken.
                await lockCampaignSelection(tx, campaignId);

                // 1. Compute settlement total from active, non-canceled orders.
                //    Uses order.total_amount (the canonical per-order total) rather
                //    than the denormalized campaign.total_sales which may drift —
                //    Edgar proves the drift is real: total_sales counts a cancelled
                //    order that active gross correctly excludes.
                //    This figure is GROSS: no share, no tax, no fee, no deduction.
                //
                //    INCLUSION RULE: every submitted order that is not cancelled.
                //    Payment status is deliberately NOT a filter — a legitimate
                //    cash/check/offline order sold just as much food as a card one.
                const activeOrders = await tx.order.findMany({
                    where: {
                        campaign_id: campaignId,
                        canceled_at: null
                    },
                    select: {
                        id: true,
                        total_amount: true,
                        items: {
                            select: {
                                bundle_id: true,
                                quantity: true,
                                unit_price: true,
                                variant_size: true,
                                item_name: true,
                                bundle: { select: { name: true } },
                            },
                        },
                    }
                });

                const settlementTotal = roundCents(activeOrders.reduce(
                    (sum, o) => sum + Number(o.total_amount || 0),
                    0
                ));

                // 2. Aggregate to ONE line per bundle + serving size.
                const lines = aggregateBundleLines(
                    activeOrders.flatMap((o) =>
                        o.items.map((it) => ({
                            bundleId: it.bundle_id ?? null,
                            description: it.bundle?.name || it.item_name || '(unnamed bundle)',
                            variantSize: (it.variant_size as string | null) ?? null,
                            quantity: Number(it.quantity) || 0,
                            unitPrice: Number(it.unit_price ?? 0),
                        }))
                    )
                );

                // 3. HARD GATE. The bundle tally must equal the order totals, or
                //    this is not a document anyone can act on. Name the offending
                //    orders so the data can be repaired rather than guessed at.
                const offenders = activeOrders
                    .map((o) => ({
                        orderId: o.id,
                        orderTotal: Number(o.total_amount || 0),
                        lineSum: roundCents(o.items.reduce(
                            (s, it) => s + (Number(it.quantity) || 0) * Number(it.unit_price ?? 0), 0)),
                    }))
                    .filter((o) => Math.abs(o.orderTotal - o.lineSum) >= 0.005);

                assertLinesReconcile(lines, settlementTotal, offenders);

                // 4. The money. Organization share comes from the campaign's own
                //    durable org_share_percent, never a current tenant default.
                //
                //    FR-TAX-1B: the tax rate likewise comes from the campaign's
                //    OWN frozen snapshot, never the tenant's current default —
                //    that is the whole point of snapshotting at launch. The
                //    base is the NET after the organization's share, per the
                //    owner's confirmed ruling (lib/fundraiserTax.ts
                //    CONFIRMED_TAXABLE_BASE), which computeCloseoutFinancials
                //    applies to its own baseRemit.
                const financials = computeCloseoutFinancials({
                    grossSales: settlementTotal,
                    orgSharePercent: Number(campaign.org_share_percent),
                    applyFoodTax,
                    taxRatePercent: resolveCloseoutTaxRate({
                        taxStatus: (campaign as any).tax_status ?? null,
                        taxRatePercent: (campaign as any).tax_rate_percent ?? null,
                    }),
                });

                const closedAt = new Date();

                // 2. CLAIM the campaign. The WHERE clause is the concurrency
                //    guarantee: only a campaign that is still open matches, so
                //    exactly one concurrent request can get count === 1.
                const claimed = await tx.fundraiserCampaign.updateMany({
                    where: {
                        id: campaignId,
                        closed_at: null,
                        status: { notIn: [...CLOSED_STATUSES] },
                    },
                    data: {
                        status: 'Closed',
                        closed_at: closedAt,
                        closed_by: userId,
                        settlement_total: settlementTotal
                    } as any
                });

                if (claimed.count !== 1) {
                    // Someone else won. Roll everything back — including any
                    // promotion — and let the caller re-read the truth.
                    throw new CampaignAlreadyClosedError();
                }

                // 3. Batch-promote fundraiser_hold orders to production_ready.
                //    Runs ONLY after the claim is won, so a losing request can
                //    never release held orders.
                //    Only targets:
                //      - orders belonging to this campaign
                //      - source = 'fundraiser' (coordinator-entered)
                //      - status = 'fundraiser_hold' (not yet promoted)
                //      - not canceled
                const promoted = await tx.order.updateMany({
                    where: {
                        campaign_id: campaignId,
                        source: 'fundraiser' as any,
                        status: 'fundraiser_hold' as any,
                        canceled_at: null
                    },
                    data: {
                        status: 'production_ready' as any
                    }
                });

                // 5. Create exactly ONE DRAFT invoice, after the claim is won.
                //
                //    total_amount is the AMOUNT DUE (base remit + tax), matching
                //    what the existing PDF and invoices UI already treat that
                //    column as — the five historical invoices store the same
                //    thing. Gross is NOT written here; it lives on the campaign's
                //    settlement_total and is reproduced exactly by the line totals.
                //
                //    The 1% is carried in tax_amount, its own labelled column, so
                //    the document can show it as its own line instead of hiding it
                //    inside an unexplained 81%.
                let invoiceId: string;
                try {
                    const invoice = await tx.invoice.create({
                        data: {
                            business_id: businessId,
                            customer_id: campaign.customer.id,
                            campaign_id: campaignId,
                            status: 'DRAFT' as any,
                            generated_at: closedAt,
                            total_amount: financials.totalDue,
                            tax_amount: financials.taxAmount,
                            fundraiser_profit_percent: financials.orgSharePercent,
                            fundraiser_profit_amount: financials.organizationAmount,
                            // FR-TAX-1B: freeze the whole tax contract onto the
                            // invoice, so total_amount is reproducible from this
                            // row alone and no later change to the organization,
                            // the tenant default, or the definition of the base
                            // can re-explain a settled document.
                            tax_rate_percent: financials.taxRatePercent,
                            tax_status: ((campaign as any).tax_status ?? null) as any,
                            taxable_base_amount: financials.baseRemit,
                            items: {
                                create: lines.map((l) => ({
                                    bundle_id: l.bundleId,
                                    description: l.description,
                                    quantity: l.quantity,
                                    unit_price: l.unitPrice,
                                    total: l.total,
                                    variant_size: (l.variantSize as any) ?? null,
                                })),
                            },
                        },
                        select: { id: true },
                    });
                    invoiceId = invoice.id;
                } catch (invErr: any) {
                    // invoices_one_per_campaign fired: this campaign already has
                    // its authoritative invoice. Reuse it rather than manufacture
                    // a second — the database, not a disabled button, is what
                    // makes closeout idempotent.
                    if (invErr?.code === UNIQUE_VIOLATION) {
                        const existing = await tx.invoice.findFirst({
                            where: { campaign_id: campaignId },
                            select: { id: true },
                        });
                        if (!existing) throw invErr;
                        invoiceId = existing.id;
                    } else {
                        throw invErr;
                    }
                }

                return {
                    settlementTotal,
                    closedAt,
                    promotedCount: promoted.count,
                    invoiceId,
                    lines,
                    financials,
                };
            });
        } catch (txErr) {
            if (txErr instanceof CampaignAlreadyClosedError) {
                // Re-read and answer with what is now true, rather than a 500.
                // The winner's invoice is returned, so a retry converges on the
                // same document instead of appearing to have produced nothing.
                const current = await prisma.fundraiserCampaign.findUnique({
                    where: { id: campaignId },
                    select: { status: true, closed_at: true, settlement_total: true },
                });
                const existingInvoice = await prisma.invoice.findFirst({
                    where: { campaign_id: campaignId },
                    select: { id: true },
                });
                return NextResponse.json({
                    success: true,
                    idempotent: true,
                    campaign_id: campaignId,
                    status: current?.status ?? 'Closed',
                    closed_at: current?.closed_at ?? null,
                    settlement_total: current?.settlement_total != null
                        ? Number(current.settlement_total)
                        : null,
                    promoted_order_count: 0,
                    invoice_id: existingInvoice?.id ?? null,
                });
            }
            // INV-B: refuse rather than emit an invoice that contradicts itself.
            // 409, not 500 — the request was well-formed; the DATA is not ready.
            if (txErr instanceof CloseoutReconciliationError) {
                return NextResponse.json({
                    error: txErr.message,
                    reconciliation: {
                        bundle_line_total: txErr.lineSum,
                        order_gross_total: txErr.grossSales,
                        detail: txErr.detail,
                    },
                }, { status: 409 });
            }
            throw txErr;
        }

        return NextResponse.json({
            success: true,
            idempotent: false,
            campaign_id: campaignId,
            status: 'Closed',
            closed_at: result.closedAt,
            settlement_total: result.settlementTotal,
            promoted_order_count: result.promotedCount,
            invoice_id: result.invoiceId,
            invoice_status: 'DRAFT',
            financials: {
                gross_sales: result.financials.grossSales,
                org_share_percent: result.financials.orgSharePercent,
                organization_amount: result.financials.organizationAmount,
                base_remit: result.financials.baseRemit,
                tax_applied: result.financials.taxApplied,
                tax_rate_percent: result.financials.taxRatePercent,
                tax_amount: result.financials.taxAmount,
                total_due: result.financials.totalDue,
            },
            lines: result.lines,
        });

    } catch (e: any) {
        console.error('Campaign Closeout Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to close campaign' },
            { status: 500 }
        );
    }
}
