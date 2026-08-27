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
 * clears the contact-scoped preference.
 *
 * ── OUTREACH-RESUBSCRIBE-1 — AND THE ADDRESS, WHEN IT MAY ───────────────────
 *
 * That used to be ALL it cleared, and the original reasoning was sound: an
 * address suppression must not be lifted by re-subscribing one individual,
 * because a shared inbox belongs to everyone using it.
 *
 * OUTREACH-CONSENT-1 then made address-scope opt-outs something a RECIPIENT
 * creates by clicking Unsubscribe, and send time treats any unsubscribed row as
 * suppressing whatever its scope. So "Re-subscribe with permission" started
 * reporting success on people it could not actually restore — the drawer offered
 * the button on precisely the rows it was powerless to fix.
 *
 * Now the address is released too, but only when this request covers EVERY
 * contact in this tenant currently using it, so one person still cannot consent
 * for an inbox they share. Anything held back is reported rather than hidden.
 * See lib/outreachResubscribe.ts for the decision, which is pure and tested.
 *
 * Sends no email. Issues no token.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { normalizeEmail } from '@/lib/seasonalAudience';
import {
    decideAddressRelease,
    describeAddressRelease,
    type AddressReleaseDecision,
} from '@/lib/outreachResubscribe';

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

        // ── OUTREACH-RESUBSCRIBE-1 — WHICH ADDRESSES MAY BE RELEASED ────────
        //
        // Re-subscribing only the CONTACT used to be the whole story, and after
        // OUTREACH-CONSENT-1 that made this endpoint lie: the public unsubscribe
        // writes an `email_address` row, and checkSuppressionAtSend treats any
        // unsubscribed row as suppressing whatever its scope. The tenant was told
        // "re-subscribed" while the recipient stayed permanently unreachable, and
        // the drawer just re-rendered the same row with the same button.
        //
        // The original rule is kept where it earns its keep: a shared inbox is
        // NOT released on one person's say-so. Release happens only when this
        // request covers every contact in this tenant who currently uses that
        // address — which the audience drawer already does, since it sends every
        // contact grouped onto the row.
        const releases: AddressReleaseDecision[] = [];
        if (action === 'resubscribe') {
            const points = await prisma.fundraiserContactPoint.findMany({
                where: { business_id: businessId, type: 'email', is_current: true },
                select: { contact_id: true, normalized_value: true },
            });
            const ownership = points
                .map((p) => ({ contactId: p.contact_id, normalizedEmail: normalizeEmail(p.normalized_value ?? '') }))
                .filter((o) => o.normalizedEmail.length > 0);

            const targeted = new Set(
                ownership.filter((o) => contactIds.includes(o.contactId)).map((o) => o.normalizedEmail),
            );
            const addressPrefs = targeted.size
                ? await prisma.marketingPreference.findMany({
                    where: {
                        business_id: businessId,
                        scope: 'email_address',
                        normalized_email: { in: [...targeted] },
                    },
                    select: { id: true, normalized_email: true, status: true },
                })
                : [];

            releases.push(...decideAddressRelease({
                resubscribingContactIds: contactIds,
                ownership,
                addressPreferences: addressPrefs.map((p) => ({
                    normalizedEmail: p.normalized_email ?? '',
                    status: p.status as 'subscribed' | 'unsubscribed' | 'paused' | 'not_interested',
                })),
            }));
        }
        const releasable = new Set(
            releases.filter((r) => r.outcome === 'released').map((r) => r.normalizedEmail),
        );

        await prisma.$transaction(async (tx) => {
            // The address-scope opt-outs this re-subscribe is entitled to lift.
            // Updated, never deleted — EmailSuppressionEvent stays the immutable
            // history of what happened, and an audit trail that can be erased by
            // the next re-subscribe is not an audit trail.
            for (const email of releasable) {
                const row = await tx.marketingPreference.findFirst({
                    where: { business_id: businessId, scope: 'email_address', normalized_email: email },
                    select: { id: true },
                });
                if (row) {
                    await tx.marketingPreference.update({
                        where: { id: row.id },
                        data: {
                            status: 'subscribed',
                            effective_at: new Date(),
                            effective_until: null,
                            permission_note: permissionNote,
                            recorded_by_user_id: userId,
                            source: 'tenant',
                        },
                    });
                }
                await tx.emailSuppressionEvent.create({
                    data: {
                        business_id: businessId,
                        event_type: 'resubscribe',
                        normalized_email: email,
                        reason: 'Address re-subscribed with documented permission',
                        effective_until: null,
                        permission_note: permissionNote,
                        recorded_by_user_id: userId,
                        source: 'tenant',
                    },
                });
            }

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

        // The tenant is told what actually happened. A held-back shared address
        // is the case this endpoint used to hide, so it is named explicitly
        // rather than folded into a bare success.
        const summary = describeAddressRelease(releases);
        return NextResponse.json({
            ok: true,
            updated: contactIds.length,
            addressesReleased: summary.released,
            addressesHeldBack: summary.heldBack,
            warning: summary.warning,
        });
    } catch (e) {
        console.error('[Marketing Preferences] POST failed:', e);
        return NextResponse.json({ error: 'Failed to update marketing preferences' }, { status: 500 });
    }
}
