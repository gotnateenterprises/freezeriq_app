import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId;
        const role = (session?.user as any)?.role;

        if (!businessId || (role !== 'ADMIN' && !(session?.user as any)?.isSuperAdmin)) {
            return NextResponse.json({ error: 'Unauthorized. Admin role required.' }, { status: 403 });
        }

        const { domain } = await req.json();

        // Clean domain string (remove http://, trailing slashes, enforce lowercase)
        const cleanDomain = domain ? domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase() : null;

        // 1. Fetch current business
        const business = await prisma.business.findUnique({
            where: { id: businessId }
        });

        if (!business) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

        const oldDomain = null; // custom_domain removed from DB schema

        // 2. Call Vercel API if configured
        const projectId = process.env.VERCEL_PROJECT_ID;
        const vercelToken = process.env.VERCEL_API_TOKEN;

        if (projectId && vercelToken) {
            // Remove old domain if it existed and is different
            if (oldDomain && oldDomain !== cleanDomain) {
                await fetch(`https://api.vercel.com/v9/projects/${projectId}/domains/${oldDomain}`, {
                    method: 'DELETE',
                    headers: {
                        Authorization: `Bearer ${vercelToken}`
                    }
                }).catch(e => console.error("[Vercel API] Failed to remove old domain", e));
            }

            // Add new domain to Vercel Project
            if (cleanDomain && oldDomain !== cleanDomain) {
                const addRes = await fetch(`https://api.vercel.com/v10/projects/${projectId}/domains`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${vercelToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ name: cleanDomain })
                });

                if (!addRes.ok) {
                    const errorData = await addRes.json();
                    console.error("[Vercel API Error]", errorData);
                    return NextResponse.json({
                        error: `Vercel Error: ${errorData.error?.message || 'Failed to attach domain to Vercel project.'}`
                    }, { status: 400 });
                }
            }
        } else {
            console.warn("[Vercel API] VERCEL_PROJECT_ID or VERCEL_API_TOKEN not set. Domain will be saved to DB but not attached to Vercel.");
        }

        // 3. Update Database
        // Custom domain DB field removed, disable update
        return NextResponse.json({ success: true, message: "Custom domains are currently disabled in the DB schema." });

    } catch (error: any) {
        console.error("Domain Add Error:", error);
        return NextResponse.json({ error: 'Internal server error while linking domain.' }, { status: 500 });
    }
}
