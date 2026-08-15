"use client";

/**
 * CRM-CC-5 — shared dialog focus behavior.
 *
 * One small hook so every modal surface in the Command Center (Campaign
 * Context drawer, closeout modal, bundle-selection dialogs) gets the same
 * accessible treatment instead of three drifting copies:
 *
 *  · on open: remember the trigger, move focus into the panel, and lock the
 *    page's scroll behind the overlay;
 *  · on close: restore the page's scroll and hand focus back to the trigger;
 *  · containTab: keep Tab / Shift+Tab cycling inside the panel, because
 *    aria-modal only hides the background from assistive tech — it does not
 *    stop keyboard focus from wandering out.
 *
 * Escape handling deliberately stays with each caller: the drawer closes
 * unconditionally, the closeout modal must ignore Escape mid-request, and the
 * bundle dialogs must stop propagation so they don't close the drawer above.
 */

import { useEffect, useRef } from 'react';

const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(open: boolean, reKey?: unknown) {
    const panelRef = useRef<HTMLDivElement>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!open) return;
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
        panelRef.current?.focus();
        // Nested dialogs each capture the value they saw, so unwinding in
        // reverse order restores the original overflow correctly.
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prevOverflow;
            restoreFocusRef.current?.focus?.();
        };
    }, [open, reKey]);

    /** Attach inside the dialog's onKeyDown to keep Tab within the panel. */
    const containTab = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab' || e.defaultPrevented || !panelRef.current) return;
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusables.length === 0) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
            if (active === first || active === panelRef.current) {
                e.preventDefault();
                last.focus();
            }
        } else if (active === last) {
            e.preventDefault();
            first.focus();
        }
    };

    return { panelRef, containTab };
}
