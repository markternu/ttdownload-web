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
process.env.NGINX_BIN = nginx.bin;
process.env.NGINX_CONF_DIR = nginx.confDir;
process.env.NGINX_SERVICE = 'nginx';

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
  // 外网访问地址基于请求 Host 推导
  assert.match(r.json.url, /^http:\/\/127\.0\.0\.1:\d+\/transmission\/web\/$/);
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
