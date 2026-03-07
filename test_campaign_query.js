const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const campaigns = await prisma.fundraiserCampaign.findMany({
            select: {
                id: true,
                orders: {
                    where: {
                        status: { notIn: ['cancelled', 'refunded'] }
                    },
                    select: {
                        items: {
                            select: {
                                quantity: true,
                                variant_size: true,
                                bundle: {
                                    select: { name: true }
                                }
                            }
                        }
                    }
                }
            }
        });
        console.log('Success:', campaigns.length);
    } catch (e) {
        console.error('Prisma Error:', e.message);
    } finally {
        await prisma.$disconnect();
    }
}
main();
