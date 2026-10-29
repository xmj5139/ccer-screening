/**
 * 测试 110（docs/57）：真实联调修复的独立回归
 * ============================================================================
 * 临时库 + 本机回环桩；不访问真实 DeepSeek、不读取实际凭据、不部署。
 * 覆盖：
 *   1. CEA/CCER 空区间不生成 0 数据证据；有样本使用实际 MAX(trade_date)；
 *   2. “只看官方”允许官方联网结果、排除第三方；
 *   3. 工具上限后无工具 JSON 总结；复杂问题预算；截断有界重试一次；401 不重试；
 *   4. get_library_record 的公开文章/政策/因子范围；
 *   5. 视觉/工具/JSON 连接测试只标为鉴权与模型连接测试，并占用配额/写调用日志；
 *   6. Search/Fetch 路由仍返回真实能力测试字段。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish, PROJECT_ROOT,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const deepseek = await import('../src/services/deepseek-capability-svc.mjs');
const tools = await import('../src/services/tool-chat-svc.mjs');
const chat = await import('../src/services/chat-svc.mjs');

console.log('\n[v2-110] DeepSeek 真实联调修复独立回归');

process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
process.env.FIXTURE_DS_KEY = 'fixture-ds-key-110';
process.env.FIXTURE_SEARCH_KEY = 'fixture-search-key-110';

const at = new Date().toISOString();
const admin = { id: 'u-admin', name: 'independent-110', role: 'admin' };
const viewer = { id: 'u-viewer', name: 'viewer-110', role: 'viewer' };

/* ---------------- 本机回环桩：模型 / 搜索 / DeepSeek 能力 ---------------- */
let modelReplies = [];
let webResults = [];
const requests = [];
const webOfficial = {
  url: 'https://www.mee.gov.cn/policy-110.html',
  title: '生态环境部官方政策',
  summary: '官方公开摘要',
  date: '2026-10-15',
  publisher: '生态环境部',
};
const webThird = {
  url: 'https://third.example.com/repost-110.html',
  title: '第三方转载',
  summary: '第三方摘要',
  date: '2026-10-15',
  publisher: '第三方媒体',
};
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    requests.push({ path: req.url, method: req.method, body, headers: req.headers });
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (req.url === '/chat/completions') {
      const reply = modelReplies.shift() || { message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' };
      if (reply.status) return send(reply.status, reply.payload || { error: { message: 'fixture auth failure' } });
      return send(200, {
        choices: [{ message: reply.message || { role: 'assistant', content: reply.content ?? '' }, finish_reason: reply.finish_reason || 'stop' }],
        usage: reply.usage || { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    }
    if (req.url === '/search') return send(200, { results: webResults });
    if (req.url === '/v1/tools/search') {
      return send(200, {
        results: [{
          url: 'https://www.mee.gov.cn/search-110.html',
          title: '官方搜索结果',
          summary: '官方搜索摘要',
          date: '2026-10-15',
          site_name: '生态环境部',
        }],
      });
    }
    if (req.url === '/v1/tools/fetch') {
      return send(200, {
        title: '官方页面',
        content: '这是用于 Search/Fetch 真实能力测试的公开正文夹具。'.repeat(20),
      });
    }
    return send(404, { error: 'not found' });
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.CCER_DEEPSEEK_TEST_BASE = BASE;

/* ---------------- 模型配置、能力配置与搜索夹具 ---------------- */
db.run(
  `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ['LLM-110', '独立测试模型', 'openai_compatible', 'https://api.deepseek.com', 'deepseek-flash',
    'FIXTURE_DS_KEY', 1, '["api.deepseek.com"]', at, at]
);
deepseek.ensureDeepSeekDefaults();
deepseek.saveDeepSeekCapability(admin, 'chat_tools', {
  enabled: true, provider_id: 'LLM-110', daily_quota: 100, timeout_ms: 20000,
  config: {
    max_rounds: 4, max_tool_calls: 1, max_total_ms: 20000,
    max_output_tokens: 1000, thinking: 'disabled',
  },
});
deepseek.saveDeepSeekCapability(admin, 'json', {
  enabled: true, provider_id: 'LLM-110', daily_quota: 20, timeout_ms: 10000,
  config: { max_retry: 1, max_output_tokens: 2200, thinking: 'disabled' },
});

db.run(
  `INSERT INTO search_provider
    (id,name,provider_kind,base_url,search_path,http_method,auth_kind,credential_ref,param_map_json,response_map_json,
     timeout_ms,retry_max,daily_quota,calls_today,enabled,allowed_domains,is_fallback,fallback_priority,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['SRCH-110', '独立搜索夹具', 'generic_json', BASE, '/search', 'POST', 'bearer', 'FIXTURE_SEARCH_KEY',
    JSON.stringify({ query_field: 'query', count_field: 'count' }),
    JSON.stringify({
      results_path: 'results', url_field: 'url', title_field: 'title',
      snippet_field: 'summary', publisher_field: 'publisher', published_field: 'date',
    }),
    5000, 0, 100, 0, 1, '["127.0.0.1"]', 0, 0, at, at]
);

const llm = db.get("SELECT * FROM llm_provider WHERE id='LLM-110'");

/* ---------------- 1. 空区间日期与覆盖交易日 ---------------- */
await testAsync('CEA/CCER 空区间：evidence=[]、返回缺口、不把请求日期当数据日期', async () => {
  for (const market of ['cea', 'ccer']) {
    const out = await tools.executeTool('market_statistics', {
      market, from: '2035-10-19', to: '2035-10-19',
    }, {});
    assertEqual(out.ok, false, `${market} 空区间不应返回成功统计`);
    assertEqual(out.evidence.length, 0, `${market} 空区间必须 evidence=[]`);
    assertEqual(out.gap, 'no_market_rows');
    assertEqual(out.data.coverage.days, 0);
    assertEqual(out.data.coverage.to, null, '空区间不得产生未来数据日期');
    assertIncludes(out.summary, '覆盖交易日 0 个');
    assertIncludes(out.summary, '不补零');
  }
});

db.run(
  `INSERT INTO cea_trade_daily
    (id,trade_date,instrument,market_scope,price_regime,close,total_volume,total_turnover,parse_status,source_url,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['CEATD-110', '2026-10-15', 'CEA', 'national', 'CEA_COMPOSITE_2026', 96.93, 30005, 2908487.5,
    'ok', 'https://shyx.cneeex.com/fixture-110', at, at]
);
db.run(
  `INSERT INTO trade_daily
    (id,trade_date,trade_method,volume,turnover,avg_price,market,session_state,source_url,collected_at,verify_status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['TD-110', '2026-10-15', '挂牌协议', 30005, 2908487.5, 96.93, 'CCER', 'traded',
    'https://www.ccer.com.cn/fixture-110.shtml', at, 'verified', at, at]
);

await testAsync('CEA/CCER 有样本：使用实际 MAX(trade_date)，不用请求 to，并注明覆盖交易日', async () => {
  for (const market of ['cea', 'ccer']) {
    const out = await tools.executeTool('market_statistics', {
      market, from: '2026-10-01', to: '2035-10-19',
    }, {});
    assertEqual(out.ok, true, JSON.stringify(out));
    assertEqual(out.evidence.length, 1);
    assertEqual(out.evidence[0].published_at, '2026-10-15', `${market} 必须用实际 MAX(trade_date)`);
    assertEqual(out.data.coverage.days, 1);
    assertEqual(out.data.coverage.to, '2026-10-15');
    assertEqual(out.data.current.to, '2026-10-15');
    assertEqual(out.data.current.requested_to, '2035-10-19', '请求区间可以保留，但不能当作数据日期');
    assertIncludes(out.summary, '已入库覆盖 1 个交易日');
    assertIncludes(out.evidence[0].text, '已入库覆盖交易日 1 个');
    assert(!out.evidence[0].text.includes('数据至 2035'), '不得把请求 to 当作数据截至日期');
  }
});

/* ---------------- 2. 官方联网过滤 ---------------- */
await testAsync('“只看官方”：官方联网结果可引用，第三方仍排除', async () => {
  webResults = [webOfficial, webThird];
  const out = await tools.executeTool('web_search', { query: '碳市场政策', count: 2 }, { officialOnly: true });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.evidence.length, 1, '只应保留官方联网结果');
  assertEqual(out.evidence[0].url, webOfficial.url);
  assertEqual(out.evidence[0].source_display.kind, 'official');

  webResults = [webThird];
  const onlyThird = await tools.executeTool('web_search', { query: '碳市场政策', count: 1 }, { officialOnly: true });
  assertEqual(onlyThird.ok, false);
  assertEqual(onlyThird.evidence.length, 0, '第三方联网结果不能因 origin=web 被放行');
  assertEqual(onlyThird.gap, '没有官方联网结果');
});

/* ---------------- 3. get_library_record 公开范围 ---------------- */
db.run(
  `INSERT INTO policy_document
    (id,policy_key,title,category,doc_status,publish_date,official_url,body_snapshot,collected_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ['POL-110-OK', 'pol-110-ok', '2026 年度全国碳市场配额分配方案', 'allocation', 'effective',
    '2026-09-20', 'https://www.mee.gov.cn/policy-110.html',
    '全国碳市场配额分配方案明确 2026 年度发电行业配额总量为 1.2 亿吨。', at, at, at]
);
db.run(
  `INSERT INTO policy_document
    (id,policy_key,title,category,doc_status,official_url,duplicate_of,collected_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ['POL-110-DUP', 'pol-110-dup', '重复收录的政策副本', 'allocation', 'effective',
    'https://www.mee.gov.cn/policy-110-dup.html', 'POL-110-OK', at, at, at]
);

function insertContent(id, { isDemo = 0, duplicateOf = null, recordKind = 'article', processStatus = 'fetched' } = {}) {
  db.run(
    `INSERT INTO content_item
      (id,content_type,record_kind,title,publisher,published_at,discovered_at,source_url,url_hash,
       body_snapshot,body_availability,is_demo,duplicate_of,process_status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, 'industry_news', recordKind, `公开文章 ${id}`, '测试发布机构', '2026-10-15', at,
      `https://www.mee.gov.cn/${id}.html`, `hash-${id}`, `公开文章正文 ${id}`, 'full_text',
      isDemo, duplicateOf, processStatus, at, at]
  );
}
insertContent('CNT-110-OK');
insertContent('CNT-110-DEMO', { isDemo: 1 });
insertContent('CNT-110-DUP', { duplicateOf: 'CNT-110-OK' });
insertContent('CNT-110-FAIL', { processStatus: 'failed_fetch' });
insertContent('CNT-110-HOME', { recordKind: 'source_homepage' });

db.run(
  `INSERT INTO emission_factor
    (id,identity_key,source_identity,source_code,name,value,original_unit,category,caliber,data_year,version,
     publish_date,original_url,is_current,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['EF-110-CURRENT', 'ef-110-current', 'fixture-110', 'fixture', '全国电网平均排放因子',
    0.5703, 'kgCO2/kWh', 'national_average', '测试口径', 2026, '2026', '2026-01-01',
    'https://www.mee.gov.cn/factor-110.pdf', 1, at, at]
);
db.run(
  `INSERT INTO emission_factor
    (id,identity_key,source_identity,source_code,name,value,original_unit,category,caliber,data_year,version,
     publish_date,original_url,is_current,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['EF-110-HISTORY', 'ef-110-history', 'fixture-110', 'fixture', '历史排放因子',
    0.6101, 'kgCO2/kWh', 'national_average', '测试口径', 2024, '2024', '2024-01-01',
    'https://www.mee.gov.cn/factor-110-history.pdf', 0, at, at]
);

await testAsync('get_library_record：content 沿用公开文章范围，policy 排除 duplicate_of', async () => {
  const okContent = await tools.executeTool('get_library_record', { kind: 'content', id: 'CNT-110-OK' }, {});
  assertEqual(okContent.ok, true, JSON.stringify(okContent));
  assertEqual(okContent.evidence[0].kind, 'full_text');
  for (const id of ['CNT-110-DEMO', 'CNT-110-DUP', 'CNT-110-FAIL', 'CNT-110-HOME']) {
    const out = await tools.executeTool('get_library_record', { kind: 'content', id }, {});
    assertEqual(out.ok, false, `${id} 不应被当作公开文章证据`);
    assertEqual(out.evidence.length, 0);
  }
  const duplicatedPolicy = await tools.executeTool('get_library_record', { kind: 'policy', id: 'POL-110-DUP' }, {});
  assertEqual(duplicatedPolicy.ok, false, '政策重复副本不得通过详情工具读取');
});

await testAsync('get_library_record：因子数值是元数据，历史/占位因子不进入公开范围', async () => {
  const cur = await tools.executeTool('get_library_record', { kind: 'factor', id: 'EF-110-CURRENT' }, {});
  assertEqual(cur.ok, true, JSON.stringify(cur));
  assertEqual(cur.evidence[0].kind, 'metadata_only', '数值+单位不是原文正文，不能标 full_text');
  assertEqual(cur.evidence[0].text, null);
  assertIncludes(cur.evidence[0].snippet, '0.5703');
  assertIncludes(cur.evidence[0].snippet, 'kgCO2/kWh');
  const hist = await tools.executeTool('get_library_record', { kind: 'factor', id: 'EF-110-HISTORY' }, {});
  assertEqual(hist.ok, false, '历史/非当前因子必须与检索公开范围一致');
});

/* ---------------- 4. 工具上限后的 JSON 总结、截断重试、401 ---------------- */
function toolCall(id, name, args) {
  return {
    message: {
      role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      reasoning_content: '内部思考：先查库内政策。',
    },
    finish_reason: 'tool_calls',
  };
}
const validFinal = JSON.stringify({
  answerable: true,
  paragraphs: [{
    text: '2026 年度发电行业配额总量为 1.2 亿吨。',
    source_ids: ['policy:POL-110-OK'],
    quotes: [{ source_id: 'policy:POL-110-OK', quote: '2026 年度发电行业配额总量为 1.2 亿吨' }],
  }],
  note: '仅总结已有政策证据。',
});
const truncatedFinal = '{"answerable":true,"paragraphs":[{"text":"2026 年度发电行业配额总量为 1.2 亿吨。","source_ids":["policy:POL-110-OK"],"quotes":[{"source_id":"policy:POL-110-OK","quote":"2026 年度发电行业配额总量为 1.2 亿吨';

await testAsync('工具调用达上限：停止工具，无工具 JSON 总结；复杂问题预算 3200，截断只重试一次', async () => {
  requests.length = 0;
  modelReplies = [
    toolCall('call-110-1', 'search_library', { query: '2026 年度全国碳市场配额分配方案', limit: 2 }),
    { message: { role: 'assistant', content: truncatedFinal }, finish_reason: 'length', usage: { prompt_tokens: 500, completion_tokens: 1000, total_tokens: 1500 } },
    { message: { role: 'assistant', content: validFinal }, finish_reason: 'stop' },
  ];
  const out = await tools.runToolChat({
    provider: llm,
    question: '请统计 2026 年度全国碳市场配额总量，并与上年对比。',
    user: viewer,
    sessionId: 'session-110-tool',
    deadlineAt: Date.now() + 20000,
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.limit_reached, true);
  assertEqual(out.final_attempts, 2);
  assert(out.evidence.some((e) => e.source_id === 'policy:POL-110-OK'));

  const calls = requests.filter((r) => r.path === '/chat/completions');
  assertEqual(calls.length, 3, '工具调用 1 次 + 最终总结 1 次 + 截断重试 1 次');
  assert(Array.isArray(calls[0].body.tools), '第一轮应携带工具定义');
  assertEqual(calls[1].body.tools, undefined, '最终总结不得再携带工具');
  assertEqual(calls[1].body.response_format.type, 'json_object', '最终总结必须启用 JSON 模式');
  assert(calls[1].body.max_tokens >= 3200, '复杂统计问题应给足输出预算');
  assertEqual(calls[2].body.response_format.type, 'json_object');
  assert(calls[2].body.max_tokens > calls[1].body.max_tokens, '格式失败重试应适当增大输出预算');
  assertEqual(out.notes.join(' ').includes('无工具证据总结'), true);

  const verdict = chat.validateAnswer(out.final, out.evidence, { question: '2026 年度配额总量' });
  assertEqual(verdict.ok, true, JSON.stringify(verdict));
  const bad = JSON.parse(validFinal);
  bad.paragraphs[0].quotes[0].quote = '2026 年度发电行业配额总量为 9.9 亿吨';
  const badVerdict = chat.validateAnswer(bad, out.evidence, { question: '2026 年度配额总量' });
  assertEqual(badVerdict.ok, false, '最终答复仍必须走 chat-svc 逐字引用校验');
});

await testAsync('最终总结 401：鉴权失败不重试', async () => {
  requests.length = 0;
  modelReplies = [
    toolCall('call-110-2', 'search_library', { query: '2026 年度全国碳市场配额分配方案', limit: 1 }),
    { status: 401, payload: { error: { message: 'fixture auth failure' } } },
  ];
  const out = await tools.runToolChat({
    provider: llm,
    question: '2026 年度配额总量是多少？',
    user: viewer,
    sessionId: 'session-110-auth',
    deadlineAt: Date.now() + 20000,
  });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'http_error');
  const calls = requests.filter((r) => r.path === '/chat/completions');
  assertEqual(calls.length, 2, '工具 1 次 + 最终总结 401 1 次；鉴权失败不得重试');
});

/* ---------------- 5. 连接测试语义、配额、超时与调用日志 ---------------- */
await testAsync('视觉/工具/JSON 连接测试：只标鉴权与连通性，占配额并写调用日志', async () => {
  requests.length = 0;
  modelReplies = [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }];
  const logBefore = db.get("SELECT COUNT(*) n FROM llm_call_log WHERE purpose='deepseek_test_json'").n;
  const capBefore = deepseek.capabilityPublic('json').calls_today;
  const out = await deepseek.testDeepSeekBinding(admin, 'json', { deadlineAt: Date.now() + 10000 });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.test_scope, 'auth_and_model_connectivity');
  assertEqual(out.capability_verified, false);
  assertEqual(out.test_label, '鉴权与模型连接测试');
  assertEqual(out.real_call_performed, true);
  assertEqual(out.call_logged, true);
  assertEqual(out.callable, true);
  assertEqual(out.http_status, 200);
  const calls = requests.filter((r) => r.path === '/chat/completions');
  assertEqual(calls.length, 1);
  assertEqual(calls[0].body.max_tokens, 16, '连接测试使用最小文本 ping');
  assertEqual(calls[0].body.thinking.type, 'disabled');
  assertEqual(calls[0].body.tools, undefined, '连接测试不冒充工具能力验收');
  const logAfter = db.get("SELECT COUNT(*) n FROM llm_call_log WHERE purpose='deepseek_test_json'").n;
  assertEqual(logAfter, logBefore + 1, '连接测试必须写入 llm_call_log');
  const log = db.get("SELECT status,model FROM llm_call_log WHERE purpose='deepseek_test_json' ORDER BY at DESC LIMIT 1");
  assertEqual(log.status, 'ok');
  assertEqual(deepseek.capabilityPublic('json').calls_today, capBefore + 1, '连接测试必须消耗能力配额');
});

test('前端按钮区分真实能力测试与鉴权/连接测试', () => {
  const adminJs = readFileSync(join(PROJECT_ROOT, 'web/v2/modules/admin.js'), 'utf8');
  assertIncludes(adminJs, '鉴权与模型连接测试');
  assertIncludes(adminJs, 'capability_verified');
  assertIncludes(adminJs, '真实能力测试');
});

/* ---------------- 6. Search/Fetch 仍走真实能力测试路由 ---------------- */
const { server: appServer } = await import('../src/server.mjs');
await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
const appBase = `http://127.0.0.1:${appServer.address().port}`;
async function call(path, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(`${appBase}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

await testAsync('Search/Fetch 后台测试返回真实能力测试字段', async () => {
  const login = await call('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' },
  });
  assertEqual(login.status, 200, JSON.stringify(login.json));
  const token = login.json.token;
  for (const kind of ['search', 'fetch']) {
    requests.length = 0;
    const out = await call('/api/v2/admin/deepseek/test', { method: 'POST', token, body: { kind } });
    assertEqual(out.status, 200, `${kind}: ${JSON.stringify(out.json)}`);
    assertEqual(out.json.ok, true, `${kind} 应真实调用成功`);
    assertEqual(out.json.test_scope, 'capability');
    assertEqual(out.json.capability_verified, true);
    assertEqual(out.json.test_label, '真实能力测试');
  }
});

appServer.closeAllConnections?.();
await new Promise((resolve) => appServer.close(resolve));
stub.closeAllConnections?.();
await new Promise((resolve) => stub.close(resolve));
await new Promise((resolve) => setTimeout(resolve, 80));
finish('110-v2-deepseek-live-fixes-independent.test.mjs');
