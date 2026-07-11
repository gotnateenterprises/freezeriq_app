'use client';
import { useEffect, useState } from 'react';

type Prefill = { customerId?: string; orgName?: string; goal?: number };

// ── generateInfoTemplate ─────────────────────────────────────────────────────
// Exact copy of the FIX-3 shared pattern from components/crm/FundraiserOverview.tsx
// (line 54-94). branding comes from GET /api/tenant/branding, same as FundraiserOverview.
// Do NOT simplify or modify this function.

const generateInfoTemplate = (name: string, bundles: any[], branding?: any) => {
    const sigName = branding?.business_name || 'Your Fundraiser Team';
    return {
        subject: `Getting started with your ${sigName} Fundraiser!`,
        html: `
<p>Hi ${name || 'there'}!</p>
<p>Thanks for your interest in a ${sigName} fundraiser! We are so excited to help you raise money and feed your community.</p>

<h3>Here is how it works (The Easy 1-2-3):</h3>
<ol>
    <li><strong>Choose Your Bundles:</strong> Take a look at the Bundles below and let us know which 2 Bundles you'd like to offer (e.g., Family Friendly & Keto).</li>
    <li><strong>Pick Your Date:</strong> Choose your desired delivery date, time and delivery location. We will confirm date if available or get back with an alternative date.</li>
    <li><strong>We Create Your Marketing:</strong> Once you decide, we will build a custom flyer, order tracking form, <em>plus</em> a personal online order page where supporters can order directly and a Coordinator Dashboard so you can track sales in real time!</li>
</ol>

<p>Please complete the short form below with all of the information we need to get you set up in our system and your custom marketing materials ready to go!</p>

<p>Warmly,<br>${sigName}</p>

<hr style="border: 1px dashed #ccc; margin: 20px 0;">

<h3>Fundraiser Information:</h3>
<p>
    <strong>Organization Name:</strong><br><br>
    <strong>Contact Name:</strong><br><br>
    <strong>Contact Email:</strong><br><br>
    <strong>Contact Phone:</strong><br><br>
    <strong>Make Checks Payable to:</strong><br><br>
    <strong>Delivery Date:</strong> ________________ <strong>Time:</strong> ________________<br><br>
    <strong>Pickup Location:</strong>
</p>

<h3>Choose 2 Bundles below:</h3>
${bundles.length > 0 ? `
<ul style="list-style: none; padding-left: 0;">
    ${bundles.map((b: any) => `<li style="margin-bottom: 8px;"><input type="checkbox" style="margin-right: 10px;"><strong>${b.name}</strong>: ${b.contents?.map((c: any) => c.recipe?.name).join(', ') || 'Various meals'}</li>`).join('')}
</ul>
` : '<p><em>(No bundles found for this season)</em></p>'}
`
    };
};

// ── 3-step header — PipelineStepper pattern (handoff line 434) ───────────────

const WIZARD_STEPS = ['1 \u00b7 Organization', '2 \u00b7 Campaign', '3 \u00b7 Launch Kit'];

function WizardStepper({ current }: { current: number }) {
    const idx = current - 1;
    return (
        <div className="flex overflow-x-auto rounded-2xl border border-slate-200 bg-white px-5 py-3.5 dark:border-slate-800 dark:bg-slate-900 mb-5">
            {WIZARD_STEPS.map((s, i) => (
                <div key={s} className="relative min-w-[100px] flex-1 text-center text-[10px] font-extrabold uppercase tracking-wide">
                    <span className={`relative z-10 mx-auto mb-1.5 block h-3 w-3 rounded-full ${
                        i < idx ? 'bg-emerald-500' : i === idx ? 'bg-indigo-600 ring-4 ring-indigo-100 dark:ring-indigo-950' : 'bg-slate-200 dark:bg-slate-700'
                    }`} />
                    {i < WIZARD_STEPS.length - 1 && (
                        <span className={`absolute left-[calc(50%+8px)] top-[5px] h-0.5 w-[calc(100%-16px)] ${i < idx ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
                    )}
                    <span className={i < idx ? 'text-emerald-700' : i === idx ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-400'}>{s}</span>
                </div>
            ))}
        </div>
    );
}

// ── Shared input label (handoff class pattern) ────────────────────────────────

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">
            {label}
            {children}
        </label>
    );
}

const inputCls = 'mt-1 block w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

// ── Main wizard — skeleton verbatim from handoff lines 440–538 ───────────────

export function StartFundraiserWizard({ prefill, onClose }: { prefill?: Prefill; onClose: () => void }) {
    const [step, setStep] = useState(prefill?.customerId ? 2 : 1);
    const [busy, setBusy] = useState(false);
    // Step 1 state
    const [org, setOrg] = useState({ name: prefill?.orgName ?? '', contact_name: '', contact_email: '', contact_phone: '' });
    const [existing, setExisting] = useState<any>(null);        // dup match
    const [useExistingId, setUseExistingId] = useState<string | null>(prefill?.customerId ?? null);
    const [useExistingName, setUseExistingName] = useState<string>(prefill?.orgName ?? '');
    // Step 2 state
    const year = new Date().getFullYear();
    const [camp, setCamp] = useState({ name: '', endDate: '', bundleGoal: prefill?.goal ?? 0 });
    const [bundles, setBundles] = useState<any[]>([]);          // filtered family/Serves-5 reps for checklist
    const [allBundles, setAllBundles] = useState<any[]>([]);    // full unfiltered list — used for Serves 2 pairing
    const [picked, setPicked] = useState<Set<string>>(new Set());
    // Step 3 state
    const [kit, setKit] = useState<any>(null);                  // { campaign, portalUrl, orderUrl, failures: string[] }
    // Branding — fetched same as FundraiserOverview (FIX-3 pattern)
    const [branding, setBranding] = useState<any>(null);
    // Email draft state
    const [emailDraft, setEmailDraft] = useState<{ subject: string; html: string } | null>(null);
    const [emailTo, setEmailTo] = useState('');
    const [emailSending, setEmailSending] = useState(false);
    const [emailSent, setEmailSent] = useState(false);

    // Fetch branding on mount (FIX-3: same pattern as FundraiserOverview line 252)
    useEffect(() => {
        fetch('/api/tenant/branding').then(r => r.json()).then(d => setBranding(d)).catch(() => {});
    }, []);

    // Dup-check while typing (Step 1).
    // GET /api/customers?type=organization returns only fundraiser_org/organization rows
    // (mapped to type 'Organization'/'Fundraiser' in the response). Without this param the
    // API returns only direct_customer (Individual) rows — useless for an org search.
    // The client-side type guard below remains as a safety layer on the typed result set.
    useEffect(() => {
        if (step !== 1 || org.name.trim().length < 3) { setExisting(null); return; }
        const t = setTimeout(async () => {
            const res = await fetch('/api/customers?type=organization', { cache: 'no-store' });
            const data = await res.json();
            const list = data.customers || data;
            const hit = list.find((c: any) =>
                (c.type === 'Organization' || c.type === 'Fundraiser') &&
                c.name?.toLowerCase().includes(org.name.trim().toLowerCase()));
            setExisting(hit ?? null);
        }, 350);
        return () => clearTimeout(t);
    }, [org.name, step]);

    // ── Helper: classify a serving_tier string as Serves 2 / couple ──────────
    // Uses the same check already established in /api/bundles/route.ts line 44-45.
    const isServes2Tier = (tier: string | null | undefined): boolean => {
        const t = (tier || '').toLowerCase().trim();
        return t.includes('couple') || t.includes('serves_2') || t.includes('serves 2') || t === 'serves_2';
    };

    // ── Helper: find the Serves 2 twin of a family bundle ────────────────────
    // Priority 1: SKU matching — look for `{familySku}-S2` with a Serves 2 tier.
    // Priority 2: Name matching — look for `{familyName} (Serves 2)` with a Serves 2 tier.
    // Safeguards: same business (allBundles already tenant-scoped), same catalog_id when
    // both records have one, must NOT be another family-tier bundle.
    const findServes2Twin = (family: any, allBundles: any[]): any | null => {
        // SKU-first
        const targetSku = `${family.sku}-S2`;
        const bySkuMatch = allBundles.filter(b =>
            b.sku === targetSku &&
            isServes2Tier(b.serving_tier) &&
            b.is_active !== false
        );
        if (bySkuMatch.length === 1) {
            const candidate = bySkuMatch[0];
            // catalog_id safeguard: if both records carry a catalog_id, they must match
            if (family.catalog_id && candidate.catalog_id && family.catalog_id !== candidate.catalog_id) return null;
            return candidate;
        }
        // Name fallback — exact `{name} (Serves 2)` only
        const targetName = `${family.name} (Serves 2)`;
        const byNameMatch = allBundles.filter(b =>
            b.name === targetName &&
            isServes2Tier(b.serving_tier) &&
            b.is_active !== false
        );
        if (byNameMatch.length === 1) {
            const candidate = byNameMatch[0];
            if (family.catalog_id && candidate.catalog_id && family.catalog_id !== candidate.catalog_id) return null;
            return candidate;
        }
        return null; // no safe unambiguous match
    };

    // Load bundle list when entering Step 2.
    // /api/bundles returns an array directly (not wrapped): each item has id, name,
    // menu_price, price, serving_tier, is_active, sku, catalog_id, contents[].
    // allBundlesRef stores the full unfiltered list for Serves 2 pairing at launch time.
    // The displayed checklist shows only active family/Serves-5 reps with a valid price.
    useEffect(() => {
        if (step !== 2) return;
        fetch('/api/bundles')
            .then(r => r.json())
            .then(d => {
                const list: any[] = Array.isArray(d) ? d : d.bundles ?? [];
                // Store full list for pairing during launch (Serves 2 records must be reachable)
                setAllBundles(list);
                // Checklist: active, non-couple/non-serves_2, effective price > 0
                const family = list.filter(b => {
                    if (b.is_active === false) return false;
                    if (isServes2Tier(b.serving_tier)) return false;
                    const effectivePrice = Number(b.menu_price ?? b.price ?? 0);
                    if (effectivePrice <= 0) return false;
                    return true;
                });
                setBundles(family);
                if (!camp.name) {
                    const resolvedName = useExistingName || org.name || '';
                    if (resolvedName) setCamp(c => ({ ...c, name: `${resolvedName} ${year} Fundraiser`.trim() }));
                }
            })
            .catch(() => { setBundles([]); setAllBundles([]); });
    }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

    // Step 3 orchestration — EXISTING endpoints, in order; partial failures collected
    const launch = async () => {
        setBusy(true);
        const failures: string[] = [];
        try {
            let customerId = useExistingId;
            if (!customerId) {
                const res = await fetch('/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...org, type: 'Organization' }) });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not create organization');
                customerId = data.id;
            }
            const cRes = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerId, name: camp.name, bundleGoal: camp.bundleGoal, endDate: camp.endDate }) });
            const campaign = await cRes.json();
            if (!cRes.ok) throw new Error(campaign.error || 'Could not create campaign');

            // ── Bundle pairing (Option B) ───────────────────────────────────────
            // For each selected family/Serves-5 bundle, resolve its Serves 2 twin via
            // SKU-first → name fallback. Both IDs go into the assignment payload.
            // If no safe twin is found, the family ID is kept but a named warning is
            // surfaced in the launch-kit failure area — campaign is never rolled back.
            const missingPairs: string[] = [];
            const resolvedIds = new Set<string>();
            for (const familyId of picked) {
                resolvedIds.add(familyId);
                const familyBundle = bundles.find((b: any) => b.id === familyId);
                if (familyBundle) {
                    const twin = findServes2Twin(familyBundle, allBundles);
                    if (twin) {
                        resolvedIds.add(twin.id);
                    } else {
                        // No safe Serves 2 match — surface by bundle name, do not guess
                        missingPairs.push(familyBundle.name);
                    }
                }
            }

            // PUT (not POST) — route only exports PUT for bundle assignment
            const bRes = await fetch(`/api/campaigns/${campaign.id}/bundles`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundleIds: [...resolvedIds] }),
            });
            if (!bRes.ok) failures.push('bundles');

            // Surface missing-pair warnings as named partial failures
            for (const name of missingPairs) {
                failures.push(`no-serves-2:${name}`);
            }

            const origin = window.location.origin;
            const portalUrl = campaign.portal_token ? `${origin}/coordinator/${campaign.portal_token}` : null;
            const orderUrl = branding?.business_slug && campaign.id
                ? `${origin}/shop/${branding.business_slug}/fundraiser/${campaign.id}`
                : null;

            // Pre-draft info-packet email using the shared FIX-3 template helper
            const firstName = useExistingId ? '' : org.contact_name ? org.contact_name.split(' ')[0] : '';
            const selectedBundles = bundles.filter((b: any) => picked.has(b.id));
            const draft = generateInfoTemplate(firstName, selectedBundles, branding);
            setEmailDraft(draft);
            if (!useExistingId && org.contact_email) setEmailTo(org.contact_email);

            setKit({ campaign, customerId, portalUrl, orderUrl, failures });
            setStep(3);
        } catch (e: any) {
            alert(e.message);
        } finally { setBusy(false); }
    };

    // Send info-packet — user-initiated only, NEVER auto-sent (handoff line 392)
    const sendEmail = async () => {
        if (!emailDraft || !emailTo.trim()) return;
        setEmailSending(true);
        try {
            const res = await fetch('/api/email/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: emailTo.trim(), subject: emailDraft.subject, html: emailDraft.html, context: 'info' }),
            });
            const data = await res.json();
            if (res.ok) setEmailSent(true);
            else alert(data.error || 'Failed to send email');
        } catch { alert('Failed to send email'); } finally { setEmailSending(false); }
    };

    // Flyer URL: /api/flyer/download uses ?token= (portal token), not ?campaignId=
    const flyerUrl = kit?.campaign?.portal_token
        ? `/api/flyer/download?token=${kit.campaign.portal_token}`
        : null;

    // ── RENDER ────────────────────────────────────────────────────────────────
    // Shell: fixed overlay + max-w-[620px] white rounded-2xl card (handoff line 524-525)
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="mx-auto w-full max-w-[620px] rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 max-h-[90vh] overflow-y-auto shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-black text-slate-900 dark:text-white">🚀 Start a Fundraiser</h2>
                    <button onClick={onClose} className="rounded-lg px-2.5 py-1.5 text-[12px] font-bold text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">✕</button>
                </div>

                {/* 3-step header (handoff line 434) */}
                <WizardStepper current={step} />

                {/* ── STEP 1: Organization ─────────────────────────────────── */}
                {step === 1 && (
                    <div className="space-y-4">
                        {/* Dup-check banner (handoff lines 402-408) */}
                        {existing && (
                            <div className="mb-3 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                                <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[13px] dark:bg-amber-950">
                                    ⚠️ <b>{existing.name}</b> already exists ({existing.contact_name}) —
                                    <button onClick={() => { setUseExistingId(existing.id); setUseExistingName(existing.name); setExisting(null); setStep(2); }} className="font-extrabold text-indigo-600">use existing</button>
                                </div>
                                <div className="px-3 py-2 text-[11px] text-slate-400">…or create new below</div>
                            </div>
                        )}

                        {/* Organization name input (handoff lines 411-413) */}
                        <FieldLabel label="Organization">
                            <input
                                id="wiz-org-name"
                                className={inputCls}
                                value={org.name}
                                onChange={e => setOrg(o => ({ ...o, name: e.target.value }))}
                                placeholder="e.g. Lincoln Elementary PTA"
                                autoFocus
                            />
                        </FieldLabel>

                        {/* Contact fields — 2×2 grid (handoff step 1 description line 528) */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <FieldLabel label="Contact Name">
                                <input id="wiz-contact-name" className={inputCls} value={org.contact_name} onChange={e => setOrg(o => ({ ...o, contact_name: e.target.value }))} placeholder="Jane Smith" />
                            </FieldLabel>
                            <FieldLabel label="Contact Email">
                                <input id="wiz-contact-email" type="email" className={inputCls} value={org.contact_email} onChange={e => setOrg(o => ({ ...o, contact_email: e.target.value }))} placeholder="jane@example.com" />
                            </FieldLabel>
                            <FieldLabel label="Contact Phone">
                                <input id="wiz-contact-phone" type="tel" className={inputCls} value={org.contact_phone} onChange={e => setOrg(o => ({ ...o, contact_phone: e.target.value }))} placeholder="(555) 000-0000" />
                            </FieldLabel>
                        </div>

                        <div className="flex justify-end pt-2">
                            <button
                                id="wiz-step1-next"
                                disabled={org.name.trim().length < 2}
                                onClick={() => setStep(2)}
                                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-black text-white shadow hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                Next: Campaign →
                            </button>
                        </div>
                    </div>
                )}

                {/* ── STEP 2: Campaign ─────────────────────────────────────── */}
                {step === 2 && (
                    <div className="space-y-4">
                        {/* Org label */}
                        <div className="rounded-xl bg-indigo-50 dark:bg-indigo-950 px-3 py-2 text-[13px] font-semibold text-indigo-700 dark:text-indigo-300">
                            🏫 {useExistingId ? useExistingName : org.name}
                            {useExistingId && <span className="ml-2 text-[11px] font-normal text-indigo-500">existing</span>}
                        </div>

                        {/* Campaign fields — name, end date, bundle goal */}
                        <FieldLabel label="Campaign Name">
                            <input id="wiz-camp-name" className={inputCls} value={camp.name} onChange={e => setCamp(c => ({ ...c, name: e.target.value }))} placeholder="e.g. Lincoln PTA 2026 Fundraiser" />
                        </FieldLabel>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <FieldLabel label="Order Deadline">
                                <input id="wiz-end-date" type="date" className={inputCls} value={camp.endDate} onChange={e => setCamp(c => ({ ...c, endDate: e.target.value }))} />
                            </FieldLabel>
                            <FieldLabel label="Bundle Goal">
                                <input id="wiz-bundle-goal" type="number" min={0} className={inputCls} value={camp.bundleGoal || ''} onChange={e => setCamp(c => ({ ...c, bundleGoal: Number(e.target.value) || 0 }))} placeholder="e.g. 50" />
                            </FieldLabel>
                        </div>

                        {/* GE-9 below-minimum amber warning (handoff line 529) */}
                        {camp.bundleGoal > 0 && camp.bundleGoal * 125 < 1250 && (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
                                ⚠️ Below your delivery minimum ({camp.bundleGoal} bundles × $125 = ${camp.bundleGoal * 125} — minimum $1,250)
                            </div>
                        )}

                        {/* GE-6 leaderboard toggle (handoff line 531) */}
                        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                            <input id="wiz-leaderboard" type="checkbox" className="rounded border-slate-300" />
                            Show a team leaderboard on the public scoreboard
                        </label>

                        {/* Bundle checklist — family/Serves-5 reps only */}
                        <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 mb-1">CHOOSE AVAILABLE BUNDLE OPTIONS</p>
                            <p className="text-[11px] text-slate-500 mb-2">Select the bundles the coordinator may choose from. They will choose 2, and both the Serves 5 and Serves 2 versions will automatically be included.</p>
                            {bundles.length === 0 ? (
                                <p className="text-[12px] text-slate-400">No active bundles available. Add bundles first.</p>
                            ) : (
                                <div className="space-y-1.5">
                                    {bundles.map((b: any) => (
                                        <label key={b.id} className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:has-[:checked]:bg-indigo-950 transition-colors">
                                            <input type="checkbox" checked={picked.has(b.id)} onChange={e => {
                                                setPicked(prev => { const n = new Set(prev); e.target.checked ? n.add(b.id) : n.delete(b.id); return n; });
                                            }} className="rounded border-slate-300" />
                                            {b.name} · ${Number(b.menu_price ?? b.price ?? 0).toFixed(2)}
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Footer — ghost Back + primary Create (handoff line 532) */}
                        <div className="flex items-center justify-between pt-2">
                            <button id="wiz-step2-back" onClick={() => { setUseExistingId(null); setUseExistingName(''); setStep(1); }} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">← Back</button>
                            <button
                                id="wiz-create-btn"
                                disabled={!camp.name.trim() || busy}
                                onClick={launch}
                                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-black text-white shadow hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                            >
                                {busy ? <><span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />Creating…</> : 'Create & build launch kit →'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── STEP 3: Launch Kit ───────────────────────────────────── */}
                {step === 3 && kit && (
                    <div className="space-y-4">
                        {/* Success banner (handoff lines 428-431) */}
                        <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
                            <b className="text-sm text-emerald-800 dark:text-emerald-200">🎉 Fundraiser created — launch kit ready</b>
                            <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">Everything below was generated automatically.</p>
                        </div>

                        {/* 2×2 kit cards (handoff lines 420-425 + render comment lines 533-534) */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {/* Coordinator portal (handoff lines 421-425) */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
                                <b className="text-[13px] text-slate-900 dark:text-white">🎯 Coordinator portal</b>
                                {kit.portalUrl ? (
                                    <>
                                        <p className="my-1 truncate font-mono text-[11px] text-slate-500">{kit.portalUrl}</p>
                                        <button id="wiz-copy-portal" onClick={() => navigator.clipboard?.writeText(kit.portalUrl)} className="rounded-lg bg-indigo-50 px-2.5 py-1.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900 mr-1.5 transition-colors">Copy link</button>
                                        <a href={kit.portalUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400">Open ↗</a>
                                    </>
                                ) : <p className="my-1 text-[11px] text-slate-400">Portal token unavailable</p>}
                            </div>

                            {/* Order page */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
                                <b className="text-[13px] text-slate-900 dark:text-white">🛍️ Order page</b>
                                {kit.orderUrl ? (
                                    <>
                                        <p className="my-1 truncate font-mono text-[11px] text-slate-500">{kit.orderUrl}</p>
                                        <button id="wiz-copy-order" onClick={() => navigator.clipboard?.writeText(kit.orderUrl)} className="rounded-lg bg-indigo-50 px-2.5 py-1.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900 mr-1.5 transition-colors">Copy link</button>
                                        <a href={kit.orderUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400">Open ↗</a>
                                    </>
                                ) : <p className="my-1 text-[11px] text-slate-400">Available once business slug is configured</p>}
                            </div>

                            {/* Flyer download — uses ?token= per actual route (not ?campaignId=) */}
                            <div className={`rounded-2xl border bg-white p-3.5 dark:bg-slate-900 ${kit.failures.includes('flyer') ? 'border-amber-300 dark:border-amber-700' : 'border-slate-200 dark:border-slate-800'}`}>
                                <b className="text-[13px] text-slate-900 dark:text-white">📄 Fundraiser flyer</b>
                                <p className="my-1 text-[11px] text-slate-500">PDF for print and email</p>
                                {flyerUrl
                                    ? <a id="wiz-flyer-download" href={flyerUrl} target="_blank" rel="noopener noreferrer" className="inline-block rounded-lg bg-indigo-50 px-2.5 py-1.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition-colors">Download PDF</a>
                                    : <span className="inline-block rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-700 dark:bg-amber-950 dark:text-amber-300">Retry — no portal token</span>}
                            </div>

                            {/* Tracking sheet */}
                            <div className={`rounded-2xl border bg-white p-3.5 dark:bg-slate-900 ${kit.failures.includes('tracking') ? 'border-amber-300 dark:border-amber-700' : 'border-slate-200 dark:border-slate-800'}`}>
                                <b className="text-[13px] text-slate-900 dark:text-white">📊 Tracking sheet</b>
                                <p className="my-1 text-[11px] text-slate-500">Excel order tracking form</p>
                                <TrackingSheetButton deadline={camp.endDate} orgName={useExistingName || org.name} onFailure={() => setKit((k: any) => k ? { ...k, failures: [...k.failures, 'tracking'] } : k)} />
                            </div>
                        </div>

                        {/* Info-packet email card (handoff line 535-536: NEVER auto-send) */}
                        {emailDraft && (
                            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
                                <b className="text-[13px] text-slate-900 dark:text-white">✉️ Info-packet email</b>
                                <p className="my-1 text-[11px] text-slate-500">Tenant-branded — review before sending.</p>
                                <div className="mt-2 space-y-2">
                                    <FieldLabel label="Send to">
                                        <input id="wiz-email-to" type="email" className={inputCls} value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="coordinator@example.com" />
                                    </FieldLabel>
                                    <p className="text-[11px] text-slate-400"><b>Subject:</b> {emailDraft.subject}</p>
                                    {emailSent ? (
                                        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950 px-3 py-2 text-[12px] font-bold text-emerald-700 dark:text-emerald-300">✓ Sent</div>
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            <button id="wiz-email-send" disabled={emailSending || !emailTo.trim()} onClick={sendEmail} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5">
                                                {emailSending ? <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Sending…</> : 'Send now'}
                                            </button>
                                            <button id="wiz-email-preview" onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.write(emailDraft.html); w.document.close(); } }} className="rounded-lg bg-slate-100 px-3 py-1.5 text-[12px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">Preview</button>
                                            <span className="self-center text-[11px] text-slate-400">or send later from the org profile</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Partial-failure notice — campaign NOT rolled back (handoff line 436) */}
                        {kit.failures.length > 0 && (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
                                ⚠️ Some items need attention:
                                {/* Retryable failures (bundles API, flyer, tracking) */}
                                {kit.failures.filter((f: string) => !f.startsWith('no-serves-2:')).map((f: string) => (
                                    <span key={f} className="inline-block ml-1 rounded bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 font-bold">{f} — retry</span>
                                ))}
                                {/* Named missing-pair warnings — not retryable from wizard */}
                                {kit.failures.filter((f: string) => f.startsWith('no-serves-2:')).map((f: string) => (
                                    <span key={f} className="inline-block ml-1 mt-0.5 rounded bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 font-bold">
                                        No Serves 2 match found for &quot;{f.slice('no-serves-2:'.length)}&quot;
                                    </span>
                                ))}
                                <p className="mt-1 text-[11px]">The campaign was created. Retry retryable items from the org profile. Missing Serves 2 pairs should be added manually in the bundle editor.</p>
                            </div>
                        )}

                        {/* Done — closes and refreshes dashboard (handoff render comment line 536) */}
                        <div className="flex flex-wrap gap-2 pt-1">
                            {kit.portalUrl && <a id="wiz-open-portal" href={kit.portalUrl} target="_blank" rel="noopener noreferrer" className="rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-black text-white shadow hover:bg-indigo-700 transition-colors">Open coordinator portal ↗</a>}
                            <a id="wiz-view-campaign" href={`/fundraisers/${kit.customerId}`} className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-[13px] font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">View campaign</a>
                            <button id="wiz-done" onClick={onClose} className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-[13px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">Done</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── TrackingSheetButton ───────────────────────────────────────────────────────
// Isolated: POST /api/documents/tracking-sheet → blob download

function TrackingSheetButton({ deadline, orgName, onFailure }: { deadline: string; orgName: string; onFailure: () => void }) {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const download = async () => {
        setBusy(true);
        try {
            const res = await fetch('/api/documents/tracking-sheet', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deadline: deadline || undefined, checks_payable_to: orgName || undefined }),
            });
            if (!res.ok) { setFailed(true); onFailure(); return; }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'tracking-sheet.xlsx';
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        } catch { setFailed(true); onFailure(); } finally { setBusy(false); }
    };
    if (failed) return <button id="wiz-tracking-retry" onClick={() => { setFailed(false); download(); }} className="inline-block rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-700 dark:bg-amber-950 dark:text-amber-300 hover:bg-amber-100 transition-colors">Retry download</button>;
    return <button id="wiz-tracking-download" disabled={busy} onClick={download} className="inline-block rounded-lg bg-indigo-50 px-2.5 py-1.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900 disabled:opacity-50 transition-colors">{busy ? 'Downloading…' : 'Download Excel'}</button>;
}
