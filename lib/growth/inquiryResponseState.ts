/**
 * FR-ACCEPTANCE-2A.1 — who, if anyone, has answered the newest inquiry.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 *
 * One FundraiserOpportunity holds MANY FundraiserInquiry rows. The public intake
 * appends to an organization's existing open opportunity rather than opening a
 * second one — that is what fundraiser_opportunities_one_open_per_org enforces —
 * so an organization that asks in spring and again in autumn produces two
 * inquiries hanging off one opportunity.
 *
 * That makes every "has this been answered?" question ambiguous unless it names
 * WHICH inquiry it means, and two different stale facts are waiting to give the
 * wrong answer:
 *
 *   1. The spring inquiry's ack_sent_at. An acknowledgement genuinely was sent —
 *      to a different person, about a different request, months ago. It says
 *      nothing about the autumn inquiry.
 *
 *   2. The opportunity's first_response_at. The tenant genuinely did reply — to
 *      the spring inquiry. It is a single nullable column on the opportunity, so
 *      it cannot distinguish "replied to the conversation that is open now" from
 *      "replied once, last March".
 *
 * Both would silence the CRM on a live lead that nobody has answered. So every
 * question here is asked about the NEWEST inquiry, and first_response_at only
 * counts when it is at least as recent as that inquiry.
 *
 * Nothing here is stored. Same rule as triage: a derived answer that is written
 * down becomes a second source of truth that goes stale the moment a new inquiry
 * arrives — which is the exact failure this module exists to prevent.
 */

/** The acknowledgement facts this module reads from one inquiry row. */
export interface InquiryAckFacts {
    received_at?: string | Date | null;
    /** An automatic acknowledgement attempt acquired the single-send claim. */
    ack_claimed_at?: string | Date | null;
    /** The email provider ACCEPTED the automatic acknowledgement. */
    ack_sent_at?: string | Date | null;
    /**
     * A PERSON at the tenant answered THIS inquiry.
     *
     * The authority for manual response. Only absent on rows written before
     * FR-ACCEPTANCE-2A.1, which the legacy fallback below covers without a
     * backfill.
     */
    human_response_at?: string | Date | null;
}

/**
 * What the tenant is told about the newest inquiry.
 *
 * Deliberately four states and not a boolean. "Answered" and "not answered"
 * cannot express an acknowledgement whose delivery nobody can confirm, and that
 * state is real: the provider was called and the outcome was never established.
 */
export type InquiryResponseState =
    /** A person at the tenant replied, and that reply applies to this inquiry. */
    | 'manual_response'
    /** The provider accepted an automatic acknowledgement for this inquiry. */
    | 'auto_ack_sent'
    /** An acknowledgement was claimed but acceptance was never confirmed. */
    | 'auto_ack_uncertain'
    /** Nobody and nothing has answered this inquiry. */
    | 'needs_first_response';

export interface InquiryResponseFacts {
    state: InquiryResponseState;
    /** When the newest inquiry arrived. Null when no inquiry data was supplied. */
    latestInquiryAt: Date | null;
    /** Provider acceptance for the NEWEST inquiry only. Never an older one. */
    autoAckSentAt: Date | null;
    /** Claim on the NEWEST inquiry only. */
    autoAckClaimedAt: Date | null;
    /**
     * Whether first_response_at is recent enough to be about the newest inquiry.
     * False for a real reply that predates it — the reply happened, it just does
     * not answer the question being asked.
     */
    manualResponseApplies: boolean;
    /**
     * The anchor for the follow-up clock: when contact was last made with this
     * organization about the CURRENT inquiry.
     *
     * Null means no contact has been made, which is "needs a first response" and
     * a different clock entirely (UNANSWERED_INQUIRY_HOURS on received_at).
     */
    outreachAt: Date | null;
}

function toDate(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The newest inquiry by received_at.
 *
 * Rows with an unreadable or missing received_at cannot be ordered, so they lose
 * to any row that can be. If NOTHING is orderable the first row is returned
 * rather than null: an inquiry whose timestamp is unreadable is still an
 * inquiry, and dropping it would silently under-report a waiting lead.
 */
export function latestInquiry<T extends InquiryAckFacts>(inquiries: readonly T[] | null | undefined): T | null {
    if (!inquiries || inquiries.length === 0) return null;
    let best: T | null = null;
    let bestAt: number | null = null;
    for (const inq of inquiries) {
        const at = toDate(inq.received_at)?.getTime() ?? null;
        if (best === null || (at !== null && (bestAt === null || at > bestAt))) {
            best = inq;
            bestAt = at;
        }
    }
    return best;
}

/**
 * Resolve who has answered the newest inquiry.
 *
 * `firstResponseAt` is FundraiserOpportunity.first_response_at — the human /
 * manual authority, which automatic acknowledgement never writes.
 *
 * Pure. Degrades safely: with no inquiry data it falls back to what
 * first_response_at alone can prove, which is exactly the behaviour every CRM
 * surface had before acknowledgements existed.
 */
export function resolveInquiryResponse(
    firstResponseAt: string | Date | null | undefined,
    inquiries: readonly InquiryAckFacts[] | null | undefined
): InquiryResponseFacts {
    const firstAt = toDate(firstResponseAt);
    const newest = latestInquiry(inquiries);
    const latestInquiryAt = toDate(newest?.received_at);
    const autoAckSentAt = toDate(newest?.ack_sent_at);
    const autoAckClaimedAt = toDate(newest?.ack_claimed_at);

    // ── WHO ANSWERED THE NEWEST INQUIRY ─────────────────────────────────────
    //
    // The newest inquiry's OWN human_response_at is the authority. It is written
    // per inquiry, so a reply to the autumn inquiry is recorded against the
    // autumn inquiry and nothing has to be inferred.
    //
    // An earlier draft compared first_response_at against the newest inquiry's
    // received_at instead. That could not work, and the reason is worth keeping:
    // first_response_at is WRITE-ONCE (its writer guards on
    // `if (!current.first_response_at)`), so answering a second inquiry writes
    // nothing at all. The comparison would have reported the newest inquiry as
    // unanswered forever, no matter how many times the tenant replied — and the
    // control offering to answer it would have silently done nothing.
    const perInquiryManualAt = toDate(newest?.human_response_at);

    // LEGACY FALLBACK, which is what makes this safe with no backfill.
    //
    // Rows written before this column existed carry no human_response_at, and
    // marking every previously-answered lead as unanswered would be a visible
    // regression across live data. So when NO inquiry carries the new column,
    // fall back to what the old model could prove: first_response_at, counted
    // only when it is at least as recent as the inquiry it would be answering.
    //
    // For an opportunity that has only ever had one inquiry — every legacy row
    // in practice — that is exactly right. For one with a newer unanswered
    // inquiry it correctly declines to answer, which is the defect being fixed.
    const anyPerInquiryData = (inquiries ?? []).some((i) => toDate(i.human_response_at) !== null);
    const legacyManualApplies =
        !anyPerInquiryData
        && firstAt !== null
        && (latestInquiryAt === null || firstAt.getTime() >= latestInquiryAt.getTime());

    const manualAt = perInquiryManualAt ?? (legacyManualApplies ? firstAt : null);
    const manualResponseApplies = manualAt !== null;

    if (manualResponseApplies) {
        // A person answering outranks a machine acknowledging, even when both
        // happened. The acknowledgement is still reported alongside; it just is
        // not what the tenant most needs to know.
        return {
            state: 'manual_response',
            latestInquiryAt,
            autoAckSentAt,
            autoAckClaimedAt,
            manualResponseApplies,
            outreachAt: manualAt,
        };
    }

    if (autoAckSentAt) {
        return {
            state: 'auto_ack_sent',
            latestInquiryAt,
            autoAckSentAt,
            autoAckClaimedAt,
            manualResponseApplies,
            outreachAt: autoAckSentAt,
        };
    }

    if (autoAckClaimedAt) {
        // Claimed but never confirmed. NOT treated as outreach: we cannot say
        // anything reached this person, so the follow-up clock must not start and
        // the tenant must not be told an acknowledgement went out.
        return {
            state: 'auto_ack_uncertain',
            latestInquiryAt,
            autoAckSentAt,
            autoAckClaimedAt,
            manualResponseApplies,
            outreachAt: null,
        };
    }

    return {
        state: 'needs_first_response',
        latestInquiryAt,
        autoAckSentAt,
        autoAckClaimedAt,
        manualResponseApplies,
        outreachAt: null,
    };
}
