"use client";

import { useState, useEffect, useRef } from 'react';
import { FileText, Send, X, Eye, Loader2, Check, Save, Link as LinkIcon, Printer } from 'lucide-react';
import { createPortal } from 'react-dom';
import FundraiserSetup from './crm/FundraiserSetup';

interface Template {
    id: string;
    name: string;
    type: string;
    content?: string;
    isGlobal?: boolean;
}

interface DocumentCenterProps {
    customer: any;
    existingDoc?: any;
    onSave?: () => void;
}

export default function DocumentCenter({ customer, existingDoc, onSave }: DocumentCenterProps) {
    const [mounted, setMounted] = useState(false);
    const [templates, setTemplates] = useState<Template[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
    const [previewContent, setPreviewContent] = useState<string | null>(null);
    const [docName, setDocName] = useState<string>('');
    const [isGenerating, setIsGenerating] = useState(false);

    // Link Mode State
    const [isLinkMode, setIsLinkMode] = useState(false);
    const [externalLinkUrl, setExternalLinkUrl] = useState('');

    // Status states
    const [isSending, setIsSending] = useState(false);
    const [sendSuccess, setSendSuccess] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    const [files, setFiles] = useState<File[]>([]);
    const editorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Update editor content when previewContent changes externally (e.g. template load)
    useEffect(() => {
        if (editorRef.current && previewContent && document.activeElement !== editorRef.current) {
            if (editorRef.current.innerHTML !== previewContent) {
                editorRef.current.innerHTML = previewContent;
            }
        }
    }, [previewContent]);

    useEffect(() => {
        // If editing an existing document, load it immediately
        if (existingDoc) {
            setDocName(existingDoc.name);
            setSelectedTemplate({ id: existingDoc.id, name: existingDoc.name, type: 'Saved Document' });

            if (existingDoc.external_link) {
                setIsLinkMode(true);
                setExternalLinkUrl(existingDoc.external_link);
                setPreviewContent(null);
            } else {
                setPreviewContent(existingDoc.content);
                setIsLinkMode(false);
            }

            setIsLoading(false);
            return;
        }

        // Otherwise fetch available templates
        fetch('/api/documents/templates')
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setTemplates(data);
                } else {
                    console.error("Templates API returned invalid data (likely error):", data);
                    setTemplates([]); // Fallback
                }
                setIsLoading(false);
            })
            .catch(err => {
                console.error("Failed to load templates", err);
                setIsLoading(false);
            });
    }, [existingDoc]);

    // Fundraiser Info State
    const [fundraiserInfo, setFundraiserInfo] = useState<any>({
        deadline: customer.fundraiser_info?.deadline || '',
        deadline_time: customer.fundraiser_info?.deadline_time || '4:00 PM',
        delivery_date: customer.fundraiser_info?.delivery_date || '',
        delivery_time: customer.fundraiser_info?.delivery_time || '4:45 PM',
        pickup_location: customer.fundraiser_info?.pickup_location || '',
        checks_payable_to: customer.fundraiser_info?.checks_payable_to || customer.name,
        bundle1_recipes: customer.fundraiser_info?.bundle1_recipes || '',
        bundle2_recipes: customer.fundraiser_info?.bundle2_recipes || '',
        bundle1_price: customer.fundraiser_info?.bundle1_price || '60.60',
        bundle2_price: customer.fundraiser_info?.bundle2_price || '126.25',
    });
    const [showFundraiserModal, setShowFundraiserModal] = useState(false);
    const [pendingTemplate, setPendingTemplate] = useState<Template | null>(null);

    // Recipe & Bundle Search State
    const [allRecipes, setAllRecipes] = useState<any[]>([]);
    const [bundles, setBundles] = useState<any[]>([]);
    const [selectedBundleToLoad, setSelectedBundleToLoad] = useState<any>(null);
    const [recipeSearch, setRecipeSearch] = useState('');

    // Fetch recipes and bundles when modal opens
    useEffect(() => {
        if (showFundraiserModal && allRecipes.length === 0) {
            Promise.all([
                fetch('/api/recipes').then(res => res.json()),
                fetch('/api/bundles?full=true').then(res => res.json())
            ]).then(([recipesData, bundlesData]) => {
                if (recipesData.recipes) setAllRecipes(recipesData.recipes);
                if (Array.isArray(bundlesData)) setBundles(bundlesData);
            }).catch(err => console.error("Failed to fetch data", err));
        }
    }, [showFundraiserModal]);

    const filteredRecipes = recipeSearch
        ? allRecipes.filter(r => r.name.toLowerCase().includes(recipeSearch.toLowerCase())).slice(0, 10)
        : [];

    const addToBundle = (bundleNum: number, recipeName: string) => {
        const key = bundleNum === 1 ? 'bundle1_recipes' : 'bundle2_recipes';
        const current = fundraiserInfo[key] || '';
        const newValue = current ? current + '\n' + recipeName : recipeName;

        setFundraiserInfo((prev: any) => ({ ...prev, [key]: newValue }));
        setRecipeSearch(''); // Clear search after add
    };

    const handleSelectTemplate = async (template: Template) => {
        // If it's a Fundraiser Template, check if we need info
        // Trigger for 'fundraiser', 'sales', or 'agreement' in ID or Name
        if (
            template.id.includes('fundraiser') ||
            template.id.includes('sales') ||
            template.id.includes('agreement') ||
            template.name.toLowerCase().includes('fundraiser')
        ) {
            setPendingTemplate(template);
            // Open modal to confirm/edit details
            setShowFundraiserModal(true);
            return;
        }

        generateDocument(template);
    };

    const generateDocument = (template: Template) => {
        setSelectedTemplate(template);
        setDocName(`${template.name} - ${customer.name}`);
        setIsGenerating(true);
        setSendSuccess(false);

        let content = template.content || "<p>Loading...</p>";

        // Helper to format recipes as HTML list if they are newlines
        const formatRecipes = (text: string) => {
            if (!text) return '<div style="margin-left: 10px;">Chef\'s Selection</div>';
            return '<div style="margin-left: 5px;">' +
                text.split('\n').filter(Boolean).map((line, i) =>
                    `<div style="margin-bottom: 5px; display: flex;"><span style="font-weight: bold; margin-right: 8px; min-width: 15px;">${i + 1}.</span><span>${line}</span></div>`
                ).join('') +
                '</div>';
        };

        // Client-side placeholder replacement
        content = content
            .replace(/{{OrganizationName}}/g, customer.name)
            .replace(/{{ContactName}}/g, customer.contact_name || customer.name.split(' ')[0])
            .replace(/{{ContactEmail}}/g, customer.email || '')
            .replace(/{{Date}}/g, new Date().toLocaleDateString())
            .replace(/{{DeliveryAddress}}/g, customer.delivery_address || 'Not Provided')
            .replace(/{{GoalAmount}}/g, fundraiserInfo.bundle_goal ? `${fundraiserInfo.bundle_goal} bundles` : '100 bundles')
            // Fundraiser Specifics
            .replace(/{{FundraiserDeadline}}/g, fundraiserInfo.deadline ? new Date(fundraiserInfo.deadline).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '____________')
            .replace(/{{FundraiserDeadlineTime}}/g, fundraiserInfo.deadline_time || '')
            .replace(/{{FundraiserDelivery}}/g, fundraiserInfo.delivery_date ? new Date(fundraiserInfo.delivery_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '____________')
            .replace(/{{FundraiserDeliveryTime}}/g, fundraiserInfo.delivery_time || '')
            .replace(/{{FundraiserPickup}}/g, fundraiserInfo.pickup_location || customer.delivery_address || '____________')
            .replace(/{{ChecksPayableTo}}/g, fundraiserInfo.checks_payable_to || customer.name)
            .replace(/{{Bundle1Recipes}}/g, formatRecipes(fundraiserInfo.bundle1_recipes))
            .replace(/{{Bundle2Recipes}}/g, formatRecipes(fundraiserInfo.bundle2_recipes))
            .replace(/{{Bundle1Price}}/g, fundraiserInfo.bundle1_price || '60.60')
            .replace(/{{Bundle2Price}}/g, fundraiserInfo.bundle2_price || '126.25');

        setPreviewContent(content);
        setIsGenerating(false);
        setPendingTemplate(null);
    };

    const saveFundraiserInfo = async (overrideInfo?: any) => {
        const payload = overrideInfo || fundraiserInfo;
        // Save to Customer API
        try {
            await fetch(`/api/customers/${customer.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fundraiser_info: payload
                })
            });
        } catch (e) {
            console.error("Failed to save fundraiser info", e);
        }

        setShowFundraiserModal(false);
        if (pendingTemplate) {
            generateDocument(pendingTemplate);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            setFiles(Array.from(e.target.files));
        }
    };

    const handleSave = async () => {
        // Validation Checks
        if (!docName) {
            alert("Please enter a document name.");
            return;
        }

        if (isLinkMode) {
            if (!externalLinkUrl) {
                alert("Please enter a valid URL.");
                return;
            }
        } else {
            if (!previewContent) {
                alert("Document content is empty.");
                return;
            }
        }

        setIsSaving(true);

        try {
            const method = existingDoc ? 'PUT' : 'POST';
            const url = existingDoc ? `/api/documents/${existingDoc.id}` : '/api/documents';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: docName,
                    content: isLinkMode ? null : previewContent,
                    external_link: isLinkMode ? externalLinkUrl : null,
                    customerId: customer.id,
                    status: 'Draft'
                })
            });

            if (res.ok) {
                setSaveSuccess(true);
                setTimeout(() => {
                    setSaveSuccess(false);
                    if (onSave) onSave();
                }, 1000);
            } else {
                const err = await res.json();
                alert(`Failed to save: ${err.error || 'Unknown server error'}`);
            }
        } catch (e) {
            alert("Error saving document");
        } finally {
            setIsSaving(false);
        }
    }

    const handleSend = async () => {
        // Validation
        if (!docName) {
            alert("Please enter a document name.");
            return;
        }
        if (!customer.email) {
            alert("This customer does not have an email address.");
            return;
        }
        if (!selectedTemplate && files.length === 0) {
            alert("No content or files to send.");
            return;
        }

        setIsSending(true);

        // Auto-save before sending if it's a drafted document
        if (!existingDoc && previewContent) {
            // Optional: logic to save automatically? 
            // For now, let's just send.
        }

        try {
            // Convert files to base64 for mock sending
            const attachments = await Promise.all(files.map(async file => {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.readAsDataURL(file);
                    reader.onload = () => resolve({ name: file.name, content: reader.result, type: file.type });
                    reader.onerror = reject;
                });
            }));

            const res = await fetch('/api/documents/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recipient: customer.email,
                    subject: `Freezer Chef - ${docName}`,
                    documentName: docName,
                    htmlContent: previewContent || '<p>Detailed documents attached.</p>',
                    attachments
                })
            });

            if (res.ok) {
                setSendSuccess(true);

                // If this was a saved doc, update status to Sent
                if (existingDoc) {
                    await fetch(`/api/documents/${existingDoc.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'Sent' })
                    });
                }

                setTimeout(() => {
                    // Only close if we are not in "Edit mode" of an existing doc (or maybe we do?)
                    // If we are in existing doc, maybe just stay? 
                    // Let's close for now to signal completion.
                    if (onSave) onSave(); // Go back to list
                    else setSelectedTemplate(null);

                    setFiles([]);
                    setSendSuccess(false);
                }, 2000);
            } else {
                alert("Failed to send document");
            }
        } catch (e) {
            alert("Error sending document");
        } finally {
            setIsSending(false);
        }
    };

    if (isLoading) return <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl animate-pulse h-24"></div>;

    return (
        <div className="glass-panel p-6 rounded-3xl space-y-5 bg-white dark:bg-slate-800 dark:border-slate-700 relative">

            {/* Fundraiser Info Modal - PORTALED */}
            {showFundraiserModal && mounted && createPortal(
                <div className="fixed inset-0 z-[9999] bg-white/90 dark:bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-slate-800 shadow-2xl rounded-2xl p-8 w-full max-w-4xl border border-slate-200 dark:border-slate-700 max-h-[90vh] overflow-y-auto relative">
                        <button
                            onClick={() => setShowFundraiserModal(false)}
                            className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                        >
                            <X size={24} />
                        </button>

                        <FundraiserSetup
                            customer={{ ...customer, fundraiser_info: fundraiserInfo }}
                            onSave={async (data) => {
                                setFundraiserInfo(data);
                                await saveFundraiserInfo(data);
                            }}
                            allowCancel={true}
                            onCancel={() => setShowFundraiserModal(false)}
                        />
                    </div>
                </div>,
                document.body
            )}

            {
                !existingDoc && (
                    <>
                        <h3 className="font-bold text-slate-900 dark:text-white border-b border-slate-100/50 dark:border-slate-700 pb-3 text-lg flex items-center gap-2">
                            <FileText size={20} className="text-indigo-500" />
                            New Document
                        </h3>

                        <div className="space-y-3">
                            <p className="text-sm text-slate-500 dark:text-slate-400">Choose a template to start with:</p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {templates.map(t => (
                                    <button
                                        key={t.id}
                                        onClick={() => handleSelectTemplate(t)}
                                        className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:border-indigo-200 border border-slate-200 dark:border-slate-700 transition-all group text-left"
                                    >
                                        <div className="min-w-0">
                                            <div className="font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-700 dark:group-hover:text-indigo-300 transition-colors truncate">{t.name}</div>
                                            <div className="text-xs text-slate-400 font-medium uppercase tracking-wide mt-1">
                                                {t.isGlobal ? 'System Template' : 'Custom Template'}
                                            </div>
                                        </div>
                                        <div className="w-8 h-8 rounded-full bg-white dark:bg-slate-800 flex items-center justify-center text-slate-300 group-hover:text-indigo-500 shadow-sm transition-colors shrink-0">
                                            <FileText size={14} />
                                        </div>
                                    </button>
                                ))}

                                {/* Add Link Box */}
                                <div className="relative flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-xl border-dashed border-2 border-slate-300 dark:border-slate-600 hover:border-indigo-400 transition-all group cursor-pointer"
                                    onClick={() => {
                                        setSelectedTemplate({ id: 'link', name: 'External Link', type: 'link', content: '' });
                                        setDocName('');
                                        setPreviewContent(null);
                                        setIsLinkMode(true);
                                    }}
                                >
                                    <div className="min-w-0">
                                        <div className="font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-700 dark:group-hover:text-indigo-300 transition-colors truncate">
                                            Link to Sheet / Doc
                                        </div>
                                        <div className="text-xs text-slate-400 font-medium uppercase tracking-wide mt-1">
                                            Add Google Sheet URL
                                        </div>
                                    </div>
                                    <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center text-emerald-500 shadow-sm transition-colors shrink-0">
                                        <LinkIcon size={14} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </>
                )
            }

            {/* Preview / Edit Modal/Panel */}
            {
                selectedTemplate && (
                    // Inline Container (No more Modal)
                    <div className="flex flex-col h-[800px] bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
                        <div className="flex flex-col h-full">

                            {/* Header */}
                            <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-900/50 shrink-0 rounded-t-2xl">
                                <div className="flex-1 mr-4">
                                    <div className="flex items-center gap-2 mb-1">
                                        {isLinkMode ? <LinkIcon size={20} className="text-emerald-500" /> : <Eye size={20} className="text-slate-400" />}
                                        <input
                                            value={docName}
                                            onChange={(e) => setDocName(e.target.value)}
                                            className="font-black text-lg text-slate-900 dark:text-white bg-transparent border-none focus:ring-0 p-0 w-full placeholder:text-slate-300"
                                            placeholder="Document Name (Required)"
                                        />
                                    </div>
                                    <p className="text-xs text-slate-500">{isLinkMode ? 'Enter the external URL below.' : 'Click text below to edit.'}</p>
                                </div>
                                {!existingDoc && (
                                    <button onClick={() => { setSelectedTemplate(null); setIsLinkMode(false); }} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full text-slate-400 hover:text-slate-600 transition-colors">
                                        <X size={24} />
                                    </button>
                                )}
                            </div>

                            {/* Editor Area */}
                            <div className={`flex-1 overflow-auto p-8 bg-slate-100 dark:bg-black/20 ${existingDoc ? 'min-h-[600px] rounded-xl' : ''} flex flex-col`}>
                                {isGenerating ? (
                                    <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4">
                                        <Loader2 size={48} className="animate-spin text-indigo-500" />
                                        <p>Generating document...</p>
                                    </div>
                                ) : isLinkMode ? (
                                    <div className="flex flex-col items-center justify-center h-full max-w-xl mx-auto w-full space-y-6">
                                        <div className="w-full text-center space-y-2">
                                            <div className="bg-white dark:bg-slate-800 p-6 rounded-full inline-block shadow-sm">
                                                <LinkIcon size={48} className="text-emerald-500" />
                                            </div>
                                            <h3 className="text-xl font-bold text-slate-900 dark:text-white">Add External Link</h3>
                                            <p className="text-slate-500">Paste the URL to your Google Sheet, Doc, or other external resource.</p>
                                        </div>
                                        <input
                                            type="url"
                                            placeholder="https://docs.google.com/spreadsheets/d/..."
                                            className="w-full p-4 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all"
                                            value={externalLinkUrl}
                                            onChange={(e) => setExternalLinkUrl(e.target.value)}
                                        />
                                    </div>
                                ) : (
                                    <div
                                        ref={editorRef}
                                        className="bg-white text-slate-900 shadow-lg p-12 min-h-[800px] max-w-3xl mx-auto rounded-sm prose prose-slate lg:prose-lg outline-none focus:ring-2 focus:ring-indigo-500/50"
                                        contentEditable
                                        suppressContentEditableWarning
                                        onInput={(e) => setPreviewContent(e.currentTarget.innerHTML)}
                                        onBlur={(e) => setPreviewContent(e.currentTarget.innerHTML)}
                                    />
                                )}
                            </div>

                            {/* Footer / Actions */}
                            <div className="p-4 border-t border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 shrink-0 flex justify-between items-center rounded-b-2xl">
                                <div className="flex items-center gap-4">
                                    {!isLinkMode && (
                                        <div className="relative group cursor-pointer text-sm font-bold text-slate-500 hover:text-indigo-600 flex items-center gap-2">
                                            <input type="file" multiple onChange={handleFileChange} className="absolute inset-0 opacity-0 cursor-pointer" />
                                            <span>{files.length > 0 ? `${files.length} Attachments` : 'Add Attachments'}</span>
                                        </div>
                                    )}
                                </div>

                                <div className="flex gap-3">
                                    {!existingDoc && (
                                        <button
                                            onClick={() => { setSelectedTemplate(null); setIsLinkMode(false); }}
                                            className="px-4 py-2 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                                        >
                                            Cancel
                                        </button>
                                    )}

                                    <button
                                        onClick={() => {
                                            const printWindow = window.open('', '_blank');
                                            if (printWindow) {
                                                printWindow.document.write(`
                                                    <html>
                                                        <head>
                                                            <title>${docName}</title>
                                                            <style>
                                                                body { font-family: sans-serif; margin: 40px; }
                                                                @media print {
                                                                    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                                                                }
                                                            </style>
                                                        </head>
                                                        <body>
                                                            ${previewContent}
                                                            <script>
                                                                window.onload = () => { window.print(); window.close(); }
                                                            </script>
                                                        </body>
                                                    </html>
                                                `);
                                                printWindow.document.close();
                                            }
                                        }}

                                        className="px-4 py-2 rounded-xl font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 transition flex items-center gap-2"
                                    >
                                        <Printer size={16} />
                                        Print Preview
                                    </button>

                                    <button
                                        onClick={handleSave}
                                        disabled={isSaving || saveSuccess}
                                        className={`px-6 py-2 rounded-xl font-bold border-2 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed
                                            ${saveSuccess
                                                ? 'border-emerald-500 text-emerald-600 bg-emerald-50'
                                                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-600'
                                            }`}
                                    >
                                        {isSaving ? <Loader2 size={16} className="animate-spin" /> : saveSuccess ? <Check size={16} /> : <Save size={16} />}
                                        {saveSuccess ? 'Saved' : 'Save'}
                                    </button>

                                    {!isLinkMode && (
                                        <button
                                            onClick={handleSend}
                                            disabled={isSending || sendSuccess}
                                            className={`px-6 py-2 rounded-xl font-bold text-white shadow-lg transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed
                                                ${sendSuccess ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-indigo-600 hover:bg-indigo-700 hover:scale-105 active:scale-95 shadow-indigo-200 dark:shadow-none'}
                                            `}
                                        >
                                            {isSending ? <Loader2 size={16} className="animate-spin" /> : sendSuccess ? <Check size={16} /> : <Send size={16} />}
                                            {sendSuccess ? 'Sent!' : 'Send & Close'}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

        </div >
    );
}
