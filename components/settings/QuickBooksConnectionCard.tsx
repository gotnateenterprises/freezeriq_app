'use client';

/**
 * QB-INVOICE-1A — the QuickBooks Online connection control in Settings.
 *
 * Replaces the legacy card that linked to the retired /api/auth/qbo route and
 * reported "connected" whenever any 'qbo' row existed. The state shown here is
 * the server's live answer from /api/integrations/quickbooks/status, which only
 * says connected after a read-only CompanyInfo call succeeds.
 *
 * Rendered for tenant admins only; the routes enforce the same rule regardless.
 * No client id, realm id, token or integration id is ever sent to this component.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link2, Loader2 } from 'lucide-react';
import {
    QUICKBOOKS_CALLBACK_MESSAGES,
    quickBooksCardView,
    type QuickBooksStatusPayload,
} from '@/lib/quickbooks/statusView';

const TONE_CLASS: Record<string, string> = {
    neutral: 'text-slate-500 dark:text-slate-400',
    ok: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-rose-600 dark:text-rose-400',
};

export default function QuickBooksConnectionCard() {
    const [status, setStatus] = useState<QuickBooksStatusPayload | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setStatus(null);
        try {
            const res = await fetch('/api/integrations/quickbooks/status', { cache: 'no-store' });
            const data = await res.json().catch(() => null);
            setStatus(res.ok && data?.state ? data : { state: 'error' });
        } catch {
            setStatus({ state: 'error' });
        }
    }, []);

    useEffect(() => {
        load();
        // One-time outcome from the OAuth callback redirect; removed from the URL
        // so a refresh does not repeat it.
        const params = new URLSearchParams(window.location.search);
        const outcome = params.get('quickbooks');
        if (outcome) {
            const msg = QUICKBOOKS_CALLBACK_MESSAGES[outcome] ?? QUICKBOOKS_CALLBACK_MESSAGES.error;
            if (msg.ok) toast.success(msg.text); else toast.error(msg.text);
            params.delete('quickbooks');
            const qs = params.toString();
            window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
        }
    }, [load]);

    async function post(action: 'disconnect' | 'forget') {
        setBusy(true);
        try {
            const res = await fetch('/api/integrations/quickbooks/disconnect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(data?.error || 'Could not change the QuickBooks connection.');
            } else if (action === 'disconnect') {
                if (data?.revoked === false) {
                    toast.warning('Disconnected in FreezerIQ. QuickBooks did not confirm the revocation — also disconnect FreezerIQ from inside QuickBooks.');
                } else {
                    toast.success('QuickBooks disconnected.');
                }
            } else {
                toast.success('Previous QuickBooks company forgotten.');
            }
        } catch {
            toast.error('Could not change the QuickBooks connection.');
        } finally {
            setBusy(false);
            load();
        }
    }

    const view = quickBooksCardView(status);

    return (
        <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700">
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                    <div className="w-10 h-10 shrink-0 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500">
                        {/* A neutral icon: no Intuit logo before approval, and never a "QB" abbreviation. */}
                        <Link2 size={18} />
                    </div>
                    <div className="min-w-0">
                        <p className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                            QuickBooks Online
                            {view.sandbox && (
                                <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Sandbox</span>
                            )}
                        </p>
                        <p className={`text-xs font-semibold flex items-center gap-1 ${TONE_CLASS[view.tone]}`}>
                            {status === null && <Loader2 size={12} className="animate-spin" />}
                            {view.tone === 'ok' ? '✓ ' : ''}{view.label}
                        </p>
                        {view.detail && <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{view.detail}</p>}
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {view.showRetry && (
                        <button onClick={load} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200">Retry</button>
                    )}
                    {view.showConnect && (
                        <a href="/api/integrations/quickbooks/connect" className="bg-slate-900 text-white px-4 py-2 rounded-lg text-xs font-bold">{view.connectLabel}</a>
                    )}
                    {view.showDisconnect && (
                        <button
                            onClick={() => { if (confirm('Disconnect from QuickBooks? FreezerIQ will stop accessing this QuickBooks company.')) post('disconnect'); }}
                            disabled={busy}
                            className="px-3 py-2 rounded-lg text-xs font-bold border border-rose-200 text-rose-600"
                        >
                            Disconnect from QuickBooks
                        </button>
                    )}
                    {view.showForget && (
                        <button
                            onClick={() => { if (confirm('Forget the previous QuickBooks company so a different one can be connected?')) post('forget'); }}
                            disabled={busy}
                            className="px-3 py-2 rounded-lg text-xs font-bold border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300"
                        >
                            Forget company
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
