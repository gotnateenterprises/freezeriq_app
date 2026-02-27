import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const vchsCustomer = "96474533-c0ec-4472-b50c-f1cac15338e2";
    const amberCustomer = "5504b116-9f59-4b9e-8103-2ec1544ce6e9";
    const campaignToMove = "6218ac10-c8f5-465e-a026-745a020772ba";

    // 1. Move the campaign
    await prisma.fundraiserCampaign.update({
        where: { id: campaignToMove },
        data: { customer_id: vchsCustomer }
    });

    console.log('Campaign moved to VCHS PBIS customer.');

    // 2. We should also move the fundraiser_info config to the VCHS customer
    const oldAmber = await prisma.customer.findUnique({ where: { id: amberCustomer } });

    if (oldAmber && oldAmber.fundraiser_info) {
        await prisma.customer.update({
            where: { id: vchsCustomer },
            data: { fundraiser_info: oldAmber.fundraiser_info }
        });
        console.log('fundraiser_info moved to VCHS PBIS.');
    }

    // 3. Since the VCHS customer was Manually created, they might not have the correct status.
    await prisma.customer.update({
        where: { id: vchsCustomer },
        data: { status: 'FLYERS' } // Typical status for mid-campaign
    });

    // 4. Optionally archive or delete Amber Finley if no other orders exist
    // We can just leave Amber Finley as-is for now (she might be a valid Individual customer who also buys food)
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
