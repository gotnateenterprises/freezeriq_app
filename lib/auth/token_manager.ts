import { prisma } from '@/lib/db';

export class TokenManager {
    private provider: string;
    private businessId: string;

    constructor(provider: 'square' | 'qbo' | 'meta' | 'instagram', businessId: string) {
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
