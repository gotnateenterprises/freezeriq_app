/**
 * CRM-CC-4 — pure presentation logic for the Campaign Context drawer.
 *
 * Decides WHICH sections of the campaign detail render for a given campaign,
 * from facts the row already carries. It re-decides nothing: health comes from
 * GE-3, priority/next-action from CRM-CC-1's triage, bundle-selection state
 * from its own card, closeout rules from the existing modal. This module only
 * arranges those authorities into a readable detail experience.
 *
 * Lifecycle here is a PRESENTATION grouping (which widgets make sense), not a
 * new state machine — it is derived 1:1 from triage + the end date.
 */

import {
    triageCampaign,
    type CampaignForTriage,
    type CampaignTriage,
} from './nextAction';
import {
    describeCampaignInvoice,
    hasCampaignInvoice,
    type CampaignInvoiceDisplay,
} from './campaignLifecycle';

/**
 * Presentation lifecycle:
 * - active       — running; health, progress, coordinator, bundles all apply
 * - ended_open   — the window has passed but closeout has not happened; the
 *                  story is "wrap this up", not "how is it pacing"
 * - completed    — a record; quiet historical summary, no invented actions
 * - upcoming     — a lead/placeholder; relationship context only
 */
export type CampaignDetailLifecycle = 'active' | 'ended_open' | 'completed' | 'upcoming';

export function detailLifecycle(c: CampaignForTriage, now: Date): CampaignDetailLifecycle {
    const triage = triageCampaign(c, now);
    // FR-HISTORY-1: `awaiting_payment` is OPERATIONALLY finished — ordering has
    // closed — even though it is not financially finished. It maps here with
    // `completed` so the drawer keeps hiding closeout and bundle-selection on a
    // campaign nobody can still order from. Without this it fell through to
    // 'active' and offered operational widgets on a closed fundraiser.
    //
    // The financial half of the story is NOT lost: it travels separately on
    // `DetailSections.invoiceState`, which says whether the invoice is a draft,
    // sent, paid or settled externally.
    if (triage.priority === 'completed' || triage.priority === 'awaiting_payment') return 'completed';
    if (triage.priority === 'upcoming') return 'upcoming';
    if (c.status === 'Active' && c.end_date) {
        const end = new Date(c.end_date);
        if (!Number.isNaN(end.getTime()) && end.getTime() < now.getTime()) return 'ended_open';
    }
    return 'active';
}

export interface DetailSections {
    lifecycle: CampaignDetailLifecycle;
    triage: CampaignTriage;
    /** Health reasons block — only when GE-3 actually has something adverse to say. */
    showHealth: boolean;
    /** Progress / held-orders / dates snapshot. Leads have nothing to snapshot. */
    showSnapshot: boolean;
    /** Bundle-selection card (it additionally self-hides for `not_required`). */
    showBundleSelection: boolean;
    /** Coordinator / organization contact context. Useful in every lifecycle. */
    showCoordinator: boolean;
    /** The existing closeout action. Only for real, not-yet-closed campaigns. */
    showCloseout: boolean;
    /** The existing Create-invoice capability. Neutral, never a recommendation.
     *  FR-HISTORY-1: now false once an invoice exists. */
    showInvoice: boolean;
    /** FR-HISTORY-1: what the campaign's invoice is, so the drawer can say so. */
    invoiceState: CampaignInvoiceDisplay;
}

/** One derivation per drawer open — deterministic, testable, no fetches. */
export function detailSections(c: CampaignForTriage, now: Date): DetailSections {
    const lifecycle = detailLifecycle(c, now);
    const triage = triageCampaign(c, now);
    const isReal = !c.is_placeholder;

    return {
        lifecycle,
        triage,
        // Reasons render only when they exist; on-pace campaigns already carry
        // their verdict in the header signal and need no explanation block.
        showHealth:
            (lifecycle === 'active' || lifecycle === 'ended_open')
            && (c.health === 'at_risk' || c.health === 'watch')
            && (c.health_reasons?.length ?? 0) > 0,
        showSnapshot: lifecycle !== 'upcoming',
        showBundleSelection: isReal && (lifecycle === 'active' || lifecycle === 'ended_open'),
        showCoordinator: true,
        showCloseout: isReal && (lifecycle === 'active' || lifecycle === 'ended_open'),
        // FR-HISTORY-1: withdraw "Create invoice" once an invoice is KNOWN to
        // exist. `isReal` alone offered it on every real campaign including ones
        // already invoiced and already PAID, and the database's
        // one-invoice-per-campaign index would reject the attempt anyway — so the
        // button could only ever produce an error or a contradiction.
        //
        // Deliberately keyed on "known to exist", not on `canCreateInvoice`.
        // A route that sends no invoice linkage yields `unknown`, and withdrawing
        // a working capability because a payload is silent would be a regression
        // dressed up as caution.
        showInvoice: isReal && !hasCampaignInvoice(c),
        // What the invoice actually IS, when one exists. Lets the drawer state the
        // truth instead of falling silent.
        invoiceState: describeCampaignInvoice(c),
    };
}

/**
 * The drawer's date line. Plain words; an ended campaign reads as a fact, not
 * an error. Missing dates yield null — never a "No date" placeholder.
 */
export function detailDateLine(c: CampaignForTriage, now: Date): string | null {
    if (!c.end_date) return null;
    const end = new Date(c.end_date);
    if (Number.isNaN(end.getTime())) return null;
    const fmt = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return end.getTime() < now.getTime() ? `Ended ${fmt}` : `Ends ${fmt}`;
}
