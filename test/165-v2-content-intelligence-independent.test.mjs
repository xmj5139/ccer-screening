// docs/86 第一阶段：清洗、实质变化、版本/附件/事件组、字段引句、重取/重处理。
// 全部使用 setupV2 临时库；模型与网络均用注入替身，不调用真实付费 API。
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const { db } = await setupV2({ withPublicDemo: false });
const clean = await import('../src/services/content-clean-svc.mjs');
const content = await import('../src/services/content-svc.mjs');
const field = await import('../src/services/field-evidence-svc.mjs');
const intel = await import('../src/services/content-intelligence-svc.mjs');
const rss = await import('../src/services/rss-discovery-svc.mjs');
const { V2_ROUTES } = await import('../src/routes-v2.mjs');

const admin = { id: 'u-admin', name: 'admin-test', role: 'admin' };
const viewer = { id: 'u-viewer', name: 'viewer', role: 'viewer' };

function cpSlice(text, start, end) {
  return Array.from(String(text || '')).slice(start, end).join('');
}

const FIELD_BODY = [
  '本方法学适用于广东省的煤矿瓦斯项目，方法学编号 CCER-10-001-V01。',
  '项目适用年度为2026年度，申请阈值不超过10000吨。',
  '发布日期：2026年1月2日。生效日期：2026年2月1日。',
  '这是用于独立测试的公开正文，逐字引句必须能在正文中定位，不能用改写或概括替代。',
].join('') + '公开信息正文用于测试字段定位与版本变化。'.repeat(12);

console.log('\n[v2-165] 公开信息智能化第一阶段');

await testAsync('规则清洗优先 article/main，移除脚本与导航，保留表格、实体和正文中的导航词', async () => {
  const html = `<html><head><title>测试</title><style>.x{color:red}</style><script>alert('bad')</script></head>
    <body><nav>首页 登录 注册 网站地图</nav><main><article>
      <h1>广东省煤矿瓦斯方法学</h1>
      <p>正文中的“首页”只是叙述，不是导航。A&amp;B &lt;不是标签&gt;。</p>
      <table><tr><th>年度</th><th>阈值</th></tr><tr><td>2026</td><td>10000 吨</td></tr></table>
      <p>最后一段公开正文，包含足够长度以便判定为文章。</p>
    </article></main><footer>版权所有 2026</footer><aside>广告</aside></body></html>`;
  const out = await clean.cleanContent({ rawHtml: html });
  assertEqual(out.extractor, 'deterministic_html');
  assertIncludes(out.text, '广东省煤矿瓦斯方法学');
  assertIncludes(out.text, 'A&B <不是标签>');
  assertIncludes(out.text, '2026\t10000 吨');
  assertIncludes(out.text, '正文中的“首页”只是叙述');
  assertNotIncludes(out.text, "alert('bad')");
  assertNotIncludes(out.text, '首页 登录 注册');
  assertNotIncludes(out.text, '版权所有');
  assertNotIncludes(out.text, '广告');
});

await testAsync('Trafilatura 未启用/不可用时回退规则清洗，并如实记录实际 parser', async () => {
  const html = '<article><p>这是一段足够长的公开正文，用于验证可选 worker 失败时的真实回退。</p></article>';
  const failed = await clean.cleanContent({
    rawHtml: html, preferTrafilatura: true,
    trafilaturaRunner: async () => ({ ok: false, reason: 'not_installed', message: 'trafilatura 未安装' }),
  });
  assertEqual(failed.extractor, 'deterministic_html');
  assertEqual(failed.status, 'fallback');
  assertIncludes(failed.note, 'not_installed');
  const ok = await clean.cleanContent({
    rawHtml: html, preferTrafilatura: true,
    trafilaturaRunner: async () => ({ ok: true, text: 'Trafilatura 提取正文。'.repeat(10), version: '1.99-test' }),
  });
  assertEqual(ok.extractor, 'trafilatura');
  assertEqual(ok.extractor_version, '1.99-test');
  assertEqual(ok.status, 'ok');
});

const item = content.upsertContent({
  content_type: 'industry_news',
  title: '公开测试：广东省煤矿瓦斯方法学信息',
  publisher: '示例公开机构',
  published_at: '2026-01-03',
  source_url: 'https://www.example.gov.cn/report/2026/001.html',
  source_category: 'official',
  body_availability: 'full_text',
  body_snapshot: FIELD_BODY,
  raw_html: `<article><p>${FIELD_BODY}</p></article>`,
  attachments: [{ url: 'https://www.example.gov.cn/files/a.pdf', file_name: 'a.pdf', file_type: 'pdf' }],
}, { actor: 'test:165' });

test('首次入库保存版本、附件、正文指纹与可定位的确定性字段', () => {
  const detail = content.getContentDetail(item.id);
  assertEqual(detail.versions.length, 1);
  assertEqual(detail.versions[0].change_kind, 'initial');
  assertEqual(detail.attachments.length, 1);
  assert(!!detail.item.body_fingerprint, '应保存正文指纹');
  assert(!!detail.item.substantive_fingerprint, '应保存实质指纹');
  assert(!!detail.item.attachment_fingerprint, '应保存附件指纹');
  assert(detail.extraction && detail.extraction.raw_hash, '应保存原始 HTML 哈希');
  assert(detail.fields.length >= 5, `应抽取到多个字段，实际 ${detail.fields.length}`);
  const keys = new Set(detail.fields.map((f) => f.field));
  for (const k of ['region', 'industry', 'year', 'methodology_code', 'threshold', 'publish_date', 'effective_date']) {
    assert(keys.has(k), `缺字段 ${k}`);
  }
  for (const f of detail.fields) {
    assertEqual(cpSlice(detail.item.body_snapshot, f.char_start, f.char_end), f.quote, `${f.field} 的码点区间必须与引句一致`);
    assertIncludes(detail.item.body_snapshot, f.quote, '引句必须是原文连续片段');
  }
  const region = detail.fields.find((f) => f.field === 'region' && f.value === '广东省');
  assert(region && region.method === 'deterministic_rule');
});

await testAsync('日期页脚变化不产生新版本、不重生成摘要；实质正文变化才保存 body_change', async () => {
  const footerChanged = `${FIELD_BODY}\n发布日期：2026-10-30`;
  const same = content.upsertContent({
    title: '公开测试：广东省煤矿瓦斯方法学信息',
    source_url: 'https://www.example.gov.cn/report/2026/001.html',
    body_snapshot: footerChanged,
    body_availability: 'full_text',
  }, { actor: 'test:165:footer' });
  assertEqual(same.action, 'unchanged');
  assertEqual(same.change_kind, 'none');
  assertEqual(db.get('SELECT COUNT(*) c FROM content_version WHERE content_item_id=?', [item.id]).c, 1,
    '仅页脚日期变化不得新增版本');

  const changed = `${FIELD_BODY}\n\n实质性新增：本段改变了项目适用条件，必须重新判断。`.repeat(3);
  const up = content.upsertContent({
    title: '公开测试：广东省煤矿瓦斯方法学信息（修订）',
    source_url: 'https://www.example.gov.cn/report/2026/001.html',
    body_snapshot: changed,
    body_availability: 'full_text',
  }, { actor: 'test:165:body' });
  assertEqual(up.action, 'updated');
  assertEqual(up.change_kind, 'body_change');
  const versions = content.getContentDetail(item.id).versions;
  assertEqual(versions.length, 2);
  assertEqual(versions[0].change_kind, 'body_change');
  const stale = db.get("SELECT COUNT(*) c FROM field_evidence WHERE entity_type='content_item' AND entity_id=? AND status='stale'", [item.id]).c;
  assert(stale > 0, '正文变化后旧字段证据应 stale');
  const stages = db.all("SELECT stage,status FROM processing_stage WHERE object_id=? AND stage IN ('summarized','verified')", [item.id]);
  assert(stages.every((s) => s.status === 'stale'), '摘要/核验应失效');
});

test('附件变化保存 attachment_change，不伪造正文版本或重生成摘要', () => {
  const bodyNow = content.getContentDetail(item.id).item.body_snapshot;
  const up = content.upsertContent({
    title: '公开测试：广东省煤矿瓦斯方法学信息（修订）',
    source_url: 'https://www.example.gov.cn/report/2026/001.html',
    body_snapshot: bodyNow,
    body_availability: 'full_text',
    attachments: [{ url: 'https://www.example.gov.cn/files/b.pdf', file_name: 'b.pdf', file_type: 'pdf' }],
  }, { actor: 'test:165:att' });
  assertEqual(up.action, 'updated');
  assertEqual(up.change_kind, 'attachment_change');
  const detail = content.getContentDetail(item.id);
  assertEqual(detail.versions[0].change_kind, 'attachment_change');
  assertEqual(detail.versions[0].body_fingerprint, detail.item.body_fingerprint, '附件变化不应改变正文指纹');
  assertEqual(detail.attachments.filter((a) => a.status === 'referenced').length, 1);
  assertEqual(detail.attachments.filter((a) => a.status === 'missing').length, 1);
});

test('同文不同 URL 保留独立来源记录并建立可解释事件组，不按标题相似合并', () => {
  const body = '同文不同 URL 的独立测试正文，内容哈希完全一致，但来源发布方与时间不同。'.repeat(10);
  const rep = content.upsertContent({
    title: '同一篇公开资料的原始来源', source_url: 'https://www.example.gov.cn/original/001.html',
    body_snapshot: body, body_availability: 'full_text', publisher: '原始机构',
    published_at: '2026-03-01',
  }, { actor: 'test:165:event' });
  const dup = content.upsertContent({
    title: '转载标题完全不同也不会按标题合并', source_url: 'https://www.example.org/reprint/001.html',
    body_snapshot: body, body_availability: 'full_text', publisher: '转载站',
    published_at: '2026-03-02',
  }, { actor: 'test:165:event' });
  assertEqual(dup.action, 'duplicate');
  assertEqual(dup.representative_id, rep.id);
  assert(db.get('SELECT id FROM content_item WHERE id=?', [dup.id]), '转载来源必须保留独立记录');
  const group = content.getContentDetail(rep.id).event_group;
  assert(group, '应建立事件组');
  assertEqual(group.members.length, 2);
  assertIncludes(group.match_basis, 'SHA-256');
  assert(group.members.every((m) => m.source_url && m.discovered_at));
  assert(group.members.some((m) => m.publisher === '原始机构'));
  assert(group.members.some((m) => m.publisher === '转载站'));
});

const now = new Date().toISOString();
db.run(
  `INSERT INTO llm_provider
     (id,name,provider_kind,base_url,model,enabled,use_content_verify,max_calls_per_day,created_at,updated_at)
   VALUES (?,?,?,?,?,1,1,100,?,?)`,
  ['provider-165', '本地字段抽取替身', 'ollama', 'http://127.0.0.1:9/v1/chat/completions', 'stub-model-165', now, now]
);

await testAsync('模型伪造/改写引句被拒绝，真实连续引句才写入 method=model', async () => {
  const body = content.getContentDetail(item.id).item.body_snapshot;
  const forged = await field.extractFieldsWithModel('content_item', item.id, {
    callModel: async () => ({ ok: true, parsed: { fields: [{ field: 'region', value: '广东省', quote: '这是模型伪造的引句，不在原文中' }] } }),
    force: true, actor: 'test:165:model',
  });
  assertEqual(forged.ok, false);
  assert(forged.rejected >= 1);
  assertEqual(db.get("SELECT COUNT(*) c FROM field_evidence WHERE entity_id=? AND method='model' AND status='valid'", [item.id]).c, 0,
    '无法定位的模型引句不得成为有效证据');

  const signature = '生态环境部办公厅\n国家能源局综合司\n2024年12月31日';
  const wrongDate = field.upsertFieldEvidence({
    entityType: 'content_item', entityId: item.id, bodyHash: 'semantic-test',
    fieldKey: 'publish_date', fieldValue: '2024-12-31', valueType: 'date',
    quote: '2024年12月31日', text: signature, method: 'model', model: 'stub', actor: 'test:165:model',
  });
  assertEqual(wrongDate.ok, false);
  assertIncludes(wrongDate.error, '标签');
  const noUnit = field.upsertFieldEvidence({
    entityType: 'content_item', entityId: item.id, bodyHash: 'semantic-test',
    fieldKey: 'threshold', fieldValue: '8 吨', valueType: 'number',
    quote: '甲烷体积浓度低于8%', text: '甲烷体积浓度低于8%', method: 'model', model: 'stub', actor: 'test:165:model',
  });
  assertEqual(noUnit.ok, false);
  assertIncludes(noUnit.error, '单位');
  const wrongDir = field.upsertFieldEvidence({
    entityType: 'content_item', entityId: item.id, bodyHash: 'semantic-test',
    fieldKey: 'threshold', fieldValue: '高于8%', valueType: 'number',
    quote: '甲烷体积浓度低于8%', text: '甲烷体积浓度低于8%', method: 'model', model: 'stub', actor: 'test:165:model',
  });
  assertEqual(wrongDir.ok, false);
  assertIncludes(wrongDir.error, '方向');

  const quote = '本方法学适用于广东省的煤矿瓦斯项目，方法学编号 CCER-10-001-V01。';
  assertIncludes(body, quote);
  const good = await field.extractFieldsWithModel('content_item', item.id, {
    callModel: async () => ({ ok: true, parsed: { fields: [{ field: 'region', value: '广东省', quote }] } }),
    force: true, actor: 'test:165:model',
  });
  assertEqual(good.ok, true, JSON.stringify(good));
  assertEqual(good.accepted, 1);
  const detail = content.getContentDetail(item.id);
  const modelField = detail.fields.find((f) => f.method === 'model');
  assert(modelField);
  assertEqual(modelField.model, 'stub-model-165');
  assertEqual(cpSlice(detail.item.body_snapshot, modelField.char_start, modelField.char_end), modelField.quote);
});

await testAsync('单条重取走真实受控抓取接口（替身）：正文变化保存版本，列表页拒绝覆盖', async () => {
  const target = content.upsertContent({
    title: '待重取的公开条目', source_url: 'https://www.example.gov.cn/refetch/001.html',
    body_snapshot: '旧版正文，足够长以形成可比较的版本，且不包含特殊结构。'.repeat(8),
    body_availability: 'partial', content_type: 'industry_news',
  }, { actor: 'test:165:refetch' });
  const fakeConn = { id: 'fake-fetch-165', name: '测试抓取连接', enabled: 1 };
  const newBody = '重取后的新版正文，包含广东省与2026年度，并新增公开附件。'.repeat(8);
  const out = await intel.refetchContentItem(target.id, {
    connection: fakeConn, actor: 'test:165:refetch',
    fetcher: async () => ({
      ok: true, content: newBody, chars: newBody.length,
      raw_html: `<article><p>${newBody}</p><a href="/files/new.pdf">附件</a></article>`,
      availability: null,
    }),
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.action, 'updated');
  assertEqual(out.change_kind, 'body_change');
  assertEqual(out.extractor, 'deterministic_html');
  const detail = content.getContentDetail(target.id);
  assertEqual(detail.item.body_availability, 'full_text');
  assertEqual(detail.versions.length, 2);
  assert(detail.attachments.some((a) => a.file_name === '附件'), '应记录重取页面上的附件');

  const beforeCount = content.getContentDetail(target.id).versions.length;
  const listPage = Array.from({ length: 18 }, (_, i) => `栏目导航 ${i}`).join('<br>');
  const rejected = await intel.refetchContentItem(target.id, {
    connection: fakeConn, actor: 'test:165:refetch',
    fetcher: async () => ({ ok: true, content: listPage, raw_html: `<article>${listPage}</article>`, chars: listPage.length }),
  });
  assertEqual(rejected.status, 422);
  assertEqual(rejected.reason, 'not_article');
  assertEqual(content.getContentDetail(target.id).versions.length, beforeCount, '列表页不得覆盖已有文章');
});

await testAsync('collection 租约忙时拒绝单条重取；离线重处理可切换 Trafilatura 并如实记录', async () => {
  const target = content.upsertContent({
    title: '离线重处理测试条目', source_url: 'https://www.example.gov.cn/reprocess/001.html',
    body_snapshot: '离线重处理旧正文。'.repeat(20), body_availability: 'full_text',
    raw_html: `<article><p>${'离线重处理旧正文。'.repeat(20)}</p></article>`,
  }, { actor: 'test:165:reprocess' });
  const { acquireLease, releaseLease } = await import('../src/services/governance-svc.mjs');
  const lease = acquireLease({ key: 'collection', owner: 'test-holder', purpose: 'test', ttlMs: 60000 });
  assertEqual(lease.ok, true);
  const busy = await intel.refetchContentItem(target.id, {
    connection: { id: 'fake', name: 'fake', enabled: 1 },
    fetcher: async () => ({ ok: true, content: '不会执行' }),
  });
  assertEqual(busy.status, 409);
  releaseLease({ key: 'collection', owner: 'test-holder' });

  const rep = await intel.reprocessContentItem(target.id, {
    actor: 'test:165:reprocess',
    trafilaturaRunner: async () => ({ ok: true, text: 'Trafilatura 离线重处理正文。'.repeat(10), version: '1.99-test' }),
  });
  assertEqual(rep.ok, true, JSON.stringify(rep));
  assertEqual(rep.extractor, 'trafilatura');
  assertEqual(rep.extractor_version, '1.99-test');
  const extractions = intel.listExtractions(target.id, 5);
  assert(extractions.some((e) => e.extractor === 'trafilatura' && e.status === 'ok'));
});

test('RSS 解析拒绝 DOCTYPE/ENTITY（XXE），并提供候选元数据', () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&xxe;</title><link>https://example.com/a</link></item></channel></rss>`;
  const bad = rss.parseFeed(xxe);
  assertEqual(bad.ok, false);
  assertEqual(bad.reason, 'xxe_blocked');

  const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>公开测试订阅</title>
    <item><title><![CDATA[广东省 CCER 方法学动态]]></title>
      <link>https://www.example.gov.cn/news/2026/01/001.html</link>
      <pubDate>Fri, 02 Jan 2026 08:00:00 +0800</pubDate>
      <description><![CDATA[<p>订阅摘要 &amp; 不是全文</p>]]></description></item>
    <item><title>重复链接</title><link>https://www.example.gov.cn/news/2026/01/001.html</link></item>
  </channel></rss>`;
  const parsed = rss.parseFeed(feed, { feedUrl: 'https://www.example.gov.cn/rss.xml' });
  assertEqual(parsed.ok, true);
  assertEqual(parsed.format, 'rss');
  assertEqual(parsed.items.length, 1, '同一订阅内 URL 去重');
  assertEqual(parsed.items[0].published_at, '2026-01-02');
  assertIncludes(parsed.items[0].summary, '订阅摘要 & 不是全文');
});

await testAsync('RSS 来源拒绝内网/字面 IP；URL 幂等发现；每日任务有界且候选摘要不冒充全文', async () => {
  const blocked = rss.saveRssSource(admin, { name: '内网', url: 'http://127.0.0.1/feed.xml' });
  assertEqual(blocked.status, 400);
  const blockedIp = rss.saveRssSource(admin, { name: 'IP', url: 'http://8.8.8.8/feed.xml' });
  assertEqual(blockedIp.status, 400);

  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>测试</title>
    <item><title>RSS 候选一</title><link>https://www.example.gov.cn/news/2026/02/001.html</link>
      <pubDate>Mon, 02 Feb 2026 08:00:00 +0800</pubDate><description>订阅摘要，不是全文。</description></item>
  </channel></rss>`;
  const saved = rss.saveRssSource(admin, { name: '公开测试 RSS', url: 'https://www.example.gov.cn/feed.xml', enabled: true });
  assertEqual(saved.ok, true, JSON.stringify(saved));
  const sourceId = saved.source.id;
  const tested = await rss.testRssSource(admin, sourceId, { fetcher: async () => feed });
  assertEqual(tested.ok, true);
  assertEqual(tested.items, 1);

  const src = rss.listRssSources().find((s) => s.id === sourceId);
  const first = await rss.discoverRssSource({ ...src, enabled: 1 }, { fetcher: async () => feed, actor: 'test:165:rss' });
  assertEqual(first.ok, true);
  assertEqual(first.inserted, 1);
  const second = await rss.discoverRssSource({ ...src, enabled: 1 }, { fetcher: async () => feed, actor: 'test:165:rss' });
  assertEqual(second.inserted, 0);
  assertEqual(second.existing, 1, '同 URL 第二次必须是 existing');
  const rows = db.all('SELECT * FROM content_item WHERE source_url=?', ['https://www.example.gov.cn/news/2026/02/001.html']);
  assertEqual(rows.length, 1, '按 URL 幂等');
  assertEqual(rows[0].body_availability, 'metadata_only', '订阅摘要不得冒充全文');
  assertEqual(rows[0].body_snapshot, null);
  assertIncludes(rows[0].note, '订阅摘要不是全文');

  const daily = await rss.runRssDaily({
    actor: 'test:165:rss', maxSources: 1, maxItems: 5, maxFetch: 0,
    fetcher: async () => feed,
  });
  assertEqual(daily.ok, true, JSON.stringify(daily));
  assertEqual(daily.sources, 1);
  assertEqual(daily.body_fetched, 0);
  const cursor = db.get("SELECT * FROM dataset_cursor WHERE dataset='rss_discovery'");
  assert(cursor, '每日 RSS 任务应写入真实游标');
  assertIncludes(cursor.note, '有界');
});

await testAsync('后台接口对 viewer 返回 403（服务端角色守卫，不依赖前端隐藏）', async () => {
  const route = V2_ROUTES.find(([m, p]) => m === 'GET' && p === '/api/v2/admin/rss-sources');
  assert(route, '应注册 RSS 管理路由');
  const out = await route[2]({ user: viewer, query: {}, params: {}, body: {}, req: { headers: {} } });
  assertEqual(out.status, 403);
  const anon = await route[2]({ user: null, query: {}, params: {}, body: {}, req: { headers: {} } });
  assertEqual(anon.status, 401);
  const fieldsRoute = V2_ROUTES.find(([m, p]) => m === 'GET' && p === '/api/v2/content/:id/fields');
  assert(fieldsRoute, '应注册普通用户字段证据路由');
  const fields = await fieldsRoute[2]({ user: viewer, query: {}, params: { id: item.id }, body: {}, req: { headers: {} } });
  assert(fields.fields.length > 0, '普通登录用户只读字段证据');
});

finish('165-v2-content-intelligence-independent.test.mjs');
