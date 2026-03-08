import { NextResponse } from 'next/server';

export async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string }> }
) {
    return NextResponse.json({ tiers: [] });
}
