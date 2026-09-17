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

/** 一段文本里若混进了名字/路径，用它兜底（把可疑的引号内容换成占位） */
export function hideText(value: unknown): string {
  return String(value ?? '').replace(/([/\\][^\s/\\]+)/g, `/${HIDDEN_NAME}`);
}
