'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * SF-3: inline category chips — faithful port of the prototype `.cats` row
 * (white chips on the warm ground, ink-filled active state), replacing the
 * fixed legacy StickyCategoryBar pill so nothing overlaps the SF-2A sticky
 * topbar. Destinations and section ids are preserved exactly:
 *   Support a Cause → #fundraisers · Monthly Menus → #shop-bundles ·
 *   Extra Meals → #extras
 * Native buttons with aria-pressed; scrolling behavior matches the page's
 * existing smooth-scroll convention. Section content is untouched.
 */
export function CategoryChips({ hasFundraisers, hasBundles }: {
    hasFundraisers: boolean;
    hasBundles: boolean;
}) {
    const [active, setActive] = useState('bundles');

    const items = [
        { id: 'fundraisers', label: 'Support a Cause', target: 'fundraisers', show: hasFundraisers },
        { id: 'bundles', label: 'Monthly Menus', target: 'shop-bundles', show: hasBundles },
        { id: 'extras', label: 'Extra Meals', target: 'extras', show: true },
    ].filter(i => i.show);

    // Correction B: `active` previously reflected only the last-clicked chip,
    // not the section actually on screen. A minimal, storefront-only
    // IntersectionObserver (browser-native — no dependency added) watches the
    // real section elements and keeps `active` in sync with whichever one is
    // crossing a thin band near the top of the viewport. Section ids,
    // destinations, and scroll behavior on click are unchanged; no fixed or
    // floating bar is introduced. The observer is fully torn down on
    // unmount/dependency change via the effect's disconnect() cleanup.
    const itemsRef = useRef(items);
    itemsRef.current = items;

    useEffect(() => {
        const targets = itemsRef.current
            .map(i => ({ id: i.id, el: document.getElementById(i.target) }))
            .filter((t): t is { id: string; el: HTMLElement } => Boolean(t.el));
        if (targets.length === 0) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const visible = entries.filter(e => e.isIntersecting);
                if (visible.length === 0) return;
                const topMost = visible.reduce((a, b) =>
                    a.boundingClientRect.top < b.boundingClientRect.top ? a : b
                );
                const match = targets.find(t => t.el === topMost.target);
                if (match) setActive(match.id);
            },
            { rootMargin: '-20% 0px -70% 0px', threshold: 0 }
        );

        targets.forEach(t => observer.observe(t.el));
        return () => observer.disconnect();
    }, [hasFundraisers, hasBundles]);

    const go = (id: string, target: string) => {
        setActive(id);
        const el = document.getElementById(target);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
    };

    return (
        <div className="flex gap-1.5 overflow-x-auto px-4 pb-1 pt-3 [scrollbar-width:none]" role="group" aria-label="Shop sections">
            {items.map(i => (
                <button
                    key={i.id}
                    onClick={() => go(i.id, i.target)}
                    aria-pressed={active === i.id}
                    className={`flex-none rounded-full border px-3 py-1.5 text-xs font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)] ${
                        active === i.id
                            ? 'border-[var(--sf-ink)] bg-[var(--sf-ink)] text-white'
                            : 'border-[var(--sf-line)] bg-[var(--sf-card)] text-[var(--sf-muted)]'}`}
                >
                    {i.label}
                </button>
            ))}
        </div>
    );
}
