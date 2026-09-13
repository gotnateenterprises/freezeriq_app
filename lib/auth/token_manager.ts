import { prisma } from '@/lib/db';

export class TokenManager {
    private provider: string;
    private businessId: string;

    // 'qbo' was removed in QB-INVOICE-1A: this class stores plaintext, and
    // QuickBooks credentials now go through lib/quickbooks/connection.ts, which
    // encrypts them. Keeping the literal out of the union makes a plaintext
    // QuickBooks write a compile error.
    constructor(provider: 'square' | 'meta' | 'instagram', businessId: string) {
        this.provider = provider;
        this.businessId = businessId;
    }

    async saveTokens(accessToken: string, refreshToken?: string, expiresAt?: Date, realmId?: string) {
        await prisma.integration.upsert({
            where: {
                business_id_provider: {
                    business_id: this.businessId,
                    provider: this.provider
                }
            },
            update: {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_at: expiresAt,
                realm_id: realmId,
                updated_at: new Date()
            },
            create: {
                business_id: this.businessId,
                provider: this.provider,
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_at: expiresAt,
                realm_id: realmId
            }
        });
    }

    async getTokens() {
        return await prisma.integration.findUnique({
            where: {
                business_id_provider: {
                    business_id: this.businessId,
                    provider: this.provider
                }
            }
        });
    }

    // Placeholder for future encryption
    private encrypt(text: string) { return text; }
    private decrypt(text: string) { return text; }
}
