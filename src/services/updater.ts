/**
 * 自动更新（自升级）—— 需求（用户原话）：
 *   · 开机启动时必须去拉取最新代码；拉不到（重试几次还失败）就直接用本地老代码启动；
 *   · 启动运行后定时去获取最新代码，有就拉下来升级；
 *   · 升级的时候不能影响正在下载的下载任务：可以先暂停，升级成功重启后恢复下载；
 *   · 页面给用户一个「更新」页，可以点「检查更新」「立即更新」。
 *
 * 设计要点（为什么这么做）：
 *   1. **绝不阻塞启动**：本服务永远先用本地代码起来（systemd/nginx 的健康检查不受网络影响），
 *      更新检查是启动后延迟 + 定时跑的异步任务；git 拉不到只是打一条日志，继续用老代码跑。
 *   2. **版本号说话**：远端版本 = 远端 `package.json` 的 SemVer；只有**比本地高**才自动升。
 *      版本一样的提交不自动装（防止把没发布的半成品推上线），但用户可以在页面上强制装最新提交。
 *      规范见 docs/VERSIONING.md（写代码的人必须改一次代码就抬一次版本号）。
 *   3. **升级动作不放在本进程里做**：本进程要"自己把自己换掉"，所以只负责
 *      「暂停下载 → 写状态 → 把活交给外部脚本（systemd-run 起一个独立 unit）→ 退出」。
 *      外部脚本做 git 拉取/构建/重启/回滚，见 deploy/scripts/self-update.sh。
 *      用 systemd-run 是为了让脚本**跑在服务进程的 cgroup 之外** ——
 *      否则 `systemctl restart` 会把正在干活的脚本自己一起杀掉。
 *   4. **暂停/恢复**：只暂停底层下载器（transmission 种子、aria2 任务），**不动数据库里的任务状态**
 *      —— 这样即使升级失败回滚到老代码，重启后的 recoverTasks 也会自动把它们接着下。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { tasksRepo } from '../core/db';
import { getSettings } from './settings';
import { transmissionClient } from '../modules/transmission';
import { aria2Client, ensureAria2Daemon } from '../modules/aria2Client';
import { compareSemVer, isMajorBump, parseSemVer, readPackageVersion } from '../core/version';
import { nowIso } from '../core/clock';
import type { Task } from '../types';

const execFileAsync = promisify(execFile);

/** 状态文件：本进程写的"当前/上次检查与升级状态"（重启后页面还看得到） */
function statePath(name: string): string {
  return path.join(config.dirs.state, name);
}
export const STATUS_FILE = (): string => statePath('update-status.json');
export const RESULT_FILE = (): string => statePath('update-result.json');
export const RESUME_FILE = (): string => statePath('update-resume.json');
export const LOG_FILE = (): string => statePath('update.log');

export interface UpdateCommit {
  sha: string;
  subject: string;
  at: string;
}

export type UpdatePhase = 'idle' | 'checking' | 'paused' | 'updating' | 'done' | 'failed' | 'unavailable';

export interface UpdateStatus {
  /** 当前（本地）版本，来自 package.json */
  currentVersion: string;
  /** 远端版本（检查成功后才有） */
  latestVersion: string | null;
  /** 当前 commit（短 sha）与提交说明 */
  currentCommit: string | null;
  currentCommitSubject: string | null;
  latestCommit: string | null;
  /** 远端比本地多的提交数 */
  behind: number;
  /** 远端更新（版本更高，或有新提交） */
  available: boolean;
  /** 远端版本更高 */
  versionNewer: boolean;
  /** 大版本升级（页面要提醒"可能不兼容"） */
  majorBump: boolean;
  /** 有提交但没有抬版本号（不给自动升，页面上说明） */
  versionUnchanged: boolean;
  commits: UpdateCommit[];
  remote: string;
  branch: string;
  repoReady: boolean;
  /** 上次检查时间 / 上次检查失败原因 */
  checkedAt: string | null;
  error: string | null;
  phase: UpdatePhase;
  message: string;
  /** 上一次升级的结果（外部脚本写的，重启后仍在） */
  lastResult: UpdateResult | null;
  /** 升级日志（self-update.sh 的 tail） */
  logTail: string;
  autoEnabled: boolean;
  intervalMin: number;
  bootDelaySec: number;
  serviceName: string;
  /** 正在下载/等待的任务数（页面提示"升级会先暂停它们"） */
  activeTasks: number;
  /** 上一次自动升级的尝试（失败时页面要提示"冷却中"，并给出手动命令） */
  lastAttempt: UpdateAttempt | null;
  /** 自动升级被冷却挡住的原因（null = 没被挡）；页面据此提示"请手动执行命令" */
  autoApplySkipReason: string | null;
  /** 手动升级命令（页面一键复制；服务器上执行它等价于点「立即更新」） */
  manualCommand: string;
  /** 部署目录的绝对路径（页面上显示，避免 `~/...` 有歧义） */
  rootDir: string;
}

export interface UpdateResult {
  ok: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  fromCommit: string | null;
  toCommit: string | null;
  at: string;
  message: string;
  rolledBack: boolean;
}

/* ------------------------------------------------------------------ *
 *  状态读写
 * ------------------------------------------------------------------ */

let status: UpdateStatus | null = null;

function emptyStatus(): UpdateStatus {
  return {
    currentVersion: config.version,
    latestVersion: null,
    currentCommit: null,
    currentCommitSubject: null,
    latestCommit: null,
    behind: 0,
    available: false,
    versionNewer: false,
    majorBump: false,
    versionUnchanged: false,
    commits: [],
    remote: config.update.remote,
    branch: config.update.branch,
    repoReady: isGitRepo(),
    checkedAt: null,
    error: null,
    phase: 'idle',
    message: '',
    lastResult: null,
    logTail: '',
    autoEnabled: getSettings().update.enabled,
    intervalMin: getSettings().update.intervalMin,
    bootDelaySec: getSettings().update.bootDelaySec,
    serviceName: config.update.serviceName,
    activeTasks: 0,
    lastAttempt: null,
    autoApplySkipReason: null,
    manualCommand: '',
    rootDir: config.rootDir,
  };
}

function persistStatus(): void {
  if (!status) return;
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE()), { recursive: true });
    fs.writeFileSync(STATUS_FILE(), JSON.stringify(status, null, 2));
  } catch (e) {
    logger.child('update').warn(`写更新状态文件失败：${(e as Error).message}`);
  }
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function logTail(lines = 40): string {
  try {
    if (!fs.existsSync(LOG_FILE())) return '';
    const all = fs.readFileSync(LOG_FILE(), 'utf8').split('\n').filter(Boolean);
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export function isGitRepo(): boolean {
  return fs.existsSync(path.join(config.rootDir, '.git'));
}

/** 给页面看的完整状态（每次调用都刷新"上次升级结果/日志尾巴/在跑任务数"） */
export function getUpdateStatus(): UpdateStatus {
  if (!status) {
    status = emptyStatus();
    const saved = readJson<UpdateStatus>(STATUS_FILE());
    // 只回填"历史信息"，实时字段一律以本次进程为准（避免显示上一次的错误状态）
    if (saved) {
      status.checkedAt = saved.checkedAt ?? null;
      status.latestVersion = saved.latestVersion ?? null;
      status.latestCommit = saved.latestCommit ?? null;
      status.commits = Array.isArray(saved.commits) ? saved.commits : [];
    }
  }
  const s = getSettings();
  status.currentVersion = config.version;
  status.autoEnabled = s.update.enabled;
  status.intervalMin = s.update.intervalMin;
  status.bootDelaySec = s.update.bootDelaySec;
  status.lastResult = readJson<UpdateResult>(RESULT_FILE());
  status.lastAttempt = lastAttempt();
  // 被冷却挡住时页面要明说（否则用户会以为"自动更新坏了"）
  status.autoApplySkipReason = status.versionNewer ? shouldSkipAutoApply(status).reason ?? null : null;
  status.manualCommand = manualUpdateCommand();
  status.logTail = logTail();
  status.repoReady = isGitRepo();
  status.activeTasks = tasksRepo.byStatus(['waiting', 'parsing', 'downloading']).length;
  return status;
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...(status ?? emptyStatus()), ...patch };
  persistStatus();
}

/**
 * 给用户在服务器上手动执行的升级命令 = 本页面「立即更新」的等价物。
 * 自动升级起不来（没有 systemd-run / 权限不对 / 网络太差）时，这就是兜底手段。
 *
 * 路径用 `~/xxx` 形式（用户是用自己的账号 ssh 上去执行的，`~` 就是他自己的家目录；
 * 而服务是以 root 跑的，所以这里**不能**用服务进程的 HOME 去展开）。
 * 不在家目录下的部署（例如 /opt/xxx）就如实给绝对路径，别硬凑 `~`。
 */
export function manualUpdateCommand(): string {
  const dir = config.rootDir;
  const m = /^(?:\/home|\/Users)\/[^/]+\/(.+)$/.exec(dir);
  const shown = m ? `~/${m[1]}` : dir;
  return `cd ${shown} && sudo ./deploy.sh --update`;
}

/* ------------------------------------------------------------------ *
 *  git 操作
 * ------------------------------------------------------------------ */

export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function git(args: string[], timeoutMs = config.update.fetchTimeoutSec * 1000): Promise<GitRun> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-c', 'safe.directory=*', ...args], {
      cwd: config.rootDir,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const stderr = String(err.stderr ?? '').trim() || String(err.message ?? '');
    return { ok: false, stdout: String(err.stdout ?? '').trim(), stderr: err.killed ? `超时（>${timeoutMs / 1000}s）` : stderr };
  }
}

/** 远端 ref（`origin/main`），别用 FETCH_HEAD —— 多 remote 时会指错。 */
function remoteRef(): string {
  return `${config.update.remote}/${config.update.branch}`;
}

async function localCommit(): Promise<{ sha: string; subject: string } | null> {
  const r = await git(['log', '-1', '--format=%h|%s'], 15_000);
  if (!r.ok || !r.stdout) return null;
  const [sha, ...rest] = r.stdout.split('|');
  return { sha, subject: rest.join('|') };
}

/* ------------------------------------------------------------------ *
 *  检查更新
 * ------------------------------------------------------------------ */

export interface CheckOptions {
  /** 用户手动点的：失败要如实报错（自动检查失败只打日志） */
  manual?: boolean;
  /** 只读远端（不 fetch）——测试/离线用 */
  noFetch?: boolean;
}

/**
 * 拉远端 + 比对版本。**任何失败都不抛异常**（自动更新绝不能把服务搞挂），
 * 失败信息放在返回值的 error 里。
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateStatus> {
  const s = getSettings();
  setStatus({ phase: 'checking', message: '正在检查更新…' });
  const pending = { ...(status ?? emptyStatus()) };

  if (!isGitRepo()) {
    setStatus({
      phase: 'unavailable',
      repoReady: false,
      checkedAt: nowIso(),
      error: '当前部署目录不是 git 仓库（可能是压缩包上传的），无法自动更新；请用 deploy.sh 重新拉取代码',
      message: '当前目录不是 git 仓库，不能自动更新',
    });
    return getUpdateStatus();
  }

  const local = await localCommit();
  let fetchError: string | null = null;
  if (!opts.noFetch) {
    const f = await git(['fetch', '--prune', config.update.remote, config.update.branch]);
    if (!f.ok) {
      fetchError = f.stderr.split('\n')[0]?.slice(0, 300) || '拉取失败';
      logger.child('update').warn(`[MARK:UPDATE_CHECK] git fetch 失败（继续用本地代码跑）：${fetchError}`);
    } else {
      logger.child('update').mark('UPDATE_CHECK', `已拉取 ${config.update.remote}/${config.update.branch}`);
    }
  }

  // 远端 package.json 里的版本号 = 发布版本
  const show = await git(['show', `${remoteRef()}:package.json`], 20_000);
  let latestVersion: string | null = null;
  if (show.ok && show.stdout) {
    try {
      latestVersion = readPackageVersionFromText(show.stdout);
    } catch {
      latestVersion = null;
    }
  }
  const remoteShaRun = await git(['rev-parse', '--short', remoteRef()], 15_000);
  const latestCommit = remoteShaRun.ok ? remoteShaRun.stdout.split('\n')[0] : null;

  const logRun = await git(['log', '--format=%h|%s|%cI', `HEAD..${remoteRef()}`, '-n', '50'], 20_000);
  const commits: UpdateCommit[] = logRun.ok && logRun.stdout
    ? logRun.stdout.split('\n').filter(Boolean).map((line) => {
        const [sha, subject, at] = line.split('|');
        return { sha, subject: subject ?? '', at: at ?? '' };
      })
    : [];

  const cmp = latestVersion ? compareSemVer(latestVersion, config.version) : 0;
  const versionNewer = cmp > 0;
  const behind = commits.length;
  const available = versionNewer || behind > 0;

  setStatus({
    ...pending,
    currentVersion: config.version,
    latestVersion,
    currentCommit: local?.sha ?? null,
    currentCommitSubject: local?.subject ?? null,
    latestCommit,
    behind,
    available,
    versionNewer,
    majorBump: latestVersion ? isMajorBump(config.version, latestVersion) : false,
    versionUnchanged: !versionNewer && behind > 0,
    commits,
    remote: config.update.remote,
    branch: config.update.branch,
    repoReady: true,
    checkedAt: nowIso(),
    error: fetchError,
    phase: 'idle',
    message: versionNewer
      ? `发现新版本 ${latestVersion}（当前 ${config.version}），共 ${behind} 个新提交`
      : behind > 0
        ? `远端有 ${behind} 个新提交，但版本号没抬（仍是 ${latestVersion ?? '未知'}）——按规范不自动升级`
        : `已是最新版本 ${config.version}`,
    autoEnabled: s.update.enabled,
    intervalMin: s.update.intervalMin,
    bootDelaySec: s.update.bootDelaySec,
  });

  logger.child('update').mark('UPDATE_CHECK', status!.message, {
    current: config.version,
    latest: latestVersion,
    behind,
    fetchError: fetchError ?? undefined,
  });
  return getUpdateStatus();
}

/** 从 package.json 文本里读版本（远端 checkout 不出来时用 `git show` 拿到的是文本） */
export function readPackageVersionFromText(text: string): string | null {
  try {
    const pkg = JSON.parse(text) as { version?: unknown };
    const v = parseSemVer(pkg.version);
    return v ? `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}` : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  暂停 / 恢复下载
 * ------------------------------------------------------------------ */

interface ResumePlan {
  at: string;
  torrentIds: number[];
  aria2Gids: string[];
  /** 本次升级的目标版本，恢复后写进日志 */
  toVersion: string | null;
}

/**
 * 暂停所有正在下载的任务 —— **只动底层下载器，不动数据库里的任务状态**。
 * 为什么不动状态：万一升级失败回滚到老代码，老代码没有"恢复被升级暂停的任务"这套逻辑，
 * 任务就会永远卡在 paused。而现在数据库里仍然是 downloading，重启后 recoverTasks
 * 会把它重新排队并 torrent-start / unpause，老代码新代码都能自愈。
 */
export async function pauseDownloads(): Promise<ResumePlan> {
  const plan: ResumePlan = { at: nowIso(), torrentIds: [], aria2Gids: [], toVersion: getUpdateStatus().latestVersion };
  const running = tasksRepo.byStatus(['parsing', 'downloading']) as (Task & { payload?: Record<string, unknown> })[];

  // transmission：torrent-stop（transmission 自己会把状态落盘，重启后还是停着的，所以要记下来恢复）
  const torrentIds = running
    .filter((t) => t.module === 'transmission')
    .map((t) => Number((t.payload ?? {}).torrentId ?? 0))
    .filter((n) => n > 0);
  if (torrentIds.length) {
    try {
      const client = transmissionClient();
      if (await client.ping()) {
        await client.call('torrent-stop', { ids: torrentIds });
        plan.torrentIds = torrentIds;
        logger.child('update').mark('UPDATE_PAUSE', `已暂停 ${torrentIds.length} 个 transmission 种子（升级期间不下载）`);
      }
    } catch (e) {
      logger.child('update').warn(`暂停 transmission 种子失败（升级继续）：${(e as Error).message}`);
    }
  }

  // aria2：pause（同样会被 aria2 自己记住，重启后需要 unpause）
  const gids = running
    .filter((t) => t.module === 'aria2')
    .map((t) => String((t.payload ?? {}).gid ?? ''))
    .filter(Boolean);
  if (gids.length) {
    try {
      await ensureAria2Daemon();
      const client = aria2Client();
      for (const gid of gids) {
        await client.call('aria2.pause', [gid]).catch(() => undefined);
      }
      plan.aria2Gids = gids;
      logger.child('update').mark('UPDATE_PAUSE', `已暂停 ${gids.length} 个 aria2 任务（升级期间不下载）`);
    } catch (e) {
      logger.child('update').warn(`暂停 aria2 任务失败（升级继续）：${(e as Error).message}`);
    }
  }

  try {
    fs.writeFileSync(RESUME_FILE(), JSON.stringify(plan, null, 2));
  } catch (e) {
    logger.child('update').warn(`写恢复计划失败：${(e as Error).message}`);
  }
  return plan;
}

/**
 * 开机时调用：如果上次是"为了升级而暂停"，这里恢复下载。
 * （数据库里的任务状态没被改过，所以 recoverTasks 也会顺带把它们跑起来；
 *   这里主要是把 transmission/aria2 里"停着"的开关重新打开。）
 */
export async function resumeAfterUpdate(): Promise<void> {
  const plan = readJson<ResumePlan>(RESUME_FILE());
  if (!plan) return;
  const result = readJson<UpdateResult>(RESULT_FILE());
  try {
    if (result && result.at && plan.at && result.at < plan.at) {
      // 结果文件比暂停计划还旧 → 说明这次升级根本没跑到"写结果"那一步（脚本没起来/被杀）
      logger.child('update').warn('[MARK:UPDATE_RESUME] 上次升级没有留下结果，仍按计划恢复下载');
    }
    if (plan.torrentIds?.length) {
      const client = transmissionClient();
      if (await client.ping()) {
        await client.call('torrent-start', { ids: plan.torrentIds });
        logger.child('update').mark('UPDATE_RESUME', `已恢复 ${plan.torrentIds.length} 个 transmission 种子`);
      }
    }
    if (plan.aria2Gids?.length) {
      await ensureAria2Daemon();
      const client = aria2Client();
      for (const gid of plan.aria2Gids) {
        await client.call('aria2.unpause', [gid]).catch(() => undefined);
      }
      logger.child('update').mark('UPDATE_RESUME', `已恢复 ${plan.aria2Gids.length} 个 aria2 任务`);
    }
  } catch (e) {
    logger.child('update').warn(`恢复下载失败（可在页面上手动"继续"）：${(e as Error).message}`);
  } finally {
    try {
      fs.rmSync(RESUME_FILE(), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 *  执行升级
 * ------------------------------------------------------------------ */

export interface ApplyOptions {
  /** 用户手动点的（允许"版本没变也装最新提交"） */
  manual?: boolean;
  /** 只把命令打出来（不真的执行）——测试用 */
  dryRun?: boolean;
}

export interface ApplyDecision {
  ok: boolean;
  reason?: string;
  command?: string;
}

/** 升级前的前置检查（抽出来是为了能单测：这些判断不能只活在 HTTP 处理里） */
export function canApply(st: UpdateStatus, opts: ApplyOptions = {}): ApplyDecision {
  if (!st.repoReady) return { ok: false, reason: '部署目录不是 git 仓库，无法自动升级（请用 deploy.sh 重新拉取代码）' };
  if (!opts.manual) {
    if (!st.versionNewer) {
      return { ok: false, reason: st.versionUnchanged
        ? `远端有 ${st.behind} 个新提交，但版本号没有抬高（仍是 ${st.latestVersion ?? '未知'}）：请先按规范抬版本号，或在页面上手动"强制安装最新提交"`
        : '当前已是最新版本' };
    }
  } else if (!st.available) {
    return { ok: false, reason: '当前已是最新版本' };
  }
  const script = selfUpdateScript();
  if (!fs.existsSync(script)) return { ok: false, reason: `缺少升级脚本 ${script}（代码不完整，请重新部署）` };
  return { ok: true, command: script };
}

function selfUpdateScript(): string {
  return path.join(config.rootDir, 'deploy', 'scripts', 'self-update.sh');
}

/**
 * 生成"启动外部升级脚本"的命令（抽成纯函数是为了能单测 —— 真机踩过的坑：
 * systemd-run 把命令后面的 `--repo/--ref/...` 当成它自己的参数吃掉了，
 * 脚本收到 0 个参数，于是仓库路径退化成 "/"，git 直接报 not a git repository）。
 *
 * 所以这里做两件事：
 *   ① 参数**同时**用环境变量传一份（脚本优先读 env，其次才读命令行）；
 *   ② systemd-run 命令前加 `--`，明确"后面全是命令和它的参数"。
 */
export function buildUpdaterCommand(opts: {
  script: string;
  repo: string;
  ref: string;
  service: string;
  log: string;
  previous?: string;
}): { env: Record<string, string>; cliArgs: string[]; shellCmd: string } {
  const cliArgs = [
    '--repo', opts.repo,
    '--ref', opts.ref,
    '--service', opts.service,
    '--log', opts.log,
    ...(opts.previous ? ['--previous', opts.previous] : []),
  ];
  const env = {
    TTDL_REPO: opts.repo,
    TTDL_REF: opts.ref,
    TTDL_SERVICE: opts.service,
    TTDL_LOG: opts.log,
    TTDL_PREVIOUS: opts.previous ?? '',
    // 让脚本在日志里说清"是谁调用的"（人工跑 vs 程序自动升级）
    TTDL_CALLER: 'app(自动更新)',
    TTDL_SELF_UPDATE_ARGV: ['bash', opts.script, ...cliArgs].join(' '),
  };
  // 展示用命令：--xxx 保持不带引号（人能读），带空格的值加引号
  const q = (v: string): string => (/[\s"']/.test(v) ? JSON.stringify(v) : v);
  const shellCmd = `bash ${q(opts.script)} ${cliArgs.map((a) => (a.startsWith('--') ? a : q(a))).join(' ')}`;
  return { env, cliArgs, shellCmd };
}

/**
 * 真正发起升级：暂停下载 → 启动外部升级脚本 → 本进程退出（脚本会重新拉起服务）。
 *
 * ⚠️ 脚本必须跑在**本服务的 cgroup 之外**（systemd-run --unit=...），否则
 *    `systemctl restart` 会把正在构建的脚本自己一起杀掉，升到一半服务就没了。
 *    没有 systemd（比如 `npm start` 手跑）时退回 setsid+nohup：这时父进程退出后
 *    脚本还在，但重启服务要靠脚本自己的兜底逻辑（pkill + nohup node dist/server.js）。
 */
export async function applyUpdate(opts: ApplyOptions = {}): Promise<ApplyDecision> {
  const st = getUpdateStatus();
  const decision = canApply(st, opts);
  if (!decision.ok) return decision;

  const script = decision.command!;
  const target = st.latestCommit || remoteRef();
  const previous = st.currentCommit ?? '';
  const logFile = LOG_FILE();
  const cmd = buildUpdaterCommand({
    script,
    repo: config.rootDir,
    ref: target,
    service: config.update.serviceName,
    log: logFile,
    previous: previous || undefined,
  });
  const unit = `ttdownload-selfupdate-${Date.now()}`;

  setStatus({ phase: 'paused', message: '正在暂停下载任务（升级完成后自动恢复）…' });
  await pauseDownloads();

  setStatus({ phase: 'updating', message: `正在升级到 ${st.latestVersion ?? target}，服务稍后自动重启…` });
  // 记一次"尝试"：万一脚本起不来/失败，下次开机不能马上再试（否则会陷入
  // 开机→升级→失败→退出→重启→再升级 的死循环，真机上就是这么刷日志的）
  recordAttempt({ at: nowIso(), target, fromVersion: config.version, ok: null });
  // 外部脚本的最终结果由它自己写 RESULT_FILE；本进程马上会被它杀掉/重启
  logger.child('update').mark('UPDATE_APPLY', `即将启动升级脚本：${cmd.shellCmd}`, { repo: config.rootDir, target });

  if (opts.dryRun) {
    return { ok: true, command: cmd.shellCmd };
  }

  let started = false;
  let lastErr = '';
  // ① 首选 systemd-run（跑在服务 cgroup 之外，重启服务不会杀掉它）
  //    ⚠️ 命令前的 `--` 不能省：否则 `--repo` 这类参数可能被 systemd-run 自己吃掉
  try {
    const p = await execFileAsync(
      'systemd-run',
      ['--unit', unit, '--collect', '--no-block', '--description', 'ttdownload-web self-update',
        ...Object.entries(cmd.env).map(([k, v]) => `--setenv=${k}=${v}`),
        '--', 'bash', script, ...cmd.cliArgs],
      { timeout: 5000 },
    );
    logger.child('update').mark('UPDATE_APPLY', `已用 systemd-run 启动升级脚本：${p.stdout.trim()}`);
    started = true;
  } catch (e) {
    lastErr = (e as Error).message;
    logger.child('update').warn(`systemd-run 启动失败（改用 setsid 兜底）：${lastErr}`);
  }

  // ② 兜底：没有 systemd-run / 它失败了 → setsid 脱离父进程（本进程马上退出，脚本继续）
  if (!started) {
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn('bash', [script, ...cmd.cliArgs], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...cmd.env },
      });
      child.unref();
      logger.child('update').mark('UPDATE_APPLY', `已用 setsid 兜底启动升级脚本（pid ${child.pid}）`);
      started = true;
    } catch (e) {
      lastErr = `${lastErr}; ${(e as Error).message}`;
    }
  }

  if (!started) {
    setStatus({ phase: 'failed', message: `无法启动升级脚本：${lastErr}` });
    // 起不来就赶紧把下载恢复回来，别让用户白等
    await resumeAfterUpdate();
    recordAttempt({ at: nowIso(), target, fromVersion: config.version, ok: false, message: `无法启动升级脚本：${lastErr}` });
    return { ok: false, reason: `无法启动升级脚本：${lastErr}` };
  }

  // 给 HTTP 响应留出时间再退出；脚本会重启服务（systemd Restart=always / 脚本自己拉起）
  setTimeout(() => {
    logger.child('update').mark('UPDATE_APPLY', '升级脚本已接管，本进程退出等待重启');
    process.exit(0);
  }, 2500).unref();
  return { ok: true, command: cmd.shellCmd };
}

/* ------------------------------------------------------------------ *
 *  升级尝试记录 + 冷却（防止"开机→升级→失败→重启"死循环）
 * ------------------------------------------------------------------ */

export interface UpdateAttempt {
  at: string;
  /** 这次要升到哪个目标（commit） */
  target: string;
  /** 发起时本地版本 */
  fromVersion: string;
  /** null = 还没结果 */
  ok: boolean | null;
  message?: string;
}

export const ATTEMPT_FILE = (): string => statePath('update-attempt.json');

export function recordAttempt(a: UpdateAttempt): void {
  try {
    fs.mkdirSync(path.dirname(ATTEMPT_FILE()), { recursive: true });
    fs.writeFileSync(ATTEMPT_FILE(), JSON.stringify(a, null, 2));
  } catch (e) {
    logger.child('update').warn(`写升级尝试记录失败：${(e as Error).message}`);
  }
}

export function lastAttempt(): UpdateAttempt | null {
  return readJson<UpdateAttempt>(ATTEMPT_FILE());
}

/**
 * 判断这次自动升级要不要跳过。
 *
 * 为什么要它（真机事故）：升级脚本起不来时，本进程会退出 → systemd 立刻重启 →
 * 开机检查又发现"有新版本" → 又发起升级 → 又退出……**每 30 秒一轮死循环**，
 * 日志被刷爆、下载任务被反复暂停。现在：同一个目标在冷却期内只试一次；
 * 用户仍然可以在「更新」页手动重试（手动不看冷却）。
 */
export function shouldSkipAutoApply(
  st: UpdateStatus,
  nowStr: string = nowIso(),
  cooldownMin: number = config.update.retryCooldownMin,
): { skip: boolean; reason?: string } {
  const last = lastAttempt();
  if (!last) return { skip: false };
  // 版本已经变过（说明上次其实成功了）→ 记录作废
  if (last.fromVersion && last.fromVersion !== st.currentVersion) return { skip: false };
  // 目标不同（远端又发布了新版本）→ 允许再试
  const target = st.latestCommit || remoteRef();
  if (last.target && last.target !== target) return { skip: false };
  const at = Date.parse(last.at);
  if (!Number.isFinite(at)) return { skip: false };
  const ageMin = (Date.parse(nowStr) - at) / 60000;
  if (ageMin >= cooldownMin) return { skip: false };
  return {
    skip: true,
    reason: `上次升级（${last.at}）没有成功，${Math.ceil(cooldownMin - ageMin)} 分钟内不再自动重试；可在「更新」页手动重试，或直接执行 sudo ./deploy.sh --update`,
  };
}

/* ------------------------------------------------------------------ *
 *  后台：开机检查 + 定时检查
 * ------------------------------------------------------------------ */

let bootTimer: NodeJS.Timeout | null = null;
let interval: NodeJS.Timeout | null = null;
let running = false;

/** 开机第一次检查：重试 N 次；全失败就用本地老代码继续跑（用户要求）。 */
async function bootCheck(): Promise<void> {
  const s = getSettings();
  const retries = Math.max(1, config.update.bootRetries);
  for (let i = 1; i <= retries; i += 1) {
    try {
      const st = await checkForUpdate();
      if (!st.error) break; // 拉到了（有更新/没更新都算成功）
      logger.child('update').warn(`[MARK:UPDATE_CHECK] 开机拉取失败（第 ${i}/${retries} 次）：${st.error}`);
    } catch (e) {
      logger.child('update').warn(`[MARK:UPDATE_CHECK] 开机拉取异常（第 ${i}/${retries} 次）：${(e as Error).message}`);
    }
    if (i < retries) await new Promise((r) => setTimeout(r, config.update.bootRetryGapMs));
  }

  const st = getUpdateStatus();
  if (!s.update.enabled) {
    logger.child('update').mark('UPDATE_CHECK', '自动更新已在设置里关闭（页面上的「检查更新 / 立即更新」仍可用）');
    return;
  }
  if (st.versionNewer && !st.error) {
    const skip = shouldSkipAutoApply(st);
    if (skip.skip) {
      logger.child('update').mark('UPDATE_CHECK', `暂不自动升级（冷却中）：${skip.reason}`);
      return;
    }
    logger.child('update').mark('UPDATE_CHECK', `开机发现新版本 ${st.latestVersion}（当前 ${config.version}），开始自动升级`);
    await applyUpdate({ manual: false });
    return;
  }
  if (st.error) {
    logger.child('update').mark('UPDATE_CHECK', `拉不到最新代码（${st.error}），先用本地代码 ${config.version} 启动，之后按间隔重试`);
  } else if (st.versionUnchanged) {
    logger.child('update').mark('UPDATE_CHECK', `远端有 ${st.behind} 个新提交但版本号没抬，不自动升级（规范要求抬版本号）`);
  } else {
    logger.child('update').mark('UPDATE_CHECK', `已是最新版本 ${config.version}`);
  }
}

/** 定时检查（间隔可在「更新」页改） */
async function tickCheck(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const s = getSettings();
    if (!s.update.enabled) return;
    const st = await checkForUpdate();
    if (st.versionNewer && !st.error) {
      const skip = shouldSkipAutoApply(st);
      if (skip.skip) {
        logger.child('update').mark('UPDATE_CHECK', `暂不自动升级（冷却中）：${skip.reason}`);
        return;
      }
      logger.child('update').mark('UPDATE_CHECK', `定时检查发现新版本 ${st.latestVersion}，开始自动升级`);
      await applyUpdate({ manual: false });
    }
  } catch (e) {
    logger.child('update').warn(`[MARK:UPDATE_CHECK] 定时检查异常（忽略，继续跑本地代码）：${(e as Error).message}`);
  } finally {
    running = false;
  }
}

/**
 * 启动自动更新线程。**必须在服务已经开始监听之后调用** ——
 * 更新检查永远不能挡住启动（拉不到网/拉不到代码都要能起来用）。
 */
export function startUpdateWorker(): void {
  if (bootTimer || interval) return;
  getUpdateStatus(); // 预热状态（含读取上次结果）
  const s = getSettings();
  const bootDelay = Math.max(0, s.update.bootDelaySec) * 1000;
  const everyMs = Math.max(60_000, Math.max(1, s.update.intervalMin) * 60_000);
  logger.mark('BOOT', `自动更新已启用：${config.update.remote}/${config.update.branch}；开机 ${bootDelay / 1000}s 后首次检查，之后每 ${everyMs / 60000} 分钟检查一次（可在「更新」页调整）`);

  // 开机先恢复"上次为升级而暂停"的下载
  void resumeAfterUpdate().catch(() => undefined);

  bootTimer = setTimeout(() => {
    bootTimer = null;
    void bootCheck();
  }, bootDelay);
  bootTimer.unref?.();

  interval = setInterval(() => void tickCheck(), everyMs);
  interval.unref?.();
}

export function stopUpdateWorker(): void {
  if (bootTimer) clearTimeout(bootTimer);
  if (interval) clearInterval(interval);
  bootTimer = null;
  interval = null;
}

/** 仅供测试：直接跑一次开机检查（跳过定时器） */
export const __testBootCheck = bootCheck;
export const __testTickCheck = tickCheck;
