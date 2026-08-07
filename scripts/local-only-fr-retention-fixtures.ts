/**
 * LOCAL ONLY — fictional fixtures for FR-RETENTION Checkpoint 1 validation.
 *
 * Every name, address, phone number and email address below is invented. There
 * is no production data in this file and none may ever be added to it. Its
 * purpose is to make a production-SHAPED local database (structure cloned from
 * production, zero production rows) exercisable end to end.
 *
 * USAGE
 *   npx tsx scripts/local-only-fr-retention-fixtures.ts --apply
 *
 *   # optionally also create a local sign-in identity for UI testing:
 *   FIXTURE_USER_PASSWORD='<pick-your-own>' \
 *     npx tsx scripts/local-only-fr-retention-fixtures.ts --apply --test-user
 *
 * The test user is created through the application's normal bcrypt path — the
 * same hashing `auth.ts` verifies against. Nothing about authentication is
 * bypassed or weakened. The password is never hardcoded and never printed; it
 * comes from FIXTURE_USER_PASSWORD, which you set.
 *
 * Like the backfill, this refuses any non-loopback host and reads DATABASE_URL
 * explicitly rather than inheriting .env.
 *
 * WHAT THE FIXTURES ARE DESIGNED TO PROVE
 *   · Riley Marsh coordinates THREE organizations under ONE email address.
 *     The backfill must produce three DISTINCT contacts, never one merged
 *     person — this is the central identity rule of Checkpoint 1.
 *   · Sam Rivera and Alex Rivera are two different people sharing one home
 *     inbox AND one delivery address. They must stay two contacts, with the
 *     address flagged for review and the inbox marked shared.
 *   · Lakeside has no contact information at all and must be skipped cleanly.
 *   · Old Mill is archived and must produce an archived contact.
 */

// TYPE-ONLY import: erased at compile time, so the module is not loaded here.
import type { PrismaClient as PrismaClientType } from '@prisma/client';

// Snapshot before @prisma/client loads — importing it runs Prisma's dotenv
// loader and would otherwise populate DATABASE_URL from .env behind our back.
const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const TENANT_SLUG = 'fixture-frozen-harvest';
const FIXTURE_USER_EMAIL = 'owner@frozenharvest.example';

interface OrgFixture {
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    secondaryPhone: string | null;
    address: string | null;
    archived: boolean;
    campaigns: string[];
}

const ORGS: OrgFixture[] = [
    {
        name: 'Pine Valley PTO',
        contactName: 'Riley Marsh',
        email: 'riley.marsh@pinevalley.example',
        phone: '555-0101',
        secondaryPhone: '555-0111',
        address: '48 Orchard Lane, Pine Valley',
        archived: false,
        campaigns: ['Pine Valley Fall Fundraiser', 'Pine Valley Spring Fundraiser'],
    },
    {
        name: 'Maple Grove Boosters',
        contactName: 'Riley Marsh',
        email: 'riley.marsh@pinevalley.example',
        phone: '555-0101',
        secondaryPhone: null,
        address: '12 Maple Grove Road',
        archived: false,
        campaigns: ['Maple Grove Winter Drive'],
    },
    {
        name: 'Cedar Ridge Boosters',
        contactName: 'Riley Marsh',
        email: 'riley.marsh@pinevalley.example',
        phone: '555-0101',
        secondaryPhone: null,
        address: '7 Cedar Ridge Way',
        archived: false,
        campaigns: ['Cedar Ridge Fall Drive'],
    },
    {
        name: 'Willow Creek Boosters',
        contactName: 'Sam Rivera',
        email: 'family@riverahome.example',
        phone: '555-0102',
        secondaryPhone: null,
        address: '31 Willow Creek Drive',
        archived: false,
        campaigns: ['Willow Creek Fall Drive'],
    },
    {
        name: 'Birchwood PTA',
        contactName: 'Alex Rivera',
        // Same household inbox as Sam, and the same delivery address.
        email: 'family@riverahome.example',
        phone: '555-0103',
        secondaryPhone: null,
        address: '31 Willow Creek Drive',
        archived: false,
        campaigns: ['Birchwood Spring Drive'],
    },
    {
        name: 'Lakeside Elementary PTO',
        contactName: null,
        email: null,
        phone: null,
        secondaryPhone: null,
        address: '90 Lakeside Avenue',
        archived: false,
        campaigns: [],
    },
    {
        name: 'Old Mill Academy',
        contactName: 'Jordan Fields',
        email: 'jordan.fields@oldmill.example',
        phone: '555-0104',
        secondaryPhone: null,
        address: '5 Old Mill Court',
        archived: true,
        campaigns: ['Old Mill Legacy Drive'],
    },
];

function resolveDatabaseUrl(): string {
    const raw = EXPLICIT_DATABASE_URL;
    if (!raw) throw new Error('DATABASE_URL is not set. Set it explicitly for this run.');
    let host: string;
    try {
        host = new URL(raw).hostname;
    } catch {
        throw new Error('DATABASE_URL is not a parseable connection URL.');
    }
    if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error(`REFUSED: host "${host}" is not loopback. Fixtures are local-only.`);
    }
    console.log(`  target host : ${host}`);
    return raw;
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    console.log('FR-RETENTION local fixtures (FICTIONAL DATA ONLY)');
    console.log(`  mode        : ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);

    const url = resolveDatabaseUrl();

    // Deferred value import — see EXPLICIT_DATABASE_URL above.
    const { PrismaClient } = await import('@prisma/client');
    const prisma: PrismaClientType = new PrismaClient({ datasources: { db: { url } } });

    try {
        if (!apply) {
            console.log(`  would create 1 tenant and ${ORGS.length} fundraiser organizations`);
            console.log('  DRY RUN — nothing written. Re-run with --apply.');
            return;
        }

        // --business-id=<uuid> attaches the fixtures to a specific tenant id.
        // Useful when an existing local browser session already carries a
        // businessId and you want that session to see the fixture data without
        // signing in again. Never hardcoded — supply it at runtime.
        const idArg = process.argv.find((a) => a.startsWith('--business-id='));
        const forcedId = idArg ? idArg.split('=')[1] : null;

        const business = await prisma.business.upsert({
            where: { slug: TENANT_SLUG },
            update: {},
            create: {
                ...(forcedId ? { id: forcedId } : {}),
                name: 'Frozen Harvest Kitchen (fixture tenant)',
                slug: TENANT_SLUG,
                contact_email: FIXTURE_USER_EMAIL,
            },
        });
        console.log(`  tenant      : ${business.name}`);

        let orgCount = 0;
        let campaignCount = 0;

        for (const o of ORGS) {
            const existing = await prisma.customer.findFirst({
                where: { business_id: business.id, name: o.name },
                select: { id: true },
            });
            if (existing) continue;

            const customer = await prisma.customer.create({
                data: {
                    business_id: business.id,
                    name: o.name,
                    contact_name: o.contactName,
                    contact_email: o.email,
                    contact_phone: o.phone,
                    secondary_phone: o.secondaryPhone,
                    delivery_address: o.address,
                    type: 'fundraiser_org',
                    archived: o.archived,
                    archived_at: o.archived ? new Date('2026-03-15T00:00:00Z') : null,
                },
            });
            orgCount++;

            for (const name of o.campaigns) {
                await prisma.fundraiserCampaign.create({
                    data: { name, customer_id: customer.id },
                });
                campaignCount++;
            }
        }

        console.log(`  organizations created : ${orgCount}`);
        console.log(`  campaigns created     : ${campaignCount}`);

        if (process.argv.includes('--test-user')) {
            const password = process.env.FIXTURE_USER_PASSWORD;
            if (!password) {
                throw new Error(
                    '--test-user requires FIXTURE_USER_PASSWORD to be set. It is never ' +
                    'hardcoded and never defaulted — choose your own local value.',
                );
            }
            const bcrypt = (await import('bcryptjs')).default;
            const hashed = await bcrypt.hash(password, 10);
            const user = await prisma.user.upsert({
                where: { email: FIXTURE_USER_EMAIL },
                update: { password: hashed, business_id: business.id, isActive: true },
                create: {
                    email: FIXTURE_USER_EMAIL,
                    password: hashed,
                    name: 'Fixture Owner',
                    role: 'ADMIN',
                    isActive: true,
                    business_id: business.id,
                },
            });
            // Email only. The password is deliberately not echoed.
            console.log(`  test user ready       : ${user.email} (role ${user.role})`);
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
