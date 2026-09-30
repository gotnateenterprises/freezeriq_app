/**
 * RAISE-FUNDS-MARKETING-1 — the synthetic fundraiser behind
 * /shop/[slug]/raise-funds/sample, the "See a sample ordering page" demo.
 *
 * A prospective organizer needs to see what THEIR supporters will see. The
 * sample page renders the REAL supporter component (FundraiserClient) with the
 * tenant's REAL branding and bundle lineup, but everything that would need a
 * campaign comes from here instead: an obviously fictional organization, demo
 * goal/progress, generic pickup details. Nothing here reads or points at a
 * real campaign, organization, or order — so the demo works identically for
 * every tenant, whether or not it has ever run a fundraiser.
 *
 * The campaign object is typed as PublicCampaign: it carries exactly the
 * public-allowlist fields the real page sends across the client boundary
 * (lib/publicFundraiserPayload.ts), and nothing tenant-internal.
 */
import type { PublicCampaign } from '@/lib/publicFundraiserPayload';
import type { FundraiserProgressResult } from '@/lib/fundraiserMetrics';
import type { CampaignOrderBundleMode } from '@/lib/campaignOrderBundles';

/** Not a UUID and cannot match one — never a real campaign id. */
export const SAMPLE_FUNDRAISER_ID = 'sample';
export const SAMPLE_ORGANIZATION_NAME = 'Sample Community Organization';
export const SAMPLE_FUNDRAISER_NAME = `${SAMPLE_ORGANIZATION_NAME} Fundraiser`;

/** Demo progress: far enough along to show momentum, clearly not finished. */
export const SAMPLE_BUNDLE_PROGRESS: FundraiserProgressResult = {
    totalBundlesSold: 38,
    bundleGoal: 60,
    progressPercent: 63,
    estimatedEarnings: 0,
    totalSales: 0,
    raisedAmount: null,
};

/**
 * 'legacy' is the real supporter page's own mode for a campaign that offers
 * the tenant's public storefront lineup — so the sample shows every current
 * public bundle, exactly as such a campaign would.
 */
export const SAMPLE_ORDER_MODE: CampaignOrderBundleMode = {
    allowed: true,
    mode: 'legacy',
    activeOrderableBundleIds: [],
};

const DAY_MS = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Dates are relative to `now` so the sample always shows a deadline two weeks
 * out and a pickup a week after that, never a date in the past.
 */
export function buildSampleCampaign(now: Date = new Date()): PublicCampaign {
    return {
        id: SAMPLE_FUNDRAISER_ID,
        name: SAMPLE_FUNDRAISER_NAME,
        about_text: 'We\'re raising money for our community programs this season. Every meal bundle you order helps us reach our goal and stocks your freezer with easy dinners. Thank you for your support!',
        participant_label: 'Member',
        end_date: isoDate(new Date(now.getTime() + 14 * DAY_MS)),
        delivery_date: isoDate(new Date(now.getTime() + 21 * DAY_MS)),
        pickup_location: 'Sample Community Center',
        delivery_time: '4:00 PM – 6:00 PM',
        payment_instructions: 'Example: pay your coordinator by cash or check at pickup.',
        external_payment_link: null,
        tax_status: null,
        tax_rate_percent: null,
        organization_name: SAMPLE_ORGANIZATION_NAME,
        customer_fundraiser_info: { delivery_date: null, delivery_time: null, pickup_location: null },
    };
}
