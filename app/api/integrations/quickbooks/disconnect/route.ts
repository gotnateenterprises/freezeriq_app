/**
 * POST /api/integrations/quickbooks/disconnect — QB-INVOICE-1A.
 *
 * Body: `{}` or `{ "action": "disconnect" }` — revoke at Intuit (best effort)
 *       and ALWAYS disable the stored credentials. Returns whether Intuit
 *       confirmed the revocation, so the admin can be told to also disconnect
 *       from inside QuickBooks if it did not.
 *
 *       `{ "action": "forget" }` — delete a connection that is no longer live
 *       (disconnected, revoked, or unreadable), so a DIFFERENT QuickBooks company
 *       may be connected. Refused while a live connection exists.
 *
 * Tenant ADMIN only. The tenant comes from the session; the body cannot name a
 * tenant, a realm or an integration. Disabled wherever connecting is disabled —
 * a Preview deployment shares the Production database and must not be able to
 * change a real tenant's connection either way.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import { resolveQuickBooksConfig } from '@/lib/quickbooks/config';
import { intuitErrorDetail } from '@/lib/quickbooks/intuitClient';
import { disconnectQuickBooks, forgetQuickBooksConnection } from '@/lib/quickbooks/connection';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }
    if (!mayManageQuickBooks(session.user as any)) {
        return NextResponse.json({ error: 'Only a tenant administrator can change the QuickBooks connection.' }, { status: 403, headers: NO_STORE });
    }

    // JSON only: a cross-site HTML form cannot send it without a CORS preflight.
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return NextResponse.json({ error: 'Expected application/json.' }, { status: 415, headers: NO_STORE });
    }
    let body: any = {};
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE });
    }
    const action = body?.action ?? 'disconnect';
    if (action !== 'disconnect' && action !== 'forget') {
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400, headers: NO_STORE });
    }

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) {
        return NextResponse.json(
            { error: 'QuickBooks connection is not available in this environment.', reason: resolved.reason },
            { status: 503, headers: NO_STORE },
        );
    }

    const businessId = (session.user as any).businessId as string;
    try {
        if (action === 'forget') {
            const outcome = await forgetQuickBooksConnection({ businessId });
            if (outcome === 'still_connected') {
                return NextResponse.json({ error: 'Disconnect QuickBooks before forgetting the company.', outcome }, { status: 409, headers: NO_STORE });
            }
            return NextResponse.json({ outcome }, { headers: NO_STORE });
        }
        const result = await disconnectQuickBooks({ businessId, config: resolved.config, actorUserId: session.user.id });
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (e) {
        console.error(`[quickbooks] disconnect failed: ${intuitErrorDetail(e)}`);
        return NextResponse.json({ error: 'Failed to change the QuickBooks connection.' }, { status: 500, headers: NO_STORE });
    }
}
