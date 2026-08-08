/**
 * FR-RETENTION-3 — HTML escaping for outreach email bodies.
 *
 * Mirrors the private escapeHtml() in lib/email.ts. Organization names, tenant
 * names and campaign names are database-controlled and must never be
 * interpolated into an email as raw markup.
 */
export function escapeOutreachHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
