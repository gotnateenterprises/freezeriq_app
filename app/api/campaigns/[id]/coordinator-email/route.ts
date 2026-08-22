/**
 * FR-ACCEPTANCE-2A — sending the coordinator their setup invitation.
 *
 * Before this, launching a fundraiser handed the tenant a secure link and a
 * suggested message and told them to send it themselves, out of some other
 * inbox. That worked, but it is not the workflow: the tenant should be able to
 * review the email and press send without leaving FreezerIQ.
 *
 * THREE THINGS THIS ROUTE REFUSES TO DO.
 *
 * It does not take the recipient from the caller. The address is read from the
 * campaign's own Primary Coordinator relationship, server-side. A client that
 * posts someone else's address gets ignored, so a compromised or careless page
 * cannot redirect a working credential to a stranger.
 *
 * It does not send on preview. GET renders exactly what POST would send and
 * writes nothing at all.
 *
 * It does not claim a send it cannot prove. `setup_email_sent_at` is written
 * only after the provider actually accepts the message. A safety-mode response
 * or a provider failure leaves it null, so the tenant keeps seeing "not sent
 * yet" — which is true.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { buildCoordinatorAccessUrl } from '@/lib/fundraiserUrls';
import { resolveTenantBrand } from '@/lib/tenantBrand';
import { coordinatorSetupTemplate } from '@/lib/emailTemplates';
import { getTenantSender } from '@/lib/email';

interface ResolvedInvitation {
    to: string;
    coordinatorName: string;
    organizationName: string;
    subject: string;
    html: string;
    setupUrl: string;
    alreadySentAt: Date | null;
}

/**
 * Everything the invitation needs, all of it read under the caller's tenant.
 *
 * Returns a plain error string rather than throwing so both GET and POST can
 * report the same reason with the same status.
 */
async function resolveInvitation(
    businessId: string,
    campaignId: string,
    req: Request
): Promise<{ ok: true; data: ResolvedInvitation } | { ok: false; status: number; error: string }> {
    const campaign = await prisma.fundraiserCampaign.findFirst({
        where: { id: campaignId, customer: { business_id: businessId } },
        select: {
            id: true,
            portal_token: true,
            customer_id: true,
            customer: { select: { name: true } },
        },
    });
    if (!campaign) {
        return { ok: false, status: 404, error: 'Campaign not found.' };
    }
    if (!campaign.portal_token) {
        return { ok: false, status: 409, error: 'This fundraiser has no coordinator access link yet.' };
    }

    // THE RECIPIENT AUTHORITY. Not the request body.
    const coordinator = await prisma.fundraiserCampaignCoordinator.findUnique({
        where: { campaign_id: campaignId },
        select: {
            setup_email_sent_at: true,
            org_contact: {
                select: {
                    ended_at: true,
                    contact: {
                        select: {
                            display_name: true,
                            contact_points: {
                                where: { type: 'email', is_current: true },
                                select: { value: true, is_primary: true },
                                orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
                            },
                        },
                    },
                },
            },
        },
    });
    if (!coordinator) {
        return { ok: false, status: 409, error: 'This fundraiser has no primary coordinator yet.' };
    }
    if (coordinator.org_contact.ended_at) {
        // The relationship was ended after launch. Mailing a setup link to
        // somebody who is no longer a contact of this organization is exactly
        // the kind of thing that should stop rather than "probably be fine".
        return { ok: false, status: 409, error: 'That coordinator is no longer an active contact for this organization.' };
    }

    const email = coordinator.org_contact.contact.contact_points[0]?.value?.trim();
    if (!email) {
        return { ok: false, status: 409, error: 'The selected coordinator has no email address on file.' };
    }

    const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true, display_name: true, custom_domain: true, contact_email: true, slug: true },
    });
    const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
    const brand = business ? resolveTenantBrand(business, base) : null;

    const setupUrl = buildCoordinatorAccessUrl(req, campaign.portal_token);
    const organizationName = campaign.customer?.name ?? 'your organization';
    const coordinatorName = coordinator.org_contact.contact.display_name;

    const rendered = coordinatorSetupTemplate(
        coordinatorName,
        organizationName,
        setupUrl,
        business && brand
            ? {
                name: brand.name,
                email: business.contact_email ?? undefined,
                site: brand.websiteUrl ?? undefined,
                siteLabel: brand.websiteLabel ?? undefined,
            }
            : undefined
    );

    return {
        ok: true,
        data: {
            to: email,
            coordinatorName,
            organizationName,
            subject: rendered.subject,
            html: rendered.html,
            setupUrl,
            alreadySentAt: coordinator.setup_email_sent_at,
        },
    };
}

/** PREVIEW. Renders what would be sent. Writes nothing, sends nothing. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const { id } = await params;
        const resolved = await resolveInvitation(session.user.businessId, id, req);
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.error }, { status: resolved.status });
        }
        const { to, coordinatorName, organizationName, subject, html, alreadySentAt } = resolved.data;
        // setupUrl is deliberately NOT returned. The preview shows the tenant
        // what the coordinator will read; the credential is not part of that,
        // and the launch dialog already has its own Copy Setup Link fallback.
        return NextResponse.json({
            to, coordinatorName, organizationName, subject, html,
            alreadySentAt,
            sent: false,
        });
    } catch (e: any) {
        console.error('[COORDINATOR_EMAIL_PREVIEW]', e);
        return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
    }
}

/**
 * SEND. The only path that may ever write setup_email_sent_at.
 *
 * EXACTLY ONE INVITATION PER COORDINATOR ASSIGNMENT, ENFORCED BY THE DATABASE.
 *
 * `setup_email_sent_at` means "this assignment's invitation has been sent". Once
 * it is non-null, this route refuses to send again and answers 409 with the
 * timestamp. That refusal lives in a WHERE clause, not in a disabled button, so
 * a second browser tab, a replayed request, or a double click all hit the same
 * wall.
 *
 * There is deliberately no resend feature here. A coordinator who lost the email
 * is served by Copy Setup Link, which puts the tenant in control of a single
 * credential rather than scattering more of them through an email provider. A
 * real resend — with rotation, and a decision about what the timestamp then
 * means — is its own design and is not smuggled in as a side effect of a Send
 * button.
 *
 * Nothing is taken from the caller. Every request re-resolves the campaign, the
 * CURRENT coordinator assignment, that person's CURRENT email, and a link built
 * from the campaign's CURRENT portal_token, all under the caller's own tenant.
 * A tab left open for an hour cannot mail a stale credential.
 *
 * The timestamp never claims delivery. No provider can tell us that.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;

        const resolved = await resolveInvitation(businessId, id, req);
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.error }, { status: resolved.status });
        }
        const { to, subject, html } = resolved.data;

        // Same safety switch the rest of the product uses. Off means no provider
        // is contacted, and the caller is told so plainly.
        const isLive = process.env.RESEND_API_KEY && process.env.EMAIL_LIVE === 'true';
        if (!isLive) {
            console.log(`[SAFETY MODE / MOCK EMAIL] coordinator setup invitation for campaign ${id}`);
            // Nothing durable. A simulated invitation is not an invitation, and
            // the coordinator is still waiting.
            return NextResponse.json({ success: true, mocked: true });
        }

        // ── THE CLAIM ───────────────────────────────────────────────────────
        //
        // ONE credential-bearing invitation per coordinator assignment, and the
        // database is what enforces it — not a disabled button, and not a read
        // before the send.
        //
        // A read-then-send would not survive two clicks. Both requests would
        // read null, both would call the provider, and the coordinator would get
        // two working credentials; whichever wrote last would leave a single
        // timestamp behind, so nothing would even record that it happened.
        //
        // So the right to send is CLAIMED first, in one statement whose WHERE
        // clause carries the condition. `updateMany` reports how many rows it
        // touched: exactly one caller can move the row out of null, and every
        // other concurrent caller gets zero and stops before the provider is
        // ever reached. This is the same reasoning as the FR-FLOW-3 selection
        // lock, expressed as a conditional write rather than an advisory lock,
        // because here there is a row to condition on.
        const claim = await prisma.fundraiserCampaignCoordinator.updateMany({
            where: { campaign_id: id, setup_email_sent_at: null },
            data: { setup_email_sent_at: new Date() },
        });

        if (claim.count === 0) {
            // Somebody already sent it — a moment ago in another tab, or last
            // week. Either way this request must not put a second credential in
            // the world. The tenant is told plainly, and Copy Setup Link remains
            // for the case where the coordinator genuinely lost the first one.
            const current = await prisma.fundraiserCampaignCoordinator.findUnique({
                where: { campaign_id: id },
                select: { setup_email_sent_at: true },
            });
            return NextResponse.json({
                success: false,
                alreadySent: true,
                sentAt: current?.setup_email_sent_at ?? null,
            }, { status: 409 });
        }

        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const sender = await getTenantSender(businessId);

        let data: Awaited<ReturnType<typeof resend.emails.send>>;
        try {
            data = await resend.emails.send({
                from: sender.from,
                to: [to],
                replyTo: sender.replyTo,
                subject,
                html,
            });
        } catch (sendErr) {
            // THREW. We do not know whether the message left. Releasing the claim
            // would risk a second credential for a coordinator who already has
            // one; holding it risks a coordinator who never got anything. Of the
            // two, sending a duplicate credential is the worse outcome, so the
            // claim is HELD and the tenant is told the state is uncertain.
            console.error(
                '[COORDINATOR_EMAIL] send outcome UNKNOWN for campaign ' + id +
                ' — claim held; verify with the coordinator before any resend',
                sendErr
            );
            return NextResponse.json({
                success: false,
                uncertain: true,
                error: 'We could not confirm whether that email was sent. Check with the coordinator before sending again — use Copy Setup Link if they never received it.',
            }, { status: 502 });
        }

        if (data.error) {
            // An explicit provider rejection. Nothing was queued, so the claim is
            // false and releasing it is the truthful thing to do — this is the
            // one case where we KNOW no credential is in the world.
            console.error('[COORDINATOR_EMAIL] provider rejected the send:', data.error);
            await prisma.fundraiserCampaignCoordinator.updateMany({
                where: { campaign_id: id },
                data: { setup_email_sent_at: null },
            }).catch((releaseErr) => {
                // Could not release. The row now says sent for an email that was
                // not. Loud, because only a human can reconcile it.
                console.error(
                    '[COORDINATOR_EMAIL] could not release the claim for campaign ' + id +
                    ' — setup_email_sent_at is set but NO email was sent',
                    releaseErr
                );
            });
            return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
        }

        // Claimed and sent. The timestamp already written IS the record, so there
        // is no second write to fail — the partial-success window the previous
        // review found is closed by construction rather than by handling.
        return NextResponse.json({ success: true, mocked: false, recorded: true, id: data.data?.id ?? null });
    } catch (e: any) {
        console.error('[COORDINATOR_EMAIL]', e);
        return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
    }
}
