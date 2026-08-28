/**
 * FR-SHARE-COPY-1 — the ONE authority for coordinator fundraiser share copy
 * (Email, Text/SMS, Facebook, native Web Share).
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
 *
 * Every channel built its own copy: Email/Facebook/Native shared one generic
 * message (lib/coordinatorLaunch.buildShareMessage) that never named the
 * tenant's actual brand or what was actually for sale, and Text/SMS built a
 * SECOND, independent template (buildShareSms) that hardcoded the literal
 * string "freezer meal fundraiser" — ignoring the tenant's brand entirely.
 * Neither ever mentioned the campaign's selected Bundle families, pickup/
 * delivery logistics, or how to reach the coordinator.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────
 *
 * One normalized fact object (ShareFacts) resolved ONCE, server-side, per
 * campaign. Channel formatting differs — a locked template per channel — but
 * every fact comes from the same source and none is invented client-side.
 * Multi-tenant throughout: nothing here hardcodes any particular tenant's
 * brand; ShareFacts.tenantDisplayName is the caller's resolved value
 * (lib/tenantBrand.customerFacingBusinessName), always.
 */

/** The normalized facts every channel formats from. Resolved server-side. */
export interface ShareFacts {
    /** The fundraiser organization's name (Customer.name). Never blank. */
    organizationName: string;
    /** The FreezerIQ tenant's customer-facing brand (display_name -> name). Never blank. */
    tenantDisplayName: string;
    /**
     * The campaign's ACTUAL selected Bundle families, de-duplicated (a
     * Serves-5/Serves-2 sibling pair counts once), in campaign selection
     * order. Empty when the campaign has no selected families to show —
     * callers must gracefully omit the bundle section rather than invent one.
     */
    bundleFamilyNames: string[];
    /** The canonical supporter-facing fundraiser URL. Never blank. */
    orderUrl: string;
    /** "Tuesday, October 27", or null when the campaign has no usable deadline. */
    deadlineLabel: string | null;
    /** The resolved coordinator's name, or null when none is on file. */
    coordinatorName: string | null;
    /** The resolved coordinator's email, or null when none is on file. */
    coordinatorEmail: string | null;
    /**
     * Pre-formatted "Date: …" / "Time: …" / "Location: …" lines — only the
     * ones actually configured. Empty when nothing is configured.
     */
    pickupDeliveryLines: string[];
}

/** "• Fall Comfort Bundle\n• Fall Keto Bundle" — Email/Facebook style. */
export function formatBundleBulletList(names: readonly string[]): string {
    return names.map((n) => `• ${n}`).join('\n');
}

/** "Fall Comfort Bundle, Fall Keto Bundle" — SMS style, keeps the message short. */
export function formatBundleCompactList(names: readonly string[]): string {
    return names.join(', ');
}

/**
 * "Questions? Contact NAME at EMAIL." / "Questions? Contact NAME." /
 * "Questions? Contact EMAIL." / null.
 *
 * Used by the single-line inline forms (SMS, Facebook). Never invents a
 * placeholder — the caller omits the whole line when this returns null.
 */
function formatInlineContact(name: string | null, email: string | null): string | null {
    const n = (name ?? '').trim();
    const e = (email ?? '').trim();
    if (n && e) return `Questions? Contact ${n} at ${e}.`;
    if (n) return `Questions? Contact ${n}.`;
    if (e) return `Questions? Contact ${e}.`;
    return null;
}

/** The Email template's multi-line contact block, or null when there is nothing to show. */
function formatEmailContactLines(name: string | null, email: string | null): string[] | null {
    const n = (name ?? '').trim();
    const e = (email ?? '').trim();
    const lines = [n, e].filter(Boolean);
    return lines.length ? lines : null;
}

/** Joins non-empty blocks with a blank line between them, the Email/Facebook paragraph style. */
function joinBlocks(blocks: Array<string | null | undefined>): string {
    return blocks.filter((b): b is string => Boolean(b && b.length)).join('\n\n');
}

/**
 * PART F — the locked coordinator Email template.
 *
 * The bundle section (and the sentence that follows it, which refers to
 * "each bundle") is omitted as one unit when the campaign has no selected
 * families to list — a sentence about bundles nobody selected would be a
 * lie, not a fallback.
 */
export function buildFundraiserShareEmail(facts: ShareFacts): { subject: string; body: string } {
    const org = facts.organizationName;
    const tenant = facts.tenantDisplayName;

    const subject = `Support ${org} with a ${tenant} Fundraiser!`;

    const bundleBlock = facts.bundleFamilyNames.length
        ? `For this fundraiser, you can choose from:\n${formatBundleBulletList(facts.bundleFamilyNames)}`
        : null;
    const bundleFollowUp = facts.bundleFamilyNames.length
        ? 'Each bundle includes a variety of meals you can view in full at the fundraiser page, along with pricing, serving options, and other important details.'
        : null;

    const deadlineLine = facts.deadlineLabel
        ? `Please place your order by ${facts.deadlineLabel}.`
        : null;

    const pickupBlock = facts.pickupDeliveryLines.length
        ? `Pickup/Delivery Information:\n${facts.pickupDeliveryLines.join('\n')}`
        : null;

    const contactLines = formatEmailContactLines(facts.coordinatorName, facts.coordinatorEmail);
    const contactBlock = contactLines
        ? `If you have questions about the fundraiser, please contact:\n${contactLines.join('\n')}`
        : null;

    const body = joinBlocks([
        `${org} is holding a ${tenant} fundraiser, and we'd love your support!`,
        `${tenant} offers convenient meal bundles designed to make busy mealtimes easier — while helping local organizations raise money at the same time.`,
        bundleBlock,
        bundleFollowUp,
        `Shop the ${org} Fundraiser:\n${facts.orderUrl}`,
        deadlineLine,
        pickupBlock,
        contactBlock,
        `Thank you for supporting ${org}!`,
    ]);

    return { subject, body };
}

/**
 * PART I — the locked Text/SMS template. Shorter on purpose: no pickup/
 * delivery logistics (Part I: "Do not force pickup/delivery logistics into
 * SMS if doing so makes the message unwieldy") — the fundraiser page already
 * has the full detail, and the URL is never dropped to make room.
 */
export function buildFundraiserShareSms(facts: ShareFacts): string {
    const bundleLines = facts.bundleFamilyNames.length
        ? `Available bundles:\n${formatBundleCompactList(facts.bundleFamilyNames)}`
        : null;
    const deadlineLine = facts.deadlineLabel ? `Order by ${facts.deadlineLabel}.` : null;
    const contactLine = formatInlineContact(facts.coordinatorName, facts.coordinatorEmail);

    const lines = [
        `Support ${facts.organizationName} through their ${facts.tenantDisplayName} fundraiser!`,
        bundleLines,
        deadlineLine,
        'See the meals, pricing and fundraiser details here:',
        facts.orderUrl,
        contactLine,
    ].filter((l): l is string => Boolean(l && l.length));

    return lines.join('\n');
}

/**
 * PART J — the locked Facebook/social template. No hashtags (none are
 * product-configured today), no tenant-specific branding beyond the resolved
 * ShareFacts.
 */
export function buildFundraiserShareFacebook(facts: ShareFacts): string {
    const org = facts.organizationName;
    const tenant = facts.tenantDisplayName;

    const bundleBlock = facts.bundleFamilyNames.length
        ? `Available for this fundraiser:\n${formatBundleBulletList(facts.bundleFamilyNames)}`
        : null;
    const deadlineLine = facts.deadlineLabel ? `Orders are due ${facts.deadlineLabel}.` : null;
    const contactLine = formatInlineContact(facts.coordinatorName, facts.coordinatorEmail);

    return joinBlocks([
        `Help support ${org}! 🎉`,
        `They're holding a ${tenant} fundraiser featuring convenient meal bundles for busy families.`,
        bundleBlock,
        deadlineLine,
        `See the meals, pricing, serving options and fundraiser details here:\n${facts.orderUrl}`,
        contactLine,
        `Thank you for supporting ${org}!`,
    ]);
}

/**
 * Native Web Share (`navigator.share`) reaches Messages, WhatsApp, Mail and
 * more from one sheet — there is no single "right" length constraint the way
 * SMS has one, so it reuses the fuller Facebook-style body rather than the
 * SMS-compact one. Title matches the Email subject for a consistent voice.
 */
export function buildFundraiserShareNative(facts: ShareFacts): { title: string; text: string } {
    return {
        title: `Support ${facts.organizationName} with a ${facts.tenantDisplayName} Fundraiser!`,
        text: buildFundraiserShareFacebook(facts),
    };
}
