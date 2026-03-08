const { Pool } = require('pg');
require('dotenv').config({ path: '.env.prod' });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL + '&pgbouncer=true',
    ssl: { rejectUnauthorized: false }
});

async function main() {
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT id, name FROM businesses WHERE slug = $1", ['myfreezerchef']);
        const business = res.rows[0];

        if (!business) {
            console.log("Business not found");
            return;
        }

        const stockImages = [
            "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=2071&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1547592166-23ac45744acd?q=80&w=2071&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?q=80&w=2070&auto=format&fit=crop",
            "https://images.unsplash.com/photo-158503222665a-719976ec8dfc?q=80&w=1982&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=2070&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?q=80&w=2013&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1565557623262-b51c2513a641?q=80&w=1971&auto=format&fit=crop"
        ];

        const recipesRes = await client.query("SELECT id, name FROM recipes WHERE business_id = $1", [business.id]);

        let count = 0;
        for (const recipe of recipesRes.rows) {
            const img = stockImages[count % stockImages.length];
            await client.query(
                "UPDATE recipes SET image_url = $1 WHERE id = $2",
                [img, recipe.id]
            );
            console.log(`✅ Updated ${recipe.name}`);
            count++;
        }
        console.log("Done restoring images!");
    } finally {
        client.release();
        pool.end();
    }
}
main().catch(console.error);
