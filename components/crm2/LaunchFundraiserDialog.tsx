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
import { Loader2, Rocket, Copy, Check, Lock, UserPlus } from 'lucide-react';
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
                        {result.url && (
                            <>
                                <div>
                                    <label className="mb-1 block text-xs font-bold text-slate-500">Secure setup link</label>
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
                                    /* FR-ACCEPTANCE-1 — a dead end became a next step.
                                       This used to say only "add one before launching", with
                                       nowhere to add one, so the tenant had to cancel the dialog
                                       and go hunting. Anyone who enquires now becomes an
                                       organization contact automatically, so this state should be
                                       rare; when it happens, it links straight to the place that
                                       fixes it. */
                                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/40">
                                        <p className="text-xs text-amber-800 dark:text-amber-300">
                                            This organization has no contacts on file yet. A fundraiser needs
                                            one person to set it up and receive the secure link.
                                        </p>
                                        <a
                                            href={`/customers/${ctx.organization.id}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700"
                                        >
                                            <UserPlus size={13} /> Add a contact
                                        </a>
                                        <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                                            Opens the organization in a new tab. Come back and reopen this
                                            dialog once the contact is saved.
                                        </p>
                                    </div>
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
        </div>
    );
}
