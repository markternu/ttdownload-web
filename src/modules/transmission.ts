import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger, taskLog } from '../core/logger';
import { runCommand } from '../services/archive';
import { getSettings } from '../services/settings';
import { createPublishTask } from '../services/pipeline';
import { selectBtFiles, pickDominantVideos } from '../services/btSelect';
import { anonFile, hideName, hidePath, hideText } from '../services/btAnon';
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
    // ⚠️ 绝不打印原始 args：torrent-add 的 metainfo 是整颗种子的 base64，
    //    里面就含种子名和所有文件名（用户要求日志里不能出现这些）。
    const safeArgs: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    if ('metainfo' in safeArgs) safeArgs.metainfo = '（已隐藏：种子元数据）';
    scoped.debug(`[MARK:TR_RPC] -> ${method}`, { args: safeArgs, hasAuth: !!(this.user || this.password) });
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
      logger.child('transmission').error(`[MARK:ARCHIVE] 种子 zip 解压失败 ${hideName(name)}: ${res.stderr || res.stdout}`, { zip: config.bins.unzip });
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
    logger.child('transmission').mark('ARCHIVE', `种子 zip 解压完成: ${moved} 个种子`, { outputDir: config.dirs.btQueued });
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

  /**
   * 准备阶段：**必须在真正开始下载之前**把"这个种子要占多大"算出来。
   *
   * 为什么重要（真事故）：以前这里是空壳，加种子/选片/算大小全在 start() 里，
   * 于是调度器做空间准入时 BT 任务的 expectBytes 还是 0 —— "需要 0 字节"当然永远放行，
   * 结果十来个种子同时下起来把磁盘撑爆（越过了预留），随后触发"空间不足就全暂停"，
   * 而暂停的种子永远下不完、永远腾不出空间 → 全卡死、一个都没完成。
   *
   * 现在：加种子时就 `paused: true`（一个字节都不下），选好片、算出 selectedBytes，
   * 交给调度器复查空间；装不下就回等待队列（种子在 transmission 里保持暂停），
   * 排到它时 start() 只需要 torrent-start。幂等：重复调用不会加出第二个种子。
   */
  /**
   * 准备：把种子**以暂停状态**加给 transmission，只勾选视频文件，算出视频总大小用于排队。
   *
   * 三条铁律（都是真机踩出来的）：
   *  ① **绝不覆盖 download-dir / incomplete-dir**。transmission 以 debian-transmission 运行，
   *     它自己的两个目录（/var/lib/transmission/downloads 与 /var/lib/transmission/incomplete）
   *     它有写权限；我们以前把它改成 /ttdownload/...（root 所有），结果它下完从 incomplete
   *     搬过来时 "Permission denied (13)"，每个种子都失败、文件永远进不了 downloads。
   *  ② 只勾选视频（大小写不敏感的扩展名白名单），别的文件标 unwanted —— 不下广告图和垃圾。
   *  ③ 不做任何"广告识别"之类的猜测（用户明确否掉了：会把正片误杀）。
   */
  async prepare(task): Promise<void> {
    const payload = task.payload ?? {};

    const client = transmissionClient();
    if (!(await client.ping())) {
      throw new Error('transmission 不可用：请确认已安装并启动 transmission-daemon');
    }

    // 已经加过（空间不够被退回等待 / 服务重启重新排队）→ 复用，保持暂停。
    // 这条必须放在"检查种子文件存在"之前：prepare 成功后 .torrent 就被删掉了，
    // 再查原路径会误判"种子不存在"而永久失败（空间不够被退回等待的种子一重试就废）。
    const existingId = Number(payload.torrentId ?? 0);
    if (existingId) {
      await client.call('torrent-stop', { ids: [existingId] }).catch(() => undefined);
      await syncBtVideoSelection(task, existingId);
      return;
    }

    const seedPath = String(payload.seedPath ?? '');
    if (!seedPath || !fs.existsSync(seedPath)) throw new Error('种子文件不存在（可能已被移动或删除）');

    const base64 = fs.readFileSync(seedPath).toString('base64');
    const addRes = await client.call<{
      'torrent-added'?: { id: number; name: string; hashString: string };
      'torrent-duplicate'?: { id: number; name: string; hashString?: string };
    }>('torrent-add', { metainfo: base64, paused: true });
    const added = addRes['torrent-added'] ?? addRes['torrent-duplicate'];
    if (!added) throw new Error('transmission 未返回任务 id（种子可能无效）');
    const torrentId = added.id;

    // 先把 id 落库再选片：万一选片抛错（整个种子没有视频），cancel 也能把它清掉
    tasksRepo.update(task.id, { payload: { ...payload, torrentId, btHash: added.hashString ?? '' } });

    const selectedBytes = await syncBtVideoSelection(task, torrentId);

    // 种子已经被 transmission 成功接管（拿到了任务 id、也读到了文件列表）→
    // **把这个 .torrent 文件删掉**：transmission 自己已经保存了元数据，
    // 留着只是占地方（用户明确要求）。注意是"确认接管成功之后"才删 ——
    // 上面 syncBtVideoSelection 抛错时不会走到这里，种子会留着方便重试。
    if (fs.existsSync(seedPath)) {
      try {
        fs.rmSync(seedPath, { force: true });
        const p2 = (tasksRepo.get(task.id) as TaskWithPayload).payload ?? {};
        tasksRepo.update(task.id, { payload: { ...p2, seedPathDeleted: true } });
        taskLog(task.id).mark('BT_SEED_DELETED',
          `transmission 已接管该种子，已删除种子文件（${hideName(seedPath)}）`, { torrentId });
      } catch (e) {
        logger.child('transmission').warn(`删除种子文件失败（不影响下载）: ${(e as Error).message}`);
      }
    }

    logger.child('transmission').mark('BT_PREPARE',
      `BT 已备好（种子暂停中，等空间准入）#${task.id}：只挑视频 ${(selectedBytes / 1024 ** 2).toFixed(1)}MB`, {
        torrentId,
        hash: added.hashString ?? '',
        selectedBytes,
      });
  },

/** 真正开跑：种子在 prepare 阶段已经加好（暂停）、选好片，这里只放行 */
  async start(task): Promise<void> {
    const payload = task.payload ?? {};
    const torrentId = Number(payload.torrentId ?? 0);
    if (!torrentId) throw new Error('任务未准备（缺 transmission 任务 id）：应先调用 prepare');
    const client = transmissionClient();
    if (!(await client.ping())) {
      throw new Error('transmission 不可用：请确认已安装并启动 transmission-daemon（sudo apt install -y torrent-daemon 或 transmission-daemon）');
    }
    const selectedBytes = Math.max(0, Number(payload.selectedBytes ?? task.expectBytes ?? 0) || 0);
    await client.call('torrent-start', { ids: [torrentId] });
    // 记录"什么时候扔给 transmission 的"：8 小时/4 小时策略从这一刻算起
    const handedAt = String(payload.btHandedAt ?? new Date().toISOString());

    const seedId = Number(payload.seedId ?? 0);
    if (seedId) {
      const meta = (task.meta ?? { files: [] }) as { files?: string[] };
      seedsRepo.update(seedId, { status: 'downloading', sizeBytes: selectedBytes, fileCount: (meta.files ?? []).length, taskId: task.id });
    }
    tasksRepo.update(task.id, {
      status: 'downloading',
      expectBytes: selectedBytes,
      startedAt: new Date().toISOString(),
      payload: {
        ...payload,
        btHandedAt: handedAt,
        btLastProgress: 0,
        btLastCheckAt: null,
      },
    });
    logger.child('transmission').mark('TASK_STATE', `BT 任务已放行开下 #${task.id}`, {
      torrentId,
      selectedBytes,
      downloadDir: hidePath(payload.downloadDir),
    });
  },

  /**
   * 只**读**进度。8 小时窗口内不对 transmission 里的种子做任何操作
   * （不暂停、不删文件、不改勾选）—— 有的资源这会儿没速度，过一小时才上线，
   * 干涉只会把能下完的种子搞坏。到点后的清理由 btPolicy 负责；
   * 下完的货由 btHarvest 扫目录处理。
   */
  async poll(task): Promise<PollResult> {
    const payload = task.payload ?? {};
    const torrentId = Number(payload.torrentId ?? 0);
    if (!torrentId) return { error: '缺少 transmission 任务 id（需重试）' };

    const client = transmissionClient();
    let torrent: TorrentInfo | undefined;
    try {
      const info = await client.call<{ torrents: TorrentInfo[] }>('torrent-get', {
        ids: [torrentId],
        fields: ['id', 'name', 'status', 'percentDone', 'rateDownload', 'eta', 'leftUntilDone', 'totalSize', 'downloadDir', 'error', 'errorString', 'files', 'wanted', 'hashString', 'uploadRatio'],
      });
      torrent = info.torrents?.[0];
    } catch (e) {
      return { error: `transmission 查询失败: ${(e as Error).message}` };
    }
    if (!torrent) return { error: 'transmission 中找不到该任务（可能被外部删除）' };

    const progress = Math.min(100, (torrent.percentDone ?? 0) * 100);
    const speed = torrent.rateDownload ?? 0;
    const eta = torrent.eta && torrent.eta > 0 ? torrent.eta : null;

    // 进度快照留痕（给 8h/4h 判断用，也方便排查"到底卡在多少"）
    if (Math.abs(progress - Number(payload.btLastProgress ?? -1)) >= 1) {
      tasksRepo.update(task.id, { payload: { ...payload, btLastProgress: progress, btLastCheckAt: new Date().toISOString() } });
    }

    // transmission 自己报错时如实转达，但**不**擅自删任务 —— 交给 8 小时策略
    if (torrent.error && torrent.error !== 0) {
      const msg = hideText(torrent.errorString || `错误码 ${torrent.error}`);
      taskLog(task.id).warn(`transmission 报告错误（继续观察，按 8 小时策略处理）: ${msg}`);
    }

    const selectedBytes = Math.max(0, Number(payload.selectedBytes ?? task.expectBytes ?? 0) || 0);
    return {
      progress,
      speedBps: speed,
      etaSec: eta,
      totalBytes: torrent.totalSize ?? selectedBytes,
      downloadedBytes: Math.round((torrent.percentDone ?? 0) * (torrent.totalSize ?? selectedBytes)),
    };
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

/** transmission 的 wanted 数组：空数组/缺省 = 全都要；0 = 不要 */
function wantedIdxOf(wanted: number[] | undefined, i: number): boolean {
  if (!Array.isArray(wanted) || wanted.length === 0) return true;
  return wanted[i] !== 0;
}

/**
 * 勾选视频文件：只留视频（扩展名大小写不敏感），其它标 unwanted；返回视频总字节数。
 * 幂等，可以反复调用（空间不够被退回等待后会再来一遍）。不做任何"广告识别"。
 */
async function syncBtVideoSelection(task: TaskWithPayload, torrentId: number): Promise<number> {
  const client = transmissionClient();
  const info = await client.call<{ torrents: TorrentInfo[] }>('torrent-get', {
    ids: [torrentId],
    fields: ['id', 'name', 'files', 'wanted', 'totalSize', 'downloadDir', 'status', 'hashString'],
  });
  const torrent = info.torrents?.[0];
  if (!torrent) throw new Error('无法读取种子信息');
  const files = torrent.files ?? [];
  const entries = files.map((f) => ({ name: f?.name ?? '', length: f?.length ?? 0 }));
  const picked = selectBtFiles(entries, { videoExts: config.videoExts });
  taskLog(task.id).mark('BT_SELECT',
    `只挑视频：${picked.keep.length} 个（${(picked.keptBytes / 1024 ** 2).toFixed(1)}MB），排除 ${picked.dropped.length} 个非视频`);
  for (const d of picked.dropped.slice(0, 10)) {
    taskLog(task.id).info(`不下载: ${anonFile(d.index)}（${(d.sizeBytes / 1024 ** 2).toFixed(1)}MB）—— ${d.reason}`);
  }

  // 多个视频时再挑"同类"：独树一帜下最大，相差无几一起下（用户要求）
  const videos = picked.keep.map((i) => entries[i]);
  const btSel = getSettings().btSelect;
  const dominant = pickDominantVideos(videos, {
    bigRatio: btSel.bigRatio,
    smallCeilingBytes: btSel.smallCeilingBytes,
    manySmallCount: btSel.manySmallCount,
  });
  const wantedIdx = dominant.keep.map((k) => picked.keep[k]);
  const droppedByPick = dominant.dropped.map((d) => ({ ...d, index: picked.keep[d.index] }));

  if (videos.length > 1) {
    const ruleText = {
      'single': '只有一个视频，直接下',
      'unique-biggest': '独树一帜：只下最大的',
      'many-smalls-over-weak-big': '最大的太小、小的成堆：下同类小文件',
      'similar-group': '相差无几：同类的都下',
    }[dominant.rule];
    taskLog(task.id).mark('BT_PICK',
      `视频挑同类（${ruleText}）：下 ${wantedIdx.length} 个 / 共 ${videos.length} 个`, {
        rule: dominant.rule,
        biggestBytes: dominant.biggestBytes,
        keep: wantedIdx.map((i) => anonFile(i)),
      });
    for (const d of droppedByPick) {
      taskLog(task.id).info(`不下（异类）: ${anonFile(d.index)}（${(d.sizeBytes / 1024 ** 2).toFixed(1)}MB）—— ${d.reason}`);
    }
  }

  const selectedBytes = wantedIdx.reduce((sum, i) => sum + Math.max(0, Number(files[i]?.length ?? 0) || 0), 0);

  if (wantedIdx.length === 0) {
    await client.call('torrent-remove', { ids: [torrentId], 'delete-local-data': true }).catch(() => undefined);
    throw new Error('该种子里没有视频文件，已跳过（只下载视频）');
  }

  const unwantedIdx = files.map((_, i) => i).filter((i) => !wantedIdx.includes(i));
  if (unwantedIdx.length > 0) {
    await client.call('torrent-set', { ids: [torrentId], 'files-unwanted': unwantedIdx }).catch(() => undefined);
  }
  await client.call('torrent-set', { ids: [torrentId], 'files-wanted': wantedIdx }).catch(() => undefined);

  const prev = (tasksRepo.get(task.id) as TaskWithPayload).payload ?? {};
  tasksRepo.update(task.id, {
    expectBytes: selectedBytes,
    title: task.title || torrent.name || `task_${task.id}`,
    payload: {
      ...prev,
      torrentId,
      btHash: String(torrent.hashString ?? prev.btHash ?? ''),
      selectedBytes,
      // transmission 自己决定把数据放哪（它的两个目录它有写权限），我们只记下来用于扫货
      btDownloadDir: String(torrent.downloadDir ?? ''),
      torrentName: String(torrent.name ?? ''),
    },
    meta: { ...(task.meta ?? {}), files: wantedIdx.map((i) => files[i]?.name ?? '') },
  });
  return selectedBytes;
}
