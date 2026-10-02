/**
 * SEC-DATA-INTEGRITY-1 — which identifiers an imported or synced row may be
 * matched to an existing customer on.
 *
 * ── WHAT THE OLD LOOKUPS DID ────────────────────────────────────────────────
 *
 * They were one findFirst over an OR whose email branch was written as
 *
 *     { contact_email: email ? email : undefined }     // or:  email ? {…} : {}
 *
 * Prisma drops `undefined`, so for a row with no email that branch is `{}`.
 * MEASURED on Postgres with the Prisma client this repo ships (5.22.0, for
 * SEC-DATA-INTEGRITY-1): an empty branch INSIDE an OR is ignored — `OR [x, {}]`
 * behaves exactly like `OR [x]`, and `OR [{}]` matches nothing. (At the TOP
 * level the same `undefined` removes the condition and matches every row: the
 * class of bug SEC-PUBLIC-ROUTE-1 fixed.) So a blank email did not, in practice,
 * match an arbitrary customer — but the lookup's correctness rested on
 * undocumented handling of an empty branch, which is not a contract.
 *
 * What did go wrong is the other half of that OR: findFirst over several
 * identifiers returns whichever matching row the database hands back first.
 * When the external id named one customer and the email another — or several
 * customers shared the email — the import overwrote (or attached a fundraiser
 * to) one of them arbitrarily.
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
