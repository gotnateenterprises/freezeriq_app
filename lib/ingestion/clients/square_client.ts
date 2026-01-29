import { SquareClient, SquareEnvironment } from 'square';
import { TokenManager } from '@/lib/auth/token_manager';

export class SquareWrapper {
    private tokenManager: TokenManager;

    constructor() {
        this.tokenManager = new TokenManager('square');
    }

    async getClient(): Promise<SquareClient> {
        const tokens = await this.tokenManager.getTokens();

        if (!tokens || !tokens.access_token) {
            throw new Error("Square integration not connected");
        }

        // Check for expiry (buffer of 5 minutes)
        if (tokens.expires_at && new Date() > new Date(tokens.expires_at.getTime() - 5 * 60000)) {
            console.log("Square token expired by date. Refreshing...");
            return await this.refreshTokens(tokens.refresh_token);
        }

        // Try to return client. If it fails later, we might need to handle 401s in the wrapper, 
        // but for now let's ensure we don't pass null.
        if (!tokens.access_token) {
            // Try refreshing if we have a refresh token but no access token (edge case)
            if (tokens.refresh_token) {
                console.log("No access token but found refresh token. Refreshing...");
                return await this.refreshTokens(tokens.refresh_token);
            }
            throw new Error("Square integration connected but no access token found. Please reconnect.");
        }

        return new SquareClient({
            environment: process.env.SQUARE_ENVIRONMENT === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
            token: tokens.access_token
        });
    }

    private async refreshTokens(refreshToken?: string | null): Promise<SquareClient> {
        if (!refreshToken) {
            throw new Error("No refresh token available for Square");
        }

        console.log("Refreshing Square Access Token...");

        // Create a temporary client just for auth
        const authClient = new SquareClient({
            environment: process.env.SQUARE_ENVIRONMENT === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
        });

        try {
            const response = await authClient.oAuth.obtainToken({
                clientId: process.env.SQUARE_APP_ID!,
                clientSecret: process.env.SQUARE_APP_SECRET!,
                grantType: 'refresh_token',
                refreshToken: refreshToken
            });

            // Handle flat result structure in SDK v44+
            const { accessToken, refreshToken: newRefreshToken, expiresAt } = response;

            if (!accessToken) throw new Error("Failed to refresh Square token - No access token returned");

            await this.tokenManager.saveTokens(
                accessToken,
                newRefreshToken,
                expiresAt ? new Date(expiresAt) : undefined
            );

            console.log("Square Token Refreshed Successfully.");

            return new SquareClient({
                environment: process.env.SQUARE_ENVIRONMENT === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
                token: accessToken
            });

        } catch (e: any) {
            console.error("Square Refresh Error:", e);
            // If refresh fails, we probably need to re-auth
            throw new Error(`Failed to refresh Square connection: ${JSON.stringify(e)}`);
        }
    }
}
