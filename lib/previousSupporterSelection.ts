/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0 — what the coordinator's browser may know about each
 * previous supporter, and the selection rules it applies.
 *
 * Client-safe: no imports, no I/O. The server builds these rows; the card only
 * displays and selects them. A row carries a masked address and an opaque `ref`,
 * never the address itself, and the server re-checks every `ref` it is sent
 * against the audience it recomputes from the coordinator's own session.
 */

/** Where one previous supporter stands for THIS fundraiser's invitation. */
export type SupporterEmailStatus =
    | 'ready'          // can be emailed now
    | 'emailed'        // the email service accepted an invitation for this fundraiser
    | 'sending'        // an invitation was started and its outcome is not known
    | 'failed'         // the last attempt was refused; may be retried deliberately
    | 'opted_out'      // a durable opt-out applies (or applied when we tried to send)
    | 'no_email'       // nothing on file
    | 'invalid_email'; // something on file, but not an address we will write to

export interface SupporterRow {
    /**
     * Opaque, campaign-scoped. Null when the coordinator can do nothing with this
     * row — no usable address, opted out, or no open fundraiser to invite them to.
     */
    ref: string | null;
    name: string;
    emailMasked: string | null;
    orderCount: number;
    reachable: boolean;
    exclusionReason: string | null;
    status: SupporterEmailStatus;
    /** ISO time of the attempt that decided `status`, when there was one. */
    statusAt: string | null;
    /**
     * PREVIOUS-SUPPORTER-EMAIL-2.0A — "Open in my email": a usable address, not
     * opted out, and an open fundraiser. Independent of FreezerIQ sending.
     */
    canOpenEmail: boolean;
    /**
     * Whether FreezerIQ may email this person ITSELF, and why not. Requires recorded
     * future-email permission and the organization's mailing address on top of
     * everything "Open in my email" needs.
     */
    automated: { eligible: boolean; reason: string | null };
    /** Tickable for a FreezerIQ send: automated-eligible and not yet emailed (or failed). */
    selectable: boolean;
}

/**
 * "Select all" — the supporters who have NOT yet been emailed for this fundraiser
 * and can be. A failed row is left out on purpose: retrying is the coordinator's
 * explicit choice (its own checkbox), never a side effect of Select All.
 */
export function selectAllReady(rows: readonly SupporterRow[]): string[] {
    return rows.filter((r) => r.selectable && r.status === 'ready' && r.ref).map((r) => r.ref as string);
}

/** Toggle one row. A row that is not selectable can never enter the selection. */
export function toggleSelected(selected: readonly string[], ref: string, rows: readonly SupporterRow[]): string[] {
    if (selected.includes(ref)) return selected.filter((x) => x !== ref);
    const row = rows.find((r) => r.ref === ref);
    if (!row || !row.selectable) return [...selected];
    return [...selected, ref];
}

/** Drops anything that is no longer a selectable row (for example after a refresh). */
export function pruneSelection(selected: readonly string[], rows: readonly SupporterRow[]): string[] {
    const ok = new Set(rows.filter((r) => r.selectable && r.ref).map((r) => r.ref as string));
    return [...new Set(selected)].filter((x) => ok.has(x));
}

export interface SelectionSummary {
    selected: number;
    ready: number;
    notIncluded: { label: string; count: number }[];
}

const NOT_INCLUDED_LABELS: Partial<Record<SupporterEmailStatus, string>> = {
    emailed: 'already emailed for this fundraiser',
    sending: 'still sending from an earlier attempt',
    opted_out: 'opted out of email',
    no_email: 'no email address on file',
    invalid_email: 'no usable email address',
};

/**
 * The review line: how many are selected, how many will actually be emailed, and
 * who is not included and why. Counts only — no names, no addresses.
 */
export function summarizeSelection(selected: readonly string[], rows: readonly SupporterRow[]): SelectionSummary {
    const picked = new Set(pruneSelection(selected, rows));
    const counts = new Map<string, number>();
    for (const r of rows) {
        const label = NOT_INCLUDED_LABELS[r.status];
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return {
        selected: picked.size,
        ready: picked.size,
        notIncluded: [...counts.entries()].map(([label, count]) => ({ label, count })),
    };
}

/** Short status text for a row. "Sent" means accepted by the email service, never "delivered". */
export function supporterStatusLabel(row: Pick<SupporterRow, 'status' | 'statusAt'>): string {
    const when = row.statusAt ? shortDate(row.statusAt) : null;
    switch (row.status) {
        case 'ready': return 'Not emailed yet for this fundraiser';
        case 'emailed': return when ? `Emailed ${when}` : 'Emailed for this fundraiser';
        case 'sending': return 'Sending started — not confirmed';
        case 'failed': return "Couldn't send — select to try again";
        case 'opted_out': return 'Opted out of email';
        case 'no_email': return 'No email on file';
        case 'invalid_email': return 'Email address not usable';
        default: return '';
    }
}

function shortDate(iso: string): string | null {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The ONLY body the card ever posts to send: the two edited strings, the opaque
 * references the coordinator ticked, and the confirmation literal. No address, no
 * campaign, organization or tenant identifier — those are the server's.
 */
export function buildInviteSendBody(input: { subject: string; text: string; selected: readonly string[] }) {
    return {
        subject: input.subject.trim(),
        text: input.text,
        selected: [...new Set(input.selected)],
        confirm: 'send_individual_emails' as const,
    };
}
