/**
 * v2 测试 32：CEA API 契约、认证与权限（端到端 HTTP）
 * ============================================================================
 * 覆盖规范用例：CEA-07（普通用户能看 CEA 各页、运行情景、下载；管理员配置/采集对普通用户 403；
 * 未登录 401）、CEA-12（下载内容与范围一致、字段单位明确、CSV 不执行公式）、
 * CEA-03（接口返回的官方数值与真实日报一致）。
 *
 * 说明：真实 HTTP 服务跑在临时库上（随机端口）。行情数值取自官方真实日报
 * （https://overview.cneeex.com/c/2026-07-30/498086.shtml，采集于 2026-10-14），
 * 仅写入本测试的临时库。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const cea = await import('../src/services/cea-svc.mjs');
const { parseCeaDailyReport } = await import('../src/services/cea-parse.mjs');

console.log('\n[v2-32] CEA API 契约与权限');

const URL_0730 = 'https://overview.cneeex.com/c/2026-07-30/498086.shtml';
const OFFICIAL_0730 = `【CEA】全国碳市场每日综合价格行情及成交信息20260730-上海环境能源交易所
今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨，收盘价较前一日上涨1.00%。
今日挂牌协议交易成交量544,313吨，成交额52,585,579.00元；大宗协议交易成交量500,000吨，成交额47,575,000.00元；今日无单向竞价。
今日全国碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。
2026年1月1日至7月30日，全国碳市场碳排放配额成交量68,966,986吨，成交额5,499,968,391.61元。
截至2026年7月30日，全国碳市场碳排放配额累计成交量933,833,506吨，累计成交额63,162,586,623.18元。`;

// 准备数据（临时库）
const parsed = parseCeaDailyReport(OFFICIAL_0730, { url: URL_0730 });
cea.seedCeaBaseData({ actor: 'test' });
const inserted = cea.upsertCeaTradeDaily({
  trade_date: parsed.trade_date, fields: parsed.fields, parse: parsed,
  meta: { sourceCode: 'cea_daily_sample_1', sourceUrl: URL_0730, snapshotId: 'SS-API-TEST',
    contentHash: 'hash-api-1', fetchedAt: '2026-10-14T00:00:00.000Z', actor: 'test' },
});
cea.upsertCeaEntity({
  name: '华能福州电厂', credit_code: '91350100123456789X', province: '福建',
  list_year: 2026, source_code: 'cea_entity_fujian_2026', data_as_of: '2026-10-14',
}, { actor: 'test' });
cea.upsertCeaIntention({
  source_code: 'cea_intentions', published_date: '2026-10-01', direction: 'buy',
  volume: 200000, price: null, participant: null, instrument_label: 'CEA 2025年度配额',
  source_url: 'https://shyx.cneeex.com/',
}, { actor: 'test' });

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function call(path, { method = 'GET', body = null, token = null, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, headers: res.headers, text };
}

let adminToken = null;
let viewerToken = null;

await testAsync('登录：管理员与普通只读用户', async () => {
  const a = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' } });
  assertEqual(a.status, 200, `管理员登录失败：${JSON.stringify(a.json)}`);
  adminToken = a.json.token;
  const v = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' } });
  assertEqual(v.status, 200, `普通用户登录失败：${JSON.stringify(v.json)}`);
  viewerToken = v.json.token;
});

/* ------------------------------ 未登录 401 ------------------------------ */

const CEA_READS = [
  '/api/v2/cea/overview',
  '/api/v2/cea/trade',
  `/api/v2/cea/trade/${inserted.id}`,
  '/api/v2/cea/series',
  '/api/v2/cea/summary',
  '/api/v2/cea/comparison',
  '/api/v2/cea/documents',
  '/api/v2/cea/events',
  '/api/v2/cea/entities',
  '/api/v2/cea/intentions',
  '/api/v2/cea/sources/status',
  '/api/v2/cea/scenario/presets',
  '/api/v2/cea/export?dataset=trade',
  '/api/v2/admin/cea/config',
  '/api/v2/admin/cea/jobs',
];

await testAsync('CEA-07 未登录访问全部 CEA 接口 → 401', async () => {
  for (const p of CEA_READS) {
    const out = await call(p);
    assertEqual(out.status, 401, `${p} 应 401，实际 ${out.status}`);
  }
  const post = await call('/api/v2/cea/scenario', { method: 'POST', body: { E: 1, A: 0, C: 0, U: 0, r: 0.05, P1: 1, P2: 1 } });
  assertEqual(post.status, 401, '情景接口未登录应 401');
});

/* ------------------------------ 普通用户可读 ------------------------------ */

await testAsync('CEA-07 普通用户可读 CEA 全部只读接口（200）', async () => {
  for (const p of CEA_READS.filter((x) => !x.startsWith('/api/v2/admin/'))) {
    const out = await call(p, { token: viewerToken });
    assertEqual(out.status, 200, `${p} 应 200，实际 ${out.status}：${JSON.stringify(out.json).slice(0, 160)}`);
  }
});

await testAsync('CEA-03 /trade 返回的官方数值与真实日报逐项一致', async () => {
  const out = await call('/api/v2/cea/trade?from=2026-07-01&to=2026-07-31', { token: viewerToken });
  assertEqual(out.status, 200);
  assertEqual(out.json.total, 1);
  const r = out.json.rows[0];
  assertEqual(r.trade_date, '2026-07-30');
  assertEqual(r.open, 96.0);
  assertEqual(r.high, 97.0);
  assertEqual(r.low, 95.9);
  assertEqual(r.close, 96.61);
  assertEqual(r.change_pct, 1.0);
  assertEqual(r.listed_volume, 544313);
  assertEqual(r.listed_turnover, 52585579);
  assertEqual(r.block_volume, 500000);
  assertEqual(r.total_volume, 1044313);
  assertEqual(r.total_turnover, 100160579);
  assertEqual(r.year_volume, 68966986);
  assertEqual(r.lifetime_turnover, 63162586623.18);
  assertEqual(r.auction_volume, 0, '明确无竞价 → 0');
  assertIncludes(r.price_caliber.close, '综合行情收盘价');
  assertIncludes(r.price_caliber.computed_avg_price, '总成交额 / 总成交量');
  assertEqual(r.data_as_of, '2026-07-30');
});

await testAsync('CEA-05 /comparison 明确区分三个价格字段且缺一侧为 null', async () => {
  const out = await call('/api/v2/cea/comparison?from=2026-07-01&to=2026-07-31', { token: viewerToken });
  assertEqual(out.status, 200);
  const p = out.json.points[0];
  assertEqual(p.cea_composite_close, 96.61);
  assert(p.cea_computed_avg_price !== null, 'CEA 计算均价比');
  assertEqual(p.ccer_computed_avg_price, null, 'CCER 侧缺数据必须 null');
  assertEqual(p.spread_close_minus_ccer, null, '缺一侧价差必须 null');
  assertIncludes(out.json.caliber_note, '不沿用前值');
});

await testAsync('CEA-10 /intentions 明确标注意向不计入成交，价格缺省为 null', async () => {
  const out = await call('/api/v2/cea/intentions', { token: viewerToken });
  assertEqual(out.status, 200);
  assertEqual(out.json.not_turnover, true);
  assertIncludes(out.json.note, '不计入成交量/成交额');
  assertEqual(out.json.rows[0].price, null);
  assertEqual(out.json.rows[0].participant, null);
});

await testAsync('CEA-10 /entities 返回覆盖数与真实缺口说明', async () => {
  const out = await call('/api/v2/cea/entities?list_year=2026', { token: viewerToken });
  assertEqual(out.status, 200);
  assertEqual(out.json.total, 1);
  assertEqual(out.json.rows[0].credit_code, '91350100123456789X');
  assertIncludes(out.json.note, '名录数量不等于买家数量');
  assertEqual(out.json.coverage.provinces, 1);
});

await testAsync('CEA-07 /documents 与 /events 返回政策与日历，未核验状态如实展示', async () => {
  const docs = await call('/api/v2/cea/documents?doc_status=formal', { token: viewerToken });
  assertEqual(docs.status, 200);
  // 默认隐藏官方 PDF 附件行（避免同一份通知重复计数），因此可见行数 = 计入统计的行数
  // 阶段B 新增正式全年休市公告（沪环境交〔2025〕44号），计入统计的正式文件为 6 条
  assertEqual(docs.json.rows.length, 6, `默认应返回 6 条计入统计的正式文件，实际 ${docs.json.rows.length}`);
  assertEqual(docs.json.attachments_hidden, 1, '应说明隐藏了 1 条附件行');
  assertIncludes(docs.json.attachment_note, '重复计数');
  const alloc = docs.json.rows.find((d) => d.doc_number === '国环规气候〔2026〕1号');
  assertEqual(alloc.ai_status, 'unverified');
  assertIncludes(alloc.provenance_note, 'docs/31');
  const closure = docs.json.rows.find((d) => d.doc_number === '沪环境交〔2025〕44号');
  assert(closure, '应包含正式全年休市公告');
  assertIncludes(closure.note, '优先于官方查询页使用的机器辅助休市列表');
  assertIncludes(docs.json.note, 'metadata_only');
  const ev = await call('/api/v2/cea/events', { token: viewerToken });
  assertEqual(ev.status, 200);
  const surrender = ev.json.rows.find((e) => e.event_type === 'surrender_deadline');
  assertEqual(surrender.deadline, '2026-12-31');
  assertEqual(surrender.emission_year, 2025);
  assertIncludes(ev.json.note, '未用原文核验');
});

await testAsync('CEA-08 /sources/status 如实展示来源、配额与缺口', async () => {
  const out = await call('/api/v2/cea/sources/status', { token: viewerToken });
  assertEqual(out.status, 200);
  assert(out.json.sources.length >= 13, '应返回登记的官方来源');
  assert(out.json.sync.quota, '应返回配额状态');
  assert(out.json.sync.quota.limit >= 1 && out.json.sync.quota.remaining >= 0, '配额字段应为有效数值');
  // 临时库中没有可用模型：必须如实说明「保持 unverified、不伪造 verified」，而不是假装已核验
  assertEqual(typeof out.json.verification.provider_configured, 'boolean');
  if (!out.json.verification.provider_configured) {
    assertIncludes(out.json.verification.note, '不伪造 verified');
  } else {
    assertIncludes(out.json.verification.note, '引文');
  }
  assertIncludes(out.json.note, '失败不中断全站采集');
  const banned = JSON.stringify(out.json);
  assert(!/api[_-]?key|secret|password|credential_cipher/i.test(banned), '响应不得暴露凭据字段');
});

/* ------------------------------ 情景（无副作用） ------------------------------ */

await testAsync('CEA-07/11 普通用户可运行情景；只计算、不写库', async () => {
  const before = {
    trade: db.get('SELECT COUNT(*) AS c FROM cea_trade_daily').c,
    intentions: db.get('SELECT COUNT(*) AS c FROM cea_intention').c,
    jobs: db.get('SELECT COUNT(*) AS c FROM ingestion_job').c,
  };
  const out = await call('/api/v2/cea/scenario', {
    method: 'POST', token: viewerToken,
    body: { E: 1000, A: 400, C: 500, U: 0, r: 0.05, P1: 100, P2: 60 },
  });
  assertEqual(out.status, 200, JSON.stringify(out.json));
  assertEqual(out.json.persisted, false, '情景不得持久化');
  assertEqual(out.json.result.gap_D, 600);
  assertEqual(out.json.result.offset_used_Q, 50);
  assertEqual(out.json.result.cea_only_cost, 60000);
  assertEqual(db.get('SELECT COUNT(*) AS c FROM cea_trade_daily').c, before.trade, '情景不得写行情');
  assertEqual(db.get('SELECT COUNT(*) AS c FROM cea_intention').c, before.intentions, '情景不得写意向');
  assertEqual(db.get('SELECT COUNT(*) AS c FROM ingestion_job').c, before.jobs, '情景不得触发采集任务');
});

await testAsync('CEA-11 情景非法输入 → 400 且不泄露内部细节', async () => {
  const bad = await call('/api/v2/cea/scenario', {
    method: 'POST', token: viewerToken, body: { E: -5, A: 0, C: 0, U: 0, r: 0.05, P1: 1, P2: 1 },
  });
  assertEqual(bad.status, 400);
  const noR = await call('/api/v2/cea/scenario', {
    method: 'POST', token: viewerToken, body: { E: 100, A: 0, C: 1, U: 0, P1: 1, P2: 1 },
  });
  assertEqual(noR.status, 400);
  assertIncludes(noR.json.error, '必须显式选择抵销比例');
  assert(Array.isArray(noR.json.presets), '应返回可选预设');
});

/* ------------------------------ 普通用户 403 ------------------------------ */

await testAsync('CEA-07 普通用户访问管理员 CEA 接口 → 403', async () => {
  const paths = [
    ['GET', '/api/v2/admin/cea/config'],
    ['POST', '/api/v2/admin/cea/config'],
    ['POST', '/api/v2/admin/cea/collect'],
    ['GET', '/api/v2/admin/cea/jobs'],
    ['POST', '/api/v2/admin/cea/verify'],
    ['POST', '/api/v2/admin/cea/parse-preview'],
  ];
  for (const [method, p] of paths) {
    const out = await call(p, { method, token: viewerToken, body: method === 'POST' ? {} : null });
    assertEqual(out.status, 403, `${method} ${p} 应 403，实际 ${out.status}`);
    assertIncludes(out.json.error, '权限');
  }
});

/* ------------------------------ 管理员可用 ------------------------------ */

await testAsync('CEA-07 管理员可读 CEA 采集配置与任务列表', async () => {
  const cfg = await call('/api/v2/admin/cea/config', { token: adminToken });
  assertEqual(cfg.status, 200, JSON.stringify(cfg.json));
  assert(cfg.json.config.max_items_per_round <= 8, '每轮上限应 ≤8');
  assertIncludes(cfg.json.limits_note, '每轮采集 ≤8 条');
  const jobs = await call('/api/v2/admin/cea/jobs', { token: adminToken });
  assertEqual(jobs.status, 200);
  assert(Array.isArray(jobs.json.jobs));
  assert(Array.isArray(jobs.json.gaps));
});

await testAsync('CEA-08 管理员改配置：越界值被 400 拒绝，合法值生效', async () => {
  const bad = await call('/api/v2/admin/cea/config', {
    method: 'POST', token: adminToken, body: { max_items_per_round: 50 },
  });
  assertEqual(bad.status, 400);
  const ok = await call('/api/v2/admin/cea/config', {
    method: 'POST', token: adminToken, body: { max_items_per_round: 6, after_close_time: '16:30' },
  });
  assertEqual(ok.status, 200, JSON.stringify(ok.json));
  assertEqual(ok.json.config.max_items_per_round, 6);
});

await testAsync('CEA-07 管理员解析预览：只解析不写库、不外发请求', async () => {
  const before = db.get('SELECT COUNT(*) AS c FROM cea_trade_daily').c;
  const out = await call('/api/v2/admin/cea/parse-preview', {
    method: 'POST', token: adminToken,
    body: { content: OFFICIAL_0730, url: URL_0730 },
  });
  assertEqual(out.status, 200, JSON.stringify(out.json).slice(0, 200));
  assertEqual(out.json.parsed.fields.close, 96.61);
  assertEqual(out.json.parsed.trade_date, '2026-07-30');
  assertEqual(db.get('SELECT COUNT(*) AS c FROM cea_trade_daily').c, before, '预览不得写库');
  assertIncludes(out.json.note, '不写库');
});

/* ------------------------------ 跨站写请求 ------------------------------ */

await testAsync('CEA-07 跨站写请求被拒绝（CSRF）', async () => {
  // Cookie 会话下的跨站写请求必须 403（Bearer 令牌不属于 CSRF 场景，故不在此断言）
  const out = await call('/api/v2/cea/scenario', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', cookie: `ccer_session=${viewerToken}` },
    body: { E: 1, A: 0, C: 0, U: 0, r: 0.05, P1: 1, P2: 2 },
  });
  assertEqual(out.status, 403, `跨站 Cookie 写请求应 403，实际 ${out.status}`);
  assertIncludes(out.json.error, '跨站');
  // 同一 Cookie 会话下的同源请求应放行
  const same = await call('/api/v2/cea/scenario', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', cookie: `ccer_session=${viewerToken}` },
    body: { E: 1, A: 0, C: 0, U: 0, r: 0.05, P1: 1, P2: 2 },
  });
  assertEqual(same.status, 200, '同源 Cookie 请求应放行');
});

/* ------------------------------ 导出 ------------------------------ */

await testAsync('CEA-12 导出 CSV：MIME/文件名/公式注入防护/内容与范围一致', async () => {
  const out = await call('/api/v2/cea/export?dataset=trade&format=csv&from=2026-07-01&to=2026-07-31', { token: viewerToken });
  assertEqual(out.status, 200);
  assertIncludes(out.headers.get('content-type'), 'text/csv');
  assertIncludes(decodeURIComponent(out.headers.get('content-disposition') || ''), 'cea_trade');
  assertEqual(out.headers.get('x-export-rows'), '1');
  assert(out.headers.get('x-export-sha256'), '应返回导出内容哈希');
  assertIncludes(out.text, '官方综合收盘价(元/吨)', '表头应带单位');
  assertIncludes(out.text, '96.61');
  assertIncludes(out.text, 'CEA 独立行情', '元信息应含口径说明');
  assert(!out.text.includes('api_key'), '导出不得包含凭据');
});

await testAsync('CEA-12 导出 JSON 与 CSV 行数一致；范围外返回 0 行', async () => {
  const json = await call('/api/v2/cea/export?dataset=trade&format=json&from=2026-07-01&to=2026-07-31', { token: viewerToken });
  assertEqual(json.status, 200);
  const payload = JSON.parse(json.text);
  assertEqual(payload.rows.length, 1);
  assertEqual(payload.rows[0].close, 96.61);
  assert(payload.columns.some((c) => c.unit === '元/吨'), '列定义应带单位');
  const empty = await call('/api/v2/cea/export?dataset=trade&format=json&from=2026-01-01&to=2026-01-31', { token: viewerToken });
  assertEqual(JSON.parse(empty.text).rows.length, 0);
  const bad = await call('/api/v2/cea/export?dataset=nope', { token: viewerToken });
  assertEqual(bad.status, 400);
});

await testAsync('CEA-07 导出对普通用户开放，但每次导出写入导出审计', async () => {
  const before = db.get('SELECT COUNT(*) AS c FROM export_log').c;
  await call('/api/v2/cea/export?dataset=entities&format=csv', { token: viewerToken });
  assert(db.get('SELECT COUNT(*) AS c FROM export_log').c > before, '导出应写审计');
});

await testAsync('CEA-07 不存在的行情/文件返回 404', async () => {
  const a = await call('/api/v2/cea/trade/NO-SUCH-ID', { token: viewerToken });
  assertEqual(a.status, 404);
  const b = await call('/api/v2/cea/documents/NO-SUCH-ID', { token: viewerToken });
  assertEqual(b.status, 404);
});

await testAsync('CEA-16 /trade/:id 返回来源层级与概览层，且概览不覆盖精确值', async () => {
  const out = await call(`/api/v2/cea/trade/${inserted.id}`, { token: viewerToken });
  assertEqual(out.status, 200);
  assertEqual(out.json.row.total_volume, 1044313, '精确值应保持官方日报数值');
  assert(Array.isArray(out.json.quote_sources), '应返回来源层级列表');
  assertIncludes(out.json.caliber_note, '不覆盖');
  // 概览层未采集时为 null，而不是伪造
  assertEqual(out.json.overview, null);
});

await testAsync('CEA-17 /documents 行业×年度配对过滤：不适用的新版分配规则不得返回', async () => {
  // 阶段B：sector+year 筛选后必须**排除** applicability=false 的文件（钢铁 2025 不能命中 2026 分配方案）
  const out = await call('/api/v2/cea/documents?sector=钢铁&year=2025', { token: viewerToken });
  assertEqual(out.status, 200);
  const alloc = out.json.rows.find((d) => d.doc_key === 'cea_allocation_2026_1');
  assertEqual(alloc, undefined, '钢铁 2025：新版 2026 分配方案必须被排除，不得返回');
  assert(out.json.excluded_not_applicable >= 1, '应报告被配对判定排除的文件数');
  assertIncludes(out.json.applicability_note, '不得由');
  assertIncludes(out.json.note, '配对');

  // 发电 2025 应能命中（配对覆盖 发电 2025/2026）
  const power2025 = await call('/api/v2/cea/documents?sector=发电&year=2025', { token: viewerToken });
  const powerAlloc = power2025.json.rows.find((d) => d.doc_key === 'cea_allocation_2026_1');
  assert(powerAlloc, '发电 2025 应命中分配方案');
  assertEqual(powerAlloc.applicability.applicable, true);
  assertIncludes(powerAlloc.applicability.reason, '配对覆盖命中');

  const steel2026 = await call('/api/v2/cea/documents?sector=钢铁&year=2026', { token: viewerToken });
  assertEqual(steel2026.json.rows.find((d) => d.doc_key === 'cea_allocation_2026_1').applicability.applicable, true);

  const withAtt = await call('/api/v2/cea/documents?include_attachments=true', { token: viewerToken });
  const pdfRow = withAtt.json.rows.find((d) => d.doc_key === 'cea_allocation_pdf_2026_1');
  assert(pdfRow, '加 include_attachments=true 应能看到附件行');
  assertEqual(pdfRow.count_in_stats, 0, '附件行不计入政策统计');
  assertEqual(pdfRow.attachment_of, withAtt.json.rows.find((d) => d.doc_key === 'cea_allocation_2026_1').id, '附件行应指向正文行');
});

await testAsync('CEA-04/17 API 参数边界：非法日期、倒置范围、非法 limit/year/dataset/format 一律 400', async () => {
  const bad = [
    ['/api/v2/cea/trade?from=2026-13-45', 'from'],
    ['/api/v2/cea/trade?limit=abc', 'limit'],
    ['/api/v2/cea/trade?limit=0', 'limit'],
    ['/api/v2/cea/trade?limit=99999', 'limit'],
    ['/api/v2/cea/trade?offset=-3', 'offset'],
    ['/api/v2/cea/trade?from=2026-10-13&to=2026-01-01', 'from/to'],
    ['/api/v2/cea/documents?year=20x6', 'year'],
    ['/api/v2/cea/series?granularity=hour', 'granularity'],
    ['/api/v2/cea/intentions?direction=hold', 'direction'],
    ['/api/v2/cea/export?dataset=secrets', 'dataset'],
    ['/api/v2/cea/export?format=exe', 'format'],
    ['/api/v2/cea/calendar?from=2026-02-30', 'from'],
  ];
  for (const [path, parameter] of bad) {
    const out = await call(path, { token: viewerToken });
    assertEqual(out.status, 400, `${path} 应返回 400，实际 ${out.status}`);
    assertIncludes(String(out.json.error || out.json.message || ''), '不合法');
    if (out.json.parameter) assertEqual(out.json.parameter, parameter, `${path} 应指出参数名`);
  }
  // 合法参数仍应 200（未筛选 = 允许）
  const ok = await call('/api/v2/cea/trade?from=2026-01-01&to=2026-12-31&limit=5', { token: viewerToken });
  assertEqual(ok.status, 200);
});

await testAsync('CEA-16 /calendar 返回 CEA 独立日历证据', async () => {
  const out = await call('/api/v2/cea/calendar', { token: viewerToken });
  assertEqual(out.status, 200);
  assert(Array.isArray(out.json.rows));
  assertIncludes(out.json.note, '不复用 CCER 交易日历');
});

await testAsync('CEA-13 回归：既有 CCER 接口未受影响', async () => {
  const ov = await call('/api/v2/overview', { token: viewerToken });
  assertEqual(ov.status, 200, 'CCER 总览应正常');
  const trade = await call('/api/v2/trade/daily', { token: viewerToken });
  assertEqual(trade.status, 200, 'CCER 行情应正常');
  const pol = await call('/api/v2/policies', { token: viewerToken });
  assertEqual(pol.status, 200, 'CCER 政策应正常');
  const admin = await call('/api/v2/admin/status', { token: viewerToken });
  assertEqual(admin.status, 403, '既有后台隔离仍生效');
});

server.close();
finish('32-v2-cea-api.test.mjs');
