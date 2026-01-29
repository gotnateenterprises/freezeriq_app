"use client";

import { useRef, useEffect } from 'react';
import { Trash2 } from 'lucide-react';

interface LabelRichTextProps {
    label: string;
    value: string;
    onChange: (html: string) => void;
    placeholder?: string;
    minHeight?: string;
}

export default function LabelRichText({ label, value, onChange, placeholder = "", minHeight = "80px" }: LabelRichTextProps) {
    const editorRef = useRef<HTMLDivElement>(null);

    // Sync content if value changes externally (and not focused)
    useEffect(() => {
        if (editorRef.current && document.activeElement !== editorRef.current) {
            if (editorRef.current.innerHTML !== value) {
                editorRef.current.innerHTML = value;
            }
        }
    }, [value]);

    const execCmd = (cmd: string, val?: string) => {
        document.execCommand(cmd, false, val);
        if (editorRef.current) {
            onChange(editorRef.current.innerHTML);
        }
    };

    // Prevent focus loss when clicking toolbar buttons
    const handleToolbarAction = (e: React.MouseEvent, action: () => void) => {
        e.preventDefault(); // Keep focus in editor
        action();
    };

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-end">
                <label className="block text-xs font-bold text-slate-500 uppercase">{label}</label>
            </div>

            <div className="bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700">
                {/* Toolbar */}
                <div className="flex items-center gap-2 mb-2 border-b border-slate-200 dark:border-slate-700 pb-2">
                    <div className="flex border-r border-slate-300 dark:border-slate-600 pr-2 gap-1">
                        <button
                            onMouseDown={(e) => handleToolbarAction(e, () => execCmd('bold'))}
                            className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold font-serif"
                            title="Bold"
                        >
                            B
                        </button>
                        <button
                            onMouseDown={(e) => handleToolbarAction(e, () => execCmd('italic'))}
                            className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 italic font-serif"
                            title="Italic"
                        >
                            I
                        </button>
                        <button
                            onMouseDown={(e) => handleToolbarAction(e, () => execCmd('underline'))}
                            className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 underline font-serif"
                            title="Underline"
                        >
                            U
                        </button>
                    </div>
                    <div className="flex items-center gap-2 pl-2">
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Size</span>
                        <div className="flex bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-600 overflow-hidden">
                            {[1, 2, 3, 4, 5, 6, 7].map((size) => (
                                <button
                                    key={size}
                                    onMouseDown={(e) => handleToolbarAction(e, () => execCmd('fontSize', size.toString()))}
                                    className="px-2 py-1 text-[10px] font-bold border-r border-slate-200 dark:border-slate-700 last:border-0 hover:bg-slate-50 text-slate-500"
                                    title={`Size ${size}`}
                                >
                                    {size}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Clear Format */}
                    <button
                        onMouseDown={(e) => handleToolbarAction(e, () => execCmd('removeFormat'))}
                        className="ml-auto p-1 text-slate-400 hover:text-rose-500 text-xs font-bold"
                        title="Clear Formatting"
                    >
                        CLEAR
                    </button>
                </div>

                <div
                    ref={editorRef}
                    contentEditable
                    onInput={(e) => onChange(e.currentTarget.innerHTML)}
                    className={`w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-sm overflow-y-auto`}
                    style={{ minHeight }}
                    data-placeholder={placeholder}
                />
            </div>
        </div>
    );
}
