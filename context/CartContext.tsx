'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { toast } from 'sonner';

export interface CartItem {
    bundleId: string;
    name: string;
    price: number;
    quantity: number;
    image_url?: string;
    serving_tier: string;
    isSubscription?: boolean;
}

interface CartContextType {
    items: CartItem[];
    addToCart: (item: Omit<CartItem, 'quantity'> & { quantity?: number }) => void;
    removeFromCart: (bundleId: string) => void;
    updateQuantity: (bundleId: string, quantity: number) => void;
    clearCart: () => void;
    cartTotal: number;
    isCartOpen: boolean;
    setIsCartOpen: (isOpen: boolean) => void;
    cartCount: number;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children }: { children: ReactNode }) {
    const [items, setItems] = useState<CartItem[]>([]);
    const [isCartOpen, setIsCartOpen] = useState(false);

    // Load cart from localStorage on mount
    useEffect(() => {
        const savedCart = localStorage.getItem('freezeriq_cart');
        if (savedCart) {
            try {
                setItems(JSON.parse(savedCart));
            } catch (e) {
                console.error("Failed to parse cart", e);
            }
        }
    }, []);

    // Save cart to localStorage on change
    useEffect(() => {
        localStorage.setItem('freezeriq_cart', JSON.stringify(items));
    }, [items]);

    const addToCart = (newItem: Omit<CartItem, 'quantity'> & { quantity?: number }) => {
        const qty = newItem.quantity || 1;
        setItems(prev => {
            const existing = prev.find(i => i.bundleId === newItem.bundleId);
            if (existing) {
                toast.success(`Updated quantity for ${newItem.name}`);
                return prev.map(i => i.bundleId === newItem.bundleId
                    ? { ...i, quantity: i.quantity + qty }
                    : i
                );
            }
            toast.success(`Added ${qty} ${newItem.name}(s) to cart`);
            return [...prev, { ...newItem, quantity: qty }];
        });
        setIsCartOpen(true);
    };

    const removeFromCart = (bundleId: string) => {
        setItems(prev => prev.filter(i => i.bundleId !== bundleId));
    };

    const updateQuantity = (bundleId: string, quantity: number) => {
        if (quantity < 1) {
            removeFromCart(bundleId);
            return;
        }
        setItems(prev => prev.map(i => i.bundleId === bundleId ? { ...i, quantity } : i));
    };

    const clearCart = () => {
        setItems([]);
        localStorage.removeItem('freezeriq_cart');
    };

    const cartTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const cartCount = items.reduce((sum, item) => sum + item.quantity, 0);

    return (
        <CartContext.Provider value={{
            items,
            addToCart,
            removeFromCart,
            updateQuantity,
            clearCart,
            cartTotal,
            isCartOpen,
            setIsCartOpen,
            cartCount
        }}>
            {children}
        </CartContext.Provider>
    );
}

export function useCart() {
    const context = useContext(CartContext);
    if (context === undefined) {
        throw new Error('useCart must be used within a CartProvider');
    }
    return context;
}
