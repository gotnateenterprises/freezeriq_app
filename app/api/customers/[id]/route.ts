
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { isOrgTaxStatus } from '@/lib/fundraiserTax';
import { checkCoordinatorPaymentSettings } from '@/lib/supporterPaymentMethods';


export const dynamic = 'force-dynamic';

/**
 * CRM-1A: Defensive per-order serializer.
 * Returns null + warning string if the order can't be serialized,
 * so one bad order never 500s the whole customer/fundraiser profile.
 */
function serializeOrder(o: any): { order: any; warning?: string } {
    try {
        const items = Array.isArray(o.items) ? o.items : [];
        return {
            order: {
                id: o.external_id,
                date: o.created_at,
                total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
                    .format(Number(o.total_amount) || 0),
                status: o.status,
                items: items
                    .map((i: any) => `${i.quantity ?? 0}x ${i.bundle?.name ?? i.item_name ?? 'Unknown'}`)
                    .join(', ') || 'No items',
                orderItems: items.map((i: any) => ({
                    id: i.id,
                    name: i.bundle?.name || i.item_name || 'Unknown',
                    quantity: i.quantity,
                    price: i.unit_price,
                    is_subscription: i.is_subscription,
                    serving_tier: i.variant_size
                }))
            }
        };
    } catch (err: any) {
        console.warn('[serializeOrder] Skipping malformed order:', o?.id || o?.external_id, err?.message);
        return { order: null, warning: `Order ${o?.external_id || o?.id || 'unknown'}: ${err?.message || 'serialization failed'}` };
    }
}

/**
 * CRM-1A: Serialize an array of orders defensively.
 * Returns { orders, warnings } where warnings is only populated if orders were skipped.
 */
function serializeOrders(rawOrders: any[]): { orders: any[]; warnings: string[] } {
    const orders: any[] = [];
    const warnings: string[] = [];
    for (const o of rawOrders) {
        const result = serializeOrder(o);
        if (result.order) {
            orders.push(result.order);
        }
        if (result.warning) {
            warnings.push(result.warning);
        }
    }
    return { orders, warnings };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;

        // 1. Try finding Organization (only if ID is UUID)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let org = null;

        if (isUuid) {
            org = await prisma.customer.findUnique({
                where: { id },
                include: {
                    campaigns: {
                        orderBy: { created_at: 'desc' },
                        take: 5,
                        // ── FR-HISTORY-1: the organization page's campaign-history
                        //    card reads invoice truth from here.
                        //
                        //    A bare include returns every campaign SCALAR — which
                        //    now covers settlement_total and settled_externally — but
                        //    the invoices relation has to be asked for. Without it
                        //    the card could only guess, which is exactly what it used
                        //    to do: it branched on `c.invoice_id`, a field no campaign
                        //    row has ever carried, so it said "not yet invoiced" for
                        //    every campaign including PAID ones.
                        include: { invoices: { select: { status: true } } },
                    },
                    orders: {
                        orderBy: { created_at: 'desc' },
                        include: {
                            items: {
                                include: { bundle: true }
                            }
                        }
                    }
                }
            });

            // Security Check
            if (org && org.business_id !== session.user.businessId) {
                return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
            }
        }

        if (org) {
            const orgAny = org as any;
            // CRM-1A: Defensive order serialization
            const rawOrders = Array.isArray(orgAny.orders) ? orgAny.orders : [];
            const { orders: serializedOrders, warnings } = serializeOrders(rawOrders);

            // FR-TAX-1: METADATA ONLY. `data` is deliberately excluded from
            // this select — the CRM profile response must never carry a
            // megabyte of tax paperwork, and the bytes have their own
            // authenticated download route.
            const taxDoc = await prisma.organizationTaxDocument.findFirst({
                where: { customer_id: org.id, business_id: session.user.businessId },
                select: { id: true, filename: true, content_type: true, size_bytes: true, uploaded_at: true },
            });
            const taxDocumentMeta = taxDoc ?? null;

            const response: any = {
                id: org.id,
                name: org.name,
                contact_name: org.contact_name,
                type: orgAny.type === 'direct_customer' ? 'Individual' :
                    orgAny.type === 'organization' ? 'Organization' : 'Fundraiser',
                email: org.contact_email,
                // @ts-ignore
                phone: org.contact_phone,
                // @ts-ignore
                secondary_phone: org.secondary_phone,
                delivery_address: orgAny.delivery_address,
                notes: orgAny.notes || '',
                inactive_reason: orgAny.inactive_reason,
                status: (orgAny.status ? String(orgAny.status).charAt(0).toUpperCase() + String(orgAny.status).slice(1).toLowerCase().replace('_', ' ') : 'Active'),
                rawStatus: orgAny.status || 'LEAD',
                archived: orgAny.archived || false,
                tags: orgAny.tags || [],
                fundraiser_info: orgAny.fundraiser_info || {},
                campaigns: orgAny.campaigns || [],
                source: orgAny.source || 'Manual',
                // ── FR-TAX-1: organization tax posture. Status/number only —
                //    the document's BYTES are never served from this endpoint;
                //    they have their own authenticated route.
                tax_status: orgAny.tax_status || 'UNKNOWN',
                tax_exemption_number: orgAny.tax_exemption_number || '',
                tax_document: taxDocumentMeta,
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    rawOrders.reduce((sum: number, o: any) => sum + (Number(o.total_amount) || 0), 0)
                ),
                orders: serializedOrders,
            };
            // CRM-1A: Only include warnings when orders were skipped
            if (warnings.length > 0) {
                response.serialization_warnings = warnings;
            }
            return NextResponse.json(response);
        }

        // 2. Try finding Individual by Name (Mock ID mechanism) or Promoted Customer
        const encodedName = decodeURIComponent(id);

        // CHECK: Does a real Customer record exist for this name? 
        if (session?.user?.businessId) {
            // First try strict match
            let promotedOrg = await prisma.customer.findFirst({

                where: {
                    name: encodedName,
                    business_id: session.user.businessId
                },
                include: {
                    campaigns: { orderBy: { created_at: 'desc' }, take: 5 },
                    orders: { orderBy: { created_at: 'desc' }, include: { items: { include: { bundle: true } } } }
                }
            });

            // If not found, try lax match (name only) scoped to this tenant only.
            // Do NOT return customers from other tenants - return null to simulate 404.
            if (!promotedOrg) {
                const bestMatch = await prisma.customer.findFirst({
                    where: { name: encodedName, business_id: session.user.businessId },
                    include: {
                        campaigns: { orderBy: { created_at: 'desc' }, take: 5 },
                        orders: { orderBy: { created_at: 'desc' }, include: { items: { include: { bundle: true } } } }
                    }
                });

                if (bestMatch) {
                    promotedOrg = bestMatch;
                }
                // If no match within this tenant, promotedOrg remains null → falls through to 404
            }

            if (promotedOrg) {
                // Reuse the same response logic as UUID match
                const orgAny = promotedOrg as any;
                // CRM-1A: Defensive order serialization
                const rawOrders = Array.isArray(orgAny.orders) ? orgAny.orders : [];
                const { orders: serializedOrders, warnings } = serializeOrders(rawOrders);

                const response: any = {
                    id: promotedOrg.id,
                    name: promotedOrg.name,
                    type: orgAny.type === 'direct_customer' ? 'Individual' :
                        orgAny.type === 'organization' ? 'Organization' : 'Fundraiser',
                    email: promotedOrg.contact_email,
                    phone: promotedOrg.contact_phone,
                    // @ts-ignore
                    secondary_phone: promotedOrg.secondary_phone,
                    delivery_address: orgAny.delivery_address,
                    notes: orgAny.notes || '',
                    inactive_reason: orgAny.inactive_reason,
                    status: (orgAny.status ? String(orgAny.status).charAt(0).toUpperCase() + String(orgAny.status).slice(1).toLowerCase().replace('_', ' ') : 'Active'),
                    rawStatus: orgAny.status || 'LEAD',
                    archived: orgAny.archived || false,
                    tags: orgAny.tags || [],
                    fundraiser_info: orgAny.fundraiser_info || {},
                    campaigns: orgAny.campaigns || [],
                    source: orgAny.source || 'Manual',
                    total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                        rawOrders.reduce((sum: number, o: any) => sum + (Number(o.total_amount) || 0), 0)
                    ),
                    orders: serializedOrders,
                };
                if (warnings.length > 0) {
                    response.serialization_warnings = warnings;
                }
                return NextResponse.json(response);
            }
        }

        const orders = await prisma.order.findMany({
            where: { customer_name: encodedName, business_id: session.user.businessId },
            orderBy: { created_at: 'desc' },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        if (orders.length > 0) {
            // CRM-1A: Defensive order serialization
            const { orders: serializedOrders, warnings } = serializeOrders(orders);

            const response: any = {
                id: encodedName,
                name: encodedName,
                type: 'Individual',
                email: null,
                notes: "Individual customer notes not supported in MVP Schema yet.",
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    orders.reduce((sum: number, o: any) => sum + (Number((o as any).total_amount) || 0), 0)
                ),
                orders: serializedOrders,
            };
            if (warnings.length > 0) {
                response.serialization_warnings = warnings;
            }
            return NextResponse.json(response);
        }

        return NextResponse.json({ error: "Customer not found" }, { status: 404 });

    } catch (e: any) {
        console.error("[GET /api/customers/[id]] CRASH:", e?.message || e);
        console.error("[GET /api/customers/[id]] Stack:", e?.stack);
        return NextResponse.json({ error: "Server Error", detail: e?.message || "Unknown" }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { id } = await params;
        const body = await req.json();

        // ── COORDINATOR-PAYMENT-METHOD-UX-1A: the organization blob's payment keys ──
        //
        // These two keys used to be pushed into the organization's latest OPEN campaign
        // (LEGACY-WRITER-GUARDS-1 removed that push; see the end of this handler). They
        // still pass the same payment-settings rule as Payment Settings and the tenant
        // campaign editor before the organization is written, so the blob cannot store
        // what the coordinator's own forms refuse, and a refusal leaves nothing
        // half-saved. (The CRM forms never send these two keys today.)
        const fiPayment = body.fundraiser_info && typeof body.fundraiser_info === 'object'
            ? checkCoordinatorPaymentSettings({
                paymentInstructions: body.fundraiser_info.payment_instructions || undefined,
                externalPaymentLink: body.fundraiser_info.external_payment_link || undefined,
            })
            : ({ ok: true, values: {} } as const);
        if (!fiPayment.ok) {
            return NextResponse.json({ error: fiPayment.error, code: fiPayment.code }, { status: 400 });
        }

        // Validate & Map Status (Handle Title Case from UI -> Upper Case for Prisma Enum)
        const statusMap: Record<string, any> = {
            'Active': 'ACTIVE',
            'Lead': 'LEAD',
            'In Progress': 'ACTIVE',
            'Production': 'PRODUCTION',
            'Delivery': 'DELIVERY',
            'Send Info': 'SEND_INFO',
            'Flyers': 'FLYERS',
            'Send Marketing Tools': 'FLYERS',
            'Inactive': 'INACTIVE',
            'At-Risk': 'ACTIVE',
            'Churned': 'COMPLETE',
            'COMPLETE': 'COMPLETE',
            'ACTIVE': 'ACTIVE',
            'LEAD': 'LEAD',
            'SEND_INFO': 'SEND_INFO',
            'FLYERS': 'FLYERS',
            'PRODUCTION': 'PRODUCTION',
            'DELIVERY': 'DELIVERY',
            'INACTIVE': 'INACTIVE'
        };
        // Use provided status if it matches an Enum key, or map it
        let status: any = statusMap[body.status] || (['LEAD', 'SEND_INFO', 'FLYERS', 'ACTIVE', 'PRODUCTION', 'DELIVERY', 'COMPLETE', 'INACTIVE'].includes(body.status) ? body.status : undefined);

        // Check if ID is UUID
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        let orgId = id;

        if (!isUuid) {
            // Case: Promoting a "Manual" customer (Name) to an Organization Record
            const name = decodeURIComponent(id);

            // 1. Create (or find) Customer
            let org = await prisma.customer.findFirst({
                where: {
                    name: name,
                    business_id: session.user.businessId
                }
            });

            const customerTypeMap: Record<string, 'direct_customer' | 'organization' | 'fundraiser_org'> = {
                'Customer': 'direct_customer',
                'Individual': 'direct_customer',
                'Organization': 'organization',
                'Fundraiser': 'fundraiser_org'
            };

            const mappedType = customerTypeMap[body.type] || 'fundraiser_org';

            if (!org) {
                org = await prisma.customer.create({
                    data: {
                        name: body.name || name,
                        contact_name: body.contact_name,
                        business_id: session.user.businessId,
                        contact_email: body.email,
                        contact_phone: body.phone,
                        secondary_phone: body.secondary_phone,
                        delivery_address: body.delivery_address,
                        notes: body.notes,
                        status: status,
                        type: mappedType,
                        inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                        tags: body.tags || [],
                        fundraiser_info: body.fundraiser_info !== undefined ? body.fundraiser_info : undefined
                    }
                });
            } else {
                // Update existing if found
                await prisma.customer.update({
                    where: { id: org.id },
                    data: {
                        name: body.name || name,
                        contact_name: body.contact_name,
                        status: status,
                        inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                        contact_email: body.email,
                        contact_phone: body.phone,
                        secondary_phone: body.secondary_phone,
                        delivery_address: body.delivery_address,
                        notes: body.notes,
                        tags: body.tags || [],
                        type: mappedType,
                        fundraiser_info: body.fundraiser_info !== undefined ? body.fundraiser_info : undefined
                    }
                });
            }

            orgId = org.id;

            // 2. Link existing orders to this new Org.
            //
            // SEC-DATA-INTEGRITY-1: the ORDER mutation carries the tenant itself.
            // The organization above was found or created inside this business, but
            // that proves nothing about the orders: customer_name is free text, so
            // without business_id here this claimed EVERY tenant's unlinked orders
            // that happened to share the name. An order with no business_id belongs
            // to no tenant provably, and is therefore never claimed either.
            // (app/api/customers/[id]/status/route.ts already scoped its copy.)
            await prisma.order.updateMany({
                where: { customer_name: name, customer_id: null, business_id: businessId },
                data: { customer_id: org.id }
            });

        } else {
            // Standard Update for existing Org — verify ownership first
            const existingCustomer = await prisma.customer.findUnique({ where: { id }, select: { business_id: true } });
            if (!existingCustomer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
            if (existingCustomer.business_id !== session.user.businessId) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }

            const customerTypeMap: Record<string, 'direct_customer' | 'organization' | 'fundraiser_org'> = {
                'Customer': 'direct_customer',
                'Individual': 'direct_customer',
                'Organization': 'organization',
                'Fundraiser': 'fundraiser_org'
            };

            // Only update type if it's provided and valid
            const mappedType = body.type ? (customerTypeMap[body.type] || undefined) : undefined;

            const finalUpdateData = {
                name: body.name,
                contact_name: body.contact_name,
                contact_email: body.email,
                contact_phone: body.phone,
                secondary_phone: body.secondary_phone,
                delivery_address: body.delivery_address,
                notes: body.notes,
                status: status,
                type: mappedType,
                inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                tags: body.tags,
                fundraiser_info: body.fundraiser_info !== undefined ? body.fundraiser_info : undefined,
                // ── FR-TAX-1: organization tax posture ────────────────────
                // Omission leaves the stored value alone, matching every other
                // field here — a form that does not carry a tax status must
                // never reset one. An unrecognised value is ignored rather
                // than written, so a typo cannot become a tax position.
                ...(isOrgTaxStatus(body.tax_status) ? { tax_status: body.tax_status as any } : {}),
                ...(body.tax_exemption_number !== undefined
                    ? { tax_exemption_number: String(body.tax_exemption_number).trim().slice(0, 120) || null }
                    : {}),
                // ── CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1 ────────────────────
                // The "Archive"/"Reactivate" button (FundraiserOverview.tsx,
                // CustomerOverview.tsx) has always sent { archived: boolean }
                // to this route, intending to write the real archived/
                // archived_at columns that lib/statusWorkflow.ts's
                // archiveCustomer/unarchiveCustomer already write correctly
                // elsewhere — but this route never read body.archived at
                // all, so every click silently no-op'd. Fixed to actually
                // persist it, moving both fields together exactly as that
                // module already does. Omission (every other PUT this route
                // receives) leaves the stored value alone, same as every
                // other field above — this does not touch status, since the
                // button never asked for that.
                ...(typeof body.archived === 'boolean'
                    ? { archived: body.archived, archived_at: body.archived ? new Date() : null }
                    : {}),
            };

            await prisma.customer.update({
                where: { id },
                data: finalUpdateData
            });
        }

        // ── LEGACY-WRITER-GUARDS-1: an organization profile never writes a campaign ──
        //
        // This route used to push customer.fundraiser_info into "whichever campaign was created most
        // recently" (no campaign id), whenever that campaign was open. CRM-CAMPAIGN-DETAILS-1 had
        // already made five operational fields fill-only, but bundle_goal, start_date,
        // participant_label, about_text, mission_text and the payment text were still overwritten —
        // and the org form (components/crm/FundraiserSetup.tsx) defaults bundle_goal to 20, so an
        // unrelated profile save could reset a campaign's goal. Even the fill-only half wrote the
        // form's own defaults ("4:45 PM", the organization's name as payee) into a new campaign's
        // blanks, where they then read as answers nobody gave.
        //
        // Every one of those fields has a campaign-owned writer: Edit details and the campaign PATCH
        // (dates, time, location, payee, goal, labels, text), coordinator setup and Payment Settings
        // (payment). The blob itself is still saved above, as organization-level notes.
        // fiPayment's validation is kept, so an invalid payment value is still refused before
        // anything is written.

        return NextResponse.json({ success: true, newId: orgId });
    } catch (e: any) {
        console.error("Update Error:", e);
        // Return the actual error message for clearer debugging
        return NextResponse.json({ error: `Failed to update customer: ${e.message}` }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { id } = await params;

        // Ensure it's a UUID (Organization)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        if (!isUuid) {
            return NextResponse.json({ error: "Cannot delete transient customers (linked to orders). Please Archive instead." }, { status: 400 });
        }

        // Check if exists and belongs to this tenant
        const org = await prisma.customer.findUnique({ where: { id }, include: { orders: true } });
        if (!org) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        if (org.business_id !== businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        if (org.orders.length > 0) {
            return NextResponse.json({ error: "Cannot delete customer with existing orders. Mark as Churned instead." }, { status: 400 });
        }

        // FR-RETENTION-0R: fundraiser history must survive normal lifecycle.
        // The database also enforces this (fundraiser_campaigns_customer_id_fkey is
        // ON DELETE RESTRICT); this check exists so the tenant gets a clear,
        // actionable message instead of a raw foreign-key error.
        const campaignCount = await prisma.fundraiserCampaign.count({ where: { customer_id: id } });
        if (campaignCount > 0) {
            return NextResponse.json({
                error: `This organization has ${campaignCount} fundraiser campaign${campaignCount === 1 ? '' : 's'} and cannot be deleted. Archive it instead — archiving keeps the campaigns, orders, and contact history.`,
            }, { status: 400 });
        }

        // Contact relationship history is likewise retained rather than destroyed.
        const relationshipCount = await prisma.fundraiserOrganizationContact.count({ where: { customer_id: id } });
        if (relationshipCount > 0) {
            return NextResponse.json({
                error: "This organization has contact history and cannot be deleted. Archive it instead.",
            }, { status: 400 });
        }

        // DATA-CLEANUP-GUARDS-1: invoices CASCADE from their customer, so deleting a
        // customer that has any would silently erase invoice history — paid legacy
        // invoices included — through a door the invoice delete rules never see.
        const invoiceCount = await prisma.invoice.count({ where: { customer_id: id } });
        if (invoiceCount > 0) {
            return NextResponse.json({
                error: `This customer has ${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} and cannot be deleted. Archive it instead — archiving keeps its invoice history.`,
            }, { status: 400 });
        }

        await prisma.customer.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("Delete Error:", e);
        return NextResponse.json({ error: "Failed to delete customer" }, { status: 500 });
    }
}
