"use client";

/**
 * FR-RETENTION-4 — the expired-link state (Screen 9).
 *
 * The one thing this must not do is quietly issue a new link. Asking sets a
 * "Needs action" flag for the tenant and nothing else — an expired credential
 * that can renew itself on demand is not an expiring credential.
 */

import { useState } from 'react';
import { Loader2, Clock, Check } from 'lucide-react';

export function RebookingExpired({
    token,
    businessName,
    alreadyRequested,
}: {
    token: string;
    businessName: string;
    alreadyRequested: boolean;
}) {
    const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>(
        alreadyRequested ? 'done' : 'idle',
    );

    const request = async () => {
        setState('sending');
        try {
            const res = await fetch(`/api/rebook/${encodeURIComponent(token)}/refresh`, { method: 'POST' });
            setState(res.ok ? 'done' : 'error');
        } catch {
            setState('error');
        }
    };

    return (
        <div className="mx-auto w-full max-w-md px-5 py-16 text-center space-y-4">
            <Clock size={32} className="mx-auto text-slate-300" aria-hidden="true" />
            <h1 className="text-xl font-black text-slate-900 dark:text-white">This invitation has expired.</h1>

            {state === 'done' ? (
                <p className="text-sm font-bold text-emerald-600 inline-flex items-center gap-2 justify-center">
                    <Check size={16} aria-hidden="true" />
                    We&apos;ve let {businessName} know. They&apos;ll send you a fresh link.
                </p>
            ) : (
                <>
                    <button type="button" onClick={request} disabled={state === 'sending'}
                        className="min-h-[44px] px-5 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-2 disabled:opacity-50">
                        {state === 'sending' && <Loader2 size={15} className="animate-spin" />}
                        Request a new link
                    </button>
                    {state === 'error' && (
                        <p className="text-sm font-bold text-rose-600">Something went wrong. Please try again.</p>
                    )}
                </>
            )}
        </div>
    );
}
