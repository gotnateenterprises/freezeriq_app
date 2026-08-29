/**
 * FR-SUPPORTER-CONTACT-1 — the ONE authority for turning a fundraiser
 * purchaser's separate first/last name into a display string.
 *
 * WHY THIS EXISTS
 * ────────────────
 * The supporter checkout form used to collect a single "Full Name" field
 * placed directly next to Phone — a purchaser named Matilda West naturally
 * read the two side-by-side boxes as First/Last and typed "Matilda" into
 * Name and "West" into Phone. The form now collects First Name and Last Name
 * as genuinely separate fields (see FundraiserClient.tsx), and every surface
 * that needs a full display name — Order.customer_name (kept for backward
 * compatibility with every existing reader), Customer.name, the coordinator
 * notification, the confirmation email — combines them through this ONE
 * function rather than each writing its own concatenation rule.
 *
 * Deliberately not a name parser in the other direction: this never SPLITS a
 * combined string (that risk — guessing where a historical full name breaks
 * into first/last — is exactly what FR-SUPPORTER-CONTACT-1 was told not to
 * do to old rows). It only ever COMBINES two already-distinct values.
 */
export function purchaserDisplayName(
    firstName: string | null | undefined,
    lastName: string | null | undefined
): string {
    const first = (firstName ?? '').trim();
    const last = (lastName ?? '').trim();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return 'A supporter';
}
