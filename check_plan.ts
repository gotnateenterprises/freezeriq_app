
import { prisma } from './lib/db';

async function main() {
    const businessId = '069f1823-6275-4cdb-b7f4-d8428c5f9acf'; // Freezer Chef
    const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true, name: true, plan: true }
    });
    console.log('Business:', business);
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
