
"use client";

/**
 * The Bundle Editor (protected file — CLAUDE.md proposal-first; BUNDLE-EDITOR-UX-1 approved by the owner
 * 2026-11-25, see bundle-editor-ux-audit-1/BUNDLE-EDITOR-UX-AUDIT-1.md).
 *
 * Layout: one responsive editor. Two balanced columns when the editor itself is wide enough (a container
 * query, so the app sidebar is accounted for), one column otherwise.
 *   left   Bundle Image · Bundle Details · Advanced settings (collapsed: Catalog, SKU)
 *   last   Delete Bundle (existing bundles), after both columns on every screen size
 *   right  Bundle Contents · Bundle Poster Studio · Bundle Summary
 * Save Bundle: the header button on large screens, a sticky bar on small ones — one handler.
 *
 * What is sent on save is unchanged (lib/bundleEditorSave.ts): the same form values to the same routes.
 * Hidden or collapsed fields keep their values (Advanced is a native <details>, so its inputs stay in the
 * form). The never-saved Stock Quantity input is gone (the API never wrote it; the column is untouched).
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray } from 'react-hook-form';
import { Save, Trash, ArrowLeft, Search, DollarSign, Sparkles, Image as ImageIcon, Loader2, Download, Copy, Upload, Settings2, ChevronDown, Link2 } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useBundleImagePublished } from '@/lib/bundles/bundleImageEvents';
import { generateBundleSku, type SkuPlatform } from '@/lib/bundleSkuGenerator';
import { saveBundle } from '@/lib/bundleEditorSave';

interface BundleEditorProps {
    initialData: any;
    allRecipes: { id: string; name: string; type: string }[];
    knownTiers: string[];
    /** The Bundle Poster Studio for a saved bundle (rendered by the page); absent for a new bundle. */
    posterStudio?: ReactNode;
}

/** The anchor "Create Bundle Poster" moves to. Navigation only — nothing is generated or charged. */
export const POSTER_STUDIO_ANCHOR_ID = 'bundle-poster-studio';
export const DESCRIPTION_HELP = 'Customers on your storefront and fundraiser supporters may see this description.';
export const NEW_BUNDLE_POSTER_MESSAGE = 'Save this bundle with its recipes first. Then you can create a poster here from your recipes’ own photos — nothing is generated until you choose Generate.';

const CARD = 'bg-white dark:bg-slate-800 bg-adaptive p-4 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm';
const LABEL = 'block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1';
const FIELD = 'w-full min-w-0 px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white placeholder:text-slate-400';
const SAVE_BUTTON = 'items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-lg font-bold transition-colors shadow-md disabled:opacity-60';

export default function BundleEditor({ initialData, allRecipes, knownTiers = [], posterStudio }: BundleEditorProps) {
    const router = useRouter();
    const isNew = !initialData;
    const [searchTerm, setSearchTerm] = useState('');
    const [recipeCosts, setRecipeCosts] = useState<Record<string, number>>({});
    const [catalogs, setCatalogs] = useState<any[]>([]);
    const [isUploadingImage, setIsUploadingImage] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [skuPlatform, setSkuPlatform] = useState<SkuPlatform>('other');
    const bundleImageInputRef = useRef<HTMLInputElement>(null);
    const advancedRef = useRef<HTMLDetailsElement>(null);

    const { register, control, handleSubmit, watch, setValue, formState: { errors } } = useForm({
        defaultValues: initialData ? {
            name: initialData.name,
            sku: initialData.sku,
            description: initialData.description,
            serving_tier: initialData.serving_tier || 'family',
            catalog_id: initialData.catalog_id || '',
            image_url: initialData.image_url || '',
            price: initialData.price || '',
            is_active: initialData.is_active ?? true,
            show_on_storefront: initialData.show_on_storefront ?? false,
            // FR-SUPPORTER-ADDON-UPSELL-1 (S2): Meal bundle or Fundraiser add-on.
            bundle_type: initialData.bundle_type === 'addon' ? 'addon' : 'meal',
            order_cutoff_date: initialData.order_cutoff_date ? new Date(initialData.order_cutoff_date).toISOString().split('T')[0] : '',
            contents: initialData.contents.map((c: any) => ({
                recipe_id: c.recipe_id,
                name: c.recipe.name,
                quantity: c.quantity || 1.0
            }))
        } : {
            name: '',
            // BUNDLE-EDITOR-UX-1: left blank — a valid, unique SKU is created on save (lib/bundleEditorSave.ts).
            sku: '',
            description: '',
            serving_tier: 'family',
            catalog_id: '',
            image_url: '',
            price: '', // Default empty (will use calc if null)
            is_active: true,
            show_on_storefront: false,
            bundle_type: 'meal',
            order_cutoff_date: '',
            contents: []
        }
    });

    // FR-SUPPORTER-ADDON-UPSELL-1 (S2). A Fundraiser add-on (e.g. a Sides & Dessert Bundle) is offered on
    // a fundraiser only as an optional extra beside a meal bundle. It has ONE size (saved as 'family', an
    // existing tier — never a fake or zero tier), no Serves 2 version and no storefront listing. The
    // server enforces all of this (lib/bundleTypeRules.ts); the editor just stops offering what does not
    // apply. Contents, recipes, image, description and price work exactly as for a meal bundle.
    const isAddOn = watch('bundle_type') === 'addon';
    const chooseBundleType = (type: 'meal' | 'addon') => {
        setValue('bundle_type', type, { shouldDirty: true });
        if (type === 'addon') {
            setValue('serving_tier', 'family', { shouldDirty: true });
            setValue('show_on_storefront', false, { shouldDirty: true });
        }
    };

    const { fields, append, remove } = useFieldArray({
        control,
        name: 'contents'
    });

    // BUNDLE-POSTER-USE-AS-IMAGE-1. "Use as Bundle Image" in the poster panel below has already SAVED
    // the poster as this bundle's image; show it here and keep it in the form, so the next Save Bundle
    // sends the new image instead of putting the previous one back. Only this bundle's announcement counts.
    useBundleImagePublished(initialData?.id, (url) => setValue('image_url', url));

    // Fetch resources on mount
    useEffect(() => {
        async function fetchData() {
            try {
                // Costs
                const costRes = await fetch('/api/recipes/costs');
                if (costRes.ok) setRecipeCosts(await costRes.json());

                // Catalogs
                const catRes = await fetch('/api/catalogs');
                if (catRes.ok) setCatalogs(await catRes.json());
            } catch (e) {
                console.error('Failed to fetch data:', e);
            }
        }
        fetchData();
    }, []);

    // BUNDLE-MEDIA-1. Local-file upload — a Bundle-scoped sibling of
    // RecipeEditor's handleUploadImage, same upload-then-setValue shape.
    // image_url is only ever set on a SUCCESSFUL response, so a failed or
    // rejected upload leaves whatever image was already showing untouched
    // rather than flashing a broken/blank one.
    const handleUploadBundleImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            setIsUploadingImage(true);
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('/api/bundles/upload-image', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();
            if (res.ok && data.url) {
                setValue('image_url', data.url, { shouldDirty: true });
            } else {
                alert(data.error || 'Failed to upload image');
            }
        } catch (err: any) {
            console.error('Bundle Image Upload Error:', err);
            alert('Error uploading image');
        } finally {
            setIsUploadingImage(false);
            // Reset so choosing the same file again still fires onChange.
            e.target.value = '';
        }
    };

    const openAdvanced = () => {
        if (advancedRef.current) advancedRef.current.open = true;
    };

    const onSubmit = async (data: any) => {
        setIsSaving(true);
        try {
            const result = await saveBundle({ isNew, bundleId: initialData?.id ?? null, data });
            if (result.ok) {
                alert('Bundle Saved!');
                router.push('/bundles');
                router.refresh();
            } else {
                if (result.skuProblem) openAdvanced();
                alert(`Error: ${result.error}`);
            }
        } finally {
            setIsSaving(false);
        }
    };

    // A required field the tenant cannot see must never block a save silently.
    const onInvalid = (invalid: Record<string, unknown>) => {
        if (invalid.sku) openAdvanced();
    };
    const submit = handleSubmit(onSubmit, onInvalid);

    /** "Create Bundle Poster": move to the Poster Studio. Navigation only — no request, no AI charge. */
    const goToPosterStudio = () => {
        const target = document.getElementById(POSTER_STUDIO_ANCHOR_ID);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.focus({ preventScroll: true });
    };

    // The existing generator rules, in one shared helper (lib/bundleSkuGenerator.ts). Only on request.
    const generateSkuNow = (platform: SkuPlatform) => {
        setValue('sku', generateBundleSku({ platform, servingTier: watch('serving_tier'), bundleType: watch('bundle_type') }), { shouldDirty: true });
    };

    // Filter recipes for dropdown with Deduping by Name
    const filteredRecipes = useMemo(() => {
        const lowerSearch = searchTerm.toLowerCase();
        const seen = new Set();
        return allRecipes
            .filter(r => {
                const name = r.name.toLowerCase();
                if (!name.includes(lowerSearch)) return false;
                if (seen.has(name)) return false;
                seen.add(name);
                return true;
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [allRecipes, searchTerm]);

    const addRecipe = (recipeId: string, recipeName: string) => {
        append({ recipe_id: recipeId, name: recipeName, quantity: 1.0 });
        setSearchTerm(''); // Reset search
    };

    // Calculate financial metrics
    const financials = useMemo(() => {
        const contents = watch('contents') || [];
        const servingTier = watch('serving_tier') || 'family';
        const manualPrice = Number(watch('price')) || 0;

        // Calculate total cost (Family/Serves 5 base)
        const totalCost = contents.reduce((sum: number, item: any) => {
            const recipeCost = recipeCosts[item.recipe_id] || 0;
            const quantity = Number(item.quantity) || 1;
            return sum + (recipeCost * quantity);
        }, 0);

        // Determine selling price (an add-on has no serving-size default price)
        let sellingPrice = manualPrice;
        if (!sellingPrice && watch('bundle_type') !== 'addon') {
            const tierLower = servingTier.toLowerCase();
            if (tierLower.includes('family') || tierLower === 'family') {
                sellingPrice = 125.00;
            } else if (tierLower.includes('couple') || tierLower.includes('serves 2') || tierLower === 'couple') {
                sellingPrice = 60.00;
            }
        }

        // Adjust cost logic removed: Trust the actual sum of ingredients/recipes.
        const adjustedCost = totalCost;

        const profitMargin = sellingPrice - adjustedCost;
        const profitPercent = sellingPrice > 0 ? (profitMargin / sellingPrice) * 100 : 0;
        const foodCostPercent = sellingPrice > 0 ? (adjustedCost / sellingPrice) * 100 : 0;

        return {
            totalCost,
            adjustedCost,
            sellingPrice,
            profitMargin,
            profitPercent,
            foodCostPercent
        };
    }, [watch('contents'), watch('serving_tier'), watch('price'), watch('bundle_type'), recipeCosts]);


    const handleDuplicateAsServes2 = async () => {
        if (!initialData?.id) return;

        if (!confirm("Create a 'Serves 2' version of this bundle?\n\nThis will:\n1. Clone this bundle\n2. Rename it to '(Serves 2)'\n3. Switch all recipes to their '(Serves 2)' versions (if found)\n4. Set tier to 'serves_2'\n5. Link both bundles with a shared family ID")) return;

        try {
            const res = await fetch(`/api/bundles/${initialData.id}/duplicate-serves-2`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (res.ok) {
                const clone: { id: string; name: string; family_id: string } = await res.json();
                alert("Bundle Cloned Successfully!");
                router.push(`/bundles/${clone.id}`);
                router.refresh();
            } else {
                const err: { error: string; code?: string } = await res.json();
                alert(`Failed to clone: ${err.error}`);
            }
        } catch (e) {
            console.error('[BundleEditor] Duplicate as Serves 2 failed:', e);
            alert("Error cloning bundle.");
        }
    };

    const currentSku = (watch('sku') || '').trim();
    const currentCatalog = catalogs.find((c: any) => c.id === watch('catalog_id'));
    const advancedSummary = [
        currentSku ? `SKU ${currentSku}` : (isNew ? 'SKU created automatically when you save' : 'SKU missing'),
        !isAddOn && currentCatalog ? `Catalog: ${currentCatalog.name}` : null,
    ].filter(Boolean).join(' · ');

    return (
        <div className="@container max-w-6xl mx-auto space-y-6 pb-24 lg:pb-12">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <Link href="/bundles" className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-500 dark:text-slate-400 transition-colors shrink-0" aria-label="Back to bundles">
                        <ArrowLeft size={24} />
                    </Link>
                    <div className="min-w-0">
                        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white text-adaptive">{isNew ? 'New Bundle' : 'Edit Bundle'}</h1>
                        <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle">Define the contents of your meal kit.</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {!isNew && !isAddOn && (
                        <button
                            type="button"
                            onClick={handleDuplicateAsServes2}
                            className="flex items-center gap-2 px-4 py-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 rounded-lg font-bold transition-colors border border-indigo-100 dark:border-indigo-800"
                        >
                            <Copy size={18} />
                            Make Serves 2
                        </button>
                    )}
                    <button type="button" onClick={submit} disabled={isSaving} className={`hidden lg:inline-flex ${SAVE_BUTTON}`}>
                        {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                        Save Bundle
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 @4xl:grid-cols-2 gap-6 items-start">
                {/* ── Left column ─────────────────────────────────────────────────────────────── */}
                <div className="space-y-6 min-w-0">
                    {/* Bundle Image */}
                    <section className={`${CARD} space-y-3`} aria-labelledby="bundle-image-heading">
                        <h2 id="bundle-image-heading" className="text-lg font-bold text-slate-900 dark:text-white text-adaptive">Bundle Image</h2>
                        {/* BUNDLE-MEDIA-1: the primary, visible way to attach a
                            cover image — a local-file upload, not a URL the tenant
                            has to already have somewhere else. */}
                        <input
                            type="file"
                            ref={bundleImageInputRef}
                            className="hidden"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            onChange={handleUploadBundleImage}
                        />

                        {watch('image_url') ? (
                            <div className="relative w-full max-w-sm mx-auto aspect-square rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 group">
                                <img src={watch('image_url')} alt="Bundle" className="w-full h-full object-cover" />
                                <div className="absolute top-2 right-2 flex gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                                    <a
                                        href={watch('image_url')}
                                        download={`bundle-${(watch('name') || 'image').replace(/\s+/g, '-').toLowerCase()}.png`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="p-1.5 bg-white text-slate-600 hover:text-indigo-600 rounded-full shadow-md transition-colors"
                                        title="Download Image"
                                    >
                                        <Download size={16} />
                                    </a>
                                    <button
                                        type="button"
                                        onClick={() => setValue('image_url', '')}
                                        className="p-1.5 bg-white text-rose-600 hover:text-rose-700 rounded-full shadow-md transition-colors"
                                        title="Remove Image"
                                    >
                                        <Trash size={16} />
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="w-full aspect-video bg-slate-50 dark:bg-slate-900 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg flex flex-col items-center justify-center text-slate-400 p-4">
                                <ImageIcon size={32} className="mb-2 opacity-50" />
                                <span className="text-xs">No image selected</span>
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={() => bundleImageInputRef.current?.click()}
                            disabled={isUploadingImage}
                            className="w-full px-3 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                        >
                            {isUploadingImage ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                            {isUploadingImage ? 'Uploading...' : watch('image_url') ? 'Replace Image' : 'Upload Image'}
                        </button>

                        {/* BUNDLE-EDITOR-UX-1: replaces the legacy "Generate AI" stock-photo picker. It only moves to
                            the Poster Studio below — it never generates an image or calls an AI service. */}
                        <button
                            type="button"
                            onClick={goToPosterStudio}
                            className="w-full px-3 py-2.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-800 rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-1.5"
                        >
                            <Sparkles size={14} />
                            Create Bundle Poster
                        </button>

                        <details className="group/link">
                            <summary className="flex cursor-pointer list-none [&::-webkit-details-marker]:hidden items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-indigo-600 dark:text-slate-400">
                                <Link2 size={13} aria-hidden="true" />
                                Use an image link instead
                            </summary>
                            <input
                                type="text"
                                placeholder="https://…"
                                aria-label="Image link"
                                {...register('image_url')}
                                className="mt-2 w-full min-w-0 px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                        </details>
                    </section>

                    {/* Bundle Details */}
                    <section className={`${CARD} space-y-4`} aria-labelledby="bundle-details-heading">
                        <h2 id="bundle-details-heading" className="text-lg font-bold text-slate-900 dark:text-white text-adaptive">Bundle Details</h2>

                        <fieldset>
                            <legend className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Bundle type</legend>
                            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Bundle type">
                                {([
                                    { value: 'meal', label: 'Meal bundle', hint: 'Sold on its own' },
                                    { value: 'addon', label: 'Fundraiser add-on', hint: 'Extra beside a meal' },
                                ] as const).map((opt) => {
                                    const selected = (watch('bundle_type') || 'meal') === opt.value;
                                    return (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            role="radio"
                                            aria-checked={selected}
                                            onClick={() => chooseBundleType(opt.value)}
                                            className={`min-w-0 text-left px-3 py-2 rounded-lg border-2 transition-colors ${selected
                                                ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30'
                                                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}
                                        >
                                            <span className="block text-sm font-bold text-slate-900 dark:text-white">{opt.label}</span>
                                            <span className="block text-[11px] text-slate-500 dark:text-slate-400">{opt.hint}</span>
                                        </button>
                                    );
                                })}
                            </div>
                            {isAddOn && (
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                                    A fundraiser add-on is offered on a fundraiser you choose (Supporter Add-On in the fundraiser&apos;s
                                    details). Supporters can only add it beside at least one meal bundle. It has one size and is never
                                    shown on the storefront.
                                </p>
                            )}
                        </fieldset>

                        <div>
                            <label htmlFor="bundle-name" className={LABEL}>Bundle Name</label>
                            <input
                                id="bundle-name"
                                {...register('name', { required: true })}
                                aria-invalid={errors.name ? true : undefined}
                                className={FIELD}
                                placeholder="e.g. Family Pizza Night"
                            />
                            {errors.name && <p className="text-xs font-semibold text-rose-600 mt-1">Give the bundle a name.</p>}
                        </div>

                        {/* FR-SUPPORTER-ADDON-UPSELL-1 (S2) / BUNDLE-EDITOR-UX-1: an add-on has one size — no picker. */}
                        {!isAddOn && (
                            <div>
                                <label className={LABEL}>Serving Size Tier</label>
                                {watch('serving_tier') === 'custom_entry' ? (
                                    <div className="flex gap-2">
                                        <input
                                            autoFocus
                                            className={`${FIELD} font-medium`}
                                            placeholder="e.g. Family Size Keto"
                                            onBlur={(e) => {
                                                if (e.target.value.trim()) {
                                                    const val = e.target.value.trim();
                                                    setValue('serving_tier', val);
                                                    // Auto-Price
                                                    const vLower = val.toLowerCase();
                                                    if (vLower.includes('family')) setValue('price', '125.00', { shouldValidate: true, shouldDirty: true });
                                                    else if (vLower.includes('couple') || vLower.includes('serves 2')) setValue('price', '60.00', { shouldValidate: true, shouldDirty: true });
                                                } else {
                                                    setValue('serving_tier', 'family'); // Revert
                                                }
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    e.currentTarget.blur();
                                                }
                                            }}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setValue('serving_tier', 'family')}
                                            className="px-3 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg shrink-0"
                                            title="Cancel"
                                        >
                                            X
                                        </button>
                                    </div>
                                ) : (
                                    <select
                                        value={
                                            // 1. Is it a default tier?
                                            ['family', 'couple', 'single'].includes(watch('serving_tier'))
                                                // 2. Is it a KNOWN custom tier?
                                                || knownTiers.includes(watch('serving_tier'))
                                                ? watch('serving_tier')
                                                // 3. Otherwise treat as new/temp custom value
                                                : 'custom_value'
                                        }
                                        onChange={(e) => {
                                            if (e.target.value === 'new_tier') {
                                                setValue('serving_tier', 'custom_entry');
                                            } else if (e.target.value === 'custom_value') {
                                                // Do nothing (editing existing custom)
                                            } else {
                                                const val = e.target.value;
                                                setValue('serving_tier', val);
                                                // Auto-Price
                                                const vLower = val.toLowerCase();
                                                if (vLower.includes('family')) setValue('price', '125.00', { shouldValidate: true, shouldDirty: true });
                                                else if (vLower.includes('couple') || vLower.includes('serves 2')) setValue('price', '60.00', { shouldValidate: true, shouldDirty: true });
                                            }
                                        }}
                                        className={`${FIELD} font-medium`}
                                    >
                                        <option value="family">Family Size (Serves 5)</option>
                                        <option value="couple">Couple (Serves 2)</option>
                                        <option value="single">Single Serve</option>

                                        {/* Persisted Custom Tiers */}
                                        {knownTiers
                                            .filter(t => !['family', 'couple', 'single'].includes(t)) // Don't duplicate defaults
                                            .map(t => (
                                                <option key={t} value={t}>{t}</option>
                                            ))
                                        }

                                        {!['family', 'couple', 'single'].includes(watch('serving_tier'))
                                            && watch('serving_tier') !== 'custom_entry'
                                            && !knownTiers.includes(watch('serving_tier')) && (
                                                <option value="custom_value">{watch('serving_tier')} (New)</option>
                                            )}
                                        <option value="new_tier" className="font-bold text-indigo-600">+ New Tier...</option>
                                    </select>
                                )}
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                    Determines ingredient scaling base.<br />
                                    • Family = Recipe * 1<br />
                                    • Couple = Recipe / 2<br />
                                    • Single = Recipe / 5
                                </p>
                            </div>
                        )}

                        <div>
                            <label htmlFor="bundle-price" className={LABEL}>Selling Price ($)</label>
                            <input
                                id="bundle-price"
                                {...register('price')}
                                type="number"
                                step="0.01"
                                className={`${FIELD} font-mono text-sm`}
                                placeholder="25.00"
                            />
                            {isAddOn && !(Number(watch('price')) > 0) && (
                                <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">Needs a price above $0.00 before a fundraiser can offer it.</p>
                            )}
                        </div>

                        <div>
                            <label htmlFor="bundle-description" className={LABEL}>Description</label>
                            <textarea
                                id="bundle-description"
                                {...register('description')}
                                aria-describedby="bundle-description-help"
                                className={`${FIELD} h-24 resize-none dark:placeholder:text-slate-500`}
                                placeholder="e.g. Three hearty family-size meals, ready to bake from frozen."
                            />
                            <p id="bundle-description-help" className="text-xs text-slate-500 dark:text-slate-400 mt-1">{DESCRIPTION_HELP}</p>
                        </div>

                        <div className="space-y-4 bg-slate-50 dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <input
                                    {...register('is_active')}
                                    type="checkbox"
                                    id="is_active"
                                    className="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                                />
                                <label htmlFor="is_active" className="text-sm font-bold text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                                    Active Status
                                </label>
                                <span className="ml-auto text-xs text-slate-400 font-medium">
                                    {watch('is_active') ? 'Enabled/Unlocked' : 'Archived/Hidden'}
                                </span>
                            </div>

                            {isAddOn ? (
                                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                    Not on the storefront — a fundraiser add-on is only sold beside a fundraiser meal order.
                                </p>
                            ) : (<>
                            <hr className="border-slate-200 dark:border-slate-800" />
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <input
                                    {...register('show_on_storefront')}
                                    type="checkbox"
                                    id="show_on_storefront"
                                    className="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                                />
                                <label htmlFor="show_on_storefront" className="text-sm font-bold text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                                    Show on Customer Storefront
                                </label>
                                <span className="ml-auto text-xs text-slate-400 font-medium">
                                    {watch('show_on_storefront') ? 'Visible to public' : 'Internal CRM only'}
                                </span>
                            </div>

                            {watch('show_on_storefront') && (
                                <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 animate-in fade-in slide-in-from-top-2">
                                    <label className={LABEL}>Storefront Order Cutoff Date</label>
                                    <input
                                        {...register('order_cutoff_date')}
                                        type="date"
                                        className="w-full min-w-0 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                                    />
                                    <p className="text-xs text-slate-500 mt-1.5">If set, a global countdown banner will appear on the storefront driving urgency to order before midnight on this date.</p>
                                </div>
                            )}
                            </>)}
                        </div>
                    </section>

                    {/* Advanced settings — collapsed for everyone. A native <details>: its inputs stay in the form
                        while it is closed, so Catalog and SKU are always saved exactly as they are. */}
                    <details ref={advancedRef} className={`${CARD} group`}>
                        <summary className="flex cursor-pointer list-none [&::-webkit-details-marker]:hidden items-center gap-3">
                            <Settings2 size={18} className="shrink-0 text-slate-400" aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                                <span className="block text-base font-bold text-slate-900 dark:text-white">Advanced Settings</span>
                                <span className="block text-xs text-slate-500 dark:text-slate-400 truncate">Catalog &amp; retail options · {advancedSummary}</span>
                            </span>
                            <ChevronDown size={18} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden="true" />
                        </summary>

                        <div className="mt-4 space-y-4">
                            {/* Catalog (it was labelled "Catalog (Season)"; a catalog's season is its date range on the
                                Catalogs tab). Hidden for a fundraiser add-on; its saved value is kept either way. */}
                            {!isAddOn && (
                                <div>
                                    <label htmlFor="bundle-catalog" className={LABEL}>Catalog</label>
                                    <select id="bundle-catalog" {...register('catalog_id')} className={`${FIELD} font-medium`}>
                                        <option value="">-- No Catalog --</option>
                                        {catalogs.map((c: any) => (
                                            <option key={c.id} value={c.id}>{c.name}</option>
                                        ))}
                                    </select>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Optional. Groups this bundle with a seasonal catalog (managed on the Catalogs tab).</p>
                                </div>
                            )}

                            <div>
                                <label htmlFor="bundle-sku" className={LABEL}>SKU</label>
                                <div className="relative">
                                    <input
                                        id="bundle-sku"
                                        {...register('sku', { required: !isNew })}
                                        aria-invalid={errors.sku ? true : undefined}
                                        className={`${FIELD} font-mono text-sm pr-10`}
                                        placeholder={isNew ? 'Created automatically when you save' : 'e.g. SQ0004FS'}
                                    />
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            const val = watch('sku');
                                            if (val) {
                                                navigator.clipboard.writeText(val);
                                                const btn = e.currentTarget;
                                                const originalColor = btn.style.color;
                                                btn.style.color = '#10b981'; // Emerald
                                                setTimeout(() => btn.style.color = originalColor, 1000);
                                            }
                                        }}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                                        title="Copy to Clipboard"
                                    >
                                        <Copy size={16} />
                                    </button>
                                </div>
                                {errors.sku && <p className="text-xs font-semibold text-rose-600 mt-1">An existing bundle needs a SKU.</p>}
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                    {isNew
                                        ? 'Optional. Leave it blank and a unique SKU is created when you save.'
                                        : 'Changing an existing SKU can break a Square point-of-sale item link.'}
                                </p>

                                {/* The SKU generator — only when asked; the same format as before (lib/bundleSkuGenerator.ts). */}
                                <div className="mt-2 flex flex-wrap items-center gap-2 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-100 dark:border-slate-800">
                                    <label htmlFor="bundle-sku-platform" className="text-xs font-semibold text-slate-500">Generate for</label>
                                    <select
                                        id="bundle-sku-platform"
                                        value={skuPlatform}
                                        onChange={(e) => setSkuPlatform(e.target.value as SkuPlatform)}
                                        className="min-w-0 flex-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md outline-none focus:ring-1 focus:ring-indigo-500"
                                    >
                                        <option value="other">Other</option>
                                        <option value="square">Square</option>
                                        <option value="qb">QuickBooks</option>
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => generateSkuNow(skuPlatform)}
                                        className="px-3 py-1.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-xs font-bold rounded-md transition-colors"
                                    >
                                        Generate SKU
                                    </button>
                                </div>
                            </div>
                        </div>
                    </details>

                </div>

                {/* ── Right column ────────────────────────────────────────────────────────────── */}
                <div className="space-y-6 min-w-0">
                    {/* Bundle Contents */}
                    <section className={CARD} aria-labelledby="bundle-contents-heading">
                        <div className="flex items-baseline justify-between gap-3 mb-4">
                            <h2 id="bundle-contents-heading" className="text-lg font-bold text-slate-900 dark:text-white text-adaptive">Bundle Contents</h2>
                            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">{fields.length} recipe{fields.length === 1 ? '' : 's'}</span>
                        </div>

                        {/* Search / Add */}
                        <div className="relative mb-6">
                            <div className="flex items-center gap-2 px-4 py-3 bg-slate-50 dark:bg-slate-900 bg-adaptive border border-slate-200 dark:border-slate-700 rounded-lg focus-within:ring-2 focus-within:ring-indigo-500 ring-offset-2 transition-all">
                                <Search size={18} className="text-slate-400 dark:text-slate-500 shrink-0" />
                                <input
                                    className="bg-transparent outline-none w-full min-w-0 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500"
                                    placeholder="Search recipes to add..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                            </div>

                            {/* Dropdown Results */}
                            {searchTerm && (
                                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl z-50 max-h-60 overflow-y-auto">
                                    {filteredRecipes.length > 0 ? (
                                        filteredRecipes.map(r => (
                                            <button
                                                type="button"
                                                key={r.id}
                                                onClick={() => addRecipe(r.id, r.name)}
                                                className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-50 dark:border-slate-700 last:border-0 flex justify-between items-center gap-3 group"
                                            >
                                                <span className="min-w-0 truncate font-medium text-slate-700 dark:text-slate-200">{r.name}</span>
                                                <span className="shrink-0 text-xs text-slate-400 uppercase bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded">{r.type.replace('_', ' ')}</span>
                                            </button>
                                        ))
                                    ) : (
                                        <div className="p-4 text-center text-slate-400 text-sm">No recipes found.</div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* List */}
                        <div className="space-y-3">
                            {fields.length === 0 && (
                                <div className="text-center py-12 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                                    <div className="text-slate-400 mb-2">No items in this bundle</div>
                                    <div className="text-sm text-slate-400">Search recipes above to add them.</div>
                                </div>
                            )}

                            {fields.map((field: any, index) => {
                                const recipeCost = recipeCosts[field.recipe_id] || 0;
                                const quantity = Number(watch(`contents.${index}.quantity`)) || 1;
                                const lineCost = recipeCost * quantity;

                                return (
                                    <div key={field.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 sm:p-4 bg-white dark:bg-slate-800 bg-adaptive border border-slate-200 dark:border-slate-700 rounded-lg hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors group">
                                        <div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
                                            <div className="w-6 h-6 shrink-0 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 flex items-center justify-center text-xs font-bold">
                                                {index + 1}
                                            </div>
                                            <span className="min-w-0 truncate font-medium text-slate-900 dark:text-white text-adaptive" title={field.name}>{field.name}</span>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <input type="hidden" {...register(`contents.${index}.recipe_id` as const)} />
                                            <input type="hidden" {...register(`contents.${index}.name` as const)} />
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Cost</label>
                                                <div className="text-sm font-mono text-slate-600 dark:text-slate-400 text-center">
                                                    ${lineCost.toFixed(2)}
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Qty</label>
                                                <input
                                                    {...register(`contents.${index}.quantity` as const)}
                                                    type="number"
                                                    step="0.01"
                                                    className="w-20 px-2 py-1 border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-white rounded text-sm text-center font-mono"
                                                />
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => remove(index)}
                                                className="text-slate-300 hover:text-rose-500 transition-colors"
                                                aria-label={`Remove ${field.name}`}
                                            >
                                                <Trash size={18} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </section>

                    {/* Bundle Poster Studio — the page's existing panel for a saved bundle; a save-first card for a new
                        one. "Create Bundle Poster" scrolls here and nothing more. */}
                    <section id={POSTER_STUDIO_ANCHOR_ID} tabIndex={-1} className="scroll-mt-24 outline-none" aria-label="Bundle Poster Studio">
                        {posterStudio ?? (
                            <div className={`${CARD} space-y-2`}>
                                <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white text-adaptive">
                                    <Sparkles size={18} className="text-indigo-500" aria-hidden="true" />
                                    Bundle Poster Studio
                                </h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400">{NEW_BUNDLE_POSTER_MESSAGE}</p>
                            </div>
                        )}
                    </section>

                    {/* Bundle Summary — the same figures the Financial Summary always showed, plus type and count. */}
                    <section className={CARD} aria-labelledby="bundle-summary-heading">
                        <div className="flex items-center gap-2 mb-3">
                            <DollarSign size={18} className="text-indigo-600 dark:text-indigo-400" />
                            <h2 id="bundle-summary-heading" className="text-lg font-bold text-slate-900 dark:text-white">Bundle Summary</h2>
                        </div>
                        <dl className="space-y-1.5 text-sm mb-3">
                            <div className="flex justify-between gap-3">
                                <dt className="text-slate-500 dark:text-slate-400">Bundle type</dt>
                                <dd className="font-semibold text-slate-900 dark:text-white">{isAddOn ? 'Fundraiser add-on' : 'Meal bundle'}</dd>
                            </div>
                            <div className="flex justify-between gap-3">
                                <dt className="text-slate-500 dark:text-slate-400">Included recipes</dt>
                                <dd className="font-semibold text-slate-900 dark:text-white">{fields.length}</dd>
                            </div>
                        </dl>
                        {fields.length > 0 ? (
                            <div className="grid grid-cols-2 gap-3 p-3 sm:p-4 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 rounded-xl border border-indigo-200 dark:border-indigo-800">
                                <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Total Cost</div>
                                    <div className="text-lg font-bold text-slate-900 dark:text-white">${financials.adjustedCost.toFixed(2)}</div>
                                    {financials.adjustedCost !== financials.totalCost && (
                                        <div className="text-xs text-slate-400 mt-1">Base: ${financials.totalCost.toFixed(2)}</div>
                                    )}
                                </div>
                                <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Selling Price</div>
                                    <div className="text-lg font-bold text-slate-900 dark:text-white">${financials.sellingPrice.toFixed(2)}</div>
                                </div>
                                <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Profit Margin</div>
                                    <div className={`text-lg font-bold ${financials.profitMargin >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                        ${financials.profitMargin.toFixed(2)}
                                    </div>
                                </div>
                                <div className="bg-white dark:bg-slate-800 p-3 rounded-lg ring-2 ring-indigo-500/10">
                                    <div className="text-xs text-indigo-600 dark:text-indigo-400 uppercase font-black mb-1">Food Cost %</div>
                                    <div className={`text-lg font-black ${financials.foodCostPercent > 49 ? 'text-rose-600' :
                                        financials.foodCostPercent >= 35 ? 'text-orange-500' :
                                            'text-emerald-600'
                                        }`}>
                                        {financials.foodCostPercent.toFixed(1)}%
                                    </div>
                                </div>
                                <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Profit %</div>
                                    <div className={`text-lg font-black ${financials.profitPercent > 49 ? 'text-emerald-600' :
                                        financials.profitPercent >= 35 ? 'text-orange-500' :
                                            'text-rose-600'
                                        }`}>
                                        {financials.profitPercent.toFixed(1)}%
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <p className="text-xs text-slate-500 dark:text-slate-400">Add recipes to see the cost and margin.</p>
                        )}
                    </section>
                </div>
            </div>

            {/* Delete — last on every screen size, away from Save. */}
            {!isNew && (
                <div className="flex justify-end">
                    <button
                        type="button"
                        onClick={async () => {
                            if (!confirm('Are you sure you want to delete this bundle? This cannot be undone.')) return;
                            try {
                                const res = await fetch(`/api/bundles/${initialData.id}`, { method: 'DELETE' });
                                if (res.ok) {
                                    router.push('/bundles');
                                    router.refresh();
                                } else {
                                    const err = await res.json();
                                    alert(`Error: ${err.error}`);
                                }
                            } catch (e) {
                                console.error(e);
                                alert('Failed to delete bundle.');
                            }
                        }}
                        className="w-full sm:w-auto sm:px-6 flex items-center justify-center gap-2 bg-white dark:bg-slate-800 border border-rose-200 dark:border-rose-900/50 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 py-2.5 rounded-lg font-bold transition-colors"
                    >
                        <Trash size={18} />
                        Delete Bundle
                    </button>
                </div>
            )}

            {/* Small screens: the same Save, always within reach. */}
            <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-4 py-3 lg:hidden print:hidden">
                <button type="button" onClick={submit} disabled={isSaving} className={`flex w-full ${SAVE_BUTTON}`}>
                    {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                    Save Bundle
                </button>
            </div>
        </div>
    );
}
