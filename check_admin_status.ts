
import { prisma } from './lib/db';

async function main() {
    console.log("Checking User Admin Status...");
    const users = await prisma.user.findMany({
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            is_super_admin: true,
            business: {
                select: {
                    name: true
                }
            }
        }
    });

    console.table(users.map(u => ({
        email: u.email,
        role: u.role,
        isSuperAdmin: u.is_super_admin,
        business: u.business?.name || 'None'
    })));
}

main()
    .catch((e) => console.error(e))
    .finally(async () => await prisma.$disconnect());
