import { fundraiserIdentity } from '@/lib/fundraiserIdentityLine';

/**
 * PACKED-READY-WAVES-1 — "Fundraiser: <organization>", worded once for the lane and the slip.
 *
 * Rendered in two places that must agree: under the supporter's name on a Packed & Ready
 * row, and on the packing slip (the pre-handoff slip and the Delivery reprint share the one
 * slip page, so they get this line identically). The text comes from lib/fundraiserIdentityLine.ts;
 * where the NAME comes from is lib/supporterBoxManifest.ts's resolveOrganizationName — the
 * campaign's owning organization, never Order.customer.
 *
 * Renders NOTHING for an absent / blank name, so an ordinary order shows no line, no empty
 * line, and never the text "null" or "undefined".
 *
 * The supporter stays the primary identity: this line is one size smaller and lighter than
 * the name it sits under. It WRAPS (break-words, no truncate / no nowrap), so a long
 * organization name prints in full instead of being cut off at the page edge.
 */
export default function FundraiserIdentityLine({
    organizationName,
    variant,
}: {
    organizationName: string | null | undefined;
    variant: 'row' | 'slip';
}) {
    const identity = fundraiserIdentity(organizationName);
    if (!identity) return null;

    const className = variant === 'slip'
        ? 'text-[11px] leading-tight text-slate-600 break-words [overflow-wrap:anywhere] max-w-[4.4in]'
        : 'text-sm leading-snug text-indigo-700 dark:text-indigo-300 break-words mt-0.5';

    return (
        <div className={className} data-fundraiser-line={variant}>
            <span className="font-medium text-slate-500 dark:text-slate-400">{identity.prefix}</span>{' '}
            <span className="font-bold">{identity.name}</span>
        </div>
    );
}
