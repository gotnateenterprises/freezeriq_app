'use client';

import { Mail, Users } from 'lucide-react';
import { mailtoHref } from '@/lib/mailtoLink';
import {
    customerFacingBusinessName,
    customerFacingContactEmail,
    type TenantBrandSource,
} from '@/lib/tenantBrand';

/**
 * COORDINATOR-GUIDE-CONTACT-1 — the Success Guide's "Need Help?" block.
 *
 * Names the campaign's OWN tenant and links its customer-facing address, both
 * read from the business the coordinator API returns for this session's
 * campaign. Renders nothing when that tenant has no usable address — never a
 * substitute address, never another tenant's.
 */
export function GuideSupportContact({ business }: { business?: TenantBrandSource | null }) {
    const email = customerFacingContactEmail(business);
    const href = mailtoHref(email);
    if (!business || !email || !href) return null;

    return (
        <div className="bg-white rounded-3xl p-8 border border-slate-100 text-center space-y-4">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto text-slate-400">
                <Users size={32} />
            </div>
            <div>
                <h4 className="text-xl font-black text-slate-900">Need Help?</h4>
                <p className="text-slate-500 font-medium">{customerFacingBusinessName(business)} is here to support you every step of the way.</p>
            </div>
            <a href={href} className="inline-flex items-center gap-2 text-indigo-600 font-black hover:underline underline-offset-4">
                <Mail size={18} /> {email}
            </a>
        </div>
    );
}

export default GuideSupportContact;
