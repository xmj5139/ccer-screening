/**
 * 测试 129（docs/76）：跨资料逐条五阶段、原件/解析分列、正文变化失效、
 * 同名 ID 隔离、公开项目 skipped、无模型 blocked。
 * 仅使用 setupV2 隔离库；不联网、不调用真实模型。
 */
import {
  setupV2, test, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const stages = await import('../src/services/processing-stage-svc.mjs');
const gov = await import('../src/services/governance-svc.mjs');
const summary = await import('../src/services/summary-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');
const accountingEvidence = await import('../src/services/accounting-evidence-svc.mjs');

const now = new Date().toISOString();
const BODY = '这是用于跨资料阶段测试的公开正文，包含真实来源、时间与可核对条款。'.repeat(12);

function addPolicy(id = 'SAME-129', body = BODY, extra = {}) {
  db.run(
    `INSERT INTO policy_document
       (id,policy_key,title,doc_number,issuing_authority,category,doc_status,publish_date,
        summary,official_url,source_tier,collected_at,body_snapshot,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, `key-${id}`, extra.title || `政策 ${id}`, '测试文号〔2026〕1号', '测试发布机关',
      'ministry_policy', 'effective', '2026-09-01', '测试政策摘要',
      extra.url || `https://www.mee.gov.cn/test/${id}.html`, 1, now,
      extra.body === undefined ? body : extra.body, now, extra.updated_at || now]
  );
}

function addMethodology(id = 'SAME-129', body = BODY, extra = {}) {
  db.run(
    `INSERT INTO methodology_version
       (id,methodology_id,code_display,name,version,document_status,domain,release_date,
        official_url,body_snapshot,original_file_hash,original_file_path,catalog_confidence,
        is_candidate_eligible,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, `M-${id}`, `CCER-10-999-${id}`, extra.title || `方法学 ${id}`, 'V01', 'formal', '测试领域',
      '2026-08-01', extra.url || `https://www.mee.gov.cn/method/${id}.pdf`,
      extra.body === undefined ? body : extra.body,
      extra.hash === undefined ? null : extra.hash,
      extra.path === undefined ? null : extra.path,
      'verified_from_official_notice', 1, now, extra.updated_at || now]
  );
}

function addCea(id = 'CEA-129', body = BODY, extra = {}) {
  db.run(
    `INSERT INTO cea_document
       (id,doc_key,doc_type,category,title,doc_number,issuer,publish_date,doc_status,
        official_url,evidence_level,body_snapshot,attachment_path,attachment_hash,
        count_in_stats,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, `dk-${id}`, 'policy', 'other', extra.title || `CEA 文件 ${id}`, '测试文号',
      '测试发布机关', '2026-07-01', 'formal', extra.url || `https://www.mee.gov.cn/cea/${id}.html`,
      extra.body === undefined && body ? 'full_text' : (extra.evidence || 'metadata_only'),
      extra.body === undefined ? body : extra.body,
      extra.path || null, extra.hash || null, 1, now, extra.updated_at || now]
  );
}

function addAccountingStandard(id = 'STD-129', body = BODY, extra = {}) {
  db.run(
    `INSERT INTO accounting_standard
       (id,code,identity_key,title,issuer,sector,standard_type,status,version,publish_date,
        original_url,body_text,body_status,sha256,extraction_complete,chars,model_verify_status,
        created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, extra.code || id, `ik-${id}`, extra.title || `标准 ${id}`, '测试发布机构', '发电',
      'accounting', 'formal', 'V01', '2026-06-01', `https://www.cets.org.cn/std/${id}.pdf`,
      extra.body === undefined ? body : extra.body, extra.body_status || (body ? 'full' : 'metadata_only'),
      extra.sha || null, extra.complete === undefined ? 1 : extra.complete,
      (extra.body === undefined ? body : extra.body || '').length, 'unavailable', now, extra.updated_at || now]
  );
}

function addPublicDoc(id = 'APD-129', extra = {}) {
  db.run(
    `INSERT INTO accounting_public_document
       (id,source_id,source_code,doc_key,doc_type,category,title,url,published_at,issuer,
        body_text,body_status,content_hash,snapshot_path,captured_at,evidence_level,
        model_verify_status,revision_no,is_current,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, null, 'cets', extra.doc_key || `key-${id}`, extra.doc_type || 'article',
      extra.category || 'policy', extra.title || `公开资料 ${id}`,
      extra.url || `https://www.cets.org.cn/apd/${id}.html`, '2026-05-01', '全国碳市场信息网',
      extra.body === undefined ? '公开资料正文。'.repeat(20) : extra.body,
      extra.body_status || 'full', extra.hash || 'a'.repeat(64), extra.path || null, now,
      extra.evidence_level || 'full_text', 'unavailable', 1, 1, now, extra.updated_at || now]
  );
}

function addProject(id = 'PROJ-129', extra = {}) {
  db.run(
    `INSERT INTO public_project
       (id,registry_project_no,name,owner_name,province,domain,methodology_id,current_stage,
        official_url,evidence_level,last_checked_at,note,is_demo,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, extra.registry_no || 'REG-129', extra.title || '测试公开项目', '测试业主', '山西省',
      '能源工业', 'CCER-10-001', 'project_public', 'https://ccer.cets.org.cn/project/129',
      'official_registry', '2026-04-01', '仅公开登记字段', 0, now, now]
  );
}

function addSummary(entityType, entityId, text = '依据当前公开输入生成的测试摘要。') {
  const input = summary.loadSummaryInput(entityType, entityId);
  assert(input, `摘要输入应存在：${entityType}/${entityId}`);
  const hash = summary.summaryInputHash(input);
  db.run(
    `INSERT OR REPLACE INTO entity_summary
       (id,entity_type,entity_id,input_hash,prompt_version,model_key,status,summary,input_kind,
        input_chars,scope_note,provider_id,model,attempts,generated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'ok',?,?,?,?,?,?,1,?,?,?)`,
    [`SUM-${entityType}-${entityId}`, entityType, entityId, hash, summary.PROMPT_VERSION,
      summary.currentModelKey(), text, input.input_kind, input.text.length, input.scope_note,
      'test-provider', 'test-model', now, now, now]
  );
  return hash;
}

function addVerification(entityType, entityId, result = 'insufficient') {
  let inputHash;
  let modelKey;
  if (['policy_document', 'methodology_version', 'public_project', 'cea_document'].includes(entityType)) {
    const input = verify.objectVerificationInput(entityType, entityId);
    assert(input, `核验输入应存在：${entityType}/${entityId}`);
    inputHash = input.inputHash;
    modelKey = input.modelKey;
  } else {
    const row = db.get(`SELECT * FROM ${entityType === 'accounting_standard' ? 'accounting_standard' : 'accounting_public_document'} WHERE id=?`, [entityId]);
    const fp = accountingEvidence.accountingEvidenceFingerprint(entityType, row);
    inputHash = fp.input_hash;
    modelKey = verify.modelKeyOf(verify.pickVerifyProvider());
  }
  db.run(
    `INSERT INTO verification_result
       (id,object_type,object_id,result,ui_state,rules_ok,rules_json,model_used,provider_id,model,
        evidence_level,capability_note,summary,input_hash,input_hash_scheme,policy_hash,model_key,
        evidence_hash,citations_validated,citations_rejected,prompt_chars,error,created_at)
     VALUES (?,?,?,?,'evidence_insufficient',1,'[]',0,NULL,NULL,'full_text',?,?,?,?,?,?,?,0,0,0,NULL,?)`,
    [`VR-${entityType}-${entityId}`, entityType, entityId, result, '测试核验结论',
      result === 'verified' ? null : '证据不足（测试 fixture）', inputHash,
      verify.INPUT_HASH_SCHEME, 'policy-129', modelKey, 'evidence-129', now]
  );
}

/* ==================================================================== */
/*  1. 同名 ID 隔离 + 五阶段                                             */
/* ==================================================================== */

addPolicy('SAME-129', BODY, { title: '同名政策 A' });
addMethodology('SAME-129', BODY, { title: '同名方法学 B' });
addCea('CEA-129', BODY);
addAccountingStandard('STD-129', BODY);
addPublicDoc('APD-129', { body: '', body_status: 'index_only', hash: 'b'.repeat(64), path: '/tmp/apd.html', evidence_level: 'list_only' });
addProject('PROJ-129');

test('同名 ID 按 object_type 隔离：政策与方法学互不串数据', () => {
  const p = stages.syncObjectStages('policy_document', 'SAME-129');
  const m = stages.syncObjectStages('methodology_version', 'SAME-129');
  assertEqual(p.ok, true);
  assertEqual(m.ok, true);
  const pStages = stages.getObjectStages('policy_document', 'SAME-129');
  const mStages = stages.getObjectStages('methodology_version', 'SAME-129');
  assertEqual(pStages.length, 5);
  assertEqual(mStages.length, 5);
  const pd = gov.getGovernanceItem('SAME-129', { objectType: 'policy_document' });
  const md = gov.getGovernanceItem('SAME-129', { objectType: 'methodology_version' });
  assertEqual(pd.item.title, '同名政策 A');
  assertEqual(md.item.name, '同名方法学 B');
  assertEqual(pd.object_type, 'policy_document');
  assertEqual(md.object_type, 'methodology_version');
  assert(!pStages.some((s) => s.object_type !== 'policy_document'), '政策阶段不应混入其它类型');
  assert(!mStages.some((s) => s.object_type !== 'methodology_version'), '方法学阶段不应混入其它类型');
});

test('公开项目：发现完成，正文获取/解析明确 skipped，不冒充 PDF 闭环', () => {
  stages.syncObjectStages('public_project', 'PROJ-129');
  const by = Object.fromEntries(stages.getObjectStages('public_project', 'PROJ-129').map((s) => [s.stage, s]));
  assertEqual(by.discovered.status, 'done');
  assertEqual(by.fetched.status, 'skipped');
  assertEqual(by.parsed.status, 'skipped');
  assertIncludes(by.fetched.failure_reason || '', '结构化');
  assertIncludes(by.parsed.failure_reason || '', '不适用');
});

/* ==================================================================== */
/*  2. 原件未获取与解析失败分列                                           */
/* ==================================================================== */

addPolicy('POL-MISS-129', '', { title: '无正文政策' });
addPolicy('POL-PARSEFAIL-129', '', { title: '附件解析失败政策' });
db.run(
  `INSERT INTO policy_attachment
     (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,fetched_at,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ['ATT-POL-129', 'POL-PARSEFAIL-129', 'official.pdf', 'pdf', 'https://www.mee.gov.cn/a.pdf',
    'c'.repeat(64), '/tmp/official.pdf', 'failed', '扫描件逐页解析未取得可用正文', now, now]
);
addMethodology('MV-MISS-129', '', { title: '无原件方法学' });
addMethodology('MV-PARSEFAIL-129', '', {
  title: '原件解析失败方法学', hash: 'd'.repeat(64), path: '/tmp/mv.pdf',
});
addCea('CEA-MISS-129', '', { title: '无正文 CEA' });
addCea('CEA-PARSEFAIL-129', '', {
  title: '附件解析失败 CEA', body: '', evidence: 'metadata_only', hash: 'e'.repeat(64), path: '/tmp/cea.pdf',
});
addAccountingStandard('STD-MISS-129', '', { title: '无正文标准' });
addAccountingStandard('STD-PARSEFAIL-129', '', {
  title: '原件解析失败标准', body: '', sha: 'f'.repeat(64), body_status: 'metadata_only', complete: 0,
});
addPublicDoc('APD-PARSEFAIL-129', {
  title: '公开资料解析失败', body: '', body_status: 'metadata_only', hash: '9'.repeat(64),
  path: '/tmp/apd-failed.html', evidence_level: 'metadata_only',
});

test('政策：原件未获取与附件解析失败分列记录', () => {
  stages.syncObjectStages('policy_document', 'POL-MISS-129');
  stages.syncObjectStages('policy_document', 'POL-PARSEFAIL-129');
  const miss = Object.fromEntries(stages.getObjectStages('policy_document', 'POL-MISS-129').map((s) => [s.stage, s]));
  const bad = Object.fromEntries(stages.getObjectStages('policy_document', 'POL-PARSEFAIL-129').map((s) => [s.stage, s]));
  assertEqual(miss.fetched.status, 'blocked');
  assertEqual(miss.parsed.status, 'blocked');
  assertIncludes(miss.fetched.failure_reason || '', '未取得');
  assertEqual(bad.fetched.status, 'done', '附件已归档，获取阶段应完成');
  assertEqual(bad.parsed.status, 'failed', '已归档但解析失败');
  assertIncludes(bad.parsed.failure_reason || '', '解析');
});

test('方法学 / CEA / 标准规范：原件已归档但无正文 → parsed=failed 而不是 blocked', () => {
  for (const [type, id] of [
    ['methodology_version', 'MV-PARSEFAIL-129'],
    ['cea_document', 'CEA-PARSEFAIL-129'],
    ['accounting_standard', 'STD-PARSEFAIL-129'],
  ]) {
    stages.syncObjectStages(type, id);
    const by = Object.fromEntries(stages.getObjectStages(type, id).map((s) => [s.stage, s]));
    assertEqual(by.fetched.status, 'done', `${type} 原件/哈希已归档，获取应完成`);
    assertEqual(by.parsed.status, 'failed', `${type} 已归档但正文缺失，解析应失败`);
    assert(!!by.parsed.failure_reason, `${type} 解析失败必须有原因`);
  }
});

test('公开资料：索引页解析完成但明确不是详情全文；无正文快照时解析失败', () => {
  stages.syncObjectStages('accounting_public_document', 'APD-129');
  stages.syncObjectStages('accounting_public_document', 'APD-PARSEFAIL-129');
  const index = Object.fromEntries(stages.getObjectStages('accounting_public_document', 'APD-129').map((s) => [s.stage, s]));
  const failed = Object.fromEntries(stages.getObjectStages('accounting_public_document', 'APD-PARSEFAIL-129').map((s) => [s.stage, s]));
  assertEqual(index.parsed.status, 'done');
  assertIncludes(JSON.stringify(index.parsed.detail_json || ''), '目录');
  assertEqual(failed.fetched.status, 'done');
  assertEqual(failed.parsed.status, 'failed');
});

/* ==================================================================== */
/*  3. 摘要/核验输入变化失效                                              */
/* ==================================================================== */

test('政策/方法学/CEA 正文变化：摘要与核验立即 stale，尝试次数清零', () => {
  for (const [type, id] of [
    ['policy_document', 'SAME-129'],
    ['methodology_version', 'SAME-129'],
    ['cea_document', 'CEA-129'],
  ]) {
    addSummary(type, id);
    addVerification(type, id, 'insufficient');
    stages.syncObjectStages(type, id);
    let by = Object.fromEntries(stages.getObjectStages(type, id).map((s) => [s.stage, s]));
    assertEqual(by.summarized.status, 'done', `${type} 摘要应匹配当前输入`);
    assertEqual(by.verified.status, 'done', `${type} 核验输入签名应匹配`);
    db.run('UPDATE processing_stage SET attempts=2 WHERE object_type=? AND object_id=? AND stage IN (?,?)',
      [type, id, 'summarized', 'verified']);
    const table = type === 'policy_document' ? 'policy_document'
      : type === 'methodology_version' ? 'methodology_version' : 'cea_document';
    db.run(`UPDATE ${table} SET body_snapshot=?, updated_at=? WHERE id=?`,
      [`${BODY}\n\n修订：新增需要重新分析的公开条款。`, new Date(Date.now() + 1000).toISOString(), id]);
    stages.syncObjectStages(type, id);
    by = Object.fromEntries(stages.getObjectStages(type, id).map((s) => [s.stage, s]));
    assertEqual(by.summarized.status, 'stale', `${type} 正文变化后摘要应 stale`);
    assertEqual(by.verified.status, 'stale', `${type} 正文变化后核验应 stale`);
    assertEqual(by.summarized.attempts, 0, `${type} 输入变化应重置摘要尝试次数`);
    assertEqual(by.verified.attempts, 0, `${type} 输入变化应重置核验尝试次数`);
    assert(by.verified.next_retry_at, `${type} 应允许重新排队`);
  }
});

test('标准规范/公开资料正文变化也按真实输入签名失效', () => {
  for (const [type, id, table, bodyCol] of [
    ['accounting_standard', 'STD-129', 'accounting_standard', 'body_text'],
    ['accounting_public_document', 'APD-129', 'accounting_public_document', 'body_text'],
  ]) {
    stages.syncObjectStages(type, id);
    addSummary(type, id);
    stages.syncObjectStages(type, id);
    const before = db.get(
      'SELECT status FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
      [type, id, 'summarized']
    );
    assertEqual(before.status, 'done');
    // 公开资料从目录页变成有正文的详情页：正文与 body_status 同步改变，
    // 这样摘要输入才是真实变化（仅改 status 之外的空正文字段不算输入变化）。
    db.run(`UPDATE ${table} SET ${bodyCol}=?, body_status='full', updated_at=? WHERE id=?`,
      [`${BODY}\n\n修改后的正文内容，需要重新生成摘要。`.repeat(3), new Date(Date.now() + 1000).toISOString(), id]);
    stages.syncObjectStages(type, id);
    const after = db.get(
      'SELECT status, attempts FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
      [type, id, 'summarized']
    );
    assertEqual(after.status, 'stale', `${type} 摘要应失效`);
    assertEqual(after.attempts, 0);
  }
});

test('公开项目仅有元数据：摘要可匹配公开字段，核验结论仍是 insufficient 而非“已通过”', () => {
  addSummary('public_project', 'PROJ-129', '仅依据公开登记字段生成的摘要。');
  addVerification('public_project', 'PROJ-129', 'insufficient');
  stages.syncObjectStages('public_project', 'PROJ-129');
  const by = Object.fromEntries(stages.getObjectStages('public_project', 'PROJ-129').map((s) => [s.stage, s]));
  assertEqual(by.summarized.status, 'done');
  assertEqual(by.verified.status, 'done', '核验已执行完成（结论可以是 insufficient）');
  const detail = gov.getGovernanceItem('PROJ-129', { objectType: 'public_project' });
  assertEqual(detail.verifications[0].result, 'insufficient');
  assertIncludes(by.verified.detail_json || '', 'insufficient');
});

/* ==================================================================== */
/*  4. 无模型 blocked 与有界 worker                                      */
/* ==================================================================== */

await (async () => {
  // 确保没有可用模型凭据：只使用确定性分支，不发起外网调用。
  db.run('UPDATE llm_provider SET enabled=0');
  const out = await gov.processPending({
    actor: 'test:129', objectTypes: [
      'policy_document', 'methodology_version', 'cea_document',
      'accounting_standard', 'accounting_public_document',
    ],
    only: ['summarized'], limit: 5, budgetMs: 5000, sync: false,
  });
  test('无模型：跨类型摘要 worker 记录 blocked、尝试次数与退避，不写完成', () => {
    assertEqual(out.scanned, 5, JSON.stringify(out));
    assertEqual(out.blocked, 5, '无模型时应全部 blocked');
    for (const a of out.actions) {
      const s = db.get(
        'SELECT status,attempts,next_retry_at,failure_reason FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
        [a.object_type, a.object_id, 'summarized']
      );
      assertEqual(s.status, 'blocked', `${a.object_type}/${a.object_id} 不应写成完成`);
      assert(s.attempts >= 1, `${a.object_type}/${a.object_id} 应记录尝试次数`);
      assert(!!s.next_retry_at, `${a.object_type}/${a.object_id} 应保留下次重试时间`);
      assertIncludes(s.failure_reason || '', '模型', '阻塞原因应说明模型不可用');
    }
  });
})();

finish('test/129-v2-cross-material-stages.test.mjs');
