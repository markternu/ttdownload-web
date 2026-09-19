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
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { getSettings } from './settings';

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

export function getUsbState(): UsbState {
  const blocks = lsblk();
  const disks = blocks.filter(isExternalDisk);
  const diskNames = new Set(disks.map((d) => d.name));
  const parts = blocks.filter((b) => b.type === 'part' && [...diskNames].some((d) => b.name.startsWith(d)));
  const present = disks.length > 0;

  const mounted = parts.find((p) => p.mountpoint);
  if (mounted) {
    return {
      present: true,
      mounted: true,
      device: `/dev/${mounted.name}`,
      mountpoint: mounted.mountpoint ?? undefined,
      fstype: mounted.fstype ?? undefined,
      label: mounted.model ?? mounted.fstype ?? undefined,
      sizeBytes: parseSize(mounted.size),
      freeBytes: freeOf(mounted.mountpoint as string),
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
 * 原子写文件：先写 `.part` 临时名 → fsync 落盘 → rename 成最终名。
 * 这样中途拔盘 / 停电最多留下一个带 `.part` 标记的临时文件，
 * 绝不会出现"名字正常、内容却只写了一半"的损坏成品。失败时清理临时文件并抛错。
 */
function copyFileAtomic(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.part`;
  const rfd = fs.openSync(from, 'r');
  let wfd: number | null = null;
  try {
    wfd = fs.openSync(tmp, 'w');
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(rfd, buf, 0, buf.length, null)) > 0) {
      fs.writeSync(wfd, buf, 0, n);
    }
    fs.fsyncSync(wfd); // 数据落盘（U 盘缓存冲进设备），否则拔盘会丢尾巴
    fs.closeSync(wfd);
    wfd = null;
    fs.renameSync(tmp, to); // 同一文件系统内原子改名：要么旧文件、要么完整新文件
  } catch (e) {
    if (wfd !== null) {
      try { fs.closeSync(wfd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* 设备可能已拔，删不掉就算了 */ }
    throw e;
  } finally {
    fs.closeSync(rfd);
  }
}

/** 递归剪切（跨文件系统用 copy + rm，不能用 rename——EXDEV） */
function moveAcross(from: string, to: string): void {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) moveAcross(path.join(from, name), path.join(to, name));
    fs.rmdirSync(from);
  } else {
    copyFileAtomic(from, to);
    // ⚠️ 只在「完整文件原子落盘成功」之后才删源 —— 中途拔盘/停电源文件永远完好
    fs.unlinkSync(from);
  }
}

/** 把归档好的成品（consumer 目录）剪切到外部盘根目录的 ttdownload/ */
export function offloadArchivedToUsb(): { moved: number; bytes: number } {
  // U 盘挂载时，成品目录已经直接落在 U 盘（workDirs().consumer），新成品不再"二次剪切"。
  // 这里只做一件事：把 U 盘插入**之前**留在 SD 上的旧成品补搬到 U 盘。
  const wd = workDirs();
  if (!wd.onUsb) return { moved: 0, bytes: 0 };
  const src = config.dirs.consumer;
  const dest = wd.consumer;
  if (src === dest || !fs.existsSync(src)) return { moved: 0, bytes: 0 };
  fs.mkdirSync(dest, { recursive: true });
  let moved = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(src)) {
      if (name.startsWith('.')) continue;
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const st = fs.statSync(from);
      moveAcross(from, to);
      moved += 1;
      bytes += st.isDirectory() ? 0 : st.size;
    }
    if (moved > 0) {
      logger.child('usb').mark('USB', `SD 上已有的成品已补搬到外部盘：${moved} 项 / ${(bytes / 1024 / 1024).toFixed(1)}MB → ${dest}`, { moved, bytes });
    }
  } catch (e) {
    logger.child('usb').warn(`补搬成品到外部盘失败：${(e as Error).message}`);
  }
  return { moved, bytes };
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
      // 盘被拔掉 → 清除"刚弹出"的记忆，下次插入才允许再自动挂载
      if (!s.present) lastEjectedDevice = null;
      const prevMounted = cached.mounted;
      if (!s.mounted && s.device && s.device === lastEjectedDevice) {
        // 用户刚手动弹出的盘：巡检**不要**又自动挂回去
        cached = s;
      } else {
        cached = autoMount();
      }
      if (cached.mounted) {
        if (!prevMounted) logger.child('usb').mark('USB', `检测到外部盘并挂载：${cached.device}（${cached.label ?? ''}）`);
        offloadArchivedToUsb();
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
