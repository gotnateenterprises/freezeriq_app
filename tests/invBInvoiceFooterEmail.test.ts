/**
 * INV-B, owner-acceptance correction — the invoice PDF footer's "Questions?
 * Email:" line.
 *
 * THE BUG
 *
 * app/invoices/page.tsx read `branding.user.email` for the footer contact line.
 * That value comes from app/api/tenant/branding/route.ts's GET handler, which
 * resolves it via `tenant_branding.user_id` — "the business admin or any user
 * in this business" per that file's own comment. In Production this is the
 * login email of whichever admin happens to own the TenantBranding row, which
 * for My Freezer Chef is the super admin's own account
 * (nate475@gmail.com) — not a tenant identity at all. It read as "the
 * customer's email" in the owner's acceptance test purely because the test
 * fundraiser's customer contact happened to be set to that same address; the
 * two fields were never actually connected.
 *
 * THE FIX
 *
 * The footer now reads `branding.contact_email`, which is `Business.contact_email`
 * — an existing, owner-editable field (the "Contact Email" input in
 * components/admin/BrandingSettings.tsx) that GET /api/tenant/branding already
 * returns. That GET handler already resolves the EFFECTIVE tenant from the
 * session (SEC-TENANT-1), so View-As correctness is inherited for free; nothing
 * server-side needed to change.
 *
 * WHAT THIS FILE PROVES
 *
 * The route-level assertions are EXECUTED against the real handler with mocked
 * Prisma. There is no component-rendering harness in this repo (no jsdom, no
 * @testing-library, jest runs testEnvironment: 'node'), so the PDF-generation
 * code itself is asserted structurally against its executable source — comments
 * and prose stripped first, exactly as tests/invBCloseoutTaxUi.test.ts already
 * established for this same constraint. A mutation battery proves those
 * structural assertions are load-bearing, not decorative.
 */

process.env.AUTH_SECRET = 'test-secret-inv-b-footer';

const PAGE = 'app/invoices/page.tsx';
const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

/** Comments/prose stripped, so a docstring describing the fix cannot fake a match. */
const code = (p: string): string => {
    const s = read(p);
    return s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
};

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTED — GET /api/tenant/branding returns the correct, tenant-scoped value
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/tenant/branding: contact_email is Business.contact_email, not a user email', () => {
    const calls: Array<{ model: string; args: any }> = [];
    let businessRow: any;
    let brandingRow: any;

    const mockAuth = jest.fn();
    jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
    jest.mock('@/lib/db', () => ({
        prisma: {
            business: {
                findUnique: async (args: any) => {
                    calls.push({ model: 'business', args });
                    return businessRow;
                },
            },
            tenantBranding: {
                findFirst: async (args: any) => {
                    calls.push({ model: 'tenantBranding', args });
                    return brandingRow;
                },
            },
        },
    }));

    const TENANT_A = 'biz-aaaa';
    const TENANT_B = 'biz-bbbb';
    const ADMIN_LOGIN_EMAIL = 'super-admin-login@platform.test';   // the WRONG authority
    const TENANT_A_CONTACT = 'hello@tenant-a-business.test';        // the RIGHT authority
    const TENANT_B_CONTACT = 'support@tenant-b-business.test';

    beforeEach(() => {
        calls.length = 0;
        mockAuth.mockReset();
    });

    it('returns the BUSINESS contact_email, which differs from the branding owner\'s own login email', async () => {
        mockAuth.mockResolvedValue({
            user: { id: 'user-admin', businessId: TENANT_A, isSuperAdmin: false },
        });
        businessRow = { slug: 's', name: 'Tenant A', contact_email: TENANT_A_CONTACT };
        brandingRow = {
            business_name: 'Tenant A', primary_color: '#000',
            user: { email: ADMIN_LOGIN_EMAIL, phone: null, address: null },
        };

        const { GET } = await import('@/app/api/tenant/branding/route');
        const res = await GET({} as any);
        const body = await res.json();

        expect(body.contact_email).toBe(TENANT_A_CONTACT);
        expect(body.contact_email).not.toBe(ADMIN_LOGIN_EMAIL);
        expect(body.user.email).toBe(ADMIN_LOGIN_EMAIL);   // still present, just not what the footer must use
    });

    it('Super Admin View As Tenant B: response carries Tenant B\'s contact_email, never the admin\'s', async () => {
        mockAuth.mockResolvedValue({
            user: { id: 'user-super', businessId: TENANT_B, isSuperAdmin: true },
        });
        businessRow = { slug: 'b', name: 'Tenant B', contact_email: TENANT_B_CONTACT };
        brandingRow = {
            business_name: 'Tenant B', primary_color: '#000',
            user: { email: ADMIN_LOGIN_EMAIL, phone: null, address: null },
        };

        const { GET } = await import('@/app/api/tenant/branding/route');
        const body = await (await GET({} as any)).json();

        expect(body.contact_email).toBe(TENANT_B_CONTACT);
        expect(body.contact_email).not.toBe(ADMIN_LOGIN_EMAIL);
        expect(calls.find((c) => c.model === 'business')!.args.where.id).toBe(TENANT_B);
    });

    it('no configured tenant contact email: returns empty string, never the branding owner\'s email', async () => {
        // The real shape of "Bob Test" in Production: Business.contact_email IS NULL.
        mockAuth.mockResolvedValue({ user: { id: 'u', businessId: TENANT_A, isSuperAdmin: false } });
        businessRow = { slug: 's', name: 'Tenant A', contact_email: null };
        brandingRow = {
            business_name: 'Tenant A', primary_color: '#000',
            user: { email: ADMIN_LOGIN_EMAIL, phone: null, address: null },
        };

        const { GET } = await import('@/app/api/tenant/branding/route');
        const body = await (await GET({} as any)).json();

        expect(body.contact_email).toBe('');
        expect(body.contact_email).not.toBe(ADMIN_LOGIN_EMAIL);
    });

    it('no configured tenant contact email AND no branding row yet: still empty, not a fallback identity', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u', businessId: TENANT_A, isSuperAdmin: false } });
        businessRow = { slug: 's', name: 'Tenant A', contact_email: null };
        brandingRow = null;

        const { GET } = await import('@/app/api/tenant/branding/route');
        const body = await (await GET({} as any)).json();

        expect(body.contact_email).toBe('');
        expect(body.user).toBeUndefined();
    });

    it('NO branding row yet, but Business.contact_email IS set: the early-return path still uses it', async () => {
        // The route has TWO return statements — one for a tenant that has never
        // configured TenantBranding at all, one for a tenant that has. Both must
        // resolve contact_email from the SAME authority. This case is what makes
        // that true: contact_email here is non-empty precisely where branding.user
        // does not exist at all (brandingRow is null), so a mutant reading
        // branding?.user?.email in this branch would return '' — distinguishably
        // wrong — rather than coincidentally matching, the way it would if this
        // business also had no contact_email configured.
        mockAuth.mockResolvedValue({ user: { id: 'u', businessId: TENANT_A, isSuperAdmin: false } });
        businessRow = { slug: 's', name: 'Tenant A', contact_email: TENANT_A_CONTACT };
        brandingRow = null;

        const { GET } = await import('@/app/api/tenant/branding/route');
        const body = await (await GET({} as any)).json();

        expect(body.contact_email).toBe(TENANT_A_CONTACT);
        expect(body.user).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL — the PDF footer's field authority (no rendering harness exists)
// ═══════════════════════════════════════════════════════════════════════════

describe('invoice PDF: footer contact authority', () => {
    it('the footer no longer reads branding.user.email', () => {
        const c = code(PAGE);
        expect(c).not.toMatch(/branding\.user\.email/);
        expect(c).not.toMatch(/branding\?\.user\.email/);
    });

    it('the footer reads the tenant\'s own contact_email', () => {
        const c = code(PAGE);
        expect(c).toMatch(/const tenantContactEmail = branding\?\.contact_email \|\| '';/);
        expect(c).toMatch(/Questions\? Email: \$\{tenantContactEmail\}/);
    });

    it('the Branding type declares contact_email as its own field', () => {
        const c = code(PAGE);
        expect(c).toMatch(/interface Branding \{[\s\S]*?contact_email\?: string;[\s\S]*?\}/);
    });

    it('the entire footer contact block is gated on tenantContactEmail — omitted, not fallback, when absent', () => {
        const c = code(PAGE);
        const idx = c.indexOf('const tenantContactEmail');
        const block = c.slice(idx, idx + 500);
        expect(block).toMatch(/if \(tenantContactEmail\) \{/);
        // Phone/address are still inside that same guard, so a tenant with no
        // contact email does not print a naked "Phone:" line under a label that
        // promises an email.
        expect(block).toMatch(/branding\?\.user\?\.phone/);
        expect(block).toMatch(/branding\?\.user\?\.address/);
    });

    it('no fallback to session, logged-in user, or super-admin identity anywhere in PDF generation', () => {
        const c = code(PAGE);
        const pdfFn = c.slice(c.indexOf('const generateInvoicePDF'), c.indexOf('const handleDownloadPDF'));
        expect(pdfFn).not.toMatch(/session\??\.user/);
        expect(pdfFn).not.toMatch(/isSuperAdmin/);
    });

    it('no fallback to the invoice customer\'s email for the footer', () => {
        const c = code(PAGE);
        const pdfFn = c.slice(c.indexOf('const generateInvoicePDF'), c.indexOf('const handleDownloadPDF'));
        // customer.contact_email legitimately appears ONCE, for BILL TO — never
        // wired into the tenantContactEmail/footer construction.
        const billToUses = (pdfFn.match(/invoice\.customer\.contact_email/g) || []).length;
        expect(billToUses).toBe(1);
        expect(pdfFn.indexOf('invoice.customer.contact_email')).toBeLessThan(pdfFn.indexOf('tenantContactEmail'));
    });
});

describe('BILL TO and SEND TO remain the invoice recipient — unaffected by the footer fix', () => {
    it('BILL TO still renders invoice.customer.contact_email', () => {
        const c = code(PAGE);
        expect(c).toMatch(/doc\.text\(invoice\.customer\.contact_email, 40, billToY\);/);
    });

    it('the compose-email SEND TO still targets the invoice customer, not the tenant', () => {
        const c = code(PAGE);
        expect(c).toMatch(/to: selectedInvoice\.customer\.contact_email,/);
        expect(c).not.toMatch(/to: branding/);
    });

    it('handleEmailInvoice still guards on the CUSTOMER having an email, not the tenant', () => {
        const c = code(PAGE);
        const fn = c.slice(c.indexOf('const handleEmailInvoice'), c.indexOf('const handleMarkPaid'));
        expect(fn).toMatch(/if \(!invoice\?\.customer\?\.contact_email\)/);
    });
});

describe('financial figures and layout are untouched by this correction', () => {
    it('every dollar-figure and label from the reviewed INV-B PDF is still present verbatim', () => {
        const c = code(PAGE);
        for (const marker of [
            'Subtotal:',
            'Fundraiser Profit (',
            'doc.text(\'Tax:\', 40, y);',
            'Final Balance Due to',
            'Congratulations! Your organization earned:',
            'itemsSubtotal - profitAmount + taxAmountValue',
        ]) {
            expect(c).toContain(marker);
        }
    });

    it('the green organization-earned treatment is untouched', () => {
        const c = code(PAGE);
        expect(c).toMatch(/setTextColor\(22, 163, 74\)/);
    });
});
