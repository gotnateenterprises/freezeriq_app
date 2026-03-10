// API middleware for consistent error handling in route handlers
import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';

type RouteHandler = (...args: any[]) => Promise<NextResponse>;

export function withErrorHandler(handler: RouteHandler): RouteHandler {
    return async (...args: any[]) => {
        try {
            return await handler(...args);
        } catch (error: any) {
            if (error instanceof AppError) {
                return NextResponse.json(
                    { error: error.message },
                    { status: error.statusCode }
                );
            }

            console.error('[API Error]', error);
            return NextResponse.json(
                { error: error?.message || 'Internal Server Error' },
                { status: 500 }
            );
        }
    };
}
