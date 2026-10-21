import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from '../src/db/index.js';

// Migrations run by index (schema_version). A migration inserted in the middle shifts every
// later index: databases already in use then skip it and re-run an old one (duplicate column,
// daemon fails to start). This happened three times on 20/10. Existing entries must never change;
// new migrations go at the end, then append their hash to test/fixtures/migrations.lock.
const hash = (sql: string) => crypto.createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

describe('MIGRATIONS chỉ được thêm vào cuối', () => {
  it('các migration đã phát hành giữ nguyên vị trí và nội dung', () => {
    const lock = fs.readFileSync(path.join(__dirname, 'fixtures', 'migrations.lock'), 'utf8').trim().split('\n');
    const current = MIGRATIONS.map(hash);
    expect(current.length).toBeGreaterThanOrEqual(lock.length);
    lock.forEach((h, i) => {
      expect(current[i], `migration ${i} đã đổi hoặc bị chèn migration khác vào trước nó`).toBe(h);
    });
  });
});
