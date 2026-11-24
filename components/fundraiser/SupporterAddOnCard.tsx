"use client";

/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S4) — the supporter add-on, inside "Your order" on the public fundraiser page.
 *
 *   SupporterAddOnCard       the inline offer: the full "Complete your meals" card, or (after "No thanks",
 *                            or after the add-on was removed) one quiet link that re-opens it.
 *   SupporterAddOnOrderLine  the add-on once it is in the order: an ordinary line with − / + / line total / ✕,
 *                            named by the shared S3 rule ("Sides & Dessert Bundle (Add-On)") — never a serving
 *                            size, never "Family Size".
 *
 * Deliberately hookless and stateless (tests/helpers/hookRuntime expands function components directly).
 * FundraiserClient owns the state through lib/supporterAddOnOffer.ts — which view shows, the quantity, the
 * decline — and the one detail view (SupporterBundleDetail in its add-on mode). Copy comes from that module
 * too, so the words a supporter reads are tested in one place.
 *
 * Narrow phones: nothing here has a fixed width; every text block may wrap; the buttons wrap onto their own
 * rows; tap targets are at least 44px tall.
 */

import type React from 'react';
import { publicImageUrl } from '@/lib/supporterBundleDetail';
import { addOnDisplayName } from '@/lib/orderLineDisplay';
import {
    ADD_ON_OFFER_HEADING,
    addOnOfferBody,
    addOnPriceText,
    addOnSupportLine,
} from '@/lib/supporterAddOnOffer';
import { hideBrokenImage } from '@/components/fundraiser/SupporterBundleDetail';

const SERIF = "Georgia,'Iowan Old Style','Times New Roman',serif";

export interface SupporterAddOnPublic {
    id: string;
    name: string;
    description?: unknown;
    image_url?: unknown;
    price: number;
    items?: unknown;
    supportPercent?: number | null;
}

// Media queries and :focus-visible cannot be inline styles.
export const SUPPORTER_ADDON_CARD_CSS =
    '.fr-addon-card button:focus-visible, .fr-addon-line button:focus-visible, .fr-addon-quiet:focus-visible { outline: 3px solid #3b2a2f; outline-offset: 2px; }';

export function SupporterAddOnCard({
    view,
    addOn,
    organizationName,
    primaryColor,
    onAdd,
    onOpenDetail,
    onDecline,
    onReopen,
}: {
    view: 'card' | 'quiet';
    addOn: SupporterAddOnPublic;
    organizationName: string | null | undefined;
    primaryColor: string;
    onAdd: () => void;
    onOpenDetail: () => void;
    onDecline: () => void;
    onReopen: () => void;
}) {
    const price = addOnPriceText(addOn.price);

    if (view === 'quiet') {
        return (
            <div data-addon-offer="quiet" style={{ marginTop: '.6rem' }}>
                <style>{SUPPORTER_ADDON_CARD_CSS}</style>
                <button
                    type="button"
                    className="fr-addon-quiet"
                    onClick={onReopen}
                    aria-expanded={false}
                    style={{ background: 'none', border: 0, padding: '.6rem 0', minHeight: 44, color: primaryColor, fontSize: '.74rem', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: 3, overflowWrap: 'anywhere' }}
                >
                    + Show add-on: {addOn.name} · {price}
                </button>
            </div>
        );
    }

    const imageUrl = publicImageUrl(addOn.image_url);
    const supportLine = addOnSupportLine(organizationName, addOn.supportPercent);

    return (
        <section
            aria-labelledby="fr-addon-offer-title"
            data-addon-offer="card"
            className="fr-addon-card"
            style={{ marginTop: '.75rem', background: '#fdf8f3', border: '1px solid #eee2d6', borderRadius: 16, padding: '.85rem .9rem', minWidth: 0 }}
        >
            <style>{SUPPORTER_ADDON_CARD_CSS}</style>
            <div style={{ display: 'flex', gap: '.7rem', alignItems: 'flex-start', minWidth: 0 }}>
                {imageUrl && (
                    <span aria-hidden="true" style={{ position: 'relative', flex: 'none', width: 56, height: 56, borderRadius: 12, overflow: 'hidden', background: 'linear-gradient(135deg,#f3d8c8,#eec3ad)' }}>
                        <img
                            src={imageUrl}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            width={56}
                            height={56}
                            onError={hideBrokenImage}
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                    </span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'inline-block', borderRadius: 99, padding: '.18rem .55rem', fontSize: '.6rem', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', background: '#f6ede2', color: '#6b4d3f' }}>
                        Add-on
                    </span>
                    <h3 id="fr-addon-offer-title" style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1rem', lineHeight: 1.25, margin: '.3rem 0 0', color: '#3b2a2f', overflowWrap: 'anywhere' }}>
                        {ADD_ON_OFFER_HEADING}
                    </h3>
                    <p style={{ margin: '.25rem 0 0', fontSize: '.74rem', lineHeight: 1.45, color: '#5d463d', overflowWrap: 'anywhere' }}>
                        {addOnOfferBody(addOn.name, organizationName)}
                    </p>
                    {supportLine && (
                        <p style={{ margin: '.25rem 0 0', fontSize: '.7rem', lineHeight: 1.4, color: '#7a6258', overflowWrap: 'anywhere' }}>
                            {supportLine}
                        </p>
                    )}
                </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem .9rem', alignItems: 'center', marginTop: '.7rem' }}>
                <button
                    type="button"
                    onClick={onAdd}
                    style={{ flex: '1 1 100%', minWidth: 0, minHeight: 44, background: primaryColor, color: '#fff', border: 0, borderRadius: 12, padding: '.6rem .8rem', fontSize: '.8rem', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', overflowWrap: 'anywhere' }}
                >
                    Add to my order · {price}
                </button>
                <button
                    type="button"
                    onClick={onOpenDetail}
                    aria-haspopup="dialog"
                    style={{ background: 'none', border: 0, padding: '.55rem 0', minHeight: 44, color: primaryColor, fontSize: '.74rem', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3 }}
                >
                    See what&rsquo;s included
                </button>
                <button
                    type="button"
                    onClick={onDecline}
                    style={{ marginLeft: 'auto', background: 'none', border: 0, padding: '.55rem 0', minHeight: 44, color: '#9a8075', fontSize: '.72rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                    No thanks
                </button>
            </div>
        </section>
    );
}

const qtyBtn: React.CSSProperties = {
    width: 24,
    height: 24,
    borderRadius: 8,
    border: '1px solid #e9d9cb',
    background: '#faf5ef',
    color: '#3b2a2f',
    fontWeight: 800,
    cursor: 'pointer',
    lineHeight: 1,
};

/** The add-on in the order — the same row shape and controls as a meal line (FundraiserClient). */
export function SupporterAddOnOrderLine({
    addOn,
    quantity,
    onIncrease,
    onDecrease,
    onRemove,
}: {
    addOn: SupporterAddOnPublic;
    quantity: number;
    onIncrease: () => void;
    onDecrease: () => void;
    onRemove: () => void;
}) {
    const label = addOnDisplayName(addOn.name);
    const price = Number(addOn.price) || 0;
    return (
        <div data-addon-line="true" className="fr-addon-line" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.6rem', padding: '.55rem 0', borderBottom: '1px dashed #eee2d6' }}>
            <style>{SUPPORTER_ADDON_CARD_CSS}</style>
            <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: '.76rem', color: '#3b2a2f', display: 'block', overflowWrap: 'anywhere' }}>{label}</b>
                <span style={{ fontSize: '.66rem', color: '#9a8075' }}>{addOnPriceText(price)} each · with your meal bundle</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem' }}>
                <button type="button" aria-label={`Decrease ${label} quantity`} onClick={onDecrease} style={qtyBtn}>−</button>
                <span aria-live="polite" aria-atomic="true" style={{ fontSize: '.8rem', fontWeight: 800, minWidth: '1rem', textAlign: 'center', color: '#3b2a2f' }}>{quantity}</span>
                <button type="button" aria-label={`Increase ${label} quantity`} onClick={onIncrease} style={qtyBtn}>+</button>
            </div>
            <b style={{ fontSize: '.8rem', color: '#3b2a2f', fontVariantNumeric: 'tabular-nums' }}>{addOnPriceText(price * quantity)}</b>
            <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} style={{ color: '#d8c3b5', background: 'none', border: 0, cursor: 'pointer', padding: '0 .2rem', fontSize: '.8rem' }}>✕</button>
        </div>
    );
}
