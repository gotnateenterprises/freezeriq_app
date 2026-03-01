import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const sup = await prisma.supplier.findUnique({ where: { id: 'undefined' } });
    console.log('Supplier with id undefined:', sup);
}

main().catch(console.error).finally(() => prisma.$disconnect());
