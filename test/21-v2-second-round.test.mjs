/**
 * 二轮整改回归测试（docs/22、docs/23）
 * ============================================================================
 * 覆盖 Codex 独立验收提出的、必须可回归验证的关键点：
 *
 *   1. **一万倍单位错误**：气量单位口径与接口契约一致，万 m³ 严格 ×10000；
 *   2. **首页不得冒充文章**：来源首页只作归档（published_at=NULL），正文条目才进入
 *      列表与统计，发布日期只取来源页面声明（取不到为 NULL）；
 *   3. **博查适配**：真实请求体/响应结构与业务码、空结果、log_id 处理；
 *   4. **Firecrawl v2 MCP 预设**：官方地址、只读工具白名单、inputSchema 参数映射；
 *   5. **旧库总览去人工与 demo 污染**：演示项目不进 KPI/进度/地域，缺口只显示自动处理方式；
 *   6. **不生成人工任务**：内容采集 + 全量核验前后 review_task 行数不变；
 *   7. **根路径导向新版**、`npm start` 默认新版公开平台。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes, PROJECT_ROOT,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: true });
const { db } = ctx;
const quick = await import('../src/services/quick-estimate-svc.mjs');
const content = await import('../src/services/content-svc.mjs');
const search = await import('../src/services/search-svc.mjs');
const fetchSvc = await import('../src/services/web-fetch-svc.mjs');
const dash = await import('../src/services/dashboard-svc.mjs');
const admin = await import('../src/services/admin-v2-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');

/* ==================================================================== */
/*  一、一万倍气量单位错误（docs/22 第 11、17 条）                        */
/* ==================================================================== */

test('单位契约：元数据声明的单位必须与接口口径一致（m³/年 与 万 m³/年）', () => {
  const meta = quick.quickGasMeta();
  const gas = meta.primary_fields.find((f) => f.key === 'annual_gas_m3');
  assertEqual(gas.unit, 'm³/年', '主输入单位必须是 m³/年（不是万 m³/年）');
  const units = Object.fromEntries((gas.unit_options || []).map((u) => [u.key, u]));
  assertEqual(units.annual_gas_m3?.factor, 1, 'm³/年 的换算因子应为 1');
  assertEqual(units.annual_gas_10k_m3?.factor, 10000, '万 m³/年 的换算因子必须为 10000');
  assertEqual(meta.unit_contract.annual_gas_10k_m3.includes('10000'), true, 'unit_contract 应写明严格换算关系');
});

test('一万倍回归：10000 万 m³/年 + 1.2% → 18270.9 tCO₂e/年（而不是 1.82709）', () => {
  // 浏览器样例：输入 10000（万 m³/年）→ 必须按 1e8 m³ 计算
  const out = quick.quickGasEstimate({ annual_gas_10k_m3: 10000, ch4_pct: 1.2 });
  assert(!out.error, `不应报错：${out.error || ''}`);
  assertEqual(out.inputs.annual_gas_m3, 100000000, '万 m³ 应严格 ×10000 换算为 m³');
  assertEqual(out.inputs.annual_gas_10k_m3, 10000, '应回显万 m³ 口径');
  assertEqual(out.annual_tco2e, 18270.9, `结果应为 18270.9，实际 ${out.annual_tco2e}`);
  // 与直接按 m³ 输入的结果必须完全一致（同口径）
  const same = quick.quickGasEstimate({ annual_gas_m3: 100000000, ch4_pct: 1.2 });
  assertEqual(out.annual_tco2e, same.annual_tco2e, '两种单位写法必须得到同一结果');
  assertIncludes(out.unit_note, '万 m³/年', '结果应说明本次使用的单位口径');
  assertIncludes(out.unit_note, '等效', '结果应给出等效换算');
});

test('单位冲突与非法输入被拒绝（不允许单位歧义）', () => {
  const both = quick.quickGasEstimate({ annual_gas_m3: 10000, annual_gas_10k_m3: 10000, ch4_pct: 1.2 });
  assert(both.error, '同时提交两种单位应被拒绝');
  assertIncludes(both.error, '只能按一种单位', '应说明单位只能选一种');
  assert(quick.quickGasEstimate({ annual_gas_10k_m3: -5, ch4_pct: 1 }).error, '负的万 m³ 应被拒绝');
  assert(quick.quickGasEstimate({ annual_gas_10k_m3: 'abc', ch4_pct: 1 }).error, '非数值应被拒绝');
});

/* ==================================================================== */
/*  二、首页不得冒充文章（docs/22 第 2、8、10、15 条）                    */
/* ==================================================================== */

const ARTICLE_HTML = `<!doctype html><html><head>
<title>全国温室气体自愿减排交易系统 · 市场动态</title>
<meta name="description" content="来源页面自带的公开摘要，未改写。">
</head><body>
<h1>市场动态</h1>
<ul>
 <li><a href="/wcm/ccer/html/2408scdt1/20260920/102025504.shtml">为地球降温—全民参与碳抵销行动正式上线</a></li>
 <li><a href="/wcm/ccer/html/2408scdt1/20260918/102025501.shtml">全国温室气体自愿减排交易系统运行情况</a></li>
 <li><a href="/about/index.html">关于我们</a></li>
</ul>
</body></html>`;

const CONTENT_HTML = `<!doctype html><html><head>
<title>为地球降温—全民参与碳抵销行动正式上线</title>
<meta property="article:published_time" content="2026-09-20T10:00:00+08:00">
<meta name="description" content="交易平台动态：活动于 9 月 14 日举办。">
</head><body>
<div>发布时间：2026-09-20</div>
<p>全国温室气体自愿减排交易系统推出全民参与碳抵销行动，公众可通过公开渠道参与。</p>
<p>本段用于满足核验所需的正文长度，内容为公开页面的确定性抽取文本，不含任何模型改写。</p>
</body></html>`;

const stub = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(ARTICLE_HTML);
  }
  if (req.url.includes('20260920')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(CONTENT_HTML);
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  return res.end('not found');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

test('正文页链接发现与发布日期抽取：只认页面声明，取不到为 NULL', () => {
  const links = content.discoverArticleLinks(ARTICLE_HTML, 'https://www.ccer.com.cn/', { max: 5 });
  assert(links.length >= 2, `应发现候选正文链接，实际 ${links.length}`);
  assert(links.some((l) => l.url.includes('20260920')), '应保留日期形式的正文链接');
  assert(!links.some((l) => l.url.endsWith('/about/index.html')), '导航页不应被当作正文候选');
  const d = content.extractPublishedDate(CONTENT_HTML, { url: 'https://www.ccer.com.cn/x/20260920/1.shtml' });
  assertEqual(d.published_at, '2026-09-20', '应抽取页面声明的发布日期');
  assertEqual(d.date_source, 'meta', '应记录日期依据为 meta 标签');
  const none = content.extractPublishedDate('<html><body><p>没有日期声明</p></body></html>', { url: 'https://x.com/a' });
  assertEqual(none.published_at, null, '页面无日期声明且 URL 无完整日期时应返回 null（不得用采集时间代替）');
  const noMetaWithUrlDate = content.extractPublishedDate('<html><body><p>没有日期</p></body></html>', { url: 'https://x.com/20260920/a.shtml' });
  assertEqual(noMetaWithUrlDate.published_at, null, 'URL 日期不能直接作为发布日期');
  assertEqual(noMetaWithUrlDate.date_candidate, '2026-09-20', 'URL 日期仅保留候选依据');
  assertIncludes(noMetaWithUrlDate.note, '未经页面发布声明证实', '候选日期必须说明未证实');
});

await testAsync('来源首页只作归档：不生成「今天发布的研报」，正文条目取真实日期', async () => {
  const created = fetchSvc.upsertFetchConnection(
    { name: 'admin', role: 'admin' },
    {
      id: 'WFC-LOCAL-STUB', name: '本机桩直连抓取', conn_kind: 'direct_http',
      base_url: STUB_URL, endpoint_path: '/', auth_kind: 'none',
      allowed_domains: ['127.0.0.1'], enabled: true, timeout_ms: 4000, retry_max: 0, daily_quota: 100,
    }
  );
  assert(created.ok, `创建桩抓取连接应成功：${created.error || ''}`);
  db.run("UPDATE web_fetch_connection SET enabled=0 WHERE id<>'WFC-LOCAL-STUB'");

  const out = await content.collectFromSeedSources({
    actor: 'test', seedIds: ['src-ccer-com'], fetchLimit: 1, maxArticlesPerSource: 3,
    // 用本机桩来源替代真实站点：验证的是「发现 → 逐篇抓取 → 日期抽取」链路本身，
    // 真实站点验收由 scripts/v2-real-collect.mjs 在联网环境执行。
    seedSources: [{
      id: 'src-ccer-com', name: '全国温室气体自愿减排交易系统（本机桩）',
      url: `${STUB_URL}/`, source_category: 'exchange', kinds: ['industry_news'], enabled: 1,
    }],
  });
  assertEqual(out.fetched, 1, '来源页应抓取成功');
  assert(out.archive_records >= 1, '首页应写为来源归档记录');

  const archive = db.get(
    "SELECT * FROM content_item WHERE record_kind='source_homepage' AND source_url=?",
    [`${STUB_URL}/`]
  );
  assert(archive, '应存在首页归档记录');
  assertEqual(archive.published_at, null, '首页归档不得写入「今天」作为发布日期');
  assertIncludes(archive.note, '不作为一篇文章', '归档备注应说明不作为文章');

  const articles = db.all(
    "SELECT * FROM content_item WHERE record_kind='article' AND source_url LIKE ?",
    [`${STUB_URL}%`]
  );
  assert(articles.length >= 1, '应至少收录 1 篇正文条目');
  assertEqual(articles[0].published_at, '2026-09-20', '正文条目应使用页面声明的发布日期');
  assert(!articles.some((a) => a.source_url === `${STUB_URL}/`), '首页不得作为正文条目入库');

  // 业务列表与统计只包含正文条目，归档记录被排除
  const list = content.listContentItems({ limit: 100 });
  assert(!list.items.some((i) => i.record_kind !== 'article'), '业务列表不得包含来源归档记录');
  const stats = content.contentStats();
  assert(stats.archive_records >= 1, '统计应单列来源归档条数');
  assert(!list.items.some((i) => i.published_at === null && i.title.includes('来源首页归档')), '归档记录不得进入文章列表');
  const archiveList = content.listContentItems({ include_archive: 'true', limit: 100 });
  assert(archiveList.items.some((i) => i.record_kind === 'source_homepage'), '显式查看归档时仍可检索（保留历史留痕）');
});

test('可获得性以采集器返回为准：抓取连接返回全文时不按字符数猜', () => {
  assertEqual(
    content.availabilityFromFetch({ conn_kind: 'mcp_http' }, '很短的一段 Markdown 正文'),
    'full_text',
    'MCP/Firecrawl 返回整页内容时应判 full_text，而不是按长度猜 partial'
  );
  assertEqual(
    content.availabilityFromFetch({ conn_kind: 'direct_http', availability: 'partial' }, 'x'.repeat(5000)),
    'partial',
    '采集器明确给出 partial 时优先于长度判断'
  );
  assertEqual(
    content.availabilityFromFetch({ conn_kind: 'direct_http' }, ''),
    'metadata_only',
    '没有正文时应判 metadata_only'
  );
});

/* ==================================================================== */
/*  三、博查搜索适配（docs/23）                                          */
/* ==================================================================== */

test('博查适配：预设端点、白名单、凭据引用与请求参数映射', () => {
  const p = search.SEARCH_KINDS.bocha;
  assert(p, '应存在 provider_kind=bocha 的独立适配');
  assertIncludes(p.label, '博查', '后台选择项应显示「博查 Web Search」');
  assertEqual(p.base_url, 'https://api.bocha.cn', '默认地址应为 api.bocha.cn');
  assertEqual(p.search_path, '/v1/web-search', '默认路径应为 /v1/web-search');
  assertEqual(p.allowed_domains[0], 'api.bocha.cn', '出站白名单应为 api.bocha.cn');
  assertEqual(p.credential_ref, 'BOCHA_API_KEY', '凭据引用应为 BOCHA_API_KEY');
  assertIncludes(p.notes, 'api.bochaai.com', '应说明旧地址可手工改写但不会静默替换');

  const provider = {
    base_url: 'https://api.bocha.cn', search_path: '/v1/web-search', http_method: 'POST',
    auth_kind: 'bearer', credential_ref: 'BOCHA_API_KEY',
    param_map_json: JSON.stringify(p.param_map), response_map_json: JSON.stringify(p.response_map),
    allowed_domains: JSON.stringify(p.allowed_domains),
  };
  process.env.BOCHA_API_KEY = 'test-bocha-key-value';
  const req = search.buildSearchRequest(provider, 'CCER 方法学', { count: 5, window_days: 7 });
  assertEqual(req.url, 'https://api.bocha.cn/v1/web-search', '应请求博查真实端点');
  assertEqual(req.body.query, 'CCER 方法学', 'query 字段应映射正确');
  assertEqual(req.body.count, 5, 'count 字段应映射正确');
  assertEqual(req.body.summary, true, 'summary 默认应为 true（摘要，不是全文）');
  assertEqual(req.body.freshness, 'oneWeek', '7 天窗口应映射为 freshness=oneWeek');
  assertEqual(req.headers.authorization, 'Bearer test-bocha-key-value', '鉴权头应为 Bearer');
  delete process.env.BOCHA_API_KEY;

  // freshness 边界
  assertEqual(search.freshnessForWindow(1), 'oneDay');
  assertEqual(search.freshnessForWindow(30), 'oneMonth');
  assertEqual(search.freshnessForWindow(200), 'oneYear');
  assertEqual(search.freshnessForWindow(0), 'noLimit');
});

test('博查响应映射：data.webPages.value → 归一化；dateLastCrawled 不得当发布日期', () => {
  const provider = {
    response_map_json: JSON.stringify(search.SEARCH_KINDS.bocha.response_map),
  };
  const payload = {
    code: 200,
    log_id: 'log-123',
    data: {
      webPages: {
        value: [
          {
            name: '全球和中国碳市场回顾与展望（2026）',
            url: 'https://ceep.bit.edu.cn/zxcg/ndycbg/1a2c2e.htm',
            summary: '研究机构年度报告摘要（不是全文）。',
            snippet: '备用片段',
            siteName: '北京理工大学能源与环境政策研究中心',
            datePublished: '2026-01-12T00:00:00+08:00',
            dateLastCrawled: '2026-09-29T02:00:00+08:00',
          },
        ],
      },
    },
  };
  const rows = search.normalizeSearchResults(provider, payload);
  assertEqual(rows.length, 1, '应解析出 1 条结果');
  assertEqual(rows[0].title, '全球和中国碳市场回顾与展望（2026）', 'name → title');
  assertEqual(rows[0].publisher, '北京理工大学能源与环境政策研究中心', 'siteName → publisher');
  assertEqual(rows[0].published_at, '2026-01-12', 'datePublished → published_at');
  assert(rows[0].published_at !== '2026-09-29', 'dateLastCrawled（抓取时间）绝不能被当成发布日期');
  assertEqual(rows[0].raw_content, null, '摘要不是全文：raw_content 必须为空');
  // snippet 回退
  const rows2 = search.normalizeSearchResults(provider, {
    code: 200,
    data: { webPages: { value: [{ name: 't', url: 'https://a.com/1', snippet: '只有 snippet' }] } },
  });
  assertEqual(rows2[0].snippet, '只有 snippet', 'summary 缺失时应回退到 snippet');
  assertEqual(rows2[0].published_at, null, '没有 datePublished 时应为 null（不臆造日期）');
});

test('博查业务码：HTTP 200 但 code≠200 也算失败，并保留可公开的 log_id', () => {
  const provider = { response_map_json: JSON.stringify(search.SEARCH_KINDS.bocha.response_map), provider_kind: 'bocha' };
  const ok = search.checkBusinessCode(provider, { code: 200 });
  assertEqual(ok.failed, false, 'code=200 应判成功');
  const quota = search.checkBusinessCode(provider, { code: 403, log_id: 'log-403', message: '余额不足' });
  assertEqual(quota.failed, true, 'code=403 应判失败');
  assertEqual(quota.reason, 'insufficient_balance', '应区分「余额不足」');
  assertIncludes(quota.message, 'log-403', '错误信息应保留可公开的 log_id');
  const auth = search.checkBusinessCode(provider, { code: 401, log_id: 'log-401' });
  assertEqual(auth.reason, 'auth_error', '401 应判鉴权失败');
  const limited = search.checkBusinessCode(provider, { code: 429, log_id: 'log-429' });
  assertEqual(limited.reason, 'rate_limited', '429 应判限流');
  const other = search.checkBusinessCode({ response_map_json: JSON.stringify({ results_path: 'results' }) }, { results: [] });
  assertEqual(other.failed, false, '未配置业务码字段的供应商不受影响');
});

await testAsync('博查真实 HTTP 往返：实际发出的请求体/鉴权头正确，业务码失败如实返回', async () => {
  const seenReq = [];
  let mode = 'ok';
  const bochaStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      seenReq.push({ url: req.url, headers: req.headers, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'quota') {
        return res.end(JSON.stringify({ code: 403, log_id: 'log-quota-1', message: '余额不足' }));
      }
      if (mode === 'empty') {
        return res.end(JSON.stringify({ code: 200, log_id: 'log-empty-1', data: { webPages: { value: [] } } }));
      }
      return res.end(JSON.stringify({
        code: 200,
        log_id: 'log-ok-1',
        data: {
          webPages: {
            value: [{
              name: '全国温室气体自愿减排交易系统市场动态',
              url: 'https://www.ccer.com.cn/wcm/ccer/html/2408scdt1/20260920/102025504.shtml',
              summary: '来源摘要（不是全文）',
              siteName: '全国温室气体自愿减排交易系统',
              datePublished: '2026-09-20T00:00:00+08:00',
              dateLastCrawled: '2026-09-29T03:00:00+08:00',
            }],
          },
        },
      }));
    });
  });
  await new Promise((r) => bochaStub.listen(0, '127.0.0.1', r));

  process.env.BOCHA_API_KEY = 'test-bocha-key-value';
  const provider = {
    id: 'SRCH-BOCHA-TEST', name: '博查测试', provider_kind: 'bocha',
    base_url: `http://127.0.0.1:${bochaStub.address().port}`, search_path: '/v1/web-search',
    http_method: 'POST', auth_kind: 'bearer', credential_ref: 'BOCHA_API_KEY',
    param_map_json: JSON.stringify(search.SEARCH_KINDS.bocha.param_map),
    response_map_json: JSON.stringify(search.SEARCH_KINDS.bocha.response_map),
    allowed_domains: JSON.stringify(['127.0.0.1']),
    timeout_ms: 5000, retry_max: 0, daily_quota: 10, calls_today: 0, calls_today_date: null, enabled: 1,
  };
  const out = await search.runSearch(provider, 'CCER 方法学', { count: 3, window_days: 7 });
  assertEqual(out.ok, true, `博查调用应成功：${out.reason || ''} ${out.message || ''}`);
  assertEqual(seenReq.length, 1, '应真的发出一次请求');
  assertEqual(seenReq[0].body.query, 'CCER 方法学', '请求体 query 应正确');
  assertEqual(seenReq[0].body.count, 3, '请求体 count 应正确');
  assertEqual(seenReq[0].body.summary, true, '请求体 summary 应为 true');
  assertEqual(seenReq[0].body.freshness, 'oneWeek', '窗口 7 天应映射 freshness=oneWeek');
  assertEqual(seenReq[0].headers.authorization, 'Bearer test-bocha-key-value', '鉴权应走 Bearer 头');
  assert(!seenReq[0].url.includes('test-bocha-key-value'), 'API Key 不得出现在 URL 中');
  assertEqual(out.results[0].published_at, '2026-09-20', '结果日期应取 datePublished');
  assertEqual(out.results[0].publisher, '全国温室气体自愿减排交易系统', 'siteName 应映射为 publisher');
  assertEqual(out.log_id, 'log-ok-1', '应保留可公开的 log_id');

  mode = 'quota';
  const quota = await search.runSearch(provider, 'CCER', { count: 1 });
  assertEqual(quota.ok, false, 'HTTP 200 + code=403 应判失败');
  assertEqual(quota.reason, 'insufficient_balance', '应区分余额不足');
  assertIncludes(quota.message, 'log-quota-1', '错误信息应带 log_id');
  assertEqual(seenReq.length, 2, '业务码失败不得重试（retry_max=0 且鉴权类失败）');

  mode = 'empty';
  const empty = await search.runSearch(provider, 'CCER 不存在的结果', { count: 1 });
  assertEqual(empty.ok, true, '空结果不是失败');
  assertEqual(empty.empty, true, '应显式标记空结果');
  assertEqual(empty.results.length, 0, '空结果应为 0 条');
  assertIncludes(empty.empty_note, '空结果', '应说明是空结果而非伪造内容');

  delete process.env.BOCHA_API_KEY;
  bochaStub.close();
});

/* ==================================================================== */
/*  四、Firecrawl v2 MCP 预设（docs/23）                                 */
/* ==================================================================== */

test('Firecrawl MCP 预设：官方地址、只读工具白名单与 keyless 限额试用标注', () => {
  const preset = fetchSvc.FETCH_KINDS.mcp_http;
  assert(preset, '应存在 conn_kind=mcp_http 的 Firecrawl v2 MCP 预设');
  assertEqual(preset.base_url, 'https://mcp.firecrawl.dev', '默认 endpoint 应为官方地址');
  assertEqual(preset.endpoint_path, '/v2/mcp', '默认路径应为 /v2/mcp');
  assertEqual(preset.mcp_tool_name, 'firecrawl_scrape', '默认工具应为 firecrawl_scrape');
  assertEqual(JSON.stringify(preset.mcp_allowed_tools), JSON.stringify(['firecrawl_scrape']), '只读白名单仅含所需工具');
  assertEqual(preset.credential_ref, 'FIRECRAWL_API_KEY', '凭据引用应为 FIRECRAWL_API_KEY');
  assertEqual(preset.keyless_trial, true, '应标注官方允许 keyless 限额试用');
  assertIncludes(preset.notes, 'Anonymous keyless access is unavailable', '应如实说明无密钥抓取可能被拒');
  assertIncludes(preset.notes, 'FIRECRAWL_API_KEY', '应指向生产用 API Key');
});

test('MCP 参数映射读取 tools/list 的 inputSchema（url / formats）', () => {
  const tool = {
    name: 'firecrawl_scrape',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, formats: { type: 'array' } } },
  };
  const args = fetchSvc.buildMcpToolArgs(tool, 'https://example.com/a', {}, { extra: { onlyMainContent: true } });
  assertEqual(args.url, 'https://example.com/a', '应把 url 映射到 schema 的 url 参数');
  assertEqual(JSON.stringify(args.formats), JSON.stringify(['markdown']), '应把 formats 映射为数组');
  assertEqual(args.onlyMainContent, true, '应保留额外参数映射');
  const strSchema = { input_schema: { properties: { url: {}, formats: { type: 'string' } } } };
  const args2 = fetchSvc.buildMcpToolArgs(strSchema, 'https://example.com/b', {}, {});
  assertEqual(typeof args2.formats, 'string', 'schema 期望 string 时应提交字符串');
  const noSchema = fetchSvc.buildMcpToolArgs(null, 'https://example.com/c', {}, { url_arg: 'url', format_arg: 'formats', format_value: ['markdown'] });
  assertEqual(noSchema.url, 'https://example.com/c', '无 schema 时应退回参数映射');
});

test('keyless 域名限制：只有官方固定地址允许无凭据调用', () => {
  assertEqual(fetchSvc.keylessAllowed({ base_url: 'https://mcp.firecrawl.dev', allowed_domains: JSON.stringify(['mcp.firecrawl.dev']) }), true);
  assertEqual(fetchSvc.keylessAllowed({ base_url: 'https://mcp.firecrawl.dev.evil.com', allowed_domains: JSON.stringify(['mcp.firecrawl.dev.evil.com']) }), false, '相似域名不得放行');
  assertEqual(fetchSvc.keylessAllowed({ base_url: 'http://mcp.firecrawl.dev', allowed_domains: JSON.stringify(['mcp.firecrawl.dev']) }), false, '必须 HTTPS');
  assertEqual(fetchSvc.keylessAllowed({ base_url: 'https://mcp.firecrawl.dev', allowed_domains: JSON.stringify(['mcp.firecrawl.dev', 'evil.com']) }), false, '白名单被放宽时不得免鉴权');
});

/* ==================================================================== */
/*  五、旧库总览：去 demo 污染与去人工提示（docs/22 第 16 条）            */
/* ==================================================================== */

test('总览 KPI 与项目进度排除演示条目，且不再出现人工复核/签字口径', () => {
  const demoCount = db.get('SELECT COUNT(*) c FROM public_project WHERE COALESCE(is_demo,0)=1').c;
  assert(demoCount >= 3, '测试库应包含演示项目（用于验证排除）');
  const realCount = db.get('SELECT COUNT(*) c FROM public_project WHERE COALESCE(is_demo,0)=0').c;
  const m = dash.topMetrics(dash.parseFilters({}));
  const proj = m.metrics.find((x) => x.key === 'dash.project_public');
  assertEqual(proj.value, db.get('SELECT COUNT(*) c FROM public_project WHERE COALESCE(is_demo,0)=0 AND stage_project_public=1').c,
    '公示项目数必须只统计非演示条目');
  assertIncludes(proj.sub, `已排除演示条目 ${demoCount} 条`, '应明示已排除的演示条数');
  assertIncludes(proj.sub, `公开项目库 ${realCount} 个`, '公开项目库数量应为业务口径');
  const progress = dash.projectProgress(dash.parseFilters({}));
  assertEqual(progress.project_total, realCount, '项目进度总数不得包含演示条目');
  assert(!progress.stages.some((s) => s.count > realCount), '阶段计数不得超过业务项目总数');
  const region = dash.regionView(dash.parseFilters({}));
  assert(!JSON.stringify(region.provinces).includes('演示'), '地域视图不得出现演示条目');
  // 全量文案不得含人工审批/签字口径（公开总览只展示自动运行状态）
  const allText = JSON.stringify(m) + JSON.stringify(region);
  for (const bad of ['待人工复核', '人工核对', '人工补录', '须人工', '签字', '审批', '人工路径']) {
    assert(!allText.includes(bad), `总览口径不得再出现「${bad}」`);
  }
});

test('数据缺口展示为自动处理方式，历史人工路径只作留痕（展示入口已移到后台管理员页）', () => {
  // 模拟旧库遗留的人工路径文案（用仍然 open 的缺口：行情采集依赖官方公告页）
  db.run("UPDATE data_gap SET manual_path='人工路径：研究员逐条核对后补录' WHERE gap_key='gap-trade-daily'");
  const gaps = admin.listGaps({ status: 'all' });
  const gap = gaps.find((g) => g.gap_key === 'gap-trade-daily');
  assert(gap, '应返回缺口记录');
  assertEqual(gap.manual_path, null, '展示字段 manual_path 必须为空（不再给人工路径）');
  assertIncludes(gap.legacy_manual_path, '人工路径', '原始文案应保留为历史留痕');
  assertIncludes(gap.auto_action, '自动', '应给出自动处理方式');
  assertIncludes(gap.handling, '无人工待办', '应说明这是自动运行状态');
  // docs/44 第 4 条：缺口细节只在后台「运行与内容维护」暴露；
  // 总览服务仍能推导实时状态（后台复用），但**总览接口不再返回 data_gaps**。
  const region = dash.regionView(dash.parseFilters({}));
  const dg = region.data_gaps.find((g) => g.gap_key === 'gap-trade-daily');
  assertEqual(dg.manual_path, null, '缺口的展示字段也不得显示人工路径');
  assertIncludes(dg.auto_action, '自动', '应显示自动处理方式');
  const ov = dash.overview({});
  assertEqual(ov.updates, undefined, '总览接口不得返回自动运行状态（更新提醒）');
  assertEqual(ov.region?.data_gaps, undefined, '总览接口不得返回数据缺口细节');
});

/* ==================================================================== */
/*  六、人工任务不被生成（docs/22 第 6、12、14 条）                      */
/* ==================================================================== */

await testAsync('内容采集 + 全量核验前后 review_task 行数不变（不产生人工任务）', async () => {
  const before = db.get('SELECT COUNT(*) c FROM review_task').c;
  // 走真实的采集入口（未配置搜索服务 → 明确失败，不写库）+ 真实的核验入口
  const collectOut = await content.collectFromSearch({ actor: 'test' });
  assertEqual(collectOut.ok, false, '未配置搜索服务应明确失败');
  await verify.verifyAllBatch({ actor: 'test', limitPerScope: 10 });
  const after = db.get('SELECT COUNT(*) c FROM review_task').c;
  assertEqual(after, before, '采集与核验链路不得生成任何人工任务');
  // 旧的 createReviewTask 仍作为历史工具存在，但新链路不调用它
  const collectSrc = readFileSync(join(PROJECT_ROOT, 'src', 'services', 'collect-svc.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const calls = (collectSrc.match(/createReviewTask\(/g) || []).length;
  assertEqual(calls, 1, 'collect-svc 中只应保留函数定义本身，不得有调用点');
  const recSrc = readFileSync(join(PROJECT_ROOT, 'src', 'services', 'reconcile-svc.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert(!recSrc.includes('createReviewTask'), 'reconcile-svc 不得再引用 createReviewTask');
  assert(!recSrc.includes('UPDATE review_task'), 'reconcile-svc 不得再改写人工任务状态');
});

/* ==================================================================== */
/*  七、主入口导向新版（docs/22 第 10、18 条）                            */
/* ==================================================================== */

test('npm start 默认启动新版公开平台；根路径在 v2 启用时导向 /v2', () => {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assertEqual(pkg.scripts.start, 'node scripts/v2-start.mjs', 'npm start 必须默认启动 v2 隔离启动器');
  assertEqual(pkg.scripts['start:v1'], 'node src/server.mjs', '旧版启动脚本应单独保留为 start:v1');
  assertIncludes(pkg.description, '公开信息平台', 'package.json 描述应改为公开信息平台');
  assert(!pkg.description.includes('投资筛选'), '描述不应再是投资筛选应用');
  const serverSrc = readFileSync(join(PROJECT_ROOT, 'src', 'server.mjs'), 'utf8');
  assertIncludes(serverSrc, "location: '/v2'", 'v2 启用时根路径应 302 到 /v2');
  assertIncludes(serverSrc, 'V1_RETIRED_PREFIXES', '应集中声明需停用的旧私有/审批接口前缀');
  for (const p of ['/api/projects', '/api/reviews', '/api/calculations', '/api/reports']) {
    assertIncludes(serverSrc, p, `旧私有/审批接口 ${p} 应被明确停用`);
  }
  const startSrc = readFileSync(join(PROJECT_ROOT, 'scripts', 'v2-start.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert(!startSrc.includes('syncInternalFromDossiers'), '首次初始化不得再同步内部项目');
  assertIncludes(startSrc, 'withDemo: false', '首次初始化不得写入 demo/内部项目');
  assertIncludes(startSrc, 'withPublicDemo: false', '首次初始化不得写入公开演示项目');
  assertIncludes(startSrc, '八模块', '启动日志应描述八模块公开平台（含 CEA 市场）');
});

stub.close();
finish('21-v2-second-round.test.mjs');
