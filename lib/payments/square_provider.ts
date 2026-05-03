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

  const isProduction = process.env.SQUARE_ENVIRONMENT === 'production';
  const tokenPrefix = tokens.access_token.substring(0, 8);
  
  console.log(`[SQUARE_CLIENT] Initializing for business ${businessId}`);
  console.log(`[SQUARE_CLIENT] Environment: ${process.env.SQUARE_ENVIRONMENT}`);
  console.log(`[SQUARE_CLIENT] Token Prefix: ${tokenPrefix}...`);

  // Detect environment mismatch
  // Sandbox tokens usually start with 'EAAA' (legacy) or 'sandbox-'
  const isSandboxToken = tokens.access_token.startsWith('EAAA') || tokens.access_token.startsWith('sandbox-');
  
  if (isProduction && isSandboxToken) {
    console.error(`[SQUARE_CLIENT] Environment Mismatch: Using Sandbox token in Production for business ${businessId}`);
    throw new Error('Environment Mismatch: Attempting to use a Sandbox token in Production. Please reconnect Square in Settings.');
  }
  if (!isProduction && !isSandboxToken) {
    console.error(`[SQUARE_CLIENT] Environment Mismatch: Using Production token in Sandbox for business ${businessId}`);
    throw new Error('Environment Mismatch: Attempting to use a Production token in Sandbox. Please reconnect Square in Settings.');
  }

  // Proactive refresh if within 5 days of expiry
  if (tokens.expires_at && new Date() > new Date(tokens.expires_at.getTime() - 5 * 24 * 60 * 60 * 1000)) {
    console.log(`[SQUARE_CLIENT] Token for business ${businessId} is near expiry. Attempting proactive refresh...`);
    
    if (!tokens.refresh_token) {
      throw new Error('Square token expired and no refresh token available. Please reconnect.');
    }

    const authClient = new SquareClient({ environment: SQUARE_ENV });
    // Use consistent env var naming
    const appId = process.env.SQUARE_APP_ID || process.env.SQUARE_APPLICATION_ID;
    const appSecret = process.env.SQUARE_APP_SECRET || process.env.SQUARE_APPLICATION_SECRET;
    
    if (!appId || !appSecret) {
      throw new Error('Square application configuration (appId / appSecret) is missing.');
    }

    try {
      const response = await authClient.oAuth.obtainToken({
        clientId: appId,
        clientSecret: appSecret,
        grantType: 'refresh_token',
        refreshToken: tokens.refresh_token,
      });

      if (!response.accessToken) {
        throw new Error('Failed to refresh Square payment token - no access token returned.');
      }

      await tokenManager.saveTokens(
        response.accessToken,
        response.refreshToken,
        response.expiresAt ? new Date(response.expiresAt) : undefined
      );

      console.log(`[SQUARE_CLIENT] Token refreshed successfully for business ${businessId}`);

      return new SquareClient({ environment: SQUARE_ENV, token: response.accessToken });
    } catch (e: any) {
      console.error(`[SQUARE_CLIENT] Refresh failed for business ${businessId}:`, e);
      // If it's a 401 during refresh, it means the refresh token is also invalid
      if (e.statusCode === 401) {
        throw new Error('Square connection has been revoked or expired. Please reconnect in settings.');
      }
      throw e;
    }
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

    const applicationId = process.env.SQUARE_APP_ID || process.env.SQUARE_APPLICATION_ID;
    if (!applicationId) {
      // Log for backend visibility but return clear error
      console.error('[SQUARE_PROVIDER] SQUARE_APP_ID is missing in environment.');
      throw new Error('Square payment configuration is incomplete (SQUARE_APP_ID missing). Please check environment variables.');
    }

    return {
      type: 'embedded',
      squareConfig: {
        appId: applicationId,
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
