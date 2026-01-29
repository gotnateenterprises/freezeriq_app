
import { prisma } from './db';
import { Uuid } from '../types';

export interface DB {
    findOrgByName(name: string): Promise<{ id: Uuid } | null>;
    createOrg(name: string, email?: string): Promise<{ id: Uuid }>;
    createOrder(order: any): Promise<void>;
    createOrderLineItem(item: any): Promise<void>;
    findBundleBySku(sku: string): Promise<{ id: Uuid } | null>;
    findBundleByName(name: string): Promise<{ id: Uuid } | null>;
}

export class IngestionDBAdapter implements DB {
    async findOrgByName(name: string) {
        return prisma.organization.findFirst({
            where: { name: { equals: name, mode: 'insensitive' } },
            select: { id: true }
        });
    }

    async createOrg(name: string, email?: string) {
        return prisma.organization.create({
            data: {
                name,
                contact_email: email || ''
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
            await prisma.order.update({
                where: { external_id: order.external_id },
                data: {
                    total_amount: order.total_amount || 0,
                    status: order.status
                }
            });
            return;
        }

        await prisma.order.create({
            data: {
                id: order.id,
                external_id: order.external_id,
                source: order.source,
                status: order.status,
                organization_id: order.organization_id, // Can be null for Square individual orders
                customer_name: order.customer_name,
                delivery_date: order.delivery_date ? new Date(order.delivery_date) : null,
                created_at: order.created_at ? new Date(order.created_at) : undefined,
                total_amount: order.total_amount || 0
            }
        });
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
            where: { sku },
            select: { id: true }
        });
    }

    async findBundleByName(name: string) {
        return prisma.bundle.findFirst({
            where: { name: { contains: name, mode: 'insensitive' } },
            select: { id: true }
        });
    }
}
