/**
 * 自动获取访客 cookies 的测试
 *
 * 关键回归点：
 *  1) Netscape 格式的 HttpOnly 前缀（`#HttpOnly_`）必须能正确读写 —— 写错 yt-dlp 直接报
 *     "invalid Netscape format cookies file"（实测踩过）；
 *  2) 合并时**不能**用匿名抓来的值覆盖用户的登录态 cookie；
 *  3) 抖音必须带上 --referer（不带就一定失败，实测）；
 *  4) 「需要 cookies」的错误不能被当成「被限流」—— 之前正是这个误判让程序在试了 2 次后
 *     就放弃，并让用户「等 10~30 分钟」，完全搞错方向。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime({ env: { COOKIE_HARVEST_SITES: 'douyin,youtube' } });
// chromiumPath() 要求文件存在；用一个真实存在的可执行文件占位（真正的启动器下面会注入）
process.env.CHROMIUM_PATH = '/bin/sh';

const cookies = await import('../dist/services/cookieHarvest.js');
const { isCookieRequiredError, isRateLimitError, humanizeYtDlpError } = await import('../dist/modules/webvideo.js');

test.after(() => {
  cookies.__setHarvesterLauncher(null);
});

test('Netscape 格式：HttpOnly 用 #HttpOnly_ 前缀读写，能往返', () => {
  const line = '#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1900000000\tttwid\t1%7Cabc';
  const parsed = cookies.parseNetscapeLine(line);
  assert.ok(parsed, '应能解析 HttpOnly 行');
  assert.equal(parsed.httpOnly, true);
  assert.equal(parsed.domain, '.douyin.com');
  assert.equal(parsed.name, 'ttwid');
  assert.equal(parsed.value, '1%7Cabc');
  assert.equal(cookies.formatNetscapeLine(parsed), line, '写回必须还原成同一行');

  const plain = cookies.parseNetscapeLine('.youtube.com\tTRUE\t/\tFALSE\t1900000000\tPREF\tf6=400');
  assert.equal(plain.httpOnly, false);
  assert.ok(!cookies.formatNetscapeLine(plain).startsWith('#HttpOnly_'));
  assert.equal(cookies.parseNetscapeLine('# 这是注释'), null);
  assert.equal(cookies.parseNetscapeLine(''), null);
  assert.equal(cookies.parseNetscapeLine('字段\t不够'), null);
});

test('合并 cookies：登录态保留用户的，其余用新鲜抓取的', () => {
  const dir = path.join(root, 'merge-test');
  fs.mkdirSync(dir, { recursive: true });
  const userFile = path.join(dir, 'user.txt');
  const freshFile = path.join(dir, 'fresh.txt');
  const out = path.join(dir, 'merged.txt');

  fs.writeFileSync(
    userFile,
    [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tUSER_SID_VALUE',
      '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tPREF\tUSER_PREF_OLD',
      '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tLOGIN_INFO\tUSER_LOGIN_INFO',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    freshFile,
    [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tANON_SID_SHOULD_NOT_WIN',
      '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tPREF\tFRESH_PREF_NEW',
      '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tVISITOR_INFO1_LIVE\tFRESH_VISITOR',
      '',
    ].join('\n'),
  );

  const count = cookies.mergeCookieFiles([userFile, freshFile], out);
  const parsed = cookies.readCookieFile(out);
  const byName = new Map(parsed.map((c) => [c.name, c.value]));
  assert.equal(count, 4, '4 个不同的 cookie（SID/PREF/LOGIN_INFO/VISITOR）');
  assert.equal(byName.get('SID'), 'USER_SID_VALUE', '登录态 SID 绝不能被匿名值覆盖');
  assert.equal(byName.get('LOGIN_INFO'), 'USER_LOGIN_INFO', 'LOGIN_INFO 也要保留');
  assert.equal(byName.get('PREF'), 'FRESH_PREF_NEW', '非登录态 cookie 用新鲜值');
  assert.equal(byName.get('VISITOR_INFO1_LIVE'), 'FRESH_VISITOR', '新增的 cookie 要带进来');
});

test('站点识别：抖音带 referer，YouTube 不带', () => {
  const dy = cookies.profileFor('https://v.douyin.com/wxkLrzmtN6M/');
  assert.equal(dy?.id, 'douyin');
  assert.ok(dy.extraArgs.includes('--referer'), '抖音必须带 referer（实测必需）');
  assert.ok(dy.extraArgs.includes('https://www.douyin.com/'));
  assert.equal(cookies.profileFor('https://www.iesdouyin.com/share/video/1/')?.id, 'douyin');

  const yt = cookies.profileFor('https://www.youtube.com/watch?v=abc');
  assert.equal(yt?.id, 'youtube');
  assert.deepEqual(yt.extraArgs, [], 'YouTube 不加额外参数（默认指纹最稳）');

  assert.equal(cookies.profileFor('https://example.com/video/1')?.id ?? null, null, '未收录站点不抓');
});

test('cookiesForUrl：自动抓取 → 落盘 → 缓存（TTL 内不重复抓）→ force 可强制重抓', async () => {
  let calls = 0;
  cookies.__setHarvesterLauncher(async (profile) => {
    calls += 1;
    return [
      { domain: '.douyin.com', includeSubdomains: true, path: '/', secure: true, expires: 1900000000, name: '__ac_nonce', value: `nonce-${calls}`, httpOnly: false },
      { domain: '.douyin.com', includeSubdomains: true, path: '/', secure: true, expires: 1900000000, name: '__ac_signature', value: `sig-${calls}`, httpOnly: false },
      { domain: '.douyin.com', includeSubdomains: true, path: '/', secure: true, expires: 1900000000, name: 'ttwid', value: `ttwid-${calls}`, httpOnly: true },
    ];
  });

  const url = 'https://v.douyin.com/abc/';
  const first = await cookies.cookiesForUrl(url, null);
  assert.equal(calls, 1, '第一次应触发抓取');
  assert.equal(first.harvested, true);
  assert.ok(first.cookiesFile && fs.existsSync(first.cookiesFile), '应给出可用的 cookies 文件');
  assert.ok(first.extraArgs.includes('--referer'));
  const names = cookies.readCookieFile(first.cookiesFile).map((c) => c.name).sort();
  assert.deepEqual(names, ['__ac_nonce', '__ac_signature', 'ttwid']);
  // HttpOnly 那条必须写对，否则 yt-dlp 报格式错误
  assert.match(fs.readFileSync(first.cookiesFile, 'utf8'), /#HttpOnly_\.douyin\.com\t.*\tttwid\t/);

  const second = await cookies.cookiesForUrl(url, null);
  assert.equal(calls, 1, 'TTL 内应直接用缓存，不重复开浏览器');
  assert.equal(second.cookiesFile, first.cookiesFile);

  const forced = await cookies.cookiesForUrl(url, null, { forceHarvest: true });
  assert.equal(calls, 2, 'forceHarvest 应强制重抓（cookie 失效自愈用）');
  // 没有用户 cookies 时就是同一个文件被刷新（内容必须是新的）
  assert.match(fs.readFileSync(forced.cookiesFile, 'utf8'), /nonce-2/, '重抓后内容应更新');
  assert.doesNotMatch(fs.readFileSync(forced.cookiesFile, 'utf8'), /nonce-1/);
});

test('cookiesForUrl：用户上传的 cookies 会与自动抓取的合并（登录态保留）', async () => {
  const userFile = path.join(root, 'state', 'user-cookies.txt');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t1900000000\tSID\tUSER_SID\n');

  cookies.__setHarvesterLauncher(async () => [
    { domain: '.douyin.com', includeSubdomains: true, path: '/', secure: true, expires: 1900000000, name: '__ac_signature', value: 'sig-x', httpOnly: false },
  ]);

  const r = await cookies.cookiesForUrl('https://www.douyin.com/video/1', userFile, { forceHarvest: true });
  assert.equal(r.harvested, true);
  const byName = new Map(cookies.readCookieFile(r.cookiesFile).map((c) => [c.name, c.value]));
  assert.equal(byName.get('SID'), 'USER_SID', '用户的登录态要保留');
  assert.equal(byName.get('__ac_signature'), 'sig-x', '自动抓到的签名 cookie 也要在');
});

test('cookiesForUrl：没开自动抓取的站点（如小红书）原样使用用户的 cookies', async () => {
  let calls = 0;
  cookies.__setHarvesterLauncher(async () => {
    calls += 1;
    return [];
  });
  const userFile = path.join(root, 'state', 'user-cookies.txt');
  const r = await cookies.cookiesForUrl('https://www.xiaohongshu.com/explore/1', userFile);
  assert.equal(calls, 0, '未开启自动抓取的站点不应启动浏览器');
  assert.equal(r.cookiesFile, userFile);
  assert.equal(r.harvested, false);
});

test('harvestStatus：给出站点、开关与浏览器可用性', () => {
  const st = cookies.harvestStatus();
  assert.ok(Array.isArray(st.sites) && st.sites.length > 0);
  const dy = st.sites.find((s) => s.id === 'douyin');
  assert.ok(dy, '应有抖音');
  assert.equal(dy.auto, true, '抖音默认开启自动抓取');
  assert.equal(st.chromium, '/bin/sh', '应报告探测到的浏览器路径');
  assert.deepEqual(st.harvestSites, ['douyin', 'youtube']);
});

test('★回归：「需要新鲜 cookies」不能被当成「被限流」（否则会放弃并让用户干等）', () => {
  const douyinErr = 'ERROR: [Douyin] 7680875970777135534: Fresh cookies (not necessarily logged in) are needed';
  assert.equal(isCookieRequiredError(douyinErr), true);
  assert.equal(isRateLimitError(douyinErr), false, '抖音的 cookie 问题不是限流');

  // 中文文案同样不能被误判
  const zh = humanizeYtDlpError(douyinErr, 'https://v.douyin.com/abc/');
  assert.match(zh, /抖音/);
  assert.match(zh, /自动/);
  assert.equal(isRateLimitError(zh), false);

  // 真正的限流仍然要识别出来
  const ytBot = "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser";
  assert.equal(isRateLimitError(ytBot), true);
  assert.match(humanizeYtDlpError(ytBot, 'https://www.youtube.com/watch?v=abc'), /IP/);

  // YouTube 会员视频：要说明「上传 cookies」，而不是「等 10 分钟」
  const members = "ERROR: This video is available to this channel's members";
  const msg = humanizeYtDlpError(members, 'https://www.youtube.com/watch?v=abc');
  assert.match(msg, /cookies/);
  assert.equal(isRateLimitError(msg), false);
});
