import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface GitReferenceSnapshot {
  kind: 'git';
  name: string;
  path: string;
  head: string | null;
  status: string;
}

export interface DirFileEntry {
  mtimeMs: number;
  size: number;
}

export interface DirReferenceSnapshot {
  kind: 'dir';
  name: string;
  path: string;
  files: Map<string, DirFileEntry>;
}

export interface FileReferenceSnapshot {
  kind: 'file';
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
  sha256?: string;
}

export interface MissingReferenceSnapshot {
  kind: 'missing';
  name: string;
  path: string;
}

export type ReferenceSnapshot =
  | GitReferenceSnapshot
  | DirReferenceSnapshot
  | FileReferenceSnapshot
  | MissingReferenceSnapshot;

export interface ReferenceModification {
  name: string;
  path: string;
  modifiedFiles: string[];
}

const MAX_DIR_FILES = 5000;

function walkDir(dir: string, baseDir = dir, acc = new Map<string, DirFileEntry>()): Map<string, DirFileEntry> {
  if (acc.size >= MAX_DIR_FILES) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (acc.size >= MAX_DIR_FILES) break;
    // Skip common version control or package manager directories in non-git reference walks
    if (entry.name === '.git' || entry.name === 'node_modules') continue;

    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        walkDir(fullPath, baseDir, acc);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        const relPath = path.relative(baseDir, fullPath);
        acc.set(relPath, { mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      // Ignore unreadable files or broken links
    }
  }

  return acc;
}

export function takeReferenceSnapshot(ref: { name: string; path: string }): ReferenceSnapshot {
  if (!fs.existsSync(ref.path)) {
    return {
      kind: 'missing',
      name: ref.name,
      path: ref.path,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(ref.path);
  } catch {
    return {
      kind: 'missing',
      name: ref.name,
      path: ref.path,
    };
  }

  if (stat.isFile()) {
    let sha256: string | undefined;
    try {
      sha256 = crypto.createHash('sha256').update(fs.readFileSync(ref.path)).digest('hex');
    } catch {
      sha256 = undefined;
    }
    return {
      kind: 'file',
      name: ref.name,
      path: ref.path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256,
    };
  }

  // Directory: check if it is a git repository
  const gitDir = path.join(ref.path, '.git');
  if (fs.existsSync(gitDir)) {
    let head: string | null = null;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ref.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      head = null;
    }

    let status = '';
    try {
      status = execFileSync('git', ['status', '--porcelain'], { cwd: ref.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      status = '';
    }

    return {
      kind: 'git',
      name: ref.name,
      path: ref.path,
      head,
      status,
    };
  }

  // Regular directory
  const files = walkDir(ref.path);
  return {
    kind: 'dir',
    name: ref.name,
    path: ref.path,
    files,
  };
}

export function takeReferenceSnapshots(references: Array<{ name: string; path: string }>): ReferenceSnapshot[] {
  return references.map((ref) => takeReferenceSnapshot(ref));
}

function parsePorcelainFiles(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const p = l.slice(2).trim();
      return p.includes(' -> ') ? p.split(' -> ')[1] : p;
    });
}

export function detectReferenceModifications(snapshots: ReferenceSnapshot[]): ReferenceModification[] {
  const modifications: ReferenceModification[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.kind === 'missing') {
      if (fs.existsSync(snapshot.path)) {
        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: [snapshot.path],
        });
      }
      continue;
    }

    if (!fs.existsSync(snapshot.path)) {
      modifications.push({
        name: snapshot.name,
        path: snapshot.path,
        modifiedFiles: [path.basename(snapshot.path)],
      });
      continue;
    }

    if (snapshot.kind === 'file') {
      try {
        const stat = fs.statSync(snapshot.path);
        let currentHash: string | undefined;
        try {
          currentHash = crypto.createHash('sha256').update(fs.readFileSync(snapshot.path)).digest('hex');
        } catch {
          currentHash = undefined;
        }
        if (
          stat.size !== snapshot.size ||
          stat.mtimeMs !== snapshot.mtimeMs ||
          (snapshot.sha256 !== undefined && currentHash !== snapshot.sha256)
        ) {
          modifications.push({
            name: snapshot.name,
            path: snapshot.path,
            modifiedFiles: [path.basename(snapshot.path)],
          });
        }
      } catch {
        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: [path.basename(snapshot.path)],
        });
      }
      continue;
    }

    if (snapshot.kind === 'git') {
      let currentHead: string | null = null;
      try {
        currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        currentHead = null;
      }

      let currentStatus = '';
      try {
        currentStatus = execFileSync('git', ['status', '--porcelain'], { cwd: snapshot.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        currentStatus = '';
      }

      if (currentHead !== snapshot.head || currentStatus !== snapshot.status) {
        const fileSet = new Set<string>();

        // Files from status difference
        for (const f of parsePorcelain(currentStatus)) {
          fileSet.add(f);
        }

        // Files from commit difference if HEAD changed
        if (snapshot.head && currentHead && snapshot.head !== currentHead) {
          try {
            const diffOut = execFileSync('git', ['diff', '--name-only', `${snapshot.head}..${currentHead}`], {
              cwd: snapshot.path,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            for (const f of diffOut.split('\n').map((s) => s.trim()).filter(Boolean)) {
              fileSet.add(f);
            }
          } catch {
            fileSet.add(`(HEAD: ${snapshot.head} -> ${currentHead})`);
          }
        }

        if (fileSet.size === 0) {
          fileSet.add('(git repository status changed)');
        }

        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: Array.from(fileSet),
        });
      }
      continue;
    }

    if (snapshot.kind === 'dir') {
      const currentFiles = walkDir(snapshot.path);
      const changed: string[] = [];

      // Check for removed or modified files
      for (const [relPath, entry] of snapshot.files) {
        const currentEntry = currentFiles.get(relPath);
        if (!currentEntry) {
          changed.push(relPath);
        } else if (currentEntry.size !== entry.size || currentEntry.mtimeMs !== entry.mtimeMs) {
          changed.push(relPath);
        }
      }

      // Check for added files
      for (const relPath of currentFiles.keys()) {
        if (!snapshot.files.has(relPath)) {
          changed.push(relPath);
        }
      }

      if (changed.length > 0) {
        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: changed,
        });
      }
    }
  }

  return modifications;
}

function parsePorcelain(porcelain: string): string[] {
  return parsePorcelainFiles(porcelain);
}
