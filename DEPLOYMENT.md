# 🚀 Deployment Guide for FreezerIQ

This guide covers how to deploy the FreezerIQ application to production.

## 📋 Prerequisites

Before deploying, ensure you have the following Environment Variables ready. These must be set in your hosting provider's dashboard (e.g., Vercel, Railway, or Docker environment).

### Required Environment Variables

| Variable | Description | Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | Connection string for your PostgreSQL database (e.g. Neon, Supabase, Railway) | `postgresql://user:pass@host:5432/db` |
| `NEXTAUTH_SECRET` | Random string for session encryption. Generate with `openssl rand -base64 32` | `complex_random_string` |
| `NEXTAUTH_URL` | The canonical URL of your deployed site | `https://your-app.vercel.app` |

### Optional Integrations

| Variable | Description |
| :--- | :--- |
| `OPENAI_API_KEY` | For AI content generation features |
| `GOOGLE_GEMINI_API_KEY` | For AI content generation features |
| `SQUARE_ACCESS_TOKEN` | For integration with Square POS |

---

## ☁️ Option 1: Deploy to Vercel (Recommended)

Vercel is the creators of Next.js and offers the easiest deployment experience.

1.  **Push your code to GitHub/GitLab/Bitbucket.**
2.  **Import the Project** in Vercel Dashboard.
3.  **Configure Project**:
    *   **Framework Preset**: Next.js
    *   **Root Directory**: `./`
4.  **Environment Variables**: Paste the variables listed above.
5.  **Deploy**: Click "Deploy". Vercel will build and launch your app.

### Database Migrations on Vercel
To ensure your database is up to date, modify the "Build Command" in Vercel settings or add a `postinstall` script in `package.json`:
`"postinstall": "prisma generate"`
And run migrations manually or via a separate job:
`npx prisma migrate deploy`

---

## 🐳 Option 2: Docker / Self-Hosted

The project includes a production-ready `Dockerfile`.

### 1. Build the Image
```bash
docker build -t freezeriq .
```

### 2. Run the Container
You must pass environment variables at runtime.

```bash
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e NEXTAUTH_SECRET="secret" \
  -e NEXTAUTH_URL="http://localhost:3000" \
  freezeriq
```

### 3. Database Migrations
The Docker container does **not** run migrations automatically on startup to prevent race conditions in scaled environments. You should run migrations as a separate step/job before deploying the new image:

```bash
# E.g. using a temporary container
docker run --rm -e DATABASE_URL="..." \
  freezeriq npx prisma migrate deploy
```

---

## 🛠️ Post-Deployment Setup

1.  **Log In**: Navigate to your new URL.
2.  **Initial Setup**: The first user referencing a specific `businessId` (if using multi-tenant) usually becomes admin, or you may need to seed your database.
3.  **Cron Jobs**: If using scheduled tasks (like daily order sync), configure a cron job to hit your API endpoints (e.g. `/api/cron/sync`) using a service like Vercel Cron or a separate worker.
