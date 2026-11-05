/**
 * 文件名隐私开关：设置页「眼睛」按钮控制。
 *
 * 需求：从 v1.15 起，**所有页面默认不显示下载文件的原始名字**，统一显示 `****`；
 * 只有在设置页点「眼睛」显示后才看得到。
 *
 * 做法：在 API 出口把用户可见的 `name` / `title` 字段替换成 `****`（不是前端遮罩，
 * 隐藏时真实名字根本不下发到浏览器）。后端逻辑（调度/归档/播放）仍然用真实名字，
 * 因为它们在**下发之前**就已经用完。
 */

import { getSettings } from './settings';

/** 隐藏时显示的占位符 */
export const MASKED_NAME = '****';

/** 当前是否允许显示下载文件的原始名字 */
export function showFileNames(): boolean {
  try {
    return getSettings().showFileNames === true;
  } catch {
    // 设置还没就绪（极少见）→ 按"隐藏"处理（隐私优先）
    return false;
  }
}

/** 单个名字 */
export function maskName<T extends string | null | undefined>(name: T): T | string {
  if (name === null || name === undefined || name === '') return name as T;
  return showFileNames() ? name : MASKED_NAME;
}

/** 列表：把指定字段换成 ****（未开启显示时；空值不动） */
export function maskFields<T extends Record<string, unknown>>(rows: T[], fields: string[]): T[] {
  if (showFileNames()) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const f of fields) {
      if (f in out && out[f] !== null && out[f] !== undefined && out[f] !== '') out[f] = MASKED_NAME;
    }
    return out as T;
  });
}

/** 单个对象（详情接口用） */
export function maskOne<T extends Record<string, unknown>>(row: T | null | undefined, fields: string[]): T | null | undefined {
  if (!row || showFileNames()) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (f in out && out[f] !== null && out[f] !== undefined && out[f] !== '') out[f] = MASKED_NAME;
  }
  return out as T;
}
