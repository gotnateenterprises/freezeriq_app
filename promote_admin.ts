
import { prisma } from './lib/db';

async function main() {
    console.log("Promoting nate475@gmail.com to Super Admin...");

    try {
        const user = await prisma.user.update({
            where: { email: 'nate475@gmail.com' },
            data: {
                is_super_admin: true,
                role: 'ADMIN' // Ensure they have base admin role too
            }
        });
        console.log(`✅ Success! User ${user.email} is now a Super Admin.`);
    } catch (e) {
        console.error("Error updating user:", e);
    }
}

main()
    .catch((e) => console.error(e))
    .finally(async () => await prisma.$disconnect());
