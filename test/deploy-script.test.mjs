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
  for (const sub of ['--update', '--stop', '--start', '--logs', '--logs-follow', '--collect', '--restart', '--status', '--uninstall']) {
    assert.ok(deploySrc.includes(sub), `deploy.sh 应支持 ${sub}`);
  }
  assert.match(deploySrc, /git pull --ff-only/, '--update 应拉取最新代码');
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
});

test('内置环境脚本：diagnose-env.sh / fix-node20.sh / fix-ytdlp.sh 存在、可执行、内容正确', () => {
  const scripts = [
    { file: 'deploy/scripts/diagnose-env.sh', must: [/体检/, /aria2/, /yt-dlp/, /resolve_host/, /safe\.directory/, /JS 运行时/, /yt-dlp-ejs/, /exit 0/], readonly: true },
    { file: 'deploy/scripts/fix-node20.sh', must: [/setup_20\.x/, /npm ci/, /npm run build/, /systemctl restart/, /回滚/, /safe\.directory/, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD/], readonly: false },
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
      assert.equal(/\brm -rf\b|apt-get install|npm install/.test(text), false, '只读体检脚本不应包含修改性命令');
    }
  }
});
