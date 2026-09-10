/**
 * COORD-PUBLIC-PREVIEW-1 — "View Supporter Page" on the coordinator panel.
 *
 * A coordinator should be able to see exactly what their supporters see
 * without scanning their own QR code or copy/pasting the link they just
 * copied. This is a pure ADDITIVE UI action: one more MiniLink in the
 * existing Share Center action group, pointing at the SAME `shareUrl` value
 * already flowing into that component and already driving Copy/Facebook/
 * Native share (FR-COORD-123 / FR-SHARE-COPY-1).
 *
 * THE ONE RULE THIS SUITE EXISTS TO ENFORCE: the button must use the exact
 * same authority as Copy Link — not a formula that merely LOOKS the same.
 * `shareUrl` is resolved once in app/coordinator/portal/page.tsx via
 * getShopOrderUrl() (which prefers the server-computed, tenant-scoped
 * campaign.share.orderUrl — built server-side by buildSupporterOrderUrl in
 * lib/previousSupporterInvite.ts) and passed into ShareCenter as a single
 * prop. Reusing that identifier, rather than reconstructing a URL, is what
 * makes drift structurally impossible rather than merely unlikely.
 *
 * Source-string assertions, sliced to exact blocks — the same discipline as
 * tests/frShareCopy1.test.ts and the other FR-COORD-123 suites this phase
 * sits beside. No @testing-library/react / jsdom exists in this repo
 * (jest.config.ts pins testEnvironment: 'node' project-wide); introducing one
 * for a single presentational component would be exactly the kind of
 * redesign this phase forbids.
 */
import fs from 'fs';
import path from 'path';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SHARE_CENTER = 'components/coordinator/ShareCenter.tsx';
const PORTAL = 'app/coordinator/portal/page.tsx';
const QR_ROUTE = 'app/api/qr/download/route.ts';
const INVITE_LIB = 'lib/previousSupporterInvite.ts';
const COORD_GET = 'app/api/coordinator/route.ts';

// ═════════════════════════════════════════════════════════════════════════════
// PART B — the pre-existing canonical URL authority (governance: prove it
// exists and is singular before trusting anything reuses it).
// ═════════════════════════════════════════════════════════════════════════════
describe('the canonical supporter URL authority already exists and is singular', () => {
    it('server: buildSupporterOrderUrl is the one function that builds the tenant-scoped ordering URL', () => {
        const code = R(INVITE_LIB);
        expect(code).toContain('export function buildSupporterOrderUrl(');
        // Tenant custom domain preferred, platform origin otherwise — never req.headers.host.
        expect(code).toContain('const domain = normalizeStorefrontDomain(tenant?.customDomain)');
        expect(code).toContain('/shop/${slug}/fundraiser/${campaign.id}');
    });

    it('the coordinator GET route resolves share.orderUrl through that same function, not a second formula', () => {
        const code = strip(R(COORD_GET));
        expect(code).toContain('buildSupporterOrderUrl(');
        const shareBlock = code.slice(code.indexOf('share: {'), code.indexOf('});', code.indexOf('share: {')));
        expect(shareBlock).toContain('orderUrl: shareOrderUrl');
    });

    it('client: getShopOrderUrl() prefers the server-resolved value and is untouched by this phase', () => {
        const code = strip(R(PORTAL));
        const i = code.indexOf('const getShopOrderUrl');
        const block = code.slice(i, code.indexOf('};', i));
        expect(block).toContain('campaign?.share?.orderUrl');
        expect(block).toContain('/shop/${slug}/fundraiser/${campaign.id}');
    });

    it('the QR PNG is generated from the SAME server-side authority (Part H item 8: unchanged, and confirmed same source)', () => {
        const code = strip(R(QR_ROUTE));
        expect(code).toContain('buildSupporterOrderUrl(');
        expect(code).toContain('generateQrCode(publicUrl)');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART C/D/E — the new action itself: label, placement, behavior.
// ═════════════════════════════════════════════════════════════════════════════
describe('coordinator panel renders "View Supporter Page"', () => {
    it('REQUIRED 1 — the exact label appears in the Share Center action group', () => {
        const code = R(SHARE_CENTER);
        expect(code).toContain('View Supporter Page');
    });

    it('does not use forbidden vague wording for this action', () => {
        const code = strip(R(SHARE_CENTER));
        expect(code).not.toMatch(/label=["']Customer Portal["']/);
        expect(code).not.toMatch(/label=["']Preview["']/);
        expect(code).not.toMatch(/label=["']Open["']/);
        expect(code).not.toMatch(/label=["']Visit Site["']/);
    });

    it('REQUIRED 6 — renders as a link that opens in a new tab, same target/rel authority as every other mini-link', () => {
        const code = strip(R(SHARE_CENTER));
        // COORD-POLISH-1: styled apart from the plain utility links via a
        // PrimaryMiniLink sibling (same href/target/rel contract as
        // MiniLink, only the accent differs) — not a second URL formula.
        const line = code.split('\n').find(l => l.includes('label="View Supporter Page"'));
        expect(line).toBeDefined();
        expect(line).toMatch(/<PrimaryMiniLink\b/);
        const anchorBlock = code.slice(code.indexOf('function PrimaryMiniLink'), code.indexOf('function PrimaryMiniLink') + 400);
        expect(anchorBlock).toContain('target="_blank"');
        expect(anchorBlock).toContain('rel="noreferrer"');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART B/H — the button MUST use the exact same authority as Copy/Share.
// ═════════════════════════════════════════════════════════════════════════════
describe('the href is the exact same value as the existing Copy/Share authority — not a lookalike', () => {
    it('REQUIRED 2/3 — "View Supporter Page" uses the literal `shareUrl` identifier, the same one the Copy row displays and copies', () => {
        const code = strip(R(SHARE_CENTER));
        const line = code.split('\n').find(l => l.includes('label="View Supporter Page"'));
        expect(line).toMatch(/href=\{shareUrl\}/);
        // The exact same identifier drives the copy-target code block above it.
        expect(code).toContain('{shareUrl.replace(');
    });

    it('no second URL is constructed anywhere in ShareCenter — the component receives shareUrl, it does not build one', () => {
        const code = strip(R(SHARE_CENTER));
        expect(code).not.toMatch(/\/shop\/|\/fundraiser\/|window\.location|new URL\(/);
    });

    it('REQUIRED 4 — the portal passes the SAME `shareUrl` variable into every ShareCenter mount, no per-phase drift', () => {
        const code = strip(R(PORTAL));
        const mounts = [...code.matchAll(/<ShareCenter\b[\s\S]*?\/>/g)].map(m => m[0]);
        expect(mounts.length).toBeGreaterThanOrEqual(3);
        for (const m of mounts) expect(m).toMatch(/shareUrl=\{shareUrl\}/);
    });

    it('REQUIRED 5 — the portal still derives `shareUrl` from the one call to getShopOrderUrl(), not a duplicate', () => {
        const code = strip(R(PORTAL));
        expect(code).toContain('const shareUrl = getShopOrderUrl();');
        expect((code.match(/const shareUrl = getShopOrderUrl\(\);/g) || []).length).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART G — tenant/domain safety, by construction.
// ═════════════════════════════════════════════════════════════════════════════
describe('tenant/domain safety: the link cannot drift to another tenant or campaign', () => {
    it('REQUIRED 5 (domain) — ShareCenter receives shareUrl as an opaque prop; it has no business_id/tenant lookup of its own', () => {
        const code = R(SHARE_CENTER);
        expect(code).not.toMatch(/business_id|customDomain|tenantId|prisma\./);
    });

    it('campaign.share.orderUrl is scoped to the session-resolved campaign, never a client-supplied id (unchanged, re-verified)', () => {
        const code = strip(R(COORD_GET));
        expect(code).toContain('const campaignId = guard.campaignId;');
        const i = code.indexOf('buildSupporterOrderUrl(');
        const call = code.slice(i, code.indexOf(');', i) + 1);
        expect(call).toContain('campaign.id');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART Q(H) — no auth/admin data added; no mutation on click or view.
// ═════════════════════════════════════════════════════════════════════════════
describe('the new action carries no coordinator/admin state and mutates nothing', () => {
    it('REQUIRED 7 — ShareCenter never references a session, token, or credential', () => {
        const code = strip(R(SHARE_CENTER));
        expect(code).not.toMatch(/portal_token|public_token|session|credential|authToken|coordinatorToken/i);
    });

    it('REQUIRED 10 — MiniLink has no onClick and ShareCenter performs no fetch/POST; viewing is a plain navigation', () => {
        const code = strip(R(SHARE_CENTER));
        expect(code).not.toMatch(/onClick=\{.*View Supporter/);
        expect(code).not.toMatch(/fetch\(|trackAction\(/);
        // The MiniLink function signature itself takes no handler prop.
        const sig = code.slice(code.indexOf('function MiniLink'), code.indexOf('{', code.indexOf('function MiniLink')));
        expect(sig).not.toMatch(/onClick/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 8/9 — existing behavior is unchanged.
// ═════════════════════════════════════════════════════════════════════════════
describe('existing coordinator actions and QR code behavior are unchanged', () => {
    it('REQUIRED 8 — the QR download route is untouched by this phase (byte-for-byte-relevant lines unchanged)', () => {
        const code = strip(R(QR_ROUTE));
        expect(code).toContain('const qr = await generateQrCode(publicUrl);');
        expect(code).toContain("Content-Type': 'image/png'");
    });

    it('REQUIRED 9 — Copy Link, Facebook, Native, Email share handlers in the portal are untouched', () => {
        const code = strip(R(PORTAL));
        expect(code).toContain('const handleCopyLink = () => {');
        expect(code).toContain('navigator.clipboard.writeText(getShopOrderUrl());');
        const fb = code.slice(code.indexOf('const handleShareFacebook'), code.indexOf('const handleShareText'));
        expect(fb).toContain('https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(getShopOrderUrl())}');
    });

    it('REQUIRED 9 — the existing QR/Flyer/Scoreboard mini-links still render with the same conditional wiring (labels relabeled by COORD-SHARE-CENTER-POLISH-2; that phase\'s own suite guards the exact text)', () => {
        const code = strip(R(SHARE_CENTER));
        expect(code).toContain('{qrHref && <MiniLink href={qrHref} label="Printable QR Code" />}');
        expect(code).toContain('{flyerHref && <MiniLink href={flyerHref} label="Printable Flyer" />}');
        expect(code).toContain('{scoreboardHref && <MiniLink href={scoreboardHref} label="Share Scoreboard" />}');
    });

    it('REQUIRED 6 (Part F) — the button inherits ShareCenter\'s existing phase-gating with zero new campaign-state logic', () => {
        // ShareCenter itself carries no phase/state branching — it is mounted or
        // not by the PARENT (setup/launch/push/lastDay; never in "complete").
        // Proving ShareCenter has no new conditional confirms no new policy was
        // invented, per the mission's explicit "do not invent a new campaign-
        // state policy."
        const code = strip(R(SHARE_CENTER));
        expect(code).not.toMatch(/campaignPhase|isClosed|is_active|status ===/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART J — scope: ShareCenter.tsx is the ENTIRE production change.
// ═════════════════════════════════════════════════════════════════════════════
describe('scope stayed tiny — no sensitive/locked-channel file was touched', () => {
    it('the retired token page and every coordinator API route are untouched (not part of this phase\'s diff)', () => {
        // These are read only to prove they still describe the SAME pre-existing
        // shape this phase depends on, not to license editing them.
        const retired = R('app/coordinator/[token]/page.tsx');
        expect(retired).toContain('This coordinator link is no longer valid');
        const qr = R(QR_ROUTE);
        expect(qr).toContain('requireCoordinatorSession(req)');
    });

    it('no kitchen/calculation/Delivery/payment module is referenced anywhere in ShareCenter.tsx', () => {
        const code = R(SHARE_CENTER);
        expect(code).not.toMatch(/kitchen_engine|deliveryPackaging|physicalBoxPacking|checkout|stripe|square/i);
    });
});
