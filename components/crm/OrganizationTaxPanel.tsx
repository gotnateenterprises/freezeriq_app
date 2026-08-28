'use client';

/**
 * FR-TAX-1 — the organization's tax status, exemption number, and exemption
 * document, on the Fundraiser CRM organization record.
 *
 * The document is uploaded to, and downloaded from, an AUTHENTICATED
 * tenant-scoped route (/api/customers/[id]/tax-document). It never acquires a
 * public URL, so nothing here renders a link a logged-out visitor could follow.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { FileText, ShieldCheck, Upload, Download, Loader2 } from 'lucide-react';
import {
    ORG_TAX_STATUS_LABELS,
    ORG_TAX_STATUS_HELPER_TEXT,
    type OrgTaxStatus,
} from '@/lib/fundraiserTax';
import {
    TAX_DOCUMENT_ACCEPT_ATTRIBUTE,
    TAX_DOCUMENT_MAX_BYTES,
} from '@/lib/taxDocumentPolicy';

export interface OrganizationTaxDocumentMeta {
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    uploaded_at: string;
}

export interface OrganizationTaxPanelProps {
    organizationId: string;
    taxStatus: OrgTaxStatus;
    taxExemptionNumber: string;
    taxDocument: OrganizationTaxDocumentMeta | null;
    /** Persists status/number through the existing organization save path. */
    onSave: (updates: { tax_status: OrgTaxStatus; tax_exemption_number: string }) => Promise<void>;
    /** Re-reads the organization so a fresh document shows without a reload. */
    onDocumentChanged?: () => void;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OrganizationTaxPanel({
    organizationId,
    taxStatus,
    taxExemptionNumber,
    taxDocument,
    onSave,
    onDocumentChanged,
}: OrganizationTaxPanelProps) {
    const [status, setStatus] = useState<OrgTaxStatus>(taxStatus || 'UNKNOWN');
    const [exemptionNumber, setExemptionNumber] = useState(taxExemptionNumber || '');
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);

    const isExempt = status === 'TAX_EXEMPT';

    async function handleSave() {
        setSaving(true);
        try {
            await onSave({ tax_status: status, tax_exemption_number: exemptionNumber.trim() });
            toast.success('Tax status saved');
        } catch (e: any) {
            toast.error(e?.message || 'Failed to save tax status');
        } finally {
            setSaving(false);
        }
    }

    async function handleUpload(file: File) {
        if (file.size > TAX_DOCUMENT_MAX_BYTES) {
            toast.error(`That file is too large. The limit is ${Math.floor(TAX_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB.`);
            return;
        }
        setUploading(true);
        try {
            const form = new FormData();
            form.append('file', file);
            const res = await fetch(`/api/customers/${organizationId}/tax-document`, {
                method: 'POST',
                body: form,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Upload failed');
            toast.success('Exemption document saved');
            onDocumentChanged?.();
        } catch (e: any) {
            toast.error(e?.message || 'Failed to upload document');
        } finally {
            setUploading(false);
        }
    }

    return (
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2 mb-1">
                <ShieldCheck size={18} className="text-indigo-600" />
                <h3 className="text-lg font-black text-slate-900 dark:text-white">Tax Exemption</h3>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-5">{ORG_TAX_STATUS_HELPER_TEXT}</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label htmlFor="org-tax-status" className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                        Tax Status
                    </label>
                    <select
                        id="org-tax-status"
                        value={status}
                        onChange={(e) => setStatus(e.target.value as OrgTaxStatus)}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                    >
                        {(Object.keys(ORG_TAX_STATUS_LABELS) as OrgTaxStatus[]).map((s) => (
                            <option key={s} value={s}>{ORG_TAX_STATUS_LABELS[s]}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label htmlFor="org-tax-exemption-number" className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                        Exemption / E-number {isExempt ? '' : '(optional)'}
                    </label>
                    <input
                        id="org-tax-exemption-number"
                        type="text"
                        value={exemptionNumber}
                        onChange={(e) => setExemptionNumber(e.target.value)}
                        placeholder="e.g. E9999-9999-99"
                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                    />
                </div>
            </div>

            {/* Document — only meaningful once the tenant has said "exempt". */}
            <div className="mt-5 pt-5 border-t border-slate-100 dark:border-slate-700">
                <p className="text-[10px] font-bold uppercase text-slate-400 mb-2">Tax-exempt document</p>

                {taxDocument ? (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-4 py-3">
                        <FileText size={16} className="text-slate-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-slate-800 dark:text-slate-100">{taxDocument.filename}</p>
                            <p className="text-[11px] text-slate-500">
                                {formatBytes(taxDocument.size_bytes)} · uploaded {new Date(taxDocument.uploaded_at).toLocaleDateString()}
                            </p>
                        </div>
                        <a
                            href={`/api/customers/${organizationId}/tax-document`}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-600 px-3 py-2 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-700"
                        >
                            <Download size={14} /> Download
                        </a>
                    </div>
                ) : (
                    <p className="text-sm text-slate-400 italic mb-2">No exemption document on file.</p>
                )}

                <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 px-4 py-2.5 text-xs font-bold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100">
                    {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    {uploading ? 'Uploading…' : taxDocument ? 'Replace Document' : 'Upload Document'}
                    <input
                        type="file"
                        className="hidden"
                        accept={TAX_DOCUMENT_ACCEPT_ATTRIBUTE}
                        disabled={uploading}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleUpload(f);
                            e.currentTarget.value = '';
                        }}
                    />
                </label>
                <p className="mt-2 text-[10px] text-slate-400">
                    PDF, JPG or PNG, up to {Math.floor(TAX_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB. Stored privately —
                    only signed-in users of your business can open it.
                </p>
            </div>

            <div className="flex justify-end mt-5">
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-6 py-2 bg-indigo-600 text-white font-bold rounded-xl shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Save Tax Status'}
                </button>
            </div>
        </div>
    );
}
