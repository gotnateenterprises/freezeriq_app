require('dotenv').config({ path: '.env.prod' });
const { Client } = require('pg');

async function main() {
    console.log("Connecting using:", process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@'));

    // Ensure pgbouncer is used
    let dbUrl = process.env.DATABASE_URL;
    if (!dbUrl.includes('pgbouncer')) {
        dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'pgbouncer=true';
    }

    const client = new Client({
        connectionString: dbUrl,
    });

    try {
        await client.connect();
        console.log("Connected to Vercel Supabase successfully.");

        // 1. Add Column
        try {
            await client.query('ALTER TABLE "businesses" ADD COLUMN "custom_domain" TEXT;');
            console.log("Column 'custom_domain' added.");
        } catch (e) {
            console.log("Column might already exist:", e.message);
        }

        // 2. Add Unique Constraint
        try {
            await client.query('CREATE UNIQUE INDEX "businesses_custom_domain_key" ON "businesses"("custom_domain");');
            console.log("Unique constraint added.");
        } catch (e) {
            console.log("Constraint might already exist:", e.message);
        }

        // 3. Set Founder Value
        await client.query(`UPDATE "businesses" SET "custom_domain" = 'myfreezerchef.com' WHERE "slug" = 'my-freezer-chef';`);
        console.log("Tenant custom domain mapping registered.");

    } catch (error) {
        console.error("Fatal exception:", error);
    } finally {
        await client.end();
    }
}

main();
