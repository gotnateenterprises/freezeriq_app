
import { NextResponse } from 'next/server';
import { exchangeCodeForToken } from '@/lib/qbo';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const realmId = searchParams.get('realmId');

    if (!code || !realmId) {
        return NextResponse.json({ error: "Missing Code or RealmId" }, { status: 400 });
    }

    try {
        await exchangeCodeForToken(code, realmId);
        // Redirect back to a Success Page
        return NextResponse.redirect(new URL('/settings?qbo=connected', req.url));
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
