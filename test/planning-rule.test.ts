import { describe, it, expect } from 'vitest';
import { buildBrainPrompt, planningRule } from '../src/chat/claude.js';

describe('quy tắc duyệt kế hoạch theo Settings', () => {
  it('mặc định không bắt duyệt: giao thẳng', () => {
    expect(planningRule()).toContain('không cần duyệt');
    expect(buildBrainPrompt()).not.toContain('{{PLANNING_RULE}}');
  });
  it('chỉ duyệt kế hoạch từ N task', () => {
    expect(planningRule({ approvalMinTasks: 5 })).toContain('từ 5 task');
  });
  it('duyệt mọi task khi requireApproval', () => {
    expect(planningRule({ requireApproval: true, approvalMinTasks: 5 })).toContain('Mọi task');
  });
});
