import * as fs from 'fs';
import * as path from 'path';

const src = path.join(process.cwd(), 'app', 'customers', '[id]', 'page.tsx');
const dest = path.join(process.cwd(), 'app', 'fundraisers', '[id]', 'page.tsx');

fs.copyFileSync(src, dest);
console.log('Copied successfully');
