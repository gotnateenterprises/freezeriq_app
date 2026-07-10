'use client';
import { Category } from '@/types';
import { DroppableFolder, DraggableFolderItem } from '@/components/DraggableComponents';

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
            {/* DroppableFolder must use folder-drop-{id} prefix — handleDragEnd parses it.
                DraggableFolderItem preserves category-onto-category drag (folder nesting). */}
            <DroppableFolder id={`folder-drop-${cat.id}`}>
                <DraggableFolderItem id={cat.id}>
                    {({ attributes, listeners }) => (
                        <TreeNode
                            label={cat.name} icon={depth === 0 ? '📁' : '📄'}
                            count={(cat as any)._count?.recipes ?? 0}
                            active={activeId === cat.id} indent={depth}
                            onClick={() => onSelect(cat.id)}
                            dragAttributes={attributes}
                            dragListeners={listeners}
                        />
                    )}
                </DraggableFolderItem>
            </DroppableFolder>
            {(cat.children ?? []).map(child => (
                <Branch key={child.id} cat={child} depth={depth + 1} activeId={activeId} onSelect={onSelect} />
            ))}
        </>
    );
}

function TreeNode({ label, icon, count, active, onClick, indent = 0, dragAttributes, dragListeners }: {
    label: string; icon: string; count: number; active: boolean; onClick: () => void; indent?: number;
    dragAttributes?: any; dragListeners?: any;
}) {
    return (
        <button onClick={onClick}
            {...(dragAttributes || {})}
            {...(dragListeners || {})}
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
