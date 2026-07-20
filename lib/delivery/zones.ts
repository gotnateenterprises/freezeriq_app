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

/**
 * FIX-DELIVERY-1A: classified geocoding outcome. Distinguishes WHY an address
 * could not be verified so callers can respond honestly instead of blaming
 * the customer for a missing API key or a provider outage.
 *
 *   not_configured — GOOGLE_MAPS_API_KEY is unset.
 *   not_found      — the provider ran and found no matching address
 *                     (e.g. ZERO_RESULTS) — a genuine address problem.
 *   provider_error — REQUEST_DENIED / OVER_QUERY_LIMIT / UNKNOWN_ERROR / a
 *                     malformed response / a network failure or thrown fetch.
 */
export type GeocodeResult =
    | { ok: true; latitude: number; longitude: number }
    | { ok: false; reason: 'not_configured' | 'not_found' | 'provider_error' };

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
 * FIX-DELIVERY-1A: geocode an address with a classified result — the caller
 * learns WHY a lookup failed (missing config / no matching address / provider
 * fault) rather than a bare failure signal. Never logs the full address, the
 * API key, or a provider URL (which embeds the key).
 */
export async function geocodeAddressDetailed(address: string): Promise<GeocodeResult> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.error('[DELIVERY_ZONES] Geocoding unavailable: GOOGLE_MAPS_API_KEY is not configured');
        return { ok: false, reason: 'not_configured' };
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.status === 'ZERO_RESULTS') {
            console.warn('[DELIVERY_ZONES] Geocoding found no matching address (status: ZERO_RESULTS)');
            return { ok: false, reason: 'not_found' };
        }

        if (data.status !== 'OK' || !data.results?.length) {
            console.error('[DELIVERY_ZONES] Geocoding provider returned status:', data.status);
            return { ok: false, reason: 'provider_error' };
        }

        const location = data.results[0].geometry.location;
        return { ok: true, latitude: location.lat, longitude: location.lng };
    } catch (error) {
        console.error('[DELIVERY_ZONES] Geocoding provider request failed');
        return { ok: false, reason: 'provider_error' };
    }
}

/**
 * Geocode an address string to lat/lng using Google Maps Geocoding API.
 * Returns null if the address can't be resolved for ANY reason.
 *
 * Legacy coarse contract — preserved unchanged for existing callers
 * (app/api/admin/storefront-config/route.ts, app/api/checkout/session/route.ts)
 * that only need a success/failure signal. Callers that must distinguish WHY
 * a lookup failed (e.g. to avoid blaming the customer for a config/provider
 * fault) should use geocodeAddressDetailed() instead — see
 * app/api/checkout/validate-delivery/route.ts.
 */
export async function geocodeAddress(address: string): Promise<GeoResult | null> {
    const result = await geocodeAddressDetailed(address);
    if (!result.ok) return null;
    return { lat: result.latitude, lng: result.longitude };
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
