
import { NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/lib/qbo';

export async function GET() {
    try {
        const url = getAuthorizationUrl();
        console.log("Redirecting to QBO Auth URL:", url); // DEBUG LOG
        return NextResponse.redirect(url);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
