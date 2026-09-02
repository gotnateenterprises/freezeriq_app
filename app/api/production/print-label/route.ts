
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getLabelPrinter } from '@/lib/label_printer';

// SEC-PUBLIC-ROUTE-1. No auth() call — same physical-printer exposure as the
// sibling /api/production/print.
//
// NOT fixed here, deliberately: `job` carries tenant branding (businessName,
// logoUrl, primaryColor, secondaryColor, accentColor) straight from the request
// body, so even an authenticated tenant can print labels bearing another
// business's identity. Closing that means resolving branding server-side from
// the session (lib/tenantBrand.ts already exports resolveTenantBrand), which
// silently changes behaviour for all three existing callers. That is a
// deliberate product decision, not a P0 auth repair, and it is left out of this
// phase on purpose.
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { job } = body;

        if (!job) {
            return NextResponse.json({ error: "Missing print job data" }, { status: 400 });
        }

        const printer = getLabelPrinter();
        const result = await printer.printLabel(job);

        if (!result.success) {
            return NextResponse.json({ error: result.message, mock: result.mock }, { status: 500 });
        }

        // OPS-5D: `mock` tells the caller whether this response is evidence
        // of an actual physical print (a real printer answered) or merely a
        // mock queue for preview/testing — a 200 from this route is not, by
        // itself, proof that a label reached a printer.
        return NextResponse.json({ success: true, message: result.message, mock: result.mock });

    } catch (e) {
        console.error("Print API Error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
