import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { sendInviteEmail } from '@/lib/email';
import { withErrorHandler } from '@/lib/api-middleware';
import { ValidationError, UnauthorizedError, NotFoundError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('UsersRoute');

// GET: List all users (Admin only)
export const GET = withErrorHandler(async () => {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        throw new UnauthorizedError('Unauthorized');
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        throw new ValidationError('Business ID missing from session');
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
});

// POST: Invite a new user
export const POST = withErrorHandler(async (req: Request) => {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        throw new UnauthorizedError('Unauthorized');
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        throw new ValidationError('Business ID missing from session');
    }

    const { email, role, firstName, lastName, phone, address } = await req.json();

    // Check if exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        throw new ValidationError('User already exists');
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

    logger.info(`User ${email} created with temporary password`);

    return NextResponse.json(newUser);
});

// DELETE: Remove a user
export const DELETE = withErrorHandler(async (req: Request) => {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        throw new UnauthorizedError('Unauthorized');
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        throw new ValidationError('Business ID missing from session');
    }

    const url = new URL(req.url);
    const id = url.searchParams.get('id');

    if (!id) throw new ValidationError('Missing ID');

    if (id === session.user.id) {
        throw new ValidationError('Cannot delete yourself');
    }

    const targetUser = await prisma.user.findUnique({ where: { id } });
    if (!targetUser || targetUser.business_id !== businessId) {
        throw new NotFoundError('User not found or unauthorized');
    }

    await prisma.user.delete({ where: { id } });
    return NextResponse.json({ success: true });
});

// PATCH: Update permissions or details
export const PATCH = withErrorHandler(async (req: Request) => {
    const session = await auth();
    if (session?.user?.role !== 'ADMIN') {
        throw new UnauthorizedError('Unauthorized');
    }

    const businessId = session.user.businessId;
    if (!businessId) {
        throw new ValidationError('Business ID missing from session');
    }

    const { id, permissions, firstName, lastName, phone, address, role } = await req.json();

    const targetUser = await prisma.user.findUnique({ where: { id } });
    if (!targetUser || targetUser.business_id !== businessId) {
        throw new NotFoundError('User not found or unauthorized');
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
});
