import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const region = process.env.S3_REGION || "auto"; // "auto" is often used for Cloudflare R2
const accessKeyId = process.env.S3_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || "";
const endpoint = process.env.S3_ENDPOINT || ""; // e.g. https://<account_id>.r2.cloudflarestorage.com
const bucketName = process.env.S3_BUCKET_NAME || "";

export const s3Client = new S3Client({
    region,
    endpoint: endpoint || undefined,
    credentials: {
        accessKeyId,
        secretAccessKey,
    },
});

export async function uploadToS3(fileBuffer: Buffer, fileName: string, contentType: string): Promise<string> {
    const timestamp = Date.now();
    // Create a unique filename to prevent overwriting
    const uniqueFileName = `${timestamp}-${fileName}`;

    // Development Fallback: If no S3 bucket or credentials are configured, save locally
    if (!bucketName || !accessKeyId) {
        console.warn(`[S3 Utility] Incomplete S3 config (missing bucket or access key). Falling back to local storage for ${fileName}.`);
        const { writeFile, mkdir } = await import('fs/promises');
        const { join } = await import('path');

        const uploadDir = join(process.cwd(), 'public', 'uploads');
        try {
            await mkdir(uploadDir, { recursive: true });
        } catch (e) {
            // Ignore directory exists errors
        }
        const filepath = join(uploadDir, uniqueFileName);
        await writeFile(filepath, fileBuffer);
        return `/uploads/${uniqueFileName}`;
    }

    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: uniqueFileName,
        Body: fileBuffer,
        ContentType: contentType,
        // ACL: 'public-read', // Uncomment if your bucket allows ACLs
    });

    await s3Client.send(command);

    // Return the public URL
    // If using Cloudflare R2 with a custom public domain:
    const publicDomain = process.env.S3_PUBLIC_DOMAIN;
    if (publicDomain) {
        // publicDomain should ideally be like https://pub-xyz.r2.dev or a custom domain
        const baseUrl = publicDomain.endsWith('/') ? publicDomain.slice(0, -1) : publicDomain;
        return `${baseUrl}/${uniqueFileName}`;
    }

    // Fallback standard AWS S3 format
    if (endpoint) {
        const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
        return `${baseUrl}/${bucketName}/${uniqueFileName}`;
    }

    return `https://${bucketName}.s3.${region}.amazonaws.com/${uniqueFileName}`;
}
