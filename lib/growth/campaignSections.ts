/**
 * CRM-CC-2 — priority sections for the Campaign list.
 *
 * Pure arrangement over CRM-CC-1's triage. This module decides NOTHING about a
 * campaign's priority — lib/growth/nextAction.ts already did, and inventing a
 * second model here would let the list disagree with the AttentionStrip. It
 * only files already-triaged campaigns into ordered, titled sections and
 * formats progress into words a person can read without decoding tiny numbers.
 *
 * Section rules:
 * - order is PRIORITY_RANK order — the most urgent section is always first;
 * - empty sections are omitted, never rendered as scary empty containers;
 * - "Recently completed" starts collapsed: finished campaigns are records,
 *   and records should not compete with work.
 */

import {
    triageCampaign,
    PRIORITY_RANK,
    type CampaignForTriage,
    type CampaignPriority,
    type CampaignTriage,
} from './nextAction';

export interface SectionMeta {
    /** Section heading. Plain language, no internal vocabulary. */
    title: string;
    /** One quiet sentence under the heading explaining what belongs here. */
    description: string;
    /** Finished work starts folded so it never competes with live work. */
    collapsedByDefault: boolean;
}

export const SECTION_META: Record<CampaignPriority, SectionMeta> = {
    needs_attention: {
        title: 'Needs attention',
        description: 'Act on these first — warning signs, or ended with orders still held.',
        collapsedByDefault: false,
    },
    // FR-HISTORY-1: money owed is work, and work is never folded away. This
    // section exists precisely because closing a fundraiser used to file it under
    // "Recently completed" — collapsed — while payment was still outstanding.
    awaiting_payment: {
        title: 'Closed — awaiting payment',
        description: 'Ordering has finished and the money has not been collected yet.',
        collapsedByDefault: false,
    },
    worth_a_look: {
        title: 'Worth a look',
        description: 'One warning sign each. Not alarming, worth a glance.',
        collapsedByDefault: false,
    },
    on_pace: {
        title: 'Active',
        description: 'Running with no warning signs.',
        collapsedByDefault: false,
    },
    upcoming: {
        title: 'Leads & upcoming',
        description: 'Organizations without a running campaign yet.',
        collapsedByDefault: false,
    },
    completed: {
        title: 'Recently completed',
        description: 'Finished campaigns, kept for reference.',
        collapsedByDefault: true,
    },
};

export interface CampaignSection<T> {
    priority: CampaignPriority;
    meta: SectionMeta;
    /** Campaigns with their triage attached, so rows never re-derive it. */
    campaigns: (T & { triage: CampaignTriage })[];
}

/**
 * File campaigns into ordered sections. Deterministic: same rows, same clock,
 * same sections. Order within a section preserves the input order (the server's
 * order), so this never invents a ranking the data does not support.
 */
export function groupCampaignsByPriority<T extends CampaignForTriage>(
    campaigns: T[],
    now: Date,
): CampaignSection<T>[] {
    const buckets = new Map<CampaignPriority, (T & { triage: CampaignTriage })[]>();
    for (const c of campaigns) {
        const triage = triageCampaign(c, now);
        const list = buckets.get(triage.priority) ?? [];
        list.push(Object.assign({}, c, { triage }));
        buckets.set(triage.priority, list);
    }
    return (Object.keys(PRIORITY_RANK) as CampaignPriority[])
        .sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])
        .filter((p) => (buckets.get(p) ?? []).length > 0)
        .map((p) => ({ priority: p, meta: SECTION_META[p], campaigns: buckets.get(p)! }));
}

export interface BundleProgress {
    /** Readable sentence fragment, e.g. "14 of 20 bundles". */
    text: string;
    /** 0–100 for the meter, or null when a meter would be dishonest (no goal). */
    percent: number | null;
}

/**
 * Progress in words first, meter second.
 *
 * - With a goal: "S of G bundles" plus a clamped percent for the meter.
 * - Without a goal but with sales: "S bundles" and NO meter — a bar with no
 *   denominator is a broken promise, not information.
 * - Without either: null. Silence beats "No bundle goal set" rendered at the
 *   same prominence as real progress.
 */
export function formatBundleProgress(
    weightedSold: number | null | undefined,
    goal: number | null | undefined,
    serverPercent?: number | null,
): BundleProgress | null {
    const sold = Number(weightedSold ?? 0);
    const g = Number(goal ?? 0);
    const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

    if (Number.isFinite(g) && g > 0) {
        const pct = Number.isFinite(Number(serverPercent))
            ? Math.min(Math.max(Number(serverPercent), 0), 100)
            : Math.min(Math.max((sold / g) * 100, 0), 100);
        return { text: `${fmt(Math.max(sold, 0))} of ${fmt(g)} bundles`, percent: pct };
    }
    if (Number.isFinite(sold) && sold > 0) {
        return { text: `${fmt(sold)} bundles`, percent: null };
    }
    return null;
}
