/**
 * 测试 126（docs/74 C）：方法学版本时间线、正式/草案隔离、未来生效、
 * 证据关系确认、版本差异来源定位与旧测算保留。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const method = await import('../src/services/methodology-version-svc.mjs');
const verificationSvc = await import('../src/services/verification-svc.mjs');

console.log('\n[v2-126] 方法学版本：时间线、证据关系、差异与旧测算保留');

const admin = { id: 'u-admin', name: 'admin-test', role: 'admin' };
const researcher = { id: 'u-res', name: 'researcher', role: 'researcher' };
const viewer = { id: 'u-viewer', name: 'viewer', role: 'viewer' };
const now = new Date().toISOString();
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const MID = 'TEST-METH-001';
const BODY1 = [
  '第一条 本方法学适用于瓦斯利用项目。',
  '项目边界包括瓦斯抽采、输送与利用设施，不包括项目外的电网排放。',
  '计入期为首个减排量登记之日起 10 年。',
  '监测要求：项目业主应按月计量瓦斯流量、浓度与利用量，并保留原始记录。',
  '关键参数默认值见附表。',
].join('\n');
const BODY2 = `${BODY1
  .replace('10 年', '7 年')
  .replace('瓦斯流量、浓度与利用量', '瓦斯流量、浓度、利用量与电量')
  .replace('不包括项目外的电网排放', '包括项目边界内的电网排放')}
本版本替代 V01 版本，原 V01 自本版本生效之日起停止执行。`;

function insertVersion(id, version, status, body, opts = {}) {
  db.run(
    `INSERT INTO methodology_version
       (id,methodology_id,code_display,name,version,document_status,domain,project_types,tech_routes,
        scale_note,crediting_note,release_date,effective_date,repeal_date,official_url,original_file_hash,
        catalog_confidence,is_candidate_eligible,created_at,updated_at,body_snapshot,evidence_level,auto_verify_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, MID, `CCER-TEST-${version}`, '测试方法学：瓦斯利用', version, status, '煤矿瓦斯',
      JSON.stringify(opts.project_types || ['瓦斯利用']), JSON.stringify(['瓦斯发电']),
      opts.scale_note || '适用于年利用瓦斯量不低于 1 万立方米的项目',
      opts.crediting_note || '计入期 10 年', opts.release_date || '2026-01-01',
      opts.effective_date || '2026-02-01', opts.repeal_date || null,
      opts.official_url || 'https://www.mee.gov.cn/xxgk/methodology/test.pdf', 'hash-test-file',
      'verified_from_official_notice', 1, now, now, body, 'unverified', opts.auto_verify || null,
    ]
  );
}

insertVersion('MV-TEST-1', 'V01', 'formal', BODY1, { release_date: '2026-01-01', effective_date: '2026-02-01' });
insertVersion('MV-TEST-2', 'V02', 'formal', BODY2, { release_date: '2026-10-20', effective_date: tomorrow, scale_note: '适用于年利用瓦斯量不低于 2 万立方米的项目', crediting_note: '计入期 7 年', official_url: 'https://www.mee.gov.cn/xxgk/methodology/test-b.pdf' });
insertVersion('MV-TEST-DRAFT', 'V03-DRAFT', 'draft', '征求意见稿：拟调整监测要求。', { release_date: '2026-10-21', effective_date: null });
insertVersion('MV-TEST-EMPTY', 'V04', 'formal', '', { release_date: '2026-10-22', effective_date: '2026-11-01', scale_note: '适用于其他瓦斯项目' });

for (const [vid, val] of [['MV-TEST-1', 1.2], ['MV-TEST-2', 1.5], ['MV-TEST-EMPTY', 1.5]]) {
  db.run(
    `INSERT INTO factor_version (id,factor_key,name,value,unit,methodology_version_id,scope,source_ref,source_year,value_status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [`FV-${vid}`, 'EF-TEST', '测试排放因子', val, 'tCO2/MWh', vid, 'methodology', '官方附表', 2026, 'verified', now]
  );
  db.run(
    `INSERT INTO formula (id,methodology_version_id,formula_id,title,expression,unit,clause_ref,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [`FM-${vid}`, vid, 'EF-TEST', '测试公式', 'E = AD * EF', 'tCO2e', '第 5 条', now]
  );
  db.run(
    `INSERT INTO rule (id,methodology_version_id,layer,rule_id,title,condition_text,expression_text,expr,required_fields,clause_ref,severity,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`RU-${vid}`, vid, 'specific', 'RULE-TEST', '测试规则', '项目边界内', 'true', '{}', '[]', '第 2 条', 'blocking', now]
  );
}

test('时间线：正式/草案分栏、未来生效、未知关系不按编号推断', () => {
  const t = method.methodologyTimeline('MV-TEST-1');
  assert(t, '应返回时间线');
  assertEqual(t.formal.length, 3, '正式版本 3 个');
  assertEqual(t.draft.length, 1, '草案 1 个');
  const v2 = t.formal.find((v) => v.id === 'MV-TEST-2');
  assertEqual(v2.future_effective, true, '未来生效日期应标记');
  assertIncludes(v2.status_label, '未来生效');
  const v1 = t.formal.find((v) => v.id === 'MV-TEST-1');
  assert(!v1.events.some((e) => e.type === 'superseded'), '没有证据关系时不得推断已被替代');
  const draft = t.draft[0];
  assert(draft.events.some((e) => e.type === 'consultation'), '草案应有征求意见事件');
  assert(!draft.events.some((e) => e.type === 'formal'), '草案不得出现正式发布事件');
});

test('候选关系缺原文证据时拒绝；有引文但未核验时仍是 candidate', () => {
  assertEqual(method.proposeRelation(viewer, {}).status, 403);
  const noEvidence = method.proposeRelation(admin, {
    from_version_id: 'MV-TEST-2', to_version_id: 'MV-TEST-1', relation_type: 'supersedes',
  });
  assertEqual(noEvidence.status, 400);
  const candidate = method.proposeRelation(researcher, {
    from_version_id: 'MV-TEST-2', to_version_id: 'MV-TEST-1', relation_type: 'supersedes',
    evidence_url: 'https://www.mee.gov.cn/xxgk/methodology/test-b.pdf',
    evidence_locator: '修订通知第 2 页第 3 段',
    evidence_quote: '本版本替代 V01 版本',
  });
  assertEqual(candidate.confirmed, false, JSON.stringify(candidate));
  assertIncludes(candidate.reason, '核验');
  const rel = db.get("SELECT * FROM methodology_version_relation WHERE from_version_id='MV-TEST-2' AND to_version_id='MV-TEST-1'");
  assertEqual(rel.status, 'candidate');
});

await testAsync('既有核验通过后关系可自动确认，并在时间线显示证据', async () => {
  const current = verificationSvc.objectVerificationInput('methodology_version', 'MV-TEST-2');
  db.run(
    `INSERT INTO verification_result
       (id,object_type,object_id,result,ui_state,rules_ok,rules_json,model_used,provider_id,model,
        evidence_level,summary,input_hash,input_hash_scheme,policy_hash,model_key,evidence_hash,
        citations_validated,citations_rejected,prompt_chars,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['VR-MV-TEST-2', 'methodology_version', 'MV-TEST-2', 'verified', 'auto_verified', 1, '[]', 1, 'p1', 'm1',
      'full_text', '既有核验通过', current.inputHash, verificationSvc.INPUT_HASH_SCHEME,
      current.policyHash, current.modelKey, current.evidenceHash, 1, 0, 100, now]
  );
  const rec = method.reconcileAllRelations();
  assert(rec.confirmed >= 1, JSON.stringify(rec));
  const t = method.methodologyTimeline('MV-TEST-1');
  const old = t.formal.find((v) => v.id === 'MV-TEST-1');
  const event = old.events.find((e) => e.type === 'superseded');
  assert(event, '已确认替代关系应出现在旧版本时间线');
  assertEqual(event.status, 'confirmed');
  assertIncludes(event.evidence_locator, '第 2 页');
  assertIncludes(event.evidence_quote, '替代');
  const confirmed = method.listRelations({ versionId: 'MV-TEST-1', status: 'confirmed' });
  assert(confirmed.length >= 1, '应能查询确认关系');
});

test('版本差异：五个维度带来源定位；缺证据明确无法比较', () => {
  const diff = method.compareVersions('MV-TEST-2', 'MV-TEST-1');
  assertEqual(diff.ok, true, JSON.stringify(diff));
  assertEqual(diff.diffs.length, 5);
  const boundary = diff.diffs.find((d) => d.aspect === 'boundary');
  assertEqual(boundary.change_kind, 'changed');
  assert(boundary.evidence.length >= 2, '边界差异应带两版来源');
  assert(boundary.evidence.every((e) => e.locator && e.quote), '每条差异证据应有定位与引文');
  const mon = diff.diffs.find((d) => d.aspect === 'monitoring');
  assertEqual(mon.change_kind, 'changed');
  assertIncludes(mon.evidence[0].locator, '正文快照');
  const params = diff.diffs.find((d) => d.aspect === 'parameters');
  assertEqual(params.change_kind, 'changed');
  assertIncludes(params.summary, '因子');
  const saved = method.savedDiffs('MV-TEST-2', 'MV-TEST-1');
  assertEqual(saved.length, 5, '差异应持久化');
  assert(saved.every((d) => ['same', 'changed', 'insufficient'].includes(d.change_kind)));

  const bad = method.compareVersions('MV-TEST-2', 'MV-TEST-1');
  assertEqual(bad.ok, true);
  const cross = method.compareVersions('MV-TEST-2', 'MV-TEST-EMPTY');
  // 空正文版本：边界/监测/计入期应明确无法比较，而不是编造差异
  assert(cross.insufficient_aspects.length >= 2, JSON.stringify(cross.insufficient_aspects));
  assertIncludes(cross.diffs.find((d) => d.aspect === 'boundary').summary, '无法比较');
  // 不同 methodology_id 不允许比较
  db.run(
    `INSERT INTO methodology_version (id,methodology_id,code_display,name,version,document_status,catalog_confidence,is_candidate_eligible,created_at,updated_at)
     VALUES ('MV-OTHER','OTHER-001','OTHER-V01','别的方法学','V01','formal','verified_from_official_notice',1,?,?)`,
    [now, now]
  );
  const wrong = method.compareVersions('MV-TEST-2', 'MV-OTHER');
  assertEqual(wrong.status, 400);
});

test('旧测算保留 methodology_version_id 与输入参数，不因新版本/差异而改写', () => {
  db.run(
    `INSERT INTO project (id,code,name,stage,team_id,analyst,confidentiality,created_at,updated_at)
     VALUES ('P-TEST-126','P-126','测试项目','运营','team-default','tester','internal',?,?)`,
    [now, now]
  );
  const inputs = JSON.stringify({ gas_volume: 12345, factor: 1.2 });
  db.run(
    `INSERT INTO calculation_run
       (id,project_id,methodology_version_id,plugin_key,plugin_version,scenario,analysis_base_date,run_at,
        operator,status,inputs_json,result_json,factor_snapshot_json,audit_status,review_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['CALC-126', 'P-TEST-126', 'MV-TEST-1', 'test-plugin', '1.0', 'base', '2026-01-31', now,
      'tester', 'ok', inputs, JSON.stringify({ reduction: 100 }), JSON.stringify({ factor: 1.2 }), 'reviewed', 'reviewed']
  );
  method.compareVersions('MV-TEST-2', 'MV-TEST-1');
  const t = method.methodologyTimeline('MV-TEST-1');
  const old = t.formal.find((v) => v.id === 'MV-TEST-1');
  assertEqual(old.calculation_runs, 1);
  assertIncludes(old.calculation_runs_note, '不改写');
  const calc = db.get('SELECT * FROM calculation_run WHERE id=?', ['CALC-126']);
  assertEqual(calc.methodology_version_id, 'MV-TEST-1');
  assertEqual(calc.inputs_json, inputs, '旧测算输入参数不得被差异计算改写');
  assertEqual(calc.result_json, JSON.stringify({ reduction: 100 }));
});

finish('test/126-v2-methodology-version.test.mjs');
