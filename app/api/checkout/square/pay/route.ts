/**
 * Square Payment Processing Endpoint
 * 
 * POST /api/checkout/square/pay
 * 
 * Receives a payment token from the Square Web Payments SDK (frontend),
 * creates a payment on the tenant's Square account, and updates the order.
 * 
 * Per Constitution §9: Uses tenant-owned Square credentials, never platform Stripe.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSquarePaymentClient } from '@/lib/payments/square_provider';
import crypto from 'crypto';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { paymentToken, orderId, amountCents, businessId, customerEmail } = body;

    // Validate required fields
    if (!paymentToken || !orderId || !amountCents || !businessId) {
      return NextResponse.json(
        { error: 'Missing required fields: paymentToken, orderId, amountCents, businessId' },
        { status: 400 }
      );
    }

    // Verify business exists
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Verify the order exists, belongs to this business, and is pending
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }
    if (order.business_id !== businessId) {
      return NextResponse.json({ error: 'Order does not belong to this business' }, { status: 403 });
    }
    if (order.status !== 'pending') {
      return NextResponse.json({ error: 'Order is not in pending state' }, { status: 400 });
    }

    // Server-side price validation: verify amount matches order total
    const expectedCents = Math.round(Number(order.total_amount) * 100);
    if (amountCents !== expectedCents) {
      return NextResponse.json(
        { error: 'Amount mismatch — price may have changed. Please refresh and try again.' },
        { status: 400 }
      );
    }

    // Get authenticated Square client for this business
    const client = await getSquarePaymentClient(businessId);

    // Get primary location
    const { locations } = await client.locations.list();
    const location = locations?.find(l => l.status === 'ACTIVE') || locations?.[0];
    if (!location?.id) {
      return NextResponse.json({ error: 'No Square location found' }, { status: 500 });
    }

    // Create payment via Square Payments API
    // Deterministic key: retries for the same order reuse the same key,
    // so Square deduplicates automatically.
    // Square max idempotencyKey length is 45 chars; SHA-256 hex is 64
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`freezeriq-square-pay-${orderId}`)
      .digest('hex')
      .substring(0, 45);

    const paymentResult = await client.payments.create({
      sourceId: paymentToken,
      idempotencyKey,
      amountMoney: {
        amount: BigInt(amountCents),
        currency: 'USD',
      },
      locationId: location.id,
      buyerEmailAddress: customerEmail,
      note: `FreezerIQ Order ${order.external_id}`,
      referenceId: orderId,
    });

    if (!paymentResult.payment || paymentResult.payment.status !== 'COMPLETED') {
      console.error('[SQUARE_PAY] Payment not completed:', paymentResult);
      return NextResponse.json(
        { error: 'Payment was not completed. Please try again.' },
        { status: 400 }
      );
    }

    // Update order status to production_ready
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'production_ready',
        processor_payment_id: paymentResult.payment.id,
      },
    });

    console.log(`[SQUARE_PAY] Payment ${paymentResult.payment.id} completed for order ${orderId}`);

    return NextResponse.json({
      success: true,
      orderId: orderId,
      paymentId: paymentResult.payment.id,
    });

  } catch (error: any) {
    console.error('[SQUARE_PAY] Full error:', JSON.stringify(error, null, 2));
    const detail = error?.body?.errors?.[0]?.detail
      || error?.errors?.[0]?.detail
      || error?.message
      || 'Payment processing failed. Please try again.';
    console.error('[SQUARE_PAY] Detail:', detail);
    return NextResponse.json(
      { error: detail },
      { status: 500 }
    );
  }
}
