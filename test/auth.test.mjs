/**
 * 全站鉴权测试
 * 覆盖：未登录一律 401 / 正确登录后放行 / 错误密码 401 / 公开白名单 / 安卓 Token 仍可用 /
 *       Basic 与 Bearer 程序化访问 / 退出后失效 / 登录失败限流 / Cookie 属性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({
  env: {
    ARIA2_RPC_PORT: String(mock.port),
    WEB_AUTH_USER: 'admin',
    WEB_AUTH_PASSWORD: 'S3cretPassw0rd',
    WEB_SESSION_HOURS: '2',
  },
});

const { createApp } = await import('../dist/app.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function req(p, init = {}) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const jsonReq = (p, body, extraHeaders = {}) =>
  req(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });

/** 提取 Set-Cookie 里的会话 Cookie 名值对 */
function sessionCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(';')[0];
}

test.after(async () => {
  const { stopScheduler } = await import('../dist/core/scheduler.js');
  const { stopPipeline } = await import('../dist/services/pipeline.js');
  stopScheduler();
  stopPipeline();
  await new Promise((r) => server.close(r));
  await mock.close();
});

test('未登录：所有业务接口都 401，且 /api/health 与 /api/auth/me 保持公开', async () => {
  for (const p of ['/api/stats', '/api/tasks', '/api/settings', '/api/system', '/api/files', '/api/files/pending', '/api/webvideo/platforms', '/api/logs']) {
    const res = await req(p);
    assert.equal(res.status, 401, `${p} 未登录应 401，实际 ${res.status}`);
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
    assert.match(res.json.error.message, /登录/);
  }
  // 白名单
  const health = await req('/api/health');
  assert.equal(health.status, 200, '/api/health 应公开（部署脚本探活用）');
  const me = await req('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.enabled, true);
  assert.equal(me.json.authenticated, false);
  assert.equal(me.json.username, null);
});

test('登录：错误密码 401；正确密码下发 HttpOnly 会话 Cookie 并放行', async () => {
  const bad = await jsonReq('/api/auth/login', { username: 'admin', password: 'wrong' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'BAD_CREDENTIALS');

  const empty = await jsonReq('/api/auth/login', { username: '', password: '' });
  assert.equal(empty.status, 400);

  const ok = await jsonReq('/api/auth/login', { username: 'admin', password: 'S3cretPassw0rd' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.authenticated, true);
  assert.equal(ok.json.username, 'admin');
  const cookieRaw = ok.headers.get('set-cookie') ?? '';
  assert.match(cookieRaw, /ttd_session=/);
  assert.match(cookieRaw, /HttpOnly/i);
  assert.match(cookieRaw, /SameSite=Lax/i);
  assert.match(cookieRaw, /Path=\//);
  const cookie = sessionCookie(ok);

  // 带上 Cookie → 业务接口放行
  const stats = await req('/api/stats', { headers: { Cookie: cookie } });
  assert.equal(stats.status, 200, '登录后应能访问业务接口');
  assert.ok(stats.json.todayTasks !== undefined);

  const me2 = await req('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me2.json.authenticated, true);
  assert.equal(me2.json.username, 'admin');

  // 伪造/篡改的 Cookie 无效
  const forged = await req('/api/stats', { headers: { Cookie: 'ttd_session=abc.def' } });
  assert.equal(forged.status, 401, '伪造会话必须被拒绝');
  const tampered = cookie.replace(/.$/, 'x');
  const tamperedRes = await req('/api/stats', { headers: { Cookie: tampered } });
  assert.equal(tamperedRes.status, 401, '被篡改的会话必须被拒绝');
});

test('程序化访问：HTTP Basic 与安卓 Token 都可以（方便 curl / aria2 拉文件）', async () => {
  const basic = Buffer.from('admin:S3cretPassw0rd').toString('base64');
  const viaBasic = await req('/api/stats', { headers: { Authorization: `Basic ${basic}` } });
  assert.equal(viaBasic.status, 200, 'HTTP Basic 应可访问');

  const badBasic = Buffer.from('admin:nope').toString('base64');
  const viaBadBasic = await req('/api/stats', { headers: { Authorization: `Basic ${badBasic}` } });
  assert.equal(viaBadBasic.status, 401);

  // 安卓 Token（ANDROID_TOKEN=test-token，来自 setupRuntime）
  const viaAndroidToken = await req('/api/files/pending', { headers: { 'X-Auth-Token': 'test-token' } });
  assert.equal(viaAndroidToken.status, 200, '安卓 Token 应可用于程序化访问');
  const viaQuery = await req('/api/files/pending?token=test-token');
  assert.equal(viaQuery.status, 200, '?token= 也应可用');
  const viaWrong = await req('/api/files/pending', { headers: { 'X-Auth-Token': 'nope' } });
  assert.equal(viaWrong.status, 401);

  // 安卓端接口本来就是 Token 鉴权，不需要网页会话
  const androidFiles = await req('/api/android/files', { headers: { 'X-Auth-Token': 'test-token' } });
  assert.equal(androidFiles.status, 200, '安卓端接口应保持原有 Token 鉴权');
  const androidNoToken = await req('/api/android/files');
  assert.equal(androidNoToken.status, 401, '安卓端接口无 Token 应 401');
});

test('退出登录：清除 Cookie 后恢复 401', async () => {
  const login = await jsonReq('/api/auth/login', { username: 'admin', password: 'S3cretPassw0rd' });
  const cookie = sessionCookie(login);
  assert.equal((await req('/api/stats', { headers: { Cookie: cookie } })).status, 200);

  const logout = await jsonReq('/api/auth/logout', {}, { Cookie: cookie });
  assert.equal(logout.status, 200);
  assert.match(String(logout.headers.get('set-cookie')), /Max-Age=0/, '退出应清除 Cookie');

  // Cookie 清掉后（模拟浏览器行为）应恢复 401
  assert.equal((await req('/api/stats')).status, 401);
});

test('登录失败限流：连续失败达阈值后返回 429', async () => {
  const attacker = { 'X-Forwarded-For': '203.0.113.9' };
  let saw429 = false;
  for (let i = 0; i < 14; i += 1) {
    const res = await jsonReq('/api/auth/login', { username: 'admin', password: `bad-${i}` }, attacker);
    if (res.status === 429) {
      saw429 = true;
      assert.match(res.json.error.message, /再试/);
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.ok(saw429, '连续失败应触发临时限流');

  // 其它 IP 不受影响（真实用户不会被误伤）
  const other = await jsonReq('/api/auth/login', { username: 'admin', password: 'S3cretPassw0rd' }, { 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(other.status, 200, '不同 IP 不应被限流波及');
});

test('鉴权标记日志：登录成功/失败与拒绝访问都会留痕', async () => {
  const { logger } = await import('../dist/core/logger.js');
  assert.ok(logger.markers().some((m) => m.marker === 'AUTH'), 'AUTH 标记应登记');
  const { tailLogs } = await import('../dist/core/logger.js');
  const lines = tailLogs({ lines: 500, marker: 'AUTH' });
  assert.ok(lines.some((l) => l.includes('登录成功')), '应有登录成功日志');
  assert.ok(lines.some((l) => l.includes('登录失败')), '应有登录失败日志');
  assert.ok(lines.some((l) => l.includes('未授权访问被拒绝')), '应有未授权拒绝日志');
});
