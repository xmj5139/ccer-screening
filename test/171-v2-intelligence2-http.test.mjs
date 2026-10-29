/**
 * 测试 171（docs/86 第二阶段路由接线）：
 *   · 关注规则/信息流/已读只允许当前用户；跨用户规则更新仍 403；
 *   · 全文索引重建与 PDF 表格解析是后台写动作，viewer 403、匿名 401；
 *   · 后台可读取索引状态、PDF worker 状态与候选，但普通用户不能触发解析。
 * 临时库；直接调用路由处理器，不启动服务、不联网。
 */
import {
  setupV2, testAsync, assert, assertEqual, finish,
} from './v2-helpers.mjs';

const { db } = await setupV2({ withPublicDemo: false });
const content = await import('../src/services/content-svc.mjs');
const { V2_ROUTES } = await import('../src/routes-v2.mjs');

const admin = { id: 'U-171-ADMIN', name: '管理员171', role: 'admin' };
const userA = { id: 'U-171-A', name: '用户A171', role: 'viewer' };
const userB = { id: 'U-171-B', name: '用户B171', role: 'viewer' };
for (const u of [admin, userA, userB]) {
  db.run(
    'INSERT OR IGNORE INTO app_user (id,name,role,team_id,active) VALUES (?,?,?,?,1)',
    [u.id, u.name, u.role, 'T-171']
  );
}

function handler(method, path) {
  const hit = V2_ROUTES.find(([m, p]) => m === method && p === path);
  assert(hit, `路由未注册：${method} ${path}`);
  return hit[2];
}

function ctx(user, { params = {}, body = {}, query = {} } = {}) {
  return { user, params, body, query, ip: null, req: { headers: {} } };
}

const item = content.upsertContent({
  source_url: 'https://example.test/171/follow',
  title: '171 瓦斯关注路由测试',
  publisher: '测试机构',
  content_type: 'industry_news',
  body_snapshot: '瓦斯关注路由测试正文，包含内蒙古与钢铁。'.repeat(6),
}, { actor: 'test:171' });

let ruleA;
await testAsync('关注路由：viewer 可建自己的规则/读信息流/标记已读；跨用户更新 403', async () => {
  const anon = await handler('GET', '/api/v2/follow/rules')(ctx(null));
  assertEqual(anon.status, 401);
  const created = await handler('POST', '/api/v2/follow/rules')(
    ctx(userA, { body: { name: '路由关注', keywords: ['瓦斯'] } })
  );
  assertEqual(created.ok, true, JSON.stringify(created));
  ruleA = created.rule;
  const feed = await handler('GET', '/api/v2/follow/feed')(ctx(userA, { query: { limit: '10' } }));
  assertEqual(feed.ok, true);
  assert(feed.items.some((x) => x.content_item_id === item.id), '信息流应命中测试条目');
  const read = await handler('POST', '/api/v2/follow/read')(
    ctx(userA, { body: { content_id: item.id } })
  );
  assertEqual(read.ok, true);
  const after = await handler('GET', '/api/v2/follow/feed')(ctx(userA, { query: { limit: '10' } }));
  assertEqual(after.items[0].unread, false);

  const hijack = await handler('POST', '/api/v2/follow/rules')(
    ctx(userB, { body: { id: ruleA.id, name: '劫持', keywords: ['污水'] } })
  );
  assertEqual(hijack.status, 403);
  const del = await handler('DELETE', '/api/v2/follow/rules/:id')(
    ctx(userB, { params: { id: ruleA.id } })
  );
  assertEqual(del.status, 403);
});

await testAsync('全文索引：viewer 403、匿名 401，管理员可读状态并做有限批重建', async () => {
  const anon = await handler('GET', '/api/v2/admin/search-index')(ctx(null));
  assertEqual(anon.status, 401);
  const denied = await handler('GET', '/api/v2/admin/search-index')(ctx(userA));
  assertEqual(denied.status, 403);
  const status = await handler('GET', '/api/v2/admin/search-index')(ctx(admin));
  assertEqual(status.ok, true);
  assert(status.status && typeof status.status.ready === 'boolean');
  const rebuild = await handler('POST', '/api/v2/admin/search-index/rebuild')(
    ctx(admin, { body: { types: ['content'], max_docs: 20 } })
  );
  assertEqual(rebuild.ok, true, JSON.stringify(rebuild));
  assert(rebuild.indexed >= 1);
  assert(rebuild.status && rebuild.status.doc_count >= 1);
});

await testAsync('PDF 表格：普通用户不能触发写动作；管理员可读 worker 状态与候选', async () => {
  const anon = await handler('POST', '/api/v2/admin/pdf-tables/run')(ctx(null, { body: {} }));
  assertEqual(anon.status, 401);
  const denied = await handler('POST', '/api/v2/admin/pdf-tables/run')(
    ctx(userA, { body: { path: 'anything.pdf' } })
  );
  assertEqual(denied.status, 403);
  const status = await handler('GET', '/api/v2/admin/pdf-tables')(ctx(admin));
  assertEqual(status.ok, true);
  assertEqual(status.worker.parser, 'pdfplumber');
  assert(status.worker.limits.concurrency === 1);
  const candidates = await handler('GET', '/api/v2/admin/pdf-tables/candidates')(ctx(admin));
  assertEqual(candidates.ok, true);
  assert(Array.isArray(candidates.candidates));
  const deniedRun = await handler('POST', '/api/v2/admin/pdf-tables/run')(
    ctx(admin, { body: { path: 'C:\\Windows\\win.ini' } })
  );
  assertEqual(deniedRun.status, 403, '任意路径必须被服务层拒绝');
});

finish('171-v2-intelligence2-http.test.mjs');
