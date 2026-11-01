"use client";

/**
 * FR-SUPPORTER-ORDER-CONVERSION-1 — the bundle detail a supporter opens from a bundle card on the
 * public fundraiser page: the whole bundle photo, the size and price, and every meal inside in the
 * bundle's own order with its stored photo and description, plus one action that adds THIS exact
 * orderable bundle (this id, this size, this price) to the order already on the page.
 *
 * Deliberately hookless and stateless. FundraiserClient owns everything: which bundle is open, the
 * order lines (its toggleLine / changeQty are the only quantity authority — this view has no cart of
 * its own), the photo-size toggle, and the shared dialog focus behaviour (components/crm2/
 * useDialogFocus: focus moves in, background scroll locks, Tab stays inside, focus returns to the
 * card that opened it). Escape is the caller's, as that hook requires.
 *
 * Content comes only from the public payload (lib/publicFundraiserPayload.ts) through
 * lib/supporterBundleDetail.ts: nothing is invented, sorted, or fetched. Meal photos load only when
 * this view is open, because it only renders then.
 */

import type React from 'react';
import { publicImageUrl, publicText, supporterBundleMeals, supporterGoalCredit, supporterServesLabel } from '@/lib/supporterBundleDetail';

const SERIF = "Georgia,'Iowan Old Style','Times New Roman',serif";

/** A photo that fails to load hides itself and leaves the warm placeholder behind it showing. */
export function hideBrokenImage(e: React.SyntheticEvent<HTMLImageElement>) {
    e.currentTarget.style.visibility = 'hidden';
}

// Media queries and :focus-visible cannot be inline styles. A centred dialog on desktop; on a phone
// a sheet from the bottom that is nearly full height, so a long meal list scrolls inside it while the
// close button and the action stay in reach. Nothing here has a fixed width, so nothing can push
// past a 360px screen.
export const SUPPORTER_BUNDLE_DETAIL_CSS = `
.fr-detail-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(59,42,47,.45); display: flex; align-items: center; justify-content: center; padding: 1rem; }
.fr-detail-panel { position: relative; background: #fff; color: #3b2a2f; border: 1px solid #eee2d6; border-radius: 20px; box-shadow: 0 20px 45px rgba(59,42,47,.25); width: 100%; max-width: 34rem; max-height: 88vh; max-height: 88dvh; display: flex; flex-direction: column; overflow: hidden; outline: none; }
.fr-detail-head { flex: none; display: flex; justify-content: flex-end; align-items: center; min-height: 52px; padding: .35rem .45rem 0; position: relative; }
.fr-detail-handle { display: none; }
.fr-detail-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 0 1.15rem 1.1rem; }
.fr-detail-foot { flex: none; border-top: 1px solid #eee2d6; background: #fff; padding: .75rem 1.15rem; padding-bottom: calc(.75rem + env(safe-area-inset-bottom, 0px)); }
.fr-detail-panel button { font-family: inherit; }
.fr-detail-panel button:focus-visible { outline: 3px solid #3b2a2f; outline-offset: 2px; }
@media (max-width: 640px) {
  .fr-detail-overlay { align-items: flex-end; padding: 0; }
  .fr-detail-panel { max-width: none; max-height: 94vh; max-height: 94dvh; border-radius: 20px 20px 0 0; border-bottom: 0; }
  .fr-detail-handle { display: block; position: absolute; left: 50%; top: .5rem; transform: translateX(-50%); width: 36px; height: 4px; border-radius: 99px; background: #eee2d6; }
  .fr-detail-body { padding: 0 1rem 1rem; }
  .fr-detail-foot { padding-left: 1rem; padding-right: 1rem; }
}
`;

const chip: React.CSSProperties = {
    display: 'inline-block', borderRadius: 99, padding: '.28rem .65rem', fontSize: '.72rem', fontWeight: 800,
    background: '#fdf3ee',
};

/** Read by screen readers, not shown. */
export const srOnly: React.CSSProperties = {
    position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
};

const stepBtn: React.CSSProperties = {
    width: 44, height: 44, borderRadius: 12, border: '1px solid #e9d9cb', background: '#faf5ef', color: '#3b2a2f',
    fontSize: '1.1rem', fontWeight: 800, cursor: 'pointer', lineHeight: 1, flex: 'none',
};

export interface SupporterBundleDetailProps {
    /** The exact orderable bundle, as the page received it. */
    bundle: any;
    primaryColor: string;
    /** This bundle's quantity in the page's order (0 when it is not in the order). */
    quantityInOrder: number;
    /** Whether the bundle photo is shown at its full natural size. */
    imageExpanded: boolean;
    panelRef: React.Ref<HTMLDivElement>;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onClose: () => void;
    /** Put this bundle in the order (the page's own add), then close. */
    onAdd: () => void;
    /** Change this bundle's quantity through the page's own stepper logic. */
    onChangeQty: (delta: number) => void;
    onToggleImage: () => void;
}

export function SupporterBundleDetail({
    bundle,
    primaryColor,
    quantityInOrder,
    imageExpanded,
    panelRef,
    onKeyDown,
    onClose,
    onAdd,
    onChangeQty,
    onToggleImage,
}: SupporterBundleDetailProps) {
    const meals = supporterBundleMeals(bundle);
    const serves = supporterServesLabel(bundle.serving_tier);
    const servesTitle = serves === 'serves 5' ? 'Serves 5' : 'Serves 2';
    const hasPrice = Number(bundle.price || 0) > 0;
    const price = hasPrice ? `$${Number(bundle.price).toFixed(2)}` : 'Contact for price';
    const imageUrl = publicImageUrl(bundle.image_url);
    const description = publicText(bundle.description);
    const inOrder = quantityInOrder > 0;

    return (
        <div className="fr-detail-overlay" onClick={onClose} onKeyDown={onKeyDown}>
            <style>{SUPPORTER_BUNDLE_DETAIL_CSS}</style>
            <div
                ref={panelRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="fr-bundle-detail-title"
                data-bundle-id={bundle.id}
                className="fr-detail-panel"
                onClick={e => e.stopPropagation()}
            >
                <div className="fr-detail-head">
                    <span className="fr-detail-handle" aria-hidden="true" />
                    <button type="button" onClick={onClose} aria-label="Close bundle details" style={{ width: 44, height: 44, borderRadius: 99, border: 0, background: '#f6ede2', color: '#3b2a2f', fontSize: '1rem', fontWeight: 800, cursor: 'pointer' }}>
                        ✕
                    </button>
                </div>

                <div className="fr-detail-body">
                    {/* The WHOLE photo: contain, never cover. Tapping it switches between a
                        screen-sized view and the photo's own full size, inside this scroll area. */}
                    {imageUrl ? (
                        <button
                            type="button"
                            onClick={onToggleImage}
                            aria-pressed={imageExpanded}
                            aria-label={imageExpanded ? `Show the ${bundle.name} photo smaller` : `Show the ${bundle.name} photo at full size`}
                            style={{ display: 'block', position: 'relative', width: '100%', padding: 0, border: 0, borderRadius: 16, overflow: 'hidden', background: 'linear-gradient(135deg,#f3d8c8,#eec3ad)', cursor: imageExpanded ? 'zoom-out' : 'zoom-in' }}
                        >
                            <img
                                src={imageUrl}
                                alt={`${bundle.name} — full bundle photo`}
                                decoding="async"
                                onError={hideBrokenImage}
                                style={{ display: 'block', width: '100%', height: 'auto', maxHeight: imageExpanded ? 'none' : 'min(58vh, 30rem)', objectFit: 'contain' }}
                            />
                            <span aria-hidden="true" style={{ position: 'absolute', right: '.5rem', bottom: '.5rem', background: 'rgba(255,255,255,.92)', color: '#3b2a2f', borderRadius: 99, padding: '.3rem .6rem', fontSize: '.68rem', fontWeight: 800 }}>
                                {imageExpanded ? '− Smaller' : '⤢ Full size'}
                            </span>
                        </button>
                    ) : (
                        <div aria-hidden="true" style={{ height: 96, borderRadius: 16, display: 'grid', placeItems: 'center', fontSize: '2.4rem', background: 'linear-gradient(135deg,#f3d8c8,#eec3ad)' }}>
                            🍲
                        </div>
                    )}

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '.85rem 0 .45rem' }}>
                        <span style={{ ...chip, color: primaryColor }}>{servesTitle}</span>
                        {meals.length > 0 && (
                            <span style={{ ...chip, color: '#6b4d3f', background: '#f6ede2' }}>{meals.length} meal{meals.length === 1 ? '' : 's'}</span>
                        )}
                    </div>

                    <h2 id="fr-bundle-detail-title" style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.4rem', lineHeight: 1.25, margin: 0, color: '#3b2a2f', overflowWrap: 'anywhere' }}>
                        {bundle.name}
                    </h2>
                    <p style={{ margin: '.35rem 0 0', fontSize: '.9rem', color: '#3b2a2f' }}>
                        <b style={{ fontVariantNumeric: 'tabular-nums' }}>{price}</b>
                        <span style={{ color: '#7a6258' }}> · {serves}</span>
                    </p>
                    <p style={{ margin: '.2rem 0 0', fontSize: '.74rem', color: '#7a6258' }}>
                        Counts as {supporterGoalCredit(bundle.serving_tier)} toward the fundraiser goal
                    </p>
                    {description && (
                        <p style={{ margin: '.6rem 0 0', fontSize: '.84rem', color: '#5d463d', lineHeight: 1.55, overflowWrap: 'anywhere' }}>{description}</p>
                    )}

                    <h3 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.1rem', margin: '1.15rem 0 .2rem', color: '#3b2a2f' }}>
                        What&rsquo;s inside
                    </h3>
                    {meals.length > 0 ? (
                        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                            {meals.map((meal, i) => (
                                <li key={i} data-meal-index={i} style={{ display: 'flex', gap: '.8rem', alignItems: 'flex-start', padding: '.8rem 0', borderTop: i === 0 ? 0 : '1px dashed #eee2d6' }}>
                                    <span style={{ position: 'relative', flex: 'none', width: 76, height: 76, borderRadius: 14, overflow: 'hidden', background: 'linear-gradient(135deg,#f3d8c8,#eec3ad)', display: 'grid', placeItems: 'center', fontSize: '1.5rem' }}>
                                        <span aria-hidden="true">🍽️</span>
                                        {meal.imageUrl && (
                                            <img
                                                src={meal.imageUrl}
                                                alt={`Photo of ${meal.displayName}`}
                                                loading="lazy"
                                                decoding="async"
                                                width={76}
                                                height={76}
                                                onError={hideBrokenImage}
                                                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                                            />
                                        )}
                                    </span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <b style={{ display: 'block', fontSize: '.92rem', lineHeight: 1.3, color: '#3b2a2f', overflowWrap: 'anywhere' }}>{meal.displayName}</b>
                                        {meal.description && (
                                            <p style={{ margin: '.25rem 0 0', fontSize: '.84rem', lineHeight: 1.5, color: '#5d463d', overflowWrap: 'anywhere' }}>{meal.description}</p>
                                        )}
                                        {(meal.cookTime || meal.allergens) && (
                                            <p style={{ margin: '.3rem 0 0', fontSize: '.72rem', lineHeight: 1.45, color: '#7a6258', overflowWrap: 'anywhere' }}>
                                                {meal.cookTime && <span>⏱ {meal.cookTime}</span>}
                                                {meal.cookTime && meal.allergens && <span aria-hidden="true"> · </span>}
                                                {meal.allergens && <span>Allergens: {meal.allergens}</span>}
                                            </p>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p style={{ margin: '.4rem 0 0', fontSize: '.84rem', color: '#7a6258' }}>
                            The meal list for this bundle isn&rsquo;t available right now.
                        </p>
                    )}
                </div>

                {/* The action. It names the exact size and price being added, and it uses the page's
                    own order: Add is the card's add; the steppers are the order card's −/+. */}
                <div className="fr-detail-foot">
                    {inOrder ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
                            <span style={{ flex: '1 1 8rem', minWidth: 0, fontSize: '.84rem', fontWeight: 800, color: '#4f6142' }}>
                                ✓ In your order
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flex: 'none' }}>
                                <button type="button" aria-label={`One fewer ${bundle.name}`} onClick={() => onChangeQty(-1)} style={stepBtn}>−</button>
                                <span aria-live="polite" aria-atomic="true" style={{ minWidth: '1.5rem', textAlign: 'center', fontSize: '1rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                                    <span style={srOnly}>Quantity </span>{quantityInOrder}
                                </span>
                                <button type="button" aria-label={`One more ${bundle.name}`} onClick={() => onChangeQty(+1)} style={stepBtn}>+</button>
                            </div>
                            <button type="button" onClick={onClose} style={{ flex: '1 1 100%', minHeight: 48, background: primaryColor, color: '#fff', border: 0, borderRadius: 14, fontSize: '.9rem', fontWeight: 800, cursor: 'pointer' }}>
                                Done
                            </button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={onAdd}
                            disabled={!hasPrice}
                            style={{ width: '100%', minHeight: 48, background: primaryColor, color: '#fff', border: 0, borderRadius: 14, padding: '.7rem .9rem', fontSize: '.9rem', fontWeight: 800, cursor: hasPrice ? 'pointer' : 'default', opacity: hasPrice ? 1 : .55, overflowWrap: 'anywhere' }}
                        >
                            {hasPrice ? `Add to my order · ${servesTitle} · ${price}` : 'Contact for price'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
