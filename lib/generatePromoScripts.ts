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
    name: string;
    price: number;
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
    };
};

// ── Helpers ────────────────────────────────────────────────

function formatPrice(cents: number): string {
    // Prices stored as dollars (Decimal) in this codebase, not cents
    return `$${cents.toFixed(0)}`;
}

function formatBundleLine(b: BundleSummary): string {
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
    const parts = show.map(b => `${b.name} (${formatPrice(b.price)})`);
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

    email += `Place your order here:\n${publicUrl}\n`;

    if (deadline) {
        email += `\n${deadline}\n`;
    }

    email += `\nThank you for your support!`;

    return email;
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
        },
    };
}
