import fs from 'node:fs';
import { isInside, processAncestors, processIds } from './reaper.js';

export interface ProcessTreeMetrics {
  rss: number; // total RSS in bytes
  cpu: number; // percentage, e.g. 12.5
  totalTicks: number;
  measuredAt: number;
  pids: number[];
}

export interface PrevTreeMetrics {
  ticks: number;
  time: number;
}

interface ParsedProc {
  pid: number;
  ppid: number;
  pgrp: number;
  ticks: number;
  cwd: string | null;
}

export function measureProcessTree(
  rootPid: number,
  worktreePath?: string | null,
  prev?: PrevTreeMetrics,
): ProcessTreeMetrics {
  const now = Date.now();
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) {
    return { rss: 0, cpu: 0, totalTicks: 0, measuredAt: now, pids: [] };
  }

  const excluded = processAncestors();
  const allPids = processIds();

  const procMap = new Map<number, ParsedProc>();
  const childrenMap = new Map<number, number[]>();

  for (const pid of allPids) {
    if (excluded.has(pid)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const lastParen = stat.lastIndexOf(')');
      if (lastParen === -1) continue;
      const afterComm = stat.slice(lastParen + 2).trim().split(/\s+/);
      const ppid = Number(afterComm[1]);
      const pgrp = Number(afterComm[2]);
      const utime = Number(afterComm[11] || 0);
      const stime = Number(afterComm[12] || 0);
      const ticks = utime + stime;

      let cwd: string | null = null;
      if (worktreePath) {
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          // ignore
        }
      }

      procMap.set(pid, { pid, ppid, pgrp, ticks, cwd });

      if (ppid > 0) {
        const existing = childrenMap.get(ppid);
        if (existing) {
          existing.push(pid);
        } else {
          childrenMap.set(ppid, [pid]);
        }
      }
    } catch {
      // process might have exited
    }
  }

  // Find all PIDs in the tree
  const matchedPids = new Set<number>();
  const queue: number[] = [];

  for (const [pid, proc] of procMap) {
    let matches = false;
    if (pid === rootPid) {
      matches = true;
    } else if (rootPid > 0 && proc.pgrp === rootPid) {
      matches = true;
    } else if (worktreePath && proc.cwd && isInside(proc.cwd, worktreePath)) {
      matches = true;
    }

    if (matches) {
      if (!matchedPids.has(pid)) {
        matchedPids.add(pid);
        queue.push(pid);
      }
    }
  }

  // Add all descendants of matched PIDs
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const children = childrenMap.get(parent);
    if (children) {
      for (const childPid of children) {
        if (!matchedPids.has(childPid)) {
          matchedPids.add(childPid);
          queue.push(childPid);
        }
      }
    }
  }

  // Read RSS and sum ticks
  let totalRss = 0;
  let totalTicks = 0;

  for (const pid of matchedPids) {
    const proc = procMap.get(pid);
    if (proc) {
      totalTicks += proc.ticks;
    }

    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (rssMatch) {
        totalRss += Number(rssMatch[1]) * 1024;
      }
    } catch {
      // process might have exited
    }
  }

  // Compute %CPU
  let cpu = 0;
  if (prev && prev.time > 0 && now > prev.time) {
    const deltaTicks = Math.max(0, totalTicks - prev.ticks);
    const deltaSec = (now - prev.time) / 1000;
    cpu = deltaSec > 0 ? (deltaTicks / 100 / deltaSec) * 100 : 0;
  }
  cpu = Math.round(cpu * 10) / 10;

  return {
    rss: totalRss,
    cpu,
    totalTicks,
    measuredAt: now,
    pids: Array.from(matchedPids),
  };
}
