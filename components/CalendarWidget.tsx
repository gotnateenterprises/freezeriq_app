"use client";

import { useState, useEffect } from 'react';
import { Calendar, Settings, X, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { updateCalendarUrl } from '@/app/actions/settings';
import { useTheme } from '@/components/ThemeProvider';

export default function CalendarWidget({ initialUrl, hideSettings = false }: { initialUrl?: string, hideSettings?: boolean }) {
    const [calendarUrl, setCalendarUrl] = useState(initialUrl || '');
    const [savedUrl, setSavedUrl] = useState(initialUrl || '');
    const [showSettings, setShowSettings] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const { theme } = useTheme();

    useEffect(() => {
        const cleaned = initialUrl ? cleanUrl(initialUrl) : '';
        setSavedUrl(cleaned);
        setCalendarUrl(cleaned);
    }, [initialUrl]);

    const cleanUrl = (url: string) => {
        let clean = url.trim();
        if (clean.includes('<iframe')) {
            const srcMatch = clean.match(/src="([^"]+)"/);
            if (srcMatch && srcMatch[1]) clean = srcMatch[1];
        }

        // Handle cid conversion
        if (clean.includes('cid=')) {
            try {
                const urlObj = new URL(clean);
                const cid = urlObj.searchParams.get('cid');
                if (cid) {
                    const decodedEmail = atob(cid);
                    clean = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(decodedEmail)}&ctz=America%2FChicago`;
                }
            } catch (e) { }
        }

        // Handle public URL conversion
        if (clean.includes('calendar.google.com/calendar/') && !clean.includes('/embed')) {
            const publicMatch = clean.match(/\/calendar\/public\/u\/0\/([^/]+)/);
            if (publicMatch && publicMatch[1]) {
                clean = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(publicMatch[1])}&ctz=America%2FChicago`;
            }
        }
        return clean;
    };

    const handleSave = async () => {
        const urlToSave = cleanUrl(calendarUrl);
        if (urlToSave) {
            setIsSaving(true);
            const result = await updateCalendarUrl(urlToSave);
            setIsSaving(false);

            if (result.success) {
                setSavedUrl(urlToSave);
                setCalendarUrl(urlToSave);
                setShowSettings(false);
            } else {
                alert('Failed to save calendar URL');
            }
        }
    };

    const handleClear = async () => {
        if (confirm('Are you sure? This will remove the calendar for everyone in your business.')) {
            setIsSaving(true);
            const result = await updateCalendarUrl(''); // Save empty string to clear
            setIsSaving(false);

            if (result.success) {
                setSavedUrl('');
                setCalendarUrl('');
            }
        }
    };

    return (
        <div className="bg-white dark:!bg-slate-800 rounded-2xl shadow-lg border border-slate-200 dark:!border-slate-700 overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Calendar className="text-indigo-600 dark:text-indigo-400" size={20} />
                    <h3 className="text-lg font-bold text-slate-900 dark:!text-white">Calendar</h3>
                </div>
                {!hideSettings && (
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                        title="Calendar Settings"
                    >
                        <Settings size={18} className="text-slate-500 dark:text-slate-400" />
                    </button>
                )}
            </div>

            {/* Settings Panel */}
            {showSettings && (
                <div className="p-4 bg-slate-50 dark:!bg-slate-900 border-b border-slate-200 dark:!border-slate-700">
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
                                className="w-full px-3 py-2 bg-white dark:!bg-slate-800 border border-slate-300 dark:!border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none dark:!text-white"
                            />
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                1. Go to Google Calendar → Settings → Select Calendar<br />
                                2. Scroll to "Access permissions for events" → Check "Make available to public"<br />
                                3. Scroll to "Integrate calendar" → Copy "Public URL to this calendar" (or Embed code)
                            </p>
                            {calendarUrl && calendarUrl.includes('calendar.google.com') && !calendarUrl.includes('embed') && (
                                <p className="text-xs text-amber-600 font-bold mt-2">
                                    ⚠️ This looks like a browser URL, not an embed URL. Please double-check step 3.
                                </p>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={handleSave}
                                disabled={!calendarUrl.trim() || isSaving}
                                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                            >
                                {isSaving && <Loader2 className="animate-spin" size={12} />}
                                Save
                            </button>
                            {savedUrl && (
                                <button
                                    onClick={handleClear}
                                    disabled={isSaving}
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
                    <div
                        className="w-full h-[500px] rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 relative bg-white transition-all duration-300"
                        style={{
                            filter: theme === 'dark' ? 'invert(1) hue-rotate(180deg)' : 'none'
                        }}
                    >
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
                            {hideSettings ? "No calendar link has been configured for your business." : "Click the settings icon to add your Google Calendar"}
                        </p>
                        {!hideSettings && (
                            <button
                                onClick={() => setShowSettings(true)}
                                className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-bold text-sm"
                            >
                                Connect Calendar
                            </button>
                        )}
                        {hideSettings && (
                            <Link
                                href="/settings"
                                className="text-indigo-600 dark:text-indigo-400 font-bold hover:underline py-2 block"
                            >
                                Go to Settings to Connect &rarr;
                            </Link>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
