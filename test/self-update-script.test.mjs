/**
 * 自动升级「起不来」的回归测试（真机事故，2026-10-08）
 *
 * 现场日志：
 *   [14:30:30] ===== 开始自动升级 =====  repo=/ ref=<远端默认> service=ttdownload-web
 *   git fetch --prune ... → fatal: not a git repository (or any of the parent directories): .git
 *   然后每 30 秒重复一次（开机 → 发现新版本 → 升级 → 退出 → systemd 重启 → 再来）
 *
 * 两个真根因，各配一条会红的用例：
 *   ① 脚本的"仓库路径"退化成了 `/`：
 *      脚本会把自己复制到 /tmp 再执行（防止 git reset 换掉正在跑的脚本），
 *      而仓库路径默认值是 `dirname($0)/../..` —— re-exec 之后 $0 指向 /tmp，
 *      于是 `.. /..` = `/`。而且程序传的参数还会被 systemd-run 吃掉（真机上脚本
 *      收到 0 个参数）。修：**re-exec 之前**解析好仓库路径、用 env 传下去，
 *      并且程序调用时同时用 env 传参。
 *   ② 升级失败后会**每次开机都重试**（死循环刷日志、反复暂停下载）。
 *      修：同目标失败后在冷却期（默认 30 分钟）内不再自动重试，页面提示走手动命令。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime();
const { buildUpdaterCommand, shouldSkipAutoApply, recordAttempt, ATTEMPT_FILE, getUpdateStatus, manualUpdateCommand } =
  await import('../dist/services/updater.js');
const { config } = await import('../dist/core/config.js');

const SCRIPT = path.join(config.rootDir, 'deploy', 'scripts', 'self-update.sh');

/* --------------------------- ① 脚本的配置解析 --------------------------- */

/** 在临时目录里造一个"假仓库"（只有 .git 和一个 .env），把脚本拷进去 */
function fakeRepo(extraEnv = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-selfupd-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'deploy', 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'deploy', 'scripts', 'self-update.sh'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), `DOWNLOAD_ROOT=${dir}\n${extraEnv}`);
  return { dir, state };
}

const printConfig = (repoDir, args = [], env = {}) =>
  execFileSync('bash', ['deploy/scripts/self-update.sh', '--print-config', ...args], {
    cwd: repoDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

test('【事故根因①】脚本就算一个参数都没收到，也要解析出**正确的仓库路径**（不能是 /）', () => {
  const { dir } = fakeRepo();
  // 模拟真机：systemd-run 把 --repo/--ref 全吃掉了，脚本收到 0 个参数
  const out = printConfig(dir, []);
  const repo = /^repo=(.*)$/m.exec(out)?.[1];
  // macOS 的 /var 是 /private/var 的软链，pwd 返回真实路径 → 两边都取 realpath 再比
  assert.equal(fs.realpathSync(repo), fs.realpathSync(dir), `仓库路径必须是自己所在的仓库，而不是 "/"（实际 ${repo}）`);
  assert.notEqual(repo, '/', 're-exec 到 /tmp 之后靠 $0 推导会得到 / —— 这个坑不能再犯');
});

test('【事故根因①】参数用环境变量传也能生效（程序调用走的就是这条路）', () => {
  const { dir, state } = fakeRepo();
  const out = printConfig(dir, ['--print-config'], {
    TTDL_REPO: dir,
    TTDL_REF: 'deadbee',
    TTDL_SERVICE: 'ttdownload-web',
    TTDL_LOG: path.join(state, 'update.log'),
    TTDL_CALLER: 'app(自动更新)',
  });
  assert.equal(fs.realpathSync(/^repo=(.*)$/m.exec(out)[1]), fs.realpathSync(dir));
  assert.match(out, /^ref=deadbee$/m, 'env 里的 ref 要被采纳');
  assert.ok(out.includes(`log=${path.join(state, 'update.log')}`), 'env 里的 log 要被采纳');
});

test('命令行参数优先级高于环境变量（人工执行时不会被程序留下的 env 干扰）', () => {
  const { dir } = fakeRepo();
  const out = printConfig(dir, ['--ref', 'from-cli', '--repo', dir], { TTDL_REPO: '/tmp/不存在', TTDL_REF: 'from-env' });
  assert.equal(fs.realpathSync(/^repo=(.*)$/m.exec(out)[1]), fs.realpathSync(dir), '--repo 优先级最高');
  assert.match(out, /^ref=from-cli$/m, '--ref 要盖过 env');
});

test('仓库目录不存在要**明确报错退出**，不能默默去操作别的地方', () => {
  const { dir } = fakeRepo();
  assert.throws(
    () => printConfig(dir, ['--repo', '/definitely/not/here']),
    /仓库目录不存在/,
    '路径不对必须报错，绝不能拿着一个坏路径继续跑 git/npm',
  );
});

/* --------------------------- ② 程序侧的调用方式 --------------------------- */

test('【事故根因①】启动脚本时参数**同时**用命令行和 env 传，且 systemd-run 命令里要有 `--`', () => {
  const cmd = buildUpdaterCommand({
    script: '/repo/deploy/scripts/self-update.sh',
    repo: '/repo',
    ref: 'abc1234',
    service: 'ttdownload-web',
    log: '/ttdownload/state/update.log',
    previous: 'old1234',
  });
  // 命令行一份
  assert.deepEqual(cmd.cliArgs, [
    '--repo', '/repo', '--ref', 'abc1234', '--service', 'ttdownload-web',
    '--log', '/ttdownload/state/update.log', '--previous', 'old1234',
  ]);
  // env 再来一份（systemd-run 吃参数时靠它兜底）
  assert.equal(cmd.env.TTDL_REPO, '/repo');
  assert.equal(cmd.env.TTDL_REF, 'abc1234');
  assert.equal(cmd.env.TTDL_SERVICE, 'ttdownload-web');
  assert.equal(cmd.env.TTDL_LOG, '/ttdownload/state/update.log');
  assert.equal(cmd.env.TTDL_PREVIOUS, 'old1234');
  assert.match(cmd.env.TTDL_SELF_UPDATE_ARGV, /self-update\.sh/, '日志里要能看见完整 argv，方便下次排查');
  assert.match(cmd.shellCmd, /--repo \/repo/, '展示给用户的命令要带仓库路径');
});

/* --------------------------- ③ 失败后的冷却 --------------------------- */

function makeStatus(over = {}) {
  return {
    ...getUpdateStatus(),
    repoReady: true,
    versionNewer: true,
    available: true,
    behind: 1,
    latestVersion: '9.9.9',
    latestCommit: 'target-sha',
    ...over,
  };
}

test('【事故根因②】上次升级失败后，冷却期内不再自动重试（避免开机→升级→失败→重启死循环）', () => {
  fs.rmSync(ATTEMPT_FILE(), { force: true });
  const st = makeStatus();
  recordAttempt({
    at: new Date().toISOString(),
    target: 'target-sha',
    fromVersion: st.currentVersion,
    ok: null,
  });
  const skip = shouldSkipAutoApply(st, new Date().toISOString(), 30);
  assert.equal(skip.skip, true, '同目标刚失败过 → 必须跳过自动重试');
  assert.match(String(skip.reason), /手动/, '要告诉用户改用手动命令');
});

test('冷却时间过了 / 换了新目标 / 本地版本已经变了 → 允许再试', () => {
  fs.rmSync(ATTEMPT_FILE(), { force: true });
  const st = makeStatus();

  // ① 冷却时间已过（40 分钟前失败的）
  recordAttempt({
    at: new Date(Date.now() - 40 * 60_000).toISOString(),
    target: 'target-sha',
    fromVersion: st.currentVersion,
    ok: null,
  });
  assert.equal(shouldSkipAutoApply(st, new Date().toISOString(), 30).skip, false, '过了冷却期要再试');

  // ② 远端又发了新提交（目标变了）
  recordAttempt({ at: new Date().toISOString(), target: 'other-sha', fromVersion: st.currentVersion, ok: null });
  assert.equal(shouldSkipAutoApply(st, new Date().toISOString(), 30).skip, false, '目标变了要再试');

  // ③ 本地版本已经变了（说明上次其实升成功了）
  recordAttempt({ at: new Date().toISOString(), target: 'target-sha', fromVersion: '0.0.1', ok: true });
  assert.equal(shouldSkipAutoApply(st, new Date().toISOString(), 30).skip, false, '版本已变，记录作废');
});

/* --------------------------- ④ 页面需要的数据 --------------------------- */

test('状态里给出「手动更新命令」和「自动重试被挡的原因」，页面才能一键复制并说明', () => {
  const st = getUpdateStatus();
  assert.match(st.manualCommand, /^cd .+ && sudo \.\/deploy\.sh --update$/, '必须给出可直接执行的手动升级命令');
  // 家目录下的部署用 ~ 形式（用户是用自己的账号 ssh 执行，~ = 他自己的家目录）
  if (/^(?:\/home|\/Users)\/[^/]+\//.test(config.rootDir)) {
    assert.match(st.manualCommand, /^cd ~\//, `家目录下的部署要显示成 ~/…（实际 ${st.manualCommand}）`);
  }
  assert.equal(st.rootDir, config.rootDir, '页面要能显示实际绝对路径（避免 ~ 有歧义）');
  assert.match(st.manualCommand, new RegExp(config.rootDir.split('/').pop()), '命令里要包含项目目录名');
  assert.ok('autoApplySkipReason' in st, '状态里要有冷却原因字段（页面据此提示）');
  assert.equal(manualUpdateCommand(), st.manualCommand);
});
