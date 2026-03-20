import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const dbs = await prisma.$queryRaw`SELECT datname FROM pg_database WHERE datistemplate = false;`;
  console.log(dbs);
}
main().finally(() => prisma.$disconnect());
