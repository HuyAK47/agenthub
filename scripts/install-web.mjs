import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = path.resolve('dist/web');
const target = path.join(os.homedir(), '.agenthub', 'web');
if (!fs.existsSync(source)) throw new Error(`Web build not found: ${source}`);
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log(`Installed web assets to ${target}`);
