import { Client } from 'pg';

async function check() {
    const client = new Client({
        connectionString: "postgresql://postgres.kcgerldyiquzanxkjiyq:Zi0PoPJgwvJGBjjy@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
    });

    try {
        await client.connect();
        const res = await client.query('SELECT type, COUNT(*) FROM "Customer" GROUP BY type');
        console.log("Customers in Production by type:");
        console.table(res.rows);

        const res2 = await client.query('SELECT email, business_id FROM "User" WHERE email LIKE \'%nate%\' LIMIT 5');
        console.log("Admin Users:");
        console.table(res2.rows);

    } catch (e) {
        console.error(e);
    } finally {
        await client.end();
    }
}

check();
