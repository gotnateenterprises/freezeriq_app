import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET() {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Fetch all pending or production-ready orders
        // (Status: pending, production_ready)
        const activeOrders = await prisma.order.findMany({
            where: {
                status: { in: ['pending', 'production_ready'] },
                business_id: session.user.businessId
            },
            include: {
                items: {
                    include: {
                        bundle: {
                            include: {
                                contents: {
                                    include: { recipe: true }
                                }
                            }
                        }
                    }
                }
            }
        });

        // Tally counters
        let largeTrays = 0;
        let largeLids = 0;
        let smallTrays = 0;
        let smallLids = 0;
        let gallonBags = 0;
        let quartBags = 0;

        // Legacy box counters (still useful for shipping)
        let largeBoxesNeeded = 0;
        let smallBoxesNeeded = 0;

        activeOrders.forEach(order => {
            order.items.forEach(item => {
                const bundle = item.bundle;
                if (!bundle) return;

                const qty = item.quantity;
                const tier = bundle.serving_tier?.toLowerCase() || '';
                const isFamily = tier === 'family' || bundle.name?.toLowerCase().includes('family');

                // Box Logic (Bundle Level)
                if (isFamily) {
                    largeBoxesNeeded += qty;
                } else {
                    smallBoxesNeeded += qty;
                }

                // Packaging Logic (Recipe Level)
                // Iterate through recipes in the bundle to determine container needs
                bundle.contents.forEach(content => {
                    const recipe = content.recipe;
                    if (!recipe) return;

                    // Scale logic: 
                    // If bundle quantity is 1, and content quantity is 1, we need 1 container.
                    // Usually 1 Bundle = 1 Set of Meals.
                    // We multiply OrderItem.quantity * BundleContent.quantity (rounded up?)
                    // Usually BundleContent.quantity is 1 for the main meal.

                    const needed = qty * (content.quantity || 1);

                    if (recipe.container_type === 'bag') {
                        if (isFamily) {
                            gallonBags += needed;
                        } else {
                            quartBags += needed;
                        }
                    } else {
                        // Default is 'tray'
                        if (isFamily) {
                            largeTrays += needed;
                            largeLids += needed;
                        } else {
                            smallTrays += needed;
                            smallLids += needed;
                        }
                    }
                });
            });
        });

        return NextResponse.json({
            largeBoxesNeeded,
            smallBoxesNeeded,
            packaging: {
                largeTrays,
                largeLids,
                smallTrays,
                smallLids,
                gallonBags,
                quartBags
            },
            totalActiveOrders: activeOrders.length
        });

    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: "Failed to calculate stats" }, { status: 500 });
    }
}
