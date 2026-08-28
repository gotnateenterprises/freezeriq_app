import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { uploadToS3 } from '@/lib/s3';
import { validateImageUpload } from '@/lib/imageUploadPolicy';

export const dynamic = 'force-dynamic';

/**
 * BUNDLE-MEDIA-1. Bundle cover image upload — a sibling of
 * app/api/recipes/upload-image/route.ts using the identical size/type policy
 * (lib/imageUploadPolicy.ts) and the same S3/R2 storage helper.
 *
 * This route uploads and returns a URL only; it does not write to the
 * database. Attaching the returned URL to a specific Bundle happens through
 * the existing, already tenant-scoped POST/PUT /api/bundles handlers when the
 * caller saves the bundle — this endpoint never accepts or trusts a bundle
 * id, so it cannot itself attach media to anyone's bundle, theirs or another
 * tenant's.
 *
 * Tenant safety: the object key embeds the caller's own businessId, and
 * uploadToS3 additionally prefixes every key with Date.now(), so two
 * uploads — from the same tenant or different ones — cannot collide or
 * overwrite one another.
 */
export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        const businessId = session?.user?.businessId;

        if (!businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const formData = await req.formData();
        const file = formData.get('file') as File | null;

        const check = validateImageUpload(file);
        if (!check.ok) {
            return NextResponse.json({ error: check.error }, { status: check.status });
        }
        // validateImageUpload(null) always fails, so `check.ok` proves `file` here.
        const validFile: File = file!;

        const buffer = Buffer.from(await validFile.arrayBuffer());
        const ext = validFile.name.split('.').pop() || 'png';
        const safeName = `bundle_${businessId}_${Date.now()}.${ext}`;
        const imageUrl = await uploadToS3(buffer, safeName, validFile.type || 'image/png');

        return NextResponse.json({ url: imageUrl });

    } catch (error: any) {
        console.error('Bundle Image Upload Error:', error);
        return NextResponse.json({
            error: 'Failed to upload image',
            details: 'Something went wrong. Please try again.'
        }, { status: 500 });
    }
}
