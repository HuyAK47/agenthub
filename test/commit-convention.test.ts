import { describe, expect, it } from 'vitest';
import { commitConventionExample, renderCommitTemplate, renderTaskBranch } from '../src/commit-convention.js';
import { projectSettings } from '../src/projects/settings.js';

describe('project commit conventions', () => {
  it('renders templates and preserves legacy defaults', () => {
    const project = { settings: null };
    expect(renderTaskBranch(project, { slug: 'login', externalRef: null })).toBe('agenthub/login');
    expect(projectSettings(project).commitConvention.mergeMessageTemplate).toBe("Merge branch '{branch}' into {target}");
    expect(renderCommitTemplate('{type}({scope}): {ref} {summary}', {
      type: 'feat', scope: 'auth', ref: 'OP#123', summary: 'add login',
    })).toBe('feat(auth): OP#123 add login');
  });

  it('renders a concrete example for a configured project', () => {
    const project = {
      settings: JSON.stringify({
        commitConvention: {
          branchTemplate: 'feature/{ref}-{slug}',
          commitTemplate: '{type}({scope}): {ref} {summary}',
          mergeMessageTemplate: 'merge {branch} -> {target}',
        },
      }),
    };
    expect(commitConventionExample(project, 'PROJ-45')).toEqual({
      branch: 'feature/PROJ-45-add-login',
      message: 'feat(auth): PROJ-45 add login',
    });
  });
});
