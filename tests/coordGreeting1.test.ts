/**
 * COORD-GREETING-1 — the Coordinator Portal greets the CURRENT campaign's assigned coordinator:
 * "Taylor, it's easy as 1-2-3", never the organization's on-file contact ("Lindsey").
 *
 * The REAL GET /api/coordinator runs against the recording Prisma double (session cookie mocked);
 * the REAL LaunchSteps card is rendered to markup. Fictional names only; the repository is public.
 */
import fs from 'fs';
import path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { assignedCoordinatorFirstName, resolveCampaignCoordinator } from '@/lib/campaignCoordinatorContact';
import LaunchSteps from '@/components/coordinator/LaunchSteps';

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__cg1Prisma; } }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === (global as any).__cg1CookieName ? { name, value: 'cg1-test-secret' } : undefined),
    }),
}));

const CAMPAIGN_ID = 'campaign-cg1-a';
const assignment = (displayName: string | null, opts: { ended?: boolean; email?: string | null } = {}) => ({
    org_contact: {
        ended_at: opts.ended ? new Date('2026-10-01T00:00:00Z') : null,
        contact: {
            display_name: displayName,
            contact_points: opts.email === null ? [] : [{ value: opts.email ?? 'taylor@booster.example.test', is_primary: true }],
        },
    },
});

const campaign = () => ({
    id: CAMPAIGN_ID, name: 'Winter Fundraiser', status: 'Active', end_date: null, delivery_date: null, delivery_time: null,
    closed_at: null, settlement_total: null, pickup_location: 'Gym', external_payment_link: null, payment_instructions: null,
    bundle_goal: 40, total_sales: 0, org_share_percent: 20, participant_label: 'Student',
    bundle_selection_status: 'not_required', bundle_selection_limit: 2, public_token: 'public-token-cg1', customer_id: 'org-cg1',
    customer: {
        name: 'Riverside Boosters (fixture)',
        contact_name: 'Lindsey Organizer',                 // the ORGANIZATION's main contact
        contact_email: 'lindsey@boosters.example.test',
        business_id: 'biz-cg1',
        business: { name: 'Example Kitchen', display_name: null, slug: 'example-kitchen', custom_domain: null, contact_email: null, logo_url: null, plan: 'FREE', subscription_status: 'active' },
    },
    orders: [],
});

let mock: PrismaMock;
function world(assigned: any) {
    (global as any).__cg1CookieName = coordinatorSessionCookieName();
    mock = createPrismaMock({
        results: {
            'coordinatorSession.findUnique': { id: 'session-cg1', campaign_id: CAMPAIGN_ID, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null },
            'fundraiserCampaign.findFirst': campaign(),
            'fundraiserCampaignCoordinator.findUnique': assigned,
            'order.findMany': [],
            'bundle.findMany': [],
        },
    });
    (global as any).__cg1Prisma = mock.client;
}
async function greetingFromApi() {
    const { GET } = await import('@/app/api/coordinator/route');
    const res = await GET(new Request('http://localhost/api/coordinator', { method: 'GET', headers: { origin: 'http://localhost' } }) as any);
    expect(res.status).toBe(200);
    return (await res.json()).share;
}
const noop = () => undefined;
const card = (coordinatorFirstName?: string) => renderToStaticMarkup(createElement(LaunchSteps, {
    setupComplete: false, sharingStarted: false, firstOrderReceived: false, hasPaymentInfo: false,
    onSetPayment: noop, onShareEmail: noop, onShareFacebook: noop, onShareText: noop, onCopyLink: noop, copied: false,
    previousSupportersReachable: 0, onPreviousSupporters: noop, onEnterOrder: noop, orderingAllowed: true,
    notifyEmail: null, coordinatorFirstName,
}));
// The portal turns the API's field into the card prop with exactly this expression.
const portalProp = (share: any) => share?.greetingFirstName || undefined;

beforeEach(() => jest.clearAllMocks());

describe('COORD-GREETING-1', () => {
    it('1 · 4 · assigned coordinator Taylor + organization contact Lindsey → "Taylor, it\'s easy as 1-2-3"', async () => {
        world(assignment('Taylor Smith'));
        const share = await greetingFromApi();
        expect(share.greetingFirstName).toBe('Taylor');
        const html = card(portalProp(share));
        expect(html).toContain('Taylor, it&#x27;s easy as 1-2-3');
        expect(html).not.toContain('Lindsey');
    });

    it('2 · changing the campaign\'s coordinator changes the greeting', async () => {
        world(assignment('Taylor Smith'));
        expect((await greetingFromApi()).greetingFirstName).toBe('Taylor');
        world(assignment('Morgan Reyes'));
        expect((await greetingFromApi()).greetingFirstName).toBe('Morgan');
    });

    it('3 · no assigned coordinator (or an ended relationship) → the neutral greeting, never the organization contact', async () => {
        for (const assigned of [null, assignment('Taylor Smith', { ended: true }), { org_contact: null }, assignment('   ')]) {
            world(assigned);
            const share = await greetingFromApi();
            expect(share.greetingFirstName).toBeNull();
            const html = card(portalProp(share));
            expect(html).toContain('It&#x27;s easy as 1-2-3');
            expect(html).not.toMatch(/Lindsey|Taylor/);
        }
    });

    it('an assigned coordinator without a usable email is still the one greeted (a greeting is not a delivery)', async () => {
        world(assignment('Taylor Smith', { email: null }));
        const share = await greetingFromApi();
        expect(share.greetingFirstName).toBe('Taylor');
        // …while operational mail keeps its existing, separate fallback to the organization contact.
        expect(share.coordinatorEmail).toBe('lindsey@boosters.example.test');
    });

    it('first name follows the canonical firstNameOf rule', () => {
        expect(assignedCoordinatorFirstName(assignment('Taylor Smith'))).toBe('Taylor');
        expect(assignedCoordinatorFirstName(assignment('  Mary Ann Jones '))).toBe('Mary');
        expect(assignedCoordinatorFirstName(assignment('Cher'))).toBe('Cher');
        expect(assignedCoordinatorFirstName(assignment(null))).toBeNull();
        expect(assignedCoordinatorFirstName(null)).toBeNull();
        expect(assignedCoordinatorFirstName(undefined)).toBeNull();
    });

    it('5 · everything else about the portal is unchanged: the share recipient still resolves as before', async () => {
        world(assignment('Taylor Smith'));
        const share = await greetingFromApi();
        expect(share.coordinatorName).toBe('Taylor Smith');
        expect(share.coordinatorEmail).toBe('taylor@booster.example.test');
        // The shared resolver itself is untouched (assigned first, organization fallback after).
        expect(resolveCampaignCoordinator({ assignment: null, organization: { contact_name: 'Lindsey Organizer', contact_email: 'lindsey@boosters.example.test' } }))
            .toMatchObject({ name: 'Lindsey Organizer', source: 'organization' });
    });

    it('the portal reads only the server-resolved greeting name — the organization contact is no longer an input', () => {
        const page = R('app/coordinator/portal/page.tsx');
        expect(page).toContain('const coordinatorFirstName = campaign?.share?.greetingFirstName || undefined;');
        expect(page).not.toContain('campaign?.customer?.contact_name?.split(" ")[0]');
        expect(page).toContain('coordinatorFirstName={coordinatorFirstName}');
        const route = R('app/api/coordinator/route.ts');
        expect(route).toContain('greetingFirstName: assignedCoordinatorFirstName(coordinatorAssignment),');
        // The greeting card itself is unchanged.
        expect(R('components/coordinator/LaunchSteps.tsx')).toContain("{coordinatorFirstName ? `${coordinatorFirstName}, it's ` : \"It's \"}easy as 1-2-3");
    });
});
