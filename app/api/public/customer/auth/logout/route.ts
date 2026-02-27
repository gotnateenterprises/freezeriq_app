import { NextResponse } from 'next/server';
import { destroyCustomerSession } from '@/lib/customerAuth';

export async function POST() {
    try {
        await destroyCustomerSession();
        return NextResponse.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('[Customer Auth Logout] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
