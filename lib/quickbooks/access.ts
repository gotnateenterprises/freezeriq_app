/**
 * QB-INVOICE-1A — who may manage a tenant's QuickBooks connection.
 *
 * Connecting QuickBooks hands FreezerIQ standing access to a company's books,
 * and disconnecting it stops invoicing. Both are owner-level decisions, so the
 * rule is: the tenant's own ADMIN, acting as themselves.
 *
 *   - CHEF, DRIVER and any other role are refused.
 *   - A super admin VIEWING AS another tenant is refused even if their role
 *     string is ADMIN. View As exists to inspect a tenant, not to attach an
 *     accounting company to one; `role` is the super admin's own role and says
 *     nothing about authority inside the viewed tenant.
 *
 * This deliberately differs from lib/campaignCloseout.ts, where a super admin is
 * authorised regardless of role: closeout acts on FreezerIQ data, whereas this
 * grants a third party's credentials to a tenant.
 *
 * Plain fields rather than a session type so it is directly testable; strict
 * comparisons so a lowercased role or a truthy-but-not-true flag never opens it.
 */
export function mayManageQuickBooks(user: {
    id?: unknown;
    role?: unknown;
    businessId?: unknown;
    baseBusinessId?: unknown;
    isViewingAsTenant?: unknown;
} | null | undefined): boolean {
    if (!user) return false;
    if (typeof user.id !== 'string' || !user.id) return false;
    if (user.role !== 'ADMIN') return false;
    if (typeof user.businessId !== 'string' || !user.businessId) return false;
    if (user.isViewingAsTenant !== false && user.isViewingAsTenant !== undefined) return false;
    if (user.baseBusinessId !== undefined && user.baseBusinessId !== user.businessId) return false;
    return true;
}
