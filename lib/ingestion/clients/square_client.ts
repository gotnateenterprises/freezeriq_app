import { SquareClient } from 'square';
import { getSquarePaymentClient } from '@/lib/payments/square_provider';

/**
 * Legacy wrapper for SquareClient used in ingestion handlers.
 * Refactored to use the unified getSquarePaymentClient from square_provider.ts.
 */
export class SquareWrapper {
    constructor(private businessId: string) {}

    /**
     * Get an authenticated Square client.
     * Delegates to the central payment provider logic which handles tokens and environments.
     */
    async getClient(): Promise<SquareClient> {
        return await getSquarePaymentClient(this.businessId);
    }
}
