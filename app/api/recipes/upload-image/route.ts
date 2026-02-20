import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { uploadToS3 } from '@/lib/s3';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        const businessId = session?.user?.businessId;

        if (!businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const formData = await req.formData();
        const file = formData.get('file') as File | null;

        if (!file || file.size === 0) {
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        // Limit file size (e.g., 5MB)
        if (file.size > 5 * 1024 * 1024) {
            return NextResponse.json({ error: 'File too large (max 5MB)' }, { status: 400 });
        }

        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowedTypes.includes(file.type)) {
            return NextResponse.json({ error: 'Invalid file type. Only JPEG, PNG, WEBP, and GIF are allowed.' }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const ext = file.name.split('.').pop() || 'png';
        const safeName = `recipe_${businessId}_${Date.now()}.${ext}`;
        const imageUrl = await uploadToS3(buffer, safeName, file.type || 'image/png');

        return NextResponse.json({ url: imageUrl });

    } catch (error: any) {
        console.error('Recipe Image Upload Error:', error);
        return NextResponse.json({
            error: 'Failed to upload image',
            details: error.message
        }, { status: 500 });
    }
}
