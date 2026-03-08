import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2022-11-15' as any, // Temporary bypass while keeping the runtime satisfied
});

export async function GET(req: Request) {
    return new NextResponse('Stripe connect integration is no longer active.', { status: 501 });
}
