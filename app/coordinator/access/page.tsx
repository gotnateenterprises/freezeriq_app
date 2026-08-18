'use client';

/**
 * FR-COORD-SEC-1B — coordinator access exchange page.
 *
 * The coordinator link is `/coordinator/access#<credential>`. Browsers never put
 * the fragment on the wire, so the HTTP request for this page is exactly
 * `GET /coordinator/access` and Vercel's access log records nothing secret.
 *
 * This component:
 *   1. reads the fragment,
 *   2. strips it from the visible URL and from history BEFORE anything else,
 *   3. POSTs it once, in a request body, to the exchange endpoint,
 *   4. drops its reference and navigates to the tokenless portal.
 *
 * The credential is never rendered, never logged, never written to
 * localStorage or sessionStorage, and never placed in a URL.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Phase = 'exchanging' | 'invalid' | 'offline' | 'signedout';

/**
 * FR-COORD-SEC-1D-L — set by the portal's Logout control. A plain presentational
 * flag: it carries no credential and grants nothing, it only distinguishes
 * "you chose to sign out" from "this link is broken", which are very different
 * messages to show someone.
 */
const SIGNED_OUT_PARAM = 'signedout';

export default function CoordinatorAccessPage() {
    const router = useRouter();
    const [phase, setPhase] = useState<Phase>('exchanging');
    // React 18 StrictMode double-invokes effects in development; the credential
    // is consumed once and the fragment is already gone on the second pass, so
    // this guard keeps a single exchange attempt.
    const startedRef = useRef(false);

    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;

        // 1. Capture. `location.hash` includes the leading '#'.
        const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
        let credential: string | null = raw ? decodeURIComponent(raw) : null;

        // 2. Strip immediately — before the network call, so the secret spends
        //    the shortest possible time in the address bar and never lands in a
        //    history entry the coordinator could later share or screenshot.
        //    replaceState (not pushState) so Back does not restore it.
        if (raw) {
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }

        if (!credential) {
            // A credential always wins if one is present; this only decides what
            // to say when there isn't one.
            const signedOut = new URLSearchParams(window.location.search).has(SIGNED_OUT_PARAM);
            setPhase(signedOut ? 'signedout' : 'invalid');
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/coordinator/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // Body, never URL.
                    body: JSON.stringify({ credential }),
                });
                // 4. Drop the reference as soon as the request is dispatched.
                credential = null;

                if (cancelled) return;
                if (res.ok) {
                    // replace(), not push(), so Back does not return to this page.
                    router.replace('/coordinator/portal');
                    return;
                }
                setPhase('invalid');
            } catch {
                credential = null;
                if (!cancelled) setPhase('offline');
            }
        })();

        return () => {
            cancelled = true;
            credential = null;
        };
    }, [router]);

    return (
        <main className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
            <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200 text-center">
                {phase === 'exchanging' && (
                    <>
                        <div
                            className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600"
                            role="status"
                            aria-label="Opening your coordinator portal"
                        />
                        <p className="mt-5 text-sm text-slate-600">Opening your coordinator portal…</p>
                    </>
                )}

                {phase === 'signedout' && (
                    <>
                        <h1 className="text-lg font-semibold text-slate-900">
                            You&apos;ve been logged out
                        </h1>
                        <p className="mt-3 text-sm text-slate-600">
                            Use your coordinator link to open the portal again.
                        </p>
                    </>
                )}

                {phase === 'invalid' && (
                    <>
                        <h1 className="text-lg font-semibold text-slate-900">
                            This coordinator link is no longer valid
                        </h1>
                        <p className="mt-3 text-sm text-slate-600">
                            Please ask your FreezerIQ contact for a new link.
                        </p>
                    </>
                )}

                {phase === 'offline' && (
                    <>
                        <h1 className="text-lg font-semibold text-slate-900">
                            We couldn&apos;t connect
                        </h1>
                        <p className="mt-3 text-sm text-slate-600">
                            Please check your connection and try again.
                        </p>
                    </>
                )}
            </div>
        </main>
    );
}
