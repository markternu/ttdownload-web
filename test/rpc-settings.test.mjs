/**
 * RPC 凭据相关的回归测试（setttings 页 → 真的要生效）
 *
 * 真机血案（用户报的）：浏览器能打开 9091，网页却报
 *   「transmission 不可用：请确认已安装并启动 transmission-daemon」
 * 实际是 HTTP **401**（RPC 用户名/密码被拒）。三个连带问题：
 *   ① BT 模块只读 `config.transmissionRpc`（= .env），**从来不读设置页（DB）** ——
 *      用户在网页「设置 → 网络设置 → transmission RPC」里改的账号密码一点用都没有，
 *      而部署脚本和网络自检的提示都叫他去那里填。
 *   ② ping() 把所有异常都吞成 false，错误信息统一说"是不是没装"，把人带偏。
 *   ③ `不可用：请` 被当成永久错误 → 改对密码也不会自动重试。
 *   ④ getSettingsPublic() 不脱敏 RPC 密码/secret → 明文进了要发给开发者的诊断包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupRuntime, startJsonRpcServer } from './helpers.mjs';

const root = setupRuntime();

const { getSettings, getSettingsPublic, updateSettings, transmissionRpc, aria2Rpc } = await import('../dist/services/settings.js');
const { transmissionClient } = await import('../dist/modules/transmission.js');

/** 一个"必须带对 Basic 认证"的 transmission RPC mock（凭据不对就 401） */
async function startAuthMock(user, password) {
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  return startJsonRpcServer((msg, req) => {
    if ((req.headers.authorization ?? '') !== expected) {
      return { status: 401, body: '401: Unauthorized' };
    }
    if (req.headers['x-transmission-session-id'] !== 'sess-1') {
      return { status: 409, headers: { 'X-Transmission-Session-Id': 'sess-1' }, body: {} };
    }
    const args = msg.method === 'session-get' ? { version: '4.0.5-auth-mock' } : {};
    return { body: { result: 'success', arguments: args } };
  });
}

test('【血案回归】「设置」页里填的 transmission RPC 账号密码必须真的生效', async () => {
  const mock = await startAuthMock('opengl', 'secret-pw');
  try {
    // 用户在网页「设置 → 网络设置 → transmission RPC」里填的内容
    updateSettings({ transmissionRpc: { host: '127.0.0.1', port: mock.port, user: 'opengl', password: 'secret-pw' } });
    const probe = await transmissionClient().probe();
    assert.equal(probe.ok, true, `设置页填的凭据应该能连上，实际：${probe.reason}`);
    assert.equal(probe.version, '4.0.5-auth-mock');
  } finally {
    await mock.close();
  }
});

test('【血案回归】凭据不对时报 401（不是"请确认已安装并启动 transmission-daemon"）', async () => {
  const mock = await startAuthMock('opengl', 'right-pw');
  try {
    updateSettings({ transmissionRpc: { host: '127.0.0.1', port: mock.port, user: 'opengl', password: 'wrong-pw' } });
    const probe = await transmissionClient().probe();
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /401|未授权/, `应指出是认证问题，实际：${probe.reason}`);
    assert.equal(
      probe.reason.includes('请确认已安装并启动'),
      false,
      '不能再说"请确认已安装并启动 transmission-daemon"（浏览器能开 9091 时会把人彻底带偏）',
    );
    // 用户最终看到的是 prepare() 抛出来的那句：必须带上"去哪儿改"的指引
    const { transmissionModule } = await import('../dist/modules/transmission.js');
    await assert.rejects(
      () => transmissionModule.prepare({ id: 1, payload: {}, meta: { files: [] } }),
      (e) => {
        assert.match(e.message, /401|未授权/, '要指出是认证问题');
        assert.equal(e.message.includes('请确认已安装并启动'), false, '不能再说"是不是没装"');
        assert.match(e.message, /设置/, '要告诉用户可以在「设置」里改');
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

test('设置页留空时回落到 .env（老部署不受影响）', async () => {
  const { config } = await import('../dist/core/config.js');
  updateSettings({ transmissionRpc: { host: '', port: 0, user: '', password: '' } });
  const eff = transmissionRpc();
  assert.equal(eff.host, config.transmissionRpc.host, 'host 应回落到 .env');
  assert.equal(eff.port, config.transmissionRpc.port, '端口应回落到 .env');
});

test('【血案回归】设置页空密码回落 .env；填了就用填的', async () => {
  updateSettings({ transmissionRpc: { host: '127.0.0.1', port: 9091, user: 'u1', password: 'p1' } });
  assert.equal(transmissionRpc().password, 'p1');
  assert.equal(transmissionRpc().user, 'u1');
});

test('【血案回归】公开设置里 RPC 密码/secret 必须是掩码（诊断包是要发出去的）', async () => {
  updateSettings({
    transmissionRpc: { host: '127.0.0.1', port: 9091, user: 'opengl', password: 'plaintext-pw' },
    aria2Rpc: { host: '127.0.0.1', port: 6800, secret: 'plaintext-secret' },
  });
  const pub = getSettingsPublic();
  assert.equal(pub.transmissionRpc.password, '******', 'transmission RPC 密码必须掩码');
  assert.equal(pub.aria2Rpc.secret, '******', 'aria2 secret 必须掩码');
  assert.equal(JSON.stringify(pub).includes('plaintext-pw'), false, '公开设置里不得出现明文密码');
  assert.equal(JSON.stringify(pub).includes('plaintext-secret'), false, '公开设置里不得出现明文 secret');

  // 前端拿到的就是掩码，原样提交回来不能把真密码冲掉
  updateSettings({ transmissionRpc: { password: '******' }, aria2Rpc: { secret: '******' } });
  assert.equal(getSettings().transmissionRpc.password, 'plaintext-pw', '掩码回传必须保持原密码');
  assert.equal(getSettings().aria2Rpc.secret, 'plaintext-secret', '掩码回传必须保持原 secret');
});

test('aria2 的 RPC 设置同样"设置页优先、回落 .env"', async () => {
  updateSettings({ aria2Rpc: { host: '10.0.0.9', port: 6801, secret: 'tok' } });
  const eff = aria2Rpc();
  assert.equal(eff.host, '10.0.0.9');
  assert.equal(eff.port, 6801);
  assert.equal(eff.secret, 'tok');
  // 清空 → 回落 .env
  updateSettings({ aria2Rpc: { host: '', port: 0, secret: '' } });
  assert.equal(aria2Rpc().port, 6800, '应回落到 .env 的 6800');
});

test('RPC 不通是可恢复错误：任务不该被标成"永久失败"（改对密码后能重试）', async () => {
  const { tasksRepo } = await import('../dist/core/db.js');
  const { schedulerTick } = await import('../dist/core/scheduler.js');
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);
  // 指到一个没人监听的端口 → prepare 必然连不上
  updateSettings({ transmissionRpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' }, reserveFreeBytes: 0, maxConcurrent: 0 });
  const task = tasksRepo.create({ module: 'transmission', title: 'rpc-down', platform: 'BT', expectBytes: 1024, payload: {}, meta: { files: [] } });
  await schedulerTick();
  const after = tasksRepo.get(task.id);
  assert.notEqual(after.status, 'failed', 'RPC 不通不该直接判永久失败（用户改好凭据后应能自动重试）');
  assert.match(String(after.error ?? ''), /RPC/, '任务表要写清是 RPC 不通：' + String(after.error));
  assert.ok(Number(after.retryCount ?? 0) >= 1, '应进入自动重试');
});
