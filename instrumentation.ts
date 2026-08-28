/**
 * DEV-ENV-SAFETY-1. Next.js calls `register()` once, when the server
 * process starts — for `next dev`, `next start`, and every deployed Vercel
 * runtime. It is never called during `next build`, so this cannot affect
 * the build step.
 *
 * The guard itself is a no-op outside `NODE_ENV === 'development'`, so
 * Preview and Production deployments (NODE_ENV === 'production') are
 * unaffected. See lib/devEnvGuard.ts.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { assertNotDevelopmentAgainstProduction } = await import('@/lib/devEnvGuard');
        assertNotDevelopmentAgainstProduction();
    }
}
