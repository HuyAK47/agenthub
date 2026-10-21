import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeService } from '../src/worktrees/index.js';

describe('References and AGENTS.md context generation', () => {
  it('writes references.md with injected content for text file <= 64KB', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ref-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      const glossaryPath = path.join(root, 'glossary.md');
      const glossaryContent = '# Bảng thuật ngữ\n- Term A: Definition A\n- Term B: Definition B';
      fs.writeFileSync(glossaryPath, glossaryContent, 'utf-8');

      service.writeTaskFile(
        worktree,
        'Implement feature X.',
        false,
        undefined,
        [],
        16000,
        [],
        12000,
        [{ name: 'glossary', path: glossaryPath, inject: true }],
      );

      const refMdPath = path.join(worktree, '.agenthub', 'context', 'references.md');
      expect(fs.existsSync(refMdPath)).toBe(true);

      const content = fs.readFileSync(refMdPath, 'utf-8');
      expect(content).toContain('CHỈ ĐỌC');
      expect(content).toContain('không sửa, không commit');
      expect(content).toContain('## glossary');
      expect(content).toContain(glossaryPath);
      expect(content).toContain('AGENTHUB_REF_GLOSSARY');
      expect(content).toContain(glossaryContent);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not inject content when file exceeds 64KB or is a directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ref-large-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      // 1. File > 64KB (e.g. 70KB)
      const bigFilePath = path.join(root, 'big.txt');
      const bigContent = 'x'.repeat(70 * 1024);
      fs.writeFileSync(bigFilePath, bigContent, 'utf-8');

      // 2. Directory
      const dirPath = path.join(root, 'shared_docs');
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, 'guide.md'), 'guide');

      service.writeTaskFile(
        worktree,
        'Implement feature Y.',
        false,
        undefined,
        [],
        16000,
        [],
        12000,
        [
          { name: 'big_file', path: bigFilePath, inject: true },
          { name: 'shared_dir', path: dirPath, inject: true },
        ],
      );

      const refMdPath = path.join(worktree, '.agenthub', 'context', 'references.md');
      const content = fs.readFileSync(refMdPath, 'utf-8');

      // big_file: listed with warning, content NOT injected
      expect(content).toContain('## big_file');
      expect(content).toContain('vượt quá giới hạn 64KB');
      expect(content).not.toContain(bigContent);

      // shared_dir: listed with warning that it is a directory
      expect(content).toContain('## shared_dir');
      expect(content).toContain('Tham chiếu là thư mục, không tự động inject');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns in context when reference path does not exist without failing or blocking', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ref-missing-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      const missingPath = path.join(root, 'nonexistent', 'doc.md');

      expect(() => {
        service.writeTaskFile(
          worktree,
          'Implement feature Z.',
          false,
          undefined,
          [],
          16000,
          [],
          12000,
          [{ name: 'missing_ref', path: missingPath, inject: true }],
        );
      }).not.toThrow();

      const refMdPath = path.join(worktree, '.agenthub', 'context', 'references.md');
      const content = fs.readFileSync(refMdPath, 'utf-8');
      expect(content).toContain('## missing_ref');
      expect(content).toContain('Đường dẫn tham chiếu không tồn tại');
      expect(content).toContain(missingPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies AGENTS.md (<= 32KB) into .agenthub/context/AGENTS.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-agents-md-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(projectRoot, { recursive: true });

      const agentsContent = '# Project Rules\n1. Follow standards.\n2. Write tests.';
      fs.writeFileSync(path.join(worktree, 'AGENTS.md'), agentsContent, 'utf-8');

      service.writeTaskFile(
        worktree,
        'Implement feature W.',
        false,
        undefined,
        [],
        16000,
        [],
        12000,
        [],
        projectRoot,
      );

      const copiedAgentsPath = path.join(worktree, '.agenthub', 'context', 'AGENTS.md');
      expect(fs.existsSync(copiedAgentsPath)).toBe(true);
      expect(fs.readFileSync(copiedAgentsPath, 'utf-8')).toBe(agentsContent);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not copy AGENTS.md if file exceeds 32KB', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-agents-large-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      const bigAgentsContent = 'a'.repeat(35 * 1024); // 35KB > 32KB
      fs.writeFileSync(path.join(worktree, 'AGENTS.md'), bigAgentsContent, 'utf-8');

      service.writeTaskFile(
        worktree,
        'Implement feature V.',
        false,
        undefined,
        [],
        16000,
        [],
        12000,
        [],
      );

      const copiedAgentsPath = path.join(worktree, '.agenthub', 'context', 'AGENTS.md');
      expect(fs.existsSync(copiedAgentsPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
