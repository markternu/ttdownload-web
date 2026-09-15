/**
 * nginx 子路径反代「开关」脚本测试（用假 nginx，不需要真装 nginx）
 *
 * 这段代码会改用户的 nginx 配置，所以必须严格验证：
 *   status 能定位到「监听 80 的 server 块」而不是 443 的；
 *   preview 只打印不改动；
 *   enable → 写入 snippet + 插入 include（幂等、append 到别人的配置里互不影响）；
 *   半残状态（snippet 丢了 include 还在）能自愈；
 *   nginx -t 失败 → 自动回滚（文件恢复原样、snippet 删除、退出码非 0）；
 *   disable → 摘掉 include 并删 snippet，别人的 location 一个字都不动。
 * 另外验证脚本不依赖 GNU sed（在 macOS/BSD 上也能跑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFakeNginx } from './helpers.mjs';

const SCRIPT = path.resolve('deploy/scripts/nginx-proxy-toggle.sh');

/** 假 nginx 沙箱（见 test/helpers.mjs：sites-enabled 是软链，模拟 Ubuntu 默认布局） */
function makeSandbox() {
  const nx = makeFakeNginx();
  const run = (args, extraEnv = {}) =>
    execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...nx.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return { ...nx, run };
}

const parseResult = (out) => JSON.parse((out.match(/TTDL_NGINX_PROXY_RESULT=(\{.*\})/) ?? [])[1] ?? '{}');

test('status：未开启；能越过 443/default_server 准确定位到监听 80 的 server 文件', () => {
  const sb = makeSandbox();
  const r = parseResult(sb.run(['status']));
  assert.equal(r.enabled, false);
  assert.equal(r.subPath, '/transmission');
  assert.equal(r.target, '127.0.0.1:9091');
  assert.match(r.nginxVersion, /nginx\/1\.24/);
  assert.equal(r.serverFile, sb.site80, '应选中监听 80（且已在代理 /ttdownload/）的 server 块');
  assert.equal(r.reason, '');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('preview：只打印配置，不写文件也不 reload', () => {
  const sb = makeSandbox();
  const out = sb.run(['preview']);
  assert.match(out, /location \/transmission\//);
  assert.match(out, /proxy_pass http:\/\/127\.0\.0\.1:9091;/);
  assert.match(out, /将写入/);
  assert.equal(fs.existsSync(path.join(sb.confDir, 'snippets')), false, 'preview 不应创建 snippets 目录');
  assert.equal(fs.existsSync(sb.reloadLog), false, 'preview 不应 reload');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('enable：写入 snippet、把 include 插进 80 的 server 块、幂等、不动别人的配置', () => {
  const sb = makeSandbox();
  const before443 = fs.readFileSync(sb.site443, 'utf8');
  const beforeOther80 = fs.readFileSync(sb.other80, 'utf8');

  const first = parseResult(sb.run(['enable']));
  assert.equal(first.enabled, true, '开启后 status 应为 enabled');

  const snippet = sb.snippet();
  assert.ok(fs.existsSync(snippet), '应写入 snippet');
  const body = fs.readFileSync(snippet, 'utf8');
  assert.match(body, /proxy_pass http:\/\/127\.0\.0\.1:9091;/);
  assert.doesNotMatch(body, /proxy_pass http:\/\/127\.0\.0\.1:9091\/;/, 'proxy_pass 不能带尾斜杠（要保留 /transmission 前缀）');
  assert.match(body, /location = \/transmission \{ return 301 \/transmission\/; \}/);

  const siteText = fs.readFileSync(sb.site80, 'utf8');
  const includeLines = siteText.split('\n').filter((l) => l.includes(`include ${snippet};`));
  assert.equal(includeLines.length, 1, 'include 应恰好插入一次');
  assert.ok(includeLines[0].includes('ttdownload-web managed'), 'include 行要带托管标记，便于卸载');
  const idxInclude = siteText.indexOf(`include ${snippet};`);
  const idxServer = siteText.indexOf('server {');
  const idxListen = siteText.indexOf('listen 80');
  const idxOurLocation = siteText.indexOf('location /ttdownload/');
  assert.ok(idxInclude > idxServer, 'include 必须在 server { 之后（插在 server 块里）');
  assert.ok(idxInclude < idxListen, 'include 紧跟 server { ，在 listen 之前也是合法的');
  assert.ok(idxInclude < idxOurLocation, 'include 应在 server 块内（我们自己的 location 之前）');
  assert.ok(idxInclude < siteText.lastIndexOf('}'), 'include 应在最后一个 } 之前');

  const backups = fs.readdirSync(sb.confDir).filter((n) => n.startsWith('ttdownload-backup-'));
  assert.ok(backups.length >= 1, '应留下配置备份');
  assert.ok(fs.existsSync(sb.reloadLog), '应触发 reload');

  // 重复 enable → 幂等
  const second = parseResult(sb.run(['enable']));
  assert.equal(second.enabled, true);
  const again = fs.readFileSync(sb.site80, 'utf8').split('\n').filter((l) => l.includes(`include ${snippet};`));
  assert.equal(again.length, 1, '重复 enable 不应重复插入 include');
  assert.equal(fs.readFileSync(sb.site443, 'utf8'), before443, '443 的 server 块一个字都不能改');
  assert.equal(fs.readFileSync(sb.other80, 'utf8'), beforeOther80, '别的 80 站点一个字都不能改');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('enable：nginx -t 失败（新配置有 duplicate location）时自动回滚', () => {
  const sb = makeSandbox();
  const before = fs.readFileSync(sb.site80, 'utf8');
  fs.writeFileSync(sb.breakOnInclude, '1'); // include 一旦出现，-t 就失败
  let err;
  try {
    sb.run(['enable']);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'nginx -t 失败时应非零退出');
  assert.notEqual(err.status, 0);
  assert.match(String(err.stderr), /回滚/, '应说明已回滚');
  assert.equal(fs.readFileSync(sb.site80, 'utf8'), before, '配置文件应恢复原样');
  assert.equal(fs.existsSync(sb.snippet()), false, 'snippet 应被删除');
  fs.rmSync(sb.breakOnInclude, { force: true });
  assert.equal(parseResult(sb.run(['status'])).enabled, false, '回滚后状态应为未开启');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('enable：本来配置就坏（与本次改动无关）时拒绝动手，不做任何改动', () => {
  const sb = makeSandbox();
  const before = fs.readFileSync(sb.site80, 'utf8');
  fs.writeFileSync(sb.breakAlways, '1');
  let err;
  try {
    sb.run(['enable']);
  } catch (e) {
    err = e;
  }
  assert.ok(err, '预检失败应非零退出');
  assert.match(String(err.stderr), /未做任何改动/);
  assert.equal(fs.readFileSync(sb.site80, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(sb.confDir, 'snippets')), false, '不应留下 snippet');
  assert.equal(fs.existsSync(sb.reloadLog), false, '不应 reload');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('自愈：snippet 被删但 include 残留时，enable 先清理残行再正常开启', () => {
  const sb = makeSandbox();
  sb.run(['enable']);
  fs.rmSync(sb.snippet()); // 模拟手工删掉 snippet（此时 include 行还在 → nginx -t 会失败）
  const r = parseResult(sb.run(['enable']));
  assert.equal(r.enabled, true);
  const lines = fs.readFileSync(sb.site80, 'utf8').split('\n').filter((l) => l.includes('ttdownload-web managed'));
  assert.equal(lines.length, 1, '残行应被清理后重新只插入一次');
  assert.ok(fs.existsSync(sb.snippet()));
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('enable：同一个 server 块里已有别人的 /transmission location 时劝退，不写配置', () => {
  const sb = makeSandbox();
  const withConflict = fs
    .readFileSync(sb.site80, 'utf8')
    .replace('location /ttdownload/ {', 'location /transmission/ { return 200 "别人的 transmission"; }\n\n    location /ttdownload/ {');
  fs.writeFileSync(sb.site80, withConflict);
  let err;
  try {
    sb.run(['enable']);
  } catch (e) {
    err = e;
  }
  assert.ok(err, '有冲突 location 时应拒绝');
  assert.match(String(err.stderr), /已经有 \/transmission 的 location/);
  assert.equal(fs.readFileSync(sb.site80, 'utf8'), withConflict, '被拒绝时不能改文件');
  assert.equal(fs.existsSync(sb.snippet()), false);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('disable：移除 include 并删除 snippet，别人的配置保持不动；再 disable 也不报错', () => {
  const sb = makeSandbox();
  const before443 = fs.readFileSync(sb.site443, 'utf8');
  sb.run(['enable']);
  assert.equal(parseResult(sb.run(['status'])).enabled, true);

  const off = parseResult(sb.run(['disable']));
  assert.equal(off.enabled, false);
  const siteText = fs.readFileSync(sb.site80, 'utf8');
  assert.equal(siteText.includes('ttdownload-web managed'), false, 'include 行应被移除');
  assert.equal(fs.existsSync(sb.snippet()), false, 'snippet 应被删除');
  assert.match(siteText, /location \/ttdownload\//, '我们应用的 location 必须保持不动');
  assert.equal(fs.readFileSync(sb.site443, 'utf8'), before443, '别人的配置必须保持不动');

  assert.equal(parseResult(sb.run(['disable'])).enabled, false, '重复 disable 应幂等');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('自定义子路径与目标端口（每个子路径一个独立 snippet，可共存）', () => {
  const sb = makeSandbox();
  const a = parseResult(sb.run(['enable', '--path', '/transmission', '--target', '127.0.0.1:9091']));
  const b = parseResult(sb.run(['enable', '--path', '/bt', '--target', '10.0.0.5:9091']));
  assert.equal(a.enabled, true);
  assert.equal(b.enabled, true);
  assert.equal(b.subPath, '/bt');
  assert.ok(fs.existsSync(sb.snippet('bt')), '应按子路径生成独立 snippet');
  assert.ok(fs.existsSync(sb.snippet('transmission')), '原 snippet 不应被覆盖');
  assert.match(fs.readFileSync(sb.snippet('bt'), 'utf8'), /location \/bt\//);
  assert.match(fs.readFileSync(sb.snippet('bt'), 'utf8'), /proxy_pass http:\/\/10\.0\.0\.5:9091;/);

  const managed = fs.readFileSync(sb.site80, 'utf8').split('\n').filter((l) => l.includes('ttdownload-web managed'));
  assert.equal(managed.length, 2, '两个子路径各一行 include');

  // 只关掉 /bt，/transmission 必须还在
  const off = parseResult(sb.run(['disable', '--path', '/bt']));
  assert.equal(off.enabled, false);
  assert.ok(fs.existsSync(sb.snippet('transmission')), '/transmission 不应被误删');
  assert.equal(parseResult(sb.run(['status', '--path', '/transmission'])).enabled, true);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('参数校验：非法子路径 / 非法 target 直接报错', () => {
  const sb = makeSandbox();
  for (const args of [['enable', '--path', '/bad path'], ['enable', '--path', '/ok', '--target', 'nope']]) {
    let err;
    try {
      sb.run(args);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `${args.join(' ')} 应报错`);
  }
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('符号链接：sites-enabled 是软链时，改的是真实文件且软链必须保持为软链', () => {
  const sb = makeSandbox();
  // 前提：假环境的 sites-enabled/ttdownload 就是指向 sites-available/ttdownload 的软链（Ubuntu 默认布局）
  assert.equal(sb.site80IsSymlink(), true, '前置条件：应该是符号链接');
  const realFile = sb.site80Real;
  const modeBefore = fs.statSync(realFile).mode & 0o777;

  const r = parseResult(sb.run(['enable']));
  assert.equal(r.enabled, true);
  assert.equal(sb.site80IsSymlink(), true, 'enable 之后必须是符号链接（不能变成普通文件）');
  assert.equal(sb.managedLines(), 1, 'include 应写进真实文件');
  assert.match(fs.readFileSync(realFile, 'utf8'), /ttdownload-web managed/);
  assert.equal(fs.statSync(realFile).mode & 0o777, modeBefore, '文件权限不能被改掉');
  // nginx -T 报出来的是 sites-enabled 那条路径
  assert.equal(r.serverFile, sb.site80);
  // 备份里应该存的是真实文件的内容（不是坏掉的软链）
  const backupDir = fs
    .readdirSync(sb.confDir)
    .filter((n) => n.startsWith('ttdownload-backup-'))
    .map((n) => path.join(sb.confDir, n))
    .pop();
  assert.ok(backupDir, '应有备份目录');
  const backed = fs.readdirSync(backupDir);
  assert.ok(backed.includes('ttdownload'), `备份里应有 ttdownload（实际 ${backed.join(',')}）`);
  assert.equal(fs.lstatSync(path.join(backupDir, 'ttdownload')).isSymbolicLink(), false, '备份应是文件内容而不是软链');

  // 回滚路径同样不能把软链弄坏
  fs.writeFileSync(sb.breakOnInclude, '1');
  let err;
  try {
    sb.run(['enable', '--path', '/bt']); // 先开一个 /bt 触发 -t 失败回滚
  } catch (e) {
    err = e;
  }
  fs.rmSync(sb.breakOnInclude, { force: true });
  assert.ok(err, '应回滚失败');
  assert.equal(sb.site80IsSymlink(), true, '回滚后仍必须是符号链接');

  // 关闭后仍是软链，且内容干净
  const off = parseResult(sb.run(['disable']));
  assert.equal(off.enabled, false);
  assert.equal(sb.site80IsSymlink(), true, 'disable 之后必须仍是符号链接');
  assert.equal(fs.readFileSync(realFile, 'utf8').includes('ttdownload-web managed'), false);
  assert.equal(fs.statSync(realFile).mode & 0o777, modeBefore);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('status 报告 nginx 是否在运行（装了但没跑必须能看出来）', () => {
  const sb = makeSandbox();
  assert.equal(parseResult(sb.run(['status'])).nginxRunning, true, '默认假 systemctl 认为在运行');
  fs.writeFileSync(sb.nginxStopped, '1');
  assert.equal(parseResult(sb.run(['status'])).nginxRunning, false, '服务停了要报 false');
  fs.rmSync(sb.nginxStopped, { force: true });
  assert.equal(parseResult(sb.run(['status'])).nginxRunning, true);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('★nginx 没在运行时会自动启动它（不能出现"开关已开但地址打不开"的假成功）', () => {
  const sb = makeSandbox();
  fs.writeFileSync(sb.nginxStopped, '1'); // 模拟 nginx 处于 stopped
  // 用一个本地 HTTP 服务冒充 transmission（返回 401 = 已到达），走 VERIFY_BASE_URL
  const r = parseResult(sb.run(['enable'], { VERIFY_BASE_URL: 'http://127.0.0.1:1' })); // 故意连不上
  assert.equal(r.enabled, true, '配置应写入成功');
  assert.equal(r.nginxRunning, true, '应把 nginx 启动起来（假 systemctl start 会清掉 stopped 标记）');
  assert.equal(fs.existsSync(sb.nginxStopped), false, 'nginx 应已从 stopped 变为 running');
  assert.equal(r.verified, false, '连不上时实测结论必须是 false');
  assert.match(String(r.verifyDetail), /连不上|HTTP/, '要给出实测说明');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('★nginx 启动失败时必须回滚并报错（而不是假装开启成功）', () => {
  const sb = makeSandbox();
  fs.writeFileSync(sb.nginxStopped, '1');
  fs.writeFileSync(sb.nginxCannotStart, '1'); // 启动一定失败
  const before = fs.readFileSync(sb.site80, 'utf8');
  let err;
  try {
    sb.run(['enable']);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'nginx 起不来时应报错');
  assert.match(String(err.stderr), /已回滚|无法启动/, '应说明已回滚');
  assert.equal(fs.readFileSync(sb.site80, 'utf8'), before, '配置文件必须恢复原样');
  assert.equal(fs.existsSync(sb.snippet()), false, 'snippet 应被删除');
  assert.equal(parseResult(sb.run(['status'])).enabled, false, '状态应回到未开启');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('★status 必须给出「实测能不能访问」（enabled=true 才判；关了就是 null）', async () => {
  const sb = makeSandbox();
  // 注意：不能用同进程的 http 服务 —— 脚本是用 execFileSync 同步跑的，会阻塞事件循环，
  // 同进程的服务永远不回包。所以起一个**独立子进程**当假 transmission。
  const port = 18080 + Math.floor(Math.random() * 500);
  const { spawn } = await import('node:child_process');
  const srv = spawn(
    process.execPath,
    ['-e', `require('http').createServer((q,s)=>s.writeHead(409).end('x')).listen(${port},'127.0.0.1')`],
    { stdio: 'ignore' },
  );
  // 等它就绪
  const net = await import('node:net');
  for (let i = 0; i < 50; i += 1) {
    const ok = await new Promise((r) => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => {
        c.destroy();
        r(true);
      });
      c.once('error', () => r(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const env = { VERIFY_BASE_URL: `http://127.0.0.1:${port}` };
  try {
    assert.equal(parseResult(sb.run(['status'], env)).verified, null, '没开启时不该有实测结论');
    const on = parseResult(sb.run(['enable'], env));
    assert.equal(on.enabled, true);
    assert.equal(on.verified, true, `应实测通过，实际 ${on.verifyDetail}`);
    assert.match(String(on.verifyDetail), /已到达 transmission/);
    assert.equal(parseResult(sb.run(['status'], env)).verified, true, 'status 也要带实测结论');
    const off = parseResult(sb.run(['disable'], env));
    assert.equal(off.enabled, false);
    assert.equal(off.verified, null, '关闭后不该再有实测结论');
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
});
