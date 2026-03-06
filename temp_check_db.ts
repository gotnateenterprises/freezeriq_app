import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const users = await prisma.user.findMany();
    console.log('TOTAL USERS:', users.length);
    const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
    console.log('ADMIN EXISTS:', !!admin, admin ? admin.email : '');

    // Also check bundles because the user said the shop isn't showing up
    const bundles = await prisma.bundle.findMany();
    console.log('TOTAL BUNDLES:', bundles.length);
}

main().finally(() => prisma.$disconnect());
