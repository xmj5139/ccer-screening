/**
 * 测试 127（docs/74 D）：统一检索跨实体、筛选/分页/总数、去重与 demo 排除、
 * 中文短词/空查询、注入与秘密不可检索、API 权限。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db, auth } = ctx;
const search = await import('../src/services/unified-search-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

console.log('\n[v2-127] 统一检索：跨实体、筛选、分页、去重与安全');

const KEY = '甲烷治理检索ZZZ';
const now = new Date().toISOString();

db.run(
  `INSERT INTO policy_document (id,policy_key,title,category,doc_status,publish_date,summary,official_url,body_snapshot,collected_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['POL-127', 'pol-127', `${KEY} 政策文件`, 'climate', 'effective', '2026-09-10', '政策摘要：甲烷治理。',
    'https://www.mee.gov.cn/policy/127.html', `政策原文包含 ${KEY} 与甲烷治理要求。`, now, now, now]
);
db.run(
  `INSERT INTO methodology_version (id,methodology_id,code_display,name,version,document_status,domain,release_date,effective_date,official_url,body_snapshot,catalog_confidence,is_candidate_eligible,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['MV-127', 'M-127', 'CCER-M-127', `${KEY} 方法学`, 'V01', 'formal', '煤矿瓦斯',
    '2026-10-20', '2026-11-01', 'https://www.mee.gov.cn/m/127.pdf', `方法学正文 ${KEY}。`,
    'verified_from_official_notice', 1, now, now]
);
db.run(
  `INSERT INTO public_project (id,registry_project_no,name,owner_name,province,city,domain,methodology_id,current_stage,official_url,last_checked_at,note,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['PP-127', 'R-127', `${KEY} 公开项目`, '示例业主', '内蒙古', '鄂尔多斯', '煤矿瓦斯', 'M-127',
    'project_registered', 'https://ccer.cets.org.cn/project/127', '2026-09-20',
    `项目说明 ${KEY}`, now, now]
);
// 同一官方登记编号的阶段行：检索必须按登记号去重，而不是把 2 行当 2 个项目。
db.run(
  `INSERT INTO public_project (id,registry_project_no,name,owner_name,province,city,domain,methodology_id,current_stage,official_url,last_checked_at,note,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['PP-127-DUP', 'R-127', `${KEY} 公开项目（阶段行）`, '示例业主', '内蒙古', '鄂尔多斯', '煤矿瓦斯', 'M-127',
    'reduction_public', 'https://ccer.cets.org.cn/project/127', '2026-09-21',
    `项目阶段说明 ${KEY}`, now, new Date(Date.now() + 1000).toISOString()]
);
const normal = content.upsertContent({
  source_url: 'https://example.test/search/127/normal',
  title: `${KEY} 公开研报`, publisher: '测试研究机构', source_category: 'institution',
  content_type: 'research_report', published_at: '2026-09-15',
  body_snapshot: `这是一篇关于 ${KEY} 的公开研报正文，用于统一检索测试。`.repeat(10),
}, { actor: 'test:127' });
content.upsertContent({
  source_url: 'https://example.test/search/127/demo',
  title: `${KEY} 演示条目`, publisher: '测试研究机构', content_type: 'research_report',
  published_at: '2026-09-15', is_demo: 1,
  body_snapshot: `演示内容 ${KEY}，不得进入检索结果。`.repeat(10),
}, { actor: 'test:127' });
content.upsertContent({
  source_url: 'https://example.test/search/127/duplicate',
  title: `${KEY} 转载副本`, publisher: '转载站', source_category: 'media',
  content_type: 'industry_news', published_at: '2026-09-16',
  body_snapshot: `这是一篇关于 ${KEY} 的公开研报正文，用于统一检索测试。`.repeat(10),
}, { actor: 'test:127' });
content.upsertContent({
  source_url: 'https://example.test/search/127/archive',
  title: `${KEY} 来源首页归档`, publisher: '测试研究机构', record_kind: 'source_homepage',
  body_snapshot: `首页归档 ${KEY}，不是文章。`.repeat(10),
}, { actor: 'test:127' });
content.upsertContent({
  source_url: 'https://example.test/search/127/unknown',
  title: `${KEY} 未知日期动态`, publisher: '测试研究机构', content_type: 'industry_news',
  published_at: null, body_snapshot: `未知发布日期 ${KEY}。`.repeat(10),
}, { actor: 'test:127' });
const failed = content.upsertContent({
  source_url: 'https://example.test/search/127/failed',
  title: `${KEY} 抓取失败条目`, publisher: '测试研究机构', content_type: 'industry_news',
  published_at: '2026-09-17', body_snapshot: `失败条目 ${KEY}。`.repeat(10),
}, { actor: 'test:127' });
db.run("UPDATE content_item SET process_status='failed_fetch' WHERE id=?", [failed.id]);
const xss = content.upsertContent({
  source_url: 'https://example.test/search/127/xss',
  title: `<script>alert(1)</script> ${KEY}`, publisher: '测试研究机构',
  content_type: 'industry_news', published_at: '2026-09-18',
  body_snapshot: `XSS 测试 ${KEY}。`.repeat(10),
}, { actor: 'test:127' });

db.run(
  `INSERT INTO cea_document (id,doc_key,doc_type,title,issuer,publish_date,official_url,body_snapshot,evidence_level,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ['CEADOC-127', 'cea-doc-127', 'policy', `${KEY} CEA 公开文件`, '生态环境部', '2026-09-12',
    'https://www.mee.gov.cn/cea/127.html', `CEA 文件正文 ${KEY}。`, 'full_text', now, now]
);
db.run(
  `INSERT INTO emission_factor
     (id,identity_key,source_identity,source_code,name,value,original_unit,gas,category,caliber,region,
      data_year,publish_date,version,locator,original_url,evidence_level,is_current,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['EF-127', 'ef-127', 'test-source:127', 'TEST-SRC', `${KEY} 排放因子`, 0.5, 'tCO2/MWh', 'CO2',
    'national_average', '测试口径', '全国', 2026, '2026-09-11', 'v1', '表 1', 'https://example.test/factor/127',
    'metadata_only', 1, now, now]
);
db.run(
  `INSERT INTO cea_entity (id,entity_key,name,credit_code,province,city,sector,list_year,status,source_url,data_as_of,verify_status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['ENT-127', 'credit:127', `${KEY} 重点排放单位`, '91150000127', '内蒙古', '鄂尔多斯', '发电',
    2026, 'existing', 'https://www.mee.gov.cn/entity/127.html', '2026-09-30', 'unverified', now, now]
);
// 秘密数据：检索不得返回
db.run(
  `INSERT INTO llm_provider (id,name,base_url,model,enabled,credential_ref,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?)`,
  ['LLM-127', 'secret-provider', 'https://example.test/llm', 'model-x', 0, 'SECRET-XYZ-127', now, now]
);
db.run(
  "INSERT INTO system_meta (key,value,updated_at) VALUES ('test_secret_127',?,?)",
  ['SECRET-XYZ-127', now]
);

test('中文关键词跨政策/方法学/项目/研报/CEA/因子/企业名录命中', () => {
  const out = search.searchUnified({ q: KEY, page_size: 20 });
  assertEqual(out.ok, true);
  const types = new Set(out.results.map((r) => r.type));
  for (const t of ['policy', 'methodology', 'project', 'content', 'cea_document', 'factor', 'entity']) {
    assert(types.has(t), `缺少类型 ${t}：${[...types].join('、')}`);
  }
  for (const r of out.results) {
    assert(r.entity_type && r.entity_id, '每条结果必须有实体类型与 ID');
    assert(r.title && r.type_label, '每条结果必须有标题与类型标签');
    assert(r.source, '每条结果必须有真实来源字段');
    assert('snippet' in r, '应提供摘要/匹配片段');
    assert(r.original_url === null || /^https?:\/\//.test(r.original_url), '原文链接必须是 http(s)');
    assert(r.locator, '应提供文件/段落定位');
    assert(!('password' in r) && !('credential_ref' in r), '不得泄露凭据字段');
  }
  const contentResults = out.results.filter((r) => r.type === 'content');
  assertEqual(contentResults.length, 3, `演示/转载/归档/失败条目应被排除，仅正常条目、未知日期条目与 XSS 条目保留；实际 ${contentResults.length}`);
});

test('demo、转载副本、导航归档、失败抓取不进入结果；XSS 标题以纯文本返回', () => {
  const out = search.searchUnified({ q: KEY, types: 'content', page_size: 50 });
  assertEqual(out.results.length, 3);  const titles = out.results.map((r) => r.title).join('｜');
  assert(!titles.includes('演示条目'), 'demo 必须排除');
  assert(!titles.includes('转载副本'), '已去重历史记录必须排除');
  assert(!titles.includes('来源首页归档'), '导航/来源归档必须排除');
  assert(!titles.includes('抓取失败条目'), '失败抓取必须排除');
  const x = out.results.find((r) => r.entity_id === xss.id);
  assert(x, '不含脚本的正常字段仍应可检索');
  assertIncludes(x.title, '<script>');
  assert(!x.snippet.includes('<img'), '片段不得注入 HTML（前端会统一转义）');
});

test('公开项目按登记编号去重、阶段中文化；日期口径分别标注', () => {
  const out = search.searchUnified({ q: KEY, types: 'project', page_size: 20 });
  assertEqual(out.results.length, 1, '同一登记号的两条阶段行只能算一个项目');
  assertEqual(out.total, 1);
  const p = out.results[0];
  assertEqual(p.entity_type, 'public_project');
  assertEqual(p.date_label, '最近核对日期');
  assert(p.status && !/^project_|^reduction_/.test(p.status), `项目阶段应中文化，实际 ${p.status}`);
  assert(['项目登记', '减排量公示'].includes(p.status), `阶段应来自真实枚举，实际 ${p.status}`);
  assertEqual(p.extra.stage_union, true);
  assertEqual(out.per_type.project.raw_match_count, 2, '原始阶段行数可审计');
  const meta = search.searchMeta();
  assertEqual(meta.types.find((t) => t.key === 'project').count, 1, '搜索类型统计也必须按登记号去重');
  const entity = search.searchUnified({ q: KEY, types: 'entity', page_size: 20 }).results[0];
  assertEqual(entity.date_label, '名录数据截至');
});

test('类型/来源/日期/地区筛选只作用于适用类型，不清空其它结果', () => {
  const onlyPolicy = search.searchUnified({ q: KEY, types: 'policy' });
  assertEqual(onlyPolicy.results.length, 1);
  assertEqual(onlyPolicy.results[0].type, 'policy');

  const dated = search.searchUnified({ q: KEY, from: '2026-09-01', to: '2026-09-30', page_size: 50 });
  assert(dated.results.every((r) => r.type !== 'methodology'), '方法学 10-20 在窗口外应排除');
  assert(dated.results.every((r) => r.type !== 'content' || r.date), '日期筛选下未知发布日期不参与');
  assert(dated.filter_notes.join('｜').includes('发布日期未披露'), '应说明未知发布日期被排除');

  const region = search.searchUnified({ q: KEY, region: '内蒙古', page_size: 50 });
  const regionTypes = new Set(region.results.map((r) => r.type));
  assert(regionTypes.has('project') && regionTypes.has('entity'), '地区筛选应保留项目与企业');
  assert(regionTypes.has('content'), '地区不适用的内容类型不得被静默清空');
  assert(region.filter_notes.join('｜').includes('地区筛选只作用于'), '应说明地区筛选的适用边界');

  const source = search.searchUnified({ q: KEY, source: '测试研究机构', page_size: 50 });
  assert(source.results.some((r) => r.type === 'content'), '来源筛选应命中测试研究机构');
  assert(source.filter_notes.join('｜').includes('来源筛选未应用'), '不适用来源筛选的类型应有说明');
});

test('分页与总数一致，相关度/日期排序稳定，短词与空查询可用', () => {
  const all = search.searchUnified({ q: KEY, page_size: 50 });
  const total = all.total;
  assert(total >= 8, `总数应包含多种实体，实际 ${total}`);
  const p1 = search.searchUnified({ q: KEY, page_size: 3, page: 1 });
  const p2 = search.searchUnified({ q: KEY, page_size: 3, page: 2 });
  assertEqual(p1.total, total, '不同页总数应一致');
  assertEqual(p2.total, total);
  assertEqual(p1.total_pages, Math.ceil(total / 3));
  const ids1 = p1.results.map((r) => `${r.entity_type}:${r.entity_id}`);
  const ids2 = p2.results.map((r) => `${r.entity_type}:${r.entity_id}`);
  assert(ids1.every((id) => !ids2.includes(id)), '分页结果不得重复');
  assert(p1.results.length + p2.results.length <= total);

  const byDate = search.searchUnified({ q: KEY, sort: 'date', page_size: 50 });
  const dates = byDate.results.map((r) => r.date || '').filter(Boolean);
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  assertEqual(dates.join(','), sorted.join(','), '日期排序应稳定新→旧');
  // 无日期结果放在有日期结果之后（稳定排序）
  const firstUndated = byDate.results.findIndex((r) => !r.date);
  if (firstUndated >= 0) assert(byDate.results.slice(firstUndated).every((r) => !r.date), '无日期结果不得夹在有日期结果之前');

  const short = search.searchUnified({ q: '碳', page_size: 5 });
  assert(short.ok && short.results.length > 0, '中文单字短词应可用');
  const empty = search.searchUnified({ q: '', page_size: 5 });
  assert(empty.ok && empty.empty_query === true, '空查询应为浏览模式');
  assert(empty.results.length > 0, '空查询应返回最近公开记录');
});

test('SQL 注入被参数化；秘密/配置/用户/审计不可检索', () => {
  const inj = search.searchUnified({ q: "' OR 1=1 --", page_size: 20 });
  assertEqual(inj.ok, true);
  assertEqual(inj.total, 0, '注入字符串不应扩大结果');
  assertEqual(db.get('SELECT COUNT(*) c FROM policy_document').c >= 1, true, '注入后公开表仍可读');
  for (const q of ['SECRET-XYZ-127', 'credential_ref', 'user_session', 'audit_log']) {
    const out = search.searchUnified({ q, page_size: 20 });
    assertEqual(out.total, 0, `秘密/内部对象不得被检索到：${q}`);
  }
  const meta = search.searchMeta();
  const labels = meta.types.map((t) => t.entity_type).join('｜');
  assert(!labels.includes('user') && !labels.includes('audit') && !labels.includes('provider'), '类型白名单不得包含内部实体');
});

await testAsync('HTTP API：普通用户可检索，后台治理/补采 403；响应可回到实体与原文', async () => {
  process.env.CCER_AUTH_MODE = 'session';
  const adminUser = db.get("SELECT * FROM app_user WHERE role='admin' AND active=1 LIMIT 1");
  let viewerUser = db.get("SELECT * FROM app_user WHERE role='viewer' AND active=1 LIMIT 1");
  if (!viewerUser) {
    db.run("INSERT INTO app_user (id,name,role,team_id,active) VALUES ('u-viewer-127','viewer-127','viewer','team-default',1)");
    viewerUser = db.get("SELECT * FROM app_user WHERE id='u-viewer-127'");
  }
  assert(adminUser, '测试库应有管理员');
  const adminToken = auth.createSession(adminUser.id, { actor: 'test:127' }).token;
  const viewerToken = auth.createSession(viewerUser.id, { actor: 'test:127' }).token;
  const { server } = await import('../src/server.mjs');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  try {
    const apiSearch = await call(`/api/v2/search?q=${encodeURIComponent(KEY)}&page_size=20`, viewerToken);
    assertEqual(apiSearch.status, 200);
    assertEqual(apiSearch.body.ok, true);
    assert(apiSearch.body.results.some((r) => r.entity_type === 'content_item' && r.entity_id === normal.id), 'API 应返回可核对的实体 ID');
    const meta = await call('/api/v2/search/meta', viewerToken);
    assertEqual(meta.status, 200);
    assert(meta.body.types.length >= 7);

    const denied = await call('/api/v2/admin/governance/pipeline', viewerToken);
    assertEqual(denied.status, 403, '普通用户不得访问治理后台');
    const deniedBackfill = await call('/api/v2/admin/backfill/sources', viewerToken);
    assertEqual(deniedBackfill.status, 403);
    const adminPipeline = await call('/api/v2/admin/governance/pipeline', adminToken);
    assertEqual(adminPipeline.status, 200);
    assert(Array.isArray(adminPipeline.body.funnel));
    const sources = await call('/api/v2/admin/backfill/sources', adminToken);
    assertEqual(sources.status, 200);
    assert(Array.isArray(sources.body.datasets));
  } finally {
    server.unref();
    await new Promise((r) => server.close(r));
  }
});

finish('test/127-v2-unified-search.test.mjs');
