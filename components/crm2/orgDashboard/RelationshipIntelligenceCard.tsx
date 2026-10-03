"use client";

/**
 * FR-ORG-DASHBOARD-1A — what happened last time, and who can be reached.
 *
 * The timing row is an INFERENCE from fundraiser dates and is labelled as one.
 * There is no stored preferred season anywhere in FreezerIQ, so no "Preferred
 * season" row exists here — an inference is never presented as something the
 * organization said.
 */

import type { DashboardIntelligence } from '@/lib/organizationDashboard';

function Row({ label, value, muted, sub }: { label: string; value: string; muted?: boolean; sub?: string | null }) {
    return (
        <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="shrink-0 text-xs font-bold text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="min-w-0 text-right">
                <span className={`block break-words text-sm tabular-nums ${muted ? 'font-bold text-slate-400 dark:text-slate-500' : 'font-black text-slate-900 dark:text-white'}`}>
                    {value}
                </span>
                {sub && (
                    // Each " · " segment stays whole, so a line never breaks inside "2 opted out".
                    <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        {sub.split(' · ').map((part, i) => (
                            <span key={i}>{i > 0 ? ' · ' : ''}<span className="whitespace-nowrap">{part}</span></span>
                        ))}
                    </span>
                )}
            </dd>
        </div>
    );
}

export function RelationshipIntelligenceCard({ intelligence }: { intelligence: DashboardIntelligence }) {
    const last = intelligence.lastFundraiser;
    return (
        <section
            aria-labelledby="org-intel-heading"
            className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900"
        >
            <h2 id="org-intel-heading" className="mb-1 text-[11px] font-black uppercase tracking-widest text-slate-400">
                Relationship Intelligence
            </h2>
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
                {last ? (
                    <>
                        <Row label="Last fundraiser" value={last.name} sub={last.dateLabel} />
                        <Row label="Last result" value={last.resultLabel} muted={last.resultLabel === 'No sales data recorded'} />
                        <Row
                            label="Last bundles"
                            value={last.bundleFamilies.length ? last.bundleFamilies.join(' · ') : 'Not recorded'}
                            muted={last.bundleFamilies.length === 0}
                        />
                        <Row label="Last supporters" value={last.supporterCount.toLocaleString('en-US')} />
                    </>
                ) : intelligence.legacyHistoryNote ? (
                    // DATA-CLEANUP-GUARDS-1A.1: the last fundraiser exists only as a legacy
                    // paid record with no campaign — not "None yet", and nothing invented.
                    <Row label="Last fundraiser" value="Legacy record" muted sub={intelligence.legacyHistoryNote} />
                ) : (
                    <Row label="Last fundraiser" value="None yet" muted />
                )}
                <Row label="Historical pattern" value={intelligence.timing.label} muted={intelligence.timing.muted} />
                <Row label="Supporters on file" value={intelligence.supportersOnFile.toLocaleString('en-US')} />
                <Row
                    label="Email-ready"
                    value={intelligence.emailReady.toLocaleString('en-US')}
                    sub={intelligence.emailReadyBreakdown}
                />
            </dl>
            <p className="mt-3 text-[11px] font-medium leading-snug text-slate-500 dark:text-slate-400">
                {last
                    ? 'The pattern is read from past fundraiser dates — it is not a preference the organization has stated. Supporters are matched by email or phone, never by name.'
                    : intelligence.legacyHistoryNote
                        ? 'These rows fill in from campaign records. This organization’s earlier fundraiser history is on file without one.'
                        : 'Relationship intelligence fills in after the first fundraiser closes.'}
            </p>
        </section>
    );
}
