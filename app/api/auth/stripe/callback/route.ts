import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';

export async function GET(req: Request) {
    const url = new URL(req.url);
    const accountId = url.searchParams.get('account_id');
    const businessId = url.searchParams.get('business_id');

    const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const settingsUrl = `${appUrl}/settings`;

    if (!accountId || !businessId) {
        console.error("Stripe Callback Error: Missing account_id or business_id parameters.");
        return NextResponse.redirect(`${settingsUrl}?error=stripe_callback_missing_params`);
    }

    try {
        // Verify the account exists and check if onboarding is complete
        const account = await stripe.accounts.retrieve(accountId);

        if (!account) {
            console.error("Stripe Callback Error: Account not found.");
            return NextResponse.redirect(`${settingsUrl}?error=stripe_account_not_found`);
        }

        // Technically, `details_submitted` or `charges_enabled` tells us they finished onboarding
        if (!account.details_submitted) {
            console.warn(`User aborted or did not finish Stripe Onboarding. Account: ${accountId}`);

            // Still save the integration so they can resume later, but redirect to settings
            await prisma.integration.upsert({
                where: {
                    business_id_provider: {
                        business_id: businessId,
                        provider: 'stripe'
                    }
                },
                update: {
                    access_token: accountId,
                    updated_at: new Date()
                },
                create: {
                    business_id: businessId,
                    provider: 'stripe',
                    access_token: accountId
                }
            });

            return NextResponse.redirect(`${settingsUrl}?error=stripe_setup_incomplete`);
        }

        // The user successfully finished onboarding!
        // Save the Account ID as the access_token in the Integrations table
        await prisma.integration.upsert({
            where: {
                business_id_provider: {
                    business_id: businessId,
                    provider: 'stripe'
                }
            },
            update: {
                access_token: accountId,
                updated_at: new Date()
            },
            create: {
                business_id: businessId,
                provider: 'stripe',
                access_token: accountId
            }
        });

        // Redirect back to settings with a success state
        return NextResponse.redirect(`${settingsUrl}?success=stripe_connected`);
    } catch (error: any) {
        console.error("Stripe Callback Exception:", error);
        return NextResponse.redirect(`${settingsUrl}?error=stripe_callback_failed`);
    }
}
