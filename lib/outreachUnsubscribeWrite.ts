/**
 * OUTREACH-CONSENT-1 — recording a recipient's opt-out.
 *
 * ── AUTHORITY COMES FROM THE TOKEN, NEVER THE REQUEST ───────────────────────
 *
 * This function takes a resolved token payload, not a request body. There is no
 * parameter through which a caller can name an email address, a tenant, a scope
 * or a status — so the public endpoint cannot be turned into "suppress anyone,
 * anywhere" by editing a form field. The only thing a caller may do is present a
 * token and have the address inside it opted out.
 *
 * ── IT FOLLOWS THE EXISTING SCHEMA, IT DOES NOT INVENT ONE ──────────────────
 *
 * Verified against the schema and against the tenant-facing writer at
 * app/api/rebooking/marketing-preferences/route.ts:
 *
 *   · MarketingPreference is a ONE-CURRENT-ROW model — that route reads, then
 *     updates or creates. It does not append. So does this.
 *   · scope `email_address` with `normalized_email` is a real member of
 *     MarketingPreferenceScope, and is one of the two shapes
 *     checkSuppressionAtSend already queries. The other is `contact`, which is
 *     wrong here: an unsubscribing supporter is an ADDRESS we mailed, not
 *     necessarily a durable FundraiserContact row, and most supporters have no
 *     contact record at all.
 *   · status `unsubscribed` and `effective_until: null` — an opt-out does not
 *     lapse. `paused` and `not_interested` are the ones that carry an end date.
 *   · source `contact_request` is a real member of PreferenceSource and is the
 *     only one that means "the person themselves asked". `tenant` would falsely
 *     credit the business with a decision the recipient made.
 *   · EmailSuppressionEvent gets an append-only `unsubscribe` row beside it,
 *     exactly as the tenant-facing writer appends its history.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 *
 * Unsubscribing twice is success, not an error, and does not accumulate
 * preference rows. A mailbox provider's one-click POST can be retried, a
 * frustrated person can press the button five times, and the durable result is
 * identical.
 */

import type { PrismaClient } from '@prisma/client';
import type { UnsubscribeTokenPayload } from '@/lib/outreachUnsubscribeToken';

export interface UnsubscribeWriteResult {
    /** True when this call is what turned it off; false when it already was. */
    changed: boolean;
    alreadyUnsubscribed: boolean;
}

/** Postgres unique violation, as Prisma reports it. */
function isUniqueViolation(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2002';
}

/**
 * ── THE RACE THIS SURVIVES ──────────────────────────────────────────────────
 *
 * `marketing_preferences_one_per_email` is a PARTIAL unique index created in raw
 * SQL — invisible to Prisma, and therefore easy to forget:
 *
 *     UNIQUE (business_id, normalized_email) WHERE scope = 'email_address'
 *
 * The read-then-write below is not atomic against it. Two unsubscribes for the
 * same address at once — a mailbox provider's one-click POST retrying, or a
 * frustrated person double-pressing — both find no row and both insert, and the
 * loser gets a unique violation. Untreated, the person who IS now unsubscribed
 * would be told "Something went wrong", which is the worst possible moment to
 * lie to someone about whether they got out.
 *
 * Postgres aborts the entire transaction on a unique violation, so the recovery
 * cannot happen inside it. The whole unit is retried once instead: the second
 * attempt sees the winner's row and takes the update path, or short-circuits on
 * already-unsubscribed. One retry is enough — after a successful insert the row
 * exists permanently, so the race cannot recur.
 */
export async function recordUnsubscribe(
    prisma: PrismaClient,
    payload: UnsubscribeTokenPayload,
    now: Date = new Date(),
): Promise<UnsubscribeWriteResult> {
    try {
        return await writeUnsubscribeOnce(prisma, payload, now);
    } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        return writeUnsubscribeOnce(prisma, payload, now);
    }
}

async function writeUnsubscribeOnce(
    prisma: PrismaClient,
    payload: UnsubscribeTokenPayload,
    now: Date,
): Promise<UnsubscribeWriteResult> {
    const { businessId, normalizedEmail } = payload;

    return prisma.$transaction(async (tx) => {
        const existing = await tx.marketingPreference.findFirst({
            where: {
                business_id: businessId,
                scope: 'email_address',
                normalized_email: normalizedEmail,
            },
            select: { id: true, status: true },
        });

        if (existing?.status === 'unsubscribed') {
            // Already off. No write, no second history row — repeated one-click
            // POSTs must not turn into a growing pile of identical events.
            return { changed: false, alreadyUnsubscribed: true };
        }

        if (existing) {
            await tx.marketingPreference.update({
                where: { id: existing.id },
                data: {
                    status: 'unsubscribed',
                    effective_at: now,
                    // An opt-out has no end date; clearing this matters when the
                    // previous row was a time-boxed pause.
                    effective_until: null,
                    permission_note: null,
                    // The recipient acted, not a logged-in user.
                    recorded_by_user_id: null,
                    source: 'contact_request',
                },
            });
        } else {
            await tx.marketingPreference.create({
                data: {
                    business_id: businessId,
                    scope: 'email_address',
                    normalized_email: normalizedEmail,
                    status: 'unsubscribed',
                    effective_at: now,
                    effective_until: null,
                    recorded_by_user_id: null,
                    source: 'contact_request',
                },
            });
        }

        await tx.emailSuppressionEvent.create({
            data: {
                business_id: businessId,
                event_type: 'unsubscribe',
                normalized_email: normalizedEmail,
                reason: 'Unsubscribed from an outreach email',
                effective_until: null,
                recorded_by_user_id: null,
                source: 'contact_request',
            },
        });

        return { changed: true, alreadyUnsubscribed: false };
    });
}
