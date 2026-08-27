/**
 * FR-REBOOK-2-PREARM — the three correctness gaps that block arming.
 *
 *   1. OUTREACH-RESUBSCRIBE-1        an approved re-subscribe must restore real sendability
 *   2. OUTREACH-PREFERENCE-DISPLAY-1 display truth must equal send truth
 *   3. FR-REBOOK-2-ORIGIN-1          the supporter link must not follow the request host
 *
 * The end-to-end suppression tests drive the SAME functions the send path uses,
 * not a paraphrase of them.
 */
process.env.TZ = 'America/Chicago';

import fs from 'fs';
import path from 'path';
import {
    decideAddressRelease,
    describeAddressRelease,
} from '../lib/outreachResubscribe';
import { evaluateSuppression, checkSuppressionAtSend, type SendableRecipient } from '../lib/outreachSend';
import { resolveActivePreference, type PreferenceRow } from '../lib/rebookingRowState';
import { buildSupporterOrderUrl, buildInviteDraft } from '../lib/previousSupporterInvite';
import { derivePreviousSupporters } from '../lib/previousSupporters';
import { normalizeEmail } from '../lib/seasonalAudience';

const BIZ = 'biz-1';
const OTHER = 'biz-2';
const EMAIL = 'bonnie@example.com';
const NOW = new Date('2026-08-26T12:00:00Z');

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── GAP 1 — RESUBSCRIBE AUTHORITY ──────────────────────────────────────────
describe('OUTREACH-RESUBSCRIBE-1 · which addresses an approved re-subscribe may release', () => {
    it('releases an address when the re-subscribe covers its only owner', () => {
        const d = decideAddressRelease({
            resubscribingContactIds: ['c1'],
            ownership: [{ contactId: 'c1', normalizedEmail: EMAIL }],
            addressPreferences: [{ normalizedEmail: EMAIL, status: 'unsubscribed' }],
        });
        expect(d).toEqual([{ normalizedEmail: EMAIL, outcome: 'released', heldBackForContactIds: [] }]);
    });

    it('HOLDS BACK a shared inbox when someone using it is not included', () => {
        // The rule FR-RETENTION-2 was protecting: one person cannot consent on
        // behalf of an inbox two other people also read.
        const d = decideAddressRelease({
            resubscribingContactIds: ['c1'],
            ownership: [
                { contactId: 'c1', normalizedEmail: EMAIL },
                { contactId: 'c2', normalizedEmail: EMAIL },
                { contactId: 'c3', normalizedEmail: EMAIL },
            ],
            addressPreferences: [{ normalizedEmail: EMAIL, status: 'unsubscribed' }],
        });
        expect(d[0].outcome).toBe('shared_with_others');
        expect(d[0].heldBackForContactIds).toEqual(['c2', 'c3']);
    });

    it('releases a shared inbox when EVERY sharer is re-subscribed together', () => {
        // Which is what the audience drawer already sends — it passes every
        // contact grouped onto the row.
        const d = decideAddressRelease({
            resubscribingContactIds: ['c1', 'c2'],
            ownership: [
                { contactId: 'c1', normalizedEmail: EMAIL },
                { contactId: 'c2', normalizedEmail: EMAIL },
            ],
            addressPreferences: [{ normalizedEmail: EMAIL, status: 'unsubscribed' }],
        });
        expect(d[0].outcome).toBe('released');
    });

    it('does nothing for an address that was never suppressed', () => {
        const d = decideAddressRelease({
            resubscribingContactIds: ['c1'],
            ownership: [{ contactId: 'c1', normalizedEmail: EMAIL }],
            addressPreferences: [],
        });
        expect(d[0].outcome).toBe('not_suppressed');
    });

    it('never touches an address the re-subscribed contacts do not use', () => {
        const d = decideAddressRelease({
            resubscribingContactIds: ['c1'],
            ownership: [
                { contactId: 'c1', normalizedEmail: EMAIL },
                { contactId: 'c9', normalizedEmail: 'someone-else@example.com' },
            ],
            addressPreferences: [
                { normalizedEmail: EMAIL, status: 'unsubscribed' },
                { normalizedEmail: 'someone-else@example.com', status: 'unsubscribed' },
            ],
        });
        expect(d.map((x) => x.normalizedEmail)).toEqual([EMAIL]);
    });

    it('tells the tenant plainly when something was held back', () => {
        const held = describeAddressRelease([
            { normalizedEmail: EMAIL, outcome: 'shared_with_others', heldBackForContactIds: ['c2'] },
        ]);
        expect(held.released).toBe(0);
        expect(held.heldBack).toBe(1);
        expect(held.warning).toMatch(/shared/i);
        expect(held.warning).toMatch(/still not receive/i);

        const clean = describeAddressRelease([
            { normalizedEmail: EMAIL, outcome: 'released', heldBackForContactIds: [] },
        ]);
        expect(clean.released).toBe(1);
        expect(clean.warning).toBeNull();
    });
});

// ── The end-to-end sendability proof ───────────────────────────────────────
type PrefRow = {
    id: string; business_id: string; scope: string; contact_id: string | null;
    normalized_email: string | null; status: string; effective_until: Date | null;
    effective_at: Date; permission_note: string | null; recorded_by_user_id: string | null; source: string;
};

function fakePrisma() {
    const prefs: PrefRow[] = [];
    let n = 0;
    const api: any = {
        marketingPreference: {
            findMany: async ({ where }: any) => prefs.filter((p) => {
                if (p.business_id !== where.business_id) return false;
                if (!where.OR) {
                    if (where.scope && p.scope !== where.scope) return false;
                    return true;
                }
                return where.OR.some((o: any) =>
                    (o.scope === 'contact' && p.scope === 'contact' && o.contact_id?.in?.includes(p.contact_id))
                    || (o.scope === 'email_address' && p.scope === 'email_address' && o.normalized_email === p.normalized_email));
            }).map((p) => ({ ...p })),
            findFirst: async ({ where }: any) => {
                const hit = prefs.find((p) => p.business_id === where.business_id
                    && (where.scope === undefined || p.scope === where.scope)
                    && (where.contact_id === undefined || p.contact_id === where.contact_id)
                    && (where.normalized_email === undefined || p.normalized_email === where.normalized_email));
                return hit ? { ...hit } : null;
            },
            update: async ({ where, data }: any) => {
                const row = prefs.find((p) => p.id === where.id)!;
                Object.assign(row, data);
                return { ...row };
            },
            create: async ({ data }: any) => {
                const row = { id: `p${++n}`, contact_id: null, normalized_email: null, effective_at: NOW, ...data } as PrefRow;
                prefs.push(row);
                return { ...row };
            },
        },
        __prefs: prefs,
    };
    return api;
}

describe('OUTREACH-RESUBSCRIBE-1 · end-to-end sendability', () => {
    const recipient: SendableRecipient = {
        recipientId: 'r1', normalizedEmail: EMAIL, displayName: 'Bonnie',
        contactIds: ['c1'], organizationNames: [],
    };

    it('sendable -> public unsubscribe -> suppressed -> approved re-subscribe -> sendable again', async () => {
        const p = fakePrisma();

        // 1. Initially reachable.
        await expect(checkSuppressionAtSend(p, BIZ, recipient, NOW))
            .resolves.toEqual({ suppressed: false, reason: null });

        // 2. The recipient unsubscribes publicly — an ADDRESS-scope row.
        await p.marketingPreference.create({
            data: {
                business_id: BIZ, scope: 'email_address', normalized_email: EMAIL,
                status: 'unsubscribed', effective_until: null, source: 'contact_request',
                recorded_by_user_id: null,
            },
        });
        expect((await checkSuppressionAtSend(p, BIZ, recipient, NOW)).suppressed).toBe(true);

        // 3. The OLD behaviour: a contact-scope subscribed row alone. Still suppressed.
        await p.marketingPreference.create({
            data: {
                business_id: BIZ, scope: 'contact', contact_id: 'c1',
                status: 'subscribed', effective_until: null, source: 'tenant',
                permission_note: 'they asked us to at the fair',
            },
        });
        expect((await checkSuppressionAtSend(p, BIZ, recipient, NOW)).suppressed).toBe(true);

        // 4. The FIX: the approved re-subscribe also releases the address it owns.
        const decisions = decideAddressRelease({
            resubscribingContactIds: ['c1'],
            ownership: [{ contactId: 'c1', normalizedEmail: EMAIL }],
            addressPreferences: [{ normalizedEmail: EMAIL, status: 'unsubscribed' }],
        });
        expect(decisions[0].outcome).toBe('released');
        const row = await p.marketingPreference.findFirst({
            where: { business_id: BIZ, scope: 'email_address', normalized_email: EMAIL },
        });
        await p.marketingPreference.update({
            where: { id: row.id },
            data: { status: 'subscribed', effective_until: null, source: 'tenant' },
        });

        // 5. Sendable again — proven through the SEND authority, not a UI label.
        await expect(checkSuppressionAtSend(p, BIZ, recipient, NOW))
            .resolves.toEqual({ suppressed: false, reason: null });
    });

    it('another tenant is unaffected by either the opt-out or the release', async () => {
        const p = fakePrisma();
        await p.marketingPreference.create({
            data: {
                business_id: OTHER, scope: 'email_address', normalized_email: EMAIL,
                status: 'unsubscribed', effective_until: null, source: 'contact_request',
            },
        });
        expect((await checkSuppressionAtSend(p, OTHER, recipient, NOW)).suppressed).toBe(true);
        expect((await checkSuppressionAtSend(p, BIZ, recipient, NOW)).suppressed).toBe(false);
    });

    it('a held-back shared address leaves the recipient genuinely suppressed', async () => {
        const p = fakePrisma();
        await p.marketingPreference.create({
            data: {
                business_id: BIZ, scope: 'email_address', normalized_email: EMAIL,
                status: 'unsubscribed', effective_until: null, source: 'contact_request',
            },
        });
        const decisions = decideAddressRelease({
            resubscribingContactIds: ['c1'],
            ownership: [
                { contactId: 'c1', normalizedEmail: EMAIL },
                { contactId: 'c2', normalizedEmail: EMAIL },
            ],
            addressPreferences: [{ normalizedEmail: EMAIL, status: 'unsubscribed' }],
        });
        expect(decisions[0].outcome).toBe('shared_with_others');
        // Nothing released, so the send path still refuses — and the response
        // says so instead of claiming success.
        expect((await checkSuppressionAtSend(p, BIZ, recipient, NOW)).suppressed).toBe(true);
        expect(describeAddressRelease(decisions).warning).toBeTruthy();
    });
});

describe('OUTREACH-RESUBSCRIBE-1 · shipped route contract', () => {
    const route = strip(R('app/api/rebooking/marketing-preferences/route.ts'));

    it('still REQUIRES a permission note for re-subscribe', () => {
        expect(route).toContain("if (action === 'resubscribe' && permissionNote.length === 0)");
    });
    it('releases addresses only through the pure decision', () => {
        expect(route).toContain('decideAddressRelease({');
        expect(route).toContain("releases.filter((r) => r.outcome === 'released')");
    });
    it('address release happens ONLY for the resubscribe action', () => {
        expect(route).toContain("if (action === 'resubscribe') {");
        const block = route.slice(route.indexOf('const releases'), route.indexOf('await prisma.$transaction'));
        expect(block).toContain("action === 'resubscribe'");
    });
    it('uses the canonical normalizer for address ownership', () => {
        expect(route).toContain('normalizeEmail(p.normalized_value');
    });
    it('scopes every read and write to the tenant', () => {
        const block = route.slice(route.indexOf('const releases'));
        expect(block).toContain('business_id: businessId');
        expect(block).not.toMatch(/business_id:\s*body/);
    });
    it('NEVER deletes suppression history', () => {
        expect(route).not.toContain('emailSuppressionEvent.delete');
        expect(route).not.toContain('deleteMany');
        expect(route).toContain('emailSuppressionEvent.create');
    });
    it('the address release appends its own suppression-history event', () => {
        const block = route.slice(route.indexOf('for (const email of releasable)'));
        const body = block.slice(0, block.indexOf('for (const contactId of contactIds)'));
        expect(body).toContain('emailSuppressionEvent.create(');
        expect(body).toContain("event_type: 'resubscribe'");
        expect(body).toContain('normalized_email: email');
        // Updated, never removed — an erasable audit trail is not one.
        expect(body).toContain('marketingPreference.update(');
        expect(body).not.toContain('.delete');
    });

    it('reports what was held back instead of a bare success', () => {
        expect(route).toContain('addressesHeldBack');
        expect(route).toContain('warning: summary.warning');
    });
});

// ── GAP 2 — DISPLAY TRUTH ──────────────────────────────────────────────────
describe('OUTREACH-PREFERENCE-DISPLAY-1 · display agrees with send', () => {
    const at = (iso: string) => new Date(iso);

    it('a NEWER contact-subscribe does not override an older ADDRESS-unsubscribe', () => {
        // The exact one-click sequence: the recipient unsubscribes publicly
        // (address scope), then the tenant re-subscribes the contact.
        const prefs: PreferenceRow[] = [
            { scope: 'email_address', status: 'unsubscribed', effective_at: at('2026-08-01T00:00:00Z'), effective_until: null },
            { scope: 'contact', status: 'subscribed', effective_at: at('2026-08-20T00:00:00Z'), effective_until: null },
        ];
        // Display now says suppressed...
        expect(resolveActivePreference(prefs, NOW)!.status).toBe('unsubscribed');
        expect(resolveActivePreference(prefs, NOW)!.scope).toBe('email_address');
        // ...and so does send, for the same underlying rows.
        expect(evaluateSuppression(
            [{ scope: 'email_address', status: 'unsubscribed', effective_until: null },
                { scope: 'contact', status: 'subscribed', effective_until: null }], NOW,
        ).suppressed).toBe(true);
    });

    it('order of the rows does not change the answer', () => {
        const a: PreferenceRow[] = [
            { scope: 'contact', status: 'subscribed', effective_at: at('2026-08-20T00:00:00Z'), effective_until: null },
            { scope: 'email_address', status: 'unsubscribed', effective_at: at('2026-08-01T00:00:00Z'), effective_until: null },
        ];
        expect(resolveActivePreference(a, NOW)!.status).toBe('unsubscribed');
        expect(resolveActivePreference([...a].reverse(), NOW)!.status).toBe('unsubscribed');
    });

    it('WITHIN one scope, a later re-subscribe still wins — that rule is preserved', () => {
        // Only the cross-scope case was ever wrong. The tenant's re-subscribe
        // button must keep working for an ordinary contact-scope opt-out.
        const contactOnly: PreferenceRow[] = [
            { scope: 'contact', status: 'unsubscribed', effective_at: at('2026-01-01T00:00:00Z'), effective_until: null },
            { scope: 'contact', status: 'subscribed', effective_at: at('2026-06-01T00:00:00Z'), effective_until: null },
        ];
        expect(resolveActivePreference(contactOnly, NOW)!.status).toBe('subscribed');
    });

    it('an address RELEASE lets the newest row win again', () => {
        // After lib/outreachResubscribe releases it, the address row reads
        // subscribed, so it is no longer a veto.
        const released: PreferenceRow[] = [
            { scope: 'email_address', status: 'subscribed', effective_at: at('2026-08-26T00:00:00Z'), effective_until: null },
            { scope: 'contact', status: 'subscribed', effective_at: at('2026-08-20T00:00:00Z'), effective_until: null },
        ];
        expect(resolveActivePreference(released, NOW)!.status).toBe('subscribed');
    });

    it('an ELAPSED pause is not suppression, in display or in send', () => {
        const prefs: PreferenceRow[] = [
            { scope: 'contact', status: 'paused', effective_at: at('2026-01-01T00:00:00Z'), effective_until: at('2026-02-01T00:00:00Z') },
        ];
        expect(resolveActivePreference(prefs, NOW)).toBeNull();
        expect(evaluateSuppression(
            [{ scope: 'contact', status: 'paused', effective_until: at('2026-02-01T00:00:00Z') }], NOW,
        ).suppressed).toBe(false);
    });

    it('a RUNNING pause suppresses in both', () => {
        const until = at('2027-01-01T00:00:00Z');
        expect(resolveActivePreference(
            [{ scope: 'contact', status: 'paused', effective_at: at('2026-08-01T00:00:00Z'), effective_until: until }], NOW,
        )!.status).toBe('paused');
        expect(evaluateSuppression([{ scope: 'contact', status: 'paused', effective_until: until }], NOW).suppressed).toBe(true);
    });

    it('after an approved release, display shows subscribed again', () => {
        const prefs: PreferenceRow[] = [
            { scope: 'email_address', status: 'unsubscribed', effective_at: at('2026-08-01T00:00:00Z'), effective_until: null },
        ];
        expect(resolveActivePreference(prefs, NOW)!.status).toBe('unsubscribed');
        // The release UPDATES the row rather than adding a newer one.
        const released: PreferenceRow[] = [
            { scope: 'email_address', status: 'subscribed', effective_at: at('2026-08-26T00:00:00Z'), effective_until: null },
        ];
        expect(resolveActivePreference(released, NOW)!.status).toBe('subscribed');
    });

    it('a future-dated row is not yet in force', () => {
        expect(resolveActivePreference(
            [{ scope: 'email_address', status: 'unsubscribed', effective_at: at('2027-01-01T00:00:00Z'), effective_until: null }], NOW,
        )).toBeNull();
    });

    it('send time is the reference implementation the others consume', () => {
        const send = strip(R('lib/outreachSend.ts'));
        expect(send).toContain('export function evaluateSuppression(');
        expect(send).toContain('return evaluateSuppression(prefs, now);');
        const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
        expect(route).toContain('evaluateSuppression(rows, now)');
    });
});

describe('OUTREACH-PREFERENCE-DISPLAY-1 · Previous Supporters honours the same truth', () => {
    const order = (id: string, email: string) => ({
        id, campaign_id: 'prior', canceled_at: null, customer_id: `cust-${id}`,
        customer_name: `Person ${id}`, phone: null,
        customer: { id: `cust-${id}`, business_id: BIZ, contact_email: email, contact_phone: null, name: `Person ${id}` },
    });
    const base = {
        businessId: BIZ, organizationCustomerId: 'org', priorCampaignIds: ['prior'],
        organizationCustomerIds: new Set(['org']),
    };

    it('a suppressed supporter is not counted as reachable', () => {
        const a = derivePreviousSupporters({
            ...base,
            orders: [order('a', 'in@example.com'), order('b', EMAIL)],
            suppressedEmails: new Set([EMAIL]),
        });
        expect(a.supporterCount).toBe(2);
        expect(a.reachableCount).toBe(1);
        expect(a.suppressedCount).toBe(1);
        expect(a.supporters.find((s) => s.email === EMAIL)!.reachable).toBe(false);
    });

    it('the computed suppressed set is actually fed into the derivation', () => {
        // Computing it and then not passing it would leave every opted-out
        // supporter counted as reachable, with no test noticing.
        const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
        const call = route.slice(route.indexOf('derivePreviousSupporters({'));
        const args = call.slice(0, call.indexOf('        });'));
        expect(args).toContain('suppressedEmails,');
        expect(args).not.toContain('new Set<string>()');
        expect(args).not.toContain('suppressedEmails: new Set');
    });

    it('an elapsed pause must NOT appear in the suppressed set', () => {
        // Proven through the shared rule the route now uses.
        expect(evaluateSuppression(
            [{ scope: 'email_address', status: 'paused', effective_until: new Date('2026-02-01T00:00:00Z') }], NOW,
        ).suppressed).toBe(false);
        const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
        // The old shape — every non-subscribed row suppresses — must be gone.
        expect(route).not.toContain("status: { not: 'subscribed' }");
        expect(route).toContain('effective_until: true');
    });
});

// ── GAP 3 — ORIGIN AUTHORITY ───────────────────────────────────────────────
describe('FR-REBOOK-2-ORIGIN-1 · the supporter ordering URL', () => {
    const PLATFORM = 'https://www.freezeriqapp.com';
    const campaign = {
        id: 'camp-current', name: 'Fall', end_date: new Date('2026-04-29T00:00:00.000Z'),
        public_token: 'pub-current',
    };

    it('uses the tenant storefront ORDERING path, not the scoreboard', () => {
        const url = buildSupporterOrderUrl(PLATFORM, campaign, { slug: 'freezer-chef', customDomain: null });
        expect(url).toBe(`${PLATFORM}/shop/freezer-chef/fundraiser/camp-current`);
        expect(url).not.toContain('/fundraiser/pub-current');
    });

    it('prefers the tenant custom domain when they have one', () => {
        const url = buildSupporterOrderUrl(PLATFORM, campaign, {
            slug: 'freezer-chef', customDomain: 'myfreezerchef.com',
        });
        expect(url).toBe('https://myfreezerchef.com/shop/freezer-chef/fundraiser/camp-current');
    });

    it('falls back to the platform origin when there is no custom domain', () => {
        expect(buildSupporterOrderUrl(PLATFORM, campaign, { slug: 's', customDomain: '   ' }))
            .toBe(`${PLATFORM}/shop/s/fundraiser/camp-current`);
    });

    it('falls back to the scoreboard only when the tenant has no slug', () => {
        expect(buildSupporterOrderUrl(PLATFORM, campaign, { slug: null, customDomain: null }))
            .toBe(`${PLATFORM}/fundraiser/pub-current`);
    });

    it('refuses a junk custom domain rather than emitting a broken link', () => {
        for (const junk of ['not a domain', 'javascript:alert(1)', 'http://', '..', 'localhost', 'a'.repeat(300)]) {
            const url = buildSupporterOrderUrl(PLATFORM, campaign, { slug: 's', customDomain: junk });
            expect(url).toBe(`${PLATFORM}/shop/s/fundraiser/camp-current`);   // falls back, never junk
        }
    });

    it('never emits a non-http base', () => {
        for (const bad of ['javascript:alert(1)', 'ftp://x.test', '/relative', '', null, undefined]) {
            expect(buildSupporterOrderUrl(bad as any, campaign, { slug: 's', customDomain: null })).toBeNull();
        }
    });

    it('uses the CURRENT campaign id, never a prior one', () => {
        const now = buildSupporterOrderUrl(PLATFORM, campaign, { slug: 's', customDomain: null });
        const old = buildSupporterOrderUrl(PLATFORM, { id: 'camp-old', public_token: 'pub-old' }, { slug: 's', customDomain: null });
        expect(now).toContain('camp-current');
        expect(now).not.toContain('camp-old');
        expect(old).not.toBe(now);
    });

    it('never emits a coordinator or admin URL', () => {
        const d = buildInviteDraft({
            organizationName: 'Edgar County Farm Bureau',
            campaign, origin: PLATFORM,
            tenant: { slug: 'freezer-chef', customDomain: null },
        });
        expect(d.text).not.toContain('/coordinator');
        expect(d.text).not.toContain('/dashboard');
        expect(d.text).not.toContain('#');
    });

    it('the link and the deadline come from the SAME current campaign', () => {
        const d = buildInviteDraft({
            organizationName: 'Edgar County Farm Bureau',
            campaign, origin: PLATFORM,
            tenant: { slug: 'freezer-chef', customDomain: null },
        });
        expect(d.orderUrl).toContain('camp-current');
        expect(d.deadlineLabel).toBe('Wednesday, April 29');
        expect(d.text).toContain('Please place your order by Wednesday, April 29.');
        // Editing the sentence out changes the email, never the campaign.
        const edited = d.text.replace('Please place your order by Wednesday, April 29.', '').trim();
        expect(edited).not.toMatch(/place your order by/i);
        expect(campaign.end_date).toEqual(new Date('2026-04-29T00:00:00.000Z'));
        expect(buildInviteDraft({
            organizationName: 'X', campaign, origin: PLATFORM,
            tenant: { slug: 'freezer-chef', customDomain: null },
        }).deadlineLabel).toBe('Wednesday, April 29');
    });
});

describe('FR-REBOOK-2-ORIGIN-1 · the route never trusts the request host', () => {
    const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));

    it('uses the PINNED resolver, not resolveRequestOrigin', () => {
        expect(route).toContain('resolveOutreachOrigin(req)');
        expect(route).not.toContain('resolveRequestOrigin');
    });

    it('passes the tenant storefront through to the builder', () => {
        const call = route.slice(route.indexOf('return buildInviteDraft({'));
        const args = call.slice(0, call.indexOf('    });'));
        expect(args).toContain('customDomain: campaign.customer?.business?.custom_domain');
        expect(args).toContain('slug: campaign.customer?.business?.slug');
        expect(args).toContain('id: campaign.id');
        // The origin is a parameter of the shared helper, so BOTH callers must
        // supply the pinned one — a single site could otherwise drift.
        expect(args).toContain('origin,');
        const callers = [...route.matchAll(/buildDraftFor\(campaign, ([^)]+)\)/g)].map((m) => m[1]);
        expect(callers.length).toBeGreaterThanOrEqual(1);
        const origins = [...route.matchAll(/const origin = ([^;]+);/g)].map((m) => m[1].trim());
        expect(origins.length).toBe(2);                       // GET and POST
        expect(origins.every((o) => o === 'resolveOutreachOrigin(req)')).toBe(true);
    });

    it('a hostile Host header cannot become the link', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { resolveOutreachOrigin, CANONICAL_COORDINATOR_ORIGIN } = require('../lib/fundraiserUrls');
        const original = process.env.NODE_ENV;
        (process.env as any).NODE_ENV = 'production';
        for (const hostile of [
            'https://attacker.example/api/x',
            'https://freezeriq-app.vercel.app/api/x',
            'https://some-preview-xyz.vercel.app/api/x',
            'http://localhost:3000/api/x',
            'https://freezeriq.com/api/x',
            'https://another-tenant.example/api/x',
        ]) {
            const origin = resolveOutreachOrigin(new Request(hostile));
            expect(origin).toBe(CANONICAL_COORDINATOR_ORIGIN);
            const url = buildSupporterOrderUrl(origin, { id: 'c1', public_token: 't' }, { slug: 's', customDomain: null });
            expect(url).toBe(`${CANONICAL_COORDINATOR_ORIGIN}/shop/s/fundraiser/c1`);
            for (const bad of ['attacker.example', 'vercel.app', 'localhost', 'another-tenant']) {
                expect(url).not.toContain(bad);
            }
        }
        (process.env as any).NODE_ENV = original;
    });

    it('an X-Forwarded-Host header is not consulted anywhere in the chain', () => {
        expect(route).not.toMatch(/x-forwarded-host/i);
        expect(strip(R('lib/fundraiserUrls.ts'))).not.toMatch(/x-forwarded-host/i);
        expect(strip(R('lib/previousSupporterInvite.ts'))).not.toMatch(/x-forwarded-host|headers/i);
    });
});

// ── DISARMED ───────────────────────────────────────────────────────────────
describe('FR-REBOOK-2 is now ARMED, and the PREARM guarantees still hold', () => {
    const route = strip(R('app/api/coordinator/previous-supporters/route.ts'));
    const card = strip(R('components/coordinator/PreviousSupporters.tsx'));

    it('canSend is derived per request, never asserted by a handler', () => {
        const handlers = route.slice(route.indexOf('export async function GET('));
        expect(handlers).not.toContain('canSend: true');
        expect(handlers).not.toContain('canSend: false');
        expect(handlers).toContain('resolveSendCapability({');
    });

    it('the send POST exists and goes through the deployed engine', () => {
        expect(route).toContain('export async function POST(');
        expect(route).toContain('await runSend({');
        expect(route).not.toMatch(/provider\.send\(/);
    });

    it('the card arms only when the server says so', () => {
        expect(card).toContain('disabled={!data.send.canSend || sending');
        expect(card).toContain('if (!data?.send.canSend || sending) return;');
    });

    it('the GET is still read-only — a preview creates nothing', () => {
        const get = route.slice(route.indexOf('export async function GET('), route.indexOf('export async function POST('));
        for (const w of ['.create(', '.createMany(', '.update(', '.updateMany(', '.upsert(', '.delete(']) {
            expect(get).not.toContain(w);
        }
    });

    it('the send writes outreach rows ONLY — no order, campaign or invoice', () => {
        const post = route.slice(route.indexOf('export async function POST('));
        for (const w of ['order.create', 'order.update', 'fundraiserCampaign.update',
            'customer.update', 'invoice.', 'fundraiserOpportunity']) {
            expect(post).not.toContain(w);
        }
    });
});
