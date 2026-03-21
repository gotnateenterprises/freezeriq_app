import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function check() {
    try {
        const users = await prisma.user.findMany({
            where: { email: { contains: 'nate' } },
            select: { email: true, business_id: true }
        });
        console.log("Users:");
        console.table(users);

        if (users.length > 0 && users[0].business_id) {
            const custs = await prisma.customer.findMany({
                where: { business_id: users[0].business_id },
                select: { name: true, type: true }
            });
            console.log(`Customers for business_id ${users[0].business_id}: ${custs.length}`);
        }

        // check how many distinct business_ids there are for customers
        const dist = await prisma.customer.groupBy({
            by: ['business_id'],
            _count: true
        });
        console.log("Customer counts by Business ID:");
        console.table(dist);

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

check();
