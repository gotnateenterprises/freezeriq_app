"use client";

import { useState } from 'react';
import { Share2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

interface ShareActionProps {
    url: string;
    title?: string;
    text?: string;
    className?: string;
}

export default function ShareAction({ url, title = 'Support our Fundraiser!', text = 'Check out our fundraiser and help us reach our goal!', className = '' }: ShareActionProps) {
    const [copied, setCopied] = useState(false);

    const handleShare = async () => {
        // Check if Web Share API is fully supported and we are on a mobile-like device usually
        if (navigator.share) {
            try {
                await navigator.share({
                    title,
                    text,
                    url,
                });
                return; // Success, we are done
            } catch (err) {
                // User may have cancelled or it failed. 
                // We'll fall through to the clipboard copy just in case it was a failure and not a cancel,
                // or we can just log it. Usually, AbortError means user cancelled.
                if ((err as Error).name !== 'AbortError') {
                    fallbackCopy();
                }
            }
        } else {
            // Fallback for desktop or unsupported browsers
            fallbackCopy();
        }
    };

    const fallbackCopy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            showSuccess();
        } catch (err) {
            // Fallback for when document is not focused or clipboard API fails
            try {
                const textArea = document.createElement("textarea");
                textArea.value = url;
                textArea.style.position = "fixed";
                textArea.style.left = "-999999px";
                textArea.style.top = "-999999px";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                const successful = document.execCommand('copy');
                textArea.remove();
                if (successful) {
                    showSuccess();
                } else {
                    toast.error("Could not copy automatically. The link is: " + url);
                }
            } catch (fallbackErr) {
                toast.error("Could not copy automatically. The link is: " + url);
            }
        }
    };

    const showSuccess = () => {
        setCopied(true);
        toast.success("Link copied to clipboard!");
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            onClick={handleShare}
            className={`flex items-center justify-center gap-2 transition-all active:scale-95 ${className}`}
        >
            {copied ? <CheckCircle2 size={24} className="text-emerald-500" /> : <Share2 size={24} />}
            <span>{copied ? 'Copied!' : 'Share Custom Link'}</span>
        </button>
    );
}
