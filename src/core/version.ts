/**
 * 版本号（SemVer）工具 —— 项目版本规范见 docs/VERSIONING.md。
 *
 * 规范一句话：**`v主版本.次版本.修订号`（MAJOR.MINOR.PATCH）**，三位都必须有，
 * 含义固定：
 *   · MAJOR  不兼容变更：数据结构/配置需要迁移，或老机器必须人工做点什么才能升（例如换 Node 大版本）
 *   · MINOR  向后兼容的新功能（新页面、新接口、新选项）
 *   · PATCH  向后兼容的修 bug / 性能 / 文档
 *
 * 版本的**唯一来源**是 package.json 的 `version` 字段（config.version 读的就是它），
 * 不允许在别处再写死一份 —— 两份版本号必然会不一致。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** 原始串（可能带 v 前缀/预发布后缀，用于展示） */
  raw: string;
  /** 预发布后缀（`1.2.3-beta.1` 里的 `beta.1`），正式版为空串 */
  prerelease: string;
}

/** 解析 `1.2.3` / `v1.2.3` / `1.2.3-beta.1`；解析不了返回 null（绝不猜）。 */
export function parseSemVer(input: unknown): SemVer | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
    raw,
  };
}

/** a > b → 1；a == b → 0；a < b → -1。解析失败的版本号一律排最后（视为最小）。 */
export function compareSemVer(a: unknown, b: unknown): number {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  if (x.major !== y.major) return x.major > y.major ? 1 : -1;
  if (x.minor !== y.minor) return x.minor > y.minor ? 1 : -1;
  if (x.patch !== y.patch) return x.patch > y.patch ? 1 : -1;
  // 预发布版本 < 同号正式版（SemVer 规范）
  if (x.prerelease === y.prerelease) return 0;
  if (!x.prerelease) return 1;
  if (!y.prerelease) return -1;
  return x.prerelease > y.prerelease ? 1 : -1;
}

/** to 相对 from 是不是「大版本升级」（可能不兼容，页面要提醒用户）。 */
export function isMajorBump(from: unknown, to: unknown): boolean {
  const a = parseSemVer(from);
  const b = parseSemVer(to);
  if (!a || !b) return false;
  return b.major > a.major;
}

/** 从 package.json 读版本号（读不到返回 null，调用方决定怎么兜底）。 */
export function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    const v = parseSemVer(pkg.version);
    return v ? `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}` : null;
  } catch {
    return null;
  }
}

/** 项目根目录（dist/core/*.js 与 src/core/*.ts 都往上两级就是仓库根）。 */
export function projectRoot(): string {
  return path.resolve(__dirname, '..', '..');
}
