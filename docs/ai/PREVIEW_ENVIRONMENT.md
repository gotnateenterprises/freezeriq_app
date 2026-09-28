# FreezerIQ Preview Environment (PREVIEW-DB-ISOLATION-1)

> [!CAUTION]
> **FUTURE AGENT RULE: NEVER assume Preview points to Production — or that it doesn't. Verify environment before mutating acceptance.**
> A Vercel deployment keeps the environment variables it was **built** with. Preview deployments created
> before the cutover on **2026-09-27** still read and write the **Production** database. Before any
> mutating test on a Preview URL, prove which database that exact deployment uses (see
> [Verify a deployment's database](#verify-a-deployments-database)). If you cannot prove it, do not mutate.

## Topology (since 2026-09-27)

| | Production | Preview (built after the cutover) | Local development |
|---|---|---|---|
| Database | Production Supabase project (pooler `aws-1-us-east-1…`) | **Separate** free Supabase project `freezeriq-preview` in organization "FreezerIQ Preview" (pooler `aws-0-us-east-1…`) | unchanged: local Postgres via `.env` / `.env.development.local` |
| Data | real tenants | **fake fixtures only** (below) | developer's own |
| Email (Resend) | unchanged | every send redirected to Resend's test sink `delivered@resend.dev` (`lib/emailSafety.ts`) | unchanged |
| QuickBooks | enabled per `QBO_*` | disabled in code (`lib/quickbooks/config.ts`), no `QBO_*` variables | sandbox only |
| Square | production | `SQUARE_ENVIRONMENT=sandbox`, and the Preview database holds no Square tokens | unchanged |
| Media (R2) | unchanged keys | same bucket, keys prefixed `preview/` (`lib/s3.ts`) | unchanged |
| Stripe | dormant (no connected businesses) | same platform key — see [Residual risks](#residual-risks) | unchanged |
| Inbound webhooks / cron | as configured | unreachable: Preview is behind Vercel Authentication; no code registers webhooks; there are no Vercel crons (they would run on Production only) | n/a |

Old topology, for the record: until 2026-09-27 `DATABASE_URL` and `DIRECT_URL` were single Vercel entries
shared by Production, Preview and Development, so every Preview deployment used the Production database.

## Vercel environment variables (names and targets only)

| Variable | Target | Value points at |
|---|---|---|
| `DATABASE_URL` | production, development | Production transaction pooler (unchanged) |
| `DATABASE_URL` | preview | Preview transaction pooler, `:6543?pgbouncer=true` |
| `DIRECT_URL` | production, development | Production session pooler (unchanged) |
| `DIRECT_URL` | preview | Preview session pooler, `:5432` |
| `SQUARE_ENVIRONMENT` | production, development | `production` (unchanged) |
| `SQUARE_ENVIRONMENT` | preview | `sandbox` |

Every other variable is unchanged. The Production entries kept their exact values; only their target lists
lost `preview`. Env changes apply to **new** deployments only.

## Verify a deployment's database

Use the fixed fake campaign id — it exists only in the Preview database:

1. The deployment must have been **created after** the 2026-09-27 cutover (`vercel inspect <url>` or the
   dashboard). Anything older is Production-backed.
2. Open `<deployment-url>/shop/preview-test-tenant/fundraiser/7e57f000-0000-4000-8000-000000000010`.
   It renders **"Preview Test Active Fundraiser"** only on the Preview database; on Production the tenant
   does not exist.
3. Read-only alternative: count rows in each database directly and compare (the Preview database holds one
   business, slug `preview-test-tenant`).

## Fixtures (all fake)

Seeded by `lib/previewFixtures.ts`. Names start "Preview Test"; every email address is a Resend test-sink
address (`delivered+<label>@resend.dev`, delivered nowhere); phones are fictional `555-01xx`; ids start `7e57`.

- Tenant **Preview Test Tenant** (`preview-test-tenant`, plan ULTIMATE) with admin `delivered+preview-admin@resend.dev`
- Organization **Preview Test Organization**, coordinator **Preview Test Coordinator**
- Two bundle families, each **Serves 5** ($125, tier `family`) + **Serves 2** ($70, tier `serves_2`), with four fake recipes
- **Preview Test Active Fundraiser** — Active, selected menu, deadline 30 days after seeding, delivery 9:00 AM, bundle goal 20, three supporter orders (weighted progress 4.0)
- **Preview Test Closed Fundraiser** — closed exactly as the closeout route closes one (settlement $390.00, one DRAFT invoice for $312.00), two supporter orders

The admin password and the coordinator portal links are generated at seed time and written only to a
credentials file **outside** the repository (never committed, never printed).

## Reset / reseed

Only the Preview database may be seeded. The seeder refuses unless `DATABASE_URL` and `DIRECT_URL` are set
explicitly, neither is the Production host, and the database holds no business outside `preview-test*` and no
user outside `@resend.dev`. `--reset` truncates every application table (not `_prisma_migrations`) first.

```powershell
# Get the Preview URLs without printing them: `vercel env pull <file outside the repo> --environment=preview`,
# or Supabase dashboard -> organization "FreezerIQ Preview" -> project freezeriq-preview -> Connect.
$env:DATABASE_URL = '<Preview transaction pooler URL>'
$env:DIRECT_URL   = '<Preview session pooler URL>'
npx tsx lib/previewDbSeedCli.ts --reset --credentials-out "$HOME\.freezeriq-preview\preview-credentials.txt"
Remove-Item Env:DATABASE_URL, Env:DIRECT_URL
```

Reseed when the active fixture campaign's deadline (30 days after seeding) has passed.

## Migrations

Builds never migrate (`prisma generate && next build`). Preview does not change that.

- Apply migrations to the Preview database explicitly: `npx prisma migrate deploy` with the Preview
  `DIRECT_URL`/`DATABASE_URL` in the process environment. **Never `prisma migrate dev`** against it (or any
  shared database).
- A branch that adds a migration: apply it to **Preview** first, test on a Preview deployment, then apply
  it to Production only through the normal owner-authorized release step. Never the other way round.
- If an abandoned branch's migration was applied to Preview, reset the Preview schema to `main`'s migrations
  (drop the application tables, `migrate deploy`, reseed) rather than leaving Preview ahead of Production.
- Ledger parity: Production's `_prisma_migrations` checksums are SHA-256 of the committed (LF) migration
  bytes — except `20260813000000_ge5a_automation_foundation`, recorded from CRLF bytes. A Windows checkout
  (`core.autocrlf=true`) produces different checksums; the schema is identical either way and
  `migrate deploy` does not re-check applied migrations. On 2026-09-27 the Preview ledger was built from the
  byte variant matching each Production checksum, so the two ledgers' digests are identical.

## Residual risks

- **Old Preview deployments** built before 2026-09-27 still use the Production database, Production email
  recipients and Production Square mode. Do not use them for mutating acceptance.
- **Branches without `lib/emailSafety.ts`** (cut from a commit before PREVIEW-DB-ISOLATION-1) send Preview
  email unredirected. The Preview database contains only sink addresses, so this reaches no real person
  unless a tester types a real address. The guard reaches every future branch once this phase is on the
  main line.
- **Stripe**: Preview uses the same `STRIPE_SECRET_KEY` as Production. Stripe is dormant (no business has a
  Stripe customer or subscription), and nothing calls it except an explicit tester action. To fence it,
  add a Preview-only Stripe **test** key (`sk_test_…`) from the Stripe dashboard.
- **Free plan**: the Preview project pauses after about a week without traffic (restore it from the
  Supabase dashboard, free), is limited to 500 MB, and has no backups (fixtures are reproducible).
- **Resend**: Preview sends to the sink still go through the Production Resend account (they appear in its
  logs and count toward its quota).

## Rollback

Delete the three Preview-only entries, then re-add `preview` to the targets of the Production
`DATABASE_URL`, `DIRECT_URL` and `SQUARE_ENVIRONMENT` entries, and redeploy Preview. Nothing in Production
changes. The code guards are inert on Production and local development either way.
