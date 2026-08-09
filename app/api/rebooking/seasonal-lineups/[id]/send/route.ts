/**
 * FR-RETENTION-3 — controlled test send and CTA-gated real send.
 *
 *   POST { mode: 'test',  testAddress? } → one test email to an authorized
 *                                          destination. Never a coordinator.
 *   POST { mode: 'real' }               → the real audience send.
 *
 * THE SEND GATES: a real send is refused server-side unless a rebooking link can
 * be built AND the platform sender is configured. These are structured readiness
 * conditions, not disabled buttons — an API client bypassing the UI is refused
 * identically.
 *
 * FR-RETENTION-4 — the rebooking credential is minted PER RECIPIENT, inside the
 * send loop, after that recipient's delivery attempt has been claimed. The raw
 * token exists only in the local variable that renders one email; only its
 * SHA-256 digest is written to the database, and neither the token nor the
 * finished URL is logged.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { getTenantSender } from '@/lib/email';
import { renderSeasonalUpdate, resolveRebookingCta, checkSenderReadiness } from '@/lib/outreachMessage';
import { ResendOutreachProvider } from '@/lib/outreachProvider';
import { runSend, type SendableRecipient } from '@/lib/outreachSend';
import { mintRebookingToken } from '@/lib/rebookingToken';
import { buildRebookingUrl, resolveRequestOrigin } from '@/lib/fundraiserUrls';

function isPlausible(email: string): boolean {
    const v = email.trim();
    if (!v || /\s/.test(v)) return false;
    const at = v.indexOf('@');
    if (at <= 0 || at !== v.lastIndexOf('@')) return false;
    const d = v.slice(at + 1);
    return d.includes('.') && !d.startsWith('.') && !d.endsWith('.');
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const { id } = await ctx.params;

        const body = await req.json().catch(() => ({}));
        const mode: 'test' | 'real' = body.mode === 'real' ? 'real' : 'test';

        const lineup = await prisma.seasonalOffering.findFirst({
            where: { id, business_id: businessId },
            select: { id: true, name: true, starts_at: true, ends_at: true },
        });
        if (!lineup) return NextResponse.json({ error: 'Seasonal lineup not found' }, { status: 404 });

        const batch = await prisma.outreachBatch.findFirst({
            where: { business_id: businessId, seasonal_offering_id: id },
            select: { id: true, status: true },
        });
        if (!batch) return NextResponse.json({ error: 'Review the audience before sending.' }, { status: 400 });

        const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } });
        const sender = await getTenantSender(businessId);
        const cta = resolveRebookingCta(req);

        // ── TEST SEND ────────────────────────────────────────────────────────
        if (mode === 'test') {
            // Only the authenticated user's own address, or an address they
            // explicitly typed. A fundraiser recipient address is never
            // substituted here.
            const typed = typeof body.testAddress === 'string' ? body.testAddress.trim() : '';
            const destination = typed || session.user.email || '';
            if (!destination || !isPlausible(destination)) {
                return NextResponse.json({ errors: ['Enter a valid email address to send the test to.'] }, { status: 400 });
            }

            const rendered = renderSeasonalUpdate({
                tenantName: business.name,
                organizationNames: ['Your organization'],
                lineupName: lineup.name,
                lineupStartsAt: lineup.starts_at,
                lineupEndsAt: lineup.ends_at,
                hasPreviousFundraiser: true,
                previousCampaignName: null,
                cta,
                isTest: true,   // adds the visible TEST banner and subject prefix
            });

            const provider = new ResendOutreachProvider();
            const result = await provider.send({
                to: destination, subject: rendered.subject, html: rendered.html, text: rendered.text,
                from: sender.from, replyTo: sender.replyTo,
            });

            if (result.outcome === 'failed') {
                return NextResponse.json({ ok: false, error: result.detail }, { status: 502 });
            }

            // Deliberately NOT recorded as an EmailDeliveryAttempt against any
            // OutreachRecipient — a test is not a coordinator delivery.
            return NextResponse.json({
                ok: true,
                mode: 'test',
                // "accepted", never "delivered".
                providerAccepted: true,
                destinationCategory: typed ? 'typed test address' : 'signed-in user',
            });
        }

        // ── REAL SEND ────────────────────────────────────────────────────────
        // TWO independent gates, both server-side, both BEFORE any provider
        // call. A real fundraiser send requires each of them.

        // Gate 1 — a rebooking link must be buildable.
        if (!cta.ready) {
            return NextResponse.json({
                ok: false,
                blocked: true,
                reason: cta.blockedReason,
            }, { status: 409 });
        }

        // Gate 2 — the platform sender must be configured for production, not
        // the provider's shared development address.
        const senderReadiness = checkSenderReadiness(process.env.EMAIL_FROM);
        if (!senderReadiness.ready) {
            return NextResponse.json({
                ok: false,
                blocked: true,
                reason: senderReadiness.blockedReason,
            }, { status: 409 });
        }

        const message = await prisma.outreachMessage.findFirst({
            where: { business_id: businessId, outreach_batch_id: batch.id },
            select: { id: true, approved_at: true, version: true },
        });
        if (!message) return NextResponse.json({ error: 'Approve the email before sending.' }, { status: 400 });
        if (!message.approved_at) return NextResponse.json({ error: 'Approve the email before sending.' }, { status: 400 });
        if (batch.status !== 'audience_ready') {
            return NextResponse.json({ error: 'Review the audience before sending.' }, { status: 400 });
        }

        // Frozen snapshot only — recipients are never recalculated at send time.
        const rows = await prisma.outreachRecipient.findMany({
            where: {
                business_id: businessId, outreach_batch_id: batch.id,
                eligibility: 'included', is_selected: true, normalized_email: { not: null },
            },
            select: {
                id: true, normalized_email: true, display_name: true,
                contacts: { select: { contact_id: true } },
                orgs: { select: { organization_name: true } },
            },
        });

        const recipients: SendableRecipient[] = rows.map((r) => ({
            recipientId: r.id,
            normalizedEmail: r.normalized_email,
            displayName: r.display_name,
            contactIds: r.contacts.map((c) => c.contact_id),
            organizationNames: r.orgs.map((o) => o.organization_name),
        }));

        await prisma.outreachBatch.update({ where: { id: batch.id }, data: { status: 'sending' } });
        await prisma.outreachMessage.update({ where: { id: message.id }, data: { status: 'sending', send_started_at: new Date() } });

        // Gate 1 already proved this resolves; re-resolving here keeps the
        // non-null assertion honest rather than assumed.
        const origin = resolveRequestOrigin(req)!;

        const summary = await runSend({
            prisma, provider: new ResendOutreachProvider(),
            businessId, batchId: batch.id, messageId: message.id, generation: message.version,
            recipients,
            render: async (r) => {
                // ── MINT ─────────────────────────────────────────────────────
                // Runs once this recipient's attempt is claimed, so we know the
                // email is really going out. `raw` never leaves this closure:
                // it goes into one email body and is then unreachable. Only the
                // digest is persisted.
                //
                // Re-minting deliberately REPLACES any earlier digest for this
                // recipient. Only recipients without a live attempt reach this
                // point, so no link that someone already received is revoked by
                // a retry — but a link minted for a delivery that then failed is
                // correctly invalidated rather than left live and unreachable.
                const minted = mintRebookingToken();
                await prisma.outreachRecipient.update({
                    where: { id: r.recipientId },
                    data: {
                        rebooking_token_hash: minted.hash,
                        rebooking_token_issued_at: minted.issuedAt,
                        rebooking_token_expires_at: minted.expiresAt,
                        rebooking_token_revoked_at: null,
                        refresh_requested_at: null,
                    },
                });

                return renderSeasonalUpdate({
                    tenantName: business.name,
                    organizationNames: r.organizationNames,
                    lineupName: lineup.name,
                    lineupStartsAt: lineup.starts_at,
                    lineupEndsAt: lineup.ends_at,
                    hasPreviousFundraiser: true,
                    previousCampaignName: null,
                    cta: { ...cta, url: buildRebookingUrl(origin, minted.raw) },
                });
            },
            from: sender.from, replyTo: sender.replyTo, now: new Date(),
        });

        await prisma.outreachBatch.update({ where: { id: batch.id }, data: { status: summary.batchStatus } });
        await prisma.outreachMessage.update({
            where: { id: message.id },
            data: {
                status: summary.batchStatus === 'completed' ? 'sent'
                    : summary.batchStatus === 'completed_with_issues' ? 'sent_with_issues' : 'failed',
                send_completed_at: new Date(),
            },
        });

        return NextResponse.json({
            ok: true, mode: 'real',
            sent: summary.accepted, couldNotSend: summary.failed, skipped: summary.skipped,
            outcome: summary.batchStatus,
        });
    } catch (e) {
        console.error('[Outreach send] failed:', e);
        return NextResponse.json({ error: 'Sending failed' }, { status: 500 });
    }
}
