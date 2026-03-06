import React from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import NutritionFactsLabel from './NutritionFactsLabel';

interface LabelContent {
    name: string;
    ingredients: string;
    allergens: string;
    expiry: string;
    mealSize: string;
    instructions: string;
    macros: string; // Can be simple string or JSON
}

interface LabelConfig {
    showIngredients: boolean;
    showAllergens: boolean;
    showDates: boolean;
    showNotes: boolean;
    showQRCode: boolean;
}

interface LabelTemplateProps {
    content: LabelContent;
    config: LabelConfig;
    logoUrl?: string | null;
    uploadedImage?: string | null;
    qrCodeUrl?: string | null;
    colorMode?: 'color' | 'bw';
    onClearUpload?: () => void;
    labelSize?: '2x6' | '4x6';
}

export default function LabelTemplate({
    content,
    config,
    logoUrl,
    uploadedImage,
    qrCodeUrl,
    colorMode = 'bw',
    onClearUpload,
    labelSize = '2x6'
}: LabelTemplateProps) {
    // Parse full nutrition if available
    let fullNutrition = null;
    let simpleMacros = content.macros;
    if (content.macros && content.macros.startsWith('{')) {
        try {
            const parsed = JSON.parse(content.macros);
            fullNutrition = parsed.fullData;
            simpleMacros = parsed.summary;
        } catch (e) {
            // Not JSON
        }
    }

    const isLarge = labelSize === '4x6';

    return (
        <div
            className={`label-print-container w-full mx-auto bg-white rounded-md shadow-sm border border-slate-300 p-4 flex relative overflow-hidden ${isLarge ? 'aspect-[2/3] max-w-[480px] gap-6' : 'aspect-[1/3] max-w-[240px] flex-col'}`}
            style={{
                filter: colorMode === 'bw' ? 'grayscale(100%)' : 'none',
                printColorAdjust: 'exact',
                WebkitPrintColorAdjust: 'exact',
                pageBreakInside: 'avoid',
                breakInside: 'avoid'
            }}
        >
            {/* Left Column (Shared for 2x6, Content column for 4x6) */}
            <div className={`flex flex-col flex-1 h-full ${isLarge ? 'max-w-[55%]' : ''}`}>

                {/* Custom Uploaded Design Overlay */}
                {uploadedImage ? (
                    <div className="absolute inset-0 z-50 bg-white">
                        <img src={uploadedImage} alt="Custom Label Design" className="w-full h-full object-contain" />
                        {onClearUpload && (
                            <button
                                onClick={onClearUpload}
                                className="print:hidden absolute top-2 right-2 bg-white/90 text-rose-500 p-1.5 rounded-full shadow-sm hover:bg-rose-50 transition-colors"
                                title="Clear Design"
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                ) : (
                    /* Standard Header */
                    <div className="flex flex-col items-center border-b-2 border-slate-900 pb-3 mb-3 text-center">
                        {logoUrl ? (
                            <div className="w-12 h-12 mb-2 rounded-xl overflow-hidden border border-slate-200">
                                <img src={logoUrl} alt="Logo" className="w-full h-full object-cover" />
                            </div>
                        ) : (
                            <div className="w-12 h-12 bg-slate-900 rounded-xl flex items-center justify-center text-white font-black text-[10px] mb-2">
                                LOGO
                            </div>
                        )}
                        <h2 className="text-xl font-black text-slate-900 uppercase leading-tight text-center break-words w-full">{content.name}</h2>
                        <p className="text-[10px] font-bold text-slate-500 mt-1 uppercase tracking-wider">{new Date().toLocaleDateString()}</p>
                    </div>
                )}

                <div className="flex-1 space-y-4 overflow-hidden">
                    {/* Ingredients */}
                    {config.showIngredients && (
                        <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Ingredients</p>
                            <div
                                className="text-[10px] font-bold text-slate-800 leading-tight"
                                dangerouslySetInnerHTML={{ __html: content.ingredients }}
                            />
                        </div>
                    )}

                    {/* Allergens - Only show if content exists */}
                    {config.showAllergens && content.allergens && (
                        <div className="bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-2">
                            <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                            <div>
                                <p className="text-[10px] font-black text-amber-800 uppercase tracking-wider mb-0.5">Allergens</p>
                                <p className="text-[10px] font-bold text-amber-900 leading-tight">{content.allergens}</p>
                            </div>
                        </div>
                    )}

                    {/* Cooking Instructions */}
                    {content.instructions && (
                        <div className="pt-2">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Cooking Instructions</p>
                            <div
                                className="text-sm text-slate-900 leading-snug whitespace-pre-wrap"
                                dangerouslySetInnerHTML={{ __html: content.instructions }}
                            />
                        </div>
                    )}

                    {/* Simple Macros - Only if NOT showing large nutrition facts or if specifically enabled */}
                    {!isLarge && simpleMacros && (
                        <div className="pt-2 border-t border-slate-200 mt-2">
                            <div
                                className="text-[8px] font-mono text-slate-500 leading-tight whitespace-pre-wrap"
                                dangerouslySetInnerHTML={{ __html: simpleMacros }}
                            />
                        </div>
                    )}
                </div>

                {/* Footer - Only for 2x6 or separate flow */}
                {!isLarge && config.showDates && (
                    <div className="mt-auto border-t-2 border-slate-900 border-dashed pt-4 mb-4">
                        <div className="flex justify-between items-end mb-2">
                            <p className="text-[10px] font-black text-slate-400 uppercase">Best By</p>
                            <p className="text-sm font-black text-slate-900">{content.expiry}</p>
                        </div>
                        <div className="flex justify-between items-end">
                            <p className="text-[10px] font-black text-slate-400 uppercase">Size</p>
                            <p className="text-sm font-black text-slate-900">{content.mealSize}</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Right Column (For 4x6 labels - Nutrition Facts) */}
            {isLarge && (
                <div className="flex flex-col w-[45%] h-full">
                    {fullNutrition ? (
                        <NutritionFactsLabel data={fullNutrition} className="border-none p-0 scale-[0.9] origin-top-left" />
                    ) : (
                        <div className="flex-1 border-2 border-dashed border-slate-200 rounded-lg flex items-center justify-center text-[10px] text-slate-400 text-center p-4">
                            Nutrition Facts panel will appear here
                        </div>
                    )}

                    {config.showQRCode && (
                        <div className="flex justify-center mt-auto mb-4">
                            {qrCodeUrl ? (
                                <img src={qrCodeUrl} alt="QR" className="w-16 h-16 object-contain" />
                            ) : (
                                <div className="w-16 h-16 bg-slate-100 rounded border border-slate-200" />
                            )}
                        </div>
                    )}

                    {config.showDates && (
                        <div className="border-t-2 border-slate-900 border-dashed pt-4 pb-4">
                            <div className="flex justify-between items-end mb-1">
                                <p className="text-[8px] font-black text-slate-400 uppercase">Best By</p>
                                <p className="text-xs font-black text-slate-900">{content.expiry}</p>
                            </div>
                            <div className="flex justify-between items-end">
                                <p className="text-[8px] font-black text-slate-400 uppercase">Size</p>
                                <p className="text-xs font-black text-slate-900">{content.mealSize}</p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Floating QR for 2x6 only */}
            {!isLarge && config.showQRCode && (
                <div className="flex justify-center mb-2">
                    {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-12 h-12 object-contain" />}
                </div>
            )}
        </div>
    );
}
