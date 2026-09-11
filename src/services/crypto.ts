import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../core/config';
import { logger } from '../core/logger';

/**
 * 与老脚本 (video_auto.sh / all1.sh) 完全兼容的加密与命名工具：
 *  - V-L-T 尾部标记：原始文件名 + 4字节大端长度 + 100字节 "FKY996"+NUL
 *  - AES-256-CBC：key = sha256(password) hex，iv = md5(password) hex
 *  - 命名：随机3字母前缀 + 递增序号（禁用 fom），序号文件 state/indexFXY
 */

const VIDEO_AUTO_PASSWORD_FALLBACK = 'ec3e458fcde2582e079f19368abc780f';

export function passwordOf(pwd?: string): string {
  return pwd && pwd.length > 0 ? pwd : config.encryptPassword || VIDEO_AUTO_PASSWORD_FALLBACK;
}

/** 生成 AES key/iv（hex 字符串，供 openssl -K/-iv 使用） */
export function deriveKeyIv(pwd: string): { key: string; iv: string } {
  const key = crypto.createHash('sha256').update(pwd, 'utf8').digest('hex');
  const iv = crypto.createHash('md5').update(pwd, 'utf8').digest('hex');
  return { key, iv };
}

/** 文件末尾是否是 FKY996 标记 */
export function hasVltMarker(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 104) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(100);
      fs.readSync(fd, buf, 0, 100, st.size - 100);
      return buf.toString('latin1').replace(/\0+$/g, '') === 'FKY996';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 追加 V-L-T 标记（已存在则跳过） */
export function markVlt(file: string, originalName: string): boolean {
  if (hasVltMarker(file)) return true;
  const nameBuf = Buffer.from(originalName, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(nameBuf.length, 0);
  const typeBuf = Buffer.alloc(100);
  typeBuf.write('FKY996', 0, 'latin1');
  try {
    fs.appendFileSync(file, Buffer.concat([nameBuf, lenBuf, typeBuf]));
    return true;
  } catch (e) {
    logger.child('crypto').error(`[MARK:ENCRYPT] 写入 V-L-T 标记失败 ${file}: ${(e as Error).message}`);
    return false;
  }
}

/** 读取 V-L-T 标记中的原始文件名（未加密文件用；加密后需先解密） */
export function readVltOriginalName(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (st.size < 104) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const tail = Buffer.alloc(4);
      fs.readSync(fd, tail, 0, 4, st.size - 104);
      const nameLen = tail.readUInt32BE(0);
      if (nameLen <= 0 || nameLen > st.size - 104) return null;
      const nameBuf = Buffer.alloc(nameLen);
      fs.readSync(fd, nameBuf, 0, nameLen, st.size - 104 - nameLen);
      return nameBuf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 文件名安全化（去掉路径分隔符等） */
export function safeFileName(name: string): string {
  return String(name || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 180) || 'file';
}

/* ------------------------------------------------------------------ */
/* 命名：随机3字母前缀 + 递增序号（与老脚本共用 state/indexFXY）        */
/* ------------------------------------------------------------------ */

let namePrefix = '';

export function initNamePrefix(forcePrefix?: string): string {
  if (forcePrefix) {
    namePrefix = forcePrefix;
    return namePrefix;
  }
  if (namePrefix) return namePrefix;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let p = '';
  do {
    p = '';
    for (let i = 0; i < 3; i += 1) p += letters[crypto.randomInt(0, 26)];
  } while (p === 'fom');
  namePrefix = p;
  return namePrefix;
}

export function currentNamePrefix(): string {
  return namePrefix || initNamePrefix();
}

/** 取下一个序号名（如 oqq12），序号文件与老脚本共用 */
export function nextPublishName(): string {
  const prefix = currentNamePrefix();
  const indexFile = path.join(config.dirs.state, 'indexFXY');
  let idx = 1;
  try {
    const raw = fs.readFileSync(indexFile, 'utf8').trim();
    if (/^\d+$/.test(raw)) idx = Number.parseInt(raw, 10);
  } catch {
    /* 文件不存在，从 1 开始 */
  }
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `${prefix}${idx}`;
    const exists = fs.existsSync(path.join(config.dirs.consumer, candidate)) || fs.existsSync(path.join(config.dirs.archiveReady, candidate));
    idx += 1;
    if (!exists) {
      try {
        fs.writeFileSync(indexFile, String(idx));
      } catch (e) {
        logger.child('crypto').warn(`[MARK:ENCRYPT] 写序号文件失败: ${(e as Error).message}`);
      }
      return candidate;
    }
  }
  return `${prefix}${Date.now()}`;
}

/* ------------------------------------------------------------------ */
/* 加密（openssl 子进程，参数与老脚本逐字节一致）                        */
/* ------------------------------------------------------------------ */

export interface EncryptResult {
  ok: boolean;
  output?: string;
  error?: string;
}

/** 加密单个文件 -> 输出 <file>.data（调用方负责后续去后缀/移动） */
export async function encryptFile(
  input: string,
  output: string,
  pwd: string,
  opensslBin: string = config.bins.openssl,
): Promise<EncryptResult> {
  const { key, iv } = deriveKeyIv(passwordOf(pwd));
  return new Promise<EncryptResult>((resolve) => {
    const args = ['enc', '-aes-256-cbc', '-K', key, '-iv', iv, '-in', input, '-out', output];
    const t0 = Date.now();
    const scoped = logger.child('crypto');
    scoped.mark('PROC_SPAWN', 'AES 加密文件', { bin: opensslBin, in: input, out: output, keyLen: key.length });
    const child = spawn(opensslBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      scoped.error(`[MARK:ENCRYPT] openssl 启动失败: ${e.message}`, { bin: opensslBin });
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) {
        scoped.mark('ENCRYPT', `加密完成（${Date.now() - t0}ms）`, {
          in: path.basename(input),
          out: path.basename(output),
          sizeBytes: fs.statSync(output).size,
        });
        resolve({ ok: true, output });
      } else {
        try {
          fs.rmSync(output, { force: true });
        } catch {
          /* ignore */
        }
        scoped.error(`[MARK:ENCRYPT] 加密失败 code=${code}: ${stderr.slice(-300)}`, { in: input, out: output });
        resolve({ ok: false, error: stderr || `openssl 退出码 ${code}` });
      }
    });
  });
}

/** 去掉文件名后缀：oqq1.data -> oqq1（目标已存在时加 _strip_N） */
export function stripExtension(file: string): string {
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (!base.includes('.')) return file;
  let dest = path.join(dir, base.slice(0, base.lastIndexOf('.')));
  if (dest === file) return file;
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base.slice(0, base.lastIndexOf('.'))}_strip_${n}`);
    n += 1;
  }
  fs.renameSync(file, dest);
  return dest;
}
