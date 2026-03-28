'use client';

/**
 * SquarePaymentForm — Embedded Square Web Payments SDK
 * 
 * Renders an inline card form using Square's tokenization SDK.
 * On successful tokenization, sends the nonce to /api/checkout/square/pay
 * which processes the payment on the tenant's Square account.
 * 
 * Per Constitution §9: payment flows through tenant-owned credentials only.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, CreditCard, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

interface SquarePaymentFormProps {
  appId: string;
  locationId: string;
  orderId: string;
  amountCents: number;
  businessId: string;
  customerEmail?: string;
  successUrl: string;
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

declare global {
  interface Window {
    Square?: any;
  }
}

export default function SquarePaymentForm({
  appId,
  locationId,
  orderId,
  amountCents,
  businessId,
  customerEmail,
  successUrl,
  onSuccess,
  onError,
}: SquarePaymentFormProps) {
  const cardContainerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<any>(null);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  const [processing, setProcessing] = useState(false);

  // Load Square Web Payments SDK script
  useEffect(() => {
    if (window.Square) {
      setSdkLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = appId.startsWith('sandbox')
      ? 'https://sandbox.web.squarecdn.com/v1/square.js'
      : 'https://web.squarecdn.com/v1/square.js';
    script.async = true;
    script.onload = () => setSdkLoaded(true);
    script.onerror = () => {
      toast.error('Failed to load payment SDK');
      onError?.('Failed to load Square SDK');
    };
    document.body.appendChild(script);

    return () => {
      // Cleanup: don't remove the script since other instances might use it
    };
  }, [appId, onError]);

  // Initialize the card payment method
  useEffect(() => {
    if (!sdkLoaded || !window.Square || !cardContainerRef.current) return;

    let cancelled = false;

    const initCard = async () => {
      try {
        const payments = window.Square.payments(appId, locationId);
        const card = await payments.card();
        
        if (cancelled) return;
        
        await card.attach(cardContainerRef.current);
        cardRef.current = card;
        setCardReady(true);
      } catch (err: any) {
        console.error('[SQUARE_CARD_INIT]', err);
        if (!cancelled) {
          toast.error('Failed to initialize payment form');
          onError?.('Card initialization failed');
        }
      }
    };

    initCard();

    return () => {
      cancelled = true;
      if (cardRef.current) {
        try {
          cardRef.current.destroy();
        } catch {}
        cardRef.current = null;
      }
    };
  }, [sdkLoaded, appId, locationId, onError]);

  const handlePay = useCallback(async () => {
    if (!cardRef.current || processing) return;

    setProcessing(true);
    try {
      // Step 1: Tokenize the card
      const result = await cardRef.current.tokenize();
      if (result.status !== 'OK') {
        throw new Error(result.errors?.[0]?.message || 'Card tokenization failed');
      }

      // Step 2: Send token to our server for processing
      const res = await fetch('/api/checkout/square/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentToken: result.token,
          orderId,
          amountCents,
          businessId,
          customerEmail,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Payment failed');
      }

      toast.success('Payment completed! Redirecting...');

      // Only redirect. Do NOT call onSuccess() — it triggers React state
      // updates (close modal, clear cart) that race with the navigation
      // and can cause the redirect to be swallowed by a re-render.
      window.location.href = successUrl;
      return; // guard against any code after this

    } catch (err: any) {
      console.error('[SQUARE_PAY_ERROR]', err);
      toast.error(err.message || 'Payment failed. Please try again.');
      onError?.(err.message);
    } finally {
      setProcessing(false);
    }
  }, [processing, orderId, amountCents, businessId, customerEmail, successUrl, onSuccess, onError]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <CreditCard className="w-5 h-5 text-slate-400" />
        <h4 className="text-lg font-bold text-slate-700">Card Payment</h4>
      </div>

      {/* Square card input container */}
      <div
        ref={cardContainerRef}
        className="min-h-[56px] rounded-2xl overflow-hidden"
        style={{ opacity: cardReady ? 1 : 0.3, transition: 'opacity 0.3s' }}
      />

      {!cardReady && (
        <div className="flex items-center justify-center gap-2 py-4 text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading payment form...</span>
        </div>
      )}

      <button
        onClick={handlePay}
        disabled={!cardReady || processing}
        className="w-full py-5 rounded-[2rem] bg-indigo-600 text-white font-bold text-lg hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 flex items-center justify-center gap-3 disabled:opacity-50 disabled:shadow-none"
      >
        {processing ? (
          <Loader2 className="w-6 h-6 animate-spin" />
        ) : (
          <>
            Pay ${(amountCents / 100).toFixed(2)}
            <ShieldCheck className="w-5 h-5" />
          </>
        )}
      </button>

      <p className="text-center text-xs text-slate-400 flex items-center justify-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5" />
        Secured by Square
      </p>
    </div>
  );
}
