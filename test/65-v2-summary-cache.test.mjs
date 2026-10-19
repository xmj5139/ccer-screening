/**
 * v2.6 测试 65（docs/44 第 3 条）：统一「核心摘要」缓存、失效与有界批次
 * ============================================================================
 * 覆盖：
 *   · 摘要真的调用已配置模型（本机桩服务器收到请求，提示词含输入范围）；
 *   · 缓存命中不重复调用；输入变化 / 提示词版本 / 模型配置变化使旧摘要失效；
 *   · 未配置模型时如实 skipped，**绝不伪造「模型生成」摘要**；
 *   · 读路径只读缓存（列表 GET 不触发模型）；
 *   · 后台异步任务：202 语义、全局单并发、状态持久化。
 */
import { createServer } from 'node:http';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const summary = await import('../src/services/summary-svc.mjs');
const adminSvc = await import('../src/services/admin-v2-svc.mjs');

console.log('\n[v2-65] 核心摘要缓存与有界批次');

/* ---- 本机桩模型服务器 ---- */
let modelReply = JSON.stringify({ summary: '本条公开信息依据已获取的公开字段生成的核心摘要。' });
let mode = 'ok';
const seen = [];
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    seen.push({ url: req.url, body: parsed });
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (mode === 'http500') return send(500, { error: 'boom' });
    return send(200, { choices: [{ message: { content: modelReply } }] });
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const MODEL_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

function upsertProvider({ id = 'LLM-SUM', model = 'summary-model', enabled = true } = {}) {
  const now = new Date().toISOString();
  process.env.CCER_LLM_KEY_TEST_KEY = 'local-test-secret';
  const exists = db.get('SELECT id FROM llm_provider WHERE id=?', [id]);
  if (exists) {
    // llm_call_log 引用该行，不能删除（外键）；直接更新配置
    db.run('UPDATE llm_provider SET model=?, enabled=?, use_content_verify=1, base_url=?, updated_at=? WHERE id=?',
      [model, enabled ? 1 : 0, `${MODEL_BASE}/v1/chat/completions`, now, id]);
    return id;
  }
  db.run(
    `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,
      allowed_domains,use_content_verify,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, '本机摘要模型', 'ollama', `${MODEL_BASE}/v1/chat/completions`, model, 'TEST_KEY', enabled ? 1 : 0, '[]', 1, now, now]
  );
  return id;
}

const POLICY_ID = 'POL-SUM-64';
function seedPolicy(body) {
  const now = new Date().toISOString();
  const exists = db.get('SELECT id FROM policy_document WHERE id=?', [POLICY_ID]);
  if (exists) {
    db.run('UPDATE policy_document SET body_snapshot=?, updated_at=? WHERE id=?', [body, now, POLICY_ID]);
  } else {
    db.run(
      `INSERT INTO policy_document (id,policy_key,title,category,doc_status,publish_date,official_url,body_snapshot,collected_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [POLICY_ID, 'pol-sum-64', '全国碳市场配额管理公开政策', 'management', 'effective', '2026-10-01',
        'https://www.mee.gov.cn/xxgk/2026/sum.html', body, now, now, now]
    );
  }
}

/* ==================================================================== */
/*  一、真实调用 + 缓存命中 + 失效                                       */
/* ==================================================================== */

await testAsync('摘要批次真的调用已配置模型，并写入结构化摘要（含输入范围）', async () => {
  upsertProvider();
  seedPolicy(`第一条公开政策正文。${'内容'.repeat(300)}`);
  const before = seen.length;
  const out = await summary.runSummaryBatch({ entityType: 'policy_document', ids: [POLICY_ID], actor: 'test:65' });
  assertEqual(out.model_configured, true, '应识别到已配置模型');
  assertEqual(out.generated, 1, `应生成 1 条摘要，实际 ${JSON.stringify(out.per_entity)}`);
  assertEqual(seen.length, before + 1, '应真的向模型发出一次请求');
  const body = seen[seen.length - 1].body;
  assertIncludes(JSON.stringify(body), '只输出 JSON', '应使用摘要专用系统提示词');
  assertIncludes(JSON.stringify(body), '输入范围', '提示词应包含输入范围说明');
  const row = db.get('SELECT * FROM entity_summary WHERE entity_type=? AND entity_id=?', ['policy_document', POLICY_ID]);
  assertEqual(row.status, 'ok');
  assertIncludes(row.summary, '核心摘要');
  assertEqual(row.prompt_version, summary.PROMPT_VERSION);
  assertIncludes(row.scope_note, '已归档正文', '应记录输入范围');
  assert(row.model_key.startsWith('LLM-SUM::'), '应记录模型键');
});

await testAsync('缓存命中：同一输入不重复调用模型', async () => {
  const before = seen.length;
  const out = await summary.runSummaryBatch({ entityType: 'policy_document', ids: [POLICY_ID], actor: 'test:65' });
  assertEqual(out.generated, 0, '输入未变化时不应重新生成');
  assertEqual(seen.length, before, '缓存命中不得再次调用模型');
  const s = summary.getSummary('policy_document', POLICY_ID);
  assertEqual(s.stale, false);
  assert(s.summary, '缓存命中时应返回摘要文本');
});

await testAsync('输入变化使旧摘要失效，并且失效摘要不作为当前摘要展示', async () => {
  seedPolicy(`修改后的政策正文（条款变化）。${'新内容'.repeat(300)}`);
  const s = summary.getSummary('policy_document', POLICY_ID);
  assertEqual(s.stale, true, '正文变化后摘要必须失效');
  assertEqual(s.summary, null, '失效摘要不得作为当前摘要返回');
  assert(s.stale_summary, '原摘要应保留为历史（可追溯）');
  assertIncludes(s.empty_reason, '失效');
  const attached = summary.attachSummary('policy_document', { id: POLICY_ID });
  assertEqual(attached.summary_block.text, null, '挂载到列表时也不能显示失效摘要');
  assertEqual(attached.summary_block.stale, true);
  // 截断窗口之外的尾部变化同样必须失效（完整输入哈希）
  const before = seen.length;
  const out = await summary.runSummaryBatch({ entityType: 'policy_document', ids: [POLICY_ID], actor: 'test:65' });
  assertEqual(out.generated, 1, '失效摘要应被重算');
  assertEqual(seen.length, before + 1);
  assertEqual(summary.getSummary('policy_document', POLICY_ID).stale, false);
});

await testAsync('模型配置变化使旧摘要失效', async () => {
  upsertProvider({ model: 'summary-model-v2' });
  const s = summary.getSummary('policy_document', POLICY_ID);
  assertEqual(s.stale, true, '模型变化后旧摘要必须失效');
  assertIncludes(s.stale_reason, '模型配置');
});

/* ==================================================================== */
/*  二、无模型不伪造 + 读路径不调模型                                    */
/* ==================================================================== */

await testAsync('未配置模型：如实 skipped，不写伪造的「模型生成」摘要', async () => {
  db.run("UPDATE llm_provider SET enabled=0 WHERE id='LLM-SUM'");
  seedPolicy(`无模型场景正文。${'内容'.repeat(300)}`);
  const before = seen.length;
  const out = await summary.runSummaryBatch({ entityType: 'policy_document', ids: [POLICY_ID], actor: 'test:65' });
  assertEqual(out.model_configured, false);
  assertEqual(out.generated, 0, '无模型时不得生成任何摘要');
  assertEqual(out.skipped, 1, '应如实记为 skipped');
  assertEqual(seen.length, before, '无模型时不得发起任何模型请求');
  const row = db.get('SELECT * FROM entity_summary WHERE entity_type=? AND entity_id=?', ['policy_document', POLICY_ID]);
  assertEqual(row.status, 'skipped');
  assertEqual(row.summary, null, '不得写入伪造摘要');
  assertIncludes(row.error, '未配置');
  const s = summary.getSummary('policy_document', POLICY_ID);
  assertEqual(s.summary, null);
  assertIncludes(s.empty_reason, '未配置');
  upsertProvider();
});

test('读路径只读缓存：列表/详情的摘要读取不包含任何模型调用', async () => {
  const fs = await import('node:fs');
  const srcFile = fs.readFileSync(new URL('../src/services/summary-svc.mjs', import.meta.url), 'utf8');
  const grab = (name) => {
    const i = srcFile.indexOf(`export function ${name}(`);
    assert(i > 0, `应有 ${name}`);
    const end = srcFile.indexOf('\n}', i);
    assert(end > i, `${name} 应有函数体`);
    return srcFile.slice(i, end + 2);
  };
  for (const fn of ['getSummary', 'getSummaries', 'attachSummary', 'attachSummaries', 'summaryPayload']) {
    const body = grab(fn);
    assert(!body.includes('callVerifyModel'), `${fn} 属于读路径，不得调用模型`);
    assert(!body.includes('fetch('), `${fn} 属于读路径，不得发起网络请求`);
  }
});

/* ==================================================================== */
/*  三、游标与覆盖统计                                                   */
/* ==================================================================== */

test('摘要候选按持久游标轮转，覆盖统计给出真实覆盖数', () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i += 1) {
    db.run(
      `INSERT OR REPLACE INTO policy_document (id,policy_key,title,category,doc_status,publish_date,collected_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [`POL-CUR-${i}`, `pol-cur-${i}`, `游标测试政策 ${i}`, 'management', 'effective', `2026-09-0${i + 1}`, now, now, now]
    );
  }
  const win1 = summary.cursorWindow('policy_document', 2);
  assert(win1.ids.length > 0, '应返回候选');
  assertEqual(win1.total >= 6, true, '总数应包含全部有效条目');
  assert(win1.next > 0 || win1.ids.length === win1.total, '游标应向前推进或已到末尾');
  summary.setCursorForTest ? summary.setCursorForTest('policy_document', 0) : null;
  const status = summary.summaryStatus({ sample: 5 });
  const per = status.per_entity.policy_document;
  assertEqual(per.entity_total >= 6, true, '应统计有效条目总数');
  assertEqual(typeof per.covered, 'number', '应给出真实覆盖数');
  assertEqual(per.missing, Math.max(0, per.entity_total - per.covered), 'missing 应为总数减覆盖数');
  assert(typeof status.coverage_ratio === 'number', '应给出覆盖率');
  assert(status.recent_tasks, '应返回最近任务列表');
});

/* ==================================================================== */
/*  四、后台异步任务（202 + 轮询 + 全局单并发）                          */
/* ==================================================================== */

await testAsync('后台摘要任务：入队即返回、状态持久化、重复发起被单并发拦截', async () => {
  const admin = { id: 'u-admin', name: 'admin-test', role: 'admin' };
  const first = summary.startSummaryTask(admin, { entityType: 'policy_document', limit: 3, force: true });
  assertEqual(first.accepted, true, '应接受异步任务');
  assert(first.task_id, '应返回任务 ID');
  assert(['queued', 'running'].includes(summary.getSummaryTask(first.task_id).status), '任务应处于排队/执行中');
  const second = summary.startSummaryTask(admin, { entityType: 'policy_document', limit: 3 });
  assertEqual(second.busy, true, '全局单并发：已有任务时应拒绝重复发起');
  // 等待任务结束（有界）
  for (let i = 0; i < 60; i += 1) {
    const t = summary.getSummaryTask(first.task_id);
    if (['success', 'partial', 'failed', 'interrupted'].includes(t.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const done = summary.getSummaryTask(first.task_id);
  assert(['success', 'partial'].includes(done.status), `任务应完成，实际 ${done.status}：${done.error || ''}`);
  assert(done.finished_at, '完成后应记录完成时间');
  assert(done.generated >= 1, `应生成至少一条摘要，实际 ${JSON.stringify(done)}`);
  assertEqual(summary.runningSummaryTask(), null, '完成后不应残留进行中的任务');
});

await testAsync('非管理员不得发起摘要任务', async () => {
  const out = summary.startSummaryTask({ name: 'viewer', role: 'viewer' }, {});
  assertEqual(out.status, 403);
  assertIncludes(out.error, '管理员');
});

/* ==================================================================== */
/*  五、批次边界：全局硬上限 + 300 秒硬预算（docs/46 第 4、11 条 / docs/47） */
/* ==================================================================== */

test('批次时间预算夹在 1 秒—300 秒之间，任何调用方都不能无界延长', () => {
  assertEqual(summary.MIN_BATCH_BUDGET_MS, 1000);
  assertEqual(summary.MAX_BATCH_BUDGET_MS, 300_000);
  assertEqual(summary.clampBatchBudget(10 * 60 * 1000), 300_000, '超过 300 秒必须夹到硬上限');
  assertEqual(summary.clampBatchBudget(120_000), 120_000);
  assertEqual(summary.clampBatchBudget(1), 1000, '低于 1 秒必须抬到下限');
  assertEqual(summary.clampBatchBudget(-5), summary.DEFAULT_BATCH_BUDGET_MS, '非法预算退回默认值');
  assertEqual(summary.clampBatchBudget('abc'), summary.DEFAULT_BATCH_BUDGET_MS);
});

await testAsync('limit 是所有实体类型合计的全局硬上限，不会按类型放大', async () => {
  upsertProvider();
  // 让多个实体类型都有可扫描候选（非空库），否则空跑不能证明上限有效
  seedPolicy(`全局上限核验正文。${'内容'.repeat(300)}`);
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO content_item (id,content_type,record_kind,title,publisher,published_at,
       discovered_at,source_url,url_hash,source_category,body_availability,body_snapshot,is_demo,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    ['CNT-LIMIT-1', 'industry_news', 'article', '全局上限核验动态', '测试机构', '2026-10-01',
      now, 'https://example.com/limit-1', 'hash-limit-1', 'media', 'full_text', '动态正文。'.repeat(300), now, now]
  );
  const out = await summary.runSummaryBatch({ limit: 1, budgetMs: 5000, actor: 'test:65' });
  const perScanned = Object.values(out.per_entity).reduce((n, p) => n + p.scanned, 0);
  assertEqual(out.scanned <= 1, true, `limit=1 时全局扫描不得超过 1 条，实际 ${out.scanned}`);
  assertEqual(perScanned, out.scanned, '各类型扫描数之和必须等于全局扫描数');
  assert(out.budget_ms <= 300_000 && out.budget_ms >= 1000, '批次必须回报夹紧后的时间预算');
});

finish('65-v2-summary-cache.test.mjs');
