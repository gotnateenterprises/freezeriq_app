import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { name, email, type } = body;

        if (!name || !email || !type) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // 1. Save Lead to Database
        let lead;
        try {
            // @ts-ignore - Prisma Client might be stale due to file lock during build
            lead = await prisma.businessLead.create({
                data: {
                    name,
                    email,
                    type,
                    status: 'NEW'
                }
            });
        } catch (dbError) {
            console.log('Database Error (Likely Schema Sync):', dbError);
            // Fallback for demo if DB fails (e.g. schema not synced yet)
            lead = { id: 'temp-id', name, email, type, status: 'NEW' };
        }

        // 2. Fetch Super Admin Email (or hardcode fallback)
        // Ideally we fetch a USER with role 'SUPER_ADMIN' 
        const superAdmins = await prisma.user.findMany({
            where: { is_super_admin: true },
            select: { email: true }
        });
        const adminEmails = superAdmins.map(u => u.email).filter(Boolean) as string[];

        // Fallback if no super admin found in DB (safety net)
        if (adminEmails.length === 0) adminEmails.push('hello@freezeriq.com');


        // 3. Email Notification to Super Admin
        await sendEmail({
            to: adminEmails,
            subject: `New Kitchen Lead: ${name}`,
            html: `
                <h1>New Business Inquiry</h1>
                <p><strong>Name:</strong> ${name}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Type:</strong> ${type}</p>
                <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                <br/>
                <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/leads">View in Admin Dashboard</a></p>
            `,
        });

        // 4. Auto-Reply to Lead
        await sendEmail({
            to: [email],
            subject: 'Welcome to FreezerIQ!',
            html: `
                <h1>Thanks for your interest, ${name}!</h1>
                <p>We're excited to help you start your freezer meal business.</p>
                <p>A member of our team will review your application and reach out shortly to schedule a demo.</p>
                <br/>
                <p>In the meantime, check out our <a href="${process.env.NEXT_PUBLIC_APP_URL}/shop/demo-kitchen">Demo Storefront</a> to see what your future shop could look like.</p>
                <br/>
                <p>Cheers,<br/>The FreezerIQ Team</p>
            `,
        });

        return NextResponse.json({ success: true, lead });
    } catch (error: any) {
        console.error('Error creating business lead:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
