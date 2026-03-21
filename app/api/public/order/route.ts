import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { items, customer, slug, campaignId } = body;

        if (!items || items.length === 0) {
            return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
        }

        if (!customer || !customer.email || !customer.name) {
            return NextResponse.json({ error: "Customer details required" }, { status: 400 });
        }

        if (!slug || typeof slug !== 'string') {
            return NextResponse.json({ error: "Store identifier required" }, { status: 400 });
        }

        // 1. Resolve Business from slug (server-trusted, never from client businessId)
        const business = await prisma.business.findFirst({
            where: {
                slug: {
                    equals: slug.toLowerCase().trim(),
                    mode: 'insensitive'
                }
            }
        });

        if (!business) {
            return NextResponse.json({ error: "Business not found" }, { status: 404 });
        }

        const businessId = business.id;

        // 1.5 SERVER-SIDE PRICE VALIDATION — never trust client prices
        const bundleIds = items
            .filter((item: any) => item.bundleId && item.bundleId !== 'manual_upsell')
            .map((item: any) => item.bundleId);

        const dbBundles = bundleIds.length > 0
            ? await prisma.bundle.findMany({
                where: { id: { in: bundleIds }, business_id: businessId },
                select: { id: true, price: true }
            })
            : [];

        const bundlePriceMap = new Map(dbBundles.map((b: any) => [b.id, Number(b.price)]));

        let manualUpsellPrice: number | null = null;
        const hasManualUpsell = items.some((item: any) => item.bundleId === 'manual_upsell');
        if (hasManualUpsell) {
            const sfConfig = await prisma.storefrontConfig.findUnique({
                where: { business_id: businessId },
                select: { manual_upsell_price: true }
            });
            manualUpsellPrice = sfConfig?.manual_upsell_price ? Number(sfConfig.manual_upsell_price) : null;
        }

        // Resolve each item's price from DB — reject if no valid price
        const resolvedItems = items.map((item: any) => {
            let serverPrice: number;

            if (item.bundleId === 'manual_upsell') {
                if (manualUpsellPrice === null || manualUpsellPrice <= 0) {
                    throw new Error(`Upsell item "${item.name}" has no valid price configured`);
                }
                serverPrice = manualUpsellPrice;
            } else if (item.bundleId) {
                const dbPrice = bundlePriceMap.get(item.bundleId);
                if (dbPrice === undefined) {
                    throw new Error(`Bundle not found for this business`);
                }
                if (!dbPrice || dbPrice <= 0) {
                    throw new Error(`Bundle "${item.name}" has no valid price`);
                }
                serverPrice = dbPrice;
            } else {
                throw new Error(`Item "${item.name}" has no bundle reference`);
            }

            return { ...item, serverPrice };
        });

        const serverTotal = resolvedItems.reduce(
            (sum: number, item: any) => sum + (item.serverPrice * item.quantity), 0
        );

        // 1.6 Fetch Campaign & Org Details (if campaignId provided)
        let campaign: any = null;
        let orgContactEmail: string | null = null;
        let paymentInstructions: string | null = null;
        let externalPaymentLink: string | null = null;
        let orgName: string | null = null;

        if (campaignId) {
            campaign = await prisma.fundraiserCampaign.findUnique({
                where: { id: campaignId },
                include: { customer: true } // Get the Organization customer
            });

            // Validate campaign belongs to this business
            if (campaign && campaign.customer?.business_id !== businessId) {
                return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
            }

            if (campaign) {
                // @ts-ignore - Schema fields exist
                paymentInstructions = campaign.payment_instructions;
                // @ts-ignore
                externalPaymentLink = campaign.external_payment_link;
                orgName = campaign.customer?.name || null;

                if (campaign.customer?.contact_email) {
                    orgContactEmail = campaign.customer.contact_email;
                }
            }
        }

        // 2. Find or Create Customer (Individual)
        // We try to find by email AND type='Individual' to avoid mixing with Org contacts
        let dbCustomer = await prisma.customer.findFirst({
            where: {
                business_id: businessId,
                contact_email: customer.email,
                type: 'direct_customer' // Enum value for Individual
            }
        });

        const formattedAddress = customer.address ? `${customer.address}, ${customer.city}, ${customer.state} ${customer.zip}` : null;

        if (!dbCustomer) {
            // Create new "Lead" customer
            dbCustomer = await prisma.customer.create({
                data: {
                    business_id: businessId,
                    name: customer.name,
                    contact_email: customer.email,
                    contact_phone: customer.phone,
                    delivery_address: formattedAddress,
                    type: 'direct_customer',
                    status: 'LEAD',
                    source: campaignId ? 'Fundraiser' : 'Storefront',
                    notes: `Created via ${campaignId ? 'Fundraiser' : 'Storefront'} Order.${campaign ? ` Campaign: ${campaign.name}` : ''}`,
                    external_id: `sf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                }
            });

            // Trigger lead notification to business owner
            const owner = await prisma.user.findFirst({
                where: { business_id: businessId }
            });
            if (owner?.email) {
                const { sendLeadNotificationEmail } = await import('@/lib/email');
                await sendLeadNotificationEmail(owner.email, {
                    name: customer.name,
                    email: customer.email,
                    phone: customer.phone,
                    source: campaignId ? 'Fundraiser' : 'Storefront'
                });
            }
        } else if (formattedAddress && dbCustomer.delivery_address !== formattedAddress) {
            // Update existing customer with new address if it changed or was empty
            dbCustomer = await prisma.customer.update({
                where: { id: dbCustomer.id },
                data: { delivery_address: formattedAddress, contact_phone: customer.phone } // Opportunistically update phone as well
            });
        }

        // 3. Create Order
        const order = await prisma.order.create({
            data: {
                business_id: businessId,
                customer_id: dbCustomer.id,
                customer_name: customer.name,
                participant_name: customer.participantCode || null,
                // @ts-ignore - 'storefront' was just added to enum
                source: 'storefront',
                status: 'pending',
                total_amount: serverTotal,
                delivery_address: customer.address ? `${customer.address}, ${customer.city}, ${customer.state} ${customer.zip}` : customer.notes,
                external_id: `ord_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                campaign_id: campaignId || null,
                items: {
                    create: resolvedItems.map((item: any) => ({
                        bundle_id: (item.bundleId === 'manual_upsell' || !item.bundleId) ? null : item.bundleId,
                        quantity: item.quantity,
                        variant_size: item.serving_tier === 'Family Size' ? 'serves_5' : 'serves_2',
                        item_name: item.name,
                        unit_price: item.serverPrice,
                        is_subscription: !!item.isSubscription
                    }))
                }
            },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        // 4. Update Stock (Simple subtraction for Bundles only)
        for (const item of items) {
            if (item.bundleId && item.bundleId !== 'manual_upsell') {
                await prisma.bundle.update({
                    where: { id: item.bundleId },
                    data: {
                        stock_on_hand: {
                            decrement: item.quantity
                        }
                    } as any // Cast to any to avoid partial type mismatch on Decimal decrement
                });
            }
        }

        // 5. Send Confirmation Email
        // Import dynamically to avoid circular deps if any, though likely fine
        const { sendOrderConfirmationEmail } = await import('@/lib/email');
        await sendOrderConfirmationEmail(
            customer.email,
            order,
            (order as any).items, // Cast to any because TS isn't inferring the include 
            orgContactEmail,
            paymentInstructions,
            externalPaymentLink
        );

        return NextResponse.json({
            success: true,
            orderId: order.id,
            paymentData: {
                paymentInstructions,
                externalPaymentLink,
                orgName
            }
        });

    } catch (e: any) {
        console.error("Failed to place storefront order:", e);
        return NextResponse.json({ error: e.message || "Internal Server Error" }, { status: 500 });
    }
}
