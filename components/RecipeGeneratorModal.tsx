
'use client';

import React, { useState } from 'react';
import { X, Sparkles, ChefHat, Flame, ThumbsUp } from 'lucide-react';

interface GeneratedRecipe {
    name: string;
    description: string;
    viral_score: number;
    ingredients: {
        name: string;
        approx_qty: number;
        unit: string;
        matched_ingredient_id?: string;
    }[];
    instructions: string[];
}

export default function RecipeGeneratorModal({ onClose, onSave }: { onClose: () => void, onSave: (recipe: any) => void }) {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<GeneratedRecipe | null>(null);
    const [vibe, setVibe] = useState("Trending");
    const [error, setError] = useState("");
    const [feedbackGiven, setFeedbackGiven] = useState(false);
    const [comment, setComment] = useState("");
    const [showComment, setShowComment] = useState(false);

    const handleFeedback = async (rating: number) => {
        if (!result) return;

        // If it's a thumbs down and we haven't shown comment box yet, show it
        if (rating === -1 && !showComment) {
            setShowComment(true);
            return;
        }

        try {
            await fetch('/api/ai/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipe: result, rating, feedback_text: comment })
            });
            setFeedbackGiven(true);
            setShowComment(false);
        } catch (e) {
            console.error("Failed to save feedback");
        }
    };

    const handleGenerate = async () => {
        setLoading(true);
        setError("");
        setResult(null);
        setFeedbackGiven(false);

        try {
            const res = await fetch('/api/ai/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vibe })
            });
            const data = await res.json();

            if (data.error) throw new Error(data.error);
            setResult(data.recipe);

        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const vibes = ["Dump & Go Crockpot 🧊", "Oven-Ready Bake 🥘", "Slow Cooker Hero 🍲", "Keto-Freezer 🥩", "Family Bulk Prep 👨‍👩‍👧"];

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">

                {/* Header */}
                <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-t-xl">
                    <div className="flex items-center gap-2">
                        <Sparkles className="w-6 h-6 animate-pulse" />
                        <h2 className="text-xl font-bold">Viral Recipe Creator</h2>
                    </div>
                    <button onClick={onClose} className="hover:bg-white/20 p-1 rounded">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                <div className="p-6 space-y-6">

                    {/* Input Section */}
                    {!result && (
                        <div className="space-y-4 text-center">
                            <p className="text-gray-600">I'll look at your <b>In-Stock Inventory</b> and concoct something amazing.</p>

                            <h3 className="font-semibold text-gray-700">Choose your Vibe:</h3>
                            <div className="flex flex-wrap justify-center gap-2">
                                {vibes.map(v => (
                                    <button
                                        key={v}
                                        onClick={() => setVibe(v)}
                                        className={`px-4 py-2 rounded-full border transition-all ${vibe === v ? 'bg-purple-100 border-purple-500 text-purple-700 shadow-md transform scale-105' : 'bg-gray-50 border-gray-200 hover:bg-gray-100'}`}
                                    >
                                        {v}
                                    </button>
                                ))}
                            </div>

                            {error && (
                                <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm">
                                    {error}
                                </div>
                            )}

                            <button
                                onClick={handleGenerate}
                                disabled={loading}
                                className="w-full py-4 mt-4 bg-black text-white rounded-xl font-bold text-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2 transition-all"
                            >
                                {loading ? (
                                    <>
                                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                                        Analyzing Inventory...
                                    </>
                                ) : (
                                    <>
                                        <ChefHat className="w-6 h-6" />
                                        Cook Magic!
                                    </>
                                )}
                            </button>
                        </div>
                    )}

                    {/* Result Display */}
                    {result && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                            <div className="flex justify-between items-start">
                                <div>
                                    <h2 className="text-3xl font-bold text-gray-900">{result.name}</h2>
                                    <p className="text-gray-500 mt-1 italic">"{result.description}"</p>
                                </div>
                                <div className="flex flex-col gap-2">
                                    <div className="bg-orange-100 text-orange-800 px-4 py-2 rounded-lg flex flex-col items-center border border-orange-200">
                                        <span className="text-xs uppercase font-bold tracking-wider">Viral Score</span>
                                        <span className="text-2xl font-black flex items-center gap-1">
                                            {result.viral_score}/10 <Flame className="w-5 h-5 text-orange-500 fill-orange-500" />
                                        </span>
                                    </div>
                                    <div className="flex justify-center gap-4 py-1">
                                        <button
                                            onClick={() => handleFeedback(-1)}
                                            disabled={feedbackGiven}
                                            className={`p-2 rounded-full transition-colors ${feedbackGiven ? 'opacity-50 grayscale' : 'hover:bg-red-100 text-gray-400 hover:text-red-500'} ${showComment ? 'bg-red-50 text-red-500' : ''}`}
                                            title="Too basic / Don't like"
                                        >
                                            <ThumbsUp className="w-5 h-5 rotate-180" />
                                        </button>
                                        <button
                                            onClick={() => handleFeedback(1)}
                                            disabled={feedbackGiven || showComment}
                                            className={`p-2 rounded-full transition-colors ${feedbackGiven ? 'opacity-50 grayscale' : 'hover:bg-green-100 text-gray-400 hover:text-green-500'}`}
                                            title="Amazing! Want more like this"
                                        >
                                            <ThumbsUp className="w-5 h-5" />
                                        </button>
                                    </div>

                                    {showComment && (
                                        <div className="space-y-2 animate-in fade-in zoom-in-95 duration-200">
                                            <textarea
                                                value={comment}
                                                onChange={(e) => setComment(e.target.value)}
                                                placeholder="What was wrong? (e.g. Too spicy, Missing salt...)"
                                                className="w-full p-2 text-xs border border-red-200 rounded-lg focus:ring-1 focus:ring-red-500 outline-none"
                                                rows={2}
                                            />
                                            <button
                                                onClick={() => handleFeedback(-1)}
                                                className="w-full py-1.5 bg-red-500 text-white text-[10px] uppercase font-bold rounded-lg hover:bg-red-600 transition-colors"
                                            >
                                                Submit Feedback to Train AI
                                            </button>
                                        </div>
                                    )}

                                    {feedbackGiven && <span className="text-[10px] text-center text-green-600 font-bold animate-pulse">Thanks! AI Training...</span>}
                                </div>
                            </div>

                            <div className="grid md:grid-cols-2 gap-6">
                                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                                    <h3 className="font-bold text-gray-800 mb-3 flex items-center gap-2">
                                        🛒 Ingredients
                                    </h3>
                                    <ul className="space-y-2 text-sm">
                                        {result.ingredients.map((ing, i) => (
                                            <li key={i} className="flex justify-between items-center py-1 border-b border-gray-100 last:border-0">
                                                <span className={ing.matched_ingredient_id ? "text-green-700 font-medium" : "text-gray-600"}>
                                                    {ing.name}
                                                </span>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-gray-500">{ing.approx_qty} {ing.unit}</span>
                                                    {ing.matched_ingredient_id && (
                                                        <span className="bg-green-100 text-green-700 text-[10px] px-1.5 py-0.5 rounded-full">In Stock</span>
                                                    )}
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                </div>

                                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                                    <h3 className="font-bold text-gray-800 mb-3">📝 Instructions</h3>
                                    <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
                                        {result.instructions.map((step, i) => (
                                            <li key={i} className="pl-1">{step}</li>
                                        ))}
                                    </ol>
                                </div>
                            </div>

                            <div className="flex gap-3 pt-4">
                                <button
                                    onClick={() => setResult(null)}
                                    className="flex-1 py-3 text-gray-600 font-medium hover:bg-gray-100 rounded-lg"
                                >
                                    Try Again
                                </button>
                                <button
                                    onClick={() => onSave(result)}
                                    className="flex-[2] py-3 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 shadow-lg flex justify-center items-center gap-2"
                                >
                                    <ThumbsUp className="w-5 h-5" />
                                    Save to Menu
                                </button>
                            </div>
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
}
