import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { AgentHubConfig, loadConfig } from './config.js';
import { createContext } from './daemon.js';
import { CodexEngine } from './engines/index.js';
import { findClaudeBin } from './chat/claude.js';
import { getPlatform } from './platform/index.js';
import { lockTool } from './profiles/locks.js';
import { findAgyBin } from './agy.js';

export type CheckStatus = 'ok' | 'error' | 'skip' | 'warn';

export interface DoctorCheckItem {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  timestamp: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    warned: number;
  };
  checks: DoctorCheckItem[];
}

export type SyncExecFn = (
  cmd: string,
  args: string[],
  options?: { timeout?: number },
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export const defaultExecSync: SyncExecFn = (cmd, args, options) => {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout: options?.timeout ?? 5000,
    });
    return {
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: res.error,
    };
  } catch (err) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
};

export function findRealUserHome(): string {
  try {
    const info = os.userInfo();
    if (info?.homedir && fs.existsSync(info.homedir)) {
      return info.homedir;
    }
  } catch {
    // ignore
  }
  return os.homedir();
}

export function findAgyPath(customHome?: string, existsFn: (filePath: string) => boolean = (p) => fs.existsSync(p)): string | null {
  return findAgyBin(customHome, existsFn);
}

export function findCodexPath(customHome?: string, existsFn: (filePath: string) => boolean = (p) => fs.existsSync(p)): string | null {
  const fromEngine = CodexEngine.findCodexPath();
  if (fromEngine && existsFn(fromEngine)) {
    return fromEngine;
  }
  const homes = [customHome, os.homedir(), findRealUserHome()].filter(Boolean) as string[];
  if (process.env.AGENTHUB_TOOLS_DIR) {
    const managed = path.join(process.env.AGENTHUB_TOOLS_DIR, 'node_modules', '.bin', 'codex');
    if (existsFn(managed)) return managed;
  }
  for (const h of homes) {
    const base = path.join(h, '.vscode', 'extensions');
    if (existsFn(base)) {
      try {
        const entries = fs.readdirSync(base).filter((e) => e.startsWith('openai.chatgpt-'));
        if (entries.length > 0) {
          entries.sort();
          const latest = entries[entries.length - 1];
          const targets = process.platform === 'darwin'
            ? ['darwin-arm64', 'darwin-x64', 'macos-arm64', 'macos-x64']
            : process.platform === 'win32' ? ['win32-x64'] : ['linux-x86_64'];
          for (const target of targets) {
            const codexBin = path.join(base, latest, 'bin', target, 'codex');
            if (existsFn(codexBin)) return codexBin;
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

// 1. Node check
export interface CheckNodeDeps {
  version?: string;
  execPath?: string;
}

export async function checkNode(deps?: CheckNodeDeps): Promise<DoctorCheckItem> {
  const version = deps?.version ?? process.version;
  const execPath = deps?.execPath ?? process.execPath;
  const match = version.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;

  if (major >= 22) {
    return {
      id: 'node',
      name: 'Phiên bản Node.js',
      status: 'ok',
      message: `Node ${version} (${execPath})`,
      details: { version, execPath, major },
    };
  }

  return {
    id: 'node',
    name: 'Phiên bản Node.js',
    status: 'error',
    message: `Node ${version} (${execPath}) - yêu cầu phiên bản ≥ 22`,
    suggestion: `Chạy 'source ~/.nvm/nvm.sh && nvm use 22' hoặc cài đặt Node.js phiên bản ≥ 22.`,
    details: { version, execPath, major },
  };
}

// 2. Git check
export interface CheckGitDeps {
  exec?: SyncExecFn;
  timeoutMs?: number;
}

export async function checkGit(deps?: CheckGitDeps): Promise<DoctorCheckItem> {
  const exec = deps?.exec ?? defaultExecSync;
  const timeoutMs = deps?.timeoutMs ?? 5000;
  const res = exec('git', ['--version'], { timeout: timeoutMs });

  if (res.error) {
    return {
      id: 'git',
      name: 'Git',
      status: 'error',
      message: `Không thể thực thi lệnh git: ${res.error.message}`,
      suggestion: `Cài đặt git ('sudo apt install git') và đảm bảo git có trong biến môi trường PATH.`,
      details: { error: res.error.message },
    };
  }

  if (res.status === 0 && res.stdout) {
    const versionStr = res.stdout.trim();
    return {
      id: 'git',
      name: 'Git',
      status: 'ok',
      message: versionStr,
      details: { version: versionStr },
    };
  }

  return {
    id: 'git',
    name: 'Git',
    status: 'error',
    message: `Lệnh git thất bại với mã thoát ${res.status}: ${res.stderr.trim() || '(không có lỗi chi tiết)'}`,
    suggestion: `Kiểm tra lại cài đặt git trên máy.`,
    details: { status: res.status, stderr: res.stderr },
  };
}

// Git identity is a warning because users may configure it later; workers and hub
// commits have an explicit AgentHub fallback when it is absent.
export async function checkGitIdentity(deps?: CheckGitDeps): Promise<DoctorCheckItem> {
  const exec = deps?.exec ?? defaultExecSync;
  const timeoutMs = deps?.timeoutMs ?? 5000;
  const name = exec('git', ['config', '--get', 'user.name'], { timeout: timeoutMs });
  const email = exec('git', ['config', '--get', 'user.email'], { timeout: timeoutMs });
  const hasName = name.status === 0 && name.stdout.trim().length > 0;
  const hasEmail = email.status === 0 && email.stdout.trim().length > 0;
  if (hasName && hasEmail) {
    return { id: 'git-identity', name: 'Danh tính Git', status: 'ok', message: `${name.stdout.trim()} <${email.stdout.trim()}>` };
  }
  return {
    id: 'git-identity',
    name: 'Danh tính Git',
    status: 'warn',
    message: 'Chưa cấu hình đầy đủ user.name/user.email (AgentHub sẽ dùng danh tính mặc định khi cần commit)',
    suggestion: "Chạy 'git config --global user.name ...' và 'git config --global user.email ...' để cấu hình danh tính Git.",
    details: { hasName, hasEmail },
  };
}

export interface CheckLockToolDeps {
  exec?: SyncExecFn;
  timeoutMs?: number;
}

export async function checkLockTool(deps?: CheckLockToolDeps): Promise<DoctorCheckItem> {
  const exec = deps?.exec ?? defaultExecSync;
  const timeoutMs = deps?.timeoutMs ?? 5000;
  const tool = lockTool();
  const res = exec(tool, [], { timeout: timeoutMs });
  if (!res.error) {
    return {
      id: 'lock-tool',
      name: 'Công cụ khóa file',
      status: 'ok',
      message: `Tìm thấy ${tool} (${process.platform === 'darwin' ? 'macOS lockf' : 'Linux flock'})`,
      details: { tool, platform: process.platform },
    };
  }
  return {
    id: 'lock-tool',
    name: 'Công cụ khóa file',
    status: 'error',
    message: `Không thể thực thi ${tool}: ${res.error.message}`,
    suggestion: process.platform === 'darwin'
      ? 'Đảm bảo /usr/bin/lockf có sẵn trên macOS.'
      : 'Cài đặt util-linux để có lệnh flock và đảm bảo nó có trong PATH.',
    details: { tool, platform: process.platform, error: res.error.message },
  };
}

// 3. Worker Engines check (agy and Codex)
export interface CheckEnginesDeps {
  agyPath?: string | null;
  codexPath?: string | null;
  homeDir?: string;
  checkFileExists?: (filePath: string) => boolean;
  port?: number;
}

export async function checkEngines(deps?: CheckEnginesDeps): Promise<DoctorCheckItem> {
  const existsFn = deps?.checkFileExists ?? fs.existsSync;
  const agy = deps?.agyPath !== undefined
    ? deps.agyPath
    : findAgyPath(deps?.homeDir, existsFn);
  const codex = deps?.codexPath !== undefined
    ? deps.codexPath
    : findCodexPath(deps?.homeDir, existsFn);

  const foundAgy = !!agy;
  const foundCodex = !!codex;

  if (foundAgy && foundCodex) {
    return {
      id: 'engines',
      name: 'Worker Engines (agy & codex)',
      status: 'ok',
      message: `Tìm thấy agy (${agy}) và Codex CLI (${codex})`,
      details: { agy, codex },
    };
  }

  const suggestions: string[] = [];
  if (!foundAgy) {
    suggestions.push(`Cài đặt Antigravity CLI tại ~/.gemini/bin/agy`);
  }
  if (!foundCodex) {
    const port = deps?.port ?? loadConfig().port ?? 7700;
    suggestions.push(`Mở http://127.0.0.1:${port}/setup để cài Codex CLI/Claude Code một chạm; xem mục cài agy trong docs/GETTING-STARTED.md`);
  }

  let message = '';
  if (!foundAgy && !foundCodex) {
    message = 'Không tìm thấy cả agy (~/.gemini/bin/agy) lẫn Codex CLI';
  } else if (!foundAgy) {
    message = `Không tìm thấy agy (~/.gemini/bin/agy); tìm thấy Codex CLI (${codex})`;
  } else {
    message = `Tìm thấy agy (${agy}); không tìm thấy Codex CLI`;
  }

  return {
    id: 'engines',
    name: 'Worker Engines (agy & codex)',
    status: 'error',
    message,
    suggestion: suggestions.join('; '),
    details: { agy, codex },
  };
}

// 4. Daemon check
export interface CheckDaemonDeps {
  port?: number;
  tokenPath?: string;
  fetchFn?: typeof fetch;
  readToken?: (path: string) => string | null;
  timeoutMs?: number;
}

export async function checkDaemon(deps?: CheckDaemonDeps): Promise<DoctorCheckItem> {
  const port = deps?.port ?? loadConfig().port ?? 7700;
  const tokenPath = deps?.tokenPath ?? loadConfig().tokenPath;
  const fetchFn = deps?.fetchFn ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? 2000;
  const readToken = deps?.readToken ?? ((p: string) => {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf-8').trim();
      }
    } catch {
      // ignore
    }
    return null;
  });

  // Step 1: GET /health
  let healthOk = false;
  try {
    const healthRes = await fetchFn(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (healthRes.status === 200) {
      healthOk = true;
    } else {
      return {
        id: 'daemon',
        name: 'Daemon HTTP API',
        status: 'error',
        message: `GET /health trả về HTTP ${healthRes.status} (cổng ${port})`,
        suggestion: `Kiểm tra tiến trình đang chạy trên cổng ${port} hoặc khởi động daemon bằng 'agenthub daemon'.`,
        details: { port, healthStatus: healthRes.status },
      };
    }
  } catch (err) {
    return {
      id: 'daemon',
      name: 'Daemon HTTP API',
      status: 'error',
      message: `Không kết nối được daemon tại http://127.0.0.1:${port}/health (timeout 2s): ${err instanceof Error ? err.message : String(err)}`,
      suggestion: `Khởi động daemon bằng 'agenthub daemon' hoặc kiểm tra cổng ${port}.`,
      details: { port, error: err instanceof Error ? err.message : String(err) },
    };
  }

  // Step 2: Read token
  const token = readToken(tokenPath);
  if (!token) {
    return {
      id: 'daemon',
      name: 'Daemon HTTP API',
      status: 'error',
      message: `Daemon đang chạy nhưng không đọc được token tại ${tokenPath}`,
      suggestion: `Đảm bảo file ${tokenPath} tồn tại và có quyền đọc, hoặc khởi động daemon để tạo token.`,
      details: { port, healthOk, tokenPath },
    };
  }

  // Step 3: GET /api/status with token
  try {
    const statusRes = await fetchFn(`http://127.0.0.1:${port}/api/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (statusRes.status === 200) {
      return {
        id: 'daemon',
        name: 'Daemon HTTP API',
        status: 'ok',
        message: `Daemon đang chạy (cổng ${port}), đọc được token, /api/status trả 200`,
        details: { port, tokenPath, status: 200 },
      };
    }

    return {
      id: 'daemon',
      name: 'Daemon HTTP API',
      status: 'error',
      message: `GET /health OK, đọc được token, nhưng GET /api/status trả về HTTP ${statusRes.status}`,
      suggestion: `Token tại ${tokenPath} không hợp lệ với daemon đang chạy. Thử khởi động lại daemon.`,
      details: { port, tokenPath, apiStatus: statusRes.status },
    };
  } catch (err) {
    return {
      id: 'daemon',
      name: 'Daemon HTTP API',
      status: 'error',
      message: `Lỗi khi gọi /api/status với token: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: `Kiểm tra daemon và thử gọi lại API.`,
      details: { port, tokenPath, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

// 5. Systemd service check
export interface CheckSystemdDeps {
  exec?: SyncExecFn;
  timeoutMs?: number;
}

export async function checkSystemd(deps?: CheckSystemdDeps): Promise<DoctorCheckItem> {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return getPlatform().serviceCheck(deps?.exec ?? defaultExecSync, deps?.timeoutMs ?? 5000);
  }
  const exec = deps?.exec ?? defaultExecSync;
  const timeoutMs = deps?.timeoutMs ?? 5000;

  // Check if systemctl exists
  const probe = exec('systemctl', ['--version'], { timeout: timeoutMs });
  if (probe.error) {
    return {
      id: 'systemd',
      name: 'Service systemd',
      status: 'skip',
      message: 'Không có systemd (bỏ qua)',
      details: { reason: 'systemctl_not_found' },
    };
  }

  const res = exec('systemctl', ['--user', 'is-active', 'agenthub'], { timeout: timeoutMs });

  // If user bus is not available (e.g. headless container, docker, no dbus)
  if (res.stderr && /Failed to connect to bus|not been booted with systemd/i.test(res.stderr)) {
    return {
      id: 'systemd',
      name: 'Service systemd',
      status: 'skip',
      message: 'Không có systemd user bus (bỏ qua)',
      details: { reason: 'user_bus_unavailable', stderr: res.stderr.trim() },
    };
  }

  const output = (res.stdout || '').trim();

  if (res.status === 0 && output === 'active') {
    return {
      id: 'systemd',
      name: 'Service systemd',
      status: 'ok',
      message: `Service systemd 'agenthub' đang hoạt động (active)`,
      details: { status: output },
    };
  }

  return {
    id: 'systemd',
    name: 'Service systemd',
    status: 'error',
    message: `Service systemd 'agenthub' không hoạt động (${output || 'inactive'})`,
    suggestion: `Chạy 'agenthub install-service' hoặc 'systemctl --user start agenthub'.`,
    details: { status: output || 'inactive', exitCode: res.status },
  };
}

// 6. MCP check (claude mcp list)
export interface CheckMcpDeps {
  exec?: SyncExecFn;
  timeoutMs?: number;
  claudeBin?: string;
}

export async function checkMcp(deps?: CheckMcpDeps): Promise<DoctorCheckItem> {
  const exec = deps?.exec ?? defaultExecSync;
  const timeoutMs = deps?.timeoutMs ?? 10000;

  // Claude Code is often only installed inside the VS Code extension (not on PATH); use the
  // same lookup as the chat so doctor does not report it as missing.
  const claudeBin = deps?.claudeBin ?? (deps?.exec ? 'claude' : findClaudeBin() || 'claude');
  const res = exec(claudeBin, ['mcp', 'list'], { timeout: timeoutMs });

  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return {
        id: 'mcp',
        name: 'Cấu hình Claude MCP',
        status: 'error',
        message: 'Lệnh claude mcp list bị quá thời gian (timeout 10 giây)',
        suggestion: `Kiểm tra lệnh 'claude mcp list' trên máy để khắc phục treo tiến trình.`,
        details: { timeoutMs },
      };
    }
    return {
      id: 'mcp',
      name: 'Cấu hình Claude MCP',
      status: 'skip',
      message: 'Không có lệnh claude (bỏ qua)',
      details: { reason: 'claude_not_found', error: res.error.message },
    };
  }

  // Check if command not found by exit code 127
  if (res.status === 127) {
    return {
      id: 'mcp',
      name: 'Cấu hình Claude MCP',
      status: 'skip',
      message: 'Không có lệnh claude (bỏ qua)',
      details: { reason: 'claude_not_found' },
    };
  }

  const combinedOutput = `${res.stdout}\n${res.stderr}`;
  if (/agenthub/i.test(combinedOutput)) {
    return {
      id: 'mcp',
      name: 'Cấu hình Claude MCP',
      status: 'ok',
      message: 'Đã tìm thấy agenthub trong cấu hình Claude MCP',
      details: { output: res.stdout.trim() },
    };
  }

  return {
    id: 'mcp',
    name: 'Cấu hình Claude MCP',
    status: 'error',
    message: 'Chưa cấu hình agenthub trong Claude MCP',
    suggestion: `Chạy 'agenthub mcp-install' để đăng ký agenthub với Claude Code.`,
    details: { output: res.stdout.trim() },
  };
}

// 7. Profile check (read through service, never read token file)
export interface ProfileItem {
  name: string;
  engine: string;
  kind: string;
  email: string | null;
  enabled: number | boolean;
}

export interface ProfileData {
  profiles: ProfileItem[];
  duplicateEmails: Map<string, string[]>;
  activeQuotaMarks: Array<{ profileName: string; family: string; until: number; reason?: string | null }>;
}

export interface CheckProfilesDeps {
  getProfileData?: () => Promise<ProfileData> | ProfileData;
  config?: AgentHubConfig;
}

export async function checkProfiles(deps?: CheckProfilesDeps): Promise<DoctorCheckItem> {
  let data: ProfileData;

  if (deps?.getProfileData) {
    data = await deps.getProfileData();
  } else {
    const config = deps?.config ?? loadConfig();
    const ctx = createContext(config);
    try {
      ctx.profileService.registerAll();
      const profiles = ctx.profileRepo.getAll();
      const duplicateEmails = ctx.profileService.getDuplicateEmails();
      const activeQuotaMarks = ctx.quotaMarkRepo.getActive();
      data = { profiles, duplicateEmails, activeQuotaMarks };
    } finally {
      ctx.db.close();
    }
  }

  const { profiles, duplicateEmails, activeQuotaMarks } = data;
  const total = profiles.length;
  // Agy profiles require email login; if email is null, profile is unauthenticated
  const unauthenticated = profiles
    .filter((p) => p.engine === 'agy' && !p.email)
    .map((p) => p.name);

  const duplicateGroups: string[] = [];
  for (const [email, names] of duplicateEmails.entries()) {
    duplicateGroups.push(`${email}: ${names.join(', ')}`);
  }

  const details = {
    total,
    unauthenticated,
    duplicates: Object.fromEntries(duplicateEmails.entries()),
    activeQuotaMarksCount: activeQuotaMarks.length,
    activeQuotaMarks: activeQuotaMarks.map((m) => ({
      profile: m.profileName,
      family: m.family,
      until: m.until,
    })),
  };

  if (total === 0) {
    return {
      id: 'profiles',
      name: 'Hồ sơ worker',
      status: 'error',
      message: 'Chưa tìm thấy hồ sơ nào trong hệ thống',
      suggestion: `Chạy 'agenthub profile login <tên>' để tạo hồ sơ agy hoặc kiểm tra thư mục ~/.agy-homes.`,
      details,
    };
  }

  if (unauthenticated.length > 0) {
    const suggestions: string[] = [
      `Đăng nhập cho các hồ sơ chưa xác thực (${unauthenticated.join(', ')}) bằng lệnh 'agenthub profile login <tên>'`,
    ];
    if (duplicateGroups.length > 0) {
      suggestions.push(`Lưu ý các hồ sơ trùng email sẽ dùng chung quota: ${duplicateGroups.join('; ')}`);
    }

    return {
      id: 'profiles',
      name: 'Hồ sơ worker',
      status: 'error',
      message: `${total} hồ sơ, có ${unauthenticated.length} hồ sơ chưa đăng nhập (${unauthenticated.join(', ')})`,
      suggestion: suggestions.join('. '),
      details,
    };
  }

  let message = `${total} hồ sơ (tất cả đã đăng nhập)`;
  if (duplicateGroups.length > 0) {
    message += `, ${duplicateGroups.length} nhóm trùng email`;
  }
  if (activeQuotaMarks.length > 0) {
    message += `, ${activeQuotaMarks.length} quota mark còn hiệu lực`;
  }

  const suggestion = duplicateGroups.length > 0
    ? `Lưu ý các hồ sơ trùng email sẽ dùng chung quota: ${duplicateGroups.join('; ')}`
    : undefined;

  return {
    id: 'profiles',
    name: 'Hồ sơ worker',
    status: 'ok',
    message,
    suggestion,
    details,
  };
}

// 8. Permissions check (~/.agenthub: 700, token: 600)
export interface CheckPermissionsDeps {
  hubHome?: string;
  tokenPath?: string;
  statSync?: (path: string) => { mode: number; isDirectory: () => boolean; isFile: () => boolean };
  existsSync?: (path: string) => boolean;
}

export async function checkPermissions(deps?: CheckPermissionsDeps): Promise<DoctorCheckItem> {
  const config = deps?.hubHome && deps?.tokenPath ? undefined : loadConfig();
  const hubHome = deps?.hubHome ?? config!.hubHome;
  const tokenPath = deps?.tokenPath ?? config!.tokenPath;
  const statFn = deps?.statSync ?? fs.statSync;
  const existsFn = deps?.existsSync ?? fs.existsSync;

  const errors: string[] = [];
  const suggestions: string[] = [];

  // Check ~/.agenthub
  if (!existsFn(hubHome)) {
    errors.push(`Thư mục ${hubHome} không tồn tại`);
    suggestions.push(`Tạo thư mục với quyền 700: 'mkdir -m 700 -p ${hubHome}'`);
  } else {
    try {
      const stat = statFn(hubHome);
      const modeOctal = (stat.mode & 0o777).toString(8);
      if (modeOctal !== '700') {
        errors.push(`Thư mục ${hubHome} có quyền ${modeOctal} (yêu cầu 700)`);
        suggestions.push(`Chạy 'chmod 700 ${hubHome}'`);
      }
    } catch (err) {
      errors.push(`Không thể đọc quyền thư mục ${hubHome}: ${err instanceof Error ? err.message : String(err)}`);
      suggestions.push(`Kiểm tra lại quyền truy cập ${hubHome}`);
    }
  }

  // Check token file
  if (!existsFn(tokenPath)) {
    errors.push(`File token ${tokenPath} không tồn tại`);
    suggestions.push(`Khởi động daemon để tự sinh token hoặc tạo file và chạy 'chmod 600 ${tokenPath}'`);
  } else {
    try {
      const stat = statFn(tokenPath);
      const modeOctal = (stat.mode & 0o777).toString(8);
      if (modeOctal !== '600') {
        errors.push(`File token ${tokenPath} có quyền ${modeOctal} (yêu cầu 600)`);
        suggestions.push(`Chạy 'chmod 600 ${tokenPath}'`);
      }
    } catch (err) {
      errors.push(`Không thể đọc quyền file token ${tokenPath}: ${err instanceof Error ? err.message : String(err)}`);
      suggestions.push(`Kiểm tra lại quyền truy cập ${tokenPath}`);
    }
  }

  if (errors.length > 0) {
    return {
      id: 'permissions',
      name: 'Quyền thư mục và file token',
      status: 'error',
      message: errors.join('; '),
      suggestion: suggestions.join('; '),
      details: { hubHome, tokenPath, errors },
    };
  }

  return {
    id: 'permissions',
    name: 'Quyền thư mục và file token',
    status: 'ok',
    message: `Thư mục ${hubHome} (700) và file token (600) đúng quyền bảo mật`,
    details: { hubHome, tokenPath },
  };
}

// Master orchestrator
export interface DoctorDeps {
  node?: CheckNodeDeps;
  git?: CheckGitDeps;
  gitIdentity?: CheckGitDeps;
  lockTool?: CheckLockToolDeps;
  engines?: CheckEnginesDeps;
  daemon?: CheckDaemonDeps;
  systemd?: CheckSystemdDeps;
  mcp?: CheckMcpDeps;
  profiles?: CheckProfilesDeps;
  permissions?: CheckPermissionsDeps;
}

export async function runDoctor(deps?: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheckItem[] = [
    await checkNode(deps?.node),
    await checkGit(deps?.git),
    await checkGitIdentity(deps?.gitIdentity ?? deps?.git),
    await checkLockTool(deps?.lockTool),
    await checkEngines(deps?.engines),
    await checkDaemon(deps?.daemon),
    await checkSystemd(deps?.systemd),
    await checkMcp(deps?.mcp),
    await checkProfiles(deps?.profiles),
    await checkPermissions(deps?.permissions),
  ];

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let warned = 0;

  for (const c of checks) {
    if (c.status === 'ok') passed++;
    else if (c.status === 'error') failed++;
    else if (c.status === 'skip') skipped++;
    else if (c.status === 'warn') warned++;
  }

  return {
    ok: failed === 0,
    timestamp: new Date().toISOString(),
    summary: {
      total: checks.length,
      passed,
      failed,
      skipped,
      warned,
    },
    checks,
  };
}

export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = ['=== AgentHub Doctor ===\n'];

  for (let i = 0; i < report.checks.length; i++) {
    const c = report.checks[i];
    let icon = '✓';
    if (c.status === 'error') icon = '✗';
    else if (c.status === 'skip') icon = '-';
    else if (c.status === 'warn') icon = '⚠️';

    lines.push(`${icon} [${i + 1}/${report.checks.length}] ${c.name}: ${c.message}`);
    if (c.suggestion && (c.status === 'error' || c.status === 'warn')) {
      lines.push(`  ↳ Gợi ý: ${c.suggestion}`);
    }
  }

  lines.push('');
  if (report.ok) {
    lines.push(`✓ Tất cả ${report.summary.passed}/${report.summary.total} mục kiểm tra đều đạt!`);
  } else {
    lines.push(
      `Kết quả: ${report.summary.passed}/${report.summary.total} mục đạt, ${report.summary.failed} mục lỗi, ${report.summary.skipped} mục bỏ qua.`,
    );
    lines.push('Vui lòng xem các gợi ý sửa cho từng mục lỗi ở trên.');
  }

  return lines.join('\n');
}

export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
