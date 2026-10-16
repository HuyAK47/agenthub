export interface TaskRef { id: string; slug: string }

export function taskRefsFromToolInput(input: unknown, tasks: TaskRef[], projectNames: string[] = []): string[] {
  const text = collectStrings(input).join('\n');
  const found = new Set<string>();
  for (const task of tasks) {
    const escaped = task.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const project = task.id.split(/[~/]/)[0];
    const projectEscaped = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`${projectEscaped}~${escaped}(?:\\b|$)|${projectEscaped}/${escaped}(?:\\b|$)`, 'i'),
      new RegExp(`/worktrees/[^/]+/${escaped}(?:\\b|$)`, 'i'),
      new RegExp(`docs/tasks/${escaped}(?:\\b|$)`, 'i'),
      new RegExp(`["']slug["']\\s*:\\s*["']${escaped}["']`, 'i'),
    ];
    if ((projectNames.length === 0 || projectNames.includes(project)) && patterns.some((pattern) => pattern.test(text))) found.add(task.id);
  }
  return [...found];
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

export function attributeTurn(effectiveTokens: number, taskIds: string[]): Array<{ taskId: string; effectiveTokens: number }> {
  const ids = taskIds.length ? taskIds : ['_general'];
  return ids.map((taskId) => ({ taskId, effectiveTokens: effectiveTokens / ids.length }));
}
