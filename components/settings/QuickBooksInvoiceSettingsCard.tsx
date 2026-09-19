'use client';

/**
 * QB-INVOICE-1C — which of the tenant's OWN QuickBooks items and terms FreezerIQ invoices use.
 *
 * Tenant admins only (the settings page gates it, and the route enforces it). Every option comes from the tenant's
 * QuickBooks company, filtered by accounting purpose on the server, under an opaque key: this card never sees a
 * token, realm id, connection id or raw QuickBooks id. Creating an item requires an explicit confirmation that
 * names the item and the account; FreezerIQ never creates an account.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FileText, Loader2 } from 'lucide-react';
import type { ItemRole } from '@/lib/quickbooks/invoiceSettings';
import {
    HELPER_OUTCOME_TEXT,
    helperItemPrompt,
    ROLE_LABELS,
    SAVE_OUTCOME_TEXT,
    SETTINGS_BLOCKER_TEXT,
    SETTINGS_NOTICE_TEXT,
    SETTINGS_PROBLEM_TEXT,
    settingsCardSummary,
    type InvoiceSettingsPayload,
} from '@/lib/quickbooks/invoiceSettingsView';

const URL = '/api/integrations/quickbooks/invoice-settings';
const ROLES: ItemRole[] = ['sales', 'share', 'tax'];

const TONE_CLASS: Record<string, string> = {
    neutral: 'text-slate-500 dark:text-slate-400',
    ok: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-rose-600 dark:text-rose-400',
};

interface Form {
    salesItemKey: string;
    shareItemKey: string;
    taxItemKey: string;
    termKey: string;
    allowOnlineCard: boolean;
    allowOnlineAch: boolean;
    defaultCc: string;
}

const EMPTY_FORM: Form = { salesItemKey: '', shareItemKey: '', taxItemKey: '', termKey: '', allowOnlineCard: false, allowOnlineAch: false, defaultCc: '' };

function newAttemptId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export default function QuickBooksInvoiceSettingsCard() {
    const [payload, setPayload] = useState<InvoiceSettingsPayload | null>(null);
    const [form, setForm] = useState<Form>(EMPTY_FORM);
    const [busy, setBusy] = useState(false);
    const [helperRole, setHelperRole] = useState<ItemRole | null>(null);
    const [helperAccountKey, setHelperAccountKey] = useState('');

    const adopt = useCallback((next: InvoiceSettingsPayload) => {
        setPayload(next);
        if (next.state === 'ready' && next.saved) {
            setForm({
                salesItemKey: next.saved.salesItemKey, shareItemKey: next.saved.shareItemKey ?? '', taxItemKey: next.saved.taxItemKey ?? '',
                termKey: next.saved.termKey, allowOnlineCard: next.saved.allowOnlineCard, allowOnlineAch: next.saved.allowOnlineAch,
                defaultCc: next.saved.defaultCc ?? '',
            });
        }
    }, []);

    const load = useCallback(async () => {
        setPayload(null);
        try {
            const res = await fetch(URL, { cache: 'no-store' });
            const data = await res.json().catch(() => null);
            adopt(res.ok && data?.state ? data : res.status === 403 ? { state: 'disabled' } : { state: 'error' });
        } catch {
            setPayload({ state: 'error' });
        }
    }, [adopt]);

    useEffect(() => { load(); }, [load]);

    async function save() {
        setBusy(true);
        try {
            const res = await fetch(URL, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    salesItemKey: form.salesItemKey, shareItemKey: form.shareItemKey || null, taxItemKey: form.taxItemKey || null,
                    termKey: form.termKey, allowOnlineCard: form.allowOnlineCard, allowOnlineAch: form.allowOnlineAch,
                    defaultCc: form.defaultCc.trim() || null,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.outcome === 'saved') {
                toast.success('QuickBooks invoice settings saved.');
                adopt(data.view);
            } else {
                toast.error(SAVE_OUTCOME_TEXT[data?.reason ?? data?.outcome] ?? data?.error ?? 'Could not save the QuickBooks invoice settings.');
                if (data?.outcome !== 'invalid') load();
            }
        } catch {
            toast.error('Could not save the QuickBooks invoice settings.');
        } finally {
            setBusy(false);
        }
    }

    async function createHelper(role: ItemRole) {
        if (!payload || payload.state !== 'ready') return;
        const helper = payload.helperItems[role];
        const account = payload.options.accounts[role].find((a) => a.key === helperAccountKey);
        const confirmation = helper.accountConfirmations.find((c) => c.accountKey === helperAccountKey)?.confirmation;
        if (!account || !confirmation) return;
        if (!confirm(helperItemPrompt(role, helper.proposedName, account.name))) return;
        setBusy(true);
        try {
            const res = await fetch(URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create_item', role, accountKey: account.key, name: helper.proposedName, confirmation, attemptId: newAttemptId() }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.outcome === 'created') {
                toast.success(`Created “${helper.proposedName}” in QuickBooks. Save to use it.`);
                adopt(data.view);
                setForm((f) => ({ ...f, [`${role}ItemKey`]: data.itemKey }));
                setHelperRole(null);
            } else {
                toast.error(HELPER_OUTCOME_TEXT[data?.reason ?? data?.outcome] ?? data?.error ?? 'Could not complete the QuickBooks request.');
                if (data?.outcome !== 'rejected') load();
            }
        } catch {
            toast.error('Could not complete the QuickBooks request.');
        } finally {
            setBusy(false);
        }
    }

    const summary = settingsCardSummary(payload);
    if (!summary.visible) return null;
    const ready = payload?.state === 'ready' ? payload : null;

    return (
        <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700">
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                    <div className="w-10 h-10 shrink-0 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500">
                        <FileText size={18} />
                    </div>
                    <div className="min-w-0">
                        <p className="font-bold text-slate-900 dark:text-white text-sm">QuickBooks invoice settings</p>
                        <p className={`text-xs font-semibold flex items-center gap-1 ${TONE_CLASS[summary.tone]}`}>
                            {payload === null && <Loader2 size={12} className="animate-spin" />}
                            {summary.tone === 'ok' ? '✓ ' : ''}{summary.label}
                        </p>
                        {summary.detail && <p className="text-xs text-slate-500 dark:text-slate-400">{summary.detail}</p>}
                    </div>
                </div>
                {summary.showRecheck && (
                    <button onClick={load} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 shrink-0">
                        Check again
                    </button>
                )}
            </div>

            {ready && (
                <div className="mt-4 space-y-4">
                    {ready.blockers.length > 0 && (
                        <ul className="space-y-1 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 rounded-lg p-3">
                            {ready.blockers.map((b) => <li key={b}>{SETTINGS_BLOCKER_TEXT[b]}</li>)}
                        </ul>
                    )}
                    {ready.saved && ready.saved.problems.length > 0 && (
                        <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3">
                            {ready.saved.problems.map((p) => <li key={p}>{SETTINGS_PROBLEM_TEXT[p]}</li>)}
                        </ul>
                    )}
                    <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                        {ready.notices.map((n) => <li key={n}>{SETTINGS_NOTICE_TEXT[n]}</li>)}
                    </ul>

                    {ROLES.map((role) => {
                        const key = `${role}ItemKey` as const;
                        const items = ready.options.items[role];
                        return (
                            <div key={role}>
                                <label className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-1">
                                    {ROLE_LABELS[role].title}{ROLE_LABELS[role].required ? '' : ' (optional)'}
                                </label>
                                <select
                                    value={form[key]}
                                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                                    disabled={busy}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                                >
                                    <option value="">{ROLE_LABELS[role].required ? 'Choose an item…' : 'None'}</option>
                                    {items.map((i) => <option key={i.key} value={i.key}>{i.name} — posts to {i.accountName}</option>)}
                                </select>
                                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{ROLE_LABELS[role].help}</p>
                                {helperRole === role ? (
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <select
                                            value={helperAccountKey}
                                            onChange={(e) => setHelperAccountKey(e.target.value)}
                                            disabled={busy}
                                            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs"
                                        >
                                            <option value="">Choose the account it posts to…</option>
                                            {ready.options.accounts[role].map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
                                        </select>
                                        <button
                                            onClick={() => createHelper(role)}
                                            disabled={busy || !helperAccountKey}
                                            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white disabled:opacity-50"
                                        >
                                            Create “{ready.helperItems[role].proposedName}”
                                        </button>
                                        <button onClick={() => setHelperRole(null)} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-500">
                                            Cancel
                                        </button>
                                    </div>
                                ) : ready.options.accounts[role].length > 0 && (
                                    <button
                                        onClick={() => { setHelperRole(role); setHelperAccountKey(''); }}
                                        disabled={busy}
                                        className="mt-1 text-xs font-bold text-indigo-600 dark:text-indigo-400"
                                    >
                                        No suitable item? Create one in QuickBooks…
                                    </button>
                                )}
                            </div>
                        );
                    })}

                    <div>
                        <label className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-1">Payment terms</label>
                        <select
                            value={form.termKey}
                            onChange={(e) => setForm((f) => ({ ...f, termKey: e.target.value }))}
                            disabled={busy}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                        >
                            <option value="">Choose terms…</option>
                            {ready.options.terms.map((t) => <option key={t.key} value={t.key}>{t.name} (due in {t.dueDays} days)</option>)}
                        </select>
                    </div>

                    <div>
                        <label className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-1">Online payment options</label>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={form.allowOnlineCard} disabled={busy || !ready.onlinePaymentsEnabled}
                                onChange={(e) => setForm((f) => ({ ...f, allowOnlineCard: e.target.checked }))} />
                            Let organizations pay by card in QuickBooks
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={form.allowOnlineAch} disabled={busy || !ready.onlinePaymentsEnabled}
                                onChange={(e) => setForm((f) => ({ ...f, allowOnlineAch: e.target.checked }))} />
                            Let organizations pay by bank transfer (ACH) in QuickBooks
                        </label>
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            Applied only after an invoice’s amounts and recipients are verified. QuickBooks may email the invoice at that moment; FreezerIQ checks
                            for that and records it as the send. Payments made in QuickBooks are not recorded in FreezerIQ automatically.
                        </p>
                    </div>

                    <div>
                        <label htmlFor="quickbooks-invoice-default-cc" className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-1">
                            Default CC (optional)
                        </label>
                        <input
                            id="quickbooks-invoice-default-cc"
                            type="text"
                            inputMode="email"
                            value={form.defaultCc}
                            maxLength={100}
                            onChange={(e) => setForm((f) => ({ ...f, defaultCc: e.target.value }))}
                            disabled={busy}
                            placeholder="bookkeeping@example.com, owner@example.com"
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                        />
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">One or more addresses separated by commas, suggested on every send. You review the recipient and CC before each invoice is sent.</p>
                    </div>

                    <div className="flex justify-end">
                        <button
                            onClick={save}
                            disabled={busy || !form.salesItemKey || !form.termKey}
                            className="bg-slate-900 text-white px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-50"
                        >
                            {busy ? 'Saving…' : 'Save invoice settings'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
