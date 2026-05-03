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
    const { paymentToken, orderId, amountCents, customerEmail } = body;

    // Validate required fields (businessId is derived from the order, never from client)
    if (!paymentToken || !orderId || !amountCents) {
      return NextResponse.json(
        { error: 'Missing required fields: paymentToken, orderId, amountCents' },
        { status: 400 }
      );
    }

    // Verify the order exists and is pending
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }
    if (order.status !== 'pending') {
      return NextResponse.json({ error: 'Order is not in pending state' }, { status: 400 });
    }

    // Derive businessId from the order (server-trusted, never from client)
    const businessId = order.business_id;
    if (!businessId) {
      return NextResponse.json({ error: 'Order has no associated business' }, { status: 400 });
    }

    // Verify business exists
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
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
    // 1. Detailed error logging for diagnostics
    console.error('[SQUARE_PAY] Full Error Object:', JSON.stringify(error, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value, 2));

    // 2. Identify the specific error type
    const statusCode = error?.statusCode || error?.status || 500;
    const errors = error?.errors || error?.body?.errors;
    const firstError = errors?.[0];
    
    // 3. Handle 401 Unauthorized specifically
    if (statusCode === 401 || firstError?.code === 'UNAUTHORIZED') {
      console.error('[SQUARE_PAY] Unauthorized error. Tenant Square token is invalid or expired.');
      return NextResponse.json(
        { 
          error: 'SQUARE_RECONNECT_REQUIRED', 
          detail: 'Your Square connection has expired or is invalid. Please reconnect your Square account in Settings to resume payments.',
          code: 'UNAUTHORIZED'
        },
        { status: 401 }
      );
    }

    // 4. Handle Environment Mismatch (from getSquarePaymentClient)
    if (error?.message?.includes('Environment Mismatch')) {
      return NextResponse.json(
        { 
          error: 'SQUARE_ENVIRONMENT_MISMATCH', 
          detail: error.message,
          code: 'ENV_MISMATCH'
        },
        { status: 401 }
      );
    }

    // 5. Default Error Handling
    const detail = firstError?.detail || error?.message || 'Payment processing failed. Please try again.';
    console.error('[SQUARE_PAY] Processing error detail:', detail);

    return NextResponse.json(
      { error: detail },
      { status: statusCode >= 400 && statusCode < 600 ? statusCode : 500 }
    );
  }
}
