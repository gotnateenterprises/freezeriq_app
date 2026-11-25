/**
 * INQUIRY-REPLY-EXTRA-1 — the Settings card's live preview.
 *
 * POST { enabled, heading, body } returns the COMPLETE inquiry reply exactly as a volunteer would receive it
 * with that (possibly unsaved) section — rendered by the same authority every sending path uses
 * (lib/inquiryReply.ts), with this tenant's real brand and signature, for a fictional sample inquiry.
 *
 * Writes nothing, sends nothing, claims nothing. Administrator only, like the setting itself.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { renderInquiryReply } from '@/lib/inquiryReply';
import {
    INQUIRY_REPLY_ADMIN_ONLY_MESSAGE,
    INQUIRY_REPLY_PREVIEW_SAMPLE,
    mayManageInquiryReply,
    parseInquiryReplyExtraInput,
} from '@/lib/inquiryReplyExtra';

export async function POST(req: Request) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId as string | undefined;
        if (!session?.user || !businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (!mayManageInquiryReply(session.user as any)) {
            return NextResponse.json({ error: INQUIRY_REPLY_ADMIN_ONLY_MESSAGE, code: 'ADMIN_ONLY' }, { status: 403 });
        }
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
        }
        const parsed = parseInquiryReplyExtraInput(body);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: parsed.status });
        const rendered = await renderInquiryReply(prisma, {
            businessId,
            contactName: INQUIRY_REPLY_PREVIEW_SAMPLE.contactName,
            organizationName: INQUIRY_REPLY_PREVIEW_SAMPLE.organizationName,
            draftSetting: parsed.value,
        });
        return NextResponse.json({ subject: rendered.subject, html: rendered.html, sample: INQUIRY_REPLY_PREVIEW_SAMPLE });
    } catch (e) {
        console.error('[INQUIRY_REPLY_PREVIEW]', e);
        return NextResponse.json({ error: 'Could not render the preview.' }, { status: 500 });
    }
}
