"use client";

import { useState, useEffect } from 'react';
import {
    Settings,
    User,
    Shield,
    RefreshCw,
    Database,
    Trash2,
    Save,
    Upload,
    CheckCircle,
    XCircle,
    Smartphone,
    Mail,
    Lock,
    Globe,
    ExternalLink,
    Sparkles,
    Calendar,
    AlertTriangle,
    QrCode,
    FileSpreadsheet,
    Users
} from 'lucide-react';
import { updateCalendarUrl } from '@/app/actions/settings';
import { useSession } from 'next-auth/react';
import DashboardImporter from '@/components/DashboardImporter';
import RecipeImporter from '@/components/RecipeImporter';
import CustomerImporter from '@/components/CustomerImporter';
import FundraiserImporter from '@/components/FundraiserImporter';
import { Database as DatabaseIcon } from 'lucide-react';

function AccountSecuritySection() {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');

    async function handleChangePassword() {
        if (!currentPassword || !newPassword) return;
        setStatus('loading');
        try {
            const res = await fetch('/api/auth/password', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await res.json();

            if (res.ok) {
                setStatus('success');
                setCurrentPassword('');
                setNewPassword('');
                setTimeout(() => setStatus('idle'), 3000);
            } else {
                setStatus('error');
                setErrorMsg(data.error || 'Failed to update');
            }
        } catch (e) {
            setStatus('error');
            setErrorMsg('System error');
        } finally {
            if (status !== 'success') setTimeout(() => setStatus('idle'), 3000);
        }
    }

    return (
        <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive mb-6 flex items-center gap-2">
                <Lock size={20} className="text-emerald-600 dark:text-emerald-400" />
                Account Security
            </h3>

            <div className="max-w-md space-y-4">
                <div>
                    <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1">Current Password</label>
                    <input
                        type="password"
                        value={currentPassword}
                        onChange={e => setCurrentPassword(e.target.value)}
                        className="w-full p-2 border border-slate-200 dark:border-slate-600 rounded-lg bg-transparent"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1">New Password</label>
                    <input
                        type="password"
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        className="w-full p-2 border border-slate-200 dark:border-slate-600 rounded-lg bg-transparent"
                    />
                </div>

                <button
                    onClick={handleChangePassword}
                    disabled={status === 'loading'}
                    className={`mt-2 px-4 py-2 rounded-lg font-medium text-white transition-colors ${status === 'success' ? 'bg-emerald-600' :
                        status === 'error' ? 'bg-rose-600' :
                            'bg-slate-900 dark:bg-slate-700 hover:bg-slate-800'
                        }`}
                >
                    {status === 'loading' ? 'Updating...' :
                        status === 'success' ? 'Password Updated!' :
                            status === 'error' ? errorMsg : 'Change Password'}
                </button>
            </div>
        </div>
    );
}

function AiIntegrationSection() {
    const [keys, setKeys] = useState({ openai: '', gemini: '' });
    const [status, setStatus] = useState({ openai: false, gemini: false });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetch('/api/integrations/keys')
            .then(res => res.json())
            .then(data => {
                setStatus(data);
                setLoading(false);
            })
            .catch(e => {
                console.error(e);
                setLoading(false);
            });
    }, []);

    const handleSave = async (provider: 'openai' | 'gemini') => {
        const key = keys[provider];
        if (!key && !confirm("Are you sure you want to remove this key?")) return;

        setSaving(true);
        try {
            const res = await fetch('/api/integrations/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, key })
            });

            if (res.ok) {
                const data = await res.json();
                if (data.status === 'removed') {
                    setStatus(prev => ({ ...prev, [provider]: false }));
                    setKeys(prev => ({ ...prev, [provider]: '' }));
                    alert(`${provider === 'openai' ? 'OpenAI' : 'Gemini'} key removed.`);
                } else {
                    setStatus(prev => ({ ...prev, [provider]: true }));
                    setKeys(prev => ({ ...prev, [provider]: '' })); // Clear input for security
                    alert(`${provider === 'openai' ? 'OpenAI' : 'Gemini'} key saved!`);
                }
            } else {
                alert("Failed to save key.");
            }
        } catch (e) {
            alert("Error saving key.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive mb-6 flex items-center gap-2">
                <Sparkles size={20} className="text-purple-600 dark:text-purple-400" />
                AI Content Generation
            </h3>

            <div className="flex flex-col gap-8">
                {/* OpenAI */}
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">OpenAI (ChatGPT/DALL-E)</label>
                        {status.openai && (
                            <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 px-3 py-1 rounded-full border border-emerald-100 dark:border-emerald-800/50 flex items-center gap-1 uppercase tracking-wider">
                                <CheckCircle size={12} /> Connected
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <div className="relative flex-1 min-w-0">
                            <input
                                type="password"
                                value={keys.openai}
                                onChange={e => setKeys(prev => ({ ...prev, openai: e.target.value }))}
                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none focus:ring-2 focus:ring-purple-500 font-mono"
                                placeholder={status.openai ? "••••••••••••••••" : "sk-..."}
                            />
                        </div>
                        <button
                            onClick={() => handleSave('openai')}
                            disabled={saving}
                            className="px-4 py-2 bg-slate-900 dark:bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-sm font-bold transition-all shadow-sm active:scale-95 disabled:opacity-50 whitespace-nowrap"
                        >
                            Save
                        </button>
                    </div>
                    <p className="text-[10px] font-medium text-slate-400 leading-relaxed italic">Used for generating images and descriptions.</p>
                </div>

                {/* Gemini */}
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">Google Gemini</label>
                        {status.gemini && (
                            <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 px-3 py-1 rounded-full border border-emerald-100 dark:border-emerald-800/50 flex items-center gap-1 uppercase tracking-wider">
                                <CheckCircle size={12} /> Connected
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <div className="relative flex-1 min-w-0">
                            <input
                                type="password"
                                value={keys.gemini}
                                onChange={e => setKeys(prev => ({ ...prev, gemini: e.target.value }))}
                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none focus:ring-2 focus:ring-purple-500 font-mono"
                                placeholder={status.gemini ? "••••••••••••••••" : "AIza..."}
                            />
                        </div>
                        <button
                            onClick={() => handleSave('gemini')}
                            disabled={saving}
                            className="px-4 py-2 bg-slate-900 dark:bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-sm font-bold transition-all shadow-sm active:scale-95 disabled:opacity-50 whitespace-nowrap"
                        >
                            Save
                        </button>
                    </div>
                    <p className="text-[10px] font-medium text-slate-400 leading-relaxed italic">Used for text generation (Image generation coming soon).</p>
                </div>
            </div>
        </div>
    );
}

function CalendarSettingsSection() {
    const [calendarUrl, setCalendarUrl] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/business')
            .then(res => res.json())
            .then(data => {
                if (data.google_calendar_url) setCalendarUrl(data.google_calendar_url);
                setLoading(false);
            })
            .catch(e => {
                console.error(e);
                setLoading(false);
            });
    }, []);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const result = await updateCalendarUrl(calendarUrl);
            if (result.success) {
                alert("Calendar link saved successfully!");
            } else {
                alert(result.error || "Failed to save calendar URL");
            }
        } catch (e) {
            console.error(e);
            alert("Error saving calendar URL");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 mt-8">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive mb-6 flex items-center gap-2">
                <Calendar size={20} className="text-indigo-600 dark:text-indigo-400" />
                Google Calendar Integration
            </h3>

            <div className="space-y-4">
                <div>
                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                        Calendar Public URL or Embed Code
                    </label>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={calendarUrl}
                            onChange={(e) => setCalendarUrl(e.target.value)}
                            className="flex-1 px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                            placeholder="Paste Public URL or <iframe src='...'></iframe>"
                        />
                        <button
                            onClick={handleSave}
                            disabled={isSaving || loading}
                            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold transition-all shadow-md disabled:opacity-50"
                        >
                            {isSaving ? 'Saving...' : 'Connect Calendar'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function DataManagementSection() {
    const handleBundleExport = () => {
        window.location.href = '/api/bundles/export';
    };

    const handleBundleExportCSV = () => {
        window.location.href = '/api/csv/export/bundles';
    };

    const handleRecipeExport = () => {
        window.location.href = '/api/recipes/backup';
    };

    const handleRecipeExportCSV = () => {
        window.location.href = '/api/csv/export/recipes';
    };

    const handleCustomerExportCSV = () => {
        window.location.href = '/api/csv/export/customers';
    };

    return (
        <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 mt-8">
            <div className="flex items-center gap-2 mb-6">
                <DatabaseIcon size={20} className="text-indigo-600 dark:text-indigo-400" />
                <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive">
                    Data Management
                </h3>
            </div>

            <div className="space-y-8">
                {/* Bundles & Catalogs */}
                <div className="p-4 bg-slate-50/50 dark:bg-slate-900/30 rounded-xl border border-slate-100 dark:border-slate-800">
                    <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Bundles & Catalogs</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        Backup or restore your bundles, pricing, and active catalogs.
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <button
                            onClick={handleBundleExport}
                            className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-300 text-sm transition-colors shadow-sm"
                        >
                            <Save size={16} className="text-indigo-500" />
                            Export JSON
                        </button>
                        <button
                            onClick={handleBundleExportCSV}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 rounded-xl hover:bg-emerald-100 dark:hover:bg-emerald-900/30 font-bold text-emerald-700 dark:text-emerald-400 text-sm transition-colors shadow-sm"
                        >
                            <FileSpreadsheet size={16} />
                            Export CSV
                        </button>
                        <DashboardImporter minimal={true} />
                    </div>
                </div>

                {/* Recipes & Inventory */}
                <div className="p-4 bg-slate-50/50 dark:bg-slate-900/30 rounded-xl border border-slate-100 dark:border-slate-800">
                    <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Recipes & Inventory</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        Backup or restore your recipe database, ingredients, and packaging stock.
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <button
                            onClick={handleRecipeExport}
                            className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-300 text-sm transition-colors shadow-sm"
                        >
                            <Save size={16} className="text-indigo-500" />
                            Export JSON
                        </button>
                        <button
                            onClick={handleRecipeExportCSV}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 rounded-xl hover:bg-emerald-100 dark:hover:bg-emerald-900/30 font-bold text-emerald-700 dark:text-emerald-400 text-sm transition-colors shadow-sm"
                        >
                            <FileSpreadsheet size={16} />
                            Export CSV
                        </button>

                        <RecipeImportTrigger />
                    </div>
                </div>

                {/* Fundraisers */}
                <div className="p-4 bg-slate-50/50 dark:bg-slate-900/30 rounded-xl border border-slate-100 dark:border-slate-800">
                    <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Fundraisers & Organizations</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        Import/Export fundraiser organizations and campaigns.
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <button
                            onClick={() => window.location.href = '/api/csv/export/fundraisers'}
                            className="flex items-center gap-2 px-4 py-2 bg-pink-50 dark:bg-pink-900/20 border border-pink-100 dark:border-pink-800/50 rounded-xl hover:bg-pink-100 dark:hover:bg-pink-900/30 font-bold text-pink-700 dark:text-pink-400 text-sm transition-colors shadow-sm"
                        >
                            <FileSpreadsheet size={16} />
                            Export CSV
                        </button>
                        <FundraiserImportTrigger />
                    </div>
                </div>

                {/* Customers */}
                <div className="p-4 bg-slate-50/50 dark:bg-slate-900/30 rounded-xl border border-slate-100 dark:border-slate-800">
                    <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Customers</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        Import your customer directory from Square or other platforms via CSV.
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <button
                            onClick={handleCustomerExportCSV}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 rounded-xl hover:bg-emerald-100 dark:hover:bg-emerald-900/30 font-bold text-emerald-700 dark:text-emerald-400 text-sm transition-colors shadow-sm"
                        >
                            <FileSpreadsheet size={16} />
                            Export CSV
                        </button>
                        <CustomerImportTrigger />
                    </div>
                </div>
            </div>
        </div>
    );
}

function FundraiserImportTrigger() {
    const [showImporter, setShowImporter] = useState(false);

    return (
        <>
            <button
                onClick={() => setShowImporter(true)}
                className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-300 text-sm transition-colors shadow-sm"
            >
                <Upload size={16} className="text-pink-500" />
                Import Fundraisers
            </button>
            {showImporter && <FundraiserImporter onClose={() => setShowImporter(false)} />}
        </>
    );
}

function RecipeImportTrigger() {
    const [showImporter, setShowImporter] = useState(false);

    return (
        <>
            <button
                onClick={() => setShowImporter(true)}
                className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-300 text-sm transition-colors shadow-sm"
            >
                <Upload size={16} className="text-indigo-500" />
                Import Recipes
            </button>
            {showImporter && <RecipeImporter onClose={() => setShowImporter(false)} />}
        </>
    );
}

function CustomerImportTrigger() {
    const [showImporter, setShowImporter] = useState(false);

    return (
        <>
            <button
                onClick={() => setShowImporter(true)}
                className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-300 text-sm transition-colors shadow-sm"
            >
                <Users size={16} className="text-indigo-500" />
                Import Customers (Square)
            </button>
            {showImporter && <CustomerImporter onClose={() => setShowImporter(false)} />}
        </>
    );
}

export default function SettingsPage() {
    const { data: session } = useSession();
    const [integrationStatus, setIntegrationStatus] = useState({ square: false, qbo: false, meta: false, instagram: false });
    const [isBackingUp, setIsBackingUp] = useState(false);
    const [backupStatus, setBackupStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [isConfirmingClear, setIsConfirmingClear] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);

    useEffect(() => {
        fetch('/api/integrations/status')
            .then(res => res.json())
            .then(data => setIntegrationStatus(data))
            .catch(console.error);
    }, []);

    const disconnectIntegration = async (provider: 'square' | 'qbo' | 'meta' | 'instagram') => {
        if (!confirm(`Are you sure you want to delete the ${provider} connection?`)) return;
        try {
            const res = await fetch('/api/integrations/disconnect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider })
            });
            if (res.ok) {
                setIntegrationStatus(prev => ({ ...prev, [provider]: false }));
                alert(`${provider} disconnected successfully.`);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleBackup = async () => {
        setIsBackingUp(true);
        setBackupStatus(null);
        try {
            const res = await fetch('/api/admin/backup', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                setBackupStatus({ success: true, message: "Backup completed successfully!" });
            } else {
                setBackupStatus({ success: false, message: data.error || "Backup failed." });
            }
        } catch (e: any) {
            setBackupStatus({ success: false, message: "Network error." });
        } finally {
            setIsBackingUp(false);
        }
    };

    const handleClearData = async () => {
        if (deleteConfirmText !== "DELETE") return;
        setIsDeleting(true);
        try {
            const res = await fetch('/api/tenant/clear-data', { method: 'POST' });
            if (res.ok) {
                alert("Data cleared.");
                window.location.reload();
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="p-6 max-w-4xl mx-auto pb-32">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 mb-12">
                <div className="flex items-center gap-4">
                    <div className="w-16 h-16 bg-white dark:bg-slate-800 rounded-2xl border-2 border-indigo-100 dark:border-indigo-900/50 flex items-center justify-center shadow-xl">
                        <Settings size={32} className="text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div>
                        <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight">System Settings</h1>
                        <p className="text-slate-500 dark:text-slate-400 mt-1 text-lg">Manage integrations, backups, and security.</p>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                <div className="space-y-8">
                    <AccountSecuritySection />
                    {session?.user?.isSuperAdmin && (
                        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8">
                            <h2 className="text-xl font-bold text-slate-800 dark:text-white flex items-center gap-2 mb-6">
                                <Database className="w-5 h-5 text-indigo-600" />
                                System Backup
                            </h2>
                            <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-100 dark:border-slate-700 flex items-center justify-between">
                                <p className="text-xs font-bold text-slate-700 dark:text-slate-300">Manual Backup</p>
                                <button
                                    onClick={handleBackup}
                                    disabled={isBackingUp}
                                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold"
                                >
                                    {isBackingUp ? 'Running...' : 'Backup Now'}
                                </button>
                            </div>
                            {backupStatus && (
                                <p className={`mt-4 text-xs font-bold ${backupStatus.success ? 'text-emerald-600' : 'text-rose-600'}`}>
                                    {backupStatus.message}
                                </p>
                            )}
                        </div>
                    )}
                </div>

                <div className="space-y-8">
                    <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive mb-6 flex items-center gap-2">
                            <RefreshCw size={20} className="text-indigo-600 dark:text-indigo-400" />
                            Integrations
                        </h3>
                        <div className="space-y-4">
                            <IntegrationItem
                                name="Square POS"
                                logo="SQ"
                                isConnected={integrationStatus.square}
                                connectUrl="/api/auth/square"
                                onDisconnect={() => disconnectIntegration('square')}
                            />
                            <IntegrationItem
                                name="QuickBooks"
                                logo="QB"
                                isConnected={integrationStatus.qbo}
                                connectUrl="/api/auth/qbo"
                                onDisconnect={() => disconnectIntegration('qbo')}
                            />
                        </div>
                    </div>
                    <AiIntegrationSection />
                    <CalendarSettingsSection />
                </div>
            </div>

            <div className="space-y-8">
                <DataManagementSection />
                <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-rose-100 dark:border-rose-900/30 p-8">
                    <h3 className="text-lg font-bold text-rose-600 dark:text-rose-500 mb-2 flex items-center gap-2">
                        <Trash2 size={20} />
                        Danger Zone
                    </h3>
                    <div className="p-4 bg-rose-50/50 dark:bg-rose-900/10 rounded-xl border border-rose-100 dark:border-rose-900/20 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                            <p className="font-bold text-slate-900 dark:text-white">Clear All Tenant Data</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">Permanently delete all records for this kitchen.</p>
                        </div>
                        {!isConfirmingClear ? (
                            <button
                                onClick={() => setIsConfirmingClear(true)}
                                className="px-6 py-3 border border-rose-200 text-rose-600 rounded-xl font-bold text-sm"
                            >
                                Start Reset
                            </button>
                        ) : (
                            <div className="flex flex-col items-end gap-2">
                                <input
                                    type="text"
                                    value={deleteConfirmText}
                                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                                    placeholder="Type DELETE"
                                    className="px-4 py-2 border-2 border-rose-500 rounded-lg text-sm"
                                />
                                <button
                                    onClick={handleClearData}
                                    disabled={deleteConfirmText !== "DELETE" || isDeleting}
                                    className="px-6 py-2 bg-rose-600 text-white rounded-lg font-bold text-sm"
                                >
                                    Confirm
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function IntegrationItem({ name, logo, isConnected, connectUrl, onDisconnect }: any) {
    return (
        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 flex items-center justify-center font-bold">{logo}</div>
                <p className="font-bold text-slate-900 dark:text-white text-sm">{name}</p>
            </div>
            {isConnected ? (
                <button onClick={onDisconnect} className="text-slate-400 hover:text-rose-500"><Trash2 size={16} /></button>
            ) : (
                <a href={connectUrl} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-xs font-bold">Connect</a>
            )}
        </div>
    );
}
