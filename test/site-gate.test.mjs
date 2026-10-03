import { test } from 'node:test';
import assert from 'node:assert/strict';
const gate = await import('../dist/services/siteGate.js');

test('站点节流：间隔 0 时完全直通（不拖慢不受风控影响的站点）', async () => {
  gate.__resetSiteGates();
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) {
    const { release } = await gate.acquireSiteSlot('nobody.com', { minGapMs: 0 });
    release();
  }
  assert.ok(Date.now() - t0 < 100, '间隔 0 必须直通，不该有任何等待');
});

test('站点节流：相邻两次启动至少间隔 minGapMs（这是不被风控打爆的关键）', async () => {
  gate.__resetSiteGates();
  const GAP = 150;
  const starts = [];
  for (let i = 0; i < 3; i += 1) {
    const { release } = await gate.acquireSiteSlot('douyin', { minGapMs: GAP });
    starts.push(Date.now());
    release();
  }
  for (let i = 1; i < starts.length; i += 1) {
    const delta = starts[i] - starts[i - 1];
    assert.ok(delta >= GAP - 15, `第 ${i + 1} 次启动必须等够间隔：实际 ${delta}ms < ${GAP}ms`);
  }
});

test('★站点节流：并发同时申请时会被**排队拉开**（真机血案：5 条任务同时捶 → 一分钟 26~31 次 → 立刻被限流）', async () => {
  gate.__resetSiteGates();
  const GAP = 120;
  const starts = [];
  // 模拟"一次入队 5 条视频、同时开跑"
  await Promise.all(
    Array.from({ length: 5 }, () =>
      (async () => {
        const { release } = await gate.acquireSiteSlot('douyin', { minGapMs: GAP });
        starts.push(Date.now());
        release();
      })(),
    ),
  );
  starts.sort((a, b) => a - b);
  assert.equal(starts.length, 5);
  const span = starts[starts.length - 1] - starts[0];
  assert.ok(span >= GAP * 4 - 40, `5 次并发启动必须被拉开约 4×间隔，实际只用了 ${span}ms`);
  // 而且任意相邻两次都不能"贴脸"发出去
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= GAP - 20, `第 ${i} 与 ${i - 1} 次启动间隔不足：${starts[i] - starts[i - 1]}ms`);
  }
});

test('站点节流：只有按 IP 风控严格的平台才节流，其它站点直通', () => {
  const dy = gate.siteGateFor('https://v.douyin.com/abc/');
  assert.equal(dy.site, 'douyin');
  assert.ok(dy.minGapMs >= 1000, `抖音必须节流，实际 ${dy.minGapMs}ms`);

  for (const u of ['https://www.iesdouyin.com/share/video/1/', 'https://www.tiktok.com/@a/video/1']) {
    assert.ok(gate.siteGateFor(u).minGapMs >= 1000, `${u} 也应节流`);
  }
  assert.equal(gate.siteGateFor('https://www.youtube.com/watch?v=1').minGapMs, 0, 'YouTube 不该被拖慢');
  assert.equal(gate.siteGateFor('not-a-url').minGapMs, 0, '解析不了的地址直通');
});

test('站点节流：间隔可用环境变量调（部署时可放宽/收紧）', () => {
  process.env.YTDLP_SITE_GAP_MS = '5000';
  try {
    assert.equal(gate.siteGateFor('https://v.douyin.com/x/').minGapMs, 5000);
  } finally {
    delete process.env.YTDLP_SITE_GAP_MS;
  }
  assert.equal(gate.siteGateFor('https://v.douyin.com/x/').minGapMs, 20_000, '默认 20 秒');
});
