import { NextResponse } from 'next/server';

export async function GET(req: Request) {
    return new NextResponse('Customer Auth is under development.', { status: 501 });
}
