import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    try {
        await prisma.supplier.update({
            where: { id: undefined as any },
            data: { name: 'test' }
        });
    } catch (e: any) {
        console.error('Prisma Error Message:', e.message);
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
