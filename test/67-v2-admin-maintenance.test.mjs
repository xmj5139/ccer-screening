/**
 * v2.6 测试 67（docs/44 第 5 条）：后台「运行与内容维护」—— 缺口原因、有界重试、
 * 白名单编辑、覆盖层与可恢复历史、审计与角色。
 * ============================================================================
 * 覆盖：
 *   · 普通用户（含 researcher）编辑 / 查看维护接口 → 403（不是隐藏按钮）；
 *   · 白名单字段校验：非白名单字段、超长、非法日期、非 http(s) URL 全部拒绝；
 *   · 防存储 XSS：脚本/事件属性载荷被拒绝；
 *   · 修订写入**覆盖层**并标记「管理员修订」，业务表原始值与官方数值不被 UPDATE；
 *   · 修改前后版本可查、可恢复；审计留痕；
 *   · 编辑缺口说明不等于修复原始数据（提示明确）；
 *   · 动态表名/字段名不接受外部输入。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const maint = await import('../src/services/admin-maintenance-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

console.log('\n[v2-67] 后台运行与内容维护：覆盖层编辑、审计与角色');

const admin = { id: 'u-admin', name: 'admin-test', role: 'admin' };
const viewer = { id: 'u-viewer', name: 'viewer', role: 'viewer' };
const researcher = { id: 'u-res', name: 'researcher', role: 'researcher' };

const CNT = content.upsertContent({
  source_url: 'https://www.tanpaifang.com/a/edit-target.html',
  title: '待修订的公开研报条目', publisher: '碳排放交易网',
  body_snapshot: '这是一篇用于后台修订测试的公开研报正文。'.repeat(20),
  content_type: 'research_report', published_at: '2026-09-15', record_kind: 'article',
}, { actor: 'test:67' });
const CNT_ID = CNT.id;

/* ==================================================================== */
/*  一、角色：普通用户必须 403                                           */
/* ==================================================================== */

test('普通用户与研究员不得查看或编辑公开内容（服务端 403）', () => {
  for (const u of [viewer, researcher]) {
    assertEqual(maint.listEditableEntities(u, {}).status, 403, `${u.role} 不得列出可编辑内容`);
    assertEqual(maint.previewEdit(u, { entity_type: 'content_item', entity_id: CNT_ID }).status, 403);
    assertEqual(maint.applyEdit(u, { entity_type: 'content_item', entity_id: CNT_ID, fields: { title: 'x' } }).status, 403);
    assertEqual(maint.listRevisions(u, {}).status, 403);
    assertEqual(maint.restoreRevision(u, 'REV-1').status, 403);
    assertEqual(maint.maintenanceOverview(u).status, 403, `${u.role} 不得查看运行维护总览`);
    assertEqual(maint.gapReasons(u, {}).status, 403);
  }
  const anon = maint.applyEdit(null, { entity_type: 'content_item', entity_id: CNT_ID, fields: { title: 'x' } });
  assertEqual(anon.status, 403);
});

test('管理员可列出可编辑实体，且字段白名单与实际表结构一致', () => {
  const issues = maint.editableFieldIssues();
  assertEqual(issues.length, 0, `字段白名单必须与实际表结构一致，实际：${JSON.stringify(issues)}`);
  const out = maint.listEditableEntities(admin, { entity_type: 'content_item', q: '待修订' });
  assert(out.entities?.content_item, '应返回 content_item 分组');
  const keys = out.entities.content_item.fields.map((f) => f.key);
  for (const k of ['title', 'summary', 'source_url', 'publisher', 'published_at']) {
    assert(keys.includes(k), `白名单应含 ${k}`);
  }
  assert(!keys.includes('id'), 'id 不可编辑');
  assert(!keys.includes('body_snapshot'), '原始正文快照不可被覆盖');
  assert(!keys.includes('verification_status'), '核验状态不可手改');
});

/* ==================================================================== */
/*  二、字段校验：白名单 / 长度 / 日期 / URL / XSS                        */
/* ==================================================================== */

test('非白名单字段与非法取值一律拒绝，且不写库', () => {
  const before = db.get('SELECT title FROM content_item WHERE id=?', [CNT_ID]).title;

  const unknownType = maint.applyEdit(admin, { entity_type: 'sqlite_master', entity_id: 'x', fields: { name: 'y' } });
  assertEqual(unknownType.status, 400, '未知实体类型应 400');

  const unknownField = maint.applyEdit(admin, { entity_type: 'content_item', entity_id: CNT_ID, fields: { id: 'HACKED' } });
  assertEqual(unknownField.status, 400);
  assertIncludes(unknownField.issues.join('｜'), '白名单');

  const tooLong = maint.applyEdit(admin, { entity_type: 'content_item', entity_id: CNT_ID, fields: { title: '长'.repeat(400) } });
  assertEqual(tooLong.status, 400);
  assertIncludes(tooLong.issues.join('｜'), '上限');

  const badDate = maint.applyEdit(admin, { entity_type: 'content_item', entity_id: CNT_ID, fields: { published_at: '2026/09/15' } });
  assertEqual(badDate.status, 400);
  assertIncludes(badDate.issues.join('｜'), 'YYYY-MM-DD');

  for (const badUrl of ['javascript:alert(1)', 'data:text/html,<script>x</script>', '/relative/path', 'file:///etc/passwd']) {
    const out = maint.applyEdit(admin, { entity_type: 'content_item', entity_id: CNT_ID, fields: { source_url: badUrl } });
    assertEqual(out.status, 400, `${badUrl} 应被拒绝`);
    assertIncludes(out.issues.join('｜'), 'http(s)');
  }

  for (const payload of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>']) {
    const out = maint.applyEdit(admin, { entity_type: 'content_item', entity_id: CNT_ID, fields: { title: payload } });
    assertEqual(out.status, 400, `脚本载荷应被拒绝：${payload}`);
    assertIncludes(out.issues.join('｜'), '防存储 XSS');
  }

  assertEqual(db.get('SELECT title FROM content_item WHERE id=?', [CNT_ID]).title, before, '被拒绝的提交不得改动数据');
  assertEqual(db.get('SELECT COUNT(*) c FROM admin_revision WHERE entity_id=?', [CNT_ID]).c, 0, '被拒绝的提交不得产生修订记录');
});

/* ==================================================================== */
/*  三、覆盖层：不改写原始值，可查历史、可恢复                            */
/* ==================================================================== */

await testAsync('管理员修订写入覆盖层并标记「管理员修订」，原始值不被改写', async () => {
  const originalTitle = db.get('SELECT title, source_url FROM content_item WHERE id=?', [CNT_ID]).title;
  const out = maint.applyEdit(admin, {
    entity_type: 'content_item', entity_id: CNT_ID,
    fields: { title: '管理员修订后的标题', source_url: 'https://www.mee.gov.cn/xxgk/2026/corrected.html' },
    note: '来源链接改回官方原文',
  });
  assertEqual(out.ok, true, JSON.stringify(out));
  assertEqual(out.revisions.length, 2, '应记录 2 个字段的修订');
  // 业务表原始值保持不变（不得悄悄覆盖）
  assertEqual(db.get('SELECT title FROM content_item WHERE id=?', [CNT_ID]).title, originalTitle, '原始标题不得被 UPDATE');
  // 覆盖层生效于读路径
  const row = db.get('SELECT * FROM content_item WHERE id=?', [CNT_ID]);
  const merged = maint.mergeOverlay('content_item', row);
  assertEqual(merged.title, '管理员修订后的标题', '读路径应合并覆盖层');
  assertEqual(merged.manual_revision, true, '应标记为管理员修订');
  assert(merged.manual_fields.includes('title'));
  assertEqual(merged.original_values.title, originalTitle, '应保留修改前的值');
  // 审计留痕
  const audits = db.all("SELECT * FROM audit_log WHERE action='maintenance.edit' AND object_id=?", [CNT_ID]);
  assertEqual(audits.length, 2, '每个字段都应写审计');
  assertIncludes(audits[0].detail, '官方原文', '审计应包含修订说明');
  // 历史可查
  const hist = maint.listRevisions(admin, { entity_id: CNT_ID });
  assertEqual(hist.revisions.length, 2);
  assert(hist.revisions.every((r) => r.status === 'active'));
});

await testAsync('二次修订保留历史版本，并可恢复到任意历史值 / 原始采集值', async () => {
  const first = maint.listRevisions(admin, { entity_id: CNT_ID }).revisions.find((r) => r.field_key === 'title');
  const again = maint.applyEdit(admin, {
    entity_type: 'content_item', entity_id: CNT_ID, fields: { title: '第二次修订标题' },
  });
  assertEqual(again.ok, true);
  const hist = maint.listRevisions(admin, { entity_id: CNT_ID }).revisions.filter((r) => r.field_key === 'title');
  assertEqual(hist.filter((r) => r.status === 'active').length, 1, '同一字段只应有一个生效版本');
  assertEqual(hist.filter((r) => r.status === 'superseded').length, 1, '旧版本应保留为历史');
  assert(hist[0].revision_no >= 2, '修订号应递增');

  // 恢复到第一次修订值
  const restored = maint.restoreRevision(admin, first.id);
  assertEqual(restored.ok, true);
  assertEqual(maint.mergeOverlay('content_item', db.get('SELECT * FROM content_item WHERE id=?', [CNT_ID])).title,
    first.value, '应恢复到指定历史版本');
  const restoreAudit = db.all("SELECT * FROM audit_log WHERE action='maintenance.restore'");
  assertEqual(restoreAudit.length, 1, '恢复动作应写审计');
});

/* ==================================================================== */
/*  四、运行状态 / 缺口原因 / 有界重试                                    */
/* ==================================================================== */

await testAsync('运行维护总览给管理员：缺口原因、摘要状态、问答状态齐备；缺口说明不等于修复数据', async () => {
  const out = maint.maintenanceOverview(admin, { gapStatus: 'all' });
  assert(out.run, '应返回运行状态');
  assert(out.gaps, '应返回缺口');
  assert(out.summaries, '应返回摘要状态');
  assert(out.chat, '应返回问答状态');
  assert(Array.isArray(out.official_domains) && out.official_domains.length > 0, '应返回官方域名登记');
  assert(out.edit_types.length >= 5, '应返回可编辑实体类型');
  for (const g of out.gaps.items || []) {
    assert('reason' in g, '每条缺口应有原因字段');
    assertIncludes(g.raw_data_fix, '不会改变原始数据', '必须说明编辑缺口说明不等于修复原始数据');
  }
  const reasons = maint.gapReasons(admin, { status: 'all' });
  assert(Array.isArray(reasons.gaps), '缺口原因接口应返回列表');
});

await testAsync('有界重试：不支持的目标 400；摘要目标在无模型时如实失败', async () => {
  const bad = await maint.runRetry(admin, { target: 'drop-table' });
  assertEqual(bad.status, 400);
  assertIncludes(bad.error, '不支持的重试目标');
  const sum = await maint.runRetry(admin, { target: 'summaries', limit: 2 });
  assertEqual(sum.target, 'summaries');
  assertEqual(sum.model_configured, false, '测试库未配置模型');
  assertEqual(sum.generated, 0, '无模型时不得生成摘要');
  assertIncludes(sum.message, '不伪造');
  const audit = db.all("SELECT * FROM audit_log WHERE action='maintenance.retry'");
  assert(audit.length >= 1, '重试动作应写审计');
});

test('官方域名登记：仅管理员可维护，且拒绝通配符与非法域名', () => {
  assertEqual(maint.upsertOfficialDomain(viewer, { domain: 'x.gov.cn', label: 'x' }).status, 403);
  for (const bad of ['*.gov.cn', 'not a domain', 'http://', '..', 'localhost']) {
    const out = maint.upsertOfficialDomain(admin, { domain: bad, label: '测试' });
    assertEqual(out.status, 400, `${bad} 应被拒绝`);
  }
  const ok = maint.upsertOfficialDomain(admin, { domain: 'example.gov.cn', label: '示例主管机构', kind: 'official' });
  assertEqual(ok.ok, true);
  assertEqual(db.get("SELECT enabled FROM official_domain WHERE domain='example.gov.cn'").enabled, 1);
  // 管理员粘贴完整 URL 时只取 hostname（不把路径/协议写进登记表）
  const pasted = maint.upsertOfficialDomain(admin, { domain: 'https://pasted.example.gov.cn/xxgk/2026/x.html', label: '粘贴 URL 的机构' });
  assertEqual(pasted.ok, true);
  assertEqual(pasted.domain, 'pasted.example.gov.cn', '应只登记 hostname');
  const audit = db.all("SELECT * FROM audit_log WHERE action='official_domain.upsert'");
  assertEqual(audit.length, 2, '域名登记变更应写审计');
});

finish('67-v2-admin-maintenance.test.mjs');
