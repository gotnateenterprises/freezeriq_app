/**
 * FR-FLOW-2B — what the CRM should CALL a campaign, as opposed to what the
 * database stores.
 *
 * WHY THIS EXISTS
 * A campaign launched by FR-FLOW-2 is persisted with `status = 'Active'` and
 * `bundle_selection_status = 'pending'`. Both are correct: 'Active' is what the
 * public listing predicate matches on, and 'pending' is what blocks that same
 * listing and refuses every order. The campaign is genuinely alive, and just as
 * genuinely not open for business.
 *
 * The CRM was reading only the first of those two and painting a green ACTIVE
 * chip on a fundraiser nobody could order from. That is not a cosmetic problem:
 * a tenant looking at a green chip has no reason to go chase the coordinator,
 * which is the one action that would actually move the fundraiser forward.
 *
 * WHY DERIVED RATHER THAN A NEW STATUS VALUE
 * `status` is free text with no enum and no CHECK, and two vocabularies already
 * disagree about it — the PATCH allowlist and the closed-family predicate. Adding
 * an 'AwaitingCoordinatorSetup' value would need every one of those predicates
 * re-audited, and would break the public listing's `fc.status = 'Active'` match
 * in a way that only shows up once a coordinator finally submits. The stored
 * value stays exactly as it is and compatible with every existing predicate;
 * only the label is computed.
 */

/** Keep in sync with StageChip.isClosedFamily and lib/campaignBundleSelection CLOSED_STATUSES. */
const CLOSED_STATUSES = ['Closed', 'Settled', 'Completed', 'Archived'];

export const AWAITING_COORDINATOR_SETUP_LABEL = 'Awaiting Coordinator Setup';
export const AWAITING_COORDINATOR_SETUP_KEY = 'awaiting_setup';

export interface CampaignDisplayStageInput {
    status: string;
    closed_at?: string | Date | null;
    bundle_selection_status?: string | null;
}

export interface CampaignDisplayStage {
    /** Human label for the chip. */
    label: string;
    /** Lowercase style key. */
    key: string;
    /** True when the campaign is waiting on its coordinator to finish setup. */
    awaitingCoordinatorSetup: boolean;
}

/**
 * A closed campaign is never "awaiting setup" — closure outranks the workflow,
 * exactly as it does in resolveCampaignOrderMode, where isCampaignClosed() is
 * checked before the bundle-selection branch.
 */
function isClosedFamily(c: CampaignDisplayStageInput): boolean {
    return Boolean(c.closed_at) || CLOSED_STATUSES.includes(c.status);
}

export function campaignDisplayStage(c: CampaignDisplayStageInput): CampaignDisplayStage {
    const status = c.status || '';

    if (isClosedFamily(c)) {
        return { label: status, key: status.toLowerCase(), awaitingCoordinatorSetup: false };
    }

    // The exact condition the owner specified: live lifecycle status, coordinator
    // setup still outstanding.
    if (status.toLowerCase() === 'active' && c.bundle_selection_status === 'pending') {
        return {
            label: AWAITING_COORDINATOR_SETUP_LABEL,
            key: AWAITING_COORDINATOR_SETUP_KEY,
            awaitingCoordinatorSetup: true,
        };
    }

    return { label: status, key: status.toLowerCase(), awaitingCoordinatorSetup: false };
}
