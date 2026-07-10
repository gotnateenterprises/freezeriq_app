'use client';
import Link from 'next/link';
import React from 'react';
import { Printer } from 'lucide-react';

export function RecipeQuickView({ recipe, onClose, onPrint }: { recipe: any | null; onClose: () => void; onPrint?: (recipe: any) => void }) {
    if (!recipe) {
        return (
            <aside className="hidden lg:grid place-items-center rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
                <div>
                    <p className="text-3xl">🍲</p>
                    <p className="mx-auto mt-2 max-w-[24ch] text-sm text-slate-400">
                        <b>Select a recipe</b> to preview it here without opening the editor.
                    </p>
                </div>
            </aside>
        );
    }
    const cost = recipe.calculated_cost;
    const perServing = cost != null && Number(recipe.base_yield_qty) > 0 &&
        /serv/i.test(recipe.base_yield_unit ?? '')
        ? cost / Number(recipe.base_yield_qty) : null;

    return (
        <aside className="flex flex-col overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 lg:max-h-[calc(100vh-200px)]">
            <button onClick={onClose} className="ml-auto text-slate-300 hover:text-slate-500 lg:hidden" aria-label="Close">✕</button>
            {recipe.image_url && (
                <img src={recipe.image_url} alt={recipe.name}
                    className="mb-3 h-36 w-full rounded-lg object-cover" />
            )}
            {(recipe.categories ?? []).length > 0 && (
                <span className="w-fit rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
                    {recipe.categories.map((c: any) => c.name).join(' · ')}
                </span>
            )}
            <h3 className="mt-1.5 text-xl font-black leading-tight tracking-tight text-slate-900 dark:text-white">{recipe.name}</h3>

            <div className="mt-3 flex gap-2">
                <Stat label="yield" value={recipe.base_yield_qty ? `${recipe.base_yield_qty} ${recipe.base_yield_unit ?? ''}` : '—'} />
                {cost != null && <Stat label="cost / batch" value={`$${Number(cost).toFixed(2)}`} money />}
                {perServing != null && <Stat label="cost / srv" value={`$${perServing.toFixed(2)}`} money />}
            </div>

            <Section title="Ingredients">
                {(recipe.child_items ?? []).length === 0 && (
                    <p className="py-2 text-xs text-slate-400">No ingredients listed.</p>
                )}
                {(recipe.child_items ?? []).map((item: any, i: number) => (
                    <div key={i} className="flex justify-between gap-3 border-b border-dashed border-slate-100 py-1.5 text-[13px] last:border-b-0 dark:border-slate-800">
                        <span className={item.child_recipe ? 'font-semibold text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}>
                            {item.child_recipe ? '↳ ' : ''}{item.child_recipe?.name ?? item.child_ingredient?.name ?? '—'}
                        </span>
                        <span className="whitespace-nowrap tabular-nums text-slate-500">
                            {item.quantity} {item.unit ?? ''}
                        </span>
                    </div>
                ))}
            </Section>

            {/* Kitchen prep — uses the instructions field, omitted if empty */}
            {recipe.instructions && (
                <Section title="Kitchen Prep">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-600 dark:text-slate-300">{recipe.instructions}</p>
                </Section>
            )}

            <div className="sticky bottom-0 mt-4 flex gap-2 bg-white pt-3 dark:bg-slate-900">
                <Link href={`/recipes/${recipe.id}`}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-center text-xs font-extrabold text-white hover:bg-indigo-700 transition">
                    ✏️ Edit recipe
                </Link>
                {onPrint && (
                    <button
                        onClick={() => onPrint(recipe)}
                        title="Print recipe"
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-extrabold text-slate-600 hover:border-indigo-300 hover:text-indigo-600 transition dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:text-indigo-400"
                    >
                        <Printer size={14} />
                        Print
                    </button>
                )}
            </div>
        </aside>
    );
}

function Stat({ label, value, money = false }: { label: string; value: string; money?: boolean }) {
    return (
        <div className="flex-1 rounded-lg bg-slate-50 px-2 py-1.5 text-center dark:bg-slate-800">
            <p className={`text-sm font-black tabular-nums ${money ? 'text-emerald-600' : 'text-slate-900 dark:text-white'}`}>{value}</p>
            <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        </div>
    );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="mt-4">
            <h4 className="mb-1.5 text-[10px] font-extrabold uppercase tracking-widest text-slate-400">{title}</h4>
            {children}
        </div>
    );
}
