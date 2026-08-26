/**
 * OUTREACH-CONSENT-1 — the public unsubscribe endpoint.
 *
 * PUBLIC AND UNAUTHENTICATED. The token IS the authority, and it carries the
 * only two facts this route is allowed to act on: which tenant, and which
 * address. Nothing is read from the query string or the body, so there is no
 * field through which a caller could nominate somebody else.
 *
 * ── GET DOES NOT UNSUBSCRIBE ────────────────────────────────────────────────
 *
 * This URL is named in `List-Unsubscribe`, which means it gets fetched by things
 * that are not people: mailbox providers previewing links, corporate mail
 * security scanners rewriting and pre-fetching every URL in a message, link
 * checkers. If GET acted, a scanner would silently opt recipients out of mail
 * they never asked to stop — and nobody would ever find out why the list decayed.
 *
 * So GET redirects to the human confirmation page and changes nothing. POST is
 * the only method that writes.
 *
 * ── NO EXISTENCE ORACLE ─────────────────────────────────────────────────────
 *
 * Every rejected token — malformed, tampered, truncated, minted under another
 * secret — produces the same answer. Nothing distinguishes "not a real token"
 * from "real token, unknown tenant", and no supporter, order or campaign data is
 * read or returned. The response never contains the address.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { openUnsubscribeToken } from '@/lib/outreachUnsubscribeToken';
import { recordUnsubscribe } from '@/lib/outreachUnsubscribeWrite';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';

/** One answer for every bad token. The token itself is never echoed or logged. */
function refuse() {
    return NextResponse.json(
        { ok: false, error: 'This unsubscribe link is not valid.' },
        { status: 400 },
    );
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
    const { token } = await ctx.params;
    // Deliberately does not resolve the token: a redirect must be as cheap and
    // as side-effect-free for a scanner as it is for a person.
    //
    // The origin is the pinned platform one, NOT NEXTAUTH_URL — that variable is
    // set to a vercel.app host in .env.production, which would bounce a real
    // recipient off the product's domain on their way to opting out.
    return NextResponse.redirect(
        new URL(`/u/${encodeURIComponent(token ?? '')}`, resolveOutreachOrigin()),
        302,
    );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
    try {
        const { token } = await ctx.params;
        const payload = await openUnsubscribeToken(token);
        if (!payload) return refuse();

        // The write takes the RESOLVED payload. The request body is never read,
        // and there is no code path by which one could influence this.
        const result = await recordUnsubscribe(prisma, payload);

        // Repeat presses and provider retries are success, not error.
        return NextResponse.json({
            ok: true,
            alreadyUnsubscribed: result.alreadyUnsubscribed,
        });
    } catch (e) {
        // The token must never reach a log line, so the error is logged bare.
        console.error('[OUTREACH-CONSENT-1] unsubscribe failed:',
            e instanceof Error ? e.message : 'unknown');
        return NextResponse.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
    }
}
