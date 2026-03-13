"use client";

import { useState, useEffect } from 'react';
import { Save, Plus, Minus, Search, Store, Package, Trash2, ExternalLink, Loader2, Copy, Merge } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

import SupplierTable from './commercial/SupplierTable';
import PackagingTable from './commercial/PackagingTable';
import IngredientTable from './commercial/IngredientTable';
import { BulkPasteModal, MergeModal } from './commercial/BulkActionModals';


interface Supplier {
    id: string;
    name: string;
    website_url?: string | null;
}

interface Ingredient {
    id: string;
    name: string;
    cost_per_unit: number;
    unit: string;
    stock_quantity: number;
    supplier_id: string | null;
    sku?: string | null;
    purchase_unit?: string | null;
    purchase_quantity?: number | null;
    purchase_cost?: number | null;
    needs_review?: boolean;
}

interface PackagingItem {
    id: string;
    name: string;
    quantity: number;
    reorderUrl?: string | null;
    lowStockThreshold: number;
    type: string;
    cost_per_unit: number;
    defaultLabelId?: string | null;
}

export default function CommercialManager({ initialSuppliers, initialIngredients, initialPackaging }: { initialSuppliers: Supplier[], initialIngredients: Ingredient[], initialPackaging: PackagingItem[] }) {
    const [activeTab, setActiveTab] = useState<'ingredients' | 'suppliers' | 'packaging'>('ingredients');
    const [suppliers, setSuppliers] = useState(initialSuppliers);
    const [ingredients, setIngredients] = useState(initialIngredients);
    const [packaging, setPackaging] = useState(initialPackaging);
    const [isSaving, setIsSaving] = useState(false);
    const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const router = useRouter();

    // State for new supplier
    const [newSupplierName, setNewSupplierName] = useState('');
    // State for new ingredient
    const [newIngName, setNewIngName] = useState('');
    const [newIngSku, setNewIngSku] = useState('');
    const [newIngCost, setNewIngCost] = useState('');
    const [newIngUnit, setNewIngUnit] = useState('oz');

    // State for new packaging
    const [newPkgName, setNewPkgName] = useState('');
    const [newPkgCost, setNewPkgCost] = useState('');
    const [newPkgType, setNewPkgType] = useState('other');

    // Sync with server if props change (e.g. after save/refresh)
    useEffect(() => {
        setSuppliers(initialSuppliers);
    }, [initialSuppliers]);

    useEffect(() => {
        setIngredients(initialIngredients);
    }, [initialIngredients]);

    useEffect(() => {
        setPackaging(initialPackaging);
    }, [initialPackaging]);
    const [newPkgStock, setNewPkgStock] = useState('');

    const PKG_TYPES = [
        { value: 'other', label: 'Other / General' },
        { value: 'large_box', label: 'Large Box' },
        { value: 'small_box', label: 'Small Box' },
        { value: 'bag', label: 'Bag' },
        { value: 'tray', label: 'Tray' },
        { value: 'lid', label: 'Lid' },
        { value: 'sticker', label: 'Sticker / Label' },
        { value: 'insulation', label: 'Insulation' },
        { value: 'ice_pack', label: 'Ice Pack' },
    ];

    // Common Units
    const UNIT_OPTIONS = ['g', 'oz', 'lb', 'kg', 'ml', 'L', 'fl oz', 'cup', 'tbsp', 'tsp', 'each', 'can', 'pack', 'case', 'bunch'];

    const handleUpdateIngredient = (id: string, field: 'name' | 'cost_per_unit' | 'supplier_id' | 'unit' | 'stock_quantity' | 'sku' | 'purchase_unit' | 'purchase_quantity' | 'purchase_cost', value: any) => {
        setIngredients(prev => prev.map(ing => {
            if (ing.id !== id) return ing;

            const next = { ...ing, [field]: (field === 'cost_per_unit' || field === 'stock_quantity' || field === 'purchase_quantity' || field === 'purchase_cost') ? Number(value) : value };

            // Auto-Calculate Unit Cost if Purchase Params Change
            if (field === 'purchase_cost' || field === 'purchase_quantity') {
                const pCost = field === 'purchase_cost' ? Number(value) : (next.purchase_cost || 0);
                const pQty = field === 'purchase_quantity' ? Number(value) : (next.purchase_quantity || 1);

                if (pQty > 0) {
                    next.cost_per_unit = Number((pCost / pQty).toFixed(2));
                }
            }
            return next;
        }));
    };

    const handleAddCases = (id: string, caseCount: number) => {
        setIngredients(prev => prev.map(ing => {
            if (ing.id !== id) return ing;
            const pQty = ing.purchase_quantity || 0;
            if (pQty <= 0) return ing;
            const addedStock = caseCount * pQty;
            return { ...ing, stock_quantity: (ing.stock_quantity || 0) + addedStock };
        }));
    };

    // Helper for Deep Linking
    const getSupplierSearchUrl = (baseUrl: string, query: string) => {
        if (!baseUrl) return null;
        const lowerUrl = baseUrl.toLowerCase();
        const encodedQuery = encodeURIComponent(query);
        const encodedQueryPlus = query.split(' ').map(encodeURIComponent).join('+'); // Some sites use +

        // GFS Specific Logic
        if (lowerUrl.includes('gfs') || lowerUrl.includes('gordon')) {
            // Check Local Settings
            const portalPref = localStorage.getItem('gfsPortalType') || 'gfs_store';
            const customUrl = localStorage.getItem('customGfsUrl');

            if (portalPref === 'custom' && customUrl) {
                return customUrl.includes('?')
                    ? `${customUrl}&q=${encodedQuery}`
                    : `${customUrl}/search?q=${encodedQuery}`;
            }

            if (portalPref === 'gordon_ordering') {
                // Updated Commercial Portal (Safe Fallback)
                return `https://apps.gfs.com/doc/go/search?q=${encodedQuery}`;
            } else if (portalPref === 'gordon_experience') {
                return `https://gordonexperience.com/search?q=${encodedQuery}`;
            } else {
                // Public Store (default)
                return `https://gfsstore.com/products/?query=${encodedQuery}`;
            }
        }

        if (lowerUrl.includes('amazon')) {
            return `https://www.amazon.com/s?k=${encodedQuery}`;
        }
        if (lowerUrl.includes('webstaurantstore')) {
            return `https://www.webstaurantstore.com/search/${encodedQuery}.html`;
        }
        if (lowerUrl.includes('sysco')) {
            return `https://www.sysco.com/search?q=${encodedQuery}`;
        }
        // Generic Fallback
        if (!lowerUrl.includes('/')) { // e.g. "example.com"
            return `https://${baseUrl}/search?q=${encodedQuery}`;
        }

        return baseUrl;
    };


    const saveChanges = async () => {
        setIsSaving(true);
        try {
            const res = await fetch('/api/commercial/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ingredients, suppliers })
            });

            if (!res.ok) {
                let errorData: any = {};
                try {
                    errorData = await res.json();
                } catch (e) {
                    throw new Error(`Server Error (Status ${res.status}): ${await res.text() || "No response body"}`);
                }
                const err: any = new Error(errorData.error || `Failed to save (Status ${res.status})`);
                err.code = errorData.code;
                throw err;
            }
            alert("Saved Successfully!");
            router.refresh();
        } catch (e: any) {
            let msg = e.message;
            if (e.code) msg += ` (Code: ${e.code})`;
            alert(`Error saving changes: ${msg}`);
        } finally {
            setIsSaving(false);
        }
    };

    const downloadData = () => {
        const data = {
            date: new Date().toISOString(),
            ingredients,
            suppliers
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `freezeriq_backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const json = JSON.parse(event.target?.result as string);

                if (json.ingredients && Array.isArray(json.ingredients)) {
                    if (confirm(`Found ${json.ingredients.length} ingredients and ${json.suppliers?.length || 0} suppliers.\nThis will import them as NEW items for your business.\n\nProceed?`)) {

                        // ID Remapping Maps
                        const supplierMap = new Map<string, string>(); // Old ID -> New/Existing ID

                        // 1. Process Suppliers (Deduplicate by Name)
                        const currentSupplierNames = new Map(suppliers.map(s => [s.name.toLowerCase().trim(), s.id]));
                        const newSuppliers: any[] = [];

                        (json.suppliers || []).forEach((s: any) => {
                            const normalizedName = s.name.toLowerCase().trim();
                            if (currentSupplierNames.has(normalizedName)) {
                                // Exists: Map import ID to existing ID
                                if (s.id) supplierMap.set(s.id, currentSupplierNames.get(normalizedName)!);
                            } else {
                                // New: Generate ID and add to list
                                const newId = crypto.randomUUID();
                                if (s.id) supplierMap.set(s.id, newId);
                                newSuppliers.push({
                                    ...s,
                                    id: newId,
                                    business_id: undefined,
                                    is_global: false
                                });
                                // Add to map to prevent dupes within the import file itself
                                currentSupplierNames.set(normalizedName, newId);
                            }
                        });

                        // 2. Process Ingredients (Deduplicate by Name & Remap Suppliers)
                        const currentIngredientNames = new Map(ingredients.map(i => [i.name.toLowerCase().trim(), i.id]));
                        const newIngredients: any[] = [];
                        const updatedIngredients: any[] = [];

                        // Helper to find existing ingredient by ID (for updates)
                        const findExisting = (id: string) => ingredients.find(i => i.id === id);

                        json.ingredients.forEach((ing: any) => {
                            const normalizedName = ing.name.toLowerCase().trim();
                            const mappedSupplierId = (ing.supplier_id && supplierMap.has(ing.supplier_id))
                                ? supplierMap.get(ing.supplier_id)
                                : null;

                            if (currentIngredientNames.has(normalizedName)) {
                                // Exists: Update fields but keep ID
                                const existingId = currentIngredientNames.get(normalizedName)!;
                                updatedIngredients.push({
                                    ...findExisting(existingId), // Keep existing fields
                                    ...ing, // Overwrite with import data
                                    id: existingId, // FORCE existing ID
                                    business_id: undefined, // Will be set by API on save
                                    supplier_id: mappedSupplierId // Update supplier link
                                });
                            } else {
                                // New: Create new
                                const newId = crypto.randomUUID();
                                newIngredients.push({
                                    ...ing,
                                    id: newId,
                                    business_id: undefined,
                                    supplier_id: mappedSupplierId
                                });
                                currentIngredientNames.set(normalizedName, newId);
                            }
                        });

                        // 3. Process Packaging (Simple Dedupe by Name)
                        const currentPkgNames = new Set(packaging.map(p => p.name.toLowerCase().trim()));
                        let newPackaging: any[] = [];

                        if (json.packaging && Array.isArray(json.packaging)) {
                            json.packaging.forEach((p: any) => {
                                if (!currentPkgNames.has(p.name.toLowerCase().trim())) {
                                    newPackaging.push({
                                        ...p,
                                        id: crypto.randomUUID(),
                                        business_id: undefined
                                    });
                                }
                            });
                        }

                        // Update State
                        setSuppliers(prev => [...prev, ...newSuppliers]);

                        // For ingredients, we need to merge updates into the main list + add new ones
                        setIngredients(prev => {
                            const sensitiveUpdates = new Map(updatedIngredients.map(i => [i.id, i]));
                            return [
                                ...prev.map(p => sensitiveUpdates.has(p.id) ? sensitiveUpdates.get(p.id) : p),
                                ...newIngredients
                            ];
                        });

                        if (newPackaging.length > 0) setPackaging(prev => [...prev, ...newPackaging]);

                        alert("Import Successful! Items added as new drafts.\n\nPlease click 'Save Changes' to permanently save them to your account.");
                    }
                } else {
                    alert("Invalid backup file format.");
                }
            } catch (err) {
                console.error(err);
                alert("Failed to parse file.");
            }
        };
        reader.readAsText(file);
    };

    const handleSaveSingle = async (id: string) => {
        const ing = ingredients.find(i => i.id === id);
        if (!ing) return;

        setSavingIds(prev => new Set(prev).add(id));
        try {
            const res = await fetch('/api/commercial/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ingredients: [ing], suppliers })
            });

            if (!res.ok) {
                let errorData: any = {};
                try {
                    errorData = await res.json();
                } catch (e) {
                    throw new Error(`Server Error (Status ${res.status}): ${await res.text() || "No response body"}`);
                }
                const err: any = new Error(errorData.error || `Failed to save item (Status ${res.status})`);
                err.code = errorData.code;
                throw err;
            }
        } catch (e: any) {
            let msg = e.message;
            if (e.code) msg += ` (Code: ${e.code})`;
            alert(`Error saving item: ${msg}`);
        } finally {
            setSavingIds(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const addSupplier = async () => {
        if (!newSupplierName.trim()) return;
        try {
            const res = await fetch('/api/commercial/suppliers/create', {
                method: 'POST',
                body: JSON.stringify({ name: newSupplierName })
            });
            const newSup = await res.json();
            setSuppliers(prev => [...prev, newSup]);
            setNewSupplierName('');
        } catch (e) {
            alert("Error adding supplier");
            alert("Error adding supplier");
        }
    }

    const addIngredient = async () => {
        if (!newIngName.trim()) return;
        try {
            const res = await fetch('/api/commercial/ingredients/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newIngName,
                    cost_per_unit: Number(newIngCost),
                    unit: newIngUnit,
                    sku: newIngSku || undefined
                })
            });
            if (!res.ok) throw new Error("Failed");
            const newIng = await res.json();
            setIngredients(prev => [newIng, ...prev]); // Add to top
            setNewIngName('');
            setNewIngSku('');
            setNewIngCost('');
        } catch (e) {
            alert("Error adding ingredient");
        }
    }

    const confirmDelete = async (id: string, name: string) => {
        if (confirm(`Are you sure you want to delete "${name}"?\nThis cannot be undone.`)) {
            try {
                const res = await fetch('/api/commercial/ingredients/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                const data = await res.json();
                if (data.error) {
                    alert(data.error);
                } else {
                    setIngredients(prev => prev.filter(i => i.id !== id));
                }
            } catch (e) {
                alert("Failed to delete.");
            }
        }
    };

    const deleteSupplier = async (id: string, name: string) => {
        if (!confirm(`Are you sure you want to delete supplier "${name}"? This cannot be undone.`)) return;

        const res = await fetch(`/api/commercial/suppliers/delete?id=${id}`, {
            method: 'DELETE'
        });

        const data = await res.json();

        if (res.ok) {
            setSuppliers(prev => prev.filter(s => s.id !== id));
            toast.success('Supplier deleted');
            router.refresh();
        } else {
            alert(data.error || 'Failed to delete supplier');
        }
    };

    // --- PACKAGING HANDLERS (Live Edit) ---
    const addPackaging = async () => {
        if (!newPkgName.trim()) return;
        try {
            const res = await fetch('/api/delivery/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newPkgName,
                    cost_per_unit: Number(newPkgCost),
                    quantity: Number(newPkgStock),
                    type: newPkgType
                })
            });
            if (!res.ok) throw new Error("Failed");
            const newItem = await res.json();
            // ensure numbers
            newItem.cost_per_unit = Number(newItem.cost_per_unit || 0);
            newItem.quantity = Number(newItem.quantity || 0);
            newItem.lowStockThreshold = Number(newItem.lowStockThreshold || 10);

            setPackaging(prev => [...prev, newItem]);
            setNewPkgName('');
            setNewPkgCost('');
            setNewPkgStock('');
        } catch (e) {
            alert("Error adding packaging");
        }
    };

    const updatePackaging = async (id: string, updates: Partial<PackagingItem>) => {
        // Optimistic Update
        setPackaging(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));

        // Live Save
        try {
            await fetch('/api/delivery/inventory', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ...updates })
            });
        } catch (e) {
            console.error("Failed to save packaging update");
        }
    };

    const deletePackaging = async (id: string, name: string) => {
        if (!confirm(`Delete "${name}"?`)) return;
        try {
            const res = await fetch('/api/delivery/inventory', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            if (res.ok) {
                setPackaging(prev => prev.filter(p => p.id !== id));
            } else {
                alert("Failed to delete.");
            }
        } catch (e) {
            alert("Error deleting.");
        }
    };

    // Bulk Paste State
    const [showBulkPaste, setShowBulkPaste] = useState(false);
    const [pasteContent, setPasteContent] = useState('');
    const [bulkPreview, setBulkPreview] = useState<{ id: string, name: string, oldCost: number, newCost: number, match: boolean }[]>([]);

    // Merge State
    const [mergeSource, setMergeSource] = useState<Ingredient | null>(null);
    const [mergeTargetId, setMergeTargetId] = useState('');

    const handleMerge = async () => {
        if (!mergeSource || !mergeTargetId) return;

        const duplicateName = ingredients.find(i => i.id === mergeTargetId)?.name;

        if (!confirm(`MERGE WARNING:\n\nYou are KEEPING "${mergeSource.name}" and DELETING "${duplicateName}".\n\nAll recipes using "${duplicateName}" will be updated to use "${mergeSource.name}" instead.\n\nThis cannot be undone.`)) {
            return;
        }

        setIsSaving(true);
        try {
            const res = await fetch('/api/commercial/ingredients/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceId: mergeTargetId, targetId: mergeSource.id })
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error);

            // Update Local State - remove the duplicate (mergeTargetId)
            setIngredients(prev => prev.filter(i => i.id !== mergeTargetId));
            setMergeSource(null);
            setMergeTargetId('');
            alert("Merged successfully!");
            router.refresh();
        } catch (e: any) {
            alert("Merge failed: " + e.message);
        } finally {
            setIsSaving(false);
        }
    };

    const parseBulkData = () => {
        const lines = pasteContent.split(/\r?\n/).filter(l => l.trim());
        const preview = [];

        for (const line of lines) {
            // Assume Tab Separated (Excel/Sheets default)
            const cols = line.split('\t').map(c => c.trim());
            if (cols.length < 2) continue; // Need at least Name and Cost

            // Simple Heuristic: 
            // If Col 0 is text and Col 1 is number -> Name | Cost
            // If Col 1 is text and Col 0 is text -> Name | Unit (skip cost?) - Let's stick to Name | Cost

            const name = cols[0];
            // Remove '$' and ',' if present
            const costStr = cols[1].replace(/[$,]/g, '');
            const cost = parseFloat(costStr);

            if (!name || isNaN(cost)) continue;

            // Find Match
            const match = ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());

            if (match) {
                preview.push({
                    id: match.id,
                    name: match.name,
                    oldCost: match.cost_per_unit,
                    newCost: cost,
                    match: true
                });
            } else {
                preview.push({
                    id: 'new_' + Math.random(),
                    name: name,
                    oldCost: 0,
                    newCost: cost,
                    match: false
                });
            }
        }
        setBulkPreview(preview);
    };

    const applyBulkData = () => {
        const updates = new Map(bulkPreview.filter(p => p.match).map(p => [p.id, p]));

        setIngredients(prev => prev.map(ing => {
            const update = updates.get(ing.id);
            if (update) {
                return { ...ing, cost_per_unit: update.newCost };
            }
            return ing;
        }));

        setShowBulkPaste(false);
        setPasteContent('');
        setBulkPreview([]);
        alert(`Updated ${updates.size} ingredients! Don't forget to click "Save Changes".`);
    };

    return (
        <div className="space-y-6">
            <BulkPasteModal
                showBulkPaste={showBulkPaste}
                setShowBulkPaste={setShowBulkPaste}
                pasteContent={pasteContent}
                setPasteContent={setPasteContent}
                bulkPreview={bulkPreview}
                setBulkPreview={setBulkPreview}
                parseBulkData={parseBulkData}
                applyBulkData={applyBulkData}
            />

            <MergeModal
                mergeSource={mergeSource}
                setMergeSource={setMergeSource}
                mergeTargetId={mergeTargetId}
                setMergeTargetId={setMergeTargetId}
                ingredients={ingredients}
                handleMerge={handleMerge}
                isSaving={isSaving}
            />

            {/* Header / Tabs */}
            <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                <div className="flex gap-4">
                    <button
                        onClick={() => setActiveTab('ingredients')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition ${activeTab === 'ingredients' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                    >
                        <Package size={18} />
                        Ingredients & Costs
                    </button>
                    <button
                        onClick={() => setActiveTab('packaging')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition ${activeTab === 'packaging' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                    >
                        <Package size={18} />
                        Packaging
                    </button>
                    <button
                        onClick={() => setActiveTab('suppliers')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition ${activeTab === 'suppliers' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                    >
                        <Store size={18} />
                        Suppliers
                    </button>
                </div>
                <div className="flex gap-3">
                    <label className="flex items-center gap-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white px-3 py-2 rounded-lg font-bold transition-colors cursor-pointer" title="Import from JSON">
                        <input type="file" accept=".json" onChange={handleImport} className="hidden" />
                        <Package size={18} /> {/* Reusing icon for Import/Upload feel */}
                        Import
                    </label>
                    <button
                        onClick={downloadData}
                        className="flex items-center gap-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white px-3 py-2 rounded-lg font-bold transition-colors"
                        title="Export to JSON"
                    >
                        <ExternalLink size={18} />
                        Export
                    </button>
                </div>
            </div>

            {activeTab === 'ingredients' && (
                <IngredientTable
                    ingredients={ingredients}
                    suppliers={suppliers}
                    newIngName={newIngName}
                    setNewIngName={setNewIngName}
                    newIngSku={newIngSku}
                    setNewIngSku={setNewIngSku}
                    newIngCost={newIngCost}
                    setNewIngCost={setNewIngCost}
                    newIngUnit={newIngUnit}
                    setNewIngUnit={setNewIngUnit}
                    addIngredient={addIngredient}
                    searchQuery={searchQuery}
                    setSearchQuery={setSearchQuery}
                    handleUpdateIngredient={handleUpdateIngredient}
                    saveChanges={saveChanges}
                    isSaving={isSaving}
                    savingIds={savingIds}
                    handleSaveSingle={handleSaveSingle}
                    confirmDelete={confirmDelete}
                    setMergeSource={setMergeSource}
                    UNIT_OPTIONS={UNIT_OPTIONS}
                    handleAddCases={handleAddCases}
                />
            )}

            {activeTab === 'packaging' && (
                <PackagingTable
                    packaging={packaging}
                    newPkgName={newPkgName}
                    setNewPkgName={setNewPkgName}
                    newPkgType={newPkgType}
                    setNewPkgType={setNewPkgType}
                    newPkgCost={newPkgCost}
                    setNewPkgCost={setNewPkgCost}
                    newPkgStock={newPkgStock}
                    setNewPkgStock={setNewPkgStock}
                    addPackaging={addPackaging}
                    updatePackaging={updatePackaging}
                    deletePackaging={deletePackaging}
                    PKG_TYPES={PKG_TYPES}
                />
            )}

            {activeTab === 'suppliers' && (
                <SupplierTable
                    suppliers={suppliers}
                    newSupplierName={newSupplierName}
                    setNewSupplierName={setNewSupplierName}
                    addSupplier={addSupplier}
                    deleteSupplier={deleteSupplier}
                />
            )}

        </div>
    );
}
