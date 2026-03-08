import { NextResponse } from 'next/server';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return new NextResponse('Subscriptions feature is under development.', { status: 501 });
}
