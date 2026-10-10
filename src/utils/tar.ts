/**
 * 极简 TAR 打包（ustar 格式，**流式、不落盘**）。
 *
 * 为什么要它：浏览器的"同一站点同时下载数"是有限制的（Chrome 大约 6 个），
 * 用户在「文件」页一个一个点下载，点到第 7 个就得排队等前面的下完 —— 这不是我们
 * 服务端的限制，而是浏览器连接池的限制，加多少并发都绕不过去。
 * 唯一真正有效的办法是**把多个文件打成一个包，一次下载**（一个连接）。
 *
 * 为什么用 tar 而不是 zip：
 *   · zip 需要随机访问/中央目录 → 必须先写一个临时文件（下 50GB 就要再占 50GB 磁盘，
 *     而磁盘紧张正是这个项目常见状态）；tar 可以纯流式，**一个字节都不落盘**；
 *   · 这些成品本身是加密数据（不可压缩），zip 的压缩也没意义；
 *   · Windows 10+ 自带 tar 命令，macOS/Linux 天生支持。
 */

/** 512 字节的 ustar 头 */
export function tarHeader(name: string, size: number, mtimeMs = Date.now()): Buffer {
  const header = Buffer.alloc(512);
  // 文件名（100 字节）+ 目录前缀（155 字节）：超长就从前缀处切，切不开就截断（保住扩展名）
  let base = String(name || 'file').replace(/^\/+/, '').replace(/[\u0000]/g, '');
  let prefix = '';
  const bytes = Buffer.byteLength(base, 'utf8');
  if (bytes > 100) {
    const cut = base.lastIndexOf('/');
    if (cut > 0) {
      prefix = base.slice(0, cut).slice(0, 155);
      base = base.slice(cut + 1);
    }
    if (Buffer.byteLength(base, 'utf8') > 100) {
      // 极端情况：单段名字就超 100 字节 → 保留扩展名截断
      const dot = base.lastIndexOf('.');
      const ext = dot > 0 ? base.slice(dot) : '';
      base = Buffer.from(base, 'utf8').subarray(0, Math.max(1, 100 - Buffer.byteLength(ext, 'utf8'))).toString('utf8') + ext;
    }
  }
  header.write(base, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);        // mode
  writeOctal(header, 108, 8, 0);            // uid
  writeOctal(header, 116, 8, 0);            // gid
  writeOctal(header, 124, 12, size);        // size
  writeOctal(header, 136, 12, Math.floor(mtimeMs / 1000)); // mtime
  header.write('        ', 148, 8, 'latin1'); // checksum 先填空格
  header.write('0', 156, 1, 'latin1');      // typeflag: 0 = 普通文件
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');     // ustar version
  header.write(prefix.slice(0, 155), 345, 155, 'utf8');
  // 校验和 = 头全部字节相加（空格处按空格算）
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const s = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0').slice(0, length - 1);
  buf.write(s, offset, length - 1, 'latin1');
  buf.write('\0', offset + length - 1, 1, 'latin1');
}

/** 文件数据后面的填充（tar 要求每个文件补齐到 512 字节的整数倍） */
export function tarPadding(size: number): number {
  return (512 - (size % 512)) % 512;
}

/** 归档结束标记：两个全零块 */
export function tarEnd(): Buffer {
  return Buffer.alloc(1024);
}
