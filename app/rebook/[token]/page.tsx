/**
 * FR-RETENTION-4 — /rebook/{token}
 *
 * Public and unauthenticated, in the same family as the existing
 * /coordinator/{token} and /fundraiser/{token} routes.
 *
 * Resolved on the SERVER so an expired, revoked or unknown link never ships the
 * form, the organization list, or the tenant's name to a browser that has no
 * business seeing them. The token reaches the client only for the states that
 * genuinely need to POST with it.
 *
 * NOT INDEXED: a rebooking link is a private credential, so this page is marked
 * noindex/nofollow regardless of what a crawler was handed.
 */

import type { Metadata } from 'next';
import { resolveRebookingAccess, isWritableState } from '@/lib/rebookingAccess';
import { RebookingLanding } from '@/components/rebooking/RebookingLanding';
import { RebookingExpired } from '@/components/rebooking/RebookingExpired';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Plan another fundraiser',
    robots: { index: false, follow: false },
};

/** Every terminal state shares this shell, so they look like one product. */
function Notice({ headline, body }: { headline: string; body: string }) {
    return (
        <div className="mx-auto w-full max-w-md px-5 py-16 text-center space-y-3">
            <h1 className="text-xl font-black text-slate-900 dark:text-white">{headline}</h1>
            <p className="text-sm font-bold text-slate-500">{body}</p>
        </div>
    );
}

export default async function RebookPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const { state, context } = await resolveRebookingAccess(token);

    // Unknown digest. Deliberately indistinguishable from a mistyped link — a
    // page that distinguished them would confirm which tokens exist.
    if (!context || state === 'invalid') {
        return (
            <Notice
                headline="This link isn't valid."
                body="Contact the organization that invited you for a new invitation."
            />
        );
    }

    if (state === 'revoked') {
        return (
            <Notice
                headline="This link was replaced."
                body="Check your email for the newer one."
            />
        );
    }

    // Expired with NOTHING to show. Someone who already answered keeps their
    // confirmation instead — see canUpdate below.
    if (state === 'expired') {
        return (
            <RebookingExpired
                token={token}
                businessName={context.businessName}
                alreadyRequested={Boolean(context.refreshRequestedAt)}
            />
        );
    }

    // `valid` and `already_submitted` share one component: the second opens on
    // the confirmation with "Update my request", which appends a revision rather
    // than creating a second request.
    return (
        <RebookingLanding
            canUpdate={isWritableState(state, context.expiresAt)}
            refreshRequested={Boolean(context.refreshRequestedAt)}
            token={token}
            businessName={context.businessName}
            lineupName={context.lineupName}
            familyNames={context.familyNames}
            organizations={context.organizations.map((o) => ({ id: o.customerId, name: o.organizationName }))}
            recipientDisplayName={context.recipientDisplayName}
            recipientEmailMasked={context.recipientEmailMasked}
            isSharedInbox={context.isSharedInbox}
            submission={
                context.submission
                    ? {
                        revisionNumber: context.submission.revisionNumber,
                        submittedAt: context.submission.submittedAt.toISOString(),
                        preferredStartDate: context.submission.preferredStartDate?.toISOString().slice(0, 10) ?? null,
                        alternateStartDate: context.submission.alternateStartDate?.toISOString().slice(0, 10) ?? null,
                        preferredEndDate: context.submission.preferredEndDate?.toISOString().slice(0, 10) ?? null,
                        participantEstimate: context.submission.participantEstimate,
                        notes: context.submission.notes,
                        orgs: context.submission.orgs.map((o) => ({
                            id: o.customerId,
                            name: o.organizationName,
                            selected: o.selected,
                            coordinatorIntent: o.coordinatorIntent,
                            coordinatorName: o.coordinatorName,
                            coordinatorEmail: o.coordinatorEmail,
                        })),
                    }
                    : null
            }
        />
    );
}
