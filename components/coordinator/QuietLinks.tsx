'use client';

export function QuietLinks({
    guideHref, onOpenDownloads, activitySummary,
}: {
    guideHref: string; onOpenDownloads: () => void; activitySummary?: string;
}) {
    return (
        <div className="flex items-center justify-around rounded-2xl border border-slate-200 bg-white px-2 py-2.5 text-xs text-slate-500">
            <a href={guideHref} className="font-medium hover:text-slate-700">Success guide</a>
            <button onClick={onOpenDownloads} className="font-medium hover:text-slate-700">Downloads</button>
            {activitySummary && <span>Your activity: {activitySummary}</span>}
        </div>
    );
}

export default QuietLinks;
