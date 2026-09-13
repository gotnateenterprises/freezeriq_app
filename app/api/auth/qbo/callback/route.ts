/**
 * Legacy QuickBooks OAuth callback — RETIRED (QB-INVOICE-1A).
 *
 * This exchanged the authorization code BEFORE checking who was signed in,
 * accepted `realmId` straight from the query string, trusted no state at all,
 * and saved the tokens in plaintext under the ambiguous provider key 'qbo'.
 *
 * The one QuickBooks callback is now app/api/integrations/quickbooks/callback.
 *
 * WHY A 410 FILE RATHER THAN DELETION: without this file the path falls through
 * to the app/api/auth/[...nextauth] catch-all. See app/api/auth/qbo/route.ts.
 *
 * The request — including any code, state or realmId on it — is never read.
 */

import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json(
        { error: 'This endpoint is no longer available.' },
        { status: 410, headers: { 'Cache-Control': 'no-store' } },
    );
}
