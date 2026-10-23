import { Task, TaskDetail } from '../types/api';

/**
 * Determines whether the active/fallback reviewer for a task is Codex or Claude.
 */
export function getReviewerEngine(task: Task | TaskDetail): 'codex' | 'claude' {
  if (task.reviewer) return task.reviewer;
  if ('events' in task && Array.isArray((task as TaskDetail).events) && (task as TaskDetail).events?.some((e) => e.type === 'review.fallback')) {
    return 'claude';
  }
  if ('reviews' in task && Array.isArray((task as TaskDetail).reviews) && (task as TaskDetail).reviews?.some((r) => r.actor === 'claude-reviewer')) {
    return 'claude';
  }
  if ('runs' in task && Array.isArray((task as TaskDetail).runs) && (task as TaskDetail).runs?.some((r) => r.kind === 'reviewer' && r.engine === 'claude')) {
    return 'claude';
  }
  const currentStep = task.reviewChain?.[task.reviewStep ?? 0];
  if (currentStep?.reviewer?.startsWith('claude')) return 'claude';
  return 'codex';
}
