/**
 * 测试 130（docs/76）：后台按类型筛选、逐条详情、object_type+object_id 隔离、
 * 重试入口、上传/编辑链接定位、权限、共享租约与尝试上限。
 * 仅使用 setupV2 隔离库；不联网、不调用真实模型。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const gov = await import('../src/services/governance-svc.mjs');
const stages = await import('../src/services/processing-stage-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

const now = new Date().toISOString();
const admin = { id: 'u130-admin', name: 'admin-130', role: 'admin' };
const viewer = { id: 'u130-viewer', name: 'viewer-130', role: 'viewer' };
const BODY = '跨类型治理后台测试正文，包含公开来源、时间与可核对条款。'.repeat(24);

db.run(
  `INSERT INTO policy_document
     (id,policy_key,title,doc_number,issuing_authority,category,doc_status,publish_date,summary,
      official_url,source_tier,collected_at,body_snapshot,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['GOV-130', 'key-gov-130', '后台政策 130', '文号130', '发布机关130', 'ministry_policy',
    'effective', '2026-09-10', '政策摘要', 'https://www.mee.gov.cn/gov130.html', 1, now, BODY, now, now]
);
db.run(
  `INSERT INTO methodology_version
     (id,methodology_id,code_display,name,version,document_status,domain,release_date,
      official_url,body_snapshot,catalog_confidence,is_candidate_eligible,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['GOV-130', 'M-GOV-130', 'CCER-10-130', '后台方法学 130', 'V01', 'formal', '测试领域',
    '2026-09-01', 'https://www.mee.gov.cn/gov130.pdf', BODY, 'verified_from_official_notice', 1, now, now]
);
db.run(
  `INSERT INTO accounting_standard
     (id,code,identity_key,title,issuer,sector,standard_type,status,publish_date,original_url,
      body_text,body_status,sha256,extraction_complete,chars,model_verify_status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['STD-130', 'STD-130', 'ik-std-130', '后台标准 130', '发布机关', '发电', 'accounting',
    'formal', '2026-08-01', 'https://www.cets.org.cn/std130.pdf', BODY, 'full', 'c'.repeat(64),
    1, BODY.length, 'unavailable', now, now]
);
db.run(
  `INSERT INTO accounting_public_document
     (id,source_id,source_code,doc_key,doc_type,category,title,url,published_at,issuer,body_text,
      body_status,content_hash,snapshot_path,captured_at,evidence_level,model_verify_status,
      revision_no,is_current,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['APD-130', null, 'cets', 'key-apd-130', 'article', 'policy', '后台公开资料 130',
    'https://www.cets.org.cn/apd130.html', '2026-07-01', '全国碳市场信息网', BODY, 'full',
    'd'.repeat(64), '/tmp/apd130.html', now, 'full_text', 'unavailable', 1, 1, now, now]
);
db.run(
  `INSERT INTO public_project
     (id,registry_project_no,name,owner_name,province,current_stage,official_url,evidence_level,
      last_checked_at,note,is_demo,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['PROJ-130', 'REG-130', '后台项目 130', '业主 130', '山西省', 'project_public',
    'https://ccer.cets.org.cn/project130', 'official_registry', '2026-06-01', '公开字段', 0, now, now]
);
const contentItem = content.upsertContent({
  source_url: 'https://www.example.gov.cn/gov130/content.html',
  title: '后台内容 130', publisher: '测试媒体', content_type: 'industry_news',
  published_at: '2026-09-12', body_snapshot: BODY,
}, { actor: 'test:130' });

for (const [type, id] of [
  ['policy_document', 'GOV-130'], ['methodology_version', 'GOV-130'],
  ['accounting_standard', 'STD-130'], ['accounting_public_document', 'APD-130'],
  ['public_project', 'PROJ-130'], ['content_item', contentItem.id],
]) stages.syncObjectStages(type, id);

test('后台列表按 object_type 筛选，列表项同时携带类型与 ID', () => {
  const all = gov.listPipeline({ sync: false, limit: 50 });
  assertEqual(all.object_types.length, 7, '应返回七类逐条治理对象');
  assert(all.funnel.length === 5);
  const policy = gov.listPipeline({ objectType: 'policy_document', q: '后台政策', sync: false, limit: 20 });
  assert(policy.items.length >= 1);
  assert(policy.items.every((i) => i.object_type === 'policy_document'), '筛选后不得混入其它类型');
  assert(policy.items.every((i) => !!i.id), '列表项必须携带 object_id');
  const method = gov.listPipeline({ objectType: 'methodology_version', q: '后台方法学', sync: false, limit: 20 });
  assertEqual(method.items[0].object_type, 'methodology_version');
  assertIncludes(method.items[0].type_label, '方法学');
});

test('同名 ID：详情按 object_type 返回正确实体与阶段，不串数据', () => {
  const p = gov.getGovernanceItem('GOV-130', { objectType: 'policy_document' });
  const m = gov.getGovernanceItem('GOV-130', { objectType: 'methodology_version' });
  assertEqual(p.item.title, '后台政策 130');
  assertEqual(m.item.name, '后台方法学 130');
  assertEqual(p.object_id, 'GOV-130');
  assertEqual(m.object_id, 'GOV-130');
  assertEqual(p.stages.length, 5);
  assertEqual(m.stages.length, 5);
  assert(p.stages.every((s) => s.object_type === 'policy_document'));
  assert(m.stages.every((s) => s.object_type === 'methodology_version'));
});

test('详情返回正确上传/编辑链接：政策落到 document-upload 表单并预选实体', () => {
  const p = gov.getGovernanceItem('GOV-130', { objectType: 'policy_document' });
  assertEqual(p.links.upload.supported, true);
  assertEqual(p.links.upload.kind, 'policy');
  assertIncludes(p.links.upload.href, 'tab=governance');
  assertIncludes(p.links.upload.href, 'upload_type=policy_document');
  assertIncludes(p.links.upload.href, 'upload_id=GOV-130');
  assertIncludes(p.links.edit.href, 'tab=maintenance');
  assertIncludes(p.links.edit.href, 'entity_type=policy_document');
  assertIncludes(p.links.edit.href, 'entity_id=GOV-130');
  assertIncludes(p.links.edit.href, 'action=edit');
});

test('详情链接：标准规范落到碳核算上传页；不可上传类型明确说明而非假链接', () => {
  const std = gov.getGovernanceItem('STD-130', { objectType: 'accounting_standard' });
  assertEqual(std.links.upload.supported, true);
  assertIncludes(std.links.upload.href, 'tab=accounting');
  assertIncludes(std.links.upload.href, 'upload_type=accounting_standard');
  assertIncludes(std.links.upload.href, 'upload_id=STD-130');
  assertIncludes(std.links.upload.note, '碳核算资料');

  const apd = gov.getGovernanceItem('APD-130', { objectType: 'accounting_public_document' });
  assertEqual(apd.links.upload.supported, false);
  assertIncludes(apd.links.upload.note, '没有 PDF 补传入口');

  const item = gov.getGovernanceItem(contentItem.id, { objectType: 'content_item' });
  assertEqual(item.links.upload.supported, false);
  assertIncludes(item.links.upload.note, '原件补传');
  assertEqual(item.capabilities.summary_supported, true);
  assertEqual(item.capabilities.verification_supported, true);
});

await testAsync('权限：普通用户不能查看/重试；服务层拒绝并携带 object_type+object_id', async () => {
  const denied = await gov.retryStage(viewer, {
    objectType: 'policy_document', objectId: 'GOV-130', stage: 'summarized',
  });
  assertEqual(denied.status, 403);
  assertEqual(denied.object_type, 'policy_document');
  assertEqual(denied.object_id, 'GOV-130');
  const batch = await gov.runGovernanceBatch(viewer, { limit: 1 });
  assertEqual(batch.status, 403);
});

await testAsync('无模型重试：摘要/核验都 blocked 且写回尝试与退避，不伪造完成', async () => {
  db.run('UPDATE llm_provider SET enabled=0');
  const sum = await gov.retryStage(admin, {
    objectType: 'policy_document', objectId: 'GOV-130', stage: 'summarized',
  });
  assertEqual(sum.ok, false);
  assertEqual(sum.status, 'blocked');
  assertEqual(sum.object_type, 'policy_document');
  assertEqual(sum.object_id, 'GOV-130');
  const sumStage = db.get(
    "SELECT status,attempts,next_retry_at FROM processing_stage WHERE object_type='policy_document' AND object_id='GOV-130' AND stage='summarized'"
  );
  assertEqual(sumStage.status, 'blocked');
  assert(sumStage.attempts >= 1);
  assert(!!sumStage.next_retry_at);

  const ver = await gov.retryStage(admin, {
    objectType: 'policy_document', objectId: 'GOV-130', stage: 'verified',
  });
  assertEqual(ver.ok, false);
  assertEqual(ver.status, 'blocked');
  const verStage = db.get(
    "SELECT status,attempts FROM processing_stage WHERE object_type='policy_document' AND object_id='GOV-130' AND stage='verified'"
  );
  assertEqual(verStage.status, 'blocked');
  assert(verStage.attempts >= 1);
});

await testAsync('正文/原件重试：无单条能力时返回 manual_upload/blocked 与正确实体链接', async () => {
  const method = await gov.retryStage(admin, {
    objectType: 'methodology_version', objectId: 'GOV-130', stage: 'fetched',
  });
  assertEqual(method.ok, false);
  assertEqual(method.status, 'blocked');
  assertEqual(method.object_type, 'methodology_version');
  assertIncludes(method.action, 'reparse');
  assert(method.upload && method.upload.href.includes('upload_id=GOV-130'));

  const std = await gov.retryStage(admin, {
    objectType: 'accounting_standard', objectId: 'STD-130', stage: 'parsed',
  });
  assertEqual(std.ok, false);
  assertEqual(std.status, 'blocked');
  assertEqual(std.action, 'manual_upload');
  assertIncludes(std.upload.href, 'tab=accounting');

  const project = await gov.retryStage(admin, {
    objectType: 'public_project', objectId: 'PROJ-130', stage: 'fetched',
  });
  assertEqual(project.ok, true);
  assertEqual(project.status, 'skipped');
});

await testAsync('共享租约：已有采集/补采租约时不抢占，也不增加尝试次数', async () => {
  db.run(
    "UPDATE processing_stage SET status='pending', attempts=0, next_retry_at=? WHERE object_type='policy_document' AND object_id='GOV-130' AND stage='summarized'",
    [now]
  );
  const before = db.get(
    "SELECT attempts FROM processing_stage WHERE object_type='policy_document' AND object_id='GOV-130' AND stage='summarized'"
  );
  const held = gov.acquireLease({ key: 'collection', owner: 'other-130', purpose: 'test', ttlMs: 60000 });
  assertEqual(held.ok, true);
  const out = await gov.processPending({
    actor: 'test:130', objectTypes: ['policy_document'], only: ['summarized'],
    limit: 1, budgetMs: 5000, leaseOwner: 'gov-130', sync: false,
  });
  assertEqual(out.ok, false);
  assertEqual(out.reason, 'lease_busy');
  const after = db.get(
    "SELECT attempts FROM processing_stage WHERE object_type='policy_document' AND object_id='GOV-130' AND stage='summarized'"
  );
  assertEqual(after.attempts, before.attempts);
  gov.releaseLease({ key: 'collection', owner: 'other-130' });
});

await testAsync('达到尝试上限：停止自动重试并保留 blocked/下一次为空', async () => {
  db.run(
    "UPDATE processing_stage SET status='pending', attempts=3, next_retry_at='2000-01-01T00:00:00.000Z' WHERE object_type='policy_document' AND object_id='GOV-130' AND stage='summarized'"
  );
  await gov.processPending({
    actor: 'test:130', objectTypes: ['policy_document'], only: ['summarized'],
    limit: 5, budgetMs: 5000, sync: false,
  });
  const s = db.get(
    "SELECT status,attempts,next_retry_at,failure_reason FROM processing_stage WHERE object_type='policy_document' AND object_id='GOV-130' AND stage='summarized'"
  );
  assertEqual(s.status, 'blocked');
  assertEqual(s.next_retry_at, null);
  assertEqual(s.attempts, 3);
  assertIncludes(s.failure_reason || '', '上限');
});

finish('test/130-v2-governance-multitype-admin.test.mjs');
