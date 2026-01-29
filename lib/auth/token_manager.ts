import { prisma } from '@/lib/db';

export class TokenManager {
    private provider: string;

    constructor(provider: 'square' | 'qbo' | 'meta') {
        this.provider = provider;
    }

    async saveTokens(accessToken: string, refreshToken?: string, expiresAt?: Date, realmId?: string) {
        await prisma.integration.upsert({
            where: { provider: this.provider },
            update: {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_at: expiresAt,
                realm_id: realmId,
                updated_at: new Date()
            },
            create: {
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
            where: { provider: this.provider }
        });
    }

    // Placeholder for future encryption
    private encrypt(text: string) { return text; }
    private decrypt(text: string) { return text; }
}
