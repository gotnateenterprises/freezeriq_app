# FreezerIQ Environment Contract

> [!CAUTION]
> Do not read, modify, or copy `.env` files unless explicitly asked.
> This document describes the *contract* — what variables must exist and their purpose.

## Variable Categories

### Auth
| Variable | Owner | Purpose |
|----------|-------|---------|
| `AUTH_SECRET` | Platform | NextAuth session signing |
| `NEXTAUTH_URL` | Platform | Auth callback base URL |

### Database
| Variable | Owner | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | Platform | Supabase Postgres connection string |
| `DIRECT_URL` | Platform | Direct Postgres connection (bypasses pooler) |

### Platform Billing (Stripe)
| Variable | Owner | Purpose |
|----------|-------|---------|
| `STRIPE_SECRET_KEY` | Platform | Platform SaaS billing API key |
| `STRIPE_PUBLISHABLE_KEY` | Platform | Platform client-side Stripe |
| `STRIPE_WEBHOOK_SECRET` | Platform | Platform webhook verification |

> [!WARNING]
> These are the PLATFORM's Stripe credentials for SaaS subscription billing.
> Tenant payment processing uses tenant-stored connected account credentials.
> Mixing these is a critical bug per CONSTITUTION §9.

### Square Tenant Commerce
| Variable | Owner | Purpose |
|----------|-------|---------|
| `SQUARE_APP_ID` | Platform | Square Developer app ID (OAuth + Web Payments SDK) |
| `SQUARE_APP_SECRET` | Platform | Square Developer app secret (OAuth token exchange) |
| `SQUARE_ENVIRONMENT` | Platform | `sandbox` or `production` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Platform | Webhook subscription signature key from Square Developer Console |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | Platform | Webhook notification endpoint URL (must match Square subscription) |

> [!NOTE]
> These are **platform** credentials for FreezerIQ's Square Developer app.
> Tenant-specific Square tokens are obtained via OAuth and stored in the Integration table.
> This is tenant commerce infrastructure, NOT platform billing per CONSTITUTION §9.

### Storage (Cloudflare R2)
| Variable | Owner | Purpose |
|----------|-------|---------|
| `S3_ACCESS_KEY_ID` | Platform | R2 access key |
| `S3_SECRET_ACCESS_KEY` | Platform | R2 secret key |
| `S3_BUCKET_NAME` | Platform | R2 bucket name |
| `S3_ENDPOINT` | Platform | R2 endpoint URL |

> [!WARNING]
> S3_ACCESS_KEY_ID is currently misconfigured. See CONSTITUTION §5.

### Email
| Variable | Owner | Purpose |
|----------|-------|---------|
| `RESEND_API_KEY` | Platform | Transactional email sending |

### AI
| Variable | Owner | Purpose |
|----------|-------|---------|
| `OPENAI_API_KEY` | Platform | AI features (recipe generation, etc.) |

### SMS
| Variable | Owner | Purpose |
|----------|-------|---------|
| `TWILIO_ACCOUNT_SID` | Platform | SMS notifications |
| `TWILIO_AUTH_TOKEN` | Platform | Twilio auth |
| `TWILIO_PHONE_NUMBER` | Platform | Sending phone number |

### QuickBooks (QB-INVOICE-1A)
| Variable | Owner | Purpose |
|----------|-------|---------|
| `QBO_CLIENT_ID` | Platform | Intuit app OAuth client ID (Development keys locally; Production keys only once approved) |
| `QBO_CLIENT_SECRET` | Platform | Intuit app OAuth client secret — never logged, never in a URL |
| `QBO_ENVIRONMENT` | Platform | `sandbox` or `production`. Must be `sandbox` in local development and `production` on Vercel Production; any mismatch disables the connector |
| `QBO_REDIRECT_URI` | Platform | Exact callback. Local: `http://localhost:3000/api/integrations/quickbooks/callback`. Production: `https://www.freezeriqapp.com/api/integrations/quickbooks/callback`. Any other value disables the connector |
| `QBO_PRODUCTION_ENABLED` | Platform | Must be exactly `true` for Production to connect at all. Unset in QB-INVOICE-1A |
| `INTEGRATION_TOKEN_KEY` | Platform | Dedicated AES-256-GCM key material for integration credentials at rest: 32+ characters, no commas or newlines (a key containing either is refused). No fallback to any other secret |
| `INTEGRATION_TOKEN_KEY_PREVIOUS` | Platform | Optional, comma-separated retired keys, read-only; at most 4 are read (any beyond that are ignored). Replacing `INTEGRATION_TOKEN_KEY` without listing the old key here makes every stored QuickBooks connection unreadable. Rows move to the new key only when their access_token column is rewritten (connect/reconnect, successful refresh, any disconnect/revoked/expired tombstone); idle connections, transient refresh failures and already-disconnected rows do not. Follow the procedure in `docs/ai/QUICKBOOKS_INTEGRATION.md` ("Encryption-key rotation") |

The QuickBooks connector is **always disabled on Vercel Preview** (`VERCEL_ENV=preview`), because Preview shares the Production database. Never add `QBO_*` variables to the Preview environment. See `lib/quickbooks/config.ts`.

## Rules
1. Missing secrets must fail loudly in production paths
2. Test vs live values must never be mixed
3. New env vars must be documented here with owner and purpose before being added to code
4. Variable names must be standardized (no ad-hoc naming)
