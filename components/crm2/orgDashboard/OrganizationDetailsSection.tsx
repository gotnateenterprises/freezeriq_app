"use client";

/**
 * FR-ORG-DASHBOARD-1A — the organization's permanent records, below the
 * relationship view.
 *
 * Reuses the existing pieces unchanged: OrganizationTaxPanel (FR-TAX-1),
 * DocumentsTab (agreements and sales sheets), and the QuickBooks customer card,
 * which the PAGE passes in as `quickBooks` so it stays rendered on exactly the
 * two profile pages (QB-ORG-LINK-1). Contact Profile and Customer Notes keep the
 * behaviour they had: Contact opens the profile editor and can compose an email;
 * Notes save themselves through the page's existing organization save path.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Edit2, FileCheck, Mail, MapPin, Phone, StickyNote, User } from 'lucide-react';
import OrganizationTaxPanel from '@/components/crm/OrganizationTaxPanel';
import DocumentsTab from '@/components/crm/DocumentsTab';

type NotesState = 'idle' | 'saving' | 'saved' | 'error';

export function OrganizationDetailsSection({
    customer,
    notes,
    notesState,
    onNotesChange,
    onSaveTax,
    onTaxDocumentChanged,
    onEditProfile,
    onComposeEmail,
    quickBooks,
}: {
    customer: any;
    notes: string;
    notesState: NotesState;
    onNotesChange: (value: string) => void;
    onSaveTax: (updates: { tax_status: any; tax_exemption_number: string }) => Promise<void>;
    onTaxDocumentChanged: () => void;
    onEditProfile: () => void;
    onComposeEmail: () => void;
    quickBooks: ReactNode;
}) {
    const [documentsOpen, setDocumentsOpen] = useState(false);
    const isOrganization = customer?.type === 'Fundraiser' || customer?.type === 'Organization';

    return (
        <section aria-labelledby="org-details-heading" className="space-y-3">
            <h2 id="org-details-heading" className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                Organization Details
            </h2>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {isOrganization && (
                    <div className="min-w-0">
                        <OrganizationTaxPanel
                            organizationId={customer.id}
                            taxStatus={(customer.tax_status as any) || 'UNKNOWN'}
                            taxExemptionNumber={customer.tax_exemption_number || ''}
                            taxDocument={customer.tax_document || null}
                            onSave={onSaveTax}
                            onDocumentChanged={onTaxDocumentChanged}
                        />
                    </div>
                )}

                {/* ── Contact Profile ── */}
                <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-black text-slate-900 dark:text-white">Contact Profile</h3>
                        <button
                            type="button"
                            onClick={onEditProfile}
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                            <Edit2 size={13} aria-hidden="true" /> Edit
                        </button>
                    </div>
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                        <ContactRow icon={<User size={15} aria-hidden="true" />} label="Primary contact">
                            {customer.contact_name || <span className="text-slate-400">Not on file</span>}
                        </ContactRow>
                        <ContactRow icon={<Mail size={15} aria-hidden="true" />} label="Email">
                            {customer.email ? (
                                <button
                                    type="button"
                                    onClick={onComposeEmail}
                                    title="Write an email to this contact"
                                    className="break-all text-left font-bold text-indigo-600 hover:underline dark:text-indigo-400"
                                >
                                    {customer.email}
                                </button>
                            ) : <span className="text-slate-400">Not on file</span>}
                        </ContactRow>
                        <ContactRow icon={<Phone size={15} aria-hidden="true" />} label="Phone">
                            {customer.phone ? (
                                <a href={`tel:${customer.phone}`} className="font-bold text-indigo-600 hover:underline dark:text-indigo-400">
                                    {customer.phone}
                                </a>
                            ) : <span className="text-slate-400">Not on file</span>}
                        </ContactRow>
                        <ContactRow icon={<MapPin size={15} aria-hidden="true" />} label="Delivery address">
                            {customer.delivery_address || <span className="text-slate-400">Not on file</span>}
                        </ContactRow>
                    </ul>
                </div>

                {/* ── Customer Notes ── */}
                <div className="relative min-w-0 overflow-hidden rounded-2xl border border-yellow-200/60 bg-yellow-50/80 p-4 sm:p-5 dark:border-yellow-900/30 dark:bg-yellow-900/10">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <label htmlFor="org-customer-notes" className="flex items-center gap-2 text-sm font-black text-yellow-900 dark:text-yellow-100">
                            <StickyNote size={16} className="fill-yellow-400 text-yellow-600 dark:text-yellow-500" aria-hidden="true" />
                            Customer Notes
                        </label>
                        <span aria-live="polite" className="text-[11px] font-medium text-yellow-800/80 dark:text-yellow-200/70">
                            {notesState === 'saving' ? 'Saving…' : notesState === 'saved' ? 'Saved' : notesState === 'error' ? 'Not saved — try again' : 'Saves automatically'}
                        </span>
                    </div>
                    <textarea
                        id="org-customer-notes"
                        value={notes}
                        onChange={(e) => onNotesChange(e.target.value)}
                        className="h-36 w-full rounded-xl border border-yellow-200/60 bg-yellow-100/30 p-3 text-sm font-medium leading-relaxed text-yellow-900 transition-all focus:bg-white/50 focus:outline-none focus:ring-2 focus:ring-yellow-400/50 dark:border-yellow-700/30 dark:bg-yellow-900/20 dark:text-yellow-50 dark:focus:bg-yellow-900/40"
                        placeholder="Add preferences, allergies, or delivery notes here..."
                    />
                </div>

                <div className="min-w-0 space-y-4">
                    {/* The card brings its own top margin for the old tab layout; neutralised here
                        without touching the QuickBooks component itself. Renders nothing for
                        non-admins or when QuickBooks is unavailable. */}
                    <div className="empty:hidden [&>div]:mt-0">
                        {quickBooks}
                    </div>
                    {/* ── Documents ── */}
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900">
                        <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
                                <FileCheck size={16} aria-hidden="true" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <h3 className="text-sm font-black text-slate-900 dark:text-white">Documents &amp; Forms</h3>
                                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Agreements and sales sheets for this organization</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setDocumentsOpen((v) => !v)}
                                aria-expanded={documentsOpen}
                                aria-controls="org-documents-panel"
                                className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-200 px-3.5 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                                {documentsOpen ? <>Hide <ChevronUp size={13} aria-hidden="true" /></> : <>Open <ChevronDown size={13} aria-hidden="true" /></>}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {documentsOpen && (
                <div id="org-documents-panel" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
                    <DocumentsTab customer={customer} />
                </div>
            )}
        </section>
    );
}

function ContactRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
    return (
        <li className="flex items-start gap-3 py-2">
            <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {icon}
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
                <div className="break-words text-sm font-medium text-slate-900 dark:text-slate-100">{children}</div>
            </div>
        </li>
    );
}
