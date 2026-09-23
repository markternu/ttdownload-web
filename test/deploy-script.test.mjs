/**
 * 一键部署脚本的依赖安装/跳过逻辑测试
 *  - aria2：未安装 -> apt install；已安装 -> 跳过
 *  - transmission：未安装 -> 必须调用工程自带的 deploy/ubuntutr.sh（交互脚本）；已安装 -> 跳过
 * 说明：这里用假的 PATH 命令与假安装脚本来验证「调用/跳过」分支，不会真的安装任何东西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const projectRoot = path.resolve('.');
const deploySrc = fs.readFileSync(path.join(projectRoot, 'deploy.sh'), 'utf8');

// 从 deploy.sh 中抽出依赖相关函数（have_cmd ~ configure_transmission_env 结束）
const startMarker = 'have_cmd() {';
const endMarker = '# ---------------------------------------------------------------- 已部署后的管理动作';
const startIdx = deploySrc.indexOf(startMarker);
const endIdx = deploySrc.indexOf(endMarker);
assert.ok(startIdx > 0 && endIdx > startIdx, '应从 deploy.sh 中提取到依赖处理函数');
const functionsBlock = deploySrc.slice(startIdx, endIdx);

function makeSandbox({ withAria2, withTransmission, withTransmissionRemote = withTransmission, fakeInstallerBody, aptNodeConflict = false, stubCurl = false, extraCalls = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-deploy-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(logFile, '');

  // 造一个"干净的系统 PATH"：软链 /usr/bin 里除**应用二进制**之外的东西。
  // 血案（真机测试）：原来 PATH 里直接带 /usr/bin，而树莓派上真装着 aria2c /
  // transmission-daemon / node → "未安装"的模拟全失效（该 apt install 的地方它
  // 认为已安装），本地全绿、Pi 上一片红。
  const APP_BINS = new Set([
    'node', 'nodejs', 'npm', 'npx', 'corepack',
    'aria2c', 'transmission-daemon', 'transmission-remote', 'transmission-cli',
    'yt-dlp', 'ffmpeg', 'ffprobe', 'deno', 'bun', 'qjs', 'quickjs',
    'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  ]);
  const sysBin = path.join(dir, 'sysbin');
  fs.mkdirSync(sysBin, { recursive: true });
  for (const src of ['/usr/bin', '/bin']) {
    let names = [];
    try {
      names = fs.readdirSync(src);
    } catch {
      continue;
    }
    for (const n of names) {
      if (APP_BINS.has(n)) continue;
      const dest = path.join(sysBin, n);
      if (fs.existsSync(dest)) continue;
      try {
        fs.symlinkSync(path.join(src, n), dest);
      } catch {
        /* 同名/权限问题忽略即可 */
      }
    }
  }
  // 假的 apt 源目录：ensure_node 会在这里删 nodesource.list，测试不去动真实 /etc/apt
  const aptSources = path.join(dir, 'apt-sources');
  fs.mkdirSync(aptSources, { recursive: true });

  const writeStub = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };

  if (withAria2) writeStub('aria2c', 'echo "aria2 version 1.37.0"');
  if (withTransmission) {
    writeStub('transmission-daemon', 'echo transmission-daemon-mock');
    if (withTransmissionRemote) writeStub('transmission-remote', 'echo transmission-remote-mock');
  }
  // apt-get 桩：只记录被调用的参数；aptNodeConflict=1 时模拟真机那个"held broken packages"
  if (aptNodeConflict) {
    writeStub(
      'apt-get',
      `echo "apt-get $@" >> ${logFile}
case "$*" in
  *install*nodejs*npm*|*install*npm*nodejs*)
    echo "E: Unable to correct problems, you have held broken packages." >&2
    exit 100 ;;
esac
case "$*" in
  *install*nodejs*)
    # 模拟 NodeSource 的 nodejs：**自带 npm**
    printf '#!/bin/bash\\n[ "$1" = "-v" ] && echo v20.11.0\\n' > ${bin}/node; chmod +x ${bin}/node
    printf '#!/bin/bash\\n[ "$1" = "-v" ] && echo 10.2.4\\n' > ${bin}/npm; chmod +x ${bin}/npm
    ;;
  *install*npm*)
    printf '#!/bin/bash\\n[ "$1" = "-v" ] && echo 10.2.4\\n' > ${bin}/npm; chmod +x ${bin}/npm
    ;;
esac
exit 0`,
    );
  } else {
    writeStub('apt-get', `echo "apt-get $@" >> ${logFile}`);
  }
  writeStub('systemctl', `echo "systemctl $@" >> ${logFile}`);
  // curl 桩：ensure_node 会 `curl ... | bash -` 配置 NodeSource 源；测试里不打网络
  if (stubCurl) writeStub('curl', `echo "curl $@" >> ${logFile}`);

  // 假的 transmission 安装脚本（真实场景是 deploy/ubuntutr.sh，交互提示原样保留）
  fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  const installer = path.join(dir, 'deploy', 'ubuntutr.sh');
  fs.writeFileSync(
    installer,
    `#!/bin/bash\necho "INSTALLER_CALLED" >> ${logFile}\n${fakeInstallerBody ?? 'echo "fake ubuntutr interactive"'} \n`,
    { mode: 0o755 },
  );

  const harness = path.join(dir, 'harness.sh');
  fs.writeFileSync(
    harness,
    `#!/bin/bash
PROJECT_DIR="${dir}"
BT_INSTALLER="${installer}"
PATH="${bin}:${sysBin}"
APT_SOURCES_DIR="${aptSources}"
DEPLOY_ASSUME_TTY=1
export PATH DEPLOY_ASSUME_TTY APT_SOURCES_DIR
log()  { echo "[deploy] $*"; }
warn() { echo "[deploy][warn] $*"; }
die()  { echo "[deploy][die] $*" >&2; exit 1; }

${functionsBlock}

print_dep_status
ensure_aria2
ensure_transmission
${extraCalls}
`,
    { mode: 0o755 },
  );

  return {
    dir,
    logFile,
    installer,
    aptSources,
    bin,
    sysBin,
    run: (args = []) => execFileSync('bash', [harness, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    runAllowFail: () => {
      try {
        return { out: execFileSync('bash', [harness], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
      } catch (e) {
        return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
      }
    },
    calls: () => fs.readFileSync(logFile, 'utf8'),
  };
}

test('两个都已安装：打印"已安装"并且不调用 apt / 不调用传输安装脚本', () => {
  const sb = makeSandbox({ withAria2: true, withTransmission: true });
  const out = sb.run();
  assert.match(out, /aria2\s+已安装/);
  assert.match(out, /transmission 已安装/);
  assert.match(out, /跳过安装/);
  const calls = sb.calls();
  assert.equal(calls.includes('apt-get install -y aria2'), false, '已安装时不应 apt install aria2');
  assert.equal(calls.includes('INSTALLER_CALLED'), false, '已安装时不应调用 ubuntutr.sh');
});

test('aria2 未安装：会 apt install -y aria2', () => {
  const sb = makeSandbox({ withAria2: false, withTransmission: true });
  const out = sb.run();
  assert.match(out, /未检测到 aria2/);
  assert.match(sb.calls(), /apt-get install -y aria2/);
});

test('transmission 未安装：自动 apt 安装（不再强制交互脚本）；密码默认 123456a 且等 60 秒', () => {
  const sb = makeSandbox({ withAria2: true, withTransmission: false });
  const out = sb.run();
  assert.match(out, /未检测到 transmission/);
  assert.match(sb.calls(), /apt-get install[^\n]*transmission/, '必须自动 apt 安装 transmission（无人值守也能装好）');
  // 策略本身（写在脚本里，供交互式首装时使用）
  assert.match(deploySrc, /TRANSMISSION_DEFAULT_PASSWORD:-123456a/, '默认密码必须是 123456a');
  assert.match(deploySrc, /read -r -t 60/, '密码提示必须等 60 秒');
  assert.match(deploySrc, /TRANSMISSION_RPC_PASSWORD=%s/, '密码要写回 .env');
});

test('两者都未安装：aria2 与 transmission 都自动安装', () => {
  const sb = makeSandbox({ withAria2: false, withTransmission: false });
  sb.run();
  const calls = sb.calls();
  assert.match(calls, /apt-get install -y aria2/);
  assert.match(calls, /apt-get install[^\n]*transmission/);
});

test('只有 transmission-daemon、没有 transmission-remote：视为已安装，绝不重跑安装脚本', () => {
  // 后端只用 JSON-RPC，不需要 transmission-remote；而 ubuntutr.sh 会 purge 旧配置，
  // 所以「已装 daemon 但没装 remote」的机器必须跳过安装（避免毁掉用户现有 transmission 配置）
  const sb = makeSandbox({ withAria2: true, withTransmission: true, withTransmissionRemote: false });
  const out = sb.run();
  assert.match(out, /transmission 已安装/);
  assert.equal(sb.calls().includes('INSTALLER_CALLED'), false, '已有 daemon 时不得调用 ubuntutr.sh');
});

test('系统依赖里包含 better-sqlite3 本机编译所需的 build-essential/python3', () => {
  assert.match(deploySrc, /apt-get install -y [^\n]*build-essential[^\n]*python3/, '应安装 build-essential 与 python3');
});

test('Node 版本自适应：目标 20，只有 Ubuntu <20.04 才退回 18（Debian/树莓派 OS 用 20）', () => {
  assert.match(deploySrc, /setup_\$\{NODE_SETUP\}\.x/, '应使用变量化的 NodeSource 版本');
  assert.match(deploySrc, /NODE_WANT_MAJOR=20/, '目标版本应为 20');
  // 线上踩过：1G 内存的机器上 vite 卡在 "rendering chunks"（疯狂 swap），且 emptyOutDir=true
  // 会在构建开始时清空 public/ —— 中途失败就白页。必须：内存上限 + 超时 + 备份回滚 + 校验产物。
  assert.match(deploySrc, /--max-old-space-size=2048/, '前端构建要给 Node 明确内存上限（小内存机器会 swap 到假死）');
  assert.match(deploySrc, /timeout 1200 npm run build/, '前端构建要有硬超时，卡住要报错而不是无限等');
  assert.match(deploySrc, /public\.deploy-bak/, '构建前要备份 public/');
  assert.match(deploySrc, /public\/index\.html/, '构建后要校验 index.html 存在，否则回滚');
  assert.match(deploySrc, /"\$OS_ID" == "ubuntu"/, '必须同时判断发行版 ID 是 ubuntu');
  assert.match(deploySrc, /OS_MAJ < 20/, '只有 Ubuntu <20.04 才回退 Node 18');
  // 回归：不能用「VERSION_ID 的整数」直接和 20 比较（Debian 12/13 会被误判）
  assert.equal(/UBUNTU_MAJ < 20/.test(deploySrc), false, '旧的 Ubuntu-only 判断必须已移除');
  // NodeSource 不支持某些新发行版时要能退化到发行版仓库
  assert.match(deploySrc, /NodeSource 源配置失败/, '应有 NodeSource 失败后的降级处理');
  assert.match(deploySrc, /apt-get install -y nodejs npm/, '应能退回发行版仓库安装 nodejs');
  assert.match(deploySrc, /Node 版本仍然过低/, '装完仍过低要明确报错');
});

test('【血案回归】NodeSource 那一步不能把 nodejs 和 npm 写在一起装（apt held broken packages）', () => {
  // 真机事故：全新 Ubuntu 上部署卡在 Node 这一步，报
  //   E: Unable to correct problems, you have held broken packages.
  // 原因：NodeSource 的 nodejs 包**自带 npm**，且与发行版 npm 互斥
  //   （发行版 npm 依赖发行版 nodejs）→ 两个一起点名，apt 无解。
  // 这个桩会像真机一样：同时点名 nodejs+npm 就失败；只点名 nodejs 则成功并"自带 npm"。
  const sb = makeSandbox({
    withAria2: true,
    withTransmission: true,
    aptNodeConflict: true,
    stubCurl: true,
    extraCalls: 'ensure_node',
  });
  const out = sb.run();
  assert.match(out, /Node 已就绪/, '真机上这一步必须能装成功，实际输出：' + out);

  const installLines = sb.calls()
    .split('\n')
    .filter((l) => l.includes('apt-get') && l.includes('install'));
  const bad = installLines.filter((l) => l.includes('nodejs') && l.includes('npm'));
  assert.deepEqual(
    bad,
    [],
    '不得把 nodejs 与 npm 放进同一条 apt 安装命令（NodeSource 的 nodejs 自带 npm，二者互斥）：\n' + bad.join('\n'),
  );
  assert.ok(
    installLines.some((l) => l.includes('nodejs')),
    '应该用 NodeSource 装 nodejs',
  );
});

test('【血案回归】只有 NodeSource 装不上时，才摘掉它的源、用发行版仓库装 nodejs+npm', () => {
  // 场景：NodeSource 的 nodejs 装不上（发行版太新/太老）→ 必须**先摘源**再用发行版仓库，
  // 否则发行版的 npm 依旧和残留的 NodeSource nodejs 冲突。
  const sb = makeSandbox({
    withAria2: true,
    withTransmission: true,
    aptNodeConflict: true,
    stubCurl: true,
    // 第一次装 nodejs 直接失败，逼它走"发行版仓库"回退分支
    fakeInstallerBody: '',
    extraCalls: '',
  });
  // 覆盖 apt 桩：让 nodejs 单独安装也失败，只有 nodejs+npm（发行版仓库）才行
  fs.writeFileSync(
    path.join(sb.bin, 'apt-get'),
    `#!/bin/bash
echo "apt-get $@" >> ${sb.logFile}
case "$*" in
  *install*nodejs*npm*|*install*npm*nodejs*)
    printf '#!/bin/bash\\n[ "$1" = "-v" ] && echo v20.11.0\\n' > ${sb.bin}/node; chmod +x ${sb.bin}/node
    printf '#!/bin/bash\\n[ "$1" = "-v" ] && echo 10.2.4\\n' > ${sb.bin}/npm; chmod +x ${sb.bin}/npm
    exit 0 ;;
  *install*nodejs*)
    echo "E: Unable to locate package nodejs" >&2; exit 100 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // 放一个假的 NodeSource 源文件，验证回退时确实把它摘掉了
  const srcList = path.join(sb.aptSources, 'nodesource.list');
  fs.writeFileSync(srcList, 'deb https://deb.nodesource.com/node_20.x nodistro main\n');

  const harness = path.join(sb.dir, 'harness-node.sh');
  fs.writeFileSync(
    harness,
    `#!/bin/bash
PATH="${sb.bin}:${sb.sysBin}"
APT_SOURCES_DIR="${sb.aptSources}"
export PATH APT_SOURCES_DIR
log()  { echo "[deploy] $*"; }
warn() { echo "[deploy][warn] $*"; }
die()  { echo "[deploy][die] $*" >&2; exit 1; }
${functionsBlock}
ensure_node
`,
    { mode: 0o755 },
  );
  const out = execFileSync('bash', [harness], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /Node 已就绪/, '回退到发行版仓库后应该装上：' + out);
  assert.equal(fs.existsSync(srcList), false, '回退前必须摘掉 NodeSource 的源，否则 npm 依旧和它冲突');
  assert.match(sb.calls(), /apt-get install -y nodejs npm/, '发行版仓库里 nodejs+npm 是配套的，应一起装');
});

test('【血案回归】--update 分支也必须保证 Node 就绪（否则没 Node 的机器上 npm ci 直接 command not found）', () => {
  const a = deploySrc.indexOf('\n  update)');
  const b = deploySrc.indexOf('\n  status)');
  assert.ok(a > 0 && b > a, '应能从 deploy.sh 里切出 update 分支');
  const updateBlock = deploySrc.slice(a, b);
  assert.match(updateBlock, /ensure_node/, '--update 分支应调用 ensure_node（否则全新机器上更新必失败）');
  // 比顺序时要**去掉注释行**：注释里也会出现 "npm ci" 字样，否则比的是注释不是代码
  const code = updateBlock
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    code.indexOf('ensure_node') < code.indexOf('npm ci'),
    'ensure_node 必须排在 npm ci 之前，否则等不到它就已经 command not found 了',
  );
});

test('--check-deps 能正确识别 node 版本（回归：辅助函数必须定义在提前退出之前）', () => {
  const out = execFileSync('bash', [path.join(projectRoot, 'deploy.sh'), '--check-deps'], { encoding: 'utf8' });
  assert.match(out, /依赖检查结果/);
  assert.equal(out.includes('command not found'), false, '不应出现未定义函数/命令');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    assert.match(out, /✓ node\s+v\d+/, '应识别出已安装的 node 版本');
    assert.equal(out.includes('低于 18'), false, '不得把 >=18 的 node 误报为版本过低');
  }
});

test('deploy/ubuntutr.sh 与原始脚本逐字节一致（交互提示原样保留）', () => {
  const bundled = fs.readFileSync(path.join(projectRoot, 'deploy/ubuntutr.sh'));
  // 原始脚本的哈希（Transmission 终极安装配置脚本 v4.0）；本地有原文件时直接逐字节对比
  const expectedSha256 = 'b4ea0c768945edd6f385e71a845d63dbebf2cc5068f8cafc29d6fce231fe6693';
  const originalPath = process.env.UBUNTUTR_ORIGINAL ?? '/Users/wt/Desktop/androidapp/github/ubuntutr.sh';
  if (fs.existsSync(originalPath)) {
    const original = fs.readFileSync(originalPath);
    assert.deepEqual(bundled, original, 'bundled 的 ubuntutr.sh 必须与原始脚本完全一致');
    return;
  }
  // 没有原文件（例如在 Ubuntu 服务器上 clone 后跑测试）时校验哈希 + 关键交互提示
  const actual = createHash('sha256').update(bundled).digest('hex');
  assert.equal(actual, expectedSha256, 'ubuntutr.sh 内容被改动（哈希不匹配）');
  const text = bundled.toString('utf8');
  for (const prompt of ['是否启用 IP 白名单?', '设置 RPC 登录密码: ', '再次确认密码: ', '[11/11] 最终启动服务']) {
    assert.ok(text.includes(prompt), `应保留交互提示: ${prompt}`);
  }
});

test('运维子命令齐备：--update / --stop / --start / --logs / --logs-follow', () => {
  for (const sub of ['--update', '--stop', '--start', '--logs', '--logs-follow', '--collect', '--check-ports', '--proxy', '--proxy-path', '--restart', '--status', '--uninstall']) {
    assert.ok(deploySrc.includes(sub), `deploy.sh 应支持 ${sub}`);
  }
  assert.match(deploySrc, /pull --ff-only/, '--update 应拉取最新代码');
  assert.match(deploySrc, /npm run build/, '--update 应重新构建后端');
  assert.match(deploySrc, /systemctl restart/, '--update 应重启服务');
  assert.match(deploySrc, /tail -n "\$LOG_LINES"/, '--logs 应输出指定行数日志');
  assert.match(deploySrc, /LOG_LEVEL=debug/, '生成的 .env 默认开启 debug 日志');
  assert.match(deploySrc, /deploy\.log/, '部署脚本输出应落盘到 state/logs/deploy.log');
  assert.match(deploySrc, /ttdownload-logs-\$\{STAMP\}/, '--collect 应离线打包日志文件');
  // 老部署升级：应补齐新配置项而不是只补 PORT/DOWNLOAD_ROOT
  assert.match(deploySrc, /backfill_env\(\)/, '应有 .env 补齐函数');
  assert.match(deploySrc, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/, '应跳过 playwright 浏览器下载');
  // sudo 部署时 git/npm/构建必须以仓库属主身份执行，否则产物变 root 所有、之后普通用户无法 git pull
  assert.match(deploySrc, /REPO_OWNER=/, '应识别仓库属主');
  assert.match(deploySrc, /as_owner\(\)/, '应有 as_owner 包装函数');
  assert.match(deploySrc, /as_owner npm run build/, '构建应以属主身份执行');
  assert.match(deploySrc, /as_owner git -c safe\.directory/, 'git pull 应以属主身份执行');
  // --update 的自愈：检测到属主不符（历史 sudo 造成的 root 文件）时自动归位并重试
  assert.match(deploySrc, /OWNER_MISMATCH/, '应检测属主不符的文件');
  assert.match(deploySrc, /自动归位属主后重试 git pull/, '应自动归位后重试');
  // --update 拉取到新代码后必须用新脚本重新执行，否则"新加的部署步骤会被跳过"
  assert.match(deploySrc, /ORIGINAL_ARGS=/, '应保留原始参数供 re-exec');
  assert.match(deploySrc, /DEPLOY_REEXEC/, '应用 DEPLOY_REEXEC 防死循环');
  assert.match(deploySrc, /exec bash "\$\{PROJECT_DIR\}\/deploy\.sh"/, '应 re-exec 新脚本继续执行');
});

test('内置环境脚本：diagnose-env.sh / fix-node20.sh / fix-ytdlp.sh 存在、可执行、内容正确', () => {
  const scripts = [
    { file: 'deploy/scripts/diagnose-env.sh', must: [/体检/, /aria2/, /yt-dlp/, /resolve_host/, /safe\.directory/, /JS 运行时/, /yt-dlp-ejs/, /exit 0/], readonly: true },
    { file: 'deploy/scripts/fix-node20.sh', must: [/setup_20\.x/, /npm ci/, /npm run build/, /systemctl restart/, /回滚/, /safe\.directory/, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD/], readonly: false },
    {
      file: 'deploy/scripts/check-ports.sh',
      must: [/ss -ltn|sport = :/, /ufw/, /iptables|nft/, /check-host\.net/, /不可达/, /setup-nginx-proxy\.sh/, /只读/],
      readonly: true,
    },
    {
      file: 'deploy/scripts/setup-nginx-proxy.sh',
      must: [/location =/, /location /, /proxy_pass http:\/\/127\.0\.0\.1:/, /proxy_buffering off/, /nginx -t/, /include/, /备份|backup/, /--remove/],
      readonly: false,
    },
    {
      file: 'deploy/scripts/fix-ownership.sh',
      must: [/chown -R/, /safe\.directory/, /归位/, /sudo -u/, /回滚/],
      readonly: false,
    },
    {
      file: 'deploy/scripts/fix-ytdlp.sh',
      must: [
        /pip3 install -U/,
        /--break-system-packages/,
        /yt-dlp\[default\]/,        // yt-dlp-ejs 挑战求解脚本
        /yt-dlp-ejs/,
        /deno\.land\/install\.sh/,  // JS 运行时（本次问题的关键）
        /curl_cffi/,
        /升级前/,
        /回滚/,
      ],
      readonly: false,
    },
  ];
  for (const { file, must, readonly } of scripts) {
    const full = path.join(projectRoot, file);
    assert.ok(fs.existsSync(full), `${file} 应存在`);
    const text = fs.readFileSync(full, 'utf8');
    for (const re of must) assert.match(text, re, `${file} 应包含 ${re}`);
    // 语法检查（bash -n）
    execFileSync('bash', ['-n', full]);
    // 可执行位
    const mode = fs.statSync(full).mode & 0o777;
    assert.ok((mode & 0o100) !== 0, `${file} 应有可执行位（实际 ${mode.toString(8)}）`);
    if (readonly) {
      assert.equal(/\brm -rf\b|apt-get install|npm install|chown |sed -i/.test(text), false, '只读脚本不应包含修改性命令');
    }
  }
});

test('gen_password 在 set -e + pipefail 下不会因 SIGPIPE 中断部署', () => {
  const fn = deploySrc.slice(deploySrc.indexOf('gen_password() {'), deploySrc.indexOf('log()  {'));
  assert.ok(fn.includes('dd if=/dev/urandom'), '应使用 dd 读取随机字节（避免 tr|head 的 SIGPIPE）');
  const script = `set -euo pipefail\n${fn}\npw="$(gen_password)"; echo "PW=$pw"; echo "LEN=${'${#pw}'}"\n`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  const pw = /PW=(\S+)/.exec(out)?.[1] ?? '';
  assert.match(pw, /^[A-Za-z0-9]{16}$/, `应生成 16 位字母数字密码，实际 ${pw}`);
  assert.match(out, /LEN=16/);
});

test('BT 反代开关子命令齐备：--bt-proxy / --bt-proxy-off / --bt-proxy-status / --bt-proxy-path', () => {
  for (const sub of ['--bt-proxy', '--bt-proxy-off', '--bt-proxy-status', '--bt-proxy-path']) {
    assert.ok(deploySrc.includes(sub), `deploy.sh 应支持 ${sub}`);
  }
  assert.match(deploySrc, /nginx-proxy-toggle\.sh/, '应调用 nginx-proxy-toggle.sh');
  assert.match(deploySrc, /BT_PROXY_PATH="\$\{BT_PROXY_PATH:-\/transmission\}"/, '默认子路径应为 /transmission（transmission WebUI 自带前缀）');
  assert.match(deploySrc, /bash "\$BT_PROXY_TOGGLE" enable/, '--bt-proxy 应调用 enable');
  assert.match(deploySrc, /bash "\$BT_PROXY_TOGGLE" disable/, '--bt-proxy-off 应调用 disable');
  assert.match(deploySrc, /bash "\$BT_PROXY_TOGGLE" status/, '--bt-proxy-status 应调用 status');
  assert.match(deploySrc, /--no-bt-proxy\)/, '应提供 --no-bt-proxy 别名');
  // 关闭时的语义必须说清楚：是真的删掉配置，而不是靠防火墙
  assert.match(deploySrc, /外界无法再通过/, '应说明关闭后外界访问不到');
});

test('nginx-proxy-toggle.sh：可执行、危险操作有护栏（备份 / nginx -t / 回滚 / 不依赖 GNU sed）', () => {
  const file = 'deploy/scripts/nginx-proxy-toggle.sh';
  const text = fs.readFileSync(path.join(projectRoot, file), 'utf8');
  const mode = fs.statSync(path.join(projectRoot, file)).mode;
  assert.ok(mode & 0o111, '脚本应可执行');

  // 改配置前备份、改完检查、失败回滚 —— 这是「不能把用户 nginx 搞挂」的底线
  assert.match(text, /ttdownload-backup-/, '应备份原配置');
  assert.match(text, /nginx_ok\(\)/, '应有 nginx -t 检查');
  assert.match(text, /已回滚/, '失败时应回滚');
  assert.match(text, /未做任何改动/, '预检失败时不应动手');
  // 只插一个 include，绝不去重写整个 nginx.conf
  assert.match(text, /include \$\{SNIPPET\};/, '应以 include 片段方式接入');
  assert.match(text, /proxy_pass http:\/\/\$\{TARGET\};/, 'proxy_pass 不能带尾斜杠（要保留 /transmission 前缀）');
  // preview 必须只读
  assert.match(text, /^preview\(\)/m, '应有 preview 只读模式');
  // 可移植性：BSD/macOS 的 sed -i 与 GNU 参数不兼容，会静默不改文件（实机踩过）
  const codeOnly = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.equal(/sed\s+-i/.test(codeOnly), false, '不能用 sed -i（GNU/BSD 不兼容）');
  assert.match(text, /write_file_atomic/, '应使用可移植的原子写入');
  // 调用方（Node 服务）靠这一行解析结果
  assert.match(text, /TTDL_NGINX_PROXY_RESULT=/, '应输出机器可解析的结果行');
});
