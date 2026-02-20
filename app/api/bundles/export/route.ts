
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const businessId = session.user.businessId;
        const timestamp = new Date().toISOString().split('T')[0];

        const [catalogs, bundles] = await Promise.all([
            prisma.catalog.findMany({
                where: { business_id: businessId }
            }),
            prisma.bundle.findMany({
                where: { business_id: businessId },
                include: {
                    contents: {
                        include: {
                            recipe: {
                                select: {
                                    id: true,
                                    name: true,
                                    sku: true
                                }
                            }
                        }
                    }
                }
            })
        ]);

        const backupData = {
            metadata: {
                version: "1.0",
                exported_at: new Date().toISOString(),
                type: "bundle_backup"
            },
            catalogs,
            bundles
        };

        return new NextResponse(JSON.stringify(backupData, null, 2), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="freezeriq_bundles_backup_${timestamp}.json"`
            }
        });

    } catch (e: any) {
        console.error("Bundle Export Failed:", e);
        return NextResponse.json({ error: "Export failed" }, { status: 500 });
    }
}
