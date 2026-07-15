# Recipe Library Redesign — Implementation Handoff

**Governing spec:** `docs/ai/UI_REDESIGN_SPEC.md` §3 — if this handoff and the spec disagree, the spec wins.
**Target file:** `components/RecipeBrowser.tsx` (client component, Tailwind, dnd-kit) — this file is NOT on the locked list and is the only existing file you should meaningfully edit.
**Concept:** three-pane library — category tree | searchable name list | click-to-open quick-view panel.

---

## HARD RULES FOR THE IMPLEMENTER — read before writing any code

1. **UI-only change, one file plus new components.** Do NOT modify:
   - `components/RecipeEditor.tsx` (locked)
   - `app/recipes/page.tsx` (leave the server data-fetching exactly as is for v1)
   - ANY file under `app/api/` — especially `app/api/recipes/[id]/categories/route.ts`. (It has a known missing-auth issue that is being fixed in a separate security task — do not touch it here, do not "fix it while you're in there.")
   - `prisma/schema.prisma`, `lib/**`
2. **Reuse the drag-and-drop system verbatim.** `RecipeBrowser.tsx` already has `DndContext`, `handleDragStart`, `handleDragEnd`, sensors, and `DroppableFolder` / `DraggableRecipe` / `DraggableFolderItem` from `components/DraggableComponents.tsx`. Keep `handleDragEnd` byte-identical — it PUTs `/api/recipes/[id]/categories` and expects droppable ids prefixed `folder-drop-<categoryId>` with `data.type === 'category'`, and draggable recipes with `data.type === 'recipe'`. Your new tree nodes and list rows must emit those exact same ids/data payloads (wrap them with the existing Draggable/Droppable components or the same hooks).
3. **Reuse the existing search scoring block** (currently ~lines 244-290): name `startsWith` scores highest, then name `includes`, then ingredient/sub-recipe matches with `matchReason`. Don't rewrite it — feed its output into the new list.
4. **Respect the financials permission.** `recipe.calculated_cost` is `null` when the user lacks `VIEW_FINANCIALS` (the server already does this). Whenever cost is null, render nothing for cost cells/stats — no `$0.00`.
5. **Data comes from existing props only.** `RecipeBrowser({ recipes, categories })` already receives everything the quick view needs: `child_items` (with `child_ingredient {name, cost_per_unit, unit}` and `child_recipe {name, base_yield_qty, base_yield_unit}`), `categories`, `base_yield_qty`, `base_yield_unit`, `image_url`, `calculated_cost`. **No new fetches.**
6. **Out of scope for v1** (do not build, do not stub):
   - "Used in bundles" section (needs a server query change — later phase)
   - "SUB" badge on sub-recipes (only add if the Recipe model already has an explicit flag — check first; if the only way is inference, skip it)
   - Print / Duplicate buttons in the quick view (no existing endpoints — Edit only)
   - Any change to how `/recipes/new` or `/recipes/[id]` (the editor) work
   - Removing `@ts-nocheck` from `app/recipes/page.tsx` (separate hygiene task)
7. **Keep every existing feature reachable:** CSV importer (`showImporter`), backup download (`/api/recipes/backup`), New Folder modal (`isCreatingFolder`), AI generator (lives in `RecipePageClient`), category-onto-category drag (folder nesting). Importer + backup move into a "⋯" overflow menu; everything else keeps its current trigger.

---

## Design tokens (Tailwind)

| Role | Class |
|---|---|
| Page background | `bg-slate-50 dark:bg-slate-950` (match existing page) |
| Panel / cards | `bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800` |
| Accent | `indigo-600`, soft `indigo-50 text-indigo-700` (selected states) |
| Money | `text-emerald-600` |
| List row text | `text-sm`, muted meta `text-xs text-slate-500` |
| Numbers | `tabular-nums` |
| Radii | `rounded-xl` panels, `rounded-lg` buttons/chips |

The current file already supports dark mode (`dark:` variants everywhere) — every new component must too.

---

## Layout

```
┌ Toolbar: "Recipes" · search · [List|Cards] · [+ New Recipe] · [⋯]  ┐
├────────────┬──────────────────────────────┬───────────────────────┤
│ Category   │ Recipe list (default view)   │ Quick view panel      │
│ tree       │ grip · name · cats · yield · │ (hidden until a row   │
│ (~220px)   │ cost — filtered by search +  │  is clicked, ~380px)  │
│            │ selected tree node           │                       │
└────────────┴──────────────────────────────┴───────────────────────┘
```

- Desktop (`lg:`): three columns via `grid lg:grid-cols-[220px_1fr_380px]`.
- Tablet/narrow (`< lg`): tree collapses to a horizontal category chip row above the list; quick view renders as a right slide-over (`fixed inset-y-0 right-0 w-full max-w-md`) with a backdrop + close button.
- `currentCategoryId` **keeps its existing name and role** but changes meaning from "folder I've drilled into" to "active tree filter." This matters: `handleDragEnd` reads `currentCategoryId` to decide move-vs-add semantics — with the tree, that existing logic still does the right thing (dragging while a category filter is active = move out of that category; dragging from "All" = add category). Zero changes needed.
- Cards view: keep the existing card-grid JSX in a `{view === 'cards'}` branch, unchanged. List is the new default. Persist the choice in `localStorage('recipeView')`.

---

## New state in `RecipeBrowser.tsx`

```tsx
const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
const [view, setView] = useState<'list' | 'cards'>('list');
const selectedRecipe = recipes.find(r => r.id === selectedRecipeId) ?? null;
```

Category filtering helper (top-level in the file, next to `getPath`):

```tsx
// All descendant ids of a category, for filtering "Entrées" to include "Chicken"/"Beef"
function collectCategoryIds(categories: Category[], targetId: string): string[] {
    const found = getPath(categories, targetId).pop();
    if (!found) return [targetId];
    const walk = (c: Category): string[] => [c.id, ...(c.children ?? []).flatMap(walk)];
    return walk(found);
}
```

List derivation (replaces the drill-in display logic when `view === 'list'`; the search-scoring block stays exactly as-is and runs first):

```tsx
const visibleRecipes = useMemo(() => {
    let base = isSearching ? scoredResults : [...recipes].sort((a, b) => a.name.localeCompare(b.name));
    if (currentCategoryId === 'uncategorized') {
        base = base.filter(r => !r.categories || r.categories.length === 0);
    } else if (currentCategoryId) {
        const ids = new Set(collectCategoryIds(categories, currentCategoryId));
        base = base.filter(r => (r.categories ?? []).some(c => ids.has(c.id)));
    }
    return base;
}, [recipes, categories, currentCategoryId, isSearching, scoredResults]);
```

---

## Components (new files in `components/recipes/`)

### 1. `components/recipes/CategoryTree.tsx`

```tsx
'use client';
import { Category } from '@/types';
import { DroppableFolder } from '@/components/DraggableComponents';

export function CategoryTree({
    categories, activeId, totalCount, uncategorizedCount,
    onSelect, onNewFolder,
}: {
    categories: Category[]; activeId: string | null;
    totalCount: number; uncategorizedCount: number;
    onSelect: (id: string | null) => void; onNewFolder: () => void;
}) {
    return (
        <nav className="rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between px-2 pb-2">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Categories</span>
                <button onClick={onNewFolder} title="New folder"
                    className="text-base font-extrabold text-indigo-600 hover:text-indigo-700">+</button>
            </div>
            <TreeNode label="All recipes" icon="📚" count={totalCount}
                active={activeId === null} onClick={() => onSelect(null)} />
            {categories.filter(c => !c.parent_id).map(cat => (
                <Branch key={cat.id} cat={cat} depth={0} activeId={activeId} onSelect={onSelect} />
            ))}
            <TreeNode label="Uncategorized" icon="🗂" count={uncategorizedCount}
                active={activeId === 'uncategorized'} onClick={() => onSelect('uncategorized')} />
            <p className="mx-2 mt-3 rounded-lg border-2 border-dashed border-slate-200 px-2 py-1.5 text-center text-[10px] text-slate-400 dark:border-slate-700">
                Drag a recipe onto a folder to file it
            </p>
        </nav>
    );
}

function Branch({ cat, depth, activeId, onSelect }: {
    cat: Category; depth: number; activeId: string | null; onSelect: (id: string) => void;
}) {
    return (
        <>
            {/* DroppableFolder must register id `folder-drop-${cat.id}` with data {type:'category'} —
                same contract the existing card-view folders use, so handleDragEnd needs no changes. */}
            <DroppableFolder id={cat.id}>
                <TreeNode
                    label={cat.name} icon={depth === 0 ? '📁' : '📄'}
                    count={(cat as any)._count?.recipes ?? 0}
                    active={activeId === cat.id} indent={depth}
                    onClick={() => onSelect(cat.id)}
                />
            </DroppableFolder>
            {(cat.children ?? []).map(child => (
                <Branch key={child.id} cat={child} depth={depth + 1} activeId={activeId} onSelect={onSelect} />
            ))}
        </>
    );
}

function TreeNode({ label, icon, count, active, onClick, indent = 0 }: {
    label: string; icon: string; count: number; active: boolean; onClick: () => void; indent?: number;
}) {
    return (
        <button onClick={onClick}
            style={{ paddingLeft: `${0.5 + indent * 1.1}rem` }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] font-semibold transition
                ${active ? 'bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200'
                         : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            <span className="opacity-70">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="text-[10px] font-bold tabular-nums text-slate-400">{count}</span>
        </button>
    );
}
```

**Important:** check `DroppableFolder`'s actual props in `components/DraggableComponents.tsx` and match them — if it renders its own folder card UI rather than wrapping children, create a thin `DroppableTreeNode` using the same `useDroppable({ id: \`folder-drop-${id}\`, data: { type: 'category' } })` hook instead. The id/data contract is what must not change.

### 2. `components/recipes/RecipeList.tsx`

```tsx
'use client';
import { DraggableRecipe } from '@/components/DraggableComponents'; // same caveat as DroppableFolder

export function RecipeList({
    recipes, selectedId, onSelect,
}: {
    recipes: any[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
    return (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="grid grid-cols-[24px_1fr_140px_90px_80px] gap-2 border-b border-slate-200 px-3 py-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:border-slate-800">
                <span /><span>Recipe</span><span>Category</span><span>Yield</span><span className="text-right">Cost</span>
            </div>
            {recipes.length === 0 && (
                <p className="px-4 py-10 text-center text-sm text-slate-400">No recipes match.</p>
            )}
            {recipes.map(r => {
                const cost = r.calculated_cost; // null ⇒ user can't view financials
                return (
                    <DraggableRecipe key={r.id} id={r.id}>
                        <button onClick={() => onSelect(r.id)}
                            className={`grid w-full grid-cols-[24px_1fr_140px_90px_80px] items-center gap-2 border-b border-slate-100 px-3 py-2.5 text-left transition last:border-b-0 dark:border-slate-800
                                ${selectedId === r.id ? 'bg-indigo-50 dark:bg-indigo-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                            <span className="cursor-grab text-slate-300" title="Drag to a category">⠿</span>
                            <span className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-white">
                                {r.name}
                                {r.matchReason && <span className="ml-2 text-[10px] font-medium text-amber-600">{r.matchReason}</span>}
                            </span>
                            <span className="truncate text-xs text-slate-500">
                                {(r.categories ?? []).map((c: any) => c.name).join(' · ') || '—'}
                            </span>
                            <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">
                                {r.base_yield_qty ? `${r.base_yield_qty} ${r.base_yield_unit ?? ''}` : '—'}
                            </span>
                            <span className="text-right text-xs font-bold tabular-nums text-emerald-600">
                                {cost != null ? `$${Number(cost).toFixed(2)}` : ''}
                            </span>
                        </button>
                    </DraggableRecipe>
                );
            })}
        </div>
    );
}
```

### 3. `components/recipes/RecipeQuickView.tsx`

```tsx
'use client';
import Link from 'next/link';

export function RecipeQuickView({ recipe, onClose }: { recipe: any | null; onClose: () => void }) {
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
        <aside className="flex max-h-[75vh] flex-col overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
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

            {/* Kitchen prep: use the SAME field RecipeEditor labels "Preparation (Kitchen Only)".
                Check the Recipe model / RecipeEditor for its exact name (e.g. prep_notes /
                prep_instructions) and render as whitespace-preserving text. Omit section if empty. */}

            <div className="sticky bottom-0 mt-4 flex gap-2 bg-white pt-3 dark:bg-slate-900">
                <Link href={`/recipes/${recipe.id}`}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-center text-xs font-extrabold text-white">
                    ✏️ Edit recipe
                </Link>
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
```

---

## Render tree in `RecipeBrowser.tsx`

Everything stays inside the existing `<DndContext ...>` (tree + list must both be inside it or drag breaks):

```tsx
<DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} ...existing props>
    {/* Toolbar: title, existing search input (same searchTerm state), List|Cards toggle,
        existing "+ New Recipe" Link (/recipes/new), "⋯" menu containing:
        Import CSV (setShowImporter), Download Backup (/api/recipes/backup), New Folder (setIsCreatingFolder) */}

    <div className="grid gap-4 lg:grid-cols-[220px_1fr_380px]">
        <CategoryTree
            categories={categories}
            activeId={currentCategoryId}
            totalCount={recipes.length}
            uncategorizedCount={recipes.filter(r => !r.categories?.length).length}
            onSelect={setCurrentCategoryId}
            onNewFolder={() => setIsCreatingFolder(true)}
        />
        {view === 'list' ? (
            <RecipeList recipes={visibleRecipes} selectedId={selectedRecipeId} onSelect={setSelectedRecipeId} />
        ) : (
            /* EXISTING card grid JSX, unchanged, minus the folder cards (tree replaces them) */
        )}
        <RecipeQuickView recipe={selectedRecipe} onClose={() => setSelectedRecipeId(null)} />
    </div>

    {/* existing DragOverlay, folder-create modal, importer modal — unchanged */}
</DndContext>
```

Narrow screens: render `RecipeQuickView` in a slide-over (`fixed inset-y-0 right-0 z-40 w-full max-w-md shadow-2xl` + backdrop) when `selectedRecipeId` is set; the third grid column is `hidden lg:block`.

---

## Acceptance checklist

- [ ] `git diff --stat` shows only `components/RecipeBrowser.tsx` + new files under `components/recipes/`. Nothing under `app/api/`, no `RecipeEditor.tsx`, no `app/recipes/page.tsx`, no schema.
- [ ] Search filters the list as you type; ingredient matches still surface with their match reason.
- [ ] Clicking a tree category filters the list to it **and its subcategories**; counts match.
- [ ] Dragging a row onto a tree folder still files the recipe (network tab: same `PUT /api/recipes/{id}/categories` payload shape as before). Dragging while a category filter is active still *moves* (removes old category), from "All recipes" still *adds*.
- [ ] Clicking a row opens the quick view; **Edit** navigates to `/recipes/{id}` (full editor) exactly as today.
- [ ] Log in as a user WITHOUT `VIEW_FINANCIALS`: no `$` values render anywhere (list column empty, no cost stats in quick view).
- [ ] Cards toggle shows the old card grid unchanged; choice persists across reloads.
- [ ] Import CSV, Download Backup, New Folder all still reachable from the ⋯ menu and functional.
- [ ] Dark mode: all three panes legible (`dark:` variants on every new element).
- [ ] Tablet width (~800px): tree collapses, quick view opens as slide-over, no horizontal scroll.
