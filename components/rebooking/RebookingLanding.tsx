"use client";

/**
 * FR-RETENTION-4 — the public rebooking page (Screens 8, 9 and 10).
 * Visual source of truth: docs/ai/prototypes/fr_retention_prototype.html.
 *
 * WHO IS READING THIS: whoever received one email. We do not know that they are
 * the coordinator, and for a shared inbox we do not even know which person they
 * are. So the page asks, per organization, rather than assuming — "helping with
 * rebooking is not volunteering to run it".
 *
 * WHAT IT NEVER CLAIMS: that anything is booked. Every path ends on "Nothing is
 * booked until {tenant} confirms your dates", because that is the truth and the
 * alternative is a volunteer telling their board they have a fundraiser.
 *
 * CONTACT CORRECTIONS: the current values are shown MASKED and read-only, with
 * separate empty fields for a correction. Prefilling an editable box with
 * "r•••@grovemail.org" would save that mask as if it were an address the moment
 * anyone submitted without clearing it.
 */

import { useMemo, useState } from 'react';
import { Check, Loader2, AlertCircle, WifiOff, Pencil } from 'lucide-react';

type Intent = 'yes' | 'no' | 'not_sure';

export interface RebookingOrg {
    id: string;
    name: string;
}

export interface RebookingSubmittedOrg {
    id: string;
    name: string;
    selected: boolean;
    coordinatorIntent: Intent;
    coordinatorName: string | null;
    coordinatorEmail: string | null;
}

export interface RebookingSubmissionView {
    revisionNumber: number;
    submittedAt: string;
    preferredStartDate: string | null;
    alternateStartDate: string | null;
    preferredEndDate: string | null;
    participantEstimate: number | null;
    notes: string | null;
    orgs: RebookingSubmittedOrg[];
}

export interface RebookingLandingProps {
    token: string;
    businessName: string;
    lineupName: string;
    familyNames: string[];
    organizations: RebookingOrg[];
    recipientDisplayName: string;
    recipientEmailMasked: string | null;
    isSharedInbox: boolean;
    submission: RebookingSubmissionView | null;
    /**
     * False when the link has expired. A respondent who already answered still
     * gets to SEE what they asked for — losing that would be worse — but the
     * "Update my request" button is replaced by the honest explanation, rather
     * than offered and then refused by the server.
     */
    canUpdate: boolean;
    refreshRequested: boolean;
}

interface OrgAnswer {
    selected: boolean;
    intent: Intent;
    coordinatorName: string;
    coordinatorEmail: string;
}

const FIELD =
    'w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
    'text-sm font-bold text-slate-900 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600 ' +
    'focus:outline-none focus:ring-2 focus:ring-indigo-500';

const LABEL = 'block text-[11px] font-black uppercase tracking-wide text-slate-500 mb-1.5';

/** Renders a stored yyyy-mm-dd without letting a timezone move it a day. */
function prettyDate(value: string | null): string {
    if (!value) return '—';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return value;
    const d = new Date(`${value}T00:00:00.000Z`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function RebookingLanding(props: RebookingLandingProps) {
    const {
        token, businessName, lineupName, familyNames, organizations,
        recipientDisplayName, recipientEmailMasked, isSharedInbox, submission,
        canUpdate, refreshRequested,
    } = props;

    const [refreshState, setRefreshState] = useState<'idle' | 'sending' | 'done' | 'error'>(
        refreshRequested ? 'done' : 'idle',
    );

    const requestFreshLink = async () => {
        setRefreshState('sending');
        try {
            const res = await fetch(`/api/rebook/${encodeURIComponent(token)}/refresh`, { method: 'POST' });
            setRefreshState(res.ok ? 'done' : 'error');
        } catch {
            setRefreshState('error');
        }
    };

    // An existing submission opens on the confirmation, exactly as the approved
    // flow does — you see what you asked for before you can change it.
    const [mode, setMode] = useState<'form' | 'confirmed'>(submission ? 'confirmed' : 'form');
    const [result, setResult] = useState<RebookingSubmissionView | null>(submission);

    const [answers, setAnswers] = useState<Record<string, OrgAnswer>>(() => {
        const seed: Record<string, OrgAnswer> = {};
        for (const org of organizations) {
            const prior = submission?.orgs.find((o) => o.id === org.id);
            seed[org.id] = {
                selected: prior?.selected ?? false,
                intent: prior?.coordinatorIntent ?? 'not_sure',
                coordinatorName: prior?.coordinatorName ?? '',
                coordinatorEmail: prior?.coordinatorEmail ?? '',
            };
        }
        return seed;
    });

    const [preferredStart, setPreferredStart] = useState(submission?.preferredStartDate ?? '');
    const [alternateStart, setAlternateStart] = useState(submission?.alternateStartDate ?? '');
    const [preferredEnd, setPreferredEnd] = useState(submission?.preferredEndDate ?? '');
    const [showEndDate, setShowEndDate] = useState(Boolean(submission?.preferredEndDate));
    const [participants, setParticipants] = useState(
        submission?.participantEstimate != null ? String(submission.participantEstimate) : '',
    );
    const [notes, setNotes] = useState(submission?.notes ?? '');

    const [newName, setNewName] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [newPhone, setNewPhone] = useState('');

    const [busy, setBusy] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [offline, setOffline] = useState(false);

    const selectedIds = useMemo(
        () => organizations.filter((o) => answers[o.id]?.selected).map((o) => o.id),
        [organizations, answers],
    );
    const selectedCount = selectedIds.length;

    const setAnswer = (id: string, patch: Partial<OrgAnswer>) =>
        setAnswers((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

    const submit = async () => {
        setBusy(true); setErrors([]); setOffline(false);
        try {
            const res = await fetch(`/api/rebook/${encodeURIComponent(token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    organizations: organizations.map((o) => ({
                        id: o.id,
                        selected: answers[o.id].selected,
                        coordinatorIntent: answers[o.id].intent,
                        coordinatorName: answers[o.id].coordinatorName || null,
                        coordinatorEmail: answers[o.id].coordinatorEmail || null,
                    })),
                    preferredStartDate: preferredStart || null,
                    alternateStartDate: alternateStart || null,
                    preferredEndDate: showEndDate ? (preferredEnd || null) : null,
                    participantEstimate: participants === '' ? null : participants,
                    notes: notes || null,
                    respondentName: newName || null,
                    respondentEmail: newEmail || null,
                    respondentPhone: newPhone || null,
                }),
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok || !data.ok) {
                // A 409 carries a link STATE rather than a field error. Saying
                // "something went wrong" to someone whose link simply expired
                // sends them looking for a bug that isn't there.
                const byState: Record<string, string> = {
                    expired: 'This link has expired, so your changes could not be saved. Ask for a new link below.',
                    revoked: 'This link was replaced. Check your email for the newer one.',
                    invalid: "This link isn't valid any more.",
                };
                setErrors(
                    Array.isArray(data.errors) && data.errors.length
                        ? data.errors
                        : [byState[data.state as string]
                            ?? 'Something went wrong. Your answers are still here — try again.'],
                );
                return;
            }

            // Rebuild the confirmation from what was actually sent, so the page
            // never shows a summary that differs from the submitted answers.
            setResult({
                revisionNumber: data.revisionNumber ?? (result?.revisionNumber ?? 0) + 1,
                submittedAt: new Date().toISOString(),
                preferredStartDate: preferredStart || null,
                alternateStartDate: alternateStart || null,
                preferredEndDate: showEndDate ? (preferredEnd || null) : null,
                participantEstimate: participants === '' ? null : Number(participants),
                notes: notes || null,
                orgs: organizations.map((o) => ({
                    id: o.id,
                    name: o.name,
                    selected: answers[o.id].selected,
                    coordinatorIntent: answers[o.id].intent,
                    coordinatorName: answers[o.id].coordinatorName || null,
                    coordinatorEmail: answers[o.id].coordinatorEmail || null,
                })),
            });
            setMode('confirmed');
        } catch {
            // The answers live in component state, so "still here" is literally
            // true — nothing is cleared on failure.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) setOffline(true);
            else setErrors(['Something went wrong. Your answers are still here — try again.']);
        } finally {
            setBusy(false);
        }
    };

    // ── Confirmation (Screen 10) ─────────────────────────────────────────────
    if (mode === 'confirmed' && result) {
        const chosen = result.orgs.filter((o) => o.selected);
        const dropped = result.orgs.filter((o) => !o.selected);

        return (
            <div className="mx-auto w-full max-w-lg px-5 py-8 space-y-5">
                <h1 className="text-2xl font-black text-slate-900 dark:text-white">
                    Request sent for {chosen.length} group{chosen.length === 1 ? '' : 's'} <span aria-hidden="true">✓</span>
                </h1>

                {chosen.map((o) => (
                    <section key={o.id}
                        className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-2">
                        <h2 className="text-[11px] font-black uppercase tracking-widest text-slate-400">{o.name}</h2>
                        <dl className="grid grid-cols-2 gap-3">
                            <div>
                                <dt className="text-[11px] font-bold text-slate-400">Dates</dt>
                                <dd className="text-sm font-black text-slate-900 dark:text-white">
                                    {prettyDate(result.preferredStartDate)}
                                    {result.preferredEndDate ? ` → ${prettyDate(result.preferredEndDate)}` : ''}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-[11px] font-bold text-slate-400">Coordinator</dt>
                                {/* Three answers, three readings. `not_sure` must NOT
                                    read as "someone else will" — that is a different
                                    statement, and one the respondent never made. */}
                                <dd className="text-sm font-black text-slate-900 dark:text-white break-words">
                                    {o.coordinatorIntent === 'yes'
                                        ? 'You'
                                        : o.coordinatorIntent === 'no'
                                            ? (o.coordinatorName || 'Someone else — name to come')
                                            : 'Not decided yet'}
                                </dd>
                            </div>
                        </dl>
                    </section>
                ))}

                {dropped.length > 0 && (
                    <p className="text-sm font-bold text-slate-500">
                        We&apos;ll let {businessName} know {dropped.map((o) => o.name).join(', ')}{' '}
                        {dropped.length === 1 ? 'is' : 'are'} sitting this season out.
                    </p>
                )}

                {result.participantEstimate != null && (
                    <p className="text-sm font-bold text-slate-500">
                        Participants: ~{result.participantEstimate}
                    </p>
                )}

                {canUpdate ? (
                    <button type="button" onClick={() => setMode('form')}
                        className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-2">
                        <Pencil size={15} /> Update my request
                    </button>
                ) : (
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 px-4 py-3 space-y-2 text-center">
                        <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
                            This link has expired, so it can no longer be changed.
                        </p>
                        {refreshState === 'done' ? (
                            <p className="text-[12px] font-bold text-emerald-600">
                                We&apos;ve let {businessName} know. They&apos;ll send you a fresh link.
                            </p>
                        ) : (
                            <>
                                <button type="button" onClick={requestFreshLink} disabled={refreshState === 'sending'}
                                    className="min-h-[44px] px-5 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-2 disabled:opacity-50">
                                    {refreshState === 'sending' && <Loader2 size={15} className="animate-spin" />}
                                    Request a new link
                                </button>
                                {refreshState === 'error' && (
                                    <p className="text-[12px] font-bold text-rose-600">Something went wrong. Please try again.</p>
                                )}
                            </>
                        )}
                    </div>
                )}

                <p className="text-center text-[12px] font-bold text-slate-400 leading-relaxed">
                    What happens next: {businessName} will confirm dates by email.<br />
                    <strong className="text-slate-600 dark:text-slate-300">
                        Nothing is booked until {businessName} confirms your dates.
                    </strong>
                </p>
            </div>
        );
    }

    // ── Form (Screen 8) ──────────────────────────────────────────────────────
    return (
        <div className="mx-auto w-full max-w-lg px-5 py-8 space-y-6">
            <header>
                <p className="text-[11px] font-black uppercase tracking-widest text-indigo-600">
                    {lineupName} · {businessName}
                </p>
                <h1 className="text-2xl font-black text-slate-900 dark:text-white mt-1">
                    Let&apos;s plan your next fundraiser
                </h1>
            </header>

            {familyNames.length > 0 && (
                <section aria-labelledby="lineup-heading">
                    <h2 id="lineup-heading" className="sr-only">This season&apos;s bundles</h2>
                    <ul className="grid grid-cols-2 gap-2.5">
                        {familyNames.map((name) => (
                            <li key={name}
                                className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-3 text-sm font-black text-slate-900 dark:text-white">
                                {name}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <fieldset className="space-y-2.5">
                <legend className="text-sm font-black text-slate-900 dark:text-white mb-2">
                    Which groups are you booking?
                </legend>

                {organizations.map((org) => {
                    const a = answers[org.id];
                    return (
                        <div key={org.id} className="space-y-2">
                            <label
                                className="flex items-center gap-3 min-h-[44px] px-3.5 py-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500">
                                <input
                                    type="checkbox"
                                    checked={a.selected}
                                    onChange={(e) => setAnswer(org.id, { selected: e.target.checked })}
                                    className="w-5 h-5 rounded accent-indigo-600"
                                />
                                <span className="text-sm font-black text-slate-900 dark:text-white">{org.name}</span>
                                {a.selected && <Check size={16} className="ml-auto text-indigo-600" aria-hidden="true" />}
                            </label>

                            {a.selected && (
                                <fieldset className="ml-3 pl-3.5 border-l-2 border-indigo-100 dark:border-indigo-900 space-y-2">
                                    {/* Asked even for a single organization — helping with
                                        rebooking is not volunteering to run it. */}
                                    <legend className="text-[12px] font-bold text-slate-500 mb-1">
                                        Will you be the coordinator for the {org.name} fundraiser?
                                    </legend>

                                    {([['yes', "Yes, I'll coordinate it"], ['no', 'No, someone else will']] as const).map(
                                        ([value, label]) => (
                                            <label key={value}
                                                className="flex items-center gap-3 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500">
                                                <input
                                                    type="radio"
                                                    name={`intent-${org.id}`}
                                                    value={value}
                                                    checked={a.intent === value}
                                                    onChange={() => setAnswer(org.id, { intent: value })}
                                                    className="w-4 h-4 accent-indigo-600"
                                                />
                                                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{label}</span>
                                            </label>
                                        ),
                                    )}

                                    {a.intent === 'no' && (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                                            <div>
                                                <label htmlFor={`cname-${org.id}`} className={LABEL}>Their name</label>
                                                <input id={`cname-${org.id}`} className={FIELD} value={a.coordinatorName}
                                                    onChange={(e) => setAnswer(org.id, { coordinatorName: e.target.value })} />
                                            </div>
                                            <div>
                                                <label htmlFor={`cmail-${org.id}`} className={LABEL}>Their email</label>
                                                <input id={`cmail-${org.id}`} type="email" className={FIELD}
                                                    placeholder="Leave blank if you're not sure yet"
                                                    value={a.coordinatorEmail}
                                                    onChange={(e) => setAnswer(org.id, { coordinatorEmail: e.target.value })} />
                                            </div>
                                        </div>
                                    )}
                                </fieldset>
                            )}
                        </div>
                    );
                })}

                <p className="text-[12px] font-bold text-slate-400" aria-live="polite">
                    {selectedCount} of {organizations.length} selected — each becomes its own fundraiser
                </p>
            </fieldset>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                    <label htmlFor="pref-start" className={LABEL}>Preferred start</label>
                    <input id="pref-start" type="date" className={FIELD}
                        value={preferredStart} onChange={(e) => setPreferredStart(e.target.value)} />
                </div>
                <div>
                    <label htmlFor="alt-start" className={LABEL}>Alternate start</label>
                    <input id="alt-start" type="date" className={FIELD}
                        value={alternateStart} onChange={(e) => setAlternateStart(e.target.value)} />
                </div>
            </div>

            {showEndDate ? (
                <div>
                    <label htmlFor="pref-end" className={LABEL}>End date</label>
                    <input id="pref-end" type="date" className={FIELD}
                        value={preferredEnd} onChange={(e) => setPreferredEnd(e.target.value)} />
                </div>
            ) : (
                <button type="button" onClick={() => setShowEndDate(true)}
                    className="text-[12px] font-black text-indigo-600 min-h-[44px]">
                    + add an end date
                </button>
            )}

            <div>
                <label htmlFor="participants" className={LABEL}>About how many participants?</label>
                <input id="participants" type="number" inputMode="numeric" min={0} className={FIELD}
                    value={participants} onChange={(e) => setParticipants(e.target.value)} />
            </div>

            <div>
                <label htmlFor="notes" className={LABEL}>Anything we should know?</label>
                <textarea id="notes" rows={3} placeholder="Optional"
                    className={`${FIELD} py-2.5 min-h-[80px]`}
                    value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            <details className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
                <summary className="px-4 py-3 text-sm font-black text-slate-900 dark:text-white cursor-pointer min-h-[44px] flex items-center">
                    Is your contact info still right? Update it
                </summary>
                <div className="px-4 pb-4 space-y-3">
                    {/* Current values are READ-ONLY and masked. The editable
                        fields below start empty so a mask can never be saved as
                        if it were a real address. */}
                    <dl className="text-[12px] font-bold text-slate-400 space-y-0.5">
                        <div className="flex gap-2">
                            <dt>We have:</dt>
                            <dd className="text-slate-600 dark:text-slate-300">
                                {isSharedInbox ? 'a shared inbox' : recipientDisplayName}
                                {recipientEmailMasked ? ` · ${recipientEmailMasked}` : ''}
                            </dd>
                        </div>
                    </dl>
                    {isSharedInbox && (
                        <p className="text-[12px] font-bold text-slate-400">
                            This address reaches more than one person, so tell us who you are if you&apos;d
                            like {businessName} to reply to you directly.
                        </p>
                    )}
                    <div>
                        <label htmlFor="new-name" className={LABEL}>Your name</label>
                        <input id="new-name" className={FIELD} placeholder="Leave blank to keep what we have"
                            value={newName} onChange={(e) => setNewName(e.target.value)} />
                    </div>
                    <div>
                        <label htmlFor="new-email" className={LABEL}>Your email</label>
                        <input id="new-email" type="email" className={FIELD} placeholder="Leave blank to keep what we have"
                            value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                    </div>
                    <div>
                        <label htmlFor="new-phone" className={LABEL}>Your phone</label>
                        <input id="new-phone" type="tel" className={FIELD} placeholder="Leave blank to keep what we have"
                            value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                    </div>
                    <p className="text-[12px] font-bold text-slate-400">
                        {businessName} will confirm any change before updating their records.
                    </p>
                </div>
            </details>

            <div aria-live="assertive" className="space-y-2">
                {offline && (
                    <div className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3">
                        <p className="text-sm font-bold text-amber-800 dark:text-amber-400 flex items-start gap-2">
                            <WifiOff size={15} className="flex-none mt-0.5" />
                            No connection. Check your connection — your answers are saved on this page.
                        </p>
                    </div>
                )}
                {errors.map((err) => (
                    <div key={err} className="rounded-2xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3">
                        <p className="text-sm font-bold text-rose-700 dark:text-rose-400 flex items-start gap-2">
                            <AlertCircle size={15} className="flex-none mt-0.5" /> {err}
                        </p>
                    </div>
                ))}
            </div>

            <button type="button" onClick={submit} disabled={busy || selectedCount === 0}
                className="w-full min-h-[48px] rounded-xl bg-indigo-600 text-white font-black text-sm hover:bg-indigo-700 disabled:opacity-40 inline-flex items-center justify-center gap-2">
                {busy && <Loader2 size={16} className="animate-spin" />}
                {selectedCount === 0
                    ? 'Choose at least one group'
                    : `Send my request for ${selectedCount} group${selectedCount === 1 ? '' : 's'}`}
            </button>

            <p className="text-center text-[12px] font-bold text-slate-400 leading-relaxed">
                Nothing is booked until {businessName} confirms your dates.<br />
                We&apos;ll only use this to plan your fundraiser.
            </p>
        </div>
    );
}
