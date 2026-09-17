/**
 * BT 日志脱敏。
 *
 * 用户要求：**BT 相关日志里不能出现种子名、也不能出现下载内容（文件）的名字**
 * —— 这些对排查逻辑没有帮助，但一旦把日志发出来就泄露了内容。
 * 所以日志里一律用"文件1 / 文件2 / （名称已隐藏）"这种匿名标签代替真实名字；
 * 路径只保留目录、隐藏最后一段。
 *
 * 注意：数据库/界面里的真实标题照旧（用户自己要看到），只有**日志**脱敏。
 */

export const HIDDEN_NAME = '（名称已隐藏）';

/** 第 i 个文件（0 起）的匿名标签，同一个任务内稳定，便于对着日志排查 */
export function anonFile(index: number): string {
  const n = Number(index);
  return `文件${Number.isFinite(n) ? n + 1 : '?'}`;
}

/** 任何名字 -> 统一占位（不保留长度、不保留首尾字符，避免任何泄露） */
export function hideName(_value?: unknown): string {
  return HIDDEN_NAME;
}

/** 路径只留目录，隐藏最后一段（防止 /var/lib/transmission/downloads/<种子名> 这种） */
export function hidePath(value?: unknown): string {
  const s = String(value ?? '');
  if (!s) return HIDDEN_NAME;
  const i = s.lastIndexOf('/');
  if (i > 0) return `${s.slice(0, i)}/${HIDDEN_NAME}`;
  return HIDDEN_NAME;
}

/**
 * 深层路径隐藏：**一个文件的路径里可能有两段名字** ——
 * `/…/transmission/downloads/<种子名>/<内容文件名>.mp4`。
 * hidePath 只砍最后一段，种子名还在，所以"文件级"路径要用这个：
 *   · 认得出是 transmission 的下载/未完成目录 → 只留到该目录，后面全隐藏
 *   · 其它路径 → 只留前两段（如 /mnt/data），后面全隐藏
 * 宁可少留一点排查线索，也不能泄露内容名。
 */
const BT_DIR_MARKERS = ['/transmission/downloads/', '/transmission/incomplete/'];

export function hidePathDeep(value?: unknown): string {
  const s = String(value ?? '');
  if (!s) return HIDDEN_NAME;
  for (const marker of BT_DIR_MARKERS) {
    const i = s.indexOf(marker);
    if (i >= 0) return `${s.slice(0, i + marker.length)}${HIDDEN_NAME}`;
  }
  const parts = s.split(/[/\\]+/).filter(Boolean);
  if (parts.length <= 2) return HIDDEN_NAME;
  return `/${parts[0]}/${parts[1]}/…/${HIDDEN_NAME}`;
}

/** 一段文本里若混进了名字/路径，用它兜底（把可疑的引号内容换成占位） */
export function hideText(value: unknown): string {
  return String(value ?? '').replace(/([/\\][^\s/\\]+)/g, `/${HIDDEN_NAME}`);
}
