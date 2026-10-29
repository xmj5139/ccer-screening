// docs/86 第一阶段路由接线：普通字段只读、后台权限、RSS 管理真实响应。
// 临时库；直接调用路由处理器（不启动服务、不联网、不调用模型）。
import {
  setupV2, testAsync, assert, assertEqual, finish,
} from './v2-helpers.mjs';

const { db } = await setupV2({ withPublicDemo: false });
const content = await import('../src/services/content-svc.mjs');
const { V2_ROUTES } = await import('../src/routes-v2.mjs');
db.run('UPDATE llm_provider SET enabled=0');

const admin = { id: 'user-admin', name: '系统管理员', role: 'admin' };
const viewer = { id: 'user-other', name: '其他用户', role: 'viewer' };

function handler(method, path) {
  const hit = V2_ROUTES.find(([m, p]) => m === method && p === path);
  assert(hit, `路由未注册：${method} ${path}`);
  return hit[2];
}

function ctx(user, { params = {}, body = {}, query = {} } = {}) {
  return { user, params, body, query, ip: null, req: { headers: {} } };
}

const item = content.upsertContent({
  title: '路由字段证据测试', source_url: 'https://www.example.gov.cn/route/001.html',
  body_snapshot: '本方法学适用于广东省，方法学编号 CCER-10-001-V01。发布日期：2026年1月2日。'.repeat(3),
  body_availability: 'full_text', content_type: 'industry_news',
}, { actor: 'test:166' });

await testAsync('普通用户可只读字段证据，但后台模型抽取与 RSS 管理一律 403', async () => {
  const fields = await handler('GET', '/api/v2/content/:id/fields')(ctx(viewer, { params: { id: item.id } }));
  assert(fields.fields.length > 0);
  const extract = await handler('POST', '/api/v2/admin/content/:id/extract-fields')(
    ctx(viewer, { params: { id: item.id }, body: { mode: 'model' } })
  );
  assertEqual(extract.status, 403);
  const rssList = await handler('GET', '/api/v2/admin/rss-sources')(ctx(viewer));
  assertEqual(rssList.status, 403);
  const anon = await handler('GET', '/api/v2/admin/rss-sources')(ctx(null));
  assertEqual(anon.status, 401);
});

await testAsync('管理员保存 RSS 来源：拒绝内网，合法地址落库；默认停用不进入每日任务', async () => {
  const before = await handler('GET', '/api/v2/admin/rss-sources')(ctx(admin));
  assertEqual(before.status, undefined);
  assert(Array.isArray(before.sources));
  assertEqual(before.limits.max_sources_per_run, 5);

  const blocked = await handler('POST', '/api/v2/admin/rss-sources')(
    ctx(admin, { body: { name: '内网地址', url: 'http://127.0.0.1/feed.xml' } })
  );
  assertEqual(blocked.status, 400);
  assert(!db.get('SELECT id FROM rss_source WHERE name=?', ['内网地址']));

  const saved = await handler('POST', '/api/v2/admin/rss-sources')(
    ctx(admin, { body: { name: '路由测试公开 RSS', url: 'https://www.example.gov.cn/route-feed.xml', enabled: false } })
  );
  assertEqual(saved.ok, true, JSON.stringify(saved));
  assertEqual(saved.source.enabled, false);
  const live = db.get('SELECT * FROM rss_source WHERE id=?', [saved.source.id]);
  assertEqual(live.enabled, 0);
});

await testAsync('模型字段抽取无可用模型时返回明确原因，不伪造成功', async () => {
  const out = await handler('POST', '/api/v2/admin/content/:id/extract-fields')(
    ctx(admin, { params: { id: item.id }, body: { mode: 'model' } })
  );
  assertEqual(out.status, 400);
  assertEqual(out.body.reason, 'no_provider');
  assertEqual(out.body.ok, false);
});

finish('166-v2-intelligence-http.test.mjs');
