/**
 * COORDINATOR-EMAIL-REOPEN-1 — what the persistent "Coordinator setup email" card says and offers.
 *
 * The launch dialog was the only place a tenant could review and send a coordinator's setup
 * invitation. Once it closed, there was no way back: a fundraiser launched without a pickup time
 * could have the time added through Edit details, but the Review & send step that time unblocked
 * was gone. This module is the reading half of the card that brings it back on the Campaign
 * Context drawer.
 *
 * IT DECIDES NOTHING ABOUT SENDING. The one-invitation rule lives in
 * app/api/campaigns/[id]/coordinator-email/route.ts — a conditional claim in a WHERE clause, a
 * held claim when the outcome is unknown, and `setup_email_sent_at` written only on provider
 * acceptance. This file only translates that route's answers into words and into which buttons
 * the card shows. Hiding Send here is courtesy; the route's refusal is the guarantee.
 *
 * Pure and dependency-free so the card's behaviour can be tested without a DOM.
 */

/** The three durable states the route's GET names (`state`). */
export type CoordinatorEmailState = 'ready' | 'sent' | 'unresolved';

export interface CoordinatorEmailPreview {
    to: string;
    subject: string;
    html: string;
}

export type CoordinatorEmailStatus =
    | { kind: 'loading' }
    /** Never sent and never claimed: the tenant may review and send. */
    | { kind: 'ready'; preview: CoordinatorEmailPreview }
    /** The provider accepted the invitation at `sentAt`. */
    | { kind: 'sent'; sentAt: string | null; preview: CoordinatorEmailPreview | null }
    /** An attempt claimed the send and its outcome was never confirmed. */
    | { kind: 'unresolved'; claimedAt: string | null; preview: CoordinatorEmailPreview | null }
    /**
     * The route refused to prepare the invitation for a stated reason (no pickup time, no
     * coordinator, no coordinator email, no access link…). `message` is the route's own words.
     * `knownSentAt` is the list payload's provider-confirmed timestamp, so a fundraiser whose
     * invitation already went out still says so even if it is not currently "ready".
     */
    | { kind: 'blocked'; message: string; knownSentAt: string | null }
    | { kind: 'error'; message: string };

export const CHECK_FAILED_MESSAGE = "Couldn't check the coordinator email. Try again.";
export const ONE_INVITATION_NOTE =
    'FreezerIQ sends one setup email per coordinator. If they never received it, use Copy Setup Link '
    + 'rather than sending a second link.';
export const UNRESOLVED_NOTE =
    'FreezerIQ will not send again automatically, because a second email could hand the coordinator '
    + 'a duplicate link. Check with the coordinator — if they never received it, use Copy Setup Link.';

const iso = (v: unknown): string | null => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const previewOf = (body: any): CoordinatorEmailPreview | null =>
    body && typeof body.to === 'string' && typeof body.subject === 'string' && typeof body.html === 'string'
        ? { to: body.to, subject: body.subject, html: body.html }
        : null;

/**
 * Read GET /api/campaigns/[id]/coordinator-email.
 *
 * `sent` and `unresolved` are taken from the timestamps the route returns, in the same order the
 * route names them (sent outranks a claim), so the card can never call a claimed-but-unconfirmed
 * attempt "sent".
 */
export function statusFromPreviewResponse(
    httpOk: boolean,
    httpStatus: number,
    body: any,
    knownSentAt: string | null = null,
): CoordinatorEmailStatus {
    if (httpOk) {
        const preview = previewOf(body);
        const sentAt = iso(body?.alreadySentAt);
        const claimedAt = iso(body?.claimedAt);
        if (body?.state === 'sent' || sentAt) return { kind: 'sent', sentAt, preview };
        if (body?.state === 'unresolved' || claimedAt) return { kind: 'unresolved', claimedAt, preview };
        if (!preview) return { kind: 'error', message: CHECK_FAILED_MESSAGE };
        return { kind: 'ready', preview };
    }
    // 404 / 409 are the route's stated refusals ("Set a delivery/pickup time…", "no primary
    // coordinator", "no email address on file"). Shown verbatim — they say what to fix.
    if ((httpStatus === 409 || httpStatus === 404) && typeof body?.error === 'string' && body.error.trim()) {
        return { kind: 'blocked', message: body.error, knownSentAt: iso(knownSentAt) };
    }
    if (httpStatus === 401) {
        return { kind: 'error', message: 'Your session has ended. Sign in again to manage this fundraiser.' };
    }
    return { kind: 'error', message: CHECK_FAILED_MESSAGE };
}

export type SendOutcomeKind =
    | 'sent'
    | 'sent_unrecorded'
    | 'already_sent'
    | 'unresolved'
    | 'uncertain'
    | 'mocked'
    | 'blocked'
    | 'failed';

export interface SendOutcome {
    kind: SendOutcomeKind;
    /** The card's next status, or null to leave it as it was (the tenant may retry). */
    next: CoordinatorEmailStatus | null;
    toast: { level: 'success' | 'info' | 'warning' | 'error' | 'message'; title: string; description?: string };
}

/**
 * Read POST /api/campaigns/[id]/coordinator-email. Mirrors the launch dialog's truth rules: only a
 * genuine provider acceptance reads as sent, safety mode records nothing, and every "we do not
 * know" answer becomes `unresolved`, which offers no Send button.
 */
export function outcomeFromSendResponse(
    httpOk: boolean,
    httpStatus: number,
    body: any,
    now: Date = new Date(),
): SendOutcome {
    if (!httpOk) {
        if (body?.alreadySent) {
            return {
                kind: 'already_sent',
                next: { kind: 'sent', sentAt: iso(body.sentAt), preview: null },
                toast: { level: 'info', title: 'That invitation has already been sent.', description: 'Use Copy Setup Link if the coordinator never received it.' },
            };
        }
        if (body?.unresolved) {
            return {
                kind: 'unresolved',
                next: { kind: 'unresolved', claimedAt: iso(body.claimedAt), preview: null },
                toast: { level: 'warning', title: 'Delivery status unresolved', description: UNRESOLVED_NOTE },
            };
        }
        if (body?.uncertain) {
            return {
                kind: 'uncertain',
                next: { kind: 'unresolved', claimedAt: now.toISOString(), preview: null },
                toast: { level: 'warning', title: 'Could not confirm that send', description: typeof body.error === 'string' ? body.error : UNRESOLVED_NOTE },
            };
        }
        if ((httpStatus === 409 || httpStatus === 404) && typeof body?.error === 'string' && body.error.trim()) {
            return {
                kind: 'blocked',
                next: { kind: 'blocked', message: body.error, knownSentAt: null },
                toast: { level: 'error', title: body.error },
            };
        }
        // An explicit provider rejection (the route released its claim) or any other failure:
        // nothing was recorded as sent, so the tenant may genuinely try again.
        return {
            kind: 'failed',
            next: null,
            toast: { level: 'error', title: typeof body?.error === 'string' && body.error ? body.error : "We couldn't send that email. Please try again." },
        };
    }
    if (body?.mocked) {
        return {
            kind: 'mocked',
            next: null,
            toast: { level: 'message', title: 'No email was sent — sending is switched off for this environment.', description: 'The coordinator has not been contacted. Use Copy Setup Link instead.' },
        };
    }
    if (body?.recorded === false) {
        return {
            kind: 'sent_unrecorded',
            next: { kind: 'unresolved', claimedAt: now.toISOString(), preview: null },
            toast: {
                level: 'warning',
                title: 'Sent — but not recorded',
                description: 'The coordinator has the setup email. FreezerIQ could not save that it was sent, so it will show as unconfirmed. Do not send it again.',
            },
        };
    }
    return {
        kind: 'sent',
        next: { kind: 'sent', sentAt: now.toISOString(), preview: null },
        toast: { level: 'success', title: 'Setup email sent to the coordinator.' },
    };
}

/** "Nov 18, 2026, 4:05 PM" in the viewer's own zone; null for a missing or invalid value. */
export function formatEmailTimestamp(value: string | null | undefined, timeZone?: string): string | null {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
        ...(timeZone ? { timeZone } : {}),
    });
}

export interface CoordinatorEmailCardView {
    tone: 'neutral' | 'success' | 'warning' | 'error';
    headline: string;
    detail: string | null;
    /** Open the review dialog (a GET; writes nothing). */
    canReview: boolean;
    /** Show "Send Coordinator Email" in the review dialog. Only ever true for `ready`. */
    canSend: boolean;
    /** Offer Copy Setup Link (the card also needs the campaign's access token to show it). */
    canCopyLink: boolean;
    /** Offer "Check again" (re-runs the GET). */
    canRecheck: boolean;
}

export function coordinatorEmailCardView(status: CoordinatorEmailStatus, timeZone?: string): CoordinatorEmailCardView {
    switch (status.kind) {
        case 'loading':
            return { tone: 'neutral', headline: 'Checking the coordinator email…', detail: null, canReview: false, canSend: false, canCopyLink: false, canRecheck: false };
        case 'ready':
            return {
                tone: 'neutral',
                headline: 'Coordinator setup email not sent yet',
                detail: `Review the email, then send it to ${status.preview.to}. Nothing is sent until you press Send.`,
                canReview: true, canSend: true, canCopyLink: true, canRecheck: false,
            };
        case 'sent': {
            const when = formatEmailTimestamp(status.sentAt, timeZone);
            return {
                tone: 'success',
                headline: when ? `Coordinator setup email sent ${when}` : 'Coordinator setup email sent',
                detail: ONE_INVITATION_NOTE,
                canReview: true, canSend: false, canCopyLink: true, canRecheck: false,
            };
        }
        case 'unresolved': {
            const when = formatEmailTimestamp(status.claimedAt, timeZone);
            return {
                tone: 'warning',
                headline: 'Delivery status unresolved',
                detail: `An earlier send attempt${when ? ` (started ${when})` : ''} could not be confirmed. ${UNRESOLVED_NOTE}`,
                canReview: true, canSend: false, canCopyLink: true, canRecheck: false,
            };
        }
        case 'blocked': {
            const when = formatEmailTimestamp(status.knownSentAt, timeZone);
            if (status.knownSentAt) {
                return {
                    tone: 'success',
                    headline: when ? `Coordinator setup email sent ${when}` : 'Coordinator setup email sent',
                    detail: `${status.message} ${ONE_INVITATION_NOTE}`,
                    canReview: false, canSend: false, canCopyLink: true, canRecheck: true,
                };
            }
            return {
                tone: 'warning',
                headline: 'Not ready to send yet',
                detail: status.message,
                canReview: false, canSend: false, canCopyLink: false, canRecheck: true,
            };
        }
        case 'error':
            return { tone: 'error', headline: "Couldn't check the coordinator email", detail: status.message, canReview: false, canSend: false, canCopyLink: false, canRecheck: true };
    }
}
