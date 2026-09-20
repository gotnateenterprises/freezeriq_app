/**
 * PUBLIC QuickBooks disconnect information page — the URL registered with Intuit
 * as the app's Disconnect URL (https://www.freezeriqapp.com/legal/disconnect).
 *
 * INFORMATIONAL ONLY. Visiting this page disconnects nothing. Intuit may append
 * `?realmId=...`; this page must — and structurally cannot — act on it:
 *
 *   - `dynamic = 'force-static'` means the page is rendered at build time, so it
 *     has no access to searchParams, cookies or headers at request time. A query
 *     string cannot reach this component at all, from Intuit or from anyone else;
 *   - it takes no props, imports nothing (no database client, no QuickBooks
 *     module, no auth), performs no fetch, declares no server action and renders
 *     no form or button. There is nothing here to POST to;
 *   - the real disconnect is an authenticated, tenant-ADMIN action inside the
 *     application (Settings → QuickBooks), which is what this page points to.
 *
 * Wording follows Intuit's naming guidelines: "QuickBooks" is never abbreviated
 * and no Intuit logo is used. Nothing here promises deletion behaviour the
 * application does not perform.
 */

export const dynamic = 'force-static';

export const metadata = {
    title: 'Disconnect FreezerIQ from QuickBooks Online',
    description: 'How to disconnect a QuickBooks Online company from FreezerIQ, and what happens when you do.',
};

export default function QuickBooksDisconnectPage() {
    return (
        <div className="max-w-3xl mx-auto py-12 px-6">
            <h1 className="text-3xl font-bold mb-6">Disconnect FreezerIQ from QuickBooks Online</h1>
            <div className="space-y-4 text-slate-700">
                <p><strong>Last Updated:</strong> September 20, 2026</p>
                <p>
                    This page is for information only. Opening it does not change or disconnect anything.
                    Disconnecting is done inside FreezerIQ by an administrator, as described below.
                </p>

                <h2 className="text-xl font-bold mt-6">What disconnecting does</h2>
                <p>
                    Disconnecting stops FreezerIQ from accessing your QuickBooks Online company. After you
                    disconnect, FreezerIQ can no longer read your QuickBooks company or create, update or send
                    invoices in it.
                </p>

                <h2 className="text-xl font-bold mt-6">How to disconnect</h2>
                <ol className="list-decimal ml-6 space-y-1">
                    <li>Sign in to FreezerIQ.</li>
                    <li>Open <strong>Settings</strong>.</li>
                    <li>Go to the <strong>QuickBooks</strong> section.</li>
                    <li>Choose <strong>Disconnect from QuickBooks</strong> and confirm.</li>
                </ol>
                <p>
                    Only an authorized FreezerIQ administrator for your business can disconnect the connection.
                    You can also remove FreezerIQ&apos;s access from the Apps section of QuickBooks Online.
                </p>

                <h2 className="text-xl font-bold mt-6">What happens to your data</h2>
                <p>
                    Disconnecting does not delete anything in QuickBooks Online. Invoices and other records
                    FreezerIQ has already created there remain in your QuickBooks company, under your control.
                </p>
                <p>
                    In FreezerIQ, disconnecting revokes and deletes the stored access credentials for your
                    QuickBooks company. A record that the company was connected — and later disconnected —
                    remains until an administrator also chooses <strong>Forget company</strong>, which is a
                    separate step. Historical QuickBooks connection records referenced by invoice history
                    survive both Disconnect and Forget for accounting and audit continuity, subject to the
                    applicable data-retention and deletion policy.
                </p>

                <h2 className="text-xl font-bold mt-6">Reconnecting later</h2>
                <p>
                    If you reconnect, FreezerIQ verifies the QuickBooks company before restoring access, so a
                    connection is always re-established against the company you intend. Connecting a different
                    QuickBooks company requires <strong>Forget company</strong> first.
                </p>

                <h2 className="text-xl font-bold mt-6">Questions</h2>
                <p>
                    If you need help disconnecting, contact your FreezerIQ administrator.
                </p>
            </div>
        </div>
    );
}
