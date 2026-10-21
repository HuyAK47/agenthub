import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('test service-command safety shim', () => {
  it.each(['systemctl', 'launchctl'])('blocks real %s calls', (command) => {
    const result = spawnSync(command, ['status', 'agenthub'], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('blocked test service command');
  });
});
