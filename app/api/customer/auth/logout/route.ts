import { NextResponse } from 'next/server';
import { destroyCustomerSession } from '@/lib/customerAuth';

export async function POST() {
    try {
        await destroyCustomerSession();
        return NextResponse.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        return NextResponse.json({ error: 'Failed to process logout' }, { status: 500 });
    }
}
