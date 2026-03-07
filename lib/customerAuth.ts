import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const SECRET_KEY = new TextEncoder().encode(
    process.env.JWT_SECRET || 'fallback_secret_for_development_only'
);

// We use a distinct cookie name so as not to conflict with NextAuth (which handles Tenant B2B users)
const CUSTOMER_COOKIE_NAME = 'freezeriq_customer_session';

export interface CustomerSessionPayload {
    customerId: string;
    email: string;
    businessId: string;
}

/**
 * Creates a JWT token for the authenticated customer.
 */
export async function createCustomerSession(payload: CustomerSessionPayload) {
    const token = await new SignJWT({ ...payload })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('30d') // Sessions last 30 days
        .sign(SECRET_KEY);

    const cookieStore = await cookies();
    cookieStore.set(CUSTOMER_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30, // 30 days
    });
}

/**
 * Verifies the customer's JWT token and returns the payload.
 */
export async function getCustomerSession(): Promise<CustomerSessionPayload | null> {
    const cookieStore = await cookies();
    const token = cookieStore.get(CUSTOMER_COOKIE_NAME)?.value;

    if (!token) return null;

    try {
        const { payload } = await jwtVerify(token, SECRET_KEY);
        return payload as unknown as CustomerSessionPayload;
    } catch (error) {
        console.warn('Invalid or expired customer session token');
        return null;
    }
}

/**
 * Destroys the customer's session cookie.
 */
export async function destroyCustomerSession() {
    const cookieStore = await cookies();
    cookieStore.delete(CUSTOMER_COOKIE_NAME);
}
