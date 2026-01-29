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
}

// --- PRINT COMPONENT ---
function PrintedLabel({ template, scale = 1 }: { template: LabelTemplate, scale?: number }) {
    const UNITS_PER_INCH = 100; // Must match Label Editor's ZOOM constant
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

function Avery5821Page({ labels }: { labels: LabelTemplate[] }) {
    // Avery 5821: 8.5 x 11 sheet. 2 columns, 4 rows.
    // Label: 4.0 x 2.5
    // Top Margin: 0.5", Side Margin: 0.25"
    return (
        <div className="avery-page bg-white shadow-xl mb-12 print:mb-0 print:shadow-none relative" style={{
            width: '8.5in',
            height: '11in',
            pageBreakAfter: 'always',
            margin: '0 auto',
            overflow: 'hidden',
            boxSizing: 'border-box'
        }}>
            {/* The Grid / Slots */}
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
                            style={{
                                width: '4in',
                                height: '2.5in',
                                boxSizing: 'border-box',
                                border: '1px solid rgba(0,0,0,0.05)',
                                position: 'relative',
                                overflow: 'hidden'
                            }}
                            className="print:border-none"
                        >
                            {label && (
                                <div style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: `${label.width}in`,
                                    height: `${label.height}in`,
                                    transformOrigin: '0 0',
                                    transform: (() => {
                                        // Decide if we need to rotate portrait -> landscape
                                        const shouldRotate = label.height > label.width;
                                        const actualW = shouldRotate ? label.height : label.width;
                                        const actualH = shouldRotate ? label.width : label.height;

                                        // Calculate best fit scale
                                        const scaleX = 4 / actualW;
                                        const scaleY = 2.5 / actualH;
                                        const scale = Math.min(scaleX, scaleY);

                                        // Rotation math: Rotate 90deg CW, then move right by Height to bring back to (+X) quadrant
                                        const rotationStr = shouldRotate ? `translateX(${label.height}in) rotate(90deg)` : '';
                                        return `scale(${scale}) ${rotationStr}`;
                                    })()
                                }}>
                                    <PrintedLabel template={label} />
                                </div>
                            )}
                            {!label && (
                                <div className="absolute inset-0 flex items-center justify-center text-[8px] text-slate-300 font-bold uppercase tracking-tighter print:hidden">
                                    Empty Slot {i + 1}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// --- MAIN PAGE ---
export default function BatchPrintPage() {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(true);
    const [jobs, setJobs] = useState<{ template: LabelTemplate, count: number, typeName: string }[]>([]);
    const [errors, setErrors] = useState<string[]>([]);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            // 1. Fetch Stats & Inventory
            const [statsRes, invRes, labelsRes] = await Promise.all([
                fetch('/api/delivery/stats'),
                fetch('/api/delivery/inventory'),
                fetch('/api/delivery/labels')
            ]);

            const stats: Stats = await statsRes.json();
            const items: PackagingItem[] = await invRes.json();
            const templates: LabelTemplate[] = await labelsRes.json();

            // 2. Identify Box Items
            const largeBox = items.find(i => i.type === 'large_box' || i.name.toLowerCase().includes('large'));
            const smallBox = items.find(i => i.type === 'small_box' || i.name.toLowerCase().includes('small'));

            const newJobs = [];
            const newErrors = [];

            // 3. Match Large Boxes
            if (stats.largeBoxesNeeded > 0) {
                if (largeBox?.defaultLabelId) {
                    const tpl = templates.find(t => t.id === largeBox.defaultLabelId);
                    if (tpl) {
                        newJobs.push({ template: tpl, count: stats.largeBoxesNeeded, typeName: 'Large Box' });
                    } else {
                        newErrors.push("Large Box label template not found.");
                    }
                } else {
                    newErrors.push("No label assigned to Large Box.");
                }
            }

            // 4. Match Small Boxes
            if (stats.smallBoxesNeeded > 0) {
                if (smallBox?.defaultLabelId) {
                    const tpl = templates.find(t => t.id === smallBox.defaultLabelId);
                    if (tpl) {
                        newJobs.push({ template: tpl, count: stats.smallBoxesNeeded, typeName: 'Small Box' });
                    } else {
                        newErrors.push("Small Box label template not found.");
                    }
                } else {
                    newErrors.push("No label assigned to Small Box.");
                }
            }

            setJobs(newJobs);
            setErrors(newErrors);

            console.log("Load complete. Jobs:", newJobs.length, "Errors:", newErrors.length);

        } catch (e) {
            console.error(e);
            setErrors(["Failed to load print data."]);
        } finally {
            setIsLoading(false);
        }
    };

    const handlePrint = () => {
        window.print();
    };

    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading print job...</div>;

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
                        <button
                            onClick={handlePrint}
                            disabled={jobs.length === 0}
                            className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <Printer size={20} /> Print {jobs.reduce((a, b) => a + b.count, 0)} Labels
                        </button>
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
                            <p className="text-sm mt-2 text-amber-700">Go back to the Dashboard and assign labels to your box counters.</p>
                        </div>
                    </div>
                )}

                {jobs.length === 0 && errors.length === 0 && (
                    <div className="text-center py-12 bg-white rounded-2xl border border-slate-200">
                        <p className="text-slate-500 font-bold">No labels needed right now!</p>
                    </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {jobs.map((job, i) => (
                        <div key={i} className="bg-white p-4 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-700 mb-2 border-b border-slate-100 pb-2 flex justify-between">
                                <span>{job.typeName}</span>
                                <span className="bg-slate-100 px-2 rounded text-xs py-0.5">{job.count} copies</span>
                            </h4>
                            <div className="scale-[0.4] origin-top-left" style={{ width: `${job.template.width}in`, height: `${job.template.height}in` }}>
                                <PrintedLabel template={job.template} />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* PRINT & PREVIEW UI (Combined for WYSIWYG) */}
            <div className="py-8 bg-slate-200 dark:bg-slate-800 print:bg-white min-h-screen">
                <style dangerouslySetInnerHTML={{
                    __html: `
                    @media print {
                        @page { 
                            margin: 0 !important; 
                            size: 8.5in 11in !important; 
                        }
                        body { 
                            background: white !important; 
                            margin: 0 !important; 
                            padding: 0 !important; 
                        }
                        .print-hidden { 
                            display: none !important; 
                        }
                        .avery-page {
                            margin: 0 !important;
                            box-shadow: none !important;
                            border: none !important;
                        }
                        .bg-slate-200 { background: white !important; }
                        /* Ensure text is black for printing */
                        * { -webkit-print-color-adjust: exact; }
                    }
                `}} />

                {/* Chunk labels into pages of 8 */}
                {(() => {
                    const allLabels: LabelTemplate[] = [];
                    jobs.forEach(job => {
                        for (let k = 0; k < job.count; k++) {
                            allLabels.push(job.template);
                        }
                    });

                    // DEBUG: Log if we are rendering labels
                    console.log(`Rendering ${allLabels.length} total labels across ${Math.ceil(allLabels.length / 8)} pages`);

                    const pages = [];
                    for (let i = 0; i < allLabels.length; i += 8) {
                        pages.push(allLabels.slice(i, i + 8));
                    }

                    if (pages.length === 0 && !isLoading) {
                        return (
                            <div className="text-center py-24 print-hidden">
                                <AlertTriangle size={48} className="mx-auto text-slate-300 mb-4" />
                                <p className="text-slate-500 font-bold text-xl">No labels in the print queue.</p>
                                <p className="text-slate-400 mt-2">Check your orders and ensure labels are assigned to boxes.</p>
                            </div>
                        );
                    }

                    return pages.map((pageLabels, i) => (
                        <Avery5821Page key={i} labels={pageLabels} />
                    ));
                })()}
            </div>
        </div>
    );
}
