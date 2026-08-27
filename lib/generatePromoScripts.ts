/**
 * Campaign-Specific Promo Script Generator
 *
 * Pure, deterministic, template-based copy generation.
 * No AI/LLM dependency — uses string templates with campaign data.
 *
 * Used by /api/promo-scripts/[token] to serve ready-to-copy messaging
 * for the Coordinator Portal Sales Toolkit.
 */

// ── Types ──────────────────────────────────────────────────

export type BundleSummary = {
    /** Menu display name — one summary per MENU, not per size variant. */
    name: string;
    /** The family-size price (or the only size's price). */
    price: number;
    /**
     * FR-COORD-123: the Serves-2 price, when the menu also comes in that
     * size. Rendered alongside `price` so a menu is advertised once with
     * both sizes, instead of appearing twice as two "bundles".
     */
    couplePrice?: number | null;
};

export type PromoScriptInput = {
    campaignName: string;
    organizationName: string;
    publicUrl: string;
    endDate?: string | null;   // ISO date string or null
    bundles: BundleSummary[];
};

export type PromoScriptsResponse = {
    campaignName: string;
    organizationName: string;
    publicUrl: string;
    scripts: {
        facebook: string;
        textMessage: string;
        emailBlurb: string;
        emailBlurbHtml: string;
    };
};

// ── Helpers ────────────────────────────────────────────────

function formatPrice(cents: number): string {
    // Prices stored as dollars (Decimal) in this codebase, not cents
    return `$${cents.toFixed(0)}`;
}

function formatBundleLine(b: BundleSummary): string {
    // Both sizes on one line when the menu comes in both — never the same
    // menu listed twice.
    if (b.couplePrice !== null && b.couplePrice !== undefined) {
        return `${b.name} – ${formatPrice(b.price)} (Family) / ${formatPrice(b.couplePrice)} (Serves 2)`;
    }
    return `${b.name} – ${formatPrice(b.price)}`;
}

function bundleListShort(bundles: BundleSummary[], max = 3): string {
    const show = bundles.slice(0, max);
    const lines = show.map(formatBundleLine);
    if (bundles.length > max) {
        lines.push(`and ${bundles.length - max} more option${bundles.length - max > 1 ? 's' : ''}`);
    }
    return lines.join('\n');
}

function bundleListInline(bundles: BundleSummary[], max = 3): string {
    const show = bundles.slice(0, max);
    // SMS-compact: "$125/$60" when the menu comes in both sizes.
    const parts = show.map(b => {
        const priceTag = b.couplePrice !== null && b.couplePrice !== undefined
            ? `${formatPrice(b.price)}/${formatPrice(b.couplePrice)}`
            : formatPrice(b.price);
        return `${b.name} (${priceTag})`;
    });
    if (bundles.length > max) {
        parts.push(`+ more`);
    }
    return parts.join(', ');
}

function deadlineLine(endDate?: string | null): string {
    if (!endDate) return '';
    try {
        const d = new Date(endDate);
        const formatted = d.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
        });
        return `Orders close ${formatted} — don't miss out!`;
    } catch {
        return '';
    }
}

function deadlineShort(endDate?: string | null): string {
    if (!endDate) return '';
    try {
        const d = new Date(endDate);
        const formatted = d.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
        });
        return `Ends ${formatted}!`;
    } catch {
        return '';
    }
}

// ── Script Generators ──────────────────────────────────────

function generateFacebook(input: PromoScriptInput): string {
    const { organizationName, publicUrl, endDate, bundles } = input;
    const deadline = deadlineLine(endDate);

    let post = `🍽️ Support ${organizationName} with easy freezer meals!\n\n`;
    post += `Stock your freezer AND support a great cause — it's a win-win. `;
    post += `Choose from delicious, ready-to-heat meal bundles:\n\n`;

    if (bundles.length > 0) {
        post += bundleListShort(bundles, 4) + '\n\n';
    }

    post += `🛒 Order online in minutes:\n${publicUrl}\n`;

    if (deadline) {
        post += `\n⏰ ${deadline}\n`;
    }

    post += `\nEvery order makes a difference. Share this with friends & family! ❤️`;

    return post;
}

function generateTextMessage(input: PromoScriptInput): string {
    const { organizationName, publicUrl, endDate, bundles } = input;
    const deadlineTag = deadlineShort(endDate);

    let msg = `Hey! 🍽️ ${organizationName} is running a freezer meal fundraiser. `;

    if (bundles.length > 0) {
        msg += `Easy meal bundles like ${bundleListInline(bundles, 2)}. `;
    } else {
        msg += `Delicious, ready-to-heat meals — super easy. `;
    }

    msg += `Order here: ${publicUrl}`;

    if (deadlineTag) {
        msg += ` ${deadlineTag}`;
    }

    return msg;
}

function generateEmailBlurb(input: PromoScriptInput): string {
    const { organizationName, publicUrl, endDate, bundles } = input;
    const deadline = deadlineLine(endDate);

    let email = `We're excited to share that ${organizationName} is hosting a freezer meal fundraiser! `;
    email += `It's easy — just pick your favorite meal bundles, place your order online, and stock your freezer with `;
    email += `delicious, ready-to-heat meals while supporting ${organizationName}.\n\n`;

    if (bundles.length > 0) {
        email += `Available bundles:\n`;
        email += bundleListShort(bundles, 4) + '\n\n';
    }

    email += `👉 Order Your Freezer Meals: ${publicUrl}\n`;

    if (deadline) {
        email += `\n${deadline}\n`;
    }

    email += `\nThank you for your support!`;

    return email;
}

function generateEmailBlurbHtml(input: PromoScriptInput): string {
    const { organizationName, publicUrl, endDate, bundles } = input;
    const deadline = deadlineLine(endDate);

    let html = `<p>We're excited to share that ${organizationName} is hosting a freezer meal fundraiser! `;
    html += `It's easy — just pick your favorite meal bundles, place your order online, and stock your freezer with `;
    html += `delicious, ready-to-heat meals while supporting ${organizationName}.</p>`;

    if (bundles.length > 0) {
        html += `<p><strong>Available bundles:</strong><br>`;
        const show = bundles.slice(0, 4);
        html += show.map(formatBundleLine).join('<br>');
        if (bundles.length > 4) {
            html += `<br>and ${bundles.length - 4} more option${bundles.length - 4 > 1 ? 's' : ''}`;
        }
        html += `</p>`;
    }

    html += `<p>👉 <a href="${publicUrl}" style="color:#6366f1;font-weight:bold;">Order Your Freezer Meals Here</a></p>`;

    if (deadline) {
        html += `<p>⏰ ${deadline}</p>`;
    }

    html += `<p>Thank you for your support!</p>`;

    return html;
}

// ── Main Export ─────────────────────────────────────────────

export function generatePromoScripts(input: PromoScriptInput): PromoScriptsResponse {
    return {
        campaignName: input.campaignName,
        organizationName: input.organizationName,
        publicUrl: input.publicUrl,
        scripts: {
            facebook: generateFacebook(input),
            textMessage: generateTextMessage(input),
            emailBlurb: generateEmailBlurb(input),
            emailBlurbHtml: generateEmailBlurbHtml(input),
        },
    };
}
