
import { NextResponse } from 'next/server';
import { exchangeCodeForToken } from '@/lib/qbo';

export async function GET(req: Request) {
    // 1. Auth Check
    const { auth } = await import('@/auth'); // Dynamic import to avoid cycles or context issues if any
    const session = await auth();
    if (!session?.user?.businessId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const businessId = session.user.businessId;

    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const realmId = searchParams.get('realmId');

    if (!code || !realmId) {
        return NextResponse.json({ error: "Missing Code or RealmId" }, { status: 400 });
    }

    try {
        await exchangeCodeForToken(code, realmId, businessId);
        // Redirect back to a Success Page
        return NextResponse.redirect(new URL('/settings?qbo=connected', req.url));
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
