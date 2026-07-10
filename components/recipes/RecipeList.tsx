'use client';
import { DraggableRecipe } from '@/components/DraggableComponents';

export function RecipeList({
    recipes, selectedId, onSelect,
}: {
    recipes: any[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
    return (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {/* Header — Category/Yield columns hidden on small screens to prevent horizontal scroll */}
            <div className="grid grid-cols-[24px_1fr_80px] md:grid-cols-[24px_1fr_140px_90px_80px] gap-2 border-b border-slate-200 px-3 py-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:border-slate-800">
                <span /><span>Recipe</span>
                <span className="hidden md:block">Category</span>
                <span className="hidden md:block">Yield</span>
                <span className="text-right">Cost</span>
            </div>
            {recipes.length === 0 && (
                <p className="px-4 py-10 text-center text-sm text-slate-400">No recipes match.</p>
            )}
            {recipes.map(r => {
                const cost = r.calculated_cost; // null ⇒ user can't view financials
                return (
                    <DraggableRecipe key={r.id} id={r.id}>
                        {({ attributes, listeners }) => (
                            <button onClick={() => onSelect(r.id)}
                                className={`grid w-full grid-cols-[24px_1fr_80px] md:grid-cols-[24px_1fr_140px_90px_80px] items-center gap-2 border-b border-slate-100 px-3 py-2.5 text-left transition last:border-b-0 dark:border-slate-800
                                    ${selectedId === r.id ? 'bg-indigo-50 dark:bg-indigo-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                                <span {...attributes} {...listeners} className="cursor-grab text-slate-300" title="Drag to a category">⠿</span>
                                <span className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-white">
                                    {r.name}
                                    {r.matchReason && <span className="ml-2 text-[10px] font-medium text-amber-600">{r.matchReason}</span>}
                                </span>
                                <span className="hidden md:block truncate text-xs text-slate-500">
                                    {(r.categories ?? []).map((c: any) => c.name).join(' · ') || '—'}
                                </span>
                                <span className="hidden md:block whitespace-nowrap text-xs tabular-nums text-slate-500">
                                    {r.base_yield_qty ? `${r.base_yield_qty} ${r.base_yield_unit ?? ''}` : '—'}
                                </span>
                                <span className="text-right text-xs font-bold tabular-nums text-emerald-600">
                                    {cost != null ? `$${Number(cost).toFixed(2)}` : ''}
                                </span>
                            </button>
                        )}
                    </DraggableRecipe>
                );
            })}
        </div>
    );
}
