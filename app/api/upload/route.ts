
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { uploadToS3 } from '@/lib/s3';

export const dynamic = 'force-dynamic';

// Helper to get extension
function getExtension(filename: string) {
    const parts = filename.split('.');
    return parts.length > 1 ? `.${parts.pop()}` : '';
}

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        // Validate type
        const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validTypes.includes(file.type)) {
            return NextResponse.json({ error: 'Invalid file type. Only JPG, PNG, GIF, WEBP allowed.' }, { status: 400 });
        }

        const originalBuffer = Buffer.from(await file.arrayBuffer() as ArrayBuffer);

        let finalBuffer: Buffer = originalBuffer;
        let finalFilename = `${uuidv4()}`;
        let finalType = file.type;

        // Compress and convert to WEBP if it's not a GIF (GIFs break if aggressively optimized this way)
        if (file.type !== 'image/gif') {
            const sharp = (await import('sharp')).default;
            finalBuffer = await sharp(originalBuffer)
                .resize(1200, 1200, {
                    fit: 'inside', // Maintains aspect ratio, won't enlarge if smaller
                    withoutEnlargement: true
                })
                .webp({ quality: 80 }) // Converts to highly optimized webp
                .toBuffer() as Buffer;

            finalFilename += '.webp';
            finalType = 'image/webp';
        } else {
            finalFilename += getExtension(file.name);
        }

        // Save to S3 Compatible Storage
        const url = await uploadToS3(finalBuffer, finalFilename, finalType);

        return NextResponse.json({
            success: true,
            url,
            name: file.name,
            type: finalType
        });

    } catch (error) {
        console.error('Upload error:', error);
        return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }
}
