"use client";

import { useState, useEffect } from 'react';
import { X, Eye, Calendar } from 'lucide-react';
import { generateGoogleCalendarUrl } from '@/lib/google_calendar';

interface FundraiserSetupProps {
    customer: any;
    onSave: (data: any) => Promise<void>;
    allowCancel?: boolean;
    onCancel?: () => void;
    onPreview?: (data: any) => Promise<void>;
    onPreviewTracker?: (data: any) => Promise<void>;
}

export default function FundraiserSetup({ customer, onSave, allowCancel, onCancel, onPreview, onPreviewTracker }: FundraiserSetupProps) {
    // Fundraiser Info State
    const [fundraiserInfo, setFundraiserInfo] = useState({
        deadline: customer.fundraiser_info?.deadline || '',
        deadline_time: customer.fundraiser_info?.deadline_time || '4:00 PM',
        delivery_date: customer.fundraiser_info?.delivery_date || '',
        delivery_time: customer.fundraiser_info?.delivery_time || '4:45 PM',
        pickup_location: customer.fundraiser_info?.pickup_location || '',
        checks_payable_to: customer.fundraiser_info?.checks_payable_to || customer.name,
        flyer_details: customer.fundraiser_info?.flyer_details || '', // NEW FIELD
        bundle1_recipes: customer.fundraiser_info?.bundle1_recipes || '',
        bundle2_recipes: customer.fundraiser_info?.bundle2_recipes || '',
        bundle1_name: customer.fundraiser_info?.bundle1_name || '', // NEW: Store Bundle Name
        bundle2_name: customer.fundraiser_info?.bundle2_name || '', // NEW: Store Bundle Name
        participant_label: customer.fundraiser_info?.participant_label || '', // NEW: Participant Label
        // Prices removed
    });

    const [allRecipes, setAllRecipes] = useState<any[]>([]);
    const [bundles, setBundles] = useState<any[]>([]);
    const [selectedBundleToLoad, setSelectedBundleToLoad] = useState<any>(null);
    const [recipeSearch, setRecipeSearch] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    // Fetch recipes and bundles on mount
    useEffect(() => {
        Promise.all([
            fetch('/api/recipes').then(res => res.json()),
            fetch('/api/bundles?full=true').then(res => res.json())
        ]).then(([recipesData, bundlesData]) => {
            if (recipesData.recipes) setAllRecipes(recipesData.recipes);
            // API returns { bundles: [...], catalogs: [...] } when full=true
            if (bundlesData.bundles && Array.isArray(bundlesData.bundles)) {
                setBundles(bundlesData.bundles);
            } else if (Array.isArray(bundlesData)) {
                setBundles(bundlesData);
            }
        }).catch(err => console.error("Failed to fetch data", err));
    }, []);

    const filteredRecipes = recipeSearch
        ? allRecipes.filter(r => r.name.toLowerCase().includes(recipeSearch.toLowerCase())).slice(0, 10)
        : [];

    const addToBundle = (bundleNum: number, recipeName: string) => {
        const key = bundleNum === 1 ? 'bundle1_recipes' : 'bundle2_recipes';
        const current = (fundraiserInfo as any)[key] || '';
        const newValue = current ? current + '\n' + recipeName : recipeName;

        setFundraiserInfo(prev => ({ ...prev, [key]: newValue }));
        setRecipeSearch(''); // Clear search after add
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            console.log("Saving Fundraiser Info:", fundraiserInfo);
            await onSave(fundraiserInfo);
            alert("Fundraiser details saved successfully!");
        } catch (e) {
            console.error("Save failed:", e);
            alert("Failed to save changes.");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 w-full relative">
            <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2">Fundraiser Details</h3>
            <p className="text-slate-500 mb-6">Enter these details to auto-fill the sales sheet.</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Order Deadline</label>
                        <input
                            type="date"
                            value={fundraiserInfo.deadline}
                            onChange={e => setFundraiserInfo({ ...fundraiserInfo, deadline: e.target.value })}
                            className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                        />
                    </div>
                    <div className="w-1/3">
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Time</label>
                        <input
                            type="text"
                            value={fundraiserInfo.deadline_time}
                            onChange={e => setFundraiserInfo({ ...fundraiserInfo, deadline_time: e.target.value })}
                            className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                        />
                    </div>
                </div>
                <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Delivery Date</label>
                        <input
                            type="date"
                            value={fundraiserInfo.delivery_date}
                            onChange={e => setFundraiserInfo({ ...fundraiserInfo, delivery_date: e.target.value })}
                            className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                        />
                    </div>
                    <div className="w-1/3">
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Time</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={fundraiserInfo.delivery_time}
                                onChange={e => setFundraiserInfo({ ...fundraiserInfo, delivery_time: e.target.value })}
                                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                            />
                            <button
                                onClick={() => {
                                    if (!fundraiserInfo.delivery_date) {
                                        alert("Please enter a delivery date first.");
                                        return;
                                    }
                                    const title = `Fundraiser Delivery: ${customer.name}`;
                                    const desc = `Bundles:\n${fundraiserInfo.bundle1_name || 'Bundle 1'}\n${fundraiserInfo.bundle2_name || 'Bundle 2'}\n\nCheck Payable To: ${fundraiserInfo.checks_payable_to}`;
                                    const url = generateGoogleCalendarUrl(
                                        title,
                                        fundraiserInfo.delivery_date,
                                        fundraiserInfo.delivery_time,
                                        fundraiserInfo.pickup_location,
                                        desc
                                    );
                                    if (url) window.open(url, '_blank');
                                    else alert("Invalid date/time format.");
                                }}
                                title="Add to Google Calendar"
                                className="p-3 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50 rounded-xl transition-colors border border-indigo-200 dark:border-indigo-800"
                            >
                                <Calendar size={20} />
                            </button>
                        </div>
                    </div>
                </div>
                <div>
                    <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Pickup Location</label>
                    <input
                        type="text"
                        placeholder="e.g. High School Cafeteria"
                        value={fundraiserInfo.pickup_location}
                        onChange={e => setFundraiserInfo({ ...fundraiserInfo, pickup_location: e.target.value })}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                    />
                </div>
                <div>
                    <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Make Checks Payable To</label>
                    <input
                        type="text"
                        value={fundraiserInfo.checks_payable_to}
                        onChange={e => setFundraiserInfo({ ...fundraiserInfo, checks_payable_to: e.target.value })}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                    />
                </div>
            </div>

            <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Flyer Details / Extra Notes</label>
                    <textarea
                        value={fundraiserInfo.flyer_details}
                        onChange={e => setFundraiserInfo({ ...fundraiserInfo, flyer_details: e.target.value })}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-medium h-24"
                        placeholder="Enter any other details needed for the flyer (e.g. detailed instructions, pricing notes, etc.)"
                    />
                </div>
                <div>
                    <label className="block text-xs font-bold uppercase text-slate-400 mb-1">Participant Label (Optional)</label>
                    <input
                        type="text"
                        value={fundraiserInfo.participant_label || ''}
                        // @ts-ignore
                        onChange={e => setFundraiserInfo({ ...fundraiserInfo, participant_label: e.target.value })}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                        placeholder="e.g. Student Name, Athlete, Scout..."
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                        If set, customers will be asked "Which [Label] are you supporting?". Leave blank to disable.
                    </p>
                </div>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
                <h4 className="font-bold text-slate-900 dark:text-white mb-2">Bundle Menus</h4>

                <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Recipe Search Helper */}
                    <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-800">
                        <label className="block text-xs font-bold uppercase text-indigo-500 mb-2">Detailed Recipe Search</label>
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Search individual recipes..."
                                value={recipeSearch}
                                onChange={e => setRecipeSearch(e.target.value)}
                                className="w-full p-2 pl-3 rounded-lg border border-slate-200 dark:border-slate-700 text-sm"
                            />
                            {recipeSearch && (
                                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl z-10 max-h-48 overflow-y-auto">
                                    {filteredRecipes.length > 0 ? (
                                        filteredRecipes.map(r => (
                                            <div key={r.id} className="p-2 hover:bg-slate-50 dark:hover:bg-slate-700 flex justify-between items-center text-sm border-b border-slate-100 dark:border-slate-700 last:border-0">
                                                <span className="font-medium text-slate-700 dark:text-slate-200 truncate pr-2 flex-1">{r.name}</span>
                                                <div className="flex gap-1 shrink-0">
                                                    <button
                                                        onClick={() => addToBundle(1, r.name)}
                                                        className="px-2 py-1 bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300 text-xs rounded hover:bg-indigo-200"
                                                    >
                                                        + B1
                                                    </button>
                                                    <button
                                                        onClick={() => addToBundle(2, r.name)}
                                                        className="px-2 py-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 text-xs rounded hover:bg-emerald-200"
                                                    >
                                                        + B2
                                                    </button>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="p-2 text-xs text-slate-400 text-center">No recipes found</div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Bundle Auto-Fill */}
                    <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-xl border border-purple-100 dark:border-purple-800">
                        <label className="block text-xs font-bold uppercase text-purple-500 mb-2">Load From Bundle</label>
                        <div className="flex gap-2">
                            <select
                                className="flex-1 p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm bg-white dark:bg-slate-800"
                                onChange={(e) => {
                                    const bundleId = e.target.value;
                                    if (!bundleId) return;
                                    const bundle = bundles.find(b => b.id === bundleId);
                                    if (bundle) {
                                        setSelectedBundleToLoad(bundle);
                                    }
                                }}
                                value={selectedBundleToLoad?.id || ''}
                            >
                                <option value="">Select a Bundle...</option>
                                {bundles.map(b => (
                                    <option key={b.id} value={b.id}>{b.name} ({b._count?.contents || 0} items)</option>
                                ))}
                            </select>
                        </div>
                        <div className="flex gap-2 mt-2">
                            <button
                                onClick={() => {
                                    if (selectedBundleToLoad) {
                                        const recipes = selectedBundleToLoad.contents.map((c: any) => c.recipe?.name).filter(Boolean).join('\n');
                                        setFundraiserInfo(prev => ({
                                            ...prev,
                                            bundle1_recipes: recipes,
                                            bundle1_name: selectedBundleToLoad.name // Save Name
                                        }));
                                    }
                                }}
                                disabled={!selectedBundleToLoad}
                                className="flex-1 py-1 bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300 text-xs rounded hover:bg-indigo-200 disabled:opacity-50 font-bold"
                            >
                                Fill Bundle 1
                            </button>
                            <button
                                onClick={() => {
                                    if (selectedBundleToLoad) {
                                        const recipes = selectedBundleToLoad.contents.map((c: any) => c.recipe?.name).filter(Boolean).join('\n');
                                        setFundraiserInfo(prev => ({
                                            ...prev,
                                            bundle2_recipes: recipes,
                                            bundle2_name: selectedBundleToLoad.name // Save Name
                                        }));
                                    }
                                }}
                                disabled={!selectedBundleToLoad}
                                className="flex-1 py-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 text-xs rounded hover:bg-emerald-200 disabled:opacity-50 font-bold"
                            >
                                Fill Bundle 2
                            </button>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    {/* Bundle 1 Column */}
                    <div className="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col h-64">
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-2">Bundle 1 Recipes (5)</label>
                        <div className="flex-1 overflow-y-auto space-y-2 mb-2 pr-1">
                            {(fundraiserInfo.bundle1_recipes || '').split('\n').filter(Boolean).map((line: string, idx: number) => (
                                <div key={idx} className="flex items-center justify-between bg-white dark:bg-slate-800 p-2 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm text-sm group">
                                    <div className="flex items-center truncate mr-2">
                                        <span className="font-bold text-slate-400 mr-2 shrink-0">{idx + 1}.</span>
                                        <span className="truncate">{line}</span>
                                    </div>
                                    <button
                                        onClick={() => {
                                            const lines = (fundraiserInfo.bundle1_recipes || '').split('\n').filter(Boolean);
                                            lines.splice(idx, 1);
                                            setFundraiserInfo({ ...fundraiserInfo, bundle1_recipes: lines.join('\n') });
                                        }}
                                        className="text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}
                            {!(fundraiserInfo.bundle1_recipes) && <p className="text-xs text-slate-400 italic text-center mt-4">No recipes added yet</p>}
                        </div>
                        <input
                            type="text"
                            placeholder="+ Type custom item..."
                            className="w-full text-xs p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-1 focus:ring-indigo-500 outline-none"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const val = e.currentTarget.value.trim();
                                    if (val) addToBundle(1, val);
                                    e.currentTarget.value = '';
                                }
                            }}
                        />
                    </div>

                    {/* Bundle 2 Column */}
                    <div className="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col h-64">
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-2">Bundle 2 Recipes (5)</label>
                        <div className="flex-1 overflow-y-auto space-y-2 mb-2 pr-1">
                            {(fundraiserInfo.bundle2_recipes || '').split('\n').filter(Boolean).map((line: string, idx: number) => (
                                <div key={idx} className="flex items-center justify-between bg-white dark:bg-slate-800 p-2 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm text-sm group">
                                    <div className="flex items-center truncate mr-2">
                                        <span className="font-bold text-slate-400 mr-2 shrink-0">{idx + 1}.</span>
                                        <span className="truncate">{line}</span>
                                    </div>
                                    <button
                                        onClick={() => {
                                            const lines = (fundraiserInfo.bundle2_recipes || '').split('\n').filter(Boolean);
                                            lines.splice(idx, 1);
                                            setFundraiserInfo({ ...fundraiserInfo, bundle2_recipes: lines.join('\n') });
                                        }}
                                        className="text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}
                            {!(fundraiserInfo.bundle2_recipes) && <p className="text-xs text-slate-400 italic text-center mt-4">No recipes added yet</p>}
                        </div>
                        <input
                            type="text"
                            placeholder="+ Type custom item..."
                            className="w-full text-xs p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-1 focus:ring-emerald-500 outline-none"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const val = e.currentTarget.value.trim();
                                    if (val) addToBundle(2, val);
                                    e.currentTarget.value = '';
                                }
                            }}
                        />
                    </div>
                </div>
            </div>

            <div className="flex gap-3 justify-end mt-8">
                {onPreview && (
                    <button
                        onClick={() => onPreview(fundraiserInfo)}
                        className="px-4 py-2 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 font-bold rounded-xl flex items-center gap-2 border border-indigo-200"
                    >
                        Preview Flyer
                    </button>
                )}
                {onPreviewTracker && (
                    <button
                        onClick={() => onPreviewTracker(fundraiserInfo)}
                        className="px-4 py-2 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 font-bold rounded-xl flex items-center gap-2 border border-indigo-200"
                    >
                        <Eye size={16} />
                        Preview Tracker
                    </button>
                )}
                {allowCancel && onCancel && (
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 text-slate-500 font-bold hover:bg-slate-100 rounded-xl"
                    >
                        Cancel
                    </button>
                )}
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="px-6 py-2 bg-indigo-600 text-white font-bold rounded-xl shadow-lg hover:bg-indigo-700 hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
                >
                    {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
            </div>
        </div>
    );
}
