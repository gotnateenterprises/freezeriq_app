"use client";

import { useState } from 'react';
import { Tag, Plus, Check } from 'lucide-react';
import { toast } from 'sonner';

interface UpsellProps {
    config: {
        upsell_bundle_id?: string;
        upsell_title: string;
        upsell_description: string;
        upsell_discount_percent: number;
        upsell_bundle?: {
            name: string;
            price: number;
            image_url?: string;
        };
        upsell_type?: 'bundle' | 'manual';
        manual_upsell_name?: string;
        manual_upsell_price?: number;
    };
    onAdd: (bundleId: string) => void; // For manual, we can pass a special flag or ID
}

export default function CheckoutUpsell({ config, onAdd }: UpsellProps) {
    const [added, setAdded] = useState(false);

    // Determine if we have a valid offer
    const isBundle = config.upsell_type === 'bundle' || !config.upsell_type;
    const isValid = isBundle
        ? (config.upsell_bundle_id && config.upsell_bundle)
        : (config.manual_upsell_name && config.manual_upsell_price);

    if (!isValid) return null;

    const originalPrice = isBundle
        ? Number(config.upsell_bundle!.price)
        : Number(config.manual_upsell_price);

    const discount = config.upsell_discount_percent || 0;
    const discountedPrice = originalPrice * (1 - discount / 100);
    const itemName = isBundle ? config.upsell_bundle!.name : config.manual_upsell_name;

    const handleAdd = () => {
        onAdd(isBundle ? config.upsell_bundle_id! : 'manual_upsell');
        setAdded(true);
        toast.success("Special offer added to cart!");
    };

    return (
        <div className="bg-slate-50 dark:bg-slate-900/50 rounded-[2.5rem] p-6 relative overflow-hidden animate-in zoom-in duration-300">
            <div className="absolute top-0 right-0 bg-indigo-500 text-white text-[10px] font-bold px-4 py-1.5 rounded-bl-2xl uppercase tracking-widest">
                Special Offer
            </div>

            <div className="flex gap-6 items-center">
                <div className="w-16 h-16 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center text-indigo-600 shadow-sm shrink-0 border border-slate-100 dark:border-slate-700">
                    <Tag size={24} className="opacity-80" />
                </div>

                <div className="flex-1">
                    <h4 className="font-serif text-lg text-slate-900 dark:text-white leading-tight">
                        {config.upsell_title || "Make it a meal?"}
                    </h4>
                    <p className="text-xs text-slate-500 font-medium mt-1 leading-relaxed">
                        {config.upsell_description || `Add ${itemName} for a discount.`}
                    </p>
                    <div className="flex items-baseline gap-2 mt-2">
                        <span className="font-bold text-indigo-600 text-lg">
                            ${discountedPrice.toFixed(2)}
                        </span>
                        {discount > 0 && (
                            <span className="text-xs text-slate-300 line-through">
                                ${originalPrice.toFixed(2)}
                            </span>
                        )}
                    </div>
                </div>

                <button
                    onClick={handleAdd}
                    disabled={added}
                    className={`h-12 w-12 rounded-full transition-all flex items-center justify-center ${added
                        ? 'bg-emerald-50 text-emerald-500'
                        : 'bg-white text-slate-900 hover:bg-slate-50 shadow-sm border border-slate-100'
                        }`}
                >
                    {added ? <Check size={20} /> : <Plus size={20} />}
                </button>
            </div>
        </div>
    );
}
