'use client';

/**
 * FR-FLOW-2B — launching a fundraiser from a date-confirmed opportunity.
 *
 * Everything shown here is loaded from ONE tenant-scoped endpoint, and every
 * value it collects is re-validated on the server. Nothing on this screen is a
 * gate: the delivery date is read-only because changing it belongs to the
 * date-confirmation workflow, not because the input is disabled.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Rocket, Copy, Check, Lock, UserPlus, Mail, Send, X, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { AWAITING_COORDINATOR_SETUP_LABEL } from '@/lib/campaignDisplayStage';

interface CoordinatorCandidate {
    orgContactId: string;
    displayName: string;
    role: string;
    isPrimaryRelationship: boolean;
    email: string | null;
    phone: string | null;
}

interface BundleFamily {
    familyId: string;
    name: string;
    serves5: { id: string; name: string; price: number | null };
    serves2: { id: string; name: string; price: number | null } | null;
}

interface LaunchContext {
    opportunity: {
        id: string;
        status: string;
        participantEstimate: number | null;
        confirmedDeliveryDate: string | null;
        launchable: boolean;
        refusal: { code: string; error: string } | null;
        alreadyLaunchedCampaignId: string | null;
    };
    organization: { id: string; name: string };
    coordinatorCandidates: CoordinatorCandidate[];
    bundleFamilies: BundleFamily[];
}

/** PART O — a prepared message the tenant sends themselves. Nothing is sent automatically. */
function coordinatorMessage(orgName: string, url: string): string {
    return `Your fundraiser for ${orgName} is ready for setup. Use this secure link to choose your bundle options and confirm the remaining fundraiser details:\n\n${url}`;
}

const inputCls =
    'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800';

export function LaunchFundraiserDialog({
    opportunityId,
    onClose,
    onLaunched,
}: {
    opportunityId: string;
    onClose: () => void;
    onLaunched?: (campaignId: string) => void;
}) {
    const [ctx, setCtx] = useState<LaunchContext | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState<'link' | 'message' | null>(null);
    const [result, setResult] = useState<{ campaignId: string; url: string | null } | null>(null);
    // FR-ACCEPTANCE-2A — adding the real coordinator without leaving the flow.
    const [addingContact, setAddingContact] = useState(false);
    const [savingContact, setSavingContact] = useState(false);
    const [newName, setNewName] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [newPhone, setNewPhone] = useState('');
    // FR-ACCEPTANCE-2A — coordinator setup email: review, then send.
    const [emailPreview, setEmailPreview] = useState<{ to: string; subject: string; html: string } | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [sendingEmail, setSendingEmail] = useState(false);
    /** Set ONLY from a real provider success reported by the server. */
    const [emailSentAt, setEmailSentAt] = useState<string | null>(null);
    /**
     * A send was attempted and its outcome could not be confirmed. NOT "sent" —
     * the coordinator may or may not have the invitation, and the honest thing
     * is to say so rather than pick whichever guess reads better.
     */
    const [emailUnresolved, setEmailUnresolved] = useState(false);

    const [name, setName] = useState('');
    const [endDate, setEndDate] = useState('');
    const [orgContactId, setOrgContactId] = useState('');
    const [orgShare, setOrgShare] = useState('20');
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [selectionLimit, setSelectionLimit] = useState(2);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(`/api/opportunities/${opportunityId}/launch`, {
                    credentials: 'same-origin',
                });
                const data = await res.json();
                if (!alive) return;
                if (!res.ok) {
                    toast.error(data?.error || 'Could not load this opportunity.');
                    onClose();
                    return;
                }
                setCtx(data);
                setName(`${data.organization.name} Fundraiser`);
                // FR-ACCEPTANCE-1 — no pre-selection, deliberately.
                //
                // This used to default to the organization's primary relationship,
                // falling back to whoever came first. Now that the person who
                // submits an enquiry automatically becomes an organization contact,
                // that fallback would quietly nominate them as coordinator — and
                // the person who fills in a web form is often a parent or an office
                // administrator, not whoever will actually run the fundraiser.
                //
                // Appointing a coordinator sends them a credential and makes them
                // responsible for the setup. That is a decision, so it is left to
                // the tenant to make one.
            } catch {
                if (alive) { toast.error('Could not load this opportunity.'); onClose(); }
            } finally {
                if (alive) setLoading(false);
            }
        })();

        return () => { alive = false; };
    }, [opportunityId, onClose]);

    const toggleFamily = useCallback((familyId: string) => {
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(familyId)) next.delete(familyId); else next.add(familyId);
            return next;
        });
    }, []);

    const submit = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/opportunities/${opportunityId}/launch`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    name,
                    endDate,
                    orgContactId,
                    orgSharePercent: orgShare,
                    candidateFamilyIds: [...picked],
                    selectionLimit,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                toast.error(data?.error || 'Could not launch this fundraiser.');
                setBusy(false);
                return;
            }
            if (data.alreadyLaunched) toast.info('This fundraiser was already launched.');
            else toast.success('Fundraiser created — awaiting coordinator setup.');
            setResult({ campaignId: data.campaignId, url: data.coordinatorAccessUrl ?? null });
            onLaunched?.(data.campaignId);
        } catch {
            toast.error('Could not launch this fundraiser.');
        } finally {
            setBusy(false);
        }
    }, [busy, opportunityId, name, endDate, orgContactId, orgShare, picked, selectionLimit, onLaunched]);

    /**
     * FR-ACCEPTANCE-2A — save a new organization contact, then refresh the picker.
     *
     * Refreshes ONLY coordinatorCandidates. Re-reading the whole context would
     * throw away the name, dates and bundle choices the tenant has already made
     * in this dialog.
     *
     * It deliberately does NOT select the new person. Creating a contact and
     * appointing a coordinator are different decisions — appointing them mints a
     * credential and makes them responsible for setup — so the tenant still picks
     * from the dropdown.
     */
    const addContact = useCallback(async () => {
        if (savingContact || !ctx) return;
        setSavingContact(true);
        try {
            const res = await fetch(`/api/organizations/${ctx.organization.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ name: newName.trim(), email: newEmail.trim(), phone: newPhone.trim() }),
            });
            const data = await res.json().catch(() => ({} as any));
            if (!res.ok) {
                toast.error(data?.error || 'Could not save that contact.');
                return;
            }

            const refreshed = await fetch(`/api/opportunities/${opportunityId}/launch`, { credentials: 'same-origin' });
            const fresh = await refreshed.json().catch(() => null);
            if (refreshed.ok && fresh?.coordinatorCandidates) {
                setCtx((prev) => (prev ? { ...prev, coordinatorCandidates: fresh.coordinatorCandidates } : prev));
            }

            toast.success(data?.created === false ? 'That person was already a contact here.' : 'Contact added.');
            setAddingContact(false);
            setNewName(''); setNewEmail(''); setNewPhone('');
        } catch {
            toast.error('Could not save that contact.');
        } finally {
            setSavingContact(false);
        }
    }, [savingContact, ctx, newName, newEmail, newPhone, opportunityId]);

    /**
     * Load the preview. Opening it is NOT sending it — this is a GET, and the
     * server writes nothing on that path.
     */
    const openEmailReview = useCallback(async () => {
        if (!result) return;
        setLoadingPreview(true);
        try {
            const res = await fetch(`/api/campaigns/${result.campaignId}/coordinator-email`, {
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({} as any));
            if (!res.ok) {
                toast.error(data?.error || 'Could not prepare that email.');
                return;
            }
            setEmailPreview({ to: data.to, subject: data.subject, html: data.html });
            if (data.state === 'sent') setEmailSentAt(String(data.alreadySentAt));
            else if (data.state === 'unresolved') setEmailUnresolved(true);
        } catch {
            toast.error('Could not prepare that email.');
        } finally {
            setLoadingPreview(false);
        }
    }, [result]);

    /**
     * Send it for real.
     *
     * FR-ACCEPTANCE-1C truth rules apply unchanged: a safety-mode response says
     * so and records nothing, a failure claims nothing, and only a genuine
     * provider success is reported as sent.
     */
    const sendCoordinatorEmail = useCallback(async () => {
        if (!result || sendingEmail) return;
        setSendingEmail(true);
        try {
            const res = await fetch(`/api/campaigns/${result.campaignId}/coordinator-email`, {
                method: 'POST',
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({} as any));
            if (!res.ok) {
                if (data?.alreadySent) {
                    // The server refused a second credential. Reflect that state
                    // rather than reporting a failure the tenant should retry.
                    setEmailSentAt(data.sentAt ? String(data.sentAt) : new Date().toISOString());
                    setEmailPreview(null);
                    toast.info('That invitation has already been sent.', {
                        description: 'Use Copy Setup Link if the coordinator never received it.',
                    });
                    return;
                }
                if (data?.unresolved) {
                    // An earlier attempt claimed the send and never resolved.
                    // Not sent, not failed — unknown, and blocked from retrying.
                    setEmailUnresolved(true);
                    setEmailPreview(null);
                    toast.warning('Delivery status unresolved', {
                        description:
                            'An earlier attempt could not be confirmed, so FreezerIQ will not send '
                            + 'again automatically. Use Copy Setup Link if the coordinator never received it.',
                        duration: 12000,
                    });
                    return;
                }
                if (data?.uncertain) {
                    // This attempt's outcome is unknown, claim held. Not a retry
                    // prompt — a second send could duplicate a live credential.
                    setEmailUnresolved(true);
                    setEmailPreview(null);
                    toast.warning('Could not confirm that send', {
                        description: data.error,
                        duration: 12000,
                    });
                    return;
                }
                toast.error(data?.error || "We couldn't send that email. Please try again.");
                return;
            }
            if (data?.mocked) {
                // Nothing left the building, so nothing is claimed or recorded.
                toast.message('No email was sent — sending is switched off for this environment.', {
                    description: 'The coordinator has not been contacted. Use Copy Setup Link instead.',
                });
                setEmailPreview(null);
                return;
            }
            // The provider accepted it. That much is certain either way.
            setEmailPreview(null);
            if (data?.recorded === false) {
                // Sent, but we could not write sent_at. The row rests at
                // claimed-but-not-sent, so the honest screen is "uncertain" —
                // and above all, not an invitation to send a second credential.
                setEmailUnresolved(true);
                toast.warning('Sent — but not recorded', {
                    description:
                        'The coordinator has the setup email. FreezerIQ could not save that it was sent, '
                        + 'so it will show as unconfirmed. Do not send it again.',
                    duration: 12000,
                });
                return;
            }
            setEmailSentAt(new Date().toISOString());
            toast.success('Setup email sent to the coordinator.');
        } catch {
            toast.error("We couldn't send that email. Please try again.");
        } finally {
            setSendingEmail(false);
        }
    }, [result, sendingEmail]);

    const copy = useCallback(async (what: 'link' | 'message', text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(what);
            setTimeout(() => setCopied(null), 2000);
        } catch {
            toast.error('Could not copy. Select the text and copy manually.');
        }
    }, []);

    const familyCount = picked.size;
    const canSubmit =
        !busy && !!name.trim() && !!endDate && !!orgContactId && familyCount >= 1
        && selectionLimit >= 1 && selectionLimit <= familyCount;

    /**
     * FR-ACCEPTANCE-1 — say WHY the button is off.
     *
     * The tenant met a greyed-out "Create & Prepare Coordinator Setup" with no
     * explanation, next to an empty coordinator field, and had no way to know
     * which of five requirements was missing. The gate itself is right — FR-FLOW-2
     * cannot mint a coordinator setup link without a coordinator — but a disabled
     * control that will not say what it wants is just a dead end.
     *
     * Ordered the way someone fills the form in, so the first thing named is the
     * first thing to go and do.
     */
    const blockingReason = ((): string | null => {
        if (!name.trim()) return 'Enter a fundraiser name.';
        if (!endDate) return 'Choose the last day supporters may place orders.';
        if (!orgContactId) {
            return ctx && ctx.coordinatorCandidates.length === 0
                ? 'This organization has no contacts yet. Add one to choose a primary coordinator.'
                : 'Choose the primary coordinator who will set this fundraiser up.';
        }
        if (familyCount === 0) return 'Select at least one bundle option for the coordinator to choose from.';
        if (selectionLimit < 1) return 'The coordinator must choose at least one bundle option.';
        if (selectionLimit > familyCount) {
            return `You have asked the coordinator to choose ${selectionLimit}, but only offered ${familyCount}.`;
        }
        return null;
    })();

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
            <div className="my-8 w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900">
                {loading ? (
                    <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
                        <Loader2 className="animate-spin" size={16} /> Loading…
                    </div>
                ) : result ? (
                    /* ── Success: Awaiting Coordinator Setup ─────────────────── */
                    <div className="space-y-4">
                        <div className="inline-flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                            {AWAITING_COORDINATOR_SETUP_LABEL}
                        </div>
                        <p className="text-sm text-slate-600 dark:text-slate-300">
                            The fundraiser exists and is not yet taking orders. It stays hidden from the
                            public storefront until the coordinator finishes setup.
                        </p>

                        {/* FR-ACCEPTANCE-2A — the normal way to hand off.
                            Copying a link and pasting it into another inbox still works and
                            stays below, but it should not be the only route. Nothing is sent
                            by launching: the tenant reviews the message first, then sends. */}
                        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-900 dark:bg-indigo-950/40">
                            {emailSentAt ? (
                                <>
                                    <p className="flex items-center gap-1.5 text-sm font-bold text-emerald-700 dark:text-emerald-400">
                                        <Check size={14} /> Setup email sent to the coordinator
                                    </p>
                                    {/* No resend button, deliberately. One credential-bearing
                                        invitation per coordinator, enforced server-side. If the
                                        coordinator never got it, Copy Setup Link below hands the
                                        tenant the same single link to pass on themselves. */}
                                    <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">
                                        If they never received it, use Copy Setup Link below rather
                                        than sending a second link.
                                    </p>
                                </>
                            ) : emailUnresolved ? (
                                /* Claimed, never confirmed. Saying "sent" would be a guess and
                                   "failed" would be a different guess — the truth is that we do
                                   not know, and a second send could duplicate a live credential. */
                                <>
                                    <p className="flex items-center gap-1.5 text-sm font-bold text-amber-800 dark:text-amber-300">
                                        <AlertTriangle size={14} /> Delivery status not confirmed
                                    </p>
                                    <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                                        FreezerIQ could not confirm whether the coordinator invitation
                                        was delivered, so it will not send again automatically. Check
                                        with {'them'} — and if it never arrived, use Copy Setup Link
                                        below rather than sending a second link.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <p className="text-sm font-bold text-indigo-900 dark:text-indigo-200">
                                        Send the coordinator their setup email
                                    </p>
                                    <p className="mt-1 text-xs text-indigo-800 dark:text-indigo-300">
                                        Nothing has been sent yet. Review the message, then send it from
                                        your business.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={openEmailReview}
                                        disabled={loadingPreview}
                                        aria-busy={loadingPreview}
                                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
                                    >
                                        {loadingPreview ? <Loader2 className="animate-spin" size={13} /> : <Mail size={13} />}
                                        Review &amp; send coordinator email
                                    </button>
                                </>
                            )}
                        </div>

                        {result.url && (
                            <>
                                <div>
                                    <label className="mb-1 block text-xs font-bold text-slate-500">
                                        Secure setup link <span className="font-medium text-slate-400">(manual fallback)</span>
                                    </label>
                                    <div className="flex gap-2">
                                        <input readOnly value={result.url} className={inputCls} onFocus={(e) => e.currentTarget.select()} />
                                        <button
                                            type="button"
                                            onClick={() => copy('link', result.url!)}
                                            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white dark:bg-slate-100 dark:text-slate-900"
                                        >
                                            {copied === 'link' ? <Check size={13} /> : <Copy size={13} />}
                                            {copied === 'link' ? 'Copied' : 'Copy Setup Link'}
                                        </button>
                                    </div>
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs font-bold text-slate-500">
                                        Message for the coordinator — send this yourself
                                    </label>
                                    <textarea
                                        readOnly
                                        rows={4}
                                        value={coordinatorMessage(ctx!.organization.name, result.url)}
                                        className={inputCls}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => copy('message', coordinatorMessage(ctx!.organization.name, result.url!))}
                                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold dark:border-slate-700"
                                    >
                                        {copied === 'message' ? <Check size={13} /> : <Copy size={13} />}
                                        {copied === 'message' ? 'Copied' : 'Copy message'}
                                    </button>
                                </div>
                            </>
                        )}
                        <div className="flex justify-end">
                            <button onClick={onClose} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-900">
                                Done
                            </button>
                        </div>
                    </div>
                ) : !ctx?.opportunity.launchable ? (
                    <div className="space-y-4">
                        <p className="text-sm text-slate-600 dark:text-slate-300">
                            {ctx?.opportunity.refusal?.error ?? 'This opportunity cannot be launched.'}
                        </p>
                        <div className="flex justify-end">
                            <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold dark:border-slate-700">Close</button>
                        </div>
                    </div>
                ) : (
                    /* ── The launch form ─────────────────────────────────────── */
                    <div className="space-y-5">
                        <div>
                            <h2 className="text-lg font-black">Launch Fundraiser</h2>
                            <p className="text-sm text-slate-500">{ctx.organization.name}</p>
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="sm:col-span-2">
                                <label htmlFor="lf-name" className="mb-1 block text-xs font-bold text-slate-500">Fundraiser name</label>
                                <input id="lf-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
                            </div>

                            <div>
                                <label className="mb-1 flex items-center gap-1.5 text-xs font-bold text-slate-500">
                                    <Lock size={11} /> Delivery / pickup date
                                </label>
                                <input readOnly value={ctx.opportunity.confirmedDeliveryDate ?? ''} className={`${inputCls} bg-slate-50 dark:bg-slate-800/60`} />
                                <p className="mt-1 text-[11px] text-slate-400">
                                    Confirmed with the organization. Change it from the lead, not here.
                                </p>
                            </div>

                            <div>
                                <label htmlFor="lf-end" className="mb-1 block text-xs font-bold text-slate-500">
                                    Last day supporters may place orders
                                </label>
                                <input id="lf-end" type="date" className={inputCls} value={endDate}
                                    max={ctx.opportunity.confirmedDeliveryDate ?? undefined}
                                    onChange={(e) => setEndDate(e.target.value)} />
                            </div>

                            <div>
                                <label htmlFor="lf-coord" className="mb-1 block text-xs font-bold text-slate-500">Primary coordinator</label>
                                {ctx.coordinatorCandidates.length === 0 ? (
                                    <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                                        This organization has no contacts on file yet. A fundraiser needs
                                        one person to set it up and receive the secure link — add them below.
                                    </p>
                                ) : (
                                    <select id="lf-coord" className={inputCls} value={orgContactId} onChange={(e) => setOrgContactId(e.target.value)}>
                                        {/* Deliberately unselected until the tenant chooses. The
                                            person who filled in the enquiry form is a contact of the
                                            organization, which is not the same as having agreed to
                                            run the fundraiser — so they are offered, never assumed. */}
                                        <option value="">Choose a coordinator…</option>
                                        {ctx.coordinatorCandidates.map((c) => (
                                            <option key={c.orgContactId} value={c.orgContactId}>
                                                {c.displayName}{c.email ? ` · ${c.email}` : ''}
                                            </option>
                                        ))}
                                    </select>
                                )}

                                {/* FR-ACCEPTANCE-2A — add the real coordinator without leaving.
                                    The person who filled in the enquiry form is very often not the
                                    one who will run the fundraiser; the intake email now asks who
                                    that will be. Before this the tenant had to cancel the launch,
                                    go and find the organization in the CRM, add a contact, and
                                    start over. */}
                                {!addingContact ? (
                                    <button
                                        type="button"
                                        onClick={() => setAddingContact(true)}
                                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:underline dark:text-indigo-400"
                                    >
                                        <UserPlus size={13} /> Add a different coordinator
                                    </button>
                                ) : (
                                    <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
                                        <p className="text-xs font-bold text-slate-600 dark:text-slate-300">
                                            New contact for {ctx.organization.name}
                                        </p>
                                        <input className={inputCls} placeholder="Full name" value={newName}
                                            onChange={(e) => setNewName(e.target.value)} />
                                        <input className={inputCls} type="email" placeholder="Email address" value={newEmail}
                                            onChange={(e) => setNewEmail(e.target.value)} />
                                        <input className={inputCls} placeholder="Phone (optional)" value={newPhone}
                                            onChange={(e) => setNewPhone(e.target.value)} />
                                        <div className="flex items-center justify-end gap-2">
                                            <button type="button" onClick={() => setAddingContact(false)}
                                                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold dark:border-slate-700">
                                                Cancel
                                            </button>
                                            <button
                                                type="button"
                                                onClick={addContact}
                                                disabled={savingContact || !newName.trim() || !newEmail.trim()}
                                                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                                            >
                                                {savingContact ? <Loader2 className="animate-spin" size={13} /> : <UserPlus size={13} />}
                                                Save contact
                                            </button>
                                        </div>
                                        <p className="text-[11px] text-slate-500">
                                            Saving adds them to this organization. You still choose the
                                            coordinator above — nobody is selected automatically.
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div>
                                <label htmlFor="lf-share" className="mb-1 block text-xs font-bold text-slate-500">Organization share (%)</label>
                                <input id="lf-share" type="number" min={0} max={100} step="0.01" className={inputCls}
                                    value={orgShare} onChange={(e) => setOrgShare(e.target.value)} />
                            </div>
                        </div>

                        <div>
                            <label className="mb-1 block text-xs font-bold text-slate-500">
                                Bundle options the coordinator may choose from
                            </label>
                            {ctx.bundleFamilies.length === 0 ? (
                                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                                    No eligible bundle families. Each family needs an active Serves-5 and Serves-2 pair.
                                </p>
                            ) : (
                                <ul className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                                    {ctx.bundleFamilies.map((f) => (
                                        <li key={f.familyId}>
                                            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                                                <input type="checkbox" checked={picked.has(f.familyId)} onChange={() => toggleFamily(f.familyId)} />
                                                <span>{f.name}</span>
                                            </label>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div>
                            <label htmlFor="lf-limit" className="mb-1 block text-xs font-bold text-slate-500">
                                How many the coordinator must choose
                            </label>
                            <input id="lf-limit" type="number" min={1} max={Math.max(1, familyCount)} className={`${inputCls} sm:w-32`}
                                value={selectionLimit}
                                onChange={(e) => setSelectionLimit(Number(e.target.value))} />
                            <p className="mt-1 text-[11px] text-slate-400">
                                Exactly this many, from the {familyCount} option{familyCount === 1 ? '' : 's'} selected above.
                            </p>
                        </div>

                        <div className="flex flex-col items-end gap-2">
                            {blockingReason && (
                                <p aria-live="polite" className="text-right text-xs font-semibold text-amber-700 dark:text-amber-400">
                                    {blockingReason}
                                </p>
                            )}
                            <div className="flex justify-end gap-2">
                                <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold dark:border-slate-700">Cancel</button>
                                <button
                                    onClick={submit}
                                    disabled={!canSubmit}
                                    aria-busy={busy}
                                    title={blockingReason ?? undefined}
                                    className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                                >
                                    {busy ? <Loader2 className="animate-spin" size={15} /> : <Rocket size={15} />}
                                    Create &amp; Prepare Coordinator Setup
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* FR-ACCEPTANCE-2A — review before send.
                The tenant sees the recipient, the subject and the exact body the
                coordinator will read. The secure link is NOT shown as text
                anywhere: it lives only in the CTA's href, because a credential a
                human can read is a credential a human can paste somewhere it
                does not belong. */}
            {emailPreview && (
                <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4">
                    <div className="my-10 w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900">
                        <div className="mb-3 flex items-start justify-between gap-3">
                            <h3 className="text-base font-black text-slate-900 dark:text-white">Review coordinator email</h3>
                            <button onClick={() => setEmailPreview(null)} aria-label="Close"
                                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                                <X size={16} />
                            </button>
                        </div>

                        <dl className="mb-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-800/60">
                            <div className="flex gap-2">
                                <dt className="w-16 shrink-0 font-bold text-slate-500">To</dt>
                                <dd className="text-slate-700 dark:text-slate-200">{emailPreview.to}</dd>
                            </div>
                            <div className="flex gap-2">
                                <dt className="w-16 shrink-0 font-bold text-slate-500">Subject</dt>
                                <dd className="text-slate-700 dark:text-slate-200">{emailPreview.subject}</dd>
                            </div>
                        </dl>

                        <label className="mb-1 block text-xs font-bold text-slate-500">Message</label>
                        <div
                            className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
                            dangerouslySetInnerHTML={{ __html: emailPreview.html }}
                        />
                        <p className="mt-2 text-[11px] text-slate-500">
                            The button in this message carries the coordinator&rsquo;s private setup
                            link. It is not shown as text on purpose.
                        </p>

                        <div className="mt-4 flex justify-end gap-2">
                            <button onClick={() => setEmailPreview(null)}
                                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold dark:border-slate-700">
                                Cancel
                            </button>
                            <button
                                onClick={sendCoordinatorEmail}
                                disabled={sendingEmail}
                                aria-busy={sendingEmail}
                                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                            >
                                {sendingEmail ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
                                Send Coordinator Email
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
