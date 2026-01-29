import { NextResponse } from 'next/server';

const SQUARE_APP_ID = process.env.SQUARE_APP_ID;
const SQUARE_ENV = process.env.SQUARE_ENVIRONMENT || 'sandbox'; // sandbox or production

export async function GET() {
    if (!SQUARE_APP_ID) {
        return NextResponse.json({ error: "Missing SQUARE_APP_ID in environment" }, { status: 500 });
    }

    const baseUrl = SQUARE_ENV === 'production'
        ? 'https://connect.squareup.com'
        : 'https://connect.squareupsandbox.com';

    // Scopes needed for our app
    const scopes = [
        'ORDERS_READ',
        'CUSTOMERS_READ',
        'PAYMENTS_READ',
        'MERCHANT_PROFILE_READ'
    ].join(' ');

    // State for CSRF protection (simplified for now)
    const state = 'search_orders_and_customers';

    const authUrl = `${baseUrl}/oauth2/authorize?client_id=${SQUARE_APP_ID}&scope=${scopes}&state=${state}`;

    return NextResponse.redirect(authUrl);
}
