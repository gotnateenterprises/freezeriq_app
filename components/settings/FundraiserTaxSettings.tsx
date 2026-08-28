'use client';

/**
 * FR-TAX-1B — the tenant-facing control for the default food/grocery tax rate.
 *
 * The API (GET/PUT /api/tenant/tax-settings) shipped in FR-TAX-1; this is the
 * normal Settings surface for it, so configuring a rate never requires the
 * owner to call an endpoint by hand.
 *
 * The displayed value is always the CONFIGURED one, read from the server. There
 * is no hardcoded 1%: Illinois eliminated its statewide 1% grocery tax on
 * 2026-01-01, and any local 1% is a rate this tenant verifies and enters.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Receipt, Loader2 } from 'lucide-react';
import { parseTaxRatePercent, MIN_TAX_RATE_PERCENT, MAX_TAX_RATE_PERCENT } from '@/lib/fundraiserTax';

export const DEFAULT_FOOD_TAX_HELPER_TEXT =
    'Used as the default for new taxable fundraiser campaigns. Existing campaigns keep their saved tax rate.';

export default function FundraiserTaxSettings() {
    const [rate, setRate] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/tenant/tax-settings', { cache: 'no-store' });
                const data = await res.json().catch(() => ({}));
                if (!cancelled && res.ok && data?.defaultFoodTaxPercent !== undefined) {
                    setRate(String(data.defaultFoodTaxPercent));
                }
            } catch {
                if (!cancelled) toast.error('Could not load your tax settings');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Client-side check is a convenience; the server re-validates and is the
    // only thing that decides.
    const parsed = parseTaxRatePercent(rate);
    const error = rate.trim() === '' ? null : (parsed.ok ? null : parsed.error);

    async function handleSave() {
        if (error) { toast.error(error); return; }
        setSaving(true);
        try {
            const res = await fetch('/api/tenant/tax-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaultFoodTaxPercent: rate }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to save');
            setRate(String(data.defaultFoodTaxPercent));
            toast.success('Default food tax rate saved');
        } catch (e: any) {
            toast.error(e?.message || 'Failed to save tax settings');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 mt-8">
            <div className="flex items-center gap-2 mb-6">
                <Receipt size={20} className="text-indigo-600 dark:text-indigo-400" />
                <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive">
                    Fundraiser Tax
                </h3>
            </div>

            <div className="p-4 bg-slate-50/50 dark:bg-slate-900/30 rounded-xl border border-slate-100 dark:border-slate-800">
                <label htmlFor="default-food-tax-percent" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Default Food Tax Rate
                </label>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                    {DEFAULT_FOOD_TAX_HELPER_TEXT}
                </p>

                <div className="flex items-center gap-2">
                    <input
                        id="default-food-tax-percent"
                        type="number"
                        min={MIN_TAX_RATE_PERCENT}
                        max={MAX_TAX_RATE_PERCENT}
                        step={0.01}
                        disabled={loading || saving}
                        value={loading ? '' : rate}
                        placeholder={loading ? 'Loading…' : '0.00'}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? 'default-food-tax-error' : undefined}
                        onChange={(e) => setRate(e.target.value)}
                        className="w-32 px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 font-bold disabled:opacity-50"
                    />
                    <span className="text-sm font-bold text-slate-500 dark:text-slate-400">%</span>

                    <button
                        onClick={handleSave}
                        disabled={loading || saving || error !== null}
                        className="ml-2 flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>

                {error && (
                    <p id="default-food-tax-error" role="alert" className="mt-2 text-[12px] font-bold text-red-600 dark:text-red-400">
                        {error}
                    </p>
                )}
            </div>
        </div>
    );
}
