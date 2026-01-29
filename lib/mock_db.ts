import { DBAdapter } from './kitchen_engine';
import { Recipe, Uuid, Bundle } from '../types';
import fs from 'fs';
import path from 'path';

export class MockDB implements DBAdapter {
    private recipes: Recipe[] = [];
    private bundles: Bundle[] = [];

    constructor() {
        this.loadData();
    }

    private loadData() {
        // Load Recipes from JSON
        try {
            const recipePath = path.join(process.cwd(), 'data', 'recipes.json');
            if (fs.existsSync(recipePath)) {
                this.recipes = JSON.parse(fs.readFileSync(recipePath, 'utf-8'));
            }
        } catch (e) { console.error("Failed to load recipes", e); }

        // Hardcoded Bundles for MVP
        this.bundles = [
            {
                id: 'bun_comfort',
                name: 'Comfort Classics Bundle',
                sku: 'BUNDLE-A',
                recipes: [] // Logic handles linking separately via contents
            }
        ];
    }

    async getRecipe(id: Uuid): Promise<Recipe | null> {
        // Refresh data on every read for dev speed
        this.loadData();
        return this.recipes.find(r => r.id === id) || null;
    }

    async getBundleContents(bundleId: Uuid): Promise<{ recipe_id: Uuid; position: number }[]> {
        // For MVP: If bundle is Comfort Classics, return ALL menu_items we found in DB
        // This is a hack to make the demo work without building a Bundle Editor UI yet.
        // It effectively says "The Bundle contains ALL Recipes you have created".
        const menuItems = this.recipes.filter(r => r.type === 'menu_item');
        return menuItems.map((r, i) => ({ recipe_id: r.id, position: i + 1 }));
    }

    async getBundleInfo(bundleId: Uuid): Promise<{ serving_tier: string } | null> {
        return { serving_tier: 'family' }; // Default mock return
    }

    async getBundles(): Promise<Bundle[]> {
        return this.bundles;
    }
}
