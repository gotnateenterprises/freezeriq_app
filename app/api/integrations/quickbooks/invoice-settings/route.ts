/**
 * /api/integrations/quickbooks/invoice-settings — QB-INVOICE-1C.
 *
 * GET   the tenant's QuickBooks invoice settings: the eligible items, accounts and terms from the tenant's OWN
 *       QuickBooks company (each under an opaque key), what is saved, and anything that blocks sending.
 * PUT   {"salesItemKey","shareItemKey","taxItemKey","termKey","allowOnlineCard","allowOnlineAch","defaultCc"}
 * POST  {"action":"create_item","role","accountKey","name","confirmation","attemptId"}
 *       Creates ONE non-taxable Service item in QuickBooks — only with the confirmation the GET issued for
 *       exactly that role, account and name. FreezerIQ never creates an account, and never creates anything else.
 *
 * Tenant ADMIN only, acting as themselves (not View As). JSON bodies only (415 otherwise). The body can name
 * neither a tenant, a company nor a QuickBooks object — only opaque keys that are valid for the live connection.
 * No response carries a token, the realm id, the connection id or a raw QuickBooks id.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import { resolveQuickBooksConfig } from '@/lib/quickbooks/config';
import { intuitErrorDetail } from '@/lib/quickbooks/intuitClient';
import {
    createQuickBooksHelperItem,
    getQuickBooksInvoiceSettingsView,
    saveQuickBooksInvoiceSettings,
    type ItemRole,
} from '@/lib/quickbooks/invoiceSettings';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const FORBIDDEN = 'Only a tenant administrator can manage QuickBooks invoice settings.';

const isJson = (req: Request) => (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
const keyOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401);
    if (!mayManageQuickBooks(session.user as any)) return json({ error: FORBIDDEN }, 403);

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) return json({ state: 'disabled' });

    const businessId = (session.user as any).businessId as string;
    try {
        return json(await getQuickBooksInvoiceSettingsView({ businessId, config: resolved.config }));
    } catch (e) {
        console.error(`[quickbooks] invoice settings view failed: ${intuitErrorDetail(e)}`);
        return json({ state: 'error' });
    }
}

export async function PUT(req: Request) {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401);
    if (!mayManageQuickBooks(session.user as any)) return json({ error: FORBIDDEN }, 403);
    if (!isJson(req)) return json({ error: 'Expected application/json' }, 415);

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) return json({ error: 'QuickBooks is not available in this environment.' }, 503);

    let body: any;
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid request' }, 400);
    }
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);

    const businessId = (session.user as any).businessId as string;
    const userId = session.user.id as string;
    try {
        const result = await saveQuickBooksInvoiceSettings({
            businessId, userId, config: resolved.config,
            selection: {
                salesItemKey: typeof body.salesItemKey === 'string' ? body.salesItemKey : '',
                shareItemKey: keyOrNull(body.shareItemKey),
                taxItemKey: keyOrNull(body.taxItemKey),
                termKey: typeof body.termKey === 'string' ? body.termKey : '',
                allowOnlineCard: body.allowOnlineCard === true,
                allowOnlineAch: body.allowOnlineAch === true,
                defaultCc: typeof body.defaultCc === 'string' ? body.defaultCc : null,
            },
        });
        const status = result.outcome === 'saved' ? 200 : result.outcome === 'invalid' ? 400 : result.outcome === 'unavailable' ? 503 : 409;
        return json(result, status);
    } catch (e) {
        console.error(`[quickbooks] invoice settings save failed: ${intuitErrorDetail(e)}`);
        return json({ error: 'Could not save the QuickBooks invoice settings.' }, 500);
    }
}

export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401);
    if (!mayManageQuickBooks(session.user as any)) return json({ error: FORBIDDEN }, 403);
    if (!isJson(req)) return json({ error: 'Expected application/json' }, 415);

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) return json({ error: 'QuickBooks is not available in this environment.' }, 503);

    let body: any;
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid request' }, 400);
    }
    if (body?.action !== 'create_item') return json({ error: 'Invalid request' }, 400);

    const businessId = (session.user as any).businessId as string;
    try {
        const result = await createQuickBooksHelperItem({
            businessId, config: resolved.config,
            role: body.role as ItemRole,
            accountKey: typeof body.accountKey === 'string' ? body.accountKey : '',
            name: typeof body.name === 'string' ? body.name : '',
            confirmation: typeof body.confirmation === 'string' ? body.confirmation : '',
            attemptId: typeof body.attemptId === 'string' ? body.attemptId : '',
        });
        const status = result.outcome === 'created' ? 200
            : result.outcome === 'unknown' ? 202
                : result.outcome === 'unavailable' ? 503
                    : result.outcome === 'rejected' ? 422
                        : 409; // stale
        return json(result, status);
    } catch (e) {
        console.error(`[quickbooks] helper item create failed: ${intuitErrorDetail(e)}`);
        return json({ error: 'Could not complete the QuickBooks request.' }, 500);
    }
}
