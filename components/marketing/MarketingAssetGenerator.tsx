'use client';

import React, { useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2, Share2, FileText, Instagram } from 'lucide-react';
import { format } from 'date-fns';

interface MarketingAssetGeneratorProps {
    campaign: {
        name: string;
        goal_amount?: number;
        end_date?: string | Date;
        pickup_location?: string;
        delivery_date?: string | Date;
        public_token?: string;
        portal_token?: string;
    };
    organizationName: string;
    baseUrl?: string;
}

export default function MarketingAssetGenerator({
    campaign,
    organizationName,
    baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://freezeriq.com' // Fallback
}: MarketingAssetGeneratorProps) {
    const [isGenerating, setIsGenerating] = useState(false);

    const flyerRef = useRef<HTMLDivElement>(null);

    const socialSquareRef = useRef<HTMLDivElement>(null);
    const socialStoryRef = useRef<HTMLDivElement>(null);

    const publicLink = `${baseUrl}/fundraiser/${campaign.public_token}`;


    /**
     * html2canvas parses ALL stylesheets in the cloned document. Tailwind v4
     * generates oklch()/lab() color functions that html2canvas cannot parse.
     * Fix: inline every computed style (browser resolves oklch→rgb) on the
     * capture target, then strip all stylesheets from the clone.
     */
    const sanitizeCloneForCapture = (clonedDoc: Document, element: HTMLElement) => {
        const win = clonedDoc.defaultView;
        if (!win) return;
        const inlineAll = (el: Element) => {
            const cs = win.getComputedStyle(el);
            const s = (el as HTMLElement).style;
            for (let i = 0; i < cs.length; i++) {
                const p = cs[i];
                s.setProperty(p, cs.getPropertyValue(p));
            }
            for (let c = 0; c < el.children.length; c++) inlineAll(el.children[c]);
        };
        inlineAll(element);
        clonedDoc.querySelectorAll('style, link[rel="stylesheet"]').forEach(s => s.remove());
    };

    const generatePacket = async () => {
        setIsGenerating(true);
        try {
            const pdf: any = new jsPDF('p', 'mm', 'a4'); // A4 size

            // 1. Generate Flyer
            if (flyerRef.current) {
                const canvas = await html2canvas(flyerRef.current, { scale: 2, useCORS: true, onclone: sanitizeCloneForCapture } as any);
                const imgData = canvas.toDataURL('image/png');
                const imgProps = pdf.getImageProperties(imgData);
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

                pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
            }



            pdf.save(`${(campaign.name || 'Campaign').replace(/\s+/g, '_')}_Coordinator_Packet.pdf`);
        } catch (error) {
            console.error("Error generating packet:", error);
        } finally {
            setIsGenerating(false);
        }
    };

    const downloadSocialImage = async (type: 'square' | 'story') => {
        setIsGenerating(true);
        try {
            const ref = type === 'square' ? socialSquareRef : socialStoryRef;
            if (ref.current) {
                const canvas = await html2canvas(ref.current, { scale: 2, useCORS: true, onclone: sanitizeCloneForCapture } as any);
                const link = document.createElement('a');
                link.download = `${(campaign.name || 'Campaign').replace(/\s+/g, '_')}_Social_${type}.png`;
                link.href = canvas.toDataURL('image/png');
                link.click();
            }
        } catch (error) {
            console.error("Error generating image:", error);
        } finally {
            setIsGenerating(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
                <button
                    onClick={generatePacket}
                    disabled={isGenerating}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 rounded-2xl font-black transition-all active:scale-95 disabled:opacity-50 shadow-lg shadow-indigo-500/20"
                >
                    {isGenerating ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
                    Download Coordinator Packet (PDF)
                </button>

                <button
                    onClick={() => downloadSocialImage('square')}
                    disabled={isGenerating}
                    className="flex items-center gap-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 px-4 py-3 rounded-2xl font-bold transition-all active:scale-95 disabled:opacity-50 shadow-sm"
                >
                    <Instagram className="w-5 h-5 text-pink-600" />
                    Social Square
                </button>

                <button
                    onClick={() => downloadSocialImage('story')}
                    disabled={isGenerating}
                    className="flex items-center gap-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 px-4 py-3 rounded-2xl font-bold transition-all active:scale-95 disabled:opacity-50 shadow-sm"
                >
                    <Share2 className="w-5 h-5 text-purple-600" />
                    Social Story
                </button>
            </div>

            {/* Hidden render area for capturing — uses ONLY inline hex/rgb/rgba
                colors so html2canvas never encounters oklch()/lab() functions. */}
            <div className="fixed left-[-9999px] top-0 pointer-events-none">

                {/* 1. FLYER (A4 Ratio approx) */}
                <div ref={flyerRef} className="w-[794px] h-[1123px] p-12 flex flex-col items-center text-center relative" style={{ fontFamily: 'Inter, sans-serif', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', color: '#0f172a' }}>

                    {/* Header Strip */}
                    <div className="absolute top-0 left-0 w-full h-4" style={{ background: 'linear-gradient(to right, #6366f1, #a855f7, #ec4899)' }}></div>

                    <div className="mt-8 mb-4">
                        <h2 className="text-xl uppercase tracking-widest font-semibold mb-2" style={{ color: '#64748b' }}>Fundraiser For</h2>
                        <h1 className="text-5xl font-black leading-tight" style={{ color: '#0f172a' }}>{organizationName}</h1>
                    </div>

                    <div className="w-full h-px my-8" style={{ backgroundColor: '#e2e8f0' }}></div>

                    <div className="flex-1 flex flex-col justify-center items-center w-full space-y-8">
                        <div className="p-8 rounded-3xl w-full max-w-2xl" style={{ backgroundColor: '#eef2ff', border: '2px solid #e0e7ff' }}>
                            <h3 className="text-3xl font-bold mb-2" style={{ color: '#312e81' }}>{campaign.name}</h3>
                            {Number(campaign.goal_amount) > 0 && (
                                <p className="text-xl font-medium" style={{ color: '#4f46e5' }}>Help us reach our goal of ${Number(campaign.goal_amount).toLocaleString()}!</p>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-8 w-full max-w-2xl text-left">
                            <div className="p-6 rounded-2xl" style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0' }}>
                                <p className="text-sm font-bold uppercase mb-1" style={{ color: '#94a3b8' }}>Orders Due By</p>
                                <p className="text-2xl font-bold" style={{ color: '#1e293b' }}>
                                    {campaign.end_date ? format(new Date(campaign.end_date), 'MMMM do') : 'TBD'}
                                </p>
                            </div>
                            <div className="p-6 rounded-2xl" style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0' }}>
                                <p className="text-sm font-bold uppercase mb-1" style={{ color: '#94a3b8' }}>Pick Up Date</p>
                                <p className="text-2xl font-bold" style={{ color: '#1e293b' }}>
                                    {campaign.delivery_date ? format(new Date(campaign.delivery_date), 'MMMM do') : 'TBD'}
                                </p>
                            </div>
                        </div>

                        <div className="py-8">
                            <div className="p-4 rounded-3xl inline-block" style={{ backgroundColor: '#ffffff', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)', border: '4px solid #0f172a' }}>
                                <QRCodeSVG value={publicLink} size={250} level={"H"} includeMargin={true} />
                            </div>
                            <p className="mt-6 text-2xl font-bold" style={{ color: '#0f172a' }}>Scan to Order & Support</p>
                            <p className="mt-2 text-lg" style={{ color: '#64748b' }}>or visit {publicLink.replace('https://', '')}</p>
                        </div>
                    </div>

                    <div className="mt-auto w-full pt-8" style={{ borderTop: '1px solid #f1f5f9' }}>
                        <div className="flex items-center justify-center gap-2 font-medium" style={{ color: '#94a3b8' }}>
                            <span>Powered by</span>
                            <span className="font-bold" style={{ color: '#4f46e5' }}>FreezerIQ</span>
                        </div>
                    </div>
                </div>



                {/* 3. SOCIAL SQUARE (1080x1080) */}
                <div ref={socialSquareRef} className="w-[1080px] h-[1080px] p-16 flex flex-col justify-between relative" style={{ fontFamily: 'Inter, sans-serif', background: 'linear-gradient(to bottom right, #312e81, #581c87, #0f172a)', color: '#ffffff' }}>
                    {/* Background decorations */}
                    <div className="absolute top-0 right-0 w-[600px] h-[600px] rounded-full blur-[150px] opacity-20" style={{ backgroundColor: '#6366f1' }}></div>
                    <div className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full blur-[120px] opacity-20" style={{ backgroundColor: '#ec4899' }}></div>

                    <div className="relative z-10">
                        <h2 className="text-3xl font-bold uppercase tracking-widest mb-4" style={{ color: '#a5b4fc' }}>Support Our Fundraiser</h2>
                        <h1 className="text-7xl font-black leading-tight mb-8">{organizationName}</h1>
                        <div className="inline-block px-8 py-4 rounded-2xl" style={{ backgroundColor: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
                            <p className="text-2xl font-medium">Goal: <span className="font-bold" style={{ color: '#ffffff' }}>${Number(campaign.goal_amount).toLocaleString()}</span></p>
                        </div>
                    </div>

                    <div className="relative z-10 flex items-end justify-between">
                        <div>
                            <p className="text-3xl font-light mb-2" style={{ color: '#cbd5e1' }}>Order by {campaign.end_date ? format(new Date(campaign.end_date), 'MMM do') : 'Soon'}</p>
                            <p className="text-5xl font-bold" style={{ color: '#ffffff' }}>Delicious Meals<br />Ready for Your Freezer.</p>
                        </div>
                        <div className="p-6 rounded-3xl" style={{ backgroundColor: '#ffffff', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)' }}>
                            <QRCodeSVG value={publicLink} size={280} level={"H"} />
                        </div>
                    </div>
                </div>

                {/* 4. SOCIAL STORY (1080x1920) */}
                <div ref={socialStoryRef} className="w-[1080px] h-[1920px] p-16 flex flex-col items-center justify-center relative" style={{ fontFamily: 'Inter, sans-serif', backgroundColor: '#f8fafc', color: '#0f172a' }}>
                    <div className="absolute top-0 left-0 w-full h-[800px] rounded-b-[100px]" style={{ backgroundColor: '#4f46e5' }}></div>

                    <div className="relative z-10 p-12 rounded-[60px] w-full text-center flex flex-col items-center gap-8" style={{ backgroundColor: '#ffffff', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', border: '6px solid #e0e7ff' }}>
                        <div className="w-32 h-2 rounded-full" style={{ backgroundColor: '#e2e8f0' }}></div>

                        <div>
                            <h2 className="text-3xl uppercase font-bold mb-2" style={{ color: '#4f46e5' }}>Fundraiser Alert</h2>
                            <h1 className="text-6xl font-black" style={{ color: '#0f172a' }}>{organizationName}</h1>
                        </div>

                        <div className="w-full h-px" style={{ backgroundColor: '#f1f5f9' }}></div>

                        <div className="space-y-4">
                            <p className="text-2xl" style={{ color: '#64748b' }}>We are raising money for</p>
                            <h3 className="text-4xl font-bold" style={{ color: '#0f172a' }}>{campaign.name}</h3>
                        </div>

                        <div className="p-10 rounded-[40px] w-full" style={{ backgroundColor: '#eef2ff' }}>
                            <QRCodeSVG value={publicLink} size={400} className="mx-auto" />
                            <p className="text-3xl font-bold mt-8" style={{ color: '#312e81' }}>SCAN TO ORDER</p>
                        </div>

                        <div className="text-xl font-medium" style={{ color: '#94a3b8' }}>
                            Ends {campaign.end_date ? format(new Date(campaign.end_date), 'MMMM do') : 'Soon'}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
