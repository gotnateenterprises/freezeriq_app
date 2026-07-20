'use client';

import Link from 'next/link';
import { User } from 'lucide-react';

/**
 * SF-2A: faithful port of the approved prototype `.topbar`
 * (storefront_prototype.html — sticky warm bar: 30px round primary logo
 * circle · serif business name · compact right-side slot).
 *
 * Prototype CSS ported to SF-1 tokens:
 *   position:sticky; background:rgba(250,245,239,.92); backdrop blur;
 *   border-bottom: 1px #eee2d6  →  --sf-ground / --sf-line
 *   .logo 30px round berry circle →  --sf-primary / --sf-on-primary
 *   <b> Georgia serif 1rem        →  font-serif
 *
 * The right side deliberately carries ONLY a neutral account link — an
 * approved product deviation (account access must stay discoverable).
 * No discount chips, points, offers, or reorder data may appear here
 * until their SF-2B data phases land.
 */
export function StorefrontTopbar({
    businessName,
    logoUrl,
    slug,
}: {
    businessName: string;
    logoUrl?: string | null;
    slug: string;
}) {
    return (
        <div className="sticky top-0 z-40 flex items-center gap-2.5 border-b border-[var(--sf-line)] bg-[color-mix(in_srgb,var(--sf-ground)_92%,transparent)] px-4 pb-2.5 pt-3 backdrop-blur-lg">
            <span className="grid h-[30px] w-[30px] flex-none place-items-center overflow-hidden rounded-full bg-[var(--sf-primary)] text-[0.85rem] text-[var(--sf-on-primary)]">
                {logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                    <span aria-hidden="true">🍲</span>
                )}
            </span>
            <b className="min-w-0 truncate font-serif text-base font-normal tracking-[0.01em] text-[var(--sf-ink)]">
                {businessName}
            </b>
            <Link
                href={`/shop/${slug}/account`}
                aria-label="My Account"
                className="ml-auto flex flex-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-bold text-[var(--sf-muted)] transition-colors hover:text-[var(--sf-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
            >
                <User size={14} aria-hidden="true" />
                <span className="hidden sm:inline">My Account</span>
            </Link>
        </div>
    );
}
