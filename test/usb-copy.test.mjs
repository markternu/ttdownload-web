/**
 * 成品拷贝到 U 盘：状态 + 断电恢复
 *   · 拷贝中 / 已在 U 盘（DB 的 on_usb）
 *   · 断电场景：只留 .part（清掉重搬）/ rename 完但没写库（认领）/ 写库完但没删源（不重复搬）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

// 限速 2MB/s、文件间不等待：既验证限速，又不让用例太慢
const root = setupRuntime({ env: { USB_COPY_RATE_MBPS: '2', USB_COPY_PAUSE_MS: '0' } });
const { filesRepo } = await import('../dist/core/db.js');
const { config } = await import('../dist/core/config.js');
const { offloadToDir, reconcileUsbCopies, cleanupPartials, usbCopyStatus, USB_COPY_BOOT } = await import('../dist/services/usbMount.js');

const usbDir = path.join(root, 'fake-usb', 'ttdownload', 'xiaofeizhe_downd');
const sdDir = config.dirs.consumer;

function addFile(name, content = 'encrypted-bytes') {
  fs.mkdirSync(sdDir, { recursive: true });
  const p = path.join(sdDir, name);
  fs.writeFileSync(p, content);
  const id = filesRepo.add({ taskId: null, name, title: name, module: 'aria2', sizeBytes: content.length, path: p });
  return { id, p };
}

test('拷贝到 U 盘：文件搬过去、记录标 on_usb、源文件删除', async () => {
  const a = addFile('usb-a.bin', 'aaaa');
  const b = addFile('usb-b.bin', 'bbbb');
  fs.mkdirSync(usbDir, { recursive: true });

  const r = await offloadToDir(usbDir);
  assert.ok(r.moved >= 2, `应至少搬 2 个，实际 ${r.moved}`);

  for (const f of [a, b]) {
    const row = filesRepo.get(f.id);
    assert.equal(row.on_usb, 1, '记录要标成已在 U 盘');
    assert.ok(row.path.startsWith(usbDir), '记录路径要指向 U 盘');
    assert.equal(fs.existsSync(row.path), true, 'U 盘上要有这个文件');
    assert.equal(fs.existsSync(f.p), false, '源文件要删掉');
    assert.equal(usbCopyStatus(f.id), null, '成功后不再有拷贝状态');
  }

  // 幂等：再跑一次不该重复搬
  const r2 = await offloadToDir(usbDir);
  assert.equal(r2.moved, 0);
});

test('断电恢复①：rename 完但没写库 → 巡检认领 U 盘上的完整文件', () => {
  // 源路径已不存在（rename 后源被删/断电），U 盘上有完整文件，但 DB 还指着 SD
  const ghostPath = path.join(sdDir, 'usb-ghost.bin');
  const id = filesRepo.add({ taskId: null, name: 'usb-ghost.bin', title: 'ghost', module: 'aria2', sizeBytes: 8, path: ghostPath });
  fs.mkdirSync(usbDir, { recursive: true });
  fs.writeFileSync(path.join(usbDir, 'usb-ghost.bin'), 'complete');

  const fixed = reconcileUsbCopies(usbDir);
  assert.ok(fixed >= 1);
  const row = filesRepo.get(id);
  assert.equal(row.on_usb, 1);
  assert.equal(row.path, path.join(usbDir, 'usb-ghost.bin'));
});

test('断电恢复②：没写完的 .part 要被清掉（完整文件保留）', () => {
  fs.mkdirSync(usbDir, { recursive: true });
  fs.writeFileSync(path.join(usbDir, 'half.bin.part'), 'partial');
  fs.writeFileSync(path.join(usbDir, 'full.bin'), 'complete');
  const removed = cleanupPartials(usbDir);
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(path.join(usbDir, 'half.bin.part')), false, '.part 要清掉');
  assert.equal(fs.existsSync(path.join(usbDir, 'full.bin')), true, '完整文件不能动');
});

test('断电恢复③：写库了但源没删掉 → 不重复搬（两边都在也不重复）', async () => {
  const p = path.join(sdDir, 'usb-both.bin');
  fs.writeFileSync(p, 'data');
  const id = filesRepo.add({ taskId: null, name: 'usb-both.bin', title: 'both', module: 'aria2', sizeBytes: 4, path: p });
  // 模拟"记录已在 U 盘，但源文件还残留"
  filesRepo.markOnUsb(id, path.join(usbDir, 'usb-both.bin'));
  fs.writeFileSync(path.join(usbDir, 'usb-both.bin'), 'data');

  const r = await offloadToDir(usbDir);
  assert.equal(r.moved, 0, 'on_usb=1 的文件不能重复搬');
  assert.equal(fs.existsSync(p), true, '残留源文件不归这里处理（由垃圾扫描报告）');
});

test('拷贝限速：几十 GB 全速会打满 I/O，限速后按速率慢慢搬（不卡系统）', async () => {
  // 1 MiB @ 2MB/s ≈ 0.5s
  const big = addFile('usb-big.bin', 'x'.repeat(1024 * 1024));
  fs.mkdirSync(usbDir, { recursive: true });
  const t0 = Date.now();
  const r = await offloadToDir(usbDir);
  const ms = Date.now() - t0;
  assert.ok(r.moved >= 1, '要搬过去');
  assert.ok(ms >= 300, `限速应该让 1MiB@2MB/s 至少花几百毫秒，实际 ${ms}ms`);
  assert.ok(ms < 5000, `也不能慢到离谱，实际 ${ms}ms`);
  const row = filesRepo.get(big.id);
  assert.equal(row.on_usb, 1);
  assert.equal(fs.existsSync(row.path), true);
});

test('旧 /media 残留：记录说"在U盘"但路径不在当前U盘目录 → 自动搬到真U盘，拷完才删SD那份', async () => {
  // 模拟 /media/mypi/upo 残留：文件在 SD 上，不在消费者目录，也不在当前 U 盘目录
  const leftoverDir = path.join(root, 'media-leftover', 'ttdownload', 'xiaofeizhe_downd');
  fs.mkdirSync(leftoverDir, { recursive: true });
  const leftover = path.join(leftoverDir, 'stale-file.bin');
  fs.writeFileSync(leftover, 'stale-bytes');
  const id = filesRepo.add({ taskId: null, name: 'stale-file.bin', title: 'stale', module: 'aria2', sizeBytes: 11, path: leftover });
  filesRepo.markOnUsb(id, leftover); // 记录错误地标成"已在U盘"

  const fixed = reconcileUsbCopies(usbDir);
  assert.ok(fixed >= 1, '要识别出路径不在当前 U 盘目录');
  assert.equal(filesRepo.get(id).on_usb, 0, '要标回待拷贝');

  const r = await offloadToDir(usbDir);
  assert.ok(r.moved >= 1);
  const row = filesRepo.get(id);
  assert.equal(row.on_usb, 1);
  assert.ok(row.path.startsWith(usbDir), '记录要指向真 U 盘');
  assert.equal(fs.existsSync(row.path), true, '文件要真的在 U 盘');
  assert.equal(fs.existsSync(leftover), false, '拷完才删 SD 上的残留');
});

test('U盘已有同名同大小文件：不重复拷，直接改记录并删SD源', async () => {
  const p = path.join(sdDir, 'already-there.bin');
  fs.writeFileSync(p, 'same-content');
  const id = filesRepo.add({ taskId: null, name: 'already-there.bin', title: 'at', module: 'aria2', sizeBytes: 12, path: p });
  fs.mkdirSync(usbDir, { recursive: true });
  fs.writeFileSync(path.join(usbDir, 'already-there.bin'), 'same-content');

  const r = await offloadToDir(usbDir);
  assert.ok(r.moved >= 1);
  const row = filesRepo.get(id);
  assert.equal(row.on_usb, 1);
  assert.equal(row.path, path.join(usbDir, 'already-there.bin'));
  assert.equal(fs.existsSync(p), false, 'SD 源可以安全删除（U 盘已有完整同名文件）');
});

test('断点续传：同一进程的 .part 从断点继续，最终内容和源一致', async () => {
  const content = 'A'.repeat(1024 * 1024);
  const p = path.join(sdDir, 'resume.bin');
  fs.writeFileSync(p, content);
  const id = filesRepo.add({ taskId: null, name: 'resume.bin', title: 'resume', module: 'aria2', sizeBytes: content.length, path: p });

  fs.mkdirSync(usbDir, { recursive: true });
  const part = path.join(usbDir, 'resume.bin.part');
  fs.writeFileSync(part, content.slice(0, 512 * 1024));
  const st = fs.statSync(p);
  fs.writeFileSync(`${part}.meta`, JSON.stringify({ src: p, size: st.size, mtimeMs: st.mtimeMs, boot: USB_COPY_BOOT }));

  const r = await offloadToDir(usbDir);
  assert.ok(r.moved >= 1);
  assert.equal(fs.readFileSync(path.join(usbDir, 'resume.bin'), 'utf8'), content, '续传后内容必须完整');
  assert.equal(filesRepo.get(id).on_usb, 1);
});

test('断电重启后的 .part 不续传（防止把没刷盘的半截数据拼进去）', async () => {
  const content = 'B'.repeat(1024 * 1024);
  const p = path.join(sdDir, 'stale-part.bin');
  fs.writeFileSync(p, content);
  filesRepo.add({ taskId: null, name: 'stale-part.bin', title: 'sp', module: 'aria2', sizeBytes: content.length, path: p });

  fs.mkdirSync(usbDir, { recursive: true });
  const part = path.join(usbDir, 'stale-part.bin.part');
  fs.writeFileSync(part, 'X'.repeat(512 * 1024));
  const st = fs.statSync(p);
  fs.writeFileSync(`${part}.meta`, JSON.stringify({ src: p, size: st.size, mtimeMs: st.mtimeMs, boot: 'old-boot' }));

  const r = await offloadToDir(usbDir);
  assert.ok(r.moved >= 1);
  assert.equal(fs.readFileSync(path.join(usbDir, 'stale-part.bin'), 'utf8'), content, '旧 .part 必须丢弃、从头拷');
});

test('半截脏数据（尾部对不上）→ 丢弃 .part 从头拷', async () => {
  const content = 'C'.repeat(1024 * 1024);
  const p = path.join(sdDir, 'dirty-part.bin');
  fs.writeFileSync(p, content);
  filesRepo.add({ taskId: null, name: 'dirty-part.bin', title: 'dp', module: 'aria2', sizeBytes: content.length, path: p });

  fs.mkdirSync(usbDir, { recursive: true });
  const part = path.join(usbDir, 'dirty-part.bin.part');
  // 前半段是对的，但尾部内容被写坏（模拟没刷盘/写错误）
  const broken = Buffer.from(content.slice(0, 600 * 1024));
  broken.fill(0x00, 500 * 1024);
  fs.writeFileSync(part, broken);
  const st = fs.statSync(p);
  fs.writeFileSync(`${part}.meta`, JSON.stringify({ src: p, size: st.size, mtimeMs: st.mtimeMs, boot: USB_COPY_BOOT }));

  const r = await offloadToDir(usbDir);
  assert.ok(r.moved >= 1);
  assert.equal(fs.readFileSync(path.join(usbDir, 'dirty-part.bin'), 'utf8'), content, '必须丢弃脏 .part、从头拷');
});
