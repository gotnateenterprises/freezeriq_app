/**
 * INV-A — financial-terms authorization for the fundraiser organization share.
 *
 * Owner ruling: the organization share decides how much of gross fundraiser
 * sales belongs to the organization, so only an ADMIN or super-admin may
 * explicitly set or change it. CHEF and DRIVER may not.
 *
 * Failure modes pinned here:
 *  - a CHEF or DRIVER quietly moving the money split
 *  - an unauthorized override being SILENTLY ignored (accepting the request but
 *    storing 20.00) instead of truthfully refusing it
 *  - the gate accidentally making ordinary fundraiser CREATION admin-only
 *  - create and edit drifting apart on which check wins
 *  - an authorized admin editing the share after closeout froze it
 */

import {
    decideOrgShareChange,
    isOrgShareRejected,
    mayManageFundraiserFinancialTerms,
    DEFAULT_ORG_SHARE_PERCENT,
    ORG_SHARE_FORBIDDEN_MESSAGE,
} from '@/lib/fundraiserOrgShare';

const ADMIN = { role: 'ADMIN', isSuperAdmin: false };
const SUPER = { role: 'CHEF', isSuperAdmin: true };
const CHEF = { role: 'CHEF', isSuperAdmin: false };
const DRIVER = { role: 'DRIVER', isSuperAdmin: false };

/** Campaign creation: a new campaign can never already be closed. */
const onCreate = (requested: unknown, user: any) =>
    decideOrgShareChange({ requested, user, campaignClosed: false });

/** Campaign edit while financially open. */
const onEditOpen = (requested: unknown, user: any) =>
    decideOrgShareChange({ requested, user, campaignClosed: false });

/** Campaign edit after closeout froze the terms. */
const onEditClosed = (requested: unknown, user: any) =>
    decideOrgShareChange({ requested, user, campaignClosed: true });

describe('1. who may manage fundraiser financial terms', () => {
    it('ADMIN may', () => {
        expect(mayManageFundraiserFinancialTerms(ADMIN)).toBe(true);
    });

    it('a super-admin may, whatever the role string says', () => {
        expect(mayManageFundraiserFinancialTerms(SUPER)).toBe(true);
        expect(mayManageFundraiserFinancialTerms({ isSuperAdmin: true })).toBe(true);
    });

    it('CHEF may not', () => {
        expect(mayManageFundraiserFinancialTerms(CHEF)).toBe(false);
    });

    it('DRIVER may not', () => {
        expect(mayManageFundraiserFinancialTerms(DRIVER)).toBe(false);
    });

    it('a role-less authenticated user may not', () => {
        expect(mayManageFundraiserFinancialTerms({})).toBe(false);
    });

    it('is case-sensitive and refuses coerced truthiness', () => {
        expect(mayManageFundraiserFinancialTerms({ role: 'admin' })).toBe(false);
        expect(mayManageFundraiserFinancialTerms({ role: 'CHEF', isSuperAdmin: 'true' })).toBe(false);
        expect(mayManageFundraiserFinancialTerms({ role: 'CHEF', isSuperAdmin: 1 })).toBe(false);
    });

    it('is a SEPARATE decision from closeout authorization', () => {
        // They agree today by owner ruling. This test exists so that if one is
        // ever widened, the other is changed deliberately rather than by import.
        const { mayCloseOutCampaign } = require('@/lib/campaignCloseout');
        for (const u of [ADMIN, SUPER, CHEF, DRIVER]) {
            expect(mayManageFundraiserFinancialTerms(u)).toBe(mayCloseOutCampaign(u));
        }
    });
});

describe('2. explicit override at campaign CREATION', () => {
    it('ADMIN may set a custom share', () => {
        expect(onCreate(30, ADMIN)).toEqual({ change: true, percent: 30 });
    });

    it('a super-admin may set a custom share', () => {
        expect(onCreate('27.5', SUPER)).toEqual({ change: true, percent: 27.5 });
    });

    it('CHEF is refused with 403', () => {
        const d = onCreate(30, CHEF);
        expect(isOrgShareRejected(d) && d.status).toBe(403);
        expect(isOrgShareRejected(d) && d.error).toBe(ORG_SHARE_FORBIDDEN_MESSAGE);
    });

    it('DRIVER is refused with 403', () => {
        const d = onCreate(30, DRIVER);
        expect(isOrgShareRejected(d) && d.status).toBe(403);
    });

    it('the refusal is TRUTHFUL — it never silently downgrades 30 to 20', () => {
        const d = onCreate(30, CHEF);
        expect(d.change).toBe(false);
        expect((d as any).percent).toBeUndefined();
        expect(isOrgShareRejected(d)).toBe(true);
    });
});

describe('3. omitting the share keeps existing creation behaviour', () => {
    it('an unauthorized caller may still create a fundraiser — no change requested', () => {
        for (const u of [CHEF, DRIVER, {}]) {
            for (const omitted of [undefined, null, '']) {
                const d = onCreate(omitted, u);
                expect(d).toEqual({ change: false });
                expect(isOrgShareRejected(d)).toBe(false);
            }
        }
    });

    it('no explicit value means the database default stands', () => {
        expect(onCreate(undefined, CHEF)).toEqual({ change: false });
        expect(DEFAULT_ORG_SHARE_PERCENT).toBe(20);
    });

    it('an ADMIN omitting it also writes nothing, taking the same default', () => {
        expect(onCreate(undefined, ADMIN)).toEqual({ change: false });
    });
});

describe('4. explicit change on an OPEN campaign', () => {
    it('ADMIN may edit the share', () => {
        expect(onEditOpen(35, ADMIN)).toEqual({ change: true, percent: 35 });
    });

    it('a super-admin may edit the share', () => {
        expect(onEditOpen(35, SUPER)).toEqual({ change: true, percent: 35 });
    });

    it('CHEF is refused with 403', () => {
        const d = onEditOpen(35, CHEF);
        expect(isOrgShareRejected(d) && d.status).toBe(403);
    });

    it('DRIVER is refused with 403', () => {
        const d = onEditOpen(35, DRIVER);
        expect(isOrgShareRejected(d) && d.status).toBe(403);
    });

    it('an unauthorized caller editing OTHER fields is unaffected', () => {
        // Omission is the shape a non-financial edit takes.
        expect(onEditOpen(undefined, CHEF)).toEqual({ change: false });
    });
});

describe('5. post-closeout immutability survives, for everyone', () => {
    it('even an ADMIN cannot change the share after closeout', () => {
        const d = onEditClosed(35, ADMIN);
        expect(isOrgShareRejected(d) && d.status).toBe(409);
    });

    it('even a super-admin cannot', () => {
        const d = onEditClosed(35, SUPER);
        expect(isOrgShareRejected(d) && d.status).toBe(409);
    });

    it('an unauthorized caller gets 403 BEFORE the closed check leaks state', () => {
        // Both gates fail; authorization must win so a CHEF cannot use the
        // status code to learn whether a campaign has been closed out.
        const d = onEditClosed(35, CHEF);
        expect(isOrgShareRejected(d) && d.status).toBe(403);
    });

    it('a closed campaign still accepts non-financial edits (no change requested)', () => {
        expect(onEditClosed(undefined, ADMIN)).toEqual({ change: false });
    });
});

describe('6. validation is not weakened by the new gate', () => {
    it('an authorized admin still cannot set an out-of-range share', () => {
        for (const bad of [-0.01, 100.01, -1, 1000]) {
            const d = onEditOpen(bad, ADMIN);
            expect(isOrgShareRejected(d) && d.status).toBe(400);
        }
    });

    it('an authorized admin still cannot set junk', () => {
        for (const bad of ['twenty', '20%', NaN, Infinity, true, [], {}]) {
            const d = onEditOpen(bad, ADMIN);
            expect(isOrgShareRejected(d) && d.status).toBe(400);
        }
    });

    it('boundaries remain inclusive for an authorized admin', () => {
        expect(onEditOpen(0, ADMIN)).toEqual({ change: true, percent: 0 });
        expect(onEditOpen(100, ADMIN)).toEqual({ change: true, percent: 100 });
    });

    it('an UNAUTHORIZED caller is refused before validation even runs', () => {
        // 403, not 400 — the response must not confirm whether the value parsed.
        const d = onEditOpen('not-a-number', CHEF);
        expect(isOrgShareRejected(d) && d.status).toBe(403);
    });

    it('still normalises to two decimals for an authorized admin', () => {
        expect(onEditOpen('25.555', ADMIN)).toEqual({ change: true, percent: 25.56 });
    });
});

describe('8. the generic customer/profile route has no authority over the share', () => {
    // Structural guard, not a logic test: the organization-profile save writes an
    // explicit field list. If anyone ever adds org_share_percent to it, that
    // route would edit a financial term with no financial-terms gate at all.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'app', 'api', 'customers', '[id]', 'route.ts'),
        'utf8'
    );

    it('never writes org_share_percent', () => {
        const writes = src
            .split('\n')
            .filter((l: string) => l.includes('org_share_percent') && !l.trimStart().startsWith('//'));
        expect(writes).toEqual([]);
    });

    it('never accepts an orgSharePercent input', () => {
        expect(src.includes('orgSharePercent')).toBe(false);
    });
});

describe('7. create and edit cannot drift apart', () => {
    it('the same inputs decide identically on an open campaign', () => {
        const cases: Array<[unknown, any]> = [
            [30, ADMIN], [30, SUPER], [30, CHEF], [30, DRIVER],
            [undefined, CHEF], [null, DRIVER], ['', ADMIN],
            [-5, ADMIN], ['abc', ADMIN], [0, ADMIN], [100, SUPER],
        ];
        for (const [requested, user] of cases) {
            expect(onCreate(requested, user)).toEqual(onEditOpen(requested, user));
        }
    });
});
