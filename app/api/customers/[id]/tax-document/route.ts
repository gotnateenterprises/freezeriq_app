/**
 * FR-TAX-1 — the organization's tax-exemption document.
 *
 * ACCESS MODEL: authenticated TENANT session only (auth() -> businessId), and
 * every handler re-checks that the organization belongs to THAT business before
 * touching a byte. There is deliberately no token, no signed URL and no public
 * variant of this route:
 *
 *   - a COORDINATOR has a coordinator session, not a tenant session, so
 *     requireCoordinatorSession-authenticated surfaces can never reach here;
 *   - a SUPPORTER / public visitor has no session at all and gets 401;
 *   - tenant B asking for tenant A's organization gets 404 — deliberately
 *     indistinguishable from "no such organization", so this route cannot be
 *     used to probe which organizations exist in another tenant.
 *
 * The bytes never acquire a URL. They are streamed from Postgres through this
 * authenticated handler, so there is no CDN object to leak, no bucket policy to
 * misconfigure and no presigned link to end up in browser history or logs.
 *
 * POST   upload or REPLACE the organization's current document (upsert)
 * GET    download the current document
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    validateTaxDocument,
    safeDocumentFilename,
    TAX_DOCUMENT_MAX_BYTES,
} from '@/lib/taxDocumentPolicy';

export const dynamic = 'force-dynamic';

/**
 * Resolve the organization ONLY within the caller's own tenant.
 * Returns null for "not found" and for "belongs to someone else" alike.
 */
async function findOwnedOrganization(id: string, businessId: string) {
    return prisma.customer.findFirst({
        where: { id, business_id: businessId },
        select: { id: true, business_id: true },
    });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;

        const org = await findOwnedOrganization(id, businessId);
        if (!org) {
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
        }

        const formData = await req.formData();
        const file = formData.get('file');
        if (!file || typeof file === 'string') {
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        const validation = validateTaxDocument({
            contentType: (file as File).type,
            sizeBytes: (file as File).size,
        });
        if (!validation.ok) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }

        const buffer = Buffer.from(await (file as File).arrayBuffer());
        // Re-check the ACTUAL byte length. `File.size` is client-reported
        // metadata; the bytes are the only thing that consumes storage.
        if (buffer.byteLength === 0 || buffer.byteLength > TAX_DOCUMENT_MAX_BYTES) {
            return NextResponse.json({ error: 'That file is too large.' }, { status: 400 });
        }

        const filename = safeDocumentFilename((file as File).name);

        // Upsert on the unique customer_id: uploading again REPLACES the
        // current document, which is the whole lifecycle FR-TAX-1 needs.
        const saved = await prisma.organizationTaxDocument.upsert({
            where: { customer_id: org.id },
            create: {
                customer_id: org.id,
                business_id: businessId,
                filename,
                content_type: validation.contentType,
                size_bytes: buffer.byteLength,
                data: buffer,
                uploaded_by: session.user.id ?? null,
            },
            update: {
                filename,
                content_type: validation.contentType,
                size_bytes: buffer.byteLength,
                data: buffer,
                uploaded_at: new Date(),
                uploaded_by: session.user.id ?? null,
                // business_id is intentionally NOT updatable here: a document
                // never migrates between tenants.
            },
            select: { id: true, filename: true, size_bytes: true, uploaded_at: true, content_type: true },
        });

        return NextResponse.json({ success: true, document: saved });
    } catch (e: any) {
        console.error('[FR-TAX-1] tax document upload error:', e?.message || e);
        return NextResponse.json({ error: 'Failed to upload document' }, { status: 500 });
    }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;

        const org = await findOwnedOrganization(id, businessId);
        if (!org) {
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
        }

        // business_id is in the WHERE clause as well as the ownership check
        // above — belt and braces, so a future refactor of findOwnedOrganization
        // cannot silently widen this read.
        const doc = await prisma.organizationTaxDocument.findFirst({
            where: { customer_id: org.id, business_id: businessId },
        });
        if (!doc) {
            return NextResponse.json({ error: 'No tax-exemption document on file' }, { status: 404 });
        }

        return new NextResponse(Buffer.from(doc.data) as any, {
            headers: {
                'Content-Type': doc.content_type,
                'Content-Disposition': `attachment; filename="${safeDocumentFilename(doc.filename)}"`,
                'Content-Length': String(doc.size_bytes),
                // Never let a shared cache or CDN hold tax paperwork.
                'Cache-Control': 'private, no-store, max-age=0',
            },
        });
    } catch (e: any) {
        console.error('[FR-TAX-1] tax document download error:', e?.message || e);
        return NextResponse.json({ error: 'Failed to retrieve document' }, { status: 500 });
    }
}
