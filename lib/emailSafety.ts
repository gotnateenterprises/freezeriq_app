/**
 * PREVIEW-DB-ISOLATION-1 — the only way FreezerIQ constructs a Resend client.
 *
 * Vercel Preview uses the SAME Resend account (and key) as Production. Its
 * database no longer holds real people, but a tester can still type a real
 * address, and a Preview build must never be the thing that mails a customer
 * or a coordinator. So on a Preview (or unrecognised) deployment every send is
 * rewritten before it leaves the process:
 *
 *   to      → the Resend test sink only (accepted, "delivered", reaches no one)
 *   cc/bcc  → removed
 *   subject → prefixed "[PREVIEW to: <intended recipients>]", so the send can
 *             still be inspected in the Resend dashboard
 *
 * Production and local development get the client exactly as `new Resend(key)`
 * built it — this module adds nothing on those tiers. The tier comes from
 * lib/deploymentTier.ts, never from the request.
 */
import { Resend } from 'resend';
import { deploymentTier, isPreviewSafetyTier } from '@/lib/deploymentTier';

/** Resend's own test recipient: every send to it succeeds and is delivered nowhere. */
export const PREVIEW_EMAIL_SINK = 'delivered@resend.dev';

/** How many intended recipients the Preview subject names before summarising. */
const SUBJECT_RECIPIENT_LIMIT = 3;

type RecipientField = string | string[] | null | undefined;

interface EmailPayload {
    to?: RecipientField;
    cc?: RecipientField;
    bcc?: RecipientField;
    subject?: string;
}

function recipients(field: RecipientField): string[] {
    if (!field) return [];
    return (Array.isArray(field) ? field : [field])
        .filter((r): r is string => typeof r === 'string')
        .map((r) => r.trim())
        .filter(Boolean);
}

/** "[PREVIEW to: a@x.com, b@y.com +2 more] Original subject" */
export function previewSubject(subject: string, intended: string[]): string {
    const named = intended.slice(0, SUBJECT_RECIPIENT_LIMIT).join(', ');
    const more = intended.length > SUBJECT_RECIPIENT_LIMIT ? ` +${intended.length - SUBJECT_RECIPIENT_LIMIT} more` : '';
    const tag = intended.length > 0 ? `[PREVIEW to: ${named}${more}]` : '[PREVIEW]';
    return `${tag} ${subject}`;
}

// Payloads this module produced. Resend's `send` delegates to `create`, and both
// are wrapped, so the rewrite must recognise its own output and not apply twice.
const redirected = new WeakSet<object>();

/**
 * The Preview rewrite of ONE email payload. Pure apart from the idempotency
 * mark; everything not listed above (from, replyTo, html, attachments, ...)
 * is passed through untouched.
 */
export function applyPreviewEmailPolicy<T extends EmailPayload>(payload: T): T {
    if (!payload || typeof payload !== 'object' || redirected.has(payload)) return payload;
    const intended = [...recipients(payload.to), ...recipients(payload.cc), ...recipients(payload.bcc)];
    const next = {
        ...payload,
        to: [PREVIEW_EMAIL_SINK],
        cc: undefined,
        bcc: undefined,
        ...(typeof payload.subject === 'string' ? { subject: previewSubject(payload.subject, intended) } : {}),
    } as T;
    redirected.add(next);
    // Count only — the intended addresses are never written to a log.
    console.info(`[PREVIEW-EMAIL] redirected ${intended.length} recipient(s) to the Resend test sink`);
    return next;
}

function wrapSends(target: any, transform: (payload: any) => any): void {
    if (!target) return;
    for (const method of ['send', 'create']) {
        const original = target[method];
        if (typeof original !== 'function') continue;
        target[method] = (payload: any, ...rest: any[]) => original.call(target, transform(payload), ...rest);
    }
}

/**
 * Use instead of `new Resend(apiKey)`. Same argument, same return type, same
 * behaviour on Production and local development.
 */
export function createResendClient(apiKey?: string, env: NodeJS.ProcessEnv = process.env): Resend {
    const client = new Resend(apiKey);
    if (!isPreviewSafetyTier(deploymentTier(env))) return client;

    wrapSends((client as any).emails, applyPreviewEmailPolicy);
    wrapSends((client as any).batch, (list: unknown) =>
        Array.isArray(list) ? list.map((p) => applyPreviewEmailPolicy(p)) : list
    );
    return client;
}
