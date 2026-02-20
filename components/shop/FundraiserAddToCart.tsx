"use client";

import { ShoppingBag } from 'lucide-react';
import { useCart } from '@/context/CartContext';

export default function FundraiserAddToCart({ bundle, primaryColor }: { bundle: any, primaryColor: string }) {
    const { addToCart, setIsCartOpen } = useCart();

    const handleAdd = () => {
        addToCart({
            bundleId: bundle.id,
            name: bundle.name,
            price: Number(bundle.price),
            quantity: 1,
            serving_tier: 'Family Size', // Default
            image_url: bundle.image_url
        });
        setIsCartOpen(true);
    };

    return (
        <button
            onClick={handleAdd}
            className="w-full py-3 rounded-xl text-white font-bold shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2"
            style={{ backgroundColor: primaryColor }}
        >
            <ShoppingBag size={18} />
            Add to Fundraiser Cart
        </button>
    );
}
