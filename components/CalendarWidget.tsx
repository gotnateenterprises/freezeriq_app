"use client";

import { useState, useEffect } from 'react';
import { Calendar, Settings, X } from 'lucide-react';

export default function CalendarWidget() {
    const [calendarUrl, setCalendarUrl] = useState('');
    const [savedUrl, setSavedUrl] = useState('');
    const [showSettings, setShowSettings] = useState(false);

    // Load saved URL from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem('googleCalendarUrl');
        if (saved) {
            setSavedUrl(saved);
        }
    }, []);

    const handleSave = () => {
        let urlToSave = calendarUrl.trim();

        // Extract src from iframe tag if pasted
        if (urlToSave.includes('<iframe')) {
            const srcMatch = urlToSave.match(/src="([^"]+)"/);
            if (srcMatch && srcMatch[1]) {
                urlToSave = srcMatch[1];
            }
        }

        if (urlToSave) {
            localStorage.setItem('googleCalendarUrl', urlToSave);
            setSavedUrl(urlToSave);
            setCalendarUrl(urlToSave); // Update input to show clean URL
            setShowSettings(false);
        }
    };

    const handleClear = () => {
        localStorage.removeItem('googleCalendarUrl');
        setSavedUrl('');
        setCalendarUrl('');
    };

    return (
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Calendar className="text-indigo-600 dark:text-indigo-400" size={20} />
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">Calendar</h3>
                </div>
                <button
                    onClick={() => setShowSettings(!showSettings)}
                    className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                    title="Calendar Settings"
                >
                    <Settings size={18} className="text-slate-500 dark:text-slate-400" />
                </button>
            </div>

            {/* Settings Panel */}
            {showSettings && (
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700">
                    <div className="space-y-3">
                        <div>
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                                Google Calendar Embed URL
                            </label>
                            <input
                                type="text"
                                value={calendarUrl}
                                onChange={(e) => setCalendarUrl(e.target.value)}
                                placeholder="Paste your calendar embed URL here..."
                                className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                Get this from Google Calendar → Settings → Integrate calendar → Public URL
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={handleSave}
                                disabled={!calendarUrl.trim()}
                                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Save
                            </button>
                            {savedUrl && (
                                <button
                                    onClick={handleClear}
                                    className="bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 px-4 py-2 rounded-lg font-bold text-sm"
                                >
                                    Clear
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Calendar Display */}
            <div className="p-4">
                {savedUrl ? (
                    <div className="w-full h-[500px] rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
                        <iframe
                            src={savedUrl}
                            className="w-full h-full"
                            frameBorder="0"
                            scrolling="no"
                        />
                    </div>
                ) : (
                    <div className="text-center py-12">
                        <Calendar className="mx-auto text-slate-300 dark:text-slate-600 mb-4" size={48} />
                        <p className="text-slate-500 dark:text-slate-400 font-bold mb-2">No Calendar Connected</p>
                        <p className="text-sm text-slate-400 dark:text-slate-500 mb-4">
                            Click the settings icon to add your Google Calendar
                        </p>
                        <button
                            onClick={() => setShowSettings(true)}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-bold text-sm"
                        >
                            Connect Calendar
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
