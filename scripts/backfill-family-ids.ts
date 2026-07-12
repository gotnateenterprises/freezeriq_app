/**
 * CB-1 Backfill: Bundle Family ID Pairing
 *
 * Supervised script that populates Bundle.family_id for existing bundles
 * by matching Serves-5/family bundles to their Serves-2 siblings using
 * deterministic SKU and name conventions established by BundleEditor.
 *
 * USAGE:
 *   npx tsx scripts/backfill-family-ids.ts              # dry-run (default)
 *   npx tsx scripts/backfill-family-ids.ts --apply       # write family_id values
 *   npx tsx scripts/backfill-family-ids.ts --business=ID # single business only
 *
 * MATCHING RULES (strict priority order):
 *   1. SKU match: {familySku}-S2 + serves_2 tier
 *   2. Name match: {familyName} (Serves 2) + serves_2 tier (exact, case-insensitive)
 *   3. Same catalog_id when both have one
 *   4. Active-status validation (inactive variants flagged, not auto-paired)
 *   5. Ambiguity rejection (multiple matches = flagged, never auto-paired)
 *
 * NEVER AUTO-PAIRED:
 *   - Ambiguous matches (multiple candidates)
 *   - Cross-business matches (impossible due to per-business scoping)
 *   - Cross-catalog conflicts (catalog_id mismatch)
 *   - Duplicate tier members (two serves_2 with same family)
 *   - Custom/nonstandard tiers without deterministic evidence
 *   - Conflicting existing family_id values
 *
 * OUTPUT CATEGORIES:
 *   ✅ Paired            — deterministic match found
 *   ⏭️  Already paired    — family_id already set on both
 *   ⚠️  Missing Serves 2  — no matching sibling found
 *   ⚠️  Orphan Serves 2   — serves_2 bundle with no matching family
 *   ⚠️  Ambiguous          — multiple candidates matched
 *   ⚠️  Inactive variant   — match found but sibling is inactive
 *   ⚠️  Cross-catalog      — match found but catalog_id mismatch
 *   ⚠️  Conflicting IDs    — existing family_id values disagree
 *   ℹ️  Custom tier        — nonstandard serving_tier (not paired)
 *   ⏩ Skipped            — already processed or excluded
 *
 * @module backfill-family-ids
 */

// ── Imports ─────────────────────────────────────────────────────────────────
// NOTE: This script uses direct Prisma client. Run with `npx tsx`.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Configuration ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY_MODE = args.includes('--apply');
const BUSINESS_FILTER = args.find(a => a.startsWith('--business='))?.split('=')[1] || null;

// ── Serving tier classification ─────────────────────────────────────────────

function isServes2Tier(tier: string | null | undefined): boolean {
    const t = (tier || '').toLowerCase().trim();
    return t.includes('couple') || t.includes('serves_2') || t.includes('serves 2') || t === 'serves_2';
}

function isFamilyTier(tier: string | null | undefined): boolean {
    const t = (tier || '').toLowerCase().trim();
    // Family-tier includes: family, family_size, serves_5, start_fresh, empty/default
    if (t === '' || t === 'family' || t === 'family_size' || t === 'serves_5' || t === 'start_fresh') return true;
    return false;
}

function isCustomTier(tier: string | null | undefined): boolean {
    return !isFamilyTier(tier) && !isServes2Tier(tier);
}

// ── Result tracking ─────────────────────────────────────────────────────────

interface PairResult {
    category: string;
    familyBundle: { id: string; name: string; sku: string; serving_tier: string; family_id: string | null };
    serves2Bundle?: { id: string; name: string; sku: string; serving_tier: string; family_id: string | null };
    reason?: string;
    generatedFamilyId?: string;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  CB-1 Bundle Family ID Backfill                            ║');
    console.log(`║  Mode: ${APPLY_MODE ? 'APPLY (will write)' : 'DRY RUN (read-only)'}                            ║`);
    if (BUSINESS_FILTER) {
        console.log(`║  Business: ${BUSINESS_FILTER.substring(0, 36).padEnd(36)}       ║`);
    }
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');

    // Fetch all businesses (or single one)
    const businesses = await prisma.business.findMany({
        where: BUSINESS_FILTER ? { id: BUSINESS_FILTER } : undefined,
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
    });

    if (businesses.length === 0) {
        console.log('No businesses found.');
        return;
    }

    const globalResults: PairResult[] = [];
    const globalCounts = {
        paired: 0,
        alreadyPaired: 0,
        missingServes2: 0,
        orphanServes2: 0,
        ambiguous: 0,
        inactiveVariant: 0,
        crossCatalog: 0,
        conflictingIds: 0,
        customTier: 0,
        skipped: 0,
    };

    for (const business of businesses) {
        console.log(`\n── Business: ${business.name} (${business.id}) ──`);

        // Fetch all bundles for this business
        const bundles = await prisma.bundle.findMany({
            where: { business_id: business.id },
            select: {
                id: true,
                name: true,
                sku: true,
                serving_tier: true,
                is_active: true,
                catalog_id: true,
                family_id: true,
            },
            orderBy: { name: 'asc' },
        });

        // Classify bundles
        const familyBundles = bundles.filter(b => isFamilyTier(b.serving_tier));
        const serves2Bundles = bundles.filter(b => isServes2Tier(b.serving_tier));
        const customBundles = bundles.filter(b => isCustomTier(b.serving_tier));

        console.log(`  Total: ${bundles.length} | Family: ${familyBundles.length} | Serves 2: ${serves2Bundles.length} | Custom: ${customBundles.length}`);

        // Track which serves_2 bundles have been matched (to detect orphans)
        const matchedServes2Ids = new Set<string>();

        // Process each family-tier bundle
        const businessResults: PairResult[] = [];
        const pairsToWrite: Array<{ familyId: string; serves2Id: string; generatedFamilyId: string }> = [];

        for (const family of familyBundles) {
            // Custom tier — skip with info
            if (isCustomTier(family.serving_tier)) {
                businessResults.push({
                    category: 'custom_tier',
                    familyBundle: family as any,
                    reason: `Nonstandard serving_tier: "${family.serving_tier}"`,
                });
                globalCounts.customTier++;
                continue;
            }

            // Already paired — both family and its potential match have family_id set
            if (family.family_id) {
                const existingSibling = serves2Bundles.find(
                    b => b.family_id === family.family_id && b.id !== family.id
                );
                if (existingSibling) {
                    matchedServes2Ids.add(existingSibling.id);
                    businessResults.push({
                        category: 'already_paired',
                        familyBundle: family as any,
                        serves2Bundle: existingSibling as any,
                    });
                    globalCounts.alreadyPaired++;
                    continue;
                }
                // Family has family_id but no sibling shares it — will be handled as missing serves 2
            }

            // ── Priority 1: SKU match ───────────────────────────────────
            const targetSku = `${family.sku}-S2`;
            const skuMatches = serves2Bundles.filter(
                b => b.sku === targetSku && isServes2Tier(b.serving_tier)
            );

            if (skuMatches.length > 1) {
                businessResults.push({
                    category: 'ambiguous',
                    familyBundle: family as any,
                    reason: `Multiple SKU matches for "${targetSku}": ${skuMatches.map(b => b.id).join(', ')}`,
                });
                globalCounts.ambiguous++;
                continue;
            }

            let candidate = skuMatches.length === 1 ? skuMatches[0] : null;

            // ── Priority 2: Name match (only if SKU didn't match) ───────
            if (!candidate) {
                const targetName = `${family.name} (Serves 2)`;
                const nameMatches = serves2Bundles.filter(
                    b => b.name.toLowerCase() === targetName.toLowerCase() && isServes2Tier(b.serving_tier)
                );

                if (nameMatches.length > 1) {
                    businessResults.push({
                        category: 'ambiguous',
                        familyBundle: family as any,
                        reason: `Multiple name matches for "${targetName}": ${nameMatches.map(b => b.id).join(', ')}`,
                    });
                    globalCounts.ambiguous++;
                    continue;
                }

                candidate = nameMatches.length === 1 ? nameMatches[0] : null;
            }

            // ── No match found ──────────────────────────────────────────
            if (!candidate) {
                businessResults.push({
                    category: 'missing_serves2',
                    familyBundle: family as any,
                    reason: `No matching Serves 2 found (tried SKU "${family.sku}-S2" and name "${family.name} (Serves 2)")`,
                });
                globalCounts.missingServes2++;
                continue;
            }

            // ── Validation gates ────────────────────────────────────────

            // Inactive variant check
            if (!candidate.is_active) {
                businessResults.push({
                    category: 'inactive_variant',
                    familyBundle: family as any,
                    serves2Bundle: candidate as any,
                    reason: `Serves 2 sibling "${candidate.name}" (${candidate.id}) is inactive`,
                });
                globalCounts.inactiveVariant++;
                continue;
            }

            if (!family.is_active) {
                businessResults.push({
                    category: 'inactive_variant',
                    familyBundle: family as any,
                    serves2Bundle: candidate as any,
                    reason: `Family bundle "${family.name}" (${family.id}) is inactive`,
                });
                globalCounts.inactiveVariant++;
                continue;
            }

            // Cross-catalog check
            if (family.catalog_id && candidate.catalog_id && family.catalog_id !== candidate.catalog_id) {
                businessResults.push({
                    category: 'cross_catalog',
                    familyBundle: family as any,
                    serves2Bundle: candidate as any,
                    reason: `Catalog mismatch: family="${family.catalog_id}" vs serves_2="${candidate.catalog_id}"`,
                });
                globalCounts.crossCatalog++;
                continue;
            }

            // Conflicting existing family_id check
            if (family.family_id && candidate.family_id && family.family_id !== candidate.family_id) {
                businessResults.push({
                    category: 'conflicting_ids',
                    familyBundle: family as any,
                    serves2Bundle: candidate as any,
                    reason: `Existing family_id conflict: family="${family.family_id}" vs serves_2="${candidate.family_id}"`,
                });
                globalCounts.conflictingIds++;
                continue;
            }

            // ── Match accepted ──────────────────────────────────────────
            // Use existing family_id from either side, or generate a new one
            const generatedFamilyId = family.family_id || candidate.family_id || crypto.randomUUID();

            matchedServes2Ids.add(candidate.id);
            pairsToWrite.push({
                familyId: family.id,
                serves2Id: candidate.id,
                generatedFamilyId,
            });
            businessResults.push({
                category: 'paired',
                familyBundle: family as any,
                serves2Bundle: candidate as any,
                generatedFamilyId,
            });
            globalCounts.paired++;
        }

        // ── Detect orphan Serves 2 bundles ──────────────────────────────
        for (const s2 of serves2Bundles) {
            if (!matchedServes2Ids.has(s2.id) && !s2.family_id) {
                businessResults.push({
                    category: 'orphan_serves2',
                    familyBundle: s2 as any, // Using familyBundle field for the orphan
                    reason: `Serves 2 bundle with no matching family bundle`,
                });
                globalCounts.orphanServes2++;
            }
        }

        // ── Custom tiers ────────────────────────────────────────────────
        for (const custom of customBundles) {
            businessResults.push({
                category: 'custom_tier',
                familyBundle: custom as any,
                reason: `Nonstandard serving_tier: "${custom.serving_tier}"`,
            });
            globalCounts.customTier++;
        }

        // ── Print business results ──────────────────────────────────────
        for (const r of businessResults) {
            const icon = {
                paired: '✅',
                already_paired: '⏭️ ',
                missing_serves2: '⚠️ ',
                orphan_serves2: '⚠️ ',
                ambiguous: '⚠️ ',
                inactive_variant: '⚠️ ',
                cross_catalog: '⚠️ ',
                conflicting_ids: '⚠️ ',
                custom_tier: 'ℹ️ ',
                skipped: '⏩',
            }[r.category] || '  ';

            const label = {
                paired: 'Paired',
                already_paired: 'Already paired',
                missing_serves2: 'Missing Serves 2',
                orphan_serves2: 'Orphan Serves 2',
                ambiguous: 'Ambiguous',
                inactive_variant: 'Inactive variant',
                cross_catalog: 'Cross-catalog',
                conflicting_ids: 'Conflicting IDs',
                custom_tier: 'Custom tier',
                skipped: 'Skipped',
            }[r.category] || r.category;

            const bundleInfo = `"${r.familyBundle.name}" (${r.familyBundle.sku})`;
            const siblingInfo = r.serves2Bundle ? ` ↔ "${r.serves2Bundle.name}" (${r.serves2Bundle.sku})` : '';
            const reason = r.reason ? ` — ${r.reason}` : '';
            const familyIdInfo = r.generatedFamilyId ? ` [family_id: ${r.generatedFamilyId.substring(0, 8)}...]` : '';

            console.log(`  ${icon} ${label}: ${bundleInfo}${siblingInfo}${familyIdInfo}${reason}`);
        }

        globalResults.push(...businessResults);

        // ── Apply mode: write family_id values ──────────────────────────
        if (APPLY_MODE && pairsToWrite.length > 0) {
            console.log(`\n  📝 Writing ${pairsToWrite.length} pair(s)...`);

            await prisma.$transaction(async (tx) => {
                for (const pair of pairsToWrite) {
                    await tx.bundle.update({
                        where: { id: pair.familyId },
                        data: { family_id: pair.generatedFamilyId },
                    });
                    await tx.bundle.update({
                        where: { id: pair.serves2Id },
                        data: { family_id: pair.generatedFamilyId },
                    });
                }
            });

            console.log(`  ✅ ${pairsToWrite.length} pair(s) written for ${business.name}`);
        } else if (pairsToWrite.length > 0) {
            console.log(`\n  ℹ️  ${pairsToWrite.length} pair(s) would be written (dry-run mode — use --apply to write)`);
        }
    }

    // ── Global summary ──────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Summary                                                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`  ✅ Paired:            ${globalCounts.paired}`);
    console.log(`  ⏭️  Already paired:    ${globalCounts.alreadyPaired}`);
    console.log(`  ⚠️  Missing Serves 2:  ${globalCounts.missingServes2}`);
    console.log(`  ⚠️  Orphan Serves 2:   ${globalCounts.orphanServes2}`);
    console.log(`  ⚠️  Ambiguous:         ${globalCounts.ambiguous}`);
    console.log(`  ⚠️  Inactive variant:  ${globalCounts.inactiveVariant}`);
    console.log(`  ⚠️  Cross-catalog:     ${globalCounts.crossCatalog}`);
    console.log(`  ⚠️  Conflicting IDs:   ${globalCounts.conflictingIds}`);
    console.log(`  ℹ️  Custom tier:       ${globalCounts.customTier}`);
    console.log(`  ⏩ Skipped:           ${globalCounts.skipped}`);
    console.log(`\n  Total businesses:     ${businesses.length}`);
    console.log(`  Total results:        ${globalResults.length}`);
    console.log(`  Mode:                 ${APPLY_MODE ? 'APPLY (changes written)' : 'DRY RUN (no changes)'}`);

    if (!APPLY_MODE && globalCounts.paired > 0) {
        console.log(`\n  👉 Run with --apply to write ${globalCounts.paired} pair(s)`);
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error('Fatal error:', e);
    await prisma.$disconnect();
    process.exit(1);
});
