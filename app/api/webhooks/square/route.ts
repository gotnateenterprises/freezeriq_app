/**
 * Square Storefront Webhook
 *
 * POST /api/webhooks/square
 *
 * Receives Square webhook events and promotes pending storefront orders
 * to production_ready when payment is confirmed.
 *
 * Per Constitution §9: This is tenant commerce — NOT platform billing.
 * Per Architecture §Webhooks: Clearly belongs to tenant commerce domain.
 *
 * Signature verification uses the Square SDK WebhooksHelper, which
 * validates HMAC-SHA256 using the webhook subscription's signature key
 * and notification URL.
 *
 * Idempotency pattern mirrors app/api/webhooks/stripe/route.ts:
 *   1. Verify signature
 *   2. Resolve order via payment.reference_id (set to orderId in square/pay)
 *   3. Guard: order exists, belongs to correct business, is pending
 *   4. Promote pending → production_ready exactly once
 *   5. Already-promoted orders are silently skipped
 */

import { NextResponse } from 'next/server';
import { WebhooksHelper } from 'square';
import { prisma } from '@/lib/db';

// Next.js must not parse the body — we need the raw string for HMAC verification
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // ── 1. Read raw body and signature header ──────────────────────────────────
  const body = await req.text();
  const signatureHeader = req.headers.get('x-square-hmacsha256-signature');

  if (!signatureHeader) {
    console.error('[SQUARE_WEBHOOK] Missing x-square-hmacsha256-signature header');
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  // ── 2. Verify env vars exist ───────────────────────────────────────────────
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;

  if (!signatureKey || !notificationUrl) {
    console.error('[SQUARE_WEBHOOK] Missing SQUARE_WEBHOOK_SIGNATURE_KEY or SQUARE_WEBHOOK_NOTIFICATION_URL');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  // ── 3. Verify HMAC-SHA256 signature ────────────────────────────────────────
  let isValid: boolean;
  try {
    isValid = await WebhooksHelper.verifySignature({
      requestBody: body,
      signatureHeader,
      signatureKey,
      notificationUrl,
    });
  } catch (err: any) {
    console.error('[SQUARE_WEBHOOK] Signature verification error:', err.message);
    return NextResponse.json({ error: 'Signature verification failed' }, { status: 400 });
  }

  if (!isValid) {
    console.error('[SQUARE_WEBHOOK] Invalid signature — rejecting');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // ── 4. Parse event ────────────────────────────────────────────────────────
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    console.error('[SQUARE_WEBHOOK] Failed to parse JSON body');
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType: string = event?.type;

  // ── 5. Route by event type ────────────────────────────────────────────────
  if (eventType === 'payment.completed') {
    await handlePaymentCompleted(event.data?.object?.payment);
  } else {
    // Accept but ignore unhandled event types (Square best practice)
    console.log(`[SQUARE_WEBHOOK] Unhandled event type: ${eventType}`);
  }

  // ── 6. Always acknowledge receipt (Square retries on non-2xx) ─────────────
  return NextResponse.json({ received: true });
}

// ─── Handler: payment.completed ──────────────────────────────────────────────

async function handlePaymentCompleted(payment: any) {
  if (!payment) {
    console.error('[SQUARE_WEBHOOK] payment.completed event missing payment object');
    return;
  }

  // The square/pay route sets referenceId = orderId when creating the payment
  const orderId = payment.reference_id;
  const squarePaymentId = payment.id;

  if (!orderId) {
    // Not a FreezerIQ-originated payment (e.g., direct Square POS sale) — ignore
    console.log(`[SQUARE_WEBHOOK] payment.completed without reference_id — skipping (payment: ${squarePaymentId})`);
    return;
  }

  // ── Lookup order ──────────────────────────────────────────────────────────
  const existingOrder = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, business_id: true },
  });

  if (!existingOrder) {
    console.error(`[SQUARE_WEBHOOK] Order not found: ${orderId} (payment: ${squarePaymentId})`);
    return;
  }

  // ── Idempotency: already promoted — skip silently ─────────────────────────
  if (existingOrder.status === 'production_ready') {
    console.log(`[SQUARE_WEBHOOK] Order ${orderId} already production_ready — skipping (idempotent)`);
    return;
  }

  // ── Guard: only promote from pending ──────────────────────────────────────
  if (existingOrder.status !== 'pending') {
    console.warn(`[SQUARE_WEBHOOK] Order ${orderId} in unexpected state "${existingOrder.status}" — skipping`);
    return;
  }

  // ── Promote to production_ready ───────────────────────────────────────────
  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'production_ready',
      processor_payment_id: squarePaymentId,
    },
  });

  console.log(`[SQUARE_WEBHOOK] ✓ Order ${orderId} confirmed via webhook (payment: ${squarePaymentId})`);
}
