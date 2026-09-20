/**
 * INTUIT PRODUCTION READINESS — the PUBLIC QuickBooks disconnect information page.
 *
 * `https://www.freezeriqapp.com/legal/disconnect` is registered with Intuit as the app's Disconnect URL.
 * Intuit may open it with `?realmId=...` appended, and anyone may open it at any time. It must therefore be
 * readable without signing in and must do NOTHING: no database access, no QuickBooks call, no token access,
 * no realm lookup, no state change of any kind.
 *
 * Source-string assertions, as everywhere else in this repository: there is no @testing-library/react and no
 * jsdom (jest.config.ts pins testEnvironment 'node'), so a presentational page is proven structurally — which
 * is the stronger proof here anyway, because "this file imports no database client and declares no action"
 * cannot be demonstrated by rendering it once.
 */
import fs from 'fs';
import path from 'path';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = 'app/legal/disconnect/page.tsx';
const AUTH_CONFIG = 'auth.config.ts';
const DISCONNECT_ROUTE = 'app/api/integrations/quickbooks/disconnect/route.ts';

describe('QuickBooks disconnect page · public and inert', () => {
    it('A: it exists as a page, needs no session, and is not one of the gated application paths', () => {
        const code = R(PAGE);
        expect(code).toContain('export default function QuickBooksDisconnectPage()');

        // Publicness is decided by the auth callback: only the listed application paths require a session.
        const auth = strip(R(AUTH_CONFIG));
        const gate = auth.slice(auth.indexOf('const isOnDashboard'), auth.indexOf('if (isOnDashboard)'));
        expect(gate).toContain("nextUrl.pathname.startsWith('/settings')"); // the real disconnect IS gated
        expect(gate).not.toContain('/legal'); // this page is not
        // The page itself never consults a session.
        expect(code).not.toMatch(/from '@\/auth'|auth\(\)|getServerSession|useSession|cookies\(\)|headers\(\)/);
    });

    it('B: a query string cannot reach it — including ?realmId=', () => {
        // Comments explain WHY the query string is ignored, so the executable code is what is asserted here.
        const code = strip(R(PAGE));
        // Statically rendered at build time: there is no request-time context to read a query string from.
        expect(code).toContain("export const dynamic = 'force-static'");
        // And it takes no props, so Next.js never hands it searchParams or params.
        expect(code).toMatch(/export default function QuickBooksDisconnectPage\(\)/);
        expect(code).not.toMatch(/searchParams|useSearchParams|nextUrl|realmId/i);
    });

    it('C: it performs no database, QuickBooks, network or mutating action', () => {
        const code = strip(R(PAGE));
        const imports = code.match(/^\s*import .*$/gm) ?? [];
        expect(imports).toEqual([]); // nothing is imported at all
        for (const forbidden of [
            '@/lib/db', 'prisma', 'PrismaClient',                       // database
            '@/lib/quickbooks', 'intuitClient', 'quickbooks/connection', // QuickBooks
            'access_token', 'refresh_token', 'realm',                    // tokens and realms
            'fetch(', "'use server'", '"use server"',                    // network and server actions
            '<form', 'onSubmit', 'method="post"', 'method="POST"',       // anything that could submit
            'revalidate', 'redirect(',                                   // side effects
        ]) {
            expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
        }
        // It is a client-free server component: no interactivity is even possible.
        expect(code).not.toContain("'use client'");
        expect(code).not.toMatch(/<button|onClick/);
    });

    it('D: it explains the authenticated Settings flow instead of performing a disconnect', () => {
        const body = R(PAGE);
        expect(body).toContain('This page is for information only. Opening it does not change or disconnect anything.');
        expect(body).toContain('<strong>Settings</strong>');
        expect(body).toContain('<strong>QuickBooks</strong>');
        expect(body).toContain('<strong>Disconnect from QuickBooks</strong>');
        expect(body).toContain('Only an authorized FreezerIQ administrator');
        // It must not promise deletion the application does not perform.
        expect(body).toContain('Disconnecting does not delete anything in QuickBooks Online.');
        expect(body).toContain('subject to the\n                    applicable data-retention and deletion policy');
        expect(body).not.toMatch(/deleted? (?:forever|permanently)|erase[sd]? everything|kept forever/i);
        // Intuit naming guidelines: never abbreviate QuickBooks, never claim to be Intuit.
        expect(body).toContain('QuickBooks Online');
        expect(body).not.toMatch(/\bQB\b|\bQBO\b/);
    });

    it('the REAL disconnect stays authenticated, ADMIN-only and tenant-scoped — this page changes none of that', () => {
        const route = strip(R(DISCONNECT_ROUTE));
        expect(route).toContain('export async function POST(');
        expect(route).not.toMatch(/export async function GET\(/); // nothing to trigger by visiting a URL
        expect(route).toContain('const session = await auth();');
        expect(route).toContain('mayManageQuickBooks(session.user as any)');
        expect(route).toContain("const businessId = (session.user as any).businessId as string;");
        expect(route).toContain("action !== 'disconnect' && action !== 'forget'");
        expect(route).toContain("outcome === 'still_connected'"); // Forget stays separate from Disconnect
    });
});
