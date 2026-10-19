/**
 * 36-v2-cea-dsh-fixes.test.mjs —— docs/35 九项尾项的实际修复回归
 * ============================================================================
 * 覆盖（全部针对 docs/35-CEA独立验收尾项.md「发布前必须解决」）：
 *   1. JSON 串日 / 方式缺失 / 方式重复：用**真实响应夹具**改日期、删一行、复制一行，
 *      验证串日通道不写入请求日字段、缺口可追溯、不把少数行合成完整总量；
 *   2. 共享 deadline 真正传到网络与重试：慢响应桩覆盖 JSON 通道、搜索、直连抓取、MCP、模型；
 *   3. research 后台指定服务真正生效（不存在/未启用 → 明确失败，不静默切换）；
 *   4. research 正文抓取计入 CEA 当日配额（含失败尝试）、异常必定收尾不留 running、
 *      重入不关闭仍在运行的原任务（覆盖全部 CEA 采集器）；
 *   5. 截止日按原文精度记录（不补造日）＋转载站 first_source_url 为 null、本页 URL 另存；
 *   6. 管理员采集异步 202 + task_id + 重入合并 + 真实进度/失败原因（端到端 HTTP）；
 *   7. 收盘后轻量增量的真实调度（北京时间跨天、CCER_DAILY_SYNC=0、动态配置、停止）；
 *   8. 成本表单 P2 读取 CCER 独立行情（绝不回落 CEA 价格）；
 *   9. 文件采集后的默认模型核验实际触发（本机桩模型真实 HTTP 调用）。
 *
 * 说明：本文件是**后端/接口回归**，浏览器交互（390px、点击路径）由 Codex 用真实
 * Playwright 独立复验，本文件不冒充浏览器验收。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const jsonSvc = await import('../src/services/cea-json.mjs');
const webFetch = await import('../src/services/web-fetch-svc.mjs');
const searchSvc = await import('../src/services/search-svc.mjs');
const collectSvc = await import('../src/services/collect-svc.mjs');
const verifySvc = await import('../src/services/verification-svc.mjs');
const scheduler = await import('../src/services/daily-scheduler.mjs');

const ROOT = process.cwd();
// 公开无凭据夹具随代码包提供（test/fixtures/cea），完整回归不依赖 data/backups 运行期目录
const SRC_DIR = join(ROOT, 'test', 'fixtures', 'cea');
const REAL_MARKET = readFileSync(join(SRC_DIR, 'queryMarketByDate-20261014.json'), 'utf8');
const REAL_SUB = readFileSync(join(SRC_DIR, 'querySubStat-20261014.json'), 'utf8');
const REAL_TRADE_DATE = '2026-10-14';

// 允许本机回环出站（测试桩服务器都在 127.0.0.1）：与 test/16 的做法一致
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
const ADMIN = { id: 'user-admin', name: '系统管理员', role: 'admin', team_id: 'team-carbon' };

console.log('\n[v2-36] CEA docs/35 九项尾项修复回归（串日 / deadline / 配额 / 202 / 调度 / P2 / 核验）');

/* ==================================================================== */
/*  本机桩服务器：CEA 上游 JSON / 搜索 / 抓取连接 / MCP / 模型           */
/* ==================================================================== */

const upstreamCalls = [];
let modelPromptSeen = null;
/** 路由表：path -> { status, body, delayMs, contentType, json } */
const routes = new Map();

const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const path = String(req.url || '').split('?')[0];
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw || null; }
    upstreamCalls.push({ path, method: req.method, body, at: Date.now() });
    let r = routes.get(path);
    if (!r) {
      // 前缀匹配：供应商会在 base_url 后追加自己的 path（如 /v1/web-search）；
      // 必须取**最长**匹配，否则 '/search' 会抢先匹配 '/search-ok2'
      const prefixHits = [...routes.keys()]
        .filter((k) => k !== '*' && path.startsWith(k))
        .sort((a, b) => b.length - a.length);
      if (prefixHits.length) r = routes.get(prefixHits[0]);
    }
    if (!r && routes.has('*')) r = routes.get('*');
    if (!r) r = { status: 404, body: { error: 'no route' } };
    const delay = Number(r.delayMs) || 0;
    const send = () => {
      // MCP：按 JSON-RPC 方法返回（initialize / tools/list / tools/call）
      if (r.mcp) {
        const method = body?.method;
        if (method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'stub-session' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '1' } } }));
        }
        if (method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
        if (method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'firecrawl_scrape', inputSchema: { type: 'object', properties: { url: { type: 'string' }, formats: { type: 'array' } } } }] } }));
        }
        if (method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            jsonrpc: '2.0', id: body.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ markdown: r.markdown || '# 标题\n\n正文内容（桩）', metadata: { title: '桩页面' } }) }] },
          }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, result: {} }));
      }
      if (r.model) {
        // 兼容 OpenAI chat/completions：返回可被 parseModelJson 解析的核验结果
        try { modelPromptSeen = JSON.stringify(body || {}).slice(0, 8000); } catch { modelPromptSeen = null; }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                consistent: true, confidence: 0.9, evidence_capability: 'full_text',
                summary: '桩模型：正文与来源一致',
                issues: [], conflict_fields: [],
                citations: [{ kind: 'body', quote: r.modelQuote || '全国碳排放权交易市场', locator: '第 1 段' }],
              }),
            },
          }],
          usage: { total_tokens: 12 },
        }));
      }
      const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
      res.writeHead(r.status || 200, { 'content-type': r.contentType || 'application/json' });
      res.end(payload);
    };
    if (delay > 0) setTimeout(send, delay); else send();
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

function setRoute(path, cfg) { routes.set(path, cfg); }
function callsTo(path) { return upstreamCalls.filter((c) => c.path === path || c.path.startsWith(path)); }
/** 清掉服务端限流时间戳，避免测试被 12/分钟 的间隔拖慢（这是测试夹具，不是放宽生产限流） */
function resetRateLimit() { db.run("DELETE FROM system_meta WHERE key='collect_last_request_at_ms'"); }
/** 把某个 CEA 来源指向本机桩（仍走真实 checkOutboundUrl + fetchText 链路） */
function pointCeaSource(code, path, { method = 'GET' } = {}) {
  db.run('UPDATE cea_source SET url=?, allowed_domains=?, method=? WHERE code=?', [
    `${STUB}${path}`, JSON.stringify(['127.0.0.1']), method, code,
  ]);
}
function openGaps(prefix) {
  return db.all("SELECT gap_key,title,status FROM data_gap WHERE gap_key LIKE ? AND status='open'", [`${prefix}%`]);
}

cea.seedCeaBaseData({ actor: 'test' });

/* ==================================================================== */
/*  尾项1：JSON 串日 / 缺失方式 / 重复行                                 */
/* ==================================================================== */

test('尾项1 真实夹具基线：querySubStat 三方式齐全时才有完整合计', () => {
  const real = jsonSvc.parseSubStat(REAL_SUB);
  assertEqual(real.ok, true);
  assertEqual(real.trade_date, REAL_TRADE_DATE, '夹具是 2026-10-14 的真实响应');
  assertEqual(real.complete, true, '真实响应三方式齐全');
  assert(Number.isFinite(real.total_volume) && real.total_volume > 0, '真实响应应有总成交量');
  assertEqual(real.methods_missing.length, 0);
  assertEqual(real.methods_duplicated.length, 0);
});

test('尾项1 串日夹具：汇总行日期不一致 → 直接判失败，不产出任何数值', () => {
  const j = JSON.parse(REAL_SUB);
  const agg = j.data.filter((r) => String(r.subjectCode).toUpperCase() === 'COMCEA');
  agg[1].tradeDate = '20261013'; // 真实响应改一行日期
  const out = jsonSvc.parseSubStat(j);
  assertEqual(out.ok, false, '日期不一致必须判失败');
  assertIncludes(out.reason, '日期不一致');
  assertEqual(out.total_volume, undefined, '失败时不得产出合计');
});

test('尾项1 删行夹具：缺失一个方式 → 分项保留、合计保持 null（不合成完整总量）', () => {
  const j = JSON.parse(REAL_SUB);
  j.data = j.data.filter((r) => !(String(r.subjectCode).toUpperCase() === 'COMCEA' && String(r.tradeMethod) === '21'));
  const out = jsonSvc.parseSubStat(j);
  assertEqual(out.ok, true);
  assertEqual(out.complete, false, '缺一个方式即不完整');
  assertEqual(out.methods_missing.length, 1);
  assertEqual(out.methods_missing[0].method, 'auction');
  assertEqual(out.total_volume, null, '不得用已见方式之和冒充完整总量');
  assertEqual(out.year_volume, null);
  assertEqual(out.lifetime_volume, null);
  assert(Number.isFinite(out.listed_volume), '已披露方式的分项值照实保留');
  assertIncludes(out.caliber_note, '合计值一律保持 null');
});

test('尾项1 重复行夹具：同一方式出现两行 → 判重复、拒绝合计（避免总量虚高）', () => {
  const j = JSON.parse(REAL_SUB);
  const listed = j.data.find((r) => String(r.subjectCode).toUpperCase() === 'COMCEA' && String(r.tradeMethod) === '10');
  j.data.push({ ...listed });
  const out = jsonSvc.parseSubStat(j);
  assertEqual(out.ok, true);
  assertEqual(out.complete, false);
  assertEqual(JSON.stringify(out.methods_duplicated), JSON.stringify(['10']));
  assertEqual(out.total_volume, null, '重复行不得参与合计');
  assertEqual(out.per_method.filter((r) => r.method === 'listed').length, 1, '重复行不重复计入分项');
});

test('尾项1 queryMarketByDate：响应无日期时 date_confirmed=false（不得当成请求日）', () => {
  const j = JSON.parse(REAL_MARKET);
  j.data[0].quotPoin = '';
  const out = jsonSvc.parseMarketByDate(j);
  assertEqual(out.ok, true);
  assertEqual(out.trade_date, null);
  assertEqual(out.date_confirmed, false);
});

/* ---- docs/35「17:00 之后的独立故障注入追加」的两项失败，按同样的真实夹具复验 ---- */

test('尾项1 追加：任一分项数量未披露 → 该字段合计保持 null，其余字段照常单独保留', () => {
  const baseline = jsonSvc.parseSubStat(REAL_SUB);
  const j = JSON.parse(REAL_SUB);
  j.data.find((r) => String(r.subjectCode).toUpperCase() === 'COMCEA' && String(r.tradeMethod) === '20').tradeVolume = null;
  const out = jsonSvc.parseSubStat(j);
  assertEqual(out.ok, true);
  assertEqual(out.complete, true, 'complete 只表示三方式齐全（缺项不再被当成 0 参与合计）');
  assertEqual(out.total_volume, null, '任一分项未披露时，总成交量不得用其余方式之和冒充完整总量');
  assertEqual(out.block_volume, null, '未披露的分项保持 null');
  assert(Number.isFinite(out.listed_volume) && Number.isFinite(out.auction_volume), '已披露分项照实保留');
  assertEqual(out.total_turnover, baseline.total_turnover, '已完整披露的金额字段不受影响、单独保留');
  assertEqual(out.field_disclosure.total_volume.complete, false);
  assertEqual(out.field_disclosure.total_volume.undisclosed_methods[0].method, 'block');
  assert(out.fields_undisclosed.some((f) => f.field === 'total_volume'), '应逐字段记录未披露项');
  assertIncludes(out.caliber_note, '并非三方式全部披露');
});

test('尾项1 追加：年度标的行再增加也不改变 COMCEA 总量', () => {
  const baseline = jsonSvc.parseSubStat(REAL_SUB);
  const j = JSON.parse(REAL_SUB);
  const annual = j.data.find((r) => String(r.subjectCode).toUpperCase() !== 'COMCEA');
  j.data.push({ ...annual });
  const out = jsonSvc.parseSubStat(j);
  assertEqual(out.total_volume, baseline.total_volume);
  assertEqual(out.total_turnover, baseline.total_turnover);
});

test('尾项1 追加：queryMarketByDate 只有年度标的（无 COMCEA）→ 判失败，不冒充全国综合行情', () => {
  const j = JSON.parse(REAL_MARKET);
  j.data.forEach((r) => { r.subjCode = 'CEA25'; });
  const out = jsonSvc.parseMarketByDate(j);
  assertEqual(out.ok, false, '年度标的行情不得冒充综合行情');
  assertIncludes(out.reason, 'COMCEA');
  assertIncludes(out.reason, '年度标的');
  assertEqual(out.close, undefined, '失败时不得产出任何行情数值');
  assertEqual(out.trade_date, undefined);
});

await testAsync('尾项1 采集链路：串日通道不写入请求日字段，同日正确通道保留为 partial 并留缺口', async () => {
  // 真实响应夹具：market 通道被改成前一天（模拟上游忽略查询日期/缓存串日），substat 保持同日
  const marketJ = JSON.parse(REAL_MARKET);
  marketJ.data.forEach((r) => { r.quotPoin = '20261013'; });
  const subJ = JSON.parse(REAL_SUB);
  const histJ = [['20261014', 100, 101, 99, 102, 1234]];

  setRoute('/cea/market', { status: 200, body: marketJ });
  setRoute('/cea/substat', { status: 200, body: subJ });
  setRoute('/cea/hiskline', { status: 200, body: histJ });
  setRoute('/cea/dailyov', { status: 500, body: { error: 'stub' } });
  setRoute('/cea/holidays', { status: 500, body: { error: 'stub' } });
  pointCeaSource('cea_json_market_by_date', '/cea/market', { method: 'POST' });
  pointCeaSource('cea_json_substat', '/cea/substat', { method: 'POST' });
  pointCeaSource('cea_json_hiskline', '/cea/hiskline');
  pointCeaSource('cea_json_dailyov', '/cea/dailyov');
  pointCeaSource('cea_json_holidays', '/cea/holidays');
  resetRateLimit();

  const cfg = { ...collect.ceaCollectConfig(), auto_verify: false, request_timeout_ms: 4000, batch_budget_ms: 30000, daily_fetch_limit: 60 };
  const out = await collect.collectCeaJsonDaily({ actor: 'test', trigger: 'manual', dates: [REAL_TRADE_DATE], cfg });

  const row = db.get('SELECT * FROM cea_trade_daily WHERE trade_date=?', [REAL_TRADE_DATE]);
  assert(row, '同日正确的 substat 通道应当入库该交易日');
  assertEqual(row.close, null, '串日的 market 通道不得把行情写进该日');
  assertEqual(row.open, null);
  assertEqual(row.listed_volume, jsonSvc.parseSubStat(REAL_SUB).listed_volume, '同日通道的量额保留');
  assert(row.total_volume > 0, '同日 substat 精确量额应保留');

  const src = out.quote_sources[0];
  assertEqual(src.partial, true, '应由 quote_sources 标记为 partial');
  assertEqual(src.channels.market_by_date, 'date_mismatch');
  assertEqual(src.channels.substat, 'used');
  assertEqual(out.date_mismatches.length, 1);
  assertEqual(out.date_mismatches[0].channel, 'market_by_date');

  const gaps = openGaps(`cea:json:date_mismatch:${REAL_TRADE_DATE}:market_by_date`);
  assertEqual(gaps.length, 1, '串日必须登记可追溯缺口');
  const parseRow = db.get('SELECT parse_status, parse_note, raw_fields_json FROM cea_trade_daily WHERE trade_date=?', [REAL_TRADE_DATE]);
  assertEqual(parseRow.parse_status, 'partial');
  assertIncludes(parseRow.parse_note, '与请求日期');
  const rawFields = JSON.parse(parseRow.raw_fields_json);
  assertEqual(rawFields.market_by_date.trade_date, '2026-10-13', '串日通道按其真实日期留痕');
});

await testAsync('尾项1 采集链路：两通道都串日 → 该日不留行情行、不生成 0 值点', async () => {
  const marketJ = JSON.parse(REAL_MARKET);
  marketJ.data.forEach((r) => { r.quotPoin = '20261013'; });
  const subJ = JSON.parse(REAL_SUB);
  subJ.data.forEach((r) => { if (r.tradeDate) r.tradeDate = '20261013'; });
  const otherDay = '2026-08-11';
  setRoute('/cea/market', { status: 200, body: marketJ });
  setRoute('/cea/substat', { status: 200, body: subJ });
  setRoute('/cea/hiskline', { status: 200, body: [[otherDay.replace(/-/g, ''), 100, 101, 99, 102, 1234]] });
  resetRateLimit();
  const cfg = { ...collect.ceaCollectConfig(), auto_verify: false, request_timeout_ms: 4000, batch_budget_ms: 20000, daily_fetch_limit: 60 };
  await collect.collectCeaJsonDaily({ actor: 'test', trigger: 'manual', dates: [otherDay], cfg });
  const row = db.get('SELECT * FROM cea_trade_daily WHERE trade_date=?', [otherDay]);
  assert(!row, '两个通道都无法确认日期时不得写入该交易日（也不写 0）');
});

/* ==================================================================== */
/*  尾项2：共享 deadline 真正传到网络与重试                              */
/* ==================================================================== */

await testAsync('尾项2 fetchText：批次剩余时间决定真实请求时限（慢响应被真正中止，不靠 Promise.race）', async () => {
  setRoute('/slow/text', { status: 200, body: { ok: true }, delayMs: 5000 });
  resetRateLimit();
  const t0 = Date.now();
  const out = await collectSvc.fetchText(`${STUB}/slow/text`, {
    allowedDomains: ['127.0.0.1'], timeoutMs: 30000, retryMax: 2, deadlineAt: Date.now() + 600,
  });
  const elapsed = Date.now() - t0;
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'deadline_exceeded');
  assertIncludes(out.error, '批次总时间上限');
  assert(elapsed < 2500, `必须在剩余时间内收尾（实际 ${elapsed}ms），而不是等满 30 秒`);
  assertEqual(callsTo('/slow/text').length, 1, '剩余时间不足时不得继续重试');
});

await testAsync('尾项2 fetchText：不传 deadline 时行为与旧版一致（默认兼容）', async () => {
  setRoute('/fast/text', { status: 200, body: { ok: true }, contentType: 'application/json' });
  resetRateLimit();
  const out = await collectSvc.fetchText(`${STUB}/fast/text`, { allowedDomains: ['127.0.0.1'], timeoutMs: 5000, retryMax: 0 });
  assertEqual(out.ok, true);
  assertEqual(out.status, 200);
});

await testAsync('尾项2 runSearch：重试不再重置时限，剩余不足即收尾且不重复请求', async () => {
  const now = new Date().toISOString();
  db.run('DELETE FROM search_provider');
  db.run(
    `INSERT INTO search_provider (id,name,provider_kind,base_url,auth_kind,param_map_json,response_map_json,
       timeout_ms,retry_max,allowed_domains,enabled,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['SRCH-STUB', '桩搜索', 'bocha', STUB, 'none', '{}', '{}', 30000, 3, JSON.stringify(['127.0.0.1']), 1, now, now]
  );
  process.env.CEA_TEST_KEY = 'stub-search-secret';
  db.run("UPDATE search_provider SET credential_ref='CEA_TEST_KEY' WHERE id='SRCH-STUB'");
  setRoute('/search', { status: 200, body: { code: 200, data: { webPages: { value: [] } } }, delayMs: 5000 });
  const provider = db.get("SELECT * FROM search_provider WHERE id='SRCH-STUB'");
  // buildSearchRequest 会把供应商 path 拼在 base_url 上；桩路由按前缀匹配
  const p = { ...provider, base_url: `${STUB}/search` };
  const t0 = Date.now();
  const out = await searchSvc.runSearch(p, '测试查询', { count: 3, deadlineAt: Date.now() + 700 });
  const elapsed = Date.now() - t0;
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'deadline_exceeded');
  assert(elapsed < 2500, `搜索必须在剩余时间内收尾（实际 ${elapsed}ms）`);
  assertEqual(callsTo('/search').length, 1, '重试不得越过共享 deadline（不得重复发请求）');
});

await testAsync('尾项2 fetchUrlContent：调用方更短时限在直连分支真正生效', async () => {
  setRoute('/fetch/slow', { status: 200, body: '<html><body>正文</body></html>', contentType: 'text/html', delayMs: 5000 });
  const conn = {
    id: 'WFC-STUB-DIRECT', name: '桩直连', enabled: 1, conn_kind: 'direct_http', auth_kind: 'none',
    base_url: STUB, allowed_domains: JSON.stringify(['127.0.0.1']), timeout_ms: 30000, retry_max: 0,
    calls_today: 0, calls_today_date: null, daily_quota: 100,
  };
  const t0 = Date.now();
  const out = await webFetch.fetchUrlContent(conn, `${STUB}/fetch/slow`, { timeoutMs: 500 });
  const elapsed = Date.now() - t0;
  assertEqual(out.ok, false, '慢响应必须判失败');
  assert(elapsed < 2500, `opts.timeoutMs 必须真正生效（实际 ${elapsed}ms，旧实现会等满 conn.timeout_ms=30s）`);
});

await testAsync('尾项2 fetchUrlContent：MCP 分支的 initialize/tools/call 都受共享 deadline 约束', async () => {
  setRoute('/mcp-slow', { mcp: true, delayMs: 5000 });
  const conn = {
    id: 'WFC-STUB-MCP', name: '桩MCP', enabled: 1, conn_kind: 'mcp_http', auth_kind: 'none',
    base_url: STUB, endpoint_path: '/mcp-slow', allowed_domains: JSON.stringify(['127.0.0.1']),
    timeout_ms: 30000, retry_max: 2, mcp_tool_name: 'firecrawl_scrape',
    mcp_allowed_tools: JSON.stringify(['firecrawl_scrape']), calls_today: 0, calls_today_date: null, daily_quota: 100,
    credential_ref: 'CEA_TEST_KEY',
  };
  process.env.CEA_TEST_KEY = 'stub-mcp-secret';
  const t0 = Date.now();
  const out = await webFetch.fetchUrlContent(conn, `${STUB}/target-page`, { deadlineAt: Date.now() + 700, timeoutMs: 30000 });
  const elapsed = Date.now() - t0;
  assertEqual(out.ok, false);
  assert(elapsed < 2500, `MCP 必须在剩余时间内收尾（实际 ${elapsed}ms）`);
  assert(
    ['deadline_exceeded', 'mcp_init_failed'].includes(out.reason),
    `MCP 失败原因应体现时限（实际 ${out.reason}）`
  );
});

await testAsync('尾项2 MCP 正常路径：同一连接在时限充足时能真实取回正文（不是只有超时用例）', async () => {
  setRoute('/mcp-ok', { mcp: true, markdown: '# 研报标题\n\n' + '全国碳排放权交易市场配额分配方案研究。'.repeat(30) });
  const conn = {
    id: 'WFC-STUB-MCP2', name: '桩MCP2', enabled: 1, conn_kind: 'mcp_http', auth_kind: 'none',
    base_url: STUB, endpoint_path: '/mcp-ok', allowed_domains: JSON.stringify(['127.0.0.1']),
    timeout_ms: 8000, retry_max: 0, mcp_tool_name: 'firecrawl_scrape',
    mcp_allowed_tools: JSON.stringify(['firecrawl_scrape']), calls_today: 0, calls_today_date: null, daily_quota: 100,
    credential_ref: 'CEA_TEST_KEY',
  };
  const out = await webFetch.fetchUrlContent(conn, `${STUB}/target-page-2`, { timeoutMs: 5000 });
  assertEqual(out.ok, true);
  assertIncludes(out.content, '全国碳排放权交易市场');
});

/* ==================================================================== */
/*  尾项3：research 后台指定服务真正生效                                 */
/* ==================================================================== */

function insertSearchProvider({ id, enabled = 1, base = STUB, path = '/search3' }) {
  const now = new Date().toISOString();
  db.run('DELETE FROM search_provider WHERE id=?', [id]);
  db.run(
    `INSERT INTO search_provider (id,name,provider_kind,base_url,auth_kind,param_map_json,response_map_json,
       timeout_ms,retry_max,allowed_domains,enabled,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, `桩搜索 ${id}`, 'bocha', `${base}${path}`, 'none',
      JSON.stringify({ query_field: 'query', count_field: 'count' }),
      JSON.stringify({ results_path: 'data.webPages.value', url_field: 'url', title_field: 'name', snippet_field: 'summary', business_code_field: 'code', business_code_ok: 200 }),
      5000, 0, JSON.stringify(['127.0.0.1']), enabled, now, now,
    ]
  );
  process.env.CEA_TEST_KEY = 'stub-search-secret';
  db.run("UPDATE search_provider SET credential_ref='CEA_TEST_KEY' WHERE id=?", [id]);
  return db.get('SELECT * FROM search_provider WHERE id=?', [id]);
}

function insertFetchConn({ id, kind = 'direct_http', enabled = 1, archived = 0 }) {
  const now = new Date().toISOString();
  db.run('DELETE FROM web_fetch_connection WHERE id=?', [id]);
  db.run(
    `INSERT INTO web_fetch_connection (id,name,conn_kind,base_url,endpoint_path,auth_kind,allowed_domains,
       timeout_ms,retry_max,daily_quota,enabled,archived,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, `桩连接 ${id}`, kind, STUB, '/page', 'none', JSON.stringify(['127.0.0.1']), 5000, 0, 100, enabled, archived, now, now]
  );
  return db.get('SELECT * FROM web_fetch_connection WHERE id=?', [id]);
}

await testAsync('尾项3 配置保存：search_provider_id / fetch_connection_id 真实落库并回读', async () => {
  insertSearchProvider({ id: 'SRCH-CFG' });
  insertFetchConn({ id: 'WFC-CFG' });
  const saved = collect.saveCeaCollectConfig(ADMIN, { search_provider_id: 'SRCH-CFG', fetch_connection_id: 'WFC-CFG' });
  assertEqual(saved.ok, true);
  const back = collect.ceaCollectConfig();
  assertEqual(back.search_provider_id, 'SRCH-CFG');
  assertEqual(back.fetch_connection_id, 'WFC-CFG');
});

await testAsync('尾项3 指定搜索服务不存在 → 明确失败，且不发任何搜索请求（不静默切换）', async () => {
  collect.saveCeaCollectConfig(ADMIN, { search_provider_id: 'SRCH-NOT-EXIST', fetch_connection_id: null });
  setRoute('/search3', { status: 200, body: { code: 200, data: { webPages: { value: [] } } } });
  const before = callsTo('/search3').length;
  const out = await collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig(), limit: 1 });
  assertEqual(out.published, 0);
  assertEqual(out.failed[0].reason, 'search_provider_missing');
  assertIncludes(out.failed[0].message, '不自动改用其他服务');
  assertEqual(callsTo('/search3').length, before, '指定服务不存在时不得改调用其它服务');
});

await testAsync('尾项3 指定搜索服务未启用 → 明确失败，不静默切换', async () => {
  insertSearchProvider({ id: 'SRCH-OFF', enabled: 0 });
  collect.saveCeaCollectConfig(ADMIN, { search_provider_id: 'SRCH-OFF' });
  const out = await collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig(), limit: 1 });
  assertEqual(out.failed[0].reason, 'search_provider_disabled');
  assertIncludes(out.failed[0].message, '未启用');
});

await testAsync('尾项3 指定抓取连接不存在/归档 → 明确失败，不静默切换', async () => {
  insertSearchProvider({ id: 'SRCH-OK' });
  setRoute('/search3', { status: 200, body: { code: 200, data: { webPages: { value: [] } } } });
  collect.saveCeaCollectConfig(ADMIN, { search_provider_id: 'SRCH-OK', fetch_connection_id: 'WFC-NOT-EXIST' });
  const out1 = await collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig(), limit: 1 });
  assertEqual(out1.failed[0].reason, 'fetch_connection_unusable');
  assertIncludes(out1.failed[0].message, '不存在');

  insertFetchConn({ id: 'WFC-ARCHIVED', archived: 1 });
  collect.saveCeaCollectConfig(ADMIN, { fetch_connection_id: 'WFC-ARCHIVED' });
  const out2 = await collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig(), limit: 1 });
  assertEqual(out2.failed[0].reason, 'fetch_connection_unusable');
  assertIncludes(out2.failed[0].message, '归档');
});

await testAsync('尾项3 实际调用选中的就是配置的两个服务（返回体标注 source=config）', async () => {
  insertSearchProvider({ id: 'SRCH-OK2', path: '/search-ok2' });
  insertFetchConn({ id: 'WFC-OK2' });
  setRoute('/search-ok2', {
    status: 200,
    body: {
      code: 200,
      data: { webPages: { value: [{ url: `${STUB}/page-1.htm`, name: '官方研究', summary: '摘要' }] } },
    },
  });
  setRoute('/page', { status: 500, body: 'upstream down', contentType: 'text/plain' });
  collect.saveCeaCollectConfig(ADMIN, { search_provider_id: 'SRCH-OK2', fetch_connection_id: 'WFC-OK2' });
  const out = await collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig(), limit: 1 });
  assertEqual(out.search_provider.id, 'SRCH-OK2');
  assertEqual(out.search_provider.source, 'config');
  assertEqual(out.fetch_connection.id, 'WFC-OK2');
  assertEqual(out.fetch_connection.source, 'config');
  assert(callsTo('/search-ok2').length >= 1, '搜索请求必须打到配置的服务');
  assert(callsTo('/page').length >= 1, '正文抓取必须打到配置的连接');
});

/* ==================================================================== */
/*  尾项4：配额计数、异常收尾、重入不关闭原任务                          */
/* ==================================================================== */

await testAsync('尾项4 研究正文抓取（含失败尝试）计入 CEA 当日调用数', async () => {
  insertSearchProvider({ id: 'SRCH-Q', path: '/search-q' });
  insertFetchConn({ id: 'WFC-Q' });
  setRoute('/search-q', {
    status: 200,
    body: { code: 200, data: { webPages: { value: [
      { url: `${STUB}/page-1.htm`, name: '研究一', summary: 's' },
      { url: `${STUB}/page-2.htm`, name: '研究二', summary: 's' },
    ] } } },
  });
  setRoute('/page', { status: 500, body: 'down', contentType: 'text/plain' });
  collect.saveCeaCollectConfig(ADMIN, { search_provider_id: 'SRCH-Q', fetch_connection_id: 'WFC-Q' });
  const before = collect.ceaFetchUsedToday();
  const out = await collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig(), limit: 2 });
  const after = collect.ceaFetchUsedToday();
  assert(out.fetch_attempts >= 1, '必须记录正文抓取尝试');
  assertEqual(after - before, out.fetch_attempts, '每次正文抓取尝试（含失败）都要计入 CEA 当日调用数');
  const q = collect.ceaQuotaState(collect.ceaCollectConfig());
  assert(q.breakdown.research_and_other_attempts >= out.fetch_attempts, '配额明细里应能看出研究类尝试');
});

await testAsync('尾项4 研究主体异常必定收尾：不留 running 任务', async () => {
  insertSearchProvider({ id: 'SRCH-EX', path: '/search-ex' });
  insertFetchConn({ id: 'WFC-EX' });
  setRoute('/search-ex', { status: 200, body: { code: 200, data: { webPages: { value: [] } } } });
  collect.saveCeaCollectConfig(ADMIN, { search_provider_id: 'SRCH-EX', fetch_connection_id: 'WFC-EX' });
  const origFetch = globalThis.fetch;
  // 故障注入：抛出一个 message 取值即报错的对象，使「catch 内部再抛」这种最坏情况也发生
  const nasty = {};
  Object.defineProperty(nasty, 'message', { get() { throw new Error('boom-in-catch'); } });
  globalThis.fetch = () => { throw nasty; };
  let out = null;
  try {
    out = await collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig(), limit: 1 });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert(out, '异常也必须返回结果（不把异常抛给调用方后留下 running）');
  assert(out.failed.some((f) => f.reason === 'exception'), '应如实记录异常');
  const job = db.get("SELECT * FROM ingestion_job WHERE job_key='cea_research' ORDER BY started_at DESC LIMIT 1");
  assert(job.status !== 'running', '异常后任务不得留在 running');
  assert(job.finished_at, '异常后必须有结束时间');
});

await testAsync('尾项4 意向采集异常同样收尾（不留 running）', async () => {
  pointCeaSource('cea_json_trade_intent', '/intent-nasty');
  const origFetch = globalThis.fetch;
  const nasty = {};
  Object.defineProperty(nasty, 'message', { get() { throw new Error('boom-intentions'); } });
  globalThis.fetch = () => { throw nasty; };
  try {
    await collect.collectCeaIntentions({ actor: 'test', trigger: 'manual', cfg: collect.ceaCollectConfig() });
  } finally {
    globalThis.fetch = origFetch;
  }
  const job = db.get("SELECT * FROM ingestion_job WHERE job_key='cea_intentions' ORDER BY started_at DESC LIMIT 1");
  assert(job.status !== 'running', '意向采集异常后不得留在 running');
});

await testAsync('尾项4 重入：复用运行中的任务但**不关闭**它（覆盖全部 CEA 采集器）', async () => {
  const map = [
    ['cea_daily', (cfg, dl) => collect.collectCeaDaily({ actor: 'test', trigger: 'manual', cfg, deadlineAt: dl })],
    ['cea_documents', (cfg, dl) => collect.collectCeaDocuments({ actor: 'test', trigger: 'manual', cfg, deadlineAt: dl })],
    ['cea_intentions', (cfg, dl) => collect.collectCeaIntentions({ actor: 'test', trigger: 'manual', cfg, deadlineAt: dl })],
    ['cea_research', (cfg, dl) => collect.collectCeaResearch({ actor: 'test', trigger: 'manual', cfg, limit: 1, deadlineAt: dl })],
    ['cea_entities', (cfg, dl) => collect.collectCeaEntities({ actor: 'test', trigger: 'manual', cfg, deadlineAt: dl })],
    ['cea_json_daily', (cfg, dl) => collect.collectCeaJsonDaily({ actor: 'test', trigger: 'manual', cfg, deadlineAt: dl })],
  ];
  const cfg = { ...collect.ceaCollectConfig(), auto_verify: false };
  for (const [key, run] of map) {
    const job = collect.openCeaJob({ jobKey: key, title: `占位运行任务 ${key}`, trigger: 'test', actor: 'test' });
    assertEqual(job.reused, false, `${key} 应新建占位任务`);
    const out = await run(cfg, Date.now() + 5000);
    assertEqual(out.reused, true, `${key} 应识别为重入`);
    assertEqual(out.merged, true);
    assertEqual(out.merged_into_job_id, job.id);
    const row = db.get('SELECT status,finished_at FROM ingestion_job WHERE id=?', [job.id]);
    assertEqual(row.status, 'running', `${key} 的重入不得把仍在运行的原任务标成结束`);
    assertEqual(row.finished_at, null, `${key} 的重入不得写结束时间`);
    collect.closeCeaJob(job.id, { status: 'failed', errorSummary: '测试收尾' });
  }
});

/* ==================================================================== */
/*  尾项5：截止日精度 + 第一来源纪律                                     */
/* ==================================================================== */

test('尾项5 截止日按原文精度记录：只到月/年不补造成具体某一天', () => {
  const month = collect.deriveResearchMeta({ url: 'https://example.com/a', body: '数据截至2023年12月' });
  assertEqual(month.data_cutoff_date, '2023-12');
  assertEqual(month.data_cutoff_precision, 'month');
  assertIncludes(month.data_cutoff_raw, '截至2023年12月');
  const year = collect.deriveResearchMeta({ url: 'https://example.com/a', body: '数据截至2023年' });
  assertEqual(year.data_cutoff_date, '2023');
  assertEqual(year.data_cutoff_precision, 'year');
  const day = collect.deriveResearchMeta({ url: 'https://example.com/a', body: '数据截至2023年12月31日' });
  assertEqual(day.data_cutoff_date, '2023-12-31');
  assertEqual(day.data_cutoff_precision, 'day');
  const none = collect.deriveResearchMeta({ url: 'https://example.com/a', body: '没有截止日表述' });
  assertEqual(none.data_cutoff_date, null, '未标注保持 null');
});

await testAsync('尾项5 转载站：first_source_url 为 null、本页 URL 记在 page_url；截止日精度进列表', async () => {
  const repost = cea.upsertCeaDocument({
    doc_key: 'test_repost_1', doc_type: 'news', category: 'news', title: '转载：碳市场动态',
    first_source_url: null, page_url: 'https://www.sohu.com/a/123',
    data_cutoff_date: '2023-12', data_cutoff_precision: 'month', data_cutoff_raw: '数据截至2023年12月',
    viewpoint: 'market_news', evidence_level: 'full_text', body_snapshot: '正文'.repeat(300),
    fetched_at: new Date().toISOString(),
  }, { actor: 'test' });
  assertEqual(repost.ok, true);
  const list = cea.listCeaResearch({ limit: 50 });
  const row = list.rows.find((r) => r.id === repost.id);
  assert(row, '新写入的条目应出现在研报列表');
  assertEqual(row.first_source, null, '转载站不得冒充公开第一来源');
  assertEqual(row.first_source_unknown, true);
  assertEqual(row.page_url, 'https://www.sohu.com/a/123', '当前页面 URL 必须另存');
  assertEqual(row.data_cutoff_display, '2023-12（原文仅到月）', '展示必须体现原文精度');
  const exported = cea.ceaExportRows('research', {});
  const colKeys = exported.columns.map((c) => c.key);
  assert(colKeys.includes('data_cutoff_precision'), '导出需含截止日精度');
  assert(colKeys.includes('page_url'), '导出需含本页 URL');
});

/* ==================================================================== */
/*  尾项6：管理员采集异步 202（端到端 HTTP）                             */
/* ==================================================================== */

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${server.address().port}`;

async function call(path, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

let adminToken = null;
let viewerToken = null;

await testAsync('尾项6 登录（真实会话）', async () => {
  const a = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' } });
  assertEqual(a.status, 200, `管理员登录失败：${JSON.stringify(a.json)}`);
  adminToken = a.json.token;
  const v = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' } });
  assertEqual(v.status, 200);
  viewerToken = v.json.token;
});

await testAsync('尾项6 普通用户触发采集仍然 403', async () => {
  const out = await call('/api/v2/admin/cea/collect', { method: 'POST', token: viewerToken, body: { target: 'json' } });
  assertEqual(out.status, 403);
});

await testAsync('尾项6 POST 立即 202 + task_id；同目标第二次请求合并不重复抓取；进度可轮询', async () => {
  setRoute('/cea/http-market', { status: 200, body: JSON.parse(REAL_MARKET), delayMs: 900 });
  setRoute('/cea/http-substat', { status: 200, body: JSON.parse(REAL_SUB), delayMs: 900 });
  setRoute('/cea/http-hiskline', { status: 200, body: [['20261014', 100, 101, 99, 102, 1234]], delayMs: 200 });
  setRoute('/cea/http-dailyov', { status: 500, body: { error: 'stub' } });
  setRoute('/cea/http-holidays', { status: 500, body: { error: 'stub' } });
  pointCeaSource('cea_json_market_by_date', '/cea/http-market', { method: 'POST' });
  pointCeaSource('cea_json_substat', '/cea/http-substat', { method: 'POST' });
  pointCeaSource('cea_json_hiskline', '/cea/http-hiskline');
  pointCeaSource('cea_json_dailyov', '/cea/http-dailyov');
  pointCeaSource('cea_json_holidays', '/cea/http-holidays');
  resetRateLimit();

  const t0 = Date.now();
  const first = await call('/api/v2/admin/cea/collect', { method: 'POST', token: adminToken, body: { target: 'json', dates: [REAL_TRADE_DATE] } });
  const elapsed = Date.now() - t0;
  assertEqual(first.status, 202, `POST 必须立即 202（实际 ${first.status}）`);
  assert(first.json.task_id, '必须返回 task_id');
  assert(elapsed < 500, `POST 不得等待外部采集（实际 ${elapsed}ms）`);

  const second = await call('/api/v2/admin/cea/collect', { method: 'POST', token: adminToken, body: { target: 'json' } });
  assertEqual(second.status, 202);
  assertEqual(second.json.merged, true, '同目标重入必须合并');
  assertEqual(second.json.task_id, first.json.task_id, '合并必须返回同一个 task_id');

  // 轮询真实进度
  let task = null;
  let sawRunning = false;
  for (let i = 0; i < 160; i += 1) {
    const poll = await call(`/api/v2/admin/cea/jobs?task_id=${encodeURIComponent(first.json.task_id)}`, { token: adminToken });
    assertEqual(poll.status, 200);
    task = poll.json.task;
    if (task && (task.status === 'queued' || task.status === 'running')) sawRunning = true;
    if (task && task.status !== 'queued' && task.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(sawRunning, '轮询期间应能看到 queued/running 真实状态');
  assert(task, 'jobs?task_id= 必须返回任务');
  assert(['success', 'partial', 'failed'].includes(task.status), `任务应有明确结束状态（实际 ${task?.status}）`);
  assert(task.job_id, '任务必须关联真实的 ingestion_job');
  assertEqual(task.result_summary.status, task.status === 'failed' ? 'failed' : task.result_summary.status);
  const jobs = await call('/api/v2/admin/cea/jobs', { token: adminToken });
  assert((jobs.json.jobs || []).some((j) => j.id === task.job_id), '后台 jobs 列表应能看到该真实任务');
  assert((jobs.json.tasks || []).some((t) => t.task_id === task.task_id), '后台 tasks 列表应能看到异步任务');
});

await testAsync('尾项6 无采集结果时不得判「完成」：失败任务带明确失败原因', async () => {
  setRoute('/cea/http-intent', { status: 500, body: { error: 'upstream down' } });
  pointCeaSource('cea_json_trade_intent', '/cea/http-intent');
  pointCeaSource('cea_intentions', '/cea/http-intent-portal');
  setRoute('/cea/http-intent-portal', { status: 500, body: { error: 'down' } });
  resetRateLimit();
  const accepted = await call('/api/v2/admin/cea/collect', { method: 'POST', token: adminToken, body: { target: 'intentions' } });
  assertEqual(accepted.status, 202);
  let task = null;
  for (let i = 0; i < 160; i += 1) {
    const poll = await call(`/api/v2/admin/cea/jobs?task_id=${encodeURIComponent(accepted.json.task_id)}`, { token: adminToken });
    task = poll.json.task;
    if (task && task.status !== 'queued' && task.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assertEqual(task.status, 'failed', '两个通道都失败时必须判 failed');
  assert(task.error, '失败必须带原因');
  assertEqual(task.result_summary.published, 0);
});

/* ==================================================================== */
/*  尾项7：收盘后增量的真实调度                                          */
/* ==================================================================== */

test('尾项7 北京时间跨天计算：16:30 之前排当天、之后排次日（与服务器本地时区无关）', () => {
  // 2026-10-14T08:00:00Z = 北京时间 16:00 → 当天 16:30（=08:30Z）
  const before = scheduler.__test.nextRun(Date.parse('2026-10-14T08:00:00Z'), 16, 30);
  assertEqual(new Date(before).toISOString(), '2026-10-14T08:30:00.000Z');
  // 2026-10-14T08:31:00Z = 北京时间 16:31 → 次日 16:30（= 2026-10-15T08:30Z）
  const after = scheduler.__test.nextRun(Date.parse('2026-10-14T08:31:00Z'), 16, 30);
  assertEqual(new Date(after).toISOString(), '2026-10-15T08:30:00.000Z');
  // 跨月/跨年边界
  const nye = scheduler.__test.nextRun(Date.parse('2026-12-31T09:00:00Z'), 16, 30); // 北京 17:00
  assertEqual(new Date(nye).toISOString(), '2027-01-01T08:30:00.000Z');
});

await testAsync('尾项7 CCER_DAILY_SYNC=0 一并停用；CCER_CEA_AFTER_CLOSE=0 单独停用', async () => {
  const saved = process.env.CCER_DAILY_SYNC;
  process.env.CCER_DAILY_SYNC = '0';
  scheduler.stopDailyScheduler();
  const off = await scheduler.startCeaAfterCloseScheduler();
  assertEqual(off, null, 'CCER_DAILY_SYNC=0 时不得启动收盘后增量');
  const st = scheduler.ceaAfterCloseStatus();
  assertEqual(st.env_allowed, false);
  assertEqual(st.scheduled, false);
  assertEqual(st.next_run_at, null, '未排程时不得假装有下一次运行时间');

  process.env.CCER_DAILY_SYNC = '1';
  process.env.CCER_CEA_AFTER_CLOSE = '0';
  const kill = await scheduler.startCeaAfterCloseScheduler();
  assertEqual(kill, null, 'CCER_CEA_AFTER_CLOSE=0 时不得启动');
  assertIncludes(String(scheduler.ceaAfterCloseStatus().env_kill_switch), 'CCER_CEA_AFTER_CLOSE=0');
  delete process.env.CCER_CEA_AFTER_CLOSE;
  if (saved === undefined) delete process.env.CCER_DAILY_SYNC; else process.env.CCER_DAILY_SYNC = saved;
  scheduler.stopDailyScheduler();
});

await testAsync('尾项7 后台改开关/时间后真实生效并显示下一次运行时间；stop 停掉所有定时器', async () => {
  const saved = process.env.CCER_DAILY_SYNC;
  process.env.CCER_DAILY_SYNC = '1';
  collect.saveCeaCollectConfig(ADMIN, { after_close_enabled: true, after_close_time: '16:30' });
  const started = await scheduler.startCeaAfterCloseScheduler();
  assertEqual(started, true, '启用后应真实排程');
  let st = scheduler.ceaAfterCloseStatus();
  assertEqual(st.scheduled, true);
  assert(st.next_run_at, '必须给出下一次运行时间（由真实定时器计算）');
  assertIncludes(st.next_run_beijing, '16:30（北京时间）');
  assertEqual(new Date(st.next_run_at).getUTCMinutes(), 30);

  // 动态改时间：保存后立即重排，下一次运行时间随之改变
  collect.saveCeaCollectConfig(ADMIN, { after_close_time: '23:59' });
  await scheduler.rescheduleCeaAfterClose();
  st = scheduler.ceaAfterCloseStatus();
  assertIncludes(st.next_run_beijing, '23:59（北京时间）');

  // 动态关开关：重排后不再有定时器
  collect.saveCeaCollectConfig(ADMIN, { after_close_enabled: false });
  await scheduler.rescheduleCeaAfterClose();
  st = scheduler.ceaAfterCloseStatus();
  assertEqual(st.scheduled, false);
  assertEqual(st.next_run_at, null);

  // 06:30 全平台更新仍按既有环境变量工作；stop 必须停掉所有定时器
  collect.saveCeaCollectConfig(ADMIN, { after_close_enabled: true, after_close_time: '16:30' });
  const full = scheduler.startDailyScheduler();
  assertEqual(full, true, '既有 06:30 调度不受影响');
  await new Promise((r) => setTimeout(r, 80)); // startDailyScheduler 内部异步排程，等其生效
  assertEqual(scheduler.ceaAfterCloseStatus().scheduled, true, '收盘后增量与 06:30 分开排程');
  scheduler.stopDailyScheduler();
  assertEqual(scheduler.ceaAfterCloseStatus().scheduled, false, 'stopDailyScheduler 必须停掉 CEA 定时器');
  if (saved === undefined) delete process.env.CCER_DAILY_SYNC; else process.env.CCER_DAILY_SYNC = saved;
});

/* ==================================================================== */
/*  尾项8：成本表单 P2 使用 CCER 独立报价                                */
/* ==================================================================== */

await testAsync('尾项8 无 CCER 行情时明确缺失（不给 CEA 价顶替）', async () => {
  db.run("DELETE FROM trade_daily WHERE market='CCER'");
  const out = await call('/api/v2/cea/scenario/ccer-quotes', { token: viewerToken });
  assertEqual(out.status, 200);
  assertEqual(out.json.available, false);
  assertEqual(out.json.quotes.length, 0);
  assert(out.json.missing_reason, '必须说明缺失原因');
  assertIncludes(out.json.note, '绝不返回 CEA 价格');
});

await testAsync('尾项8 P2 取 CCER 独立行情（日期/来源/口径/核验状态），不混入 CEA 价格', async () => {
  const now = new Date().toISOString();
  db.run("DELETE FROM trade_daily WHERE market='CCER'");
  const insSql = `INSERT INTO trade_daily (id,trade_date,trade_method,volume,turnover,avg_price,market,session_state,
       source_url,published_at,collected_at,verify_status,revision,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'CCER','traded',?,?,?,?,1,?,?)`;
  db.run(insSql, ['TD-CCER-1', '2026-09-29', '官方合计（未区分交易方式）', 14028, 1309265, 93.33,
    'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/20260929/163511321.shtml', now, now, 'verified', now, now]);
  db.run(insSql, ['TD-CCER-2', '2026-09-28', '官方合计（未区分交易方式）', 352, 31031.7, 88.16,
    'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/20260928/153545370.shtml', now, now, 'verified', now, now]);
  // CEA 行情（不同市场、不同口径）：绝不能出现在 P2 参考价里
  const ceaClose = db.get('SELECT close FROM cea_trade_daily ORDER BY trade_date DESC LIMIT 1')?.close;

  const out = await call('/api/v2/cea/scenario/ccer-quotes', { token: viewerToken });
  assertEqual(out.status, 200);
  assertEqual(out.json.available, true);
  assertEqual(out.json.market, 'CCER');
  assertEqual(out.json.quotes.length, 2);
  assertEqual(out.json.latest.trade_date, '2026-09-29');
  assertEqual(out.json.latest.avg_price, 93.33);
  assertIncludes(out.json.latest.source_url, 'ccer.com.cn');
  assertIncludes(out.json.quotes[0].caliber, '成交均价');
  assertEqual(out.json.quotes[0].verify_status, 'verified');
  assertEqual(out.json.computed_avg.value, Math.round((1309265 + 31031.7) / (14028 + 352) * 10000) / 10000);
  assertIncludes(out.json.computed_avg.caliber, '计算值');
  if (ceaClose !== undefined && ceaClose !== null) {
    assert(!out.json.quotes.some((q) => q.price === ceaClose), 'CCER 参考价中不得出现 CEA 收盘价');
  }
  assert(!out.json.quotes.some((q) => q.trade_date === REAL_TRADE_DATE), '不得混入 CEA 行情日期');
});

test('尾项8 前端源码：P2 用 CCER 接口且不再用 CEA 行情口径；研究资料状态不显示「现行正式」', () => {
  const src = readFileSync(join(ROOT, 'web', 'v2', 'modules', 'cea.js'), 'utf8');
  assertIncludes(src, '/api/v2/cea/scenario/ccer-quotes', 'P2 必须读取 CCER 独立行情接口');
  assertIncludes(src, 'P2 参考价只能来自 CCER 独立行情或手动输入', 'P2 提示必须说明来源限制');
  assertIncludes(src, '不会用 CEA 价格顶替 CCER 价格', '缺失时必须说明不做 CEA 顶替');
  assertIncludes(src, 'function docStatusChip', '研究资料状态必须走单独映射');
  assertIncludes(src, "'研究观点'", '研究观点状态');
  assertIncludes(src, "'已发布'", '已发布状态');
  const chipFn = src.slice(src.indexOf('function docStatusChip'), src.indexOf('function docStatusChip') + 700);
  assertIncludes(chipFn, 'isResearch', '研究类文件必须与政策文件分开判定');
  assert(!/isResearch[\s\S]{0,300}现行正式/.test(chipFn), '研究类文件不得显示「现行正式」');
});

/* ==================================================================== */
/*  尾项9：文件采集后的默认模型核验真实触发                              */
/* ==================================================================== */

await testAsync('尾项9 默认核验范围包含 CEA；采集后自动调用模型（本机桩模型真实 HTTP）', async () => {
  // 桩模型：真实 OpenAI 兼容端点
  const now = new Date().toISOString();
  db.run('UPDATE llm_provider SET enabled=0, use_content_verify=0');
  db.run('DELETE FROM llm_provider WHERE id=?', ['LLM-STUB-CEA']);
  db.run(
    `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,
       use_content_verify,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['LLM-STUB-CEA', '桩模型（CEA 自动核验）', 'openai_compatible', `${STUB}/v1`, 'stub-cea', 'CEA_TEST_KEY', 1,
      JSON.stringify(['127.0.0.1']), 1, now, now]
  );
  process.env.CCER_LLM_KEY_CEA_TEST_KEY = 'stub-secret';
  setRoute('/v1/chat/completions', { model: true, modelQuote: '全国碳排放权交易市场配额总量与分配方案' });

  assertEqual(verifySvc.verifyConfig().scopes.includes('cea'), true, '默认核验范围必须包含 cea');
  const provider = verifySvc.pickVerifyProvider(verifySvc.verifyConfig());
  assertEqual(provider?.id, 'LLM-STUB-CEA', '应选中桩模型');

  // 把一个 CEA 文件来源指向桩正文（>400 字，可判 full_text）
  const body = `<html><body><h1>全国碳排放权交易市场配额总量与分配方案</h1><p>${'本方案明确全国碳排放权交易市场配额总量与分配方案，适用于发电、钢铁、水泥、铝冶炼等行业。'.repeat(12)}</p></body></html>`;
  setRoute('/cea/doc', { status: 200, body, contentType: 'text/html' });
  pointCeaSource('cea_annual_work', '/cea/doc');

  const cfg = { ...collect.ceaCollectConfig(), auto_verify: true, request_timeout_ms: 5000, batch_budget_ms: 30000 };
  const out = await collect.collectCeaDocuments({ actor: 'test', trigger: 'manual', codes: ['cea_annual_work'], cfg, deadlineAt: Date.now() + 25000 });
  assertEqual(out.ok.length, 1, '应真实取得该文件正文');
  assert(out.verified, '采集后必须触发自动核验（out.verified）');
  assert(out.verified.attempts >= 1, `自动核验必须真的发起模型调用（attempts=${out.verified.attempts}）`);
  assert(callsTo('/v1/chat/completions').length >= 1, '桩模型端点必须收到真实 HTTP 请求');
  assert(modelPromptSeen, '模型请求体应被记录');
  assertIncludes(modelPromptSeen, '全国碳排放权交易市场', '模型请求必须携带真实正文证据');

  const doc = db.get('SELECT ai_status, ai_checked_at FROM cea_document WHERE doc_key=?', ['cea_annual_work_2026']);
  assert(doc, '文件应已入库');
  assert(['verified', 'insufficient', 'conflict'].includes(doc.ai_status), `核验后状态必须真实反映结论（实际 ${doc.ai_status}）`);
  assert(doc.ai_checked_at, '核验时间必须落库');
  const log = db.get("SELECT * FROM llm_call_log WHERE object_type='cea_document' ORDER BY at DESC LIMIT 1");
  assert(log, '模型调用必须有日志（真实 LLM 调用留痕）');
});

await testAsync('尾项9 未配置模型时不伪造 verified（保持 unverified 并说明）', async () => {
  db.run('UPDATE llm_provider SET enabled=0, use_content_verify=0');
  const cfg = { ...collect.ceaCollectConfig(), auto_verify: true, request_timeout_ms: 5000, batch_budget_ms: 20000 };
  resetRateLimit();
  const out = await collect.collectCeaDocuments({ actor: 'test', trigger: 'manual', codes: ['cea_carryover'], cfg, deadlineAt: Date.now() + 15000 });
  assertEqual(out.verified.provider_configured, false);
  assertEqual(out.verified.attempts, 0);
  assertIncludes(out.verified.note, '未配置可用模型');
});

/* ==================================================================== */

// 关闭测试用桩服务器与 HTTP 服务，避免句柄泄漏
await new Promise((r) => server.close(r));
await new Promise((r) => stub.close(r));

finish('36-v2-cea-dsh-fixes.test.mjs');
