/**
 * 测试 96（docs/54 A/B）：DeepSeek 凭据引用、Search/Fetch 协议与回退
 * ============================================================================
 * 使用本机回环桩模拟官方 JSON 形状与故障码；**不访问真实 DeepSeek**，
 * 也不读取或打印任何真实凭据。测试只证明协议适配、预算/失败分类与回退接入。
 */
import { createServer } from 'node:http';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const search = await import('../src/services/search-svc.mjs');
const fetchSvc = await import('../src/services/web-fetch-svc.mjs');
const deepseek = await import('../src/services/deepseek-capability-svc.mjs');
const fallback = await import('../src/services/deepseek-fallback-svc.mjs');

console.log('\n[v2-96] DeepSeek 凭据引用 / Search / Fetch / 回退');

process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
process.env.DEEPSEEK_API_KEY = 'local-test-deepseek-key';
process.env.BOCHA_API_KEY = 'local-test-bocha-key';

/* ---------------- 回环桩：官方 JSON 形状 ---------------- */
const seen = [];
let searchMode = 'ok';
let fetchMode = 'ok';
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    seen.push({ method: req.method, url: req.url, body, headers: req.headers });
    const send = (code, payload, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (req.url === '/v1/tools/search') {
      if (searchMode === '402') return send(402, { error: { message: 'Insufficient Balance' } });
      if (searchMode === '302') return send(302, {}, { location: 'https://evil.example/search' });
      if (searchMode === '500') return send(500, { error: 'boom' });
      return send(200, {
        results: [
          {
            rerank_score: 2.4, title: 'CCER 方法学公开页', url: 'https://www.mee.gov.cn/a.html',
            snippet: '短摘要', summary: '长摘要：公开方法学信息。', content: '正文：这是 DeepSeek Search 返回的正文。',
            site_name: '生态环境部', date: '2026-09-30T00:00:00+00:00', authority: 3,
          },
        ],
      });
    }
    if (req.url === '/v1/tools/fetch') {
      if (fetchMode === '402') return send(402, { error: { message: 'Insufficient Balance' } });
      if (fetchMode === '404') return send(404, { error: { message: 'not found' } });
      return send(200, { title: '公开页面标题', content: '# 公开页面\n\n这是 DeepSeek Fetch 返回的 Markdown 正文。' });
    }
    if (req.url === '/search') {
      return send(500, { error: 'primary down' });
    }
    return send(404, { error: 'not found' });
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.CCER_DEEPSEEK_TEST_BASE = BASE;

const admin = { id: 'u-admin', name: 'admin-test', role: 'admin' };
const viewer = { id: 'u-viewer', name: 'viewer-test', role: 'viewer' };
const now = new Date().toISOString();

/* ---------------- 官方模型配置：只存凭据引用 ---------------- */
db.run(
  `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,
    use_content_verify,use_qa_draft,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['LLM-DS-96', '官方 DeepSeek', 'openai_compatible', 'https://api.deepseek.com', 'deepseek-flash',
    'DEEPSEEK_API_KEY', 1, '["api.deepseek.com"]', 1, 1, now, now]
);
db.run(
  `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ['LLM-AGENT-96', '某代理商接口', 'openai_compatible', 'https://api.agent.example.com/v1', 'deepseek-flash',
    'AGENT_KEY', 1, '["api.agent.example.com"]', now, now]
);
process.env.AGENT_KEY = 'should-never-be-forwarded';

const defaults = deepseek.ensureDeepSeekDefaults();
assertEqual(defaults.created.length, 2, '存在官方模型时应自动创建 Search/Fetch 两套 fallback 配置');
assertEqual(defaults.created.every((x) => x.kind === 'search' || x.kind === 'fetch'), true);
const autoSearch = db.get("SELECT * FROM search_provider WHERE id='DS-SEARCH-AUTO'");
const autoFetch = db.get("SELECT * FROM web_fetch_connection WHERE id='DS-FETCH-AUTO'");
assert(autoSearch && autoFetch, '应生成固定的备用连接 ID');
assertEqual(autoSearch.provider_id, 'LLM-DS-96');
assertEqual(autoSearch.credential_cipher, null, '不得把模型密钥密文复制到搜索表');
assertEqual(autoFetch.credential_cipher, null, '不得把模型密钥密文复制到抓取表');
assertEqual(autoSearch.is_fallback, 1, '自动生成连接应为 fallback，不替换主服务');
assertEqual(autoFetch.is_fallback, 1);

test('重复初始化不会生成重复连接，且不覆盖既有配置', () => {
  db.run('UPDATE search_provider SET note=? WHERE id=?', ['人工修改保持', 'DS-SEARCH-AUTO']);
  const again = deepseek.ensureDeepSeekDefaults();
  assertEqual(again.created.length, 0);
  assertEqual(db.get('SELECT COUNT(*) n FROM search_provider')?.n, 1);
  assertEqual(db.get('SELECT note FROM search_provider WHERE id=?', ['DS-SEARCH-AUTO']).note, '人工修改保持');
});

test('凭据通过 provider_id 解析；轮换环境变量后自动使用新值', () => {
  const before = deepseek.resolveCapabilityCredential(autoSearch);
  assertEqual(before.ok, true);
  assertEqual(before.via, 'provider_id');
  assertEqual(before.secret, 'local-test-deepseek-key');
  process.env.DEEPSEEK_API_KEY = 'rotated-test-key';
  const after = deepseek.resolveCapabilityCredential(db.get("SELECT * FROM search_provider WHERE id='DS-SEARCH-AUTO'"));
  assertEqual(after.secret, 'rotated-test-key', '模型 Key 轮换后引用应自动使用新值');
  assertEqual(after.provider.id, 'LLM-DS-96');
});

test('不得绑定代理商 / 非官方接口配置', () => {
  const out = deepseek.saveDeepSeekCapability(admin, 'vision', { provider_id: 'LLM-AGENT-96' });
  assert(out.error, '非官方配置应被拒绝');
  assertIncludes(out.error, 'api.deepseek.com');
});

test('能力配置写操作 admin-only', () => {
  const out = deepseek.saveDeepSeekCapability(viewer, 'vision', { enabled: true });
  assertEqual(out.status, 403);
});

test('后台概览不返回任何凭据明文或密文', () => {
  const s = JSON.stringify(deepseek.deepseekOverview());
  assert(!s.includes('local-test-deepseek-key'), '概览不得包含凭据明文');
  assert(!s.includes('rotated-test-key'), '概览不得包含轮换后的凭据明文');
  assert(!s.includes('credential_cipher'), '概览不得包含密文字段');
});

/* ---------------- Search / Fetch 协议 ---------------- */
function configureDeepSeekConnections() {
  db.run(
    `INSERT OR REPLACE INTO search_provider
      (id,name,provider_kind,base_url,search_path,http_method,auth_kind,credential_ref,param_map_json,response_map_json,
       timeout_ms,retry_max,daily_quota,calls_today,enabled,allowed_domains,provider_id,is_fallback,fallback_priority,
       created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
    ['SRCH-DS-96', 'DeepSeek Search 桩', 'deepseek_search', 'https://api.deepseek.com', '/v1/tools/search',
      'POST', 'bearer', null, '{}', '{}', 15000, 1, 100, 1, '["api.deepseek.com"]', 'LLM-DS-96', 1, 50, now, now]
  );
  db.run(
    `INSERT OR REPLACE INTO web_fetch_connection
      (id,name,conn_kind,base_url,endpoint_path,http_method,auth_kind,credential_ref,param_map_json,response_map_json,
       timeout_ms,retry_max,daily_quota,calls_today,enabled,allowed_domains,provider_id,is_fallback,fallback_priority,
       created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
    ['WFC-DS-96', 'DeepSeek Fetch 桩', 'deepseek_fetch', 'https://api.deepseek.com', '/v1/tools/fetch',
      'POST', 'bearer', null, '{}', '{}', 15000, 1, 100, 1, '["api.deepseek.com"]', 'LLM-DS-96', 1, 50, now, now]
  );
}
configureDeepSeekConnections();

test('请求构造：固定官方端点、Bearer、query 截断到 128、count 夹到 1—50', () => {
  const p = db.get("SELECT * FROM search_provider WHERE id='SRCH-DS-96'");
  const req = search.buildSearchRequest(p, '碳'.repeat(300), { count: 999, raw_content: true });
  assertEqual(req.url, `${BASE}/v1/tools/search`);
  assertEqual(req.headers.authorization, 'Bearer rotated-test-key');
  assert(req.body.query.length <= 128);
  assertEqual(req.body.count, 20, 'count 应被能力配置的 max_count=20 夹住（仍不超过官方 50）');
  assert(req.body.count >= 1 && req.body.count <= 50);
  assertEqual(req.body.need_content, true);
  assertEqual(req.body.query.includes('\uFFFD'), false, '截断不能产生无效 Unicode');
});

await testAsync('Search 官方响应适配：results 字段归一化，摘要与正文分开', async () => {
  searchMode = 'ok';
  const p = db.get("SELECT * FROM search_provider WHERE id='SRCH-DS-96'");
  const out = await search.runSearch(p, 'CCER 方法学', { count: 5, raw_content: true });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.results.length, 1);
  const r = out.results[0];
  assertEqual(r.title, 'CCER 方法学公开页');
  assertEqual(r.snippet, '长摘要：公开方法学信息。');
  assertEqual(r.raw_content, '正文：这是 DeepSeek Search 返回的正文。');
  assertEqual(r.published_at, '2026-09-30');
  assertEqual(r.publisher, '生态环境部');
  assertEqual(r.content_kind, 'full_text');
  const req = seen[seen.length - 1];
  assertEqual(req.headers.authorization, 'Bearer rotated-test-key');
  assertEqual(req.body.need_content, true);
});

await testAsync('Fetch 官方响应适配：title/content；目标 URL 放入 JSON body', async () => {
  fetchMode = 'ok';
  const c = db.get("SELECT * FROM web_fetch_connection WHERE id='WFC-DS-96'");
  const out = await fetchSvc.fetchUrlContent(c, 'https://www.mee.gov.cn/a.html', {});
  assertEqual(out.ok, true, JSON.stringify(out));
  assertIncludes(out.content, 'DeepSeek Fetch 返回');
  assertEqual(out.availability, 'partial');
  assertEqual(out.conn_kind, 'deepseek_fetch');
  const req = seen[seen.length - 1];
  assertEqual(req.url, '/v1/tools/fetch');
  assertEqual(req.body.url, 'https://www.mee.gov.cn/a.html');
});

await testAsync('私网 / metadata / 带凭据的抓取目标在发请求前拒绝', async () => {
  const c = db.get("SELECT * FROM web_fetch_connection WHERE id='WFC-DS-96'");
  const countBefore = seen.length;
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://user:pass@example.com/a',
    'file:///etc/passwd',
    'http://10.0.0.5/internal',
  ]) {
    const out = await fetchSvc.fetchUrlContent(c, url, {});
    assertEqual(out.ok, false, `${url} 应被拒绝`);
    assert(['blocked_url', 'bad_url'].includes(out.reason), `${url} 应以 blocked_url/bad_url 拒绝，实际 ${out.reason}`);
  }
  assertEqual(seen.length, countBefore, '被拒绝的目标不能发出任何请求');
});

await testAsync('3xx 不跟随：不把 Authorization 带给其它 host，也不重试', async () => {
  searchMode = '302';
  const p = db.get("SELECT * FROM search_provider WHERE id='SRCH-DS-96'");
  const before = seen.length;
  const out = await search.runSearch(p, 'redirect test', { count: 1 });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'redirect_blocked');
  assertEqual(seen.length, before + 1, '重定向不应自动跟随/重试');
  searchMode = 'ok';
});

await testAsync('402 停止当日预算调用，后续不再发请求', async () => {
  db.run("UPDATE deepseek_capability SET budget_stopped_date=NULL WHERE kind='search'");
  searchMode = '402';
  const p = db.get("SELECT * FROM search_provider WHERE id='SRCH-DS-96'");
  const out = await search.runSearch(p, 'budget test', { count: 1 });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'budget_exhausted');
  const before = seen.length;
  searchMode = 'ok';
  const out2 = await search.runSearch(p, 'budget test 2', { count: 1 });
  assertEqual(out2.ok, false);
  assertEqual(out2.reason, 'budget_stopped');
  assertEqual(seen.length, before, '402 后当日不应再发请求');
  assertEqual(deepseek.capabilityPublic('search').budget_stopped_today, true);
  db.run("UPDATE deepseek_capability SET budget_stopped_date=NULL WHERE kind='search'");
});

await testAsync('主服务失败后尝试备用并另记：同一 URL 只算一条证据', async () => {
  searchMode = '500';
  db.run(
    `INSERT OR REPLACE INTO search_provider
      (id,name,provider_kind,base_url,search_path,http_method,auth_kind,credential_ref,param_map_json,response_map_json,
       timeout_ms,retry_max,daily_quota,calls_today,enabled,allowed_domains,is_fallback,fallback_priority,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,
    ['SRCH-PRIMARY-96', '主搜索（故障桩）', 'bocha', BASE, '/search', 'POST', 'bearer', 'BOCHA_API_KEY',
      JSON.stringify({ query_field: 'query', count_field: 'count' }),
      JSON.stringify({ results_path: 'data.webPages.value', url_field: 'url', title_field: 'name', snippet_field: 'summary', business_code_field: 'code', business_code_ok: 200 }),
      5000, 0, 100, 1, '["127.0.0.1"]', 0, 10, now, now]
  );
  // 确保主服务排在备用前（自动行 is_fallback=1）
  searchMode = 'ok';
  const out = await fallback.runSearchWithFallback('CCER 公开方法学', { attempts: 2 });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.fallback_used, true);
  assertEqual(out.attempts.length, 2);
  assertEqual(out.attempts[0].ok, false);
  assertEqual(out.attempts[1].ok, true);
  assertIncludes(out.notes.join(' '), '备用');
  assertEqual(out.results.length, 1, '同一 URL 只保留一条证据');
  assertEqual(out.results[0].also_from.length, 0, '不同通道没有返回同 URL 时不应伪造多源');
});

await testAsync('抓取统计与最近成功时间被记录', async () => {
  const row = db.get("SELECT * FROM web_fetch_connection WHERE id='WFC-DS-96'");
  assert(row.total_calls > 0, '应记录总调用次数');
  assert(row.total_success > 0, '应记录成功次数');
  assert(row.last_success_at, '应记录最近成功时间');
});

stub.closeAllConnections?.();
await new Promise((resolve) => stub.close(resolve));
// 让 Windows 上的 libuv 完成关闭句柄后再退出，避免“UV_HANDLE_CLOSING”断言。
await new Promise((resolve) => setTimeout(resolve, 80));
finish('96-v2-deepseek-capability.test.mjs');
