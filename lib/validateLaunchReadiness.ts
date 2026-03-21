/**
 * Fundraiser Launch Readiness Validator
 *
 * Validates that all required fields are filled before allowing
 * a coordinator to send the marketing packet (flyer + order form email).
 *
 * This is a client-side gate only. The backend send endpoints are
 * not modified — the gate prevents premature UI triggers.
 */

export interface LaunchReadinessResult {
  ready: boolean;
  missing: string[];
}

/**
 * Check whether a fundraiser has all required data to launch.
 *
 * @param customer  – the full customer record (includes email, fundraiser_info, campaigns)
 * @returns `{ ready, missing }` – if `ready` is false, `missing` lists human-readable labels
 */
export function validateLaunchReadiness(customer: any): LaunchReadinessResult {
  const missing: string[] = [];
  const info = customer?.fundraiser_info;
  // Prefer the most recent campaign (source of truth for download routes)
  const campaign = customer?.campaigns?.[0];

  // 1. Contact email (required to send anything)
  if (!customer?.email?.trim()) {
    missing.push('Contact Email');
  }

  // 2. Fundraiser details must exist — either as a campaign or JSON
  if (!info && !campaign) {
    missing.push('Fundraiser Details (none saved yet)');
    return { ready: false, missing };
  }

  // 3. Order Deadline (campaign.end_date or info.deadline)
  if (!campaign?.end_date && !info?.deadline?.trim()) {
    missing.push('Order Deadline');
  }

  // 4. Delivery Date (campaign.delivery_date or info.delivery_date)
  if (!campaign?.delivery_date && !info?.delivery_date?.trim()) {
    missing.push('Delivery Date');
  }

  // 5. Pickup Location (campaign.pickup_location or info.pickup_location)
  const hasPickup = campaign?.pickup_location?.trim() || info?.pickup_location?.trim();
  if (!hasPickup) {
    missing.push('Pickup Location');
  }

  // 6. At least one bundle with recipes
  const hasBundle1 = !!info?.bundle1_recipes?.trim();
  const hasBundle2 = !!info?.bundle2_recipes?.trim();
  // Also check campaign_bundles if available
  const hasCampaignBundles = (campaign as any)?.campaign_bundles?.length > 0;
  if (!hasBundle1 && !hasBundle2 && !hasCampaignBundles) {
    missing.push('At least one Bundle with recipes');
  }

  // 7. Active campaign must exist (generates portal/public tokens)
  const campaigns = customer?.campaigns || [];
  if (campaigns.length === 0) {
    missing.push('A Campaign (create one in the Fundraisers tab)');
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

/**
 * Build a user-friendly alert message from missing fields.
 */
export function launchReadinessMessage(missing: string[]): string {
  return (
    `🚫 Not ready to launch yet!\n\nPlease complete the following before sending the marketing packet:\n\n` +
    missing.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
  );
}
