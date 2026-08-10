'use client';

/**
 * SF-4 — Bag redesign (BAG STEP ONLY).
 *
 * This drawer IS the storefront bag: it is where the customer reviews line
 * items, changes quantities, and leaves for checkout. (`CheckoutModal` also
 * contains a `'bag'` step, but nothing ever sets it — see the deferral note in
 * the SF-4 report. It is untouched here.)
 *
 * WHAT SF-4 CHANGED: presentation only — SF-1 brand tokens instead of raw
 * tenant hex, the handoff's RoundOutRow suggestion strip, the FreeDeliveryBar
 * seam, and the directed footer treatment ("Total" / "Checkout securely →").
 *
 * WHAT SF-4 DID NOT CHANGE, deliberately: cart state, add/remove/quantity
 * semantics, pricing, persistence, and the checkout handoff. The CTA still calls
 * exactly what it called before — `setIsCheckoutOpen(true)` — which opens the
 * EXISTING CheckoutModal on its existing `'details'` step. No new checkout flow,
 * no fulfillment logic moved into the bag.
 */

import { X, Plus, Minus, ShoppingBag, ArrowRight } from 'lucide-react';
import { useCart } from '@/context/CartContext';
import { useMemo, useState } from 'react';
import CheckoutModal from './CheckoutModal';
import Link from 'next/link';
import { RoundOutRow, selectRoundOutBundles } from '@/components/storefront/RoundOutRow';
import { FreeDeliveryBar } from '@/components/storefront/FreeDeliveryBar';

interface CartDrawerProps {
    primaryColor: string;
    businessId: string;
    slug: string;
    campaignId?: string;
    campaignParticipantLabel?: string | null;
    storefrontConfig?: any;
    /** SF-4: tenant-scoped storefront bundles, used only to source suggestions. */
    bundles?: any[];
}

export default function CartDrawer({ primaryColor, businessId, slug, campaignId, campaignParticipantLabel, storefrontConfig, bundles }: CartDrawerProps) {
    const { isCartOpen, setIsCartOpen, items, addToCart, removeFromCart, updateQuantity, cartTotal, cartCount, clearCart } = useCart();
    const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);

    const bundleIdsInBag = useMemo(() => new Set(items.map(i => i.bundleId)), [items]);
    const roundOut = useMemo(
        () => selectRoundOutBundles(bundles ?? [], bundleIdsInBag),
        [bundles, bundleIdsInBag],
    );

    // EXACT existing cart contract — the same shape SF-3 adds with, so a
    // suggestion added here is indistinguishable from one added on the page.
    const addSuggestion = (b: any) => addToCart({
        bundleId: b.id,
        name: b.name,
        price: Number(b.price),
        image_url: b.image_url || undefined,
        serving_tier: b.serving_tier,
    });

    if (!isCartOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 transition-opacity"
                onClick={() => setIsCartOpen(false)}
            />

            {/* Drawer */}
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="sf4-bag-title"
                className="fixed inset-y-0 right-0 w-full max-w-md bg-[var(--sf-card)] text-[var(--sf-ink)] shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-500 ease-out border-l border-[var(--sf-line)]"
            >
                <div className="flex items-center justify-between border-b border-[var(--sf-line)] p-6">
                    <h2 id="sf4-bag-title" className="flex items-center gap-2 text-xl font-black">
                        <ShoppingBag className="h-5 w-5" aria-hidden="true" /> Your Bag
                    </h2>
                    <button
                        onClick={() => setIsCartOpen(false)}
                        aria-label="Close bag"
                        className="grid h-11 w-11 place-items-center rounded-full text-[var(--sf-muted)] transition-colors hover:bg-[var(--sf-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {items.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center space-y-4 text-center">
                            <ShoppingBag className="h-16 w-16 text-[var(--sf-line)]" aria-hidden="true" />
                            <p className="text-lg font-bold text-[var(--sf-muted)]">Your bag is empty</p>
                            <button
                                onClick={() => setIsCartOpen(false)}
                                className="min-h-[44px] px-4 font-bold text-[var(--sf-primary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
                            >
                                Browse Menu
                            </button>
                        </div>
                    ) : (
                        <>
                            <ul className="space-y-6">
                                {items.map(item => (
                                    <li key={item.bundleId} className="w-full">
                                        <div className="mb-1 flex items-start justify-between gap-3">
                                            {/* Clamped so a long bundle name cannot push the
                                                remove control off the row. */}
                                            <h3 className="font-bold leading-tight line-clamp-2">{item.name}</h3>
                                            <button
                                                onClick={() => removeFromCart(item.bundleId)}
                                                aria-label={`Remove ${item.name} from your bag`}
                                                className="grid h-11 w-11 flex-none place-items-center rounded-full text-[var(--sf-muted)] transition-colors hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        </div>
                                        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--sf-muted)]">{item.serving_tier}</p>

                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-1 rounded-lg bg-[var(--sf-soft)] p-1">
                                                <button
                                                    onClick={() => updateQuantity(item.bundleId, item.quantity - 1)}
                                                    aria-label={`Decrease quantity of ${item.name}`}
                                                    className="grid h-11 w-11 place-items-center rounded-md transition-all hover:bg-[var(--sf-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
                                                >
                                                    <Minus className="h-3 w-3" />
                                                </button>
                                                <span className="w-6 text-center text-sm font-bold tabular-nums" aria-live="polite">{item.quantity}</span>
                                                <button
                                                    onClick={() => updateQuantity(item.bundleId, item.quantity + 1)}
                                                    aria-label={`Increase quantity of ${item.name}`}
                                                    className="grid h-11 w-11 place-items-center rounded-md transition-all hover:bg-[var(--sf-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
                                                >
                                                    <Plus className="h-3 w-3" />
                                                </button>
                                            </div>
                                            <p className="font-black tabular-nums">
                                                ${(item.price * item.quantity).toFixed(2)}
                                            </p>
                                        </div>
                                    </li>
                                ))}
                            </ul>

                            {/* SF-4 RoundOutRow — renders nothing when nothing qualifies. */}
                            <RoundOutRow addOns={roundOut} onAdd={addSuggestion} addedIds={bundleIdsInBag} />

                            {/* SF-4 seam: the SF-3 FreeDeliveryBar, wired to the same honest
                                source it uses on the page. No tenant free-delivery threshold
                                field exists, so it renders NOTHING today rather than promising
                                a number nobody configured. It lights up automatically if a real
                                threshold is ever added. */}
                            <FreeDeliveryBar subtotal={cartTotal} threshold={null} />
                        </>
                    )}
                </div>

                {items.length > 0 && (
                    <div
                        className="border-t border-[var(--sf-line)] bg-[var(--sf-card)]"
                        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                    >
                        {/* Directed SF-4 footer treatment: the StickyCartBar variant —
                            count chip, "Total", amount, "Checkout securely →".
                            Shown at full precision (2dp): this is the figure the
                            customer is about to pay, not a glanceable page summary. */}
                        <div className="flex items-center gap-3 bg-[var(--sf-ink)] px-4 py-3 text-white">
                            <span className="grid h-6 min-w-6 place-items-center rounded-full bg-[var(--sf-primary)] px-1.5 text-[11px] font-extrabold" aria-hidden="true">{cartCount}</span>
                            <span className="text-sm font-bold">Total</span>
                            <span className="ml-auto font-extrabold tabular-nums">${cartTotal.toFixed(2)}</span>
                        </div>
                        <div className="space-y-2 p-4">
                            <button
                                onClick={() => setIsCheckoutOpen(true)}
                                aria-label={`Checkout securely — ${cartCount} item${cartCount === 1 ? '' : 's'}, $${cartTotal.toFixed(2)}`}
                                className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-[var(--sf-primary)] text-lg font-black text-[var(--sf-on-primary)] shadow-lg transition-all hover:bg-[var(--sf-primary-press)] active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sf-primary)]"
                            >
                                Checkout securely <ArrowRight className="h-5 w-5" aria-hidden="true" />
                            </button>
                            {/* Trust line — states only what is verifiably true of the
                                next step. No security badge or guarantee is claimed. */}
                            <p className="text-center text-[11px] font-medium text-[var(--sf-muted)]">
                                You&rsquo;ll confirm delivery and payment details on the next step.
                            </p>
                            <button
                                onClick={() => setIsCartOpen(false)}
                                className="min-h-[44px] w-full font-bold text-[var(--sf-muted)] transition-colors hover:text-[var(--sf-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
                            >
                                Continue Shopping
                            </button>
                            <Link
                                href={`/shop/${slug}/login`}
                                className="block w-full py-2 text-center text-xs font-medium text-[var(--sf-muted)] transition-colors hover:text-[var(--sf-primary)]"
                            >
                                Already a customer? Sign in here
                            </Link>
                        </div>
                    </div>
                )}
            </div>

            {/* Checkout Modal — UNCHANGED handoff target. */}
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
