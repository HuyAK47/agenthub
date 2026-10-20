import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, ProfileRepo } from '../src/db/index.js';

describe('profile enabled flag', () => {
  it('giữ trạng thái tắt khi hồ sơ được đăng ký lại lúc khởi động', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-enabled-'));
    const db = openDatabase(path.join(dir, 'hub.db'));
    const repo = new ProfileRepo(db);
    const row = { name: 'chinh', engine: 'agy' as const, kind: 'keyring' as const, home: dir, email: null, enabled: 1, authState: null, authMessage: null, verifyUrl: null };
    repo.upsert(row);
    repo.updateEnabled('chinh', 0);
    repo.upsert(row);
    expect(repo.get('chinh')?.enabled).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
