'use client';

import { Share2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * COORDINATOR-GUIDE-SHARE-LINK-1 — the Success Guide's supporter link.
 *
 * ONE LINK, ONE AUTHORITY. The supporter ordering URL is resolved SERVER-SIDE by
 * GET /api/coordinator (`share.orderUrl`, FR-COORD-123): the tenant's own storefront
 * domain when it has one, otherwise the pinned platform origin. The dashboard's
 * Copy Link and Share Center read that field; so does the guide now, and nothing
 * here builds a URL of its own.
 *
 * The guide used to compose `window.location.origin + /shop/<slug>/fundraiser/<id>`
 * itself. That origin is wherever the coordinator happens to be reading — the
 * platform portal host, or a Vercel Preview host — so the guide handed out a
 * different link from the dashboard for every tenant with a storefront domain, and
 * an ephemeral, login-gated Preview host to anyone reading it on a Preview.
 *
 * When the API sent no URL there is nothing true to show, so both surfaces render
 * nothing rather than invent one.
 */

/** The supporter ordering URL exactly as /api/coordinator resolved it, or null. */
export function guideOrderUrl(
    campaign: { share?: { orderUrl?: unknown } | null } | null | undefined,
): string | null {
    const url = campaign?.share?.orderUrl;
    return typeof url === 'string' && url !== '' ? url : null;
}

/** Copies exactly the given supporter URL — no rebuilding, no normalising. */
export function copyGuideShareLink(orderUrl: string) {
    navigator.clipboard.writeText(orderUrl);
    toast.success('Public Link Copied!');
}

/** Opens the device's share sheet with exactly the given supporter URL. */
export function shareGuideLink(orderUrl: string, campaignName?: string | null) {
    if (navigator.share) {
        navigator.share({
            title: `${campaignName} Fundraiser`,
            text: `Support our fundraiser and solve dinner!`,
            url: orderUrl
        });
    }
}

export function GuideShareCard({ orderUrl }: { orderUrl: string | null }) {
    if (!orderUrl) return null;

    return (
        <div className="bg-slate-900 rounded-[2.5rem] p-10 text-white relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full -translate-y-20 translate-x-20 blur-3xl" />
            <div className="relative z-10 space-y-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center text-indigo-400">
                        <Share2 size={24} />
                    </div>
                    <h2 className="text-2xl font-black tracking-tight">Promote Your Online Order Form</h2>
                </div>
                <p className="text-slate-400 font-medium">
                    Share this link everywhere — texts, emails, Facebook, word-of-mouth! The more people who see your order form, the faster you hit your goal. Every share counts!
                </p>
                <div className="bg-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 border border-white/10 group">
                    <code className="text-xs font-mono text-indigo-300 truncate">{orderUrl}</code>
                    <button
                        onClick={() => copyGuideShareLink(orderUrl)}
                        className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-xs font-black uppercase transition-all"
                    >
                        Copy Link
                    </button>
                </div>
            </div>
        </div>
    );
}

export function GuideMobileShare({ orderUrl, campaignName }: { orderUrl: string | null; campaignName?: string | null }) {
    if (!orderUrl) return null;

    return (
        <div className="fixed bottom-6 left-0 right-0 px-6 z-40 md:hidden">
            <button
                onClick={() => shareGuideLink(orderUrl, campaignName)}
                className="w-full bg-indigo-600 text-white py-5 rounded-full font-black shadow-2xl shadow-indigo-500/40 flex items-center justify-center gap-3 active:scale-95 transition-all"
            >
                <Share2 size={24} /> Share Order Page
            </button>
        </div>
    );
}

export default GuideShareCard;
