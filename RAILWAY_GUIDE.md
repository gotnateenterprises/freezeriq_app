# Railway Deployment Guide for FreezerIQ

This guide will walk you through deploying your Next.js application to [Railway.app](https://railway.app).

## Prerequisites
1. A [Railway](https://railway.app) account.
2. Your code pushed to a GitHub repository.

## Step 1: Create a New Project on Railway
1. Go to your [Railway Dashboard](https://railway.app/dashboard).
2. Click **+ New Project**.
3. Select **Deploy from GitHub repo**.
4. Select your `freezeriq_app` repository.

## Step 2: Add PostgreSQL Database
1. Once the project is created, click **+ Add Service**.
2. Select **Database** -> **Add PostgreSQL**.
3. Railway will automatically create a database and provide a `DATABASE_URL` environment variable.

## Step 3: Configure Environment Variables
In your Railway project, go to the **Variables** tab for your app service and add the following:

| Variable | Description |
|---|---|
| `DATABASE_URL` | (Auto-populated by Railway if linked to Postgres) |
| `AUTH_SECRET` | Run `npx auth secret` locally to generate one. |
| `NEXTAUTH_URL` | Your Railway app URL (e.g., `https://freezer-iq.up.railway.app`). |
| `STRIPE_SECRET_KEY` | Your Stripe secret key (`sk_live_...` or `sk_test_...`). |
| `STRIPE_WEBHOOK_SECRET` | Required if using Stripe webhooks. |
| `SQUARE_ACCESS_TOKEN` | Your Square access token. |
| `OPENAI_API_KEY` | For AI recipe features. |
| `RESEND_API_KEY` | For email notifications. |
| `NODE_ENV` | Set to `production`. |

## Step 4: Database Migration
The first time you deploy, you need to push your local database schema to Railway:
1. Install the [Railway CLI](https://docs.railway.app/guides/cli) locally.
2. Run `railway login`.
3. Run `railway link`.
4. Run `npx prisma db push` to initialize the remote database.

## Step 5: Verify Deployment
1. Check the **Deployments** tab in Railway.
2. Once the status is `Active`, click the provided URL to view your live app.
3. Verify that you can log in (using your credentials from the local database if you migrated them, or by seeding a new admin).

> [!TIP]
> To seed an initial admin on the live database, you can run:
> `railway run npx tsx scripts/seed_admin.ts`
