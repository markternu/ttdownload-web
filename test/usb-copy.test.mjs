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
const { offloadToDir, reconcileUsbCopies, cleanupPartials, usbCopyStatus } = await import('../dist/services/usbMount.js');

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
