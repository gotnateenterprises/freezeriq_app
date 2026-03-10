// Simple logger utility for API routes

export function createLogger(context: string) {
    return {
        info: (...args: any[]) => console.log(`[${context}]`, ...args),
        warn: (...args: any[]) => console.warn(`[${context}]`, ...args),
        error: (...args: any[]) => console.error(`[${context}]`, ...args),
        debug: (...args: any[]) => {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`[${context}:DEBUG]`, ...args);
            }
        }
    };
}
