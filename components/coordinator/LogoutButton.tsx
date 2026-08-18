"use client";

/**
 * FR-COORD-SEC-1D-L — the coordinator logout control.
 *
 * A thin shell around `runCoordinatorLogout`: this file owns presentation and
 * the double-submit guard, and the module it calls owns the security-relevant
 * behaviour so that behaviour can be tested for real.
 *
 * Deliberately carries NO identifying data — no portal credential, no campaign
 * id, no session value. The session is an HttpOnly cookie this component cannot
 * read and must not try to.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { runCoordinatorLogout } from '@/lib/coordinatorLogout';

export function LogoutButton({ className = '' }: { className?: string }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    // FR-COORD-SEC-1D-L-R: the guard is a ref, not the state flag. Two clicks
    // dispatched in the same tick would both read the pre-render value of
    // `busy` and both get through; a ref is updated synchronously. `busy`
    // still drives what the button looks like.
    const inFlight = useRef(false);

    const handleLogout = async () => {
        // Logout is idempotent server-side, but a second in-flight request
        // would race the navigation for no benefit.
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);

        const outcome = await runCoordinatorLogout({
            fetchImpl: fetch,
            // replace(), not push(), so Back does not return to a portal the
            // coordinator can no longer load.
            navigate: (path) => router.replace(path),
            onError: (message) => toast.error(message),
        });

        // Stay latched through the navigation on success; release on failure so
        // the coordinator can try again.
        if (outcome === 'failed') {
            inFlight.current = false;
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            onClick={handleLogout}
            disabled={busy}
            aria-busy={busy}
            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold text-slate-600 transition-all hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
        >
            <LogOut size={16} aria-hidden="true" />
            {busy ? 'Logging out…' : 'Log out'}
        </button>
    );
}

export default LogoutButton;
