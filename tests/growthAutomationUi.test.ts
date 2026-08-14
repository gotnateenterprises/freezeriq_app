/**
 * GE-5A-2 — pure display logic for the Seasonal Rebooking Recommendations panel.
 *
 * This repo has no React component-testing infrastructure (jest runs with
 * testEnvironment: 'node', no jsdom, no @testing-library/react — see
 * jest.config.js). Rather than add that infrastructure or skip verification,
 * the actual decisions the panel makes — which empty state to show, how a
 * result count becomes a sentence, which statuses are still actionable, which
 * offering to evaluate against — were extracted into lib/growth/automationUi.ts
 * so they are unit-testable the same way the rest of this codebase tests
 * logic. The component itself is thin glue around these functions and is
 * covered by tsc + a source-level review instead.
 *
 * The failure mode every test here guards against is the same one GE-5A-1's
 * own tests guard against: language or state that claims more than GE-5A can
 * actually do (implying a send, hiding that nothing happened, conflating
 * "never tried" with "tried and found nothing").
 */

import {
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    STATUS_PRESENTATION,
    labelImpliesSend,
    classifyActions,
    selectEmptyState,
    formatEvaluateResult,
    formatDisableMessage,
    ENABLE_MESSAGE,
    selectEligibleOffering,
    type AutomationStatus,
} from '@/lib/growth/automationUi';

const ALL_STATUSES: AutomationStatus[] = ['candidate', 'approved', 'dismissed', 'suppressed', 'expired'];

describe('1. active/terminal status partition', () => {
    it('together cover exactly the 5 real statuses, with no overlap', () => {
        const combined = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES].sort();
        expect(combined).toEqual([...ALL_STATUSES].sort());
        const overlap = ACTIVE_STATUSES.filter((s) => (TERMINAL_STATUSES as string[]).includes(s));
        expect(overlap).toEqual([]);
    });

    it('active is exactly candidate and approved', () => {
        expect([...ACTIVE_STATUSES].sort()).toEqual(['approved', 'candidate']);
    });

    it('terminal is exactly dismissed, suppressed, expired', () => {
        expect([...TERMINAL_STATUSES].sort()).toEqual(['dismissed', 'expired', 'suppressed']);
    });
});

describe('2. status labels never imply a send, schedule, or execution', () => {
    it('has a presentation entry for every real status', () => {
        for (const status of ALL_STATUSES) {
            expect(STATUS_PRESENTATION[status]).toBeDefined();
        }
    });

    it('no status label trips the send-implying check', () => {
        for (const status of ALL_STATUSES) {
            expect(labelImpliesSend(STATUS_PRESENTATION[status].label)).toBe(false);
        }
    });

    it('labelImpliesSend catches the words GE-5A cannot honestly use', () => {
        expect(labelImpliesSend('This has been sent')).toBe(true);
        expect(labelImpliesSend('Scheduled for delivery')).toBe(true);
        expect(labelImpliesSend('Already executed')).toBe(true);
        expect(labelImpliesSend('Message dispatched')).toBe(true);
        expect(labelImpliesSend('Delivered to inbox')).toBe(true);
        expect(labelImpliesSend('Mailed yesterday')).toBe(true);
    });

    it('labelImpliesSend is case-insensitive', () => {
        expect(labelImpliesSend('SENT')).toBe(true);
        expect(labelImpliesSend('Sending now')).toBe(true);
    });

    it('labelImpliesSend does not false-positive on words that merely contain the substring', () => {
        // "sentiment" contains "sent" but is not the word "sent" — \b enforces this.
        expect(labelImpliesSend('Positive sentiment')).toBe(false);
        expect(labelImpliesSend('Recommended')).toBe(false);
        expect(labelImpliesSend('No longer active')).toBe(false);
    });
});

describe('3. classifyActions splits active vs history correctly', () => {
    it('returns two empty arrays for no actions', () => {
        expect(classifyActions([])).toEqual({ active: [], history: [] });
    });

    it('puts candidate and approved in active, nothing else', () => {
        const actions = [{ status: 'candidate' as const }, { status: 'approved' as const }];
        const { active, history } = classifyActions(actions);
        expect(active).toEqual(actions);
        expect(history).toEqual([]);
    });

    it('puts dismissed, suppressed, and expired in history — never in active', () => {
        const actions = [
            { status: 'dismissed' as const },
            { status: 'suppressed' as const },
            { status: 'expired' as const },
        ];
        const { active, history } = classifyActions(actions);
        expect(active).toEqual([]);
        expect(history).toEqual(actions);
    });

    it('splits a mixed list without dropping or duplicating rows', () => {
        const actions = [
            { id: 1, status: 'candidate' as const },
            { id: 2, status: 'expired' as const },
            { id: 3, status: 'approved' as const },
            { id: 4, status: 'dismissed' as const },
            { id: 5, status: 'suppressed' as const },
        ];
        const { active, history } = classifyActions(actions);
        expect(active.map((a) => a.id)).toEqual([1, 3]);
        expect(history.map((a) => a.id)).toEqual([2, 4, 5]);
    });
});

describe('4. selectEmptyState picks the one true reason the list is empty', () => {
    it('is policy_off whenever the policy is disabled, regardless of any counts', () => {
        expect(selectEmptyState({ policyEnabled: false, activeCount: 0, historyCount: 0, hasEvaluated: false })).toBe('policy_off');
        expect(selectEmptyState({ policyEnabled: false, activeCount: 5, historyCount: 5, hasEvaluated: true })).toBe('policy_off');
    });

    it('is null whenever there are active cards to show, on or off history/evaluated state', () => {
        expect(selectEmptyState({ policyEnabled: true, activeCount: 1, historyCount: 0, hasEvaluated: false })).toBeNull();
        expect(selectEmptyState({ policyEnabled: true, activeCount: 3, historyCount: 2, hasEvaluated: true })).toBeNull();
    });

    it('is never_evaluated only when nothing has been tried and there is no history yet', () => {
        expect(selectEmptyState({ policyEnabled: true, activeCount: 0, historyCount: 0, hasEvaluated: false })).toBe('never_evaluated');
    });

    it('is no_new_recommendations when evaluated, found nothing, and there is no history', () => {
        expect(selectEmptyState({ policyEnabled: true, activeCount: 0, historyCount: 0, hasEvaluated: true })).toBe('no_new_recommendations');
    });

    it('is only_history when settled actions exist and nothing is currently active', () => {
        expect(selectEmptyState({ policyEnabled: true, activeCount: 0, historyCount: 1, hasEvaluated: true })).toBe('only_history');
    });

    it('is only_history (not never_evaluated) when history exists even though this session has not evaluated', () => {
        // A tenant can reload the page after a prior session already produced
        // history; hasEvaluated only tracks this page load, so history must win.
        expect(selectEmptyState({ policyEnabled: true, activeCount: 0, historyCount: 2, hasEvaluated: false })).toBe('only_history');
    });
});

describe('5. formatEvaluateResult never overstates what the evaluator did', () => {
    it('reads as "no new" for zero', () => {
        expect(formatEvaluateResult(0)).toBe('No new recommendations right now.');
    });

    it('treats negative counts the same as zero — defensive, not a crash', () => {
        expect(formatEvaluateResult(-1)).toBe('No new recommendations right now.');
    });

    it('uses singular grammar for exactly one', () => {
        expect(formatEvaluateResult(1)).toBe('1 new recommendation found.');
    });

    it('uses plural grammar for more than one', () => {
        expect(formatEvaluateResult(2)).toBe('2 new recommendations found.');
        expect(formatEvaluateResult(11)).toBe('11 new recommendations found.');
    });
});

describe('6. formatDisableMessage is truthful about what was retired', () => {
    it('does not claim a retirement happened when nothing was active', () => {
        expect(formatDisableMessage(0)).toBe('Recommendations are off. Nothing was sent.');
    });

    it('uses singular grammar for exactly one retired action', () => {
        expect(formatDisableMessage(1)).toBe('Recommendations are off. 1 active recommendation was retired. Nothing was sent.');
    });

    it('uses plural grammar for more than one retired action', () => {
        expect(formatDisableMessage(3)).toBe('Recommendations are off. 3 active recommendations were retired. Nothing was sent.');
    });

    it('always ends with the same "nothing was sent" safety line, on or off', () => {
        expect(formatDisableMessage(0)).toMatch(/Nothing was sent\.$/);
        expect(formatDisableMessage(4)).toMatch(/Nothing was sent\.$/);
    });
});

describe('7. ENABLE_MESSAGE is honest that turning on sends nothing', () => {
    it('says nothing will be sent automatically', () => {
        expect(ENABLE_MESSAGE).toMatch(/nothing will be sent/i);
    });

    // Not tested with labelImpliesSend here: that checker is a blunt word-match
    // meant for short status-chip labels, and ENABLE_MESSAGE legitimately uses
    // the word "sent" in a negation ("nothing will be sent automatically") —
    // exactly the kind of sentence labelImpliesSend cannot parse correctly.
});

describe('8. selectEligibleOffering mirrors the backend eligibility rule', () => {
    it('returns null for an empty list', () => {
        expect(selectEligibleOffering([])).toBeNull();
    });

    it('excludes draft and archived lineups', () => {
        const lineups = [
            { id: 'a', status: 'draft', updatedAt: '2026-08-01T00:00:00Z' },
            { id: 'b', status: 'archived', updatedAt: '2026-08-02T00:00:00Z' },
        ];
        expect(selectEligibleOffering(lineups)).toBeNull();
    });

    it('includes ready and in_use lineups', () => {
        expect(selectEligibleOffering([{ id: 'a', status: 'ready', updatedAt: '2026-08-01T00:00:00Z' }])?.id).toBe('a');
        expect(selectEligibleOffering([{ id: 'b', status: 'in_use', updatedAt: '2026-08-01T00:00:00Z' }])?.id).toBe('b');
    });

    it('picks the most recently updated eligible lineup when several qualify', () => {
        const lineups = [
            { id: 'old', status: 'in_use', updatedAt: '2026-01-01T00:00:00Z' },
            { id: 'new', status: 'ready', updatedAt: '2026-08-01T00:00:00Z' },
            { id: 'mid', status: 'in_use', updatedAt: '2026-04-01T00:00:00Z' },
        ];
        expect(selectEligibleOffering(lineups)?.id).toBe('new');
    });

    it('never picks an archived lineup even if it is the most recently updated', () => {
        const lineups = [
            { id: 'stale-but-eligible', status: 'in_use', updatedAt: '2026-01-01T00:00:00Z' },
            { id: 'freshly-archived', status: 'archived', updatedAt: '2026-08-10T00:00:00Z' },
        ];
        expect(selectEligibleOffering(lineups)?.id).toBe('stale-but-eligible');
    });
});
