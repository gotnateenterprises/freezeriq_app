/**
 * Legacy SMS relay — RETIRED (TWILIO-SMS-ROUTE-RETIRE-1, owner-approved 2026-11-23).
 *
 * ── WHY THIS IS NOW A DEAD END ──────────────────────────────────────────────
 *
 * TWILIO-SMS-ROUTE-AUDIT-1 (read-only, on Production 95dff83) found that this POST sent a text from
 * the platform's single Twilio number to ANY list of numbers, with ANY message, for ANY signed-in
 * staff account. It had:
 *
 *   - no tenant scoping — no business id was read, so one tenant could text another tenant's
 *     supporters or any number outside FreezerIQ;
 *   - no supporter consent check (supporter_contact_consents was never read), no suppression,
 *     and no inbound STOP / revocation handling anywhere in FreezerIQ;
 *   - no rate, recipient or length limits, international numbers passed straight through, and
 *     Twilio errors and message ids were echoed back to the caller.
 *
 * It had no callers: no page, component, script or library referenced it, and the only SMS UI in
 * the repository (components/crm/SmsComposeModal.tsx) is imported nowhere. Twilio was not
 * configured in any Vercel environment, so it answered 503 — but adding the credentials would have
 * turned it into a live open relay.
 *
 * ── WHAT IS EXPLICITLY *NOT* AFFECTED ───────────────────────────────────────
 *
 * SUPPORTER-CONSENT-1 keeps capturing SMS permission at supporter checkout (capture only). Marketing
 * SMS stays disabled: there is no sender, and none may exist until inbound STOP / revocation, SMS
 * suppression, a send log and abuse limits do. A future sender must be purpose-specific and
 * server-owned (recipients and wording chosen by the server), not a generic relay like this one.
 *
 * ── WHY 410 RATHER THAN DELETION ────────────────────────────────────────────
 *
 * The file stays so a stale caller gets a definite answer, and so the retirement is legible where
 * someone would look for it. Every request, signed in or not, from any tenant, gets the same fixed
 * response. Nothing is read: no session, no body, no phone number, no message, no environment
 * variable. Nothing is logged. There is no Twilio import and no code path to any provider.
 */

import { NextResponse } from 'next/server';

/** Identical for every verb and every caller: gone, no work performed, nothing disclosed. */
function gone() {
    return NextResponse.json(
        { error: 'This SMS endpoint is no longer available.' },
        { status: 410, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
}

export async function POST() {
    // The request is deliberately never read: no session, no body, no recipients, no message.
    return gone();
}

export async function GET() {
    return gone();
}
