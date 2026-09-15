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

function makeSandbox({ withAria2, withTransmission, withTransmissionRemote = withTransmission, fakeInstallerBody }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-deploy-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(logFile, '');

  const writeStub = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };

  if (withAria2) writeStub('aria2c', 'echo "aria2 version 1.37.0"');
  if (withTransmission) {
    writeStub('transmission-daemon', 'echo transmission-daemon-mock');
    if (withTransmissionRemote) writeStub('transmission-remote', 'echo transmission-remote-mock');
  }
  // apt-get 桩：只记录被调用的参数
  writeStub('apt-get', `echo "apt-get $@" >> ${logFile}`);
  writeStub('systemctl', `echo "systemctl $@" >> ${logFile}`);

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
PATH="${bin}:/usr/bin:/bin"
DEPLOY_ASSUME_TTY=1
export PATH DEPLOY_ASSUME_TTY
log()  { echo "[deploy] $*"; }
warn() { echo "[deploy][warn] $*"; }
die()  { echo "[deploy][die] $*" >&2; exit 1; }

${functionsBlock}

print_dep_status
ensure_aria2
ensure_transmission
`,
    { mode: 0o755 },
  );

  return {
    dir,
    logFile,
    installer,
    run: (args = []) => execFileSync('bash', [harness, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
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

test('transmission 未安装：必须调用工程自带的 deploy/ubuntutr.sh（保留其交互）', () => {
  const sb = makeSandbox({ withAria2: true, withTransmission: false });
  const out = sb.run();
  assert.match(out, /未检测到 transmission/);
  assert.match(out, /ubuntutr\.sh/);
  const calls = sb.calls();
  assert.match(calls, /INSTALLER_CALLED/, '应调用安装脚本');
  // 且不能擅自 apt 安装 transmission
  assert.equal(/apt-get install[^\n]*transmission/.test(calls), false, '不得绕过交互脚本直接 apt 安装 transmission');
});

test('两者都未安装：先装 aria2，再调用 transmission 交互安装脚本', () => {
  const sb = makeSandbox({ withAria2: false, withTransmission: false });
  const out = sb.run();
  const calls = sb.calls();
  assert.match(calls, /apt-get install -y aria2/);
  assert.match(calls, /INSTALLER_CALLED/);
  assert.match(out, /交互式提问|请按提示输入/);
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
  assert.match(deploySrc, /"\$OS_ID" == "ubuntu"/, '必须同时判断发行版 ID 是 ubuntu');
  assert.match(deploySrc, /OS_MAJ < 20/, '只有 Ubuntu <20.04 才回退 Node 18');
  // 回归：不能用「VERSION_ID 的整数」直接和 20 比较（Debian 12/13 会被误判）
  assert.equal(/UBUNTU_MAJ < 20/.test(deploySrc), false, '旧的 Ubuntu-only 判断必须已移除');
  // NodeSource 不支持某些新发行版时要能退化到发行版仓库
  assert.match(deploySrc, /NodeSource 源配置失败/, '应有 NodeSource 失败后的降级处理');
  assert.match(deploySrc, /apt-get install -y nodejs npm/, '应能退回发行版仓库安装 nodejs');
  assert.match(deploySrc, /Node 版本仍然过低/, '装完仍过低要明确报错');
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
  assert.match(deploySrc, /SCRIPT_UPLOAD_ENABLED=0/, '应给现有 .env 补齐修复脚本开关');
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
