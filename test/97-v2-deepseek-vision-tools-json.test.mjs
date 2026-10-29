/**
 * 测试 97（docs/54 C/D/E）：视觉逐页、Files 生命周期、工具问答与 JSON 加固
 * ============================================================================
 * 全部使用本机回环桩与注入 renderer；不调用真实模型、不上传真实图片。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db, dir } = ctx;
const deepseek = await import('../src/services/deepseek-capability-svc.mjs');
const structured = await import('../src/services/structured-model-svc.mjs');
const vision = await import('../src/services/vision-svc.mjs');
const toolChat = await import('../src/services/tool-chat-svc.mjs');
const chat = await import('../src/services/chat-svc.mjs');

console.log('\n[v2-97] 视觉 / Files / 工具问答 / JSON 可靠性');

process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
process.env.DEEPSEEK_API_KEY = 'local-test-deepseek-key-97';

/* ---------------- 模型 / Files 回环桩 ---------------- */
let replies = [];
let modelStatus = 200;
let fileStatus = 200;
let deleteStatus = 200;
const modelCalls = [];
const fileCalls = [];
const deleteCalls = [];
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (req.url === '/files' && req.method === 'POST') {
      fileCalls.push({ url: req.url, headers: req.headers, bytes: raw.length });
      if (fileStatus !== 200) return send(fileStatus, { error: { message: 'upload failed' } });
      return send(200, {
        id: `file-api-test-${fileCalls.length}`, object: 'file', bytes: 8,
        created_at: Math.floor(Date.now() / 1000), filename: 'page.png', purpose: 'user_data',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    if (req.url.startsWith('/files/') && req.method === 'DELETE') {
      deleteCalls.push(req.url);
      if (deleteStatus !== 200) return send(deleteStatus, { error: { message: 'delete failed' } });
      return send(200, { id: req.url.split('/').pop(), object: 'file', deleted: true });
    }
    if (req.url === '/chat/completions') {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      modelCalls.push({ body, headers: req.headers });
      if (modelStatus !== 200) return send(modelStatus, { error: { message: 'model failure' } });
      const reply = replies.shift() || { content: '{}' };
      return send(200, {
        choices: [{ message: reply.message || { role: 'assistant', content: reply.content ?? '' }, finish_reason: reply.finish_reason || 'stop' }],
        usage: reply.usage || { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
      });
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
db.run(
  `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,
    use_content_verify,use_qa_draft,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['LLM-DS-97', '官方 DeepSeek 97', 'openai_compatible', 'https://api.deepseek.com', 'deepseek-flash',
    'DEEPSEEK_API_KEY', 1, '["api.deepseek.com"]', 1, 1, now, now]
);
const provider = db.get("SELECT * FROM llm_provider WHERE id='LLM-DS-97'");
deepseek.saveDeepSeekCapability(admin, 'chat_tools', {
  enabled: true, provider_id: 'LLM-DS-97', daily_quota: 100, timeout_ms: 30000,
  config: { max_rounds: 3, max_tool_calls: 4, max_total_ms: 30000, max_output_tokens: 1200, thinking: 'enabled', reasoning_effort: 'high' },
});
deepseek.saveDeepSeekCapability(admin, 'vision', {
  enabled: true, provider_id: 'LLM-DS-97', daily_quota: 100, timeout_ms: 30000,
  config: { model: 'deepseek-flash', max_pages_per_doc: 3, max_image_bytes: 1048576, dpi: 144, files_reuse: false, thinking: 'disabled' },
});
deepseek.saveDeepSeekCapability(admin, 'json', {
  enabled: true, config: { max_retry: 1, max_output_tokens: 2200, thinking: 'disabled' },
});

/* ---------------- 结构化 JSON 可靠性 ---------------- */
await testAsync('JSON 空 content：只重试一次，第二次增大输出预算并使用 json_object', async () => {
  replies = [
    { message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
    { message: { role: 'assistant', content: '{"summary":"中文摘要 ✅"}' }, finish_reason: 'stop' },
  ];
  const before = modelCalls.length;
  const out = await structured.callStructuredModel({
    provider, prompt: '请输出 json 摘要', systemPrompt: '只输出 JSON：{"summary":"..."}',
    requiredFields: { summary: { type: 'string', min: 1, max: 100 } },
    purpose: 'test_json', maxTokens: 200, thinking: 'disabled',
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.attempts, 2);
  assertEqual(out.retry_count, 1);
  const calls = modelCalls.slice(before);
  assertEqual(calls.length, 2);
  assertEqual(calls[0].body.response_format.type, 'json_object');
  assertEqual(calls[0].body.thinking.type, 'disabled');
  assert(calls[1].body.max_tokens > calls[0].body.max_tokens, '重试应适当增大输出预算');
  assertIncludes(JSON.stringify(calls[0].body), 'json');
  assertEqual(out.parsed.summary, '中文摘要 ✅', 'Unicode 必须原样保留');
});

await testAsync('JSON 截断（finish_reason=length）：重试一次后成功；不会无界续写', async () => {
  replies = [
    { message: { role: 'assistant', content: '{"summary":"被截断' }, finish_reason: 'length' },
    { message: { role: 'assistant', content: '{"summary":"完整摘要"}' }, finish_reason: 'stop' },
  ];
  const before = modelCalls.length;
  const out = await structured.callStructuredModel({
    provider, prompt: 'json 摘要', systemPrompt: '只输出 JSON', requiredFields: { summary: { type: 'string', min: 1 } },
    purpose: 'test_json', maxTokens: 200, thinking: 'disabled',
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(modelCalls.length - before, 2);
});

await testAsync('JSON 401：不盲目重试', async () => {
  modelStatus = 401;
  const before = modelCalls.length;
  const out = await structured.callStructuredModel({
    provider, prompt: 'json 摘要', systemPrompt: '只输出 JSON', requiredFields: { summary: { type: 'string' } },
    purpose: 'test_json', maxTokens: 100,
  });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'http_error');
  assertEqual(modelCalls.length - before, 1, '401 不应重试');
  modelStatus = 200;
});

test('JSON 校验拒绝空字段、错误类型与超长字段', () => {
  assertEqual(structured.validateStructured({ summary: '' }, { summary: { type: 'string', min: 1 } }).reason, 'invalid_fields');
  assertEqual(structured.validateStructured({ summary: 3 }, { summary: { type: 'string' } }).reason, 'invalid_fields');
  assertEqual(structured.validateStructured({}, { summary: { type: 'string' } }).reason, 'missing_fields');
});

/* ---------------- 视觉与 Files ---------------- */
const pdfDir = join(dir, 'official-originals');
mkdirSync(pdfDir, { recursive: true });
const pdfPath = join(pdfDir, 'vision-test.pdf');
writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n% test fixture\n'));
const docHash = createHash('sha256').update(Buffer.from('%PDF-1.4\n% test fixture\n')).digest('hex');
db.run(
  `INSERT INTO policy_document (id,policy_key,title,category,doc_status,publish_date,official_url,body_snapshot,local_path,original_file_hash,collected_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['POL-VISION-97', 'pol-vision-97', '视觉测试文档', 'management', 'effective', '2026-09-01',
    'https://www.mee.gov.cn/vision-test.html', '原有正文。', pdfPath, docHash, now, now, now]
);
const fakePng = Buffer.from('fake-png-bytes-97');
const fakeHash = createHash('sha256').update(fakePng).digest('hex');
const renderer = async () => ({ ok: true, buffer: fakePng, bytes: fakePng.length, page: 1, image_hash: fakeHash, pages_total: 2, tool: 'stub-pdftoppm' });

await testAsync('视觉补充分页：结构化文字/表格/限制写入并接回正文，不标成官方事实', async () => {
  replies = [{ message: { role: 'assistant', content: JSON.stringify({ page_number: 1, text: '第 1 页可见文字 2026', tables: [{ caption: '表1', rows: [['项目', '数值'], ['配额', '1.2 亿吨']] }], limitations: ['小字可能不清'], confidence: 0.82 }) }, finish_reason: 'stop' }];
  const out = await vision.visionSupplementPage({
    kind: 'policy_document', id: 'POL-VISION-97', page: 1, filePath: pdfPath, docHash,
    title: '视觉测试文档', actor: 'admin-test', apply: true, renderer,
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.image_hash, fakeHash);
  assertEqual(out.tables.length, 1);
  assert(out.limitations.length >= 1);
  assertEqual(out.official_fact, false);
  const row = db.get('SELECT * FROM deepseek_vision_page WHERE doc_hash=? AND page=1', [docHash]);
  assertEqual(row.status, 'ok');
  assertEqual(row.applied, 1);
  assertEqual(row.image_hash, fakeHash);
  const doc = db.get("SELECT body_snapshot FROM policy_document WHERE id='POL-VISION-97'");
  assertIncludes(doc.body_snapshot, '第 1 页可见文字');
  assertIncludes(doc.body_snapshot, '视觉模型补充');
  assertIncludes(doc.body_snapshot, '1.2 亿吨');
});

await testAsync('页图工具缺失：如实 blocked，不写正文、不伪造已解析', async () => {
  const noTool = async () => ({ ok: false, reason: 'pdf_tool_missing', error: '未安装 pdftoppm（Poppler）', bytes: 0 });
  const out = await vision.visionSupplementPage({
    kind: 'policy_document', id: 'POL-VISION-97', page: 2, filePath: pdfPath, docHash,
    title: '视觉测试文档', actor: 'admin-test', apply: true, renderer: noTool,
  });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'pdf_tool_missing');
  const row = db.get("SELECT * FROM deepseek_vision_page WHERE doc_hash=? AND page=2", [docHash]);
  assertEqual(row.status, 'blocked');
  assertIncludes(row.error, 'pdftoppm');
});

await testAsync('视觉成功后才允许 Files 复用；第二次同图使用缓存 file_id', async () => {
  deepseek.saveDeepSeekCapability(admin, 'vision', {
    enabled: true, provider_id: 'LLM-DS-97',
    config: { files_reuse: true, file_ttl_seconds: 3600, max_pages_per_doc: 3, max_image_bytes: 1048576 },
  });
  replies = [
    { message: { role: 'assistant', content: JSON.stringify({ page_number: 1, text: 'Files 复用页 A', tables: [], limitations: [], confidence: 0.7 }) }, finish_reason: 'stop' },
    { message: { role: 'assistant', content: JSON.stringify({ page_number: 1, text: 'Files 复用页 B', tables: [], limitations: [], confidence: 0.7 }) }, finish_reason: 'stop' },
  ];
  const before = fileCalls.length;
  const first = await vision.visionSupplementPage({
    kind: 'policy_document', id: 'POL-VISION-97', page: 1, filePath: pdfPath, docHash,
    title: '视觉测试文档', actor: 'admin-test', apply: false, renderer,
  });
  const second = await vision.visionSupplementPage({
    kind: 'policy_document', id: 'POL-VISION-97', page: 1, filePath: pdfPath, docHash,
    title: '视觉测试文档', actor: 'admin-test', apply: false, renderer,
  });
  assertEqual(first.ok, true, JSON.stringify(first));
  assertEqual(second.ok, true, JSON.stringify(second));
  assertEqual(fileCalls.length - before, 1, '同一图片 hash + 同一凭据归属应复用 file_id');
  assertEqual(second.files.reused, true);
  const lastCall = modelCalls[modelCalls.length - 1].body;
  const imagePart = lastCall.messages[1].content.find((x) => x.type === 'file' || x.type === 'image_url');
  assertEqual(imagePart.type, 'file', '复用时应使用 file 内容块');
  assertIncludes(imagePart.file_id, 'file-api-test');
});

await testAsync('过期 Files 清理：删除远端后标记本地记录', async () => {
  db.run("UPDATE deepseek_file_cache SET expires_at='2000-01-01T00:00:00.000Z'");
  const out = await deepseek.cleanupExpiredFiles({ limit: 5 });
  assertEqual(out.scanned >= 1, true);
  assertEqual(deleteCalls.length >= 1, true);
  const row = db.get('SELECT status FROM deepseek_file_cache LIMIT 1');
  assertEqual(row.status, 'deleted');
});

await testAsync('视觉额度/单文档页数上限阻止继续调用', async () => {
  deepseek.saveDeepSeekCapability(admin, 'vision', {
    enabled: true, provider_id: 'LLM-DS-97',
    config: { files_reuse: false, max_pages_per_doc: 1, max_image_bytes: 1048576 },
  });
  const before = modelCalls.length;
  const out = await vision.visionSupplementPage({
    kind: 'policy_document', id: 'POL-VISION-97', page: 2, filePath: pdfPath, docHash,
    title: '视觉测试文档', actor: 'admin-test', apply: false, renderer,
  });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'doc_page_limit');
  assertEqual(modelCalls.length, before);
});

/* ---------------- 工具化多轮问答 ---------------- */
const POL_BODY = '全国碳市场配额分配方案明确 2026 年度发电行业配额总量为 1.2 亿吨。其余条款为公开说明。';
db.run(
  `INSERT INTO policy_document (id,policy_key,title,category,doc_status,publish_date,official_url,body_snapshot,collected_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ['POL-TOOL-97', 'pol-tool-97', '2026 年度全国碳市场配额分配方案', 'allocation', 'effective', '2026-09-20',
    'https://www.mee.gov.cn/policy-tool-97.html', POL_BODY, now, now, now]
);

function toolCall(id, name, args) {
  return {
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }], reasoning_content: '内部思考：应先查库内政策。' },
    finish_reason: 'tool_calls',
  };
}

await testAsync('工具参数服务端校验：缺参返回询问，不猜默认值', async () => {
  const r = await toolChat.executeTool('estimate_emissions', { kind: 'electricity' }, {});
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'missing_arguments');
  assertIncludes(r.summary, 'energy');
});

await testAsync('工具拒绝抓取本轮未检索的 URL / 未知工具', async () => {
  const r = await toolChat.executeTool('web_fetch', { url: 'https://evil.example/x' }, { webUrls: new Set() });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'url_not_from_turn_search');
  const u = await toolChat.executeTool('drop_table', {}, {});
  assertEqual(u.ok, false);
  assertEqual(u.reason, 'unknown_tool');
});

test('会话历史按用户隔离，不跨用户拼接', () => {
  db.run(
    `INSERT INTO chat_turn (id,user_id,user_name,question,mode,refused,created_at,session_id,answer_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['CHT-SESS-97', 'u-a', 'A', '上一个问题', 'db', 0, now, 'session-aaaa-97', JSON.stringify({ paragraphs: ['上一个回答'] })]
  );
  assertEqual(toolChat.loadSessionTurns('u-b', 'session-aaaa-97').length, 0);
  assertEqual(toolChat.loadSessionTurns('u-a', 'session-aaaa-97').length, 1);
});

await testAsync('工具循环：先查库，再依据真实证据回答；reasoning_content 保留但不作为答案', async () => {
  const finalJson = JSON.stringify({ answerable: true, paragraphs: [{ text: '2026 年度发电行业配额总量为 1.2 亿吨。', source_ids: ['policy:POL-TOOL-97'], quotes: [{ source_id: 'policy:POL-TOOL-97', quote: '2026 年度发电行业配额总量为 1.2 亿吨' }] }], note: '' });
  replies = [
    toolCall('call_1', 'search_library', { query: '2026 年度全国碳市场配额分配方案', limit: 3 }),
    // 带 tools 的这一轮只用于结束工具阶段；最终答复由随后无工具 + JSON 模式生成。
    { message: { role: 'assistant', content: finalJson }, finish_reason: 'stop' },
    { message: { role: 'assistant', content: finalJson }, finish_reason: 'stop' },
  ];
  const before = modelCalls.length;
  const out = await toolChat.runToolChat({
    provider, question: '2026 年度全国碳市场配额分配方案的发电行业配额总量是多少？',
    user: viewer, sessionId: 'session-tool-97', progress: () => {},
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.toolRuns.length, 1);
  assertEqual(out.toolRuns[0].tool, 'search_library');
  assert(out.evidence.some((e) => e.source_id === 'policy:POL-TOOL-97'));
  const secondReq = modelCalls[before + 1].body;
  assertEqual(secondReq.thinking.type, 'enabled', '复杂问题应开启思考模式');
  const assistant = secondReq.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert(assistant, '请求必须回传 assistant tool_calls');
  assertEqual(assistant.reasoning_content, '内部思考：应先查库内政策。', '带 tools 时必须回传 reasoning_content');
  const toolMsg = secondReq.messages.find((m) => m.role === 'tool');
  assertIncludes(toolMsg.content, 'policy:POL-TOOL-97');
});

await testAsync('工具达上限：停止工具，在剩余预算内做一次无工具 JSON 总结', async () => {
  deepseek.saveDeepSeekCapability(admin, 'chat_tools', {
    enabled: true, provider_id: 'LLM-DS-97',
    config: { max_rounds: 4, max_tool_calls: 1, max_total_ms: 20000, max_output_tokens: 1000, thinking: 'disabled' },
  });
  const limitFinal = JSON.stringify({ answerable: true, paragraphs: [{ text: '2026 年度发电行业配额总量为 1.2 亿吨。', source_ids: ['policy:POL-TOOL-97'], quotes: [{ source_id: 'policy:POL-TOOL-97', quote: '2026 年度发电行业配额总量为 1.2 亿吨' }] }], note: '工具调用达到上限，仅总结已有证据。' });
  replies = [
    toolCall('call_limit_1', 'search_library', { query: '配额', limit: 1 }),
    { message: { role: 'assistant', content: limitFinal }, finish_reason: 'stop' },
  ];
  const before = modelCalls.length;
  const out = await toolChat.runToolChat({ provider, question: '配额总量与上年对比如何？', user: viewer, sessionId: 'session-limit-97' });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.limit_reached, true);
  assert(out.evidence.length >= 1, '应返回已有证据');
  assertEqual(modelCalls.length - before, 2, '达到上限后只允许一次无工具总结，不再调用工具');
  const finalReq = modelCalls[modelCalls.length - 1].body;
  assertEqual(finalReq.tools, undefined, '最终总结不得再携带工具定义');
  assertEqual(finalReq.response_format.type, 'json_object', '最终总结必须启用 JSON 模式');
  assert(finalReq.max_tokens >= 2400, '复杂统计/对比问题应给足输出预算，避免 finish_reason=length');
  assertIncludes(out.notes.join(' '), '无工具证据总结');
});

await testAsync('chat.ask 接入工具证据并通过来源/引句校验', async () => {
  chat.__resetChatState();
  deepseek.saveDeepSeekCapability(admin, 'chat_tools', {
    enabled: true, provider_id: 'LLM-DS-97',
    config: { max_rounds: 3, max_tool_calls: 4, max_total_ms: 30000, max_output_tokens: 1200, thinking: 'enabled' },
  });
  const askFinal = JSON.stringify({ answerable: true, paragraphs: [{ text: '2026 年度发电行业配额总量为 1.2 亿吨。', source_ids: ['policy:POL-TOOL-97'], quotes: [{ source_id: 'policy:POL-TOOL-97', quote: '2026 年度发电行业配额总量为 1.2 亿吨' }] }], note: '数据来自库内公开政策。' });
  replies = [
    toolCall('call_2', 'search_library', { query: '2026 年度全国碳市场配额分配方案', limit: 3 }),
    { message: { role: 'assistant', content: askFinal }, finish_reason: 'stop' },
    { message: { role: 'assistant', content: askFinal }, finish_reason: 'stop' },
  ];
  const out = await chat.ask({
    user: viewer, question: '2026 年度全国碳市场配额分配方案的发电行业配额总量是多少？',
    sessionId: 'session-ask-97', progressId: 'pg-test-97',
  });
  assertEqual(out.refused, false, JSON.stringify(out));
  assertEqual(out.answer.length, 1);
  assertIncludes(out.answer[0].text, '1.2 亿吨');
  assertEqual(out.as_of, '2026-09-20');
  assert(out.tool_runs.length >= 1);
  const turn = db.get("SELECT * FROM chat_turn WHERE user_id='u-viewer' ORDER BY created_at DESC LIMIT 1");
  assertEqual(turn.session_id, 'session-ask-97');
  assert(turn.tool_call_count >= 1);
  assert(turn.as_of === '2026-09-20');
});

/* ---------------- 视觉能力关闭时如实不可用 ---------------- */
await testAsync('视觉能力关闭时返回 disabled，不渲染、不调用模型', async () => {
  deepseek.saveDeepSeekCapability(admin, 'vision', { enabled: false, provider_id: 'LLM-DS-97' });
  const before = modelCalls.length;
  const out = await vision.visionSupplementPage({
    kind: 'policy_document', id: 'POL-VISION-97', page: 1, filePath: pdfPath, docHash,
    title: '视觉测试文档', actor: 'admin-test', apply: false, renderer,
  });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'disabled');
  assertEqual(modelCalls.length, before);
});

stub.closeAllConnections?.();
await new Promise((resolve) => stub.close(resolve));
finish('97-v2-deepseek-vision-tools-json.test.mjs');
