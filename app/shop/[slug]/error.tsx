'use client';

import { useEffect } from 'react';

export default function ShopError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error('Shop page error:', error);
    }, [error]);

    return (
        <div className="min-h-screen flex items-center justify-center p-8 bg-slate-50">
            <div className="max-w-xl w-full bg-white rounded-3xl shadow-xl p-10 text-center">
                <h2 className="text-2xl font-bold text-slate-900 mb-4">Something went wrong</h2>
                <p className="text-slate-500 mb-2">We&apos;re sorry, this storefront encountered an error.</p>
                <pre className="bg-slate-100 text-red-600 text-xs p-4 rounded-xl mb-6 text-left overflow-auto max-h-48 whitespace-pre-wrap">
                    {error.message}
                    {error.digest && `\n\nDigest: ${error.digest}`}
                </pre>
                <button
                    onClick={reset}
                    className="bg-emerald-600 text-white px-8 py-3 rounded-full font-semibold hover:bg-emerald-700 transition-colors"
                >
                    Try Again
                </button>
            </div>
        </div>
    );
}
