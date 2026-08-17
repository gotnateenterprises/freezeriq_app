import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { findBusinessBySlug } from '@/lib/publicIdentity';

/**
 * SF-2 — public storefront menu-email capture.
 *
 * Writes one BusinessLead per (email, tenant) signup. The current BusinessLead
 * model has NO tenant relation and NO source field, so this route uses the
 * approved compatibility mapping:
 *   name:   `Menu signup — ${business.name}`  (required field; preserves tenant
 *           context textually — NOT a real relational tenant association)
 *   type:   'storefront_menu_signup'          (the spec's "source" semantic)
 *   status: 'NEW'                             (existing lead convention)
 *
 * Anti-enumeration contract: every well-formed request — invalid email,
 * unknown slug, duplicate, or new signup — answers { success: true }. The
 * response never reveals whether a tenant exists or an email was seen before.
 * Duplicate prevention is a sequential find-before-create; no schema-level
 * concurrency guarantee is added in SF-2. No email is sent from this route.
 */
export async function POST(req: NextRequest) {
    try {
        let body: any;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ success: true });
        }

        const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : '';
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

        if (!slug || !email || email.length > 320 || !/.+@.+\..+/.test(email)) {
            return NextResponse.json({ success: true });
        }

        // Resolve the tenant case-insensitively by slug (same pattern as the
        // public order route). Unknown slug → silent success, no write.
        // FR-PUBLIC-IDENTITY-1: literal slug. ILIKE let "%" reach an arbitrary tenant.
        const business = await findBusinessBySlug(prisma, slug, { name: true });

        if (!business) {
            return NextResponse.json({ success: true });
        }

        const leadName = `Menu signup — ${business.name}`;

        // Sequential duplicate prevention: same email + type + tenant-marked
        // name → return success without another write (no lead spam).
        const existing = await prisma.businessLead.findFirst({
            where: {
                email,
                type: 'storefront_menu_signup',
                name: leadName,
            },
            select: { id: true },
        });

        if (!existing) {
            await prisma.businessLead.create({
                data: {
                    name: leadName,
                    email,
                    type: 'storefront_menu_signup',
                    status: 'NEW',
                },
            });
        }

        return NextResponse.json({ success: true });
    } catch (e) {
        // Generic server-side log only — never log the submitted email.
        console.error('[MENU-SIGNUP] Unexpected failure while recording signup');
        return NextResponse.json({ success: true });
    }
}
