import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function PUT(req: NextRequest) {
    try {
        const { orderIds } = await req.json();

        if (!Array.isArray(orderIds)) {
            return NextResponse.json({ error: "Invalid data format" }, { status: 400 });
        }

        // Use transaction to update all sequences efficiently
        await prisma.$transaction(
            orderIds.map((id, index) =>
                prisma.order.update({
                    where: { id },
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
