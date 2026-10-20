import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { PlatformApi, PlatformProcessInfo, ServiceRestartResult, ServiceUninstallResult } from './types.js';

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
function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function shellWord(value: string): string { return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : shellQuote(value); }
function launchctlCommand(...args: string[]): string { return [shellWord(process.env.AGENTHUB_LAUNCHCTL || 'launchctl'), ...args.map(shellWord)].join(' '); }
function installService(opts: { nodePath: string; cliPath: string; currentPath: string; homeDir: string; print: boolean; exec?: (command: string, options: { stdio: 'inherit' }) => void }) {
  const file = path.join(opts.homeDir, 'Library', 'LaunchAgents', 'dev.agenthub.plist');
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.agenthub</string><key>ProgramArguments</key><array><string>${opts.nodePath}</string><string>${opts.cliPath}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${opts.currentPath}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
  const activate = launchctlCommand('bootstrap', `gui/${process.getuid?.() ?? ''}`, file);
  if (!opts.print) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); (opts.exec || ((cmd, options) => execFileSync('sh', ['-c', cmd], options)))(activate, { stdio: 'inherit' }); }
  return { file, content, activate };
}

function restartService(opts?: { exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceRestartResult {
  const uid = process.getuid?.() ?? '';
  const runner = opts?.exec || ((cmd, options) => execFileSync('sh', ['-c', cmd], options));
  try {
    runner(launchctlCommand('kickstart', '-k', `gui/${uid}/dev.agenthub`), { stdio: 'inherit' });
    return { restarted: true, message: 'Đã khởi động lại LaunchAgent dev.agenthub' };
  } catch (err) {
    return { restarted: false, message: `Không thể khởi động lại LaunchAgent: ${(err as Error).message}` };
  }
}

function uninstallService(opts?: { homeDir?: string; exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceUninstallResult {
  const homeDir = opts?.homeDir || os.homedir();
  const file = path.join(homeDir, 'Library', 'LaunchAgents', 'dev.agenthub.plist');
  const uid = process.getuid?.() ?? '';
  const runner = opts?.exec || ((cmd, options) => execFileSync('sh', ['-c', cmd], options));
  try {
    runner(launchctlCommand('bootout', `gui/${uid}/dev.agenthub`), { stdio: 'ignore' });
  } catch {
    // ignore
  }
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
  return { uninstalled: true, file, message: 'Đã gỡ LaunchAgent dev.agenthub' };
}

export const darwinPlatform: PlatformApi = { process: { listProcesses, parentPid }, freeMemoryBytes, lowPriority, openBrowser, installService, restartService, uninstallService, serviceCheck: () => ({ id: 'service', name: 'Service nền tảng', status: 'skip', message: 'macOS dùng LaunchAgent; systemd không được hỗ trợ. Chạy agenthub install-service để tạo ~/Library/LaunchAgents/dev.agenthub.plist.', suggestion: 'LaunchAgent được nạp bằng launchctl bootstrap khi cài đặt.', details: { platform: 'darwin', limited: ['ionice', 'systemd'] } }) };
