/**
 * Payment Provider Resolver
 * 
 * Resolves the correct PaymentProvider for a given business based on
 * their storefront config. Defaults to Stripe if no config exists.
 */

import { prisma } from '@/lib/db';
import type { PaymentProvider, PaymentProviderType } from './types';
import { StripePaymentProvider } from './stripe_provider';
import { SquarePaymentProvider } from './square_provider';

const providers: Record<PaymentProviderType, PaymentProvider> = {
  stripe: new StripePaymentProvider(),
  square: new SquarePaymentProvider(),
};

/**
 * Get the active payment provider for a business.
 * Determined by StorefrontConfig.payment_provider (default: "stripe").
 */
export async function getPaymentProvider(businessId: string): Promise<{
  provider: PaymentProvider;
  type: PaymentProviderType;
}> {
  const config = await prisma.storefrontConfig.findUnique({
    where: { business_id: businessId },
    select: { payment_provider: true },
  });

  const type = (config?.payment_provider as PaymentProviderType) || 'stripe';
  const provider = providers[type];

  if (!provider) {
    throw new Error(`Unknown payment provider: ${type}`);
  }

  return { provider, type };
}
