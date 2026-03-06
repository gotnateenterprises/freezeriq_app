
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash, Plus } from 'lucide-react';
import { formatQuantity } from '@/lib/format_quantity';
import { convertUnit, optimizeUnit } from '@/lib/unit_converter';

interface RecipeIngredientRowProps {
    index: number;
    fieldId: string;
    item: any;
    register: any;
    setValue: any;
    isScaling: boolean;
    allIngredients: any[];
    units: string[];
    multiplier: number;
    remove: (index: number) => void;
    handleSyncIngredient: (index: number, name: string) => void;
    handleAddNewUnit: (val: string, setter?: any) => string;
    isBox: boolean;
    currentBatch: number;
    totalBatchQty: number;
    isDragging?: boolean;
}

export default function RecipeIngredientRow({
    index,
    fieldId,
    item,
    register,
    setValue,
    isScaling,
    allIngredients,
    units,
    multiplier,
    remove,
    handleSyncIngredient,
    handleAddNewUnit,
    isBox,
    currentBatch,
    totalBatchQty
}: RecipeIngredientRowProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: fieldId });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 'auto',
        position: isDragging ? 'relative' as const : 'static' as const,
        opacity: isDragging ? 0.8 : 1,
    };

    // Derived values
    const originalQty = Number(item?.qty) || 0;
    const scaledQty = originalQty * multiplier;

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`grid grid-cols-12 gap-4 items-center p-2 rounded-lg border group ${isScaling ? 'bg-indigo-50/30 dark:bg-indigo-900/10 border-indigo-100 dark:border-indigo-800' : 'bg-white dark:bg-slate-900/30 border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-700 transition-colors'} print:border-0 print:border-b print:border-slate-300 print:rounded-none print:p-2 print:bg-transparent`}
        >
            <div className="col-span-1 flex justify-center items-center text-slate-400 cursor-grab active:cursor-grabbing touch-none" {...attributes} {...listeners}>
                {!isScaling ? <GripVertical size={18} className="text-slate-300 hover:text-slate-500" /> : <span>{index + 1}</span>}
                {/* Hidden Registrations for Metadata */}
                <input type="hidden" {...register(`items.${index}.is_sub_recipe`)} />
                <input type="hidden" {...register(`items.${index}.section_name`)} />
                <input type="hidden" {...register(`items.${index}.section_batch`)} />
            </div>

            <div className="col-span-4 relative">
                <input
                    {...register(`items.${index}.name`, {
                        onChange: (e: any) => handleSyncIngredient(index, e.target.value)
                    })}
                    list={`ingredient-list-${index}`}
                    disabled={isScaling}
                    className="w-full px-3 py-2 bg-transparent border-none font-medium text-slate-900 dark:text-slate-100 outline-none disabled:cursor-text placeholder:text-slate-400 dark:placeholder:text-slate-600 print:hidden"
                    placeholder={isBox ? "Search sub-ingredients..." : "Search ingredients..."}
                />
                <datalist id={`ingredient-list-${index}`}>
                    {allIngredients.map(ing => (
                        <option key={ing.id} value={ing.name} />
                    ))}
                </datalist>
                <div className="hidden print:block px-3 py-2 font-medium text-slate-900">
                    {item?.name}
                </div>
            </div>

            <div className="col-span-2">
                {isScaling ? (
                    <div className="px-3 py-2 font-bold text-indigo-700 dark:text-indigo-300 font-mono text-lg">
                        {formatQuantity(scaledQty)}
                    </div>
                ) : (
                    <div className="relative">
                        <input
                            {...register(`items.${index}.qty`)}
                            type="number"
                            step="0.01"
                            onKeyDown={(e) => e.stopPropagation()} // Prevent DnD interference
                            className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md focus:ring-2 focus:ring-emerald-500 outline-none text-sm text-slate-900 dark:text-slate-100 print:hidden"
                        />
                        <div className="hidden print:block px-3 py-2 font-mono font-bold text-slate-900">
                            {formatQuantity(item?.qty)}
                        </div>
                        {/* Batch Preview */}
                        {isBox && currentBatch > 1 && (
                            <div className="absolute -top-7 left-0 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                                <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                                    {isScaling ? 'Scaled ' : ''}Batch Total: {formatQuantity(isScaling ? (scaledQty * currentBatch) : totalBatchQty)} {item.unit}
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="col-span-2">
                <select
                    {...register(`items.${index}.unit`, {
                        onChange: (e: any) => {
                            if (e.target.value === 'ADD_NEW') {
                                const added = handleAddNewUnit('ADD_NEW');
                                if (added) setValue(`items.${index}.unit`, added);
                                else setValue(`items.${index}.unit`, ''); // revert
                            }
                        }
                    })}
                    disabled={isScaling}
                    className={`w-full px-3 py-2 rounded-md outline-none text-sm disabled:cursor-text appearance-none print:hidden ${isScaling ? 'bg-transparent border-none text-slate-500 dark:text-slate-400' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-emerald-500 text-slate-700 dark:text-slate-200'}`}
                >
                    <option value="" disabled>Select Unit...</option>
                    {units.map(u => (
                        <option key={u} value={u}>{u}</option>
                    ))}
                    <option value="ADD_NEW" className="font-bold text-emerald-600">+ Add New Unit...</option>
                </select>
                <div className="hidden print:block px-3 py-2 text-sm text-slate-500 font-bold">
                    {item?.unit}
                </div>
            </div>

            {/* Line Cost Column */}
            <div className="col-span-1 text-right font-mono font-bold text-slate-600 dark:text-slate-400">
                {(() => {
                    const match = allIngredients.find(ing => ing.name.toLowerCase() === (item?.name || '').toLowerCase());
                    if (match) {
                        const qty = isScaling ? scaledQty : (Number(item?.qty) || 0);
                        const rate = convertUnit(1, item?.unit || '', match.unit);
                        const lineCost = qty * rate * Number(match.cost_per_unit || 0);
                        return `$${lineCost.toFixed(2)}`;
                    }
                    return <span className="text-slate-300">$-.--</span>;
                })()}
            </div>

            {isScaling ? (
                <div className="col-span-2 text-right">
                    {(() => {
                        const opt = optimizeUnit(scaledQty, item?.unit, item?.name);
                        if (opt.unit !== item?.unit) {
                            return (
                                <div className="px-3 py-2 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-lg font-bold font-mono text-sm inline-block shadow-sm border border-emerald-100 dark:border-emerald-900/50">
                                    {formatQuantity(opt.qty)} {opt.unit}
                                </div>
                            )
                        }
                        return <span className="text-slate-300">-</span>
                    })()}
                </div>
            ) : (
                <div className="col-span-2 flex justify-center gap-1">
                    <button
                        type="button"
                        onClick={() => remove(index)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-md transition-all opacity-0 group-hover:opacity-100 print:hidden"
                    >
                        <Trash size={16} />
                    </button>
                </div>
            )}
        </div>
    );
}
