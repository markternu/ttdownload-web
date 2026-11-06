/**
 * 共享的「解密产物」。
 *
 * 播放 和 「下载原始文件」解的是**同一份加密归档**，产物完全可以共用 ——
 * 所以这里做一份**一一对应**的缓存：`state/restored/dec_<fileId>.bin`
 * （旁边 `dec_<fileId>.json` 记原始名），并在 restored_files 表里登记
 * （kind='decrypted', source_file_id=fileId）。
 *
 * 谁先点（播放 / 下载原始文件）谁触发解密，另一个直接用现成的，**绝不重复解密**。
 * 产物跟着【还原文件目录】的 4 小时规则走（过期由 sweepRestored 清理）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../core/config';
import { filesRepo, restoredRepo } from '../core/db';
import { logger } from '../core/logger';
import { deriveKeyIv, passwordOf, readVltOriginalName } from './crypto';
import { ensureRestoredDir, registerRestored, restoredDir } from './restored';

const scoped = logger.child('decrypted');

export interface DecryptedPayload {
  path: string;
  originalName: string;
  sizeBytes: number;
  /** true = 复用了已有的解密结果（没有重新解密） */
  reused: boolean;
}

/** 固定的共享产物路径（fileId 与加密文件一一对应，内容不可变） */
export function decryptedPath(fileId: number): string {
  return path.join(restoredDir(), `dec_${fileId}.bin`);
}

function metaPath(fileId: number): string {
  return path.join(restoredDir(), `dec_${fileId}.json`);
}

function readMeta(fileId: number): { originalName: string } | null {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(fileId), 'utf8')) as { originalName?: unknown };
    if (typeof m.originalName === 'string' && m.originalName) return { originalName: m.originalName };
    return null;
  } catch {
    return null;
  }
}

/** 找一份可复用的解密产物：文件在 + 元数据在 + 登记未过期 */
export function findDecrypted(fileId: number, now = Date.now()): DecryptedPayload | null {
  const p = decryptedPath(fileId);
  const meta = readMeta(fileId);
  if (!meta) return null;
  try {
    if (!fs.statSync(p).isFile()) return null;
  } catch {
    return null;
  }
  const row = restoredRepo.list().find((r) => r.kind === 'decrypted' && Number(r.source_file_id) === fileId);
  if (!row || row.expires_at <= now) return null;
  const sizeBytes = fs.statSync(p).size;
  return { path: p, originalName: meta.originalName, sizeBytes, reused: true };
}

function decryptTo(src: string, out: string): Promise<{ ok: boolean; error?: string }> {
  const pwd = passwordOf();
  const { key, iv } = deriveKeyIv(pwd);
  return new Promise((resolve) => {
    const child = spawn(config.bins.openssl, ['enc', '-d', '-aes-256-cbc', '-K', key, '-iv', iv, '-in', src, '-out', out], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => resolve({ ok: false, error: `openssl 启动失败：${e.message}` }));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) resolve({ ok: true });
      else resolve({ ok: false, error: `解密失败（退出码 ${code}）：${stderr.trim().slice(-200)}` });
    });
  });
}

/**
 * 确保有一份可用的解密产物：有就复用，没有才解密。
 * 播放 / 下载原始文件 都调这里 → 两者共用同一份，不重复解密。
 */
export async function ensureDecrypted(fileId: number): Promise<{ ok: true; payload: DecryptedPayload } | { ok: false; error: string }> {
  const cached = findDecrypted(fileId);
  if (cached) {
    scoped.mark('DECRYPTED', `复用已解密的共享产物 #${fileId}（不再重复解密）`);
    return { ok: true, payload: cached };
  }

  const row = filesRepo.get(fileId);
  if (!row) return { ok: false, error: '文件记录不存在' };
  if (!fs.existsSync(row.path)) return { ok: false, error: '磁盘上的加密文件已不存在（可能已被取走）' };

  ensureRestoredDir();
  const out = decryptedPath(fileId);
  const tmp = `${out}.tmp_${process.pid}_${Date.now()}`;
  const dec = await decryptTo(row.path, tmp);
  if (!dec.ok) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: dec.error ?? '解密失败' };
  }

  const name = readVltOriginalName(tmp);
  if (!name) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: '解密结果里没有 FKY996 标记（文件可能不是本工具加密的，或密码不对）' };
  }
  const contentLen = fs.statSync(tmp).size - 104 - Buffer.byteLength(name, 'utf8');
  if (contentLen <= 0) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: '解密结果长度异常，文件可能已损坏' };
  }
  fs.truncateSync(tmp, contentLen);
  fs.renameSync(tmp, out);
  fs.writeFileSync(metaPath(fileId), JSON.stringify({ originalName: name }));
  registerRestored({ path: out, kind: 'decrypted', sourceFileId: fileId, sizeBytes: contentLen, readyAt: Date.now() });
  scoped.mark('DECRYPTED', `解密完成（共享产物）#${fileId} → ${name}（${(contentLen / 1024 ** 2).toFixed(1)} MiB）`);
  return { ok: true, payload: { path: out, originalName: name, sizeBytes: contentLen, reused: false } };
}
