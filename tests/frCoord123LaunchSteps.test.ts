/**
 * FR-COORD-123 — Easy as 1-2-3: durable step truth, share actions, tracker
 * polling, notification wording, and honest copy.
 *
 * Behavioral tests drive lib/coordinatorLaunch directly; wiring that lives in
 * client components is pinned by source-level assertions sliced to the exact
 * block, the same discipline as the FR-REBOOK-2 suites.
 */
process.env.TZ = 'America/Chicago';

import fs from 'fs';
import path from 'path';
import {
    deriveLaunchSteps,
    deriveSharingStarted,
    isShareAction,
    SHARE_ACTION_TYPES,
} from '../lib/coordinatorLaunch';
import { COORDINATOR_PORTAL_PLANS, planAllowsCoordinatorPortal } from '../app/api/coordinator/route';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PORTAL = 'app/coordinator/portal/page.tsx';
const CARD = 'components/coordinator/LaunchSteps.tsx';
const ACTIONS = 'app/api/coordinator-actions/route.ts';
const SUMMARY = 'app/api/coordinator-actions/summary/route.ts';
const COORD_GET = 'app/api/coordinator/route.ts';
const EMAIL = 'lib/email.ts';

const counts = (over: Record<string, number> = {}) => ({
    share_fundraiser: 0, send_text_blast: 0, share_facebook: 0,
    share_email: 0, share_native: 0, copy_link: 0,
    copy_text_message: 0, copy_facebook_post: 0, copy_email_blurb: 0,
    download_flyer: 0, download_tracker: 0, download_qr: 0, download_packet: 0,
    ...over,
});

// ── PLAN GATE (BASE) ────────────────────────────────────────────────────────
describe('FR-COORD-123 · coordinator portal plan gate', () => {
    /**
     * THE SHIPPED predicate — imported, never re-implemented here. A local copy
     * would pass no matter what the route actually does.
     */
    const allows = planAllowsCoordinatorPortal;

    it('THE DEFECT: BASE — the SCHEMA DEFAULT plan — is admitted', () => {
        // prisma/schema.prisma: `plan SubscriptionPlan @default(BASE)`. Before
        // the fix, every business created without an explicit plan answered its
        // coordinators 403 "Portal unavailable (Plan Restriction)".
        expect(allows('BASE')).toBe(true);
        const schema = R('prisma/schema.prisma');
        expect(schema).toMatch(/plan\s+SubscriptionPlan\s+@default\(BASE\)/);
    });

    it('admits every plan in the SubscriptionPlan enum — no tier can drift out', () => {
        // Read the enum from the schema itself, so adding a tier without adding
        // it here fails loudly instead of silently 403-ing that tenant.
        const schema = R('prisma/schema.prisma');
        const block = schema.slice(schema.indexOf('enum SubscriptionPlan {'));
        const enumValues = block.slice(0, block.indexOf('}'))
            .split('\n').slice(1).map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
        expect(enumValues.sort()).toEqual([...COORDINATOR_PORTAL_PLANS].sort());
        for (const p of enumValues) expect(allows(p)).toBe(true);
    });

    it('is NOT "allow anything": unknown, null, empty and non-strings are refused', () => {
        for (const bad of ['', 'TRIAL', 'base', 'Base', 'ENTERPRISE ', 'UNKNOWN', null, undefined, 0, {}, [], true]) {
            expect(allows(bad)).toBe(false);
        }
    });

    it('the gate is a single authority used by every handler — no hand-written copies', () => {
        const code = strip(R(COORD_GET));
        // Three handlers (GET portal, POST order, PUT settings) all call it.
        expect(code.split('planAllowsCoordinatorPortal(plan)').length - 1).toBe(3);
        // The literal arrays that drifted are gone.
        expect(code).not.toContain('allowedPlans');
        expect(code).not.toMatch(/\['ENTERPRISE',\s*'ULTIMATE',\s*'FREE',\s*'PRO'\]/);
        // And the gate still exists — it was not simply deleted.
        expect(code).toContain('Plan Restriction');
        expect(code).toContain('status: 403');
    });

    it('the plan gate does not replace session authority — both still apply', () => {
        const code = strip(R(COORD_GET));
        // requireCoordinatorSession runs FIRST in every handler; the plan check
        // is an additional gate, never a substitute for authentication.
        const get = code.slice(code.indexOf('export async function GET('));
        expect(get.indexOf('requireCoordinatorSession(req)'))
            .toBeLessThan(get.indexOf('planAllowsCoordinatorPortal(plan)'));
    });
});

// ── STEP 1 ──────────────────────────────────────────────────────────────────
describe('FR-COORD-123 · Step 1 — setup truth', () => {
    it('completed setup → checked', () => {
        const s = deriveLaunchSteps({ setupConfirmed: true, shareCounts: counts(), activeOrderCount: 0 });
        expect(s.setupComplete).toBe(true);
        expect(s.currentStep).toBe(2);
    });

    it('incomplete setup → NOT checked, and it is the current step', () => {
        const s = deriveLaunchSteps({ setupConfirmed: false, shareCounts: counts(), activeOrderCount: 0 });
        expect(s.setupComplete).toBe(false);
        expect(s.currentStep).toBe(1);
    });

    it('the card only renders after the SERVER confirms setup — no client invention', () => {
        const portal = strip(R(PORTAL));
        // LaunchSteps sits inside the bundleSelectionDone gate and reads it as
        // Step 1's truth — the flag is set only by the server-confirmed
        // selection state (BundleSelectionStep onSelectionComplete).
        const gate = portal.indexOf('{bundleSelectionDone && (<>');
        const mount = portal.indexOf('<LaunchSteps');
        expect(gate).toBeGreaterThan(-1);
        expect(mount).toBeGreaterThan(gate);
        expect(portal).toContain('setupComplete={setupComplete}');
        // The authority is the CAMPAIGN ROW, re-read on every poll — the
        // write-once latch only covers the moment before the first payload.
        expect(portal).toContain("campaign.bundle_selection_status === 'selected'");
        expect(portal).toContain("campaign.bundle_selection_status === 'not_required'");
        // The ROW is the authority: the ternary tests the row's presence first
        // and reaches bundleSelectionDone only as the pre-payload fallback. A
        // `bundleSelectionDone || …` form would restore the write-once latch.
        const decl = portal.slice(portal.indexOf('const setupComplete ='), portal.indexOf('// Where the new-order'));
        expect(decl).toMatch(/const setupComplete = typeof campaign.bundle_selection_status === 'string'/);
        expect(decl).not.toMatch(/setupComplete = bundleSelectionDone/);
        expect(decl.indexOf('bundle_selection_status')).toBeLessThan(decl.indexOf('bundleSelectionDone'));
    });
});

// ── STEP 2 ──────────────────────────────────────────────────────────────────
describe('FR-COORD-123 · Step 2 — sharing started is a durable ACTION', () => {
    it('zero actions → not started', () => {
        expect(deriveSharingStarted(counts())).toBe(false);
        expect(deriveSharingStarted(null)).toBe(false);
        expect(deriveSharingStarted(undefined)).toBe(false);
    });

    it('every genuine share action starts it', () => {
        for (const t of SHARE_ACTION_TYPES) {
            expect(deriveSharingStarted(counts({ [t]: 1 }))).toBe(true);
        }
    });

    it('DOWNLOADS do not count — printing a tracker notifies nobody', () => {
        expect(deriveSharingStarted(counts({
            download_flyer: 3, download_tracker: 2, download_qr: 1, download_packet: 1,
        }))).toBe(false);
        for (const t of ['download_flyer', 'download_tracker', 'download_qr', 'download_packet']) {
            expect(isShareAction(t)).toBe(false);
        }
    });

    it('opening the share UI alone records nothing — only handlers track', () => {
        const card = strip(R(CARD));
        // The card is presentational: it never posts an action event itself.
        expect(card).not.toContain('/api/coordinator-actions');
        expect(card).not.toContain('fetch(');
        // And the portal tracks INSIDE the action handlers, not on render.
        const portal = strip(R(PORTAL));
        for (const [handler, action] of [
            ['const handleShareEmail', "trackAction('share_email')"],
            ['const handleShareFacebook', "trackAction('share_facebook')"],
            ['const handleShareText', "trackAction('send_text_blast')"],
            ['const handleCopyLink', "trackAction('copy_link')"],
        ] as const) {
            const i = portal.indexOf(handler);
            expect(i).toBeGreaterThan(-1);
            const block = portal.slice(i, i + 900);
            expect(block).toContain(action);
        }
    });

    it('a CANCELED native share records nothing — track only after the await resolves', () => {
        const portal = strip(R(PORTAL));
        const i = portal.indexOf('const handleShareNative');
        const block = portal.slice(i, portal.indexOf('};', i));
        // The track call comes after the awaited share and before the catch.
        expect(block.indexOf('await')).toBeLessThan(block.indexOf("trackAction('share_native')"));
        expect(block.indexOf("trackAction('share_native')")).toBeLessThan(block.indexOf('catch'));
    });

    it('share controls remain usable after Sharing started', () => {
        const card = R(CARD);
        // The share buttons render unconditionally inside Step 2 — not gated
        // on !sharingStarted.
        const step2 = card.slice(card.indexOf('── STEP 2 ──'), card.indexOf('── STEP 3 ──'));
        expect(step2).toContain('ShareBtn label="✉️ Email"');
        expect(step2).toContain('ShareBtn label="📘 Facebook"');
        expect(step2).toContain('ShareBtn label="💬 Text"');
        expect(step2).toContain('Copy Link');
        expect(step2).not.toMatch(/\{!sharingStarted && [\s\S]*ShareBtn/);
        // Post-action state and reinforcement copy.
        expect(step2).toContain("'Sharing started'");
        expect(step2).toContain('Great start — keep sharing!');
    });

    it('the action vocabulary is whitelisted server-side, and the summary counts it', () => {
        const actions = R(ACTIONS);
        const summary = R(SUMMARY);
        for (const t of ['share_email', 'share_native', 'copy_link']) {
            expect(actions).toContain(`'${t}'`);
            expect(summary).toContain(`${t}: 0`);
        }
    });
});

// ── SHARE COPY + URL AUTHORITY ──────────────────────────────────────────────
// FR-SHARE-COPY-1: the channel-specific templates (Email/SMS/Facebook/Native)
// now live in lib/fundraiserShareContent.ts and are covered by
// tests/frShareCopy1.test.ts. What remains here is the wiring invariant this
// suite has always owned: the portal reads its share facts from exactly ONE
// server-resolved source, never a per-handler duplicate or a client guess.
describe('FR-COORD-123 · share copy and canonical URL', () => {
    it('the coordinator GET resolves the URL through the PINNED authority', () => {
        const code = strip(R(COORD_GET));
        expect(code).toContain('buildSupporterOrderUrl(');
        expect(code).toContain('resolveOutreachOrigin(req)');
        expect(code).toContain('custom_domain');
        expect(code).toContain('formatOrderDeadline(campaign.end_date)');
        expect(code).toContain('orderUrl: shareOrderUrl,');
        expect(code).toContain('deadlineLabel: shareDeadlineLabel,');
    });

    it('every portal share handler uses the one canonical URL helper', () => {
        const portal = strip(R(PORTAL));
        // The server value is preferred; browser-origin construction is only
        // the stale-response fallback inside the same helper.
        const helper = portal.slice(portal.indexOf('const getShopOrderUrl'), portal.indexOf('const getScoreboardUrl'));
        expect(helper).toContain('campaign?.share?.orderUrl');
        // Handlers never build URLs of their own.
        for (const h of ['handleShareEmail', 'handleShareFacebook', 'handleShareText', 'handleCopyLink']) {
            const i = portal.indexOf(`const ${h}`);
            const block = portal.slice(i, portal.indexOf('};', i));
            expect(block).not.toContain('window.location.origin');
        }
        // FR-SHARE-COPY-1: every channel now reads the CURRENT campaign's
        // server-resolved facts through the ONE shareFacts() resolver — a
        // stronger invariant than before, when Email/Facebook/Native shared a
        // wrapper but Text/SMS duplicated the same field access independently.
        expect(portal).toContain('const shareFacts = (): ShareFacts => (');
        expect(portal.split('deadlineLabel: campaign?.share?.deadlineLabel ?? null').length - 1).toBe(1);
        for (const h of ['handleShareEmail', 'handleShareFacebook', 'handleShareText', 'handleShareNative']) {
            const i = portal.indexOf(`const ${h}`);
            const block = portal.slice(i, portal.indexOf('};', i));
            expect(block).toContain('shareFacts()');
        }
    });

    it('an old campaign cannot leak: URL and deadline both come from the one campaign object', () => {
        const portal = strip(R(PORTAL));
        // The portal holds exactly one campaign (the session's); there is no
        // second campaign source anywhere in the file.
        expect(portal).not.toMatch(/previousCampaign|oldCampaign|campaigns\[/);
    });
});

// ── STEP 3 ──────────────────────────────────────────────────────────────────
describe('FR-COORD-123 · Step 3 — first order authority', () => {
    it('zero valid orders → incomplete', () => {
        const s = deriveLaunchSteps({ setupConfirmed: true, shareCounts: counts({ share_email: 1 }), activeOrderCount: 0 });
        expect(s.firstOrderReceived).toBe(false);
        expect(s.currentStep).toBe(3);
    });

    it('first valid current-campaign order → complete', () => {
        const s = deriveLaunchSteps({ setupConfirmed: true, shareCounts: counts({ share_email: 1 }), activeOrderCount: 1 });
        expect(s.firstOrderReceived).toBe(true);
        expect(s.allComplete).toBe(true);
        expect(s.currentStep).toBeNull();
    });

    it('the count the portal feeds it is the server-filtered non-canceled list', () => {
        // The coordinator GET's orders relation filters canceled_at: null and
        // is scoped to the session campaign — canceled-only and other-campaign
        // orders can never reach the card.
        const get = strip(R(COORD_GET));
        expect(get).toContain('where: { canceled_at: null }');
        const portal = strip(R(PORTAL));
        expect(portal).toContain('const hasFirstOrder = activeOrders.length > 0');
        expect(portal).toContain('firstOrderReceived={hasFirstOrder}');
    });

    it('sharing, opening pages, or opening the order modal cannot complete it', () => {
        // Completion is derived ONLY from activeOrderCount — no action type
        // participates.
        const s = deriveLaunchSteps({
            setupConfirmed: true,
            shareCounts: counts({ share_email: 9, share_facebook: 9, copy_link: 9 }),
            activeOrderCount: 0,
        });
        expect(s.firstOrderReceived).toBe(false);
        // And the card's Enter-an-order button opens the existing modal — it
        // never touches step state.
        const card = strip(R(CARD));
        expect(card).toContain('onEnterOrder');
        expect(card).not.toContain('setFirstOrder');
    });
});

// ── TRACKER POLLING ─────────────────────────────────────────────────────────
describe('FR-COORD-123 · tracker auto-refresh', () => {
    const portal = R(PORTAL);
    const effect = portal.slice(
        portal.indexOf('const pollInFlight'),
        portal.indexOf('const [canNativeShare'),
    );

    it('polls the ONE canonical endpoint about every 30 seconds', () => {
        expect(effect).toContain("fetch('/api/coordinator')");
        expect(effect).toContain('setInterval(refreshCampaignQuietly, 30_000)');
        // No second data source, no websockets.
        expect(effect).not.toContain('supabase');
        expect(effect).not.toContain('WebSocket');
    });

    it('the timer and focus listener are cleaned up on unmount', () => {
        expect(effect).toContain('clearInterval(id)');
        expect(effect).toContain("window.addEventListener('focus', refreshCampaignQuietly)");
        expect(effect).toContain("window.removeEventListener('focus', refreshCampaignQuietly)");
    });

    it('requests cannot overlap, and hidden tabs / closed campaigns do not poll', () => {
        expect(effect).toContain('if (pollInFlight.current) return;');
        expect(effect).toContain('document.hidden) return;');
        expect(effect).toContain('if (campaignClosedRef.current) return;');
        // The guard releases in finally, so one failure cannot wedge polling.
        expect(effect).toMatch(/finally\s*\{\s*pollInFlight\.current = false/);
    });

    it('there is exactly ONE polling loop', () => {
        expect(portal.split('setInterval').length - 1).toBe(1);
    });

    it('a stale poll cannot overwrite a NEWER answer', () => {
        // Two writers of one state: a slow poll that started first must not
        // land on top of the fetch that followed the coordinator's own action.
        expect(effect).toContain('const seq = ++campaignSeq.current');
        expect(effect).toContain('applyCampaign(seq, data)');
        const apply = portal.slice(portal.indexOf('const applyCampaign'), portal.indexOf('const editingRef'));
        expect(apply).toContain('if (seq < campaignSeq.current) return false');
        // fetchCampaign shares the same counter.
        const fetchFn = portal.slice(portal.indexOf('const fetchCampaign'), portal.indexOf('// ── URL helpers'));
        expect(fetchFn).toContain('++campaignSeq.current');
        expect(fetchFn).toContain('applyCampaign(seq, data)');
    });

    it('a lapsed session is surfaced, not swallowed', () => {
        expect(effect).toContain('res.status === 401');
        expect(effect).toContain('setSessionLapsed(true)');
        expect(effect).toContain('if (sessionLapsedRef.current) return;');
        expect(portal).toContain('Your session has expired');
    });

    it('the poll holds off while the coordinator is mid-edit', () => {
        expect(effect).toContain('if (editingRef.current) return;');
        expect(portal).toContain('editingRef.current = showOrderModal || showAiPanel || showSettingsModal');
    });

    it("the coordinator's own mutations still refresh immediately", () => {
        const stripped = strip(portal);
        // Cancel, restore and add-order all call fetchCampaign() directly.
        expect(stripped.split('fetchCampaign()').length - 1).toBeGreaterThanOrEqual(4);
    });
});

// ── NOTIFICATION ────────────────────────────────────────────────────────────
describe('FR-COORD-123 · new-order notification', () => {
    const email = R(EMAIL);
    const block = email.slice(
        email.indexOf('sendFundraiserCoordinatorNotification'),
        email.indexOf('sendLeadNotificationEmail'),
    );

    it('the recipient authority is preserved: Customer.contact_email, exactly one recipient', () => {
        expect(block).toContain('The ONLY recipient. Campaign → Customer.contact_email');
        const route = strip(R('app/api/public/order/route.ts'));
        expect(route).toContain('campaign.customer?.contact_email');
    });

    it('the email carries the operational facts: who, how to reach them, what, total', () => {
        for (const field of ['supporterEmail', 'supporterPhone', 'itemsHtml', 'orderReference', 'participantName']) {
            expect(block).toContain(field);
        }
    });

    it('PAYMENT TRUTH: with an external link the order is NEVER called paid — verify wording', () => {
        expect(block).toContain('needs to be collected or verified');
        expect(block).toContain('please verify before counting this order as paid');
        expect(block).toContain('verify payment');
        // The unconditional over-broad claim is gone; the plain "collected by
        // you directly" survives ONLY on the no-link branch.
        const footer = block.slice(block.indexOf('const paymentFooter'), block.indexOf('const subjectTail'));
        expect(footer).toContain('hasExternalPaymentLink');
        expect(footer.indexOf('may have')).toBeLessThan(footer.indexOf('no online payment was taken'));
        // Nothing in the template CODE says "Paid" — comments stripped first,
        // because the explanation of why we never say it legitimately says it.
        expect(strip(block)).not.toMatch(/Payment:\s*Paid|marked paid|payment received/i);
    });

    it('the route passes the real link state — never a hardcoded flag', () => {
        const route = strip(R('app/api/public/order/route.ts'));
        // Written instructions ("Venmo @our-boosters") are an external payment
        // path too — a supporter may already have paid through them.
        expect(route).toContain("hasExternalPaymentLink: Boolean(externalPaymentLink) || Boolean(paymentInstructions?.trim())");
    });

    it('the notification fires from exactly ONE call site — once per order', () => {
        const route = strip(R('app/api/public/order/route.ts'));
        // One import destructure + one call. A second call would double-mail
        // the coordinator for a single order.
        expect(route.split('sendFundraiserCoordinatorNotification').length - 1).toBe(2);
        // And the campaign is resolved by the validated id — never unscoped.
        const get = strip(R(COORD_GET));
        expect(get).toContain('where: { id: campaignId }');
    });

    it('the dashboard promise matches: names the real inbox, or promises nothing', () => {
        const card = R(CARD);
        // The BRANCH must be on the real recipient — `{true ?` would keep both
        // strings in source while always rendering the promise.
        expect(card).toContain('{notifyEmail ? (');
        expect(card).toContain('we&apos;ll email <strong>{notifyEmail}</strong>');
        expect(card).toContain('appears in your order list below');
        const portal = strip(R(PORTAL));
        expect(portal).toContain('campaign.customer?.contact_email || null');
        const get = strip(R(COORD_GET));
        expect(get).toContain('contact_email: true');
    });
});

// ── COPY TRUTH (Part E) ─────────────────────────────────────────────────────
describe('FR-COORD-123 · no overclaims survive', () => {
    it('the coordinator flow claims polling-strength updates, not "real time"', () => {
        for (const p of [
            'lib/emailTemplates.ts',
            'components/crm/CustomerOverview.tsx',
            'components/crm/FundraiserOverview.tsx',
            'components/crm2/StartFundraiserWizard.tsx',
            PORTAL, CARD,
        ]) {
            expect(R(p)).not.toMatch(/in real.?time/i);
        }
    });

    it('the card states the actual refresh strength', () => {
        expect(R(CARD)).toContain('refreshes about every 30 seconds');
    });

    it('no false promises: delivery-time email and order-by-email are gone', () => {
        expect(R('components/coordinator/WhatsNext.tsx'))
            .not.toContain("You'll get an email with the exact time");
        expect(R('app/coordinator/portal/guide/page.tsx'))
            .not.toContain('by emailing you');
    });

    it('pickup-day guidance: the SAME list, during and after', () => {
        expect(R(CARD)).toContain('your pickup-day checklist');
        expect(R(PORTAL)).toContain('use the order list below as your pickup-day guide');
    });

    it('the pickup claim does not promise fields the order list lacks', () => {
        // RecentOrders renders supporter name, an item count and the total. The
        // coordinator GET deliberately excludes email/phone as PII, so the card
        // must not claim the list shows how to contact anyone.
        const card = R(CARD);
        const pickup = card.slice(card.indexOf('When ordering closes'), card.indexOf('</details>'));
        expect(pickup).not.toMatch(/how to reach|contact (them|information)|phone|email address/i);
        const orders = strip(R('components/coordinator/RecentOrders.tsx'));
        expect(orders).not.toContain('customer_email');
        expect(orders).not.toContain('phone');
    });

    it('the guide no longer contradicts the card about email notifications', () => {
        const guide = R('app/coordinator/portal/guide/page.tsx');
        // The unconditional promise is gone; both surfaces now agree that the
        // email depends on the group having a contact address.
        expect(guide).not.toContain('Orders are emailed directly to you');
        expect(guide).toContain('If your group has a contact email on file');
    });
});

// ── PREVIOUS SUPPORTERS INTEGRATION ─────────────────────────────────────────
describe('FR-COORD-123 · Previous Supporters in Step 2', () => {
    it('appears when reachable, silent when zero — generic sharing unaffected', () => {
        const card = R(CARD);
        expect(card).toContain('previousSupportersReachable > 0 && (');
        // The generic share grid renders regardless — it is not inside that
        // conditional.
        const step2 = card.slice(card.indexOf('── STEP 2 ──'), card.indexOf('── STEP 3 ──'));
        expect(step2.indexOf('ShareBtn label="✉️ Email"'))
            .toBeLessThan(step2.indexOf('previousSupportersReachable > 0'));
    });

    it('the FR-REBOOK-2 component only gained an OPTIONAL availability callback', () => {
        const ps = R('components/coordinator/PreviousSupporters.tsx');
        expect(ps).toContain('onAvailability?: (reachable: number) => void');
        expect(ps).toContain('onAvailability?.(json.counts?.reachable ?? 0)');
        // The send contract is untouched: only the two edited strings travel.
        const stripped = strip(ps);
        expect(stripped).toContain('JSON.stringify({ subject: subject.trim(), text })');
        expect(stripped).not.toContain('recipients');
    });

    it('the portal mounts it in every active phase, anchored for the Step-2 chip', () => {
        const portal = R(PORTAL);
        // ONE mount, outside the phase branches: a poll that moves the campaign
        // from one phase to the next used to unmount and remount this card,
        // closing an open invitation composer mid-keystroke.
        expect(portal.split('id="previous-supporters"').length - 1).toBe(1);
        expect(portal.split('<PreviousSupporters onAvailability={setPsReachable} />').length - 1).toBe(1);
        // And it must span EVERY active phase — gating it to a single phase
        // would reintroduce the unmount that closed the composer mid-keystroke.
        // The guard immediately preceding the mount is the thing under test.
        const mountAt = portal.indexOf('id="previous-supporters"');
        const guard = portal.slice(portal.lastIndexOf('{campaignPhase', mountAt), mountAt);
        expect(guard).toContain("campaignPhase !== 'complete'");
        expect(guard).not.toMatch(/campaignPhase === /);
        expect(strip(portal)).toContain("document.getElementById('previous-supporters')");
    });
});
