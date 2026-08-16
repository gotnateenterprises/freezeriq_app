/**
 * INV-A — campaign closeout authorization and the closed-campaign predicate.
 *
 * Failure modes pinned here:
 *  - a CHEF or DRIVER freezing a fundraiser's money and releasing its held
 *    production orders
 *  - the closed-status list drifting between the closeout claim and the
 *    org_share_percent edit lock, so the share can be edited after settlement
 *  - a legacy row with a closed status but no closed_at being treated as open
 *
 * Real-database behaviour (the partial unique index, the CHECK bounds, and the
 * conditional-claim race) is proven separately against a disposable Postgres
 * schema; that cannot be faked with mocks and is not attempted here.
 */

import { mayCloseOutCampaign } from '@/lib/campaignCloseout';
import { CLOSED_STATUSES, isCampaignClosed } from '@/lib/campaignBundleSelection';

describe('1. only an ADMIN or super-admin may close out a fundraiser', () => {
    it('allows ADMIN', () => {
        expect(mayCloseOutCampaign({ role: 'ADMIN', isSuperAdmin: false })).toBe(true);
    });

    it('allows a super-admin regardless of role string', () => {
        expect(mayCloseOutCampaign({ role: 'CHEF', isSuperAdmin: true })).toBe(true);
        expect(mayCloseOutCampaign({ role: undefined, isSuperAdmin: true })).toBe(true);
    });

    it('refuses CHEF — the owner decision excludes kitchen staff by default', () => {
        expect(mayCloseOutCampaign({ role: 'CHEF', isSuperAdmin: false })).toBe(false);
    });

    it('refuses DRIVER', () => {
        expect(mayCloseOutCampaign({ role: 'DRIVER', isSuperAdmin: false })).toBe(false);
    });

    it('refuses an authenticated user with no role at all', () => {
        expect(mayCloseOutCampaign({})).toBe(false);
        expect(mayCloseOutCampaign({ role: null, isSuperAdmin: null })).toBe(false);
    });

    it('is case-sensitive — "admin" is not ADMIN', () => {
        expect(mayCloseOutCampaign({ role: 'admin' })).toBe(false);
        expect(mayCloseOutCampaign({ role: 'Admin' })).toBe(false);
    });

    it('refuses a merely truthy isSuperAdmin', () => {
        // A string flag off a JWT must not open a financial gate by coercion.
        expect(mayCloseOutCampaign({ role: 'CHEF', isSuperAdmin: 'true' })).toBe(false);
        expect(mayCloseOutCampaign({ role: 'CHEF', isSuperAdmin: 1 })).toBe(false);
    });
});

describe('2. the closed-status family has exactly one definition', () => {
    it('is the four financially-closed statuses', () => {
        expect([...CLOSED_STATUSES]).toEqual(['Closed', 'Settled', 'Completed', 'Archived']);
    });

    it('every listed status reads as closed', () => {
        for (const status of CLOSED_STATUSES) {
            expect(isCampaignClosed({ closed_at: null, status })).toBe(true);
        }
    });

    it('open lifecycle statuses read as open', () => {
        for (const status of ['Lead', 'Active', 'Scheduled', 'Delivered']) {
            expect(isCampaignClosed({ closed_at: null, status })).toBe(false);
        }
    });
});

describe('3. either signal alone is enough to lock the money', () => {
    it('closed_at set with an open status still counts as closed', () => {
        // The closeout claim writes both, but a row mid-migration may carry only
        // the timestamp; the org-share edit must still be refused.
        expect(isCampaignClosed({ closed_at: new Date('2026-08-14'), status: 'Active' })).toBe(true);
    });

    it('a closed status with no closed_at still counts as closed', () => {
        expect(isCampaignClosed({ closed_at: null, status: 'Settled' })).toBe(true);
    });

    it('neither signal means open, and the share stays editable', () => {
        expect(isCampaignClosed({ closed_at: null, status: 'Active' })).toBe(false);
    });
});
