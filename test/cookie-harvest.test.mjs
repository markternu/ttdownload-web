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
  assert.equal(r.harvested, false);
  // 关键：交出去的必须是**副本**，不能是用户原件（yt-dlp 会回写它）
  assert.notEqual(r.cookiesFile, userFile, '绝不能把用户上传的原件交给 yt-dlp');
  assert.equal(
    fs.readFileSync(r.cookiesFile, 'utf8'),
    fs.readFileSync(userFile, 'utf8'),
    '副本内容要与原件一致',
  );
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

test('★抖音：纯 HTTP 拿 ttwid（不需要浏览器、不需要 chromium）', async () => {
  // 清掉浏览器路径，证明「没装 chromium 也能自动获取」
  const savedChromium = process.env.CHROMIUM_PATH;
  process.env.CHROMIUM_PATH = '/nonexistent/no-chromium-installed'; // 显式表示：这台机器没有 chromium
  cookies.__setHarvesterLauncher(null);

  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls += 1;
    assert.match(String(url), /ttwid\.bytedance\.com/);
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body ?? '{}'));
    assert.equal(body.region, 'cn', '应按官方要求带上 region/aid 等参数');
    return {
      status: 200,
      headers: {
        getSetCookie: () => ['ttwid=1%7Cabc%7C123%7Cdef; Path=/; Domain=bytedance.com; Max-Age=31536000; HttpOnly; Secure'],
        get: () => null,
      },
    };
  };

  try {
    assert.equal(
      cookies.chromiumPath(),
      null,
      '前提：显式把 CHROMIUM_PATH 指到不存在的路径 → 等价于这台机器没有 chromium',
    );
    const meta = await cookies.harvestNow('douyin');
    assert.ok(meta, '应成功');
    assert.equal(meta.via, 'http', '应走 HTTP 途径（不是浏览器）');
    assert.equal(fetchCalls, 1);
    const parsed = cookies.readCookieFile(meta.file);
    const ttwid = parsed.find((c) => c.name === 'ttwid');
    assert.ok(ttwid, '应有 ttwid');
    assert.equal(ttwid.value, '1%7Cabc%7C123%7Cdef', 'ttwid 原样保留（含 URL 编码的竖线）');
    assert.ok(parsed.some((c) => c.domain === '.douyin.com'), '必须挂到 .douyin.com（网页接口要的就是它）');
    assert.ok(parsed.some((c) => c.domain === '.bytedance.com'), '原始域也保留');
    assert.match(fs.readFileSync(meta.file, 'utf8'), /#HttpOnly_/, 'ttwid 是 HttpOnly，必须写成 #HttpOnly_ 前缀');
  } finally {
    globalThis.fetch = realFetch;
    if (savedChromium) process.env.CHROMIUM_PATH = savedChromium;
    cookies.__setHarvesterLauncher(null);
  }
});

test('★没有 chromium 时，有 HTTP 途径的站点（抖音）依然能自动获取', async () => {
  const savedChromium = process.env.CHROMIUM_PATH;
  process.env.CHROMIUM_PATH = '/nonexistent/no-chromium-installed'; // 显式表示：这台机器没有 chromium
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    headers: {
      getSetCookie: () => ['ttwid=xyz; Path=/; Domain=bytedance.com; HttpOnly; Secure'],
      get: () => null,
    },
  });
  try {
    assert.equal(cookies.chromiumPath(), null, '显式指定不存在的 CHROMIUM_PATH → 视为没有 chromium');
    const r = await cookies.cookiesForUrl('https://v.douyin.com/abc/', null, { forceHarvest: true });
    assert.equal(r.harvested, true, '没装浏览器也该能自动获取（抖音走 HTTP）');
    assert.ok(r.cookiesFile);
    const names = cookies.readCookieFile(r.cookiesFile).map((c) => c.name);
    assert.ok(names.length >= 1 && names.every((n) => n === 'ttwid'), `应只有 ttwid，实际 ${JSON.stringify(names)}`);
  } finally {
    globalThis.fetch = realFetch;
    if (savedChromium) process.env.CHROMIUM_PATH = savedChromium;
  }
});

test('HTTP 途径失败时会退回无头浏览器（两条腿走路）', async () => {
  process.env.CHROMIUM_PATH = '/bin/sh';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('模拟网络失败');
  };
  let launcherUsed = 0;
  cookies.__setHarvesterLauncher(async () => {
    launcherUsed += 1;
    return [
      { domain: '.douyin.com', includeSubdomains: true, path: '/', secure: true, expires: 1900000000, name: '__ac_signature', value: 'sig-browser', httpOnly: false },
    ];
  });
  try {
    const meta = await cookies.harvestNow('douyin');
    assert.equal(launcherUsed, 1, 'HTTP 失败后应启动浏览器兜底');
    assert.equal(meta.via, 'browser');
    assert.equal(cookies.readCookieFile(meta.file)[0].name, '__ac_signature');
  } finally {
    globalThis.fetch = realFetch;
    process.env.CHROMIUM_PATH = '/nonexistent/no-chromium-installed'; // 显式表示：这台机器没有 chromium
    cookies.__setHarvesterLauncher(null);
  }
});

test('★B站：纯 HTTP 从首页拿 buvid3 等访客 cookies（并且带中文 Accept-Language）', async () => {
  const realFetch = globalThis.fetch;
  let seenHeaders = {};
  globalThis.fetch = async (url, init) => {
    seenHeaders = init?.headers ?? {};
    assert.match(String(url), /bilibili\.com/);
    return {
      status: 200,
      headers: {
        getSetCookie: () => [
          'buvid3=ABC123infoc; Path=/; Domain=.bilibili.com; Expires=Wed, 01 Jan 2027 00:00:00 GMT',
          'b_nut=1789459423; Path=/; Domain=.bilibili.com',
          'unwanted=xx; Path=/; Domain=.bilibili.com',
        ],
        get: () => null,
      },
    };
  };
  try {
    const got = await cookies.fetchHomepageCookies('https://www.bilibili.com/', ['buvid3', 'b_nut']);
    assert.deepEqual(
      got.map((c) => c.name).sort(),
      ['b_nut', 'buvid3'],
      '只保留需要的名字',
    );
    assert.ok(got.every((c) => c.domain === '.bilibili.com'), '应挂到 .bilibili.com（覆盖子域）');
    assert.equal(seenHeaders['Accept-Language'], 'zh-CN,zh;q=0.9', '对国内站点必须发中文 Accept-Language');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('B站已加入默认可自动获取的站点，并带 referer + 中文 Accept-Language', () => {
  // 这个文件开头为了别的用例设了 COOKIE_HARVEST_SITES，这里要看「默认值」
  const saved = process.env.COOKIE_HARVEST_SITES;
  delete process.env.COOKIE_HARVEST_SITES;
  try {
    assert.ok(cookies.defaultHarvestSites().includes('bilibili'), 'B站应默认开启自动获取');
    assert.ok(cookies.defaultHarvestSites().includes('douyin'), '抖音也应在默认清单里');
  } finally {
    if (saved !== undefined) process.env.COOKIE_HARVEST_SITES = saved;
  }
  const p = cookies.profileFor('https://b23.tv/vckgrcX');
  assert.equal(p?.id, 'bilibili');
  assert.ok(p.extraArgs.includes('--referer'));
  const i = p.extraArgs.indexOf('--add-header');
  assert.ok(i >= 0 && /Accept-Language: zh-CN/.test(p.extraArgs[i + 1]), '应覆盖成中文 Accept-Language');
  assert.equal(typeof p.httpProvider, 'function', 'B站应能用纯 HTTP 拿 cookies（不需要浏览器）');
  const site = cookies.harvestStatus().sites.find((x) => x.id === 'bilibili');
  assert.equal(site?.needsBrowser, false, 'harvestStatus 里应标明不需要浏览器');
});

test('★B站 412 的错误提示必须指向「出口 IP 归属」，而不是让用户去折腾 cookies', async () => {
  const { humanizeYtDlpError } = await import('../dist/modules/webvideo.js');
  const msg = humanizeYtDlpError(
    'ERROR: [BiliBili] 1eh8q6rEoS: Unable to download webpage: HTTP Error 412: Precondition Failed',
    'https://b23.tv/vckgrcX',
  );
  assert.match(msg, /412/);
  assert.match(msg, /出口 IP|机房|海外/, '要指出是出口 IP 归属问题');
  assert.match(msg, /bilibili\.com|b23\.tv/, '要指出哪些域名要走直连');
  assert.doesNotMatch(msg, /上传 cookies\.txt（或填/, '不能又让用户去导 cookies（那是错的方向）');
});

test('★回归：yt-dlp 会回写 cookies 文件 —— 所以只能给它副本，用户原件必须毫发无损', async () => {
  // 这条测的是"给 yt-dlp 的一定是副本"。真机上装了 chromium 时 YouTube 也会走
  // 自动抓取 + 合并那条路径，测到的就变成"合并缓存"了 → 先显式声明"没有浏览器"，
  // 把这条用例隔离在"保护原件"这一件事上。
  const savedChromium = process.env.CHROMIUM_PATH;
  process.env.CHROMIUM_PATH = '/nonexistent/no-chromium-installed';
  const dir = path.join(root, 'state');
  const userFile = path.join(dir, 'user-original.txt');
  const original = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tMY_LOGIN_SID',
    '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tLOGIN_INFO\tMY_LOGIN_INFO',
    '',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(userFile, original);

  const r = await cookies.cookiesForUrl('https://www.youtube.com/watch?v=x', userFile);
  assert.ok(r.cookiesFile, '应给出 cookies 文件');
  assert.notEqual(r.cookiesFile, userFile, 'YouTube 不走自动抓取，更要给副本');

  // 模拟 yt-dlp 回写：把副本清空/改坏（真实场景是 YouTube 下发会话失效，yt-dlp 把结果写回）
  fs.writeFileSync(r.cookiesFile, '# Netscape HTTP Cookie File\n', { mode: 0o600 });
  assert.equal(fs.readFileSync(userFile, 'utf8'), original, '用户原件必须一个字节都没变');

  // 副本丢了/被改小 → 下次自动重新拷贝
  const again = await cookies.cookiesForUrl('https://www.youtube.com/watch?v=x', userFile);
  assert.equal(fs.readFileSync(again.cookiesFile, 'utf8'), original, '下一次应重新从原件拷贝');
  assert.equal(fs.readFileSync(userFile, 'utf8'), original, '原件依然不能被动');

  if (savedChromium === undefined) delete process.env.CHROMIUM_PATH;
  else process.env.CHROMIUM_PATH = savedChromium;
});
