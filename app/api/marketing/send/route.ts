import { NextResponse } from 'next/server';
import { auth } from '@/auth';

// MARKETING-PLACEHOLDER-SEND-1.
//
// FreezerIQ has no marketing email or SMS sender. This route used to hand every
// request to an in-memory MockMarketingClient that only console.logged the
// message, waited 1.5 s and answered `status: 'sent'`, so the /campaigns page
// told the tenant "Message Sent!" when nothing had been emailed or texted. Its
// GET returned that mock's process-wide campaign list (two invented demo
// campaigns with made-up open/click stats, plus anything any tenant had
// "sent" since cold start), with no tenant filter.
//
// Both methods now refuse with 501 instead of pretending. They read no request
// body, count no customers and touch no database: there is nothing to deliver
// to, so there is nothing to look up. The session guard stays first so an
// anonymous caller still gets 401 (SEC-PUBLIC-ROUTE-1).
//
// Email that really works lives elsewhere and is untouched by this file:
// coordinator Previous Supporters invitations and the Fundraiser CRM's
// seasonal lineup emails (/fundraisers?tab=rebooking). SMS has no sender at
// all (TWILIO-SMS-ROUTE-RETIRE-1). A real campaign sender is a separate,
// approved build with its own consent, suppression and send-log design.

const MARKETING_SEND_UNAVAILABLE = 'MARKETING_SEND_UNAVAILABLE';

function unavailable(error: string) {
    return NextResponse.json(
        { error, code: MARKETING_SEND_UNAVAILABLE, sent: false },
        { status: 501 },
    );
}

export async function POST() {
    const session = await auth();
    if (!session?.user?.businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return unavailable(
        'Campaign sending is not available yet. FreezerIQ has no marketing email or SMS sender, so nothing was emailed or texted.',
    );
}

export async function GET() {
    const session = await auth();
    if (!session?.user?.businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return unavailable(
        'Campaign history is not available. FreezerIQ has no marketing email or SMS sender, so no campaigns have been sent from this page.',
    );
}
