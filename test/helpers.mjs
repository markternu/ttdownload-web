/**
 * 测试公共工具：环境隔离 + mock 外部服务
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/** 创建独立运行目录并设置环境变量（必须在 import dist 之前调用） */
export function setupRuntime(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-test-'));
  process.env.DOWNLOAD_ROOT = root;
  process.env.RESERVE_FREE_BYTES = String(extra.reserveFreeBytes ?? 1024 * 1024);
  process.env.ANDROID_TOKEN = extra.androidToken ?? 'test-token';
  // 注意：这里是**测试脚手架**的默认值（3），不是生产默认值。
  // 生产默认是 0=不限（准入只由磁盘空间决定），要测那套行为请显式传 env（见
  // test/disk-driven-admission.test.mjs）——否则一大堆老测试会因为"任务全被放行"
  // 而互相干扰。
  process.env.MAX_CONCURRENT = String(extra.maxConcurrent ?? 3);
  process.env.SCHEDULER_INTERVAL_MS = String(extra.schedulerIntervalMs ?? 100000);
  process.env.PIPELINE_INTERVAL_MS = String(extra.pipelineIntervalMs ?? 100000);
  process.env.LOG_PATH = path.join(root, 'state', 'app.log');
  if (extra.env) Object.assign(process.env, extra.env);
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

export function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 在 root 下创建文件 */
export function tmpFile(root, name, content = 'x') {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 通用 JSON-RPC mock 服务器 */
export function startJsonRpcServer(handle) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      const out = handle(msg, req);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json', ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * mock aria2 JSON-RPC。
 * state.tasks: Map<gid,{status,total,completed,file}>
 * state.complete: Set<gid> 中的任务视为已完成（并确保文件存在、无 .aria2 控制文件）
 */
export async function startAria2Mock({ workDir }) {
  const state = { tasks: new Map(), seq: 0 };
  const mock = await startJsonRpcServer((msg) => {
    const params = msg.params ?? [];
    const rest = typeof params[0] === 'string' && params[0].startsWith('token:') ? params.slice(1) : params;
    const ok = (result) => ({ body: { jsonrpc: '2.0', id: msg.id, result } });
    const err = (code, message) => ({ body: { jsonrpc: '2.0', id: msg.id, error: { code, message } } });
    switch (msg.method) {
      case 'aria2.getVersion':
        return ok({ version: '1.37.0-mock' });
      case 'aria2.getGlobalStat':
        return ok({ numWaiting: '0', numActive: '0', numStopped: '0' });
      case 'aria2.addUri': {
        state.seq += 1;
        const gid = `mock${state.seq}`;
        const url = rest[0]?.[0] ?? '';
        const out = rest[1]?.out ?? `file${state.seq}.bin`;
        const file = path.join(workDir, out);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        state.tasks.set(gid, { status: 'active', total: 2048, completed: 1024, file, url });
        return ok(gid);
      }
      case 'aria2.tellStatus': {
        const t = state.tasks.get(String(rest[0]));
        if (!t) return err(1, 'not found');
        if (t.status === 'complete') {
          fs.writeFileSync(t.file, Buffer.alloc(t.total, 7));
          fs.rmSync(`${t.file}.aria2`, { force: true });
        }
        return ok({
          gid: String(rest[0]),
          status: t.status,
          totalLength: String(t.total),
          completedLength: String(t.completed),
          downloadSpeed: '1024',
          files: [{ path: t.file, selected: 'true' }],
          dir: path.dirname(t.file),
        });
      }
      case 'aria2.pause':
      case 'aria2.unpause':
      case 'aria2.remove':
      case 'aria2.removeDownloadResult':
        return ok('OK');
      default:
        return err(1, `unknown ${msg.method}`);
    }
  });
  return {
    ...mock,
    state,
    complete(gid) {
      const t = state.tasks.get(gid);
      if (t) {
        t.status = 'complete';
        t.completed = t.total;
      }
    },
    setProgress(gid, { total, completed }) {
      const t = state.tasks.get(gid);
      if (!t) return;
      if (total !== undefined) t.total = total;
      if (completed !== undefined) t.completed = completed;
    },
  };
}

/** mock transmission RPC（带 409 session 协商）；state.complete 控制完成态 */
export async function startTransmissionMock({ downloadDir, torrentName = 'Demo', files, sessionExtra } = {}) {
  let session = '';
  const state = {
    running: false,
    complete: false,
    name: torrentName,
    percent: 0.5,
    rateDownload: 2048,
    eta: 30,
    peersConnected: 5,
    removed: [],
    torrents: [],
    torrentSets: [],
    torrentAdds: [],
    wanted: (files ?? [
      { name: 'video.mp4', length: 1000, bytesCompleted: 0 },
      { name: 'cover.jpg', length: 100, bytesCompleted: 0 },
      { name: 'readme.txt', length: 50, bytesCompleted: 0 },
    ]).map(() => 1),
    downloadDir,
    files: files ?? [
      { name: 'video.mp4', length: 1000, bytesCompleted: 0 },
      { name: 'cover.jpg', length: 100, bytesCompleted: 0 },
      { name: 'readme.txt', length: 50, bytesCompleted: 0 },
    ],
  };
  const mock = await startJsonRpcServer((msg, req) => {
    if (req.headers['x-transmission-session-id'] !== session) {
      session = 'sess-123';
      return { status: 409, headers: { 'X-Transmission-Session-Id': session }, body: {} };
    }
    const args = msg.arguments ?? {};
    const ok = (result, extra = {}) => ({ body: { result, arguments: extra } });
    switch (msg.method) {
      case 'session-get':
        return ok('success', { version: '4.0.5-mock', ...(sessionExtra ?? {}) });
      case 'torrent-add':
        state.torrentAdds.push(args);
        return ok('success', { 'torrent-added': { id: 7, name: state.name, hashString: 'abc' } });
      case 'torrent-set': {
        state.torrentSets.push(args);
        if (Array.isArray(args['files-wanted'])) for (const i of args['files-wanted']) if (state.wanted[i] !== undefined) state.wanted[i] = 1;
        if (Array.isArray(args['files-unwanted'])) for (const i of args['files-unwanted']) if (state.wanted[i] !== undefined) state.wanted[i] = 0;
        return ok('success', {});
      }
      case 'torrent-remove':
        state.removed.push({ ids: args.ids, deleteLocalData: args['delete-local-data'] === true });
        state.running = false;
        return ok('success', {});
      case 'torrent-start':
        state.running = true;
        return ok('success', {});
      case 'torrent-stop':
        state.running = false;
        return ok('success', {});
      case 'torrent-get': {
        // 支持直接给一组"命名种子"（扫货测试要用多个不同名字的种子）
        if (Array.isArray(state.torrents) && state.torrents.length) {
          return ok('success', {
            torrents: state.torrents.map((t) => ({
              id: t.id,
              name: t.name,
              hashString: t.hashString ?? 'h',
              status: 4,
              percentDone: t.percentDone ?? 1,
              rateDownload: 0,
              eta: 0,
              leftUntilDone: 0,
              totalSize: (t.files ?? []).reduce((a, f) => a + (f.length ?? 0), 0),
              downloadDir,
              error: 0,
              peersConnected: 0,
              peersSendingToUs: 0,
              files: t.files ?? [],
              wanted: (t.files ?? []).map(() => 1),
            })),
          });
        }
        const complete = state.complete;
        const percentDone = complete ? 1 : state.percent;
        return ok('success', {
          torrents: [
            {
              id: 7,
              name: state.name,
              status: state.running ? 4 : 0,
              percentDone,
              rateDownload: complete ? 0 : state.rateDownload,
              eta: complete ? 0 : state.eta,
              leftUntilDone: complete ? 0 : Math.round(1150 * (1 - percentDone)),
              totalSize: 1150,
              downloadDir,
              error: 0,
              peersConnected: state.peersConnected,
              peersSendingToUs: state.peersConnected,
              // 逐文件进度：测试显式给了 bytesCompleted（例如"这个大文件已经下完"）就用它，
              // 否则按整体百分比推算（老测试依赖这个行为）
              files: state.files.map((f) => ({
                ...f,
                bytesCompleted: f.bytesCompleted > 0 ? f.bytesCompleted : Math.round(f.length * percentDone),
              })),
              wanted: state.files.map((_, i) => (state.wanted[i] === undefined ? 1 : state.wanted[i])),
            },
          ],
        });
      }
      default:
        return ok('success', {});
    }
  });
  return { ...mock, state };
}

/**
 * 造一个假 nginx + 一套假配置目录（用于测试会改 nginx 配置的代码，不需要真装 nginx）
 *
 * 布局故意刁钻：443 的 server 块排在 80 前面，另有一个别人的 80 站点，
 * 用来验证代码只会动「监听 80 且属于我们的」那个 server 块。
 */
export function makeFakeNginx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-nginx-'));
  const confDir = path.join(root, 'nginx');
  const binDir = path.join(root, 'bin');
  const sitesEnabled = path.join(confDir, 'sites-enabled');
  fs.mkdirSync(sitesEnabled, { recursive: true });
  fs.mkdirSync(path.join(confDir, 'conf.d'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const mainConf = path.join(confDir, 'nginx.conf');
  const site443 = path.join(sitesEnabled, 'other-https');
  const sitesAvailable = path.join(confDir, 'sites-available');
  fs.mkdirSync(sitesAvailable, { recursive: true });
  // 关键：Ubuntu/Debian 的 sites-enabled/* 是指向 sites-available/* 的**符号链接**，
  // 这里刻意照搬，用来验证改配置时不会把符号链接替换成普通文件。
  const site80Real = path.join(sitesAvailable, 'ttdownload');
  const site80 = path.join(sitesEnabled, 'ttdownload');
  const other80 = path.join(confDir, 'conf.d', 'zz-default.conf');

  fs.writeFileSync(
    site443,
    `server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate /etc/ssl/fake.pem;

    location / { return 200 "https 别人的站点"; }
}
`,
  );
  fs.writeFileSync(
    site80Real,
    `server {
    listen 80 default_server;
    server_name _;

    location /ttdownload/ {
        proxy_pass http://127.0.0.1:8080;
    }
}
`,
  );
  fs.symlinkSync(path.join('..', 'sites-available', 'ttdownload'), site80);
  fs.writeFileSync(
    other80,
    `server {
    listen 80;
    server_name old.example.com;

    location / { return 301 https://$host$request_uri; }
}
`,
  );
  fs.writeFileSync(
    mainConf,
    `events {}
http {
  include ${sitesEnabled}/*;
  include ${confDir}/conf.d/*.conf;
}
`,
  );

  const reloadLog = path.join(root, 'reload.log');
  const breakOnInclude = path.join(root, 'break-on-include');
  const breakAlways = path.join(root, 'break-always');
  const bin = path.join(binDir, 'nginx');
  fs.writeFileSync(
    bin,
    `#!/bin/bash
dump() {
  echo "# configuration file ${mainConf}:"
  cat "${mainConf}"
  echo "# configuration file ${site443}:"
  cat "${site443}"
  echo "# configuration file ${site80}:"
  cat "${site80}"
  echo "# configuration file ${other80}:"
  cat "${other80}"
}
for a in "$@"; do
  case "$a" in
    -v) echo "nginx version: nginx/1.24.0 (fake)"; exit 0 ;;
    -t)
      if [ -f "${breakAlways}" ]; then echo "nginx: [emerg] fake pre-existing error" >&2; exit 1; fi
      if [ -f "${breakOnInclude}" ] && grep -rqsF "ttdownload-web managed" "${confDir}"; then
        echo "nginx: [emerg] duplicate location" >&2; exit 1
      fi
      echo "nginx: configuration file test is successful"; exit 0 ;;
    -T) dump; exit 0 ;;
    reload) echo reload >> "${reloadLog}"; exit 0 ;;
  esac
done
exit 0
`,
    { mode: 0o755 },
  );
  const nginxStopped = path.join(root, 'nginx-stopped');
  const nginxCannotStart = path.join(root, 'nginx-cannot-start');
  fs.writeFileSync(
    path.join(binDir, 'systemctl'),
    `#!/bin/bash
case "\${1:-}" in
  is-active)
    [ -f "${nginxStopped}" ] && exit 3
    exit 0
    ;;
  start)
    echo "systemctl $@" >> "${reloadLog}"
    # 模拟「启动失败」：标记存在则起不来
    [ -f "${nginxCannotStart}" ] && exit 1
    rm -f "${nginxStopped}"
    exit 0
    ;;
esac
# 只记录真正的 reload：is-active 是查询，不该被当成「动过 nginx」
echo "systemctl $@" >> "${reloadLog}"
exit 0
`,
    { mode: 0o755 },
  );

  return {
    root,
    confDir,
    mainConf,
    bin,
    binDir,
    site80,
    site80Real,
    /** site80 是否仍是符号链接（改配置后必须仍然是） */
    site80IsSymlink: () => {
      try {
        return fs.lstatSync(site80).isSymbolicLink();
      } catch {
        return false;
      }
    },
    site443,
    other80,
    reloadLog,
    breakOnInclude,
    breakAlways,
    /** 标记文件：存在则假 systemctl 认为 nginx 没在运行 */
    nginxStopped,
    /** 标记文件：存在则假 systemctl start 失败 */
    nginxCannotStart,
    /** 子路径对应的 snippet 路径 */
    snippet: (tag = 'transmission') => path.join(confDir, 'snippets', `ttdownload-proxy-${tag}.conf`),
    /** 可直接塞进 setupRuntime 的 env（让被测代码用这个假 nginx） */
    env: { PATH: `${binDir}:${process.env.PATH}`, NGINX_BIN: bin, NGINX_CONF_DIR: confDir, NGINX_SERVICE: 'nginx' },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    /** 受管 include 行计数（0 表示反代已彻底关闭） */
    managedLines: () => fs.readFileSync(site80, 'utf8').split('\n').filter((l) => l.includes('ttdownload-web managed')).length,
  };
}
