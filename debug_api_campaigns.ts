
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("Starting Debug Script...");
    try {
        const query = `
                SELECT 
                    c.id as customer_id, 
                    c.name as customer_name, 
                    c.type as customer_type,
                    fc.id as campaign_id,
                    fc.name as campaign_name,
                    fc.status as campaign_status,
                    fc.start_date,
                    fc.end_date,
                    fc.goal_amount,
                    fc.total_sales,
                    fc.created_at as campaign_created_at
                FROM customers c
                LEFT JOIN fundraiser_campaigns fc ON c.id = fc.customer_id
                WHERE (c.type::text = 'fundraiser_org' OR c.type::text = 'ORGANIZATION')
                ORDER BY fc.created_at DESC NULLS LAST, c.name ASC
            `;

        console.log("Executing Query...");
        const rawResults: any[] = await prisma.$queryRawUnsafe(query);
        console.log("Query Executed. Result Count:", rawResults.length);

        if (rawResults.length > 0) {
            const first = rawResults[0];
            console.log("First Result Keys:", Object.keys(first));
            console.log("First Result:", first);

            // Check for BigInt or weird types
            for (const key in first) {
                console.log(`Field ${key}: Type=${typeof first[key]}, Value=${first[key]}`);
                if (typeof first[key] === 'bigint') {
                    console.error(`ERROR: Field ${key} is BigInt! This will break JSON serialization.`);
                }
            }
        } else {
            console.log("No results found.");
        }

        // Simulate Mapping
        const campaigns = rawResults.map(r => ({
            id: r.campaign_id || `new-${r.customer_id}`, // Generate temp ID if missing
            name: r.campaign_name || `${r.customer_name} Fundraiser`,
            status: r.campaign_status || 'Lead', // Default to Lead if no campaign
            start_date: r.start_date,
            end_date: r.end_date,
            goal_amount: Number(r.goal_amount || 0),
            sales_total: Number(r.total_sales || 0),
            customer_id: r.customer_id,
            customer: { name: r.customer_name },
            is_placeholder: !r.campaign_id // Flag for UI if needed
        }));

        console.log("Mapped Campaigns (First 1):", campaigns.slice(0, 1));
        console.log("JSON Stringify Check:", JSON.stringify(campaigns.slice(0, 1)));

    } catch (e) {
        console.error("Debug Script Error:", e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
