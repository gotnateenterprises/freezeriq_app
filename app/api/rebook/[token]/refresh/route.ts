/**
 * FR-RETENTION-4 — "my link expired, please send me a new one".
 *
 * THE RULE THIS ENDPOINT EXISTS TO ENFORCE: a new link is NEVER auto-issued.
 * All this does is set a flag the tenant sees as "Needs action". No credential
 * is minted, no email is sent, and nothing about the expired link changes — an
 * endpoint that quietly reissued credentials to anyone holding an expired URL
 * would defeat expiry entirely.
 *
 * A REVOKED link deliberately cannot request a refresh. Revocation is a decision
 * the tenant made; letting the holder undo it with one tap would be worse than
 * useless.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveRebookingAccess } from '@/lib/rebookingAccess';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
    try {
        const { token } = await ctx.params;
        const now = new Date();
        const { state, context } = await resolveRebookingAccess(token, now);

        if (!context) return NextResponse.json({ ok: false, state: 'invalid' }, { status: 404 });

        // Expiry is checked DIRECTLY rather than through the classified state.
        // A link that both expired and already carries an answer classifies as
        // `already_submitted` — that respondent has genuinely expired and must
        // still be able to ask for a new link.
        const isExpired = Boolean(context.expiresAt && context.expiresAt <= now);
        // Revocation is deliberate and is not undone by asking nicely.
        if (state === 'revoked' || !isExpired) {
            return NextResponse.json({ ok: false, state }, { status: 409 });
        }

        // Idempotent by nature: asking twice sets the same flag, and the tenant
        // sees one item rather than a growing pile.
        await prisma.outreachRecipient.update({
            where: { id: context.recipientId },
            data: { refresh_requested_at: context.refreshRequestedAt ?? now },
        });

        return NextResponse.json({
            ok: true,
            message: `We've let ${context.businessName} know. They'll send you a fresh link.`,
        });
    } catch {
        console.error('[Rebooking] refresh request failed');
        return NextResponse.json(
            { ok: false, errors: ['Something went wrong. Please try again.'] },
            { status: 500 },
        );
    }
}
