/**
 * FR-REBOOK-1A — no inquiry means nothing to answer, and the reply is editable.
 *
 * THE PRODUCTION DEFECT THIS CLOSES
 *
 * The owner clicked "Start Next Fundraiser" for Edgar County Farm Bureau — an
 * organization with zero FundraiserInquiry rows, because nobody filled in the
 * public form — and the Leads screen showed:
 *
 *     0 inquiries · not yet answered
 *     Respond to new inquiry
 *     "A new fundraiser inquiry has not been answered yet."
 *
 * WHY THE EARLIER TESTS PASSED ANYWAY, which is the part worth remembering:
 *
 * The first fix guarded triage with
 * `inquiries.length > 0 || toDate(o.received_at) !== null`, and every unit test
 * of it passed — because those fixtures set `received_at: null`. The only real
 * caller, /api/opportunities, sends
 * `received_at: firstInquiry?.received_at ?? o.created_at`, which is never null.
 * So the OR clause was permanently true in Production and the guard never fired.
 * The fixture was a shape the caller cannot produce.
 *
 * Two further surfaces were never covered at all: the panel prints
 * "· not yet answered" from `response_hours`, and renders the Respond button from
 * `response_state` — neither of which goes through triage.
 *
 * So this file tests the real payload shape, and tests the surfaces, not just the
 * helper underneath them.
 */

import { resolveInquiryResponse } from '@/lib/growth/inquiryResponseState';
import { triageOpportunity, funnelBucket } from '@/lib/growth/opportunityNextAction';
import { htmlToEditableText, editableTextToEmailHtml } from '@/lib/plainTextEmail';
import { EMAIL_TEMPLATES } from '@/lib/emailTemplates';

const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');
const code = (p: string): string =>
    read(p)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const PANEL = 'components/crm2/FunnelLeadsPanel.tsx';
const DIALOG = 'components/crm2/RespondToInquiryDialog.tsx';
const RESPOND = 'app/api/opportunities/[id]/respond/route.ts';
const OPP_API = 'app/api/opportunities/route.ts';

const NOW = new Date('2026-08-26T12:00:00.000Z');

/**
 * Edgar's ACTUAL row as /api/opportunities builds it. `received_at` is populated
 * from the opportunity's own created_at — the exact shape that defeated the
 * previous fix.
 */
const edgar: any = {
    status: 'new',
    received_at: '2026-08-26T04:01:44.329Z',
    first_response_at: null,
    preferred_delivery_date: null,
    alternate_delivery_date: null,
    confirmed_delivery_date: null,
    updated_at: '2026-08-26T04:01:44.329Z',
    inquiries: [],
};

/** A genuine public inquiry, for the regression side. */
const publicInquiry: any = {
    ...edgar,
    inquiries: [{ received_at: '2026-08-26T04:00:00.000Z', ack_sent_at: null, ack_claimed_at: null, human_response_at: null }],
};

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · zero inquiries is not an unanswered inquiry', () => {
    it('resolves to its own state, against the REAL payload shape', () => {
        expect(resolveInquiryResponse(edgar.first_response_at, edgar.inquiries).state)
            .toBe('no_inquiry');
    });

    it('reports no phantom inquiry facts alongside it', () => {
        // Every field here describes "the newest inquiry". With none, they must
        // all be empty — a synthesised timestamp would make an inquiry appear to
        // exist to anything that reads these instead of the state.
        const r = resolveInquiryResponse(edgar.first_response_at, edgar.inquiries);
        expect(r.latestInquiryAt).toBeNull();
        expect(r.autoAckSentAt).toBeNull();
        expect(r.autoAckClaimedAt).toBeNull();
        expect(r.manualResponseApplies).toBe(false);
        expect(r.lastHumanFollowUpAt).toBeNull();
    });

    it('the non-null received_at that broke the last fix does not affect it', () => {
        // Proven directly: the timestamp is present and irrelevant.
        expect(edgar.received_at).not.toBeNull();
        expect(triageOpportunity(edgar, NOW).action?.kind).toBe('await_preferred_dates');
    });

    it('asks for the date, never for a reply', () => {
        const t = triageOpportunity(edgar, NOW);
        expect(t.action?.kind).toBe('await_preferred_dates');
        expect(t.action?.kind).not.toBe('respond_to_inquiry');
    });

    it('says nothing about an inquiry in the reason', () => {
        expect(triageOpportunity(edgar, NOW).action?.reason ?? '').not.toMatch(/inquiry/i);
    });

    it('is not filed under New Leads', () => {
        expect(funnelBucket(edgar, NOW)).not.toBe('new_leads');
    });

    it('progresses normally once a date is proposed', () => {
        const withDate = { ...edgar, preferred_delivery_date: '2026-10-15' };
        expect(['check_date_availability', 'confirm_delivery_date'])
            .toContain(triageOpportunity(withDate, NOW).action?.kind);
    });

    it('an ABSENT inquiries array keeps the thin-payload contract', () => {
        // "Fewer signals, never a wrong one." Omitting the relation is not a claim
        // that there are none; only a supplied empty array is.
        expect(resolveInquiryResponse(null, undefined).state).toBe('needs_first_response');
        expect(resolveInquiryResponse(null, []).state).toBe('no_inquiry');
    });

    it('the decision lives in ONE place, keyed on the rows', () => {
        const st = code('lib/growth/inquiryResponseState.ts');
        expect(st).toContain('if (Array.isArray(inquiries) && !newest) {');
        expect(st).toContain("state: 'no_inquiry'");
        // And triage no longer carries a private copy that could disagree.
        expect(code('lib/growth/opportunityNextAction.ts')).not.toContain('const hasInquiry =');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · the Leads card stops inventing an obligation', () => {
    const panel = code(PANEL);

    it('"not yet answered" is only said when an inquiry exists', () => {
        expect(panel).toContain("o.response_state === 'no_inquiry' ?");
        // The old unconditional copy is now inside the else branch.
        const block = panel.slice(panel.indexOf("o.response_state === 'no_inquiry' ?"));
        expect(block.slice(0, 400)).toMatch(/no website inquiry/i);
    });

    it('the Respond and "I replied elsewhere" actions require an inquiry', () => {
        expect(panel).toContain("o.response_state !== 'no_inquiry' && !o.manual_response_applies");
    });

    it('the panel knows the new state exists', () => {
        expect(panel).toContain("'no_inquiry'");
    });

    it('the date controls are NOT gated behind answering anything', () => {
        // The real next step must stay reachable for a returning organization.
        expect(panel).toContain("action: 'set_dates'");
        expect(panel).toContain("action: 'confirm_date'");
        const setDates = panel.indexOf("action: 'set_dates'");
        const gate = panel.indexOf("o.response_state !== 'no_inquiry' && !o.manual_response_applies");
        // The date controls sit AFTER and OUTSIDE the inquiry-response block.
        expect(setDates).toBeGreaterThan(gate);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · genuine public inquiries are untouched', () => {
    it('still resolve to needs_first_response', () => {
        expect(resolveInquiryResponse(null, publicInquiry.inquiries).state)
            .toBe('needs_first_response');
    });

    it('still ask for a reply', () => {
        expect(triageOpportunity(publicInquiry, NOW).action?.kind).toBe('respond_to_inquiry');
    });

    it('still land in New Leads', () => {
        expect(funnelBucket(publicInquiry, NOW)).toBe('new_leads');
    });

    it('an acknowledged inquiry still reports the acknowledgement', () => {
        const acked = [{ received_at: '2026-08-26T04:00:00.000Z', ack_sent_at: '2026-08-26T04:05:00.000Z', ack_claimed_at: '2026-08-26T04:04:00.000Z', human_response_at: null }];
        expect(resolveInquiryResponse(null, acked).state).toBe('auto_ack_sent');
    });

    it('an unconfirmed acknowledgement still reports uncertainty', () => {
        const uncertain = [{ received_at: '2026-08-26T04:00:00.000Z', ack_sent_at: null, ack_claimed_at: '2026-08-26T04:04:00.000Z', human_response_at: null }];
        expect(resolveInquiryResponse(null, uncertain).state).toBe('auto_ack_uncertain');
    });

    it('a human reply still wins', () => {
        const replied = [{ received_at: '2026-08-26T04:00:00.000Z', ack_sent_at: null, ack_claimed_at: null, human_response_at: '2026-08-26T05:00:00.000Z' }];
        expect(resolveInquiryResponse(null, replied).state).toBe('manual_response');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · the reply is visible and editable', () => {
    const dialog = read(DIALOG);
    const dialogCode = code(DIALOG);

    it('shows a real subject field, prefilled and editable', () => {
        expect(dialog).toContain('id="respond-subject"');
        expect(dialogCode).toContain('onChange={(e) => setSubject(e.target.value)}');
    });

    it('shows the REAL message body, prefilled and editable', () => {
        expect(dialog).toContain('id="respond-body"');
        expect(dialog).toContain('<textarea');
        expect(dialogCode).toContain('onChange={(e) => setText(e.target.value)}');
    });

    it('the owner edits TEXT — the browser never composes markup', () => {
        // The adversarial review's Part I: an html field accepted from the client
        // is a general HTML email composer, not a personalisation box.
        expect(dialogCode).not.toContain('setHtml(');
        expect(dialogCode).toContain('setText(');
    });

    it('no longer merely DESCRIBES the email', () => {
        expect(dialog).not.toContain('Your standard fundraiser introduction\n');
        expect(dialog).not.toMatch(/Sends your saved introduction/);
    });

    it('loads the draft from the server before offering to send', () => {
        expect(dialogCode).toContain('/respond');
        expect(dialogCode).toContain('setSubject(data?.subject');
        expect(dialogCode).toContain('setText(data?.text');
    });

    it('sends the EDITED subject and body, not a template key', () => {
        expect(dialogCode).toContain("JSON.stringify({ subject: subject.trim(), text })");
        expect(dialogCode).not.toContain("template: 'lead_intro'");
    });

    it('the recipient is displayed but NOT editable', () => {
        expect(dialogCode).not.toContain('setTo(e.target.value)');
        expect(dialogCode).not.toContain('id="respond-to"');
        // It still shows who is being written to.
        expect(dialog).toMatch(/Send to/);
    });

    it('cannot send an empty message', () => {
        // Scoped to the send function. The same expression also appears in the
        // button's disabled prop, so a whole-file search would pass with the
        // send-time guard removed.
        const send = dialogCode.slice(dialogCode.indexOf('const send = useCallback'));
        const guard = send.slice(0, send.indexOf('setSending(true)'));
        expect(guard).toContain('!subject.trim() || !text.trim()');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · server authority and email truth', () => {
    const route = code(RESPOND);
    const post = route.slice(route.indexOf('export async function POST('));

    it('derives the recipient from the opportunity, never from the client', () => {
        expect(post).toContain('target.customer?.contact_email');
        expect(post).not.toMatch(/body\?\.to/);
        expect(post).not.toMatch(/const .*to.* = .*body/);
    });

    it('is tenant-scoped and non-disclosing', () => {
        expect(route).toContain('where: { id: opportunityId, business_id: businessId }');
        expect(route).toContain("{ error: 'Opportunity not found' }");
        expect(route).toContain("{ error: 'Unauthorized' }");
    });

    it('bounds what the owner may edit', () => {
        expect(route).toContain('RESPOND_SUBJECT_MAX');
        expect(route).toContain('RESPOND_BODY_MAX');
        expect(post).toContain('rawSubject.length > RESPOND_SUBJECT_MAX');
        expect(post).toContain('rawText.length > RESPOND_BODY_MAX');
    });

    it('runs the edited subject through safeSubject — no header injection', () => {
        expect(post).toContain('safeSubject(rawSubject)');
    });

    it('honours safety mode and says so, recording nothing', () => {
        expect(post).toContain("process.env.EMAIL_LIVE === 'true'");
        expect(post).toContain('mocked: true');
    });

    it('a provider failure is a failure — never a success', () => {
        // Scoped to the data.error branch. The outer catch also returns 502 with
        // success:false, so a whole-handler search would pass even with the
        // provider-error branch deleted and an error reported as a send.
        const branch = post.slice(post.indexOf('if (data.error) {'));
        const body = branch.slice(0, branch.indexOf('return NextResponse.json({ success: true'));
        expect(body).toContain('success: false');
        expect(body).toContain('{ status: 502 }');
        expect(body).toMatch(/could not be sent/);
        // Provider text never reaches the browser.
        expect(body).not.toContain('data.error }');
    });

    it('uses the CANONICAL template — there is no second copy to drift', () => {
        expect(route).toContain('resolveTenantBrand');
        // The dialog renders none of its own copy.
        expect(code(DIALOG)).not.toContain('lead_intro');

        // renderDraft must RETURN the generator, with no hand-written subject or
        // body short-circuiting it. Merely finding the identifier somewhere in
        // the file would pass with a hardcoded literal returned above it.
        const fn = route.slice(route.indexOf('async function renderDraft'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).toContain('return EMAIL_TEMPLATES.lead_intro(');
        expect(body).not.toMatch(/return \{\s*subject:/);
        expect((body.match(/return /g) || []).length).toBe(1);
    });

    it('reports whether a real inquiry exists, so the dialog need not guess', () => {
        expect(route).toContain('hasInquiry: target._count.inquiries > 0');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · the reply endpoint fails CLOSED without an inquiry', () => {
    const route = code(RESPOND);
    const post = route.slice(route.indexOf('export async function POST('));

    it('refuses to send for an opportunity with zero inquiries', () => {
        // Part R: hiding the button is a suggestion, not a control. Anyone
        // reaching the route directly gets the same answer the panel gives.
        expect(post).toContain('if (target._count.inquiries === 0) {');
        expect(post).toContain("code: 'no_inquiry'");
        expect(post).toContain('{ status: 409 }');
    });

    it('and refuses BEFORE reading the body or contacting a provider', () => {
        const guard = post.indexOf('target._count.inquiries === 0');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(post.indexOf('await req.json()'));
        expect(guard).toBeLessThan(post.indexOf('resend.emails.send'));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · the owner personalises text, the server writes the markup', () => {
    it('the draft handed to the owner is text — no tags, no entities', () => {
        const draft = EMAIL_TEMPLATES.lead_intro('Wyatt Williamson', 'Edgar County Farm Bureau', { name: 'Freezer Chef' });
        const text = htmlToEditableText(draft.html);
        expect(text).not.toMatch(/<[a-z]/i);
        expect(text).not.toMatch(/&[a-zA-Z#0-9]+;/);
        // It is still the canonical letter, not a rewrite.
        expect(text).toMatch(/Edgar County Farm Bureau/);
        expect(text).toMatch(/preferred date/i);
    });

    it('the endpoint reads TEXT and never html from the request', () => {
        const post = code(RESPOND).slice(code(RESPOND).indexOf('export async function POST('));
        expect(post).toContain("typeof body?.text === 'string'");
        expect(post).not.toContain("body?.html");
        expect(post).toContain('editableTextToEmailHtml(rawText');

        // And the RENDERED body is what actually goes to the provider. Asserting
        // only that the render happens would pass with the result discarded and
        // the raw text sent instead.
        const send = post.slice(post.indexOf('resend.emails.send('));
        const args = send.slice(0, send.indexOf('});'));
        expect(args).toContain('html: finalHtml');
        expect(args).not.toContain('html: rawText');
        expect(args).toContain('subject,');
        expect(args).toContain('to: [recipient]');
    });

    it('EXECUTED: hostile text can never become markup', () => {
        const attacks = [
            '<script>alert(1)</script>',
            '<img src=x onerror=alert(1)>',
            '<a href="javascript:alert(1)">click</a>',
            '<div style="position:fixed">overlay</div>',
            'Subject: forged\r\nBcc: evil@example.com',
            '</p><p>injected',
            '<<<>>>malformed<<<',
            '&lt;script&gt;alert(1)&lt;/script&gt;',
        ];
        for (const a of attacks) {
            const out = editableTextToEmailHtml(a, { name: 'Freezer Chef' });
            // The ONLY tags in the result are the ones the module writes.
            const tags = [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
            expect([...new Set(tags)].every((t) => ['div', 'p', 'br', 'strong', 'a'].includes(t))).toBe(true);
            expect(out).not.toMatch(/<script/i);
            expect(out).not.toMatch(/<img/i);
            expect(out).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
            expect(out).not.toMatch(/href="javascript:/i);
        }
    });

    it('a hostile stored brand URL is not rendered as a link', () => {
        for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example.com']) {
            const out = editableTextToEmailHtml('hello', { name: 'X', site: bad, siteLabel: 'click' });
            expect(out).not.toMatch(/<a /);
        }
        // A real https site still links.
        expect(editableTextToEmailHtml('hello', { name: 'X', site: 'https://example.com', siteLabel: 'site' }))
            .toMatch(/href="https:\/\/example\.com"/);
    });

    it('a double-encoded entity cannot round-trip into a tag', () => {
        const t = htmlToEditableText('&amp;lt;script&amp;gt;');
        expect(t).toBe('&lt;script&gt;');
        expect(editableTextToEmailHtml(t)).not.toMatch(/<script/i);
    });

    it('blank lines make paragraphs; single newlines make breaks', () => {
        const out = editableTextToEmailHtml('one\ntwo\n\nthree');
        expect((out.match(/<p /g) || []).length).toBe(2);
        expect((out.match(/<br \/>/g) || []).length).toBe(1);
    });

    it('the body bound is stated and enforced', () => {
        const route = code(RESPOND);
        expect(route).toContain('RESPOND_BODY_MAX = 20_000');
        expect(route).toContain('rawText.length > RESPOND_BODY_MAX');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · which inquiry is being answered', () => {
    it('the NEWEST inquiry is the authority, not array order', () => {
        const older = { received_at: '2026-01-01T00:00:00.000Z', ack_sent_at: null, ack_claimed_at: null, human_response_at: '2026-01-02T00:00:00.000Z' };
        const newer = { received_at: '2026-08-01T00:00:00.000Z', ack_sent_at: null, ack_claimed_at: null, human_response_at: null };
        // An answered OLD inquiry must not mark a newer unanswered one as handled,
        // in either array order.
        expect(resolveInquiryResponse(null, [older, newer]).state).toBe('needs_first_response');
        expect(resolveInquiryResponse(null, [newer, older]).state).toBe('needs_first_response');
    });

    it('an answered newest inquiry reports the reply, whatever came before', () => {
        const older = { received_at: '2026-01-01T00:00:00.000Z', ack_sent_at: null, ack_claimed_at: null, human_response_at: null };
        const newer = { received_at: '2026-08-01T00:00:00.000Z', ack_sent_at: null, ack_claimed_at: null, human_response_at: '2026-08-02T00:00:00.000Z' };
        expect(resolveInquiryResponse(null, [older, newer]).state).toBe('manual_response');
    });

    it('latestInquiryAt names the newest, so the card cannot cite an old one', () => {
        const a = { received_at: '2026-01-01T00:00:00.000Z' };
        const b = { received_at: '2026-08-01T00:00:00.000Z' };
        expect(resolveInquiryResponse(null, [a, b]).latestInquiryAt?.toISOString())
            .toBe('2026-08-01T00:00:00.000Z');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-REBOOK-1A · nothing about Edgar had to change', () => {
    it('the fix is presentational — no inquiry is fabricated anywhere', () => {
        for (const f of [PANEL, OPP_API, RESPOND, 'lib/growth/inquiryResponseState.ts']) {
            expect(code(f)).not.toContain('fundraiserInquiry.create');
        }
    });

    it('CustomerStatus is not used as an inquiry signal', () => {
        const st = code('lib/growth/inquiryResponseState.ts');
        expect(st).not.toContain('CustomerStatus');
        expect(st).not.toContain("'LEAD'");
    });

    it('the owner-initiated creation path is unchanged', () => {
        const opp = code(OPP_API);
        expect(opp).toContain('fundraiserOpportunity.create');
        expect(opp).not.toContain('fundraiserInquiry');
    });
});
