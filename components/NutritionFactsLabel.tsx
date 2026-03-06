import React from 'react';

export interface NutritionData {
    servingSize: string;
    servingsPerContainer: string;
    calories: number;
    totalFat: string; // e.g. "8g"
    saturatedFat: string;
    transFat: string;
    cholesterol: string;
    sodium: string;
    totalCarbohydrate: string;
    dietaryFiber: string;
    totalSugars: string;
    addedSugars: string;
    protein: string;
    vitaminD: string;
    calcium: string;
    iron: string;
    potassium: string;
}

interface Props {
    data: Partial<NutritionData>;
    className?: string;
}

export default function NutritionFactsLabel({ data, className = '' }: Props) {
    // FDA Standard Daily Values based on 2,000 calorie diet
    const DAILY_VALUES = {
        totalFat: 78, // g
        saturatedFat: 20, // g
        cholesterol: 300, // mg
        sodium: 2300, // mg
        totalCarbohydrate: 275, // g
        dietaryFiber: 28, // g
        addedSugars: 50, // g
        protein: 50, // g
        vitaminD: 20, // mcg
        calcium: 1300, // mg
        iron: 18, // mg
        potassium: 4700 // mg
    };

    const calculateDV = (valueStr?: string, maxDv?: number): string => {
        if (!valueStr || !maxDv) return '--%';
        // Extract the first number found in the string (handles "8g", "1.5mg", etc.)
        const match = valueStr.match(/(\d+(\.\d+)?)/);
        if (!match) return '--%';

        const value = parseFloat(match[1]);
        if (isNaN(value)) return '--%';

        const percentage = Math.round((value / maxDv) * 100);
        return `${percentage}%`;
    };

    return (
        <div className={`nutrition-label-container bg-white p-2 border border-black max-w-[280px] font-sans text-black leading-tight ${className}`}>
            <h2 className="text-2xl font-black border-b-[6px] border-black mb-1 pb-0.5 tracking-tight uppercase">Nutrition Facts</h2>

            <div className="border-b-[3px] border-black pb-1 mb-1">
                <p className="text-xs font-bold leading-none">{data.servingsPerContainer || '1'} servings per container</p>
                <div className="flex justify-between items-baseline leading-none">
                    <p className="text-sm font-black">Serving size</p>
                    <p className="text-sm font-black">{data.servingSize || '1 tray'}</p>
                </div>
            </div>

            <div className="flex justify-between items-baseline border-b-[8px] border-black pb-1 mb-1">
                <div className="font-black">
                    <p className="text-xs">Amount per serving</p>
                    <p className="text-3xl leading-none font-black tracking-tighter">Calories</p>
                </div>
                <p className="text-4xl font-black tracking-tighter">{data.calories || 0}</p>
            </div>

            <div className="text-[10px] leading-tight pb-1 border-b border-black">
                <p className="text-right font-black mb-0.5">% Daily Value*</p>

                <div className="flex justify-between border-t border-black py-0.5">
                    <p><span className="font-bold">Total Fat</span> {data.totalFat || '0g'}</p>
                    <p className="font-bold">{calculateDV(data.totalFat, DAILY_VALUES.totalFat)}</p>
                </div>
                <div className="pl-3 flex justify-between border-t border-slate-300 py-0.5">
                    <p>Saturated Fat {data.saturatedFat || '0g'}</p>
                    <p className="font-bold">{calculateDV(data.saturatedFat, DAILY_VALUES.saturatedFat)}</p>
                </div>
                <div className="pl-3 flex justify-between border-t border-slate-300 py-0.5">
                    <p><i>Trans</i> Fat {data.transFat || '0g'}</p>
                    <p className="font-bold"></p>
                </div>

                <div className="flex justify-between border-t border-black py-0.5">
                    <p><span className="font-bold">Cholesterol</span> {data.cholesterol || '0mg'}</p>
                    <p className="font-bold">{calculateDV(data.cholesterol, DAILY_VALUES.cholesterol)}</p>
                </div>

                <div className="flex justify-between border-t border-black py-0.5">
                    <p><span className="font-bold">Sodium</span> {data.sodium || '0mg'}</p>
                    <p className="font-bold">{calculateDV(data.sodium, DAILY_VALUES.sodium)}</p>
                </div>

                <div className="flex justify-between border-t border-black py-0.5">
                    <p><span className="font-bold">Total Carbohydrate</span> {data.totalCarbohydrate || '0g'}</p>
                    <p className="font-bold">{calculateDV(data.totalCarbohydrate, DAILY_VALUES.totalCarbohydrate)}</p>
                </div>
                <div className="pl-3 flex justify-between border-t border-slate-300 py-0.5">
                    <p>Dietary Fiber {data.dietaryFiber || '0g'}</p>
                    <p className="font-bold">{calculateDV(data.dietaryFiber, DAILY_VALUES.dietaryFiber)}</p>
                </div>
                <div className="pl-3 border-t border-slate-300 py-0.5">
                    <p>Total Sugars {data.totalSugars || '0g'}</p>
                </div>
                <div className="pl-6 flex justify-between border-t border-slate-300 py-0.5">
                    <p>Includes {data.addedSugars || '0g'} Added Sugars</p>
                    <p className="font-bold">{calculateDV(data.addedSugars, DAILY_VALUES.addedSugars)}</p>
                </div>

                <div className="flex justify-between border-t border-black py-0.5 border-b-[6px]">
                    <p><span className="font-bold">Protein</span> {data.protein || '0g'}</p>
                    <p className="font-bold"></p>
                </div>
            </div>

            <div className="text-[10px] leading-tight space-y-0.5 py-1">
                <div className="flex justify-between border-b border-slate-200 py-0.5">
                    <p>Vitamin D {data.vitaminD || '0mcg'}</p>
                    <p>{calculateDV(data.vitaminD, DAILY_VALUES.vitaminD)}</p>
                </div>
                <div className="flex justify-between border-b border-slate-200 py-0.5">
                    <p>Calcium {data.calcium || '0mg'}</p>
                    <p>{calculateDV(data.calcium, DAILY_VALUES.calcium)}</p>
                </div>
                <div className="flex justify-between border-b border-slate-200 py-0.5">
                    <p>Iron {data.iron || '0mg'}</p>
                    <p>{calculateDV(data.iron, DAILY_VALUES.iron)}</p>
                </div>
                <div className="flex justify-between py-0.5">
                    <p>Potassium {data.potassium || '0mg'}</p>
                    <p>{calculateDV(data.potassium, DAILY_VALUES.potassium)}</p>
                </div>
            </div>

            <div className="border-t border-black pt-1 mt-1 text-[8px] leading-tight">
                <p>* The % Daily Value (DV) tells you how much a nutrient in a serving of food contributes to a daily diet. 2,000 calories a day is used for general nutrition advice.</p>
            </div>
        </div>
    );
}
