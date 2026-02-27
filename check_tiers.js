const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const tiers = await prisma.subscriptionTier.findMany();
    console.log(tiers.map(t => ({ id: t.id, name: t.name, price: t.price, credits: t.meal_credits_per_cycle })));
}
main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
