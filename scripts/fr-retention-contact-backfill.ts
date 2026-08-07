/**
 * FR-RETENTION Checkpoint 1 — durable fundraiser contact backfill.
 *
 * Seeds `fundraiser_contacts`, `fundraiser_contact_points` and
 * `fundraiser_organization_contacts` from the org-level contact fields that
 * already live on `customers` (contact_name / contact_email / contact_phone /
 * secondary_phone).
 *
 * USAGE — LOCAL (the default, and the only mode without explicit authorization)
 *   npx tsx scripts/fr-retention-contact-backfill.ts            # dry run (default)
 *   npx tsx scripts/fr-retention-contact-backfill.ts --apply    # write
 *   npx tsx scripts/fr-retention-contact-backfill.ts --business=<id>
 *
 * USAGE — PRODUCTION (five independent gates, all required together)
 *   FR_RETENTION_PRODUCTION_BACKFILL_CONFIRM=YES \
 *   DATABASE_URL='<production direct url>' \
 *   npx tsx scripts/fr-retention-contact-backfill.ts \
 *     --allow-production \
 *     --business=<business uuid> \
 *     --expected-host=aws-1-us-east-1.pooler.supabase.com \
 *     [--apply]
 *
 *   Omit --apply for a dry run. Production runs are ALWAYS scoped to exactly one
 *   business: there is no tenant-wide production mode, by design. A missing gate
 *   is a refusal, never a prompt and never a default.
 *
 * The connection string is read from process.env.DATABASE_URL and passed to
 * PrismaClient EXPLICITLY via `datasources`. This is deliberate: the Prisma
 * CLI's dotenv loader overrides the ambient environment, and this script must
 * never silently inherit whatever `.env` happens to say.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY: LOOPBACK BY DEFAULT, PRODUCTION ONLY BY EXPLICIT INTENT
 *
 * With no production authorization the script refuses any host that is not
 * 127.0.0.1 / localhost, and defaults to a dry run. That default is unchanged.
 *
 * Production requires FIVE independent gates in one invocation:
 *   1. --allow-production
 *   2. --business=<exact business uuid>     (no tenant-wide production mode)
 *   3. --expected-host=<the production host, stated by the caller>
 *   4. FR_RETENTION_PRODUCTION_BACKFILL_CONFIRM=YES in the environment
 *   5. --apply, for writes only — without it production still dry-runs
 *
 * The resolved host must then match the approved production host exactly and
 * the database must be `postgres`. Any missing or mismatched gate is a hard
 * refusal. The point of five gates is that no single typo, stale shell
 * variable, or half-copied command can reach production.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * IDENTITY RULES (these are product rules, not implementation details)
 *
 *   · One provisional FundraiserContact per source organization contact.
 *   · People are NEVER merged by email address. Two coordinators who share an
 *     office inbox stay two distinct people with two distinct contact rows;
 *     the shared address is flagged, not collapsed. Merging is a later,
 *     human-reviewed checkpoint — it is not something a backfill may decide.
 *   · Identity is `provisional` because it was inferred from an org record,
 *     not confirmed by the person. Confirmation happens through outreach.
 *
 * ARCHIVED STATE
 *   When the source organization is archived, the created contact is archived
 *   too (archived_at mirrors the organization's archived_at). The relationship
 *   row is deliberately left ACTIVE (ended_at = NULL): ending it would hide the
 *   organization from the contact, and the Rebooking surface derives "Archived"
 *   from the organization it can still see. Archiving the person — not severing
 *   the relationship — is what preserves the history.
 *
 * PROVENANCE
 *   history_starts_at is set from the organization's earliest campaign
 *   created_at. It records how far back this relationship is evidenced, and is
 *   left NULL when there is no campaign to evidence it. Nothing is invented.
 *
 * IDEMPOTENCY
 *   An organization is considered already backfilled when it already has any
 *   FundraiserOrganizationContact with source = 'backfill'. Re-running creates
 *   nothing. This is checked per organization, so a partial run resumes safely.
 *
 * PRIVACY
 *   Output is counts and organization names only. No email address, phone
 *   number, or delivery address is ever printed.
 */

// TYPE-ONLY import: erased at compile time, so it does NOT load the module at
// runtime. The value import is deferred to a dynamic import inside main().
import type { PrismaClient as PrismaClientType } from '@prisma/client';

// Snapshot the ambient DATABASE_URL BEFORE @prisma/client is ever loaded.
// Importing @prisma/client runs Prisma's dotenv loader, which populates
// process.env.DATABASE_URL from .env. Without this snapshot, running the script
// with no DATABASE_URL set would silently inherit .env's target — which is a
// real local database — instead of refusing. That is exactly the accident this
// script exists to prevent, so the snapshot is load-order critical.
const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// The ONLY non-loopback host this script will ever accept, and only then with
// every gate below satisfied. Anything else is refused outright.
const PRODUCTION_HOST = 'aws-1-us-east-1.pooler.supabase.com';
const PRODUCTION_DB = 'postgres';
const CONFIRM_ENV = 'FR_RETENTION_PRODUCTION_BACKFILL_CONFIRM';
const CONFIRM_VALUE = 'YES';

interface Args {
    apply: boolean;
    businessId: string | null;
    allowProduction: boolean;
    expectedHost: string | null;
}

function parseArgs(argv: string[]): Args {
    const get = (prefix: string) => {
        const a = argv.find((x) => x.startsWith(prefix));
        return a ? a.slice(prefix.length) || null : null;
    };
    return {
        apply: argv.includes('--apply'),
        businessId: get('--business='),
        allowProduction: argv.includes('--allow-production'),
        expectedHost: get('--expected-host='),
    };
}

export interface ResolvedTarget {
    url: string;
    host: string;
    database: string;
    isProduction: boolean;
}

/**
 * Loopback by default. Production only through five independent gates that must
 * ALL be satisfied in the same invocation — a flag, a named business, a declared
 * expected host, an environment confirmation, and (for writes) --apply.
 *
 * Each gate is something a person has to mean. None of them can be satisfied by
 * a stray shell variable or a copied command fragment on its own.
 */
function resolveTarget(args: Args): ResolvedTarget {
    const raw = EXPLICIT_DATABASE_URL;
    if (!raw) {
        throw new Error(
            'DATABASE_URL is not set. Set it explicitly for this run — this script ' +
            'deliberately ignores .env, so there is no implicit target.',
        );
    }

    let host: string;
    let database: string;
    try {
        const u = new URL(raw);
        host = u.hostname;
        database = u.pathname.replace(/^\//, '');
    } catch {
        throw new Error('DATABASE_URL is not a parseable connection URL.');
    }

    const isLoopback = LOOPBACK_HOSTS.has(host);

    if (isLoopback) {
        // Refuse the ambiguity of production authorization aimed at a local
        // database — that combination always means someone mixed up two runs.
        if (args.allowProduction) {
            throw new Error(
                `REFUSED: --allow-production was passed but the target host "${host}" is loopback. ` +
                'Refusing rather than guessing which run was intended.',
            );
        }
        console.log(`  target      : ${host} / ${database} (local)`);
        return { url: raw, host, database, isProduction: false };
    }

    // ── Non-loopback: every gate below is mandatory ──────────────────────────
    const missing: string[] = [];
    if (!args.allowProduction) missing.push('--allow-production');
    if (!args.businessId) missing.push('--business=<business uuid>');
    if (!args.expectedHost) missing.push(`--expected-host=${PRODUCTION_HOST}`);
    if (process.env[CONFIRM_ENV] !== CONFIRM_VALUE) missing.push(`${CONFIRM_ENV}=${CONFIRM_VALUE}`);

    if (missing.length > 0) {
        throw new Error(
            `REFUSED: host "${host}" is not loopback, so production mode is required.\n` +
            'Missing:\n  ' + missing.join('\n  ') + '\n' +
            'All of them are required in the same invocation.',
        );
    }
    if (args.expectedHost !== PRODUCTION_HOST) {
        throw new Error(
            `REFUSED: --expected-host "${args.expectedHost}" is not the approved production host.`,
        );
    }
    if (host !== PRODUCTION_HOST) {
        throw new Error(
            `REFUSED: target host "${host}" is neither loopback nor the approved production host.`,
        );
    }
    if (database !== PRODUCTION_DB) {
        throw new Error(
            `REFUSED: production database must be "${PRODUCTION_DB}", got "${database}".`,
        );
    }

    console.log(`  target      : ${host} / ${database} (PRODUCTION)`);
    console.log(`  scope       : single business ${args.businessId}`);
    console.log(`  gates       : --allow-production, --business, --expected-host, ${CONFIRM_ENV}`);
    return { url: raw, host, database, isProduction: true };
}

/** Lowercase + trim. Used for grouping only; the original value is stored. */
function normalize(value: string): string {
    return value.trim().toLowerCase();
}

/** Collapses whitespace so "12 Main St " and "12  Main St" group together. */
function normalizeAddress(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    console.log('FR-RETENTION contact backfill');
    console.log(`  mode        : ${args.apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);

    const target = resolveTarget(args);

    // Deferred value import — see EXPLICIT_DATABASE_URL above.
    const { PrismaClient } = await import('@prisma/client');
    const prisma: PrismaClientType = new PrismaClient({ datasources: { db: { url: target.url } } });

    try {
        if (target.isProduction) {
            // Belt and braces: production must never run tenant-wide, and the
            // named business has to actually exist before anything is created.
            if (!args.businessId) {
                throw new Error('REFUSED: production runs require --business=<business uuid>.');
            }
            const exists = await prisma.business.count({ where: { id: args.businessId } });
            if (exists !== 1) {
                throw new Error(
                    `REFUSED: business ${args.businessId} was not found in this database.`,
                );
            }
            console.log('  business    : verified present');
        }

        const organizations = await prisma.customer.findMany({
            where: {
                type: 'fundraiser_org',
                business_id: args.businessId ? args.businessId : { not: null },
            },
            select: {
                id: true,
                business_id: true,
                name: true,
                contact_name: true,
                contact_email: true,
                contact_phone: true,
                secondary_phone: true,
                delivery_address: true,
                archived: true,
                archived_at: true,
                campaigns: {
                    select: { created_at: true },
                    orderBy: { created_at: 'asc' },
                    take: 1,
                },
                org_contacts: {
                    where: { source: 'backfill' },
                    select: { id: true },
                    take: 1,
                },
            },
            orderBy: { name: 'asc' },
        });

        console.log(`  fundraiser organizations found: ${organizations.length}`);

        // ── Pass 1: group by shared signal, WITHOUT merging anyone ──────────
        // These counts decide which contacts get flagged for human review and
        // which addresses are marked as shared inboxes. They never cause two
        // source records to become one contact.
        const emailCounts = new Map<string, number>();
        const addressCounts = new Map<string, number>();
        for (const org of organizations) {
            if (org.contact_email) {
                const k = normalize(org.contact_email);
                emailCounts.set(k, (emailCounts.get(k) ?? 0) + 1);
            }
            if (org.delivery_address) {
                const k = normalizeAddress(org.delivery_address);
                addressCounts.set(k, (addressCounts.get(k) ?? 0) + 1);
            }
        }

        let createdContacts = 0;
        let createdPoints = 0;
        let createdRelationships = 0;
        let skippedAlreadyBackfilled = 0;
        let skippedNoContactData = 0;
        let flaggedSharedAddress = 0;
        let flaggedSharedInbox = 0;
        let archivedContacts = 0;

        for (const org of organizations) {
            if (org.org_contacts.length > 0) {
                skippedAlreadyBackfilled++;
                continue;
            }

            const hasAnyContactData =
                Boolean(org.contact_name) ||
                Boolean(org.contact_email) ||
                Boolean(org.contact_phone) ||
                Boolean(org.secondary_phone);

            if (!hasAnyContactData) {
                skippedNoContactData++;
                continue;
            }

            // business_id is non-null by the query filter, but the column is
            // nullable in the schema — narrow it rather than assert.
            const businessId = org.business_id;
            if (!businessId) {
                skippedNoContactData++;
                continue;
            }

            const displayName = org.contact_name?.trim() || `${org.name} coordinator`;

            const sharedAddress = org.delivery_address
                ? (addressCounts.get(normalizeAddress(org.delivery_address)) ?? 0) > 1
                : false;
            const sharedInbox = org.contact_email
                ? (emailCounts.get(normalize(org.contact_email)) ?? 0) > 1
                : false;

            // Review is about the shared delivery address: it means two
            // organizations deliver to one place, which a human should look at.
            const reviewReason = sharedAddress
                ? 'Shares a delivery address with another organization'
                : null;

            if (sharedAddress) flaggedSharedAddress++;
            if (sharedInbox) flaggedSharedInbox++;

            const historyStartsAt = org.campaigns[0]?.created_at ?? null;
            const archivedAt = org.archived ? (org.archived_at ?? new Date()) : null;
            if (archivedAt) archivedContacts++;

            const points: { type: 'email' | 'phone'; label: 'work' | 'mobile'; value: string; isPrimary: boolean }[] = [];
            if (org.contact_email?.trim()) {
                points.push({ type: 'email', label: 'work', value: org.contact_email.trim(), isPrimary: true });
            }
            if (org.contact_phone?.trim()) {
                points.push({ type: 'phone', label: 'work', value: org.contact_phone.trim(), isPrimary: true });
            }
            if (org.secondary_phone?.trim()) {
                // Secondary phone is a real, current, usable number — but not
                // primary. The partial unique index permits exactly one primary
                // current point per (contact, type); secondaries are unlimited.
                points.push({ type: 'phone', label: 'mobile', value: org.secondary_phone.trim(), isPrimary: false });
            }

            if (!args.apply) {
                createdContacts++;
                createdPoints += points.length;
                createdRelationships++;
                continue;
            }

            await prisma.$transaction(async (tx) => {
                const contact = await tx.fundraiserContact.create({
                    data: {
                        business_id: businessId,
                        display_name: displayName,
                        identity_status: 'provisional',
                        needs_review: sharedAddress,
                        review_reason: reviewReason,
                        history_starts_at: historyStartsAt,
                        source: 'backfill',
                        archived_at: archivedAt,
                        archive_reason: archivedAt ? 'inactive' : null,
                    },
                });
                createdContacts++;

                for (const p of points) {
                    await tx.fundraiserContactPoint.create({
                        data: {
                            business_id: businessId,
                            contact_id: contact.id,
                            type: p.type,
                            label: p.label,
                            value: p.value,
                            normalized_value: normalize(p.value),
                            is_primary: p.isPrimary,
                            is_current: true,
                            is_shared_inbox: p.type === 'email' ? sharedInbox : false,
                            source: 'backfill',
                        },
                    });
                    createdPoints++;
                }

                await tx.fundraiserOrganizationContact.create({
                    data: {
                        business_id: businessId,
                        contact_id: contact.id,
                        customer_id: org.id,
                        role: 'coordinator',
                        is_primary_relationship: true,
                        // Left active on purpose even for archived organizations
                        // — see the ARCHIVED STATE note in the file header.
                        ended_at: null,
                        source: 'backfill',
                    },
                });
                createdRelationships++;
            });
        }

        console.log('');
        console.log('  RESULTS');
        console.log(`    contacts created         : ${createdContacts}`);
        console.log(`    contact points created   : ${createdPoints}`);
        console.log(`    relationships created    : ${createdRelationships}`);
        console.log(`    skipped (already done)   : ${skippedAlreadyBackfilled}`);
        console.log(`    skipped (no contact data): ${skippedNoContactData}`);
        console.log(`    flagged shared address   : ${flaggedSharedAddress}`);
        console.log(`    marked shared inbox      : ${flaggedSharedInbox}`);
        console.log(`    archived contacts        : ${archivedContacts}`);
        if (!args.apply) {
            console.log('');
            console.log('  DRY RUN — nothing was written. Re-run with --apply to commit.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
