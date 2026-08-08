/**
 * FR-RETENTION-3 — Seasonal Update message rendering and send-readiness.
 *
 * MONEY LANGUAGE — a deliberate omission, please read before "improving" it:
 * The email states NO money figure. `FundraiserCampaign.settlement_total` is a
 * GROSS number — the closeout API freezes it from "all non-canceled orders",
 * and the coordinator UI labels it "Final campaign total". There is no verified
 * calculation anywhere in this repository for what an organization actually
 * KEPT. Leading with gross would overstate the benefit, and deriving a retained
 * figure from gross would be fabrication. So the message leads with the
 * relationship and the ease of running again, not a number.
 *
 * CTA — the send gate:
 * The durable rebooking link is Checkpoint 4 work and does not exist yet.
 * Rather than invent a temporary URL, this module exposes a structured
 * readiness check that the send endpoint consults server-side. Preview shows an
 * internal placeholder; a real send is refused until CP4 supplies a real link.
 */

import { escapeOutreachHtml } from '@/lib/outreachHtml';
import { formatCalendarRange } from '@/lib/calendarDate';

// ── CTA readiness ────────────────────────────────────────────────────────────

export interface RebookingCtaResult {
    ready: boolean;
    /** Absolute URL. Only present when ready. */
    url: string | null;
    /** Tenant-facing plain language explaining why sending is blocked. */
    blockedReason: string | null;
}

/**
 * Resolves the durable rebooking CTA for one audience.
 *
 * Checkpoint 4 will implement this against a real, secure, per-recipient
 * rebooking link. Until then it reports NOT READY, and the send endpoint
 * refuses. This is a server-side condition on purpose — a disabled button is
 * not a safety control.
 */
export function resolveRebookingCta(_batchId: string): RebookingCtaResult {
    return {
        ready: false,
        url: null,
        blockedReason: 'Rebooking link needs to be ready before this can be sent.',
    };
}

// ── Sender readiness ─────────────────────────────────────────────────────────

/**
 * The provider's shared development sender. Perfectly fine for provider
 * smoke-testing, and completely unacceptable as the visible sender of a real
 * fundraiser email — it is not the tenant's domain, it is not verified for
 * them, and it damages deliverability and trust.
 */
const FALLBACK_SENDER_ADDRESS = 'onboarding@resend.dev';

export interface SenderReadinessResult {
    ready: boolean;
    /** Plain tenant-facing language. Never names the provider or the env var. */
    blockedReason: string | null;
}

/**
 * Server-side gate: is the platform sender configured well enough to send a
 * REAL Seasonal Update?
 *
 * Refuses when the sender is unset or resolves to the provider's shared
 * development address. This is deliberately independent of the CP4 CTA gate —
 * a real fundraiser send requires BOTH.
 *
 * Test sends are intentionally NOT gated by this: sending yourself a preview
 * through the development sender is exactly what it is for.
 */
export function checkSenderReadiness(configuredFrom: string | undefined | null): SenderReadinessResult {
    const raw = (configuredFrom ?? '').trim();

    if (!raw) {
        return { ready: false, blockedReason: 'Email sending needs to be configured before this Seasonal Update can be sent.' };
    }
    // Matches both "addr" and "Name <addr>" forms.
    if (raw.toLowerCase().includes(FALLBACK_SENDER_ADDRESS)) {
        return { ready: false, blockedReason: 'Email sending needs to be configured before this Seasonal Update can be sent.' };
    }
    return { ready: true, blockedReason: null };
}

// ── Message rendering ────────────────────────────────────────────────────────

export interface SeasonalMessageInput {
    tenantName: string;
    /** Organizations this one delivery address represents. */
    organizationNames: string[];
    lineupName: string;
    lineupStartsAt: Date;
    lineupEndsAt: Date;
    /** Verified fact: has this organization run a fundraiser before? */
    hasPreviousFundraiser: boolean;
    previousCampaignName: string | null;
    cta: RebookingCtaResult;
    /** Marks the message as a test so it can never pass for a real send. */
    isTest?: boolean;
}

export interface RenderedMessage {
    subject: string;
    html: string;
    text: string;
}

// Lineup dates are CALENDAR dates, not instants. formatCalendarRange reads the
// UTC fields directly, so "Sep 1" never renders as "Aug 31" in America/Chicago
// or any other negative-offset timezone.
function formatDateRange(from: Date, to: Date): string {
    return formatCalendarRange(from, to);
}

/** "A & B", "A, B & C" — reads naturally for shared inboxes. */
function joinNames(names: string[]): string {
    if (names.length === 0) return 'your group';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

export function renderSeasonalUpdate(input: SeasonalMessageInput): RenderedMessage {
    const {
        tenantName, organizationNames, lineupName, lineupStartsAt, lineupEndsAt,
        hasPreviousFundraiser, previousCampaignName, cta, isTest,
    } = input;

    const orgs = joinNames(organizationNames);
    const window = formatDateRange(lineupStartsAt, lineupEndsAt);
    const testPrefix = isTest ? '[TEST] ' : '';

    const subject = `${testPrefix}${lineupName} fundraising is open — ${orgs}`;

    // Leads with the relationship and how little work it is. No money figure.
    const opening = hasPreviousFundraiser
        ? `It was good working with ${orgs}${previousCampaignName ? ` on ${previousCampaignName}` : ''}. We're opening up our ${lineupName} season, and we'd love to have you back.`
        : `We're opening up our ${lineupName} season, and we'd love to run a fundraiser with ${orgs}.`;

    const ease = hasPreviousFundraiser
        ? `You already know how it works — pick your bundles and your dates, and we handle the food, the packing and the paperwork.`
        : `It's straightforward — pick your bundles and your dates, and we handle the food, the packing and the paperwork.`;

    const ctaBlockHtml = cta.ready && cta.url
        ? `<a href="${escapeOutreachHtml(cta.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">Pick your dates</a>`
        // Internal preview only. The send endpoint refuses while the CTA is not
        // ready, so this string cannot reach a real coordinator.
        : `<div style="border:1px dashed #cbd5e1;border-radius:8px;padding:14px;color:#64748b;font-size:13px;">
             <strong>Rebooking link will be added before sending.</strong>
           </div>`;

    const ctaBlockText = cta.ready && cta.url
        ? `Pick your dates: ${cta.url}`
        : `[Rebooking link will be added before sending.]`;

    const testBannerHtml = isTest
        ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:12px;margin-bottom:16px;color:#92400e;font-weight:bold;">
             This is a TEST email. No coordinator received it.
           </div>`
        : '';

    const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1f2937;">
            ${testBannerHtml}
            <h1 style="color:#4f46e5;font-size:22px;margin-bottom:4px;">${escapeOutreachHtml(lineupName)} fundraising is open</h1>
            <p style="color:#6b7280;margin-top:0;font-size:14px;">${escapeOutreachHtml(window)}</p>

            <p>${escapeOutreachHtml(opening)}</p>
            <p>${escapeOutreachHtml(ease)}</p>

            <div style="background:#f3f4f6;padding:16px;border-radius:8px;margin:20px 0;">
                <p style="margin:0;font-weight:bold;">This season: ${escapeOutreachHtml(lineupName)}</p>
                <p style="margin:6px 0 0 0;font-size:14px;color:#4b5563;">
                    You'll choose which bundles your supporters can order.
                </p>
            </div>

            <div style="margin:24px 0;">${ctaBlockHtml}</div>

            <p style="font-size:13px;color:#6b7280;margin-top:28px;">
                — ${escapeOutreachHtml(tenantName)}
            </p>
        </div>
    `.trim();

    const text = [
        isTest ? 'THIS IS A TEST EMAIL. No coordinator received it.\n' : '',
        `${lineupName} fundraising is open`,
        window,
        '',
        opening,
        '',
        ease,
        '',
        `This season: ${lineupName}. You'll choose which bundles your supporters can order.`,
        '',
        ctaBlockText,
        '',
        `— ${tenantName}`,
    ].filter((l) => l !== '').join('\n');

    return { subject, html, text };
}
