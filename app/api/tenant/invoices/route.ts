
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import type { VariantSize } from '@prisma/client';
import { buildBundlePriceMap } from '@/lib/pricing';
import { resolveVariantSize } from '@/lib/serving_multipliers';
import { LOYALTY_ACCRUAL_ENABLED } from '@/lib/loyalty';
import {
    shouldCreateFulfillmentOrder,
    isClientSettableInvoiceStatus,
} from '@/lib/invoiceFulfillment';

// ---------------------------------------------------------------------------
// Local helper — round money to two decimal places consistently.
// Used wherever server-side totals are recomputed.
// ---------------------------------------------------------------------------
function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// resolveInvoiceItems
//
// Validates incoming invoice items against server-authoritative bundle data.
// Returns a validated items array where:
//   - bundle-backed lines: unit_price and total come from DB, variant_size resolved from serving_tier
//   - custom/manual lines:  unit_price kept as supplied, total recomputed
//
// Throws a structured error (with a .statusCode property) if any bundle_id
// is invalid or belongs to a different tenant, so the route can return a 400
// before opening a transaction.
// ---------------------------------------------------------------------------
interface ValidatedItem {
    bundle_id: string | null;
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
    variant_size: VariantSize | null; // populated only for bundle-backed lines
}

type FulfillableInvoiceItem = ValidatedItem & {
    bundle_id: string;
    variant_size: VariantSize;
};

class InvoiceValidationError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

async function resolveInvoiceItems(
    businessId: string,
    rawItems: any[]
): Promise<ValidatedItem[]> {
    // Collect unique bundle IDs from submitted items
    const bundleIds: string[] = rawItems
        .filter((i: any) => i.bundle_id)
        .map((i: any) => String(i.bundle_id));

    // --- Server-side price authority (LAW 1 — never trust client prices) ---
    const bundlePriceMap = bundleIds.length > 0
        ? await buildBundlePriceMap(businessId, bundleIds)
        : new Map<string, number>();

    // --- Server-side serving_tier authority ---
    // Separate query so lib/pricing.ts is not modified.
    const bundleServingTierMap = new Map<string, string>();
    if (bundleIds.length > 0) {
        const bundles = await prisma.bundle.findMany({
            where: {
                id: { in: bundleIds },
                business_id: businessId,
            },
            select: { id: true, serving_tier: true },
        });
        for (const b of bundles) {
            bundleServingTierMap.set(b.id, (b as any).serving_tier || 'family');
        }
    }

    // Validate all bundle-backed items resolve correctly
    for (const item of rawItems) {
        if (!item.bundle_id) continue;
        if (!bundlePriceMap.has(item.bundle_id)) {
            throw new InvoiceValidationError(
                `Bundle not found or does not belong to this account (id: ${item.bundle_id})`
            );
        }
        if (!bundleServingTierMap.has(item.bundle_id)) {
            throw new InvoiceValidationError(
                `Bundle serving tier could not be resolved (id: ${item.bundle_id})`
            );
        }
    }

    // Build validated items
    const validated: ValidatedItem[] = rawItems.map((item: any) => {
        const qty = Number(item.quantity);

        if (!Number.isFinite(qty) || qty <= 0) {
            throw new InvoiceValidationError('Item quantity must be a positive number');
        }

        if (item.bundle_id) {
            // Bundle-backed line — use DB price, not client price
            const serverPrice = bundlePriceMap.get(item.bundle_id) as number;
            const serverTotal = roundMoney(qty * serverPrice);
            const servingTier = bundleServingTierMap.get(item.bundle_id) as string;

            return {
                bundle_id: item.bundle_id,
                description: item.description,
                quantity: qty,
                unit_price: serverPrice,
                total: serverTotal,
                variant_size: resolveVariantSize(servingTier) as VariantSize,
            };
        } else {
            // Custom/manual line — preserve manual unit_price
            const unitPrice = Number(item.unit_price);
            if (!Number.isFinite(unitPrice) || unitPrice < 0) {
                throw new InvoiceValidationError('Custom item unit_price must be a non-negative number');
            }
            return {
                bundle_id: null,
                description: item.description,
                quantity: qty,
                unit_price: unitPrice,
                total: roundMoney(qty * unitPrice),
                variant_size: null,
            };
        }
    });

    return validated;
}

export async function GET() {
    const session = await auth();
    const businessId = session?.user?.businessId;

    if (!businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // @ts-ignore - Stale Prisma Client
        const invoices = await prisma.invoice.findMany({
            where: { business_id: businessId },
            include: {
                customer: {
                    select: { name: true, contact_email: true, delivery_address: true }
                },
                items: true
            },
            orderBy: { created_at: 'desc' }
        });

        return NextResponse.json(invoices);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch invoices' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const session = await auth();
    const businessId = session?.user?.businessId;

    if (!businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body;
    try {
        body = await request.json();
        console.log('[API] POST Invoice Body:', JSON.stringify(body, null, 2));
        const {
            customer_id,
            items,
            tax_amount,
            due_date,
            payment_method,
            status,
            fundraiser_profit_percent,
            fundraiser_profit_amount
        } = body;

        // Verify customer belongs to this tenant before connecting
        if (customer_id) {
            const customer = await prisma.customer.findUnique({ where: { id: customer_id }, select: { business_id: true } });
            if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
            if (customer.business_id !== businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // ── INV-A: status input hardening ─────────────────────────────────────
        // `status` is passed straight to Prisma below. Now that DRAFT and SENT
        // exist in the enum, an allowlist is required or any authenticated
        // tenant user could mint a fundraiser-lifecycle invoice through the
        // ordinary API. DRAFT belongs to INV-B's generator; SENT to INV-C.
        if (status !== undefined && status !== null && !isClientSettableInvoiceStatus(status)) {
            return NextResponse.json({ error: 'Invalid invoice status.' }, { status: 400 });
        }

        // ── INV-A: campaign linkage is server-owned ───────────────────────────
        // Ordinary invoices created through this endpoint are never
        // campaign-linked, so a client cannot claim a campaign's one-invoice
        // slot here. INV-B's server-side generator is what sets campaign_id.
        const campaignId: string | null = null;

        // --- SERVER-SIDE PRICE & VARIANT VALIDATION ---
        // Validate bundle prices and serving tiers before opening any transaction.
        // resolveInvoiceItems throws InvoiceValidationError with a statusCode if any
        // bundle_id is unknown or belongs to a different tenant.
        let validatedItems: ValidatedItem[];
        try {
            validatedItems = await resolveInvoiceItems(businessId, items);
        } catch (err: any) {
            if (err instanceof InvoiceValidationError) {
                return NextResponse.json({ error: err.message }, { status: err.statusCode });
            }
            throw err;
        }

        // Recompute invoice total server-side — ignore client-sent total_amount
        const serverSubtotal = validatedItems.reduce((sum, i) => sum + i.total, 0);
        const serverTaxAmount = Number(tax_amount) || 0;
        const serverProfitAmount = Number(fundraiser_profit_amount) || 0;
        const serverTotal = roundMoney(serverSubtotal + serverTaxAmount - serverProfitAmount);

        // Bundle-backed items that generate OrderItems
        const fulfillableItems = validatedItems.filter(
            (i): i is FulfillableInvoiceItem => Boolean(i.bundle_id && i.variant_size)
        );

        const result = await prisma.$transaction(async (tx) => {
            // @ts-ignore - New bundle_id field
            const invoice = await tx.invoice.create({
                data: {
                    business: { connect: { id: businessId } },
                    customer: { connect: { id: customer_id } },
                    total_amount: serverTotal,
                    tax_amount: serverTaxAmount,
                    due_date: due_date ? new Date(due_date) : null,
                    payment_method: payment_method || 'check',
                    status: status || 'PENDING',
                    fundraiser_profit_percent: fundraiser_profit_percent || 0,
                    fundraiser_profit_amount: serverProfitAmount,
                    items: {
                        create: validatedItems.map((item) => ({
                            bundle_id: item.bundle_id || null,
                            description: item.description,
                            quantity: item.quantity,
                            unit_price: item.unit_price,
                            total: item.total,
                            // INV-A: persist the server-derived serving size.
                            // resolveInvoiceItems already computes it; it was
                            // previously forwarded only to OrderItem. NULL for
                            // manual lines — never fabricated as serves_5.
                            // Re-derived here on PUT too, so it survives the
                            // delete-and-recreate cycle without the client
                            // needing to round-trip it.
                            variant_size: item.variant_size ?? null
                        }))
                    }
                },
                include: {
                    items: true,
                    customer: {
                        select: { name: true, contact_email: true, delivery_address: true, type: true }
                    }
                }
            });

            // AUTO-POPULATE ORDER
            // We only create an order if there are items linked to bundles —
            // and never for a campaign-linked (fundraiser) invoice, whose
            // fulfilment records are the campaign's own orders. See
            // lib/invoiceFulfillment.ts for why that would double the kitchen.
            if (shouldCreateFulfillmentOrder({ campaignId, fulfillableItemCount: fulfillableItems.length })) {
                // @ts-ignore - New invoice_id field
                await tx.order.create({
                    data: {
                        external_id: `INV-${invoice.id.split('-')[0].toUpperCase()}`,
                        source: 'manual',
                        customer_name: invoice.customer.name,
                        customer_id: customer_id,
                        business_id: businessId,
                        invoice_id: invoice.id,
                        status: status === 'PAID' ? 'production_ready' : 'pending',
                        total_amount: serverTotal,
                        delivery_address: invoice.customer.delivery_address,
                        items: {
                            create: fulfillableItems.map((i) => ({
                                bundle_id: i.bundle_id,
                                quantity: Math.floor(i.quantity),
                                variant_size: i.variant_size
                            }))
                        }
                    }
                });
            }

            // If created as PAID, add loyalty points (Direct Customers/Orgs only)
            // LOY-P0: new accrual is globally paused; invoice creation is unaffected.
            if (LOYALTY_ACCRUAL_ENABLED && status === 'PAID' && invoice.customer.type !== 'fundraiser_org') {
                const points = Math.floor(serverTotal);
                // @ts-ignore - Stale Prisma Client
                await tx.loyaltyPoint.create({
                    data: {
                        customer_id,
                        points,
                        reason: `Invoice ${invoice.id}`
                    }
                });

                await tx.customer.update({
                    where: { id: customer_id },
                    data: {
                        // @ts-ignore - Stale Prisma Client
                        loyalty_balance: { increment: points }
                    }
                });
            }

            return invoice;
        });

        return NextResponse.json(result);
    } catch (error: any) {
        console.error('Invoice Creation Error Full:', {
            message: error.message,
            stack: error.stack,
            body: body
        });
        return NextResponse.json({
            error: 'Something went wrong. Please try again.'
        }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    const session = await auth();
    const businessId = session?.user?.businessId;

    if (!businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body;
    try {
        body = await request.json();
        console.log('[API] PUT Invoice Body:', JSON.stringify(body, null, 2));
        const {
            id,
            customer_id,
            items,
            tax_amount,
            due_date,
            payment_method,
            status,
            fundraiser_profit_percent,
            fundraiser_profit_amount
        } = body;

        if (!id) {
            return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 });
        }

        // Verify customer belongs to this tenant before connecting
        if (customer_id) {
            const customer = await prisma.customer.findUnique({ where: { id: customer_id }, select: { business_id: true } });
            if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
            if (customer.business_id !== businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // ── INV-A: status input hardening (see POST) ──────────────────────────
        if (status !== undefined && status !== null && !isClientSettableInvoiceStatus(status)) {
            return NextResponse.json({ error: 'Invalid invoice status.' }, { status: 400 });
        }

        // ── INV-A: campaign linkage comes from the PERSISTED row, never the
        //    client body — an edit must not be able to attach or detach a
        //    campaign, and the fulfilment suppression must hold on every edit.
        const persisted = await prisma.invoice.findFirst({
            where: { id, business_id: businessId },
            select: {
                campaign_id: true,
                // ── INV-C: the financial facts closeout froze. Read so an edit
                //    to a generated fundraiser invoice can PRESERVE them rather
                //    than recompute them from whatever the client posted.
                total_amount: true,
                tax_amount: true,
                fundraiser_profit_percent: true,
                fundraiser_profit_amount: true,
            },
        });
        const campaignId: string | null = persisted?.campaign_id ?? null;

        // ── INV-C: a generated fundraiser invoice's totals are not editable here.
        //
        // INV-B computed gross, the organization's share and the tax inside the
        // campaign lock, reconciled the bundle lines against the frozen
        // settlement_total, and the owner accepted the result. This endpoint
        // deletes and recreates `items` from the request body and re-prices them
        // through resolveInvoiceItems — so a bundle whose price changed AFTER
        // closeout would silently rewrite a historical invoice's lines, and the
        // printed document would stop agreeing with the campaign's settlement.
        // "Mark as Paid" alone round-trips the whole invoice through here, which
        // is enough to trigger it without anyone intending an edit.
        //
        // So for campaign-linked invoices the stored financial facts win and the
        // lines are left alone. Presentation-level fields (status via the
        // existing allowlist, due date, payment method) still update normally.
        // Ordinary manual invoices are completely unaffected.
        const isGeneratedCampaignInvoice = campaignId !== null;

        // --- SERVER-SIDE PRICE & VARIANT VALIDATION ---
        // Validate bundle prices and serving tiers before opening any transaction.
        let validatedItems: ValidatedItem[];
        try {
            validatedItems = await resolveInvoiceItems(businessId, items);
        } catch (err: any) {
            if (err instanceof InvoiceValidationError) {
                return NextResponse.json({ error: err.message }, { status: err.statusCode });
            }
            throw err;
        }

        // Recompute invoice total server-side — ignore client-sent total_amount
        const serverSubtotal = validatedItems.reduce((sum, i) => sum + i.total, 0);
        const serverTaxAmount = Number(tax_amount) || 0;
        const serverProfitAmount = Number(fundraiser_profit_amount) || 0;
        const serverTotal = roundMoney(serverSubtotal + serverTaxAmount - serverProfitAmount);

        // Bundle-backed items that generate OrderItems
        const fulfillableItems = validatedItems.filter(
            (i): i is FulfillableInvoiceItem => Boolean(i.bundle_id && i.variant_size)
        );

        const result = await prisma.$transaction(async (tx) => {
            // INV-C: never touch the lines of a generated fundraiser invoice.
            if (!isGeneratedCampaignInvoice) {
                // Delete existing items
                // @ts-ignore
                await tx.invoiceItem.deleteMany({
                    where: { invoice_id: id }
                });
            }

            // Update invoice and recreate items
            // @ts-ignore
            const invoice = await tx.invoice.update({
                where: { id, business_id: businessId },
                data: {
                    customer: { connect: { id: customer_id } },
                    // INV-C: stored values win for a generated fundraiser invoice.
                    total_amount: isGeneratedCampaignInvoice ? persisted!.total_amount : serverTotal,
                    tax_amount: isGeneratedCampaignInvoice ? persisted!.tax_amount : serverTaxAmount,
                    due_date: due_date ? new Date(due_date) : null,
                    payment_method: payment_method || 'check',
                    status: status || 'PENDING',
                    fundraiser_profit_percent: isGeneratedCampaignInvoice
                        ? persisted!.fundraiser_profit_percent
                        : (fundraiser_profit_percent || 0),
                    fundraiser_profit_amount: isGeneratedCampaignInvoice
                        ? persisted!.fundraiser_profit_amount
                        : serverProfitAmount,
                    ...(isGeneratedCampaignInvoice ? {} : {
                    items: {
                        create: validatedItems.map((item) => ({
                            bundle_id: item.bundle_id || null,
                            description: item.description,
                            quantity: item.quantity,
                            unit_price: item.unit_price,
                            total: item.total,
                            // INV-A: persist the server-derived serving size.
                            // resolveInvoiceItems already computes it; it was
                            // previously forwarded only to OrderItem. NULL for
                            // manual lines — never fabricated as serves_5.
                            // Re-derived here on PUT too, so it survives the
                            // delete-and-recreate cycle without the client
                            // needing to round-trip it.
                            variant_size: item.variant_size ?? null
                        }))
                    }
                    }),
                },
                include: {
                    items: true,
                    customer: {
                        select: { name: true, contact_email: true, delivery_address: true, type: true }
                    },
                    order: true
                }
            });

            // SYNC LINKED ORDER
            // @ts-ignore
            const existingOrder = invoice.order;

            // ── INV-A: a campaign-linked invoice never creates or maintains a
            //    fulfilment Order. Guarded here as well as at creation because
            //    an edit must not be able to conjure the phantom order that
            //    creation refused. Ordinary invoices are untouched.
            const maySyncFulfillmentOrder = shouldCreateFulfillmentOrder({
                campaignId,
                fulfillableItemCount: fulfillableItems.length,
            });

            if (campaignId) {
                // Campaign invoice: no fulfilment order, nothing to sync.
            } else if (existingOrder) {
                if (fulfillableItems.length > 0) {
                    // Update existing order items
                    await tx.orderItem.deleteMany({ where: { order_id: existingOrder.id } });
                    await tx.order.update({
                        where: { id: existingOrder.id },
                        data: {
                            total_amount: serverTotal,
                            status: status === 'PAID' ? 'production_ready' : existingOrder.status,
                            items: {
                                create: fulfillableItems.map((i) => ({
                                    bundle_id: i.bundle_id,
                                    quantity: Math.floor(i.quantity),
                                    variant_size: i.variant_size
                                }))
                            }
                        }
                    });
                } else {
                    // If no fulfillable items left, maybe delete order? 
                    // For now, keep it but empty.
                    await tx.orderItem.deleteMany({ where: { order_id: existingOrder.id } });
                    await tx.order.update({
                        where: { id: existingOrder.id },
                        data: { total_amount: 0 }
                    });
                }
            } else if (maySyncFulfillmentOrder) {
                // Create new order if it didn't exist
                // @ts-ignore
                await tx.order.create({
                    data: {
                        external_id: `INV-${invoice.id.split('-')[0].toUpperCase()}`,
                        source: 'manual',
                        customer_name: invoice.customer.name,
                        customer_id: customer_id,
                        business_id: businessId,
                        // @ts-ignore - New invoice_id field
                        invoice_id: invoice.id,
                        status: status === 'PAID' ? 'production_ready' : 'pending',
                        total_amount: serverTotal,
                        delivery_address: invoice.customer.delivery_address,
                        items: {
                            create: fulfillableItems.map((i) => ({
                                bundle_id: i.bundle_id,
                                quantity: Math.floor(i.quantity),
                                variant_size: i.variant_size
                            }))
                        }
                    }
                });
            }

            // If updated to PAID, add loyalty points (Direct Customers/Orgs only)
            // LOY-P0: new accrual is globally paused; the invoice status update is
            // unaffected and the reason-string lookup below is unreachable while paused.
            if (LOYALTY_ACCRUAL_ENABLED && status === 'PAID' && invoice.customer.type !== 'fundraiser_org') {
                const points = Math.floor(serverTotal);
                // Check if points already awarded? 
                // For simplicity, typically we'd check if a LoyaltyPoint record exists for this invoice.
                const existingPoints = await tx.loyaltyPoint.findFirst({
                    where: { reason: `Invoice ${invoice.id}` }
                });

                if (!existingPoints) {
                    await tx.loyaltyPoint.create({
                        data: {
                            customer_id,
                            points,
                            reason: `Invoice ${invoice.id}`
                        }
                    });

                    await tx.customer.update({
                        where: { id: customer_id },
                        data: {
                            loyalty_balance: { increment: points }
                        }
                    });
                }
            }

            return invoice;
        });

        return NextResponse.json(result);
    } catch (error: any) {
        console.error('Invoice Update Error Full:', {
            message: error.message,
            stack: error.stack,
            body: body
        });
        return NextResponse.json({
            error: 'Something went wrong. Please try again.'
        }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const session = await auth();
    const businessId = session?.user?.businessId;

    if (!businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { id } = await request.json();
        if (!id) {
            return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 });
        }

        await prisma.$transaction(async (tx) => {
            // Verify invoice belongs to this business
            // @ts-ignore
            const invoice = await tx.invoice.findUnique({
                where: { id, business_id: businessId },
                include: { order: true }
            });

            if (!invoice) {
                throw new Error('Invoice not found');
            }

            // Delete linked order and its items if exists
            // @ts-ignore
            if (invoice.order) {
                // @ts-ignore
                await tx.orderItem.deleteMany({ where: { order_id: invoice.order.id } });
                // @ts-ignore
                await tx.order.delete({ where: { id: invoice.order.id } });
            }

            // Delete invoice items
            // @ts-ignore
            await tx.invoiceItem.deleteMany({ where: { invoice_id: id } });

            // Delete the invoice
            // @ts-ignore
            await tx.invoice.delete({ where: { id } });
        });

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Invoice Delete Error:', error.message);
        return NextResponse.json({
            error: error.message === 'Invoice not found' ? 'Invoice not found' : 'Failed to delete invoice'
        }, { status: error.message === 'Invoice not found' ? 404 : 500 });
    }
}
