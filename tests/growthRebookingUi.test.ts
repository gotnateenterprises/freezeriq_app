/**
 * CRM-CC-3 — Rebooking tab presentation logic.
 *
 * Failure modes pinned: a sixth chip appearing, "Needs action" losing its lead
 * position or emphasis, the Rebooked relabel drifting away from the exact
 * server semantics it depends on, and a resting state rendered at full alarm.
 */

import {
    REBOOKING_FILTERS,
    QUIET_STATUSES,
    isQuietStatus,
    rebookingEmptyCopy,
} from '@/lib/growth/rebookingUi';
import { bucketForStatus, type RebookingStatus } from '@/lib/rebookingRowState';

describe('1. exactly five chips, most operational first', () => {
    it('has exactly five filters', () => {
        expect(REBOOKING_FILTERS).toHaveLength(5);
    });

    it('leads with Needs action and ends with All', () => {
        expect(REBOOKING_FILTERS[0].key).toBe('needs_action');
        expect(REBOOKING_FILTERS[REBOOKING_FILTERS.length - 1].key).toBe('all');
    });

    it('covers every server bucket key exactly once', () => {
        expect(REBOOKING_FILTERS.map((f) => f.key).sort()).toEqual(
            ['all', 'done', 'needs_action', 'ready_to_invite', 'waiting'],
        );
    });

    it('only Needs action carries emphasis', () => {
        for (const f of REBOOKING_FILTERS) {
            expect(f.emphasize).toBe(f.key === 'needs_action');
        }
    });
});

describe('2. the Rebooked relabel is exact, not optimistic', () => {
    it('labels the done bucket "Rebooked"', () => {
        expect(REBOOKING_FILTERS.find((f) => f.key === 'done')!.label).toBe('Rebooked');
    });

    it('server routes ONLY status=rebooked into done — the precondition for the relabel', () => {
        const all: RebookingStatus[] = [
            'ready_to_invite', 'update_sent', 'interested', 'needs_review',
            'needs_coordinator', 'ready_to_create', 'rebooked', 'cant_email',
            'paused_until', 'archived',
        ];
        const doneStatuses = all.filter((s) => bucketForStatus(s, false) === 'done');
        expect(doneStatuses).toEqual(['rebooked']);
    });
});

describe('3. quiet statuses are resting states only', () => {
    it('archived and paused are quiet', () => {
        expect(isQuietStatus('archived')).toBe(true);
        expect(isQuietStatus('paused_until')).toBe(true);
    });

    it('actionable and informational states stay at full strength', () => {
        for (const s of ['cant_email', 'needs_review', 'update_sent', 'rebooked', 'ready_to_invite']) {
            expect(isQuietStatus(s)).toBe(false);
        }
    });

    it('every quiet status is one the server files under none (not a work queue)', () => {
        for (const s of QUIET_STATUSES) {
            expect(bucketForStatus(s as RebookingStatus, false)).toBe('none');
        }
    });
});

describe('4. empty-state copy is calm and specific', () => {
    it('has a sentence per non-needs-action filter', () => {
        expect(rebookingEmptyCopy('waiting')).toBe('No updates are waiting on replies yet.');
        expect(rebookingEmptyCopy('done')).toBe('No groups have rebooked yet.');
        expect(rebookingEmptyCopy('ready_to_invite')).toBe('No contacts are ready to invite.');
        expect(rebookingEmptyCopy('all')).toBe('Add a fundraiser organization and it will appear here.');
    });
});
