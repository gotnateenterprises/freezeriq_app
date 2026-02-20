import QuickBooks from 'node-quickbooks';
import OAuthClient from 'intuit-oauth';
import { TokenManager } from '@/lib/auth/token_manager';

export class QBOWrapper {
    private tokenManager: TokenManager;

    constructor(businessId: string) {
        this.tokenManager = new TokenManager('qbo', businessId);
    }

    async getClient(): Promise<any> {
        const tokens = await this.tokenManager.getTokens();

        if (!tokens || !tokens.access_token || !tokens.realm_id) {
            throw new Error("QuickBooks integration not connected");
        }

        // Check for expiry (buffer of 5 minutes)
        if (tokens.expires_at && new Date() > new Date(tokens.expires_at.getTime() - 5 * 60000)) {
            console.log("QBO token expired. Refreshing...");
            return await this.refreshTokens(tokens.refresh_token, tokens.realm_id);
        }

        return this.createQBOInstance(tokens.access_token, tokens.realm_id, tokens.refresh_token);
    }

    private createQBOInstance(accessToken: string, realmId: string, refreshToken?: string | null) {
        return new QuickBooks(
            process.env.QBO_CLIENT_ID,
            process.env.QBO_CLIENT_SECRET,
            accessToken,
            false, // no token secret for OAuth 2.0
            realmId,
            process.env.QBO_ENVIRONMENT !== 'production', // useSandbox
            false, // debug
            null, // minorversion
            '2.0', // oauth version
            refreshToken
        );
    }

    private async refreshTokens(refreshToken: string | null | undefined, realmId: string): Promise<any> {
        if (!refreshToken) {
            throw new Error("No refresh token available for QBO");
        }

        const oauthClient = new OAuthClient({
            clientId: process.env.QBO_CLIENT_ID,
            clientSecret: process.env.QBO_CLIENT_SECRET,
            environment: process.env.QBO_ENVIRONMENT || 'sandbox',
            redirectUri: 'http://localhost:3000/api/auth/qbo/callback', // Not used for refresh but required in constructor
        });

        try {
            const authResponse = await oauthClient.refreshUsingToken(refreshToken);
            const tokenData = authResponse.getJson();

            await this.tokenManager.saveTokens(
                tokenData.access_token,
                tokenData.refresh_token,
                new Date(Date.now() + (tokenData.expires_in * 1000)),
                realmId
            );

            return this.createQBOInstance(tokenData.access_token, realmId, tokenData.refresh_token);

        } catch (e) {
            console.error("QBO Refresh Error:", e);
            throw new Error("Failed to refresh QBO connection. Please reconnect.");
        }
    }
}
