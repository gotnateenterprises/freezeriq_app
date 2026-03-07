"use client";

import React, { useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { Eraser, Check } from 'lucide-react';

interface SignaturePadProps {
    onSave: (signatureDataUrl: string) => void;
    onCancel: () => void;
}

export default function SignaturePad({ onSave, onCancel }: SignaturePadProps) {
    const sigCanvas = useRef<any>(null);
    const [isEmpty, setIsEmpty] = useState(true);

    const clear = () => {
        sigCanvas.current?.clear();
        setIsEmpty(true);
    };

    const save = () => {
        if (sigCanvas.current?.isEmpty()) {
            alert('Please provide a signature first.');
            return;
        }
        const dataUrl = sigCanvas.current?.getTrimmedCanvas().toDataURL('image/png');
        if (dataUrl) {
            onSave(dataUrl);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="border-2 border-slate-300 dark:border-slate-600 rounded-lg bg-white overflow-hidden shadow-inner touch-none">
                <SignatureCanvas
                    ref={sigCanvas}
                    penColor="black"
                    canvasProps={{ className: 'w-full h-48 sm:h-64' }}
                    onEnd={() => setIsEmpty(false)}
                />
            </div>

            <div className="flex justify-between items-center text-sm sm:text-base">
                <button
                    onClick={clear}
                    className="text-slate-500 hover:text-slate-700 font-medium flex items-center gap-1 px-3 py-2"
                >
                    <Eraser size={18} /> Clear
                </button>

                <div className="flex gap-2 sm:gap-3">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={save}
                        disabled={isEmpty}
                        className={`px-5 py-2 rounded-lg font-bold flex items-center gap-2 ${isEmpty
                                ? 'bg-indigo-300 text-white cursor-not-allowed'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700'
                            }`}
                    >
                        <Check size={18} /> Accept Signature
                    </button>
                </div>
            </div>
        </div>
    );
}
