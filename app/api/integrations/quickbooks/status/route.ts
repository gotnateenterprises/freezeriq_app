/**
 * GET /api/integrations/quickbooks/status — QB-INVOICE-1A.
 *
 * The truthful connection state for the signed-in tenant. "connected" is only
 * ever returned straight after a live, read-only CompanyInfo call for the
 * tenant's own stored company succeeded — a database row on its own is never
 * reported as a working connection.
 *
 *   disabled            not available in this deployment (reason code only)
 *   not_connected       nothing stored
 *   connected           live CompanyInfo succeeded just now
 *   refresh_required    stored and probably fine, but a token refresh could not
 *                       complete right now — recoverable, retry later
 *   reconnect_required  Intuit revoked the grant, the refresh token expired, the
 *                       stored credentials cannot be read, or the company no
 *                       longer grants access
 *   disconnected        an admin disconnected it
 *   error               QuickBooks could not be reached to verify
 *
 * Tenant ADMIN only. Never returns a token, the realm id, the client id or an
 * integration identifier. The only company detail is its display name.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import { resolveQuickBooksConfig } from '@/lib/quickbooks/config';
import { intuitErrorDetail } from '@/lib/quickbooks/intuitClient';
import { checkQuickBooksHealth } from '@/lib/quickbooks/connection';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }
    if (!mayManageQuickBooks(session.user as any)) {
        return NextResponse.json({ error: 'Only a tenant administrator can view the QuickBooks connection.' }, { status: 403, headers: NO_STORE });
    }

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) {
        return NextResponse.json({ state: 'disabled', reason: resolved.reason }, { headers: NO_STORE });
    }

    const businessId = (session.user as any).businessId as string;
    try {
        const health = await checkQuickBooksHealth({ businessId, config: resolved.config });
        return NextResponse.json(health, { headers: NO_STORE });
    } catch (e) {
        console.error(`[quickbooks] status failed: ${intuitErrorDetail(e)}`);
        return NextResponse.json({ state: 'error', environment: resolved.config.environment, cause: 'status_unavailable' }, { headers: NO_STORE });
    }
}
