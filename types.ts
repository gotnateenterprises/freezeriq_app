// Core Culinary Types
export type Uuid = string;

export interface Ingredient {
    id: Uuid;
    name: string;
    sku: string;
    cost_per_unit: number;
    unit: string; // 'grams' | 'oz' | 'each'
    supplier_id?: Uuid;
    purchase_cost?: number;
    purchase_unit?: string;
    purchase_quantity?: number;
}

export interface Recipe {
    id: Uuid;
    name: string;
    type: 'prep' | 'menu_item';
    base_yield_qty: number;
    base_yield_unit: string;
    container_type?: 'tray' | 'bag';
    category_id?: Uuid;
    categories?: Category[]; // Many-to-Many support
    label_text?: string;
    allergens?: string;
    instructions?: string;
    macros?: string;
    image_url?: string;
    description?: string;
    cook_time?: string;
    items: RecipeItem[];
}

export interface Category {
    id: Uuid;
    name: string;
    parent_id?: Uuid;
    children?: Category[];
}

export interface RecipeItem {
    id: Uuid;
    parent_recipe_id: Uuid;
    child_item_id: Uuid;
    child_type: 'ingredient' | 'recipe';
    name: string;
    quantity: number;
    unit: string;
    supplier_name?: string;
    stock_quantity?: number;
    cost_per_unit?: number;
    cost_unit?: string; // Unit the cost refers to (e.g. 'lb')
    sku?: string;
    supplier_url?: string;
    purchase_cost?: number;
    purchase_unit?: string;
    purchase_quantity?: number;

    // NEW
    is_sub_recipe?: boolean;
    section_name?: string;
    section_batch?: number;
    portal_type?: string;
    search_url_pattern?: string;
}

// Commercial Types
export interface Bundle {
    id: Uuid;
    name: string;
    sku: string;
    recipes: Recipe[]; // Resolved from bundle_contents
}

export interface OrderLineItem {
    bundle_id: Uuid;
    quantity: number;
    variant_size: 'serves_2' | 'serves_5';
}

// Production Types
export interface ProductionTask {
    item_name: string;
    total_qty: number;
    unit: string;
    type: 'buy' | 'prep' | 'cook';
}
