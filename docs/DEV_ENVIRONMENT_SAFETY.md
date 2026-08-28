# Local development environment safety

## The problem this solves

Next.js loads env files in this order for `next dev` (highest wins):

```
.env.development.local  >  .env.local  >  .env.development  >  .env
```

In this repository, **`.env.local` holds Production credentials** — the
same Supabase database and the same R2 media bucket Vercel Production uses.
`.env` holds genuinely local values (local Postgres, no S3 bucket). Because
`.env.local` outranks `.env`, an ordinary `next dev` run has always silently
resolved Production database and Production storage credentials, with
nothing in the terminal or the app to indicate it.

This was discovered during BUNDLE-MEDIA-1 (2026-08-27): a local browser test
session uploaded two small test images to the real Production media bucket.
No database row was affected only because a local-only test business
happened not to exist in the Production database, so an unrelated
foreign-key constraint refused the accompanying write — not because
anything in the app or the environment setup prevented it.

## What to do as a developer

1. Copy the template once:

   ```bash
   cp .env.development.local.example .env.development.local
   ```

2. Fill in `.env.development.local` with your own local Postgres
   connection strings. Leave the `S3_*` variables blank.

`.env.development.local` is gitignored (matched by `.env*.local`) and is
never committed. It overrides `.env.local` for `next dev` only — it has no
effect on `next build`, `next start`, or anything deployed to Vercel.

## Why the S3 variables stay blank

There is currently no separate local/dev object-storage bucket in this
project — every populated `S3_*` value in `.env`, `.env.local`, and
`.env.production` points at the **same** real R2 bucket. Leaving
`S3_BUCKET_NAME` unset in `.env.development.local` is not a workaround; it
deliberately activates the fallback already built into `lib/s3.ts`, which
writes uploaded files under `public/uploads/` on disk when no bucket is
configured. That is the only genuinely local storage path this app has.

If real S3 upload behavior needs to be tested locally, that requires either
a dedicated non-Production bucket or explicit, deliberate use of
`.env.local` for that one run — never the default.

## The fail-fast guard

As a second, independent layer, `instrumentation.ts` calls
`assertNotDevelopmentAgainstProduction()` (`lib/devEnvGuard.ts`) once when
the server starts. If `NODE_ENV === 'development'` (i.e. `next dev`) and the
resolved `DATABASE_URL`/`DIRECT_URL`/`S3_BUCKET_NAME`/`S3_ENDPOINT` still
point at known Production hosts — meaning `.env.development.local` is
missing, incomplete, or was bypassed some other way — the server refuses to
start and prints an error naming which variables are the problem, e.g.:

```
Local development is configured to use Production services. Refusing to
start write-capable dev environment.
  - DATABASE_URL targets the Production database host
Fix: copy .env.development.local.example to .env.development.local and
fill in your local values — see docs/DEV_ENVIRONMENT_SAFETY.md.
```

The guard identifies Production by **hostname and bucket name only** — it
never reads, compares, or logs a full connection string, key, or secret. It
is a no-op for every `NODE_ENV` other than `development`, so it can never
affect `next build`, `next start`, or a Vercel Preview/Production
deployment.

## What this does not cover

- **Email (Resend).** The same Resend API key is currently present in
  `.env`, `.env.local`, and `.env.production` alike — this is not an env
  precedence bug (fixing `.env.local`'s precedence changes nothing here),
  and there is no local-fallback send path the way there is for S3. Local
  development can still send real email through the real Resend account.
  A separate, owner-provisioned test-mode key is needed to close this gap.
- **Stripe/Square.** Stripe is currently test-mode (`sk_test_…`) in every
  env file. Square is only configured in `.env` (sandbox); Production's env
  does not set it at all — live Square access is per-tenant OAuth stored in
  the database, not a global credential.
