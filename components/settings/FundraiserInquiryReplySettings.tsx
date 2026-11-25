'use client';

/**
 * INQUIRY-REPLY-EXTRA-1 — Settings → Fundraisers → "Fundraiser Inquiry Reply".
 *
 * The tenant's ONE optional section in the automatic reply a volunteer receives after asking about a
 * fundraiser (owner decisions D8–D10): on/off, a heading, plain-text paragraphs, a live preview of the
 * COMPLETE email, and Save. Administrators only — everyone else sees why the card is read-only.
 *
 * The preview is rendered by the server with the same authority every sending path uses
 * (lib/inquiryReply.ts) and shown in a sandboxed frame. Previewing and saving send nothing; a saved section
 * applies to future inquiry replies only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mail, Save } from 'lucide-react';
import { toast } from 'sonner';
import {
    INQUIRY_REPLY_BODY_MAX,
    INQUIRY_REPLY_HEADING_MAX,
    parseInquiryReplyExtraInput,
} from '@/lib/inquiryReplyExtra';

interface Preview {
    subject: string;
    html: string;
}

const inputCls =
    'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white';

export default function FundraiserInquiryReplySettings() {
    const [loading, setLoading] = useState(true);
    const [adminOnly, setAdminOnly] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [heading, setHeading] = useState('');
    const [body, setBody] = useState('');
    const [saved, setSaved] = useState<{ enabled: boolean; heading: string; body: string } | null>(null);
    const [saving, setSaving] = useState(false);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const previewSeq = useRef(0);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/tenant/inquiry-reply', { cache: 'no-store' });
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                if (res.status === 403) {
                    setAdminOnly(true);
                    return;
                }
                if (!res.ok) {
                    toast.error(data?.error || 'Could not load the inquiry reply settings');
                    return;
                }
                const loaded = {
                    enabled: data.enabled === true,
                    heading: typeof data.heading === 'string' ? data.heading : '',
                    body: typeof data.body === 'string' ? data.body : '',
                };
                setEnabled(loaded.enabled);
                setHeading(loaded.heading);
                setBody(loaded.body);
                setSaved(loaded);
            } catch {
                if (!cancelled) toast.error('Could not load the inquiry reply settings');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const complete = heading.trim().length > 0 && body.trim().length > 0;
    const validation = parseInquiryReplyExtraInput({ enabled, heading, body });
    const dirty = !!saved && (saved.enabled !== enabled || saved.heading !== heading || saved.body !== body);

    // Live preview of the whole email. Debounced; the newest request wins.
    const refreshPreview = useCallback(async (next: { enabled: boolean; heading: string; body: string }) => {
        const seq = ++previewSeq.current;
        setPreviewing(true);
        try {
            const res = await fetch('/api/tenant/inquiry-reply/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(next),
            });
            const data = await res.json().catch(() => ({}));
            if (seq !== previewSeq.current) return;
            if (!res.ok) {
                setPreviewError(data?.error || 'Could not render the preview.');
                return;
            }
            setPreviewError(null);
            setPreview({ subject: data.subject, html: data.html });
        } catch {
            if (seq === previewSeq.current) setPreviewError('Could not render the preview.');
        } finally {
            if (seq === previewSeq.current) setPreviewing(false);
        }
    }, []);

    useEffect(() => {
        if (loading || adminOnly) return;
        // An incomplete section previews as "off", so the preview always shows a real email.
        const next = { enabled: enabled && complete, heading, body };
        const t = setTimeout(() => { void refreshPreview(next); }, 400);
        return () => clearTimeout(t);
    }, [loading, adminOnly, enabled, complete, heading, body, refreshPreview]);

    const save = async () => {
        if (!validation.ok) {
            toast.error(validation.error);
            return;
        }
        setSaving(true);
        try {
            const res = await fetch('/api/tenant/inquiry-reply', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, heading, body }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(data?.error || 'Could not save the inquiry reply settings');
                return;
            }
            const next = { enabled: data.enabled === true, heading: data.heading ?? '', body: data.body ?? '' };
            setEnabled(next.enabled);
            setHeading(next.heading);
            setBody(next.body);
            setSaved(next);
            toast.success(next.enabled ? 'Saved — future inquiry replies include your section.' : 'Saved — future inquiry replies use the standard email.');
        } catch {
            toast.error('Could not save the inquiry reply settings');
        } finally {
            setSaving(false);
        }
    };

    return (
        <section
            aria-labelledby="inquiry-reply-heading"
            data-inquiry-reply-settings="true"
            className="@container bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 sm:p-8 mt-8"
        >
            <div className="flex items-center gap-2 mb-2">
                <Mail size={20} className="text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
                <h3 id="inquiry-reply-heading" className="text-lg font-bold text-slate-900 dark:text-white text-adaptive">
                    Fundraiser Inquiry Reply
                </h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
                When someone asks about a fundraiser on your website, they automatically receive your standard
                introduction email. You can add one optional section of your own. It appears just before
                &ldquo;Ready to get a date on the calendar?&rdquo;. Changes apply to future inquiries only &mdash;
                nothing is sent from this page.
            </p>

            {loading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
            ) : adminOnly ? (
                <p className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2.5 text-sm text-slate-600 dark:text-slate-300">
                    Only an administrator can change the fundraiser inquiry reply.
                </p>
            ) : (
                <div className="grid grid-cols-1 @3xl:grid-cols-2 gap-6">
                    <div className="space-y-4 min-w-0">
                        <label className="flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4"
                                checked={enabled}
                                onChange={(e) => setEnabled(e.target.checked)}
                                aria-describedby="inquiry-reply-enabled-help"
                            />
                            <span>
                                <span className="block text-sm font-bold text-slate-800 dark:text-slate-100">Include my optional section</span>
                                <span id="inquiry-reply-enabled-help" className="block text-xs text-slate-500">
                                    Off: every inquiry gets the standard email, unchanged.
                                </span>
                            </span>
                        </label>

                        <div>
                            <label htmlFor="inquiry-reply-heading-input" className="mb-1 block text-xs font-bold text-slate-500">
                                Section heading
                            </label>
                            <input
                                id="inquiry-reply-heading-input"
                                className={inputCls}
                                value={heading}
                                maxLength={INQUIRY_REPLY_HEADING_MAX}
                                onChange={(e) => setHeading(e.target.value)}
                                placeholder="e.g. More ways to support your fundraiser"
                            />
                            <p className="mt-1 text-[11px] text-slate-400 text-right">{heading.length}/{INQUIRY_REPLY_HEADING_MAX}</p>
                        </div>

                        <div>
                            <label htmlFor="inquiry-reply-body-input" className="mb-1 block text-xs font-bold text-slate-500">
                                Message
                            </label>
                            <textarea
                                id="inquiry-reply-body-input"
                                className={`${inputCls} min-h-[180px]`}
                                value={body}
                                maxLength={INQUIRY_REPLY_BODY_MAX}
                                onChange={(e) => setBody(e.target.value)}
                                placeholder="Plain text. Leave a blank line between paragraphs."
                            />
                            <p className="mt-1 flex justify-between gap-2 text-[11px] text-slate-400">
                                <span>Plain text only — formatting and links are not supported.</span>
                                <span>{body.length}/{INQUIRY_REPLY_BODY_MAX}</span>
                            </p>
                        </div>

                        {enabled && !complete && (
                            <p role="status" className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                                Add a heading and a message to include your section.
                            </p>
                        )}
                        {!validation.ok && (enabled ? complete : true) && (
                            <p role="alert" className="text-xs font-semibold text-red-600 dark:text-red-400">{validation.error}</p>
                        )}

                        <div className="flex flex-wrap items-center gap-3">
                            <button
                                type="button"
                                onClick={save}
                                disabled={saving || !validation.ok || !dirty}
                                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
                            >
                                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                                Save settings
                            </button>
                            {!dirty && saved && <span className="text-xs text-slate-400">All changes saved</span>}
                        </div>
                    </div>

                    <div className="min-w-0">
                        <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-500">Email preview (sample inquiry)</span>
                            {previewing && <Loader2 size={13} className="animate-spin text-slate-400" aria-label="Updating preview" />}
                        </div>
                        <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                            <p className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 break-words">
                                <span className="font-bold">Subject:</span> {preview?.subject ?? '…'}
                            </p>
                            {previewError ? (
                                <p role="alert" className="px-3 py-4 text-xs text-red-600">{previewError}</p>
                            ) : (
                                <iframe
                                    title="Fundraiser inquiry reply preview"
                                    sandbox=""
                                    srcDoc={preview?.html ? `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.55;color:#0f172a;padding:4px 12px;">${preview.html}</div>` : ''}
                                    className="block w-full h-[520px] bg-white"
                                />
                            )}
                        </div>
                        <p className="mt-1 text-[11px] text-slate-400">
                            Shown for a fictional inquiry. Real replies use the person&rsquo;s first name and organization.
                        </p>
                    </div>
                </div>
            )}
        </section>
    );
}
