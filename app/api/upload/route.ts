
import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

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

        const buffer = Buffer.from(await file.arrayBuffer());
        const filename = `${uuidv4()}${getExtension(file.name)}`;

        // Save to public/uploads
        // Note: In Vercel/Cloud, this won't persist. But for local dev/VPS, this works.
        const uploadDir = join(process.cwd(), 'public', 'uploads');
        const filepath = join(uploadDir, filename);

        await writeFile(filepath, buffer);

        const url = `/uploads/${filename}`;

        return NextResponse.json({
            success: true,
            url,
            name: file.name,
            type: file.type
        });

    } catch (error) {
        console.error('Upload error:', error);
        return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }
}
