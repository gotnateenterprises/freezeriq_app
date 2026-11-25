/**
 * INQUIRY-REPLY-EXTRA-1 — Settings → Fundraisers → "Fundraiser Inquiry Reply".
 *
 * GET  the tenant's optional section (enabled, heading, message) and the limits.
 * PUT  { enabled, heading, body } saves it.
 *
 * Administrator only (owner decision): a non-administrator gets 403 on both, and the Settings card says so.
 * The tenant comes from the session, never the request; the row is the tenant's own
 * `system_settings` key (lib/inquiryReplyExtra.ts). Saving changes only FUTURE inquiry replies — nothing is
 * sent, and no past inquiry is ever re-sent.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import {
    EMPTY_INQUIRY_REPLY_EXTRA,
    INQUIRY_REPLY_ADMIN_ONLY_MESSAGE,
    INQUIRY_REPLY_BODY_MAX,
    INQUIRY_REPLY_HEADING_MAX,
    mayManageInquiryReply,
    parseInquiryReplyExtraInput,
    readInquiryReplyExtra,
    writeInquiryReplyExtra,
} from '@/lib/inquiryReplyExtra';

async function requireAdmin(): Promise<{ ok: true; businessId: string } | { ok: false; response: NextResponse }> {
    const session = await auth();
    const businessId = (session?.user as any)?.businessId as string | undefined;
    if (!session?.user || !businessId) {
        return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    if (!mayManageInquiryReply(session.user as any)) {
        return {
            ok: false,
            response: NextResponse.json({ error: INQUIRY_REPLY_ADMIN_ONLY_MESSAGE, code: 'ADMIN_ONLY' }, { status: 403 }),
        };
    }
    return { ok: true, businessId };
}

export async function GET() {
    try {
        const gate = await requireAdmin();
        if (!gate.ok) return gate.response;
        const setting = (await readInquiryReplyExtra(prisma, gate.businessId)) ?? EMPTY_INQUIRY_REPLY_EXTRA;
        return NextResponse.json({
            ...setting,
            limits: { headingMax: INQUIRY_REPLY_HEADING_MAX, bodyMax: INQUIRY_REPLY_BODY_MAX },
        });
    } catch (e) {
        console.error('[INQUIRY_REPLY_SETTINGS_GET]', e);
        return NextResponse.json({ error: 'Could not load the inquiry reply settings.' }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    try {
        const gate = await requireAdmin();
        if (!gate.ok) return gate.response;
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
        }
        const parsed = parseInquiryReplyExtraInput(body);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: parsed.status });
        await writeInquiryReplyExtra(prisma, gate.businessId, parsed.value);
        return NextResponse.json({ ...parsed.value, saved: true });
    } catch (e) {
        console.error('[INQUIRY_REPLY_SETTINGS_PUT]', e);
        return NextResponse.json({ error: 'Could not save the inquiry reply settings.' }, { status: 500 });
    }
}
