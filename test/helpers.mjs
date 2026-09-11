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
export async function startTransmissionMock({ downloadDir, torrentName = 'Demo', files } = {}) {
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
        return ok('success', { version: '4.0.5-mock' });
      case 'torrent-add':
        return ok('success', { 'torrent-added': { id: 7, name: state.name, hashString: 'abc' } });
      case 'torrent-set':
        return ok('success', {});
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
              files: state.files.map((f) => ({ ...f, bytesCompleted: Math.round(f.length * percentDone) })),
              wanted: [1, 1, 1],
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
