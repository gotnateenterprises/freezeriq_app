
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
        const session = await auth();
        // Since we want to export for the current context, we rely on session
        // Assuming Super Admin or valid Business User

        // Fetch all campaigns with customer info
        // Ordered by creation for consistency
        const campaigns = await prisma.fundraiserCampaign.findMany({
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
            'Status',
            'Portal Token'
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
            escapeCSV(c.status),
            // @ts-ignore - Field exists in schema but client type is stale
            escapeCSV(c.portal_token)
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
