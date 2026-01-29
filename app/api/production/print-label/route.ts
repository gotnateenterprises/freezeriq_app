
import { NextResponse } from 'next/server';
import { getLabelPrinter } from '@/lib/label_printer';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { job } = body;

        if (!job) {
            return NextResponse.json({ error: "Missing print job data" }, { status: 400 });
        }

        const printer = getLabelPrinter();
        const result = await printer.printLabel(job);

        if (!result.success) {
            return NextResponse.json({ error: result.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: result.message });

    } catch (e) {
        console.error("Print API Error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
