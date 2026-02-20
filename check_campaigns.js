const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const campaignCount = await prisma.fundraiserCampaign.count();
        console.log('Total Campaign count:', campaignCount);

        // Raw query to group customers by type
        const customerTypes = await prisma.$queryRawUnsafe(`SELECT type, count(*) as count FROM customers GROUP BY type`);

        const replacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;

        console.log('Customer Types breakdown:', JSON.stringify(customerTypes, replacer, 2));

        // Fetch all customers that look like organizations to see their names
        const potentialOrgs = await prisma.$queryRawUnsafe(`SELECT id, name, type FROM customers WHERE type::text ILIKE '%org%' OR name ILIKE '%school%' OR name ILIKE '%fund%' LIMIT 20`);
        console.log('Potential Organizations:', JSON.stringify(potentialOrgs, replacer, 2));

        // Fetch all IDs and names to see what we have
        const campaigns = await prisma.fundraiserCampaign.findMany({
            select: { id: true, name: true, created_at: true, status: true }
        });
        console.log('All campaigns:', JSON.stringify(campaigns, null, 2));

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
