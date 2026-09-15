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
import { execFileSync } from 'node:child_process';
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
if [ -n "$YTDLP_FAIL_IDS" ]; then
  for id in $(echo "$YTDLP_FAIL_IDS" | tr ',' ' '); do
    case "$*" in *"$id"*) echo "ERROR: [youtube] $id: This video is unavailable" >&2; exit 1 ;; esac
  done
fi
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

async function reqBinary(p) {
  const res = await fetch(base + p);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}

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
  // overall 取决于真实外网（https-google/youtube/github 三项），这里只做一致性校验：
  // 基础网络全通过 → 因为 yt-dlp 链路已通过，overall 必须是 ok；否则必须是 fail。
  //
  // 例外：egress-ip / bilibili-egress 这两项判的是「出口 IP 会不会被站点风控」，
  // 不是「外网通不通」—— 测试机出口正好是境外机房（Oracle），这两项必然 fail，
  // 但它们不该把 overall 拖成「基础外网不通」（那会给出完全错误的建议）。
  const SITE_RISK_IDS = new Set(['egress-ip', 'bilibili-egress']);
  const netFailures = report.checks.filter(
    (c) => c.group === 'net' && c.id !== 'proxy' && !SITE_RISK_IDS.has(c.id) && c.status === 'fail',
  );
  if (netFailures.length === 0) {
    assert.equal(report.overall, 'ok', '基础网络与 yt-dlp 链路都通过时 overall 应为 ok');
  } else {
    assert.equal(report.overall, 'fail', `基础网络有失败项时 overall 应为 fail（失败项：${netFailures.map((c) => c.id).join(',')}）`);
  }
  // 出口 IP 有风险时，结论摘要必须把这件事说出来（否则用户只会看到一片绿）
  const egress = report.checks.find((c) => c.id === 'egress-ip');
  const bili = report.checks.find((c) => c.id === 'bilibili-egress');
  assert.ok(egress && bili, '网络自检应包含「出口 IP 归属」与「B站可达性」两项');
  assert.ok(egress.detail.includes('出口 IP'), `应报出出口 IP 与归属，实际：${egress.detail}`);
  if (egress.status === 'fail' || bili.status === 'fail') {
    assert.match(report.summary, /出口 IP|B站/, '出口被风控时摘要里要点出来');
  }
  // 无论外网如何，yt-dlp 三项检查必须是确定的（用假 yt-dlp + 本地 CDN 服务）
  assert.equal(byId['ytdlp-version'].status, 'ok');
  assert.equal(byId['ytdlp-youtube-meta'].status, 'ok');
  assert.equal(byId['youtube-cdn'].status, 'ok');
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

/* ------------------------------------------------------------------ */
/* 问题反馈：报告下载页相关接口                                          */
/* ------------------------------------------------------------------ */

test('GET /api/system/report/list：列出所有可下载的信息文件', async () => {
  const res = await req('/api/system/report/list');
  assert.equal(res.status, 200);
  const d = res.json;
  assert.equal(typeof d.zipAvailable, 'boolean');
  assert.equal(typeof d.generatedAt, 'string');
  assert.ok(['error', 'warn', 'info', 'debug', 'trace'].includes(d.logLevel));
  assert.ok(Array.isArray(d.reports));

  const ids = d.items.map((i) => i.id);
  for (const need of ['report', 'diagnostics', 'errors', 'app-log', 'deploy-log', 'tasks', 'tasks-csv', 'network']) {
    assert.ok(ids.includes(need), `缺少下载项 ${need}`);
  }
  for (const item of d.items) {
    assert.equal(typeof item.title, 'string');
    assert.ok(item.title.length > 0, '每项都要有中文标题');
    assert.ok(item.description.length > 5, '每项都要有说明');
    assert.match(item.url, /^\/api\//, 'url 应是可直接下载的 /api 路径');
    assert.ok(['zip', 'json', 'log', 'csv'].includes(item.kind));
  }
  // 推荐项排第一，且指向一键报告
  assert.equal(d.items[0].id, 'report');
  assert.equal(d.items[0].recommended, true);
  assert.equal(d.items[0].url, '/api/system/report');
  // 应用日志项应带上真实大小（此时已有日志写入）
  const appLog = d.items.find((i) => i.id === 'app-log');
  assert.ok(appLog.sizeBytes === null || appLog.sizeBytes > 0);
});

test('GET /api/system/report：一键下载完整报告（zip 或 json），内容含关键文件且密钥脱敏', async () => {
  loggerMod.logger.child('report-test').mark('TASK_FAIL', '报告测试用的失败行 :: {"token":"super-secret-value"}');
  const res = await reqBinary('/api/system/report');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-disposition')), /attachment; filename="ttdownload-report-.*\.(zip|json)"/);
  assert.ok(res.buf.length > 500, '报告不应为空');

  const isZip = res.buf.slice(0, 2).toString() === 'PK';
  if (isZip) {
    assert.match(String(res.headers.get('content-type')), /zip/);
    const tmp = path.join(root, 'report-under-test.zip');
    fs.writeFileSync(tmp, res.buf);
    const listing = execFileSync('unzip', ['-l', tmp], { encoding: 'utf8' });
    for (const need of ['README.txt', 'diagnostics.json', 'errors.log', 'app.log', 'tasks.json', 'network.json', 'markers.json']) {
      assert.ok(listing.includes(need), `报告里应包含 ${need}`);
    }
    const diagnostics = execFileSync('unzip', ['-p', tmp, 'diagnostics.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(diagnostics.includes('super-secret-value'), false, '报告里不得出现明文 token');
    assert.equal(diagnostics.includes('***'), true, '敏感字段应被打码');
    const errors = execFileSync('unzip', ['-p', tmp, 'errors.log'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(errors.includes('报告测试用的失败行'), 'errors.log 应包含 WARN/失败相关日志');
    const readme = execFileSync('unzip', ['-p', tmp, 'README.txt'], { encoding: 'utf8' });
    assert.ok(readme.includes('诊断报告'), 'README 应说明怎么用这份报告');
  } else {
    // 退化路径：单个 JSON，内容等价
    const bundle = JSON.parse(res.buf.toString('utf8'));
    assert.ok(Array.isArray(bundle.files));
    const names = bundle.files.map((f) => f.name);
    for (const need of ['README.txt', 'diagnostics.json', 'errors.log', 'app.log']) {
      assert.ok(names.includes(need), `JSON 报告里应包含 ${need}`);
    }
    assert.equal(res.buf.toString('utf8').includes('super-secret-value'), false, '报告里不得出现明文 token');
  }

  // 生成的报告可以在「历史报告」里再次下载
  const list = await req('/api/system/report/list');
  assert.ok(list.json.reports.length >= 1, '应记录已生成的报告');
  const again = await reqBinary(`/api/system/report/file?name=${encodeURIComponent(list.json.reports[0].name)}`);
  assert.equal(again.status, 200);
  assert.ok(again.buf.length > 500);
  // 目录穿越必须被拒绝
  const evil = await req('/api/system/report/file?name=../../etc/passwd');
  assert.equal(evil.status, 404);
});

test('GET /api/system/logs/export：只导出报错日志（warn 及以上）', async () => {
  loggerMod.logger.info('这条 INFO 不应出现在 warn 导出里');
  loggerMod.logger.warn('这条 WARN 应出现在 warn 导出里');
  const res = await req('/api/system/logs/export?level=warn&lines=1000');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/plain/);
  assert.match(String(res.headers.get('content-disposition')), /ttdownload-warn-log-.*\.log/);
  assert.ok(res.text.includes('这条 WARN 应出现在 warn 导出里'));
  assert.equal(res.text.includes('这条 INFO 不应出现在 warn 导出里'), false, 'warn 级别导出不应含 INFO 行');
  assert.ok(res.text.startsWith('# ttdownload-web 日志导出'), '应带说明头');

  // 按标记导出
  const byMarker = await req('/api/system/logs/export?level=all&marker=TASK_FAIL');
  assert.ok(byMarker.text.includes('TASK_FAIL'));
});

test('GET /api/system/report/tasks：JSON 与 CSV 两种格式', async () => {
  const failed = tasksRepo.create({ module: 'aria2', title: '报告页失败任务', url: 'http://x/1.bin', payload: {} });
  tasksRepo.update(failed.id, { status: 'failed', error: '报告页测试用失败原因' });

  const json = await req('/api/system/report/tasks');
  assert.equal(json.status, 200);
  assert.match(String(json.headers.get('content-disposition')), /ttdownload-tasks-.*\.json/);
  const body = JSON.parse(json.text);
  assert.ok(body.total >= 1);
  assert.ok(body.byStatus.failed >= 1);
  assert.ok(body.failed.some((f) => f.error === '报告页测试用失败原因'), '应包含失败原因');
  assert.ok(body.failed[0].retryCount !== undefined);

  const csv = await req('/api/system/report/tasks?format=csv');
  assert.match(String(csv.headers.get('content-type')), /text\/csv/);
  assert.match(String(csv.headers.get('content-disposition')), /ttdownload-tasks-.*\.csv/);
  const firstLine = csv.text.replace(/^\uFEFF/, '').split('\n')[0];
  assert.equal(firstLine, 'id,module,status,title,url,progress,error,retryCount,createdAt,finishedAt');
  assert.ok(csv.text.includes('报告页测试用失败原因'));
});

test('GET /api/system/report/network 与 /api/system/deploy-log', async () => {
  const net = await req('/api/system/report/network');
  assert.equal(net.status, 200);
  assert.match(String(net.headers.get('content-disposition')), /ttdownload-network-.*\.json/);
  const report = JSON.parse(net.text);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 8);
  assert.equal(report.cached, false, '下载的网络报告应强制重测');

  // 部署日志不存在时给出明确 404
  const missing = await req('/api/system/deploy-log');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error.message, /部署日志/);

  // 造一份部署日志后可下载
  const deployLog = path.join(config.dirs.state, 'logs', 'deploy.log');
  fs.mkdirSync(path.dirname(deployLog), { recursive: true });
  fs.writeFileSync(deployLog, '[deploy] 测试部署日志第一行\n[deploy] 第二行\n');
  const got = await req('/api/system/deploy-log');
  assert.equal(got.status, 200);
  assert.match(String(got.headers.get('content-disposition')), /deploy\.log/);
  assert.ok(got.text.includes('测试部署日志第一行'));
});

test('一键报告带网络自检预算：即使网络自检很慢也会在预算内返回', async () => {
  netCheck.resetNetworkCache(); // 清缓存，让报告必须（在预算内）自己处理
  const started = Date.now();
  const res = await reqBinary('/api/system/report');
  const ms = Date.now() - started;
  assert.equal(res.status, 200);
  assert.ok(ms < 20000, `报告生成不应被网络自检拖太久，实际 ${ms}ms`);
  assert.ok(res.buf.length > 500);
});

test('networkReportWithBudget：缓存命中时直接返回缓存，不重新测试', async () => {
  await netCheck.networkReport(true); // 先跑一次，写入缓存
  const cached = await netCheck.networkReportWithBudget(5000);
  assert.equal(cached.cached, true);
  assert.ok(cached.checks.length >= 8, '缓存里应有完整检查项');
});

/** 直接验证 gitInfo 使用了 safe.directory（服务以 root 跑在普通用户仓库里时必需） */
test('gitInfo 带 -c safe.directory，能在 root 访问他人仓库时读到版本', async () => {
  const { gitInfo } = await import('../dist/services/report.js');
  assert.equal(typeof gitInfo, 'function');
  // 本项目目录是 git 仓库（测试环境即如此）；关键断言：调用不会抛错，且带了 safe.directory
  const src = fs.readFileSync('src/services/report.ts', 'utf8');
  assert.match(src, /safe\.directory=\*/, 'gitInfo 必须带 -c safe.directory=*，否则 root 读他人仓库会被 git 拒绝');
  const info = gitInfo();
  if (info) {
    assert.match(info.commit, /^[0-9a-f]{40}$/);
  }
});

test('报告里带代码版本（git commit），便于把日志和代码版本对应起来', async () => {
  const sysRes = await req('/api/system/report/list');
  assert.equal(sysRes.status, 200);

  const bundle = JSON.parse((await req('/api/system/diagnostics')).text);
  const git = bundle.app.git;
  if (git) {
    assert.match(git.commit, /^[0-9a-f]{40}$/);
    assert.equal(git.shortCommit.length, 7);
    assert.ok(typeof git.branch === 'string' && git.branch.length > 0);
    assert.ok(typeof git.dirty === 'boolean');
  } else {
    // 非 git 目录（例如 scp 上传）时允许为 null，但字段必须存在
    assert.equal(git, null);
  }

  // README 里也要写版本
  const res = await reqBinary('/api/system/report');
  if (res.buf.slice(0, 2).toString() === 'PK') {
    const tmp = path.join(root, 'report-git.zip');
    fs.writeFileSync(tmp, res.buf);
    const readme = execFileSync('unzip', ['-p', tmp, 'README.txt'], { encoding: 'utf8' });
    assert.match(readme, /代码版本：/);
  }
});

/* ------------------------------------------------------------------ */
/* 按真实报告发现的三个问题回归                                         */
/* ------------------------------------------------------------------ */

test('HTTPS 探测：4xx 是「链路可达但被目标站拒绝」，不得误报网络不通', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/forbidden') {
      res.writeHead(403).end('nope');
      return;
    }
    if (req.url === '/boom') {
      res.writeHead(502).end('bad gateway');
      return;
    }
    res.writeHead(204).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await netCheck.probeHttp(`${b}/ok`, 3000);
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 204);

    const forbidden = await netCheck.probeHttp(`${b}/forbidden`, 3000);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.ok, true, 'GitHub 对共享出口限流返回 403，不能当成网络不通');
    assert.match(forbidden.detail, /链路可达/);

    const boom = await netCheck.probeHttp(`${b}/boom`, 3000);
    assert.equal(boom.status, 502);
    assert.equal(boom.ok, false, '5xx 才算链路有问题');

    const dead = await netCheck.probeHttp('http://127.0.0.1:1/nothing', 1500);
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 0);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('网络自检的 aria2 项能区分「未安装」与「已安装但没起来」', async () => {
  netCheck.resetNetworkCache();
  const report = await netCheck.networkReport(true);
  const aria2 = report.checks.find((c) => c.id === 'aria2-rpc');
  assert.ok(aria2, '应有 aria2 检查项');
  // 测试机没有 aria2c：应明确说「未安装」，并给 apt 建议
  assert.match(aria2.detail, /aria2c (未安装|已安装)/, `aria2 项应说明安装状态，实际：${aria2.detail}`);
  if (!aria2.detail.includes('未安装')) {
    assert.match(aria2.detail, /RPC .* 连不上|可用/);
  }
  if (aria2.status === 'fail') {
    assert.ok(aria2.hint && aria2.hint.length > 0);
  }
});

test('YouTube 元数据自检：首个候选视频不可用时自动换下一个', async () => {
  const first = 'jNQXAC9IVRw';
  process.env.YTDLP_FAIL_IDS = first;
  netCheck.resetNetworkCache();
  try {
    const report = await netCheck.networkReport(true);
    const meta = report.checks.find((c) => c.id === 'ytdlp-youtube-meta');
    assert.equal(meta.status, 'ok', `首个候选失败时应回退到下一个候选，实际：${meta.detail}`);
    assert.match(meta.detail, /候选失败/, '应说明有候选视频解析失败过');
    assert.match(meta.detail, /Big Buck Bunny|yt-dlp 官方测试视频/, '应换用后面的候选并汇报成功');
  } finally {
    delete process.env.YTDLP_FAIL_IDS;
    netCheck.resetNetworkCache();
  }
});

test('日志净化：含 NUL/控制字符/其它编码残留时，日志文件仍是纯文本（grep 不会报 binary）', async () => {
  loggerMod.clearLogs();
  // 模拟真实的脏数据：其它编码的种子名 + NUL + 控制字符 + 超长二进制片段
  const dirty = `种子名:\u0000\u0001 中文名称\u0085 x${String.fromCharCode(0x1b)}[31m` + Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('latin1');
  loggerMod.logger.child('dirty').mark('PROC_EXIT', `脏输出: ${dirty}`, { stdout: dirty, raw: dirty });

  const content = fs.readFileSync(config.logPath);
  assert.equal(content.includes(0), false, '日志文件里不应有 NUL 字节');
  assert.ok(content.toString('utf8').includes('MARK:PROC_EXIT'));
  assert.equal(loggerMod.logFileIsText(), true, 'logFileIsText 应判定为纯文本');

  // 关键：grep 不再把它当二进制
  const grep = execFileSync('grep', ['-c', 'MARK:PROC_EXIT', config.logPath], { encoding: 'utf8' });
  assert.ok(Number(grep.trim()) >= 1);
  const grepNoA = execFileSync('grep', ['MARK:PROC_EXIT', config.logPath], { encoding: 'utf8' });
  assert.ok(grepNoA.includes('MARK:PROC_EXIT'), '不加 -a 也应能正常输出');
});

/* ------------------------------------------------------------------ */
/* cookies 结构校验 + 「下载后清空日志」开关                             */
/* ------------------------------------------------------------------ */

test('cookies 结构校验：缺头/缺关键字段/过期都会给出中文告警', async () => {
  const webvideo = await import('../dist/modules/webvideo.js');
  const dir = path.join(root, 'state');
  fs.mkdirSync(dir, { recursive: true });

  // 1) 正常文件
  const good = path.join(dir, 'good-cookies.txt');
  fs.writeFileSync(
    good,
    [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t9999999999\t__Secure-1PSID\tAAA',
      '.youtube.com\tTRUE\t/\tTRUE\t9999999999\t__Secure-3PSID\tBBB',
      '.youtube.com\tTRUE\t/\tTRUE\t9999999999\tLOGIN_INFO\tCCC',
      '.google.com\tTRUE\t/\tFALSE\t9999999999\tSID\tDDD',
      '.google.com\tTRUE\t/\tFALSE\t9999999999\tHSID\tEEE',
      '.google.com\tTRUE\t/\tFALSE\t9999999999\tSSID\tFFF',
      '.google.com\tTRUE\t/\tFALSE\t9999999999\tAPISID\tGGG',
      '.google.com\tTRUE\t/\tFALSE\t9999999999\tSAPISID\tHHH',
    ].join('\n'),
  );
  const g = webvideo.inspectCookiesFile(good);
  assert.equal(g.stats.hasHeader, true);
  assert.equal(g.stats.hasYoutubeDomain, true);
  assert.equal(g.stats.hasGoogleDomain, true);
  assert.equal(g.stats.total, 8);
  assert.equal(g.stats.keys.SID, true);
  assert.equal(g.stats.keys['__Secure-1PSID'], true);
  assert.equal(g.stats.expiredCount, 0);
  // 关键字段必须全部显式列出（false=缺失），前端无需自己维护清单
  const allKeys = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];
  for (const k of allKeys) assert.equal(typeof g.stats.keys[k], 'boolean', `keys.${k} 应为布尔`);

  // 2) 只有 youtube.com、没有 google.com；且有已过期项
  const partial = path.join(dir, 'partial-cookies.txt');
  fs.writeFileSync(
    partial,
    ['# Netscape HTTP Cookie File', '.youtube.com\tTRUE\t/\tTRUE\t1000000000\tPREF\tx'].join('\n'),
  );
  const pr = webvideo.inspectCookiesFile(partial);
  assert.equal(pr.valid, false);
  assert.ok(pr.warnings.some((w) => w.includes('google.com')), '应提示缺 google.com');
  assert.ok(pr.warnings.some((w) => w.includes('关键登录 cookie')), '应提示缺关键登录 cookie');
  assert.equal(pr.stats.expiredCount, 1);
  assert.ok(pr.warnings.some((w) => w.includes('过期')));

  // 3) 完全不是 cookies.txt
  const junk = path.join(dir, 'junk-cookies.txt');
  fs.writeFileSync(junk, '{"cookies": "这是 JSON，不是 Netscape 格式"}');
  const jr = webvideo.inspectCookiesFile(junk);
  assert.equal(jr.valid, false);
  assert.ok(jr.warnings.some((w) => w.includes('没解析出任何 cookie')));
  assert.ok(jr.warnings.some((w) => w.includes('Netscape')));

  // 4) cookiesStatus 会把校验结果带出来
  const { updateSettings } = await import('../dist/services/settings.js');
  const before = { ...(await import('../dist/services/settings.js')).getSettings() };
  updateSettings({ webvideoCookiesFile: good });
  const status = await webvideo.cookiesStatus();
  assert.equal(status.exists, true);
  assert.equal(status.valid, true);
  assert.equal(status.stats.total, 8);
  assert.ok(Array.isArray(status.warnings));
  assert.ok(status.notes.some((n) => n.includes('主账号')), '多账号说明应作为提示（notes）而不是错误');
  assert.deepEqual(status.warnings, [], '结构正常的 cookies 不应有警告');
  updateSettings({ webvideoCookiesFile: before.webvideoCookiesFile });
});

test('网络自检包含「yt-dlp JS 运行时」项（缺 deno 时必须明确报失败并给指引）', async () => {
  netCheck.resetNetworkCache();
  const report = await netCheck.networkReport(true);
  const js = report.checks.find((c) => c.id === 'ytdlp-jsruntime');
  assert.ok(js, '自检应有 yt-dlp JS 运行时项');
  assert.equal(js.group, 'ytdlp');
  assert.ok(['ok', 'fail'].includes(js.status));
  if (js.status === 'fail') {
    assert.ok(js.hint && /fix-ytdlp|deno/i.test(js.hint), `失败时应指引装 deno/fix-ytdlp.sh，实际：${js.hint}`);
    assert.match(js.detail, /deno|bun|quickjs|node/, '应说明检测到了什么');
  } else {
    assert.match(js.detail, /可用/);
  }
});

test('网络自检包含 cookies 检查项（未配置时明确说 skip + 指引）', async () => {
  netCheck.resetNetworkCache();
  const report = await netCheck.networkReport(true);
  const cookies = report.checks.find((c) => c.id === 'cookies');
  assert.ok(cookies, '自检应有 cookies 项');
  assert.ok(['ok', 'fail', 'skip'].includes(cookies.status));
  assert.equal(cookies.group, 'ytdlp');
  assert.ok(cookies.detail.length > 0);
  if (cookies.status !== 'ok') assert.ok(cookies.hint && cookies.hint.length > 0, '非 ok 时应给建议');
});

test('「下载后清空已有日志」：开关可保存、report/list 会带出来', async () => {
  const off = await req('/api/system/report/list');
  assert.equal(off.json.clearLogsAfterReport, false);

  const put = await req('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearLogsAfterReport: true }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.clearLogsAfterReport, true);

  const on = await req('/api/system/report/list');
  assert.equal(on.json.clearLogsAfterReport, true);

  await req('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearLogsAfterReport: false }),
  });
});

test('下载诊断报告后清空日志：报告里仍有内容，磁盘上的日志被清空', async () => {
  loggerMod.clearLogs();
  loggerMod.logger.child('clear-test').mark('TASK_CREATE', '清空测试专用标记行-CLEARMARK');
  const before = await req('/api/system/logs?lines=50');
  assert.ok(before.json.lines.some((l) => l.includes('CLEARMARK')), '清空前应能读到该行');

  // ?clear=1 强制清空
  const res = await reqBinary('/api/system/report?clear=1');
  assert.equal(res.status, 200);
  assert.ok(Number(res.headers.get('x-logs-cleared') ?? '0') >= 1, '应返回清空的文件数');

  // 报告内容仍然完整（清空发生在报告生成之后）
  const tmp = path.join(root, 'report-clear.zip');
  if (res.buf.slice(0, 2).toString() === 'PK') {
    fs.writeFileSync(tmp, res.buf);
    const inside = execFileSync('unzip', ['-p', tmp, 'app.log'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(inside.includes('CLEARMARK'), '报告里的 app.log 应包含清空前的日志');
  } else {
    assert.ok(res.buf.toString('utf8').includes('CLEARMARK'), 'JSON 报告里应包含清空前的日志');
  }

  const after = await req('/api/system/logs?lines=50');
  assert.equal(
    after.json.lines.some((l) => l.includes('CLEARMARK')),
    false,
    '下载报告后日志应已清空（只剩本次请求自身产生的日志）',
  );
});
