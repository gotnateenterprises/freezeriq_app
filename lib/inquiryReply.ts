/**
 * INQUIRY-REPLY-EXTRA-1 — the ONE rendering authority for the fundraiser inquiry reply.
 *
 * Three paths send this letter, and before this each rendered it for itself:
 *   - the automatic acknowledgement       lib/inquiryAcknowledgement.ts
 *   - the manual "Respond to inquiry"     app/api/opportunities/[id]/respond (draft; the owner may edit it)
 *   - the generic send route              app/api/email/send with template 'lead_intro'
 * plus the Settings preview (app/api/settings/fundraiser-inquiry-reply/preview), which renders a DRAFT section
 * that has not been saved yet.
 *
 * All of them call renderInquiryReply, so the tenant brand (lib/tenantBrand.resolveTenantBrand — display name,
 * contact address, website) and the tenant's optional section (lib/inquiryReplyExtra) can never differ between
 * them. Rendering only: nothing here sends, claims, or records anything.
 */

import { EMAIL_TEMPLATES, type TemplateTenant } from '@/lib/emailTemplates';
import { resolveTenantBrand } from '@/lib/tenantBrand';
import {
    activeInquiryReplySection,
    readInquiryReplyExtra,
    type InquiryReplyExtraSetting,
} from '@/lib/inquiryReplyExtra';

const BUSINESS_BRAND_SELECT = { name: true, display_name: true, custom_domain: true, contact_email: true, slug: true } as const;

export async function loadInquiryReplyTenant(db: any, businessId: string): Promise<TemplateTenant | undefined> {
    const business = await db.business.findUnique({ where: { id: businessId }, select: BUSINESS_BRAND_SELECT });
    if (!business) return undefined;
    const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
    const brand = resolveTenantBrand(business, base);
    return {
        name: brand.name,
        email: business.contact_email ?? undefined,
        site: brand.websiteUrl ?? undefined,
        siteLabel: brand.websiteLabel ?? undefined,
    };
}

export async function renderInquiryReply(
    db: any,
    params: {
        businessId: string;
        contactName: string;
        organizationName?: string | null;
        /**
         * Settings preview only: render THIS (unsaved) setting instead of the stored one. `undefined` means
         * "use what is stored" — every sending path passes nothing here.
         */
        draftSetting?: InquiryReplyExtraSetting | null;
    },
): Promise<{ subject: string; html: string }> {
    const tenant = await loadInquiryReplyTenant(db, params.businessId);
    const setting = params.draftSetting !== undefined
        ? params.draftSetting
        : await readInquiryReplyExtra(db, params.businessId);
    return EMAIL_TEMPLATES.lead_intro(
        params.contactName,
        params.organizationName ?? undefined,
        tenant,
        activeInquiryReplySection(setting),
    );
}
