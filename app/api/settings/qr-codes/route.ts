import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    return NextResponse.json({ error: 'QR Code generation is under development.' }, { status: 501 });
}

export async function POST(req: NextRequest) {
    return NextResponse.json({ error: 'QR Code generation is under development.' }, { status: 501 });
}

export async function DELETE(req: NextRequest) {
    return NextResponse.json({ error: 'QR Code generation is under development.' }, { status: 501 });
}
