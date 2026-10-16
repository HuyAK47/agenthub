import { describe, it, expect } from 'vitest';
import { groupTasksByStatus } from '../utils/tasks';
import { Task } from '../types/api';

describe('Kanban Task Grouping', () => {
  const sampleTasks: Task[] = [
    {
      id: 'p1~t1',
      projectId: 'p1',
      slug: 't1',
      title: 'Task Draft',
      status: 'draft',
      level: 'easy',
      dependsOn: [],
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t2',
      projectId: 'p1',
      slug: 't2',
      title: 'Task Queued',
      status: 'queued',
      level: 'easy',
      dependsOn: [],
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t3',
      projectId: 'p1',
      slug: 't3',
      title: 'Task Running',
      status: 'running',
      level: 'hard',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t3b',
      projectId: 'p1',
      slug: 't3b',
      title: 'Task Checking',
      status: 'checking',
      level: 'hard',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t4',
      projectId: 'p1',
      slug: 't4',
      title: 'Task Review',
      status: 'review',
      level: 'hard',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t5',
      projectId: 'p1',
      slug: 't5',
      title: 'Task Waiting Quota',
      status: 'waiting_quota',
      level: 'easy',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t6',
      projectId: 'p1',
      slug: 't6',
      title: 'Task Blocked',
      status: 'blocked',
      level: 'hard',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t7',
      projectId: 'p1',
      slug: 't7',
      title: 'Task Failed',
      status: 'failed',
      level: 'easy',
      dependsOn: [],
      attempt: 2,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'p1~t8',
      projectId: 'p1',
      slug: 't8',
      title: 'Task Done',
      status: 'done',
      level: 'easy',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
  ];

  it('nhóm chính xác các task vào đúng mảng trạng thái tương ứng', () => {
    const grouped = groupTasksByStatus(sampleTasks);

    expect(grouped.draft).toHaveLength(1);
    expect(grouped.draft[0].slug).toBe('t1');

    expect(grouped.queued).toHaveLength(1);
    expect(grouped.queued[0].slug).toBe('t2');

    expect(grouped.running).toHaveLength(1);
    expect(grouped.running[0].slug).toBe('t3');

    expect(grouped.checking).toHaveLength(1);
    expect(grouped.checking[0].slug).toBe('t3b');

    expect(grouped.review).toHaveLength(1);
    expect(grouped.review[0].slug).toBe('t4');

    expect(grouped.waiting_quota).toHaveLength(1);
    expect(grouped.waiting_quota[0].slug).toBe('t5');

    expect(grouped.blocked).toHaveLength(1);
    expect(grouped.blocked[0].slug).toBe('t6');

    expect(grouped.failed).toHaveLength(1);
    expect(grouped.failed[0].slug).toBe('t7');

    expect(grouped.done).toHaveLength(1);
    expect(grouped.done[0].slug).toBe('t8');
  });

  it('khởi tạo đầy đủ các nhóm rỗng khi danh sách task đầu vào rỗng', () => {
    const grouped = groupTasksByStatus([]);

    expect(grouped.queued).toEqual([]);
    expect(grouped.running).toEqual([]);
    expect(grouped.done).toEqual([]);
    expect(grouped.review).toEqual([]);
  });
});
