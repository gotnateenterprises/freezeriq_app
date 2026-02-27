require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

async function main() {
    const account = await stripe.accounts.retrieve('acct_1T3tMZD1nnwf832c');
    console.log('charges_enabled:', account.charges_enabled);
    console.log('details_submitted:', account.details_submitted);
    console.log('payouts_enabled:', account.payouts_enabled);
    console.log('requirements:', JSON.stringify(account.requirements, null, 2));
}

main().catch(console.error);
