"use client";

/**
 * COORDINATOR-PAYMENT-METHOD-UX-1 — "how do I pay?" on the public fundraiser page.
 *
 * Two placements, one rule (lib/supporterPaymentMethods.buildSupporterPaymentView):
 *
 *   variant="order"         a compact note inside the order card, read BEFORE the supporter
 *                           submits. Secondary to choosing meals: small type, no buttons, nothing
 *                           external to open before an order even exists.
 *   variant="confirmation"  the payment card after a successful order, when the supporter
 *                           actually has to act: the amount due, the due guidance, every method
 *                           the coordinator selected, and "Open Venmo"-style links.
 *
 * Hookless and stateless, and it has no click handlers and makes no requests: a payment link is a
 * plain anchor that opens another app in a new tab. Nothing here can mark an order paid or say it
 * is — the amount shown is the caller's server-persisted total, never recomputed here.
 */

import {
    buildSupporterPaymentView,
    LEGACY_LINK_LABEL,
    type PublicPaymentMethod,
} from '@/lib/supporterPaymentMethods';

export interface SupporterPaymentSectionProps {
    variant: 'order' | 'confirmation';
    /** The supporter-facing projection (null for a campaign that never configured methods). */
    methods: unknown;
    instructions: unknown;
    legacyLink: unknown;
    primaryColor: string;
    /** confirmation only: the server-persisted amount due, displayed as given. */
    amountDue?: number;
    orderRef?: string;
}

const TEXT = '#3b2a2f';
const MUTED = '#7a6258';

function MethodRow({ method, linked, primaryColor }: { method: PublicPaymentMethod; linked: boolean; primaryColor: string }) {
    return (
        <li style={{ padding: '.5rem 0', borderTop: '1px dashed #eee2d6', listStyle: 'none' }}>
            <b style={{ display: 'block', fontSize: '.76rem', color: TEXT }}>{method.label}</b>
            {method.detail && (
                <span style={{ display: 'block', fontSize: '.74rem', color: '#5d463d', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{method.detail}</span>
            )}
            {linked && method.href && method.actionLabel && (
                <a
                    href={method.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${method.actionLabel}${method.detail ? ` for ${method.detail}` : ''} (opens in a new tab)`}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, width: '100%', boxSizing: 'border-box', marginTop: '.4rem', background: '#f6ede2', color: primaryColor, borderRadius: 11, fontSize: '.74rem', fontWeight: 800, padding: '.55rem .8rem', textDecoration: 'none' }}
                >
                    {method.actionLabel} ↗
                </a>
            )}
        </li>
    );
}

export function SupporterPaymentSection({ variant, methods, instructions, legacyLink, primaryColor, amountDue, orderRef }: SupporterPaymentSectionProps) {
    const view = buildSupporterPaymentView({ methods: methods as PublicPaymentMethod[] | null, instructions, legacyLink });
    const confirmation = variant === 'confirmation';
    const listLabel = confirmation ? 'Ways to pay your coordinator' : 'Ways to pay';

    const body = (
        <>
            {view.dueLine && (
                <p style={{ margin: '.3rem 0 0', fontSize: confirmation ? '.76rem' : '.7rem', fontWeight: 700, color: TEXT }}>{view.dueLine}</p>
            )}
            {view.methods.length > 0 && (
                <ul aria-label={listLabel} style={{ margin: '.45rem 0 0', padding: 0 }}>
                    {view.methods.map((m) => (
                        <MethodRow key={m.type} method={m} linked={confirmation} primaryColor={primaryColor} />
                    ))}
                </ul>
            )}
            {view.instructions && (
                <p style={{ margin: '.45rem 0 0', fontSize: confirmation ? '.74rem' : '.7rem', color: '#5d463d', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{view.instructions}</p>
            )}
            {view.legacyLink && (confirmation && view.legacyLink.href ? (
                <a
                    href={view.legacyLink.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${view.legacyLink.actionLabel} (opens in a new tab)`}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, width: '100%', boxSizing: 'border-box', marginTop: '.5rem', background: '#f6ede2', color: primaryColor, borderRadius: 11, fontSize: '.74rem', fontWeight: 800, padding: '.55rem .8rem', textDecoration: 'none' }}
                >
                    {view.legacyLink.actionLabel} ↗
                </a>
            ) : confirmation ? (
                // A stored link that fails the shared https rule is still what the coordinator
                // entered, so it is shown — as text, never as something to tap.
                <p style={{ margin: '.45rem 0 0', fontSize: '.72rem', color: MUTED, overflowWrap: 'anywhere' }}>{LEGACY_LINK_LABEL}: {view.legacyLink.text}</p>
            ) : (
                <p style={{ margin: '.45rem 0 0', fontSize: '.7rem', color: MUTED }}>A payment link is shown after you order.</p>
            ))}
            {view.fallback && (
                <p style={{ margin: '.3rem 0 0', fontSize: confirmation ? '.74rem' : '.7rem', color: '#5d463d' }}>{view.fallback}</p>
            )}
        </>
    );

    if (!confirmation) {
        return (
            <div data-payment-section="order" style={{ marginTop: '.7rem', padding: '.6rem .75rem', background: '#faf6f1', border: '1px solid #eee2d6', borderRadius: 12, overflowWrap: 'anywhere', minWidth: 0 }}>
                <b style={{ fontSize: '.7rem', color: TEXT, textTransform: 'uppercase', letterSpacing: '.05em' }}>💵 How to pay</b>
                {body}
            </div>
        );
    }

    const total = Number.isFinite(Number(amountDue)) ? Number(amountDue) : null;
    return (
        <div data-payment-section="confirmation" style={{ margin: '.8rem 0', background: '#fff', border: `2px solid ${primaryColor}`, borderRadius: 18, padding: '.95rem 1.05rem', overflowWrap: 'anywhere', minWidth: 0 }}>
            <b style={{ fontSize: '.82rem', color: TEXT }}>💵 One last step — pay your coordinator</b>
            {total !== null && (
                <p style={{ margin: '.35rem 0 0', fontSize: '.76rem', color: '#5d463d' }}>
                    Amount due: <b>${total.toFixed(2)}</b>{orderRef ? <> for order <b>#{orderRef}</b></> : null}
                </p>
            )}
            {body}
            <p style={{ margin: '.6rem 0 0', fontSize: '.66rem', color: '#9a8075' }}>
                Payment goes to your coordinator, not through this page. Opening a payment app doesn&rsquo;t mark your order paid — your coordinator confirms it.
            </p>
        </div>
    );
}
