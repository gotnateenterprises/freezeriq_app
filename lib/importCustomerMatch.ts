/**
 * SEC-DATA-INTEGRITY-1 — which identifiers an imported or synced row may be
 * matched to an existing customer on.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ───────────────────────────────────────
 *
 * Prisma DROPS `undefined` from a where-clause. A match branch written as
 *
 *     { contact_email: email ? email : undefined }     // or:  email ? {…} : {}
 *
 * therefore becomes `{}` when the row carries no email — and `{}` matches EVERY
 * row. Inside an OR that silently turned "this customer, by id or by email" into
 * "any customer in the tenant", and the importer then overwrote (or attached a
 * new fundraiser to, or linked a synced order to) whichever customer the
 * database happened to return first. app/api/training/route.ts documents the
 * same Prisma behaviour, found by SEC-PUBLIC-ROUTE-1.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * An identifier joins a match only when it is actually present: a string with
 * something other than whitespace in it. A row with no present identifier is
 * never looked up at all — there is no such thing as an empty OR here.
 *
 * And a match must be ONE customer. When the identifiers a row carries lead to
 * more than one existing customer, nothing about the row says which one it
 * means, so the caller reports the row instead of guessing.
 */

/**
 * The value itself when it carries a usable identifier, otherwise null.
 *
 * Deliberately returns the original string, not a trimmed copy: each caller
 * keeps exactly the equality it already used for a present value. Only the
 * blank, whitespace-only and missing cases change — they stop matching anything.
 */
export function presentIdentifier(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    return raw.trim().length > 0 ? raw : null;
}

/** One distinct existing customer, none, or more than one — never a guess. */
export type ImportCustomerMatch<T> =
    | { kind: 'none' }
    | { kind: 'one'; customer: T }
    | { kind: 'ambiguous'; count: number };

export function resolveImportCustomerMatch<T extends { id: string }>(
    rows: readonly (T | null | undefined)[] | null | undefined,
): ImportCustomerMatch<T> {
    const distinct = new Map<string, T>();
    for (const row of rows ?? []) {
        if (row && !distinct.has(row.id)) distinct.set(row.id, row);
    }
    if (distinct.size === 0) return { kind: 'none' };
    if (distinct.size === 1) return { kind: 'one', customer: [...distinct.values()][0] };
    return { kind: 'ambiguous', count: distinct.size };
}
