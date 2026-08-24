/**
 * Storefront customer sessions.
 *
 * CUSTOMER-JWT-SECRET-1. The signing key used to be derived like this:
 *
 *     const SECRET_KEY = new TextEncoder().encode(
 *         process.env.JWT_SECRET || 'fallback_secret_for_development_only'
 *     );
 *
 * JWT_SECRET was set in no Vercel environment, and the repository is public, so
 * the `||` branch is what actually signed and verified every deployed
 * `freezeriq_customer_session`. The key was a string anybody could read, which
 * made a session for an arbitrary customerId trivially forgeable.
 *
 * The fallback is gone. There is no default: if JWT_SECRET is not configured,
 * verification returns no session and issuing one throws. That is deliberate —
 * a missing secret must never quietly downgrade to a weaker but working mode,
 * because a silent downgrade is exactly how the original bug survived.
 *
 * The secret is read per call rather than captured at module load, so a
 * misconfigured deployment fails closed on the request that needs it instead of
 * crashing every storefront page at import time. It is NOT generated randomly
 * per process: sessions must stay valid across instances and deployments, and a
 * per-process key would log customers out unpredictably.
 *
 * This is a distinct secret from Auth.js's NEXTAUTH_SECRET on purpose, so tenant
 * session rotation and customer session rotation stay independent.
 */
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

/** The one algorithm this system issues, and the only one it will accept. */
const ALG = 'HS256';

// We use a distinct cookie name so as not to conflict with NextAuth (which handles Tenant B2B users)
const CUSTOMER_COOKIE_NAME = 'freezeriq_customer_session';

export interface CustomerSessionPayload {
    customerId: string;
    email: string;
    businessId: string;
}

function secretKey(): Uint8Array | null {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 16) return null;
    return new TextEncoder().encode(secret);
}

/** A correctly-signed token still has to carry a usable identity. */
function isValidPayload(p: any): p is CustomerSessionPayload {
    return !!p
        && typeof p.customerId === 'string' && p.customerId.length > 0
        && typeof p.businessId === 'string' && p.businessId.length > 0
        && typeof p.email === 'string';
}

/**
 * Creates a JWT token for the authenticated customer.
 * Throws when JWT_SECRET is missing: issuing an unforgeable-by-design credential
 * with a guessable key is worse than refusing to log the customer in.
 */
export async function createCustomerSession(payload: CustomerSessionPayload) {
    const key = secretKey();
    if (!key) {
        throw new Error(
            'JWT_SECRET is not configured; refusing to issue a customer session.',
        );
    }

    const token = await new SignJWT({ ...payload })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setExpirationTime('30d') // Sessions last 30 days
        .sign(key);

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
 * Returns null for every failure — missing secret, bad signature, wrong
 * algorithm, expiry, or a payload that does not describe a customer.
 */
export async function getCustomerSession(): Promise<CustomerSessionPayload | null> {
    const cookieStore = await cookies();
    const token = cookieStore.get(CUSTOMER_COOKIE_NAME)?.value;

    if (!token) return null;

    const key = secretKey();
    if (!key) {
        console.error('JWT_SECRET is not configured; rejecting customer session.');
        return null;
    }

    try {
        // Pinning the algorithm keeps the verifier from being talked into
        // accepting anything other than the HMAC this system issues.
        const { payload } = await jwtVerify(token, key, { algorithms: [ALG] });
        if (!isValidPayload(payload)) {
            console.warn('Customer session token verified but carried no usable identity');
            return null;
        }
        return {
            customerId: payload.customerId,
            email: payload.email,
            businessId: payload.businessId,
        };
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
