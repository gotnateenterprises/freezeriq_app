/**
 * INV-A — organization-share form logic (client plumbing).
 *
 * Failure modes pinned here:
 *  - an unauthorized form serializing an orgSharePercent key anyway
 *  - 25% travelling as 0.25 (the API parser reads PERCENT)
 *  - a blank field being sent instead of omitted (omission = 20.00 default)
 *  - the closed lock disappearing from the edit surface
 *  - the client authorization rule forking from the server's
 *
 * Server authorization itself is pinned in tests/fundraiserFinancialTermsAuth —
 * not re-proven here.
 */

import {
    canManageOrgShare,
    orgShareRequestField,
    orgShareInputError,
    orgShareFieldMode,
    formatOrgShare,
    ORG_SHARE_DEFAULT_INPUT,
    ORG_SHARE_LOCKED_NOTE,
} from '@/lib/orgShareForm';
import { mayManageFundraiserFinancialTerms } from '@/lib/fundraiserOrgShare';

const ADMIN = { role: 'ADMIN', isSuperAdmin: false };
const SUPER = { role: 'CHEF', isSuperAdmin: true };
const CHEF = { role: 'CHEF', isSuperAdmin: false };
const DRIVER = { role: 'DRIVER', isSuperAdmin: false };

describe('1. the client rule IS the server rule', () => {
    it('canManageOrgShare is the same function the server enforces', () => {
        // Identity, not equivalence: a re-implementation could drift.
        expect(canManageOrgShare).toBe(mayManageFundraiserFinancialTerms);
    });
});

describe('2. what the create/edit request carries', () => {
    it('authorized custom share is sent as PERCENT text — 25, never 0.25', () => {
        expect(orgShareRequestField({ user: ADMIN, raw: '25' }))
            .toEqual({ orgSharePercent: '25' });
        expect(orgShareRequestField({ user: SUPER, raw: '28.5' }))
            .toEqual({ orgSharePercent: '28.5' });
    });

    it('never converts to a fraction', () => {
        const sent = orgShareRequestField({ user: ADMIN, raw: '25' }) as any;
        expect(sent.orgSharePercent).not.toBe('0.25');
        expect(sent.orgSharePercent).not.toBe(0.25);
    });

    it('unauthorized viewers never get the key serialized — CHEF and DRIVER', () => {
        // A disabled input's value must not ride along in the body.
        expect(orgShareRequestField({ user: CHEF, raw: '30' })).toEqual({});
        expect(orgShareRequestField({ user: DRIVER, raw: '30' })).toEqual({});
        expect('orgSharePercent' in orgShareRequestField({ user: CHEF, raw: '30' })).toBe(false);
    });

    it('blank means OMIT, so the 20.00 database default applies', () => {
        expect(orgShareRequestField({ user: ADMIN, raw: '' })).toEqual({});
        expect(orgShareRequestField({ user: ADMIN, raw: '   ' })).toEqual({});
    });

    it('an untouched form default of 20 is sent as 20 (explicit but identical to the default)', () => {
        expect(ORG_SHARE_DEFAULT_INPUT).toBe('20');
        expect(orgShareRequestField({ user: ADMIN, raw: ORG_SHARE_DEFAULT_INPUT }))
            .toEqual({ orgSharePercent: '20' });
    });

    it('existing creation without an explicit share still works for everyone', () => {
        // Every non-share caller shape reduces to {} — the request is unchanged.
        for (const user of [ADMIN, SUPER, CHEF, DRIVER, {}]) {
            expect(orgShareRequestField({ user, raw: '' })).toEqual({});
        }
    });
});

describe('3. invalid input cannot be submitted', () => {
    it('flags out-of-range and junk before any round trip', () => {
        for (const bad of ['-1', '101', '100.01', 'twenty', '20%']) {
            expect(orgShareInputError(bad)).not.toBeNull();
        }
    });

    it('accepts the valid range including both bounds', () => {
        for (const good of ['0', '100', '20', '27.5', '25.55']) {
            expect(orgShareInputError(good)).toBeNull();
        }
    });

    it('blank is not an error — it is an omission', () => {
        expect(orgShareInputError('')).toBeNull();
        expect(orgShareInputError('  ')).toBeNull();
    });
});

describe('4. how the field renders per surface', () => {
    it('ADMIN on an open campaign: editable', () => {
        expect(orgShareFieldMode({ user: ADMIN, campaignClosed: false })).toBe('editable');
    });

    it('super-admin on an open campaign: editable', () => {
        expect(orgShareFieldMode({ user: SUPER, campaignClosed: false })).toBe('editable');
    });

    it('CHEF / DRIVER on an open campaign: readonly, not hidden state secrets', () => {
        expect(orgShareFieldMode({ user: CHEF, campaignClosed: false })).toBe('readonly');
        expect(orgShareFieldMode({ user: DRIVER, campaignClosed: false })).toBe('readonly');
    });

    it('a closed campaign is LOCKED for everyone — including ADMIN', () => {
        expect(orgShareFieldMode({ user: ADMIN, campaignClosed: true })).toBe('locked');
        expect(orgShareFieldMode({ user: SUPER, campaignClosed: true })).toBe('locked');
        expect(orgShareFieldMode({ user: CHEF, campaignClosed: true })).toBe('locked');
    });

    it('the locked copy states the truth', () => {
        expect(ORG_SHARE_LOCKED_NOTE).toBe('Organization share is locked after fundraiser closeout.');
    });
});

describe('5. display formatting', () => {
    it('renders natural percentages', () => {
        expect(formatOrgShare(20)).toBe('20%');
        expect(formatOrgShare('20.00')).toBe('20%');
        expect(formatOrgShare(25)).toBe('25%');
        expect(formatOrgShare('27.50')).toBe('27.5%');
        expect(formatOrgShare(28)).toBe('28%');
        expect(formatOrgShare(30)).toBe('30%');
    });

    it('a campaign persisted at 25 loads and displays as 25%', () => {
        // The GET returns org_share_percent as a number; the edit affordance
        // seeds its input from the same value via String().
        expect(formatOrgShare(25)).toBe('25%');
        expect(String(25)).toBe('25');
    });

    it('missing values display as the 20% default, never NaN%', () => {
        expect(formatOrgShare(null)).toBe('20%');
        expect(formatOrgShare(undefined)).toBe('20%');
        expect(formatOrgShare('')).toBe('20%');
    });

    it('never shows engineering noise like 20.000000', () => {
        expect(formatOrgShare(20.000001)).toBe('20%');
    });
});
