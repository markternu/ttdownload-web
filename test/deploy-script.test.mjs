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

const projectRoot = path.resolve('.');
const deploySrc = fs.readFileSync(path.join(projectRoot, 'deploy.sh'), 'utf8');

// 从 deploy.sh 中抽出依赖相关函数（have_cmd ~ configure_transmission_env 结束）
const startMarker = 'have_cmd() {';
const endMarker = '# ---------------------------------------------------------------- 已部署后的管理动作';
const startIdx = deploySrc.indexOf(startMarker);
const endIdx = deploySrc.indexOf(endMarker);
assert.ok(startIdx > 0 && endIdx > startIdx, '应从 deploy.sh 中提取到依赖处理函数');
const functionsBlock = deploySrc.slice(startIdx, endIdx);

function makeSandbox({ withAria2, withTransmission, fakeInstallerBody }) {
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
    writeStub('transmission-remote', 'echo transmission-remote-mock');
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

test('deploy/ubuntutr.sh 与原始脚本逐字节一致（交互提示原样保留）', () => {
  const bundled = fs.readFileSync(path.join(projectRoot, 'deploy/ubuntutr.sh'));
  const originalPath = '/Users/wt/Desktop/androidapp/github/ubuntutr.sh';
  if (!fs.existsSync(originalPath)) {
    // 原脚本不在此机器上时，至少校验关键交互提示存在
    const text = bundled.toString('utf8');
    for (const prompt of ['是否启用 IP 白名单?', '设置 RPC 登录密码: ', '再次确认密码: ', '[11/11] 最终启动服务']) {
      assert.ok(text.includes(prompt), `应保留交互提示: ${prompt}`);
    }
    return;
  }
  const original = fs.readFileSync(originalPath);
  assert.deepEqual(bundled, original, 'bundled 的 ubuntutr.sh 必须与原始脚本完全一致');
});
