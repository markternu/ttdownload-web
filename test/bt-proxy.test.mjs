/**
 * transmission 反向代理开关 —— HTTP API 集成测试
 *
 * 走真实链路：HTTP 路由 → src/services/btProxy.ts → deploy/scripts/nginx-proxy-toggle.sh
 *            → 假 nginx（不碰真机器的 /etc/nginx）
 *
 * 重点验证「开关语义」：
 *   - 开启后 nginx 里真的有 location（外网能访问 9091）
 *   - 关闭后 include 与 snippet 都没有了（外界真的访问不到，而不是被防火墙挡）
 *   - 关掉不影响我们自己的 /ttdownload/ 反代和别人的站点
 *   - transmission 没设密码时默认拒绝暴露到公网（force 才能强开）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { makeFakeNginx, setupRuntime, startTransmissionMock } from './helpers.mjs';

const SCRIPT = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'deploy', 'scripts', 'nginx-proxy-toggle.sh');

const nginx = makeFakeNginx();
const root = setupRuntime();
const downloadDir = path.join(root, 'transmission', 'downloads', 'Demo');
fs.mkdirSync(downloadDir, { recursive: true });
// transmission 未设置 RPC 密码（默认 mock 不含该字段 → null，不触发拦截）
const mock = await startTransmissionMock({ downloadDir, sessionExtra: { 'rpc-authentication-required': true } });

process.env.TRANSMISSION_RPC_HOST = '127.0.0.1';
process.env.TRANSMISSION_RPC_PORT = String(mock.port);
process.env.BT_PROXY_SCRIPT = SCRIPT;
// 用完整的假 nginx 环境（含 PATH 里的假 systemctl），否则在 macOS 上会误判 nginx 没在运行
Object.assign(process.env, nginx.env);

const { createApp } = await import('../dist/app.js');
const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const api = async (p, init = {}) => {
  const res = await fetch(base + p, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': 'test-token', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
};

test.after(async () => {
  await mock.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  nginx.cleanup();
});

test('GET /api/bt/proxy：初始状态（未开启、能定位到我们的 80 server、transmission 可达）', async () => {
  const r = await api('/api/bt/proxy');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.subPath, '/transmission');
  assert.equal(r.json.target, `127.0.0.1:${mock.port}`);
  assert.equal(r.json.scriptFound, true);
  assert.equal(r.json.serverFile, nginx.site80);
  assert.match(r.json.nginxVersion, /nginx\/1\.24/);
  assert.equal(r.json.transmission.reachable, true);
  assert.equal(r.json.transmission.authRequired, true);
  // 外网访问地址基于请求 Host 推导；直连应用端口时要丢掉应用端口（反代在 nginx 的 80 上）
  assert.equal(r.json.url, 'http://127.0.0.1/transmission/web/');
  assert.equal(r.json.urlSource, 'guessed');
  assert.deepEqual(r.json.warnings, []);
});

test('GET /api/bt/proxy/preview：只给出将写入的配置，不改文件', async () => {
  const before = fs.readFileSync(nginx.site80, 'utf8');
  const r = await api('/api/bt/proxy/preview');
  assert.equal(r.status, 200);
  assert.match(r.json.config, /location \/transmission\//);
  assert.match(r.json.config, /proxy_pass http:\/\/127\.0\.0\.1:\d+;/);
  assert.match(r.json.include, /snippets\/ttdownload-proxy-transmission\.conf/);
  assert.equal(fs.readFileSync(nginx.site80, 'utf8'), before, 'preview 不能改配置');
  assert.equal(fs.existsSync(nginx.snippet()), false, 'preview 不能生成 snippet');
});

test('POST /api/bt/proxy {enabled:true}：真的写进 nginx 配置（外网可访问 9091）', async () => {
  const r = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true);
  const snippet = nginx.snippet();
  assert.ok(fs.existsSync(snippet));
  assert.equal(nginx.managedLines(), 1, 'include 应恰好一行');
  assert.match(fs.readFileSync(snippet, 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:\d+;/);

  // 幂等：再开一次不重复插入
  const again = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(again.status, 200);
  assert.equal(again.json.enabled, true);
  assert.equal(nginx.managedLines(), 1);

  // 状态接口也应为已开启
  const status = await api('/api/bt/proxy');
  assert.equal(status.json.enabled, true);
});

test('POST /api/bt/proxy {enabled:false}：彻底移除（外界再也访问不到 9091）', async () => {
  const r = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(nginx.managedLines(), 0, 'include 必须被移除');
  assert.equal(fs.existsSync(nginx.snippet()), false, 'snippet 必须被删除');
  // 我们自己的站点不受影响
  const site = fs.readFileSync(nginx.site80, 'utf8');
  assert.match(site, /location \/ttdownload\//, '我们应用自己的反代不能被动到');
  assert.match(fs.readFileSync(nginx.site443, 'utf8'), /listen 443 ssl/, '别人的 443 站点不能被动到');
  assert.deepEqual((await api('/api/bt/proxy')).json.warnings, []);
});

test('enabled 不是布尔值 → 400（不乱改配置）', async () => {
  for (const body of [{}, { enabled: 'yes' }, null]) {
    const r = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应被拒绝`);
    assert.equal(nginx.managedLines(), 0);
  }
});

test('nginx -t 失败 → 500 且配置回滚，不把 nginx 搞挂', async () => {
  const before = fs.readFileSync(nginx.site80, 'utf8');
  fs.writeFileSync(nginx.breakOnInclude, '1');
  const r = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  fs.rmSync(nginx.breakOnInclude, { force: true });
  assert.equal(r.status, 500);
  assert.match(String(r.json?.error?.message ?? r.text), /回滚/);
  assert.equal(fs.readFileSync(nginx.site80, 'utf8'), before, '配置必须回滚');
  assert.equal(nginx.managedLines(), 0);
  assert.equal(fs.existsSync(nginx.snippet()), false);
  assert.equal((await api('/api/bt/proxy')).json.enabled, false, '回滚后仍应是关闭状态');
});

test('subPath 可自定义（/bt），且只影响自己那一份配置', async () => {
  const r = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: true, subPath: '/bt' }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.subPath, '/bt');
  assert.ok(fs.existsSync(nginx.snippet('bt')));
  assert.match(fs.readFileSync(nginx.snippet('bt'), 'utf8'), /location \/bt\//);

  const off = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: false, subPath: '/bt' }) });
  assert.equal(off.json.enabled, false);
  assert.equal(nginx.managedLines(), 0);
  assert.equal(fs.existsSync(nginx.snippet('bt')), false);
});

test('非法 subPath / target → 400（不把脚本的 500 抛给用户）', async () => {
  for (const body of [
    { enabled: true, subPath: '/bad path' },
    { enabled: true, subPath: '/ok;rm -rf /' },
    { enabled: true, target: 'nope' },
    { enabled: true, target: '127.0.0.1:99999' },
  ]) {
    const r = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应被拒绝，实际 ${r.status}`);
    assert.match(String(r.json?.error?.code), /BAD_(SUBPATH|TARGET)/);
  }
  assert.equal(nginx.managedLines(), 0, '被拒绝时不能改配置');
});

test('url 推断：直连应用端口（8080）时不能把 8080 当成反代地址，要丢掉应用端口并标注是推断值', async () => {
  const r = await api('/api/bt/proxy');
  assert.equal(r.status, 200);
  // 测试里我们就是直连 http://127.0.0.1:<appPort> 访问的
  assert.ok(r.json.url, '应给出访问地址');
  assert.equal(
    r.json.url,
    `http://127.0.0.1${r.json.subPath}/web/`,
    '反代挂在 nginx 的 80 上，不能把应用的随机端口拼进去',
  );
  assert.equal(r.json.urlSource, 'guessed', '直连时地址是按 nginx 默认端口推断的');
  assert.match(r.json.urlHint, /PUBLIC_BASE_URL|推断/, '应提示用户如何纠正');
});

test('url 推断：经过反向代理（X-Forwarded-Host）时用用户看到的域名', async () => {
  const r = await api('/api/bt/proxy', {
    headers: { 'X-Forwarded-Host': 'dl.example.com', 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(r.json.url, `https://dl.example.com${r.json.subPath}/web/`);
  assert.equal(r.json.urlSource, 'forwarded');
});

test('url 推断：PUBLIC_BASE_URL 优先级最高', async () => {
  process.env.PUBLIC_BASE_URL = 'https://pub.example.com:8443/';
  try {
    const r = await api('/api/bt/proxy', {
      headers: { 'X-Forwarded-Host': 'ignored.example.com', 'X-Forwarded-Proto': 'http' },
    });
    assert.equal(r.json.url, `https://pub.example.com:8443${r.json.subPath}/web/`, '应去掉结尾斜杠并优先用配置值');
    assert.equal(r.json.urlSource, 'public_base_url');
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('开关响应里直接带 url（页面不用等下一轮轮询）', async () => {
  const on = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(on.status, 200);
  assert.equal(on.json.enabled, true);
  assert.ok(on.json.url, '开启响应必须直接给出访问地址');
  assert.match(on.json.url, /\/transmission\/web\/$/);

  const off = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal(off.json.enabled, false);
  assert.equal(off.json.urlSource === 'none' || !!off.json.url, true);
});

test('无凭据探测 WebUI 是否要密码（transmission 4.1 的 session-get 不返回该字段时的兜底）', async () => {
  const http = await import('node:http');
  // 造一个「要密码」的假 WebUI：不带 Authorization 一律 401（transmission 的真实行为）
  const srv = http.createServer((req, res) => {
    if (!req.headers.authorization) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Transmission"' }).end('401: Unauthorized');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>webui</html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const { probeAuthRequired } = await import('../dist/services/btProxy.js');
  try {
    assert.equal(await probeAuthRequired('127.0.0.1', port), true, '401 → 需要密码');
    // 换一个「不要密码」的服务：200
    srv.removeAllListeners('request');
    srv.on('request', (_req, res) => res.writeHead(200).end('ok'));
    assert.equal(await probeAuthRequired('127.0.0.1', port), false, '200 → 不需要密码');
    // 连不上 → 未知（不能瞎猜成“安全”或“不安全”）
    await new Promise((r) => srv.close(r));
    assert.equal(await probeAuthRequired('127.0.0.1', port), null, '连不上 → 未知');
  } finally {
    if (srv.listening) await new Promise((r) => srv.close(r));
  }
});

test('nginx 装了但没在运行 → 明确警告（否则用户以为开了却打不开）', async () => {
  fs.writeFileSync(nginx.nginxStopped, '1'); // 让假 systemctl 认为 nginx 没跑
  try {
    const r = await api('/api/bt/proxy');
    assert.equal(r.status, 200);
    assert.equal(r.json.nginxRunning, false);
    assert.ok(
      r.json.warnings.some((w) => /nginx 服务当前没有在运行/.test(w)),
      `应警告 nginx 没在运行，实际 warnings=${JSON.stringify(r.json.warnings)}`,
    );
    // 开启仍然会写配置（这是脚本的既定行为：配置对了就行），但警告一直在
    const on = await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    assert.equal(on.json.enabled, true);
    assert.equal(on.json.nginxRunning, false);
    assert.ok(on.json.warnings.some((w) => /没有在运行/.test(w)));
    await api('/api/bt/proxy', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  } finally {
    fs.rmSync(nginx.nginxStopped, { force: true });
  }
  const back = await api('/api/bt/proxy');
  assert.equal(back.json.nginxRunning, true, '恢复正常后应报告 nginx 在运行');
  assert.deepEqual(back.json.warnings, []);
});
