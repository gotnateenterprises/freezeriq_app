/**
 * FR-SHARE-COPY-1 — coordinator fundraiser share copy: one canonical builder
 * per channel (Email/SMS/Facebook/Native), fed by the SAME normalized facts,
 * resolved server-side in app/api/coordinator/route.ts.
 *
 * Behavioral tests drive lib/fundraiserShareContent directly; wiring that
 * lives in the API route and the client component is pinned by source-level
 * assertions sliced to the exact block — the same discipline as the
 * FR-COORD-123 suites this phase extends.
 */
import fs from 'fs';
import path from 'path';
import {
    buildFundraiserShareEmail,
    buildFundraiserShareSms,
    buildFundraiserShareFacebook,
    buildFundraiserShareNative,
    formatBundleBulletList,
    formatBundleCompactList,
    type ShareFacts,
} from '../lib/fundraiserShareContent';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const COORD_GET = 'app/api/coordinator/route.ts';
const PORTAL = 'app/coordinator/portal/page.tsx';
const GENERATE = 'app/api/coordinator/generate/route.ts';
const SHARE_LIB = 'lib/fundraiserShareContent.ts';

const URL_ = 'https://myfreezerchef.com/shop/my-freezer-chef/fundraiser/camp-1';

const baseFacts = (over: Partial<ShareFacts> = {}): ShareFacts => ({
    organizationName: 'Hilltop Boosters',
    tenantDisplayName: 'Frosty Kitchen',
    bundleFamilyNames: ['Fall Comfort Bundle', 'Fall Keto Bundle'],
    orderUrl: URL_,
    deadlineLabel: 'Sunday, August 31',
    coordinatorName: 'Jane Doe',
    coordinatorEmail: 'jane@example.com',
    pickupDeliveryLines: ['Date: Tuesday, October 27', 'Time: 4:45 PM', 'Location: Front office'],
    ...over,
});

// ── PART D/O#1-3 — TENANT BRAND NAME, NEVER HARDCODED ───────────────────────
describe('FR-SHARE-COPY-1 · tenant brand name is never hardcoded', () => {
    it('a DIFFERENT tenant brand renders correctly (no "Freezer Chef" leakage)', () => {
        const facts = baseFacts({ tenantDisplayName: 'Frosty Kitchen' });
        expect(buildFundraiserShareEmail(facts).subject).toContain('Frosty Kitchen');
        expect(buildFundraiserShareEmail(facts).body).toContain('Frosty Kitchen');
        expect(buildFundraiserShareSms(facts)).toContain('Frosty Kitchen');
        expect(buildFundraiserShareFacebook(facts)).toContain('Frosty Kitchen');
        expect(buildFundraiserShareNative(facts).title).toContain('Frosty Kitchen');
        expect(buildFundraiserShareEmail(facts).subject).not.toContain('Freezer Chef');
        expect(buildFundraiserShareEmail(facts).body).not.toContain('Freezer Chef');
    });

    it('"Freezer Chef"/"My Freezer Chef" is not hardcoded anywhere in the share system', () => {
        for (const file of [SHARE_LIB, COORD_GET, PORTAL, GENERATE]) {
            const code = R(file);
            expect(code).not.toMatch(/['"`]My Freezer Chef['"`]/);
            expect(code).not.toMatch(/['"`]Freezer Chef['"`]/);
        }
    });

    it('the coordinator GET resolves tenantDisplayName via customerFacingBusinessName (display_name -> name)', () => {
        const code = strip(R(COORD_GET));
        expect(code).toContain("import { customerFacingBusinessName } from '@/lib/tenantBrand'");
        expect(code).toContain('customerFacingBusinessName(business)');
        // Business.display_name must actually be selected, or the fallback can never fire.
        const businessSelect = code.slice(code.indexOf('business: {'), code.indexOf('orders: {'));
        expect(businessSelect).toContain('display_name: true');
    });
});

// ── PART E/O#8-11 — SELECTED BUNDLE FAMILIES ─────────────────────────────────
describe('FR-SHARE-COPY-1 · selected Bundle family names', () => {
    it('the actual selected families appear, in order', () => {
        const facts = baseFacts({ bundleFamilyNames: ['Fall Comfort Bundle', 'Fall Keto Bundle'] });
        const body = buildFundraiserShareEmail(facts).body;
        expect(body.indexOf('Fall Comfort Bundle')).toBeLessThan(body.indexOf('Fall Keto Bundle'));
    });

    it('an UNSELECTED bundle name never appears — only what was passed in', () => {
        const facts = baseFacts({ bundleFamilyNames: ['Fall Comfort Bundle'] });
        const body = buildFundraiserShareEmail(facts).body;
        expect(body).toContain('Fall Comfort Bundle');
        expect(body).not.toContain('Keto');
        expect(body).not.toContain('Bundle 1');
        expect(body).not.toContain('Bundle 2');
    });

    it('more than two selected families are supported — never truncated', () => {
        const names = ['Family A', 'Family B', 'Family C', 'Family D'];
        const list = formatBundleBulletList(names);
        for (const n of names) expect(list).toContain(n);
        expect(list.split('\n')).toHaveLength(4);
    });

    it('bullet list uses "•", compact list is comma-joined (SMS-sized)', () => {
        expect(formatBundleBulletList(['A', 'B'])).toBe('• A\n• B');
        expect(formatBundleCompactList(['A', 'B'])).toBe('A, B');
    });

    it('the coordinator GET groups Serves-5/Serves-2 siblings via the SAME family authority as the tracker', () => {
        const code = strip(R(COORD_GET));
        expect(code).toContain("import { resolveMaterialBundles, groupMaterialMenus } from '@/lib/coordinatorMaterialBundles'");
        expect(code).toContain('groupMaterialMenus(resolved.bundles).map((m) => m.baseName)');
        // Fetched WITH family_id, state:'active', ordered by position — the CB-6/tracker pattern.
        const block = code.slice(code.indexOf("orderMode?.mode === 'selected'"), code.indexOf('shareBundleFamilyNames = groupMaterialMenus'));
        expect(block).toContain("state: 'active'");
        expect(block).toContain("orderBy: { position: 'asc' }");
        expect(block).toContain('family_id: true');
        expect(block).toContain('campaign_id: campaign.id');
    });

    it('a legacy campaign (no selected subset) gets an empty family list, not the whole catalog', () => {
        const code = strip(R(COORD_GET));
        // Resolution only runs for mode === 'selected'; legacy/pending/invalid all fall through to [].
        const i = code.indexOf('let shareBundleFamilyNames: string[] = []');
        const j = code.indexOf("if (orderMode?.mode === 'selected')", i);
        expect(i).toBeGreaterThan(-1);
        expect(j).toBeGreaterThan(i);
    });

    it('no selected families → the bundle section is gracefully omitted, not invented', () => {
        const facts = baseFacts({ bundleFamilyNames: [] });
        const email = buildFundraiserShareEmail(facts).body;
        expect(email).not.toContain('For this fundraiser, you can choose from:');
        expect(email).not.toContain('Each bundle includes');
        const sms = buildFundraiserShareSms(facts);
        expect(sms).not.toContain('Available bundles:');
        const fb = buildFundraiserShareFacebook(facts);
        expect(fb).not.toContain('Available for this fundraiser:');
    });
});

// ── PART F — EXACT EMAIL TEMPLATE ───────────────────────────────────────────
describe('FR-SHARE-COPY-1 · Email template matches the approved structure', () => {
    it('subject matches "Support {org} with a {tenant} Fundraiser!"', () => {
        const { subject } = buildFundraiserShareEmail(baseFacts());
        expect(subject).toBe('Support Hilltop Boosters with a Frosty Kitchen Fundraiser!');
    });

    it('body contains every required block in order', () => {
        const { body } = buildFundraiserShareEmail(baseFacts());
        const order = [
            'Hilltop Boosters is holding a Frosty Kitchen fundraiser, and we\'d love your support!',
            'Frosty Kitchen offers convenient meal bundles designed to make busy mealtimes easier',
            'For this fundraiser, you can choose from:',
            '• Fall Comfort Bundle',
            '• Fall Keto Bundle',
            'Each bundle includes a variety of meals you can view in full at the fundraiser page',
            `Shop the Hilltop Boosters Fundraiser:\n${URL_}`,
            'Please place your order by Sunday, August 31.',
            'Pickup/Delivery Information:',
            'Date: Tuesday, October 27',
            'Time: 4:45 PM',
            'Location: Front office',
            'If you have questions about the fundraiser, please contact:',
            'Jane Doe',
            'jane@example.com',
            'Thank you for supporting Hilltop Boosters!',
        ];
        let cursor = -1;
        for (const chunk of order) {
            const idx = body.indexOf(chunk);
            expect(idx).toBeGreaterThan(cursor);
            cursor = idx;
        }
    });

    it('no curly-brace placeholders ever leak into rendered output', () => {
        const { subject, body } = buildFundraiserShareEmail(baseFacts());
        expect(subject + body).not.toMatch(/\{\{.*?\}\}/);
    });
});

// ── PART G — EMAIL FORMATTING RULES / MISSING-DATA (PART N) ────────────────
describe('FR-SHARE-COPY-1 · Email missing-data behavior', () => {
    it('no deadline → the deadline sentence is OMITTED, never invented', () => {
        const { body } = buildFundraiserShareEmail(baseFacts({ deadlineLabel: null }));
        expect(body).not.toContain('Please place your order by');
        expect(body).not.toContain('null');
        expect(body).not.toContain('undefined');
    });

    it('email unavailable but name exists → contact block shows name only', () => {
        const { body } = buildFundraiserShareEmail(baseFacts({ coordinatorName: 'Jane Doe', coordinatorEmail: null }));
        expect(body).toContain('If you have questions about the fundraiser, please contact:\nJane Doe');
        expect(body).not.toMatch(/Jane Doe\n\S+@\S+/);
    });

    it('no coordinator contact at all → the whole contact block is omitted, no placeholder', () => {
        const { body } = buildFundraiserShareEmail(baseFacts({ coordinatorName: null, coordinatorEmail: null }));
        expect(body).not.toContain('If you have questions');
        expect(body).not.toContain('TBD');
        expect(body).not.toContain('null');
        expect(body).not.toContain('undefined');
    });

    it('no pickup/delivery configured → the whole block is omitted cleanly', () => {
        const { body } = buildFundraiserShareEmail(baseFacts({ pickupDeliveryLines: [] }));
        expect(body).not.toContain('Pickup/Delivery Information:');
        expect(body).not.toContain('TBD');
    });

    it('order deadline is never confused with delivery/pickup date — both can appear independently', () => {
        const { body } = buildFundraiserShareEmail(baseFacts({
            deadlineLabel: 'Sunday, August 31',
            pickupDeliveryLines: ['Date: Tuesday, October 27'],
        }));
        expect(body).toContain('Please place your order by Sunday, August 31.');
        expect(body).toContain('Date: Tuesday, October 27');
    });
});

// ── PART I — TEXT/SMS ────────────────────────────────────────────────────────
describe('FR-SHARE-COPY-1 · Text/SMS template', () => {
    it('contains organization, tenant, bundle(s), deadline and URL', () => {
        const sms = buildFundraiserShareSms(baseFacts());
        expect(sms).toContain('Hilltop Boosters');
        expect(sms).toContain('Frosty Kitchen');
        expect(sms).toContain('Fall Comfort Bundle');
        expect(sms).toContain('Fall Keto Bundle');
        expect(sms).toContain('Order by Sunday, August 31.');
        expect(sms).toContain(URL_);
    });

    it('never includes pickup/delivery logistics (kept short by design)', () => {
        const sms = buildFundraiserShareSms(baseFacts());
        expect(sms).not.toContain('Pickup/Delivery');
        expect(sms).not.toContain('Front office');
    });

    it('URL and deadline are never silently dropped even with no coordinator/bundles', () => {
        const sms = buildFundraiserShareSms(baseFacts({ bundleFamilyNames: [], coordinatorName: null, coordinatorEmail: null }));
        expect(sms).toContain(URL_);
        expect(sms).toContain('Order by Sunday, August 31.');
    });

    it('questions line uses the same name/email fallback rules as Email', () => {
        expect(buildFundraiserShareSms(baseFacts({ coordinatorEmail: null }))).toContain('Questions? Contact Jane Doe.');
        expect(buildFundraiserShareSms(baseFacts({ coordinatorName: null }))).toContain('Questions? Contact jane@example.com.');
        expect(buildFundraiserShareSms(baseFacts({ coordinatorName: null, coordinatorEmail: null }))).not.toContain('Questions?');
    });
});

// ── PART J — FACEBOOK/SOCIAL ─────────────────────────────────────────────────
describe('FR-SHARE-COPY-1 · Facebook/social template', () => {
    it('contains organization, tenant, bundle(s), deadline and URL', () => {
        const fb = buildFundraiserShareFacebook(baseFacts());
        expect(fb).toContain('Help support Hilltop Boosters! 🎉');
        expect(fb).toContain('Frosty Kitchen');
        expect(fb).toContain('Fall Comfort Bundle');
        expect(fb).toContain('Fall Keto Bundle');
        expect(fb).toContain('Orders are due Sunday, August 31.');
        expect(fb).toContain(URL_);
        expect(fb).toContain('Thank you for supporting Hilltop Boosters!');
    });

    it('no hashtags — none are product-configured', () => {
        expect(buildFundraiserShareFacebook(baseFacts())).not.toContain('#');
    });

    it('no tenant-specific branding beyond the resolved facts', () => {
        const fb = buildFundraiserShareFacebook(baseFacts({ tenantDisplayName: 'Some Other Tenant' }));
        expect(fb).not.toContain('Freezer Chef');
        expect(fb).toContain('Some Other Tenant');
    });
});

// ── NATIVE SHARE ─────────────────────────────────────────────────────────────
describe('FR-SHARE-COPY-1 · Native Web Share', () => {
    it('title matches the Email subject voice; text reuses the Facebook-style full message', () => {
        const facts = baseFacts();
        const native = buildFundraiserShareNative(facts);
        expect(native.title).toBe('Support Hilltop Boosters with a Frosty Kitchen Fundraiser!');
        expect(native.text).toBe(buildFundraiserShareFacebook(facts));
    });
});

// ── PART K — OTHER SHARE BUTTONS ────────────────────────────────────────────
describe('FR-SHARE-COPY-1 · every text-producing share button derives from the canonical builder', () => {
    it('the portal imports all four canonical builders from the one module', () => {
        const code = R(PORTAL);
        expect(code).toContain("from '@/lib/fundraiserShareContent'");
        for (const fn of ['buildFundraiserShareEmail', 'buildFundraiserShareSms', 'buildFundraiserShareFacebook', 'buildFundraiserShareNative']) {
            expect(code).toContain(fn);
        }
    });

    it('Copy Link stays URL-only — it does not call the canonical share builder', () => {
        const portal = strip(R(PORTAL));
        const i = portal.indexOf('const handleCopyLink');
        const block = portal.slice(i, portal.indexOf('};', i));
        expect(block).not.toMatch(/buildFundraiserShare|shareFacts\(\)/);
        expect(block).toContain('getShopOrderUrl()');
    });

    it('the AI Content Generator uses the SAME canonical public URL authority, not a deprecated shape', () => {
        const code = strip(R(GENERATE));
        expect(code).toContain('buildSupporterOrderUrl(');
        expect(code).toContain('resolveOutreachOrigin(req)');
        expect(code).not.toContain('buildPublicFundraiserUrl(');
    });

    it('the AI Content Generator email subject uses the organization name, consistent with every other button', () => {
        const code = strip(R(PORTAL));
        const i = code.indexOf('const handleEmailShareWithContent');
        const block = code.slice(i, code.indexOf('};', i));
        expect(block).toContain('campaign?.customer?.name');
        expect(block).not.toContain('campaign?.name ||');
    });
});

// ── PART L — URL AND SECURITY RULES / O#22 ──────────────────────────────────
describe('FR-SHARE-COPY-1 · no internal IDs or tokens leak into share copy', () => {
    it('ShareFacts / the builders never reference portal_token, public_token, tenant id, or coordinator credentials', () => {
        const code = R(SHARE_LIB);
        expect(code).not.toMatch(/portal_token|public_token|coordinatorToken|business_?[Ii]d|tenantId/);
    });

    it('the coordinator GET share object exposes only the resolved facts, never portal_token/public_token', () => {
        const code = strip(R(COORD_GET));
        const shareBlock = code.slice(code.indexOf('share: {'), code.indexOf('});', code.indexOf('share: {')));
        expect(shareBlock).not.toContain('portal_token');
        expect(shareBlock).not.toContain('public_token');
    });
});

// ── PART G/O#12-14 — COORDINATOR IDENTITY ───────────────────────────────────
describe('FR-SHARE-COPY-1 · coordinator name/email resolution', () => {
    it('appears in every channel when present', () => {
        const facts = baseFacts();
        expect(buildFundraiserShareEmail(facts).body).toContain('Jane Doe');
        expect(buildFundraiserShareEmail(facts).body).toContain('jane@example.com');
        expect(buildFundraiserShareSms(facts)).toContain('Jane Doe');
        expect(buildFundraiserShareFacebook(facts)).toContain('jane@example.com');
    });

    it('the assigned coordinator (FundraiserCampaignCoordinator) is resolved and tried BEFORE the inquiry-submitter fallback', () => {
        const code = strip(R(COORD_GET));
        const assignedIdx = code.indexOf('prisma.fundraiserCampaignCoordinator.findUnique');
        const fallbackIdx = code.indexOf('shareCoordinatorName = (campaign.customer as any)?.contact_name');
        expect(assignedIdx).toBeGreaterThan(-1);
        expect(fallbackIdx).toBeGreaterThan(assignedIdx);
        // The fallback is gated on BOTH being empty — it never overwrites an
        // assignment that resolved successfully.
        const gate = code.slice(code.indexOf('if (!shareCoordinatorName && !shareCoordinatorEmail)'), fallbackIdx + 100);
        expect(gate.startsWith('if (!shareCoordinatorName && !shareCoordinatorEmail)')).toBe(true);
    });

    it('an ended org_contact relationship is not used as the assigned coordinator', () => {
        const code = strip(R(COORD_GET));
        expect(code).toContain('if (assigned && !assigned.org_contact.ended_at)');
    });

    it('resolution is scoped to THIS campaign only', () => {
        const code = strip(R(COORD_GET));
        const i = code.indexOf('prisma.fundraiserCampaignCoordinator.findUnique');
        const block = code.slice(i, code.indexOf('});', i) + 3);
        expect(block).toContain('campaign_id: campaign.id');
    });
});

// ── PART O#23-24 — TENANT/SESSION SCOPING ───────────────────────────────────
describe('FR-SHARE-COPY-1 · authorization and tenant isolation remain intact', () => {
    it('the coordinator GET is still gated by the session guard, first', () => {
        const code = strip(R(COORD_GET));
        const getIdx = code.indexOf('export async function GET');
        const guardIdx = code.indexOf('requireCoordinatorSession(req)');
        expect(guardIdx).toBeGreaterThan(getIdx);
        expect(guardIdx - getIdx).toBeLessThan(300);
    });

    it('every new share-fact query is scoped to the session-resolved campaign, never a client-supplied id', () => {
        const code = strip(R(COORD_GET));
        // campaignId comes only from guard.campaignId, resolved from the session.
        expect(code).toContain('const campaignId = guard.campaignId;');
        expect(code).not.toMatch(/campaign_id:\s*req\.|campaign_id:\s*body\./);
    });
});
