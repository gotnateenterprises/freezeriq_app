import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const type = searchParams.get('type');

    if (!id || !type) {
        return NextResponse.redirect(new URL('/shop', request.url));
    }

    try {
        const session = await auth();

        // 1. If Logged In as Admin/Tenant -> Redirect to Scanner App or internal editor
        if (session && session.user && session.user.businessId) {
            // Check if they want to edit or scan based on context, 
            // but for now, redirect scanning a code while logged in to the rapid scanner:
            // Since they are scanning, they likely want the scanner app.
            // If they just clicked it on a desktop, maybe they want the editor, but scanner is safer default.
            return NextResponse.redirect(new URL(`/scanner?id=${id}&type=${type}`, request.url));
        }

        // 2. If NOT Logged In (Public Customer) -> Redirect to Public Label Page
        if (type === 'recipe') {
            // We need to fetch the business's slug to construct the public route
            const recipe = await prisma.recipe.findFirst({
                where: { id: id },
                include: { business: true }
            });

            if (recipe && recipe.business && recipe.business.slug) {
                return NextResponse.redirect(new URL(`/shop/${recipe.business.slug}/recipe/${id}`, request.url));
            }
        }

        // Fallback
        return NextResponse.redirect(new URL('/shop', request.url));

    } catch (error) {
        console.error("Scan Redirect Error:", error);
        return NextResponse.redirect(new URL('/shop', request.url));
    }
}
