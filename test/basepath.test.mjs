/**
 * 子路径部署：basename 推导逻辑单元测试
 * 规则见 web/src/lib/basePath.ts（前端构建产物无法直接 import，这里按同一规则重写并校验关键用例）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP_ROUTES = ['tasks','history','dashboard','aria2','bt','files','settings','logs','report'];
const ROUTE_SET = new Set(APP_ROUTES);

function detectBasename(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 0) return '';
  const idx = segs.findIndex((s) => ROUTE_SET.has(s));
  if (idx === 0) return '';
  if (idx > 0) return `/${segs.slice(0, idx).join('/')}`;
  if (pathname.endsWith('/')) return `/${segs.join('/')}`;
  return '';
}

test('根路径部署：所有路由都不带前缀', () => {
  assert.equal(detectBasename('/'), '');
  assert.equal(detectBasename('/tasks'), '');
  assert.equal(detectBasename('/settings'), '');
  assert.equal(detectBasename('/logs'), '');
});

test('单层子路径（nginx /ttdownload）', () => {
  assert.equal(detectBasename('/ttdownload/'), '/ttdownload');
  assert.equal(detectBasename('/ttdownload/tasks'), '/ttdownload');
  assert.equal(detectBasename('/ttdownload/settings'), '/ttdownload');
  assert.equal(detectBasename('/ttdownload/logs'), '/ttdownload');
});

test('多层子路径（/apps/x/logs）', () => {
  assert.equal(detectBasename('/apps/x/logs'), '/apps/x');
  assert.equal(detectBasename('/apps/x/'), '/apps/x');
});

test('根路径下的未知地址仍然是 404（不会被误当成前缀）', () => {
  assert.equal(detectBasename('/foobar'), '');
  assert.equal(detectBasename('/some/unknown/page'), '');
});

test('basename 与前端路由清单保持一致（新增路由必须同步）', () => {
  // 与 web/src/lib/basePath.ts 的 APP_ROUTES 对齐；这里断言的是"路由清单非空且单段"
  assert.ok(APP_ROUTES.length >= 9);
  for (const r of APP_ROUTES) assert.equal(r.includes('/'), false, `路由 ${r} 应为单段`);
});

test('【血案回归】前端路由必须都是单段路径，且同步注册进 APP_ROUTES', () => {
  // 血案：新增了 /tasks/waiting 这种两段式路由 → index.html 用的是相对资源路径
  // （Vite base: './'，为兼容子路径部署）→ ./assets/*.js 被解析成 /tasks/assets/*.js
  // → 服务器 SPA 回退返回 index.html → "Expected a JavaScript module but got text/html"
  // → **直接刷新/收藏该页面就是白屏**（而且只有两段以上路径才会中招）。
  const appSrc = fs.readFileSync('web/src/App.tsx', 'utf8');
  const literals = [...appSrc.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
  const deep = literals.filter((p) => p !== '*' && p !== '/' && p.split('/').filter(Boolean).length > 1);
  assert.deepEqual(deep, [], `这些路由是两段式，会让相对资源路径解析错、刷新白屏：${deep.join(', ')}`);

  // 路由名必须都登记在 APP_ROUTES（子路径部署下靠它推导 basename，漏了会被当 404）
  const baseSrc = fs.readFileSync('web/src/lib/basePath.ts', 'utf8');
  for (const p of literals) {
    if (p === '*' || p === '/' || /\.(html?|txt|ico)$/i.test(p)) continue; // /index.html 是重定向，不是页面
    const name = p.replace(/^\//, '');
    assert.ok(baseSrc.includes(`'${name}'`), `路由 ${p} 未登记进 APP_ROUTES（子路径部署刷新会 404）`);
  }
  // 模板式路由（任务区三个子页）也必须是单段
  const templated = [...appSrc.matchAll(/path=\{`\/\$\{sub\}`\}/g)];
  assert.ok(templated.length >= 1, '任务区子页路由应存在');
  assert.match(appSrc, /\['tasks-waiting', 'tasks-publish', 'tasks-other'\]/, '任务区子页应为单段路径');
  for (const name of ['tasks-waiting', 'tasks-publish', 'tasks-other']) {
    assert.ok(baseSrc.includes(`'${name}'`), `${name} 必须登记进 APP_ROUTES`);
  }
});
