/**
 * OPS-0 / DEV-BOOTSTRAP-1 — safety gate for write-capable local database
 * commands. Run before `prisma migrate deploy` in the `db:setup` / `db:status`
 * npm scripts (see package.json). Never prints a credential.
 *
 * Loads ONLY `.env` — matching the Prisma CLI's own resolution exactly, not
 * `.env.local` (which holds Production credentials in this repo) and not
 * `.env.development.local` (which `next dev` prefers). This script exists
 * specifically to gate the Prisma CLI, so it must see what the Prisma CLI
 * sees, not what `next dev` sees — those are two different mechanisms; see
 * docs/DEV_ENVIRONMENT_SAFETY.md.
 *
 * This CLI entry point lives in lib/, not scripts/ — .gitignore excludes
 * /scripts entirely (confirmed: even the existing db:backup/db:restore
 * target files are untracked), which would have made this command
 * unreproducible on a fresh clone. lib/ is tracked.
 */
import fs from 'fs';
import path from 'path';
import { classifyDbWriteTarget } from './dbSafety';

function loadDotEnvOnly(): void {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const m = /^([\w.-]+)\s*=\s*(.*)$/.exec(line.trim());
        if (!m) continue;
        let [, key, val] = m;
        val = val.trim();
        const q = val[0];
        if ((q === '"' || q === "'") && val[val.length - 1] === q) val = val.slice(1, -1);
        if (!(key in process.env)) process.env[key] = val;
    }
}

loadDotEnvOnly();

const result = classifyDbWriteTarget(process.env.DATABASE_URL);

console.log('DATABASE HOST:', result.host ?? '(unresolved)');
console.log('PORT:', result.port ?? '(default)');
console.log('DATABASE NAME:', result.database ?? '(unresolved)');
console.log('SOURCE ENV VARIABLE: DATABASE_URL');
console.log('SOURCE ENV FILE/MECHANISM: .env (matches Prisma CLI resolution)');
console.log('LOCAL/REMOTE CLASSIFICATION:', result.ok ? 'LOCAL — allowed' : `REFUSED — ${result.reason}`);

if (!result.ok) {
    console.error('\nRefusing to proceed: this target is not on the local allowlist.');
    console.error('If this is genuinely your local database, DATABASE_URL in .env must resolve to localhost or 127.0.0.1.');
    process.exit(1);
}

process.exit(0);
