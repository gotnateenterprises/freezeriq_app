/**
 * FR-REBOOK-2 FINAL ARMING — the live Previous Supporters send path.
 *
 * The batch resolver is driven directly, because its whole value is what it does
 * in a race. The route contracts are asserted against shipped source, sliced to
 * the specific block so an assertion cannot pass by matching an unrelated line.
 */
process.env.TZ = 'America/Chicago';

import fs from 'fs';
import path from 'path';
import {
    resolveCampaignBatch,
    syncCampaignRecipients,
    resolveCampaignMessage,
    assertFundraiserOwnerShape,
} from '../lib/previousSupporterBatch';
import {
    buildInviteDraft,
    renderInviteEmail,
    validateInviteMessage,
    INVITE_SUBJECT_MAX,
    INVITE_BODY_MAX,
} from '../lib/previousSupporterInvite';
import { resolveSendCapability } from '../app/api/coordinator/previous-supporters/route';
import type { PreviousSupporter } from '../lib/previousSupporters';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ROUTE = 'app/api/coordinator/previous-supporters/route.ts';
const BATCH = 'lib/previousSupporterBatch.ts';
const CARD = 'components/coordinator/PreviousSupporters.tsx';

const OWNER = { businessId: 'biz-1', customerId: 'org-1', campaignId: 'camp-now' };

// ── a prisma stand-in with the real unique behaviour ────────────────────────
function fakePrisma() {
    const batches: any[] = [];
    const recipients: any[] = [];
    const messages: any[] = [];
    let n = 0;
    const uniq = (code = 'P2002') => Object.assign(new Error('Unique constraint failed'), { code });

    return {
        __batches: batches, __recipients: recipients, __messages: messages,
        outreachBatch: {
            findFirst: async ({ where }: any) => batches.find((b) =>
                (where.business_id === undefined || b.business_id === where.business_id)
                && (where.customer_id === undefined || b.customer_id === where.customer_id)
                && (where.campaign_id === undefined || b.campaign_id === where.campaign_id)) ?? null,
            create: async ({ data }: any) => {
                // outreach_batches_one_per_campaign, WHERE campaign_id IS NOT NULL
                if (data.campaign_id && batches.some((b) => b.campaign_id === data.campaign_id)) throw uniq();
                const row = { id: `b${++n}`, ...data };
                batches.push(row);
                return { id: row.id };
            },
        },
        outreachRecipient: {
            findMany: async ({ where }: any) => recipients.filter((r) =>
                r.business_id === where.business_id && r.outreach_batch_id === where.outreach_batch_id),
            findFirst: async ({ where }: any) => recipients.find((r) =>
                r.business_id === where.business_id && r.outreach_batch_id === where.outreach_batch_id
                && r.normalized_email === where.normalized_email) ?? null,
            create: async ({ data }: any) => {
                // outreach_recipients_batch_one_email, WHERE normalized_email IS NOT NULL
                if (data.normalized_email && recipients.some((r) =>
                    r.outreach_batch_id === data.outreach_batch_id && r.normalized_email === data.normalized_email)) throw uniq();
                const row = { id: `r${++n}`, ...data };
                recipients.push(row);
                return { id: row.id };
            },
        },
        outreachMessage: {
            findFirst: async ({ where }: any) => messages.find((m) =>
                m.business_id === where.business_id && m.outreach_batch_id === where.outreach_batch_id) ?? null,
            create: async ({ data }: any) => {
                const row = { id: `m${++n}`, version: 1, ...data };
                messages.push(row);
                return { id: row.id, version: row.version };
            },
            update: async ({ where, data }: any) => {
                const row = messages.find((m) => m.id === where.id)!;
                if (data.version?.increment) row.version += data.version.increment;
                Object.assign(row, { ...data, version: row.version });
                return { id: row.id, version: row.version };
            },
        },
    } as any;
}

const supporter = (email: string | null, name = 'Person'): PreviousSupporter => ({
    key: email ? `email:${email}` : `order:${name}`,
    displayName: name,
    email,
    phone: null,
    orderCount: 1,
    reachable: !!email,
    exclusionReason: email ? null : 'no_email',
});

// ── BATCH RESOLVER ──────────────────────────────────────────────────────────
describe('FR-REBOOK-2 · campaign-owned batch resolver', () => {
    it('creates the batch with EXPLICIT scalars and a null seasonal owner', async () => {
        const p = fakePrisma();
        const r = await resolveCampaignBatch(p, OWNER);
        expect(r.how).toBe('created');
        expect(p.__batches).toHaveLength(1);
        expect(p.__batches[0]).toMatchObject({
            business_id: 'biz-1', customer_id: 'org-1', campaign_id: 'camp-now',
            seasonal_offering_id: null,
        });
    });

    it('reuses the same batch on a second call — never a second one', async () => {
        const p = fakePrisma();
        const a = await resolveCampaignBatch(p, OWNER);
        const b = await resolveCampaignBatch(p, OWNER);
        expect(b.how).toBe('reused');
        expect(b.id).toBe(a.id);
        expect(p.__batches).toHaveLength(1);
    });

    it('LOSES the create race, then re-reads the winner — same batch', async () => {
        // Both requests read "none", then both try to create. The database
        // decides; the loser must adopt the winner's row.
        const p = fakePrisma();
        const realCreate = p.outreachBatch.create;
        let first = true;
        p.outreachBatch.create = async (args: any) => {
            if (first) {
                first = false;
                await realCreate({ data: { ...args.data } });      // the winner lands
                throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
            }
            return realCreate(args);
        };
        const loser = await resolveCampaignBatch(p, OWNER);
        expect(loser.how).toBe('reused_after_race');
        expect(p.__batches).toHaveLength(1);
        expect(loser.id).toBe(p.__batches[0].id);
    });

    it('does NOT treat an unrelated P2002 as the campaign race', async () => {
        // A unique violation from some other constraint must surface, not be
        // swallowed into a re-read that finds nothing.
        const p = fakePrisma();
        p.outreachBatch.create = async () => {
            throw Object.assign(new Error('Unique constraint failed on business_id_id'), { code: 'P2002' });
        };
        await expect(resolveCampaignBatch(p, OWNER)).rejects.toThrow(/Unique constraint/);
        expect(p.__batches).toHaveLength(0);
    });

    it('rethrows a non-unique error WITHOUT attempting a race re-read', async () => {
        const p = fakePrisma();
        let reads = 0;
        const realFind = p.outreachBatch.findFirst;
        p.outreachBatch.findFirst = async (a: any) => { reads++; return realFind(a); };
        p.outreachBatch.create = async () => { throw Object.assign(new Error('connection lost'), { code: 'P1001' }); };
        await expect(resolveCampaignBatch(p, OWNER)).rejects.toThrow('connection lost');
        // One read before the create. A second would mean a dropped connection
        // had been mistaken for someone else winning the campaign race.
        expect(reads).toBe(1);
    });

    it('refuses an incomplete owner BEFORE touching the database', async () => {
        const p = fakePrisma();
        for (const bad of [
            { ...OWNER, customerId: '' }, { ...OWNER, campaignId: '   ' }, { ...OWNER, businessId: undefined as any },
        ]) {
            await expect(resolveCampaignBatch(p, bad)).rejects.toThrow(/incomplete/);
        }
        expect(p.__batches).toHaveLength(0);
        expect(() => assertFundraiserOwnerShape(OWNER)).not.toThrow();
    });

    it('uses no nested connect and no upsert anywhere', () => {
        const src = strip(R(BATCH));
        expect(src).not.toMatch(/\bconnect\s*:/);
        expect(src).not.toMatch(/\.upsert\(/);
        // Ownership is written as explicit scalars.
        expect(src).toContain('business_id: owner.businessId');
        expect(src).toContain('customer_id: owner.customerId');
        expect(src).toContain('campaign_id: owner.campaignId');
        expect(src).toContain('seasonal_offering_id: null');
    });
});

describe('FR-REBOOK-2 · recipient + message snapshot', () => {
    it('creates one recipient per REACHABLE supporter only', async () => {
        const p = fakePrisma();
        const batch = await resolveCampaignBatch(p, OWNER);
        const rows = await syncCampaignRecipients(p, {
            businessId: 'biz-1', batchId: batch.id,
            supporters: [supporter('a@example.com', 'A'), supporter(null, 'NoEmail'), supporter('b@example.com', 'B')],
        });
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.normalizedEmail).sort()).toEqual(['a@example.com', 'b@example.com']);
        expect(p.__recipients.every((r: any) => r.eligibility === 'included')).toBe(true);
    });

    it('re-running reuses the same recipient rows', async () => {
        const p = fakePrisma();
        const batch = await resolveCampaignBatch(p, OWNER);
        const first = await syncCampaignRecipients(p, { businessId: 'biz-1', batchId: batch.id, supporters: [supporter('a@example.com')] });
        let creates = 0;
        const realCreate = p.outreachRecipient.create;
        p.outreachRecipient.create = async (a: any) => { creates++; return realCreate(a); };
        const second = await syncCampaignRecipients(p, { businessId: 'biz-1', batchId: batch.id, supporters: [supporter('a@example.com')] });
        expect(second[0].recipientId).toBe(first[0].recipientId);
        expect(p.__recipients).toHaveLength(1);
        // The existing row is READ, not re-inserted and rescued by the index.
        expect(creates).toBe(0);
    });

    it('survives a concurrent recipient race by adopting the winner', async () => {
        const p = fakePrisma();
        const batch = await resolveCampaignBatch(p, OWNER);
        const realCreate = p.outreachRecipient.create;
        let first = true;
        p.outreachRecipient.create = async (args: any) => {
            if (first) { first = false; await realCreate({ data: { ...args.data } });
                throw Object.assign(new Error('Unique'), { code: 'P2002' }); }
            return realCreate(args);
        };
        const rows = await syncCampaignRecipients(p, { businessId: 'biz-1', batchId: batch.id, supporters: [supporter('a@example.com')] });
        expect(rows).toHaveLength(1);
        expect(p.__recipients).toHaveLength(1);
    });

    it('keeps the SAME generation when the wording is unchanged', async () => {
        // The idempotency key is message + recipient + generation. Bumping the
        // generation on an identical resend would mail everyone again.
        const p = fakePrisma();
        const batch = await resolveCampaignBatch(p, OWNER);
        const args = { businessId: 'biz-1', batchId: batch.id, subject: 'S', html: '<p>H</p>', text: 'H' };
        const a = await resolveCampaignMessage(p, args);
        const b = await resolveCampaignMessage(p, args);
        expect(b.id).toBe(a.id);
        expect(b.version).toBe(a.version);
        expect(p.__messages).toHaveLength(1);
    });

    it('advances the generation when the coordinator rewrites the message', async () => {
        const p = fakePrisma();
        const batch = await resolveCampaignBatch(p, OWNER);
        const a = await resolveCampaignMessage(p, { businessId: 'biz-1', batchId: batch.id, subject: 'S', html: '<p>H</p>', text: 'H' });
        const b = await resolveCampaignMessage(p, { businessId: 'biz-1', batchId: batch.id, subject: 'S', html: '<p>NEW</p>', text: 'NEW' });
        expect(b.id).toBe(a.id);
        expect(b.version).toBe(a.version + 1);
    });
});

// ── canSend ─────────────────────────────────────────────────────────────────
describe('FR-REBOOK-2 · dynamic canSend', () => {
    const ready = { reachableCount: 5, orderUrl: 'https://x.test/shop/s/fundraiser/c', unsubscribeReady: true };

    it('is true only when every precondition holds', () => {
        const c = resolveSendCapability(ready);
        expect(c).toMatchObject({ canSend: true, code: 'ready' });
        expect(c.reason).toContain('5 previous supporters');
    });

    it('EDGAR: historical supporters but zero reachable -> cannot send', () => {
        const c = resolveSendCapability({ ...ready, reachableCount: 0 });
        expect(c.canSend).toBe(false);
        expect(c.code).toBe('no_reachable_audience');
        expect(c.reason).toContain('No previous supporters with a usable email address');
    });

    it('no ordering page -> cannot send', () => {
        const c = resolveSendCapability({ ...ready, orderUrl: null });
        expect(c).toMatchObject({ canSend: false, code: 'no_order_link' });
    });

    it('no unsubscribe capability -> cannot send', () => {
        const c = resolveSendCapability({ ...ready, unsubscribeReady: false });
        expect(c).toMatchObject({ canSend: false, code: 'outreach_consent_unavailable' });
    });

    it('is DERIVED, not hardcoded — the literal appears only in the ready branch', () => {
        const route = strip(R(ROUTE));
        // `canSend: true` legitimately exists once, inside resolveSendCapability's
        // success branch. What must never happen is a handler asserting it
        // directly instead of asking the resolver.
        const resolver = route.slice(
            route.indexOf('export function resolveSendCapability('),
            route.indexOf('export async function GET('),
        );
        expect((route.match(/canSend: true/g) ?? [])).toHaveLength(1);
        expect(resolver).toContain('canSend: true');

        const handlers = route.slice(route.indexOf('export async function GET('));
        expect(handlers).not.toContain('canSend: true');
        expect(handlers).not.toContain('canSend: false');
        expect((handlers.match(/resolveSendCapability\(\{/g) ?? []).length).toBe(2);   // GET and POST
    });
});

// ── THE PROTECTED CTA ───────────────────────────────────────────────────────
describe('FR-REBOOK-2 · the ordering CTA is the server\'s', () => {
    const URL_ = 'https://www.freezeriqapp.com/shop/freezer-chef/fundraiser/camp-now';

    it('the editable prose contains NO url — so it cannot be edited', () => {
        const d = buildInviteDraft({
            organizationName: 'Edgar County Farm Bureau',
            campaign: { id: 'camp-now', name: 'Fall', end_date: new Date('2026-04-29T00:00:00Z'), public_token: 'pub' },
            origin: 'https://www.freezeriqapp.com',
            tenant: { slug: 'freezer-chef', customDomain: null },
        });
        expect(d.text).not.toContain('http');
        expect(d.text).not.toContain('/shop/');
        expect(d.orderUrl).toBe(URL_);          // still shown beside the editor
        expect(d.text).toContain('order online using the link below');
    });

    it('the server appends the canonical CTA, whatever the coordinator wrote', () => {
        const out = renderInviteEmail({ text: 'Come buy things.', orderUrl: URL_ })!;
        expect(out.html).toContain(`href="${URL_}"`);
        expect(out.html).toContain('Order Online');
        expect(out.text).toContain(URL_);
    });

    it('a URL pasted into the prose is inert text, not a second destination', () => {
        const out = renderInviteEmail({
            text: 'Order at https://evil.test/steal instead',
            orderUrl: URL_,
        })!;
        // The only href in the whole email is the canonical one.
        const hrefs = [...out.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs).toEqual([URL_]);
        expect(out.html).toContain('https://evil.test/steal');   // present, as TEXT
        expect(out.html).not.toContain('href="https://evil.test/steal"');
    });

    it('escapes the CTA href itself — a query string is not a way in', () => {
        // new URL() percent-encodes quotes and angle brackets, so those cannot
        // reach the attribute. "&" is the character it legitimately preserves,
        // and it is exactly the one that must become an entity inside an HTML
        // attribute. Without esc(url) the href would carry a raw ampersand.
        const q = 'https://freezer.test/shop/freezer-chef/fundraiser/camp-1?ref=a&utm=b';
        const out = renderInviteEmail({ text: 'hi', orderUrl: q })!;
        expect(out.html).toContain(`href="${q.replace(/&/g, '&amp;')}"`);
        expect(out.html).not.toContain(`href="${q}"`);
        // The plain-text part carries the real URL, un-entitied — it is not HTML.
        expect(out.text).toContain(q);
    });

    it('refuses to render with no ordering URL rather than mail a dead end', () => {
        expect(renderInviteEmail({ text: 'x', orderUrl: null })).toBeNull();
        expect(renderInviteEmail({ text: 'x', orderUrl: 'javascript:alert(1)' })).toBeNull();
        expect(renderInviteEmail({ text: 'x', orderUrl: '/relative' })).toBeNull();
    });

    it('escapes hostile coordinator input into harmless text', () => {
        const out = renderInviteEmail({
            text: '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<a href="javascript:alert(1)">c</a>',
            orderUrl: URL_,
        })!;
        expect(out.html).not.toContain('<script');
        expect(out.html).not.toContain('<img');
        expect(out.html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
        expect(out.html).not.toContain('href="javascript:');
        expect(out.html).toContain('&lt;script&gt;');
        const tags = [...new Set([...out.html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()))];
        expect(tags.every((t) => ['div', 'p', 'br', 'strong', 'a'].includes(t))).toBe(true);
    });
});

// ── THE SEND ROUTE ──────────────────────────────────────────────────────────
describe('FR-REBOOK-2 · send endpoint authority (shipped source)', () => {
    const route = strip(R(ROUTE));
    const post = route.slice(route.indexOf('export async function POST('));

    it('exists and is coordinator-session scoped, exactly like GET', () => {
        expect(post).toContain('requireCoordinatorSession(req)');
        expect(post).toContain('const campaignId = guard.campaignId');
    });

    it('reads ONLY subject and text from the client', () => {
        expect(post).toContain('subject: body?.subject, text: body?.text');
        for (const f of ['body?.to', 'body?.recipients', 'body?.emails', 'body?.businessId',
            'body?.customerId', 'body?.campaignId', 'body?.batchId', 'body?.orderUrl', 'body?.count']) {
            expect(post).not.toContain(f);
        }
        expect(post).not.toMatch(/searchParams/);
    });

    it('recomputes the audience server-side rather than trusting the preview', () => {
        expect(post).toContain('await computeAudience({ businessId, organizationCustomerId, campaignId })');
        expect(post).toContain('resolveSendCapability({');
        // The capability is re-derived and refused BEFORE any batch work.
        // indexOf must be proven present first: a missing guard returns -1,
        // which would satisfy a bare "less than" and pass vacuously.
        const guardAt = post.indexOf('if (!capability.canSend)');
        expect(guardAt).toBeGreaterThan(-1);
        expect(guardAt).toBeLessThan(post.indexOf('resolveCampaignBatch('));
    });

    it('derives the ordering URL from the PINNED origin, never the request host', () => {
        expect(post).toContain('resolveOutreachOrigin(req)');
        expect(post).not.toContain('new URL(req.url).origin');
        expect(post).not.toMatch(/x-forwarded-host/i);
    });

    it('renders the email server-side and sends the RENDERED body', () => {
        expect(post).toContain('renderInviteEmail({');
        expect(post).toContain('safeSubject(validated.subject)');
        const send = post.slice(post.indexOf('await runSend({'));
        const args = send.slice(0, send.indexOf('        });'));
        expect(args).toContain('html: rendered.html');
        expect(args).toContain('text: rendered.text');
        expect(args).not.toContain('html: body');
    });

    it('goes through the deployed engine — never a parallel sender', () => {
        expect(post).toContain('await runSend({');
        expect(post).toContain('new ResendOutreachProvider()');
        // No direct provider.send bypassing runSend's footer/suppression.
        expect(post).not.toMatch(/provider\.send\(/);
        expect(post).not.toContain('resend.emails.send');
    });

    it('supplies the unsubscribe capability runSend requires', () => {
        expect(post).toContain('unsubscribe: { origin, brandName:');
        expect(post).toContain('unsubscribeReady: Boolean(unsubscribeSecret())');
        expect(post).toContain('if (summary.refusal)');
    });

    it('reports truthful counts, never the audience size', () => {
        const resp = post.slice(post.indexOf('return NextResponse.json({\n            ok: true'));
        expect(resp).toContain('accepted: summary.accepted');
        expect(resp).toContain('failed: summary.failed');
        expect(resp).toContain('skipped: summary.skipped');
        expect(resp).toContain('alreadySent: summary.alreadyAttempted');
        expect(resp).not.toMatch(/reachableCount|supporterCount/);
    });

    it('creates no order, campaign, invoice or participation record', () => {
        for (const w of ['order.create', 'order.update', 'fundraiserCampaign.update', 'invoice.',
            'customer.update', 'fundraiserOpportunity.update', 'loyalty']) {
            expect(post).not.toContain(w);
        }
    });

    it('never writes a preference or suppression row', () => {
        expect(post).not.toContain('marketingPreference.create');
        expect(post).not.toContain('marketingPreference.update');
        expect(post).not.toContain('emailSuppressionEvent');
    });
});

describe('FR-REBOOK-2 · the armed card', () => {
    const card = strip(R(CARD));

    it('posts only the two edited strings', () => {
        expect(card).toContain("JSON.stringify({ subject: subject.trim(), text })");
        expect(card).not.toMatch(/recipients|emails:|campaignId|businessId|batchId/);
    });

    it('obeys the server\'s capability rather than deciding for itself', () => {
        expect(card).toContain('disabled={!data.send.canSend || sending');
        expect(card).toContain('if (!data?.send.canSend || sending) return;');
    });

    it('shows what the SERVER achieved, not the audience count', () => {
        expect(card).toContain('json.accepted ?? 0');
        expect(card).toContain('json.failed ?? 0');
        expect(card).toContain('json.skipped ?? 0');
        expect(card).toContain('invitation{result.accepted === 1');
    });

    it('still edits plain text and composes no HTML', () => {
        expect(card).toContain('setText(');
        expect(card).not.toContain('setHtml(');
        expect(card).not.toContain('dangerouslySetInnerHTML');
    });

    it('presents the order link as system-controlled, not as something to type', () => {
        expect(card).toContain('Current fundraiser');
        expect(card).toContain('Order Online');
        expect(card).toMatch(/don&rsquo;t need to type or paste it/);
    });

    it('never exposes a recipient address list', () => {
        expect(card).toContain('previous {c.reachable === 1');
        expect(card).not.toMatch(/\.map\([^)]*email[^)]*\)\s*\.join/);
    });
});

// ── message bounds ──────────────────────────────────────────────────────────
describe('FR-REBOOK-2 · message bounds still enforced', () => {
    const ok = { subject: 'Hi', text: 'Words', orderUrl: 'https://x.test/a' };
    it('accepts an edited subject and message', () => {
        expect(validateInviteMessage({ ...ok, subject: 'New', text: 'Totally new' })).toMatchObject({ ok: true });
    });
    it('refuses empty, oversized and non-string input', () => {
        expect(validateInviteMessage({ ...ok, subject: '   ' }).ok).toBe(false);
        expect(validateInviteMessage({ ...ok, text: '  ' }).ok).toBe(false);
        expect(validateInviteMessage({ ...ok, subject: 'x'.repeat(INVITE_SUBJECT_MAX + 1) }).ok).toBe(false);
        expect(validateInviteMessage({ ...ok, text: 'x'.repeat(INVITE_BODY_MAX + 1) }).ok).toBe(false);
        expect(validateInviteMessage({ ...ok, subject: 42 as any }).ok).toBe(false);
    });
});
