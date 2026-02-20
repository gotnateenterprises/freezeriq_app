'use client';

import { X, Plus, Minus, ShoppingBag, ArrowRight } from 'lucide-react';
import { useCart } from '@/context/CartContext';
import { useState } from 'react';
import CheckoutModal from './CheckoutModal';
import { getContrastTextClass } from '@/lib/colorUtils';

interface CartDrawerProps {
    primaryColor: string;
    businessId: string;
    slug: string;
    campaignId?: string;
    campaignParticipantLabel?: string | null;
    storefrontConfig?: any;
}

export default function CartDrawer({ primaryColor, businessId, slug, campaignId, campaignParticipantLabel, storefrontConfig }: CartDrawerProps) {
    const { isCartOpen, setIsCartOpen, items, removeFromCart, updateQuantity, cartTotal, clearCart } = useCart();
    const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);

    if (!isCartOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 transition-opacity"
                onClick={() => setIsCartOpen(false)}
            />

            {/* Drawer */}
            <div className="fixed inset-y-0 right-0 w-full max-w-md bg-white/80 dark:bg-slate-900/80 backdrop-blur-2xl shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-500 ease-out border-l border-white/40 dark:border-white/10">
                <div className="p-6 border-b border-slate-200/50 dark:border-slate-800/50 flex items-center justify-between bg-white/40 dark:bg-slate-900/40">
                    <h2 className="text-xl font-black flex items-center gap-2">
                        <ShoppingBag className="w-5 h-5" /> Your Cart
                    </h2>
                    <button
                        onClick={() => setIsCartOpen(false)}
                        className="p-2 hover:bg-white/50 dark:hover:bg-slate-800 rounded-full transition-colors"
                    >
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {items.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50">
                            <ShoppingBag className="w-16 h-16 text-slate-300" />
                            <p className="text-lg font-medium">Your cart is empty</p>
                            <button
                                onClick={() => setIsCartOpen(false)}
                                className="text-indigo-600 font-bold hover:underline"
                                style={{ color: primaryColor }}
                            >
                                Browse Menu
                            </button>
                        </div>
                    ) : (
                        items.map(item => (
                            <div key={item.bundleId} className="flex gap-4">
                                <div className="w-20 h-20 bg-slate-100 dark:bg-slate-800 rounded-xl overflow-hidden flex-shrink-0">
                                    {item.image_url ? (
                                        <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">No Img</div>
                                    )}
                                </div>
                                <div className="flex-1">
                                    <div className="flex justify-between items-start mb-1">
                                        <h3 className="font-bold text-slate-900 dark:text-white leading-tight">{item.name}</h3>
                                        <button
                                            onClick={() => removeFromCart(item.bundleId)}
                                            className="text-slate-400 hover:text-red-500 transition-colors p-1"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-3">{item.serving_tier}</p>

                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800 rounded-lg p-1">
                                            <button
                                                onClick={() => updateQuantity(item.bundleId, item.quantity - 1)}
                                                className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded-md shadow-sm transition-all"
                                            >
                                                <Minus className="w-3 h-3" />
                                            </button>
                                            <span className="text-sm font-bold w-4 text-center">{item.quantity}</span>
                                            <button
                                                onClick={() => updateQuantity(item.bundleId, item.quantity + 1)}
                                                className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded-md shadow-sm transition-all"
                                            >
                                                <Plus className="w-3 h-3" />
                                            </button>
                                        </div>
                                        <p className="font-black text-slate-900 dark:text-white">
                                            ${(item.price * item.quantity).toFixed(2)}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {items.length > 0 && (
                    <div className="p-6 border-t border-white/40 dark:border-slate-800/50 space-y-4 bg-white/50 dark:bg-slate-900/50 backdrop-blur-md">
                        <div className="flex justify-between items-end">
                            <span className="text-slate-500 font-medium">Subtotal</span>
                            <span className="text-2xl font-black text-slate-900 dark:text-white">${cartTotal.toFixed(2)}</span>
                        </div>
                        <button
                            onClick={() => setIsCheckoutOpen(true)}
                            className={`w-full py-4 rounded-xl font-black text-lg shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2 ${getContrastTextClass(primaryColor)}`}
                            style={{ backgroundColor: primaryColor }}
                        >
                            Checkout <ArrowRight className="w-5 h-5" />
                        </button>
                    </div>
                )}
            </div>

            {/* Checkout Modal */}
            <CheckoutModal
                isOpen={isCheckoutOpen}
                onClose={() => setIsCheckoutOpen(false)}
                primaryColor={primaryColor}
                businessId={businessId}
                slug={slug}
                cartTotal={cartTotal}
                items={items}
                campaignId={campaignId}
                campaignParticipantLabel={campaignParticipantLabel}
                storefrontConfig={storefrontConfig}
                onSuccess={() => {
                    setIsCheckoutOpen(false);
                    setIsCartOpen(false);
                    clearCart();
                }}
            />
        </>
    );
}
