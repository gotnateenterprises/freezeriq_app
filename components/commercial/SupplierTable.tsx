import { Plus, Store, Trash2 } from 'lucide-react';
import Link from 'next/link';

interface Supplier {
    id: string;
    name: string;
    website_url?: string | null;
}

interface SupplierTableProps {
    suppliers: Supplier[];
    newSupplierName: string;
    setNewSupplierName: (name: string) => void;
    addSupplier: () => void;
    deleteSupplier: (id: string, name: string) => void;
}

export default function SupplierTable({
    suppliers,
    newSupplierName,
    setNewSupplierName,
    addSupplier,
    deleteSupplier
}: SupplierTableProps) {
    return (
        <div className="max-w-xl">
            <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 mb-6">
                <h3 className="font-bold text-slate-900 dark:text-white text-adaptive mb-4">Add New Supplier</h3>
                <div className="flex gap-4">
                    <input
                        value={newSupplierName}
                        onChange={(e) => setNewSupplierName(e.target.value)}
                        placeholder="Supplier Name (e.g. Sysco)"
                        className="flex-1 px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500"
                    />
                    <button
                        onClick={addSupplier}
                        className="bg-emerald-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-emerald-700"
                    >
                        <Plus size={20} />
                    </button>
                </div>
            </div>

            <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-300">Existing Suppliers</div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                    {suppliers.map(s => (
                        <li key={s.id} className="p-4 flex items-center gap-3 group">
                            <Store size={18} className="text-slate-400" />
                            <Link href={`/commercial/suppliers/${s.id}`} className="font-medium text-slate-900 dark:text-white text-adaptive hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline flex-1">
                                {s.name}
                            </Link>
                            <button
                                onClick={() => deleteSupplier(s.id, s.name)}
                                className="opacity-0 group-hover:opacity-100 p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-all"
                                title="Delete Supplier"
                            >
                                <Trash2 size={16} />
                            </button>
                        </li>
                    ))}
                    {suppliers.length === 0 && <li className="p-8 text-center text-slate-400">No suppliers yet.</li>}
                </ul>
            </div>
        </div>
    );
}
