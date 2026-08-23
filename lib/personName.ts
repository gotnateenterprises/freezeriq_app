/**
 * FR-ACCEPTANCE-2A.2 — the first name to greet someone by.
 *
 * "Kaleb Hacker" -> "Kaleb". "  Jane Doe  " -> "Jane". "Cher" -> "Cher", a
 * single-name contact preserved rather than mangled. "" / null / undefined ->
 * null, so the caller supplies its own fallback ("there", "them") rather than
 * this module inventing tone it does not own.
 *
 * Deliberately not a name parser. It takes the first whitespace-delimited
 * token and nothing else — no titles, no suffixes, no attempt at multi-word
 * first names or non-Latin scripts. That is the right amount of intelligence
 * for "how do we address this person in a greeting", and the wrong amount for
 * "what is their legal first name" — a question this function does not answer
 * and a mistake here costs nothing worse than an imperfect greeting.
 *
 * Presentation only. The full name stored on the inquiry/contact row is never
 * touched by this — see lib/emailTemplates.ts and FunnelLeadsPanel.tsx for the
 * two places this is used to render a greeting or a button label.
 */
export function firstNameOf(fullName: string | null | undefined): string | null {
    const trimmed = (fullName ?? '').trim();
    if (!trimmed) return null;
    // trimmed is non-empty and has no leading/trailing whitespace, so this
    // split always yields at least one non-empty token.
    return trimmed.split(/\s+/)[0];
}
