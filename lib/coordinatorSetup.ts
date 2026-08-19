/**
 * FR-FLOW-3 — the rules a coordinator's setup submission must satisfy.
 *
 * Pure functions, so the rules can be exercised for real rather than asserted
 * against source text. Nothing here reads a clock, a session, or the database.
 *
 * SCOPE BOUNDARY
 * A coordinator confirms LOGISTICS. Everything the tenant owns — the confirmed
 * delivery date, the supporter deadline, the organization share, the required
 * selection count, the candidate pool — is absent from this module entirely,
 * because the safest way to refuse a field is never to accept it.
 */

/** Bounded so a single field cannot be used to bloat a row or a rendered page. */
export const CHECKS_PAYABLE_MAX = 120;
export const PICKUP_LOCATION_MAX = 300;
export const DELIVERY_TIME_MAX = 80;
export const PAYMENT_INSTRUCTIONS_MAX = 1000;
export const PAYMENT_LINK_MAX = 500;

export type SetupRefusal = { ok: false; code: string; error: string };
export type SetupOk<T> = { ok: true } & T;

export function isSetupRefusal(v: { ok: boolean }): v is SetupRefusal {
    return v.ok === false;
}

/**
 * Bounded free text.
 *
 * Deliberately does NOT strip or escape markup. Escaping at the boundary is how
 * a value ends up double-escaped in one surface and raw in another; React escapes
 * on render, and the flyer/packet routes render through the same components. What
 * this rejects is the shape that could only be an attack — a raw `<` — so an
 * apostrophe in "St. John's" survives untouched while `<script>` never lands.
 */
function boundedText(
    value: unknown,
    max: number,
    field: string,
    label: string
): SetupOk<{ value: string | null }> | SetupRefusal {
    if (value === null || value === undefined || value === '') return { ok: true, value: null };
    if (typeof value !== 'string') {
        return { ok: false, code: `${field}_invalid`, error: `${label} must be text.` };
    }
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: null };
    if (trimmed.length > max) {
        return { ok: false, code: `${field}_too_long`, error: `${label} must be ${max} characters or fewer.` };
    }
    if (/[<>]/.test(trimmed)) {
        return { ok: false, code: `${field}_unsafe`, error: `${label} cannot contain < or >.` };
    }
    return { ok: true, value: trimmed };
}

export function checkChecksPayable(v: unknown) {
    return boundedText(v, CHECKS_PAYABLE_MAX, 'checks_payable', 'Who checks are payable to');
}

export function checkPickupLocation(v: unknown) {
    return boundedText(v, PICKUP_LOCATION_MAX, 'pickup_location', 'The pickup or delivery location');
}

/**
 * The pickup/delivery time, as free text.
 *
 * "4:45 PM", "3–5 PM" and "TBD" are all real answers a coordinator gives, and a
 * window is not a clock reading, so this is never parsed into a time. It is also
 * never merged into the location: a location field holding "Gym, 4:45 PM" cannot
 * be printed, sorted or corrected as two separate facts.
 */
export function checkDeliveryTime(v: unknown) {
    return boundedText(v, DELIVERY_TIME_MAX, 'delivery_time', 'The pickup or delivery time');
}

export function checkPaymentInstructions(v: unknown) {
    return boundedText(v, PAYMENT_INSTRUCTIONS_MAX, 'payment_instructions', 'Payment instructions');
}

/**
 * An optional PUBLIC payment page.
 *
 * Informational only — FreezerIQ processes no payment here, and following this
 * link never marks an order paid. Fundraiser money is still collected offline by
 * the coordinator.
 *
 * Only https is accepted. `javascript:` and `data:` are script-execution vectors
 * in an href; `file:` reaches the viewer's own disk; plain `http` would downgrade
 * a payment page a supporter is about to trust. Credentials embedded in the URL
 * are refused outright rather than stripped, because a coordinator who pasted one
 * needs to know it was there.
 */
export function checkPaymentLink(v: unknown): SetupOk<{ value: string | null }> | SetupRefusal {
    if (v === null || v === undefined || v === '') return { ok: true, value: null };
    if (typeof v !== 'string') {
        return { ok: false, code: 'payment_link_invalid', error: 'Enter a valid payment link.' };
    }
    const raw = v.trim();
    if (raw === '') return { ok: true, value: null };
    if (raw.length > PAYMENT_LINK_MAX) {
        return { ok: false, code: 'payment_link_too_long', error: `Payment link must be ${PAYMENT_LINK_MAX} characters or fewer.` };
    }

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, code: 'payment_link_invalid', error: 'Enter a full link starting with https://' };
    }

    if (url.protocol !== 'https:') {
        return { ok: false, code: 'payment_link_scheme', error: 'Payment links must start with https://' };
    }
    if (url.username || url.password) {
        return { ok: false, code: 'payment_link_credentials', error: 'Remove the username or password from the payment link.' };
    }
    if (!url.hostname || !url.hostname.includes('.')) {
        return { ok: false, code: 'payment_link_invalid', error: 'Enter a full link starting with https://' };
    }

    return { ok: true, value: url.toString() };
}

/* ── The whole logistics payload ─────────────────────────────────────────── */

export interface CoordinatorSetupInput {
    checksPayable?: unknown;
    pickupLocation?: unknown;
    deliveryTime?: unknown;
    paymentInstructions?: unknown;
    paymentLink?: unknown;
}

export interface CoordinatorSetupValues {
    checks_payable: string | null;
    pickup_location: string | null;
    delivery_time: string | null;
    payment_instructions: string | null;
    external_payment_link: string | null;
}

/**
 * Validate every logistics field, refusing on the first problem.
 *
 * All five are optional: a fundraiser whose pickup details are genuinely still
 * being arranged should not be blocked from opening for orders. What is NOT
 * optional is the bundle selection, which is validated separately — that is the
 * thing supporters actually buy.
 */
export function checkCoordinatorSetup(
    input: CoordinatorSetupInput
): SetupOk<{ values: CoordinatorSetupValues }> | SetupRefusal {
    const checks = checkChecksPayable(input.checksPayable);
    if (isSetupRefusal(checks)) return checks;
    const location = checkPickupLocation(input.pickupLocation);
    if (isSetupRefusal(location)) return location;
    const time = checkDeliveryTime(input.deliveryTime);
    if (isSetupRefusal(time)) return time;
    const instructions = checkPaymentInstructions(input.paymentInstructions);
    if (isSetupRefusal(instructions)) return instructions;
    const link = checkPaymentLink(input.paymentLink);
    if (isSetupRefusal(link)) return link;

    return {
        ok: true,
        values: {
            checks_payable: checks.value,
            pickup_location: location.value,
            delivery_time: time.value,
            payment_instructions: instructions.value,
            external_payment_link: link.value,
        },
    };
}

/**
 * The message a coordinator sees once supporters have started ordering.
 *
 * Names no order id, no order count and no internal state — it tells them the
 * one true thing and who to ask.
 */
export const BUNDLE_SELECTION_LOCKED_MESSAGE =
    'Orders have already started, so bundle selections are locked. Contact the fundraiser organizer if a correction is needed.';
