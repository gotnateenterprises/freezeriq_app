import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { sendInviteEmail } from '@/lib/email';

// GET: List all users (Admin only)
export async function GET() {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        return NextResponse.json({ error: 'Business ID missing from session' }, { status: 400 });
    }

    const users = await prisma.user.findMany({
        where: {
            business_id: businessId
        },
        orderBy: { created_at: 'desc' },
        select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            address: true,
            role: true,
            permissions: true,
            isActive: true,
            name: true // Keep for backward compatibility
        }
    });

    return NextResponse.json(users);
}

// POST: Invite a new user
export async function POST(req: Request) {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        return NextResponse.json({ error: 'Business ID missing from session' }, { status: 400 });
    }

    try {
        const { email, role, firstName, lastName, phone, address } = await req.json();

        // Check if exists
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            return NextResponse.json({ error: 'User already exists' }, { status: 400 });
        }

        // Create with temp password
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        // Construct display name
        const displayName = (firstName && lastName) ? `${firstName} ${lastName}` : email.split('@')[0];

        const newUser = await prisma.user.create({
            data: {
                email,
                role: role || 'CHEF',
                password: hashedPassword,
                name: displayName,
                firstName,
                lastName,
                phone,
                address,
                permissions: [],
                business_id: businessId
            }
        });

        // Send Email
        await sendInviteEmail(email, tempPassword);

        console.log(`[INVITE] User ${email} created with password: ${tempPassword}`);

        return NextResponse.json(newUser);
    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }
}

// DELETE: Remove a user
export async function DELETE(req: Request) {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        return NextResponse.json({ error: 'Business ID missing from session' }, { status: 400 });
    }

    const url = new URL(req.url);
    const id = url.searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 });

    if (id === session.user.id) {
        return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });
    }

    const targetUser = await prisma.user.findUnique({ where: { id } });
    if (!targetUser || targetUser.business_id !== businessId) {
        return NextResponse.json({ error: 'User not found or unauthorized' }, { status: 404 });
    }

    await prisma.user.delete({ where: { id } });
    return NextResponse.json({ success: true });
}

// PATCH: Update permissions or details
export async function PATCH(req: Request) {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        return NextResponse.json({ error: 'Business ID missing from session' }, { status: 400 });
    }

    const { id, permissions, firstName, lastName, phone, address, role } = await req.json();

    const targetUser = await prisma.user.findUnique({ where: { id } });
    if (!targetUser || targetUser.business_id !== businessId) {
        return NextResponse.json({ error: 'User not found or unauthorized' }, { status: 404 });
    }

    const updateData: any = {};
    if (permissions) updateData.permissions = permissions;
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (phone) updateData.phone = phone;
    if (address) updateData.address = address;
    if (role) updateData.role = role;

    // Update display name if names changed
    if (firstName || lastName) {
        if (firstName && lastName) updateData.name = `${firstName} ${lastName}`;
    }

    const updated = await prisma.user.update({
        where: { id },
        data: updateData
    });

    return NextResponse.json(updated);
}
