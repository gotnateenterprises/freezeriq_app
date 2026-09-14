'use client';

/**
 * QB-INVOICE-1B — the organization's QuickBooks customer, on the organization page.
 *
 * Tenant admins only (the route enforces the same rule); renders nothing when
 * QuickBooks is not available in this deployment. Every state and action comes
 * from /api/integrations/quickbooks/customers/[customerId]; the card never sees a
 * token, realm id, connection id or raw QuickBooks id — only display names and an
 * opaque confirmation.
 *
 * Linking and creating each require an explicit confirmation that quotes the exact
 * name. There is deliberately no invoice, send or payment control here.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { Link2, Loader2 } from 'lucide-react';
import { customerLinkCardView, type CustomerLinkStatusPayload } from '@/lib/quickbooks/customerLinkView';

const TONE_CLASS: Record<string, string> = {
    neutral: 'text-slate-500 dark:text-slate-400',
    ok: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-rose-600 dark:text-rose-400',
};

const OUTCOME_MESSAGE: Record<string, string> = {
    stale: 'QuickBooks or this organization changed since you looked. Review the current state and confirm again.',
    conflict: 'Another change linked this organization or that QuickBooks customer first. Review the current state.',
    rejected: 'QuickBooks refused to create the customer. Nothing was created.',
    unknown: 'QuickBooks did not confirm the result. The customer may have been created — check again before retrying.',
    unavailable: 'QuickBooks couldn’t be reached. Try again in a moment.',
};

function newAttemptId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export default function QuickBooksCustomerLinkCard({ customerId }: { customerId: string }) {
    const { data: session } = useSession();
    const isAdmin = session?.user?.role === 'ADMIN' && !(session?.user as any)?.isViewingAsTenant;
    const [status, setStatus] = useState<CustomerLinkStatusPayload | null>(null);
    const [busy, setBusy] = useState(false);
    const url = `/api/integrations/quickbooks/customers/${encodeURIComponent(customerId)}`;

    const load = useCallback(async () => {
        setStatus(null);
        try {
            const res = await fetch(url, { cache: 'no-store' });
            const data = await res.json().catch(() => null);
            setStatus(res.ok && data?.state ? data : res.status === 403 || res.status === 404 ? { state: 'disabled' } : { state: 'error' });
        } catch {
            setStatus({ state: 'error' });
        }
    }, [url]);

    useEffect(() => {
        if (isAdmin) load();
    }, [isAdmin, load]);

    async function act(action: 'link' | 'create', confirmation: string, prompt: string) {
        if (!confirm(prompt)) return;
        setBusy(true);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(action === 'create' ? { action, confirmation, attemptId: newAttemptId() } : { action, confirmation }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.outcome === 'linked') {
                toast.success('Linked to the QuickBooks customer.');
                setStatus(data.status);
            } else {
                const message = data?.outcome === 'rejected' && data?.reason === 'name_in_use'
                    ? 'QuickBooks already uses this name for a vendor or employee. Rename one of them, then check again.'
                    : OUTCOME_MESSAGE[data?.outcome];
                toast.error(message ?? data?.error ?? 'Could not complete the QuickBooks request.');
                if (data?.status?.state) setStatus(data.status); else load();
            }
        } catch {
            toast.error('Could not complete the QuickBooks request.');
            load();
        } finally {
            setBusy(false);
        }
    }

    if (!isAdmin) return null;
    const view = customerLinkCardView(status);
    if (!view.visible) return null;

    return (
        <div className="mt-6 p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 shrink-0 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500">
                        {/* Neutral icon: no Intuit logo before approval, and never a "QB" abbreviation. */}
                        <Link2 size={16} />
                    </div>
                    <div className="min-w-0">
                        <p className="font-bold text-slate-900 dark:text-white text-sm">QuickBooks customer</p>
                        <p className={`text-xs font-semibold flex items-center gap-1 ${TONE_CLASS[view.tone]}`}>
                            {status === null && <Loader2 size={12} className="animate-spin" />}
                            {view.tone === 'ok' ? '✓ ' : ''}{view.label}
                        </p>
                        {view.detail && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{view.detail}</p>}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {view.link && (
                        <button
                            onClick={() => act('link', view.link!.confirmation, view.link!.prompt)}
                            disabled={busy}
                            className="bg-slate-900 text-white px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50"
                        >
                            Link QuickBooks customer
                        </button>
                    )}
                    {view.create && (
                        <button
                            onClick={() => act('create', view.create!.confirmation, view.create!.prompt)}
                            disabled={busy}
                            className="px-3 py-2 rounded-lg text-xs font-bold border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 disabled:opacity-50"
                        >
                            Create QuickBooks customer
                        </button>
                    )}
                    {view.showRecheck && (
                        <button onClick={load} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300">
                            Check again
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
