'use client';
import { DraggableRecipe } from '@/components/DraggableComponents';
import { Printer } from 'lucide-react';

// RECIPE-LIST-READABILITY-1: the recipe name is the dominant column. Category is a shrinking share
// (0.45 of the name's width); Yield is a narrow number; Cost is compact. Header and rows share this one
// template so they can never drift apart. Category and Yield stay hidden below md, as before.
const COLUMNS = 'grid-cols-[20px_minmax(0,1fr)_60px_24px] md:grid-cols-[20px_minmax(0,1fr)_minmax(0,0.45fr)_44px_60px_24px] gap-1.5';

export function RecipeList({
    recipes, selectedId, onSelect, onPrint,
}: {
    recipes: any[]; selectedId: string | null; onSelect: (id: string) => void; onPrint?: (recipe: any) => void;
}) {
    return (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {/* Header — Category/Yield columns hidden on small screens to prevent horizontal scroll */}
            <div className={`grid ${COLUMNS} border-b border-slate-200 px-3 py-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:border-slate-800`}>
                <span /><span>Recipe</span>
                <span className="hidden md:block">Category</span>
                <span className="hidden md:block text-center">Yield</span>
                <span className="text-right">Cost</span>
                <span />
            </div>
            {recipes.length === 0 && (
                <p className="px-4 py-10 text-center text-sm text-slate-400">No recipes match.</p>
            )}
            {recipes.map(r => {
                const cost = r.calculated_cost; // null ⇒ user can't view financials
                const categoryText = (r.categories ?? []).map((c: any) => c.name).join(' · ') || '—';
                return (
                    <DraggableRecipe key={r.id} id={r.id}>
                        {({ attributes, listeners }) => (
                            <div
                                className={`grid w-full ${COLUMNS} items-center border-b border-slate-100 px-3 py-2.5 last:border-b-0 dark:border-slate-800
                                    ${selectedId === r.id ? 'bg-indigo-50 dark:bg-indigo-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                            >
                                <span {...attributes} {...listeners} className="cursor-grab text-slate-300" title="Drag to a category">⠿</span>
                                {/* Clickable recipe name area */}
                                <button
                                    onClick={() => onSelect(r.id)}
                                    title={r.name}
                                    className="min-w-0 truncate text-left text-sm font-semibold text-slate-900 dark:text-white"
                                >
                                    {r.name}
                                    {r.matchReason && <span className="ml-2 text-[10px] font-medium text-amber-600">{r.matchReason}</span>}
                                </button>
                                <span className="hidden md:block min-w-0 truncate text-xs text-slate-500" title={categoryText}>
                                    {categoryText}
                                </span>
                                {/* The number only; the unit (e.g. "servings") is in the hover title, not repeated on every row. */}
                                <span
                                    className="hidden md:block whitespace-nowrap text-center text-xs tabular-nums text-slate-500"
                                    title={r.base_yield_qty ? `${r.base_yield_qty} ${r.base_yield_unit ?? ''}`.trim() : undefined}
                                >
                                    {r.base_yield_qty ? `${r.base_yield_qty}` : '—'}
                                </span>
                                <span className="text-right text-xs font-bold tabular-nums text-emerald-600">
                                    {cost != null ? `$${Number(cost).toFixed(2)}` : ''}
                                </span>
                                {/* Print button — stopPropagation keeps row select intact */}
                                <button
                                    onClick={(e) => { e.stopPropagation(); onPrint?.(r); }}
                                    title="Print recipe"
                                    className="flex items-center justify-center text-slate-300 hover:text-indigo-600 transition-colors"
                                >
                                    <Printer size={14} />
                                </button>
                            </div>
                        )}
                    </DraggableRecipe>
                );
            })}
        </div>
    );
}
