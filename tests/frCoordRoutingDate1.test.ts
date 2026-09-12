/**
 * FR-COORD-ROUTING-DATE-1 — coordinator notification authority + CRM date display.
 *
 * TWO DEFECTS, BOTH FOUND ON A LIVE CAMPAIGN (Cumberland Co Farm Bureau):
 *
 *   1. The supporter-order notification read Customer.contact_email directly,
 *      so a CAMPAIGN's operational mail went to the ORGANIZATION's relationship
 *      contact (Lindsey Vogt) instead of the coordinator actually assigned to
 *      that campaign (Kristi Shirley) — who had received the setup email and
 *      was running the fundraiser. Neither record was wrong; the code asked the
 *      wrong question.
 *
 *   2. The tenant CRM rendered date-only campaign values with
 *      `new Date(value).toLocaleDateString()`. A deadline stored as 2026-10-07
 *      displayed as October 6 in every U.S. timezone, because midnight UTC is
 *      the previous evening locally.
 *
 * The fixtures below use the real Cumberland shapes.
 */
import {
    CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT,
    readAssignedCoordinator,
    resolveCampaignCoordinator,
} from '@/lib/campaignCoordinatorContact';
import {
    formatCalendarDateShortValue,
    formatCalendarDateNumericValue,
    formatCalendarDateShort,
} from '@/lib/calendarDate';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readCode = (...p: string[]) => strip(read(...p));

// ── The real Cumberland shapes ───────────────────────────────────────────────
const KRISTI = 'manager@cumberlandcfb.org';
const LINDSEY = 'lindsey.vogt@fairpoint.net';

const cumberlandAssignment = (over: Record<string, any> = {}) => ({
    org_contact: {
        ended_at: null,
        contact: {
            display_name: 'Kristi Shirley',
            contact_points: [{ value: KRISTI }],
        },
        ...over,
    },
});
const cumberlandOrganization = {
    contact_name: 'Lindsey Vogt',
    contact_email: LINDSEY,
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. COORDINATOR ROUTING AUTHORITY
// ═════════════════════════════════════════════════════════════════════════════
describe('1. assigned campaign coordinator wins', () => {
    it('1. the assigned coordinator beats the organization contact', () => {
        const r = resolveCampaignCoordinator({
            assignment: cumberlandAssignment(),
            organization: cumberlandOrganization,
        });
        expect(r.email).toBe(KRISTI);
        expect(r.source).toBe('assigned');
    });

    it('2. the Cumberland fixture resolves Kristi, NOT Lindsey', () => {
        const r = resolveCampaignCoordinator({
            assignment: cumberlandAssignment(),
            organization: cumberlandOrganization,
        });
        expect(r.email).toBe('manager@cumberlandcfb.org');
        expect(r.email).not.toBe('lindsey.vogt@fairpoint.net');
        expect(r.name).toBe('Kristi Shirley');
    });

    it('3. no assignment -> organization contact fallback', () => {
        for (const assignment of [null, undefined, {}, { org_contact: null }]) {
            const r = resolveCampaignCoordinator({
                assignment: assignment as any,
                organization: cumberlandOrganization,
            });
            expect(r.email).toBe(LINDSEY);
            expect(r.source).toBe('organization');
            expect(r.assigned.usable).toBe(false);
        }
    });

    it('4. assigned contact with no usable email falls back safely', () => {
        const cases: Array<[string, any]> = [
            ['no contact points', cumberlandAssignment({ contact: { display_name: 'Kristi Shirley', contact_points: [] } })],
            ['null contact points', cumberlandAssignment({ contact: { display_name: 'Kristi Shirley', contact_points: null } })],
            ['blank value', cumberlandAssignment({ contact: { display_name: 'K', contact_points: [{ value: '   ' }] } })],
            ['malformed address', cumberlandAssignment({ contact: { display_name: 'K', contact_points: [{ value: 'not-an-email' }] } })],
            ['domain with no dot', cumberlandAssignment({ contact: { display_name: 'K', contact_points: [{ value: 'a@localhost' }] } })],
            ['embedded whitespace', cumberlandAssignment({ contact: { display_name: 'K', contact_points: [{ value: 'a b@x.com' }] } })],
        ];
        for (const [label, assignment] of cases) {
            const r = resolveCampaignCoordinator({ assignment, organization: cumberlandOrganization });
            expect([label, r.email]).toEqual([label, LINDSEY]);
            expect(r.source).toBe('organization');
        }
    });

    it('an ENDED relationship is not used, even with a valid address on file', () => {
        const r = resolveCampaignCoordinator({
            assignment: cumberlandAssignment({ ended_at: new Date('2026-09-01T00:00:00Z') }),
            organization: cumberlandOrganization,
        });
        expect(r.email).toBe(LINDSEY);
        expect(r.assigned).toEqual({ usable: false, reason: 'relationship_ended' });
    });

    it('name and email fall back TOGETHER — never Kristi\'s name at Lindsey\'s address', () => {
        const r = resolveCampaignCoordinator({
            assignment: cumberlandAssignment({ contact: { display_name: 'Kristi Shirley', contact_points: [] } }),
            organization: cumberlandOrganization,
        });
        expect(r.email).toBe(LINDSEY);
        expect(r.name).toBe('Lindsey Vogt');
        expect(r.name).not.toBe('Kristi Shirley');
    });

    it('nothing deliverable anywhere resolves to none, never to a junk address', () => {
        for (const org of [null, {}, { contact_email: '' }, { contact_email: 'nope' }]) {
            const r = resolveCampaignCoordinator({ assignment: null, organization: org as any });
            expect(r.email).toBeNull();
            expect(r.source).toBe('none');
        }
    });

    it('the first CURRENT primary email is chosen when several are on file', () => {
        const r = readAssignedCoordinator(cumberlandAssignment({
            contact: { display_name: 'Kristi Shirley', contact_points: [{ value: KRISTI }, { value: 'second@x.com' }] },
        }));
        expect(r).toEqual({ usable: true, name: 'Kristi Shirley', email: KRISTI });
    });

    it('a malformed FIRST address does not block a valid second one', () => {
        const r = readAssignedCoordinator(cumberlandAssignment({
            contact: { display_name: 'K', contact_points: [{ value: 'broken' }, { value: KRISTI }] },
        }));
        expect(r).toEqual({ usable: true, name: 'K', email: KRISTI });
    });

    it('the address is returned as stored — validation does not lowercase the recipient', () => {
        const r = readAssignedCoordinator(cumberlandAssignment({
            contact: { display_name: 'K', contact_points: [{ value: 'Manager@CumberlandCFB.org' }] },
        }));
        expect(r.usable && r.email).toBe('Manager@CumberlandCFB.org');
    });

    it('5. the resolver never mutates the organization record it was handed', () => {
        const org = { ...cumberlandOrganization };
        const snapshot = JSON.stringify(org);
        resolveCampaignCoordinator({ assignment: cumberlandAssignment(), organization: org });
        resolveCampaignCoordinator({ assignment: null, organization: org });
        expect(JSON.stringify(org)).toBe(snapshot);
        expect(org.contact_email).toBe(LINDSEY);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE ROUTES ACTUALLY USE IT
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the notification path is wired to the shared resolver', () => {
    const orderRoute = readCode('app', 'api', 'public', 'order', 'route.ts');

    it('the order route resolves the coordinator instead of reading contact_email directly', () => {
        expect(orderRoute).toMatch(/resolveCampaignCoordinator\(\{/);
        expect(orderRoute).toMatch(/CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT/);
        expect(orderRoute).toMatch(/orgContactEmail = campaignCoordinator\.email/);
        // The defect, in its exact original form, must not come back.
        expect(orderRoute).not.toMatch(/orgContactEmail = campaign\.customer\.contact_email/);
    });

    it('the assignment lookup is keyed by THIS campaign', () => {
        expect(orderRoute).toMatch(/fundraiserCampaignCoordinator\.findUnique\(\{\s*[\r\n]+\s*where:\s*\{\s*campaign_id:\s*campaign\.id\s*\}/);
    });

    it('a failed lookup cannot fail the order — it is caught and falls back', () => {
        const block = orderRoute.slice(
            orderRoute.indexOf('coordinatorAssignment = await'),
            orderRoute.indexOf('orgContactEmail = campaignCoordinator.email'),
        );
        expect(block).toMatch(/catch\s*\(coordErr\)/);
    });

    it('7. exactly ONE coordinator notification is sent, and only for a campaign order', () => {
        const calls = orderRoute.match(/sendFundraiserCoordinatorNotification\(/g) || [];
        // One import-site call. (The dynamic import names it once more.)
        expect(calls.length).toBe(1);
        const idx = orderRoute.indexOf('sendFundraiserCoordinatorNotification(');
        const gate = orderRoute.lastIndexOf('if (campaign) {', idx);
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(idx);
        // And it only fires when an address actually resolved.
        expect(orderRoute).toMatch(/const coordinatorEmail = orgContactEmail\?\.trim\(\);\s*[\r\n]+\s*if \(coordinatorEmail\) \{/);
    });

    it('the coordinator portal uses the SAME resolver — no second copy of the rule', () => {
        const coordRoute = readCode('app', 'api', 'coordinator', 'route.ts');
        expect(coordRoute).toMatch(/resolveCampaignCoordinator\(\{/);
        expect(coordRoute).toMatch(/CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT/);
        // The old inline duplicate is gone.
        expect(coordRoute).not.toMatch(/assigned\.org_contact\.contact\.contact_points\[0\]/);
    });

    it('the portal card names the address the notification will really use', () => {
        const portal = readCode('app', 'coordinator', 'portal', 'page.tsx');
        expect(portal).toMatch(/const notifyEmail: string \| null = campaign\?\.share\?\.coordinatorEmail \?\? null;/);
        expect(portal).not.toMatch(/notifyEmail[^\n]*campaign\.customer\?\.contact_email/);
    });

    it('6. the setup/invite route still resolves the ASSIGNED coordinator, and still refuses rather than falling back', () => {
        const invite = readCode('app', 'api', 'campaigns', '[id]', 'coordinator-email', 'route.ts');
        expect(invite).toMatch(/readAssignedCoordinator\(/);
        expect(invite).toMatch(/CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT/);
        // All three original refusals survive, with their messages.
        expect(invite).toMatch(/This fundraiser has no primary coordinator yet\./);
        expect(invite).toMatch(/no longer an active contact for this organization\./);
        expect(invite).toMatch(/has no email address on file\./);
        // It must NOT have gained the organization fallback.
        expect(invite).not.toMatch(/resolveCampaignCoordinator/);
    });

    it('the organization contact is still selected and still displayed — not deleted', () => {
        const coordRoute = readCode('app', 'api', 'coordinator', 'route.ts');
        expect(coordRoute).toMatch(/contact_email: true/);
        expect(coordRoute).toMatch(/contact_name: true/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. CRM DATE DISPLAY — calendar-stable in every U.S. timezone
// ═════════════════════════════════════════════════════════════════════════════
describe('3. date-only values render as the stored calendar date', () => {
    const CASES: Array<[string, string, string]> = [
        // stored value              short form        numeric form
        ['2026-10-07T00:00:00.000Z', 'Oct 7, 2026', '10/7/2026'],
        ['2026-10-12T00:00:00.000Z', 'Oct 12, 2026', '10/12/2026'],
        ['2026-01-01T00:00:00.000Z', 'Jan 1, 2026', '1/1/2026'],
        ['2026-12-31T00:00:00.000Z', 'Dec 31, 2026', '12/31/2026'],
    ];

    it('the formatters produce the stored date, not the local one', () => {
        for (const [stored, short, numeric] of CASES) {
            expect(formatCalendarDateShortValue(stored)).toBe(short);
            expect(formatCalendarDateNumericValue(stored)).toBe(numeric);
        }
    });

    it('Cumberland: stored 2026-10-07 shows October 7, never October 6', () => {
        expect(formatCalendarDateShortValue('2026-10-07T00:00:00.000Z')).toBe('Oct 7, 2026');
        expect(formatCalendarDateNumericValue('2026-10-07T00:00:00.000Z')).toBe('10/7/2026');
        expect(formatCalendarDateNumericValue('2026-10-07T00:00:00.000Z')).not.toBe('10/6/2026');
    });

    it('THE BUG IS REAL: the replaced call would shift the day in every U.S. zone', () => {
        for (const tz of ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles']) {
            const naive = new Date('2026-10-07T00:00:00.000Z').toLocaleDateString('en-US', { timeZone: tz });
            expect(naive).toBe('10/6/2026');
        }
        // UTC is the one zone where the old code looked correct — which is
        // exactly why this survived review.
        expect(new Date('2026-10-07T00:00:00.000Z').toLocaleDateString('en-US', { timeZone: 'UTC' })).toBe('10/7/2026');
    });

    it('Date and string inputs agree', () => {
        const d = new Date('2026-10-07T00:00:00.000Z');
        expect(formatCalendarDateShortValue(d)).toBe(formatCalendarDateShortValue('2026-10-07T00:00:00.000Z'));
        expect(formatCalendarDateShortValue(d)).toBe(formatCalendarDateShort(d));
    });

    it('absent and unparseable values return null rather than "Invalid Date"', () => {
        for (const v of [null, undefined, '', 'not-a-date']) {
            expect(formatCalendarDateShortValue(v as any)).toBeNull();
            expect(formatCalendarDateNumericValue(v as any)).toBeNull();
        }
    });

    it('runs identically under America/Chicago, New_York, Denver and Los_Angeles', () => {
        // Genuinely re-executed with TZ set, not merely asserted: the formatters
        // read UTC fields only, so this must hold in a real process.
        const script = `
            const { formatCalendarDateShortValue, formatCalendarDateNumericValue } = require('./lib/calendarDate.ts');
            console.log(JSON.stringify([
                formatCalendarDateShortValue('2026-10-07T00:00:00.000Z'),
                formatCalendarDateNumericValue('2026-10-07T00:00:00.000Z'),
                formatCalendarDateShortValue('2026-10-12T00:00:00.000Z'),
                formatCalendarDateNumericValue('2026-10-12T00:00:00.000Z'),
            ]));
        `;
        const expected = JSON.stringify(['Oct 7, 2026', '10/7/2026', 'Oct 12, 2026', '10/12/2026']);
        for (const tz of ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'UTC']) {
            const out = execFileSync(
                process.execPath,
                ['--experimental-strip-types', '-e', script],
                { cwd: process.cwd(), env: { ...process.env, TZ: tz }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
            ).trim();
            expect([tz, out]).toEqual([tz, expected]);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE CRM CALL SITES, AND WHAT MUST NOT HAVE CHANGED
// ═════════════════════════════════════════════════════════════════════════════
describe('4. only date-only displays were changed', () => {
    const SITES: Array<[string[], string]> = [
        [['components', 'crm', 'FundraisersTab.tsx'], 'formatCalendarDateNumericValue(campaign.end_date)'],
        [['components', 'crm2', 'CampaignCard.tsx'], 'formatCalendarDateNumericValue(c.end_date)'],
        [['components', 'crm2', 'ArchivedCampaignList.tsx'], 'formatCalendarDateShortValue(end!)'],
        [['components', 'crm2', 'CampaignPriorityList.tsx'], 'formatCalendarDateShortValue(end!)'],
    ];

    for (const [file, needle] of SITES) {
        it(`${file[file.length - 1]} renders end_date through the shared formatter`, () => {
            const src = readCode(...file);
            expect(src).toContain(needle);
            expect(src).toMatch(/from '@\/lib\/calendarDate'/);
            // No naive parse of end_date survives in this file.
            expect(src).not.toMatch(/new Date\((campaign\.end_date|c\.end_date)\)\.toLocaleDateString/);
        });
    }

    it('REAL TIMESTAMPS were left on local formatting — they are instants, not calendar dates', () => {
        // closed_at, bundle_selection_at, uploaded_at, updated_at and activity
        // timestamps must keep normal local rendering. Flattening them to UTC
        // fields would be the same bug in the opposite direction.
        expect(readCode('components', 'crm2', 'CampaignCard.tsx'))
            .toMatch(/new Date\(c\.closed_at\)\.toLocaleDateString\(\)/);
        expect(readCode('components', 'crm2', 'BundleSelectionStatusCard.tsx'))
            .toMatch(/new Date\(campaign\.selectedAt\)\.toLocaleDateString\(\)/);
        expect(readCode('components', 'crm', 'DocumentsTab.tsx'))
            .toMatch(/new Date\(doc\.updated_at\)\.toLocaleDateString\(\)/);
        expect(readCode('components', 'crm', 'ActivityFeed.tsx'))
            .toMatch(/new Date\(act\.timestamp\)\.toLocaleString\(\)/);
    });

    it('the already-safe T12:00:00 date-only sites were not disturbed', () => {
        for (const f of [
            ['components', 'crm', 'CustomerOverview.tsx'],
            ['components', 'crm', 'FundraiserOverview.tsx'],
            ['components', 'crm', 'MarketingFlyer.tsx'],
        ]) {
            expect(readCode(...f)).toMatch(/\+ 'T12:00:00'\)/);
        }
    });

    it('lib/calendarDate.ts remains the ONE date-only authority — no new ad hoc helper appeared', () => {
        const src = readCode('lib', 'calendarDate.ts');
        expect(src).toMatch(/export function formatCalendarDateShortValue/);
        expect(src).toMatch(/export function formatCalendarDateNumericValue/);
        // Both new entry points delegate to the existing UTC-field rule.
        expect(src).toMatch(/getUTCMonth|formatCalendarDateShort/);
    });
});
