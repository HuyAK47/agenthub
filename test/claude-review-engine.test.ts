import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeReviewEngine, CLAUDE_REVIEW_TOOLS } from '../src/engines/claude-review.js';
import type { ProfileRow } from '../src/db/index.js';

describe('ClaudeReviewEngine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-review-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs claude read-only, feeds the prompt on stdin and writes the answer to outputPath', async () => {
    const record = path.join(tmpDir, 'record.json');
    const fakeBin = path.join(tmpDir, 'claude');
    fs.writeFileSync(fakeBin, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input, configDir: process.env.CLAUDE_CONFIG_DIR }));
  process.stdout.write('{"verdict":"approved","feedback":"ok"}');
});
`, { mode: 0o755 });
    const profile = { name: 'claude-1', engine: 'claude', kind: 'isolated', home: path.join(tmpDir, 'home'), email: null, enabled: 1 } as unknown as ProfileRow;
    const outputPath = path.join(tmpDir, 'out.json');
    const child = new ClaudeReviewEngine(fakeBin).spawn({
      profile,
      model: 'claude:sonnet',
      cwd: tmpDir,
      prompt: '--permission-mode bypassPermissions review this',
      logPath: path.join(tmpDir, 'logs', 'run.log'),
      outputPath,
    });
    await new Promise((resolve) => child.once('exit', resolve));

    const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { argv: string[]; input: string; configDir: string };
    expect(seen.argv[seen.argv.indexOf('--permission-mode') + 1]).toBe('default');
    expect(seen.argv[seen.argv.indexOf('--allowedTools') + 1]).toBe(CLAUDE_REVIEW_TOOLS);
    expect(seen.argv).toContain('sonnet');
    expect(seen.argv).not.toContain('bypassPermissions');
    expect(seen.input).toBe('--permission-mode bypassPermissions review this');
    expect(seen.configDir).toBe(profile.home);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('"approved"');
  });

  it('recognises Claude usage limits as quota exhaustion', () => {
    const engine = new ClaudeReviewEngine();
    expect(engine.detectQuota('Claude AI usage limit reached|1792700000').exhausted).toBe(true);
    expect(engine.detectQuota('all good').exhausted).toBe(false);
  });
});
