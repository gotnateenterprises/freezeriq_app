/**
 * /api/integrations/quickbooks/customers/[customerId] — QB-INVOICE-1B.
 *
 * GET   the organization's QuickBooks customer state (read-only against QuickBooks;
 *       the first view for a live connection records that connection's id).
 * POST  {"action":"link","confirmation":"…"}
 *       {"action":"create","confirmation":"…","attemptId":"…"}
 *
 * Tenant ADMIN only, acting as themselves. The tenant is the session's; the company
 * is the tenant's verified stored connection; the organization must belong to the
 * tenant (404 otherwise). The body can name neither a tenant, a company nor a
 * QuickBooks customer — only the opaque confirmation the GET issued, which is valid
 * only while the state it describes is still true.
 *
 * POST accepts application/json only (415 otherwise), which a cross-site form cannot
 * send and a cross-origin script cannot send without a CORS preflight nothing approves.
 *
 * No response ever carries a token, the realm id, the connection id or a raw
 * QuickBooks id. QuickBooks invoices are not touched by this route in any way.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import { resolveQuickBooksConfig } from '@/lib/quickbooks/config';
import {
    createAndLinkCustomer,
    getCustomerLinkStatus,
    linkExistingCustomer,
    OrganizationNotFoundError,
} from '@/lib/quickbooks/customerLinks';

const NO_STORE = { 'Cache-Control': 'no-store' };
const ID = /^[A-Za-z0-9-]{1,64}$/;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET(_req: Request, { params }: { params: Promise<{ customerId: string }> }) {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401);
    if (!mayManageQuickBooks(session.user as any)) {
        return json({ error: 'Only a tenant administrator can manage QuickBooks customers.' }, 403);
    }
    const { customerId } = await params;
    if (!ID.test(customerId)) return json({ error: 'Organization not found' }, 404);

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) return json({ state: 'disabled' });

    const businessId = (session.user as any).businessId as string;
    try {
        return json(await getCustomerLinkStatus({ businessId, customerId, config: resolved.config }));
    } catch (e) {
        if (e instanceof OrganizationNotFoundError) return json({ error: 'Organization not found' }, 404);
        console.error(`[quickbooks] customer link status failed: ${e instanceof Error ? e.name : 'unknown'}`);
        return json({ state: 'error' });
    }
}

export async function POST(req: Request, { params }: { params: Promise<{ customerId: string }> }) {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401);
    if (!mayManageQuickBooks(session.user as any)) {
        return json({ error: 'Only a tenant administrator can manage QuickBooks customers.' }, 403);
    }
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return json({ error: 'Expected application/json' }, 415);
    }
    const { customerId } = await params;
    if (!ID.test(customerId)) return json({ error: 'Organization not found' }, 404);

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) return json({ error: 'QuickBooks is not available in this environment.' }, 503);

    let body: any;
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid request' }, 400);
    }
    const action = body?.action;
    const confirmation = typeof body?.confirmation === 'string' ? body.confirmation : '';
    if (action !== 'link' && action !== 'create') return json({ error: 'Invalid request' }, 400);

    const businessId = (session.user as any).businessId as string;
    const userId = session.user.id as string;
    try {
        const result = action === 'link'
            ? await linkExistingCustomer({ businessId, customerId, confirmation, userId, config: resolved.config })
            : await createAndLinkCustomer({
                businessId, customerId, confirmation,
                attemptId: typeof body?.attemptId === 'string' ? body.attemptId : '',
                userId, config: resolved.config,
            });
        const httpStatus = result.outcome === 'linked' ? 200
            : result.outcome === 'unknown' ? 202
                : result.outcome === 'unavailable' ? 503
                    : result.outcome === 'rejected' ? 422
                        : 409; // stale | conflict
        return json(result, httpStatus);
    } catch (e) {
        if (e instanceof OrganizationNotFoundError) return json({ error: 'Organization not found' }, 404);
        console.error(`[quickbooks] customer link ${action} failed: ${e instanceof Error ? e.name : 'unknown'}`);
        return json({ error: 'Could not complete the QuickBooks request.' }, 500);
    }
}
