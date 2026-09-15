import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../core/config';
import { filesRepo, tasksRepo } from '../core/db';
import { computeStats } from '../core/db';
import { freeBytes } from '../core/disk';
import { logger } from '../core/logger';
import { cleanupPublished } from '../services/cleanup';
import { getSettings } from '../services/settings';
import { asyncHandler, badRequest, notFound, unauthorized } from '../utils/http';
import type { PublishedFile } from '../types';

export const androidRouter = Router();

/** 安卓端所有请求都留痕（含鉴权失败），便于排查 App 连不上的问题 */
androidRouter.use((req, _res, next) => {
  logger.child('android').mark('ANDROID', `${req.method} ${req.originalUrl}`, {
    token: req.headers['x-auth-token'] ? '(有)' : req.query.token ? '(query)' : '(无)',
    ua: req.headers['user-agent'],
  });
  next();
});

/** 安卓接口鉴权：X-Auth-Token 或 ?token= */
function requireToken(req: Request, _res: Response, next: NextFunction): void {
  const token = config.androidToken;
  if (!token) {
    next(unauthorized('服务端未配置 ANDROID_TOKEN，安卓接口已关闭', 'ANDROID_DISABLED'));
    return;
  }
  const provided = String(req.header('x-auth-token') ?? req.query.token ?? '');
  if (provided !== token) {
    next(unauthorized('token 无效', 'INVALID_TOKEN'));
    return;
  }
  next();
}

androidRouter.use(requireToken);

function toAndroidFile(row: NonNullable<ReturnType<typeof filesRepo.get>>): Omit<PublishedFile, 'downloaded' | 'downloadedAt'> & { url: string } {
  return {
    // 这个接口只返回"磁盘上还在"的文件（下面已过滤），所以对安卓端来说永远是 true
    available: true,
    id: row.id,
    name: row.name,
    title: row.title,
    module: row.module,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    downloadUrl: `/api/android/download/${row.id}`,
    url: `/api/android/download/${row.id}?token=${encodeURIComponent(config.androidToken)}`,
  };
}

/** 待下载清单（安卓轮询这个接口） */
androidRouter.get('/files', (req, res) => {
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Number(req.query.pageSize ?? 200) || 200;
  const { rows, total, sum } = filesRepo.list({ pendingOnly: true, page, pageSize });
  res.json({
    items: rows.map(toAndroidFile),
    total,
    totalBytes: sum,
    freeBytes: freeBytes(),
    reserveBytes: getSettings().reserveFreeBytes,
  });
});

/**
 * 局域网测速用的数据流：凭空吐 N MB，**完全不碰磁盘**。
 * 用途：把"网络慢"和"磁盘/aria2 慢"彻底分开 —— 手机浏览器打开 /api/android/speedtest
 * 跑出来的数字就是这条链路（手机 ↔ 路由器 ↔ 树莓派）的真实上限。
 * 如果这里就慢，换 aria2 参数、换硬盘都没用，只能换 5GHz/有线。
 */
const SPEED_CHUNK: Buffer = (() => {
  // 伪随机填充：走 https/压缩代理时也不会被压掉，测出来才是真带宽
  const buf = Buffer.alloc(256 * 1024);
  let seed = 0x9e3779b9;
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0xffffffff;
    buf[i] = (seed >>> 16) & 0xff;
  }
  return buf;
})();

androidRouter.get(
  '/speedtest/data',
  asyncHandler(async (req, res) => {
    const mb = Math.min(Math.max(Number(req.query.mb ?? 50) || 50, 1), 500);
    const total = mb * 1024 * 1024;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(total));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Accept-Ranges', 'none');
    let sent = 0;
    let closed = false;
    // 客户端中途取消（手机锁屏、用户返回）时别再挂着等 drain
    res.on('close', () => {
      closed = true;
    });
    const pump = (): void => {
      while (!closed && sent < total) {
        const n = Math.min(SPEED_CHUNK.length, total - sent);
        sent += n;
        const ok = res.write(n === SPEED_CHUNK.length ? SPEED_CHUNK : SPEED_CHUNK.subarray(0, n));
        if (!ok) {
          res.once('drain', pump);
          return;
        }
      }
      if (!closed) res.end();
    };
    pump();
  }),
);

/** 手机上直接打开的测速页：跑三轮，把 MB/s 用大字打出来，并告诉用户这个数字意味着什么 */
androidRouter.get('/speedtest', (req, res) => {
  const token = String(req.query.token ?? '');
  const mb = Math.min(Math.max(Number(req.query.mb ?? 50) || 50, 5), 500);
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>局域网测速 · ttdownload</title>
<style>
  body{font-family:-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;background:#12141a;color:#e8eaf0;margin:0;padding:18px}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:#8b93a7;font-size:13px;margin-bottom:16px;line-height:1.6}
  .big{font-size:52px;font-weight:700;line-height:1.1;letter-spacing:-1px}
  .unit{font-size:20px;color:#8b93a7;font-weight:400}
  .bar{height:10px;background:#232735;border-radius:5px;overflow:hidden;margin:14px 0}
  .bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#22c55e);transition:width .15s}
  .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #232735;font-size:14px}
  .row b{font-variant-numeric:tabular-nums}
  .verdict{margin-top:16px;padding:13px;border-radius:9px;background:#1b1f2b;font-size:14px;line-height:1.7}
  .ok{color:#22c55e}.warn{color:#f59e0b}.bad{color:#ef4444}
  button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:9px;background:#3b82f6;color:#fff;font-size:16px;font-weight:600}
  button:disabled{background:#39405a;color:#8b93a7}
  code{background:#232735;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body>
<h1>局域网测速</h1>
<div class="sub">测的是 <b>手机 ↔ 路由器 ↔ 树莓派</b> 这条链路，数据由服务端凭空生成，<b>不读硬盘</b>。<br>
所以要跑得慢，只可能是网络（wifi）慢，跟 aria2、硬盘、BT 都没关系。</div>
<div class="big"><span id="v">—</span> <span class="unit">MB/s</span></div>
<div class="bar"><i id="p"></i></div>
<div class="row"><span>已传输</span><b id="got">0 MB</b></div>
<div class="row"><span>用时</span><b id="ms">0 s</b></div>
<div class="row"><span>第几轮</span><b id="round">0 / 3</b></div>
<div class="verdict" id="verdict">点下面的按钮开始（每轮 ${mb} MB，共 3 轮）</div>
<button id="go">开始测速</button>
<div class="sub" style="margin-top:18px">参考：2.4GHz wifi 一般 4~8 MB/s；5GHz 好信号 20~40 MB/s；千兆有线 90+ MB/s。<br>
命令行的等价验证：<code>curl -o /dev/null http://服务器IP:8080/api/android/speedtest/data?mb=100&token=...</code></div>
<script>
var TOKEN = ${JSON.stringify(token)}, MB = ${mb};
function set(id, t){ document.getElementById(id).textContent = t }
function runOne(i){
  return new Promise(function(resolve){
    var t0 = performance.now(), lastT = t0, lastL = 0;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/android/speedtest/data?mb=' + MB + '&r=' + Math.random() + '&token=' + encodeURIComponent(TOKEN), true);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = function(e){
      var now = performance.now(), dt = (now - lastT) / 1000;
      if (dt > 0.25 && e.loaded > lastL) {
        var inst = (e.loaded - lastL) / 1048576 / dt;
        set('v', inst.toFixed(1));
        lastT = now; lastL = e.loaded;
      }
      set('got', (e.loaded / 1048576).toFixed(1) + ' MB');
      set('ms', ((now - t0) / 1000).toFixed(1) + ' s');
      set('p', Math.min(100, e.loaded / (MB * 1048576) * 100) + '%');
    };
    xhr.onload = xhr.onerror = function(){
      var secs = (performance.now() - t0) / 1000;
      var got = (xhr.response ? xhr.response.byteLength : 0) / 1048576;
      resolve({ mbs: secs > 0 ? got / secs : 0, got: got, secs: secs, err: xhr.status !== 200 });
    };
    xhr.send();
  });
}
document.getElementById('go').onclick = function(){
  var btn = this; btn.disabled = true; btn.textContent = '测速中…';
  var rs = [];
  (function next(i){
    if (i >= 3) {
      var good = rs.filter(function(r){ return !r.err });
      var avg = good.length ? good.reduce(function(a,b){ return a + b.mbs }, 0) / good.length : 0;
      set('v', avg.toFixed(1));
      set('round', '3 / 3');
      var cls = avg >= 20 ? 'ok' : (avg >= 8 ? 'warn' : 'bad');
      var txt;
      if (avg >= 40) txt = '这条链路 <b class="ok">很快</b>（相当于千兆有线/优质5GHz）。如果这样 aria2 还是慢，那问题在 aria2 参数或手机写入速度，把日志发我。';
      else if (avg >= 15) txt = '这条链路 <b class="ok">正常</b>（像样的 5GHz）。aria2 大概能跑到这个量级的 70~90%。';
      else if (avg >= 8) txt = '这条链路 <b class="warn">偏慢</b>，典型的 2.4GHz wifi。就算 aria2 参数调到天上去，也就这个上限了 —— 换 5GHz 或插网线才能快。';
      else txt = '这条链路 <b class="bad">很慢</b>（${'<'}8 MB/s）。慢的是 wifi 信号/干扰/距离，不是服务器、不是 aria2、不是硬盘。';
      document.getElementById('verdict').innerHTML = txt + '<br><br>三轮结果：' + rs.map(function(r,i){ return '#' + (i+1) + ' ' + r.mbs.toFixed(1) });
      btn.disabled = false; btn.textContent = '再测一次';
      return;
    }
    set('round', (i + 1) + ' / 3');
    set('p', '0%');
    runOne(i).then(function(r){ rs.push(r); next(i + 1) });
  })(0);
};
</script></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

/** 文件下载（支持 Range 断点续传；token 可用 query，方便 aria2 直接下） */
androidRouter.get(
  '/download/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const file = filesRepo.get(id);
    if (!file) throw notFound('文件不存在', 'FILE_NOT_FOUND');
    if (!fs.existsSync(file.path)) throw notFound('磁盘上的文件已不存在', 'FILE_MISSING');

    const stat = fs.statSync(file.path);
    const range = req.header('range');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file.name)}"`);

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) throw badRequest('Range 头格式错误');
      const start = m[1] ? Number.parseInt(m[1], 10) : 0;
      const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      // 只在第一块（start=0）记一次，避免 aria2 多线程分片把下载次数刷爆
      if (start === 0) {
        filesRepo.trackDownload(id, 'android');
        logger.child('android').mark('FILE_DOWNLOAD', `安卓端开始下载成品文件 #${id}`, { name: file.name, sizeBytes: stat.size });
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(file.path, { start, end }).pipe(res);
      return;
    }

    // 整文件下载（不带 Range）
    filesRepo.trackDownload(id, 'android');
    logger.child('android').mark('FILE_DOWNLOAD', `安卓端开始下载成品文件 #${id}`, { name: file.name, sizeBytes: stat.size });
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(file.path).pipe(res);
  }),
);

/** 上报下载完成：删除服务器文件，腾出空间 */
androidRouter.post(
  '/done',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const raw = Array.isArray(body.ids) ? body.ids : body.id !== undefined ? [body.id] : [];
    const ids = raw.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n));
    if (ids.length === 0) throw badRequest('请提供 ids（数组）或 id', 'MISSING_IDS');
    const result = cleanupPublished(ids);
    logger.info(`安卓上报完成：${ids.join(',')} → 删除 ${result.deleted} 个，释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)}MB`);
    res.json(result);
  }),
);

/** 状态（App 自检/展示） */
androidRouter.get('/status', (_req, res) => {
  const stats = computeStats();
  return res.json({
    ok: true,
    freeBytes: freeBytes(),
    reserveBytes: getSettings().reserveFreeBytes,
    publishedCount: filesRepo.list({ pageSize: 1 }).total,
    publishedBytes: filesRepo.list({ pageSize: 1 }).sum,
    waitingTasks: tasksRepo.list({ statuses: ['waiting', 'paused'], pageSize: 1 }).total,
    downloadingTasks: stats.downloading,
    version: config.version,
  });
});
