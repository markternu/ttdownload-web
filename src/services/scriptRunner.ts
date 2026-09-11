/**
 * 修复脚本上传 / 执行（环境问题的远程修复通道）
 *
 * 用途：代码逻辑问题走 git push + `deploy.sh --update`；**系统环境问题**（缺包、权限、
 * systemd 配置、Node 版本…）则由开发者生成一个修复脚本，用户在本页面上传并一键执行，
 * 不必再 SSH 进去手工敲命令。
 *
 * 安全设计（这是「上传即 root 执行」，必须当危险功能对待）：
 *  - 默认**关闭**，必须在页面上显式开启（设置项 scriptUploadEnabled）
 *  - 配置了维护令牌（MAINTENANCE_TOKEN，默认取 ANDROID_TOKEN）时，上传/执行/删除都要带令牌
 *  - 上传后先在页面上**预览内容**，用户确认后才执行
 *  - 只接受文本 shell 脚本，大小 ≤ 1MB；落盘 0700，全部动作打 [MARK:SCRIPT_*] 日志
 *  - 执行有超时（默认 600s）、输出落盘、保留最近 20 份
 *  - 用 systemd-run 起独立瞬时单元执行：脚本里 `systemctl restart ttdownload-web`
 *    也不会把自己的执行进程一起干掉（不会死在服务重启上）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { getSettings, updateSettings } from './settings';
import { gitInfo } from './report';

const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_KEEP = 20;

export interface ScriptMeta {
  id: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  runCount: number;
  lastRun?: {
    startedAt: string;
    finishedAt: string | null;
    exitCode: number | null;
    timedOut: boolean;
    logPath: string;
    pid: number | null;
    via: 'systemd-run' | 'setsid';
  };
}

export interface ScriptItem extends ScriptMeta {
  running: boolean;
  logsUrl: string;
  fileUrl: string;
  statusUrl: string;
}

export function scriptsDir(): string {
  return path.join(config.dirs.state, 'scripts');
}

function ensureDir(): string {
  const dir = scriptsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const metaPath = (id: string): string => path.join(scriptsDir(), `${id}.json`);
const scriptPath = (id: string): string => path.join(scriptsDir(), `${id}.sh`);
const logPath = (id: string): string => path.join(scriptsDir(), `${id}.log`);
const wrapperPath = (id: string): string => path.join(scriptsDir(), `${id}.runner.sh`);

/** 是否允许上传/执行（默认关闭，可在网页开启） */
export function scriptExecEnabled(): boolean {
  return getSettings().scriptUploadEnabled === true;
}

/**
 * 维护令牌：优先 MAINTENANCE_TOKEN，其次 ANDROID_TOKEN；都为空则视为「不要求令牌」
 * （此时仅靠「显式开启」这一个开关保护，页面会给出醒目警告）
 */
export function maintenanceToken(): string {
  return String(process.env.MAINTENANCE_TOKEN ?? '').trim() || String(config.androidToken ?? '').trim();
}

export function tokenOk(provided: string | undefined): boolean {
  const expect = maintenanceToken();
  if (!expect) return true;
  const got = String(provided ?? '').trim();
  if (!got || got.length !== expect.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expect));
  } catch {
    return false;
  }
}

function readMeta(id: string): ScriptMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as ScriptMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: ScriptMeta): void {
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

/** systemd-run 的瞬时单元名（runScript 与状态判断必须一致） */
function unitName(id: string): string {
  return `ttdl-fix-${id.replace(/[^\w]/g, '')}`.slice(0, 60);
}

/** 瞬时单元是否还在跑（systemd-run 不会告诉我们 pid，只能问 systemd） */
function unitActive(id: string): boolean {
  try {
    execFileSync('systemctl', ['is-active', '--quiet', unitName(id)], { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runningNow(meta: ScriptMeta): boolean {
  const { finished } = exitCodeFromLog(meta.id);
  if (finished) return false;
  if (pidAlive(meta.lastRun?.pid ?? null)) return true;
  if (meta.lastRun?.via === 'systemd-run') return unitActive(meta.id);
  return false;
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 日志里有没有我们写的结束标记（拿到它就说明跑完了） */
function exitCodeFromLog(id: string): { exitCode: number | null; timedOut: boolean; finished: boolean } {
  try {
    const text = fs.readFileSync(logPath(id), 'utf8');
    const m = [...text.matchAll(/__EXIT_CODE=(\d+)/g)].pop();
    if (!m) return { exitCode: null, timedOut: false, finished: false };
    const code = Number(m[1]);
    return { exitCode: code, timedOut: code === 124, finished: true };
  } catch {
    return { exitCode: null, timedOut: false, finished: false };
  }
}

function toItem(meta: ScriptMeta): ScriptItem {
  const running = runningNow(meta);
  return {
    ...meta,
    running,
    statusUrl: `/api/system/scripts/${meta.id}`,
    logsUrl: `/api/system/scripts/${meta.id}/log`,
    fileUrl: `/api/system/scripts/${meta.id}/file`,
  };
}

export function listScripts(): ScriptItem[] {
  const dir = scriptsDir();
  let ids: string[] = [];
  try {
    ids = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''));
  } catch {
    return [];
  }
  return ids
    .map((id) => readMeta(id))
    .filter((m): m is ScriptMeta => !!m)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .map(toItem);
}

export function getScript(id: string): ScriptItem | null {
  const meta = readMeta(id);
  return meta ? toItem(meta) : null;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  item?: ScriptItem;
}

/** 保存上传的脚本（只接受文本 shell 脚本） */
export function saveScript(name: string, content: string): SaveResult {
  const text = content ?? '';
  if (!text.trim()) return { ok: false, error: '脚本内容为空' };
  if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) return { ok: false, error: '脚本过大（上限 1MB）' };
  if (text.includes('\u0000')) return { ok: false, error: '看起来是二进制文件，只支持文本 shell 脚本' };
  const safeName = path.basename(String(name || 'fix.sh')).replace(/[^\w.@+-]/g, '_') || 'fix.sh';
  // 只接受 .sh/.bash，或者内容带 shell shebang 的文本文件（避免误传其他类型文件）
  if (!/\.(sh|bash)$/i.test(safeName) && !/^#!\s*\S*\b(bash|sh)\b/.test(text.trimStart())) {
    return { ok: false, error: '只支持 .sh/.bash 脚本（或内容以 #!/bin/bash 开头的文件）' };
  }
  ensureDir();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(scriptPath(id), text, { mode: 0o700 });
  const meta: ScriptMeta = {
    id,
    name: safeName,
    sizeBytes: Buffer.byteLength(text),
    sha256,
    uploadedAt: new Date().toISOString(),
    runCount: 0,
  };
  writeMeta(meta);
  pruneOld();
  logger.child('script').mark('SCRIPT_UPLOAD', `已上传修复脚本 ${safeName}`, {
    id,
    sizeBytes: meta.sizeBytes,
    sha256,
    execEnabled: scriptExecEnabled(),
    tokenRequired: maintenanceToken().length > 0,
  });
  return { ok: true, item: toItem(meta) };
}

/** 读取脚本内容（页面预览用） */
export function readScript(id: string): { name: string; content: string } | null {
  const meta = readMeta(id);
  if (!meta) return null;
  try {
    return { name: meta.name, content: fs.readFileSync(scriptPath(id), 'utf8') };
  } catch {
    return null;
  }
}

export function readScriptLog(id: string, lines = 300): { content: string; total: number } {
  try {
    const text = fs.readFileSync(logPath(id), 'utf8');
    const all = text.split('\n');
    return { content: all.slice(-lines).join('\n'), total: all.length };
  } catch {
    return { content: '', total: 0 };
  }
}

export function scriptFilePath(id: string): string | null {
  const p = scriptPath(id);
  return fs.existsSync(p) ? p : null;
}

export function scriptLogPath(id: string): string | null {
  const p = logPath(id);
  return fs.existsSync(p) ? p : null;
}

/** 是否有 systemd-run（用它起独立单元，脚本重启本服务也不会被连带杀掉） */
let systemdRunCache: boolean | null = null;
function hasSystemdRun(): boolean {
  if (systemdRunCache !== null) return systemdRunCache;
  try {
    if (!fs.existsSync('/run/systemd/system')) {
      systemdRunCache = false;
      return false;
    }
    execFileSync('systemd-run', ['--version'], { timeout: 3000, stdio: 'ignore' });
    systemdRunCache = true;
  } catch {
    systemdRunCache = false;
  }
  return systemdRunCache;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  item?: ScriptItem;
  via?: 'systemd-run' | 'setsid';
}

export function runScript(id: string): RunResult {
  const meta = readMeta(id);
  if (!meta) return { ok: false, error: '脚本不存在' };
  if (!scriptExecEnabled()) return { ok: false, error: '修复脚本执行未开启（请先在页面上开启开关）' };
  if (!fs.existsSync(scriptPath(id))) return { ok: false, error: '脚本文件丢失，请重新上传' };
  if (meta.lastRun && !meta.lastRun.finishedAt && pidAlive(meta.lastRun.pid)) {
    return { ok: false, error: '该脚本上一次执行还在运行中，请等它结束（或下载日志查看进度）' };
  }

  ensureDir();
  const timeoutSec = Math.max(30, Math.min(7200, Number(getSettings().scriptRunTimeoutSec ?? 600)));
  const git = gitInfo();
  const versionLine = git ? `${git.shortCommit}${git.dirty ? '+dirty' : ''} (${git.branch})` : 'unknown';
  const log = logPath(id);
  const wrapper = wrapperPath(id);
  // 包装脚本：记录开始/结束与退出码，并用 timeout 兜底
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
# 由 ttdownload-web 生成：记录开始/结束/退出码，并在有 timeout 命令时加上超时保护
LOG=${JSON.stringify(log)}
SCRIPT=${JSON.stringify(scriptPath(id))}
NAME=${JSON.stringify(meta.name)}
ID=${JSON.stringify(id)}
TIMEOUT=${timeoutSec}
ts() { date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date; }
{
  echo "=== ttdownload-web 修复脚本开始 $(ts) ==="
  echo "脚本：$NAME（$ID）"
  echo "主机：$(hostname)  用户：$(id -un)  内核：$(uname -srm)"
  echo "超时：\${TIMEOUT}s  代码版本：${versionLine}"
  echo "---- 输出开始 ----"
} >> "$LOG"
STDBUF=""
command -v stdbuf >/dev/null 2>&1 && STDBUF="stdbuf -oL -eL"
if command -v timeout >/dev/null 2>&1; then
  $STDBUF timeout "$TIMEOUT" bash -x "$SCRIPT" >> "$LOG" 2>&1
else
  echo "(提示：系统没有 timeout 命令，本次执行无超时保护)" >> "$LOG"
  $STDBUF bash -x "$SCRIPT" >> "$LOG" 2>&1
fi
code=$?
{
  echo "---- 输出结束 ----"
  if [ "$code" = "124" ]; then echo "!!! 执行超时（\${TIMEOUT}s）已被强制结束"; fi
  echo "=== 结束 $(ts) 退出码=$code ==="
  echo "__EXIT_CODE=$code"
} >> "$LOG"
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(log, `[${new Date().toISOString()}] 已创建执行任务（${meta.name}）\n`, { mode: 0o600 });

  const via: 'systemd-run' | 'setsid' = hasSystemdRun() ? 'systemd-run' : 'setsid';
  let pid: number | null = null;
  try {
    if (via === 'systemd-run') {
      const unit = unitName(id);
      try {
        execFileSync('systemd-run', ['--unit', unit, '--collect', '--quiet', '/bin/bash', wrapper], {
          timeout: 15000,
          stdio: 'ignore',
        });
      } catch {
        // 老 systemd（<248）不支持 --collect：去掉重试一次
        execFileSync('systemd-run', ['--unit', unit, '--quiet', '/bin/bash', wrapper], { timeout: 15000, stdio: 'ignore' });
      }
      logger.child('script').mark('SCRIPT_RUN', `已通过 systemd-run 启动修复脚本（单元 ${unit}，服务重启也不会中断）`, {
        id,
        unit,
        logPath: log,
      });
    } else {
      const child = spawn('/bin/bash', [wrapper], { detached: true, stdio: 'ignore' });
      child.unref();
      pid = child.pid ?? null;
      logger.child('script').mark('SCRIPT_RUN', '已通过 setsid 分离启动修复脚本（无 systemd-run）', { id, pid, logPath: log });
    }
  } catch (e) {
    // systemd-run 失败则退回分离进程
    try {
      const child = spawn('/bin/bash', [wrapper], { detached: true, stdio: 'ignore' });
      child.unref();
      pid = child.pid ?? null;
      logger.child('script').warn(`[MARK:SCRIPT_RUN] systemd-run 启动失败（${(e as Error).message}），已退回分离进程运行`, { id, pid });
    } catch (e2) {
      logger.child('script').error(`[MARK:SCRIPT_RUN] 修复脚本启动失败: ${(e2 as Error).message}`, { id });
      return { ok: false, error: `启动失败：${(e2 as Error).message}` };
    }
  }

  meta.runCount += 1;
  meta.lastRun = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    logPath: log,
    pid,
    via,
  };
  writeMeta(meta);
  return { ok: true, item: toItem(meta), via };
}

/** 刷新运行状态（页面轮询时调用；跑完就把退出码写回 meta） */
export function refreshRun(id: string): ScriptItem | null {
  const meta = readMeta(id);
  if (!meta) return null;
  const { exitCode, timedOut, finished } = exitCodeFromLog(id);
  if (meta.lastRun && finished && meta.lastRun.finishedAt === null) {
    meta.lastRun.finishedAt = new Date().toISOString();
    meta.lastRun.exitCode = exitCode;
    meta.lastRun.timedOut = timedOut;
    writeMeta(meta);
    logger.child('script').mark('SCRIPT_RUN', `修复脚本执行结束（退出码 ${exitCode}${timedOut ? '，超时' : ''}）`, {
      id,
      name: meta.name,
      exitCode,
      timedOut,
    });
  }
  return toItem(meta);
}

export function deleteScript(id: string): boolean {
  const meta = readMeta(id);
  if (!meta) return false;
  if (meta.lastRun && !meta.lastRun.finishedAt && pidAlive(meta.lastRun.pid)) return false;
  for (const p of [metaPath(id), scriptPath(id), logPath(id), wrapperPath(id)]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
  logger.child('script').mark('SCRIPT_UPLOAD', `已删除修复脚本 ${meta.name}`, { id });
  return true;
}

function pruneOld(): void {
  const items = listScripts();
  for (const item of items.slice(MAX_KEEP)) {
    if (item.running) continue;
    try {
      for (const p of [metaPath(item.id), scriptPath(item.id), logPath(item.id), wrapperPath(item.id)]) {
        fs.rmSync(p, { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}

/** 页面状态汇总 */
export function scriptsOverview(): {
  enabled: boolean;
  tokenRequired: boolean;
  timeoutSec: number;
  allowlistHint: string;
  items: ScriptItem[];
} {
  const s = getSettings();
  return {
    enabled: scriptExecEnabled(),
    tokenRequired: maintenanceToken().length > 0,
    timeoutSec: Math.max(30, Math.min(7200, Number(s.scriptRunTimeoutSec ?? 600))),
    allowlistHint: '代码逻辑问题请走 git push + deploy.sh --update；这里只用于系统环境类修复脚本。',
    items: listScripts(),
  };
}

/** 开启/关闭（页面开关） */
export function setScriptExecEnabled(enabled: boolean): void {
  updateSettings({ scriptUploadEnabled: enabled });
  logger.child('script').mark('SCRIPT_UPLOAD', `修复脚本执行已${enabled ? '开启' : '关闭'}`, {
    enabled,
    tokenRequired: maintenanceToken().length > 0,
  });
}
