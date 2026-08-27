/**
 * MIGRATION 18 — outreach batch campaign ownership.
 *
 * The live constraint probes run against a scratch Postgres (m18-verify.ts, run
 * during the migration task). These tests pin the SHIPPED artefacts so the
 * contract cannot be quietly edited afterwards: the migration SQL, the Prisma
 * model, and the fact that nothing else in the outreach chain moved.
 */
import fs from 'fs';
import path from 'path';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const MIGRATION = 'prisma/migrations/20260826000000_m18_outreach_batch_campaign_ownership/migration.sql';
const sql = R(MIGRATION);
const schema = R('prisma/schema.prisma');

/** The OutreachBatch block only — so assertions cannot match another model. */
const batchModel = (() => {
    const start = schema.indexOf('model OutreachBatch {');
    return schema.slice(start, schema.indexOf('\n}', start));
})();

describe('Migration 18 · writes no data', () => {
    it('contains no INSERT, UPDATE or DELETE statement', () => {
        // Matched at statement start: "ON UPDATE CASCADE" and "ON DELETE
        // RESTRICT" are referential actions on a foreign key, not DML, and a
        // naive word search flags them.
        const statements = sql
            .replace(/^\s*--.*$/gm, '')
            .split(/;\s*/)
            .map((s) => s.trim())
            .filter(Boolean);
        expect(statements.length).toBeGreaterThan(0);
        for (const s of statements) {
            expect(s).not.toMatch(/^(INSERT|UPDATE|DELETE|TRUNCATE|COPY)\b/i);
        }
        // And every statement is one of the shapes this migration is allowed to use.
        for (const s of statements) {
            expect(s).toMatch(/^(ALTER TABLE|CREATE (UNIQUE )?INDEX|DROP INDEX)\b/i);
        }
    });

    it('adds no DEFAULT that would rewrite existing rows', () => {
        expect(sql).not.toMatch(/ADD COLUMN[^;]*DEFAULT/i);
    });

    it('touches only outreach_batches', () => {
        const tables = [...sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
        expect([...new Set(tables)]).toEqual(['outreach_batches']);
        // Every index it creates is on outreach_batches; the other two tables
        // appear only as FK REFERENCES targets, which alters nothing about them.
        const indexed = [...sql.matchAll(/INDEX[^;]*?\bON "([a-z_]+)"/g)].map((m) => m[1]);
        expect([...new Set(indexed)]).toEqual(['outreach_batches']);
        const referenced = [...sql.matchAll(/REFERENCES "([a-z_]+)"/g)].map((m) => m[1]);
        expect([...new Set(referenced)].sort()).toEqual(['customers', 'fundraiser_campaigns']);
    });

    it('creates no supporting unique index — both FK targets already existed', () => {
        // customers_business_id_id_key (FR-RETENTION-1) and
        // fundraiser_campaigns_customer_id_id_key (FR-FUNNEL-1).
        const created = [...sql.matchAll(/CREATE (UNIQUE )?INDEX[^;]*ON "([a-z_]+)"/g)].map((m) => m[2]);
        expect([...new Set(created)]).toEqual(['outreach_batches']);
        expect(R('prisma/migrations/20260806000000_fr_retention_contact_foundation/migration.sql'))
            .toContain('customers_business_id_id_key');
        expect(R('prisma/migrations/20260817000000_fr_funnel_1_acquisition_foundation/migration.sql'))
            .toContain('fundraiser_campaigns_customer_id_id_key');
    });
});

describe('Migration 18 · ownership', () => {
    it('makes the seasonal owner optional and adds the fundraiser owner', () => {
        expect(sql).toMatch(/ALTER COLUMN "seasonal_offering_id" DROP NOT NULL/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "campaign_id" TEXT/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "customer_id" TEXT/);
    });

    it('enforces the WHOLE owner shape, not a two-column XOR', () => {
        const check = sql.slice(sql.indexOf('outreach_batches_exactly_one_owner" CHECK'));
        // A campaign without its customer must be rejected, because a composite
        // FK containing a NULL is not checked at all under MATCH SIMPLE.
        expect(check).toMatch(/"seasonal_offering_id" IS NOT NULL\s+AND "campaign_id" IS NULL\s+AND "customer_id" IS NULL/);
        expect(check).toMatch(/"seasonal_offering_id" IS NULL\s+AND "campaign_id" IS NOT NULL\s+AND "customer_id" IS NOT NULL/);
        expect(check).not.toMatch(/<>/);
    });

    it('chains tenancy through TWO composite foreign keys', () => {
        expect(sql).toMatch(/FOREIGN KEY \("business_id", "customer_id"\)\s*REFERENCES "customers"\("business_id", "id"\)/);
        expect(sql).toMatch(/FOREIGN KEY \("customer_id", "campaign_id"\)\s*REFERENCES "fundraiser_campaigns"\("customer_id", "id"\)/);
        // Never the weaker campaign_id-only form.
        expect(sql).not.toMatch(/FOREIGN KEY \("campaign_id"\)/);
    });

    it('keeps outreach history from being deleted underneath itself', () => {
        const fks = [...sql.matchAll(/ADD CONSTRAINT "outreach_batches_[a-z_]+fkey"[\s\S]*?ON DELETE (\w+)/g)]
            .map((m) => m[1]);
        expect(fks.length).toBeGreaterThanOrEqual(2);
        expect(fks.every((a) => a === 'RESTRICT')).toBe(true);
        expect(sql).not.toMatch(/outreach_batches_campaign_fkey[\s\S]{0,200}ON DELETE CASCADE/);
    });
});

describe('Migration 18 · one batch per owner', () => {
    it('one_per_offering becomes PARTIAL, preserving the seasonal guarantee', () => {
        expect(sql).toMatch(/DROP INDEX IF EXISTS "outreach_batches_one_per_offering"/);
        const idx = sql.slice(sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "outreach_batches_one_per_offering"'));
        expect(idx.slice(0, 200)).toMatch(/WHERE "seasonal_offering_id" IS NOT NULL/);
    });

    it('one_per_campaign is the durable identity FR-REBOOK-2 needed', () => {
        const idx = sql.slice(sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "outreach_batches_one_per_campaign"'));
        expect(idx.slice(0, 200)).toMatch(/ON "outreach_batches" \("campaign_id"\)/);
        expect(idx.slice(0, 200)).toMatch(/WHERE "campaign_id" IS NOT NULL/);
        // Keyed on the campaign, never the organization — one org runs many.
        expect(idx.slice(0, 200)).not.toMatch(/\("customer_id"\)/);
    });
});

describe('Migration 18 · Prisma model matches', () => {
    it('models both owners as optional', () => {
        expect(batchModel).toMatch(/seasonal_offering_id\s+String\?/);
        expect(batchModel).toMatch(/campaign_id\s+String\?/);
        expect(batchModel).toMatch(/customer_id\s+String\?/);
        expect(batchModel).toMatch(/offering\s+SeasonalOffering\?/);
        expect(batchModel).toMatch(/campaign\s+FundraiserCampaign\?/);
        expect(batchModel).toMatch(/customer\s+Customer\?/);
    });

    it('keys the relations exactly as the foreign keys do', () => {
        expect(batchModel).toContain('fields: [business_id, customer_id], references: [business_id, id]');
        expect(batchModel).toContain('fields: [customer_id, campaign_id], references: [customer_id, id]');
    });

    it('does NOT declare the partial uniques it cannot express', () => {
        // Declaring them would tell Prisma about indexes the database does not
        // have in that shape, and a later `migrate dev` would "correct" the drift
        // by folding a stray CREATE UNIQUE INDEX into an unrelated migration.
        // Same convention as OutreachRecipient.
        const declarations = batchModel
            .split('\n')
            .filter((l) => /^\s*@@unique/.test(l));
        expect(declarations).toHaveLength(1);
        expect(declarations[0]).toContain('[business_id, id]');
        // Comment prefixes are stripped first: the sentence wraps across lines,
        // so a naive regex would be defeated by the "// " that starts the next.
        const prose = batchModel.replace(/^\s*\/\/\s?/gm, '').replace(/\s+/g, ' ');
        expect(prose).toContain('PARTIAL unique indexes created in raw SQL');
        expect(batchModel).toContain('outreach_batches_one_per_campaign');
    });

    it('every raw partial index it relies on is created by the migration', () => {
        for (const idx of ['outreach_batches_one_per_offering', 'outreach_batches_one_per_campaign']) {
            expect(batchModel).toContain(idx);
            expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${idx}"`);
        }
    });
});

describe('Migration 18 · the delivery chain is untouched', () => {
    it('the migration does not alter recipients, messages or delivery attempts', () => {
        for (const t of ['outreach_recipients', 'outreach_messages', 'email_delivery_attempts']) {
            expect(sql).not.toContain(`"${t}"`);
        }
    });

    it('the original per-recipient duplicate guard still stands in its own migration', () => {
        const original = R('prisma/migrations/20260808000000_fr_retention_outreach_delivery/migration.sql');
        expect(original).toContain('email_delivery_attempts_one_live_per_recipient');
        expect(original).toMatch(/WHERE NOT "is_test" AND "status" <> 'failed'/);
    });
});

describe('Migration 18 is what FR-REBOOK-2 now stands on', () => {
    const route = R('app/api/coordinator/previous-supporters/route.ts');
    const batch = R('lib/previousSupporterBatch.ts');

    it('the send path resolves a CAMPAIGN-owned batch, which only M18 allows', () => {
        expect(route).toContain('resolveCampaignBatch(prisma');
        expect(batch).toContain('campaign_id: owner.campaignId');
        expect(batch).toContain('seasonal_offering_id: null');
    });

    it('it never fabricates a seasonal lineup to get a batch', () => {
        expect(batch).not.toContain('seasonalOffering.create');
        // The seasonal owner is only ever written as an explicit null.
        const assignments = [...batch.matchAll(/seasonal_offering_id:\s*([^\s,}]+)/g)].map((m) => m[1]);
        expect(assignments.length).toBeGreaterThan(0);
        expect(assignments.every((v) => v === 'null')).toBe(true);
    });

    it('and it does not use the unique selector M18 deliberately withholds', () => {
        // Comments are stripped first: this file's own header explains WHY
        // upsert is wrong, and quotes it while doing so.
        const code = batch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/\.upsert\(/);
        expect(code).toContain('isUniqueViolation(e)');
    });
});
