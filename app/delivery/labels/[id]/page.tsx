"use client";

import { useState, useEffect, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, Type, QrCode, Image as ImageIcon, Trash, Printer, AlertTriangle, Plus, MonitorPlay, Layers } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

// --- TYPES ---
type ElementType = 'text' | 'qr' | 'image' | 'box';

interface LabelElement {
    id: string;
    type: ElementType;
    x: number;
    y: number;
    width: number;
    height: number;
    content: string; // Text: "Hello", QR: "https://...", Image: URL
    style: {
        fontSize?: number;
        fontWeight?: string;
        textAlign?: 'left' | 'center' | 'right';
        color?: string;
        backgroundColor?: string;
        borderColor?: string;
        borderWidth?: number;
        borderRadius?: number;
    };
}

interface LabelTemplate {
    id: string;
    name: string;
    width: number;
    height: number;
    elements: LabelElement[];
    isDefault: boolean;
}

// --- EDITOR COMPONENT ---
export default function LabelEditor({ params }: { params: Promise<{ id: string }> }) {
    const { id: labelId } = use(params);
    const router = useRouter();
    const [template, setTemplate] = useState<LabelTemplate | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    // Canvas State
    const DPI = 96; // Screen DPI approximation
    const ZOOM = 1.5; // Visual zoom for editor

    useEffect(() => {
        fetchTemplate();
    }, []);

    const fetchTemplate = async () => {
        try {
            console.log("Fetching template for ID:", labelId);
            const res = await fetch(`/api/delivery/labels/${labelId}`);
            console.log("API Response Status:", res.status);

            if (res.ok) {
                const data = await res.json();
                console.log("Template Data:", data);
                // Ensure elements is an array (handle legacy/empty)
                if (!Array.isArray(data.elements)) data.elements = [];
                setTemplate(data);
            } else {
                console.error("API returned non-OK status");
                // router.push('/delivery/labels'); // Comment out redirect for debugging
            }
        } catch (e) {
            console.error("Fetch error:", e);
        } finally {
            setIsLoading(false);
        }
    };

    const saveTemplate = async () => {
        if (!template) return;
        setIsSaving(true);
        try {
            await fetch(`/api/delivery/labels/${template.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: template.name,
                    width: template.width,
                    height: template.height,
                    elements: template.elements,
                    isDefault: template.isDefault
                })
            });
            alert("Label saved successfully!");
            router.push('/delivery/labels');
        } catch (e) {
            console.error("Failed to save", e);
            alert("Failed to save label.");
        } finally {
            setIsSaving(false);
        }
    };

    // --- ELEMENT MANAGERS ---
    const addElement = (type: ElementType) => {
        if (!template) return;
        const newEl: LabelElement = {
            id: crypto.randomUUID(),
            type,
            x: 0.5 * DPI,
            y: 0.5 * DPI,
            width: type === 'text' ? 3 * DPI : 1 * DPI,
            height: type === 'text' ? 0.5 * DPI : 1 * DPI,
            content: type === 'text' ? 'New Text' : (type === 'qr' ? 'https://freezeriq.com' : ''),
            style: type === 'text' ? { fontSize: 14, fontWeight: 'bold', textAlign: 'left', color: '#000000' } : {}
        };

        setTemplate({ ...template, elements: [...template.elements, newEl] });
        setSelectedId(newEl.id);
    };

    const updateElement = (id: string, updates: Partial<LabelElement> | { style: Partial<LabelElement['style']> }) => {
        if (!template) return;
        setTemplate({
            ...template,
            elements: template.elements.map(el => {
                if (el.id !== id) return el;
                // Handle nested style updates
                if ('style' in updates && updates.style) {
                    return { ...el, style: { ...el.style, ...updates.style } };
                }
                // Handle top-level updates
                return { ...el, ...updates } as LabelElement;
            })
        });
    };

    const removeElement = (id: string) => {
        if (!template) return;
        setTemplate({
            ...template,
            elements: template.elements.filter(el => el.id !== id)
        });
        setSelectedId(null);
    };

    // --- IMAGE UPLOAD ---
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !template) return;

        const formData = new FormData();
        formData.append('file', file);

        // Reset input
        e.target.value = '';

        try {
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            const data = await res.json();

            if (data.success) {
                const newEl: LabelElement = {
                    id: crypto.randomUUID(),
                    type: 'image',
                    x: 0.5 * DPI,
                    y: 0.5 * DPI,
                    width: 1.5 * DPI,
                    height: 1.5 * DPI,
                    content: data.url,
                    style: {}
                };
                setTemplate({ ...template, elements: [...template.elements, newEl] });
                setSelectedId(newEl.id);
            } else {
                alert('Upload failed: ' + data.error);
            }
        } catch (err) {
            console.error(err);
            alert('Upload error');
        }
    };

    // --- DRAG LOGIC (Simplified) ---
    // In a real app, use @dnd-kit. Here, using simple mouse events for brevity in the "one-shot" implementation.
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [resizeStart, setResizeStart] = useState({ w: 0, h: 0, x: 0, y: 0 });

    const handleMouseDown = (e: React.MouseEvent, id: string, x: number, y: number) => {
        e.stopPropagation();
        setSelectedId(id);
        setIsDragging(true);
        setDragOffset({ x: e.clientX - x * ZOOM, y: e.clientY - y * ZOOM }); // Store click offset relative to element pos
    };

    const handleResizeStart = (e: React.MouseEvent, id: string, w: number, h: number) => {
        e.stopPropagation();
        e.preventDefault(); // Prevent text selection
        setSelectedId(id);
        setIsResizing(true);
        setResizeStart({ w, h, x: e.clientX, y: e.clientY });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if ((!isDragging && !isResizing) || !selectedId || !containerRef.current || !template) return;

        if (isResizing) {
            const currentEl = template.elements.find(el => el.id === selectedId);
            if (!currentEl) return;

            // Delta in pixels
            const deltaX = e.clientX - resizeStart.x;
            const deltaY = e.clientY - resizeStart.y;

            // Convert pixels to "label units" (inches * DPI)
            // Delta / ZOOM = Change in label pixels
            const newWidth = resizeStart.w + (deltaX / ZOOM);
            const newHeight = resizeStart.h + (deltaY / ZOOM);

            updateElement(selectedId, {
                width: Math.max(0.25 * DPI, newWidth),
                height: Math.max(0.25 * DPI, newHeight)
            });
            return;
        }

        const containerRect = containerRef.current.getBoundingClientRect();
        const rawX = (e.clientX - containerRect.left) / ZOOM;
        const rawY = (e.clientY - containerRect.top) / ZOOM;

        updateElement(selectedId, { x: rawX - 10, y: rawY - 10 }); // -10 hack to center cursor roughly
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        setIsResizing(false);
    };

    const handleDoubleClick = (e: React.MouseEvent, id: string, type: ElementType) => {
        e.stopPropagation();
        if (type === 'text') {
            setEditingId(id);
            setSelectedId(id);
        }
    };

    const handleBlur = () => {
        setEditingId(null);
    };

    const selectedElement = template?.elements.find(el => el.id === selectedId);

    if (isLoading) return <div className="p-12 text-center">Loading Editor...</div>;
    if (!template) return <div className="p-12 text-center">Template not found.</div>;

    return (
        <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-900" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
            {/* Header */}
            <header className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 p-4 flex justify-between items-center shadow-sm z-10">
                <div className="flex items-center gap-4">
                    <button onClick={() => router.back()} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg">
                        <ArrowLeft size={20} className="text-slate-500" />
                    </button>
                    <div>
                        <input
                            value={template.name}
                            onChange={(e) => setTemplate({ ...template, name: e.target.value })}
                            className="font-black text-xl bg-transparent border-none focus:ring-0 p-0 text-slate-800 dark:text-white placeholder:text-slate-400"
                            placeholder="Label Name"
                        />
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span>{template.width}" x {template.height}"</span>
                            <span className="text-slate-300">|</span>
                            <label className="flex items-center gap-1 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={template.isDefault}
                                    onChange={(e) => setTemplate({ ...template, isDefault: e.target.checked })}
                                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                                Set as Default
                            </label>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => window.print()}
                        className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors flex items-center gap-2 font-bold text-sm"
                    >
                        <Printer size={18} /> Print Test
                    </button>
                    <button
                        onClick={saveTemplate}
                        disabled={isSaving}
                        className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-indigo-700 transition-colors shadow-lg flex items-center gap-2"
                    >
                        <Save size={18} /> {isSaving ? 'Saving...' : 'Save Label'}
                    </button>
                </div>
            </header>

            {/* Main Area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Visual Canvas Area */}
                <div className="flex-1 overflow-auto bg-slate-100/50 dark:bg-black/20 p-8 flex items-center justify-center relative">
                    {/* The "Paper" */}
                    <div
                        ref={containerRef}
                        className="bg-white shadow-2xl relative transition-all"
                        style={{
                            width: template.width * DPI * ZOOM,
                            height: template.height * DPI * ZOOM,
                        }}
                    >
                        {/* Grid Lines (Visual Aid) */}
                        <div className="absolute inset-0 pointer-events-none opacity-20"
                            style={{
                                backgroundImage: `linear-gradient(#ccc 1px, transparent 1px), linear-gradient(90deg, #ccc 1px, transparent 1px)`,
                                backgroundSize: `${DPI / 2 * ZOOM}px ${DPI / 2 * ZOOM}px`
                            }}
                        />

                        {/* Elements */}
                        {template.elements.map(el => (
                            <div
                                key={el.id}
                                onMouseDown={(e) => handleMouseDown(e, el.id, el.x, el.y)}
                                onDoubleClick={(e) => handleDoubleClick(e, el.id, el.type)}
                                className={`absolute cursor-move group select-none ${selectedId === el.id ? 'ring-2 ring-indigo-500 z-50' : 'hover:ring-1 hover:ring-indigo-300'}`}
                                style={{
                                    left: el.x * ZOOM,
                                    top: el.y * ZOOM,
                                    width: el.width * ZOOM,
                                    height: el.height * ZOOM,
                                    // Custom Styles
                                    ...el.style,
                                    // Scale font size visually
                                    fontSize: (el.style.fontSize || 12) * ZOOM,
                                }}
                            >
                                {/* Renderer */}
                                {el.type === 'text' && (
                                    editingId === el.id ? (
                                        <textarea
                                            autoFocus
                                            value={el.content}
                                            onChange={(e) => updateElement(el.id, { content: e.target.value })}
                                            onBlur={handleBlur}
                                            className="w-full h-full p-1 bg-white resize-none outline-none overflow-hidden leading-tight"
                                            style={{
                                                fontSize: (el.style.fontSize || 12) * ZOOM,
                                                textAlign: el.style.textAlign,
                                                fontWeight: el.style.fontWeight
                                            }}
                                            onMouseDown={(e) => e.stopPropagation()} // Allow clicking inside without dragging
                                        />
                                    ) : (
                                        <div className="w-full h-full p-1 whitespace-pre-wrap overflow-hidden leading-tight">
                                            {el.content}
                                        </div>
                                    )
                                )}
                                {el.type === 'qr' && (
                                    <div className="w-full h-full bg-white p-1">
                                        <QRCodeSVG value={el.content || 'https://freezeriq.com'} width="100%" height="100%" />
                                    </div>
                                )}
                                {el.type === 'image' && (
                                    <img src={el.content} alt="" className="w-full h-full object-contain pointer-events-none" />
                                )}
                                {el.type === 'box' && <div className="w-full h-full border-2 border-slate-900"></div>}

                                {/* Resize Handles */}
                                {selectedId === el.id && (
                                    <>
                                        <div
                                            onMouseDown={(e) => handleResizeStart(e, el.id, el.width, el.height)}
                                            className="absolute -bottom-1 -right-1 w-4 h-4 bg-indigo-500 rounded-full cursor-se-resize hover:scale-110 transition-transform shadow-sm"
                                        ></div>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Right Sidebar: Tools & Properties */}
                <aside className="w-80 bg-white dark:bg-slate-800 border-l border-slate-200 dark:border-slate-700 flex flex-col overflow-y-auto z-20">

                    {/* Toolbox */}
                    <div className="p-4 border-b border-slate-200 dark:border-slate-700">
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-3">Add Element</h3>
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={() => addElement('text')} className="flex flex-col items-center gap-2 p-3 bg-slate-50 dark:bg-slate-900 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700">
                                <Type size={20} className="text-slate-600 dark:text-slate-400" />
                                <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Text</span>
                            </button>
                            <button onClick={() => addElement('qr')} className="flex flex-col items-center gap-2 p-3 bg-slate-50 dark:bg-slate-900 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700">
                                <QrCode size={20} className="text-slate-600 dark:text-slate-400" />
                                <span className="text-xs font-bold text-slate-600 dark:text-slate-300">QR Code</span>
                            </button>
                            <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-2 p-3 bg-slate-50 dark:bg-slate-900 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700">
                                <ImageIcon size={20} className="text-slate-600 dark:text-slate-400" />
                                <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Image</span>
                            </button>
                            <input
                                type="file"
                                ref={fileInputRef}
                                className="hidden"
                                accept="image/png, image/jpeg, image/webp"
                                onChange={handleImageUpload}
                            />
                            {/* Future: Image & Shapes */}
                        </div>
                    </div>

                    {/* Properties Panel */}
                    <div className="flex-1 p-4">
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-3">Properties</h3>

                        {selectedElement ? (
                            <div className="space-y-4">
                                {/* Common: Position & Size */}
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-slate-400">Width (in)</label>
                                        <input
                                            type="number" step="0.1"
                                            value={(selectedElement.width / DPI).toFixed(2)}
                                            onChange={(e) => updateElement(selectedElement.id, { width: parseFloat(e.target.value) * DPI })}
                                            className="w-full bg-slate-50 border-slate-200 rounded text-sm p-1"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-slate-400">Height (in)</label>
                                        <input
                                            type="number" step="0.1"
                                            value={(selectedElement.height / DPI).toFixed(2)}
                                            onChange={(e) => updateElement(selectedElement.id, { height: parseFloat(e.target.value) * DPI })}
                                            className="w-full bg-slate-50 border-slate-200 rounded text-sm p-1"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-slate-400">X (in)</label>
                                        <input
                                            type="number" step="0.1"
                                            value={(selectedElement.x / DPI).toFixed(2)}
                                            onChange={(e) => updateElement(selectedElement.id, { x: parseFloat(e.target.value) * DPI })}
                                            className="w-full bg-slate-50 border-slate-200 rounded text-sm p-1"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-slate-400">Y (in)</label>
                                        <input
                                            type="number" step="0.1"
                                            value={(selectedElement.y / DPI).toFixed(2)}
                                            onChange={(e) => updateElement(selectedElement.id, { y: parseFloat(e.target.value) * DPI })}
                                            className="w-full bg-slate-50 border-slate-200 rounded text-sm p-1"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    <button onClick={() => updateElement(selectedElement.id, { width: 2.5 * DPI, height: 4.0 * DPI })} className="text-[10px] bg-slate-100 p-1 rounded hover:bg-slate-200 text-slate-500">Preset: 2.5\" x 4\"</button>
                                    <button onClick={() => updateElement(selectedElement.id, { width: 3.5 * DPI, height: 4.0 * DPI })} className="text-[10px] bg-slate-100 p-1 rounded hover:bg-slate-200 text-slate-500">Preset: 3.5\" x 4\"</button>
                                </div>

                                <hr className="border-slate-100" />

                                {/* Content Editor */}
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-slate-400">Content</label>
                                    <textarea
                                        rows={3}
                                        value={selectedElement.content}
                                        onChange={(e) => updateElement(selectedElement.id, { content: e.target.value })}
                                        className="w-full bg-slate-50 border-slate-200 rounded text-sm p-2"
                                        placeholder={selectedElement.type === 'qr' ? 'URL' : 'Enter text...'}
                                    />
                                    {selectedElement.type === 'qr' && (
                                        <p className="text-[10px] text-slate-400 mt-1">
                                            Tips: Use <code>{`{ORDER_ID}`}</code> or <code>{`{CUSTOMER}`}</code> for dynamic data.
                                        </p>
                                    )}
                                </div>

                                {/* Style Editor (Text Only) */}
                                {selectedElement.type === 'text' && (
                                    <>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-slate-400">Font Size</label>
                                                <input
                                                    type="number"
                                                    value={selectedElement.style?.fontSize || 12}
                                                    onChange={(e) => updateElement(selectedElement.id, { style: { fontSize: parseInt(e.target.value) } })}
                                                    className="w-full bg-slate-50 border-slate-200 rounded text-sm p-1"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-slate-400">Align</label>
                                                <select
                                                    value={selectedElement.style?.textAlign || 'left'}
                                                    onChange={(e) => updateElement(selectedElement.id, { style: { textAlign: e.target.value as any } })}
                                                    className="w-full bg-slate-50 border-slate-200 rounded text-sm p-1"
                                                >
                                                    <option value="left">Left</option>
                                                    <option value="center">Center</option>
                                                    <option value="right">Right</option>
                                                </select>
                                            </div>
                                        </div>
                                    </>
                                )}

                                <div className="pt-4">
                                    <button
                                        onClick={() => removeElement(selectedElement.id)}
                                        className="w-full bg-rose-50 text-rose-600 py-2 rounded-lg text-sm font-bold hover:bg-rose-100 flex items-center justify-center gap-2"
                                    >
                                        <Trash size={16} /> Delete Element
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="text-center py-12 text-slate-400">
                                <MonitorPlay size={32} className="mx-auto mb-2 opacity-50" />
                                <p className="text-sm">Select an element on the canvas to edit its properties.</p>
                            </div>
                        )}
                    </div>
                </aside>
            </div>

            {/* Print Styles (Hidden Logic) */}
            <style jsx global>{`
                @media print {
                    @page { 
                        size: ${template.width}in ${template.height}in;
                        margin: 0;
                    }
                    body * {
                        visibility: hidden;
                    }
                    .print-area, .print-area * {
                        visibility: visible;
                    }
                    .print-area {
                        position: absolute;
                        left: 0;
                        top: 0;
                        width: ${template.width}in;
                        height: ${template.height}in;
                        background: white;
                        overflow: hidden;
                    }
                }
            `}</style>

            {/* THE PRINTABLE DOM */}
            <div className="print-area hidden">
                {template.elements.map(el => (
                    <div
                        key={el.id}
                        style={{
                            position: 'absolute',
                            left: `${el.x / DPI}in`, // Convert px back to inches for print layout
                            top: `${el.y / DPI}in`,
                            width: `${el.width / DPI}in`,
                            height: `${el.height / DPI}in`,
                            // Styles
                            ...el.style,
                            // Font size in pt usually better for print, close enough
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
                            <img src={el.content} className="w-full h-full object-contain" />
                        )}
                        {el.type === 'box' && <div className="w-full h-full border-2 border-black"></div>}
                    </div>
                ))}
            </div>

        </div>
    );
}
