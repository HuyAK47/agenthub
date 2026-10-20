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

describe('new agy profile auth state', () => {
  it('đánh dấu chưa đăng nhập để scheduler không giao task', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { ProfileService } = await import('../src/profiles/index.js');
    const { QuotaMarkRepo } = await import('../src/db/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-newprof-'));
    const config = loadConfig(dir);
    config.agyHomesDir = path.join(dir, 'agy-homes');
    const db = openDatabase(path.join(dir, 'hub.db'));
    const repo = new ProfileRepo(db);
    const service = new ProfileService(config, repo, new QuotaMarkRepo(db));
    service.createProfile('g9');
    expect(repo.get('g9')?.authState).toBe('not_logged_in');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('trùng email theo nhà cung cấp', () => {
  it('chỉ cảnh báo khi cùng engine và cùng email', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { ProfileService } = await import('../src/profiles/index.js');
    const { QuotaMarkRepo } = await import('../src/db/index.js');
    const { QuotaService } = await import('../src/quota/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dupe-'));
    const db = openDatabase(path.join(dir, 'hub.db'));
    const repo = new ProfileRepo(db);
    const marks = new QuotaMarkRepo(db);
    const base = { home: dir, enabled: 1, authState: null, authMessage: null, verifyUrl: null };
    repo.upsert({ ...base, name: 'g1', engine: 'agy', kind: 'isolated', email: 'a@x.com' });
    repo.upsert({ ...base, name: 'claude-may', engine: 'claude', kind: 'system', email: 'a@x.com' });
    const service = new ProfileService(loadConfig(dir), repo, marks);
    expect(service.getDuplicateEmails().size).toBe(0);

    repo.upsert({ ...base, name: 'g2', engine: 'agy', kind: 'isolated', email: 'a@x.com' });
    expect([...service.getDuplicateEmails().entries()]).toEqual([['agy:a@x.com', ['g1', 'g2']]]);

    new QuotaService(marks, repo).mark('g1', 'gemini', 2_000_000_000, 'test');
    const marked = marks.getActive().map((m) => m.profileName).sort();
    expect(marked).toEqual(['g1', 'g2']);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('xoá hồ sơ (soft delete)', () => {
  it('ẩn hồ sơ, không hồi sinh khi đăng ký lại, tạo lại được', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-softdel-'));
    const db = openDatabase(path.join(dir, 'hub.db'));
    const repo = new ProfileRepo(db);
    const row = { name: 'chinh', engine: 'agy' as const, kind: 'keyring' as const, home: dir, email: 'a@x.com', enabled: 1, authState: null, authMessage: null, verifyUrl: null };
    repo.upsert(row);
    repo.softDelete('chinh');
    expect(repo.getAll().map((p) => p.name)).not.toContain('chinh');
    expect(repo.getEnabled().map((p) => p.name)).not.toContain('chinh');
    repo.upsert(row); // startup registration must not bring it back
    expect(repo.isDeleted('chinh')).toBe(true);
    expect(repo.get('chinh')?.name).toBe('chinh'); // history lookups still work
    repo.restore('chinh');
    expect(repo.getEnabled().map((p) => p.name)).toContain('chinh');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
