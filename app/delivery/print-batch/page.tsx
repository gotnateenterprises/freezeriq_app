"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { Printer, AlertTriangle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

// --- TYPES ---
interface PackagingItem {
    id: string;
    name: string;
    quantity: number;
    type: string;
    defaultLabelId?: string;
}

interface LabelTemplate {
    id: string;
    name: string;
    width: number;
    height: number;
    elements: any[];
}

interface Stats {
    largeBoxesNeeded: number;
    smallBoxesNeeded: number;
    packaging?: {
        largeTrays: number;
        largeLids: number;
        smallTrays: number;
        smallLids: number;
        gallonBags: number;
        quartBags: number;
    };
}

// --- PRINT COMPONENT ---
function PrintedLabel({ template, scale = 1 }: { template: LabelTemplate | null, scale?: number }) {
    if (!template) return null; // Logic handles null slots elsewhere, but safety first
    const UNITS_PER_INCH = 96;
    return (
        <div
            style={{
                width: `${template.width}in`,
                height: `${template.height}in`,
                position: 'relative',
                overflow: 'hidden',
                backgroundColor: 'white',
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
            }}
            className="print-label"
        >
            {template.elements.map((el: any) => (
                <div
                    key={el.id}
                    style={{
                        position: 'absolute',
                        left: `${el.x / UNITS_PER_INCH}in`,
                        top: `${el.y / UNITS_PER_INCH}in`,
                        width: `${el.width / UNITS_PER_INCH}in`,
                        height: `${el.height / UNITS_PER_INCH}in`,
                        ...el.style,
                        fontSize: `${el.style?.fontSize || 12}px`,
                        transform: el.style?.rotation ? `rotate(${el.style.rotation}deg)` : undefined
                    }}
                >
                    {el.type === 'text' && (
                        <div className="w-full h-full whitespace-pre-wrap overflow-hidden leading-tight">
                            {el.content}
                        </div>
                    )}
                    {el.type === 'qr' && (
                        <QRCodeSVG value={el.content || 'https://freezeriq.com'} width="100%" height="100%" />
                    )}
                    {el.type === 'image' && (
                        <img src={el.content} alt="" className="w-full h-full object-contain" />
                    )}
                    {el.type === 'box' && <div className="w-full h-full border-2 border-black"></div>}
                </div>
            ))}
        </div>
    );
}

function Avery5821Page({ labels, onSlotClick }: { labels: (LabelTemplate | null)[], onSlotClick: (index: number) => void }) {
    // Avery 5821: 8.5 x 11 sheet. 2 columns, 4 rows.
    return (
        <div className="avery-page bg-white shadow-xl mb-12 print:mb-0 print:shadow-none relative" style={{
            width: '8.5in',
            height: '11in',
            pageBreakAfter: 'always',
            margin: '0 auto',
            overflow: 'hidden',
            boxSizing: 'border-box'
        }}>
            <div style={{
                position: 'absolute',
                top: '0.5in',
                left: '0.25in',
                width: '8in',
                height: '10in',
                display: 'grid',
                gridTemplateColumns: '4in 4in',
                gridTemplateRows: '2.5in 2.5in 2.5in 2.5in',
            }}>
                {Array.from({ length: 8 }).map((_, i) => {
                    const label = labels[i];
                    return (
                        <div key={i}
                            style={{ width: '4in', height: '2.5in', boxSizing: 'border-box', border: '1px solid rgba(0,0,0,0.05)', position: 'relative', overflow: 'hidden' }}
                            className="print:border-none group cursor-pointer hover:bg-rose-50/20 transition-colors"
                            onClick={() => onSlotClick(i)}
                            title={label ? "Click to Remove Label" : "Click to Add Filler Label"}
                        >
                            {label ? (
                                <div className="relative w-full h-full">
                                    <div style={{
                                        position: 'absolute', top: 0, left: 0, width: `${label.width}in`, height: `${label.height}in`, transformOrigin: '0 0',
                                        transform: (() => {
                                            const shouldRotate = label.height > label.width;
                                            const actualW = shouldRotate ? label.height : label.width;
                                            const actualH = shouldRotate ? label.width : label.height;
                                            const scaleX = 4 / actualW;
                                            const scaleY = 2.5 / actualH;
                                            const scale = Math.min(scaleX, scaleY);
                                            const rotationStr = shouldRotate ? `translateX(${label.height}in) rotate(90deg)` : '';
                                            return `scale(${scale}) ${rotationStr}`;
                                        })()
                                    }}>
                                        <PrintedLabel template={label} />
                                    </div>
                                    {/* Hover Remove Overlay (Print Hidden) */}
                                    <div className="absolute inset-0 bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-opacity print:hidden flex items-center justify-center">
                                        <div className="bg-white text-rose-600 px-2 py-1 rounded shadow-sm text-xs font-bold border border-rose-100">Click to Remove</div>
                                    </div>
                                </div>
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-300 font-bold uppercase tracking-tighter print:hidden hover:bg-slate-50 transition-colors">
                                    <span className="opacity-0 group-hover:opacity-100 text-indigo-500 font-bold">+ Add Filler</span>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="print:hidden text-center text-xs text-brand-secondary mt-2">Page Break (Avery 5821)</div>
        </div>
    );
}

// --- MAIN PAGE ---
export default function BatchPrintPage() {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(true);
    const [jobs, setJobs] = useState<{ template: LabelTemplate, count: number, typeName: string }[]>([]);
    const [allSlots, setAllSlots] = useState<(LabelTemplate | null)[]>([]); // Flattened view for pagination
    const [errors, setErrors] = useState<string[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);

    // Filler Modal
    const [showFillerModal, setShowFillerModal] = useState(false);
    const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);
    const [templates, setTemplates] = useState<LabelTemplate[]>([]);

    // Custom Adder State
    const [customLabelId, setCustomLabelId] = useState('');
    const [customQty, setCustomQty] = useState(1);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const [statsRes, invRes, labelsRes] = await Promise.all([
                fetch('/api/delivery/stats'),
                fetch('/api/delivery/inventory'),
                fetch('/api/delivery/labels')
            ]);
            const s: Stats = await statsRes.json();
            const items: PackagingItem[] = await invRes.json();
            const tpls: LabelTemplate[] = await labelsRes.json();

            setStats(s);
            setTemplates(tpls);

            const largeBox = items.find(i => i.type === 'large_box' || i.name.toLowerCase().includes('large'));
            const smallBox = items.find(i => i.type === 'small_box' || i.name.toLowerCase().includes('small'));

            const newJobs = [];
            const newErrors = [];
            const newSlots: (LabelTemplate | null)[] = [];

            if (s.largeBoxesNeeded > 0) {
                if (largeBox?.defaultLabelId) {
                    const tpl = tpls.find(t => t.id === largeBox.defaultLabelId);
                    if (tpl) {
                        newJobs.push({ template: tpl, count: s.largeBoxesNeeded, typeName: 'Large Box' });
                        for (let k = 0; k < s.largeBoxesNeeded; k++) newSlots.push(tpl);
                    } else newErrors.push("Large Box label template not found.");
                } else newErrors.push("No label assigned to Large Box.");
            }

            if (s.smallBoxesNeeded > 0) {
                if (smallBox?.defaultLabelId) {
                    const tpl = tpls.find(t => t.id === smallBox.defaultLabelId);
                    if (tpl) {
                        newJobs.push({ template: tpl, count: s.smallBoxesNeeded, typeName: 'Small Box' });
                        for (let k = 0; k < s.smallBoxesNeeded; k++) newSlots.push(tpl);
                    } else newErrors.push("Small Box label template not found.");
                } else newErrors.push("No label assigned to Small Box.");
            }

            // Fill remaining page slots with nulls to complete the page visually for user interaction
            const totalLabels = newSlots.length;
            const remainder = totalLabels % 8;
            if (remainder > 0) {
                for (let k = 0; k < (8 - remainder); k++) newSlots.push(null);
            }

            setJobs(newJobs);
            setAllSlots(newSlots);
            setErrors(newErrors);
        } catch (e) {
            console.error(e);
            setErrors(["Failed to load print data."]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSlotClick = (pageIndex: number, slotInPage: number) => {
        const absoluteIndex = (pageIndex * 8) + slotInPage;

        // If slot is occupied, remove it
        if (allSlots[absoluteIndex]) {
            const newSlots = [...allSlots];
            newSlots[absoluteIndex] = null;
            setAllSlots(newSlots);
            return;
        }

        // If slot is empty, open filler modal
        setSelectedSlotIndex(absoluteIndex);
        setShowFillerModal(true);
    };

    const applyFiller = (template: LabelTemplate) => {
        if (selectedSlotIndex === null) return;
        const newSlots = [...allSlots];
        newSlots[selectedSlotIndex] = template;
        setAllSlots(newSlots);
        setShowFillerModal(false);
    };

    const handleAddCustom = () => {
        if (!customLabelId || customQty < 1) return;
        const tpl = templates.find(t => t.id === customLabelId);
        if (!tpl) return;

        let newSlots = [...allSlots];
        let addedCount = 0;

        // Try to fill empty slots first
        for (let i = 0; i < newSlots.length && addedCount < customQty; i++) {
            if (newSlots[i] === null) {
                newSlots[i] = tpl;
                addedCount++;
            }
        }

        // Add remaining to the end
        while (addedCount < customQty) {
            newSlots.push(tpl);
            addedCount++;
        }

        // Re-pad to multiple of 8
        const remainder = newSlots.length % 8;
        if (remainder > 0) {
            for (let k = 0; k < (8 - remainder); k++) newSlots.push(null);
        }

        setAllSlots(newSlots);

        const existingJob = jobs.find(j => j.template.id === tpl.id);
        if (existingJob) {
            setJobs(jobs.map(j => j.template.id === tpl.id ? { ...j, count: j.count + customQty } : j));
        } else {
            setJobs([...jobs, { template: tpl, count: customQty, typeName: tpl.name }]);
        }

        setCustomQty(1);
    };

    const handlePrint = async () => {
        window.print();

        // After print dialog closes (browser blocking behavior dependent, but we show confirm dialogue anyway)
        // Wait a small delay to ensure print dialog is fully dismissed if non-blocking
        setTimeout(async () => {
            const pack = stats?.packaging;
            const deductionMsg = pack ?
                `This will deduct:\n` +
                `- Sheets & Tape\n` +
                (pack.largeTrays ? `- ${pack.largeTrays} Large Trays & Lids\n` : '') +
                (pack.smallTrays ? `- ${pack.smallTrays} Small Containers & Lids\n` : '') +
                (pack.gallonBags ? `- ${pack.gallonBags} Gallon Bags\n` : '') +
                (pack.quartBags ? `- ${pack.quartBags} Quart Bags\n` : '')
                : 'Click OK to deduct Inventory (Sheets & Tape).';

            if (confirm(`Did the labels print successfully?\n\n${deductionMsg}\nClick Cancel if printing failed.`)) {
                try {
                    // Calculate totals
                    // Tape: derived from stats (boxes)
                    // Sheets: derived from allSlots length (printed pages)
                    const large = stats?.largeBoxesNeeded || 0;
                    const small = stats?.smallBoxesNeeded || 0;
                    const pages = Math.ceil(allSlots.length / 8);

                    const res = await fetch('/api/delivery/record-print-job', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            largeBoxes: large,
                            smallBoxes: small,
                            sheetsUsed: pages,
                            packaging: pack // Pass the calculated packaging stats
                        })
                    });

                    if (res.ok) {
                        const data = await res.json();
                        alert(`Inventory Updated!\nDeducted:\n` +
                            JSON.stringify(data.deducted.details || {}, null, 2).replace(/[\{\}"]/g, ''));
                        router.push('/delivery');
                    } else {
                        alert('Failed to update inventory.');
                    }
                } catch (e) {
                    alert('Network error updating inventory.');
                }
            }
        }, 500);
    };

    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading print job...</div>;

    // Pagination of slots
    const pages = [];
    for (let i = 0; i < allSlots.length; i += 8) {
        pages.push(allSlots.slice(i, i + 8));
    }

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 print:bg-white">
            {/* NO-PRINT UI: Header & Controls */}
            <div className="print:hidden max-w-4xl mx-auto p-6">
                <div className="flex justify-between items-end mb-6 print-hidden">
                    <div>
                        <Link href="/delivery" className="text-slate-400 hover:text-slate-600 text-sm font-bold flex items-center gap-1 mb-2">
                            <ArrowLeft size={16} /> Dashboard
                        </Link>
                        <h1 className="text-3xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                            <Printer className="text-indigo-600" />
                            Print Queue
                        </h1>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                        <span className="text-[10px] uppercase font-bold text-slate-400">Avery 5821 (8.5" x 11")</span>
                        <div className="flex gap-2">
                            <button
                                onClick={handlePrint}
                                disabled={allSlots.every(s => s === null)}
                                className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Printer size={20} /> Print & Update Inventory
                            </button>
                        </div>
                    </div>
                </div>

                {errors.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-xl mb-6 flex items-start gap-3">
                        <AlertTriangle className="shrink-0 mt-0.5" />
                        <div>
                            <h4 className="font-bold">Missing configurations:</h4>
                            <ul className="list-disc pl-5 space-y-1 text-sm mt-1">
                                {errors.map((e, i) => <li key={i}>{e}</li>)}
                            </ul>
                        </div>
                    </div>
                )}

                <p className="text-sm text-slate-500 mb-4 bg-blue-50 text-blue-800 p-3 rounded-lg border border-blue-100 flex items-center gap-2">
                    ℹ Tip: Click empty slots to Add Filler. Click occupied slots to Remove.
                </p>

                {/* Custom Label Adder UI */}
                <div className="bg-white p-4 rounded-xl border border-slate-200 mb-8 flex flex-col sm:flex-row items-end gap-4 shadow-sm">
                    <div className="flex-1 w-full">
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Add Specific Labels</label>
                        <select
                            value={customLabelId}
                            onChange={e => setCustomLabelId(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white font-medium"
                        >
                            <option value="">-- Select a Label Template --</option>
                            {templates.map(t => (
                                <option key={t.id} value={t.id}>{t.name} ({t.width}"x{t.height}")</option>
                            ))}
                        </select>
                    </div>
                    <div className="w-32">
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Quantity</label>
                        <input
                            type="number"
                            min="1"
                            value={customQty}
                            onChange={e => setCustomQty(parseInt(e.target.value) || 1)}
                            className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white font-medium"
                        />
                    </div>
                    <button
                        onClick={handleAddCustom}
                        disabled={!customLabelId || customQty < 1}
                        className="bg-slate-800 text-white px-6 py-2 rounded-lg font-bold hover:bg-slate-900 transition-colors disabled:opacity-50 h-[42px] whitespace-nowrap"
                    >
                        Add to Queue
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {/* Job Summary */}
                    {jobs.map((job, i) => (
                        <div key={i} className="bg-white p-4 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-700 mb-2 border-b border-slate-100 pb-2 flex justify-between">
                                <span className="truncate pr-2">{job.typeName}</span>
                                <span className="bg-slate-100 px-2 rounded text-xs py-0.5 whitespace-nowrap">{job.count} copies</span>
                            </h4>
                            <div className="scale-[0.4] origin-top-left" style={{ width: `${job.template.width}in`, height: `${job.template.height}in` }}>
                                <PrintedLabel template={job.template} />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* PRINT & PREVIEW UI */}
            <div className="py-8 bg-slate-200 dark:bg-slate-800 print:bg-white min-h-screen">
                <style dangerouslySetInnerHTML={{
                    __html: `
                    @media print {
                        @page { margin: 0 !important; size: 8.5in 11in !important; }
                        body { background: white !important; margin: 0 !important; padding: 0 !important; }
                        .print-hidden { display: none !important; }
                        .avery-page { margin: 0 !important; box-shadow: none !important; border: none !important; }
                        .bg-slate-200 { background: white !important; }
                        * { -webkit-print-color-adjust: exact; }
                    }
                `}} />

                {pages.map((pageLabels, i) => (
                    <Avery5821Page key={i} labels={pageLabels} onSlotClick={(slotIndex) => handleSlotClick(i, slotIndex)} />
                ))}
            </div>

            {/* Filler Modal */}
            {showFillerModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 print:hidden">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 animate-in zoom-in-95 duration-200">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-xl font-bold">Select Filler Label</h3>
                            <button onClick={() => setShowFillerModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
                        </div>
                        <div className="grid grid-cols-2 gap-4 max-h-[60vh] overflow-y-auto">
                            {templates.map(t => (
                                <button
                                    key={t.id}
                                    onClick={() => applyFiller(t)}
                                    className="border border-slate-200 p-2 rounded-lg hover:border-indigo-500 hover:bg-slate-50 text-left transition-all"
                                >
                                    <div className="font-bold text-sm mb-1 truncate">{t.name}</div>
                                    <div className="aspect-[4/2.5] bg-white border border-slate-100 relative overflow-hidden">
                                        <div className="scale-[0.25] origin-top-left absolute top-0 left-0 w-full h-full">
                                            <PrintedLabel template={t} />
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
