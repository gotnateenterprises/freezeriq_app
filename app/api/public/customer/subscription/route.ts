import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    return NextResponse.json({ error: 'Subscription logic is under development.' }, { status: 501 });
}
