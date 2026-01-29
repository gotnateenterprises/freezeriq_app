"use client";

import { useState, useEffect } from 'react';
import { Save, RefreshCw, Trash2, CheckCircle, Database, QrCode, Upload } from 'lucide-react';

export default function SettingsPage() {
    const [logo, setLogo] = useState<string | null>(null);

    // App Branding State
    const [appName, setAppName] = useState("FreezerIQ");
    const [showLogoInHeader, setShowLogoInHeader] = useState(false);

    // Text Logo Generator State
    const [logoText, setLogoText] = useState("CK");
    const [logoBg, setLogoBg] = useState("#4f46e5"); // Indigo-600
    const [logoTextColor, setLogoTextColor] = useState("#ffffff");

    // QR Code State
    const [qrCodes, setQrCodes] = useState<{ id: string, name: string, data: string }[]>([]);
    const [qrInput, setQrInput] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);

    // Load QRs
    useEffect(() => {
        const savedQrs = localStorage.getItem('qrCodes');
        if (savedQrs) {
            try {
                setQrCodes(JSON.parse(savedQrs));
            } catch (e) {
                console.error("Failed to parse saved QRs");
            }
        }
    }, []);

    // Save QRs
    useEffect(() => {
        // Only save if we have loaded or added something to avoid overwriting with empty if not loaded yet
        // Actually useEffect [] runs first, so it's fine. 
        // We might want to use a loaded flag if this was more complex, but for localstorage sync it's usually ok.
        // To be safe against the initial render overwriting:
        if (qrCodes.length > 0) {
            localStorage.setItem('qrCodes', JSON.stringify(qrCodes));
        } else {
            // If length is 0, we only remove if we know we loaded. 
            // Simpler: Just rely on persistence. 
            // For this MVP, let's just save.
            localStorage.setItem('qrCodes', JSON.stringify(qrCodes));
        }
    }, [qrCodes]);

    const handleQrUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            Array.from(e.target.files).forEach(file => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    setQrCodes(prev => [...prev, {
                        id: Date.now().toString() + Math.random().toString().slice(2),
                        name: file.name,
                        data: reader.result as string
                    }]);
                };
                reader.readAsDataURL(file);
            });
        }
    };

    const generateQrCode = async () => {
        if (!qrInput) return;
        setIsGenerating(true);
        try {
            const url = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrInput)}`;
            const res = await fetch(url);
            const blob = await res.blob();
            const reader = new FileReader();
            reader.onloadend = () => {
                setQrCodes(prev => [...prev, {
                    id: Date.now().toString() + Math.random().toString().slice(2),
                    name: qrInput.length > 20 ? qrInput.substring(0, 20) + '...' : qrInput,
                    data: reader.result as string
                }]);
                setQrInput("");
            };
            reader.readAsDataURL(blob);
        } catch (e) {
            alert("Failed to generate QR Code. Please check your internet connection.");
        } finally {
            setIsGenerating(false);
        }
    };

    const deleteQr = (id: string) => {
        setQrCodes(prev => prev.filter(q => q.id !== id));
    };

    useEffect(() => {
        const savedLogo = localStorage.getItem('kitchenLogo');
        if (savedLogo) setLogo(savedLogo);

        const savedAppName = localStorage.getItem('appName');
        if (savedAppName) setAppName(savedAppName);

        const savedHeaderSetting = localStorage.getItem('showLogoInHeader');
        if (savedHeaderSetting) setShowLogoInHeader(JSON.parse(savedHeaderSetting));

        const savedGfsPortal = localStorage.getItem('gfsPortalType');
        if (savedGfsPortal) setGfsPortalType(savedGfsPortal);

        const savedCustomGfs = localStorage.getItem('customGfsUrl');
        if (savedCustomGfs) setCustomGfsUrl(savedCustomGfs);
    }, []);

    // GFS State
    const [gfsPortalType, setGfsPortalType] = useState('gfs_store'); // 'gfs_store' | 'gordon_ordering' | 'custom'
    const [customGfsUrl, setCustomGfsUrl] = useState('');

    // Integration Status
    const [integrationStatus, setIntegrationStatus] = useState({ square: false, qbo: false, meta: false });

    useEffect(() => {
        fetch('/api/integrations/status')
            .then(res => res.json())
            .then(data => setIntegrationStatus(data))
            .catch(console.error);
    }, []);

    // Check URL params for immediate feedback after redirect
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const params = new URLSearchParams(window.location.search);
            if (params.get('square_connected') === 'true') {
                setIntegrationStatus(prev => ({ ...prev, square: true }));
                // Clean URL
                window.history.replaceState({}, '', '/settings');
            }
            if (params.get('meta_connected') === 'true') {
                setIntegrationStatus(prev => ({ ...prev, meta: true }));
                // Clean URL
                window.history.replaceState({}, '', '/settings');
            }
        }
    }, []);

    const handleGfsSave = () => {
        localStorage.setItem('gfsPortalType', gfsPortalType);
        localStorage.setItem('customGfsUrl', customGfsUrl);
        alert("GFS Settings Saved!");
    };

    const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result as string;
                localStorage.setItem('kitchenLogo', base64);
                setLogo(base64);
            };
            reader.readAsDataURL(file);
        }
    };

    const generateTextLogo = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Background
        ctx.fillStyle = logoBg;
        ctx.fillRect(0, 0, 200, 200);

        // Text
        ctx.fillStyle = logoTextColor;
        ctx.font = 'bold 100px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(logoText.substring(0, 2).toUpperCase(), 100, 100);

        const base64 = canvas.toDataURL('image/png');
        localStorage.setItem('kitchenLogo', base64);
        setLogo(base64);
    };

    const handleBrandingSave = () => {
        localStorage.setItem('appName', appName);
        localStorage.setItem('showLogoInHeader', JSON.stringify(showLogoInHeader));
        alert("Branding Settings Saved!");
    };

    const clearLogo = () => {
        localStorage.removeItem('kitchenLogo');
        setLogo(null);
    };

    const disconnectIntegration = async (provider: 'square' | 'qbo' | 'meta') => {
        if (!confirm(`Are you sure you want to delete the ${provider === 'square' ? 'Square' : provider === 'qbo' ? 'QuickBooks' : 'Facebook'} connection?`)) return;

        try {
            const res = await fetch('/api/integrations/disconnect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider })
            });

            if (res.ok) {
                setIntegrationStatus(prev => ({ ...prev, [provider]: false }));
                alert(`${provider === 'square' ? 'Square' : 'QuickBooks'} disconnected successfully.`);
            } else {
                alert("Failed to disconnect.");
            }
        } catch (e) {
            console.error(e);
            alert("Error disconnecting integration.");
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 pb-32">
            <div>
                <h2 className="text-3xl font-bold text-slate-900 dark:text-white text-adaptive">Settings</h2>
                <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-1">Manage system configurations and integrations.</p>
            </div>

            {/* ... Profile & Branding Sections ... */}

            {/* Integrations Section */}
            <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive mb-6 flex items-center gap-2">
                    <RefreshCw size={20} className="text-indigo-600 dark:text-indigo-400" />
                    Integrations Status
                </h3>
                <div className="space-y-4">
                    {/* Square */}
                    <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-100 dark:border-slate-700">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-600 flex items-center justify-center p-2">
                                <span className="font-bold text-slate-700 dark:text-slate-300">SQ</span>
                            </div>
                            <div>
                                <p className="font-bold text-slate-900 dark:text-white">Square POS</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Syncs Orders & Customers</p>
                            </div>
                        </div>
                        {integrationStatus.square ? (
                            <div className="flex items-center gap-3">
                                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-3 py-1 rounded-full text-xs font-bold border border-emerald-100 dark:border-emerald-800">
                                    <CheckCircle size={14} />
                                    Connected
                                </span>
                                <button
                                    onClick={() => disconnectIntegration('square')}
                                    className="text-slate-400 hover:text-rose-500 transition-colors p-1"
                                    title="Disconnect Square"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ) : (
                            <a
                                href="/api/auth/square"
                                className="flex items-center gap-1 text-white bg-slate-900 hover:bg-slate-800 px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                            >
                                Connect Square
                            </a>
                        )}
                    </div>

                    {/* QuickBooks */}
                    <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-100 dark:border-slate-700">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-600 flex items-center justify-center p-2">
                                <span className="font-bold text-green-700 dark:text-green-500">QB</span>
                            </div>
                            <div>
                                <p className="font-bold text-slate-900 dark:text-white">QuickBooks Online</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Syncs Invoices & Customers</p>
                            </div>
                        </div>
                        {integrationStatus.qbo ? (
                            <div className="flex items-center gap-3">
                                <span className="flex items-center gap-1 text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full text-xs font-bold border border-emerald-100">
                                    <CheckCircle size={14} />
                                    Connected
                                </span>
                                <button
                                    onClick={() => disconnectIntegration('qbo')}
                                    className="text-slate-400 hover:text-rose-500 transition-colors p-1"
                                    title="Disconnect QuickBooks"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ) : (
                            <a
                                href="/api/auth/qbo"
                                className="flex items-center gap-1 text-white bg-green-600 hover:bg-green-700 px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                            >
                                Connect QuickBooks
                            </a>
                        )}
                    </div>

                    {/* Meta / Facebook */}
                    <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-100 dark:border-slate-700">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-600 flex items-center justify-center p-2">
                                <span className="font-bold text-blue-600">FB</span>
                            </div>
                            <div>
                                <p className="font-bold text-slate-900 dark:text-white">Meta Business Suite</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Syncs Leads, Comments & Messages</p>
                            </div>
                        </div>
                        {integrationStatus.meta ? (
                            <div className="flex items-center gap-3">
                                <span className="flex items-center gap-1 text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full text-xs font-bold border border-emerald-100">
                                    <CheckCircle size={14} />
                                    Connected
                                </span>
                                <button
                                    onClick={() => disconnectIntegration('meta')}
                                    className="text-slate-400 hover:text-rose-500 transition-colors p-1"
                                    title="Disconnect Meta"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ) : (
                            <a
                                href="/api/auth/meta"
                                className="flex items-center gap-1 text-white bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                            >
                                Connect Facebook
                            </a>
                        )}
                    </div>
                </div>

                <div className="mt-8 border-t border-slate-100 dark:border-slate-700 pt-6">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider mb-4">Supplier Settings</h4>

                    <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-100 dark:border-slate-700">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-600 flex items-center justify-center p-2 shrink-0">
                                <span className="font-bold text-red-600 dark:text-red-500">GFS</span>
                            </div>
                            <div className="flex-1">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <p className="font-bold text-slate-900 dark:text-white">Gordon Food Service</p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">Configure deep linking behavior.</p>
                                    </div>
                                    <button
                                        onClick={handleGfsSave}
                                        className="text-xs font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors"
                                    >
                                        Save Config
                                    </button>
                                </div>

                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mt-2 mb-1">Preferred Portal</label>
                                <select
                                    className="w-full md:w-64 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-red-500"
                                    value={gfsPortalType}
                                    onChange={(e) => setGfsPortalType(e.target.value)}
                                >
                                    <option value="gfs_store">GFS Store (Public)</option>
                                    <option value="gordon_ordering">Gordon Ordering (Commercial)</option>
                                    <option value="gordon_experience">Gordon Experience (Legacy)</option>
                                    <option value="custom">Custom URL</option>
                                </select>

                                {gfsPortalType === 'custom' && (
                                    <input
                                        type="text"
                                        placeholder="https://your-portal.gfs.com"
                                        className="mt-2 w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-red-500"
                                        value={customGfsUrl}
                                        onChange={(e) => setCustomGfsUrl(e.target.value)}
                                    />
                                )}

                                <p className="text-[10px] text-slate-400 mt-2">
                                    "Shop" links will redirect to this portal. Make sure you are logged in correctly in your browser.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Danger Zone */}
            <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-rose-100 dark:border-rose-900/30 p-8">
                <h3 className="text-lg font-bold text-rose-600 dark:text-rose-500 mb-2 flex items-center gap-2">
                    <Trash2 size={20} />
                    Danger Zone
                </h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">Irreversible actions for system management.</p>

                <div className="flex items-center justify-between">
                    <div>
                        <p className="font-medium text-slate-900 dark:text-white">Reset Local Database</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Deletes all saved recipes and production logs.</p>
                    </div>
                    <button className="px-4 py-2 bg-white dark:bg-slate-700 border border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/40 rounded-lg font-medium text-sm transition-colors">
                        Clear All Data
                    </button>
                </div>
            </div>
        </div>
    );
}
