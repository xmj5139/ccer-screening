/**
 * 测试 131（docs/76）：跨类型有界 worker 队列轮转、全局条数上限、退避、
 * 核验 scope 过滤、每日链路实际调用与共享租约。
 * 仅使用 setupV2 隔离库；不联网、不调用真实模型。
 */
import { readFile } from 'node:fs/promises';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const gov = await import('../src/services/governance-svc.mjs');
const stages = await import('../src/services/processing-stage-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

const now = new Date().toISOString();
const BODY = '跨类型有界 worker 测试正文，用于验证轮转、预算、退避与每日调度。'.repeat(24);
const TYPES = [
  'policy_document', 'methodology_version', 'cea_document',
  'accounting_standard', 'accounting_public_document',
];

db.run(
  `INSERT INTO policy_document
     (id,policy_key,title,category,doc_status,publish_date,official_url,source_tier,
      collected_at,body_snapshot,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['P-131', 'key-p-131', 'worker 政策 131', 'ministry_policy', 'effective', '2026-09-01',
    'https://www.mee.gov.cn/p131.html', 1, now, BODY, now, now]
);
db.run(
  `INSERT INTO methodology_version
     (id,methodology_id,code_display,name,version,document_status,release_date,official_url,
      body_snapshot,catalog_confidence,is_candidate_eligible,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['M-131', 'M-131', 'CCER-10-131', 'worker 方法学 131', 'V01', 'formal', '2026-09-02',
    'https://www.mee.gov.cn/m131.pdf', BODY, 'verified_from_official_notice', 1, now, now]
);
db.run(
  `INSERT INTO cea_document
     (id,doc_key,doc_type,title,publish_date,official_url,evidence_level,body_snapshot,
      count_in_stats,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ['C-131', 'c-131', 'policy', 'worker CEA 131', '2026-09-03',
    'https://www.mee.gov.cn/c131.html', 'full_text', BODY, 1, now, now]
);
db.run(
  `INSERT INTO accounting_standard
     (id,code,identity_key,title,issuer,standard_type,status,publish_date,original_url,
      body_text,body_status,sha256,extraction_complete,chars,model_verify_status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['S-131', 'S-131', 'ik-s-131', 'worker 标准 131', '发布机关', 'accounting', 'formal',
    '2026-09-04', 'https://www.cets.org.cn/s131.pdf', BODY, 'full', 'e'.repeat(64),
    1, BODY.length, 'unavailable', now, now]
);
db.run(
  `INSERT INTO accounting_public_document
     (id,source_id,source_code,doc_key,doc_type,category,title,url,published_at,issuer,body_text,
      body_status,content_hash,snapshot_path,captured_at,evidence_level,model_verify_status,
      revision_no,is_current,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['A-131', null, 'cets', 'key-a-131', 'article', 'policy', 'worker 公开资料 131',
    'https://www.cets.org.cn/a131.html', '2026-09-05', '全国碳市场信息网', BODY, 'full',
    'f'.repeat(64), '/tmp/a131.html', now, 'full_text', 'unavailable', 1, 1, now, now]
);
const contentItem = content.upsertContent({
  source_url: 'https://www.example.gov.cn/worker131.html',
  title: 'worker 内容 131', publisher: '测试媒体', content_type: 'industry_news',
  published_at: '2026-09-06', body_snapshot: BODY,
}, { actor: 'test:131' });

for (const [type, id] of [
  ['policy_document', 'P-131'], ['methodology_version', 'M-131'],
  ['cea_document', 'C-131'], ['accounting_standard', 'S-131'],
  ['accounting_public_document', 'A-131'], ['content_item', contentItem.id],
]) stages.syncObjectStages(type, id);

function resetDueStage(type, id, stage, patch = {}) {
  db.run(
    `UPDATE processing_stage SET status=?, attempts=?, next_retry_at=?, failure_reason=?, created_at=?
      WHERE object_type=? AND object_id=? AND stage=?`,
    [patch.status || 'pending', patch.attempts ?? 0, patch.next_retry_at || now,
      patch.failure_reason || null, '2000-01-01T00:00:00.000Z', type, id, stage]
  );
}

function stageRow(type, id, stage) {
  return db.get(
    'SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [type, id, stage]
  );
}

await testAsync('无模型跨类型 worker：按类型轮转，不超过全局条数上限，逐条记录 blocked', async () => {
  db.run('UPDATE llm_provider SET enabled=0');
  const ids = {
    policy_document: 'P-131', methodology_version: 'M-131', cea_document: 'C-131',
    accounting_standard: 'S-131', accounting_public_document: 'A-131',
  };
  for (const type of TYPES) resetDueStage(type, ids[type], 'summarized');
  const out = await gov.processPending({
    actor: 'test:131', objectTypes: TYPES, only: ['summarized'],
    limit: 3, budgetMs: 5000, sync: false,
  });
  assertEqual(out.scanned, 3, JSON.stringify(out));
  assertEqual(out.blocked, 3);
  assertEqual(out.actions.length, 3);
  assertEqual(new Set(out.actions.map((a) => a.object_type)).size, 3, '应跨三个类型轮转而非只取第一个类型');
  for (const a of out.actions) {
    const s = stageRow(a.object_type, a.object_id, 'summarized');
    assertEqual(s.status, 'blocked');
    assert(s.attempts >= 1);
    assert(!!s.next_retry_at, '阻塞后应保留退避时间');
  }
});

await testAsync('核验 scope 过滤：只调度允许的类型；其它类型保持 pending', async () => {
  resetDueStage('policy_document', 'P-131', 'verified');
  resetDueStage('content_item', contentItem.id, 'verified');
  const out = await gov.processPending({
    actor: 'test:131', objectTypes: ['content_item', 'policy_document'], only: ['verified'],
    verifyObjectTypes: ['policy_document'], limit: 5, budgetMs: 5000, sync: false,
  });
  assertEqual(out.scanned, 1, JSON.stringify(out));
  assertEqual(out.actions[0].object_type, 'policy_document');
  assertEqual(out.actions[0].status, 'blocked');
  const contentStage = stageRow('content_item', contentItem.id, 'verified');
  assertEqual(contentStage.status, 'pending', '未启用 scope 的内容核验不应被调度');
  assertEqual(contentStage.attempts, 0);
});

await testAsync('退避未到不重复调用：未来 next_retry_at 的 blocked 阶段扫描为 0', async () => {
  db.run(
    "UPDATE processing_stage SET status='blocked', next_retry_at='2099-01-01T00:00:00.000Z' WHERE object_type='policy_document' AND object_id='P-131' AND stage='summarized'"
  );
  const before = stageRow('policy_document', 'P-131', 'summarized');
  const out = await gov.processPending({
    actor: 'test:131', objectTypes: ['policy_document'], only: ['summarized'],
    limit: 5, budgetMs: 5000, sync: false,
  });
  assertEqual(out.scanned, 0);
  const after = stageRow('policy_document', 'P-131', 'summarized');
  assertEqual(after.attempts, before.attempts);
  assertEqual(after.next_retry_at, before.next_retry_at);
});

await testAsync('输入变化重置尝试并重新排队（政策正文）', async () => {
  const summary = await import('../src/services/summary-svc.mjs');
  const input = summary.loadSummaryInput('policy_document', 'P-131');
  db.run(
    `INSERT OR REPLACE INTO entity_summary
       (id,entity_type,entity_id,input_hash,prompt_version,model_key,status,summary,input_kind,
        input_chars,scope_note,provider_id,model,attempts,generated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'ok',?,?,?,?,?,?,1,?,?,?)`,
    ['SUM-P-131', 'policy_document', 'P-131', summary.summaryInputHash(input),
      summary.PROMPT_VERSION, summary.currentModelKey(), '测试摘要', input.input_kind,
      input.text.length, input.scope_note, 'p', 'm', now, now, now]
  );
  stages.syncObjectStages('policy_document', 'P-131');
  db.run(
    "UPDATE processing_stage SET attempts=2 WHERE object_type='policy_document' AND object_id='P-131' AND stage IN ('summarized','verified')"
  );
  db.run(
    'UPDATE policy_document SET body_snapshot=?, updated_at=? WHERE id=?',
    [`${BODY}\n\n新增公开条款，需要重新分析。`, new Date(Date.now() + 1000).toISOString(), 'P-131']
  );
  stages.syncObjectStages('policy_document', 'P-131');
  const sum = stageRow('policy_document', 'P-131', 'summarized');
  const ver = stageRow('policy_document', 'P-131', 'verified');
  assertEqual(sum.status, 'stale');
  assertEqual(ver.status, 'stale');
  assertEqual(sum.attempts, 0);
  assertEqual(ver.attempts, 0);
});

await testAsync('每日链路调用统一 worker：runDailyGovernance 实际调度且不再直连 verifyAllBatch', async () => {
  const src = await readFile(new URL('../src/services/collect-svc.mjs', import.meta.url), 'utf8');
  assertIncludes(src, 'runDailyGovernance', '每日任务应调用统一治理 worker');
  assert(!/verify\.verifyAllBatch\s*\(/.test(src), '每日任务不应再直接调用 verifyAllBatch');
  assert(!/refreshAfterDaily\s*\(/.test(src), '每日任务不应再用旧摘要刷新旁路');

  const out = await gov.runDailyGovernance({ actor: 'test:131-daily', limit: 1, budgetMs: 5000 });
  assertEqual(out.daily, true);
  assertEqual(out.ok !== undefined, true);
  assert(Array.isArray(out.object_types) && out.object_types.length === 7, '每日 worker 应覆盖全部受治理类型');
  assert(Array.isArray(out.verify_object_types), '每日 worker 应返回本次启用的核验类型');
  assert(out.scanned >= 0 && out.scanned <= 2, '每日 worker 必须受 limit 约束');
});

await testAsync('共享 collection 租约：租约被占用时不执行 worker', async () => {
  resetDueStage('policy_document', 'P-131', 'summarized');
  const held = gov.acquireLease({ key: 'collection', owner: 'daily-131', purpose: 'test', ttlMs: 60000 });
  assertEqual(held.ok, true);
  const before = stageRow('policy_document', 'P-131', 'summarized');
  const out = await gov.processPending({
    actor: 'test:131', objectTypes: ['policy_document'], only: ['summarized'],
    limit: 1, budgetMs: 5000, leaseOwner: 'admin-131', sync: false,
  });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'lease_busy');
  const after = stageRow('policy_document', 'P-131', 'summarized');
  assertEqual(after.attempts, before.attempts);
  gov.releaseLease({ key: 'collection', owner: 'daily-131' });
});

finish('test/131-v2-daily-governance-worker.test.mjs');
