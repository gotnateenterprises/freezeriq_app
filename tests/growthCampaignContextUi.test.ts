/**
 * CRM-CC-4 — Campaign Context section logic.
 *
 * Failure modes pinned: an operational widget rendered for a lead, a fake next
 * action on a settled campaign, health reasons shown when GE-3 said nothing,
 * closeout offered on a closed campaign, invoice offered on a placeholder,
 * a "No date" placeholder, and the presentation lifecycle drifting away from
 * the triage it must mirror.
 */

import {
    detailLifecycle,
    detailSections,
    detailDateLine,
} from '@/lib/growth/campaignContextUi';
import type { CampaignForTriage } from '@/lib/growth/nextAction';
import type { CampaignHealthReason } from '@/lib/growth/health';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const reason = (code: CampaignHealthReason['code']): CampaignHealthReason => ({
    code, label: `test: ${code}`, kind: 'heuristic',
});

const active = (over: Partial<CampaignForTriage> = {}): CampaignForTriage => ({
    status: 'Active', end_date: days(10), held_order_count: 0,
    health: 'on_pace', health_reasons: [], ...over,
});

describe('1. presentation lifecycle mirrors triage + the end date', () => {
    it('running campaign → active', () => {
        expect(detailLifecycle(active(), NOW)).toBe('active');
    });

    it('Active past its end date → ended_open, held orders or not', () => {
        expect(detailLifecycle(active({ end_date: days(-1) }), NOW)).toBe('ended_open');
        expect(detailLifecycle(active({ end_date: days(-1), held_order_count: 5 }), NOW)).toBe('ended_open');
    });

    it('closed family → completed, even with a past end date', () => {
        expect(detailLifecycle(active({ status: 'Settled', end_date: days(-30) }), NOW)).toBe('completed');
        expect(detailLifecycle(active({ closed_at: days(-1) }), NOW)).toBe('completed');
    });

    it('lead/placeholder → upcoming', () => {
        expect(detailLifecycle({ status: 'Lead', is_placeholder: true }, NOW)).toBe('upcoming');
    });
});

describe('2. active campaign context', () => {
    it('healthy: snapshot + bundles + coordinator + wrap-up, but no health block', () => {
        const s = detailSections(active(), NOW);
        expect(s.lifecycle).toBe('active');
        expect(s.showHealth).toBe(false);
        expect(s.showSnapshot).toBe(true);
        expect(s.showBundleSelection).toBe(true);
        expect(s.showCoordinator).toBe(true);
        expect(s.showCloseout).toBe(true);
        expect(s.showInvoice).toBe(true);
        expect(s.triage.action).toBeNull();
    });

    it('at_risk with reasons: the health block renders', () => {
        const s = detailSections(active({
            health: 'at_risk',
            health_reasons: [reason('no_orders_yet'), reason('no_coordinator_activity')],
        }), NOW);
        expect(s.showHealth).toBe(true);
        expect(s.triage.action?.kind).toBe('contact_coordinator');
    });

    it('watch with a reason: health block renders', () => {
        const s = detailSections(active({ health: 'watch', health_reasons: [reason('behind_pace')] }), NOW);
        expect(s.showHealth).toBe(true);
    });

    it('at_risk but an empty reasons array: no empty health block', () => {
        const s = detailSections(active({ health: 'at_risk', health_reasons: [] }), NOW);
        expect(s.showHealth).toBe(false);
    });
});

describe('3. ended-with-held-orders context', () => {
    const ended = active({ end_date: days(-2), held_order_count: 4, held_order_total: 500 });

    it('is ended_open with a closeout next action', () => {
        const s = detailSections(ended, NOW);
        expect(s.lifecycle).toBe('ended_open');
        expect(s.showCloseout).toBe(true);
        expect(s.triage.action?.kind).toBe('closeout');
    });
});

describe('4. completed / settled context is quiet', () => {
    const settled: CampaignForTriage = { status: 'Settled', end_date: days(-30) };

    it('keeps the historical snapshot but drops every operational widget', () => {
        const s = detailSections(settled, NOW);
        expect(s.lifecycle).toBe('completed');
        expect(s.showSnapshot).toBe(true);
        expect(s.showHealth).toBe(false);
        expect(s.showBundleSelection).toBe(false);
        expect(s.showCloseout).toBe(false);
        expect(s.triage.action).toBeNull();
    });

    it('still offers the neutral invoice capability', () => {
        expect(detailSections(settled, NOW).showInvoice).toBe(true);
    });
});

describe('5. lead / upcoming context', () => {
    const lead: CampaignForTriage = { status: 'Lead', is_placeholder: true };

    it('shows relationship context only — no operational widgets', () => {
        const s = detailSections(lead, NOW);
        expect(s.lifecycle).toBe('upcoming');
        expect(s.showSnapshot).toBe(false);
        expect(s.showHealth).toBe(false);
        expect(s.showBundleSelection).toBe(false);
        expect(s.showCloseout).toBe(false);
        expect(s.showInvoice).toBe(false);
        expect(s.showCoordinator).toBe(true);
        expect(s.triage.action?.kind).toBe('follow_up');
    });
});

describe('6. the date line never shows a placeholder', () => {
    it('null when there is no end date', () => {
        expect(detailDateLine({ status: 'Active' }, NOW)).toBeNull();
        expect(detailDateLine({ status: 'Active', end_date: 'not-a-date' }, NOW)).toBeNull();
    });

    it('reads Ends for future, Ended for past — a fact, not an error', () => {
        // Midday-UTC timestamps so the local-timezone rendering cannot slip a
        // calendar day (date-only strings parse as UTC midnight).
        expect(detailDateLine(active({ end_date: '2026-09-10T12:00:00.000Z' }), NOW)).toBe('Ends Sep 10, 2026');
        expect(detailDateLine(active({ end_date: '2026-08-01T12:00:00.000Z' }), NOW)).toBe('Ended Aug 1, 2026');
    });
});
