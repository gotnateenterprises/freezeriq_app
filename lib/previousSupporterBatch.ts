/**
 * FR-REBOOK-2 — the campaign-owned outreach batch, and the durable rows the
 * send engine needs underneath it.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * Everything that stops a double-clicked Send from mailing people twice lives in
 * EmailDeliveryAttempt, and that row cannot exist without a batch, a message and
 * a recipient. Migration 18 gave the batch a second owner kind so a fundraiser
 * invitation has somewhere to live; this module is what actually puts it there.
 *
 * ── WHY NOT upsert ──────────────────────────────────────────────────────────
 *
 * The obvious call is:
 *
 *     prisma.outreachBatch.upsert({ where: { campaign_id }, ... })
 *
 * It does not compile and would not work. "One batch per campaign" is a PARTIAL
 * unique index in raw SQL (outreach_batches_one_per_campaign, WHERE campaign_id
 * IS NOT NULL); Prisma cannot express a predicate, so the model deliberately
 * declares no unique on campaign_id and offers no such selector. Declaring one
 * anyway — an earlier draft did — makes upsert a runtime crash (42P10) and makes
 * `migrate dev` want to create an index that should not exist.
 *
 * So the race is handled explicitly: read, try to create, and if the database
 * says someone else won, re-read theirs. See resolveCampaignBatch.
 *
 * ── WHY EXPLICIT SCALARS, NEVER NESTED connect ──────────────────────────────
 *
 * OutreachBatch now has four relations sharing scalars — business_id appears in
 * three, customer_id in two. With nested `connect`, the LAST relation in the
 * object literal wins the shared column, so a batch can silently land under a
 * different organization than the caller named. Postgres would still refuse an
 * inconsistent row, but a *consistent and wrong* one is worse than an error.
 * Every write here names business_id, customer_id, campaign_id and an explicit
 * null seasonal_offering_id, and there is no connect anywhere in this file.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import type { PreviousSupporter } from '@/lib/previousSupporters';

/** Server-derived ownership. Never assembled from request input. */
export interface CampaignBatchOwner {
    businessId: string;
    customerId: string;
    campaignId: string;
}

export type BatchResolution = 'created' | 'reused' | 'reused_after_race';

export interface ResolvedCampaignBatch {
    id: string;
    how: BatchResolution;
}

/** Prisma's unique-violation code. */
function isUniqueViolation(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2002';
}

/**
 * The owner shape Migration 18's CHECK will accept, verified BEFORE the insert.
 *
 * A CHECK rejection surfaces through Prisma as PrismaClientUnknownRequestError
 * with no error code at all, so it cannot be caught and explained downstream —
 * and it must never be mistaken for the P2002 race. Refusing early keeps the
 * failure legible.
 */
export function assertFundraiserOwnerShape(owner: CampaignBatchOwner): void {
    for (const [k, v] of Object.entries(owner)) {
        if (typeof v !== 'string' || !v.trim()) {
            throw new Error(`campaign batch owner is incomplete: ${k}`);
        }
    }
}

/**
 * THE batch for this campaign — created once, then reused forever.
 *
 * Concurrency contract, which is the whole point:
 *
 *   A: findFirst -> none      B: findFirst -> none
 *   A: create    -> wins      B: create    -> P2002 on one_per_campaign
 *                             B: re-read   -> A's batch
 *
 * Both requests come back holding the SAME batch id, so the per-recipient
 * delivery guard downstream is looking at one set of attempts rather than two
 * parallel universes.
 *
 * A P2002 from anything OTHER than the campaign race is rethrown. Treating every
 * unique violation as "someone beat me to it" would swallow real bugs and then
 * fail confusingly on a re-read that finds nothing.
 */
export async function resolveCampaignBatch(
    prisma: PrismaClient | Prisma.TransactionClient,
    owner: CampaignBatchOwner,
): Promise<ResolvedCampaignBatch> {
    assertFundraiserOwnerShape(owner);

    const find = () => prisma.outreachBatch.findFirst({
        where: {
            business_id: owner.businessId,
            customer_id: owner.customerId,
            campaign_id: owner.campaignId,
        },
        select: { id: true },
    });

    const existing = await find();
    if (existing) return { id: existing.id, how: 'reused' };

    try {
        const created = await prisma.outreachBatch.create({
            data: {
                // Explicit scalars only — see the header on nested connect.
                business_id: owner.businessId,
                customer_id: owner.customerId,
                campaign_id: owner.campaignId,
                seasonal_offering_id: null,
                status: 'audience_ready',
            },
            select: { id: true },
        });
        return { id: created.id, how: 'created' };
    } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // Someone else created it between our read and our write.
        const winner = await find();
        if (!winner) {
            // A unique violation that is NOT the campaign race — a different
            // constraint fired, and pretending otherwise would hide it.
            throw e;
        }
        return { id: winner.id, how: 'reused_after_race' };
    }
}

/**
 * The recipient rows the delivery chain hangs off, one per reachable supporter.
 *
 * Snapshot semantics, matching the seasonal audience: a recipient row records
 * who this batch was calculated for. Re-running reuses the existing rows rather
 * than duplicating them — outreach_recipients_batch_one_email (PARTIAL, WHERE
 * normalized_email IS NOT NULL) is the database's half of that promise, and the
 * read-first here is the cheap half.
 *
 * Only REACHABLE supporters get a row. Someone with no address, or suppressed,
 * is not a delivery target and inventing a row for them would put a permanent
 * "excluded" record in the audit trail for a person who was never in the
 * audience.
 */
export async function syncCampaignRecipients(
    prisma: PrismaClient | Prisma.TransactionClient,
    input: { businessId: string; batchId: string; supporters: readonly PreviousSupporter[] },
): Promise<{ recipientId: string; normalizedEmail: string; displayName: string }[]> {
    const reachable = input.supporters.filter((s) => s.reachable && s.email);

    const existing = await prisma.outreachRecipient.findMany({
        where: { business_id: input.businessId, outreach_batch_id: input.batchId },
        select: { id: true, normalized_email: true, display_name: true },
    });
    const byEmail = new Map(existing.filter((r) => r.normalized_email).map((r) => [r.normalized_email as string, r]));

    const out: { recipientId: string; normalizedEmail: string; displayName: string }[] = [];
    for (const s of reachable) {
        const email = s.email as string;
        const hit = byEmail.get(email);
        if (hit) {
            out.push({ recipientId: hit.id, normalizedEmail: email, displayName: hit.display_name });
            continue;
        }
        try {
            const created = await prisma.outreachRecipient.create({
                data: {
                    business_id: input.businessId,
                    outreach_batch_id: input.batchId,
                    normalized_email: email,
                    display_name: s.displayName,
                    eligibility: 'included',
                    represented_contact_count: 1,
                    represented_org_count: 0,
                },
                select: { id: true },
            });
            out.push({ recipientId: created.id, normalizedEmail: email, displayName: s.displayName });
        } catch (e) {
            if (!isUniqueViolation(e)) throw e;
            // Concurrent snapshot won this address; take theirs.
            const winner = await prisma.outreachRecipient.findFirst({
                where: { business_id: input.businessId, outreach_batch_id: input.batchId, normalized_email: email },
                select: { id: true, display_name: true },
            });
            if (!winner) throw e;
            out.push({ recipientId: winner.id, normalizedEmail: email, displayName: winner.display_name });
        }
    }
    return out;
}

/**
 * The batch's message row — one per batch, enforced by @@unique on
 * outreach_batch_id.
 *
 * The coordinator's approved wording is stored so a later question of "what did
 * we actually send" has an answer. It is UPDATED rather than duplicated on a
 * second send, and `version` advances, which is what runSend's idempotency key
 * uses as its generation: re-approving different wording is deliberately a new
 * generation, while re-sending the same message is not.
 */
export async function resolveCampaignMessage(
    prisma: PrismaClient | Prisma.TransactionClient,
    input: { businessId: string; batchId: string; subject: string; html: string; text: string },
): Promise<{ id: string; version: number }> {
    const existing = await prisma.outreachMessage.findFirst({
        where: { business_id: input.businessId, outreach_batch_id: input.batchId },
        select: { id: true, version: true, subject: true, text_body: true },
    });

    if (!existing) {
        const created = await prisma.outreachMessage.create({
            data: {
                business_id: input.businessId,
                outreach_batch_id: input.batchId,
                subject: input.subject,
                html_body: input.html,
                text_body: input.text,
                status: 'approved',
                approved_at: new Date(),
            },
            select: { id: true, version: true },
        });
        return created;
    }

    // Same wording, same generation — a retry of the same send must NOT look
    // like a new one, or the idempotency key changes and everyone is mailed
    // again.
    const unchanged = existing.subject === input.subject && existing.text_body === input.text;
    const updated = await prisma.outreachMessage.update({
        where: { id: existing.id },
        data: {
            subject: input.subject,
            html_body: input.html,
            text_body: input.text,
            status: 'approved',
            approved_at: new Date(),
            ...(unchanged ? {} : { version: { increment: 1 } }),
        },
        select: { id: true, version: true },
    });
    return updated;
}
