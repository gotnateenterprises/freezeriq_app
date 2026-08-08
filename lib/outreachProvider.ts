/**
 * FR-RETENTION-3 — email provider abstraction for Seasonal Updates.
 *
 * Wraps the SAME provider the rest of FreezerIQ already uses (Resend, via
 * lib/email.ts) rather than introducing a second one. The only reason this
 * exists is that lib/email.sendEmail() returns a boolean and discards the
 * provider's message id — and CP3 needs that id for delivery tracking.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS HONESTY — read before extending
 *
 * Resend returns an id when it ACCEPTS a message for delivery. That is not
 * proof of delivery. This repository has no Resend webhook handler, so nothing
 * downstream may claim `delivered`, `opened`, `clicked`, or `bounced`.
 *
 * The honest ceiling here is `accepted`, and that is what this module reports.
 * If webhook ingestion is added later, EmailProviderEvent is where the real
 * delivery evidence belongs — not here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DeliveryFailureCategory } from '@prisma/client';

export interface ProviderSendInput {
    to: string;
    subject: string;
    html: string;
    text: string;
    from: string;
    replyTo?: string;
}

export type ProviderSendResult =
    | {
        outcome: 'accepted';
        /** Resend's message id. Proves acceptance only. */
        providerMessageId: string | null;
    }
    | {
        outcome: 'failed';
        category: DeliveryFailureCategory;
        /** Sanitized, tenant-safe. Never a raw provider payload or stack trace. */
        detail: string;
    };

export interface OutreachEmailProvider {
    send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

/**
 * Maps a provider error to a category plus tenant-safe wording.
 *
 * Tenants see plain language; the raw provider message is logged server-side
 * only. Showing an SMTP/API error verbatim would leak provider internals and
 * mean nothing to the person reading it.
 */
export function classifyProviderError(err: unknown): { category: DeliveryFailureCategory; detail: string } {
    const raw = (() => {
        if (!err) return '';
        if (typeof err === 'string') return err;
        if (typeof err === 'object') {
            const e = err as { message?: unknown; name?: unknown };
            return String(e.message ?? e.name ?? '');
        }
        return String(err);
    })().toLowerCase();

    if (/invalid.*(email|recipient|address)|not a valid email/.test(raw)) {
        return { category: 'invalid_address', detail: "That email address wasn't accepted." };
    }
    if (/api[_ -]?key|unauthor|forbidden|401|403/.test(raw)) {
        return { category: 'provider_auth', detail: 'Email sending is not configured correctly. Check the email settings.' };
    }
    if (/rate.?limit|429|timeout|econn|socket|network|temporar|503|502/.test(raw)) {
        return { category: 'transient_transport', detail: 'The email service was temporarily unavailable. You can try this one again.' };
    }
    if (/reject|blocked|suppress|bounce/.test(raw)) {
        return { category: 'provider_rejected_recipient', detail: 'The email service refused this address.' };
    }
    return { category: 'unknown', detail: "The email couldn't be sent." };
}

/** Live provider, backed by Resend — the same account the rest of the app uses. */
export class ResendOutreachProvider implements OutreachEmailProvider {
    async send(input: ProviderSendInput): Promise<ProviderSendResult> {
        if (!process.env.RESEND_API_KEY) {
            return {
                outcome: 'failed',
                category: 'provider_auth',
                detail: 'Email sending is not configured. Add an email API key before sending.',
            };
        }

        try {
            const { Resend } = await import('resend');
            const resend = new Resend(process.env.RESEND_API_KEY);

            const { data, error } = await resend.emails.send({
                from: input.from,
                to: [input.to],
                replyTo: input.replyTo,
                subject: input.subject,
                html: input.html,
                text: input.text,
            });

            if (error) {
                // Raw provider error stays server-side.
                console.error('[Outreach provider] send error:', error);
                const { category, detail } = classifyProviderError(error);
                return { outcome: 'failed', category, detail };
            }

            // An id means ACCEPTED, not delivered. Naming is deliberate.
            return { outcome: 'accepted', providerMessageId: data?.id ?? null };
        } catch (e) {
            console.error('[Outreach provider] send exception:', e);
            const { category, detail } = classifyProviderError(e);
            return { outcome: 'failed', category, detail };
        }
    }
}

/**
 * Test double for the send engine. Records calls instead of contacting the
 * provider, so idempotency and concurrency can be proven without emailing
 * anyone.
 */
export class RecordingOutreachProvider implements OutreachEmailProvider {
    public readonly calls: ProviderSendInput[] = [];
    constructor(private readonly behavior: (input: ProviderSendInput, index: number) => ProviderSendResult = () => ({
        outcome: 'accepted',
        providerMessageId: 'test-message-id',
    })) { }

    async send(input: ProviderSendInput): Promise<ProviderSendResult> {
        const index = this.calls.length;
        this.calls.push(input);
        return this.behavior(input, index);
    }
}
