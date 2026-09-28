/**
 * PREVIEW-DB-ISOLATION-1 — the FAKE data the Preview database is seeded with.
 *
 * Every name starts "Preview Test" / "Preview", every email address is a Resend
 * test-sink address (delivered+<label>@resend.dev — accepted, delivered nowhere),
 * every phone number is a fictional 555-01xx number, and every id is a fixed,
 * recognisable 7e57xxxx-… value. Nothing here is, or is derived from, a real
 * person, organization or order.
 *
 * The rows mirror what the real application writes, using the same shared
 * rules: supporter orders take the public order route's shape (fundraiser_hold,
 * server-priced lines, first/last name); the closed campaign is closed the way
 * app/api/campaigns/[id]/closeout/route.ts closes one (claim + ONE draft invoice,
 * money from lib/fundraiserCloseoutMath.ts); coordinator portal tokens come from
 * lib/coordinatorPortalToken.ts.
 *
 * SAFETY: seedPreviewFixtures() refuses to touch a database unless
 * assertPreviewSeedTarget() passes — explicit URLs, not the Production host, and
 * a database that holds nothing but these fixtures. See docs/ai/PREVIEW_ENVIRONMENT.md.
 */
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { findProductionTargets } from '@/lib/devEnvGuard';
import { mintCoordinatorPortalToken } from '@/lib/coordinatorPortalToken';
import {
    aggregateBundleLines,
    assertLinesReconcile,
    computeCloseoutFinancials,
    FOOD_TAX_DEFAULT_APPLIED,
    roundCents,
} from '@/lib/fundraiserCloseoutMath';
import { resolveCloseoutTaxRate } from '@/lib/fundraiserTax';
import { purchaserDisplayName } from '@/lib/purchaserName';

export const PREVIEW_TENANT_SLUG = 'preview-test-tenant';
/** Every business in a seedable database must carry this slug prefix. */
export const PREVIEW_SLUG_PREFIX = 'preview-test';
/** Every user in a seedable database must have an address on this domain. */
export const PREVIEW_EMAIL_DOMAIN = 'resend.dev';

/** A Resend test-sink address with a readable label, e.g. delivered+preview-admin@resend.dev */
export function previewFixtureEmail(label: string): string {
    return `delivered+${label}@${PREVIEW_EMAIL_DOMAIN}`;
}

const id = (prefix: string, n: number) => `7e57${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const PREVIEW_IDS = {
    business: id('b000', 1),
    adminUser: id('a000', 1),
    organization: id('c000', 1),
    coordinatorContact: id('c0c0', 1),
    coordinatorEmailPoint: id('c0c0', 101),
    coordinatorOrgContact: id('c0c0', 201),
    activeCampaign: id('f000', 10),
    closedCampaign: id('f000', 12),
    closedInvoice: id('1000', 12),
    familyComfort: id('fa00', 10),
    familyWeeknight: id('fa00', 11),
    bundleComfort5: id('d000', 105),
    bundleComfort2: id('d000', 102),
    bundleWeeknight5: id('d000', 115),
    bundleWeeknight2: id('d000', 112),
} as const;

export const PREVIEW_NAMES = {
    tenant: 'Preview Test Tenant',
    organization: 'Preview Test Organization',
    coordinator: 'Preview Test Coordinator',
    admin: 'Preview Test Admin',
    activeCampaign: 'Preview Test Active Fundraiser',
    closedCampaign: 'Preview Test Closed Fundraiser',
} as const;

/** Serves 5 is sold as the "family" tier, exactly as Production's bundles are. */
const SERVES_5_TIER = 'family';
const SERVES_2_TIER = 'serves_2';
const PRICE_SERVES_5 = 125;
const PRICE_SERVES_2 = 70;

export interface PreviewBundleSpec {
    id: string;
    name: string;
    sku: string;
    familyId: string;
    servingTier: typeof SERVES_5_TIER | typeof SERVES_2_TIER;
    variantSize: 'serves_5' | 'serves_2';
    price: number;
    recipeNames: string[];
}

export const PREVIEW_BUNDLES: PreviewBundleSpec[] = [
    { id: PREVIEW_IDS.bundleComfort5, name: 'Preview Test Comfort Classics (Serves 5)', sku: 'PREVIEW-TEST-CC-S5', familyId: PREVIEW_IDS.familyComfort, servingTier: SERVES_5_TIER, variantSize: 'serves_5', price: PRICE_SERVES_5, recipeNames: ['Preview Test Baked Ziti', 'Preview Test Chicken Enchiladas'] },
    { id: PREVIEW_IDS.bundleComfort2, name: 'Preview Test Comfort Classics (Serves 2)', sku: 'PREVIEW-TEST-CC-S2', familyId: PREVIEW_IDS.familyComfort, servingTier: SERVES_2_TIER, variantSize: 'serves_2', price: PRICE_SERVES_2, recipeNames: ['Preview Test Baked Ziti', 'Preview Test Chicken Enchiladas'] },
    { id: PREVIEW_IDS.bundleWeeknight5, name: 'Preview Test Weeknight Favorites (Serves 5)', sku: 'PREVIEW-TEST-WF-S5', familyId: PREVIEW_IDS.familyWeeknight, servingTier: SERVES_5_TIER, variantSize: 'serves_5', price: PRICE_SERVES_5, recipeNames: ['Preview Test Beef Stew', 'Preview Test Veggie Chili'] },
    { id: PREVIEW_IDS.bundleWeeknight2, name: 'Preview Test Weeknight Favorites (Serves 2)', sku: 'PREVIEW-TEST-WF-S2', familyId: PREVIEW_IDS.familyWeeknight, servingTier: SERVES_2_TIER, variantSize: 'serves_2', price: PRICE_SERVES_2, recipeNames: ['Preview Test Beef Stew', 'Preview Test Veggie Chili'] },
];

export const PREVIEW_RECIPE_NAMES = ['Preview Test Baked Ziti', 'Preview Test Chicken Enchiladas', 'Preview Test Beef Stew', 'Preview Test Veggie Chili'];

export interface PreviewOrderSpec {
    key: string;
    campaign: 'active' | 'closed';
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    participantName: string | null;
    daysAgo: number;
    lines: Array<{ bundleId: string; quantity: number }>;
}

/** Weighted progress on the active campaign: 1 + 2 x 0.5 + 2 = 4.0 bundles. */
export const PREVIEW_ORDERS: PreviewOrderSpec[] = [
    { key: 'a', campaign: 'active', firstName: 'Preview', lastName: 'Supporter A', email: previewFixtureEmail('preview-supporter-a'), phone: '555-0101', participantName: null, daysAgo: 5, lines: [{ bundleId: PREVIEW_IDS.bundleComfort5, quantity: 1 }] },
    { key: 'b', campaign: 'active', firstName: 'Preview', lastName: 'Supporter B', email: previewFixtureEmail('preview-supporter-b'), phone: '555-0102', participantName: null, daysAgo: 4, lines: [{ bundleId: PREVIEW_IDS.bundleWeeknight2, quantity: 2 }] },
    { key: 'c', campaign: 'active', firstName: 'Preview', lastName: 'Supporter C', email: previewFixtureEmail('preview-supporter-c'), phone: '555-0103', participantName: 'Preview Seller One', daysAgo: 2, lines: [{ bundleId: PREVIEW_IDS.bundleComfort5, quantity: 1 }, { bundleId: PREVIEW_IDS.bundleWeeknight5, quantity: 1 }] },
    { key: 'd', campaign: 'closed', firstName: 'Preview', lastName: 'Supporter D', email: previewFixtureEmail('preview-supporter-d'), phone: '555-0104', participantName: null, daysAgo: 45, lines: [{ bundleId: PREVIEW_IDS.bundleComfort5, quantity: 2 }] },
    { key: 'e', campaign: 'closed', firstName: 'Preview', lastName: 'Supporter E', email: previewFixtureEmail('preview-supporter-e'), phone: '555-0105', participantName: null, daysAgo: 40, lines: [{ bundleId: PREVIEW_IDS.bundleComfort2, quantity: 1 }, { bundleId: PREVIEW_IDS.bundleWeeknight2, quantity: 1 }] },
];

/** A calendar day (for @db.Date columns), `offset` days from `today`, at UTC midnight. */
export function calendarDay(today: Date, offset: number): Date {
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
}

export function previewCampaignDates(today: Date) {
    return {
        active: { start: calendarDay(today, -7), end: calendarDay(today, 30), delivery: calendarDay(today, 40) },
        closed: { start: calendarDay(today, -60), end: calendarDay(today, -20), delivery: calendarDay(today, -10), closedAt: calendarDay(today, -19) },
    };
}

// ── Target guard ────────────────────────────────────────────────────────────

export class PreviewSeedRefusedError extends Error {
    constructor(message: string) {
        super(`Refusing to seed: ${message}`);
        Object.setPrototypeOf(this, PreviewSeedRefusedError.prototype);
        this.name = 'PreviewSeedRefusedError';
    }
}

/**
 * Throws unless the target is provably a Preview database:
 *   1. DATABASE_URL and DIRECT_URL are both given explicitly;
 *   2. neither resolves to the Production database host (lib/devEnvGuard.ts);
 *   3. the database holds no business outside the preview-test slug prefix
 *      and no user outside the Resend test domain — i.e. nothing real.
 * (3) is the decisive check: it holds for an empty or fixture-only database
 * and fails for any database that has ever held a real tenant.
 */
export function assertPreviewSeedTarget(input: {
    env: NodeJS.ProcessEnv;
    existingBusinessSlugs: string[];
    existingUserEmails: string[];
}): void {
    const { env } = input;
    if (!env.DATABASE_URL || !env.DIRECT_URL) {
        throw new PreviewSeedRefusedError('DATABASE_URL and DIRECT_URL must both be set explicitly for this process');
    }
    const dbHits = findProductionTargets(env).filter((h) => h.variable === 'DATABASE_URL' || h.variable === 'DIRECT_URL');
    if (dbHits.length > 0) {
        throw new PreviewSeedRefusedError(`${dbHits.map((h) => h.variable).join(' and ')} target the Production database host`);
    }
    const foreignBusinesses = input.existingBusinessSlugs.filter((s) => !s.startsWith(PREVIEW_SLUG_PREFIX));
    if (foreignBusinesses.length > 0) {
        throw new PreviewSeedRefusedError(`the database holds ${foreignBusinesses.length} business(es) that are not Preview fixtures`);
    }
    const foreignUsers = input.existingUserEmails.filter((e) => !e.toLowerCase().endsWith(`@${PREVIEW_EMAIL_DOMAIN}`));
    if (foreignUsers.length > 0) {
        throw new PreviewSeedRefusedError(`the database holds ${foreignUsers.length} user(s) that are not Preview fixtures`);
    }
}

// ── Seeding ─────────────────────────────────────────────────────────────────

export interface PreviewSeedResult {
    businessId: string;
    slug: string;
    adminEmail: string;
    activeCampaignId: string;
    closedCampaignId: string;
    activePortalToken: string;
    closedPortalToken: string;
    orderIds: Record<string, string>;
    closedInvoiceId: string;
    closedSettlementTotal: number;
}

async function wipeApplicationTables(prisma: PrismaClient): Promise<void> {
    const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
    );
    if (rows.length === 0) return;
    const list = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Seeds the fixtures. `reset` wipes every application table first (the guard
 * has already proven there is nothing real to wipe). Without `reset`, an
 * already-seeded database is refused rather than half-duplicated.
 */
export async function seedPreviewFixtures(
    prisma: PrismaClient,
    options: { env: NodeJS.ProcessEnv; today: Date; reset: boolean; adminPassword: string }
): Promise<PreviewSeedResult> {
    if (!options.adminPassword || options.adminPassword.length < 12) {
        throw new PreviewSeedRefusedError('an admin password of at least 12 characters is required');
    }

    const businesses = await prisma.business.findMany({ select: { slug: true } });
    const users = await prisma.user.findMany({ select: { email: true } });
    assertPreviewSeedTarget({
        env: options.env,
        existingBusinessSlugs: businesses.map((b) => b.slug),
        existingUserEmails: users.map((u) => u.email),
    });

    if (options.reset) {
        await wipeApplicationTables(prisma);
    } else if (businesses.length > 0) {
        throw new PreviewSeedRefusedError('the Preview database is already seeded; run with --reset to rebuild it');
    }

    const dates = previewCampaignDates(options.today);
    const now = options.today;
    const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
    const passwordHash = await bcrypt.hash(options.adminPassword, 10);
    const activePortalToken = mintCoordinatorPortalToken();
    const closedPortalToken = mintCoordinatorPortalToken();
    const coordinatorEmail = previewFixtureEmail('preview-coordinator');
    const bundleById = new Map(PREVIEW_BUNDLES.map((b) => [b.id, b]));

    return prisma.$transaction(async (tx) => {
        // Tenant, its admin, and its storefront.
        await tx.business.create({
            data: {
                id: PREVIEW_IDS.business,
                name: PREVIEW_NAMES.tenant,
                display_name: PREVIEW_NAMES.tenant,
                slug: PREVIEW_TENANT_SLUG,
                contact_email: previewFixtureEmail('preview-tenant'),
                timezone: 'America/Chicago',
                plan: 'ULTIMATE',
                subscription_status: 'active',
            },
        });
        await tx.user.create({
            data: {
                id: PREVIEW_IDS.adminUser,
                email: previewFixtureEmail('preview-admin'),
                password: passwordHash,
                name: PREVIEW_NAMES.admin,
                firstName: 'Preview',
                lastName: 'Admin',
                role: 'ADMIN',
                business_id: PREVIEW_IDS.business,
            },
        });
        await tx.storefrontConfig.create({ data: { business_id: PREVIEW_IDS.business } });

        // Menu: four recipes, two bundle families of Serves 5 + Serves 2.
        const recipeIds = new Map<string, string>();
        for (const [i, name] of PREVIEW_RECIPE_NAMES.entries()) {
            const recipeId = id('e000', i + 1);
            recipeIds.set(name, recipeId);
            await tx.recipe.create({
                data: {
                    id: recipeId, name, type: 'menu_item', base_yield_qty: 5, base_yield_unit: 'servings',
                    business_id: PREVIEW_IDS.business, description: 'Fake recipe for Preview testing only.',
                },
            });
        }
        for (const b of PREVIEW_BUNDLES) {
            await tx.bundle.create({
                data: {
                    id: b.id, name: b.name, sku: b.sku, serving_tier: b.servingTier, family_id: b.familyId,
                    price: b.price, is_active: true, show_on_storefront: true, business_id: PREVIEW_IDS.business,
                    description: 'Fake bundle for Preview testing only.',
                },
            });
            for (const [position, recipeName] of b.recipeNames.entries()) {
                await tx.bundleContent.create({
                    data: { bundle_id: b.id, recipe_id: recipeIds.get(recipeName)!, position, quantity: 1 },
                });
            }
        }

        // The organization and its coordinator (contact + email point + relationship).
        await tx.customer.create({
            data: {
                id: PREVIEW_IDS.organization,
                business_id: PREVIEW_IDS.business,
                name: PREVIEW_NAMES.organization,
                contact_name: PREVIEW_NAMES.coordinator,
                contact_email: coordinatorEmail,
                contact_phone: '555-0100',
                type: 'fundraiser_org',
                source: 'Preview Fixture',
                status: 'ACTIVE',
            },
        });
        await tx.fundraiserContact.create({
            data: {
                id: PREVIEW_IDS.coordinatorContact, business_id: PREVIEW_IDS.business,
                display_name: PREVIEW_NAMES.coordinator, identity_status: 'confirmed', source: 'tenant',
            },
        });
        await tx.fundraiserContactPoint.create({
            data: {
                id: PREVIEW_IDS.coordinatorEmailPoint, business_id: PREVIEW_IDS.business,
                contact_id: PREVIEW_IDS.coordinatorContact, type: 'email', label: 'work',
                value: coordinatorEmail, normalized_value: coordinatorEmail.toLowerCase(),
                is_primary: true, is_current: true, source: 'tenant',
            },
        });
        await tx.fundraiserOrganizationContact.create({
            data: {
                id: PREVIEW_IDS.coordinatorOrgContact, business_id: PREVIEW_IDS.business,
                contact_id: PREVIEW_IDS.coordinatorContact, customer_id: PREVIEW_IDS.organization,
                role: 'coordinator', is_primary_relationship: true, source: 'tenant',
            },
        });

        // Two campaigns, both with the modern two-family selected menu.
        const campaignCommon = {
            customer_id: PREVIEW_IDS.organization,
            status: 'Active',
            pickup_location: 'Preview Test Pickup - 100 Example Avenue, Springfield',
            checks_payable: PREVIEW_NAMES.organization,
            payment_instructions: 'PREVIEW TEST ONLY - no payment is collected for this fake fundraiser.',
            bundle_goal: 20,
            bundle_selection_status: 'selected',
            bundle_selection_limit: 2,
            tax_status: 'TAX_EXEMPT' as const,
            tax_rate_percent: 0,
            org_share_percent: 20,
        };
        await tx.fundraiserCampaign.create({
            data: {
                ...campaignCommon, id: PREVIEW_IDS.activeCampaign, name: PREVIEW_NAMES.activeCampaign,
                start_date: dates.active.start, end_date: dates.active.end, delivery_date: dates.active.delivery,
                delivery_time: '9:00 AM', bundle_selection_at: daysAgo(7), portal_token: activePortalToken,
            },
        });
        await tx.fundraiserCampaign.create({
            data: {
                ...campaignCommon, id: PREVIEW_IDS.closedCampaign, name: PREVIEW_NAMES.closedCampaign,
                start_date: dates.closed.start, end_date: dates.closed.end, delivery_date: dates.closed.delivery,
                delivery_time: '4:00 PM', bundle_selection_at: daysAgo(60), portal_token: closedPortalToken,
            },
        });
        for (const campaignId of [PREVIEW_IDS.activeCampaign, PREVIEW_IDS.closedCampaign]) {
            for (const [position, b] of PREVIEW_BUNDLES.entries()) {
                await tx.campaignBundle.create({ data: { campaign_id: campaignId, bundle_id: b.id, position, state: 'active' } });
            }
            await tx.fundraiserCampaignCoordinator.create({
                data: { campaign_id: campaignId, customer_id: PREVIEW_IDS.organization, org_contact_id: PREVIEW_IDS.coordinatorOrgContact },
            });
        }

        // Supporter orders, in the public order route's shape.
        const orderIds: Record<string, string> = {};
        for (const [i, o] of PREVIEW_ORDERS.entries()) {
            const campaignId = o.campaign === 'active' ? PREVIEW_IDS.activeCampaign : PREVIEW_IDS.closedCampaign;
            const campaignName = o.campaign === 'active' ? PREVIEW_NAMES.activeCampaign : PREVIEW_NAMES.closedCampaign;
            const name = purchaserDisplayName(o.firstName, o.lastName);
            const supporter = await tx.customer.create({
                data: {
                    id: id('5000', i + 1), business_id: PREVIEW_IDS.business, name,
                    contact_email: o.email, contact_phone: o.phone, type: 'direct_customer', status: 'LEAD',
                    source: 'Fundraiser', notes: `Created via Fundraiser Order. Campaign: ${campaignName}`,
                    external_id: `sf_preview_${o.key}`,
                },
            });
            const lines = o.lines.map((l) => {
                const b = bundleById.get(l.bundleId)!;
                return { bundle_id: b.id, quantity: l.quantity, variant_size: b.variantSize, item_name: b.name, unit_price: b.price };
            });
            const total = roundCents(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0));
            const orderId = id('0000', i + 1);
            orderIds[o.key] = orderId;
            await tx.order.create({
                data: {
                    id: orderId, business_id: PREVIEW_IDS.business, customer_id: supporter.id, campaign_id: campaignId,
                    customer_name: name, first_name: o.firstName, last_name: o.lastName, phone: o.phone, email: o.email,
                    participant_name: o.participantName, source: 'fundraiser', status: 'fundraiser_hold',
                    total_amount: total, tax_amount: 0, external_id: `ord_preview_${o.key}`, created_at: daysAgo(o.daysAgo),
                    items: { create: lines },
                },
            });
        }

        // Close the closed campaign exactly as the closeout route does:
        // gross from its non-canceled orders, one line per bundle + size, the
        // shared money model, the claim, and ONE draft invoice.
        const closedOrders = await tx.order.findMany({
            where: { campaign_id: PREVIEW_IDS.closedCampaign, canceled_at: null },
            select: {
                id: true, total_amount: true, tax_amount: true,
                items: { select: { bundle_id: true, quantity: true, unit_price: true, variant_size: true, item_name: true, bundle: { select: { name: true } } } },
            },
        });
        const settlementTotal = roundCents(closedOrders.reduce((s, o) => s + Number(o.total_amount || 0), 0));
        const taxCollected = roundCents(closedOrders.reduce((s, o) => s + (Number(o.tax_amount) || 0), 0));
        const closeoutLines = aggregateBundleLines(closedOrders.flatMap((o) => o.items.map((it) => ({
            bundleId: it.bundle_id ?? null,
            description: it.bundle?.name || it.item_name || '(unnamed bundle)',
            variantSize: (it.variant_size as string | null) ?? null,
            quantity: Number(it.quantity) || 0,
            unitPrice: Number(it.unit_price ?? 0),
        }))));
        assertLinesReconcile(closeoutLines, settlementTotal);
        const financials = computeCloseoutFinancials({
            grossSales: settlementTotal,
            orgSharePercent: campaignCommon.org_share_percent,
            applyFoodTax: FOOD_TAX_DEFAULT_APPLIED,
            taxCollected,
            taxRatePercent: resolveCloseoutTaxRate({ taxStatus: campaignCommon.tax_status, taxRatePercent: campaignCommon.tax_rate_percent }),
        });
        await tx.fundraiserCampaign.update({
            where: { id: PREVIEW_IDS.closedCampaign },
            data: { status: 'Closed', closed_at: dates.closed.closedAt, closed_by: PREVIEW_IDS.adminUser, settlement_total: settlementTotal },
        });
        await tx.invoice.create({
            data: {
                id: PREVIEW_IDS.closedInvoice, business_id: PREVIEW_IDS.business, customer_id: PREVIEW_IDS.organization,
                campaign_id: PREVIEW_IDS.closedCampaign, status: 'DRAFT', generated_at: dates.closed.closedAt,
                total_amount: financials.totalDue, tax_amount: financials.taxAmount,
                fundraiser_profit_percent: financials.orgSharePercent, fundraiser_profit_amount: financials.organizationAmount,
                tax_rate_percent: financials.taxRatePercent, tax_status: campaignCommon.tax_status,
                taxable_base_amount: financials.baseRemit,
                items: {
                    create: closeoutLines.map((l) => ({
                        bundle_id: l.bundleId, description: l.description, quantity: l.quantity,
                        unit_price: l.unitPrice, total: l.total, variant_size: (l.variantSize as any) ?? null,
                    })),
                },
            },
        });

        return {
            businessId: PREVIEW_IDS.business,
            slug: PREVIEW_TENANT_SLUG,
            adminEmail: previewFixtureEmail('preview-admin'),
            activeCampaignId: PREVIEW_IDS.activeCampaign,
            closedCampaignId: PREVIEW_IDS.closedCampaign,
            activePortalToken,
            closedPortalToken,
            orderIds,
            closedInvoiceId: PREVIEW_IDS.closedInvoice,
            closedSettlementTotal: settlementTotal,
        };
    }, { timeout: 120_000, maxWait: 30_000 });
}
