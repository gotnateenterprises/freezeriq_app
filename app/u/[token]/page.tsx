'use client';

/**
 * OUTREACH-CONSENT-1 — the page a recipient lands on from an unsubscribe link.
 *
 * Deliberately plain: a sentence, a button, a confirmation. No login, no
 * account, no "tell us why", no preference centre, no attempt to talk anybody
 * out of it. Someone who clicked unsubscribe has already decided.
 *
 * Nothing happens on load. The opt-out is written only when the button is
 * pressed, so a mail scanner that fetches the URL leaves no trace.
 *
 * The page never displays the address. It does not need to — the token already
 * identifies it — and printing it would turn a forwarded email into a way to
 * confirm that a particular person is on a particular list.
 */

import { useState, use } from 'react';

type State = 'ready' | 'working' | 'done' | 'invalid' | 'error';

export default function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = use(params);
    const [state, setState] = useState<State>('ready');

    async function submit() {
        setState('working');
        try {
            const res = await fetch(`/api/unsubscribe/${encodeURIComponent(token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (res.ok) { setState('done'); return; }
            // A bad token and a server fault read differently to us and the
            // same to the visitor: either way they are told plainly.
            setState(res.status === 400 ? 'invalid' : 'error');
        } catch {
            setState('error');
        }
    }

    return (
        <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
            <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                {state === 'done' ? (
                    <>
                        <h1 className="text-lg font-black text-slate-900">You&rsquo;re unsubscribed</h1>
                        <p className="mt-2 text-sm text-slate-600">
                            You won&rsquo;t receive future promotional fundraiser emails at this address.
                        </p>
                        <p className="mt-3 text-xs text-slate-500">
                            You may still receive messages about an order you place yourself, such as a receipt.
                        </p>
                    </>
                ) : state === 'invalid' ? (
                    <>
                        <h1 className="text-lg font-black text-slate-900">This link isn&rsquo;t valid</h1>
                        <p className="mt-2 text-sm text-slate-600">
                            It may have been copied incompletely. Try opening the link straight from the email,
                            or reply to that email and ask to be removed.
                        </p>
                    </>
                ) : (
                    <>
                        <h1 className="text-lg font-black text-slate-900">Unsubscribe from promotional emails</h1>
                        <p className="mt-2 text-sm text-slate-600">
                            Confirm below and you won&rsquo;t receive future promotional fundraiser emails at this
                            address.
                        </p>
                        {state === 'error' && (
                            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                                Something went wrong. Please try again.
                            </p>
                        )}
                        <button
                            type="button"
                            onClick={submit}
                            disabled={state === 'working'}
                            className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                        >
                            {state === 'working' ? 'Working…' : 'Unsubscribe'}
                        </button>
                        <p className="mt-3 text-xs text-slate-500">
                            Nothing changes until you press the button.
                        </p>
                    </>
                )}
            </div>
        </main>
    );
}
