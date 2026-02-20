
import { NextResponse } from 'next/server';
import path from 'path';

export async function POST(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { deadline, checks_payable_to } = body;

        // Dynamically import ExcelJS only when needed (reduces initial bundle size)
        const ExcelJS = (await import('exceljs')).default;

        // Load Template
        const templatePath = path.resolve('./templates/tracking_sheet.xlsx');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(templatePath);

        const worksheet = workbook.worksheets[0];

        // Format Deadline: "March 30, 2026"
        let formattedDeadline = "(Insert Date)";
        if (deadline) {
            const d = new Date(deadline);
            // Adjust for timezone offset if necessary, or just use UTC date part
            // Simple approach: append T00:00:00 to ensure local date isn't shifted
            // Actually, input is YYYY-MM-DD string, so:
            const [y, m, day] = deadline.split('-').map(Number);
            const dateObj = new Date(y, m - 1, day);
            formattedDeadline = dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        }

        // Row 4, Cell 2 (B4)
        // Original: "All orders and money must be submitted by your group’s deadline: (Insert Date)"
        const cellB4 = worksheet.getCell('B4');
        if (cellB4.value && typeof cellB4.value === 'string') {
            cellB4.value = cellB4.value.replace('(Insert Date)', formattedDeadline);
        } else {
            // Fallback if template changed
            cellB4.value = `All orders and money must be submitted by your group’s deadline: ${formattedDeadline}`;
        }

        // Row 5, Cell 2 (B5)
        // Original: "All checks should be made payable to:  (insert pay to organization)"
        const cellB5 = worksheet.getCell('B5');
        const payee = checks_payable_to || "_______________________";
        if (cellB5.value && typeof cellB5.value === 'string') {
            cellB5.value = cellB5.value.replace('(insert pay to organization)', payee);
        } else {
            cellB5.value = `All checks should be made payable to:  ${payee}`;
        }

        // Bundle 1 Meals (Column B, Rows 24-28)
        if (body.bundle1_recipes) {
            const recipes = body.bundle1_recipes.split('\n').filter((r: string) => r.trim());
            for (let i = 0; i < 5; i++) {
                const cell = worksheet.getCell(`B${24 + i}`);
                cell.value = recipes[i] || ""; // Clear if fewer than 5
            }
        }

        // Bundle 2 Meals (Column C, Rows 24-28)
        if (body.bundle2_recipes) {
            const recipes = body.bundle2_recipes.split('\n').filter((r: string) => r.trim());
            for (let i = 0; i < 5; i++) {
                const cell = worksheet.getCell(`C${24 + i}`);
                cell.value = recipes[i] || ""; // Clear if fewer than 5
            }
        }

        // Generate Buffer
        const buffer = await workbook.xlsx.writeBuffer();

        // Return File
        return new NextResponse(buffer, {
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="Freezer_Chef_Order_Tracking.xlsx"`
            }
        });

    } catch (e: any) {
        console.error("Tracking Sheet Generation Error:", e);
        return NextResponse.json({ error: e.message || "Failed to generate tracking sheet" }, { status: 500 });
    }
}
