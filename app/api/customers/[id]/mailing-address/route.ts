/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0B — an ORGANIZATION's mailing address, for the CRM.
 *
 * GET  → { mailingAddress: { line1, line2, city, state, postalCode }, complete }
 * PUT  { line1, line2?, city, state, postalCode } → saves it; all blank clears it.
 *
 * The organization is the designated sender of its fundraiser emails, so this is
 * the physical address their footers carry. It is its own five columns — this
 * route reads and writes ONLY those, so saving it can never change the delivery
 * address, the contact profile, notes, tax status or anything else on the row.
 *
 * Tenant-scoped, self-defending (middleware does not cover /api/): the session's
 * businessId is required, and every statement's WHERE carries both the
 * organization id and that businessId, so another tenant's organization answers
 * 404 exactly like one that does not exist. Only organization rows
 * (fundraiser_org / organization) have a mailing address; a direct customer 404s.
 *
 * Raw SQL on purpose: the columns are newer than some locally generated Prisma
 * clients, and an explicit column list keeps delivery_address out by construction.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    mailingAddressFromRow,
    parseMailingAddressInput,
    type OrganizationMailingAddressRow,
} from '@/lib/previousSupporterAuthorities';

export const dynamic = 'force-dynamic';

const ORGANIZATION_TYPES = ['fundraiser_org', 'organization'];

async function loadRow(id: string, businessId: string): Promise<OrganizationMailingAddressRow | null> {
    const rows = await prisma.$queryRaw<OrganizationMailingAddressRow[]>`
        SELECT mailing_address_line1, mailing_address_line2, mailing_city, mailing_state, mailing_postal_code
        FROM customers
        WHERE id = ${id} AND business_id = ${businessId} AND type::text IN (${ORGANIZATION_TYPES[0]}, ${ORGANIZATION_TYPES[1]})
        LIMIT 1
    `;
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function toResponse(row: OrganizationMailingAddressRow) {
    return {
        mailingAddress: {
            line1: row.mailing_address_line1 ?? '',
            line2: row.mailing_address_line2 ?? '',
            city: row.mailing_city ?? '',
            state: row.mailing_state ?? '',
            postalCode: row.mailing_postal_code ?? '',
        },
        // Complete and well-formed — what prepared fundraiser email requires.
        complete: mailingAddressFromRow(row) !== null,
    };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;

        const row = await loadRow(id, businessId);
        if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json(toResponse(row));
    } catch (e) {
        console.error('Organization mailing address GET error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;

        let body: unknown = {};
        try { body = await req.json(); } catch { /* validated below */ }
        const parsed = parseMailingAddressInput(body);
        if (parsed.kind === 'invalid') {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }

        const next = parsed.kind === 'set'
            ? parsed.address
            : { line1: null, line2: null, city: null, state: null, postalCode: null };

        // The five mailing columns and nothing else, for THIS tenant's organization only.
        const updated = await prisma.$executeRaw`
            UPDATE customers
            SET mailing_address_line1 = ${next.line1},
                mailing_address_line2 = ${next.line2 ?? null},
                mailing_city = ${next.city},
                mailing_state = ${next.state},
                mailing_postal_code = ${next.postalCode}
            WHERE id = ${id} AND business_id = ${businessId} AND type::text IN (${ORGANIZATION_TYPES[0]}, ${ORGANIZATION_TYPES[1]})
        `;
        if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });

        const row = await loadRow(id, businessId);
        if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json(toResponse(row));
    } catch (e) {
        console.error('Organization mailing address PUT error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}
