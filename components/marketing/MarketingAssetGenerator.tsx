'use client';

import React, { useRef, useState } from 'react';
import html2canvas from 'html2canvas-pro';
import jsPDF from 'jspdf';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2, Share2, FileText, Instagram, Copy, CheckCircle2 } from 'lucide-react';
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
    const [copiedStates, setCopiedStates] = useState<Record<string, boolean>>({});

    const flyerRef = useRef<HTMLDivElement>(null);
    const coordinatorCardRef = useRef<HTMLDivElement>(null);
    const socialSquareRef = useRef<HTMLDivElement>(null);
    const socialStoryRef = useRef<HTMLDivElement>(null);

    const publicLink = `${baseUrl}/fundraiser/${campaign.public_token}`;
    const portalLink = `${baseUrl}/coordinator/${campaign.portal_token}`;

    const generatePacket = async () => {
        setIsGenerating(true);
        try {
            const pdf: any = new jsPDF('p', 'mm', 'a4'); // A4 size

            // 1. Generate Flyer
            if (flyerRef.current) {
                const canvas = await html2canvas(flyerRef.current, { scale: 2, useCORS: true } as any);
                const imgData = canvas.toDataURL('image/png');
                const imgProps = pdf.getImageProperties(imgData);
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

                pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
            }

            // 2. Generate Coordinator Card (New Page)
            if (coordinatorCardRef.current) {
                pdf.addPage();
                const canvas = await html2canvas(coordinatorCardRef.current, { scale: 2, useCORS: true } as any);
                const imgData = canvas.toDataURL('image/png');
                const imgProps = pdf.getImageProperties(imgData);
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

                pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
            }

            pdf.save(`${campaign.name.replace(/\s+/g, '_')}_Coordinator_Packet.pdf`);
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
                const canvas = await html2canvas(ref.current, { scale: 2, useCORS: true } as any);
                const link = document.createElement('a');
                link.download = `${campaign.name.replace(/\s+/g, '_')}_Social_${type}.png`;
                link.href = canvas.toDataURL('image/png');
                link.click();
            }
        } catch (error) {
            console.error("Error generating image:", error);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleCopy = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedStates({ ...copiedStates, [id]: true });
        setTimeout(() => {
            setCopiedStates({ ...copiedStates, [id]: false });
        }, 2000);
    };

    const endDateFormatted = campaign.end_date ? format(new Date(campaign.end_date), 'MMMM do') : 'soon';

    const marketingCopy = {
        sms: `Hi! 👋 I'm raising money for ${organizationName}! We're selling delicious frozen meals. Order here to help us reach our goal: ${publicLink}`,
        email: `Subject: Support ${organizationName}'s Fundraiser!\n\nHi everyone,\n\nWe are currently raising funds for ${organizationName}, and we need your help to reach our goal of $${Number(campaign.goal_amount || 0).toLocaleString()}!\n\nWe are selling delicious, high-quality frozen meals that are perfect for busy nights. Every order directly supports our mission.\n\nPlease place your orders by ${endDateFormatted} using our official storefront link below:\n\n👉 ${publicLink}\n\nThank you so much for your support!`,
        social: `🚨 ${organizationName} Fundraiser! 🚨\n\nWe need your help to reach our goal! We're selling amazing frozen meals to raise money for ${campaign.name}.\n\n✅ Easy, delicious dinners\n✅ Directly supports our team\n✅ Order by ${endDateFormatted}\n\nTap the link below to browse the menu and place your order today! 👇\n\n🔗 ${publicLink}\n\n#Fundraiser #SupportLocal #${organizationName.replace(/\s+/g, '')}`
    };

    return (
        <div className="space-y-8">
            {/* Download Buttons Section */}
            <div className="space-y-3">
                <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest ml-1">Print & Images</h3>
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
            </div>

            {/* Copy & Paste Text Section */}
            <div className="space-y-4 pt-4 border-t border-slate-100">
                <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest ml-1">Copy & Paste Messages</h3>

                {/* SMS Snippet */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-slate-500 uppercase">Text Message / SMS</span>
                        <button onClick={() => handleCopy(marketingCopy.sms, 'sms')} className="text-indigo-600 hover:text-indigo-800 flex items-center gap-1 text-xs font-bold">
                            {copiedStates['sms'] ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                            {copiedStates['sms'] ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{marketingCopy.sms}</p>
                </div>

                {/* Social Media Snippet */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-slate-500 uppercase">Facebook / Social Post</span>
                        <button onClick={() => handleCopy(marketingCopy.social, 'social')} className="text-indigo-600 hover:text-indigo-800 flex items-center gap-1 text-xs font-bold">
                            {copiedStates['social'] ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                            {copiedStates['social'] ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{marketingCopy.social}</p>
                </div>

                {/* Email Snippet */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-slate-500 uppercase">Email Draft</span>
                        <button onClick={() => handleCopy(marketingCopy.email, 'email')} className="text-indigo-600 hover:text-indigo-800 flex items-center gap-1 text-xs font-bold">
                            {copiedStates['email'] ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                            {copiedStates['email'] ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{marketingCopy.email}</p>
                </div>
            </div>

            {/* Hidden render area for capturing */}
            <div className="fixed left-[-9999px] top-0 pointer-events-none">

                {/* 1. FLYER (A4 Ratio approx) */}
                <div ref={flyerRef} className="w-[794px] h-[1123px] bg-white p-12 flex flex-col items-center text-center border relative" style={{ fontFamily: 'Inter, sans-serif' }}>

                    {/* Header Strip */}
                    <div className="absolute top-0 left-0 w-full h-4 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>

                    <div className="mt-8 mb-4">
                        <h2 className="text-xl uppercase tracking-widest text-slate-500 font-semibold mb-2">Fundraiser For</h2>
                        <h1 className="text-5xl font-black text-slate-900 leading-tight">{organizationName}</h1>
                    </div>

                    <div className="w-full h-px bg-slate-200 my-8"></div>

                    <div className="flex-1 flex flex-col justify-center items-center w-full space-y-8">
                        <div className="bg-indigo-50 p-8 rounded-3xl w-full max-w-2xl border-2 border-indigo-100">
                            <h3 className="text-3xl font-bold text-indigo-900 mb-2">{campaign.name}</h3>
                            {Number(campaign.goal_amount) > 0 && (
                                <p className="text-xl text-indigo-600 font-medium">Help us reach our goal of ${Number(campaign.goal_amount).toLocaleString()}!</p>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-8 w-full max-w-2xl text-left">
                            <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200">
                                <p className="text-sm font-bold text-slate-400 uppercase mb-1">Orders Due By</p>
                                <p className="text-2xl font-bold text-slate-800">
                                    {campaign.end_date ? format(new Date(campaign.end_date), 'MMMM do') : 'TBD'}
                                </p>
                            </div>
                            <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200">
                                <p className="text-sm font-bold text-slate-400 uppercase mb-1">Pick Up Date</p>
                                <p className="text-2xl font-bold text-slate-800">
                                    {campaign.delivery_date ? format(new Date(campaign.delivery_date), 'MMMM do') : 'TBD'}
                                </p>
                            </div>
                        </div>

                        <div className="py-8">
                            <div className="bg-white p-4 rounded-3xl shadow-xl border-4 border-slate-900 inline-block">
                                <QRCodeSVG value={publicLink} size={250} level={"H"} includeMargin={true} />
                            </div>
                            <p className="mt-6 text-2xl font-bold text-slate-900">Scan to Order & Support</p>
                            <p className="text-slate-500 mt-2 text-lg">or visit {publicLink.replace('https://', '')}</p>
                        </div>
                    </div>

                    <div className="mt-auto w-full pt-8 border-t border-slate-100">
                        <div className="flex items-center justify-center gap-2 text-slate-400 font-medium">
                            <span>Powered by</span>
                            <span className="font-bold text-indigo-600">FreezerIQ</span>
                        </div>
                    </div>
                </div>

                {/* 2. COORDINATOR CARD */}
                <div ref={coordinatorCardRef} className="w-[794px] h-[1123px] bg-slate-900 p-12 flex flex-col items-center text-center relative text-white" style={{ fontFamily: 'Inter, sans-serif' }}>
                    <div className="absolute top-0 left-0 w-full h-4 bg-gradient-to-r from-emerald-400 to-cyan-400"></div>

                    <div className="mt-12 mb-8">
                        <span className="bg-emerald-500/10 text-emerald-400 px-4 py-2 rounded-full text-sm font-bold tracking-wide uppercase border border-emerald-500/20">
                            Private Coordinator Access
                        </span>
                        <h1 className="text-4xl font-bold mt-6">Keep This Page Safe!</h1>
                        <p className="text-slate-400 mt-4 text-lg max-w-xl mx-auto">
                            This sheet contains your secret access link. Do not share this with the public.
                        </p>
                    </div>

                    <div className="flex-1 flex flex-col justify-center items-center w-full">
                        <div className="bg-slate-800 p-10 rounded-3xl border border-slate-700 shadow-2xl max-w-lg w-full">
                            <div className="bg-white p-4 rounded-xl inline-block mb-6">
                                <QRCodeSVG value={portalLink} size={200} />
                            </div>
                            <h3 className="text-2xl font-bold text-white mb-2">Coordinator Portal</h3>
                            <p className="text-slate-400 mb-6">Scan to manage orders & view sales</p>

                            <div className="bg-slate-900 p-4 rounded-lg text-center break-all font-mono text-sm text-emerald-400 border border-emerald-500/30">
                                {portalLink}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-6 mt-12 w-full max-w-2xl">
                            <div className="flex items-start gap-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700">
                                <div className="bg-indigo-500/20 p-2 rounded-lg text-indigo-400 font-bold">1</div>
                                <div className="text-left">
                                    <h4 className="font-bold mb-1">Distribute Flyers</h4>
                                    <p className="text-sm text-slate-400">Print the flyer on the previous page and hand it out to your team.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700">
                                <div className="bg-purple-500/20 p-2 rounded-lg text-purple-400 font-bold">2</div>
                                <div className="text-left">
                                    <h4 className="font-bold mb-1">Track Progress</h4>
                                    <p className="text-sm text-slate-400">Use your portal to see live sales data and the public scoreboard.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700">
                                <div className="bg-pink-500/20 p-2 rounded-lg text-pink-400 font-bold">3</div>
                                <div className="text-left">
                                    <h4 className="font-bold mb-1">Social Sharing</h4>
                                    <p className="text-sm text-slate-400">Download social media graphics from the portal to share online.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 3. SOCIAL SQUARE (1080x1080) */}
                <div ref={socialSquareRef} className="w-[1080px] h-[1080px] bg-gradient-to-br from-indigo-900 via-purple-900 to-slate-900 p-16 flex flex-col justify-between relative text-white" style={{ fontFamily: 'Inter, sans-serif' }}>
                    {/* Background decorations */}
                    <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-indigo-500 rounded-full blur-[150px] opacity-20"></div>
                    <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-pink-500 rounded-full blur-[120px] opacity-20"></div>

                    <div className="relative z-10">
                        <h2 className="text-3xl font-bold text-indigo-300 uppercase tracking-widest mb-4">Support Our Fundraiser</h2>
                        <h1 className="text-7xl font-black leading-tight mb-8">{organizationName}</h1>
                        <div className="inline-block bg-white/10 backdrop-blur-md px-8 py-4 rounded-2xl border border-white/20">
                            <p className="text-2xl font-medium">Goal: <span className="font-bold text-white">${Number(campaign.goal_amount).toLocaleString()}</span></p>
                        </div>
                    </div>

                    <div className="relative z-10 flex items-end justify-between">
                        <div>
                            <p className="text-3xl font-light text-slate-300 mb-2">Order by {campaign.end_date ? format(new Date(campaign.end_date), 'MMM do') : 'Soon'}</p>
                            <p className="text-5xl font-bold bg-gradient-to-r from-white to-slate-300 text-transparent bg-clip-text">Delicious Meals<br />Ready for Your Freezer.</p>
                        </div>
                        <div className="bg-white p-6 rounded-3xl shadow-2xl">
                            <QRCodeSVG value={publicLink} size={280} level={"H"} />
                        </div>
                    </div>
                </div>

                {/* 4. SOCIAL STORY (1080x1920) */}
                <div ref={socialStoryRef} className="w-[1080px] h-[1920px] bg-slate-50 p-16 flex flex-col items-center justify-center relative text-slate-900" style={{ fontFamily: 'Inter, sans-serif' }}>
                    <div className="absolute top-0 left-0 w-full h-[800px] bg-indigo-600 rounded-b-[100px]"></div>

                    <div className="relative z-10 bg-white p-12 rounded-[60px] shadow-2xl w-full text-center flex flex-col items-center gap-8 border-[6px] border-indigo-100">
                        <div className="w-32 h-2 bg-slate-200 rounded-full"></div>

                        <div>
                            <h2 className="text-3xl uppercase font-bold text-indigo-600 mb-2">Fundraiser Alert</h2>
                            <h1 className="text-6xl font-black">{organizationName}</h1>
                        </div>

                        <div className="w-full h-px bg-slate-100"></div>

                        <div className="space-y-4">
                            <p className="text-2xl text-slate-500">We are raising money for</p>
                            <h3 className="text-4xl font-bold text-slate-900">{campaign.name}</h3>
                        </div>

                        <div className="bg-indigo-50 p-10 rounded-[40px] w-full">
                            <QRCodeSVG value={publicLink} size={400} className="mx-auto" />
                            <p className="text-3xl font-bold text-indigo-900 mt-8">SCAN TO ORDER</p>
                        </div>

                        <div className="text-xl font-medium text-slate-400">
                            Ends {campaign.end_date ? format(new Date(campaign.end_date), 'MMMM do') : 'Soon'}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
