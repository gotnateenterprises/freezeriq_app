"use client";

import { useState, useEffect } from 'react';
import {
    Database,
    Upload,
    Trash2,
    Save,
    Plus,
    QrCode,
    ExternalLink
} from 'lucide-react';
import QRCodeManager from './QRCodeManager';

interface BrandingSettingsProps {
    isSuperAdmin?: boolean;
}

export default function BrandingSettings({ isSuperAdmin }: BrandingSettingsProps) {
    const [logo, setLogo] = useState<string | null>(null);
    const [logoFile, setLogoFile] = useState<File | null>(null);
    const [appName, setAppName] = useState("FreezerIQ");
    const [tagline, setTagline] = useState('Deliciously Easy, home-cooked meals prepared fresh and frozen for your convenience.');
    const [thankYouNote, setThankYouNote] = useState('');
    const [reviewPrompt, setReviewPrompt] = useState('');
    const [signOff, setSignOff] = useState('');
    const [showLogoInHeader, setShowLogoInHeader] = useState(false);
    const [primaryColor, setPrimaryColor] = useState('#10b981');
    const [secondaryColor, setSecondaryColor] = useState('#6366f1');
    const [accentColor, setAccentColor] = useState('#f59e0b');
    const [businessSlug, setBusinessSlug] = useState<string | null>(null);
    const [packingSlipQrId, setPackingSlipQrId] = useState<string | null>(null);

    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        // Fetch branding from API
        const fetchBranding = async () => {
            try {
                const res = await fetch('/api/tenant/branding');
                if (res.ok) {
                    const data = await res.json();
                    if (data.business_name) setAppName(data.business_name);
                    if (data.tagline) setTagline(data.tagline);
                    if (data.thank_you_note) setThankYouNote(data.thank_you_note);
                    if (data.review_prompt) setReviewPrompt(data.review_prompt);
                    if (data.sign_off) setSignOff(data.sign_off);
                    if (data.logo_url) setLogo(data.logo_url);
                    if (data.primary_color) setPrimaryColor(data.primary_color);
                    if (data.secondary_color) setSecondaryColor(data.secondary_color);
                    if (data.accent_color) setAccentColor(data.accent_color);
                    if (data.business_slug) setBusinessSlug(data.business_slug);
                    if (data.packing_slip_qr_id) setPackingSlipQrId(data.packing_slip_qr_id);
                }
            } catch (e) {
                console.error("Failed to fetch branding", e);
            }
        };

        fetchBranding();

        fetchBranding();

        const savedHeaderSetting = localStorage.getItem('showLogoInHeader');
        if (savedHeaderSetting) setShowLogoInHeader(JSON.parse(savedHeaderSetting));
    }, []);

    const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                setLogo(reader.result as string);
                setLogoFile(file);
            };
            reader.readAsDataURL(file);
        }
    };

    const clearLogo = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setLogo(null);
        setLogoFile(null);
    };

    const handleBrandingSave = async () => {
        setIsSaving(true);
        try {
            const formData = new FormData();
            formData.append('business_name', appName);
            formData.append('tagline', tagline);
            formData.append('thank_you_note', thankYouNote);
            formData.append('review_prompt', reviewPrompt);
            formData.append('sign_off', signOff);
            formData.append('primary_color', primaryColor);
            formData.append('secondary_color', secondaryColor);
            formData.append('accent_color', accentColor);

            if (logoFile) {
                formData.append('logo', logoFile);
            } else if (!logo) {
                // If logo was cleared, we might need a way to tell the server.
                // For now, the API upserts logoUrl ONLY if provided.
                // We should probably add a way to clear it on the server too if needed.
            }

            // Add packing_slip_qr_id selection
            if (packingSlipQrId) {
                formData.append('packing_slip_qr_id', packingSlipQrId);
            }

            const res = await fetch('/api/tenant/branding', {
                method: 'POST',
                body: formData
            });

            if (res.ok) {
                localStorage.setItem('appName', appName);
                localStorage.setItem('showLogoInHeader', JSON.stringify(showLogoInHeader));
                alert("Branding Settings Saved!");
                setLogoFile(null);
            } else {
                alert("Failed to save branding.");
            }
        } catch (e) {
            console.error(e);
            alert("Error saving branding.");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 space-y-8">
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <Database size={20} className="text-indigo-600 dark:text-indigo-400" />
                    Branding & Identity
                </h3>
                {businessSlug && (
                    <a
                        href={`/shop/${businessSlug}`}
                        target="_blank"
                        className="flex items-center gap-2 text-xs font-bold text-indigo-600 hover:text-indigo-700 transition-colors"
                    >
                        View Public Storefront
                        <ExternalLink size={14} />
                    </a>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Left Side: Name and Logo */}
                <div className="space-y-6">
                    <div>
                        <div className="flex justify-between items-end mb-2">
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">Application Name</label>
                            <button
                                onClick={() => setAppName("FreezerIQ")}
                                className="text-[10px] font-black uppercase text-indigo-600 hover:underline"
                            >
                                Reset
                            </button>
                        </div>
                        <input
                            type="text"
                            value={appName}
                            onChange={(e) => setAppName(e.target.value)}
                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-500"
                            placeholder="e.g. FreezerIQ"
                        />
                    </div>

                    <div className="flex gap-8">
                        <div className="space-y-2">
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">Brand Logo</label>
                            <div className="w-32 h-32 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-center overflow-hidden group relative shadow-sm">
                                {logo ? (
                                    <>
                                        <img src={logo} alt="Logo" className="w-full h-full object-contain p-2" />
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 z-10">
                                            <button
                                                onClick={clearLogo}
                                                className="p-2 bg-rose-600 text-white rounded-full hover:bg-rose-700 shadow-xl"
                                                title="Delete Logo"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <div className="flex flex-col items-center gap-1 text-slate-400">
                                        <Upload size={24} />
                                        <span className="text-[10px] font-bold uppercase">Upload</span>
                                    </div>
                                )}
                                {/* IMPORTANT: The file input is only the clickable area if NO logo exists OR if we're not hovering the delete button */}
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={handleLogoUpload}
                                    className={`absolute inset-0 opacity-0 cursor-pointer ${logo ? 'z-0' : 'z-20'}`}
                                />
                            </div>
                        </div>

                        <div className="space-y-4 flex-1">
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">Theme Colors</label>
                            <div className="flex flex-wrap gap-4">
                                <div className="space-y-1">
                                    <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="w-10 h-10 rounded-lg cursor-pointer border-none p-0 overflow-hidden" title="Primary" />
                                    <p className="text-[8px] font-black text-center text-slate-500 uppercase tracking-wider">Primary</p>
                                </div>
                                <div className="space-y-1">
                                    <input type="color" value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="w-10 h-10 rounded-lg cursor-pointer border-none p-0 overflow-hidden" title="Secondary" />
                                    <p className="text-[8px] font-black text-center text-slate-500 uppercase tracking-wider">Accent</p>
                                </div>
                                <div className="space-y-1">
                                    <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="w-10 h-10 rounded-lg cursor-pointer border-none p-0 overflow-hidden" title="Highlight" />
                                    <p className="text-[8px] font-black text-center text-slate-500 uppercase tracking-wider">Highlight</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 pt-2">
                                <input type="checkbox" id="headerLogo" checked={showLogoInHeader} onChange={(e) => setShowLogoInHeader(e.target.checked)} className="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500" />
                                <label htmlFor="headerLogo" className="text-xs font-bold text-slate-500 uppercase tracking-wide cursor-pointer">Show in Sidebar</label>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Side: Messaging */}
                <div className="space-y-6">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Tagline</label>
                        <input
                            type="text"
                            value={tagline}
                            onChange={(e) => setTagline(e.target.value)}
                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                            placeholder="Tagline..."
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Packing Slip Note</label>
                        <textarea
                            value={thankYouNote}
                            onChange={(e) => setThankYouNote(e.target.value)}
                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm min-h-[80px] outline-none focus:ring-2 focus:ring-indigo-500 leading-relaxed"
                            placeholder="Thank you note appearing on printed slips..."
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-2">QR Sign-off</label>
                        <input
                            type="text"
                            value={signOff}
                            onChange={(e) => setSignOff(e.target.value)}
                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                            placeholder="e.g. The Freezer Chef Team"
                        />
                    </div>
                </div>
            </div>

            {/* QR Section */}
            <div className="pt-8 border-t border-slate-100 dark:border-slate-700">
                <div className="flex items-center justify-between mb-4">
                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">Custom QR Codes</label>
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Document Overlays</span>
                </div>

                <QRCodeManager
                    assignedPackingSlipQrId={packingSlipQrId}
                    onAssignPackingSlipQr={setPackingSlipQrId}
                />
            </div>

            <div className="pt-8 border-t border-slate-100 dark:border-slate-700 flex justify-end gap-3">
                {businessSlug && (
                    <a
                        href={`/shop/${businessSlug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-8 py-3 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl text-sm font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-50 transition-all shadow-sm active:scale-95"
                    >
                        <ExternalLink size={18} />
                        View Webpage
                    </a>
                )}
                <button
                    onClick={handleBrandingSave}
                    disabled={isSaving}
                    className="flex items-center gap-2 px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-indigo-200 dark:shadow-none active:scale-95 disabled:opacity-50"
                >
                    <Save size={18} />
                    {isSaving ? 'Saving...' : 'Save Branding Changes'}
                </button>
            </div>
        </div>
    );
}
