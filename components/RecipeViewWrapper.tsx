"use client";

import { useState } from 'react';
import RecipeShowcase from './RecipeShowcase';
import RecipeEditor from './RecipeEditor';

interface RecipeViewWrapperProps {
    initialData: any;
    costData: any;
}

export default function RecipeViewWrapper({ initialData, costData }: RecipeViewWrapperProps) {
    const [mode, setMode] = useState<'showcase' | 'edit'>('showcase');

    if (mode === 'edit') {
        return (
            <div className="relative">
                <button
                    onClick={() => setMode('showcase')}
                    className="absolute top-4 right-4 z-[100] px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-bold shadow-lg hover:bg-slate-700 transition-all"
                >
                    Exit Edit Mode
                </button>
                <RecipeEditor initialData={initialData} costData={costData} />
            </div>
        );
    }

    return (
        <RecipeShowcase
            recipe={initialData}
            costData={costData}
            onEdit={() => setMode('edit')}
        />
    );
}
