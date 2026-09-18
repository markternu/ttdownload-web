import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger, taskLog } from '../core/logger';
import { runCommand } from '../services/archive';
import { getSettings, transmissionRpc } from '../services/settings';
import { selectBtFiles, pickDominantVideos } from '../services/btSelect';
import { anonFile, hideName, hidePath, hideText } from '../services/btAnon';
import { seedsRepo, tasksRepo } from '../core/db';
import { cleanupBtTaskDirs } from '../services/btCleanup';
import { parseTorrentFile } from './torrentMeta';
import type { SeedItem } from '../types';
import type { ModuleAdapter, PollResult, TaskWithPayload } from './types';

/* ------------------------------------------------------------------ */
/* Transmission RPC 客户端（带 409 session-id 自动重试）                */
/* ------------------------------------------------------------------ */

/** RPC 不通时的排查步骤：把用户往对的方向引，别再说"是不是没装"（那句会把人带偏） */
const RPC_HINT =
  '｜依次排查：① transmission-daemon 是否在运行（systemctl status transmission-daemon）'
  + '② RPC 用户名/密码是否与 transmission 的 rpc-username/rpc-password 一致'
  + '（可在网页「设置 → 网络设置 → transmission RPC」里填，改完立即生效）'
  + '③ transmission 的 IP 白名单是否放行 127.0.0.1';

export class TransmissionClient {
  private sessionId = '';

  /**
   * 默认从**设置页优先级解析**（见 settings.transmissionRpc()）：设置页填了就用设置页的，
   * 没填才回落 `.env`。以前这里直接绑 `config.transmissionRpc`（= 只读 .env），
   * 导致用户在网页「设置 → transmission RPC」里填的账号密码完全不起作用（血案）。
   */
  constructor(
    private readonly host = transmissionRpc().host,
    private readonly port = transmissionRpc().port,
    private readonly user = transmissionRpc().user,
    private readonly password = transmissionRpc().password,
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
        // ⚠️ 401/403 必须**单独**判、并且说清楚：以前它掉进下面的"响应无法解析"，
        //    最终被 prepare() 统一翻译成"transmission 不可用：请确认已安装并启动 transmission-daemon"
        //    —— 用户明明能用浏览器打开 9091，却被这句误导去查安装（血案）。
        if (res.status === 401 || res.status === 403) {
          const why = res.status === 401
            ? 'HTTP 401 未授权：RPC 用户名/密码不对，或 IP 白名单没放行 127.0.0.1'
            : 'HTTP 403 被拒绝：多半是 RPC 白名单没放行 127.0.0.1';
          scoped.warn(`[MARK:TR_RPC] <- ${method} ${why}`, { httpStatus: res.status, rpcUser: this.user || '(空)' });
          throw new Error(why);
        }
        const text = await res.text();
        let json: { result?: string; arguments?: T };
        try {
          json = JSON.parse(text);
        } catch {
          // 不把响应原文拼进异常：反代/防火墙的错误页里可能带着含种子名的 URL，
          // 而这个 message 会一路被调度器写进日志（只报长度，够定位"响应不是 JSON"）
          throw new Error(`transmission 响应无法解析（非 JSON，http=${res.status}，${text.length} 字节；检查反代/防火墙是否拦了 9091）`);
        }
        if (json.result !== 'success') {
          // ⚠️ 不打印响应体：torrent-get 的响应里含种子名与全部文件名（用户要求日志里不出现）
          // result 本身是协议字符串，仍过一遍脱敏兜底（万一它回显了路径）
          scoped.warn(`[MARK:TR_RPC] <- ${method} 失败 result=${hideText(json.result)} http=${res.status}（${Date.now() - startedAt}ms）`, {
            result: hideText(json.result),
            httpStatus: res.status,
            authConfigured: !!(this.user || this.password),
          });
          throw new Error(`transmission 错误: ${json.result}`);
        }
        scoped.debug(`[MARK:TR_RPC] <- ${method} ok（${Date.now() - startedAt}ms）`);
        return (json.arguments ?? {}) as T;
      } catch (e) {
        scoped.warn(`[MARK:TR_RPC] <- ${method} 异常（${Date.now() - startedAt}ms）: ${hideText((e as Error).message)}`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    scoped.error('[MARK:TR_RPC] transmission 会话协商失败（409 重试后仍失败）：检查 RPC 用户名/密码与 rpc-whitelist');
    throw new Error('transmission 会话协商失败（409）');
  }

  async ping(): Promise<boolean> {
    return (await this.probe()).ok;
  }

  /**
   * 探活并**把真实原因带出来**（401 凭据不对 / 连接被拒 / 超时 / 响应不是 JSON）。
   *
   * 血案：以前 ping() 把所有异常都吞成 false，prepare() 再统一翻译成
   * "transmission 不可用：请确认已安装并启动 transmission-daemon" ——
   * 用户明明能在浏览器里打开 9091（服务好得很），却被这句误导去查安装，
   * 而真正的原因是 RPC 凭据不匹配（HTTP 401）。
   */
  async probe(): Promise<{ ok: boolean; reason: string; version?: string }> {
    try {
      const s = await this.call<{ version?: string }>('session-get', {}, 4000);
      return { ok: true, reason: 'ok', version: s?.version };
    } catch (e) {
      return { ok: false, reason: (e as Error).message || '未知错误' };
    }
  }
}

/**
 * 「绝不限速」策略：开机（或第一次连上 transmission）时把它的速率/队列闸门全部打开。
 *
 * 用户明确要求：**不能有任何下载限速，部署环境有多少带宽就用多少**。
 * transmission 出厂/安装脚本可能带着限速或龟速模式（alt-speed 默认 50KB/s）、
 * 队列只有 5 个种子活跃、写盘缓存只有 4MB（SD 卡/慢盘上会直接拖慢下载）。
 * 这些都不是我们代码限的，但用户看到的就是"慢" —— 所以这里统一关掉/放宽。
 *
 * 幂等；失败只告警（不影响下载）。
 */
export async function applyNoLimitPolicy(): Promise<void> {
  const client = transmissionClient();
  const probe = await client.probe();
  if (!probe.ok) return; // 连不上就先算了，下次再说
  const wanted: Record<string, unknown> = {
    // —— 速率：全关（不是设成 0 而是 enabled=false，双保险）——
    'speed-limit-down-enabled': false,
    'speed-limit-up-enabled': false,
    'alt-speed-enabled': false,
    'alt-speed-time-enabled': false,
    // —— 队列：不因为"同时活跃的种子太多"而排队 ——
    'download-queue-enabled': false,
    'seed-queue-enabled': false,
    // —— 缓存与连接数：给足，避免慢盘/少 peer 成为瓶颈 ——
    'cache-size-mb': 64,
    'peer-limit-global': 500,
    'peer-limit-per-torrent': 100,
  };
  try {
    await client.call('session-set', wanted);
    logger.child('transmission').mark('TASK_STATE', '已声明「绝不限速」：transmission 速率限制全关、队列不排队、缓存 64MB', wanted);
  } catch (e) {
    logger.child('transmission').warn(`设置 transmission 不限速失败（不影响下载）：${hideText((e as Error).message)}`);
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
    // hideArgs/hideOutput：argv 与 unzip 输出里可能带 zip 名、甚至包内 .torrent 名
    const res = await runCommand(config.bins.unzip, ['-o', '-q', '-j', zipPath, '-d', tmpDir], undefined, {
      hideArgs: true,
      hideOutput: true,
      label: '解压种子 zip',
    });
    if (res.code !== 0) {
      logger.child('transmission').error(`[MARK:ARCHIVE] 种子 zip 解压失败（退出码 ${res.code}，名称与输出已隐藏）`, { bin: config.bins.unzip });
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
    // ⚠️ 用户要求：**不自动删除种子相关文件**。zip 不能原地留着（每 3 秒的 produce 会重复
    //    解压 → 无限重复种子），所以**移动**到一个已处理目录里留档，绝不删。
    try {
      const doneDir = path.join(config.dirs.btZip, 'done');
      fs.mkdirSync(doneDir, { recursive: true });
      const keep = path.join(doneDir, `${Date.now()}_${name}`);
      fs.renameSync(zipPath, keep);
    } catch (e) {
      logger.child('transmission').warn(`种子 zip 归档留档失败（不影响解压结果）：${hideText((e as Error).message)}`);
    }
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
    const seed = seedsRepo.upsertByPath({ name, path: p });
    if (seedsRepo.all().length > before) added += 1;
    // 直接从 .torrent 读元数据（bencode），**不用先丢给 transmission** 就知道要下载的资源多大。
    // 这样"批量入队"时才能按大小排队、逐个放行，而不是全丢给 transmission 产生十几个任务。
    if (Number(seed.sizeBytes ?? 0) <= 0) {
      try {
        const meta = parseTorrentFile(p);
        seedsRepo.update(seed.id, { sizeBytes: meta.videoBytes, fileCount: meta.fileCount });
      } catch {
        // 解析失败不阻断：丢给 transmission 后仍能拿到真实大小（第二道闸门会再校验）
      }
    }
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
    const probe = await client.probe();
    if (!probe.ok) {
      // 把真实原因（401 / 连接被拒 / 超时…）如实带出来，别再让用户去查"是不是没装"
      throw new Error(`transmission RPC 不可用：${probe.reason}${RPC_HINT}`);
    }

    // 已经加过（空间不够被退回等待 / 服务重启重新排队）→ 复用，保持暂停。
    // 这条必须放在"检查种子文件存在"之前：复用分支不该因为路径问题被误判成"种子不存在"。
    const existingId = Number(payload.torrentId ?? 0);
    if (existingId) {
      await client.call('torrent-stop', { ids: [existingId] }).catch(() => undefined);
      try {
        await syncBtVideoSelection(task, existingId);
        return;
      } catch (e) {
        // ⚠️ 关键修复：transmission 里已经**没有这个种子**了（被超时策略/扫货/手动删掉、
        //    或者 transmission 重装/清空过）→ 以前这里直接抛「无法读取种子信息」，
        //    而旧的部署里 .torrent 早被删了 → **任务永远救不回来**。
        //    现在种子文件全程留档（btQueued），所以这里改为：丢掉过期的 torrentId，
        //    直接用留档的 .torrent **重新加回 transmission**。
        // ⚠️ 只认「transmission 里确实没这个种子」这一种；RPC 报错/网络中断等必须原样抛出，
        //    否则真实原因（比如磁盘/权限/RPC 故障）会被吞成一句"种子文件不存在"，更难排查
        const raw = String((e as Error).message ?? '');
        if (!raw.includes('无法读取种子信息')) throw e;
        const why = hideText(raw);
        logger.child('transmission').warn(
          `任务 #${task.id} 在 transmission 里找不到该种子（${why}）→ 尝试用留档的 .torrent 重新加入`);
        tasksRepo.update(task.id, { payload: { ...payload, torrentId: 0, reAddedAt: new Date().toISOString() } });
        payload.torrentId = 0;
        // 落到下面的"从种子文件加入"逻辑（种子文件在 btQueued 里留档，不会再出现"文件不存在"）
      }
    }

    // 种子文件路径：优先任务里记的，其次查 seeds 表（入队时已把它移到 btQueued 留档）
    let seedPath = String(payload.seedPath ?? '');
    if (!seedPath || !fs.existsSync(seedPath)) {
      const seedId = Number(payload.seedId ?? 0);
      const recorded = seedId ? String(seedsRepo.get(seedId)?.path ?? '') : '';
      if (recorded && fs.existsSync(recorded)) seedPath = recorded;
    }
    if (!seedPath || !fs.existsSync(seedPath)) {
      throw new Error('种子文件不存在：留档目录里也没有（可能被手动删除了）——请在「BT 种子」页重新上传该种子');
    }

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

    // ⚠️ **绝不自动删除 .torrent**（用户要求）。
    // 种子文件在入队时就已经被移动到 config.dirs.btQueued 归档了，这里什么都不做 ——
    // 保留它，用户以后想重下（任务被超时清理/手动删任务）都不用重新找种子。
    if (payload.seedId) {
      seedsRepo.update(Number(payload.seedId), { status: 'downloading' });
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
    const probe2 = await client.probe();
    if (!probe2.ok) {
      throw new Error(`transmission RPC 不可用：${probe2.reason}${RPC_HINT}`);
    }
    const selectedBytes = Math.max(0, Number(payload.selectedBytes ?? task.expectBytes ?? 0) || 0);
    await client.call('torrent-start', { ids: [torrentId] });
    // 记录"什么时候扔给 transmission 的"：12 小时/6 小时策略从这一刻算起
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
   * 只**读**进度。12 小时窗口内不对 transmission 里的种子做任何操作
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

    // 进度快照留痕（给 12h/6h 判断用，也方便排查"到底卡在多少"）
    if (Math.abs(progress - Number(payload.btLastProgress ?? -1)) >= 1) {
      tasksRepo.update(task.id, { payload: { ...payload, btLastProgress: progress, btLastCheckAt: new Date().toISOString() } });
    }

    // transmission 自己报错时如实转达，但**不**擅自删任务 —— 交给 12 小时策略
    if (torrent.error && torrent.error !== 0) {
      const msg = hideText(torrent.errorString || `错误码 ${torrent.error}`);
      taskLog(task.id).warn(`transmission 报告错误（继续观察，按 12 小时策略处理）: ${msg}`);
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
  // 入队 = 把 .torrent **移动**到"已入队"目录留档（永不删除；界面上的已入队列表就在这儿）
  const movedTo = moveSeedToQueued(seed);
  tasksRepo.update(task.id, {
    payload: { seedId: seed.id, seedPath: movedTo, seedArchived: true },
  });
  seedsRepo.update(seed.id, { status: 'queued', taskId: task.id, path: movedTo });
  return task;
}

/**
 * 把 .torrent **移动**到"已入队"目录（config.dirs.btQueued = transmission/btzhongzi_yijingdownding）。
 *
 * 用户要求：种子文件全程不自动删除，只有用户自己点删除才删。
 * 移动而不是留着，是为了让"待下载种子"列表里只剩还没入队的（这就是需求里的
 * "已经入队的不要再放在这里"）。移动失败（跨设备等）就退回原路径，不影响入队。
 */
function moveSeedToQueued(seed: SeedItem): string {
  const src = String(seed.path ?? '');
  if (!src || !fs.existsSync(src)) return src;
  try {
    fs.mkdirSync(config.dirs.btQueued, { recursive: true });
    let dest = path.join(config.dirs.btQueued, path.basename(src));
    if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(src)) {
      dest = path.join(config.dirs.btQueued, `${path.basename(src).replace(/\.torrent$/i, '')}_${Date.now()}.torrent`);
    }
    if (path.resolve(dest) === path.resolve(src)) return src;
    try {
      fs.renameSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
      // 注意：这里**不删**源文件（用户要求不自动删种子）；源文件留在 btPending 也无害
    }
    return dest;
  } catch (e) {
    logger.child('transmission').warn(`种子归档移动失败（不影响入队）：${hideText((e as Error).message)}`);
    return src;
  }
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
