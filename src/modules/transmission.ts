import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger, taskLog } from '../core/logger';
import { runCommand } from '../services/archive';
import { getSettings } from '../services/settings';
import { selectBtFiles, buildPublishUnits, DEFAULT_BT_BLOCK_KEYWORDS } from '../services/btSelect';
import { seedsRepo, tasksRepo } from '../core/db';
import { cleanupBtTaskDirs } from '../services/btCleanup';
import type { SeedItem } from '../types';
import type { ModuleAdapter, PollResult, TaskWithPayload } from './types';

/* ------------------------------------------------------------------ */
/* Transmission RPC 客户端（带 409 session-id 自动重试）                */
/* ------------------------------------------------------------------ */

export class TransmissionClient {
  private sessionId = '';

  constructor(
    private readonly host = config.transmissionRpc.host,
    private readonly port = config.transmissionRpc.port,
    private readonly user = config.transmissionRpc.user,
    private readonly password = config.transmissionRpc.password,
  ) {}

  get url(): string {
    return `http://${this.host}:${this.port}/transmission/rpc`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.sessionId) h['X-Transmission-Session-Id'] = this.sessionId;
    if (this.user || this.password) {
      h.Authorization = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
    }
    return h;
  }

  async call<T = Record<string, unknown>>(method: string, args: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    const body = JSON.stringify({ method, arguments: args });
    const startedAt = Date.now();
    const scoped = logger.child('transmission');
    scoped.debug(`[MARK:TR_RPC] -> ${method}`, { args, hasAuth: !!(this.user || this.password) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body, signal: ac.signal });
        if (res.status === 409) {
          this.sessionId = res.headers.get('x-transmission-session-id') ?? '';
          scoped.debug(`[MARK:TR_RPC] 409 会话协商，拿到 session-id=${this.sessionId ? '是' : '否'}（第 ${attempt + 1} 次）`);
          continue;
        }
        const text = await res.text();
        let json: { result?: string; arguments?: T };
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`transmission 响应无法解析: ${text.slice(0, 160)}`);
        }
        if (json.result !== 'success') {
          scoped.warn(`[MARK:TR_RPC] <- ${method} 失败 result=${json.result} http=${res.status}（${Date.now() - startedAt}ms）`, {
            body: text.slice(0, 400),
            authConfigured: !!(this.user || this.password),
          });
          throw new Error(`transmission 错误: ${json.result}`);
        }
        scoped.debug(`[MARK:TR_RPC] <- ${method} ok（${Date.now() - startedAt}ms）`);
        return (json.arguments ?? {}) as T;
      } catch (e) {
        scoped.warn(`[MARK:TR_RPC] <- ${method} 异常（${Date.now() - startedAt}ms）: ${(e as Error).message}`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    scoped.error('[MARK:TR_RPC] transmission 会话协商失败（409 重试后仍失败）：检查 RPC 用户名/密码与 rpc-whitelist');
    throw new Error('transmission 会话协商失败（409）');
  }

  async ping(): Promise<boolean> {
    try {
      const s = await this.call<{ version?: string }>('session-get', {}, 4000);
      return !!s;
    } catch {
      return false;
    }
  }
}

export function transmissionClient(): TransmissionClient {
  return new TransmissionClient();
}

/* ------------------------------------------------------------------ */
/* 生产者：解压 zip -> 种子入库                                        */
/* ------------------------------------------------------------------ */

const VIDEO_IMAGE_EXT = new Set([...config.videoExts, ...config.imageExts]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export async function scanZipUploads(): Promise<number> {
  fs.mkdirSync(config.dirs.btZip, { recursive: true });
  fs.mkdirSync(config.dirs.btPending, { recursive: true });
  let extracted = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(config.dirs.btZip);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!/\.zip$/i.test(name) || name.startsWith('.')) continue;
    const zipPath = path.join(config.dirs.btZip, name);
    const tmpDir = fs.mkdtempSync(path.join(config.dirs.btPending, '.unzip_'));
    const res = await runCommand(config.bins.unzip, ['-o', '-q', '-j', zipPath, '-d', tmpDir]);
    if (res.code !== 0) {
      logger.child('transmission').error(`[MARK:ARCHIVE] 种子 zip 解压失败 ${name}: ${res.stderr || res.stdout}`, { zip: config.bins.unzip });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      continue;
    }
    let moved = 0;
    for (const f of fs.readdirSync(tmpDir)) {
      if (!/\.torrent$/i.test(f)) continue;
      const dest = path.join(config.dirs.btPending, f);
      let target = dest;
      let n = 1;
      while (fs.existsSync(target)) {
        target = path.join(config.dirs.btPending, `${f.replace(/\.torrent$/i, '')}_${n}.torrent`);
        n += 1;
      }
      fs.renameSync(path.join(tmpDir, f), target);
      moved += 1;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    extracted += moved;
    logger.child('transmission').mark('ARCHIVE', `种子 zip 解压完成: ${name} → ${moved} 个种子`, { outputDir: config.dirs.btQueued });
  }
  return extracted;
}

export function registerPendingSeeds(): number {
  fs.mkdirSync(config.dirs.btPending, { recursive: true });
  let added = 0;
  for (const name of fs.readdirSync(config.dirs.btPending)) {
    if (!/\.torrent$/i.test(name) || name.startsWith('.')) continue;
    const p = path.join(config.dirs.btPending, name);
    const before = seedsRepo.all().length;
    seedsRepo.upsertByPath({ name, path: p });
    if (seedsRepo.all().length > before) added += 1;
  }
  return added;
}

/* ------------------------------------------------------------------ */
/* 模块实现                                                            */
/* ------------------------------------------------------------------ */

interface TorrentFile {
  name: string;
  length: number;
  bytesCompleted: number;
}

interface TorrentInfo {
  id: number;
  name: string;
  status: number;
  percentDone: number;
  rateDownload: number;
  eta: number;
  leftUntilDone: number;
  totalSize: number;
  downloadDir: string;
  error: number;
  errorString?: string;
  files?: TorrentFile[];
  wanted?: number[];
  hashString?: string;
}

export const transmissionModule: ModuleAdapter = {
  id: 'transmission',

  async produce(): Promise<void> {
    await scanZipUploads();
    registerPendingSeeds();
  },

  async prepare(task): Promise<void> {
    const seedPath = String((task.payload ?? {}).seedPath ?? '');
    if (!seedPath || !fs.existsSync(seedPath)) throw new Error('种子文件不存在（可能已被移动或删除）');
  },

  async start(task): Promise<void> {
    const client = transmissionClient();
    if (!(await client.ping())) {
      throw new Error('transmission 不可用：请确认已安装并启动 transmission-daemon（sudo apt install -y transmission-daemon && sudo systemctl enable --now transmission-daemon）');
    }
    const payload = task.payload ?? {};
    const seedPath = String(payload.seedPath ?? '');
    const base64 = fs.readFileSync(seedPath).toString('base64');
    const dirName = path.basename(seedPath).replace(/\.torrent$/i, '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80) || `seed_${task.id}`;
    const downloadDir = path.join(config.dirs.btDownload, dirName);
    fs.mkdirSync(downloadDir, { recursive: true });

    const addRes = await client.call<{ 'torrent-added'?: { id: number; name: string; hashString: string }; 'torrent-duplicate'?: { id: number; name: string } }>(
      'torrent-add',
      { metainfo: base64, 'download-dir': downloadDir, paused: true },
    );
    const added = addRes['torrent-added'] ?? addRes['torrent-duplicate'];
    if (!added) throw new Error('添加到 transmission 失败（返回为空）');
    const torrentId = added.id;

    const info = await client.call<{ torrents: TorrentInfo[] }>('torrent-get', {
      ids: [torrentId],
      fields: ['id', 'name', 'files', 'wanted', 'totalSize', 'downloadDir', 'status'],
    });
    const torrent = info.torrents?.[0];
    if (!torrent) throw new Error('无法读取种子信息');
    const files = torrent.files ?? [];
    // 内容甄别：只要核心内容（默认只要视频 + 排掉广告关键词命中的文件）
    const sel = getSettings().btSelect;
    const picked = selectBtFiles(
      files.map((f) => ({ name: f?.name ?? '', length: f?.length ?? 0 })),
      {
        videoExts: config.videoExts,
        imageExts: config.imageExts,
        keepImages: sel.keepImages,
        blockKeywords: (sel.blockKeywords && sel.blockKeywords.length ? sel.blockKeywords : DEFAULT_BT_BLOCK_KEYWORDS),
        minVideoBytes: sel.minVideoBytes,
      },
    );
    const wantedIdx = picked.keep;
    const selectedBytes = picked.keptBytes;
    // 把"留了什么/弃了什么/为什么"写进任务日志 —— 规则到底有没有用，用户一眼能看到
    taskLog(task.id).mark('BT_SELECT',
      `选片结果：保留 ${wantedIdx.length} 个（${(selectedBytes / 1024 / 1024).toFixed(1)}MB），排除 ${picked.dropped.length} 个`,
      { keep: wantedIdx.map((i) => files[i]?.name ?? '').slice(0, 30), dropped: picked.dropped.slice(0, 30), hasVideo: picked.hasVideo });
    for (const d of picked.dropped.slice(0, 20)) {
      taskLog(task.id).info(`排除: ${d.name}（${(d.sizeBytes / 1024 / 1024).toFixed(1)}MB）—— ${d.reason}`);
    }
    if (wantedIdx.length === 0) {
      await client.call('torrent-remove', { ids: [torrentId], 'delete-local-data': true }).catch(() => undefined);
      const hint = picked.dropped.length
        ? `（排除了 ${picked.dropped.length} 个：${picked.dropped.slice(0, 5).map((d) => `${d.name} - ${d.reason}`).join('；')}）`
        : '';
      throw new Error(`该种子内没有可下载的核心内容${hint}`);
    }
    const unwantedIdx = files.map((_, i) => i).filter((i) => !wantedIdx.includes(i));
    if (unwantedIdx.length > 0) {
      await client.call('torrent-set', { ids: [torrentId], 'files-unwanted': unwantedIdx }).catch(() => undefined);
    }
    await client.call('torrent-set', { ids: [torrentId], 'files-wanted': wantedIdx }).catch(() => undefined);
    await client.call('torrent-start', { ids: [torrentId] });

    // 种子文件移入"已下载中"目录留痕
    fs.mkdirSync(config.dirs.btQueued, { recursive: true });
    let dest = path.join(config.dirs.btQueued, path.basename(seedPath));
    let n = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(config.dirs.btQueued, `${path.basename(seedPath, '.torrent')}_${n}.torrent`);
      n += 1;
    }
    try {
      fs.renameSync(seedPath, dest);
    } catch {
      /* 移动失败不影响下载 */
    }

    const seedId = Number(payload.seedId ?? 0);
    if (seedId) {
      seedsRepo.update(seedId, { status: 'downloading', sizeBytes: selectedBytes, fileCount: wantedIdx.length, taskId: task.id });
    }
    tasksRepo.update(task.id, {
      status: 'downloading',
      expectBytes: selectedBytes,
      startedAt: new Date().toISOString(),
      title: task.title || torrent.name || added.name,
      payload: {
        ...payload,
        torrentId,
        downloadDir,
        seedPathMoved: dest,
        selectedBytes,
        // 出清机制：累计“实际下载尝试时长”，初始 0（满 10 小时才参与出清判断）
        btActiveMs: Number(payload.btActiveMs ?? 0) || 0,
        btLastCheckAt: null,
      },
      meta: { ...(task.meta ?? {}), files: wantedIdx.map((i) => files[i]?.name ?? '') },
    });
    logger.child('transmission').mark('TASK_STATE', `BT 任务已启动 #${task.id}`, {
      torrentId,
      selectedFiles: wantedIdx.length,
      selectedBytes,
      downloadDir: config.dirs.btDownload,
      incompleteDir: config.transmissionIncompleteDir,
    });
  },

  async poll(task): Promise<PollResult> {
    const payload = task.payload ?? {};
    const torrentId = Number(payload.torrentId ?? 0);
    if (!torrentId) return { error: '缺少 transmission 任务 id（需重试）' };
    const client = transmissionClient();
    let torrent: TorrentInfo | undefined;
    try {
      const info = await client.call<{ torrents: TorrentInfo[] }>('torrent-get', {
        ids: [torrentId],
        fields: ['id', 'name', 'status', 'percentDone', 'rateDownload', 'eta', 'leftUntilDone', 'totalSize', 'downloadDir', 'error', 'errorString', 'files', 'wanted'],
      });
      torrent = info.torrents?.[0];
    } catch (e) {
      return { error: `transmission 查询失败: ${(e as Error).message}` };
    }
    if (!torrent) return { error: 'transmission 中找不到该任务（可能被外部删除）' };
    if (torrent.error && torrent.error !== 0) {
      return { error: `BT 下载失败：${torrent.errorString || `错误码 ${torrent.error}`}` };
    }
    const progress = Math.min(100, (torrent.percentDone ?? 0) * 100);
    const speed = torrent.rateDownload ?? 0;
    const eta = torrent.eta && torrent.eta > 0 ? torrent.eta : null;

    const finished = (torrent.leftUntilDone ?? 1) === 0 && (torrent.percentDone ?? 0) >= 1;
    if (finished) {
      const wanted = torrent.wanted ?? [];
      const files = (torrent.files ?? []).filter((_, i) => wanted.length === 0 || wanted[i] !== 0);
      const paths = files
        .filter((f) => VIDEO_IMAGE_EXT.has(extOf(f.name)))
        .map((f) => path.join(torrent?.downloadDir ?? config.dirs.btDownload, f.name))
        .filter((p) => fs.existsSync(p));
      if (paths.length === 0) return { error: 'BT 下载完成但找不到任何文件' };

      // 只把 transmission 里的任务摘掉（保留文件），文件交给归档流水线搬走。
      // ⚠️ 以前这里 setTimeout(5s) 就 rm -rf 整个下载目录 —— 而流水线这时可能还在 zip
      //    大文件（要好几分钟），会把还在用的源文件删掉。现在改成：**发布完成之后**由
      //    流水线清理，且清理会先确认没有别的任务共用目录、只删本任务自己的文件。
      await client.call('torrent-remove', { ids: [torrentId], 'delete-local-data': false }).catch(() => undefined);

      const seedId = Number(payload.seedId ?? 0);
      if (seedId) seedsRepo.update(seedId, { status: 'done' });
      const originalName = `${torrent.name || task.title || `task_${task.id}`}`;
      const sizeBytes = paths.reduce((sum, p) => sum + fs.statSync(p).size, 0);

      // 分包：单个大视频各自一个成品（单文件走"移动"，不打包）；其余小文件合成一个 zip
      const sel = getSettings().btSelect;
      const sizeOf = (pp: string): number => {
        try {
          return fs.statSync(pp).size;
        } catch {
          return 0;
        }
      };
      const units = buildPublishUnits(paths, sel.publishIndividuallyMinBytes, sizeOf, (pp) => path.basename(pp).replace(/\.[^.]+$/, ''), originalName);
      taskLog(task.id).mark('BT_UNITS',
        `按 ${(sel.publishIndividuallyMinBytes / 1024 / 1024).toFixed(0)}MB 阈值拆成 ${units.length} 个成品：` +
        units.map((u) => `${u.name}(${u.files.length}个文件)`).join('、'),
        { units: units.map((u) => ({ name: u.name, files: u.files.length })) });

      return {
        progress: 100, speedBps: 0, totalBytes: sizeBytes, downloadedBytes: sizeBytes, etaSec: 0,
        done: { files: paths, originalName, sizeBytes, units, torrentName: torrent.name || originalName, cleanupBtDirs: true },
      };
    }

    return { progress, speedBps: speed, etaSec: eta, totalBytes: torrent.totalSize ?? 0, downloadedBytes: Math.round(((torrent.percentDone ?? 0) * (torrent.totalSize ?? 0))) };
  },

  async pause(task): Promise<void> {
    const torrentId = Number((task.payload ?? {}).torrentId ?? 0);
    if (torrentId) await transmissionClient().call('torrent-stop', { ids: [torrentId] }).catch(() => undefined);
  },

  async resume(task): Promise<void> {
    const torrentId = Number((task.payload ?? {}).torrentId ?? 0);
    if (torrentId) await transmissionClient().call('torrent-start', { ids: [torrentId] }).catch(() => undefined);
  },

  async cancel(task): Promise<void> {
    const torrentId = Number((task.payload ?? {}).torrentId ?? 0);
    const client = transmissionClient();
    // 先取种子名（用于定位 transmission incomplete 目录下的文件夹）
    let name = task.title || `task_${task.id}`;
    if (torrentId) {
      try {
        const info = await client.call<{ torrents: { name?: string }[] }>('torrent-get', { ids: [torrentId], fields: ['name'] });
        name = info.torrents?.[0]?.name || name;
      } catch {
        /* 取不到就用标题兜底 */
      }
      await client.call('torrent-remove', { ids: [torrentId], 'delete-local-data': true }).catch(() => undefined);
    }
    // 清理我们自己的下载目录 + transmission incomplete 目录（释放空间会自动广播 space-freed）
    cleanupBtTaskDirs(task, name, 'bt-cancel');
    const seedId = Number((task.payload ?? {}).seedId ?? 0);
    if (seedId) seedsRepo.update(seedId, { status: 'failed', error: '任务被取消' });
  },
};

/** 入队一个种子：创建统一队列任务 */
export function enqueueSeed(seed: SeedItem, priority = 0): import('../types').Task {
  const existing = tasksRepo
    .list({ modules: ['transmission'], statuses: ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'], pageSize: 200 })
    .items.find((t) => Number((t as TaskWithPayload).payload?.seedId ?? 0) === seed.id);
  if (existing) return existing;
  const task = tasksRepo.create({
    module: 'transmission',
    title: seed.name.replace(/\.torrent$/i, ''),
    platform: 'BT',
    url: null,
    status: 'waiting',
    priority,
    expectBytes: seed.sizeBytes || 0,
    payload: { seedId: seed.id, seedPath: seed.path },
    meta: { files: [] },
  });
  seedsRepo.update(seed.id, { status: 'queued', taskId: task.id });
  return task;
}
