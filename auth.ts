
import NextAuth from 'next-auth';
import { authConfig } from './auth.config';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';

export const { handlers, auth, signIn, signOut } = NextAuth({
    ...authConfig,
    providers: [
        Credentials({
            async authorize(credentials) {
                console.log("[Auth] Attempting login...");
                const parsedCredentials = z
                    .object({ email: z.string().email(), password: z.string().min(6) })
                    .safeParse(credentials);

                if (parsedCredentials.success) {
                    const { email, password } = parsedCredentials.data;
                    console.log(`[Auth] Lookup email: ${email}`);

                    const user = await prisma.user.findUnique({
                        where: { email },
                        include: { business: true } // Fetch subscription info
                    });
                    if (!user) {
                        console.log("[Auth] ❌ User not found in DB.");
                        return null;
                    }

                    console.log(`[Auth] User found. Role: ${user.role}. Verifying password...`);
                    const passwordsMatch = await bcrypt.compare(password, user.password);

                    if (passwordsMatch) {
                        console.log("[Auth] ✅ Password match! Login success.");
                        return {
                            id: user.id,
                            name: user.name,
                            email: user.email,
                            role: user.role,
                            permissions: user.permissions,
                            businessId: user.business_id || undefined,

                            // SaaS Fields
                            plan: user.business?.plan || 'PRO',
                            subscriptionStatus: user.business?.subscription_status || 'active',
                            isSuperAdmin: user.is_super_admin,
                            // businessLogo: user.business?.logo_url, // REMOVED: Too large for session cookie (Base64)
                            businessName: user.business?.name
                        };
                    } else {
                        console.log("[Auth] ❌ Password mismatch.");
                    }
                } else {
                    console.log("[Auth] ❌ Invalid input format.");
                }
                console.log('[Auth] Returning null (Invalid credentials)');
                return null;
            },
        }),
    ],
});
