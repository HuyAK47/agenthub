import type { ProjectRow, TaskRow } from './db/index.js';
import { projectSettings } from './projects/settings.js';

export interface CommitConventionValues {
  type?: string;
  scope?: string;
  ref?: string;
  summary?: string;
  slug?: string;
  branch?: string;
  target?: string;
}

export function renderCommitTemplate(template: string, values: CommitConventionValues): string {
  return template.replace(/\{(type|scope|ref|summary|slug|branch|target)\}/g, (_, key: keyof CommitConventionValues) => values[key] ?? '');
}

export function renderTaskBranch(project: Pick<ProjectRow, 'settings'>, task: Pick<TaskRow, 'slug'> & { externalRef?: string | null }): string {
  return renderCommitTemplate(projectSettings(project).commitConvention.branchTemplate, {
    slug: task.slug,
    ref: task.externalRef || '',
  });
}

export function commitConventionExample(project: ProjectRow, externalRef = 'PROJ-45'): { branch: string; message: string } {
  const settings = projectSettings(project).commitConvention;
  return {
    branch: renderCommitTemplate(settings.branchTemplate, { slug: 'add-login', ref: externalRef }),
    message: renderCommitTemplate(settings.commitTemplate, { type: 'feat', scope: 'auth', ref: externalRef, summary: 'add login' }),
  };
}
