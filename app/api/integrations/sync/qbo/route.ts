
import { NextResponse } from 'next/server';

export async function POST() {
    return NextResponse.json({ error: "QBO Sync not implemented yet. Please create QBO credentials first." }, { status: 501 });
}
