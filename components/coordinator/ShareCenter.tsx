'use client';

export function ShareCenter({
    shareUrl, onCopy, copied,
    qrHref, flyerHref, scoreboardHref,
    onOpenAi, aiRemaining, aiLabel = '✨ Write a message for me',
}: {
    shareUrl: string; onCopy: () => void; copied: boolean;
    qrHref?: string; flyerHref?: string; scoreboardHref?: string;
    onOpenAi?: () => void; aiRemaining?: number | null; aiLabel?: string;
}) {
    return (
        <section id="share-center" className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900 mb-3">Share Center</h3>
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600">
                    {shareUrl.replace(/^https?:\/\//, '')}
                </code>
                <button onClick={onCopy}
                    className="flex-none rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white">
                    {copied ? 'Copied ✓' : 'Copy'}
                </button>
            </div>
            <div className="mt-2.5 flex gap-2">
                {qrHref && <MiniLink href={qrHref} label="QR code" />}
                {flyerHref && <MiniLink href={flyerHref} label="Flyer" />}
                {scoreboardHref && <MiniLink href={scoreboardHref} label="Scoreboard" />}
            </div>
            {onOpenAi && (
                <button onClick={onOpenAi}
                    className="mt-2.5 w-full rounded-xl bg-indigo-50 py-2.5 text-[13px] font-bold text-indigo-700">
                    {aiLabel}{typeof aiRemaining === 'number' ? ` (${aiRemaining} left)` : ''}
                </button>
            )}
        </section>
    );
}

function MiniLink({ href, label }: { href: string; label: string }) {
    return (
        <a href={href} target="_blank" rel="noreferrer"
            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-2 text-center text-xs font-semibold text-slate-700">
            {label}
        </a>
    );
}

export default ShareCenter;
