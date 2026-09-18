import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config';
import type { ModuleId, SeedItem, Task, TaskStatus } from '../types';

ensureDirs();

export const db: Database.Database = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  platform TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  priority INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  speed_bps INTEGER NOT NULL DEFAULT 0,
  eta_sec INTEGER,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  expect_bytes INTEGER NOT NULL DEFAULT 0,
  output_path TEXT,
  published_name TEXT,
  error TEXT,
  meta_json TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_module ON tasks(module);

CREATE TABLE IF NOT EXISTS published_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  module TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  downloaded INTEGER NOT NULL DEFAULT 0,
  downloaded_at TEXT,
  -- 下载跟踪（只统计，不影响 downloaded 语义：downloaded=1 仍表示"安卓已上报完成/已消费"）
  android_downloads INTEGER NOT NULL DEFAULT 0,
  last_android_download_at TEXT,
  web_downloads INTEGER NOT NULL DEFAULT 0,
  last_web_download_at TEXT
);

CREATE TABLE IF NOT EXISTS seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/**
 * 老库补列（幂等）：SQLite 不支持 ADD COLUMN IF NOT EXISTS，先查 PRAGMA 再 ALTER。
 * 必须放在上面的建表语句**之后**执行，否则表还没建出来，ALTER 会失败并被吞掉。
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// published_files 的下载跟踪列（新库建表时已包含；老库在这里补上）
ensureColumn('published_files', 'android_downloads', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('published_files', 'last_android_download_at', 'TEXT');
ensureColumn('published_files', 'web_downloads', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('published_files', 'last_web_download_at', 'TEXT');

const nowIso = (): string => new Date().toISOString();

interface TaskRow {
  id: number;
  module: ModuleId;
  title: string;
  platform: string | null;
  url: string | null;
  status: TaskStatus;
  priority: number;
  progress: number;
  speed_bps: number;
  eta_sec: number | null;
  total_bytes: number;
  downloaded_bytes: number;
  expect_bytes: number;
  output_path: string | null;
  published_name: string | null;
  error: string | null;
  meta_json: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  retry_count: number;
}

export function rowToTask(row: TaskRow): Task & { payload?: Record<string, unknown>; retryCount: number } {
  let meta: Task['meta'] = null;
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json);
    } catch {
      meta = null;
    }
  }
  let payload: Record<string, unknown> | undefined;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = undefined;
    }
  }
  return {
    id: row.id,
    module: row.module,
    title: row.title,
    platform: row.platform,
    url: row.url,
    status: row.status,
    progress: row.progress,
    speedBps: row.speed_bps,
    etaSec: row.eta_sec,
    totalBytes: row.total_bytes,
    downloadedBytes: row.downloaded_bytes,
    expectBytes: row.expect_bytes,
    outputPath: row.output_path,
    publishedName: row.published_name,
    error: row.error,
    meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    payload,
    retryCount: row.retry_count,
  };
}

export interface TaskInput {
  module: ModuleId;
  title: string;
  platform?: string | null;
  url?: string | null;
  status?: TaskStatus;
  priority?: number;
  expectBytes?: number;
  outputPath?: string | null;
  meta?: Task['meta'];
  payload?: Record<string, unknown>;
}

/**
 * 任务筛选条件的 SQL 片段。
 * ⚠️ list() 与 summary() 必须共用它 —— 否则"列表"和"头部统计"又会出现两套口径
 * （这正是用户看到的：侧边栏一个数、任务页另一个数）。
 */
function taskWhere(opts: {
  modules?: ModuleId[];
  statuses?: TaskStatus[];
  ids?: number[];
  q?: string;
  /** download = 下载任务；publish = 扫货产生的「归档→加密→发布」子任务；不传 = 全部 */
  kind?: 'download' | 'publish';
}): { whereSql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const IS_PUBLISH =
    "(json_extract(payload_json,'$.harvest') IS NOT NULL OR json_extract(payload_json,'$.earlyHandoff') IS NOT NULL)";
  if (opts.kind === 'publish') where.push(IS_PUBLISH);
  else if (opts.kind === 'download') where.push(`NOT ${IS_PUBLISH}`);
  if (opts.modules?.length) {
    where.push(`module IN (${opts.modules.map(() => '?').join(',')})`);
    args.push(...opts.modules);
  }
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
    args.push(...opts.statuses);
  }
  if (opts.ids?.length) {
    where.push(`id IN (${opts.ids.map(() => '?').join(',')})`);
    args.push(...opts.ids);
  }
  if (opts.q) {
    where.push('(title LIKE ? OR url LIKE ?)');
    args.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export const tasksRepo = {
  create(input: TaskInput): Task {
    const ts = nowIso();
    const info = db
      .prepare(
        `INSERT INTO tasks (module,title,platform,url,status,priority,expect_bytes,output_path,meta_json,payload_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.module,
        input.title ?? '',
        input.platform ?? null,
        input.url ?? null,
        input.status ?? 'waiting',
        input.priority ?? 0,
        input.expectBytes ?? 0,
        input.outputPath ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        input.payload ? JSON.stringify(input.payload) : null,
        ts,
        ts,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },

  get(id: number): Task | null {
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  },

  update(id: number, patch: Partial<Record<string, unknown>> & { meta?: Task['meta']; payload?: Record<string, unknown> }): Task | null {
    const map: Record<string, string> = {
      title: 'title',
      platform: 'platform',
      url: 'url',
      status: 'status',
      priority: 'priority',
      progress: 'progress',
      speedBps: 'speed_bps',
      etaSec: 'eta_sec',
      totalBytes: 'total_bytes',
      downloadedBytes: 'downloaded_bytes',
      expectBytes: 'expect_bytes',
      outputPath: 'output_path',
      publishedName: 'published_name',
      error: 'error',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      retryCount: 'retry_count',
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col}=?`);
        args.push((patch as Record<string, unknown>)[k] ?? null);
      }
    }
    if ('meta' in patch) {
      sets.push('meta_json=?');
      args.push(patch.meta ? JSON.stringify(patch.meta) : null);
    }
    if ('payload' in patch) {
      sets.push('payload_json=?');
      args.push(patch.payload ? JSON.stringify(patch.payload) : null);
    }
    sets.push('updated_at=?');
    args.push(nowIso());
    args.push(id);
    db.prepare(`UPDATE tasks SET ${sets.join(',')} WHERE id=?`).run(...(args as never[]));
    return this.get(id);
  },

  list(opts: {
    modules?: ModuleId[];
    statuses?: TaskStatus[];
    q?: string;
    sort?: string;
    page?: number;
    pageSize?: number;
    ids?: number[];
    /** download = 下载任务；publish = 归档发布子任务；不传 = 全部 */
    kind?: 'download' | 'publish';
  }): { items: Task[]; total: number } {
    const { whereSql, args } = taskWhere(opts);
    const total = (db.prepare(`SELECT COUNT(*) c FROM tasks ${whereSql}`).get(...(args as never[])) as { c: number }).c;

    const sortMap: Record<string, string> = {
      created_desc: 'created_at DESC',
      created_asc: 'created_at ASC',
      updated_desc: 'updated_at DESC',
      size_desc: 'total_bytes DESC',
      progress_desc: 'progress DESC',
    };
    const order = sortMap[opts.sort ?? 'created_desc'] ?? 'created_at DESC';
    const page = Math.max(1, opts.page ?? 1);
    // 上限 1000：扫货/入队/收尾都要"一次拿到全部非终态任务"做去重（它们传 500）。
    // 以前这里硬截 200 —— 任务数一多，去重与收尾就会漏项，从而产生重复的发布任务。
    const pageSize = Math.min(1000, Math.max(1, opts.pageSize ?? 20));
    const rows = db
      .prepare(`SELECT * FROM tasks ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...(args as never[]), pageSize, (page - 1) * pageSize) as TaskRow[];
    return { items: rows.map(rowToTask), total };
  },

  /**
   * 列表筛选条件下的**统计口径**：状态分布 + 「种子下载任务 vs 归档发布子任务」拆分。
   *
   * 为什么要单独有这个（血案）：任务页标题写着"下载任务"，但 `total` 是**所有**任务 ——
   * BT 的「扫货 → 归档 → 加密 → 发布」会为每个目录再建一个发布子任务（payload.harvest），
   * 于是 14 个种子在页面上显示成 23 个任务，用户以为计数坏了，其实只是没说明白。
   * 这里用**和 total 完全相同的 where 条件**统计，页面才能把 23 解释成「下载 14 + 发布 9」。
   */
  summary(opts: { modules?: ModuleId[]; statuses?: TaskStatus[]; q?: string; kind?: 'download' | 'publish' }): {
    byStatus: Record<string, number>;
    download: number;
    publish: number;
  } {
    const { whereSql, args } = taskWhere(opts);
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) c,
           SUM(CASE WHEN json_extract(payload_json,'$.harvest') IS NOT NULL
                     OR json_extract(payload_json,'$.earlyHandoff') IS NOT NULL THEN 1 ELSE 0 END) pub
         FROM tasks ${whereSql} GROUP BY status`,
      )
      .all(...(args as never[])) as { status: string; c: number; pub: number }[];
    const byStatus: Record<string, number> = {};
    let download = 0;
    let publish = 0;
    for (const r of rows) {
      byStatus[r.status] = r.c;
      publish += Number(r.pub ?? 0);
      download += r.c - Number(r.pub ?? 0);
    }
    return { byStatus, download, publish };
  },

  byStatus(statuses: TaskStatus[]): (Task & { payload?: Record<string, unknown> })[] {
    const rows = db
      .prepare(`SELECT * FROM tasks WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY priority DESC, id ASC`)
      .all(...(statuses as never[])) as TaskRow[];
    return rows.map(rowToTask);
  },

  delete(id: number): void {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  },
};

interface PublishedRow {
  id: number;
  task_id: number | null;
  name: string;
  title: string;
  module: ModuleId;
  size_bytes: number;
  path: string;
  created_at: string;
  downloaded: number;
  downloaded_at: string | null;
  android_downloads: number | null;
  last_android_download_at: string | null;
  web_downloads: number | null;
  last_web_download_at: string | null;
}

export const filesRepo = {
  add(input: { taskId?: number | null; name: string; title: string; module: ModuleId; sizeBytes: number; path: string }): number {
    const info = db
      .prepare(
        `INSERT INTO published_files (task_id,name,title,module,size_bytes,path,created_at,downloaded)
         VALUES (?,?,?,?,?,?,?,0)`,
      )
      .run(input.taskId ?? null, input.name, input.title, input.module, input.sizeBytes, input.path, nowIso());
    return Number(info.lastInsertRowid);
  },
  get(id: number): PublishedRow | null {
    return (db.prepare('SELECT * FROM published_files WHERE id=?').get(id) as PublishedRow | undefined) ?? null;
  },
  getByPath(p: string): PublishedRow | null {
    return (db.prepare('SELECT * FROM published_files WHERE path=?').get(p) as PublishedRow | undefined) ?? null;
  },
  list(opts: { q?: string; page?: number; pageSize?: number; pendingOnly?: boolean }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.pendingOnly) where.push('downloaded=0');
    if (opts.q) {
      where.push('(name LIKE ? OR title LIKE ?)');
      args.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) c FROM published_files ${whereSql}`).get(...(args as never[])) as { c: number }).c;
    const sum = (db.prepare(`SELECT COALESCE(SUM(size_bytes),0) s FROM published_files ${whereSql}`).get(...(args as never[])) as { s: number }).s;
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 20));
    const rows = db
      .prepare(`SELECT * FROM published_files ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...(args as never[]), pageSize, (page - 1) * pageSize) as PublishedRow[];
    return { rows, total, sum };
  },
  /** 记录一次下载（安卓端 / 网页端分开统计；不影响 downloaded 语义） */
  trackDownload(id: number, kind: 'android' | 'web'): void {
    const col = kind === 'android' ? 'android_downloads' : 'web_downloads';
    const atCol = kind === 'android' ? 'last_android_download_at' : 'last_web_download_at';
    db.prepare(`UPDATE published_files SET ${col} = COALESCE(${col},0) + 1, ${atCol} = ? WHERE id = ?`).run(nowIso(), id);
  },

  /** 待下载清单（安卓还没上报完成 = 还没被取走的成品） */
  pending(opts: { q?: string; page?: number; pageSize?: number } = {}) {
    return this.list({ ...opts, pendingOnly: true });
  },

  markDownloaded(id: number): void {
    db.prepare('UPDATE published_files SET downloaded=1, downloaded_at=? WHERE id=?').run(nowIso(), id);
  },
  remove(id: number): void {
    db.prepare('DELETE FROM published_files WHERE id=?').run(id);
  },
};

interface SeedRow {
  id: number;
  name: string;
  path: string;
  status: SeedItem['status'];
  size_bytes: number;
  file_count: number;
  task_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const rowToSeed = (r: SeedRow): SeedItem => ({
  id: r.id,
  name: r.name,
  path: r.path,
  status: r.status,
  sizeBytes: r.size_bytes,
  fileCount: r.file_count,
  taskId: r.task_id,
  error: r.error,
});

export const seedsRepo = {
  upsertByPath(input: { name: string; path: string }): SeedItem {
    const exist = db.prepare('SELECT * FROM seeds WHERE path=?').get(input.path) as SeedRow | undefined;
    if (exist) return rowToSeed(exist);
    const ts = nowIso();
    const info = db
      .prepare('INSERT INTO seeds (name,path,status,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(input.name, input.path, 'pending', ts, ts);
    return rowToSeed(db.prepare('SELECT * FROM seeds WHERE id=?').get(Number(info.lastInsertRowid)) as SeedRow);
  },
  update(id: number, patch: Partial<{ status: SeedItem['status']; sizeBytes: number; fileCount: number; taskId: number | null; error: string | null; path: string; name: string }>): void {
    const map: Record<string, string> = {
      status: 'status',
      sizeBytes: 'size_bytes',
      fileCount: 'file_count',
      taskId: 'task_id',
      error: 'error',
      path: 'path',
      name: 'name',
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col}=?`);
        args.push((patch as Record<string, unknown>)[k] ?? null);
      }
    }
    sets.push('updated_at=?');
    args.push(nowIso(), id);
    db.prepare(`UPDATE seeds SET ${sets.join(',')} WHERE id=?`).run(...(args as never[]));
  },
  all(): SeedItem[] {
    return (db.prepare('SELECT * FROM seeds ORDER BY id DESC').all() as SeedRow[]).map(rowToSeed);
  },
  get(id: number): SeedItem | null {
    const r = db.prepare('SELECT * FROM seeds WHERE id=?').get(id) as SeedRow | undefined;
    return r ? rowToSeed(r) : null;
  },
  delete(id: number): void {
    db.prepare('DELETE FROM seeds WHERE id=?').run(id);
  },
};

export const settingsRepo = {
  getAll(): Record<string, string> {
    const rows = db.prepare('SELECT key,value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
  setMany(values: Record<string, string>): void {
    const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const tx = db.transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) stmt.run(k, v);
    });
    tx(Object.entries(values));
  },
};

export const logsRepo = {
  add(level: string, message: string): void {
    db.prepare('INSERT INTO event_logs (level,message,at) VALUES (?,?,?)').run(level, message, nowIso());
    // 保留最近 5000 条
    db.prepare('DELETE FROM event_logs WHERE id NOT IN (SELECT id FROM event_logs ORDER BY id DESC LIMIT 5000)').run();
  },
  recent(limit = 200): { id: number; level: string; message: string; at: string }[] {
    return db
      .prepare('SELECT * FROM event_logs ORDER BY id DESC LIMIT ?')
      .all(limit) as { id: number; level: string; message: string; at: string }[];
  },
};

/** 统计（Dashboard 用） */
export function computeStats(): import('../types').Stats {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();
  const one = (sql: string, ...args: unknown[]): number =>
    ((db.prepare(sql).get(...(args as never[])) as { c: number } | undefined)?.c ?? 0) as number;

  // ⚠️ BT 的「扫货 → 归档 → 加密 → 发布」会为每个目录**再建一个任务**（module 同样是
  //    transmission，payload.harvest 标记它）。所有统计都必须把这两类分开，否则：
  //      · 14 个种子会统计成 23 个任务
  //      · 一个种子下完 + 发布完会被算成"完成 2 个"
  //      · 归档中的子任务会被算进"下载中"
  //    （用户报的"两个数字对不上、总量虚高"就是这个原因）
  const IS_PUBLISH = "(json_extract(payload_json,'$.harvest') IS NOT NULL OR json_extract(payload_json,'$.earlyHandoff') IS NOT NULL)";
  const NOT_PUBLISH = `NOT ${IS_PUBLISH}`;
  const todayTasks = one(`SELECT COUNT(*) c FROM tasks WHERE created_at >= ? AND ${NOT_PUBLISH}`, todayIso);
  const todayCompleted = one(`SELECT COUNT(*) c FROM tasks WHERE status='completed' AND finished_at >= ? AND ${NOT_PUBLISH}`, todayIso);
  const todayPublished = one(`SELECT COUNT(*) c FROM tasks WHERE status='completed' AND finished_at >= ? AND ${IS_PUBLISH}`, todayIso);
  const downloading = one("SELECT COUNT(*) c FROM tasks WHERE status IN ('downloading','parsing')");
  const publishing = one("SELECT COUNT(*) c FROM tasks WHERE status IN ('archiving','encrypting')");
  const waiting = one("SELECT COUNT(*) c FROM tasks WHERE status IN ('waiting','paused')");
  const failed = one("SELECT COUNT(*) c FROM tasks WHERE status='failed'");
  const totalTasks = one('SELECT COUNT(*) c FROM tasks');
  const downloadTasks = one(`SELECT COUNT(*) c FROM tasks WHERE ${NOT_PUBLISH}`);
  const publishTasks = one(`SELECT COUNT(*) c FROM tasks WHERE ${IS_PUBLISH}`);
  const completedAll = one("SELECT COUNT(*) c FROM tasks WHERE status='completed'");
  const totalDownloadedBytes = ((db.prepare('SELECT COALESCE(SUM(size_bytes),0) s FROM published_files').get() as { s: number }).s ?? 0) as number;

  const perPlatform = db
    .prepare(
      `SELECT COALESCE(platform,'未知') platform, COUNT(*) count FROM tasks
       WHERE status='completed' AND ${NOT_PUBLISH} GROUP BY platform ORDER BY count DESC LIMIT 10`,
    )
    .all() as { platform: string; count: number }[];

  const dailyRows = db
    .prepare(
      `SELECT substr(created_at,1,10) date, COUNT(*) count FROM tasks
       WHERE created_at >= datetime('now','-7 day') GROUP BY date ORDER BY date`,
    )
    .all() as { date: string; count: number }[];
  const bytesRows = db
    .prepare(
      `SELECT substr(created_at,1,10) date, COALESCE(SUM(size_bytes),0) bytes FROM published_files
       WHERE created_at >= datetime('now','-7 day') GROUP BY date`,
    )
    .all() as { date: string; bytes: number }[];
  const bytesMap = new Map(bytesRows.map((r) => [r.date, r.bytes]));

  const recent = tasksRepo.list({ pageSize: 8, sort: 'updated_desc' }).items;

  return {
    todayTasks,
    todayCompleted,
    todayPublished,
    downloading,
    publishing,
    waiting,
    failed,
    totalDownloadedBytes,
    totalTasks,
    downloadTasks,
    publishTasks,
    successRate: totalTasks > 0 ? completedAll / totalTasks : 0,
    perPlatform,
    daily: dailyRows.map((r) => ({ date: r.date, count: r.count, bytes: bytesMap.get(r.date) ?? 0 })),
    recentTasks: recent,
  };
}

export { nowIso };
export const dbFileSize = (): number => {
  try {
    return fs.statSync(config.dbPath).size;
  } catch {
    return 0;
  }
};
