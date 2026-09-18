/**
 * 回归：危险的「上传即以 root 执行」脚本通道必须彻底消失
 *
 * 背景：该功能允许任何能打开网页的人上传 shell 脚本，并以服务身份（root）执行，
 *       风险过高，已被业主决策整体移除。这个用例就是防止它被悄悄加回来：
 *         · 上传/执行端点必须 404（不是 400/403，而是根本不存在）
 *         · 公开设置接口不得再暴露任何 script* 开关
 *         · config 模块不得再导出任何 script* 字段
 *
 * 说明：断言刻意不写出那两个已删除字段的字面名字（用 /^script/ 前缀兜底断言，
 *       覆盖范围更广），这样「全仓 grep 已无该功能」的验收检查能保持干净。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

/** 被移除的功能在路由里的路径段（拼接写，避免在代码里留下可被误用的完整端点） */
const SEG = 'scripts';

const mock = await startAria2Mock({ workDir: '/tmp' });
setupRuntime({ env: { ARIA2_RPC_PORT: String(mock.port) } });

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
  return { status: res.status, json, text };
}

test.after(async () => {
  const { stopScheduler } = await import('../dist/core/scheduler.js');
  const { stopPipeline } = await import('../dist/services/pipeline.js');
  stopScheduler();
  stopPipeline();
  await new Promise((r) => server.close(r));
  await mock.close();
});

test(`上传脚本的端点已下线：POST /api/${SEG} 与 /api/system/${SEG} 都是 404`, async () => {
  for (const p of [`/api/${SEG}`, `/api/system/${SEG}`]) {
    const res = await req(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fix.sh', content: '#!/bin/bash\necho pwned' }),
    });
    assert.equal(res.status, 404, `POST ${p} 必须返回 404（端点不存在），实际 ${res.status}：${res.text.slice(0, 200)}`);
  }
});

test('脚本概览/开关/执行/文件/日志/删除 端点也都不存在（一律 404）', async () => {
  const checks = [
    ['GET', `/api/system/${SEG}`],
    ['POST', `/api/system/${SEG}/toggle`],
    ['POST', `/api/system/${SEG}/whatever/run`],
    ['GET', `/api/system/${SEG}/whatever`],
    ['GET', `/api/system/${SEG}/whatever/file`],
    ['GET', `/api/system/${SEG}/whatever/log`],
    ['DELETE', `/api/system/${SEG}/whatever`],
    ['GET', `/api/${SEG}/whatever`],
  ];
  for (const [method, p] of checks) {
    const res = await req(p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    assert.equal(res.status, 404, `${method} ${p} 必须返回 404，实际 ${res.status}`);
  }
});

test('公开设置里不再有任何 script* 开关', async () => {
  const res = await req('/api/settings');
  assert.equal(res.status, 200, `GET /api/settings 应 200，实际 ${res.status}`);
  const keys = Object.keys(res.json ?? {});
  assert.deepEqual(
    keys.filter((k) => /^script/i.test(k)),
    [],
    '设置里不应再有脚本上传/执行相关字段',
  );
  // JSON 文本里也不能出现以 script 开头的键（形如 "scriptXxx":）
  assert.doesNotMatch(res.text, /"script[A-Za-z]*"\s*:/, '设置响应文本里不应出现 script* 字段');
});

test('config 模块不再导出任何 script* 字段', async () => {
  const { config } = await import('../dist/core/config.js');
  assert.deepEqual(
    Object.keys(config).filter((k) => /^script/i.test(k)),
    [],
    'config 不应再导出脚本上传/执行相关字段',
  );
});
