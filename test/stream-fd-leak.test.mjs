/**
 * 【血案回归】发文件时客户端中途断开 → 读流必须被销毁（否则 fd 泄漏）
 *
 * 用户报：手机下完并上报后，成品文件在服务器上确实没了（网页也显示"服务器已删除"），
 * 但 `df` 的可用空间不回来。Linux 上这几乎只有一个原因：**inode 仍被进程引用**
 * （文件被 unlink 了，但还有打开的 fd），块就不会归还。
 *
 * 根因：以前直接 `fs.createReadStream(path).pipe(res)`。手机端 aria2 会开多条 Range
 * 连接、拿到需要的分片后主动放弃多余连接；`res` 被销毁时 `pipe()` **不会**销毁源读流
 * → fd 一直挂着。改用 pipeline() + close 兜底销毁后，客户端一走 fd 立刻释放。
 *
 * 注意：只能在 Linux 上观察（/proc/<pid>/fd 的软链会带 " (deleted)"）；其它平台跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const isLinux = process.platform === 'linux';
const { streamFileTo } = await import('../dist/utils/http.js');

/** 当前进程里还开着、且指向这个文件的 fd 数（Linux） */
function openFdsFor(file) {
  const dir = '/proc/self/fd';
  let n = 0;
  for (const entry of fs.readdirSync(dir)) {
    try {
      const target = fs.readlinkSync(path.join(dir, entry));
      if (target.includes(file)) n += 1;
    } catch {
      /* fd 可能刚好关了 */
    }
  }
  return n;
}

test('【血案回归】客户端中途断开后，被删文件的 fd 必须已经释放（否则空间回不来）', { skip: isLinux ? false : '只在 Linux 上能观察 /proc/<pid>/fd' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-fdleak-'));
  const file = path.join(dir, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 7)); // 16MB，够大，下载到一半断开

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    streamFileTo(res, file);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 发一个请求，读一点点就**粗暴断开**（模拟 aria2 放弃多余连接）
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let got = 0;
      sock.on('data', (d) => {
        got += d.length;
        if (got > 64 * 1024) sock.destroy(); // 拿到 64KB 就断
      });
      sock.on('close', resolve);
      sock.on('error', resolve);
    });

    // 给服务端一点时间处理断开
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(
      openFdsFor(file),
      0,
      '客户端断开后不该还有 fd 指着这个文件（否则 unlink 后空间不释放，df 看不到回血）',
    );

    // 真删掉它：删得掉、且再写一个同尺寸文件（能写满说明块真的回来了）
    fs.rmSync(file);
    const again = path.join(dir, 'again.bin');
    fs.writeFileSync(again, Buffer.alloc(16 * 1024 * 1024, 7));
    assert.equal(fs.existsSync(again), true);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
