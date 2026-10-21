import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = path.resolve('dist/web');
const hubHome = path.resolve(process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'));
const target = path.join(hubHome, 'web');
if (!fs.existsSync(source)) throw new Error(`Web build not found: ${source}`);
fs.mkdirSync(hubHome, { recursive: true });
const realHubHome = fs.realpathSync.native(hubHome);
const realHome = fs.realpathSync.native(os.homedir());
const targetReal = fs.existsSync(target) ? fs.realpathSync.native(target) : path.resolve(target);
const relative = path.relative(realHubHome, targetReal);
if (targetReal === realHubHome || targetReal === realHome || relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error(`Refusing unsafe web target: ${target}`);
}
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log(`Installed web assets to ${target}`);
