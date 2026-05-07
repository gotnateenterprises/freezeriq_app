import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { getCustomerSession } from '@/lib/customerAuth';
import { getPaymentProvider } from '@/lib/payments';
import { geocodeAddress, resolveDeliveryZone } from '@/lib/delivery/zones';
import { resolveVariantSize } from '@/lib/serving_multipliers';
import { buildBundlePriceMap } from '@/lib/pricing';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { 
            slug, items, deliveryDate, customerNotes, 
            customerName, customerEmail: customerEmailInput, customerPhone,
            fulfillmentType, // "pickup" | "delivery"
            address, city, state, zip
        } = body;

        // 1. Verify Tenant — resolve from slug (never trust client-sent IDs)
        if (!slug) {
            return NextResponse.json({ error: 'Missing slug' }, { status: 400 });
        }
        const business = await prisma.business.findFirst({
            where: { slug }
        });

        if (!business) {
            return new NextResponse('Business not found', { status: 404 });
        }
        const businessId = business.id;
        
        // 1b. Fetch Storefront Config for Tax/Delivery settings + zones
        const storefrontConfig: any = await prisma.storefrontConfig.findUnique({
            where: { business_id: businessId },
        });

        // Fetch delivery zones separately via raw SQL (avoids Prisma client cache issues)
        let delivery_zones: any[] = [];
        if (storefrontConfig?.id) {
            delivery_zones = await prisma.$queryRaw`
                SELECT id, name, max_radius_miles, fee, sort_order
                FROM delivery_zones
                WHERE storefront_config_id = ${storefrontConfig.id}
                ORDER BY sort_order ASC
            `;
            storefrontConfig.delivery_zones = delivery_zones;
        } else if (storefrontConfig) {
            storefrontConfig.delivery_zones = [];
        }

        const taxPercent = Number(storefrontConfig?.tax_percent || 0);
        const flatDeliveryFee = Number(storefrontConfig?.delivery_fee || 0);
        const isDeliveryEnabled = storefrontConfig?.is_delivery_enabled !== false;
        const isPickupEnabled = storefrontConfig?.is_pickup_enabled !== false;

        // Guard: reject checkout if tenant has disabled both fulfillment options
        if (!isDeliveryEnabled && !isPickupEnabled) {
            return NextResponse.json({ error: 'This store is not currently accepting orders.' }, { status: 400 });
        }

        // Determine effective fulfillment type and validate delivery address
        const finalFulfillmentType = (fulfillmentType === 'delivery' && isDeliveryEnabled) ? 'delivery' : 'pickup';
        
        if (finalFulfillmentType === 'delivery') {
            if (!address || !city || !state || !zip) {
                return NextResponse.json({ error: 'Delivery address is required' }, { status: 400 });
            }
        }

        // --- Zone-aware delivery fee resolution ---
        let appliedDeliveryFee = 0;
        let deliveryZoneName: string | null = null;
        const fullDeliveryAddress = finalFulfillmentType === 'delivery' 
            ? `${address}, ${city}, ${state} ${zip}`
            : null;

        if (finalFulfillmentType === 'delivery') {
            const zones = storefrontConfig?.delivery_zones || [];
            const hasOrigin = storefrontConfig?.origin_lat && storefrontConfig?.origin_lng;

            if (zones.length > 0 && hasOrigin) {
                // Zone-based: geocode customer address and resolve zone
                const geo = await geocodeAddress(fullDeliveryAddress!);
                if (!geo) {
                    return NextResponse.json(
                        { error: 'We couldn\'t verify your delivery address. Please check and try again.' },
                        { status: 400 }
                    );
                }

                const zoneInputs = zones.map(z => ({
                    id: z.id,
                    name: z.name,
                    max_radius_miles: Number(z.max_radius_miles),
                    fee: Number(z.fee),
                    sort_order: z.sort_order,
                }));

                const zoneResult = resolveDeliveryZone(
                    Number(storefrontConfig!.origin_lat),
                    Number(storefrontConfig!.origin_lng),
                    geo.lat,
                    geo.lng,
                    zoneInputs
                );

                if (!zoneResult.deliverable) {
                    return NextResponse.json(
                        { error: zoneResult.error },
                        { status: 400 }
                    );
                }

                appliedDeliveryFee = zoneResult.fee;
                deliveryZoneName = zoneResult.zoneName;
            } else {
                // No zones configured — use flat fee (backward compatible)
                appliedDeliveryFee = flatDeliveryFee;
            }
        }

        // 2. Resolve Customer (Optional: if they are logged into the Account Portal)
        const session = await getCustomerSession();
        let customerId = undefined;
        let customerEmail = undefined;

        if (session && session.businessId === businessId) {
            customerId = session.customerId;
            customerEmail = session.email;
        }

        // 3. Server-side price validation — never trust client-sent prices
        //    Price lookup uses centralized buildBundlePriceMap() (LAW 1)
        const bundleIds = items
            .filter((item: any) => item.bundleId && item.bundleId !== 'manual_upsell')
            .map((item: any) => item.bundleId);

        const bundlePriceMap = await buildBundlePriceMap(business.id, bundleIds);

        // Name/image lookup for Stripe line item display (not security-critical)
        const dbBundles = bundleIds.length > 0
            ? await prisma.bundle.findMany({
                where: { id: { in: bundleIds }, business_id: business.id },
                select: { id: true, name: true, image_url: true }
            })
            : [];
        const bundleDisplayMap = new Map(dbBundles.map((b: any) => [b.id, { name: b.name, image_url: b.image_url }]));

        // Build line items with DB-validated prices
        const validatedLineItems = items.map((item: any) => {
            const price = bundlePriceMap.get(item.bundleId);
            const display = bundleDisplayMap.get(item.bundleId);
            const unitPrice = price !== undefined ? price : Number(item.price);
            const productName = display ? display.name : item.name;
            const productImage = display ? display.image_url : item.image_url;
            return {
                name: productName,
                unitAmountCents: Math.round(unitPrice * 100),
                quantity: item.quantity,
                image: productImage,
                bundleId: item.bundleId,
                serving_tier: item.serving_tier,
                rawUnitPrice: unitPrice,
            };
        });

        // 4. Calculate validated total from DB prices
        const validatedTotal = validatedLineItems.reduce((sum: number, item: any) => {
            return sum + ((item.rawUnitPrice) * (item.quantity || 1));
        }, 0);

        // 4b. Calculate Tax and Final Total
        const taxAmount = Number((validatedTotal * (taxPercent / 100)).toFixed(2));
        const finalTotal = Number((validatedTotal + taxAmount + appliedDeliveryFee).toFixed(2));
        const totalAmountCents = Math.round(finalTotal * 100);

        // 5. Generate Database Order First (Pending Payment)
        // Serving tier mapping uses centralized resolveVariantSize()
        // from lib/serving_multipliers.ts (SINGLE SOURCE OF TRUTH)

        const externalId = Math.random().toString(36).substring(2, 9).toUpperCase();

        // Resolve payment provider early so we can record it on the order
        const { type: providerType } = await getPaymentProvider(businessId);

        const pendingOrder = await prisma.order.create({
            data: {
                business_id: business.id,
                customer_id: customerId || null,
                external_id: externalId,
                source: 'storefront',
                status: 'pending',
                payment_processor: providerType, // "stripe" | "square"
                total_amount: finalTotal,
                fulfillment_type: finalFulfillmentType === 'delivery' ? 'DELIVERY' : 'PICKUP',
                tax_amount: taxAmount,
                delivery_fee: appliedDeliveryFee,
                delivery_zone_name: deliveryZoneName,
                delivery_address: fullDeliveryAddress,
                customer_name: customerName,
                delivery_date: deliveryDate ? new Date(deliveryDate) : null,
                items: {
                    create: items.map((item: any) => {
                        const price = bundlePriceMap.get(item.bundleId);
                        const display = bundleDisplayMap.get(item.bundleId);
                        const unitPrice = price !== undefined ? price : Number(item.price);
                        return {
                            bundle_id: item.bundleId === 'manual_upsell' ? null : item.bundleId,
                            quantity: item.quantity,
                            item_name: display ? display.name : item.name,
                            unit_price: unitPrice,
                            variant_size: resolveVariantSize(item.serving_tier)
                        };
                    })
                }
            }
        });

        // Use the request origin so redirects stay on the same host
        // (avoids .env.local NEXTAUTH_URL pointing to Vercel in local dev)
        const origin = new URL(req.url).origin;
        const appUrl = origin || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';

        // 6. Create checkout using the already-resolved provider type

        if (providerType === 'square') {
            // Square: return embedded payment form config
            // The actual payment happens client-side → /api/checkout/square/pay
            const { provider } = await getPaymentProvider(businessId);
            const checkoutResult = await provider.createCheckout({
                businessId,
                slug: business.slug,
                orderId: pendingOrder.id,
                lineItems: validatedLineItems,
                totalAmountCents,
                customerEmail: customerEmail || customerEmailInput,
                customerName,
                successUrl: `${appUrl}/shop/${business.slug}/checkout/success?order_id=${pendingOrder.id}&business_id=${business.id}`,
                cancelUrl: `${appUrl}/shop/${business.slug}/cart`,
                metadata: {
                    businessId: business.id,
                    customerId: customerId || '',
                    orderId: pendingOrder.id,
                    source: 'b2c'
                },
            });

            return NextResponse.json({
                type: 'embedded',
                orderId: pendingOrder.id,
                amountCents: totalAmountCents,
                squareConfig: checkoutResult.squareConfig,
                successUrl: `${appUrl}/shop/${business.slug}/checkout/success?order_id=${pendingOrder.id}&business_id=${business.id}`,
            });
        }

        // Stripe: existing redirect flow (default)
        // Resolve Stripe Connected Account from Integration (source of truth)
        const stripeIntegration = await prisma.integration.findUnique({
            where: {
                business_id_provider: {
                    business_id: businessId,
                    provider: 'stripe'
                }
            }
        });

        const connectedAccountId = stripeIntegration?.access_token;

        if (!connectedAccountId) {
            return NextResponse.json({ error: 'Checkout is temporarily unavailable for this kitchen (Stripe Onboarding Incomplete).' }, { status: 400 });
        }

        if (process.env.NODE_ENV !== 'development') {
            const acct = await stripe.accounts.retrieve(connectedAccountId);
            if (!acct.charges_enabled) {
                return NextResponse.json({ error: 'Checkout is temporarily unavailable for this kitchen (Stripe Onboarding Incomplete).' }, { status: 400 });
            }
        }

        // Build Stripe line items
        const stripeLineItems = validatedLineItems.map((item: any) => ({
            price_data: {
                currency: 'usd',
                product_data: {
                    name: item.name,
                    images: item.image ? [item.image] : [],
                },
                unit_amount: item.unitAmountCents,
            },
            quantity: item.quantity,
        }));

        // Add Tax and Delivery line items if applicable
        if (taxAmount > 0) {
            stripeLineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Sales Tax' },
                    unit_amount: Math.round(taxAmount * 100),
                },
                quantity: 1,
            });
        }

        if (appliedDeliveryFee > 0) {
            stripeLineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Delivery Fee' },
                    unit_amount: Math.round(appliedDeliveryFee * 100),
                },
                quantity: 1,
            });
        }

        // Calculate Application Fee
        let applicationFeeAmountCents = 0;
        const platformFeePercent = 0;
        if (platformFeePercent > 0) {
            applicationFeeAmountCents = Math.round(totalAmountCents * (platformFeePercent / 100));
        }

        const sessionParams: any = {
            payment_method_types: ['card', 'us_bank_account'],
            allow_promotion_codes: true,
            line_items: stripeLineItems,
            mode: 'payment',
            success_url: `${appUrl}/shop/${business.slug}/checkout/success?session_id={CHECKOUT_SESSION_ID}&business_id=${business.id}`,
            cancel_url: `${appUrl}/shop/${business.slug}/cart`,
            customer_email: customerEmail || customerEmailInput,
            metadata: {
                businessId: business.id,
                customerId: customerId || '',
                orderId: pendingOrder.id,
                source: 'b2c'
            }
        };

        if (applicationFeeAmountCents > 0) {
            sessionParams.payment_intent_data = {
                application_fee_amount: applicationFeeAmountCents,
            };
        }

        const stripeSession = await stripe.checkout.sessions.create(
            sessionParams,
            { stripeAccount: connectedAccountId }
        );

        return NextResponse.json({ type: 'redirect', url: stripeSession.url });

    } catch (error: any) {
        console.error('[CHECKOUT]', error);
        const message = `Checkout error: ${error.message || error}`;
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

