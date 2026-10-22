import fs from 'node:fs';
import path from 'node:path';

export function isSafeProjectRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return value.split(/[\\/]+/).every((part) => part !== '..');
}

/** Resolve a project-local file and reject symlinks that escape the project. */
export function resolveProjectFile(projectPath: string, relativePath: string): string | null {
  if (!isSafeProjectRelativePath(relativePath)) return null;
  const root = path.resolve(projectPath);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}
