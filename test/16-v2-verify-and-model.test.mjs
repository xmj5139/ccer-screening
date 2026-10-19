/**
 * v2.1 测试 16（重写）：模型配置真实连接测试 + 内容自动核验
 * ============================================================================
 * 本文件原为「AI 复核项目并生成人工任务」的测试。按 docs/19 第 2、47、75 条，
 * 人工复核/审批链路已整体取消，因此该文件重写为验证替代链路：
 *
 *   1. 模型配置的**真实连接测试**：区分「已配置」与「可调用」，并真的发出一次
 *      最短请求（用本机桩服务器承接，验证请求体、鉴权头与结果解析）。
 *   2. 内容自动核验：模型判一致 → verified；判矛盾 → conflict；
 *      调用失败 → unavailable；证据不足 → insufficient。
 *   3. **不再生成任何人工任务**：核验过程不得写入 review_task。
 *   4. 冲突不覆盖已有官方数值。
 *
 * 保留原有价值断言：私网地址被拒绝、凭据只存服务端且不回传浏览器。
 */
import { createServer } from 'node:http';
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const adminSvc = await import('../src/services/admin-v2-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

/* ==================================================================== */
/*  本机桩模型服务器（真实的 OpenAI 兼容响应结构）                        */
/* ==================================================================== */

let reply = '{"consistent":true,"confidence":0.9,"evidence_capability":"full_text","summary":"字段与正文一致","issues":[],"conflict_fields":[],"citations":[{"kind":"body","quote":"正文片段","locator":"第 1 段"}]}';
let mode = 'ok';
const seen = [];

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
    seen.push({ url: req.url, headers: req.headers, body: parsed });
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (mode === 'http500') return send(500, { error: { message: 'upstream error' } });
    if (mode === 'notjson') return send(200, '<html>oops</html>');
    return send(200, { choices: [{ message: { content: reply } }], usage: { total_tokens: 42 } });
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const MODEL_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

const admin = { role: 'admin', name: '测试管理员' };

/* ==================================================================== */
/*  一、模型配置校验（保留原有价值断言）                                  */
/* ==================================================================== */

test('本机模型配置保存成功且凭据从环境变量解析（不外传）', () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,
      allowed_domains,use_content_verify,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['model-test', '本地测试模型', 'ollama', `${MODEL_BASE}/v1/chat/completions`, 'test-model', 'TEST_KEY', 1, '[]', 0, now, now]
  );
  process.env.CCER_LLM_KEY_TEST_KEY = 'local-test-secret';
  const local = adminSvc.upsertLlmProvider(admin, {
    name: '本机配置测试', provider_kind: 'ollama',
    base_url: `${MODEL_BASE}/v1/chat/completions`, model: 'test-model', enabled: true,
    use_content_verify: true, allowed_domains: [],
  });
  assertEqual(local.ok, true, '本机 Ollama 配置应可保存');
  const listed = adminSvc.listLlmProviders().find((x) => x.id === local.id);
  assertEqual(listed.credential_configured, true, '凭据应解析成功');
  assert(!JSON.stringify(listed).includes('local-test-secret'), '列表不应回传凭据明文');
});

test('私网地址与非法协议被拒绝（防止把模型配置改成内网探测通道）', () => {
  const bad = adminSvc.upsertLlmProvider(admin, {
    name: '禁止私网', provider_kind: 'openai_compatible',
    base_url: 'http://192.168.1.8/v1/chat/completions', model: 'test', allowed_domains: ['192.168.1.8'],
  });
  assertEqual(bad.status, 400, '私网地址应被拒绝');
  const badProto = adminSvc.upsertLlmProvider(admin, {
    name: '禁止明文', provider_kind: 'openai_compatible',
    base_url: 'http://public.example.com/v1/chat/completions', model: 'test', allowed_domains: ['public.example.com'],
  });
  assertEqual(badProto.status, 400, '外部模型必须使用 HTTPS');
});

test('chatEndpoint 兼容「只填域名」与「已填完整路径」两种写法', () => {
  assertEqual(adminSvc.chatEndpoint({ base_url: 'https://api.deepseek.com', provider_kind: 'openai_compatible' }).url,
    'https://api.deepseek.com/chat/completions', 'DeepSeek 域名应补全为 /chat/completions');
  assertEqual(adminSvc.chatEndpoint({ base_url: 'https://api.openai.com/v1', provider_kind: 'openai_compatible' }).url,
    'https://api.openai.com/v1/chat/completions', '以 /v1 结尾应补 /chat/completions');
  assertEqual(adminSvc.chatEndpoint({ base_url: 'https://x.com/v1/chat/completions', provider_kind: 'openai_compatible' }).url,
    'https://x.com/v1/chat/completions', '已含完整路径应原样使用');
  assertEqual(adminSvc.chatEndpoint({ base_url: 'https://api.anthropic.com', provider_kind: 'anthropic' }).url,
    'https://api.anthropic.com/v1/messages', 'Anthropic 应补 /v1/messages');
});

test('未初始化主密钥时提交明文密钥被拒绝，并给出两条可操作路径', () => {
  const saved = process.env.CCER_SECRET_KEY;
  delete process.env.CCER_SECRET_KEY;
  const out = adminSvc.upsertLlmProvider(admin, {
    name: '明文密钥', provider_kind: 'openai_compatible',
    base_url: 'https://api.deepseek.com', model: 'x', allowed_domains: ['api.deepseek.com'],
    secret: 'sk-plaintext-must-not-be-saved',
  });
  assertEqual(out.status, 400, '无主密钥应拒绝保存明文');
  assertIncludes(out.message, '初始化本机主密钥', '应提示本机主密钥方案');
  assertIncludes(out.message, 'CCER_SECRET_KEY', '应提示环境变量方案');
  assert(!JSON.stringify(db.all('SELECT * FROM llm_provider')).includes('sk-plaintext-must-not-be-saved'),
    '数据库不应出现明文密钥');
  if (saved) process.env.CCER_SECRET_KEY = saved;
});

/* ==================================================================== */
/*  二、真实连接测试：已配置 ≠ 可调用                                     */
/* ==================================================================== */

await testAsync('真实连接测试：发出一条最短真实请求并区分 configured / callable', async () => {
  mode = 'ok';
  seen.length = 0;
  const created = adminSvc.upsertLlmProvider(admin, {
    name: '桩模型', provider_kind: 'openai_compatible',
    base_url: MODEL_BASE, model: 'stub-model', credential_ref: 'TEST_KEY',
    allowed_domains: ['127.0.0.1'], enabled: true, use_content_verify: true,
  });
  assertEqual(created.ok, true, '配置应可保存');
  const out = await adminSvc.testLlmProvider(admin, created.id);
  assertEqual(out.configured, true, '应判已配置');
  assertEqual(out.callable, true, '真实调用成功应判可调用');
  assertEqual(out.real_call_performed, true, '应真的发出请求');
  assertEqual(out.http_status, 200, 'HTTP 状态应为 200');
  assert(seen.length >= 1, '桩服务器应收到请求（说明请求真的发出了）');
  const req = seen[0];
  assertEqual(req.headers.authorization, 'Bearer local-test-secret', '鉴权头应正确');
  assert(Number.isInteger(req.body.max_tokens) && req.body.max_tokens > 0 && req.body.max_tokens <= 32,
    `应是短测试请求（max_tokens≤32），实际 ${req.body.max_tokens}`);
  assertEqual(req.body.model, 'stub-model', '应带上模型名');
  // 非 DeepSeek 供应商不得被强塞 thinking 参数
  assert(!('thinking' in req.body), '不应向不兼容的接口强行添加 thinking 参数');
  const row = db.get('SELECT last_test_result FROM llm_provider WHERE id=?', [created.id]);
  assertEqual(row.last_test_result, 'ok', '测试结果应写回数据库');
  const log = db.get("SELECT * FROM llm_call_log WHERE purpose='test' ORDER BY at DESC LIMIT 1");
  assert(log, '应写入调用日志（purpose=test）');
});

await testAsync('真实连接测试：模型返回 500 → 记为已配置但不可调用', async () => {
  mode = 'http500';
  const p = db.get("SELECT id FROM llm_provider WHERE name='桩模型'");
  const out = await adminSvc.testLlmProvider(admin, p.id);
  assertEqual(out.configured, true, '配置本身没问题');
  assertEqual(out.callable, false, '调用失败不应判可调用');
  assertEqual(out.http_status, 500, '应记录 HTTP 状态');
  assertIncludes(out.message, '不可调用', '应说明不可调用');
  const row = db.get('SELECT last_test_result FROM llm_provider WHERE id=?', [p.id]);
  assertEqual(row.last_test_result, 'failed', '应写回 failed');
  mode = 'ok';
});

await testAsync('真实连接测试：响应不是 JSON → 记为不可调用并说明原因', async () => {
  mode = 'notjson';
  const p = db.get("SELECT id FROM llm_provider WHERE name='桩模型'");
  const out = await adminSvc.testLlmProvider(admin, p.id);
  assertEqual(out.callable, false, '非 JSON 响应不应判可调用');
  assertIncludes(out.message, '合法 JSON', '应说明响应不是合法 JSON');
  mode = 'ok';
});

await testAsync('真实连接测试：未启用或用途未勾选 → 仅「已配置」，不发请求', async () => {
  seen.length = 0;
  const created = adminSvc.upsertLlmProvider(admin, {
    name: '未启用档', provider_kind: 'openai_compatible',
    base_url: MODEL_BASE, model: 'stub-model', credential_ref: 'TEST_KEY',
    allowed_domains: ['127.0.0.1'], enabled: false, use_content_verify: false,
  });
  const out = await adminSvc.testLlmProvider(admin, created.id);
  assertEqual(out.configured, false, '未启用应判未就绪');
  assertEqual(out.real_call_performed, false, '未就绪时不应发请求');
  assertEqual(seen.length, 0, '不应发出任何请求');
  assertIncludes(out.message, '配置未就绪', '应说明配置未就绪');
  const row = db.get('SELECT last_test_result FROM llm_provider WHERE id=?', [created.id]);
  assertEqual(row.last_test_result, 'configured_only', '应记为 configured_only');
});

/* ==================================================================== */
/*  三、自动核验：四态 + 引文可定位 + 不产生人工任务                     */
/* ==================================================================== */

const LONG = Array.from(
  { length: 60 },
  (_, i) => `第 ${i + 1} 节：公开正文内容，记录 CCER 项目公示与减排量登记的事实性描述，用于满足核验的正文长度要求。`
).join('\n');
/** 真实存在于正文中的可定位引文（模型引文必须能在证据中定位才会被采信） */
const REAL_QUOTE = '第 1 节：公开正文内容，记录 CCER 项目公示与减排量登记的事实性描述';

function mkItem(slug) {
  const item = content.upsertContent({
    content_type: 'research_report',
    title: `自动核验测试：${slug}`,
    publisher: '某研究所',
    published_at: '2026-09-20',
    source_url: `https://research.example.com/verify/${slug}`,
    body_snapshot: `${LONG}\n${slug} 专用正文标记。`,
    summary: '摘要',
  });
  db.run(
    `INSERT INTO content_source_link (id,content_item_id,url,url_hash,publisher,source_category,relation,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [`CSL-${slug}`, item.id, `https://other.example.cn/${slug}`, `hash-${slug}`, '另一来源', 'media', 'reference',
      new Date().toISOString()]
  );
  return item;
}

/** 让「桩模型」成为唯一可用于核验的模型 */
function useStubProvider() {
  db.run("UPDATE llm_provider SET enabled=0, use_content_verify=0 WHERE name<>'桩模型'");
  const p = db.get("SELECT id FROM llm_provider WHERE name='桩模型'");
  adminSvc.upsertLlmProvider(admin, { id: p.id, use_content_verify: true, enabled: true });
  verify.saveVerifyConfig(admin, { enabled: true, provider_id: p.id });
  return p.id;
}
useStubProvider();

await testAsync('模型判一致且引文可在证据中定位 → verified，且不产生任何人工任务', async () => {
  reply = JSON.stringify({
    consistent: true, confidence: 0.92, evidence_capability: 'full_text',
    summary: '字段与正文一致', issues: [], conflict_fields: [],
    citations: [{ kind: 'body', quote: REAL_QUOTE, locator: '第 1 段' }],
  });
  const before = db.get("SELECT COUNT(*) c FROM review_task WHERE status='pending'").c;
  const item = mkItem('verified');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'verified', `应判 verified，实际 ${out.result}（${out.summary || ''}）`);
  assertEqual(out.ui_state, 'auto_verified', '界面文案应为自动核验通过');
  assertEqual(out.label, '自动核验通过', '应返回统一的中文文案');
  assertEqual(out.citations_validated, 1, '可定位引文数应为 1');
  assertEqual(out.citations_rejected, 0, '不应有被过滤的引文');
  const after = db.get("SELECT COUNT(*) c FROM review_task WHERE status='pending'").c;
  assertEqual(after, before, '自动核验不得生成任何人工审核任务');
  const row = db.get("SELECT * FROM content_item WHERE id=?", [item.id]);
  assertEqual(row.verification_status, 'verified', '应回写冗余状态');
  assertEqual(row.process_status, 'verified_ok', '应回写处理状态');
  assertEqual(row.cross_source_verified, 0, '第二来源只有 URL 时不得标记为已完成跨来源验证');
});

await testAsync('伪引文降级：引文无法在证据中定位时不得判 verified', async () => {
  reply = JSON.stringify({
    consistent: true, confidence: 0.95, evidence_capability: 'full_text',
    summary: '看起来一致', issues: [], conflict_fields: [],
    citations: [{ kind: 'body', quote: '这段原文根本不存在于任何提供的证据里，属于模型编造的引用片段。', locator: '第 9 段' }],
  });
  const item = mkItem('fake-citation');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'insufficient', `伪引文应降级为 insufficient，实际 ${out.result}`);
  assertEqual(out.citations_rejected, 1, '应记录被过滤的引文数');
  assertIncludes(out.capability_note, '无法在提供的证据中定位', '应说明引文无法定位');
  const row = db.get('SELECT verification_status, citations_rejected FROM content_item WHERE id=?', [item.id]);
  assertEqual(row.verification_status, 'insufficient', '冗余状态应为 insufficient（不得盖已核验章）');
  assertEqual(row.citations_rejected, 1, '应回写被过滤引文数');
});

await testAsync('模型未提供可核对引文 → 同样不得判 verified', async () => {
  reply = JSON.stringify({
    consistent: true, confidence: 0.9, evidence_capability: 'full_text',
    summary: '无引文结论', issues: [], conflict_fields: [], citations: [],
  });
  const item = mkItem('no-citation');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'insufficient', `无引文不得判 verified，实际 ${out.result}`);
  assertIncludes(out.capability_note, '未提供可核对的原文引文', '应说明缺少可核对引文');
});

await testAsync('模型判矛盾 → conflict，冲突记录可检索但不覆盖官方数值', async () => {
  reply = JSON.stringify({
    consistent: false, confidence: 0.8, evidence_capability: 'full_text',
    summary: '方法学编号与正文不一致',
    issues: [{ field: 'methodology_id', kind: 'mismatch', reason: '正文写 CCER-10-002，字段写 CCER-10-001' }],
    conflict_fields: [{ field: 'methodology_id', values: [{ source: '结构化字段', value: 'CCER-10-001' }, { source: '正文', value: 'CCER-10-002' }], note: '编号冲突' }],
    citations: [{ kind: 'body', quote: 'CCER-10-002', locator: '第 3 段' }],
  });
  const item = mkItem('conflict');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'conflict', `应判 conflict，实际 ${out.result}`);
  assertEqual(out.ui_state, 'source_conflict', '界面文案应为来源冲突');
  assert(out.conflict_fields.length >= 1, '应记录冲突字段');
  const list = verify.listVerifications({ object_type: 'content_item', object_id: item.id });
  assert(list.length >= 1, '冲突记录应可检索');
  assertEqual(list[0].result, 'conflict', '检索结果应为 conflict');
});

await testAsync('模型调用失败 → unavailable（不阻断展示，可自动重试）', async () => {
  mode = 'http500';
  const item = mkItem('unavailable');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'unavailable', `应判 unavailable，实际 ${out.result}`);
  assertEqual(out.ui_state, 'not_verified', '界面文案应为暂未自动核验');
  assertEqual(out.reason, 'http_error', '应记录明确失败原因');
  assertIncludes(out.capability_note, '可稍后自动重试', '应说明可自动重试');
  const row = db.get('SELECT * FROM content_item WHERE id=?', [item.id]);
  assertEqual(row.verification_status, 'unavailable', '冗余状态应为 unavailable');
  mode = 'ok';
});

await testAsync('未配置可用模型 → unavailable 且说明未配置', async () => {
  db.run('UPDATE llm_provider SET enabled=0');
  const item = mkItem('no-model');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'unavailable', `应判 unavailable，实际 ${out.result}`);
  assertEqual(out.reason, 'no_provider', '原因应为 no_provider');
  assertIncludes(out.capability_note, '未配置可用模型', '应说明未配置模型');
  useStubProvider();
});

await testAsync('模型返回非法 JSON → unavailable（json_invalid）', async () => {
  reply = '这不是 JSON，只是一段普通文本。';
  const item = mkItem('badjson');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'unavailable', `应判 unavailable，实际 ${out.result}`);
  assertEqual(out.reason, 'json_invalid', '原因应为 json_invalid');
  reply = JSON.stringify({ consistent: true, evidence_capability: 'full_text', summary: 'ok', issues: [], conflict_fields: [], citations: [] });
});

await testAsync('模型 JSON 带 markdown 围栏也能解析（容错）', async () => {
  reply = '```json\n' + JSON.stringify({
    consistent: true, confidence: 0.7, evidence_capability: 'full_text',
    summary: '围栏 JSON 解析成功', issues: [], conflict_fields: [],
    citations: [{ kind: 'body', quote: REAL_QUOTE, locator: '第 1 段' }],
  }) + '\n```';
  const item = mkItem('fenced');
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'verified', `围栏 JSON 应能解析，实际 ${out.result}（${out.summary || ''}）`);
  assertEqual(out.summary, '围栏 JSON 解析成功', '应解析出模型摘要');
  const row = db.get('SELECT auto_summary, auto_summary_kind, summary FROM content_item WHERE id=?', [item.id]);
  assertEqual(row.auto_summary_kind, 'model', '模型摘要应以 auto_summary_kind=model 写回');
  assertEqual(row.summary, '摘要', '来源公开摘要不得被模型摘要覆盖');
});

await testAsync('缓存失效：模型从「未配置」变为「已配置」后必须能重试（不缓存 unavailable）', async () => {
  const item = mkItem('cache-retry');
  // 1) 先在没有可用模型的情况下核验 → unavailable
  db.run('UPDATE llm_provider SET enabled=0');
  const noModel = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(noModel.result, 'unavailable', '未配置模型应为 unavailable');
  assertEqual(noModel.reason, 'no_provider', '原因应为 no_provider');
  // 2) 配置模型后重试：相同内容必须重新计算，而不是命中旧的 unavailable 缓存
  reply = JSON.stringify({
    consistent: true, confidence: 0.9, evidence_capability: 'full_text',
    summary: '配置模型后重试成功', issues: [], conflict_fields: [],
    citations: [{ kind: 'body', quote: REAL_QUOTE, locator: '第 1 段' }],
  });
  useStubProvider();
  const retry = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(retry.cached, undefined, 'unavailable 不得被缓存复用');
  assertEqual(retry.result, 'verified', `配置模型后应真正调用模型并判 verified，实际 ${retry.result}`);
  // 3) 再跑一次：此时应命中缓存（同策略/模型/证据）
  const again = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(again.cached, true, '策略/模型/证据未变时应命中缓存（不重复调用模型）');
});

await testAsync('缓存失效：策略变化后 insufficient 会重算', async () => {
  const item = mkItem('policy-change');
  // 先用一个不可能满足的正文下限制造证据不足
  verify.saveVerifyConfig(admin, { enabled: true, min_body_chars: 100000 });
  const first = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(first.result, 'insufficient', `正文低于下限应判 insufficient，实际 ${first.result}`);
  // 放宽策略（下限恢复）→ 策略哈希变化 → 必须重算而不是复用 insufficient
  verify.saveVerifyConfig(admin, { enabled: true, min_body_chars: 400 });
  const second = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(second.cached, undefined, '策略变化后不得复用旧结论');
  assertEqual(second.result, 'verified', `策略放宽后应重算并判 verified，实际 ${second.result}`);
});

await testAsync('DeepSeek 端点关闭 thinking；其它供应商不加该参数', async () => {
  // 仅验证请求体构造（不发出真实请求）：DeepSeek 官方默认 thinking enabled，
  // 短结构化核验必须显式关闭，否则可能只返回 reasoning 而没有 JSON。
  const dsBody = verify.buildModelRequestBody(
    { base_url: 'https://api.deepseek.com', model: 'deepseek-chat' },
    'openai',
    { system: 's', user: 'u', maxTokens: 16 }
  );
  assertEqual(dsBody.thinking?.type, 'disabled', 'DeepSeek 应显式关闭 thinking');
  const otherBody = verify.buildModelRequestBody(
    { base_url: 'https://api.openai.com/v1', model: 'gpt-x' },
    'openai',
    { system: 's', user: 'u', maxTokens: 16 }
  );
  assert(!('thinking' in otherBody), '其它供应商不应被强塞 thinking 参数');
  assertEqual(verify.isDeepSeekEndpoint({ base_url: 'https://api.deepseek.com' }), true, '应识别 DeepSeek 官方端点');
  assertEqual(verify.isDeepSeekEndpoint({ base_url: 'https://api.openai.com' }), false, '不应把其它端点识别为 DeepSeek');
});

await testAsync('证据不足优先于模型可用性：仅有摘要时无需调用模型即判 insufficient', async () => {
  mode = 'ok';
  const item = content.upsertContent({
    content_type: 'institution_view',
    title: '仅有摘要的观点条目',
    publisher: '某咨询',
    published_at: '2026-09-20',
    source_url: 'https://paywall.example.com/only-abstract',
    summary: '只有公开摘要。',
    body_snapshot: '',
  });
  seen.length = 0;
  const out = await verify.verifyContentItem(item.id, { actor: 'test' });
  assertEqual(out.result, 'insufficient', `应判 insufficient，实际 ${out.result}`);
  assertEqual(seen.length, 0, '证据不足是确定性结论，不应浪费模型调用');
  assertIncludes(out.capability_note, '未读全文', '应说明未读全文');
});

await testAsync('核验记录含输入哈希、证据等级与引用（可追溯）', async () => {
  reply = JSON.stringify({
    consistent: true, confidence: 0.88, evidence_capability: 'full_text',
    summary: '可追溯性检查', issues: [], conflict_fields: [],
    citations: [{ kind: 'body', quote: REAL_QUOTE, locator: '第 2 段' }],
  });
  const item = mkItem('traceable');
  await verify.verifyContentItem(item.id, { actor: 'test' });
  const row = db.get(
    'SELECT * FROM verification_result WHERE object_id=? ORDER BY created_at DESC LIMIT 1',
    [item.id]
  );
  assert(!!row.input_hash && row.input_hash.length === 64, '应记录 sha256 输入哈希');
  assertEqual(row.input_hash_scheme, verify.INPUT_HASH_SCHEME, '应记录当前缓存键方案（策略+模型+证据）');
  assert(!!row.policy_hash, '应记录核验策略哈希');
  assert(!!row.evidence_hash, '应记录证据哈希');
  assert(!!row.model_key, '应记录模型键（provider::model）');
  assertEqual(row.evidence_level, 'full_text', '应记录证据等级');
  assertEqual(row.model_used, 1, '应标记确实调用了模型');
  assert(!!row.model, '应记录模型版本');
  const cites = JSON.parse(row.citations_json || '[]');
  assert(cites.length >= 1, '应保存引用证据');
  assertEqual(cites[0].validated, true, '保存的引文必须已在实际证据中定位');
  assert(!!row.created_at, '应记录核验时间');
});

await testAsync('自动核验不写入 ai_review_result（旧表仅作历史保留）', async () => {
  const before = db.get('SELECT COUNT(*) c FROM ai_review_result').c;
  const item = mkItem('no-legacy-write');
  await verify.verifyContentItem(item.id, { actor: 'test' });
  const after = db.get('SELECT COUNT(*) c FROM ai_review_result').c;
  assertEqual(after, before, '新版链路不应再写入旧的 ai_review_result 表');
});

test('模型用途开关含公开内容核验，且不再把「项目复核」当默认用途', () => {
  assert('use_content_verify' in adminSvc.LLM_PURPOSES, '用途列表应含公开内容自动核验');
  assertIncludes(adminSvc.LLM_PURPOSES.use_content_verify, '核验', '用途文案应说明核验');
  const status = adminSvc.llmStatus();
  assert(status.purposes.use_content_verify, '状态应包含内容核验用途');
  assertIncludes(status.note, '不需要任何人工确认环节', '应说明无人工确认环节');
});

await testAsync('只有元数据时模型不一致结论归为证据不足，不误标来源冲突', async () => {
  mode = 'ok';
  reply = JSON.stringify({consistent:false,summary:'未获取原文，无法确认',conflict_fields:['code_display'],citations:[]});
  const m = db.get("SELECT id FROM methodology_version WHERE document_status='formal' LIMIT 1");
  db.run('UPDATE methodology_version SET body_snapshot=NULL WHERE id=?',[m.id]);
  const r = await verify.verifyObject('methodology_version',m.id,{force:true});
  assertEqual(r.result,'insufficient');
});
stub.close();
finish('test/16-v2-ai-review.test.mjs');
