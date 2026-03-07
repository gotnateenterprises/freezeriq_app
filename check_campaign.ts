import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const campaign = await prisma.fundraiserCampaign.findFirst({
        where: {
            name: { contains: 'VCHS PBIS' }
        },
        include: {
            customer: true
        }
    });

    console.log(JSON.stringify(campaign, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
