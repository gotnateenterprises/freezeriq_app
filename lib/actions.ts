"use server";

import { signIn } from '@/auth';
import { AuthError } from 'next-auth';
import { checkRateLimit } from './auth/rate_limit'; // Adjust path if needed
import { headers } from 'next/headers';

export async function authenticate(
    prevState: string | undefined,
    formData: FormData,
) {
    try {
        const email = formData.get('email') as string;
        // Simple rate limit key combining email and "login"
        // In production, you'd want actual IP via headers, but this helps against brute-forcing a specific account.
        const ip = (await headers()).get('x-forwarded-for') || '127.0.0.1';

        const limitResult = checkRateLimit(`${ip}_login`, 5, 60 * 1000); // 5 attempts per minute per IP

        if (!limitResult.success) {
            return "Too many attempts. Please try again later.";
        }

        await signIn('credentials', formData);
    } catch (error) {
        if (error instanceof AuthError) {
            switch (error.type) {
                case 'CredentialsSignin':
                    return 'Invalid credentials.';
                default:
                    return 'Something went wrong.';
            }
        }
        throw error;
    }
}
