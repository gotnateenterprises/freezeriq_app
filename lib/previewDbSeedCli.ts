/**
 * PREVIEW-DB-ISOLATION-1 — seed (or reset and reseed) the PREVIEW database with
 * the fake fixtures in lib/previewFixtures.ts.
 *
 *   npx tsx lib/previewDbSeedCli.ts [--reset] --credentials-out <file outside this repository>
 *
 * The Preview connection strings are given as DATABASE_URL and DIRECT_URL in
 * the calling process only — see docs/ai/PREVIEW_ENVIRONMENT.md. This script
 * loads no .env file, and lib/previewFixtures.ts refuses the Production host and
 * any database that holds a non-fixture business or user.
 *
 * Nothing secret is printed. The generated Preview admin password and the
 * coordinator portal paths are written only to --credentials-out.
 *
 * Like lib/dbSafetyCli.ts, this CLI lives in lib/ because .gitignore excludes
 * /scripts entirely.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PREVIEW_NAMES, PREVIEW_TENANT_SLUG, seedPreviewFixtures, type PreviewSeedResult } from './previewFixtures';

function fail(message: string): never {
    console.error(`preview seed: ${message}`);
    process.exit(1);
}

/** The credentials file body. Paths only — they work on any Preview deployment built after the cutover. */
export function previewCredentialsText(result: PreviewSeedResult, adminPassword: string, generatedAt: Date): string {
    return [
        'FreezerIQ PREVIEW test access - FAKE tenant, Preview database only. Not valid in Production.',
        `Generated: ${generatedAt.toISOString()}`,
        '',
        `Tenant: ${PREVIEW_NAMES.tenant} (slug ${result.slug})`,
        `Admin sign-in email: ${result.adminEmail}`,
        `Admin sign-in password: ${adminPassword}`,
        '',
        'Append these paths to a Preview deployment URL:',
        `  Supporter ordering page (${PREVIEW_NAMES.activeCampaign}): /shop/${result.slug}/fundraiser/${result.activeCampaignId}`,
        `  Coordinator portal (${PREVIEW_NAMES.activeCampaign}): /coordinator/${result.activePortalToken}`,
        `  Coordinator portal (${PREVIEW_NAMES.closedCampaign}): /coordinator/${result.closedPortalToken}`,
        '',
    ].join('\n');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const reset = args.includes('--reset');
    const outIndex = args.indexOf('--credentials-out');
    const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
    if (!out) fail('--credentials-out <file> is required (a path OUTSIDE this repository)');

    const outPath = path.resolve(out);
    const repoRoot = path.resolve(__dirname, '..');
    if (outPath === repoRoot || outPath.startsWith(repoRoot + path.sep)) {
        fail('--credentials-out must be outside this repository, so the password can never be committed');
    }
    if (!process.env.DATABASE_URL || !process.env.DIRECT_URL) {
        fail('set DATABASE_URL and DIRECT_URL to the PREVIEW database in this process first');
    }

    const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    const adminPassword = randomBytes(18).toString('base64url');
    try {
        const result = await seedPreviewFixtures(prisma, { env: process.env, today: new Date(), reset, adminPassword });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, previewCredentialsText(result, adminPassword, new Date()), { mode: 0o600 });
        console.log(`Preview fixtures seeded: tenant ${PREVIEW_TENANT_SLUG}, ${Object.keys(result.orderIds).length} supporter orders, closed campaign settled at $${result.closedSettlementTotal.toFixed(2)}.`);
        console.log(`Sign-in details and coordinator links written to ${outPath}`);
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
