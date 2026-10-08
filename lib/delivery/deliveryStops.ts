/**
 * DELIVERY-FUNDRAISER-GROUPING-1 — the Delivery board's stops.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §3 (as amended for this
 * phase) and §15.3.
 *
 * Freezer Chef does not drive to each fundraiser supporter. It delivers the whole
 * campaign to ONE drop location, and the coordinator hands out the boxes later
 * with the Pickup Tracker. So the board shows one stop per FundraiserCampaign,
 * while an ordinary customer keeps the one stop per order it has always had.
 *
 * WHAT THIS DOES — AND WHAT IT LEAVES ALONE
 *
 *   - Grouping is lib/delivery/orderClassification.ts `groupOrdersForDelivery`,
 *     keyed on FundraiserCampaign.id and nothing else (contract §1). It is not
 *     re-derived here.
 *   - Box counts are lib/physicalBoxPacking.ts `summarizeItemPacking`, which never
 *     pairs across an order, so a stop's cartons are exactly the sum of its
 *     orders' cartons and the board's totals cannot move.
 *   - A stop carries every underlying Order id. The orders stay the source of
 *     truth: labels, slips, the manifest, production and the Pickup Tracker all
 *     keep working order by order. Nothing here creates, merges or writes a row.
 *
 * Pure: no Prisma, no React, no I/O — so the page and the tests run the same code.
 */
import {
    fundraiserDeliveryLocation,
    groupOrdersForDelivery,
    type ClassifiableOrder,
    type DeliveryOrderKind,
} from './orderClassification';
import { summarizeItemPacking } from '../physicalBoxPacking';

/** One row of /api/delivery/queue, narrowed to what a stop reads. */
export interface DeliveryQueueRow extends ClassifiableOrder {
    id: string;
    /** The display name the page resolved (supporter name, then customer name). */
    customerName?: string | null;
    delivery_address?: string | null;
    delivery_sequence?: number | null;
    items?: {
        id?: string | null;
        bundle_id?: string | null;
        quantity?: number | null;
        variant_size?: string | null;
        bundle?: { name?: string | null } | null;
    }[] | null;
    campaign?: {
        id: string;
        name?: string | null;
        pickup_location?: string | null;
        delivery_date?: string | Date | null;
        delivery_time?: string | null;
        /** The ORGANIZATION that runs the campaign — never a supporter's Customer row. */
        customer?: {
            name?: string | null;
            delivery_address?: string | null;
            contact_name?: string | null;
            contact_phone?: string | null;
        } | null;
    } | null;
}

export interface StopBoxes {
    large: number;
    small: number;
    total: number;
    /** Lines whose sold size can't be proven — reported, never folded into a guess. */
    unpackable: number;
}

/** Where a stop's navigation address came from. */
export type StopAddressSource =
    | 'organization_address'
    | 'campaign_pickup_location'
    | 'order_address'
    | null;

export interface DeliveryStopOrder {
    id: string;
    name: string;
    boxes: StopBoxes;
}

export interface DeliveryStop {
    /** Stable id for drag-and-drop and route optimisation: `campaign:<id>` or the order id. */
    id: string;
    kind: DeliveryOrderKind;
    campaignId: string | null;
    /** Every underlying Order, in route order. Never empty. */
    orderIds: string[];
    orders: DeliveryStopOrder[];
    /** Organization (fundraiser) or customer name. */
    title: string;
    /** Campaign name for a fundraiser stop. */
    campaignName: string | null;
    /** A routable address, or null — never a placeholder that would be navigated to. */
    address: string | null;
    addressSource: StopAddressSource;
    /** The campaign's pickup-location text, shown even when it can't be navigated to. */
    locationNote: string | null;
    deliveryDate: string | null;
    deliveryTime: string | null;
    contactName: string | null;
    contactPhone: string | null;
    orderCount: number;
    boxes: StopBoxes;
    bundles: string[];
    /** The lowest saved delivery_sequence among the stop's orders. */
    sequence: number;
}

/** Shown on an ordinary customer's stop that has no address — unchanged copy. */
export const NO_ADDRESS_LABEL = 'No Address Provided';
/** Shown on a fundraiser stop that has nowhere to navigate to. */
export const FUNDRAISER_ADDRESS_NEEDED_LABEL = 'Delivery address needed';

function text(value: unknown): string | null {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * True when free text reads like a street address: a house number followed by a
 * word ("719 W Lincoln Ave", "210 W Washington St"). A campaign's pickup location
 * is free text — "Farm Bureau Basement" is a perfectly good note for a driver but
 * not something to hand to a map, which would pick an arbitrary match.
 */
export function looksLikeStreetAddress(value: string | null | undefined): boolean {
    const t = text(value);
    return t !== null && /\b\d{1,6}[A-Za-z]?\s+[A-Za-z]/.test(t);
}

/**
 * Where a fundraiser stop navigates to (owner ruling, this phase):
 *
 *   1. a structured campaign delivery address — none exists in the schema today;
 *   2. the ORGANIZATION's profile address (FundraiserCampaign.customer.delivery_address);
 *   3. the campaign's pickup location, when it reads like a street address;
 *   4. otherwise nothing: the stop says "Delivery address needed" and is left out
 *      of navigation rather than given a made-up destination.
 *
 * Never a supporter's address and never Order.delivery_address, which for a
 * fundraiser order is NULL or a coordinator's free-text note (contract §3.3).
 */
export function resolveFundraiserStopAddress(order: DeliveryQueueRow): {
    address: string | null;
    addressSource: StopAddressSource;
    locationNote: string | null;
} {
    const pickup = fundraiserDeliveryLocation(order);
    const locationNote = pickup.status === 'resolved' ? pickup.location : null;

    const orgAddress = text(order.campaign?.customer?.delivery_address);
    if (orgAddress) return { address: orgAddress, addressSource: 'organization_address', locationNote };

    if (locationNote && looksLikeStreetAddress(locationNote)) {
        return { address: locationNote, addressSource: 'campaign_pickup_location', locationNote };
    }
    return { address: null, addressSource: null, locationNote };
}

function boxesFor(orders: readonly DeliveryQueueRow[]): StopBoxes {
    const s = summarizeItemPacking(orders as any);
    return { large: s.largeBoxCount, small: s.smallBoxCount, total: s.physicalBoxCount, unpackable: s.unpackable };
}

function dateOnly(value: string | Date | null | undefined): string | null {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const sequenceOf = (o: DeliveryQueueRow) => (typeof o.delivery_sequence === 'number' ? o.delivery_sequence : 0);
const nameOf = (o: DeliveryQueueRow) => text(o.customerName) ?? 'Unknown Customer';

/**
 * Queue rows -> stops, in route order.
 *
 * A fundraiser campaign is one stop holding all of its orders; anything else is
 * one stop per order exactly as before. Stops sort by the lowest saved sequence
 * among their orders, ties keeping first-appearance order, so a board with no
 * fundraiser on it comes out in the same order it always did.
 */
export function buildDeliveryStops(rows: readonly DeliveryQueueRow[]): DeliveryStop[] {
    const groups = groupOrdersForDelivery(rows);
    const stops = groups.map((group): DeliveryStop => {
        const orders = [...group.orders].sort((a, b) => sequenceOf(a) - sequenceOf(b));
        const first = orders[0];
        const stopOrders = orders.map((o) => ({ id: o.id, name: nameOf(o), boxes: boxesFor([o]) }));
        const bundles = orders.flatMap((o) => (o.items || []).map((i) => i?.bundle?.name || 'Item'));
        const sequence = Math.min(...orders.map(sequenceOf));

        if (group.kind === 'fundraiser') {
            const campaign = first.campaign ?? null;
            const where = resolveFundraiserStopAddress(first);
            return {
                id: `campaign:${group.campaignId}`,
                kind: 'fundraiser',
                campaignId: group.campaignId,
                orderIds: orders.map((o) => o.id),
                orders: stopOrders,
                title: text(campaign?.customer?.name) ?? text(campaign?.name) ?? 'Fundraiser',
                campaignName: text(campaign?.name),
                ...where,
                deliveryDate: dateOnly(campaign?.delivery_date),
                deliveryTime: text(campaign?.delivery_time),
                contactName: text(campaign?.customer?.contact_name),
                contactPhone: text(campaign?.customer?.contact_phone),
                orderCount: orders.length,
                boxes: boxesFor(orders),
                bundles,
                sequence,
            };
        }

        // An ordinary customer (or a row that is not unambiguously a fundraiser
        // order): its own stop at its own address, as it always was.
        return {
            id: first.id,
            kind: group.kind,
            campaignId: null,
            orderIds: [first.id],
            orders: stopOrders,
            title: nameOf(first),
            campaignName: null,
            address: text(first.delivery_address),
            addressSource: text(first.delivery_address) ? 'order_address' : null,
            locationNote: null,
            deliveryDate: null,
            deliveryTime: null,
            contactName: null,
            contactPhone: null,
            orderCount: 1,
            boxes: boxesFor([first]),
            bundles,
            sequence,
        };
    });

    // Array.prototype.sort is stable, so equal sequences keep first-appearance order.
    return stops.sort((a, b) => a.sequence - b.sequence);
}

/** Stops that can be handed to a map. A stop without an address is never guessed at. */
export function navigableStops<T extends Pick<DeliveryStop, 'address'>>(stops: readonly T[]): T[] {
    return stops.filter((s) => text(s.address) !== null);
}

/**
 * Every underlying Order id, stop by stop, in route order. This is what the
 * route-reorder save and the box-label reprint consume: a fundraiser stop's
 * orders stay together in one contiguous run, and no order is dropped.
 */
export function orderIdsInRouteOrder(stops: readonly Pick<DeliveryStop, 'orderIds'>[]): string[] {
    return stops.flatMap((s) => s.orderIds);
}
