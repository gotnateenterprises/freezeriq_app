import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    return NextResponse.json({ error: 'Subscriptions feature is under development.' }, { status: 501 });
}
