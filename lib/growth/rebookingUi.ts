/**
 * CRM-CC-3 — pure display logic for the Rebooking tab.
 *
 * The state machine itself lives server-side (lib/rebookingRowState.ts) and is
 * NOT restated here. This module decides presentation only: which chips exist,
 * in what order, with what owner-facing words, and which resting states render
 * quietly.
 *
 * LABEL RECONCILIATION (Part K): the server bucket `done` maps 1:1 to status
 * `rebooked` — bucketForStatus routes ONLY 'rebooked' there, and archived /
 * paused rows go to 'none' (reachable via All), so relabeling the chip
 * "Rebooked" is exact, not optimistic. The bucket KEY stays 'done' because it
 * is the server contract; only the word the owner reads changes.
 */

export type RebookingFilter = 'all' | 'ready_to_invite' | 'waiting' | 'needs_action' | 'done';

export interface RebookingFilterMeta {
    key: RebookingFilter;
    /** Owner-facing word. 'done' reads as "Rebooked" — see header. */
    label: string;
    /** The one operational queue gets amber emphasis while work exists. */
    emphasize: boolean;
}

/**
 * Exactly five chips (approved product ruling), most operational first:
 * the work queue leads, resting/summary views follow, All is the escape hatch.
 * "Needs action" remains the DEFAULT selection — that ruling is unchanged.
 */
export const REBOOKING_FILTERS: readonly RebookingFilterMeta[] = [
    { key: 'needs_action', label: 'Needs action', emphasize: true },
    { key: 'ready_to_invite', label: 'Ready to invite', emphasize: false },
    { key: 'waiting', label: 'Waiting', emphasize: false },
    { key: 'done', label: 'Rebooked', emphasize: false },
    { key: 'all', label: 'All', emphasize: false },
];

/**
 * Resting states render dimmed: they are deliberately not work queues
 * (bucketForStatus files them under 'none'), so they must not compete with
 * rows that need a human. `cant_email` stays at full strength — it is an
 * actionable problem, not a resting state.
 */
export const QUIET_STATUSES: readonly string[] = ['archived', 'paused_until'];

export function isQuietStatus(status: string): boolean {
    return QUIET_STATUSES.includes(status);
}

/** Calm empty-state copy per filter; needs_action has its own richer panel. */
export function rebookingEmptyCopy(filter: Exclude<RebookingFilter, 'needs_action'>): string {
    switch (filter) {
        case 'waiting': return 'No updates are waiting on replies yet.';
        case 'done': return 'No groups have rebooked yet.';
        case 'ready_to_invite': return 'No contacts are ready to invite.';
        case 'all': return 'Add a fundraiser organization and it will appear here.';
    }
}
