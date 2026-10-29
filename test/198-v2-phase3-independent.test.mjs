/**
 * 测试 198（docs/86 第三阶段）：
 *   · 索引 dirty 队列/跨批清理/旋转游标/旧 ID 更新/覆盖层刷新/剩余 dirty 回退；
 *   · 显式语义扩展（真实 FTS 混合、原查询保留、筛选保留、精确编号不扩展、失败回退、限流）；
 *   · CEA 企业档案（同名跨地区不合并、异常信用代码、多行业多年度、别名/历史）；
 *   · 第三方行情候选（独立表、差异状态、非法日期/负数/NaN/无单位、stale、官方零改写、CSV 防公式）。
 * 只用 setupV2 临时库；不联网、不调用真实模型。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const index = await import('../src/services/search-index-svc.mjs');
const search = await import('../src/services/unified-search-svc.mjs');
const semantic = await import('../src/services/semantic-search-svc.mjs');
const cea = await import('../src/services/cea-svc.mjs');
const market = await import('../src/services/market-candidate-svc.mjs');
const exportSvc = await import('../src/services/export-svc.mjs');
const { V2_ROUTES } = await import('../src/routes-v2.mjs');

const now = new Date().toISOString();

function insertContent(id, { title, body, published = '2026-01-01' } = {}) {
  db.run(
    `INSERT INTO content_item
       (id,content_type,record_kind,title,publisher,published_at,discovered_at,source_url,url_hash,
        content_hash,source_category,authority_tier,body_availability,language,summary,body_snapshot,
        body_chars,process_status,is_demo,duplicate_of,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, 'industry_news', 'article', title, '测试机构', published, now,
      `https://example.test/198/${encodeURIComponent(id)}`, `hash-${id}`, `chash-${id}`,
      'media', 'media_report', 'full_text', 'zh', title, body, body.length,
      'fetched', 0, null, now, now,
    ]
  );
}

function insertEntity({
  id, name, credit = null, rawCredit = null, province = null, city = null,
  sector = null, year = 2025, sourceCode = 'TEST-198', sourceUrl = 'https://example.test/198/source',
}) {
  db.run(
    `INSERT INTO cea_entity
       (id,entity_key,name,credit_code,raw_credit_code,credit_code_valid,province,city,sector,
        list_year,status,source_url,source_code,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, credit || `name:${name}|${province || ''}|${city || ''}`, name, credit, rawCredit, credit ? 1 : (rawCredit ? 0 : null),
      province, city, sector, year, 'existing', sourceUrl, sourceCode, now, now]
  );
}

function insertMembership(id, entityId, sector, sourceCode = 'TEST-198') {
  db.run(
    `INSERT INTO cea_entity_membership
       (id,entity_id,source_code,sector,source_url,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id, entityId, sourceCode, sector, 'https://example.test/198/source', now, now]
  );
}

function handler(method, path) {
  const hit = V2_ROUTES.find(([m, p]) => m === method && p === path);
  assert(hit, `路由未注册：${method} ${path}`);
  return hit[2];
}
function routeCtx(user, { params = {}, body = {}, query = {} } = {}) {
  return { user, params, body, query, ip: null, req: { headers: {} } };
}

/* ------------------------------------------------------------------ */
/* 1. 索引 dirty / 跨批 / 游标                                         */
/* ------------------------------------------------------------------ */
for (let i = 0; i < 5; i += 1) {
  insertContent(`CI-198-BATCH-${i}`, {
    title: `批次旋转记录 ${i}`, body: `批次旋转记录 ${i} 的正文。`,
    published: `2026-01-0${i + 1}`,
  });
}

test('跨批构建末批清理按全量合法来源 ID，不删除前批索引', () => {
  const before = Number(db.get("SELECT COUNT(*) c FROM search_index_doc WHERE type='content'")?.c || 0);
  const b1 = index.buildSearchIndex({ types: ['content'], maxDocs: 2, offset: 0, actor: 'test:198' });
  assertEqual(b1.types.content.complete, false);
  const b2 = index.buildSearchIndex({ types: ['content'], maxDocs: 2, offset: 2, actor: 'test:198' });
  assertEqual(b2.types.content.complete, false);
  const b3 = index.buildSearchIndex({ types: ['content'], maxDocs: 2, offset: 4, actor: 'test:198' });
  assertEqual(b3.types.content.complete, true);
  const after = Number(db.get("SELECT COUNT(*) c FROM search_index_doc WHERE type='content'")?.c || 0);
  assertEqual(after, before + 5, '末批只看到 2 条，但清理必须保留前批 3 条');
  const ids = new Set(db.all("SELECT entity_id FROM search_index_doc WHERE type='content' AND entity_id LIKE 'CI-198-BATCH-%'").map((r) => r.entity_id));
  assertEqual(ids.size, 5);
});

test('日常旋转游标推进，旧 ID 更新可被刷新；不总是 offset=0', () => {
  index.buildSearchIndex({ types: ['content'], maxDocs: 2, rotate: true, actor: 'test:198' });
  const c1 = Number(index.indexMeta('cursor:content') || 0);
  index.buildSearchIndex({ types: ['content'], maxDocs: 2, rotate: true, actor: 'test:198' });
  const c2 = Number(index.indexMeta('cursor:content') || 0);
  assert(c2 !== c1 || c2 === 0, `旋转游标应变化或回环，实际 ${c1} -> ${c2}`);
});

/* ------------------------------------------------------------------ */
/* 2. 语义扩展检索                                                     */
/* ------------------------------------------------------------------ */
insertContent('CI-198-SEM-A', {
  title: '碳市场独有词甲', body: '碳市场独有词甲的正文，讨论配额。', published: '2026-05-01',
});
insertContent('CI-198-SEM-B', {
  title: '配额分配乙', body: '配额分配乙的正文，讨论免费分配。', published: '2019-05-01',
});
insertContent('CI-198-SEM-C', {
  title: '甲烷回收丙', body: '甲烷回收丙的正文。', published: '2026-05-02',
});
insertContent('CI-198-CODE', {
  title: '编号记录 CCER-10-001-V01', body: '编号记录 CCER-10-001-V01 的正文。', published: '2026-05-03',
});
index.buildSearchIndex({ maxDocs: 20000, actor: 'test:198' });

await testAsync('显式语义扩展：模型最多 4 词，原查询保留，FTS 合并真实命中', async () => {
  const out = await semantic.searchSemantic(
    { q: '碳市场独有词甲', types: 'content', page_size: 20 },
    {
      userId: 'U-198-SEM-A', actor: 'test:198',
      callModel: async () => ({ ok: true, parsed: { terms: ['配额分配', '甲烷回收', '无关扩展', '第四词', '第五词', '第六词'] } }),
    }
  );
  assertEqual(out.mode, 'semantic_expansion', JSON.stringify(out));
  assertEqual(out.expansion_terms.length, 4);
  assertEqual(out.expansion_terms[0], '配额分配');
  const ids = out.results.map((r) => r.entity_id);
  assert(ids.includes('CI-198-SEM-A'), '原查询命中必须保留');
  assert(ids.includes('CI-198-SEM-B'), '扩展词应合并 FTS 真实命中');
});

await testAsync('语义扩展不修改原类型/年度筛选；精确 CCER 编号不走模型', async () => {
  const filtered = await semantic.searchSemantic(
    { q: '碳市场独有词甲', types: 'content', from: '2026-01-01', to: '2026-12-31', page_size: 20 },
    {
      userId: 'U-198-SEM-B', actor: 'test:198',
      callModel: async () => ({ ok: true, parsed: { terms: ['配额分配'] } }),
    }
  );
  assertEqual(filtered.expansion_terms[0], '配额分配');
  assert(!filtered.results.some((r) => r.entity_id === 'CI-198-SEM-B'), '2019 记录不得越过 2026 年度筛选');
  assert(filtered.results.every((r) => r.type === 'content'), '类型筛选必须保留');

  let called = false;
  const exact = await semantic.searchSemantic(
    { q: 'CCER-10-001-V01', types: 'content', page_size: 20 },
    {
      userId: 'U-198-SEM-C', actor: 'test:198',
      callModel: async () => { called = true; return { ok: true, parsed: { terms: ['配额'] } }; },
    }
  );
  assertEqual(called, false, '精确编号不得调用模型');
  assertEqual(exact.mode, 'keyword');
  assertEqual(exact.expansion_terms.length, 0);
  assertEqual(exact.results[0]?.entity_id, 'CI-198-CODE');
});

await testAsync('模型失败/超时回退原关键词并标记 fallback，不伪造扩展词', async () => {
  const out = await semantic.searchSemantic(
    { q: '碳市场独有词甲', types: 'content', page_size: 20 },
    {
      userId: 'U-198-SEM-D', actor: 'test:198',
      callModel: async () => ({ ok: false, reason: 'timeout', detail: '模拟超时' }),
    }
  );
  assertEqual(out.mode, 'fallback');
  assertEqual(out.semantic_mode, 'fallback');
  assertEqual(out.expansion_terms.length, 0);
  assertEqual(out.expansion_fallback_reason, 'timeout');
  assert(out.results.some((r) => r.entity_id === 'CI-198-SEM-A'), '失败时必须返回原检索结果');
});

test('语义扩展配额：每分钟 4 次后拒绝，不调用模型', () => {
  const uid = 'U-198-QUOTA';
  for (let i = 0; i < 4; i += 1) {
    assertEqual(semantic.acquireExpansionQuota(uid).ok, true, `第 ${i + 1} 次应允许`);
  }
  const denied = semantic.acquireExpansionQuota(uid);
  assertEqual(denied.ok, false);
  assertEqual(denied.reason, 'rate_limited');
});

test('索引仍有剩余 dirty 时回退 legacy，不把旧 payload 当最新', () => {
  for (let i = 0; i < 30; i += 1) {
    db.run(
      `INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at) VALUES('content',?,?,?)`,
      [`CI-198-DIRTY-${i}`, 'test:198', new Date(Date.now() + i).toISOString()]
    );
  }
  const out = search.searchUnified({ q: '碳市场独有词甲', types: 'content', page_size: 10 });
  assertEqual(out.mode, 'legacy_fallback');
  assertEqual(out.fallback_reason, 'index_dirty');
  assert(out.filter_notes.join('｜').includes('回退'), '应说明剩余 dirty 已回退');
  index.buildSearchIndex({ maxDocs: 20000, actor: 'test:198' });
});

test('源表更新/管理覆盖层变化进入 dirty，查询有界刷新后可见新值', () => {
  db.run("UPDATE content_item SET title=?, body_snapshot=? WHERE id=?", [
    '旧ID更新后的标题NEW198', '旧ID更新后的正文NEW198。', 'CI-198-BATCH-0',
  ]);
  const hit = search.searchUnified({ q: 'NEW198', types: 'content', page_size: 10 });
  assertEqual(hit.mode, 'fts5', JSON.stringify({ mode: hit.mode, notes: hit.filter_notes }));
  assertEqual(hit.results[0]?.entity_id, 'CI-198-BATCH-0');

  db.run(
    `INSERT INTO admin_revision
       (id,entity_type,entity_id,field_key,value,original_value,revision_no,status,note,actor,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['REV-198', 'content_item', 'CI-198-SEM-A', 'title', '覆盖层标题OVERLAY198',
      '碳市场独有词甲', 1, 'active', '测试覆盖层', 'test:198', now]
  );
  const over = search.searchUnified({ q: 'OVERLAY198', types: 'content', page_size: 10 });
  assertEqual(over.mode, 'fts5');
  assertEqual(over.results[0]?.entity_id, 'CI-198-SEM-A');
  assertEqual(over.results[0]?.manual_revision, true);
});

/* ------------------------------------------------------------------ */
/* 3. CEA 企业档案                                                     */
/* ------------------------------------------------------------------ */
insertEntity({ id: 'ENT-198-HEBEI', name: '同名测试企业', province: '河北省', city: '石家庄市' });
insertEntity({ id: 'ENT-198-SHANXI', name: '同名测试企业', province: '山西省', city: '太原市' });
insertEntity({
  id: 'ENT-198-BADCODE', name: '异常代码企业', rawCredit: 'BAD-CODE-198', province: '江苏省', city: '南京市',
});
insertEntity({
  id: 'ENT-198-MULTI-2024', name: '多行业企业', credit: '91110000TEST0198001',
  province: '广东省', city: '广州市', sector: '钢铁', year: 2024,
});
insertEntity({
  id: 'ENT-198-MULTI-2025', name: '多行业企业', credit: '91110000TEST0198001',
  province: '广东省', city: '广州市', sector: '电力', year: 2025,
});
insertMembership('MEM-198-1', 'ENT-198-MULTI-2024', '钢铁');
insertMembership('MEM-198-2', 'ENT-198-MULTI-2025', '电力');
insertMembership('MEM-198-3', 'ENT-198-MULTI-2025', '钢铁');
db.run(
  `INSERT INTO cea_entity_alias(id,entity_id,alias,source_code,source_url,evidence_note,created_by,created_at)
   VALUES (?,?,?,?,?,?,?,?)`,
  ['ALIAS-198', 'ENT-198-MULTI-2025', '多行业企业（曾用名）', 'TEST-198',
    'https://example.test/198/alias', '来源明确写出的曾用名', 'test:198', now]
);

test('同名无代码跨地区不合并；异常代码留空保企业名', () => {
  const hebei = cea.getCeaEntityProfile('ENT-198-HEBEI');
  assertEqual(hebei.identity_basis.includes('名称 + 省份 + 城市'), true);
  assertEqual(hebei.years.length, 1);
  assertEqual(hebei.years[0].province, '河北省');
  assertEqual(hebei.aliases.some((a) => a.alias === '同名测试企业'), false, '当前名称不是别名');
  const shanxi = cea.getCeaEntityProfile('ENT-198-SHANXI');
  assertEqual(shanxi.years.length, 1);
  assertEqual(shanxi.years[0].province, '山西省');

  const bad = cea.getCeaEntityProfile('ENT-198-BADCODE');
  assertEqual(bad.entity.name, '异常代码企业');
  assertEqual(bad.entity.credit_code, null, '异常信用代码的标准代码必须留空');
  assertEqual(bad.entity.raw_credit_code, 'BAD-CODE-198');

  const created = cea.upsertCeaEntity({
    name: '异常代码写入企业', list_year: 2026, credit_code: 'NOT-A-VALID-CODE',
    province: '安徽省', city: '合肥市', source_code: 'TEST-198',
  });
  assertEqual(created.ok, true);
  const saved = db.get('SELECT name,credit_code,raw_credit_code,credit_code_valid FROM cea_entity WHERE id=?', [created.id]);
  assertEqual(saved.name, '异常代码写入企业');
  assertEqual(saved.credit_code, null, 'upsert 收到异常代码时标准字段必须留空');
  assertEqual(saved.raw_credit_code, 'NOT-A-VALID-CODE');
  assertEqual(saved.credit_code_valid, 0);
});

await testAsync('多行业多年度保留，历史名称/来源别名可审计', async () => {
  const p = cea.getCeaEntityProfile('ENT-198-MULTI-2025');
  assertEqual(p.years.length, 2, '同一信用代码跨年度应汇总');
  assertEqual(p.industry_relations.length, 2);
  const y2025 = p.industry_relations.find((x) => x.list_year === 2025);
  assert(y2025.sectors.includes('电力') && y2025.sectors.includes('钢铁'), '多行业不得互相覆盖');
  assert(p.aliases.some((a) => a.alias === '多行业企业（曾用名）' && a.kind === 'declared'));
  assert(p.sources.length >= 1);
  assertEqual(p.emissions, null, '不推造企业排放');
  const out = await handler('GET', '/api/v2/cea/entities/:id')(routeCtx({ id: 'U-198' }, { params: { id: 'ENT-198-MULTI-2025' } }));
  assertEqual(out.ok, true);
  assertEqual(out.profile_id, 'credit:91110000TEST0198001');
});

/* ------------------------------------------------------------------ */
/* 4. 第三方行情候选                                                   */
/* ------------------------------------------------------------------ */
db.run(
  `INSERT INTO cea_trade_daily
     (id,trade_date,instrument,market_scope,price_regime,total_volume,total_turnover,
      computed_avg_price,year_volume,year_turnover,source_url,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['TD-198', '2026-03-05', 'CEA', 'national', 'CEA_COMPOSITE_2026',
    1000, 80000, 80, 5000, 400000, 'https://example.test/198/official', now, now]
);
const csv = [
  'trade_date,instrument,unit,volume,turnover,avg_price,cumulative_volume,cumulative_turnover',
  '2026-03-05,CEA,tCO2e,1000,80000,80,5000,400000',
  '2026-03-05,CEA,tCO2e,2000,160000,80,5000,400000',
  '2019-12-31,CEA,tCO2e,100,8000,80,,',
  '2026-02-31,CEA,tCO2e,100,8000,80,,',
  '2026-03-04,CEA,tCO2e,-1,8000,80,,',
  '2026-03-04,CEA,,100,8000,80,,',
  '2026-03-04,CEA,tCO2e,NaN,8000,80,,',
].join('\n');

test('候选导入只写独立表；missing/conflict/match/unsupported 与 stale 保留，官方行情零改写', () => {
  const before = db.get('SELECT total_volume,total_turnover,computed_avg_price FROM cea_trade_daily WHERE id=?', ['TD-198']);
  const out = market.importMarketCandidates({
    user: { id: 'U-198-ADMIN', name: '管理员198', role: 'admin' },
    text: csv, format: 'csv', sourceName: '=evil第三方', sourceUrl: 'https://example.test/198/candidate',
    asOf: '2026-03-05', stale: true,
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.counts.match, 1);
  assertEqual(out.counts.conflict, 1);
  assertEqual(out.counts.missing, 1);
  assertEqual(out.counts.unsupported, 4);
  assertEqual(out.stale, true);
  const after = db.get('SELECT total_volume,total_turnover,computed_avg_price FROM cea_trade_daily WHERE id=?', ['TD-198']);
  assertEqual(JSON.stringify(after), JSON.stringify(before), '官方行情表必须零改写');
  const rows = market.listMarketCandidates({ importId: out.import_id });
  assert(rows.every((r) => r.stale === true));
  assert(rows.some((r) => r.diff_status === 'match'));
  assert(rows.some((r) => r.diff_status === 'conflict'));
  assert(rows.some((r) => r.diff_status === 'missing'));
  assert(rows.some((r) => r.diff_status === 'unsupported' && /日期|单位|正数|有限/.test(r.notes)));

  const csvOut = exportSvc.toCsv(market.marketCandidateExport({ importId: out.import_id }).columns,
    market.marketCandidateExport({ importId: out.import_id }).rows);
  assertIncludes(csvOut, "'=evil第三方", 'CSV 导出必须给公式前缀加引号防护');
});

test('viewer 无候选诊断/导入权限（服务层与路由均 403）', async () => {
  const out = market.importMarketCandidates({
    user: { id: 'U-198-VIEWER', name: '只读用户', role: 'viewer' },
    text: csv, format: 'csv', sourceName: '第三方',
  });
  assertEqual(out.status, 403);
  const denied = await handler('POST', '/api/v2/admin/market-candidates/import')(
    routeCtx({ id: 'U-198-VIEWER', role: 'viewer' }, { body: { text: csv, source_name: '第三方' } })
  );
  assertEqual(denied.status, 403);
  const anon = await handler('GET', '/api/v2/admin/market-candidates')(routeCtx(null));
  assertEqual(anon.status, 401);
});

finish('198-v2-phase3-independent.test.mjs');
