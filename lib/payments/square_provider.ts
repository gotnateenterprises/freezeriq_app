/**
 * Square Payment Provider
 * 
 * Implements PaymentProvider interface using Square Web Payments SDK.
 * Uses tenant's Square OAuth credentials from Integration table.
 * 
 * Flow:
 *   1. createCheckout → returns Square SDK config (applicationId, locationId)
 *   2. Frontend tokenizes card via Web Payments SDK
 *   3. Frontend sends token to /api/checkout/square/pay
 *   4. Server calls Square Payments API with the token
 */

import { SquareClient, SquareEnvironment } from 'square';
import { prisma } from '@/lib/db';
import { TokenManager } from '@/lib/auth/token_manager';
import type { PaymentProvider, CheckoutRequest, CheckoutResult, PaymentVerification } from './types';

const SQUARE_ENV = process.env.SQUARE_ENVIRONMENT === 'production'
  ? SquareEnvironment.Production
  : SquareEnvironment.Sandbox;

/**
 * Get an authenticated Square client for a business's payment integration.
 * Handles automatic token refresh if within 5-day expiry window.
 */
export async function getSquarePaymentClient(businessId: string): Promise<SquareClient> {
  const tokenManager = new TokenManager('square', businessId);
  const tokens = await tokenManager.getTokens();

  if (!tokens || !tokens.access_token) {
    throw new Error('Square payment integration not connected.');
  }

  // Proactive refresh if within 5 days of expiry
  if (tokens.expires_at && new Date() > new Date(tokens.expires_at.getTime() - 5 * 24 * 60 * 60 * 1000)) {
    if (!tokens.refresh_token) {
      throw new Error('Square token expired and no refresh token available. Please reconnect.');
    }

    const authClient = new SquareClient({ environment: SQUARE_ENV });
    const response = await authClient.oAuth.obtainToken({
      clientId: process.env.SQUARE_APP_ID!,
      clientSecret: process.env.SQUARE_APP_SECRET!,
      grantType: 'refresh_token',
      refreshToken: tokens.refresh_token,
    });

    if (!response.accessToken) {
      throw new Error('Failed to refresh Square payment token.');
    }

    await tokenManager.saveTokens(
      response.accessToken,
      response.refreshToken,
      response.expiresAt ? new Date(response.expiresAt) : undefined
    );

    return new SquareClient({ environment: SQUARE_ENV, token: response.accessToken });
  }

  return new SquareClient({ environment: SQUARE_ENV, token: tokens.access_token });
}

/**
 * Get the primary location ID for a Square merchant.
 * Square requires a location_id for payments.
 */
async function getPrimaryLocationId(client: SquareClient): Promise<string> {
  const { locations } = await client.locations.list();
  if (!locations || locations.length === 0) {
    throw new Error('No Square locations found for this merchant.');
  }
  // Prefer the main location (first active one)
  const active = locations.find(l => l.status === 'ACTIVE');
  return (active || locations[0]).id!;
}

export class SquarePaymentProvider implements PaymentProvider {

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    // Verify Square credentials exist
    const tokens = await prisma.integration.findUnique({
      where: {
        business_id_provider: {
          business_id: req.businessId,
          provider: 'square',
        }
      }
    });

    if (!tokens || !tokens.access_token) {
      throw new Error('Square payment integration not connected for this business.');
    }

    // Get location ID for Web Payments SDK
    const client = await getSquarePaymentClient(req.businessId);
    const locationId = await getPrimaryLocationId(client);

    const applicationId = process.env.SQUARE_APP_ID!;

    return {
      type: 'embedded',
      squareConfig: {
        applicationId,
        locationId,
      },
    };
  }

  async verifyPayment(paymentId: string, businessId: string): Promise<PaymentVerification> {
    const client = await getSquarePaymentClient(businessId);

    try {
      const { payment } = await client.payments.get({ paymentId });

      if (!payment || payment.status !== 'COMPLETED') {
        return { paid: false };
      }

      return {
        paid: true,
        providerPaymentId: payment.id,
        platformFeeAmountCents: 0, // Square doesn't use application_fee — future: use Square App Fee if needed
      };
    } catch (e) {
      console.error('[SQUARE_VERIFY_PAYMENT]', e);
      return { paid: false };
    }
  }
}
