/**
 * 调试期日志能力 + 诊断包 + 网络自检测试
 *  - 日志：标记 / 过滤 / 脱敏 / 轮转 / 尾部读取
 *  - 接口：GET/DELETE /api/system/logs、/logs/download、/api/system/debug、/api/system/diagnostics
 *  - 网络自检：/api/webvideo/network 的每一项检查与缓存
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime();

/* 本地 HTTP 服务：模拟 googlevideo CDN（支持 Range），以及一个通用的 200 页面 */
const cdnHits = [];
const cdnServer = http.createServer((req, res) => {
  cdnHits.push(req.url);
  if (req.url === '/probe') {
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-0/1000' });
    res.end('x');
    return;
  }
  res.writeHead(200).end('ok');
});
await new Promise((r) => cdnServer.listen(0, '127.0.0.1', r));
const cdnBase = `http://127.0.0.1:${cdnServer.address().port}`;

/* 假 yt-dlp：-J 返回元数据（含可访问的 CDN 直链）；--get-url 打印直链 */
const fakeYtdlp = path.join(root, 'bin', 'yt-dlp');
fs.mkdirSync(path.dirname(fakeYtdlp), { recursive: true });
fs.writeFileSync(
  fakeYtdlp,
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2025.01.01"; exit 0; fi
if [ "$1" = "--get-url" ]; then echo "${cdnBase}/probe"; exit 0; fi
case "$*" in
  *-J*)
    echo '{"title":"网络自检测试视频","uploader":"作者","duration":10,"formats":[{"format_id":"18","ext":"mp4","resolution":"360p","height":360,"vcodec":"avc1","acodec":"mp4a","filesize":1000,"url":"${cdnBase}/probe"}]}'
    exit 0
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
process.env.YTDLP_BIN = fakeYtdlp;

const { createApp } = await import('../dist/app.js');
const { config } = await import('../dist/core/config.js');
const loggerMod = await import('../dist/core/logger.js');
const { tasksRepo } = await import('../dist/core/db.js');
const netCheck = await import('../dist/services/netCheck.js');

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

const post = (p, body) =>
  req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test.after(async () => {
  const { stopScheduler } = await import('../dist/core/scheduler.js');
  const { stopPipeline } = await import('../dist/services/pipeline.js');
  stopScheduler();
  stopPipeline();
  await new Promise((r) => server.close(r));
  await new Promise((r) => cdnServer.close(r));
});

/* ------------------------------------------------------------------ */
/* 日志核心                                                            */
/* ------------------------------------------------------------------ */

test('日志：标记 / 级别过滤 / 尾部读取 / 脱敏', () => {
  loggerMod.clearLogs();
  const log = loggerMod.logger.child('ut');
  log.mark('TASK_CREATE', '创建任务', { url: 'https://x/y', token: 'super-secret-value' });
  log.mark('YTDLP_ATTEMPT', '尝试方式 1/8');
  log.warn('普通警告');

  const all = loggerMod.tailLogs({ lines: 50 });
  assert.ok(all.length >= 3, '应能读到刚写的日志');
  assert.ok(all.some((l) => l.includes('[MARK:TASK_CREATE]')), '应带标记');
  assert.ok(all.some((l) => l.includes('[MARK:YTDLP_ATTEMPT]')), '应带标记');
  assert.ok(all.some((l) => l.includes('***')), '敏感字段应脱敏');
  assert.equal(all.some((l) => l.includes('super-secret-value')), false, '原始 token 不得出现');

  assert.ok(loggerMod.tailLogs({ lines: 50, marker: 'YTDLP_ATTEMPT' }).every((l) => l.includes('YTDLP_ATTEMPT')));
  assert.ok(loggerMod.tailLogs({ lines: 50, marker: '没有这个标记' }).length === 0);
  assert.ok(loggerMod.tailLogs({ lines: 50, q: '尝试方式' }).length >= 1);
  assert.ok(loggerMod.tailLogs({ lines: 50, q: '不存在的关键词zzz' }).length === 0);

  // 级别过滤：只要 error 时，debug/info 不返回
  loggerMod.logger.debug('调试细节');
  const onlyError = loggerMod.tailLogs({ lines: 50, level: 'error' });
  assert.equal(onlyError.some((l) => l.includes('调试细节')), false);
  assert.equal(onlyError.some((l) => l.includes('[WARN')), false);
});

test('日志：标记表登记齐备且可枚举', () => {
  const markers = loggerMod.logger.markers();
  assert.ok(markers.length > 20, '应登记了足够多的标记');
  for (const need of ['TASK_CREATE', 'TASK_STATE', 'TASK_FAIL', 'PROC_SPAWN', 'PROC_EXIT', 'YTDLP_ATTEMPT', 'YTDLP_EXIT', 'NET_CHECK', 'DIAG', 'ANDROID']) {
    assert.ok(markers.some((m) => m.marker === need), `缺少标记登记: ${need}`);
    assert.ok(markers.find((m) => m.marker === need).description.length > 0, `标记 ${need} 应有说明`);
  }
  assert.ok(Array.isArray(loggerMod.logger.usedMarkers()));
});

test('日志：文件轮转（写满后生成 app.log.1）', () => {
  const logDir = path.dirname(config.logPath);
  fs.mkdirSync(logDir, { recursive: true });
  process.env.LOG_MAX_MB = '0.0005'; // 约 512 字节，便于触发轮转
  try {
    // 直接写入超过阈值的内容
    for (let i = 0; i < 40; i += 1) loggerMod.logger.info(`轮转测试行 ${i} ${'x'.repeat(60)}`);
    const files = loggerMod.listLogFiles().map((f) => f.name);
    assert.ok(files.includes(path.basename(config.logPath)), '当前日志文件应存在');
    assert.ok(files.some((n) => n.endsWith('.1')), `应生成轮转文件，实际：${files.join(',')}`);
  } finally {
    delete process.env.LOG_MAX_MB;
  }
});

/* ------------------------------------------------------------------ */
/* 日志 / 调试 / 诊断接口                                               */
/* ------------------------------------------------------------------ */

test('GET /api/system/logs 返回尾部日志 + 标记表；支持过滤', async () => {
  loggerMod.clearLogs();
  loggerMod.logger.child('api').mark('TASK_CREATE', '接口测试任务已创建', { url: 'https://example.com/v.mp4' });

  const res = await req('/api/system/logs?lines=50');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.lines));
  assert.ok(res.json.lines.some((l) => l.includes('MARK:TASK_CREATE')), '应返回带标记的日志行');
  assert.equal(typeof res.json.file, 'string');
  assert.equal(typeof res.json.dir, 'string');
  assert.ok(Array.isArray(res.json.files));
  assert.equal(typeof res.json.debugMode, 'boolean');
  assert.ok(res.json.markers.length > 20, '应返回标记说明表');
  assert.ok(Array.isArray(res.json.items), '兼容旧的 items 字段');

  const filtered = await req('/api/system/logs?lines=50&marker=TASK_CREATE');
  assert.ok(filtered.json.lines.length >= 1);
  assert.ok(filtered.json.lines.every((l) => l.includes('TASK_CREATE')));

  const none = await req('/api/system/logs?lines=50&marker=ZZZ_NEVER_REGISTERED');
  assert.equal(none.json.lines.length, 0);
});

test('GET /api/system/logs/download 返回文本附件', async () => {
  const res = await req('/api/system/logs/download');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/plain/);
  assert.match(String(res.headers.get('content-disposition')), /attachment/);
  assert.ok(res.text.includes('接口测试任务已创建'));
});

test('调试模式：GET/POST /api/system/debug 可运行时切换级别', async () => {
  const before = await req('/api/system/debug');
  assert.equal(before.status, 200);
  assert.ok(['error', 'warn', 'info', 'debug', 'trace'].includes(before.json.logLevel));

  const off = await post('/api/system/debug', { debugMode: false });
  assert.equal(off.json.debugMode, false);
  assert.equal(off.json.logLevel, 'info');

  const trace = await post('/api/system/debug', { logLevel: 'trace' });
  assert.equal(trace.json.logLevel, 'trace');
  assert.equal(trace.json.debugMode, true);

  const bad = await post('/api/system/debug', { logLevel: 'noisy' });
  assert.equal(bad.status, 400);

  // 恢复 info，避免影响其它用例
  await post('/api/system/debug', { logLevel: 'info' });
});

test('DELETE /api/system/logs 清空日志', async () => {
  loggerMod.logger.info('清空前的一行日志');
  const del = await req('/api/system/logs', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);
  assert.ok(del.json.cleared >= 1);
  const after = await req('/api/system/logs?lines=50');
  assert.equal(
    after.json.lines.some((l) => l.includes('清空前的一行日志')),
    false,
    '清空后不应再读到清空前的行',
  );
});

/* ------------------------------------------------------------------ */
/* 网络自检                                                            */
/* ------------------------------------------------------------------ */

test('网络自检：yt-dlp / YouTube / CDN 全部通过，并带中文说明与建议字段', async () => {
  netCheck.resetNetworkCache();
  const res = await req('/api/webvideo/network?refresh=1');
  assert.equal(res.status, 200);
  const report = res.json;
  assert.ok(['ok', 'partial', 'fail'].includes(report.overall));
  assert.equal(typeof report.summary, 'string');
  assert.ok(report.summary.length > 0);
  assert.equal(report.cached, false);
  assert.ok(report.proxy && typeof report.proxy === 'object');

  const ids = report.checks.map((c) => c.id);
  for (const need of ['proxy', 'dns', 'https-google', 'https-youtube', 'https-github', 'ytdlp-version', 'ytdlp-youtube-meta', 'youtube-cdn', 'aria2-rpc', 'transmission-rpc']) {
    assert.ok(ids.includes(need), `缺少检查项 ${need}`);
  }
  for (const c of report.checks) {
    assert.equal(typeof c.label, 'string');
    assert.ok(['ok', 'fail', 'skip', 'running'].includes(c.status));
    assert.equal(typeof c.detail, 'string');
    assert.ok(['net', 'ytdlp', 'local'].includes(c.group));
  }

  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(byId['ytdlp-version'].status, 'ok');
  assert.match(byId['ytdlp-version'].detail, /2025\.01\.01/);
  assert.equal(byId['ytdlp-youtube-meta'].status, 'ok', byId['ytdlp-youtube-meta'].detail);
  assert.match(byId['ytdlp-youtube-meta'].detail, /网络自检测试视频/);
  assert.equal(byId['youtube-cdn'].status, 'ok', byId['youtube-cdn'].detail);
  assert.match(byId['youtube-cdn'].detail, /HTTP 206/);
  assert.ok(cdnHits.includes('/probe'), 'CDN 检查应真的去请求视频直链');

  // 失败项必须给出建议文案
  for (const c of report.checks) {
    if (c.status === 'fail') assert.ok(c.hint && c.hint.length > 0, `失败项 ${c.id} 应带 hint`);
  }
  assert.equal(report.overall, 'ok', `yt-dlp 链路都通过了，overall 应为 ok（当前 ${report.overall}）`);
});

test('网络自检：60 秒缓存 + refresh 强刷', async () => {
  const cached = await req('/api/webvideo/network');
  assert.equal(cached.json.cached, true, '第二次应命中缓存');
  const forced = await req('/api/webvideo/network?refresh=1');
  assert.equal(forced.json.cached, false, 'refresh=1 应强制重测');
});

test('GET /api/system/diagnostics 打包日志/配置/任务/网络自检，并对密钥脱敏', async () => {
  loggerMod.logger.child('diag-test').mark('DIAG', '诊断包测试标记行');
  const task = tasksRepo.create({ module: 'webvideo', title: '诊断测试.mp4', platform: 'YouTube', url: 'https://youtu.be/diag', payload: {} });
  tasksRepo.update(task.id, { status: 'failed', error: '诊断用失败原因' });

  const res = await req('/api/system/diagnostics');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /application\/json/);
  assert.match(String(res.headers.get('content-disposition')), /ttdownload-diagnostics-.*\.json/);

  const b = res.json;
  assert.ok(b.generatedAt);
  assert.equal(b.app.version, config.version);
  assert.equal(typeof b.app.debugMode, 'boolean');
  assert.ok(b.logs.length >= 1, '诊断包应包含日志内容');
  assert.ok(b.logs.some((l) => l.content.includes('诊断包测试标记行')), '应包含刚写的日志行');
  assert.ok(b.tasks.total >= 1);
  assert.ok(b.tasks.items.some((t) => t.error === '诊断用失败原因'), '应包含失败任务与原因');
  assert.ok(b.network && Array.isArray(b.network.checks), '应包含网络自检结果');
  assert.ok(b.markers.length > 20);
  assert.ok(b.disk && typeof b.disk.freeBytes === 'number');
  assert.ok(b.tools && b.tools.ytdlp);

  // 密钥脱敏
  const envText = JSON.stringify(b.env);
  assert.equal(envText.includes('test-token'), false, 'ANDROID_TOKEN 不得出现在诊断包里');
  assert.equal(envText.includes('super-secret-value'), false);
  assert.equal(String(b.settings.encryptPassword).includes('ec3e458fcde2582e079f19368abc780f'), false, '加密密码应为掩码');
});
