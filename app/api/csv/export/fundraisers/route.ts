
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

function escapeCSV(val: any): string {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

export async function GET(req: NextRequest) {
    try {
        // ── FR-FLOW-1: authentication is now ENFORCED ────────────────────────
        // This route previously called auth(), assigned the result to a local,
        // and never read it — while findMany() carried no WHERE clause at all.
        // middleware.ts's matcher excludes `/api/`, so nothing upstream was
        // enforcing anything either: an unauthenticated GET returned every
        // campaign belonging to every tenant on the platform, including each
        // coordinator's portal_token and the organization's contact email and
        // phone. Both halves are fixed here.
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        // Tenant scope is derived from the session, never from the request.
        // A campaign belongs to a tenant through its Customer, which is the
        // same join every other fundraiser read uses.
        const campaigns = await prisma.fundraiserCampaign.findMany({
            where: { customer: { business_id: businessId } },
            orderBy: { created_at: 'desc' },
            include: {
                customer: true
            }
        });

        const headers = [
            'Campaign Name',
            'Organization Name',
            'Contact Name',
            'Email',
            'Phone',
            'Start Date',
            'End Date',
            'Bundle Goal',
            'Total Sales',
            'Status'
            // FR-FLOW-1: 'Portal Token' removed. portal_token is the coordinator's
            // sole credential for the private portal and setup page — it is a
            // secret, not business data, and a spreadsheet is exactly the kind of
            // artifact that gets forwarded. Nothing in the export needs it.
        ];

        const rows = campaigns.map(c => [
            escapeCSV(c.name),
            escapeCSV(c.customer?.name || ''),
            escapeCSV(c.customer?.contact_name || ''),
            escapeCSV(c.customer?.contact_email || ''),
            escapeCSV(c.customer?.contact_phone || ''),
            escapeCSV(c.start_date ? new Date(c.start_date).toISOString().split('T')[0] : ''),
            escapeCSV(c.end_date ? new Date(c.end_date).toISOString().split('T')[0] : ''),
            escapeCSV(c.goal_amount),
            escapeCSV(c.total_sales),
            escapeCSV(c.status)
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(r => r.join(','))
        ].join('\n');

        return new NextResponse(csvContent, {
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename=fundraisers_${new Date().toISOString().split('T')[0]}.csv`
            }
        });

    } catch (error: any) {
        console.error('Fundraiser export error:', error);
        return new NextResponse('Export failed', { status: 500 });
    }
}
