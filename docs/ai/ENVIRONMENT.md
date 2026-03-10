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

### QuickBooks
| Variable | Owner | Purpose |
|----------|-------|---------|
| `QBO_CLIENT_ID` | Platform | OAuth client ID |
| `QBO_CLIENT_SECRET` | Platform | OAuth client secret |
| `QBO_REDIRECT_URI` | Platform | OAuth callback |

## Rules
1. Missing secrets must fail loudly in production paths
2. Test vs live values must never be mixed
3. New env vars must be documented here with owner and purpose before being added to code
4. Variable names must be standardized (no ad-hoc naming)
