import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Note: In production, ensure DATABASE_URL includes ?sslmode=require for security
export const prisma = globalForPrisma.prisma || new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
