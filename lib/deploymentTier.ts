/**
 * PREVIEW-DB-ISOLATION-1 — the ONE answer to "which deployment is this process?"
 *
 * Moved here unchanged from lib/quickbooks/config.ts (QB-INVOICE-1A), which
 * re-exports it, so every existing caller and test keeps working. Every
 * environment-dependent safety rule asks this module — QuickBooks, the Preview
 * email redirect (lib/emailSafety.ts) and the Preview media prefix (lib/s3.ts).
 * Nothing else in the application reads VERCEL_ENV.
 *
 * It answers from the DEPLOYMENT, never from anything in a request.
 */

export type DeploymentTier = 'local' | 'preview' | 'production' | 'unknown';

/**
 * Which deployment this process is. VERCEL_ENV is set by Vercel on every
 * deployment; its absence on a Vercel host is treated as unknown, not as local.
 */
export function deploymentTier(env: NodeJS.ProcessEnv = process.env): DeploymentTier {
    const vercelEnv = env.VERCEL_ENV;
    if (vercelEnv === 'preview') return 'preview';
    if (vercelEnv === 'production') return 'production';
    if (vercelEnv === 'development') return 'local'; // `vercel dev` on a developer machine
    if (vercelEnv) return 'unknown';
    if (env.VERCEL) return 'unknown';
    if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return 'local';
    return 'unknown';
}

/**
 * The tiers the Preview-only safety rules apply to: Vercel Preview, and any
 * runtime this module cannot identify — so an unrecognised runtime fails
 * toward "not Production", never toward live side effects. Production and
 * local development are left exactly as they were.
 */
export function isPreviewSafetyTier(tier: DeploymentTier): boolean {
    return tier === 'preview' || tier === 'unknown';
}
