/**
 * Status Workflow Management
 * Handles automatic progression through the customer pipeline stages
 */

import { prisma } from '@/lib/db';
import {
    STATUS_FLOW,
    STATUS_LABELS,
    STATUS_COLORS,
    type CustomerStatus,
} from './statusConstants';

export type { CustomerStatus };
export { STATUS_FLOW, STATUS_LABELS, STATUS_COLORS };

/**
 * Progress customer to the next status in the pipeline
 */
export async function progressStatus(
    customerId: string,
    trigger?: string
): Promise<{ success: boolean; newStatus: CustomerStatus | null; message: string }> {
    try {
        // Get current customer status
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { status: true },
        });

        if (!customer) {
            return { success: false, newStatus: null, message: 'Customer not found' };
        }

        const currentStatus = customer.status as CustomerStatus;
        const nextStatus = STATUS_FLOW[currentStatus];

        if (!nextStatus) {
            return { success: false, newStatus: null, message: 'Customer is already at terminal status' };
        }

        // Update customer status
        const updateData: any = { status: nextStatus };

        // If moving to COMPLETE, archive the customer
        if (nextStatus === 'COMPLETE') {
            updateData.archived = true;
            updateData.archived_at = new Date();
        }

        await prisma.customer.update({
            where: { id: customerId },
            data: updateData,
        });

        console.log(`✅ Customer ${customerId} progressed: ${currentStatus} → ${nextStatus}${trigger ? ` (trigger: ${trigger})` : ''}`);

        return {
            success: true,
            newStatus: nextStatus,
            message: `Status updated to ${STATUS_LABELS[nextStatus]}`,
        };
    } catch (error) {
        console.error('Error progressing customer status:', error);
        return { success: false, newStatus: null, message: 'Failed to update status' };
    }
}

/**
 * Manually set customer status (admin override)
 */
export async function setStatus(
    customerId: string,
    newStatus: CustomerStatus
): Promise<{ success: boolean; message: string }> {
    try {
        const updateData: any = { status: newStatus };

        // If moving to COMPLETE, archive the customer
        if (newStatus === 'COMPLETE') {
            updateData.archived = true;
            updateData.archived_at = new Date();
        }

        // If moving away from COMPLETE, unarchive
        if (newStatus !== 'COMPLETE') {
            updateData.archived = false;
            updateData.archived_at = null;
        }

        await prisma.customer.update({
            where: { id: customerId },
            data: updateData,
        });

        console.log(`✅ Customer ${customerId} status manually set to ${newStatus}`);

        return {
            success: true,
            message: `Status updated to ${STATUS_LABELS[newStatus]}`,
        };
    } catch (error) {
        console.error('Error setting customer status:', error);
        return { success: false, message: 'Failed to update status' };
    }
}

/**
 * Get the next status in the pipeline
 */
export function getNextStatus(currentStatus: CustomerStatus): CustomerStatus | null {
    return STATUS_FLOW[currentStatus];
}

/**
 * Check if a status transition is valid
 */
export function isValidTransition(from: CustomerStatus, to: CustomerStatus): boolean {
    // Allow moving forward in the pipeline
    let current: CustomerStatus | null = from;
    while (current) {
        if (current === to) return true;
        current = STATUS_FLOW[current];
    }
    return false;
}

/**
 * Archive a customer
 */
export async function archiveCustomer(customerId: string): Promise<{ success: boolean; message: string }> {
    try {
        await prisma.customer.update({
            where: { id: customerId },
            data: {
                status: 'COMPLETE',
                archived: true,
                archived_at: new Date(),
            },
        });

        return { success: true, message: 'Customer archived successfully' };
    } catch (error) {
        console.error('Error archiving customer:', error);
        return { success: false, message: 'Failed to archive customer' };
    }
}

/**
 * Unarchive a customer (for starting a new fundraiser)
 */
export async function unarchiveCustomer(customerId: string): Promise<{ success: boolean; message: string }> {
    try {
        await prisma.customer.update({
            where: { id: customerId },
            data: {
                status: 'LEAD',
                archived: false,
                archived_at: null,
            },
        });

        return { success: true, message: 'Customer unarchived and reset to LEAD status' };
    } catch (error) {
        console.error('Error unarchiving customer:', error);
        return { success: false, message: 'Failed to unarchive customer' };
    }
}
