
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';

const execPromise = util.promisify(exec);

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        // Strict authorization: Only Super Admins can backup
        if (!session?.user || !session.user.isSuperAdmin) {
            console.warn(`[Backup API] Unauthorized attempt by user: ${session?.user?.email}`);
            return NextResponse.json({ error: 'Unauthorized: Super Admin access required' }, { status: 403 });
        }

        const scriptPath = path.join(process.cwd(), 'scripts', 'backup_full.ps1');
        const command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;

        console.log(`[Backup API] Triggering backup: ${command}`);

        const { stdout, stderr } = await execPromise(command);

        if (stderr) {
            console.warn(`[Backup API] Script stderr: ${stderr}`);
        }

        console.log(`[Backup API] Output: ${stdout}`);

        // Check output for success marker
        if (stdout.includes("SUCCESS: Backup Complete!")) {
            return NextResponse.json({
                success: true,
                message: "Backup completed successfully.",
                details: stdout
            });
        } else {
            return NextResponse.json({
                success: false,
                error: "Backup script executed but success marker not found.",
                details: stdout + "\n" + stderr
            }, { status: 500 });
        }

    } catch (e: any) {
        console.error("[Backup API] Execution Error:", e);
        return NextResponse.json({
            success: false,
            error: e.message || "Failed to execute backup script."
        }, { status: 500 });
    }
}
