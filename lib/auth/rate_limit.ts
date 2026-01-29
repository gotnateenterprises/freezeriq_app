
const trackers = new Map<string, { count: number; expiresAt: number }>();

export function checkRateLimit(identifier: string, limit: number = 5, windowMs: number = 60 * 1000): { success: boolean, reset?: number } {
    const now = Date.now();
    const tracker = trackers.get(identifier);

    // Cleanup expired
    if (tracker && now > tracker.expiresAt) {
        trackers.delete(identifier);
    }

    if (!trackers.has(identifier)) {
        trackers.set(identifier, { count: 1, expiresAt: now + windowMs });
        return { success: true };
    }

    const current = trackers.get(identifier)!;
    if (current.count >= limit) {
        return { success: false, reset: current.expiresAt };
    }

    current.count++;
    return { success: true };
}
