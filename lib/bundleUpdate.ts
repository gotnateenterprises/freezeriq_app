// PUT /api/bundles/[id] contract: an omitted key leaves the column untouched (the list switches send one flag).

const MAX_PRICE = 99_999_999.99; // DECIMAL(10,2) ceiling

export interface BundleUpdateData {
    name?: string;
    sku?: string;
    description?: string | null;
    serving_tier?: string;
    is_active?: boolean;
    show_on_storefront?: boolean;
    price?: number | null;
    order_cutoff_date?: Date | null;
    catalog_id?: string | null;
    image_url?: string | null;
}

export type BundleUpdateResult =
    | { ok: true; data: BundleUpdateData; catalogIdToVerify: string | null }
    | { ok: false; status: 400; error: string };

const has = (body: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

const isBlank = (v: unknown): boolean => v === null || (typeof v === 'string' && v.trim() === '');

const fail = (error: string): BundleUpdateResult => ({ ok: false, status: 400, error });

// Not rounded here: the DECIMAL(10,2) column rounds exactly as it did before this contract.
function parsePrice(value: unknown): number | undefined {
    if (typeof value !== 'number' && typeof value !== 'string') return undefined;
    const n = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return undefined;
    return n;
}

export function buildBundleUpdateData(
    body: unknown,
    existing: { catalog_id: string | null }
): BundleUpdateResult {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return fail('Request body must be a JSON object.');
    }
    const b = body as Record<string, unknown>;
    const data: BundleUpdateData = {};
    // Only a changed catalog is re-verified, so bundles already filed under one keep saving.
    let catalogIdToVerify: string | null = null;

    if (has(b, 'name')) {
        if (typeof b.name !== 'string' || b.name.trim() === '') return fail('Bundle name is required.');
        data.name = b.name;
    }
    if (has(b, 'sku')) {
        if (typeof b.sku !== 'string' || b.sku.trim() === '') return fail('Bundle SKU is required.');
        data.sku = b.sku;
    }
    if (has(b, 'serving_tier')) {
        if (typeof b.serving_tier !== 'string' || b.serving_tier.trim() === '') {
            return fail('Serving size is required.');
        }
        data.serving_tier = b.serving_tier;
    }
    if (has(b, 'is_active')) {
        if (typeof b.is_active !== 'boolean') return fail('is_active must be true or false.');
        data.is_active = b.is_active;
    }
    if (has(b, 'show_on_storefront')) {
        if (typeof b.show_on_storefront !== 'boolean') return fail('show_on_storefront must be true or false.');
        data.show_on_storefront = b.show_on_storefront;
    }
    if (has(b, 'description')) {
        if (b.description !== null && typeof b.description !== 'string') return fail('Description must be text.');
        data.description = b.description as string | null;
    }
    if (has(b, 'price')) {
        if (isBlank(b.price)) {
            data.price = null;
        } else {
            const price = parsePrice(b.price);
            if (price === undefined) return fail('Price must be an amount of $0.00 or more.');
            data.price = price;
        }
    }
    if (has(b, 'order_cutoff_date')) {
        if (isBlank(b.order_cutoff_date)) {
            data.order_cutoff_date = null;
        } else {
            const d = typeof b.order_cutoff_date === 'string' ? new Date(b.order_cutoff_date) : null;
            if (!d || Number.isNaN(d.getTime())) return fail('Order cutoff date is not a valid date.');
            data.order_cutoff_date = d;
        }
    }
    if (has(b, 'catalog_id')) {
        if (isBlank(b.catalog_id)) {
            data.catalog_id = null;
        } else if (typeof b.catalog_id !== 'string') {
            return fail('catalog_id must be a catalog id.');
        } else {
            data.catalog_id = b.catalog_id;
            if (b.catalog_id !== existing.catalog_id) catalogIdToVerify = b.catalog_id;
        }
    }
    if (has(b, 'image_url')) {
        if (isBlank(b.image_url)) {
            data.image_url = null; // '' is the editor's deliberate "clear the image" signal
        } else if (typeof b.image_url !== 'string') {
            return fail('image_url must be a URL.');
        } else {
            data.image_url = b.image_url;
        }
    }

    return { ok: true, data, catalogIdToVerify };
}
