/**
 * 树莓派外部存储（U 盘 / 移动硬盘）检测、自动挂载、归档资源剪切、弹出。
 *
 * 约束（用户明确）：
 *  - 同一时刻只有一个外部存储设备（要么 U 盘、要么移动硬盘）
 *  - 用户不知道何时插入 → 后台每 10 秒巡检一次，插了没挂载就自动挂载
 *  - 归档好的资源（consumer 目录里的成品）直接"剪切"到 U 盘根目录的 ttdownload/ 下
 *  - 页面显示已挂载的盘 + 「弹出」按钮（sync + umount）
 *
 * 服务以 root 运行（deploy.sh 里 User=root），所以 mount/umount 直接执行，无需 sudo。
 */
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { getSettings } from './settings';
import { filesRepo } from '../core/db';

const MOUNT_DIR = '/mnt/usb';
const TARGET_DIR = 'ttdownload';

/** 归档/加密/成品三个"文件操作"目录：U 盘在时切到 U 盘，否则用 SD 默认目录 */
export interface WorkDirs {
  archiveReady: string;
  encryptTmp: string;
  consumer: string;
  onUsb: boolean;
}

export function workDirs(): WorkDirs {
  const s = getCachedUsbState();
  if (s.mounted && s.mountpoint && fs.existsSync(s.mountpoint)) {
    const base = path.join(s.mountpoint, TARGET_DIR);
    return {
      archiveReady: path.join(base, 'downd_ok_p2'),
      encryptTmp: path.join(base, 'downd_ok_p2_jiami_tmp'),
      consumer: path.join(base, 'xiaofeizhe_downd'),
      onUsb: true,
    };
  }
  return {
    archiveReady: config.dirs.archiveReady,
    encryptTmp: config.dirs.encryptTmp,
    consumer: config.dirs.consumer,
    onUsb: false,
  };
}

/** 有效预留空间：U 盘挂载时那 10G 红线取消（文件操作周转用 U 盘的空间），否则照旧 10G */
export function effectiveReserve(): number {
  const s = getCachedUsbState();
  return s.mounted ? 0 : getSettings().reserveFreeBytes;
}

export interface UsbState {
  /** 是否插着外部盘（U 盘/移动硬盘） */
  present: boolean;
  /** 是否已挂载 */
  mounted: boolean;
  device?: string;
  mountpoint?: string;
  fstype?: string;
  label?: string;
  sizeBytes?: number;
  freeBytes?: number;
  /** 检测到重复挂载/失效挂载，需要"全部卸载后重新挂载" */
  needsReset?: boolean;
  /** 该分区当前的全部挂载点（诊断用） */
  mounts?: string[];
  lastError?: string;
}

interface Block {
  name: string;
  type: string;
  size: string;
  fstype: string | null;
  mountpoint: string | null;
  model: string | null;
  tran: string | null;
}

function lsblk(): Block[] {
  try {
    const out = execFileSync('lsblk', ['-J', '-o', 'NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,MODEL,TRAN'], { encoding: 'utf8', timeout: 5000 });
    const j = JSON.parse(out) as { blockdevices?: unknown[] };
    const blocks: Block[] = [];
    const walk = (nodes: unknown[]) => {
      for (const n of nodes as Array<Record<string, unknown>>) {
        blocks.push({
          name: String(n.name ?? ''),
          type: String(n.type ?? ''),
          size: String(n.size ?? ''),
          fstype: n.fstype ? String(n.fstype) : null,
          mountpoint: n.mountpoint ? String(n.mountpoint) : null,
          model: n.model ? String(n.model) : null,
          tran: n.tran ? String(n.tran) : null,
        });
        if (Array.isArray(n.children)) walk(n.children);
      }
    };
    walk(j.blockdevices ?? []);
    return blocks;
  } catch {
    return [];
  }
}

// 根盘是哪块开机就不会变，缓存起来，别每 10 秒重复跑 findmnt
let _rootDevice: string | null = null;
function rootDevice(): string {
  if (_rootDevice === null) {
    try {
      _rootDevice = execFileSync('findmnt', ['-n', '-o', 'SOURCE', '/'], { encoding: 'utf8', timeout: 3000 }).trim();
    } catch {
      _rootDevice = '';
    }
  }
  return _rootDevice;
}

function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([KMGTPE]?)/i.exec(s.trim());
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6 } as Record<string, number>;
  return Math.round(n * (mult[unit] ?? 1));
}

function freeOf(mountpoint: string): number {
  try {
    const out = execFileSync('df', ['-B1', '--output=avail', mountpoint], { encoding: 'utf8', timeout: 5000 });
    const lines = out.trim().split('\n');
    return Number.parseInt(lines[lines.length - 1]?.trim() ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

/** 判断某块磁盘是不是"外部盘"（排除系统盘 mmcblk0 / vda / 以及根盘） */
function isExternalDisk(b: Block): boolean {
  if (b.type !== 'disk') return false;
  const rootDisk = rootDevice().replace(/[0-9]+$/, ''); // /dev/vda1 -> /dev/vda
  const dev = `/dev/${b.name}`;
  if (dev === rootDisk) return false;
  // 明确标记为 usb 的，或 sd[a-z] 且不是根盘（USB/SATA 移动盘）
  if (b.tran === 'usb') return true;
  if (/^sd[a-z]$/.test(b.name) && b.name !== rootDisk.replace(/^\/dev\//, '')) return true;
  return false;
}

/** 系统里所有挂载点（target / source / fstype） */
function listMounts(): { target: string; source: string; fstype: string | null }[] {
  try {
    const out = execFileSync('findmnt', ['-rn', '-o', 'TARGET,SOURCE,FSTYPE'], { encoding: 'utf8', timeout: 5000 });
    const rows: { target: string; source: string; fstype: string | null }[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line.trim()) continue;
      const [target, source, fstype] = line.split(/\s+/);
      if (target && source) rows.push({ target, source, fstype: fstype || null });
    }
    return rows;
  } catch {
    return [];
  }
}

/** 挂载点是不是**真的活着**（能 stat 且能写）。断电/拔盘留下的挂载点 stat 会失败。 */
function isLiveMount(target: string): boolean {
  try {
    fs.statSync(target);
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 同一个分区可能有多个挂载点：只挑一个"活的"用（优先固定点 /mnt/usb）；清理交给 resetUsbMount */
function pickMountTarget(mounts: { target: string; source: string }[], prefer = MOUNT_DIR): { target: string | null; duplicates: boolean; stale: boolean } {
  if (!mounts.length) return { target: null, duplicates: false, stale: false };
  const live = mounts.filter((m) => isLiveMount(m.target));
  const stale = mounts.length - live.length;
  if (!live.length) return { target: null, duplicates: false, stale: stale > 0 };
  const preferred = live.find((m) => m.target === prefer) ?? live[0];
  return { target: preferred.target, duplicates: live.length > 1, stale: stale > 0 };
}

export function getUsbState(): UsbState {
  const blocks = lsblk();
  const disks = blocks.filter(isExternalDisk);
  const diskNames = new Set(disks.map((d) => d.name));
  const parts = blocks.filter((b) => b.type === 'part' && [...diskNames].some((d) => b.name.startsWith(d)));
  const present = disks.length > 0;

  // ⚠️ 同一个分区可能被挂到多个地方（udisks 的 /media/mypi/upo、我们的 /mnt/usb，
  //    拔插后还可能出现 upo1）—— 以 findmnt 的实际挂载为准，挑一个活的、把多余的/失效的清掉。
  const mounts = listMounts();
  for (const p of parts) {
    const src = `/dev/${p.name}`;
    const mine = mounts.filter((m) => m.source === src || m.source.endsWith(`/${p.name}`));
    if (!mine.length) continue;
    const all = mine.map((m) => m.target);
    const pick = pickMountTarget(mine);
    if (!pick.target) {
      // 全是失效挂载（拔盘残留）→ 让巡检"全部推出后重新挂载"
      return {
        present: true,
        mounted: false,
        device: src,
        fstype: p.fstype ?? undefined,
        label: p.model ?? undefined,
        sizeBytes: parseSize(p.size),
        needsReset: true,
        mounts: all,
        lastError: 'U 盘挂载点已失效（可能拔松了），正在全部卸载后重新挂载…',
      };
    }
    return {
      present: true,
      mounted: true,
      device: src,
      mountpoint: pick.target,
      fstype: p.fstype ?? undefined,
      label: p.model ?? p.fstype ?? undefined,
      sizeBytes: parseSize(p.size),
      freeBytes: freeOf(pick.target),
      needsReset: pick.duplicates || pick.stale,
      mounts: all,
    };
  }

  const mountable = parts.find((p) => p.fstype && !p.mountpoint);
  return {
    present,
    mounted: false,
    device: mountable ? `/dev/${mountable.name}` : undefined,
    fstype: mountable?.fstype ?? undefined,
    label: mountable?.model ?? undefined,
    sizeBytes: mountable ? parseSize(mountable.size) : undefined,
    lastError: present && !mountable ? '检测到外部盘，但没找到带文件系统的分区（可能是未分区/未格式化的盘）' : undefined,
  };
}

export function autoMount(): UsbState {
  const s = getUsbState();
  if (s.mounted) return s;
  if (!s.device || !s.fstype) return s;
  try {
    fs.mkdirSync(MOUNT_DIR, { recursive: true });
    execFileSync('mount', [s.device, MOUNT_DIR], { timeout: 15000 });
    logger.child('usb').mark('USB', `已自动挂载外部盘 ${s.device} → ${MOUNT_DIR}`);
    return getUsbState();
  } catch (e) {
    const msg = (e as Error).message;
    return { ...s, lastError: `自动挂载失败：${msg}` };
  }
}

/**
 * 把 U 盘的**所有挂载点**（upo、upo1、/mnt/usb…）全部卸载，再干净地重新挂到固定点 /mnt/usb。
 * 用户要求：出现 upo/upo1 同时存在时，先都"推出"，再重新挂载。
 */
export function resetUsbMount(): UsbState {
  const blocks = lsblk();
  const disks = blocks.filter(isExternalDisk);
  const names = new Set(disks.map((d) => d.name));
  const parts = blocks.filter((b) => b.type === 'part' && [...names].some((n) => b.name.startsWith(n)));
  const mounts = listMounts();
  const targets = new Set<string>();
  for (const p of parts) {
    const src = `/dev/${p.name}`;
    for (const m of mounts) if (m.source === src || m.source.endsWith(`/${p.name}`)) targets.add(m.target);
  }
  if (targets.size > 0) {
    for (const t of targets) {
      try {
        execFileSync('umount', ['-l', t], { timeout: 10000 });
      } catch {
        /* 忙/已卸载都继续 */
      }
    }
    logger.child('usb').mark('USB', `已把 U 盘的全部挂载点推出：${[...targets].join('、')}（准备重新挂载）`);
  }
  const part = parts.find((p) => p.fstype);
  if (!part) return getUsbState();
  try {
    fs.mkdirSync(MOUNT_DIR, { recursive: true });
    execFileSync('mount', [`/dev/${part.name}`, MOUNT_DIR], { timeout: 20000 });
    logger.child('usb').mark('USB', `已重新挂载 /dev/${part.name} → ${MOUNT_DIR}`);
  } catch (e) {
    logger.child('usb').warn(`重新挂载失败：${(e as Error).message}`);
  }
  return getUsbState();
}

let lastEjectedDevice: string | null = null;

export function ejectUsb(): UsbState {
  const s = getUsbState();
  if (!s.mounted) return s;
  const mp = s.mountpoint ?? MOUNT_DIR;
  try {
    execFileSync('sync', { timeout: 30000 });
    // ⚠️ 用**实际挂载点**卸载：U 盘可能被系统 udisks2 自动挂到 /media/xxx，而不是 /mnt/usb
    execFileSync('umount', [mp], { timeout: 30000 });
    lastEjectedDevice = s.device ?? null; // 记住刚弹出的盘：后台巡检别再把它自动挂回去
    logger.child('usb').mark('USB', `已弹出外部盘 ${s.device}（${mp}）`);
  } catch (e) {
    return { ...s, lastError: `弹出失败（可能有进程还在占用）：${(e as Error).message}` };
  }
  return getUsbState();
}


/**
 * 限速用的 Transform：每块数据按"传输耗时"延迟一下，
 * 把整体速度压到 rateBytesPerSec（0=不限速），别把 SD/USB 总线打满。
 */
class ThrottleStream extends Transform {
  constructor(private readonly rateBytesPerSec: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.rateBytesPerSec <= 0) {
      this.push(chunk);
      cb();
      return;
    }
    const delayMs = Math.max(0, (chunk.length / this.rateBytesPerSec) * 1000);
    setTimeout(() => {
      this.push(chunk);
      cb();
    }, delayMs);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 原子拷贝（**异步、全速**，不阻塞事件循环）：
 * `.part` → fsync → rename。带**卡死看门狗**：如果长时间没有任何进度
 *（U 盘拔松/失效挂载导致写阻塞），直接中止并抛错，交给上层重置挂载。
 */
async function copyFileAtomic(
  from: string,
  to: string,
  onProgress?: (copiedTotal: number) => void,
  totalBytes = 0,
): Promise<void> {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.part`;
  const rate = Math.max(0, Number(config.usbCopyRateMbps) || 0) * 1024 * 1024;
  const stallMs = Math.max(10_000, Number(process.env.USB_COPY_STALL_SEC ?? 90) * 1000);
  let lastProgressAt = Date.now();
  let copied = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      copied += chunk.length;
      lastProgressAt = Date.now();
      onProgress?.(copied);
      this.push(chunk);
      cb();
    },
  });
  const rs = fs.createReadStream(from, { highWaterMark: 256 * 1024 });
  const ws = fs.createWriteStream(tmp);
  // 看门狗：长时间没进度 → 中止（防止"一直拷贝中"卡死）
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > stallMs) {
      rs.destroy(new Error(`拷贝卡住超过 ${Math.round(stallMs / 1000)} 秒（U 盘可能拔松/失效挂载）`));
      ws.destroy(new Error('拷贝卡住'));
    }
  }, 5000);
  try {
    await pipeline(rs, new ThrottleStream(rate), progress, ws);
    const fh = await fs.promises.open(tmp, 'r+');
    try {
      await fh.sync(); // 数据真正落盘，否则拔盘会丢尾巴
    } finally {
      await fh.close();
    }
    fs.renameSync(tmp, to); // 原子改名：要么没有，要么完整
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 设备可能已拔 */
    }
    throw e;
  } finally {
    clearInterval(watchdog);
    void totalBytes;
  }
}

/** 目标目录到底能不能写：写一个 4KB 探针（带超时）。失效挂载/只读盘会在这里暴露。 */
async function probeWritable(dir: string, timeoutMs = 8000): Promise<boolean> {
  const probe = path.join(dir, '.ttdl-probe');
  const write = (async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.unlink(probe).catch(() => undefined);
  })();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const ok = await Promise.race([write.then(() => true).catch(() => false), timeout]);
    return ok;
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/* ------------------------------------------------------------------ */
/*  成品 → U 盘：逐个文件拷贝 + 状态 + 断电恢复                          */
/* ------------------------------------------------------------------ */

export type UsbCopyState = 'copying' | 'failed';
/** 正在/刚刚拷贝的文件状态（含进度）：fileId → copying / failed */
const copyJobs = new Map<number, { state: UsbCopyState; error?: string; copiedBytes: number; totalBytes: number }>();

/** 单个文件当前的拷贝状态（给文件清单显示） */
export function usbCopyStatus(fileId: number): UsbCopyState | null {
  return copyJobs.get(fileId)?.state ?? null;
}

/** 拷贝失败的详情（诊断用） */
export function usbCopyError(fileId: number): string | null {
  return copyJobs.get(fileId)?.error ?? null;
}

/** 拷贝进度（给文件清单显示"3.5G 里拷了多少"） */
export function usbCopyProgress(fileId: number): { copiedBytes: number; totalBytes: number } | null {
  const j = copyJobs.get(fileId);
  return j ? { copiedBytes: j.copiedBytes, totalBytes: j.totalBytes } : null;
}

/**
 * 把 SD 上还没搬到 U 盘的成品**逐个**搬过去：
 *   copyFileAtomic（`.part` → fsync → rename）→ **先更新数据库指向 U 盘** → 再删源文件。
 *
 * 断电安全性（用户要求验证的）：
 *   · 拷贝中途断电 → U 盘上只留 `xxx.part`（不会被当成成品；源文件完好），下次开机清掉 .part 重搬；
 *   · rename 完成但还没写库 → 下次巡检 `reconcileUsbCopies()` 会"认领"U 盘上那个完整文件；
 *   · 写库完成但还没删源 → 两边都有，记录已是 on_usb=1，下次不会重复搬（残留源文件由垃圾扫描报告）。
 *   · 任何一步失败 **都不删源文件**，下次巡检自动重试。
 */
let copyRunning = false;

export async function offloadToDir(destDir: string, srcDir = config.dirs.consumer): Promise<{ moved: number; bytes: number }> {
  // 防重入：拷几 GB 时可能跨好几个 10 秒巡检，不能让两轮同时拷同一个文件
  if (copyRunning) return { moved: 0, bytes: 0 };
  copyRunning = true;
  try {
    return await offloadLoop(destDir);
  } finally {
    copyRunning = false;
  }
}

let nextRetryAt = 0;
let lastProbeAt = 0;
let probeOk = false;

async function offloadLoop(destDir: string): Promise<{ moved: number; bytes: number }> {
  // 失败后冷却一会儿再试，避免"失败→立刻重拷→又失败"的死循环刷屏
  if (Date.now() < nextRetryAt) return { moved: 0, bytes: 0 };
  // 拷贝前先探一下目标目录可不可写（失效挂载/只读盘/空间不足会在这里暴露）
  if (Date.now() - lastProbeAt > 30_000) {
    lastProbeAt = Date.now();
    probeOk = await probeWritable(destDir);
    if (!probeOk) {
      logger.child('usb').warn(`目标目录不可写（${destDir}），先重置挂载再试`);
      resetUsbMount();
      lastProbeAt = 0;
      nextRetryAt = Date.now() + 30_000;
      return { moved: 0, bytes: 0 };
    }
  }
  let moved = 0;
  let bytes = 0;
  let rows: ReturnType<typeof filesRepo.list>['rows'];
  try {
    rows = filesRepo.list({ pageSize: 1000 }).rows;
  } catch {
    return { moved: 0, bytes: 0 };
  }
  for (const row of rows) {
    if (row.on_usb) continue;
    if (!fs.existsSync(row.path)) continue; // 源不在 → 可能已搬到 U 盘，交给 reconcile 认领
    const to = path.join(destDir, path.basename(row.path));
    let totalBytes = 0;
    try {
      totalBytes = fs.statSync(row.path).size;
    } catch {
      totalBytes = 0;
    }
    // 空间不够就别硬拷（会写坏 .part 或失败重试）
    try {
      const free = freeOf(destDir);
      if (totalBytes > 0 && free > 0 && free < totalBytes + 64 * 1024 * 1024) {
        copyJobs.set(row.id, {
          state: 'failed',
          error: `U 盘空间不足：需要 ${(totalBytes / 1024 ** 3).toFixed(2)} GiB，剩余 ${(free / 1024 ** 3).toFixed(2)} GiB`,
          copiedBytes: 0,
          totalBytes,
        });
        nextRetryAt = Date.now() + 60_000;
        logger.child('usb').warn(`U 盘空间不足，暂停拷贝（源文件保留）：需要 ${(totalBytes / 1024 ** 3).toFixed(2)} GiB`);
        return { moved, bytes };
      }
    } catch {
      /* df 失败就继续试 */
    }
    copyJobs.set(row.id, { state: 'copying', copiedBytes: 0, totalBytes });
    try {
      await copyFileAtomic(
        row.path,
        to,
        (copied) => {
          const j = copyJobs.get(row.id);
          if (j) j.copiedBytes = copied;
        },
        totalBytes,
      );
      const st = fs.statSync(row.path);
      filesRepo.markOnUsb(row.id, to);       // ⚠️ 先写库（指向 U 盘），再删源
      copyJobs.delete(row.id);
      try {
        fs.unlinkSync(row.path);
      } catch {
        /* 源删不掉不影响：记录已在 U 盘，下次不会重复搬 */
      }
      moved += 1;
      bytes += st.size;
      await sleep(Math.max(0, Number(config.usbCopyPauseMs) || 0));
    } catch (e) {
      const msg = (e as Error).message;
      copyJobs.set(row.id, { state: 'failed', error: msg, copiedBytes: 0, totalBytes });
      logger.child('usb').warn(`拷贝到 U 盘失败（源文件保留）：${path.basename(row.path)}：${msg}`);
      // 失败 → 把 U 盘全部推出再重新挂载（用户要求），并冷却 60 秒，别死循环
      resetUsbMount();
      lastProbeAt = 0;
      nextRetryAt = Date.now() + 60_000;
      return { moved, bytes };
    }
  }
  if (moved > 0) {
    logger.child('usb').mark('USB', `已拷贝 ${moved} 个成品到 U 盘（${(bytes / 1024 / 1024).toFixed(1)}MB）`, { moved, bytes });
  }
  return { moved, bytes };
}

/**
 * 断电恢复：文件已经完整落在 U 盘、但数据库还指着 SD（源被删掉了）→ 认领 U 盘上那个文件。
 * 返回认领的数量。
 */
export function reconcileUsbCopies(destDir: string): number {
  let fixed = 0;
  let rows: ReturnType<typeof filesRepo.list>['rows'];
  try {
    rows = filesRepo.list({ pageSize: 1000 }).rows;
  } catch {
    return 0;
  }
  for (const row of rows) {
    if (row.on_usb) continue;
    if (fs.existsSync(row.path)) continue; // 源还在 → 正常流程会搬
    const candidate = path.join(destDir, path.basename(row.path));
    try {
      if (!fs.statSync(candidate).isFile() || fs.statSync(candidate).size <= 0) continue;
    } catch {
      continue;
    }
    filesRepo.markOnUsb(row.id, candidate);
    fixed += 1;
  }
  if (fixed > 0) logger.child('usb').mark('USB', `断电恢复：认领 U 盘上已完整的成品 ${fixed} 个`);
  return fixed;
}

/** 断电恢复：清掉 U 盘上没写完的 `.part`（有 .part 说明那次拷贝没完成，源文件一定还在） */
export function cleanupPartials(destDir: string): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(destDir)) {
      if (!name.endsWith('.part')) continue;
      try {
        fs.unlinkSync(path.join(destDir, name));
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在等 */
  }
  if (removed > 0) logger.child('usb').mark('USB', `清理 U 盘上未完成的临时文件 ${removed} 个`);
  return removed;
}

/** U 盘挂载时：把 SD 上的旧成品补搬到 U 盘 */
export async function offloadArchivedToUsb(): Promise<{ moved: number; bytes: number }> {
  const wd = workDirs();
  if (!wd.onUsb) return { moved: 0, bytes: 0 };
  if (path.resolve(wd.consumer) === path.resolve(config.dirs.consumer)) return { moved: 0, bytes: 0 };
  return offloadToDir(wd.consumer);
}

let cached: UsbState = getUsbState();
let timer: NodeJS.Timeout | null = null;

export function getCachedUsbState(): UsbState {
  return cached;
}

/** 每 10 秒巡检：自动挂载 + 剪切归档资源 + 刷新状态（供前端轮询显示） */
export function startUsbWorker(): void {
  if (timer) return;
  const tick = () => {
    try {
      const s = getUsbState();
      // 盘被拔掉 → 清除"刚弹出"的记忆，并把 /mnt/usb 上的失效挂载清掉（否则下次插会变 upo1）
      if (!s.present) {
        lastEjectedDevice = null;
        try {
          const stillMounted = listMounts().some((m) => m.target === MOUNT_DIR);
          if (stillMounted) {
            execFileSync('umount', ['-l', MOUNT_DIR], { timeout: 5000 });
            logger.child('usb').mark('USB', `U 盘已拔出，清理失效挂载点 ${MOUNT_DIR}`);
          }
        } catch {
          /* ignore */
        }
      }
      const prevMounted = cached.mounted;
      if (!s.mounted && s.device && s.device === lastEjectedDevice) {
        // 用户刚手动弹出的盘：巡检**不要**又自动挂回去
        cached = s;
      } else {
        cached = autoMount();
      }
      // 重复挂载 / 失效挂载（upo 与 upo1 同时存在）→ 全部推出后重新挂到 /mnt/usb
      if (cached.needsReset) {
        logger.child('usb').mark('USB', `检测到 U 盘挂载异常（挂载点：${(cached.mounts ?? []).join('、') || '?'}），全部推出后重新挂载`);
        cached = resetUsbMount();
      }
      if (cached.mounted) {
        if (!prevMounted) logger.child('usb').mark('USB', `检测到外部盘并挂载：${cached.device}（${cached.label ?? ''}）`);
        const wd = workDirs();
        if (wd.onUsb) {
          // 断电恢复顺序：先清没写完的 .part → 认领"已完整但没写库"的 → 再补搬剩下的
          cleanupPartials(wd.consumer);
          reconcileUsbCopies(wd.consumer);
        }
        void offloadArchivedToUsb().catch((e) => logger.child('usb').warn(`补搬成品到 U 盘失败：${(e as Error).message}`));
      }
    } catch (e) {
      logger.child('usb').warn(`USB 巡检异常：${(e as Error).message}`);
    }
  };
  tick();
  timer = setInterval(tick, 10_000);
}

export function stopUsbWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
