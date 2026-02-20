
import { prisma } from './lib/db';

async function main() {
    const businesses = await prisma.business.findMany({
        select: { id: true, name: true, slug: true }
    });
    console.log(JSON.stringify(businesses, null, 2));
}

main().catch(console.error);
