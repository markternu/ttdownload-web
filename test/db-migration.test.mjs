/**
 * 老库升级（补列）回归测试
 *
 * 背景：published_files 后来新增了下载跟踪列（android_downloads / web_downloads …）。
 * 全新部署建表时自带这些列，但**已有数据库**必须靠 ALTER 补齐 —— 这一路径曾经漏掉，
 * 导致线上老库访问下载接口报 "no such column: web_downloads"。
 * 本测试先用"老结构"造一个库，再用当前代码打开它，验证列被自动补上且功能可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('老库自动补列：published_files 缺下载跟踪列时也能正常使用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-migrate-'));
  const dbPath = path.join(root, 'app.db');

  // 1) 用 sqlite3 造一个"老结构"的库（没有 android_downloads / web_downloads 等列）
  const legacySql = `
    CREATE TABLE published_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      module TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL,
      created_at TEXT NOT NULL, downloaded INTEGER NOT NULL DEFAULT 0, downloaded_at TEXT
    );
    INSERT INTO published_files (name,title,module,size_bytes,path,created_at,downloaded)
      VALUES ('legacy1','老库里的文件','webvideo',123,'/tmp/legacy1','2026-01-01T00:00:00.000Z',0);
  `;
  let madeWithSqlite3 = false;
  try {
    execFileSync('sqlite3', [dbPath], { input: legacySql });
    madeWithSqlite3 = true;
  } catch {
    // 没装 sqlite3 CLI 时用 better-sqlite3 自己造（同一个库文件）
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(dbPath);
    raw.exec(legacySql);
    raw.close();
  }
  assert.ok(fs.existsSync(dbPath));

  // 2) 用当前代码打开该库 → 应自动补列
  process.env.DOWNLOAD_ROOT = root;
  process.env.DB_PATH = dbPath;
  process.env.LOG_PATH = path.join(root, 'state', 'app.log');
  const { filesRepo, db } = await import(`../dist/core/db.js?migrate=${Date.now()}`);

  const cols = db.prepare('PRAGMA table_info(published_files)').all().map((c) => c.name);
  for (const col of ['android_downloads', 'last_android_download_at', 'web_downloads', 'last_web_download_at']) {
    assert.ok(cols.includes(col), `应自动补上列 ${col}（实际：${cols.join(',')}）`);
  }

  // 3) 老数据仍在，且新的跟踪功能可用（这正是线上 500 的场景）
  const row = filesRepo.get(1);
  assert.ok(row, '老数据应保留');
  assert.equal(row.name, 'legacy1');
  assert.doesNotThrow(() => filesRepo.trackDownload(1, 'web'), 'trackDownload 不应再报 no such column');
  assert.doesNotThrow(() => filesRepo.trackDownload(1, 'android'));
  const after = filesRepo.get(1);
  assert.equal(after.web_downloads, 1);
  assert.equal(after.android_downloads, 1);
  assert.ok(after.last_web_download_at && after.last_android_download_at);

  // 4) 待下载清单仍可用
  const pending = filesRepo.pending({});
  assert.equal(pending.total, 1, '老库里未消费的文件应出现在待下载清单');
  assert.equal(madeWithSqlite3, madeWithSqlite3); // 仅记录用哪种方式造库
  fs.rmSync(root, { recursive: true, force: true });
});
