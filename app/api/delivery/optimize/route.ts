import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
    try {
        const { origin, orders } = await req.json();
        const apiKey = process.env.GOOGLE_MAPS_API_KEY;

        if (!origin || !orders || !Array.isArray(orders) || orders.length === 0) {
            return NextResponse.json({ error: "Missing origin or orders" }, { status: 400 });
        }

        if (!apiKey) {
            return NextResponse.json({ error: "Google Maps API Key not configured" }, { status: 500 });
        }

        // Filter out orders without valid addresses
        const validOrders = orders.filter(o => o.address && o.address.trim() !== '' && o.address.toLowerCase() !== 'no address provided');

        if (validOrders.length === 0) {
            return NextResponse.json({ error: "No orders with valid addresses to optimize" }, { status: 400 });
        }

        // Build Distance Matrix Request
        const destinations = validOrders.map(o => encodeURIComponent(o.address)).join('|');
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${destinations}&key=${apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK') {
            console.error("Google Distance Matrix Error:", data);
            return NextResponse.json({ error: `Google API Error: ${data.status} - ${data.error_message || 'Check API enablement'}` }, { status: 500 });
        }

        // Extract distances
        const results = data.rows[0].elements;

        // Map distances back to order IDs
        const orderDistances = validOrders.map((order, index) => {
            const element = results[index];
            return {
                id: order.id,
                distance: element.status === 'OK' ? element.distance.value : Infinity,
                duration: element.status === 'OK' ? element.duration.value : Infinity
            };
        });

        // Simple Optimization: Sort by distance (Nearest Neighbor from Origin)
        // For small batches (typical for daily delivery), this is usually sufficient.
        const optimizedOrder = orderDistances.sort((a, b) => a.distance - b.distance);

        // Re-attach orders that didn't have addresses to the end
        const invalidOrderIds = orders.filter(o => !validOrders.find(vo => vo.id === o.id)).map(o => o.id);

        const finalSequence = [...optimizedOrder.map(o => o.id), ...invalidOrderIds];

        return NextResponse.json({ success: true, optimizedIds: finalSequence });

    } catch (e) {
        console.error("Optimization API Crash:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
