/**
 * Delivery Zone Utilities
 * 
 * Server-only module for geocoding, distance calculation,
 * and delivery zone resolution for storefront orders.
 * 
 * NOT used by fundraiser flows.
 */

interface GeoResult {
    lat: number;
    lng: number;
}

interface DeliveryZoneInput {
    id: string;
    name: string;
    max_radius_miles: number; // Decimal from DB, pre-converted
    fee: number;             // Decimal from DB, pre-converted
    sort_order: number;
}

interface ZoneMatch {
    deliverable: true;
    zoneName: string;
    zoneId: string;
    fee: number;
    distanceMiles: number;
}

interface ZoneRejection {
    deliverable: false;
    error: string;
    distanceMiles: number;
}

export type ZoneResult = ZoneMatch | ZoneRejection;

/**
 * Geocode an address string to lat/lng using Google Maps Geocoding API.
 * Returns null if the address can't be resolved.
 */
export async function geocodeAddress(address: string): Promise<GeoResult | null> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.error('[DELIVERY_ZONES] GOOGLE_MAPS_API_KEY not configured');
        return null;
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== 'OK' || !data.results?.length) {
            console.warn('[DELIVERY_ZONES] Geocoding failed for address:', address, 'status:', data.status);
            return null;
        }

        const location = data.results[0].geometry.location;
        return {
            lat: location.lat,
            lng: location.lng,
        };
    } catch (error) {
        console.error('[DELIVERY_ZONES] Geocoding API error:', error);
        return null;
    }
}

/**
 * Calculate the straight-line (Haversine) distance between two points in miles.
 * No API call needed — pure math.
 */
export function haversineDistanceMiles(
    lat1: number, lng1: number,
    lat2: number, lng2: number
): number {
    const R = 3958.8; // Earth radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg: number): number {
    return deg * (Math.PI / 180);
}

/**
 * Resolve which delivery zone (if any) a destination falls into.
 * 
 * Zones are evaluated in sort_order. Each zone's max_radius_miles
 * defines the upper bound. The customer address distance is checked
 * against each zone from closest to furthest.
 * 
 * If no zone matches, returns a rejection with a clear error message.
 */
export function resolveDeliveryZone(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    zones: DeliveryZoneInput[]
): ZoneResult {
    const distanceMiles = haversineDistanceMiles(originLat, originLng, destLat, destLng);
    const roundedDistance = Math.round(distanceMiles * 100) / 100;

    // Sort zones by sort_order (should already be sorted, but enforce)
    const sortedZones = [...zones].sort((a, b) => a.sort_order - b.sort_order);

    for (const zone of sortedZones) {
        if (distanceMiles <= zone.max_radius_miles) {
            return {
                deliverable: true,
                zoneName: zone.name,
                zoneId: zone.id,
                fee: zone.fee,
                distanceMiles: roundedDistance,
            };
        }
    }

    return {
        deliverable: false,
        error: 'This address is outside our delivery area.',
        distanceMiles: roundedDistance,
    };
}
