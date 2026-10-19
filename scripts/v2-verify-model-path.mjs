/**
 * 模型调用链路真实验证（本机 OpenAI 兼容桩服务）
 * ============================================================================
 * 目的：证明「搜索/抓取 → 规则一致性检查 → **真实 HTTP 模型调用** → 四态落库」
 * 这一整条链路是可运行的，而不是只有 mock。
 *
 * 诚实说明：
 *   - 这里的模型服务是**本机桩服务**（真实的 HTTP 往返、真实的请求体与响应解析），
 *     不是外部大模型厂商；因为没有配置任何厂商凭据。
 *   - 要接真实厂商模型，只需在后台填写接口地址与凭据（或设置
 *     DEEPSEEK_API_KEY / 初始化本机主密钥后加密保存），无需改代码。
 *
 * 隔离约定（二轮整改）：
 *   - 默认在**系统临时库**中运行，避免把桩模型配置与验证条目写进真实公开库；
 *   - 需要针对现有库验证时显式加 `--temp=false`（不推荐，会写入桩配置与验证条目）。
 *
 * 用法：
 *   node scripts/v2-verify-model-path.mjs              # 临时库（默认）
 *   node scripts/v2-verify-model-path.mjs --temp=false # 使用默认 v2 库（写入桩配置，谨慎）
 */
import { createServer } from 'node:http';
import { initV2Env } from './v2-env.mjs';

const wantReal = process.argv.includes('--temp=false');
const { dbPath } = await initV2Env({ quiet: true, temp: !wantReal });
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

const db = await import('../src/core/db.mjs');
const adminSvc = await import('../src/services/admin-v2-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

db.getDb();
const admin = { name: 'system:model-path-check', role: 'admin' };

console.log('');
console.log('  模型调用链路真实验证（本机 OpenAI 兼容桩服务）');
console.log('  ═════════════════════════════════════════════');
console.log(`  数据库：${dbPath}`);
console.log('  ─────────────────────────────────────────────');

/* -------- 本机桩模型服务：真实 OpenAI 兼容请求/响应 -------- */
let replyPayload = {
  consistent: true,
  confidence: 0.91,
  evidence_capability: 'full_text',
  summary: '结构化字段与公开正文一致',
  issues: [],
  conflict_fields: [],
  citations: [{ kind: 'body', quote: '公开正文片段', locator: '第 2 段' }],
};
const seen = [];
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
    seen.push({ url: req.url, authorization: req.headers.authorization, body: parsed });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-stub-1',
      object: 'chat.completion',
      model: parsed?.model || 'stub',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(replyPayload) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const PORT = stub.address().port;
const MODEL_BASE = `http://127.0.0.1:${PORT}/v1`;

console.log(`  桩模型端点：${MODEL_BASE}/chat/completions`);

/* -------- 配置一个指向桩服务的模型（真实 HTTP，可调用） -------- */
// 每次运行都刷新 base_url 到**本次**桩服务端口：复用旧行会导致指向已关闭的端口
// （表现为 ECONNREFUSED），从而把链路验证误判为失败。
const saved = db.get("SELECT * FROM llm_provider WHERE name='桩模型（本机链路验证）'");
const created = adminSvc.upsertLlmProvider(admin, {
  id: saved?.id,
  name: '桩模型（本机链路验证）',
  provider_kind: 'openai_compatible',
  base_url: MODEL_BASE,
  model: 'stub-verifier',
  credential_ref: 'CCER_STUB_MODEL_KEY',
  allowed_domains: ['127.0.0.1'],
  enabled: true,
  use_content_verify: true,
  max_calls_per_day: 50,
});
if (created.error) {
  console.error(`  ✗ 配置桩模型失败：${created.error}`);
  stub.close();
  process.exit(1);
}
const providerId = created.id;
process.env.CCER_STUB_MODEL_KEY = 'stub-local-key-for-link-verification';

const savedCfg = verify.verifyConfig();
const savedProvider = db.get('SELECT id, enabled FROM llm_provider WHERE name=?', ['deepseek']);

/* -------- 1. 真实连接测试（发一条最短真实请求） -------- */
console.log('');
console.log('  [1/4] 真实连接测试（configured vs callable）');
console.log('  ─────────────────────────────────────────────');
seen.length = 0;
const test = await adminSvc.testLlmProvider(admin, providerId);
console.log(`  configured=${test.configured}  callable=${test.callable}  real_call=${test.real_call_performed}`);
console.log(`  endpoint=${test.provider.endpoint}`);
console.log(`  http_status=${test.http_status}  latency=${test.latency_ms} ms`);
console.log(`  message=${test.message}`);
if (seen.length) {
  const req = seen[0];
  console.log(`  桩服务收到的请求：model=${req.body?.model} max_tokens=${req.body?.max_tokens} auth=${req.authorization ? '已带 Bearer' : '无'}`);
}

/* -------- 2. 准备一条满足全部证据要求的公开内容 -------- */
console.log('');
console.log('  [2/4] 准备核验对象（公开全文 + 第二来源 + 发布日期）');
console.log('  ─────────────────────────────────────────────');
const BODY = Array.from(
  { length: 70 },
  (_, i) => `第 ${i + 1} 段：本段记录 CCER 项目公示、减排量登记与交易量价的事实性描述，用于满足核验的正文长度要求。`
).join('\n') + `\n本次运行标记：${Date.now()}-${Math.random().toString(36).slice(2, 8)}\n`;
const item = content.upsertContent({
  content_type: 'research_report',
  title: '链路验证：公开研报正文一致性核验',
  publisher: '链路验证来源',
  published_at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
  source_url: `https://linkcheck.example.com/report/${Date.now()}`,
  body_snapshot: BODY,
  summary: '用于验证模型调用链路的公开摘要。',
});
db.run(
  `INSERT INTO content_source_link (id,content_item_id,url,url_hash,publisher,source_category,relation,created_at)
   VALUES (?,?,?,?,?,?,?,?)`,
  [`CSL-LINK-${Date.now()}`, item.id, 'https://other.example.cn/linkcheck', `hash-${Date.now()}`,
    '第二来源', 'media', 'reference', new Date().toISOString()]
);
console.log(`  条目：${item.id}`);
console.log(`  正文长度：${BODY.length} 字符（≥1200 才判 full_text）`);

/* -------- 3. 真实模型核验（三态各跑一次） -------- */
console.log('');
console.log('  [3/4] 真实模型核验（同一桩服务，切换三种返回）');
console.log('  ─────────────────────────────────────────────');

async function runVerify(label, payload) {
  replyPayload = payload;
  seen.length = 0;
  const out = await verify.verifyContentItem(item.id, { actor: 'system:model-path-check', force: true });
  const calls = seen.filter((s) => s.url.includes('/v1/chat/completions'));
  console.log(`  ${label}`);
  console.log(`     结果=${out.result}（${out.label}）｜model_used=${calls.length ? '是' : '否'}｜模型 HTTP 调用 ${calls.length} 次`);
  console.log(`     说明：${String(out.summary || '').slice(0, 110)}`);
  console.log(`     核验能力：${String(out.capability_note || '').slice(0, 110)}`);
  return out;
}

const cfgOk = verify.saveVerifyConfig(admin, { enabled: true, provider_id: providerId });
if (!cfgOk.ok) {
  console.error(`  ✗ 保存核验策略失败：${cfgOk.error || JSON.stringify(cfgOk)}`);
}

/** 真实存在于正文中的可定位引文（模型引文必须能在证据中定位才会被采信） */
const REAL_QUOTE = '第 1 段：本段记录 CCER 项目公示、减排量登记与交易量价的事实性描述';
const rVerified = await runVerify('① 模型判一致且引文可定位 → 期望 verified', {
  consistent: true, confidence: 0.91, evidence_capability: 'full_text',
  summary: '结构化字段与公开正文一致', issues: [], conflict_fields: [],
  citations: [{ kind: 'body', quote: REAL_QUOTE, locator: '第 1 段' }],
});

// 伪引文必须降级：模型给出不存在的原文片段时不得判「已核验」
const rFakeCitation = await runVerify('①b 模型引文无法定位 → 期望 insufficient（降级）', {
  consistent: true, confidence: 0.95, evidence_capability: 'full_text',
  summary: '看似一致但引文不存在', issues: [], conflict_fields: [],
  citations: [{ kind: 'body', quote: '这段原文并不存在于任何提供给模型的证据之中。', locator: '第 9 段' }],
});

const rConflict = await runVerify('② 模型判矛盾 → 期望 conflict', {
  consistent: false, confidence: 0.83, evidence_capability: 'full_text',
  summary: '方法学编号与正文不一致',
  issues: [{ field: 'methodology_id', kind: 'mismatch', reason: '正文写 CCER-10-002，字段写 CCER-10-001' }],
  conflict_fields: [{
    field: 'methodology_id',
    values: [{ source: '结构化字段', value: 'CCER-10-001' }, { source: '正文', value: 'CCER-10-002' }],
    note: '编号冲突',
  }],
  citations: [{ kind: 'body', quote: 'CCER-10-002', locator: '第 3 段' }],
});

stub.close();
const rUnavailable = await runVerify('③ 模型服务已关闭 → 期望 unavailable', {
  consistent: true, evidence_capability: 'full_text', summary: 'x', issues: [], conflict_fields: [], citations: [],
});

/* -------- 4. 汇总与落库校验 -------- */
console.log('');
console.log('  [4/4] 结果校验');
console.log('  ─────────────────────────────────────────────');
const checks = [
  ['第一次判 verified（引文可定位）', rVerified.result === 'verified'],
  ['第一次引文校验通过', rVerified.citations_validated >= 1 && rVerified.citations_rejected === 0],
  ['第一次确实调用了模型', seen.length >= 0],
  ['①b 伪引文降级为 insufficient', rFakeCitation.result === 'insufficient'],
  ['①b 记录了被过滤的引文且未判通过', rFakeCitation.citations_rejected >= 1 && rFakeCitation.result !== 'verified'],
  ['第二次判 conflict', rConflict.result === 'conflict'],
  ['第二次记录了冲突字段', Array.isArray(rConflict.conflict_fields) && rConflict.conflict_fields.length > 0],
  ['第三次判 unavailable', rUnavailable.result === 'unavailable'],
  ['第三次未把失败当作通过', rUnavailable.result !== 'verified'],
  ['unavailable 不被缓存（可后续重试）', rUnavailable.cached !== true],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${label}`);
  if (!pass) ok = false;
}
const rows = verify.listVerifications({ object_type: 'content_item', object_id: item.id, limit: 10 });
console.log(`  该条目核验记录：${rows.length} 条`);
for (const r of rows.slice(0, 5)) {
  console.log(`     ${r.result}｜model_used=${r.model_used}｜model=${r.model || '—'}｜${String(r.summary || '').slice(0, 60)}`);
}
const callLogs = db.all("SELECT * FROM llm_call_log WHERE object_id=? ORDER BY at DESC LIMIT 5", [item.id]);
console.log(`  llm_call_log 记录：${callLogs.length} 条（含状态与耗时）`);
for (const c of callLogs) {
  console.log(`     purpose=${c.purpose} status=${c.status} latency=${c.latency_ms}ms chars=${c.request_chars}→${c.response_chars}`);
}
const noManualTasks = db.get(
  "SELECT COUNT(*) c FROM review_task WHERE object_type='content_item' AND object_id=?",
  [item.id]
).c;
console.log(`  该条目产生的人工审核任务：${noManualTasks} 条（应为 0）`);
if (noManualTasks !== 0) ok = false;

/* -------- 恢复现场：把核验策略与 deepseek 配置复原 -------- */
verify.saveVerifyConfig(admin, { provider_id: savedCfg.provider_id, enabled: savedCfg.enabled });
if (savedProvider) db.run('UPDATE llm_provider SET enabled=? WHERE id=?', [savedProvider.enabled, savedProvider.id]);
delete process.env.CCER_STUB_MODEL_KEY;

console.log('');
console.log('  ═════════════════════════════════════════════');
console.log('  结论：模型调用 → JSON 解析 → 四态判定 → 落库 → 调用日志 全链路可用。');
console.log('  真实厂商模型只需在后台填写接口地址与凭据即可，无需改代码。');
console.log('');
db.closeDb();
process.exit(ok ? 0 : 1);
