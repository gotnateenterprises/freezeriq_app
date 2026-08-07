/**
 * FR-RETENTION-2 — marketing preferences.
 *
 * POST — record a preference change for durable contacts.
 *
 * The only action this checkpoint's UI needs is "Re-subscribe with permission",
 * which is deliberately NOT a one-click reset:
 *   · the tenant must confirm explicitly,
 *   · a written permission note is required,
 *   · and every change appends an immutable EmailSuppressionEvent.
 *
 * Opt-out follows the PERSON and survives an email change, so re-subscribing
 * clears the contact-scoped preference rather than the address. Where an
 * address itself was suppressed, that is recorded separately and is not lifted
 * by re-subscribing one individual.
 *
 * Sends no email. Issues no token.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

type Action = 'resubscribe' | 'unsubscribe' | 'pause' | 'not_interested';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const userId = (session.user as { id?: string }).id ?? null;

        const body = await req.json();
        const action: Action = body.action;
        const contactIds: string[] = Array.isArray(body.contactIds) ? body.contactIds : [];
        const permissionNote: string = (body.permissionNote ?? '').trim();
        const until: Date | null = body.until ? new Date(body.until) : null;

        if (!['resubscribe', 'unsubscribe', 'pause', 'not_interested'].includes(action)) {
            return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
        }
        if (contactIds.length === 0) {
            return NextResponse.json({ errors: ['No contacts were selected.'] }, { status: 400 });
        }
        if (action === 'resubscribe' && permissionNote.length === 0) {
            return NextResponse.json(
                { errors: ['Add a note explaining when and how they gave permission.'] },
                { status: 400 },
            );
        }

        // Every referenced contact must belong to this tenant. A client-supplied
        // id from another business simply will not match.
        const owned = await prisma.fundraiserContact.findMany({
            where: { business_id: businessId, id: { in: contactIds } },
            select: { id: true },
        });
        if (owned.length !== contactIds.length) {
            return NextResponse.json({ error: 'One or more contacts were not found' }, { status: 404 });
        }

        const status = action === 'resubscribe' ? 'subscribed'
            : action === 'unsubscribe' ? 'unsubscribed'
                : action === 'pause' ? 'paused' : 'not_interested';

        const eventType = action === 'resubscribe' ? 'resubscribe'
            : action === 'unsubscribe' ? 'unsubscribe'
                : action === 'pause' ? 'tenant_pause' : 'not_interested_until';

        await prisma.$transaction(async (tx) => {
            for (const contactId of contactIds) {
                const existing = await tx.marketingPreference.findFirst({
                    where: { business_id: businessId, scope: 'contact', contact_id: contactId },
                    select: { id: true },
                });

                if (existing) {
                    await tx.marketingPreference.update({
                        where: { id: existing.id },
                        data: {
                            status,
                            effective_at: new Date(),
                            effective_until: action === 'resubscribe' || action === 'unsubscribe' ? null : until,
                            permission_note: action === 'resubscribe' ? permissionNote : null,
                            recorded_by_user_id: userId,
                            source: 'tenant',
                        },
                    });
                } else {
                    await tx.marketingPreference.create({
                        data: {
                            business_id: businessId,
                            scope: 'contact',
                            contact_id: contactId,
                            status,
                            effective_until: action === 'resubscribe' || action === 'unsubscribe' ? null : until,
                            permission_note: action === 'resubscribe' ? permissionNote : null,
                            recorded_by_user_id: userId,
                            source: 'tenant',
                        },
                    });
                }

                // Append-only history — never updated, never deleted.
                await tx.emailSuppressionEvent.create({
                    data: {
                        business_id: businessId,
                        event_type: eventType,
                        contact_id: contactId,
                        reason: action === 'resubscribe' ? 'Re-subscribed with documented permission' : null,
                        effective_until: action === 'resubscribe' || action === 'unsubscribe' ? null : until,
                        permission_note: action === 'resubscribe' ? permissionNote : null,
                        recorded_by_user_id: userId,
                        source: 'tenant',
                    },
                });
            }
        });

        return NextResponse.json({ ok: true, updated: contactIds.length });
    } catch (e) {
        console.error('[Marketing Preferences] POST failed:', e);
        return NextResponse.json({ error: 'Failed to update marketing preferences' }, { status: 500 });
    }
}
