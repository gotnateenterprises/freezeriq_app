"use client";

/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0B — "Organization mailing address", in Organization
 * Details.
 *
 * The organization is the designated sender of its fundraiser emails; this is the
 * physical address their footers carry. Deliberately separate from the Contact
 * Profile's delivery address and from any fundraiser's pickup location, and saved
 * through its own route (/api/customers/[id]/mailing-address), which writes only
 * these five fields.
 */

import { useEffect, useState } from 'react';
import { Edit2, Mailbox } from 'lucide-react';

export interface MailingAddressFields {
    line1: string;
    line2: string;
    city: string;
    state: string;
    postalCode: string;
}

const EMPTY: MailingAddressFields = { line1: '', line2: '', city: '', state: '', postalCode: '' };

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function OrganizationMailingAddressCard({ organizationId }: { organizationId: string }) {
    const [saved, setSaved] = useState<MailingAddressFields | null>(null);
    const [complete, setComplete] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<MailingAddressFields>(EMPTY);
    const [state, setState] = useState<SaveState>('idle');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(`/api/customers/${encodeURIComponent(organizationId)}/mailing-address`, { credentials: 'same-origin' });
                if (!res.ok) return;
                const json = await res.json();
                if (!alive) return;
                setSaved(json.mailingAddress ?? EMPTY);
                setComplete(!!json.complete);
            } catch { /* the card shows "Not on file" */ }
        })();
        return () => { alive = false; };
    }, [organizationId]);

    async function save() {
        if (state === 'saving') return;
        setState('saving');
        setError(null);
        try {
            const res = await fetch(`/api/customers/${encodeURIComponent(organizationId)}/mailing-address`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(draft),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                setState('error');
                setError(json?.error || 'The mailing address could not be saved.');
                return;
            }
            setSaved(json.mailingAddress ?? EMPTY);
            setComplete(!!json.complete);
            setEditing(false);
            setState('saved');
        } catch {
            setState('error');
            setError('The mailing address could not be saved.');
        }
    }

    return (
        <MailingAddressCardView
            saved={saved}
            complete={complete}
            editing={editing}
            draft={draft}
            state={state}
            error={error}
            onEdit={() => { setDraft(saved ?? EMPTY); setError(null); setState('idle'); setEditing(true); }}
            onCancel={() => { setEditing(false); setError(null); setState('idle'); }}
            onChange={(field, value) => setDraft((d) => ({ ...d, [field]: value }))}
            onSave={save}
        />
    );
}

/** Hookless: renders from props alone. */
export function MailingAddressCardView(props: {
    saved: MailingAddressFields | null;
    complete: boolean;
    editing: boolean;
    draft: MailingAddressFields;
    state: SaveState;
    error: string | null;
    onEdit: () => void;
    onCancel: () => void;
    onChange: (field: keyof MailingAddressFields, value: string) => void;
    onSave: () => void;
}) {
    const s = props.saved;
    const hasAny = !!s && [s.line1, s.line2, s.city, s.state, s.postalCode].some((v) => v && v.trim());
    const field = (key: keyof MailingAddressFields, label: string, extra: { autoComplete: string; maxLength: number; className?: string; placeholder?: string }) => (
        <div className={extra.className ?? ''}>
            <label htmlFor={`org-mailing-${key}`} className="mb-1 block text-[11px] font-bold text-slate-500">{label}</label>
            <input
                id={`org-mailing-${key}`}
                type="text"
                value={props.draft[key]}
                onChange={(e) => props.onChange(key, e.target.value)}
                autoComplete={extra.autoComplete}
                maxLength={extra.maxLength}
                placeholder={extra.placeholder}
                className="w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
        </div>
    );

    return (
        <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-1 flex items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-black text-slate-900 dark:text-white">
                    <Mailbox size={15} aria-hidden="true" /> Organization mailing address
                </h3>
                {!props.editing && (
                    <button
                        type="button"
                        onClick={props.onEdit}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                    >
                        <Edit2 size={13} aria-hidden="true" /> {hasAny ? 'Edit' : 'Add'}
                    </button>
                )}
            </div>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Used in fundraiser email footer information. Not the delivery address, and not a fundraiser&rsquo;s pickup location.
            </p>

            {!props.editing && (
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {hasAny && s ? (
                        <address className="not-italic break-words">
                            {s.line1}{s.line1 ? <br /> : null}
                            {s.line2}{s.line2 ? <br /> : null}
                            {[s.city, [s.state, s.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
                        </address>
                    ) : <span className="text-slate-400">Not on file</span>}
                    {!props.complete && (
                        <p className="mt-2 text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                            Prepared fundraiser emails stay unavailable until a complete mailing address is on file.
                        </p>
                    )}
                    {props.state === 'saved' && <p aria-live="polite" className="mt-2 text-[12px] font-semibold text-emerald-700">Saved</p>}
                </div>
            )}

            {props.editing && (
                <form
                    className="grid grid-cols-1 gap-2 sm:grid-cols-6"
                    onSubmit={(e) => { e.preventDefault(); props.onSave(); }}
                >
                    {field('line1', 'Street address', { autoComplete: 'address-line1', maxLength: 120, className: 'sm:col-span-6' })}
                    {field('line2', 'Address line 2 (optional)', { autoComplete: 'address-line2', maxLength: 120, className: 'sm:col-span-6' })}
                    {field('city', 'City', { autoComplete: 'address-level2', maxLength: 80, className: 'sm:col-span-3' })}
                    {field('state', 'State', { autoComplete: 'address-level1', maxLength: 2, className: 'sm:col-span-1', placeholder: 'IL' })}
                    {field('postalCode', 'ZIP code', { autoComplete: 'postal-code', maxLength: 10, className: 'sm:col-span-2' })}
                    {props.error && (
                        <p role="alert" className="sm:col-span-6 rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                            {props.error}
                        </p>
                    )}
                    <div className="flex flex-wrap justify-end gap-2 sm:col-span-6">
                        <button type="button" onClick={props.onCancel} className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                            Cancel
                        </button>
                        <button type="submit" disabled={props.state === 'saving'} className="min-h-[44px] rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                            {props.state === 'saving' ? 'Saving…' : 'Save mailing address'}
                        </button>
                    </div>
                </form>
            )}
        </div>
    );
}

export default OrganizationMailingAddressCard;
