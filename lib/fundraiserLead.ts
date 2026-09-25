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
 * FR-SUPPORTER-LEAD-1 — may a PUBLIC ORDER that created a new customer raise the tenant's
 * "New Lead Captured" sales alert?
 *
 * Not when the order came through a fundraiser. A supporter who buys a bundle to support Clark
 * County is a CUSTOMER of the tenant; they did not ask to run a fundraiser. The alert they were
 * raising is the /raise-funds SALES alert, and it arrived in the tenant's own inbox reading
 * "A new lead has been captured via the Fundraiser" — indistinguishable from a real enquiry, once
 * per first-time supporter, on every live campaign.
 *
 * This is the same boundary `belongsInFundraiserCrm` above already draws for the Fundraiser CRM
 * list, and for the same reason: having ordered is not fundraiser intent. It is stated here, beside
 * that rule, so the two cannot drift apart.
 *
 * Deliberately narrow. It changes nothing about the order, the customer record, the campaign, the
 * supporter's own confirmation e-mail or the coordinator's notification — only whether the tenant
 * is told they have a new SALES LEAD. An ordinary storefront order is untouched and still raises it.
 */
export function publicOrderRaisesLeadAlert(order: { isCampaignOrder: boolean }): boolean {
    return !order.isCampaignOrder;
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

/**
 * CRM-LEAD-D1 — the third and last surface of the same boundary: the Customer CRM's idea of a "lead".
 *
 * `Customer.status` defaults to LEAD and EVERY creation path in the app hardcodes it anyway, so LEAD
 * means "nobody has touched this record yet", NOT "this is a sales lead". The Customer CRM read it as
 * the latter, so a supporter who bought a bundle to back a campaign was counted in the "Active Leads"
 * tile and listed under "New Leads". At the time of the audit that was 34 of the 55 LEAD rows.
 *
 * The fix is deliberately a classification fix, not a data fix: supporters keep their row, their order
 * history, their `source`, and their persisted `status`. Only the question "is this a sales lead?" is
 * answered somewhere better than `status`.
 */

/** `source` written by /api/public/order when the order came through a campaign. Never overwritten. */
export const FUNDRAISER_SUPPORTER_SOURCE = 'Fundraiser';

/**
 * Did this customer record come into existence by BACKING a campaign, rather than by asking to run one?
 *
 * Proven against Production at audit time: of the 34 rows matching this predicate, 34/34 were
 * `direct_customer`, 34/34 owned at least one campaign order, and 0/34 carried any fundraiser intent.
 *
 * The intent half is expressed as `!belongsInFundraiserCrm` on purpose rather than as a bare tag check:
 * if the fundraiser-intent boundary above is ever widened, this predicate narrows to match, and the two
 * cannot drift apart. Note the audit's fuller predicate also excluded "owns a campaign" and "matches an
 * inquiry by e-mail"; both excluded zero additional rows, and both need a join, so the durable
 * `fundraiser_inquiry` tag — which the inquiry route writes on BOTH the create and the enrich-existing
 * branch — is the signal used here.
 *
 * Takes the RAW database shape (`type: 'direct_customer'`), not the CRM's display shape
 * (`type: 'Individual'`), so it can only ever be called where the real record is in hand.
 */
export function isFundraiserSupporter(customer: {
    type?: unknown;
    source?: unknown;
    tags?: unknown;
}): boolean {
    return (
        customer.type === 'direct_customer' &&
        customer.source === FUNDRAISER_SUPPORTER_SOURCE &&
        !belongsInFundraiserCrm(customer)
    );
}

/**
 * The Customer CRM's "New Leads" / "Active Leads" rule, stated once so the tile and the filtered list
 * cannot disagree.
 *
 * Takes the shape `/api/customers` emits: that route resolves `is_fundraiser_supporter` from the raw
 * record via `isFundraiserSupporter` above, because by then `type` has been mapped for display and the
 * raw value is gone. A row without the flag is treated as not a supporter, which preserves the previous
 * behaviour for anything this route does not classify (e.g. the synthetic customer-less order
 * aggregates, which have no Customer record and therefore no status of their own).
 */
export function qualifiesAsCustomerCrmLead(row: {
    status?: unknown;
    is_fundraiser_supporter?: unknown;
}): boolean {
    return row.status === 'LEAD' && row.is_fundraiser_supporter !== true;
}
