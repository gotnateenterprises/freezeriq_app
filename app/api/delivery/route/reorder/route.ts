import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { auth } from "@/auth";

// SEC-PUBLIC-ROUTE-1. This handler had no auth() call and updated orders by bare
// primary key, so an anonymous caller could renumber any tenant's delivery route
// with a list of guessed Order UUIDs — and, because order.update throws inside a
// transaction when the row is missing, a single-element array distinguished
// "this UUID exists" (200) from "it does not" (500), an unauthenticated
// existence oracle.
//
// Two changes close both holes:
//   1. the session guard, and
//   2. updateMany instead of update, with business_id in the where clause.
// updateMany is a silent no-op on a non-matching row rather than a throw, so a
// foreign or bogus id now neither writes nor changes the response — the oracle
// disappears along with the write.
//
// The import of `prisma` from '@/lib/db' replaces a module-scope
// `new PrismaClient()`. That was a connection-pool hazard on serverless, and it
// also made this handler untestable: the security tests mock '@/lib/db', which a
// privately constructed client bypasses entirely.
export async function PUT(req: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { orderIds } = await req.json();

        if (!Array.isArray(orderIds)) {
            return NextResponse.json({ error: "Invalid data format" }, { status: 400 });
        }

        // Use transaction to update all sequences efficiently
        await prisma.$transaction(
            orderIds.map((id, index) =>
                prisma.order.updateMany({
                    where: { id, business_id: businessId },
                    data: { delivery_sequence: index }
                })
            )
        );

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("Failed to reorder route", e);
        return NextResponse.json({ error: "Failed to save route order" }, { status: 500 });
    }
}
