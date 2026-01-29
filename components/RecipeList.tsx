"use client";

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Search, BookOpen, Clock, Users, ArrowRight, Upload } from 'lucide-react';
import RecipeImporter from './RecipeImporter';

export default function RecipeList({ recipes }: { recipes: any[] }) {
    const [searchTerm, setSearchTerm] = useState('');
    const [showImporter, setShowImporter] = useState(false);

    const filtered = recipes.filter(r =>
        r.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-8">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div>
                    <h2 className="text-4xl font-black text-indigo-900 dark:text-white text-adaptive tracking-tight">Recipe Manager</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-2 text-lg">Manage culinary standards and yields.</p>
                </div>
                <div className="flex items-center gap-4 w-full md:w-auto">
                    <div className="relative group flex-1 md:w-80">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 group-focus-within:text-indigo-500 transition-colors" size={20} strokeWidth={2.5} />
                        <input
                            placeholder="Search recipes..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pl-12 pr-6 py-4 bg-white dark:bg-slate-800 bg-adaptive border-none rounded-2xl outline-none font-bold text-slate-700 dark:text-gray-100 text-adaptive placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500/50 shadow-sm transition-all"
                        />
                    </div>
                    <button
                        onClick={() => setShowImporter(true)}
                        className="bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 px-6 py-4 rounded-2xl font-bold flex items-center gap-2 shadow-sm hover:scale-105 transition-all active:scale-95"
                    >
                        <Upload size={20} strokeWidth={2.5} />
                        <span className="hidden sm:inline">Import</span>
                    </button>
                    <Link
                        href="/recipes/new"
                        className="bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-600 text-white px-6 py-4 rounded-2xl font-bold flex items-center gap-2 shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/40 hover:scale-105 transition-all active:scale-95"
                    >
                        <Plus size={20} strokeWidth={3} />
                        <span className="hidden sm:inline">New Recipe</span>
                    </Link>
                </div>
            </div>

            {showImporter && <RecipeImporter onClose={() => setShowImporter(false)} />}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {filtered.map((recipe) => (
                    <Link
                        key={recipe.id}
                        href={`/recipes/${recipe.id}`}
                        className="glass-panel p-6 rounded-3xl hover:scale-[1.02] hover:shadow-xl transition-all duration-300 group border border-white/40 dark:border-slate-700/50 flex flex-col relative overflow-hidden bg-white dark:bg-slate-800/40 bg-adaptive"
                    >
                        <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 group-hover:scale-110 transition-all">
                            <BookOpen size={120} className="text-indigo-900 dark:text-indigo-400" />
                        </div>

                        <div className="flex justify-between items-start mb-4 relative z-10">
                            <span className={`inline-flex px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider ${recipe.type === 'prep'
                                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                                : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400'
                                }`}>
                                {recipe.type === 'prep' ? 'Prep Profile' : 'Menu Item'}
                            </span>
                        </div>

                        <h3 className="text-2xl font-black text-indigo-600 dark:text-indigo-300 text-adaptive mb-2 line-clamp-2 relative z-10 group-hover:text-indigo-700 dark:group-hover:text-white transition-colors">
                            {recipe.name}
                        </h3>

                        <div className="mt-auto space-y-4 relative z-10">
                            <div className="flex items-center gap-6 text-sm font-bold text-slate-500 dark:text-slate-400 text-adaptive-subtle">
                                <div className="flex items-center gap-2">
                                    <Users size={16} className="text-slate-400 dark:text-slate-600" />
                                    <span>{Number(recipe.base_yield_qty)} {recipe.base_yield_unit}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Clock size={16} className="text-slate-400 dark:text-slate-600" />
                                    <span>{recipe._count.child_items} Ingredients</span>
                                </div>
                            </div>

                            <div className="w-full h-px bg-slate-100 dark:bg-slate-700/50" />

                            <div className="flex items-center text-indigo-600 dark:text-indigo-400 font-bold text-sm group-hover:translate-x-2 transition-transform">
                                View Details <ArrowRight size={16} className="ml-1" strokeWidth={3} />
                            </div>
                        </div>
                    </Link>
                ))}
            </div>

            {filtered.length === 0 && (
                <div className="text-center py-20">
                    <p className="text-slate-400 dark:text-slate-600 text-lg font-bold">No recipes found matching "{searchTerm}"</p>
                </div>
            )}
        </div>
    );
}
