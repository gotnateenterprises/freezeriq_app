
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
        if (!session?.user?.businessId) {
            return new NextResponse('Unauthorized', { status: 401 });
        }
        const businessId = session.user.businessId;

        const customers = await prisma.customer.findMany({
            where: {
                business_id: businessId,
                archived: false
            },
            orderBy: { name: 'asc' }
        });

        const headers = [
            'Name',
            'Contact Name',
            'Email',
            'Phone',
            'Type',
            'Status',
            'Delivery Address',
            'Source',
            'Tags',
            'Notes'
        ];

        const rows = customers.map(c => [
            escapeCSV(c.name),
            escapeCSV(c.contact_name),
            escapeCSV(c.contact_email),
            escapeCSV(c.contact_phone),
            escapeCSV(c.type),
            escapeCSV(c.status),
            escapeCSV(c.delivery_address),
            escapeCSV(c.source),
            escapeCSV((c.tags || []).join(', ')),
            escapeCSV(c.notes)
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(r => r.join(','))
        ].join('\n');

        return new NextResponse(csvContent, {
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename=customers_${new Date().toISOString().split('T')[0]}.csv`
            }
        });

    } catch (error: any) {
        console.error('Customer export error:', error);
        return new NextResponse('Export failed', { status: 500 });
    }
}
