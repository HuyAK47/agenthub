import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { PlatformApi, PlatformProcessInfo } from './types.js';

function command(args: string[]): string { try { return execFileSync(args[0], args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } }

function listProcesses(): PlatformProcessInfo[] {
  const rows = command(['ps', '-axo', 'pid,ppid,rss,%cpu,command']).split('\n').slice(1);
  return rows.flatMap((row) => {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const cwd = command(['lsof', '-a', '-d', 'cwd', '-p', String(pid)]).split('\n').find((line) => /cwd/i.test(line))?.trim().split(/\s+/).at(-1) || '';
    const ppid = Number(match[2]);
    const parentName = command(['ps', '-o', 'comm=', '-p', String(ppid)]).trim();
    return [{ pid, ppid, parentName, rss: Number(match[3]) * 1024, cpu: Number(match[4]), cwd, startedAt: 0 } satisfies PlatformProcessInfo];
  });
}

function parentPid(pid: number): number | null { const row = command(['ps', '-o', 'ppid=', '-p', String(pid)]).trim(); return row ? Number(row) || null : null; }
function freeMemoryBytes(): number { return os.freemem(); }
function lowPriority(executable: string, args: string[]): [string, string[]] { return process.env.AGENTHUB_NO_NICE === '1' ? [executable, args] : ['/usr/bin/nice', ['-n', '10', executable, ...args]]; }
function openBrowser(url: string, openFn?: (file: string, args: string[], callback?: (err: Error | null) => void) => void): void { if (openFn) return openFn('open', [url]); execFile('open', [url], () => {}); }
function installService(opts: { nodePath: string; cliPath: string; currentPath: string; homeDir: string; print: boolean; exec?: (command: string, options: { stdio: 'inherit' }) => void }) {
  const file = path.join(opts.homeDir, 'Library', 'LaunchAgents', 'dev.agenthub.plist');
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.agenthub</string><key>ProgramArguments</key><array><string>${opts.nodePath}</string><string>${opts.cliPath}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${opts.currentPath}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
  const activate = `launchctl bootstrap gui/${process.getuid?.() ?? ''} ${file}`;
  if (!opts.print) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); (opts.exec || ((cmd, options) => execFileSync('sh', ['-c', cmd], options)))(activate, { stdio: 'inherit' }); }
  return { file, content, activate };
}

export const darwinPlatform: PlatformApi = { process: { listProcesses, parentPid }, freeMemoryBytes, lowPriority, openBrowser, installService, serviceCheck: () => ({ id: 'service', name: 'Service nền tảng', status: 'skip', message: 'macOS dùng LaunchAgent; systemd không được hỗ trợ. Chạy agenthub install-service để tạo ~/Library/LaunchAgents/dev.agenthub.plist.', suggestion: 'LaunchAgent được nạp bằng launchctl bootstrap khi cài đặt.', details: { platform: 'darwin', limited: ['ionice', 'systemd'] } }) };
