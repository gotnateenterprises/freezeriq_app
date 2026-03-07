import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const sup = await prisma.supplier.findUnique({
        where: { id: '383bc2c1-8d13-4414-8f5d-7fe5afed7fd9' }
    });
    console.log('Found supplier:', sup);
    if (sup) {
        try {
            const updated = await prisma.supplier.update({
                where: { id: sup.id },
                data: {
                    name: "Labels Direct"
                }
            });
            console.log('Update succeeded:', updated.name);
        } catch (e: any) {
            console.error('Update failed:', e.message);
        }
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
