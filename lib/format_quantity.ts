
/**
 * Formats a decimal number into a culinary-friendly string (e.g. "1.5" -> "1 1/2", "0.33" -> "1/3").
 * Preserves precision for non-standard fractions.
 */
export function formatQuantity(value: number | string | null | undefined): string {
    if (value === null || value === undefined) return '-';

    // Ensure it's a number
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num) || num === 0) return '-';

    // Tolerance for floating point (e.g. 0.333333)
    const tolerance = 0.01;

    // Get integer and fractional parts
    const integerPart = Math.floor(num);
    const fractionalPart = num - integerPart;

    // If effectively integer, return that
    if (fractionalPart < tolerance) {
        return integerPart.toString();
    }

    // If almost next integer (e.g. 0.99), round up
    if (Math.abs(fractionalPart - 1) < tolerance) {
        return (integerPart + 1).toString();
    }

    // Common Fractions Lookup
    const fractions: { val: number, str: string }[] = [
        { val: 1 / 2, str: '1/2' },
        { val: 1 / 3, str: '1/3' },
        { val: 2 / 3, str: '2/3' },
        { val: 1 / 4, str: '1/4' },
        { val: 3 / 4, str: '3/4' },
        { val: 1 / 8, str: '1/8' },
        { val: 3 / 8, str: '3/8' },
        { val: 5 / 8, str: '5/8' },
        { val: 7 / 8, str: '7/8' },
        // Sixths (less common but useful)
        { val: 1 / 6, str: '1/6' },
        { val: 5 / 6, str: '5/6' }
    ];

    // Find closest fraction
    const match = fractions.find(f => Math.abs(fractionalPart - f.val) < tolerance);

    if (match) {
        return integerPart > 0 ? `${integerPart} ${match.str}` : match.str;
    }

    // Fallback: If no nice fraction fits, use decimal (max 2 places)
    // Strip trailing zeros e.g. 1.50 -> 1.5
    return parseFloat(num.toFixed(2)).toString();
}
