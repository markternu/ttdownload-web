/**
 * 【血案回归】transmission 里已经没有这个种子时，必须用**留档的 .torrent 重新加入**，
 * 而不是抛「无法读取种子信息」把任务判死。
 *
 * 用户报的现象：失败的 BT 任务提示「无法读取种子信息」。
 * 这句话的真实含义是 **transmission 里查不到这个 torrent id**（被超时策略/扫货/手动删掉，
 * 或 transmission 重装过），跟"本地 .torrent 被删"不是一回事 ——
 * 但旧逻辑下 .torrent 确实早被自动删了，于是**没有自救的可能**，任务永远救不回来。
 * 现在种子文件全程留档（btQueued），所以这里断言：它能自动重新加回去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startJsonRpcServer } from './helpers.mjs';

const root = setupRuntime();
const { config } = await import('../dist/core/config.js');
const { tasksRepo, seedsRepo } = await import('../dist/core/db.js');
const { updateSettings } = await import('../dist/services/settings.js');
const bt = await import('../dist/modules/transmission.js');

test('transmission 丢了种子 + 留档还在 → 自动重新加入（不再报"无法读取种子信息"）', async () => {
  // 1) 留档的种子文件（入队时会被移动到 btQueued，这里直接放那儿）
  fs.mkdirSync(config.dirs.btQueued, { recursive: true });
  const archived = path.join(config.dirs.btQueued, 'archived.torrent');
  fs.writeFileSync(archived, 'd8:announce11:http://x/ye');
  assert.equal(fs.existsSync(archived), true, '前提：留档文件存在（新逻辑永不删）');

  // 2) mock transmission：老 id 查不到（返回空 torrents），新加的 id=99 能查到
  let added = 0;
  const rpc = await startJsonRpcServer((msg, req) => {
    if (req.headers['x-transmission-session-id'] !== 's') {
      return { status: 409, headers: { 'X-Transmission-Session-Id': 's' }, body: {} };
    }
    const args = msg.arguments ?? {};
    switch (msg.method) {
      case 'session-get':
        return { body: { result: 'success', arguments: { version: '4.0.5-mock' } } };
      case 'torrent-add':
        added += 1;
        return { body: { result: 'success', arguments: { 'torrent-added': { id: 99, name: 're-added', hashString: 'h99' } } } };
      case 'torrent-get':
        // 老 id（7）已被 transmission 丢掉 → 查不到；新 id（99）正常返回
        if (Array.isArray(args.ids) && args.ids[0] === 7) {
          return { body: { result: 'success', arguments: { torrents: [] } } };
        }
        return {
          body: {
            result: 'success',
            arguments: {
              torrents: [{
                id: 99, name: 're-added', hashString: 'h99', status: 0, percentDone: 0,
                totalSize: 1000, downloadDir: config.dirs.btDownload,
                files: [{ name: 'movie.mp4', length: 1000, bytesCompleted: 0 }], wanted: [1],
              }],
            },
          },
        };
      default:
        return { body: { result: 'success', arguments: {} } };
    }
  });

  try {
    updateSettings({ transmissionRpc: { host: '127.0.0.1', port: rpc.port, user: '', password: '' } });

    const seed = seedsRepo.upsertByPath({ name: 'archived.torrent', path: archived });
    const task = tasksRepo.create({
      module: 'transmission',
      title: 'archived',
      platform: 'BT',
      status: 'waiting',
      expectBytes: 0,
      payload: { seedId: seed.id, seedPath: archived, torrentId: 7 }, // ← 过期的 torrentId
      meta: { files: [] },
    });

    // 3) prepare 必须**成功**（重新加回去），而不是抛"无法读取种子信息"
    await bt.transmissionModule.prepare(tasksRepo.get(task.id));
    const after = tasksRepo.get(task.id);
    assert.equal(added, 1, '应该调用了一次 torrent-add（用留档的 .torrent 重新加入）');
    assert.equal(Number(after.payload.torrentId), 99, 'torrentId 应更新为新加入的那个');
    assert.deepEqual(after.meta.files, ['movie.mp4'], '重新加入后照旧只挑视频');
    assert.equal(fs.existsSync(archived), true, '留档的 .torrent 依然在（永不自动删除）');
  } finally {
    await rpc.close();
  }
});
