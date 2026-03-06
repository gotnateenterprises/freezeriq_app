
import { prisma } from './db';
import { Uuid } from '../types';

export interface DB {
    findOrgByName(name: string): Promise<{ id: Uuid } | null>;
    createOrg(name: string, email?: string): Promise<{ id: Uuid }>;
    createOrder(order: any): Promise<Uuid>;
    createOrderLineItem(item: any): Promise<void>;
    findBundleBySku(sku: string): Promise<{ id: Uuid } | null>;
    findBundleByName(name: string): Promise<{ id: Uuid } | null>;
    deleteOrdersWithNoItems(source: string): Promise<number>;
}

export class IngestionDBAdapter implements DB {
    private businessId: string;

    constructor(businessId: string) {
        this.businessId = businessId;
    }

    async findOrgByName(name: string) {
        return prisma.customer.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                business_id: this.businessId
            },
            select: { id: true }
        });
    }

    async createOrg(name: string, email?: string) {
        // Check for existing customer by name/email/business
        const existing = await prisma.customer.findFirst({
            where: {
                OR: [
                    { name: { equals: name, mode: 'insensitive' } },
                    email ? { contact_email: { equals: email, mode: 'insensitive' } } : {}
                ],
                business_id: this.businessId
            },
            select: { id: true }
        });

        if (existing) return existing;

        return prisma.customer.create({
            data: {
                name,
                contact_email: email || '',
                business_id: this.businessId,
                status: 'LEAD',
                source: 'Sync'
            },
            select: { id: true }
        });
    }

    async createOrder(order: any) {
        // Idempotency: Upsert (Update if exists, Create if not)
        const exists = await prisma.order.findUnique({
            where: { external_id: order.external_id }
        });

        if (exists) {
            // Delete existing line items to ensure fresh sync
            await prisma.orderItem.deleteMany({
                where: { order_id: exists.id }
            });

            const updated = await prisma.order.update({
                where: { external_id: order.external_id },
                data: {
                    total_amount: order.total_amount || 0,
                    status: order.status,
                    customer_name: order.customer_name,
                    customer_id: order.organization_id || exists.customer_id,
                    created_at: order.created_at ? new Date(order.created_at) : undefined,
                }
            });
            return updated.id;
        }

        const created = await prisma.order.create({
            data: {
                id: order.id,
                business_id: this.businessId,
                external_id: order.external_id,
                source: order.source,
                status: order.status,
                customer_id: order.organization_id,
                customer_name: order.customer_name,
                delivery_date: order.delivery_date ? new Date(order.delivery_date) : null,
                created_at: order.created_at ? new Date(order.created_at) : undefined,
                total_amount: order.total_amount || 0
            }
        });
        return created.id;
    }

    async createOrderLineItem(item: any) {
        await prisma.orderItem.create({
            data: {
                order_id: item.order_id,
                bundle_id: item.bundle_id,
                quantity: item.quantity,
                variant_size: item.variant_size || 'serves_5'
            }
        });
    }

    async findBundleBySku(sku: string) {
        return prisma.bundle.findFirst({
            where: {
                sku,
                business_id: this.businessId
            },
            select: { id: true }
        });
    }

    async findBundleByName(name: string) {
        // Fetch all bundles for this business
        const bundles = await prisma.bundle.findMany({
            where: { business_id: this.businessId },
            select: { id: true, name: true }
        });

        // Normalize function to strip common suffixes/prefixes and handle case
        const normalize = (s: string) => s.toLowerCase()
            .replace(/[^a-z0-9]/g, ' ')
            .replace(/\b(family size|serves 2|serves 5|keto|gluten free|gf)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        const normalizedItemName = normalize(name);

        // Exact match first
        const exact = bundles.find(b => normalize(b.name) === normalizedItemName);
        if (exact) return { id: exact.id };

        // Then fuzzy: Bidirectional substring match
        const fuzzy = bundles.find(b => {
            const normalizedBundleName = normalize(b.name);
            if (!normalizedBundleName || !normalizedItemName) return false;
            return normalizedItemName.includes(normalizedBundleName) || normalizedBundleName.includes(normalizedItemName);
        });

        if (fuzzy) return { id: fuzzy.id };

        return null;
    }

    async deleteOrdersWithNoItems(source: string) {
        // Find orders with no line items for this business and source
        const brokenOrders = await prisma.order.findMany({
            where: {
                business_id: this.businessId as any,
                source: source as any,
                items: { none: {} },
                created_at: { lt: new Date(Date.now() - 48 * 60 * 60 * 1000) } // Older than 48h
            },
            select: { id: true }
        });

        if (brokenOrders.length === 0) return 0;

        const { count } = await prisma.order.deleteMany({
            where: {
                id: { in: brokenOrders.map(o => o.id) }
            }
        });

        console.log(`[Cleanup] Deleted ${count} broken orders from ${source}`);
        return count;
    }
}
