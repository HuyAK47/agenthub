import { describe, it, expect } from 'vitest';
import {
  parseDependsOn,
  filterTasksForDag,
  calculateBlockedCounts,
  calculateCriticalPath,
  layoutTaskDag,
} from '../components/dag/dagUtils';
import { Task } from '../types/api';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id || 'p~t1',
    projectId: overrides.projectId || 'p',
    slug: overrides.slug || 't1',
    title: overrides.title || 'Task 1',
    level: 'easy',
    status: overrides.status || 'draft',
    dependsOn: overrides.dependsOn || [],
    attempt: 0,
    resume: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('dagUtils - parseDependsOn', () => {
  it('handles array, JSON string, comma string, and empty values', () => {
    expect(parseDependsOn(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseDependsOn('["a", "b"]')).toEqual(['a', 'b']);
    expect(parseDependsOn('a, b')).toEqual(['a', 'b']);
    expect(parseDependsOn('')).toEqual([]);
    expect(parseDependsOn('[]')).toEqual([]);
    expect(parseDependsOn(null)).toEqual([]);
    expect(parseDependsOn(undefined)).toEqual([]);
  });
});

describe('dagUtils - calculateCriticalPath', () => {
  it('returns empty array when there are no unfinished tasks', () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'done' }),
      makeTask({ id: 't2', status: 'done', dependsOn: ['t1'] }),
    ];
    const path = calculateCriticalPath(tasks, [{ from: 't1', to: 't2' }]);
    expect(path).toEqual([]);
  });

  it('calculates the longest chain among unfinished tasks', () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'running' }),
      makeTask({ id: 't2', status: 'queued', dependsOn: ['t1'] }),
      makeTask({ id: 't3', status: 'draft', dependsOn: ['t2'] }),
      makeTask({ id: 'short', status: 'queued', dependsOn: ['t1'] }),
    ];
    const edges = [
      { from: 't1', to: 't2' },
      { from: 't2', to: 't3' },
      { from: 't1', to: 'short' },
    ];
    const path = calculateCriticalPath(tasks, edges);
    expect(path).toEqual(['t1', 't2', 't3']);
  });

  it('skips done tasks in the critical path', () => {
    const tasks: Task[] = [
      makeTask({ id: 'done1', status: 'done' }),
      makeTask({ id: 't1', status: 'running', dependsOn: ['done1'] }),
      makeTask({ id: 't2', status: 'queued', dependsOn: ['t1'] }),
    ];
    const edges = [
      { from: 'done1', to: 't1' },
      { from: 't1', to: 't2' },
    ];
    const path = calculateCriticalPath(tasks, edges);
    expect(path).toEqual(['t1', 't2']);
  });
});

describe('dagUtils - calculateBlockedCounts', () => {
  it('counts reachable unfinished downstream tasks ("đang chặn 4 task")', () => {
    const tasks: Task[] = [
      makeTask({ id: 'A', status: 'running' }),
      makeTask({ id: 'B', status: 'queued', dependsOn: ['A'] }),
      makeTask({ id: 'C', status: 'queued', dependsOn: ['A'] }),
      makeTask({ id: 'D', status: 'queued', dependsOn: ['B'] }),
      makeTask({ id: 'E', status: 'queued', dependsOn: ['C'] }),
    ];
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'E' },
    ];
    const { counts, maxCount, maxTaskId } = calculateBlockedCounts(tasks, edges);
    expect(counts.get('A')).toBe(4);
    expect(counts.get('B')).toBe(1);
    expect(counts.get('C')).toBe(1);
    expect(counts.get('D')).toBe(0);
    expect(counts.get('E')).toBe(0);
    expect(maxCount).toBe(4);
    expect(maxTaskId).toBe('A');
  });

  it('done tasks have blocked count 0 and do not count as blocking', () => {
    const tasks: Task[] = [
      makeTask({ id: 'done', status: 'done' }),
      makeTask({ id: 'child', status: 'running', dependsOn: ['done'] }),
    ];
    const edges = [{ from: 'done', to: 'child' }];
    const { counts, maxCount, maxTaskId } = calculateBlockedCounts(tasks, edges);
    expect(counts.get('done')).toBe(0);
    expect(counts.get('child')).toBe(0);
    expect(maxCount).toBe(0);
    expect(maxTaskId).toBeNull();
  });
});

describe('dagUtils - filterTasksForDag', () => {
  it('filters by project and status', () => {
    const tasks: Task[] = [
      makeTask({ id: 'p1~t1', projectId: 'p1', status: 'running' }),
      makeTask({ id: 'p2~t1', projectId: 'p2', status: 'running' }),
      makeTask({ id: 'p1~t2', projectId: 'p1', status: 'draft' }),
    ];

    const projFiltered = filterTasksForDag(tasks, { project: 'p1', doneFilter: 'all' });
    expect(projFiltered.map((t) => t.id)).toEqual(['p1~t1', 'p1~t2']);

    const statusFiltered = filterTasksForDag(tasks, { status: 'running', doneFilter: 'all' });
    expect(statusFiltered.map((t) => t.id)).toEqual(['p1~t1', 'p2~t1']);
  });

  it('defaults to active chains (only keeps done tasks that precede unfinished tasks)', () => {
    const tasks: Task[] = [
      makeTask({ id: 'done_isolated', status: 'done' }),
      makeTask({ id: 'done_prereq', status: 'done' }),
      makeTask({ id: 'running_child', status: 'running', dependsOn: ['done_prereq'] }),
    ];

    const activeOnly = filterTasksForDag(tasks);
    expect(activeOnly.map((t) => t.id)).toEqual(['done_prereq', 'running_child']);
  });

  it('filters done tasks by age when N days is specified', () => {
    const now = Date.now();
    const oldDone = makeTask({
      id: 'old_done',
      status: 'done',
      updatedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const recentDone = makeTask({
      id: 'recent_done',
      status: 'done',
      updatedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const running = makeTask({ id: 'running', status: 'running' });

    const filtered = filterTasksForDag([oldDone, recentDone, running], { doneFilter: '7d' });
    expect(filtered.map((t) => t.id)).toEqual(['recent_done', 'running']);
  });
});

describe('dagUtils - layoutTaskDag', () => {
  it('returns empty result for empty tasks', () => {
    const result = layoutTaskDag([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it('positions nodes with left-to-right rank and calculates edge points', () => {
    const tasks: Task[] = [
      makeTask({ id: 'parent', status: 'running' }),
      makeTask({ id: 'child', status: 'queued', dependsOn: ['parent'] }),
    ];
    const result = layoutTaskDag(tasks, { rankdir: 'LR' });
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);

    const parentNode = result.nodes.find((n) => n.id === 'parent')!;
    const childNode = result.nodes.find((n) => n.id === 'child')!;

    // Left-to-right: parent X should be less than child X
    expect(parentNode.x).toBeLessThan(childNode.x);
    expect(result.edges[0].points.length).toBeGreaterThanOrEqual(2);
    expect(result.criticalPath).toEqual(['parent', 'child']);
  });
});
