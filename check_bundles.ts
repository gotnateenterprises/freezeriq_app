
import { prisma } from './lib/db';

async function checkBundles() {
    console.log("Checking Bundles...");
    const bundles = await prisma.bundle.findMany();
    console.log(`Found ${bundles.length} bundles.`);
    if (bundles.length > 0) {
        console.table(bundles.map(b => ({ id: b.id, name: b.name, is_active: b.is_active })));
    }
}

checkBundles()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
