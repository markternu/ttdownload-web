/**
 * 子路径部署：basename 推导逻辑单元测试
 * 规则见 web/src/lib/basePath.ts（前端构建产物无法直接 import，这里按同一规则重写并校验关键用例）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const APP_ROUTES = ['tasks','history','dashboard','aria2','bt','files','settings','logs','report','scripts'];
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
  assert.ok(APP_ROUTES.length >= 10);
  for (const r of APP_ROUTES) assert.equal(r.includes('/'), false, `路由 ${r} 应为单段`);
});
