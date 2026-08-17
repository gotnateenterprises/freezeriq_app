/**
 * FR-FLOW-1R — the durable "this customer has fundraiser intent" signal.
 *
 * THE PROBLEM THIS SOLVES
 * The Fundraiser CRM lists customers by `type IN ('fundraiser_org','organization')`.
 * A brand-new fundraiser inquiry creates exactly that, so it appears. But when
 * the submitter ALREADY exists in the tenant — because they bought from the
 * storefront or joined the surplus waitlist, both of which write
 * `type: 'direct_customer'` — the inquiry matched that row, enriched it, and
 * then vanished from the Fundraiser CRM. The lead was saved and invisible,
 * which is the exact failure FR-FLOW-1 was supposed to end.
 *
 * WHY NOT JUST PROMOTE THE TYPE
 * Because `Customer.type` is not a label, it is a mutually-exclusive identity
 * that other subsystems route on:
 *   - app/api/marketing/audience + marketing/send count `direct_customer` and
 *     the fundraiser types as two SEPARATE marketing audiences. Promoting a
 *     retail customer would silently move them out of the retail audience and
 *     into the fundraiser one.
 *   - app/api/growth/organizations and growth/automation/evaluate treat the
 *     fundraiser types as organizations for impact analytics and rebooking
 *     automation.
 *   - app/customers/page.tsx lenses People vs Organizations on it.
 * A person can legitimately be both a retail customer and a fundraiser lead, so
 * overwriting one role to express the other loses real information.
 *
 * THE SIGNAL
 * A tag. `Customer.tags` is already used exactly this way (the surplus waitlist
 * writes `surplus_waitlist`), it is additive, it survives alongside any type,
 * and it is written on BOTH inquiry paths — the create and the enrich-existing
 * branch. `source` is deliberately NOT the signal: it is only set on create,
 * because overwriting an existing customer's original source would destroy
 * attribution.
 *
 * Defined here rather than inline so the writer (the inquiry route) and the
 * reader (the CRM query) cannot drift apart.
 */

/** Durable marker that a Customer has expressed fundraiser intent. */
export const FUNDRAISER_INQUIRY_TAG = 'fundraiser_inquiry';

/** `source` written when the inquiry CREATES the customer. Not used as the CRM signal. */
export const FUNDRAISER_INQUIRY_SOURCE = 'Fundraiser Inquiry';

/** Customer.type values the Fundraiser CRM has always shown. */
export const FUNDRAISER_CRM_TYPES = ['fundraiser_org', 'organization'] as const;

/**
 * The Fundraiser CRM inclusion rule, as a Prisma `where` fragment.
 *
 * A customer belongs in the Fundraiser CRM when EITHER
 *   - they are a fundraiser organization by type (unchanged, historical rule), OR
 *   - they carry the fundraiser-inquiry tag (new: they asked about a fundraiser).
 *
 * Deliberately narrow. Having an email, having ordered, or being on the surplus
 * waitlist does NOT qualify — only genuine fundraiser intent does — so this
 * cannot flood the Fundraiser CRM with ordinary retail customers.
 *
 * Tenant scope is the caller's responsibility and is always applied alongside
 * this fragment.
 */
export function fundraiserCrmCustomerFilter() {
    return {
        OR: [
            { type: { in: [...FUNDRAISER_CRM_TYPES] as any } },
            { tags: { has: FUNDRAISER_INQUIRY_TAG } },
        ],
    };
}

/**
 * Pure mirror of the rule above, for tests and for any in-memory check.
 * Kept in the same file as the query fragment so the two cannot disagree.
 */
export function belongsInFundraiserCrm(customer: {
    type?: unknown;
    tags?: unknown;
}): boolean {
    const typeMatch =
        typeof customer.type === 'string' &&
        (FUNDRAISER_CRM_TYPES as readonly string[]).includes(customer.type);
    const tagMatch =
        Array.isArray(customer.tags) && customer.tags.includes(FUNDRAISER_INQUIRY_TAG);
    return typeMatch || tagMatch;
}
