/**
 * 修复脚本上传/执行通道测试（环境问题的远程修复）
 * 覆盖：默认关闭 / 令牌校验 / 上传校验 / 预览 / 执行与退出码 / 下载日志与脚本 / 删除 / 标记
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime({ env: { MAINTENANCE_TOKEN: 'maint-token-xyz' } });

const { createApp } = await import('../dist/app.js');
const { config } = await import('../dist/core/config.js');
const { logger } = await import('../dist/core/logger.js');
const { getSettings, updateSettings } = await import('../dist/services/settings.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const TOKEN = 'maint-token-xyz';

async function req(p, { token, ...init } = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers['X-Maint-Token'] = token;
  const res = await fetch(base + p, { ...init, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（如下载） */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const json = (p, body, token) =>
  req(p, { method: 'POST', token, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test.after(async () => {
  const { stopScheduler } = await import('../dist/core/scheduler.js');
  const { stopPipeline } = await import('../dist/services/pipeline.js');
  stopScheduler();
  stopPipeline();
  await new Promise((r) => server.close(r));
});

const waitFinished = async (id, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    const res = await req(`/api/system/scripts/${id}`);
    if (res.json?.item && !res.json.item.running && res.json.item.lastRun?.finishedAt) return res.json;
    await new Promise((r) => setTimeout(r, 150));
  }
  return (await req(`/api/system/scripts/${id}`)).json;
};

test('默认关闭：上传与开启都受保护，且令牌错误给出明确错误码', async () => {
  const overview = await req('/api/system/scripts');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.enabled, false, '默认必须是关闭的');
  assert.equal(overview.json.tokenRequired, true);
  assert.ok(overview.json.timeoutSec >= 30);
  assert.deepEqual(overview.json.items, []);

  // 未开启时上传 → SCRIPT_DISABLED
  const upload = await json('/api/system/scripts', { name: 'a.sh', content: 'echo hi' }, TOKEN);
  assert.equal(upload.status, 400);
  assert.equal(upload.json.error.code, 'SCRIPT_DISABLED');

  // 开启：无令牌 / 错令牌都必须被拒
  const noToken = await json('/api/system/scripts/toggle', { enabled: true });
  assert.equal(noToken.status, 400);
  assert.equal(noToken.json.error.code, 'SCRIPT_TOKEN');
  const badToken = await json('/api/system/scripts/toggle', { enabled: true }, 'wrong-token');
  assert.equal(badToken.status, 400);
  assert.equal(badToken.json.error.code, 'SCRIPT_TOKEN');

  const ok = await json('/api/system/scripts/toggle', { enabled: true }, TOKEN);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.enabled, true);
});

test('上传校验：空内容、二进制、超大、非脚本都要被拒；正常脚本可预览', async () => {
  const empty = await json('/api/system/scripts', { name: 'e.sh', content: '   ' }, TOKEN);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, 'SCRIPT_SAVE');

  const binary = await json('/api/system/scripts', { name: 'b.sh', content: '#!/bin/bash\n\u0000\u0001' }, TOKEN);
  assert.equal(binary.status, 400);
  assert.match(binary.json.error.message, /二进制/);

  const tooBig = await json('/api/system/scripts', { name: 'big.sh', content: 'x'.repeat(1024 * 1024 + 10) }, TOKEN);
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.json.error.message, /过大/);

  const wrongType = await json('/api/system/scripts', { name: 'evil.exe', content: 'MZ binary-ish' }, TOKEN);
  assert.equal(wrongType.status, 400);
  assert.match(wrongType.json.error.message, /只支持/);

  const good = await json('/api/system/scripts', { name: 'fix-ok.sh', content: '#!/bin/bash\necho fix-ok\n' }, TOKEN);
  assert.equal(good.status, 200);
  assert.equal(good.json.item.name, 'fix-ok.sh');
  assert.equal(good.json.item.sha256.length, 64);

  const detail = await req(`/api/system/scripts/${good.json.item.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.json.preview, /echo fix-ok/);
  assert.equal(detail.json.tokenRequired, true);
});

test('执行脚本：记录输出与退出码，日志/脚本可下载；运行中不允许重复执行', async () => {
  const up = await json(
    '/api/system/scripts',
    {
      name: 'exit3.sh',
      content: '#!/bin/bash\necho hello-from-fix\necho running-as-$(id -un)\nexit 3\n',
    },
    TOKEN,
  );
  const id = up.json.item.id;

  const run = await json(`/api/system/scripts/${id}/run`, {}, TOKEN);
  assert.equal(run.status, 200);
  assert.ok(['systemd-run', 'setsid'].includes(run.json.via));

  const done = await waitFinished(id);
  assert.ok(done, '应能读到脚本详情');
  assert.equal(done.item.running, false);
  assert.equal(done.item.lastRun.exitCode, 3, `退出码应为 3，日志：${done.log}`);
  assert.equal(done.item.lastRun.timedOut, false);
  assert.equal(done.item.runCount, 1);
  assert.match(done.log, /hello-from-fix/, '应记录脚本 stdout');
  assert.match(done.log, /__EXIT_CODE=3/);
  assert.match(done.log, /修复脚本开始/);
  assert.match(done.log, /代码版本/, '头部应写入代码版本，便于对照');

  const logFile = await req(`/api/system/scripts/${id}/log`);
  assert.equal(logFile.status, 200);
  assert.match(String(logFile.headers.get('content-disposition')), /attachment/);
  assert.match(logFile.text, /hello-from-fix/);

  const scriptFile = await req(`/api/system/scripts/${id}/file`);
  assert.equal(scriptFile.status, 200);
  assert.match(scriptFile.text, /exit 3/);
});

test('执行失败/超时的脚本：退出码与超时标记正确', async () => {
  updateSettings({ scriptRunTimeoutSec: 30 });
  const up = await json('/api/system/scripts', { name: 'fail.sh', content: '#!/bin/bash\necho before-fail\ncommand-not-exist-xyz\n' }, TOKEN);
  const id = up.json.item.id;
  await json(`/api/system/scripts/${id}/run`, {}, TOKEN);
  const done = await waitFinished(id);
  assert.equal(done.item.running, false);
  assert.notEqual(done.item.lastRun.exitCode, 0, '命令不存在应是非零退出');
  assert.match(done.log, /command-not-exist-xyz/);
  updateSettings({ scriptRunTimeoutSec: 600 });
});

test('删除脚本：需要令牌；删除后不再出现在列表', async () => {
  const up = await json('/api/system/scripts', { name: 'to-delete.sh', content: '#!/bin/bash\ntrue\n' }, TOKEN);
  const id = up.json.item.id;

  const noToken = await req(`/api/system/scripts/${id}`, { method: 'DELETE' });
  assert.equal(noToken.status, 400);
  assert.equal(noToken.json.error.code, 'SCRIPT_TOKEN');

  const del = await req(`/api/system/scripts/${id}`, { method: 'DELETE', token: TOKEN });
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);

  const gone = await req(`/api/system/scripts/${id}`);
  assert.equal(gone.status, 404);

  const overview = await req('/api/system/scripts');
  assert.equal(overview.json.items.some((i) => i.id === id), false);
});

test('关闭开关后不能再上传/执行（用完即关）', async () => {
  const off = await json('/api/system/scripts/toggle', { enabled: false }, TOKEN);
  assert.equal(off.json.enabled, false);
  const upload = await json('/api/system/scripts', { name: 'x.sh', content: 'echo x' }, TOKEN);
  assert.equal(upload.status, 400);
  assert.equal(upload.json.error.code, 'SCRIPT_DISABLED');
  await json('/api/system/scripts/toggle', { enabled: true }, TOKEN);
});

test('全程留下 SCRIPT_UPLOAD / SCRIPT_RUN 标记日志，且脚本落盘权限收窄', async () => {
  const lines = (await req('/api/system/logs?lines=500&marker=SCRIPT_UPLOAD')).json.lines;
  assert.ok(lines.length >= 1, '应有 SCRIPT_UPLOAD 标记');
  const runLines = (await req('/api/system/logs?lines=500&marker=SCRIPT_RUN')).json.lines;
  assert.ok(runLines.length >= 1, '应有 SCRIPT_RUN 标记');
  assert.ok(
    lines.some((l) => l.includes('已上传修复脚本')) || runLines.some((l) => l.includes('执行结束')),
    '标记内容应可读',
  );

  const dir = path.join(config.dirs.state, 'scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sh'));
  assert.ok(files.length >= 1, '脚本应落盘到 state/scripts');
  const mode = fs.statSync(path.join(dir, files[0])).mode & 0o777;
  assert.equal(mode & 0o077, 0, `脚本不应对同组/其他用户可读写（实际 ${mode.toString(8)}）`);

  const markers = (await req('/api/system/debug')).json.markers.map((m) => m.marker);
  assert.ok(markers.includes('SCRIPT_UPLOAD') && markers.includes('SCRIPT_RUN'), '标记应登记在册');
  assert.ok(logger.getLevel());
});

test('长时间运行的脚本：running 必须为 true（页面据此显示「运行中」并轮询）', async () => {
  const up = await json('/api/system/scripts', { name: 'slow.sh', content: '#!/bin/bash\necho slow-start\nsleep 3\necho slow-done\n' }, TOKEN);
  const id = up.json.item.id;
  await json(`/api/system/scripts/${id}/run`, {}, TOKEN);

  const during = await req(`/api/system/scripts/${id}`);
  assert.equal(during.json.item.running, true, '脚本仍在跑时应为 running');
  assert.equal(during.json.item.lastRun.finishedAt, null);

  const done = await waitFinished(id, 80);
  assert.equal(done.item.running, false, '跑完后 running 应为 false');
  assert.equal(done.item.lastRun.exitCode, 0);
  assert.match(done.log, /slow-done/);
});
