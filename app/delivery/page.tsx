"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Package, MapPin, Printer, ExternalLink, Plus, RefreshCw, AlertTriangle, Truck, GripVertical, Navigation, Edit } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// --- INTERFACES ---
interface PackagingItem {
    id: string;
    name: string;
    quantity: number;
    reorderUrl?: string;
    lowStockThreshold: number;
    type: string; // 'large_box', 'small_box', 'other'
    defaultLabelId?: string;
    cost_per_unit?: number;
}

interface Stats {
    largeBoxesNeeded: number;
    smallBoxesNeeded: number;
}

interface DeliveryLocation {
    id: string;
    externalId: string;
    customerName: string;
    address: string;
    orderCount: number;
    bundles: string[];
    sequence: number;
    index: number;
}

// ... existing code ...

// --- SUB-COMPONENTS ---
const InventoryItem = ({ item, onUpdate }: { item: PackagingItem, onUpdate: (id: string, delta: number, isAutoDeduct?: boolean, updates?: any) => void }) => {
    const [amount, setAmount] = useState('1');
    const [cost, setCost] = useState(item.cost_per_unit || 0);

    const handleUpdate = (multiplier: number) => {
        const val = parseInt(amount) || 1;
        onUpdate(item.id, val * multiplier);
        setAmount('1');
    };

    const handleCostBlur = () => {
        if (cost !== item.cost_per_unit) {
            onUpdate(item.id, 0, false, { cost_per_unit: Number(cost) });
        }
    };

    return (
        <div className="p-3 flex items-center justify-between group hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
            <div className="min-w-0 pr-2 flex-1">
                <div className="font-bold text-sm text-slate-700 dark:text-slate-300 truncate">{item.name}</div>
                {item.reorderUrl && <a href={item.reorderUrl} target="_blank" className="text-[10px] text-indigo-500 hover:underline flex items-center gap-1"><ExternalLink size={10} /> Reorder</a>}
            </div>

            <div className="flex items-center gap-2 shrink-0">
                {/* Cost Input */}
                <div className="relative group/cost">
                    <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
                    <input
                        type="number"
                        step="0.01"
                        value={cost}
                        onChange={(e) => setCost(parseFloat(e.target.value))}
                        onBlur={handleCostBlur}
                        className="w-16 pl-3 pr-1 py-0.5 text-xs border border-slate-200 dark:border-slate-700 rounded bg-transparent focus:bg-white focus:ring-1 focus:ring-indigo-500 text-right text-slate-600"
                        placeholder="0.00"
                    />
                </div>

                <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-10 h-6 text-center text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:ring-1 focus:ring-indigo-500 p-0 text-slate-900 dark:text-white"
                />
                <button onClick={() => handleUpdate(-1)} className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold flex items-center justify-center text-sm">-</button>
                <span className={`w-8 text-center text-sm font-bold ${item.quantity < item.lowStockThreshold ? 'text-rose-500' : ''}`}>{item.quantity}</span>
                <button onClick={() => handleUpdate(1)} className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold flex items-center justify-center text-sm">+</button>
            </div>
        </div>
    );
};

const SortableItem = ({ loc, openGoogleMaps, onDeliver }: { loc: any, openGoogleMaps: (addr: string) => void, onDeliver: (id: string) => void }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: loc.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 'auto',
        opacity: isDragging ? 0.8 : 1,
    };

    return (
        <div ref={setNodeRef} style={style} className="bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex items-center gap-3 group hover:border-indigo-300 transition-colors">
            {/* Drag Handle */}
            <div {...attributes} {...listeners} className="cursor-grab hover:text-indigo-500 text-slate-400 p-1">
                <GripVertical size={20} />
            </div>

            {/* Index Badge */}
            <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500 text-sm">
                {loc.index + 1}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="font-bold text-slate-900 dark:text-white truncate">{loc.customerName}</div>
                <div onClick={() => openGoogleMaps(loc.address)} className="text-xs text-slate-500 truncate hover:text-indigo-500 cursor-pointer flex items-center gap-1">
                    <MapPin size={10} /> {loc.address}
                </div>
            </div>

            {/* Info */}
            <div className="text-right flex flex-col items-end gap-1">
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        // Use onMouseDown to prevent drag interference if needed, but onClick usually fine here
                        if (confirm('Mark this order as DELIVERED? It will be removed from the list.')) {
                            onDeliver(loc.id);
                        }
                    }}
                    className="bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border border-emerald-200 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-colors"
                >
                    Mark Delivered
                </button>
                <div className="text-[10px] text-slate-400 uppercase font-bold">Stop #{loc.index + 1}</div>
            </div>
        </div>
    );
};

const BoxCounter = ({ title, needed, item, type, onUpdate, onCreate, templates }: {
    title: string,
    needed: number,
    item?: PackagingItem,
    type: 'large_box' | 'small_box',
    onUpdate: (id: string, delta: number, isAutoDeduct?: boolean, updates?: any) => void,
    onCreate: (type: string, name: string, qty: number) => void,
    templates: { id: string, name: string }[]
}) => {
    const [addQty, setAddQty] = useState<string>('');
    const [cost, setCost] = useState(item?.cost_per_unit || 0);

    // Sync cost state if item updates externally
    useEffect(() => {
        if (item) setCost(item.cost_per_unit || 0);
    }, [item?.cost_per_unit]);

    const onHand = item?.quantity || 0;
    const remaining = onHand - needed;

    const handleAdd = () => {
        const qty = parseInt(addQty) || 1;
        if (item) {
            onUpdate(item.id, qty);
        } else {
            onCreate(type, title, qty);
        }
        setAddQty('');
    };

    const handleLabelChange = (labelId: string) => {
        if (item) {
            onUpdate(item.id, 0, false, { defaultLabelId: labelId });
        }
    };

    const handleCostBlur = () => {
        if (item && cost !== item.cost_per_unit) {
            onUpdate(item.id, 0, false, { cost_per_unit: Number(cost) });
        }
    };

    return (
        <div className={`p-4 rounded-2xl border ${remaining < 0 ? 'bg-rose-50 border-rose-200 dark:bg-rose-900/20 dark:border-rose-800' : 'bg-white border-slate-200 dark:bg-slate-800 dark:border-slate-700'} flex flex-col justify-between relative group`}>
            {/* Header */}
            <div className="flex justify-between items-start mb-2">
                <div>
                    <h3 className="font-bold text-slate-500 text-xs uppercase tracking-wider">{title}</h3>
                    <div className="text-2xl font-black text-slate-900 dark:text-white">
                        {remaining > 0 ? remaining : 0}
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <div className="bg-slate-100 dark:bg-slate-700 p-2 rounded-lg mb-1">
                        <Package size={20} className="text-slate-500" />
                    </div>
                    {item && (
                        <div className="relative group/cost">
                            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">$</span>
                            <input
                                type="number"
                                step="0.01"
                                value={cost}
                                onChange={(e) => setCost(parseFloat(e.target.value))}
                                onBlur={handleCostBlur}
                                className="w-14 pl-3 pr-1 py-0.5 text-[10px] border border-transparent hover:border-slate-200 dark:hover:border-slate-600 rounded bg-transparent text-right text-slate-400 hover:text-slate-600 focus:bg-white focus:text-slate-900 focus:ring-1 focus:ring-indigo-500"
                                placeholder="0.00"
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Label Selector (Visible) */}
            <div className="mb-3">
                <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Label Template</label>
                <select
                    className="w-full text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-slate-700 dark:text-slate-300 outline-none focus:ring-2 focus:ring-indigo-500/20"
                    value={item?.defaultLabelId || ''}
                    onChange={(e) => handleLabelChange(e.target.value)}
                >
                    <option value="">-- No Label Assigned --</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
            </div>

            {/* Stats Row */}
            <div className="flex gap-2 mb-3">
                <div className="flex-1 bg-slate-50 dark:bg-slate-900 p-2 rounded text-center">
                    <div className="text-[10px] text-slate-400 uppercase font-bold">Stock</div>
                    <div className="font-bold text-sm text-slate-900 dark:text-white">{onHand}</div>
                </div>
                <div className="flex-1 bg-slate-50 dark:bg-slate-900 p-2 rounded text-center">
                    <div className="text-[10px] text-slate-400 uppercase font-bold">Need</div>
                    <div className="font-bold text-sm text-amber-600">{needed}</div>
                </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
                <input
                    type="number"
                    value={addQty}
                    onChange={(e) => setAddQty(e.target.value)}
                    placeholder="1"
                    className="w-16 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-center font-bold text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none text-slate-900 dark:text-white"
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                />
                <button
                    onClick={handleAdd}
                    className="flex-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold py-1.5 rounded-lg text-sm transition-colors border border-indigo-100 flex items-center justify-center gap-1"
                >
                    <Plus size={14} /> Add Stock
                </button>
            </div>
        </div>
    );
};

// --- MAIN COMPONENT ---
export default function DeliveryDashboard() {
    const router = useRouter();
    const [items, setItems] = useState<PackagingItem[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [locations, setLocations] = useState<DeliveryLocation[]>([]);
    const [labelTemplates, setLabelTemplates] = useState<{ id: string, name: string }[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [originAddress, setOriginAddress] = useState('');

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // Initial load for origin address - REMOVED to force empty default
    // useEffect(() => {
    //     const saved = localStorage.getItem('delivery_origin');
    //     if (saved) setOriginAddress(saved);
    // }, []);

    // Fetch Data (All in one go)
    const refreshData = async () => {
        setIsLoading(true);
        try {
            const [itemsRes, statsRes, routesRes, labelsRes] = await Promise.all([
                fetch('/api/delivery/inventory'),
                fetch('/api/delivery/stats'),
                fetch('/api/orders?status=pending,production_ready,completed,COMPLETED,APPROVED,IN_PRODUCTION'),
                fetch('/api/delivery/labels')
            ]);

            // Inventory
            const itemsData = await itemsRes.json();
            if (Array.isArray(itemsData)) {
                setItems(itemsData);
            } else {
                setItems([]);
            }

            // Labels
            if (labelsRes.ok) {
                setLabelTemplates(await labelsRes.json());
            }

            // Stats
            const statsData = await statsRes.json();
            setStats(statsData);

            // Routes
            const orders = await routesRes.json();
            const mappedRoutes = orders
                .map((o: any) => ({
                    id: o.id,
                    externalId: o.external_id,
                    customerName: o.customer_name || o.organization?.name || 'Unknown Customer',
                    address: o.delivery_address || o.organization?.delivery_address || 'No Address Provided',
                    orderCount: o.items?.length || 0,
                    bundles: o.items?.map((i: any) => i.bundle?.name || 'Item'),
                    sequence: o.delivery_sequence || 0
                }))
                .sort((a: any, b: any) => a.sequence - b.sequence)
                .map((item: any, index: number) => ({ ...item, index }));

            setLocations(mappedRoutes);

        } catch (e) {
            console.error("Failed to load delivery data", e);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        refreshData();
    }, []);

    // Inventory Helpers
    const updateStock = async (id: string, delta: number, isAutoDeduct = false, updates: any = {}) => {
        const item = items.find(i => i.id === id);
        if (!item) return;

        const newQty = Math.max(0, item.quantity + delta);

        // Optimistic update
        setItems(prev => prev.map(i => i.id === id ? { ...i, quantity: newQty, ...updates } : i));

        // Auto-Deduct Labels logic
        if (!isAutoDeduct && delta < 0 && (item.type === 'large_box' || item.type === 'small_box')) {
            const labelItem = items.find(i => i.name.toLowerCase().includes('label'));
            if (labelItem) {
                // Recursively call for label (silent update)
                updateStock(labelItem.id, delta, true);
            }
        }

        try {
            await fetch('/api/delivery/inventory', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, quantity: newQty, ...updates })
            });
        } catch (e) { refreshData(); }
    };

    const createAndAddStock = async (type: string, name: string) => {
        try {
            const res = await fetch('/api/delivery/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, quantity: 1, type })
            });
            if (res.ok) {
                const newItem = await res.json();
                setItems(prev => [...prev, newItem]);
            }
        } catch (e) { console.error("Failed to create item"); }
    };

    // Route Helpers
    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        setLocations((items) => {
            const oldIndex = items.findIndex((i) => i.id === active.id);
            const newIndex = items.findIndex((i) => i.id === over.id);
            const newItems = arrayMove(items, oldIndex, newIndex).map((item, index) => ({ ...item, index }));

            // Fire and forget save
            fetch('/api/delivery/route/reorder', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds: newItems.map(i => i.id) })
            }).catch(e => console.error("Failed to save route"));

            return newItems;
        });
    };

    const openGoogleMaps = (address: string) => {
        const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
        window.open(url, '_blank');
    };

    const handleAutoArrange = async () => {
        if (!originAddress || originAddress.trim() === '') {
            alert('Please enter a Start Location (Kitchen Address) first!');
            return;
        }

        setIsLoading(true);
        try {
            const res = await fetch('/api/delivery/optimize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    origin: originAddress,
                    orders: locations.map(l => ({ id: l.id, address: l.address }))
                })
            });

            const data = await res.json();
            if (res.ok && data.optimizedIds) {
                // Map the new sequence back to location objects
                const reordered = data.optimizedIds
                    .map((id: string) => locations.find(l => l.id === id))
                    .filter(Boolean)
                    .map((item: any, index: number) => ({ ...item, index }));

                setLocations(reordered);

                // Save to Database
                await fetch('/api/delivery/route/reorder', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderIds: data.optimizedIds })
                });

                alert('Route optimized successfully!');
            } else {
                alert('Auto-Arrange Failed: ' + (data.error || 'Check Google API Key'));
            }
        } catch (e) {
            alert('Network error during optimization');
        } finally {
            setIsLoading(false);
        }
    };

    const openFullRoute = () => {
        if (locations.length === 0) return;

        let stops = locations.map(l => encodeURIComponent(l.address));

        // Add origin if set
        if (originAddress && originAddress.trim() !== '') {
            stops = [encodeURIComponent(originAddress), ...stops];
        }

        const path = stops.join('/');
        const url = `https://www.google.com/maps/dir/${path}`;
        window.open(url, '_blank');
    };

    const handleMarkDelivered = async (id: string) => {
        try {
            const res = await fetch('/api/orders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, status: 'delivered' })
            });

            if (res.ok) {
                // Optimistic remove
                setLocations(prev => prev.filter(l => l.id !== id));
                // Refresh effectively
                refreshData();
            } else {
                alert('Failed to update status');
            }
        } catch (e) {
            console.error(e);
            alert('Error updating status');
        }
    };

    // Derived State
    const largeBoxItem = items.find(i => i.type === 'large_box') || items.find(i => i.name.toLowerCase().includes('large'));
    const smallBoxItem = items.find(i => i.type === 'small_box') || items.find(i => i.name.toLowerCase().includes('small'));
    const otherInventory = items.filter(i => i.type === 'other' || (!i.name.toLowerCase().includes('large') && !i.name.toLowerCase().includes('small') && i.type === 'other'));

    return (
        <div className="max-w-7xl mx-auto p-4 md:p-6 pb-24">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div>
                    <h1 className="text-2xl md:text-3xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                        <Truck className="text-indigo-600" />
                        Delivery Dashboard
                    </h1>
                    <p className="text-slate-500 text-sm font-medium">Logistics Center</p>
                </div>
                <div className="flex items-center gap-2">
                    <Link href="/delivery/labels" className="bg-white border border-slate-200 px-3 py-2 rounded-lg text-sm font-bold text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                        <Edit size={16} /> Label Editor
                    </Link>
                    <button onClick={refreshData} className="bg-white border border-slate-200 p-2 rounded-lg text-slate-700 hover:bg-slate-50">
                        <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* --- LEFT COLUMN (MAIN): ROUTE MAP --- */}
                <div className="lg:col-span-2 space-y-6">
                    {/* Route Introduction */}
                    <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 rounded-2xl p-6 text-white shadow-lg flex items-start gap-4">
                        <div className="bg-white/10 p-3 rounded-xl hidden sm:block">
                            <Navigation size={24} className="text-indigo-200" />
                        </div>
                        <div className="flex-1">
                            <div className="flex justify-between items-start">
                                <div>
                                    <h2 className="text-lg font-bold mb-1">Active Route Plan</h2>
                                    <p className="text-indigo-100 text-sm opacity-90 mb-4 max-w-lg">
                                        Drag and drop stops below. Click "Auto Arrange" to optimize by Distance.
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={handleAutoArrange}
                                        disabled={isLoading || locations.length === 0}
                                        className="bg-indigo-500 text-white border border-indigo-400 px-4 py-2 rounded-xl font-bold text-sm hover:bg-indigo-400 disabled:opacity-50 transition-all shadow-lg flex items-center gap-2"
                                        title="Sort by nearest to furthest from your kitchen"
                                    >
                                        <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} /> Optimize Route
                                    </button>
                                    <button
                                        onClick={openFullRoute}
                                        className="bg-white text-indigo-700 px-4 py-2 rounded-xl font-bold text-sm hover:bg-indigo-50 transition-colors shadow-lg flex items-center gap-2"
                                    >
                                        <MapPin size={16} /> Nav Route
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    {/* Origin Address Card */}
                    <div className="bg-white border-2 border-indigo-100 dark:border-indigo-900/50 p-4 rounded-xl flex items-center gap-4 shadow-sm relative overflow-hidden">
                        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-indigo-500"></div>
                        <div className="bg-indigo-50 dark:bg-indigo-900/50 p-2.5 rounded-lg text-indigo-600 dark:text-indigo-300">
                            <MapPin size={24} />
                        </div>
                        <div className="flex-1">
                            <label className="text-[10px] uppercase font-bold text-indigo-400 tracking-wider">Start Location (My Location)</label>
                            <input
                                type="text"
                                value={originAddress}
                                onChange={(e) => {
                                    setOriginAddress(e.target.value);
                                    localStorage.setItem('delivery_origin', e.target.value);
                                }}
                                placeholder="Enter Kitchen Address (e.g. 123 Main St)"
                                className="w-full bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-indigo-500 p-0 text-slate-900 dark:text-white font-bold focus:ring-0 placeholder:text-slate-300 transition-colors"
                            />
                        </div>
                        <div className="text-xs font-bold text-indigo-300">#0</div>
                    </div>

                    {/* Route List */}
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={locations.map(l => l.id)}
                            strategy={verticalListSortingStrategy}
                        >
                            <div className="space-y-2 relative">
                                {/* Connector Line (Visual) */}
                                <div className="absolute left-[2.2rem] top-[-1rem] bottom-4 w-0.5 bg-slate-100 dark:bg-slate-700/50 -z-10"></div>

                                {locations.length === 0 ? (
                                    <div className="text-center py-12 bg-white dark:bg-slate-800 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700">
                                        <MapPin size={32} className="mx-auto text-slate-300 mb-2" />
                                        <p className="font-bold text-slate-500">No pending orders.</p>
                                    </div>
                                ) : locations.map((loc) => (
                                    <SortableItem key={loc.id} loc={loc} openGoogleMaps={openGoogleMaps} onDeliver={handleMarkDelivered} />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                </div>

                {/* --- RIGHT COLUMN (SIDEBAR): INVENTORY --- */}
                <div className="space-y-6">
                    {/* Label Print Queue Card */}
                    <div className="bg-indigo-900 border border-indigo-800 p-4 rounded-2xl text-white shadow-lg overflow-hidden relative">
                        <div className="absolute top-0 right-0 p-4 opacity-10">
                            <Printer size={64} />
                        </div>
                        <h3 className="font-bold text-indigo-200 text-xs uppercase tracking-wider mb-1">Print Queue</h3>
                        <div className="text-3xl font-black mb-4 flex items-end gap-2">
                            {(stats?.largeBoxesNeeded || 0) + (stats?.smallBoxesNeeded || 0)}
                            <span className="text-sm font-medium text-indigo-300 mb-1">labels needed</span>
                        </div>

                        <div className="space-y-2 mb-4">
                            <div className="flex justify-between text-sm">
                                <span className="text-indigo-200">Large Boxes</span>
                                <span className="font-bold">{stats?.largeBoxesNeeded || 0}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-indigo-200">Small Boxes</span>
                                <span className="font-bold">{stats?.smallBoxesNeeded || 0}</span>
                            </div>
                        </div>

                        <Link href="/delivery/print-batch" className="block w-full bg-white text-indigo-900 font-bold py-2.5 rounded-xl text-center hover:bg-indigo-50 transition-colors shadow-sm mb-2">
                            Print Labels
                        </Link>
                        <div className="grid grid-cols-2 gap-2">
                            <Link href="/delivery/print-manifest" className="bg-white border-2 border-indigo-100 text-indigo-700 font-bold py-2 rounded-xl text-center hover:bg-indigo-50 transition-colors text-xs flex items-center justify-center gap-1 shadow-sm">
                                Manifest
                            </Link>
                            <Link href="/delivery/print-packing-slips" className="relative bg-white border-2 border-indigo-100 text-indigo-700 font-bold py-2 rounded-xl text-center hover:bg-indigo-50 transition-colors text-xs flex items-center justify-center gap-1 shadow-sm">
                                Slips
                                <span className="absolute -top-2 -right-2 bg-amber-500 text-white text-[10px] w-5 h-5 flex items-center justify-center rounded-full border-2 border-white shadow-sm">
                                    {(stats?.largeBoxesNeeded || 0) + (stats?.smallBoxesNeeded || 0)}
                                </span>
                            </Link>
                        </div>
                    </div>

                    {/* Box Counters */}
                    <div className="grid grid-cols-2 gap-3">
                        <BoxCounter
                            title="Large (Family)"
                            needed={stats?.largeBoxesNeeded || 0}
                            item={largeBoxItem}
                            type="large_box"
                            onUpdate={updateStock}
                            templates={labelTemplates}
                            onCreate={async (type, name, qty) => {
                                try {
                                    const res = await fetch('/api/delivery/inventory', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ name, quantity: qty, type })
                                    });
                                    if (res.ok) {
                                        const newItem = await res.json();
                                        setItems(prev => [...prev, newItem]);
                                    }
                                } catch (e) { console.error("Failed to create item"); }
                            }}
                        />
                        <BoxCounter
                            title="Small (Serves 2)"
                            needed={stats?.smallBoxesNeeded || 0}
                            item={smallBoxItem}
                            type="small_box"
                            onUpdate={updateStock}
                            templates={labelTemplates}
                            onCreate={async (type, name, qty) => {
                                try {
                                    const res = await fetch('/api/delivery/inventory', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ name, quantity: qty, type })
                                    });
                                    if (res.ok) {
                                        const newItem = await res.json();
                                        setItems(prev => [...prev, newItem]);
                                    }
                                } catch (e) { console.error("Failed to create item"); }
                            }}
                        />
                    </div>

                    {/* Compact Inventory List */}
                    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
                        <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-900/50">
                            <h3 className="font-bold text-sm text-slate-700 dark:text-slate-200">Inventory</h3>
                            <button
                                onClick={async () => {
                                    const name = prompt("Item Name (e.g. 'Packing Tape'):");
                                    if (name) createAndAddStock('other', name);
                                }}
                                className="text-indigo-600 hover:bg-indigo-50 p-1.5 rounded-lg transition-colors"
                            >
                                <Plus size={16} />
                            </button>
                        </div>
                        <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[400px] overflow-y-auto">
                            {otherInventory.length === 0 ? (
                                <div className="p-4 text-center text-xs text-slate-400 italic">No extra items added.</div>
                            ) : otherInventory.map(item => (
                                <InventoryItem key={item.id} item={item} onUpdate={updateStock} />
                            ))}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
