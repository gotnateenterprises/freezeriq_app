'use client';
import { useState } from 'react';

/**
 * SF-2: soft menu-email capture for FIRST-TIME visitors only (the caller owns
 * that conditional). Posts { slug, email } to /api/public/menu-signup, which
 * always answers { success: true } — so this component can never expose
 * tenant or email enumeration through its visible states. No email is sent
 * from here.
 */
export function EmailCaptureCard({ slug }: { slug: string }) {
    const [email, setEmail] = useState('');
    const [done, setDone] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        const normalized = email.trim().toLowerCase();
        if (submitting || !/.+@.+\..+/.test(normalized)) return;
        setSubmitting(true);
        try {
            await fetch('/api/public/menu-signup', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ slug, email: normalized }),
            });
            setDone(true);
        } catch {
            // Network failure: stay on the form silently — never surface an
            // error that could distinguish tenants or addresses.
        } finally {
            setSubmitting(false);
        }
    };

    if (done) return <p className="mx-4 my-4 rounded-2xl bg-[var(--sf-soft)] p-4 text-center text-sm font-semibold">You&rsquo;re on the list! 🧡 Next week&rsquo;s menu is coming your way.</p>;
    return (
        <div className="mx-4 my-4 rounded-2xl border-2 border-dashed border-[var(--sf-line)] bg-[var(--sf-card)] p-4 text-center">
            <b className="font-serif text-sm font-normal">Not ready to order?</b>
            <p className="mb-2 mt-0.5 text-[11px] text-[var(--sf-muted)]">Get next week&rsquo;s menu in your inbox — no spam, just dinner ideas.</p>
            <div className="flex gap-1.5">
                <input value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" type="email"
                    className="min-w-0 flex-1 rounded-xl border border-[var(--sf-line)] bg-[var(--sf-ground)] px-3 py-2 text-xs" />
                <button onClick={submit} disabled={submitting}
                    className="flex-none rounded-xl bg-[var(--sf-ink)] px-3.5 py-2 text-xs font-extrabold text-white disabled:opacity-60">
                    {submitting ? 'Sending…' : 'Send it'}
                </button>
            </div>
        </div>
    );
}
