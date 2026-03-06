"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer, Box } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react'; // Assuming this package is available as used in other print pages
import Link from 'next/link';
import Image from 'next/image';

interface Order {
    id: string;
    customer_name: string;
    delivery_address: string;
    items: any[];
    customer?: {
        name: string;
        contact_name?: string;
    }
    campaign?: {
        delivery_date?: string | null;
    };
    delivery_date?: string | null;
}

export default function PrintPackingSlipsPage() {
    const router = useRouter();
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const [logo, setLogo] = useState<string | null>(null);
    const [customQr, setCustomQr] = useState<string | null>(null);
    const [businessName, setBusinessName] = useState<string>('Freezer Chef');
    const [tagline, setTagline] = useState<string>('Deliciously Easy, home-cooked meals prepared fresh and frozen for your convenience.');
    const [thankYouNote, setThankYouNote] = useState<string>('Dear Friend, We just wanted to take a moment to send a giant, freezer-packed THANK YOU! Every time you choose {businessName}, you\'re doing more than just making dinnertime easier (and tastier)—you\'re supporting a small, local business with a big heart. Whether you\'re stocking your freezer for a busy week, gifting meals to someone special, or just giving yourself a well-deserved break from cooking—we’re so grateful to be part of your home.');
    const [reviewPrompt, setReviewPrompt] = useState<string>('If you enjoyed your {businessName} experience, we’d be so grateful if you left us a 5-star review on Facebook. Your kind words help more families discover deliciously easy dinners—and keep our small business growing strong.');
    const [signOff, setSignOff] = useState<string>('The Freezer Chef Team');

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch Orders
                const ordersRes = await fetch('/api/orders?status=pending,production_ready&include_details=true');
                const ordersData = await ordersRes.json();
                const sorted = ordersData.sort((a: any, b: any) =>
                    (a.delivery_sequence || 999) - (b.delivery_sequence || 999)
                );
                setOrders(sorted);

                // Fetch Tenant Branding (Source of Truth for Logo & QR)
                const brandingRes = await fetch('/api/tenant/branding');
                if (brandingRes.ok) {
                    const branding = await brandingRes.json();
                    if (branding.logo_url) setLogo(branding.logo_url);
                    if (branding.review_qr_url) setCustomQr(branding.review_qr_url);
                    if (branding.business_name) setBusinessName(branding.business_name);
                    if (branding.tagline) setTagline(branding.tagline);
                    if (branding.thank_you_note) setThankYouNote(branding.thank_you_note);
                    if (branding.review_prompt) setReviewPrompt(branding.review_prompt);
                    if (branding.sign_off) setSignOff(branding.sign_off);
                } else {
                    // Fallback to Business API if branding fails (legacy)
                    const bizRes = await fetch('/api/business');
                    if (bizRes.ok) {
                        const bizData = await bizRes.json();
                        if (bizData.logo_url) setLogo(bizData.logo_url);
                        if (bizData.name) setBusinessName(bizData.name);
                    }
                }
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, []);

    if (loading) return <div className="p-12 text-center">Loading packing slips...</div>;

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 print:bg-white">
            {/* Print Control Bar (Hidden when printing) */}
            <div className="print-hidden sticky top-0 z-50 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 p-4 shadow-sm mb-8">
                <div className="max-w-4xl mx-auto flex justify-between items-center">
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium transition-colors"
                    >
                        <ArrowLeft size={20} />
                        Back to Dashboard
                    </button>

                    <div className="flex items-center gap-4">
                        <div className="text-sm text-slate-500 font-medium">
                            {orders.length} Orders • {orders.reduce((acc, o) => acc + o.items.length, 0)} Items
                        </div>
                        <button
                            onClick={() => window.print()}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-full font-bold shadow-lg hover:shadow-indigo-500/30 transition-all flex items-center gap-2"
                        >
                            <Printer size={20} />
                            Print Packing Slips
                        </button>
                    </div>
                </div>
            </div>

            {/* ... Print logic ... */}
            <div className="print-area">
                <style dangerouslySetInnerHTML={{
                    __html: `
                    @media print {
                        @page { margin: 0; size: 8.5in 11in; }
                        body { background: white; -webkit-print-color-adjust: exact; }
                        .print-hidden { display: none !important; }
                        .page-break { page-break-after: always; }
                        .page-break:last-child { page-break-after: auto; }
                    }
                `}} />

                {orders.flatMap(order => {
                    // ... existing flatMap logic ...
                    return order.items.flatMap((item, itemIdx) => {
                        const slips = [];
                        for (let i = 0; i < item.quantity; i++) {
                            slips.push({ order, item, itemIdx, copyIndex: i });
                        }
                        return slips;
                    });
                }).map((slip, uniqueKey) => {
                    const { order, item } = slip;
                    const bundle = item.bundle;
                    const contents = bundle?.contents || [];

                    // Logic: Contact Name > Organization Name > Order Customer Name
                    const preparedForName = order.customer?.contact_name || order.customer?.name || order.customer_name;

                    // Date Logic: Campaign > Order > Today
                    let displayDate = new Date().toLocaleDateString();
                    if (order.campaign?.delivery_date) {
                        const d = new Date(order.campaign.delivery_date);
                        displayDate = d.toLocaleDateString(undefined, { timeZone: 'UTC' });
                    } else if (order.delivery_date) {
                        const d = new Date(order.delivery_date);
                        displayDate = d.toLocaleDateString(undefined, { timeZone: 'UTC' });
                    }

                    return (
                        <div key={`${order.id}-${slip.itemIdx}-${slip.copyIndex}`} className="page-break bg-white w-[8.5in] h-[11in] mx-auto p-[0.4in] relative box-border mb-8 print:mb-0 shadow-lg print:shadow-none flex flex-col">

                            {/* Header: Centered Logo & Slogan */}
                            <div className="flex flex-col items-center border-b border-slate-100 pb-2 mb-2">
                                {logo ? (
                                    <div className="h-28 relative w-80 mb-1">
                                        <img src={logo} alt="Logo" className="h-full w-full object-contain object-center" />
                                    </div>
                                ) : (
                                    <div className="text-3xl font-black text-slate-900 tracking-tight mb-1">
                                        {businessName}
                                    </div>
                                )}
                                <div className="text-center font-medium italic text-slate-600 text-xs">
                                    "{tagline}"
                                </div>
                            </div>

                            {/* Customer Info: Compact */}
                            <div className="bg-slate-50 px-4 py-2 rounded-lg mb-2 flex justify-between items-center border border-slate-100">
                                <div>
                                    <div className="text-[10px] uppercase font-bold text-slate-400">Prepared For</div>
                                    <div className="text-lg font-bold text-slate-900 truncate max-w-md leading-tight">{preparedForName}</div>
                                </div>
                                <div className="text-right">
                                    <div className="text-[10px] uppercase font-bold text-slate-400">Delivery Date</div>
                                    <div className="font-mono font-bold text-base leading-tight">{displayDate}</div>
                                </div>
                            </div>

                            {/* Thank You Section (Moved Here) */}
                            <div className="mb-4 text-justify">
                                <div className="text-sm text-slate-600 leading-relaxed space-y-2">
                                    <p>
                                        {thankYouNote.replace(/{businessName}/g, businessName)}
                                    </p>
                                </div>
                            </div>

                            {/* Contents List */}
                            <div className="flex-1 min-h-0 overflow-visible">
                                <h3 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2 uppercase tracking-wider border-b border-slate-100 pb-1">
                                    <Box size={14} className="text-indigo-500" />
                                    Box Contents
                                </h3>

                                {contents.length > 0 ? (
                                    <table className="w-full text-xs">
                                        <tbody>
                                            {contents.map((c: any, idx: number) => (
                                                <tr key={idx} className="border-b border-dashed border-slate-100">
                                                    <td className="py-1 font-medium text-slate-700">
                                                        {c.recipe?.name || 'Mystery Meal'}
                                                    </td>
                                                    <td className="py-1 text-right font-mono text-[10px] text-slate-400 w-16">
                                                        Qty: {c.quantity || 1}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div className="text-slate-400 italic py-2 text-xs">Contents not listed.</div>
                                )}
                            </div>

                            {/* Footer: Quick Tips & Review */}
                            <div className="mt-auto pt-4 border-t-2 border-slate-100 space-y-4">
                                {/* Quick Tips (Centered) */}
                                <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
                                    <h4 className="font-bold text-indigo-700 text-sm uppercase mb-3 text-center">
                                        💡 Quick Tips: Before Freezing & Cooking
                                    </h4>

                                    <div className="grid grid-cols-2 gap-6 text-xs text-indigo-900/80 font-medium leading-relaxed">
                                        <div className="text-center">
                                            <h5 className="font-bold text-indigo-800 mb-2">Before you put in freezer:</h5>
                                            <ul className="space-y-1 list-none">
                                                <li>• Wipe down any condensation on bag.</li>
                                                <li>• If you plan on eating one of the OVEN meals this week, place it in the fridge.</li>
                                            </ul>
                                        </div>
                                        <div className="text-center">
                                            <h5 className="font-bold text-indigo-800 mb-2">Before you Eat:</h5>
                                            <ul className="space-y-1 list-none">
                                                <li>• Please note cooking directions on each label.</li>
                                                <li>• "Serves 2" trays: replace lid with foil.</li>
                                                <li>• Only thaw instructed meals; otherwise crockpot frozen.</li>
                                                <li>• Proper thawing can take up to 36 hours.</li>
                                            </ul>
                                        </div>
                                    </div>
                                </div>

                                {/* Review / Footer Text */}
                                <div className="text-center space-y-2">
                                    <p className="font-bold text-indigo-600 text-base">💬 Love your meals? Let others know!</p>
                                    <p className="text-xs text-slate-600 max-w-2xl mx-auto leading-normal">
                                        {reviewPrompt.replace(/{businessName}/g, businessName)} <strong className="text-indigo-600 uppercase">Review Us!</strong>
                                    </p>

                                    <div className="flex justify-center items-center gap-1 pt-2">
                                        {customQr ? (
                                            <img src={customQr} alt="Review QR" className="w-16 h-16 object-contain" />
                                        ) : (
                                            <QRCodeSVG value="https://www.facebook.com/FreezerChef/reviews" size={64} />
                                        )}
                                    </div>

                                    <p className="text-[10px] text-slate-400 italic mt-1">– {signOff}</p>

                                    <div className="pt-2 border-t border-slate-100 flex flex-col items-center gap-1 text-[9px] text-slate-300 font-bold uppercase tracking-widest">
                                        <span>Real Meals. Real Easy. Really Local.</span>
                                        <span>{businessName} © {new Date().getFullYear()}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
