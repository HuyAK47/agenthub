#!/usr/bin/env node
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function resolveLiveDbPath() {
  const candidates = [
    process.env.AGENTHUB_DB_PATH,
    process.env.AGENTHUB_HOME ? path.join(process.env.AGENTHUB_HOME, 'hub.db') : null,
    path.join(os.homedir(), '.agenthub', 'hub.db'),
  ];

  try {
    const userHome = os.userInfo()?.homedir;
    if (userHome && userHome !== os.homedir()) {
      candidates.push(path.join(userHome, '.agenthub', 'hub.db'));
    }
  } catch {
    // Ignore error retrieving user info
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getRowCount(db, tableName) {
  try {
    const row = db.prepare(`SELECT count(*) AS count FROM ${tableName}`).get();
    return typeof row?.count === 'number' ? row.count : Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

async function main() {
  const liveDbPath = resolveLiveDbPath();
  if (!liveDbPath) {
    console.log('[check:migrate] Bỏ qua: Không tìm thấy DB thật (~/.agenthub/hub.db).');
    process.exit(0);
  }

  console.log(`[check:migrate] Tìm thấy DB thật: ${liveDbPath}`);

  const distDbModuleUrl = new URL('../dist/db/index.js', import.meta.url);
  if (!fs.existsSync(distDbModuleUrl)) {
    console.error('[check:migrate] Lỗi: dist/db/index.js không tồn tại. Hãy chạy `npm run build` trước.');
    process.exit(1);
  }

  let srcDb = null;
  let testDb = null;
  let tmpDir = null;

  try {
    // Chỉ mở readonly DB thật để đọc số dòng ban đầu và tạo bản sao backup, tuyệt đối không ghi vào
    srcDb = new Database(liveDbPath, { readonly: true, fileMustExist: true });

    const beforeCounts = {
      tasks: getRowCount(srcDb, 'tasks'),
      runs: getRowCount(srcDb, 'runs'),
      profiles: getRowCount(srcDb, 'profiles'),
    };

    console.log(
      `[check:migrate] Số dòng trước migrate: tasks=${beforeCounts.tasks}, runs=${beforeCounts.runs}, profiles=${beforeCounts.profiles}`,
    );

    const candidateDirs = [
      process.env.AGENTHUB_TEMP_DIR,
      process.env.TMPDIR,
      os.tmpdir(),
      '/tmp',
      '/var/tmp',
    ].filter(Boolean);

    let backupDbPath = null;
    let lastErr = null;
    for (const baseDir of candidateDirs) {
      try {
        tmpDir = fs.mkdtempSync(path.join(baseDir, 'agenthub-migrate-live-'));
        backupDbPath = path.join(tmpDir, 'hub.db');
        console.log(`[check:migrate] Đang sao lưu DB ra thư mục tạm (${backupDbPath}) bằng .backup()...`);
        await srcDb.backup(backupDbPath);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (tmpDir && fs.existsSync(tmpDir)) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup error
          }
          tmpDir = null;
        }
      }
    }

    if (!backupDbPath || lastErr) {
      throw new Error(
        `Không thể tạo thư mục tạm hoặc sao lưu DB ra bất kỳ thư mục tạm nào: ${lastErr?.message}`,
      );
    }

    // Đóng DB thật ngay sau khi hoàn tất backup
    srcDb.close();
    srcDb = null;

    console.log(`[check:migrate] Đang mở bản sao và thực hiện migration bằng openDatabase...`);
    const { openDatabase } = await import('../dist/db/index.js');
    testDb = openDatabase(backupDbPath);

    const fkErrors = testDb.pragma('foreign_key_check');
    const integrityResults = testDb.pragma('integrity_check');
    const isIntegrityOk =
      Array.isArray(integrityResults) &&
      integrityResults.length === 1 &&
      integrityResults[0]?.integrity_check === 'ok';

    const afterCounts = {
      tasks: getRowCount(testDb, 'tasks'),
      runs: getRowCount(testDb, 'runs'),
      profiles: getRowCount(testDb, 'profiles'),
    };

    console.log(
      `[check:migrate] Số dòng sau migrate: tasks=${afterCounts.tasks}, runs=${afterCounts.runs}, profiles=${afterCounts.profiles}`,
    );

    const errors = [];

    if (Array.isArray(fkErrors) && fkErrors.length > 0) {
      errors.push(`foreign_key_check vi phạm (${fkErrors.length} lỗi): ${JSON.stringify(fkErrors)}`);
    }

    if (!isIntegrityOk) {
      errors.push(`integrity_check không đạt: ${JSON.stringify(integrityResults)}`);
    }

    for (const table of ['tasks', 'runs', 'profiles']) {
      if (afterCounts[table] < beforeCounts[table]) {
        errors.push(
          `Bảng ${table} bị giảm số dòng sau migrate: trước=${beforeCounts[table]}, sau=${afterCounts[table]}`,
        );
      }
    }

    console.log('[check:migrate] Kết quả kiểm tra:');
    console.log(`  - foreign_key_check: ${Array.isArray(fkErrors) && fkErrors.length === 0 ? 'OK (rỗng)' : 'FAIL'}`);
    console.log(`  - integrity_check: ${isIntegrityOk ? 'OK (ok)' : 'FAIL'}`);
    console.log(
      `  - tasks: ${beforeCounts.tasks} -> ${afterCounts.tasks} (${afterCounts.tasks >= beforeCounts.tasks ? 'OK' : 'FAIL'})`,
    );
    console.log(
      `  - runs: ${beforeCounts.runs} -> ${afterCounts.runs} (${afterCounts.runs >= beforeCounts.runs ? 'OK' : 'FAIL'})`,
    );
    console.log(
      `  - profiles: ${beforeCounts.profiles} -> ${afterCounts.profiles} (${afterCounts.profiles >= beforeCounts.profiles ? 'OK' : 'FAIL'})`,
    );

    if (errors.length > 0) {
      console.error('[check:migrate] ✗ Kiểm tra migration THẤT BẠI:');
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    console.log('[check:migrate] ✓ Kiểm tra migration THÀNH CÔNG trên bản sao DB thật.');
  } catch (error) {
    console.error('[check:migrate] ✗ Lỗi trong quá trình kiểm tra migration:', error);
    process.exit(1);
  } finally {
    if (srcDb) {
      try {
        srcDb.close();
      } catch {
        // Ignore close error
      }
    }
    if (testDb) {
      try {
        testDb.close();
      } catch {
        // Ignore close error
      }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  }
}

main();
