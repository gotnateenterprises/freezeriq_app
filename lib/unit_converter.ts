// Basic conversion factors to Teaspoons (Volume Base)
const TO_TSP: Record<string, number> = {
    'tsp': 1,
    't': 1,
    'ts': 1,
    'teaspoon': 1,
    'tbsp': 3,
    'T': 3,
    'tbl': 3,
    'tablespoon': 3,
    'fl oz': 6,  // Fluid Ounce = 6 tsp (approx. 29.57ml)
    // REMOVED 'oz' from here to strictly separate Weight/Volume
    'c': 48,
    'cup': 48,
    'cups': 48,
    'pt': 96,
    'pint': 96,
    'qt': 192,
    'quart': 192,
    'gal': 768,
    'gallon': 768,
    'ml': 0.202884, // Approx 1ml = 0.202 tsp
    'l': 202.884,
    'liter': 202.884
};

// Hierarchy for output (Largest to Smallest)
const VOLUME_HIERARCHY = [
    { unit: 'gal', factor: 768, threshold: 0.5 },
    { unit: 'qt', factor: 192, threshold: 0.5 },
    { unit: 'pt', factor: 96, threshold: 0.5 },
    { unit: 'cup', factor: 48, threshold: 0.25 },
    { unit: 'fl oz', factor: 6, threshold: 0.5 },
    { unit: 'tbsp', factor: 3, threshold: 0.5 },
    { unit: 'tsp', factor: 1, threshold: 0 }
];

// Basic conversion factors to Grams (Weight Base)
const TO_GRAMS: Record<string, number> = {
    'g': 1,
    'gram': 1,
    'kg': 1000,
    'kilogram': 1000,
    'oz': 28.3495, // Weight oz
    'ounce': 28.3495,
    'ounces': 28.3495,
    'lb': 453.592,
    'pound': 453.592,
    'pounds': 453.592,
    'lbs': 453.592
};

const WEIGHT_HIERARCHY = [
    { unit: 'lb', factor: 453.592 },
    { unit: 'oz', factor: 28.3495 },
    { unit: 'kg', factor: 1000 }, // Added KG for large scale
    { unit: 'g', factor: 1 }
];

const DENSITY_TABLE: Record<string, number> = {
    // Baking & Pantry
    'sugar': 200, 'brown sugar': 220, 'powdered sugar': 120, 'flour': 120,
    'salt': 273, 'rice': 185, 'oats': 90, 'breadcrumb': 108, 'cornstarch': 128,
    // Fats & Oils
    'butter': 227, 'oil': 218, 'olive oil': 216, 'coconut oil': 218,
    // Liquids & Sauces
    'honey': 340, 'maple syrup': 322, 'milk': 245, 'cream': 238,
    'sour cream': 230, 'yogurt': 245, 'broth': 240, 'stock': 240,
    'sauce': 245, 'salsa': 240, 'enchilada': 245, 'picante': 240,
    'dressing': 240, 'ranch': 240,
    // Cheese & Dairy
    'cream cheese': 232, 'ricotta': 246, 'cheese': 113,
    'parmesan': 100, 'mozzarella': 113, 'cheddar': 113,
    // Proteins
    'chicken': 140, 'ground beef': 225, 'beef': 225, 'pork': 225,
    'sausage': 225, 'turkey': 140, 'bacon': 150,
    // Vegetables & Produce
    'cauliflower': 107, 'broccoli': 91, 'carrot': 128, 'onion': 160,
    'pepper': 150, 'tomato': 180, 'potato': 150, 'corn': 154,
    'pea': 145, 'bean': 180, 'black bean': 172, 'spinach': 30,
    'celery': 101, 'mushroom': 70, 'zucchini': 124, 'squash': 116,
    'cabbage': 89, 'lettuce': 55, 'cucumber': 119, 'garlic': 224,
    'minced garlic': 224, 'green pepper': 150, 'banana pepper': 150,
    // Pasta & Grains
    'pasta': 105, 'noodle': 105, 'macaroni': 105,
    // Eggs
    'egg': 243, 'liquid egg': 243,
    // Nuts & Seeds
    'almond': 143, 'walnut': 120, 'pecan': 109,
    // Canned goods (drained weight approximations)
    'hash brown': 210, 'tater tot': 200, 'cranberry': 250,
};

export function optimizeUnit(qty: number, unit: string, ingredientName?: string): { qty: number, unit: string, original: string } {
    const lowerUnit = unit.toLowerCase().trim();

    // 0. Check Density Bridge
    if (ingredientName && TO_TSP[lowerUnit] && !TO_GRAMS[lowerUnit]) {
        const densityKey = Object.keys(DENSITY_TABLE).find(k => ingredientName.toLowerCase().includes(k));
        if (densityKey) {
            const cups = (qty * TO_TSP[lowerUnit]) / 48;
            const totalGrams = cups * DENSITY_TABLE[densityKey];
            if (totalGrams > 50) return optimizeWeight(totalGrams, 'g');
        }
    }

    // 1. Explicit Weight Check
    if (TO_GRAMS[lowerUnit] && !TO_TSP[lowerUnit]) {
        return optimizeWeight(qty, lowerUnit);
    }

    // 2. Explicit Volume Check
    if (TO_TSP[lowerUnit]) {
        return optimizeVolume(qty, lowerUnit);
    }

    // 3. Ambiguous Fallback (e.g. if 'oz' somehow still passed as generic)
    // If unit is 'oz' and not in TO_TSP, it will hit Weight check above now.

    // Unknown unit, return as is
    return { qty, unit, original: `${qty} ${unit}` };
}



function optimizeVolume(qty: number, unit: string) {
    const tspTotal = qty * TO_TSP[unit];

    // Find best fit
    for (const level of VOLUME_HIERARCHY) {
        const val = tspTotal / level.factor;
        const threshold = (level as any).threshold ?? 0.25;
        // Threshold: Use larger unit only if we have at least 'threshold' of it
        if (val >= threshold) {
            return {
                qty: parseFloat(val.toFixed(2)),
                unit: level.unit,
                original: `${qty} ${unit}`
            };
        }
    }

    // Fallback to tsp
    return { qty: parseFloat(tspTotal.toFixed(2)), unit: 'tsp', original: `${qty} ${unit}` };
}

function optimizeWeight(qty: number, unit: string) {
    const gTotal = qty * (TO_GRAMS[unit] || 1);

    for (const level of WEIGHT_HIERARCHY) {
        const val = gTotal / level.factor;
        if (val >= 0.5) { // Weight usually wants slightly larger chunks
            return {
                qty: parseFloat(val.toFixed(2)),
                unit: level.unit,
                original: `${qty} ${unit}`
            };
        }
    }

    return { qty: parseFloat(gTotal.toFixed(2)), unit: 'g', original: `${qty} ${unit}` };
}

/**
 * Converts quantity from one unit to another, supporting Density bridges for Volume <-> Weight.
 * Returns original qty if conversion is impossible.
 */
export function convertUnit(qty: number, from: string, to: string, ingredientName?: string): number {
    const fromL = from.toLowerCase().trim();
    const toL = to.toLowerCase().trim();

    if (fromL === toL) return qty;

    // 1. Try Volume Conversion (Both are Volume)
    if (TO_TSP[fromL] && TO_TSP[toL]) {
        const base = qty * TO_TSP[fromL]; // to tsp
        return base / TO_TSP[toL];
    }

    // 2. Try Weight Conversion (Both are Weight)
    if (TO_GRAMS[fromL] && TO_GRAMS[toL]) {
        const base = qty * TO_GRAMS[fromL]; // to grams
        return base / TO_GRAMS[toL];
    }

    // 3. Density Bridge (Volume <-> Weight)
    if (ingredientName) {
        const densityKey = Object.keys(DENSITY_TABLE).find(k => ingredientName.toLowerCase().includes(k));
        if (densityKey) {
            const gramsPerCup = DENSITY_TABLE[densityKey];

            // Case A: From Volume -> To Weight
            if (TO_TSP[fromL] && TO_GRAMS[toL]) {
                const tsp = qty * TO_TSP[fromL];
                const cups = tsp / 48;
                const grams = cups * gramsPerCup;
                return grams / TO_GRAMS[toL];
            }

            // Case B: From Weight -> To Volume
            if (TO_GRAMS[fromL] && TO_TSP[toL]) {
                const grams = qty * TO_GRAMS[fromL];
                const cups = grams / gramsPerCup;
                const tsp = cups * 48;
                return tsp / TO_TSP[toL];
            }
        }
    }

    // 4. Count/discrete units — cannot convert to/from weight or volume.
    //    This is NOT drift — "each" is a fundamentally different measurement
    //    family. Log a warning but return the original quantity.
    const COUNT_UNITS = new Set(['each', 'piece', 'pieces', 'whole', 'unit', 'units', 'count', 'ea', 'pc', 'pcs', 'slice', 'slices']);
    if (COUNT_UNITS.has(fromL) || COUNT_UNITS.has(toL)) {
        console.warn(
            `[UNIT CONVERSION WARNING] Cannot convert ${qty} "${from}" → "${to}"` +
            `${ingredientName ? ` for ingredient "${ingredientName}"` : ''}. ` +
            `Count units ("each", "piece", etc.) are not convertible to weight/volume. ` +
            `Returning original quantity. Review recipe data if aggregation looks wrong.`
        );
        return qty;
    }

    // 5. Volume ↔ Weight fallback (no density entry found).
    //    Use water density (236g/cup) as a reasonable approximation.
    //    This prevents crashes for ingredients not yet in DENSITY_TABLE.
    const DEFAULT_GRAMS_PER_CUP = 236; // water density — safe fallback
    if ((TO_TSP[fromL] && TO_GRAMS[toL]) || (TO_GRAMS[fromL] && TO_TSP[toL])) {
        console.warn(
            `[UNIT CONVERSION APPROX] Converting ${qty} "${from}" → "${to}"` +
            `${ingredientName ? ` for ingredient "${ingredientName}"` : ''} ` +
            `using water density fallback (${DEFAULT_GRAMS_PER_CUP}g/cup). ` +
            `Add this ingredient to DENSITY_TABLE for accurate conversion.`
        );
        if (TO_TSP[fromL] && TO_GRAMS[toL]) {
            // Volume → Weight
            const tsp = qty * TO_TSP[fromL];
            const cups = tsp / 48;
            const grams = cups * DEFAULT_GRAMS_PER_CUP;
            return grams / TO_GRAMS[toL];
        } else {
            // Weight → Volume
            const grams = qty * TO_GRAMS[fromL];
            const cups = grams / DEFAULT_GRAMS_PER_CUP;
            const tsp = cups * 48;
            return tsp / TO_TSP[toL];
        }
    }

    // 6. Impossible Conversion — LAW 8: FAIL LOUDLY, never return silent garbage
    throw new Error(
        `[UNIT CONVERSION FAILURE] Cannot convert ${qty} "${from}" → "${to}"` +
        `${ingredientName ? ` for ingredient "${ingredientName}"` : ''}. ` +
        `No conversion path found (incompatible unit families without density bridge). ` +
        `This MUST be fixed in the recipe data.`
    );
}

/**
 * Converts a decimal to a common kitchen fraction string (e.g., 0.33 -> 1/3)
 */
export function toFraction(val: number): string {
    if (val === 0) return '0';
    if (val < 0) return '-' + toFraction(Math.abs(val));

    const whole = Math.floor(val);
    const remainder = val - whole;

    // Standard Measuring Sizes
    const sizes = [
        { d: 0, f: '' },
        { d: 0.125, f: '1/8' },
        { d: 0.25, f: '1/4' },
        { d: 0.333, f: '1/3' },
        { d: 0.5, f: '1/2' },
        { d: 0.75, f: '3/4' },
        { d: 1, f: '1' } // This will increment 'whole'
    ];

    // Find the nearest size
    let nearest = sizes[0];
    let minDiff = Math.abs(remainder - sizes[0].d);

    for (let i = 1; i < sizes.length; i++) {
        const diff = Math.abs(remainder - sizes[i].d);
        if (diff < minDiff) {
            minDiff = diff;
            nearest = sizes[i];
        }
    }

    if (nearest.d === 1) {
        return (whole + 1).toString();
    }

    if (nearest.d === 0) {
        return whole > 0 ? whole.toString() : '0'; // Handle small decimals rounding to 0
    }

    return (whole > 0 ? whole + ' ' : '') + nearest.f;
}
