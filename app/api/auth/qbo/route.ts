/**
 * Legacy QuickBooks connect — RETIRED (QB-INVOICE-1A).
 *
 * This redirected to Intuit with a hardcoded localhost callback, the fixed state
 * string 'intuit-test' (so any callback could be forged onto it) and the openid
 * scope on top of accounting, and logged the generated authorization URL.
 *
 * The one QuickBooks connector is now app/api/integrations/quickbooks/connect.
 *
 * WHY A 410 FILE RATHER THAN DELETION: app/api/auth/[...nextauth] is a catch-all
 * over /api/auth/*. Deleting this file would hand /api/auth/qbo to NextAuth,
 * which answers with its own error and logs an UnknownAction — a stale path
 * served by the auth handler. This file keeps the path owned and closed.
 *
 * There is no code path from this file to Intuit, the session, or the database.
 */

import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json(
        { error: 'This endpoint is no longer available.' },
        { status: 410, headers: { 'Cache-Control': 'no-store' } },
    );
}
