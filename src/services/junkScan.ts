/**
 * 「扫描与清理垃圾」—— 树莓派长期运行 + 经常断电重启，会留下各种临时/半成品文件。
 *
 * 用户诉求（原话）：100G 空间跑着跑着只剩 50G，断电重启后肯定留下很多垃圾临时文件，
 * 又不想 ssh 上去一个文件一个文件地找 → 要一个"扫描 + 一键清理"。
 *
 * 安全铁律（写在这里，改的人别破）：
 *   1. **只读扫描**、**白名单删除**：每个文件删除前都 `realpath` 校验它确实落在
 *      DOWNLOAD_ROOT / transmission 目录这些白名单根里；不跟符号链接走（lstat）。
 *   2. **绝不碰"还活着"的数据**：aria2 的实时任务集合、正在下载/解析/归档/加密的任务
 *      引用的文件，一律跳过；拿不到 aria2 实时集合（RPC 挂了）时，aria2 目录**整体跳过**，
 *      宁可少清也不误删。
 *   3. **按"久未更新"判断半成品**：yt-dlp 分片 / 解密临时 / 加密临时 用 mtime 阈值
 *      （正在写的文件 mtime 一直在变，绝不会被删）。
 *   4. **孤儿成品只报告、不自动删**：消费者目录里"磁盘上有但数据库没记录"的文件可能是
 *      崩溃时没入账的合法成品 —— 只在报告里列出来，不放进一键清理。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { filesRepo, tasksRepo } from '../core/db';
import { logger } from '../core/logger';
import { aria2Client } from '../modules/aria2Client';
import { nowIso } from '../core/clock';

export interface JunkItem {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  reason: string;
}

export interface JunkCategory {
  key: string;
  label: string;
  description: string;
  /** 是否参与"一键清理"（false = 只报告） */
  autoClean: boolean;
  /** RPC 拿不到、不敢乱删时标记为 skipped（本次不算垃圾） */
  skipped: boolean;
  items: JunkItem[];
  totalBytes: number;
}

export interface DirBreakdown {
  dir: string;
  label: string;
  bytes: number;
  exists: boolean;
}

export interface FileListEntry {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface FileListing {
  dir: string;
  label: string;
  files: FileListEntry[];
  total: number;
  truncated: boolean;
}

export interface JunkReport {
  scannedAt: string;
  categories: JunkCategory[];
  /** 可一键清理的垃圾总字节数（autoClean 且未 skipped 的） */
  junkBytes: number;
  junkCount: number;
  /** 各下载目录占用（让用户看清那几十 G 都去哪了） */
  breakdown: DirBreakdown[];
  /** 关键目录的**原始文件清单**（只读，让用户看清某个目录里到底有哪些文件） */
  fileListing: FileListing[];
}

const HOUR = 3600_000;

/** 递归列文件（不跟符号链接；深度限制防呆） */
function walk(dir: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const go = (d: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue; // 绝不跟符号链接
      if (e.isDirectory()) go(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  go(dir, 0);
  return out;
}

function statOf(p: string): { size: number; mtime: number } | null {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() && !st.isSymbolicLink()) return null;
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const f of walk(dir)) {
    const s = statOf(f);
    if (s) total += s.size;
  }
  return total;
}

/** 目录递归总大小（含子目录文件）——给 breakdown 用 */
function du(dir: string): { bytes: number; exists: boolean } {
  if (!fs.existsSync(dir)) return { bytes: 0, exists: false };
  return { bytes: dirBytes(dir), exists: true };
}

/** 删除白名单：只允许删这些根之下的**普通文件**（逐个 realpath 校验） */
function safeRoots(): string[] {
  return [config.rootDir, config.dirs.root, config.dirs.state, config.transmissionIncompleteDir]
    .filter(Boolean)
    .map((p) => {
      // ⚠️ 必须 realpath：macOS 上 /var 是 /private/var 的软链，/tmp 也一样，
      //    不 realpath 的话 `realpath(文件)` 会落在 /private/...，与白名单根 `/var/...` 对不上
      //    → 全部被"跳过删除"，垃圾一个都清不掉。
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    });
}

export function isWithin(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * 安全删除单个文件：realpath 后仍必须在白名单根内、且是普通文件。
 * 返回删除的字节数；跳过/失败返回 0。
 */
function safeUnlink(p: string): number {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return 0; // 符号链接一律不动
    const real = fs.realpathSync(p);
    const roots = safeRoots();
    if (!roots.some((r) => isWithin(r, real))) {
      logger.child('junk').warn(`跳过删除（不在白名单内）：${p}`);
      return 0;
    }
    const st = fs.lstatSync(real);
    if (!st.isFile()) return 0;
    const size = st.size;
    fs.rmSync(real, { force: true });
    return size;
  } catch {
    return 0;
  }
}

/**
 * 安全删除 zip 打包暂存**目录**（只在 state 下、且名字以 zipstage_ 开头才允许递归删）。
 * 返回释放的字节数。
 */
function safeRemoveZipstage(p: string): number {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return 0;
    const real = fs.realpathSync(p);
    const stateRoot = path.resolve(config.dirs.state);
    if (!isWithin(stateRoot, real)) return 0;
    const st = fs.lstatSync(real);
    if (!st.isDirectory() || !path.basename(real).startsWith('zipstage_')) return 0;
    const size = dirBytes(real);
    fs.rmSync(real, { recursive: true, force: true });
    return size;
  } catch {
    return 0;
  }
}

/** aria2 实时任务引用的所有文件路径（拿不到返回 null → 调用方整体跳过 aria2 目录） */
export async function aria2LivePaths(): Promise<Set<string> | null> {
  const client = aria2Client();
  try {
    const gids = new Set<string>();
    for (const [method, params] of [
      ['aria2.tellActive', []],
      ['aria2.tellWaiting', [0, 2000]],
      ['aria2.tellStopped', [0, 2000]],
    ] as const) {
      const r = await client.call<{ gid: string }[]>(method, [...params], 6000);
      for (const t of r ?? []) if (t?.gid) gids.add(String(t.gid));
    }
    const paths = new Set<string>();
    for (const gid of gids) {
      try {
        const st = await client.call<{ files?: { path: string }[] }>('aria2.tellStatus', [gid, ['files']], 6000);
        for (const f of st?.files ?? []) if (f.path) paths.add(path.resolve(f.path));
      } catch {
        /* 单个查不到就算了 */
      }
    }
    return paths;
  } catch (e) {
    logger.child('junk').warn(`aria2 RPC 不可用，本次不清理 aria2 目录（不乱删）：${(e as Error).message}`);
    return null;
  }
}

/** 数据库里"已知的成品"路径集合（consumer + archiveReady），分页取全 */
function knownPublishedPaths(): Set<string> {
  const set = new Set<string>();
  let page = 1;
  for (;;) {
    const r = filesRepo.list({ page, pageSize: 500 });
    for (const row of r.rows) if (row.path) set.add(path.resolve(row.path));
    if (r.rows.length === 0 || set.size >= r.total) break;
    page += 1;
    if (page > 40) break;
  }
  return set;
}

/** 把所有"还在干活"的任务引用的文件路径收集起来（尽量别误删） */
function liveTaskPaths(): Set<string> {
  const set = new Set<string>();
  const live = tasksRepo.byStatus(['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting']);
  for (const t of live as (ReturnType<typeof tasksRepo.get> & { payload?: Record<string, unknown> })[]) {
    const p = t?.payload ?? {};
    for (const v of [t.outputPath, t.publishedName, p.out, p.downloadDir, p.tempPath, p.seedPath]) {
      if (typeof v === 'string' && v) set.add(path.resolve(v));
    }
  }
  return set;
}

/** 列出一个目录里的文件（读专用，不参与清理），最多 cap 条，超了给 truncated + total */
function listFilesOf(dir: string, cap = 300): { files: FileListEntry[]; total: number; truncated: boolean } {
  const files: FileListEntry[] = [];
  let total = 0;
  try {
    for (const p of walk(dir)) {
      const st = statOf(p);
      if (!st) continue;
      total += 1;
      if (files.length < cap) {
        files.push({ path: p, name: path.basename(p), sizeBytes: st.size, mtimeMs: st.mtime });
      }
    }
  } catch {
    /* ignore */
  }
  return { files, total, truncated: total > files.length };
}

export async function scanJunk(): Promise<JunkReport> {
  const now = Date.now();
  const cats: JunkCategory[] = [];
  const push = (c: Omit<JunkCategory, 'totalBytes'>): JunkCategory => {
    const cat: JunkCategory = { ...c, totalBytes: c.items.reduce((n, i) => n + i.sizeBytes, 0) };
    cats.push(cat);
    return cat;
  };

  const liveTask = liveTaskPaths();

  // ---- ① aria2 残留（.aria2 控制文件 + 它对应的未下完文件）----
  {
    const live = await aria2LivePaths();
    const items: JunkItem[] = [];
    if (live) {
      for (const p of walk(config.dirs.aria2)) {
        if (!p.endsWith('.aria2')) continue;
        const base = p.slice(0, -'.aria2'.length);
        const baseLive = live.has(path.resolve(base)) || liveTask.has(path.resolve(base));
        if (baseLive) continue; // 还在下
        const s1 = statOf(p);
        if (s1) items.push({ path: p, name: path.basename(p), sizeBytes: s1.size, mtimeMs: s1.mtime, reason: '下载任务已不在队列里的 aria2 控制文件' });
        // 对应的未下完文件（有控制文件的才算"半成品"）
        const bs = statOf(base);
        if (bs && fs.existsSync(base)) {
          items.push({ path: base, name: path.basename(base), sizeBytes: bs.size, mtimeMs: bs.mtime, reason: '与上面控制文件配套的未下完文件' });
        }
      }
      push({ key: 'aria2', label: 'aria2 直链残留', description: '任务已不在队列，但还留着 .aria2 控制文件和半成品', autoClean: true, skipped: false, items });
    } else {
      push({ key: 'aria2', label: 'aria2 直链残留', description: 'aria2 RPC 不可用，本次跳过（不敢乱删）', autoClean: true, skipped: true, items });
    }
  }

  // ---- ② yt-dlp 分片/临时（>6 小时没动）----
  {
    const frag = /\.(part(-Frag\d+)?|ytdl|tmp|f\d+\.[A-Za-z0-9]{2,6})$/i;
    const items: JunkItem[] = [];
    for (const dir of [config.dirs.webTools, config.dirs.webToolsDone]) {
      for (const p of walk(dir)) {
        if (!frag.test(path.basename(p))) continue;
        if (liveTask.has(path.resolve(p))) continue;
        const s = statOf(p);
        if (s && now - s.mtime > 6 * HOUR) {
          items.push({ path: p, name: path.basename(p), sizeBytes: s.size, mtimeMs: s.mtime, reason: 'yt-dlp 中断留下的分片/临时文件（>6 小时未更新）' });
        }
      }
    }
    push({ key: 'ytdlp', label: '视频解析下载残留', description: 'yt-dlp 被中断留下的 .part/.ytdl/.tmp 分片', autoClean: true, skipped: false, items });
  }

  // ---- ③ 解密临时（original-tmp，>1 小时）----
  {
    const dir = path.join(config.dirs.state, 'original-tmp');
    const items: JunkItem[] = [];
    for (const p of walk(dir, 3)) {
      const s = statOf(p);
      if (s && now - s.mtime > 1 * HOUR) {
        items.push({ path: p, name: path.basename(p), sizeBytes: s.size, mtimeMs: s.mtime, reason: '解密临时文件（断电/中断后残留）' });
      }
    }
    push({ key: 'original_tmp', label: '解密临时文件', description: '「下载原始文件」断电后残留的临时解密文件', autoClean: true, skipped: false, items });
  }

  // ---- ④ 加密临时（encryptTmp，>6 小时）----
  {
    const items: JunkItem[] = [];
    for (const p of walk(config.dirs.encryptTmp)) {
      if (liveTask.has(path.resolve(p))) continue;
      const s = statOf(p);
      if (s && now - s.mtime > 6 * HOUR) {
        items.push({ path: p, name: path.basename(p), sizeBytes: s.size, mtimeMs: s.mtime, reason: '归档加密中途断电残留的临时文件' });
      }
    }
    push({ key: 'encrypt_tmp', label: '加密临时残留', description: '加密中途断电/崩溃留下的中间文件', autoClean: true, skipped: false, items });
  }

  // ---- ⑤ 归档打包暂存目录（state/zipstage_*，>1 小时）----
  {
    const items: JunkItem[] = [];
    try {
      for (const e of fs.readdirSync(config.dirs.state, { withFileTypes: true })) {
        if (!e.isDirectory() || !e.name.startsWith('zipstage_')) continue;
        const p = path.join(config.dirs.state, e.name);
        const st = fs.lstatSync(p);
        if (now - st.mtimeMs > 1 * HOUR) {
          const size = dirBytes(p);
          items.push({ path: p, name: e.name, sizeBytes: size, mtimeMs: st.mtimeMs, reason: '打包压缩的暂存目录（中断后残留）' });
        }
      }
    } catch {
      /* ignore */
    }
    push({ key: 'zipstage', label: '归档打包暂存', description: '压缩打包中断留下的暂存目录', autoClean: true, skipped: false, items });
  }

  // ---- ⑥ 归档区临时 zip（.tmp_*.zip，>1 小时）----
  {
    const items: JunkItem[] = [];
    for (const p of walk(config.dirs.archiveReady)) {
      const base = path.basename(p);
      if (!base.startsWith('.tmp_') || !base.endsWith('.zip')) continue;
      const s = statOf(p);
      if (s && now - s.mtime > 1 * HOUR) {
        items.push({ path: p, name: base, sizeBytes: s.size, mtimeMs: s.mtime, reason: '归档打包的中途临时 zip' });
      }
    }
    push({ key: 'archive_tmpzip', label: '归档临时包', description: '归档压缩到一半被中断的临时 zip', autoClean: true, skipped: false, items });
  }

  // ---- ⑦ 孤儿成品（只报告，不自动删）----
  {
    const known = knownPublishedPaths();
    const items: JunkItem[] = [];
    for (const dir of [config.dirs.consumer, config.dirs.archiveReady]) {
      for (const p of walk(dir, 2)) {
        if (known.has(path.resolve(p))) continue;
        const s = statOf(p);
        if (s) {
          items.push({ path: p, name: path.basename(p), sizeBytes: s.size, mtimeMs: s.mtime, reason: '磁盘上有、但数据库里没有记录的成品（可能是崩溃时没入账）' });
        }
      }
    }
    push({ key: 'orphan', label: '疑似孤儿成品', description: '可能是有用的成品，只报告不自动删；确认不要了去「文件」页删除', autoClean: false, skipped: false, items });
  }

  // ---- 目录占用（上下文）----
  const breakdown: DirBreakdown[] = [
    { dir: config.dirs.consumer, label: '消费者目录（成品）', ...du(config.dirs.consumer) },
    { dir: config.dirs.archiveReady, label: '归档完成区', ...du(config.dirs.archiveReady) },
    { dir: config.dirs.aria2, label: 'aria2 直链下载区', ...du(config.dirs.aria2) },
    { dir: config.dirs.webTools, label: 'yt-dlp 下载区', ...du(config.dirs.webTools) },
    { dir: config.dirs.encryptTmp, label: '加密临时区', ...du(config.dirs.encryptTmp) },
    { dir: config.dirs.state, label: '状态/日志/临时', ...du(config.dirs.state) },
    { dir: config.dirs.btDownload, label: 'BT 完成目录（transmission 管）', ...du(config.dirs.btDownload) },
    { dir: config.transmissionIncompleteDir, label: 'BT 未完成目录（transmission 管，非垃圾）', ...du(config.transmissionIncompleteDir) },
  ];

  const cleanable = cats.filter((c) => c.autoClean && !c.skipped);

  // 原始文件清单（只读展示用）—— 用户就想看"某个目录里到底堆了啥"
  const listingDirs: { dir: string; label: string }[] = [
    { dir: config.dirs.aria2, label: 'aria2 直链下载区' },
    { dir: config.dirs.webTools, label: 'yt-dlp 下载区' },
    { dir: config.dirs.encryptTmp, label: '加密临时区' },
    { dir: config.dirs.archiveReady, label: '归档完成区' },
    { dir: config.dirs.consumer, label: '消费者目录（成品）' },
    { dir: path.join(config.dirs.state, 'original-tmp'), label: '解密临时目录' },
  ];
  const fileListing: FileListing[] = listingDirs.map((d) => {
    const f = listFilesOf(d.dir);
    return { dir: d.dir, label: d.label, files: f.files, total: f.total, truncated: f.truncated };
  });

  return {
    scannedAt: nowIso(),
    categories: cats,
    junkBytes: cleanable.reduce((n, c) => n + c.totalBytes, 0),
    junkCount: cleanable.reduce((n, c) => n + c.items.length, 0),
    breakdown,
    fileListing,
  };
}

export interface CleanJunkResult {
  deleted: number;
  freedBytes: number;
  errors: string[];
}

/** 真正干活的清理：基于一份已扫描的报告（scan 完马上清，时差最小） */
export function cleanFromReport(report: JunkReport, keys: string[]): CleanJunkResult {
  const want = new Set(keys);
  const result: CleanJunkResult = { deleted: 0, freedBytes: 0, errors: [] };
  for (const cat of report.categories) {
    if (!want.has(cat.key) || !cat.autoClean || cat.skipped) continue;
    for (const item of cat.items) {
      try {
        const freed = cat.key === 'zipstage' ? safeRemoveZipstage(item.path) : safeUnlink(item.path);
        if (freed > 0) {
          result.deleted += 1;
          result.freedBytes += freed;
        }
      } catch (e) {
        result.errors.push(`${item.name}: ${(e as Error).message}`);
      }
    }
  }
  logger.child('junk').mark('JUNK_CLEAN', `清理垃圾：删除 ${result.deleted} 项，释放 ${(result.freedBytes / 1024 ** 2).toFixed(1)} MiB`, {
    keys,
    deleted: result.deleted,
    freedBytes: result.freedBytes,
  });
  return result;
}
