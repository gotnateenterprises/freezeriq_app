'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, Loader2, ChevronRight, ArrowLeft, ShoppingBag, CreditCard, User, Heart, MapPin } from 'lucide-react';
import { useCart, CartItem } from '@/context/CartContext';
import { toast } from 'sonner';
import CheckoutUpsell from './CheckoutUpsell';
import SquarePaymentForm from './SquarePaymentForm';
import Image from 'next/image';

interface CheckoutModalProps {
    isOpen: boolean;
    onClose: () => void;
    primaryColor: string;
    businessId: string;
    slug: string;
    items: CartItem[];
    cartTotal: number;
    onSuccess: () => void;
    campaignId?: string;
    campaignParticipantLabel?: string | null;
    storefrontConfig?: any;
}

type CheckoutStep = 'bag' | 'details' | 'confirm' | 'success';

export default function CheckoutModal({ isOpen, onClose, primaryColor, businessId, slug, items, cartTotal, onSuccess, campaignId, campaignParticipantLabel, storefrontConfig }: CheckoutModalProps) {
    const [step, setStep] = useState<CheckoutStep>('details');
    const [loading, setLoading] = useState(false);
    const [paymentData, setPaymentData] = useState<any>(null);
    const [squareConfig, setSquareConfig] = useState<any>(null);
    const [formData, setFormData] = useState({
        name: '',
        email: '',
        phone: '',
        address: '',
        city: '',
        state: '',
        zip: '',
        notes: '',
        participantCode: ''
    });
    const [fulfillmentType, setFulfillmentType] = useState<'pickup' | 'delivery'>(
        storefrontConfig?.is_pickup_enabled === false ? 'delivery' : 'pickup'
    );
    const [deliveryValidation, setDeliveryValidation] = useState<{
        status: 'idle' | 'loading' | 'ok' | 'error';
        zoneName?: string;
        fee?: number;
        error?: string;
    }>({ status: 'idle' });

    const validateDelivery = async () => {
        if (!formData.address || !formData.city || !formData.state || !formData.zip) {
            toast.error('Please fill in all address fields.');
            return;
        }
        setDeliveryValidation({ status: 'loading' });
        try {
            const res = await fetch('/api/checkout/validate-delivery', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    slug,
                    address: formData.address,
                    city: formData.city,
                    state: formData.state,
                    zip: formData.zip
                })
            });
            const data = await res.json();
            if (!res.ok || !data.deliverable) {
                setDeliveryValidation({
                    status: 'error',
                    error: data.error || data.reason || 'This address is outside our delivery area.'
                });
            } else {
                setDeliveryValidation({
                    status: 'ok',
                    zoneName: data.zoneName,
                    fee: Number(data.fee)
                });
            }
        } catch {
            setDeliveryValidation({ status: 'error', error: 'Could not validate address. Please try again.' });
        }
    };

    const { addToCart } = useCart();

    if (!isOpen) return null;

    const handleSubmit = async () => {
        // If a Square session already exists, reuse it — don't create another pending order
        if (squareConfig) {
            setStep('confirm');
            return;
        }
        setLoading(true);
        try {
            // Fundraiser campaign orders: coordinators collect payments externally
            // (Venmo, cash, check) — use the offline /api/public/order path.
            if (campaignId) {
                const res = await fetch('/api/public/order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        items,
                        customer: formData,
                        businessId,
                        slug,
                        campaignId
                    })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to place order');

                setPaymentData(data.paymentData);
                setStep('success');
                toast.success('Order placed successfully!');
                return;
            }

            // Regular storefront orders: create checkout session.
            // The response will indicate redirect (Stripe) or embedded (Square).
            const checkoutRes = await fetch('/api/checkout/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    slug,
                    items,
                    customerName: formData.name,
                    customerEmail: formData.email,
                    customerPhone: formData.phone,
                    customerNotes: formData.notes,
                    fulfillmentType: fulfillmentType,
                    address: formData.address,
                    city: formData.city,
                    state: formData.state,
                    zip: formData.zip
                })
            });

            const checkoutData = await checkoutRes.json();

            if (!checkoutRes.ok) {
                throw new Error(checkoutData.error || 'Checkout failed. Please try again.');
            }

            if (checkoutData.type === 'redirect' && checkoutData.url) {
                // Stripe: redirect to hosted checkout
                window.location.href = checkoutData.url;
                return;
            }

            if (checkoutData.type === 'embedded' && checkoutData.squareConfig) {
                // Square: show embedded payment form inline
                setSquareConfig({
                    appId: checkoutData.squareConfig.appId,
                    locationId: checkoutData.squareConfig.locationId,
                    orderId: checkoutData.orderId,
                    amountCents: checkoutData.amountCents,
                    successUrl: checkoutData.successUrl,
                    customerEmail: formData.email,
                });
                setStep('confirm');
                setLoading(false);
                return;
            }

            // Stripe not available (tenant hasn't connected Stripe) — fall back to
            // offline-payment /api/public/order path so the order is still captured.
            const res = await fetch('/api/public/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items,
                    customer: formData,
                    businessId,
                    slug
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to place order');

            setPaymentData(data.paymentData);
            setStep('success');
            toast.success('Order placed successfully!');
        } catch (err: any) {
            toast.error(err.message);
        } finally {
            setLoading(false);
        }
    };

    const hasUpsell = storefrontConfig?.upsell_type === 'manual'
        ? items.some(i => i.bundleId === 'manual_upsell')
        : (storefrontConfig?.upsell_bundle_id && items.some(i => i.bundleId === storefrontConfig.upsell_bundle_id));

    const onAddUpsell = (id: string) => {
        if (!storefrontConfig) return;
        if (id === 'manual_upsell') {
            const price = Number(storefrontConfig.manual_upsell_price || 0);
            const discount = storefrontConfig.upsell_discount_percent || 0;
            const finalPrice = price * (1 - discount / 100);
            addToCart({
                bundleId: 'manual_upsell',
                name: storefrontConfig.manual_upsell_name || 'Special Offer',
                price: finalPrice,
                image_url: storefrontConfig.manual_upsell_image,
                serving_tier: 'single'
            });
        } else {
            if (!storefrontConfig.upsell_bundle) return;
            const originalPrice = Number(storefrontConfig.upsell_bundle.price);
            const discount = storefrontConfig.upsell_discount_percent || 0;
            const finalPrice = originalPrice * (1 - discount / 100);
            addToCart({
                bundleId: storefrontConfig.upsell_bundle.id,
                name: storefrontConfig.upsell_bundle.name,
                price: finalPrice,
                image_url: storefrontConfig.upsell_bundle.image_url,
                serving_tier: storefrontConfig.upsell_bundle.serving_tier || 'family'
            });
        }
    };

    const slideVariants = {
        enter: (direction: number) => ({ x: direction > 0 ? 300 : -300, opacity: 0 }),
        center: { x: 0, opacity: 1 },
        exit: (direction: number) => ({ x: direction < 0 ? 300 : -300, opacity: 0 })
    };

    // --- RENDER FUNCTIONS ---

    const renderBagStep = () => (
        <motion.div
            key="bag" custom={1} variants={slideVariants} initial="enter" animate="center" exit="exit"
            className="space-y-6"
        >
            <div className="flex items-center gap-3 mb-8">
                <ShoppingBag className="w-6 h-6 text-slate-400" />
                <h3 className="text-3xl font-serif text-slate-800">Your Bag</h3>
            </div>

            <div className="space-y-4 max-h-[40vh] overflow-y-auto px-1 pr-2 scrollbar-hide">
                {items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-4 group">
                        <div className="relative w-16 h-16 rounded-2xl overflow-hidden bg-slate-100 flex-shrink-0">
                            <Image
                                src={item.image_url || '/placeholder-bundle.jpg'}
                                alt={item.name}
                                fill
                                className="object-cover"
                            />
                        </div>
                        <div className="flex-1">
                            <h4 className="font-bold text-slate-800">{item.name}</h4>
                            <p className="text-xs text-slate-400 uppercase tracking-widest font-bold">Qty: {item.quantity || 1} • {item.serving_tier}</p>
                        </div>
                        <span className="font-serif text-lg text-slate-600">${Number(item.price).toFixed(2)}</span>
                    </div>
                ))}
            </div>

            {(storefrontConfig?.upsell_bundle_id || storefrontConfig?.manual_upsell_name) && !hasUpsell && (
                <div className="pt-4">
                    <CheckoutUpsell config={storefrontConfig} onAdd={onAddUpsell} />
                </div>
            )}

            <div className="pt-6 border-t border-slate-100">
                <div className="flex justify-between items-center mb-6">
                    <span className="text-slate-400 font-bold uppercase tracking-widest text-xs">Subtotal</span>
                    <span className="text-3xl font-serif text-slate-900">${cartTotal.toFixed(2)}</span>
                </div>
                <button
                    onClick={() => setStep('details')}
                    className="w-full py-5 rounded-[2rem] bg-slate-900 text-white font-bold text-lg hover:bg-black transition-all shadow-xl flex items-center justify-center gap-3 group"
                >
                    Continue to Details <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </button>
            </div>
        </motion.div>
    );

    const renderDetailsStep = () => (
        <motion.div
            key="details" custom={1} variants={slideVariants} initial="enter" animate="center" exit="exit"
            className="space-y-6"
        >
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                    <User className="w-6 h-6 text-slate-400" />
                    <h3 className="text-3xl font-serif text-slate-800">Your Details</h3>
                </div>
            </div>

            {/* Fulfillment Selector */}
            {!campaignId && (storefrontConfig?.is_delivery_enabled !== false || storefrontConfig?.is_pickup_enabled !== false) && (
                <div className="flex p-1 bg-slate-100 rounded-2xl">
                    {storefrontConfig?.is_pickup_enabled !== false && (
                        <button
                            onClick={() => setFulfillmentType('pickup')}
                            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all ${fulfillmentType === 'pickup' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                        >
                            <ShoppingBag size={18} />
                            Pickup
                        </button>
                    )}
                    {storefrontConfig?.is_delivery_enabled !== false && (
                        <button
                            onClick={() => setFulfillmentType('delivery')}
                            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all ${fulfillmentType === 'delivery' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                        >
                            <ChevronRight size={18} className="rotate-90" />
                            Delivery
                        </button>
                    )}
                </div>
            )}

            <div className="space-y-5">
                <div className="relative">
                    <input
                        required placeholder="Full Name"
                        className="w-full px-6 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium"
                        value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
                    />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <input
                        required type="email" placeholder="Email Address"
                        className="w-full px-6 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium"
                        value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })}
                    />
                    <input
                        required type="tel" placeholder="Phone Number"
                        className="w-full px-6 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium"
                        value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })}
                    />
                </div>

                {fulfillmentType === 'delivery' && (
                    <div className="space-y-4 pt-2 animate-in fade-in slide-in-from-top-2">
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest pl-2">Delivery Address</p>
                        <input
                            required placeholder="Street Address"
                            className="w-full px-6 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium"
                            value={formData.address} onChange={e => { setFormData({ ...formData, address: e.target.value }); setDeliveryValidation({ status: 'idle' }); }}
                        />
                        <div className="grid grid-cols-6 gap-4">
                            <input
                                required placeholder="City"
                                className="col-span-3 px-6 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium"
                                value={formData.city} onChange={e => { setFormData({ ...formData, city: e.target.value }); setDeliveryValidation({ status: 'idle' }); }}
                            />
                            <input
                                required placeholder="State"
                                className="col-span-1 px-4 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium text-center uppercase"
                                value={formData.state} onChange={e => { setFormData({ ...formData, state: e.target.value }); setDeliveryValidation({ status: 'idle' }); }}
                            />
                            <input
                                required placeholder="Zip"
                                className="col-span-2 px-6 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium"
                                value={formData.zip} onChange={e => { setFormData({ ...formData, zip: e.target.value }); setDeliveryValidation({ status: 'idle' }); }}
                            />
                        </div>

                        {/* Delivery zone validation */}
                        {storefrontConfig?.delivery_zones?.length > 0 && (
                            <div className="space-y-2">
                                <button
                                    type="button"
                                    onClick={validateDelivery}
                                    disabled={deliveryValidation.status === 'loading' || !formData.address || !formData.city || !formData.state || !formData.zip}
                                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-50 text-blue-700 font-bold text-sm hover:bg-blue-100 transition-colors disabled:opacity-50"
                                >
                                    {deliveryValidation.status === 'loading' ? (
                                        <><Loader2 size={16} className="animate-spin" /> Checking...</>
                                    ) : (
                                        <><MapPin size={16} /> Check Delivery Availability</>
                                    )}
                                </button>

                                {deliveryValidation.status === 'ok' && (
                                    <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm font-medium">
                                        <CheckCircle size={16} />
                                        <span>
                                            <strong>{deliveryValidation.zoneName}</strong> — Delivery fee: <strong>${deliveryValidation.fee?.toFixed(2)}</strong>
                                        </span>
                                    </div>
                                )}

                                {deliveryValidation.status === 'error' && (
                                    <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-red-700 text-sm font-medium">
                                        <X size={16} />
                                        <span>{deliveryValidation.error}</span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {campaignId && campaignParticipantLabel && (
                    <div className="p-6 bg-indigo-50/50 rounded-3xl border border-indigo-50">
                        <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-3">Supporting {campaignParticipantLabel}</p>
                        <input
                            required placeholder="e.g. Johnny Appleseed"
                            className="w-full px-0 bg-transparent border-b-2 border-indigo-100 outline-none focus:border-indigo-400 transition-all font-bold text-lg text-indigo-900 placeholder:text-indigo-200 placeholder:font-medium"
                            value={formData.participantCode} onChange={e => setFormData({ ...formData, participantCode: e.target.value })}
                        />
                    </div>
                )}

                <textarea
                    placeholder="Order Notes (Optional)"
                    className="w-full px-6 py-4 rounded-2xl bg-slate-50 border-none outline-none focus:ring-2 focus:ring-slate-200 transition-all font-bold text-lg text-slate-900 placeholder:text-slate-300 placeholder:font-medium min-h-[100px]"
                    value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })}
                />
            </div>

            <div className="pt-6">
                <button
                    disabled={
                        !formData.name || !formData.email || !formData.phone ||
                        (fulfillmentType === 'delivery' && storefrontConfig?.delivery_zones?.length > 0 && deliveryValidation.status !== 'ok')
                    }
                    onClick={() => setStep('confirm')}
                    className="w-full py-5 rounded-[2rem] bg-indigo-600 text-white font-bold text-lg hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-200 disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-3 group"
                >
                    Review Order <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </button>
                {fulfillmentType === 'delivery' && storefrontConfig?.delivery_zones?.length > 0 && deliveryValidation.status !== 'ok' && (
                    <p className="text-center text-xs text-amber-500 mt-2 font-medium">Please check delivery availability before continuing.</p>
                )}
            </div>
        </motion.div>
    );

    const renderConfirmStep = () => (
        <motion.div
            key="confirm" custom={1} variants={slideVariants} initial="enter" animate="center" exit="exit"
            className="space-y-6"
        >
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                    <CreditCard className="w-6 h-6 text-slate-400" />
                    <h3 className="text-3xl font-serif text-slate-800">Review</h3>
                </div>
                <button onClick={() => setStep('details')} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400">
                    <ArrowLeft className="w-5 h-5" />
                </button>
            </div>

            <div className="p-8 bg-slate-50 rounded-[2.5rem] space-y-4">
                <div className="space-y-2">
                    <div className="flex justify-between items-center text-slate-500 font-medium text-sm">
                        <span>Subtotal ({items.length} items)</span>
                        <span>${cartTotal.toFixed(2)}</span>
                    </div>
                    {storefrontConfig?.tax_percent > 0 && (
                        <div className="flex justify-between items-center text-slate-500 font-medium text-sm">
                            <span>Tax ({Number(storefrontConfig.tax_percent).toFixed(2)}%)</span>
                            <span>${(cartTotal * Number(storefrontConfig.tax_percent) / 100).toFixed(2)}</span>
                        </div>
                    )}
                    {fulfillmentType === 'delivery' && (() => {
                        const fee = deliveryValidation.status === 'ok' ? deliveryValidation.fee! : Number(storefrontConfig?.delivery_fee || 0);
                        const label = deliveryValidation.status === 'ok' && deliveryValidation.zoneName
                            ? `Delivery (${deliveryValidation.zoneName})`
                            : 'Delivery Fee';
                        return fee > 0 ? (
                            <div className="flex justify-between items-center text-slate-500 font-medium text-sm">
                                <span>{label}</span>
                                <span>${fee.toFixed(2)}</span>
                            </div>
                        ) : null;
                    })()}
                </div>
                
                <div className="h-px bg-slate-200 my-4" />
                
                <div className="flex justify-between items-start">
                    <div>
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                            {fulfillmentType === 'delivery' ? 'Shipping To' : 'Pickup For'}
                        </p>
                        <p className="text-lg font-bold text-slate-800">{formData.name}</p>
                        {fulfillmentType === 'delivery' && formData.address && (
                            <p className="text-slate-600 font-medium text-sm leading-relaxed">
                                {formData.address}<br />
                                {formData.city}, {formData.state} {formData.zip}
                            </p>
                        )}
                        {fulfillmentType === 'pickup' && (
                            <p className="text-slate-500 font-medium text-sm">In-store Pickup</p>
                        )}
                    </div>
                    <div className="text-right">
                        <h2 className="text-4xl font-serif text-slate-900">
                            ${(
                                cartTotal + 
                                (cartTotal * Number(storefrontConfig?.tax_percent || 0) / 100) + 
                                (fulfillmentType === 'delivery'
                                    ? (deliveryValidation.status === 'ok' ? deliveryValidation.fee! : Number(storefrontConfig?.delivery_fee || 0))
                                    : 0)
                            ).toFixed(2)}
                        </h2>
                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Total Due</p>
                    </div>
                </div>
            </div>

            {/* Square embedded payment form */}
            {squareConfig ? (
                <div className="pt-6">
                    <SquarePaymentForm
                        appId={squareConfig.appId}
                        locationId={squareConfig.locationId}
                        orderId={squareConfig.orderId}
                        amountCents={squareConfig.amountCents}
                        businessId={businessId}
                        customerEmail={squareConfig.customerEmail}
                        successUrl={squareConfig.successUrl}
                        onSuccess={onSuccess}
                        onError={(err) => toast.error(err)}
                    />
                </div>
            ) : (
                <div className="pt-6 space-y-4">
                    <button
                        disabled={loading}
                        onClick={handleSubmit}
                        className="w-full py-5 rounded-[2rem] bg-indigo-600 text-white font-bold text-lg hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 flex items-center justify-center gap-3 group disabled:opacity-70"
                    >
                        {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : <>Complete My Order <Heart className="w-5 h-5 fill-white" /></>}
                    </button>
                    <p className="text-center text-xs text-slate-400 px-8 leading-relaxed">
                        {campaignId
                            ? 'By confirming, you agree to receive order updates. No payment is required until pickup/delivery is confirmed.'
                            : 'By confirming, you agree to receive order updates. Payment is due today. Delivery or pickup will be scheduled afterward.'}
                    </p>
                </div>
            )}
        </motion.div>
    );

    const renderSuccessStep = () => (
        <motion.div
            key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
            className="p-12 text-center space-y-8"
        >
            <div className="w-24 h-24 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-emerald-500 shadow-inner">
                <CheckCircle className="w-12 h-12" />
            </div>

            <div className="space-y-3">
                <h2 className="text-4xl font-serif text-slate-900 leading-tight">Thank you, <br /> {formData.name.split(' ')[0]}</h2>
                <p className="text-slate-500 font-medium leading-relaxed">We've received your order and sent a confirmation <br /> to your email.</p>
            </div>

            {campaignId ? (
                <div className="bg-amber-50 p-8 rounded-[2rem] border border-amber-100 shadow-sm animate-in zoom-in slide-in-from-bottom-4 duration-500">
                    <h4 className="text-amber-900 font-black mb-2 text-2xl">Payment Pending</h4>
                    <p className="text-amber-800 font-medium mb-6 text-sm">
                        Success! Your total is <strong className="text-amber-900">${cartTotal.toFixed(2)}</strong>. To confirm your order, please pay {paymentData?.orgName || 'your coordinator'} directly.
                    </p>
                    {paymentData?.paymentInstructions ? (
                        <div className="bg-white p-5 rounded-2xl border border-amber-200 text-amber-900 mb-6 text-sm font-medium italic shadow-sm">
                            "{paymentData.paymentInstructions}"
                        </div>
                    ) : (
                        <p className="text-amber-700 text-sm mb-6 bg-amber-100/50 p-4 rounded-xl">
                            Please submit payment via Cash, Check, or Venmo directly to the organization.
                        </p>
                    )}
                    {paymentData?.externalPaymentLink && (
                        <a
                            href={paymentData.externalPaymentLink}
                            target="_blank" rel="noopener noreferrer"
                            className="inline-block bg-amber-500 text-white font-bold py-4 px-10 rounded-2xl hover:bg-amber-600 transition-all shadow-xl shadow-amber-200"
                        >
                            Pay Online Now
                        </a>
                    )}
                </div>
            ) : (
                paymentData?.externalPaymentLink && (
                    <div className="bg-indigo-50 p-8 rounded-[2rem] border border-indigo-100 shadow-sm animate-in zoom-in slide-in-from-bottom-4 duration-500">
                        <h4 className="text-indigo-900 font-black mb-1">Final Step</h4>
                        <p className="text-indigo-700 text-sm mb-6">Complete your payment securely via our link:</p>
                        <a
                            href={paymentData.externalPaymentLink}
                            target="_blank" rel="noopener noreferrer"
                            className="inline-block bg-indigo-600 text-white font-bold py-4 px-10 rounded-2xl hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100"
                        >
                            Pay Securely
                        </a>
                    </div>
                )
            )}

            <button onClick={onSuccess} className="w-full text-slate-400 font-bold hover:text-slate-600 transition-colors py-4">
                Back to Store
            </button>
        </motion.div>
    );

    return (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-[60] flex items-center justify-center p-4">
            <div className="relative bg-white rounded-[3rem] w-full max-w-xl shadow-[0_32px_96px_-12px_rgba(0,0,0,0.1)] overflow-hidden transition-all duration-300 max-h-[92vh] flex flex-col">
                <button
                    onClick={onClose}
                    className="absolute top-8 right-8 p-2 hover:bg-slate-50 rounded-full transition-colors text-slate-300 z-50"
                >
                    <X className="w-6 h-6" />
                </button>

                <div className="p-12 py-10 overflow-y-auto scrollbar-hide">
                    <AnimatePresence mode="wait">
                        {step === 'bag' && renderBagStep()}
                        {step === 'details' && renderDetailsStep()}
                        {step === 'confirm' && renderConfirmStep()}
                        {step === 'success' && renderSuccessStep()}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
}
