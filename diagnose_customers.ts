
import { prisma } from './lib/db';

async function diagnose() {
    try {
        const totalCustomers = await prisma.customer.count();
        const customersWithBusiness = await prisma.customer.count({
            where: { business_id: { not: null } }
        });
        const customersWithoutBusiness = await prisma.customer.count({
            where: { business_id: null }
        });
        const archivedCustomers = await prisma.customer.count({
            where: { archived: true }
        });

        console.log('--- Customer Diagnostics ---');
        console.log(`Total Customers: ${totalCustomers}`);
        console.log(`With Business ID: ${customersWithBusiness}`);
        console.log(`Without Business ID: ${customersWithoutBusiness}`);
        console.log(`Archived: ${archivedCustomers}`);

        const businesses = await prisma.business.findMany({
            select: { id: true, name: true, plan: true }
        });
        console.log('\n--- Businesses ---');
        for (const b of businesses) {
            const count = await prisma.customer.count({ where: { business_id: b.id } });
            console.log(`Business: ${b.name} (${b.id}) - Plan: ${b.plan} - Customers: ${count}`);
        }

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

diagnose();
