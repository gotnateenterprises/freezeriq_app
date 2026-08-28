'use client';

/**
 * FR-COORD-123 — "GET YOUR FUNDRAISER GOING · Easy as 1-2-3".
 *
 * One compact card at the top of the coordinator dashboard:
 *
 *   1. Set Up Your Fundraiser   — durable: bundle_selection_status confirmed
 *   2. Share Your Fundraiser    — durable: a share-classified action event
 *   3. Get Your First Order     — durable: one non-canceled current-campaign order
 *
 * This is presentational only. Every state arrives as a prop derived from
 * server truth (lib/coordinatorLaunch.deriveLaunchSteps), and every share
 * button calls back into the portal, which performs the action AND records the
 * durable CoordinatorActionEvent. Nothing here can mark a step complete.
 *
 * The old-portal ancestry, restored rather than reinvented: the pre-redesign
 * panel's "Step 1 / Step 2 / Step 3" ladder (git d806ad5~1) and SetupChecklist's
 * "3 steps and you're live" are folded into this one card, with completion now
 * anchored to durable state instead of ephemeral nudges.
 */

export interface LaunchStepsProps {
    setupComplete: boolean;
    sharingStarted: boolean;
    firstOrderReceived: boolean;
    /** Quiet Step-1 tip when setup is done but payment info is missing. */
    hasPaymentInfo: boolean;
    onSetPayment: () => void;
    /** Share actions — the portal performs + records each one. */
    onShareEmail: () => void;
    onShareFacebook: () => void;
    onShareText: () => void;
    onCopyLink: () => void;
    /** Native Web Share — only rendered when the device supports it. */
    onShareNative?: () => void;
    copied: boolean;
    /** FR-REBOOK-2 integration: reachable previous-supporter audience size. */
    previousSupportersReachable: number;
    onPreviousSupporters: () => void;
    /** Step 3: opens the existing Add Offline Order modal. Never completes the step. */
    onEnterOrder: () => void;
    orderingAllowed: boolean;
    /** "What happens during your fundraiser?" truths. */
    notifyEmail: string | null;
    coordinatorFirstName?: string;
}

export function LaunchSteps(props: LaunchStepsProps) {
    const {
        setupComplete, sharingStarted, firstOrderReceived,
        hasPaymentInfo, onSetPayment,
        onShareEmail, onShareFacebook, onShareText, onCopyLink, onShareNative, copied,
        previousSupportersReachable, onPreviousSupporters,
        onEnterOrder, orderingAllowed,
        notifyEmail, coordinatorFirstName,
    } = props;

    const allComplete = setupComplete && sharingStarted && firstOrderReceived;
    const currentStep = !setupComplete ? 1 : !sharingStarted ? 2 : !firstOrderReceived ? 3 : null;

    // FR-ACCEPTANCE-MOBILE-POLISH-1. All three steps done used to collapse
    // this card to a bare checklist line — "keep sharing!" with no way left
    // on the card to actually do that. The share tools are exactly the
    // "Help us keep the momentum going" block the owner wants available on
    // the ONGOING coordinator panel, reusing the identical ShareBtn/handlers
    // Step 2 already used above — not a second, duplicate implementation.
    // The campaign is still active for as long as this component renders at
    // all (app/coordinator/portal/page.tsx only mounts it while
    // campaignPhase !== 'complete'), so there is no reason sharing tools
    // should ever become unreachable before then.
    if (allComplete) {
        return (
            <section data-testid="launch-steps" className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
                <div>
                    <p className="text-sm font-black text-emerald-700">
                        ✓ Setup · ✓ Sharing started · ✓ First order received
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">Help us keep the momentum going — share it again anytime.</p>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <ShareBtn label="✉️ Email" onClick={onShareEmail} />
                    <ShareBtn label="📘 Facebook" onClick={onShareFacebook} />
                    <ShareBtn label="💬 Text" onClick={onShareText} />
                    <ShareBtn label={copied ? '✓ Copied' : '🔗 Copy Link'} onClick={onCopyLink} />
                </div>
                {onShareNative && (
                    <button onClick={onShareNative}
                        className="w-full rounded-xl bg-indigo-600 py-2.5 text-[13px] font-bold text-white">
                        Share…
                    </button>
                )}
                {previousSupportersReachable > 0 && (
                    <button onClick={onPreviousSupporters}
                        className="w-full rounded-xl border border-indigo-200 bg-indigo-50 py-2.5 text-[13px] font-bold text-indigo-700">
                        💌 Invite {previousSupportersReachable} previous supporter{previousSupportersReachable === 1 ? '' : 's'}
                    </button>
                )}

                <WhatHappens notifyEmail={notifyEmail} />
            </section>
        );
    }

    return (
        <section data-testid="launch-steps" className="bg-white border border-slate-200 rounded-2xl p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-indigo-500">Get your fundraiser going</p>
            <h2 className="text-lg font-black text-slate-900">
                {coordinatorFirstName ? `${coordinatorFirstName}, it's ` : "It's "}easy as 1-2-3
            </h2>

            <div className="mt-2 divide-y divide-slate-100">
                {/* ── STEP 1 ── */}
                <StepRow
                    n={1}
                    done={setupComplete}
                    active={currentStep === 1}
                    title={setupComplete ? 'Fundraiser setup complete' : 'Set Up Your Fundraiser'}
                >
                    {setupComplete && !hasPaymentInfo && (
                        <p className="text-xs text-slate-500">
                            Tip: tell supporters how to pay you — Venmo, checks, cash.{' '}
                            <button onClick={onSetPayment} className="font-bold text-indigo-600 underline underline-offset-2">
                                Add payment info
                            </button>
                        </p>
                    )}
                </StepRow>

                {/* ── STEP 2 ── */}
                <StepRow
                    n={2}
                    done={sharingStarted}
                    active={currentStep === 2}
                    title={sharingStarted ? 'Sharing started' : 'Share Your Fundraiser'}
                >
                    {sharingStarted && <p className="text-xs text-slate-500">Great start — keep sharing!</p>}
                    {/* Share actions stay usable after "Sharing started" — one
                        share is a start, not a finish. */}
                    <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <ShareBtn label="✉️ Email" onClick={onShareEmail} />
                        <ShareBtn label="📘 Facebook" onClick={onShareFacebook} />
                        <ShareBtn label="💬 Text" onClick={onShareText} />
                        <ShareBtn label={copied ? '✓ Copied' : '🔗 Copy Link'} onClick={onCopyLink} />
                    </div>
                    {onShareNative && (
                        <button onClick={onShareNative}
                            className="mt-2 w-full rounded-xl bg-indigo-600 py-2.5 text-[13px] font-bold text-white">
                            Share…
                        </button>
                    )}
                    {previousSupportersReachable > 0 && (
                        <button onClick={onPreviousSupporters}
                            className="mt-2 w-full rounded-xl border border-indigo-200 bg-indigo-50 py-2.5 text-[13px] font-bold text-indigo-700">
                            💌 Invite {previousSupportersReachable} previous supporter{previousSupportersReachable === 1 ? '' : 's'}
                        </button>
                    )}
                </StepRow>

                {/* ── STEP 3 ── */}
                <StepRow
                    n={3}
                    done={firstOrderReceived}
                    active={currentStep === 3}
                    title={firstOrderReceived ? 'First order received' : 'Get Your First Order'}
                >
                    {firstOrderReceived
                        ? <p className="text-xs text-slate-500">Great start — keep sharing!</p>
                        : (
                            <>
                                <p className="text-xs text-slate-500">Get your first order in and get things rolling.</p>
                                {orderingAllowed && (
                                    <button onClick={onEnterOrder}
                                        className="mt-1.5 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700">
                                        Enter an order
                                    </button>
                                )}
                            </>
                        )}
                </StepRow>
            </div>

            <WhatHappens notifyEmail={notifyEmail} />
        </section>
    );
}

function StepRow({ n, done, active, title, children }: {
    n: number; done: boolean; active: boolean; title: string; children?: React.ReactNode;
}) {
    return (
        <div className={`py-2.5 ${!done && !active ? 'opacity-55' : ''}`}>
            <div className="flex items-start gap-3">
                <span className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-extrabold ${
                    done ? 'bg-emerald-100 text-emerald-700'
                        : active ? 'bg-indigo-600 text-white'
                            : 'bg-slate-100 text-slate-500'
                }`}>
                    {done ? '✓' : n}
                </span>
                <div className="min-w-0 flex-1">
                    <p className={`text-sm font-bold ${done ? 'text-emerald-700' : 'text-slate-900'}`}>
                        {done ? `✓ ${title}` : `${n}. ${title}`}
                    </p>
                    {children}
                </div>
            </div>
        </div>
    );
}

function ShareBtn({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button onClick={onClick}
            className="rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-center text-xs font-semibold text-slate-700">
            {label}
        </button>
    );
}

/**
 * "What happens during your fundraiser?" — small, collapsed by default, and
 * every sentence matches proven behavior:
 *
 *  - the per-order email really goes to the org's Customer.contact_email
 *    (lib/email.ts sendFundraiserCoordinatorNotification), so the copy names
 *    that address when it exists and makes no email promise when it doesn't;
 *  - the tracker refreshes on a ~30-second poll (the portal's polling effect),
 *    so "updates as orders come in" is claimed at exactly that strength;
 *  - pickup-day guidance is the same order list, no new subsystem.
 */
function WhatHappens({ notifyEmail }: { notifyEmail: string | null }) {
    return (
        <details className="mt-3 rounded-xl bg-slate-50 px-3 py-2">
            <summary className="cursor-pointer text-xs font-bold text-slate-600">
                What happens during your fundraiser?
            </summary>
            <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-600">
                <p>We&apos;ll help you stay on top of every order.</p>
                {notifyEmail ? (
                    <p>
                        When an online order comes in, we&apos;ll email <strong>{notifyEmail}</strong> with
                        the supporter&apos;s contact information, what they ordered, and what is
                        still owed — so you know who to follow up with.
                    </p>
                ) : (
                    <p>
                        Every online order appears in your order list below. Ask your organizer to add a
                        contact email for your group if you&apos;d also like each order emailed to you.
                    </p>
                )}
                <p>Your order tracker updates as orders come in — it refreshes about every 30 seconds.</p>
                <p>
                    When ordering closes, that same list — every supporter and what they
                    paid — is your pickup-day checklist. For the full breakdown, download
                    the pickup sheet.
                </p>
            </div>
        </details>
    );
}

export default LaunchSteps;
