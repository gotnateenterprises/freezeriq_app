
import { z } from 'zod';

const envSchema = z.object({
    DATABASE_URL: z.string().url(),
    NEXTAUTH_SECRET: z.string().min(1),
    ADMIN_EMAIL: z.string().email().optional(), // Make optional for now to avoid crash if not set immediately
    ADMIN_PASSWORD: z.string().min(6).optional(),
});

export const env = envSchema.parse(process.env);
