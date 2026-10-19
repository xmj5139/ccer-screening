/**
 * v2 测试 27：陈旧提醒与动态缺口文案回归（真实浏览器回归的隔离复现）
 * ============================================================================
 * 真实回归（2026-09-30 于 http://127.0.0.1:8910/v2 实测）：
 *   1. 总览「自动运行状态」仍把**已结清**的核对提醒当作未读待关注展示，
 *      正文还是结清前的错误数值对比（「官方累计成交量差分 2630 吨 …
 *      与系统当日成交量 500 吨不一致」），而对应 data_reconciliation 已结清；
 *   2. 「数据缺口与自动补全状态」标题仍是「部分政策原件（PDF）尚未归档与页码提取」，
 *      实际 14/14 原件已归档、只剩 2 条 JS 渲染页正文无法自动提取。
 *
 * 本文件守护修复后的口径（全部在独立临时库运行、默认不联网）：
 *   A. 提醒生命周期：所指核对记录/告警结清 → 提醒记 resolved_at/resolved_by/resolution，
 *      不再作为待关注；正文刷新与真实未结清项仍如实提示；
 *      **不是**把提醒标成「已读」来掩盖问题。
 *   B. 动态缺口 title/impact/auto_action 与实时归档状态同源（三种状态如实区分），
 *      展示层即使台账未同步也不会显示与事实相反的标题。
 *   C. 无法自动读取官方目录时写「自动核验受阻、未核实」，不写成人工待办。
 */
import {
  setupV2, test, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db, collect, reconcile, dash } = ctx;
const archiveSvc = await import('../src/services/policy-archive-svc.mjs');
const { DATA_GAPS } = await import('../src/data/policy-catalog.mjs');

console.log('\n[v2-27] 陈旧提醒与动态缺口文案回归');

const iso = () => new Date().toISOString();
const feedOf = (limit = 30) => dash.updateFeed({ limit });
const feedItems = (feed, kind) => feed.items.filter((i) => !kind || i.kind === kind);
const findFeed = (feed, needle) => feed.items.find((i) => String(i.title || '').includes(needle) || String(i.detail || '').includes(needle));

/* ==================================================================== */
/*  A. 提醒生命周期：结清后不得继续作为待关注                            */
/* ==================================================================== */

test('A1 真实回归复现：核对记录结清后，旧提醒不再以未读待关注出现', () => {
  // 与真实库同一条：2025-03-21 累计差分告警（critical）→ 生成未读提醒
  const issued = reconcile.recordIssue({
    dataset: 'trade',
    object_id: 'TD-REG-2025-03-21',
    object_label: '交易日 2025-03-21',
    check_kind: 'cumulative_gap',
    severity: 'critical',
    detail: '官方累计成交量差分 2630 吨（2025-03-19 → 2025-03-21）与系统当日成交量 500 吨不一致，可能漏采交易日或官方修订了历史数据。',
    expected: '2630',
    actual: '500',
  });
  const notif = db.get("SELECT * FROM notification WHERE object_type='data_reconciliation' AND object_id=?", [issued.id]);
  assert(notif, 'critical 差异必须产生一条提醒');
  assertEqual(notif.resolved_at, null, '刚产生的提醒不应带结清时间');
  let feed = feedOf();
  const pendingBefore = feed.items.find((i) => i.id === notif.id);
  assert(pendingBefore, '未结清提醒必须出现在总览更新流');
  assertEqual(pendingBefore.status, '待读', '未结清提醒状态应为待读');
  assert(feed.counts.unread_notifications >= 1, '未结清提醒应计入未读提醒数');

  /* 结清路径与真实库一致：每日复查未再检出 → closeAbsentIssues 归档核对记录 */
  const closed = reconcile.closeAbsentIssues({ trade: { ok: true, items: [] } }, 'system:reconcile');
  assert(closed >= 1, '未再检出的核对记录应被自动结清');
  assertEqual(
    db.get('SELECT status FROM data_reconciliation WHERE id=?', [issued.id]).status,
    'resolved',
    '核对记录应结清'
  );
  const after = db.get('SELECT * FROM notification WHERE id=?', [notif.id]);
  assert(after.resolved_at, '提醒必须记录结清时间（生命周期同步）');
  assertIncludes(after.resolution, '已结清', '提醒结清说明必须写明所指核对记录已结清');

  feed = feedOf();
  assert(!feed.items.some((i) => i.id === notif.id), '已结清的提醒不得继续作为待关注出现在更新流');
  assert(!findFeed(feed, '2630 吨'), '结清后不得再把结清前的错误数值对比当作当前事项展示');
  assert(feed.counts.settled_notifications >= 1, '已结清提醒应单独计数');
  assertEqual(feed.counts.unread_notifications, 0, '已结清提醒不得再计入未读提醒数');
  assertIncludes(feed.note, '已结清留痕', '口径说明应写明已结清提醒不再列为待关注');
});

test('A2 结清同步幂等：重复运行不重写结清时间、不产生新变更', () => {
  const row = db.get("SELECT * FROM notification WHERE resolved_at IS NOT NULL ORDER BY created_at DESC LIMIT 1");
  assert(row, '应先有已结清提醒');
  const first = collect.syncNotificationLifecycle({ actor: 'test:idempotent' });
  const after1 = db.get('SELECT resolved_at, resolution FROM notification WHERE id=?', [row.id]);
  assertEqual(after1.resolved_at, row.resolved_at, '重复同步不得改写结清时间');
  assertEqual(after1.resolution, row.resolution, '重复同步不得改写结清说明');
  assertEqual(first.resolved.length, 0, '重复同步不应再结清任何提醒');
  assertEqual(first.refreshed.length, 0, '重复同步不应再刷新任何提醒');
});

test('A3 仍未结清但正文已变 → 提醒正文与核对记录保持一致（不展示过期数值）', () => {
  const issued = reconcile.recordIssue({
    dataset: 'trade',
    object_id: 'TD-REG-REFRESH',
    object_label: '交易日 2099-01-05',
    check_kind: 'cumulative_gap',
    severity: 'critical',
    detail: '旧正文：官方累计差分 100 吨与系统当日 10 吨不一致。',
  });
  // 同一去重键再次检出，detail 更新（真实链路：recordIssue 命中未结清记录时更新而不新增）
  reconcile.recordIssue({
    dataset: 'trade',
    object_id: 'TD-REG-REFRESH',
    object_label: '交易日 2099-01-05',
    check_kind: 'cumulative_gap',
    severity: 'critical',
    detail: '新正文：区间 (2099-01-04, 2099-01-05] 内缺 1 个交易日行情记录，不做单日相减。',
  });
  collect.syncNotificationLifecycle({ actor: 'test:refresh' });
  const notif = db.get("SELECT * FROM notification WHERE object_type='data_reconciliation' AND object_id=?", [issued.id]);
  assertEqual(notif.resolved_at, null, '仍未结清的提醒不得被结清');
  assertIncludes(notif.detail, '缺 1 个交易日', '未结清提醒正文必须刷新为当前核对记录内容');
  assertNotIncludes(notif.detail, '旧正文', '未结清提醒不得继续展示过期正文');
  const feed = feedOf();
  const item = feed.items.find((i) => i.id === notif.id);
  assert(item, '真正未结清的提醒仍必须作为待关注提示');
  assertIncludes(item.detail, '缺 1 个交易日', '更新流展示的必须是刷新后的正文');
});

test('A4 无法判定结清条件的提醒保持原状（不猜测、不自动关闭）', () => {
  const id = collect.notify({
    kind: 'new_policy',
    title: '官方频道发现测试公告',
    detail: '信息型提醒，没有可判定的结清条件。',
    severity: 'normal',
    object_type: 'policy_discovery',
    object_id: 'https://www.mee.gov.cn/test.html',
  });
  collect.syncNotificationLifecycle({ actor: 'test:no-guess' });
  assertEqual(db.get('SELECT resolved_at FROM notification WHERE id=?', [id]).resolved_at, null,
    '信息型提醒不得被自动结清');
});

test('A5 告警结清同样联动提醒（alert 分支）', () => {
  const alertId = 'ALR-TEST-CLOSE';
  db.run(
    `INSERT INTO alert (id,kind,severity,title,detail,source_id,methodology_id,domain,region,project_types,created_at,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [alertId, 'structure_changed', 'warning', '测试告警', '测试详情', null, null, null, null, '[]', iso(), 'open']
  );
  const ntfId = collect.notify({
    kind: 'ingestion_alert',
    title: '测试告警提醒',
    detail: '指向 alert 的提醒',
    severity: 'high',
    object_type: 'alert',
    object_id: alertId,
  });
  assertEqual(db.get('SELECT resolved_at FROM notification WHERE id=?', [ntfId]).resolved_at, null);
  db.run("UPDATE alert SET status='closed' WHERE id=?", [alertId]);
  collect.syncNotificationLifecycle({ actor: 'test:alert' });
  const row = db.get('SELECT * FROM notification WHERE id=?', [ntfId]);
  assert(row.resolved_at, '所指告警结清后提醒应记结清');
  assert(!feedOf().items.some((i) => i.id === ntfId), '已结清告警提醒不得再作为待关注');
});

test('A6 「已读」不等于「已结清」：只标已读不能把未结清问题移出待关注', () => {
  const issued = reconcile.recordIssue({
    dataset: 'trade',
    object_id: 'TD-REG-READONLY',
    object_label: '交易日 2099-02-02',
    check_kind: 'cumulative_gap',
    severity: 'critical',
    detail: '未结清差异（只标已读测试）。',
  });
  const notif = db.get("SELECT * FROM notification WHERE object_type='data_reconciliation' AND object_id=?", [issued.id]);
  collect.markNotificationRead({ name: 'tester' }, notif.id);
  const row = db.get('SELECT * FROM notification WHERE id=?', [notif.id]);
  assert(row.read_at, '应记录已读');
  assertEqual(row.resolved_at, null, '标已读不得写成已结清');
  const feed = feedOf();
  const item = feed.items.find((i) => i.id === notif.id);
  assert(item, '只标已读的未结清提醒仍应出现在更新流');
  assertEqual(item.status, '已读', '展示状态应为「已读」，而不是「已结清」');
});

/* ==================================================================== */
/*  B. 动态缺口：title / impact / auto_action 与实时归档状态同源          */
/* ==================================================================== */

function archiveAllOthers({ quality = 'good', except = [] } = {}) {
  for (const p of db.all("SELECT id FROM policy_document WHERE doc_status != 'superseded'")) {
    if (except.includes(p.id)) continue;
    const has = db.get(
      'SELECT COUNT(*) c FROM policy_attachment WHERE policy_id=? AND local_path IS NOT NULL AND file_hash IS NOT NULL',
      [p.id]
    ).c;
    if (!has) {
      db.run(
        `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [`PAT-GAP-${p.id.slice(-8)}`, p.id, 'f.html', 'html', 'https://www.mee.gov.cn/', `h-${p.id}`, 'data/f.html', quality, '测试填充', iso()]
      );
    }
  }
}

const GAP_KEY = 'gap-policy-original-archive';

test('B1 仍有政策未归档 → 标题写明待归档条数，自动处理方式无人工待办字样', () => {
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,collected_at,created_at,updated_at)
     VALUES ('POL-GAP-A','pol-gap-a','缺口文案测试政策','management','effective','https://www.mee.gov.cn/gap.html',?,?,?)`,
    [iso(), iso(), iso()]
  );
  const out = archiveSvc.syncPolicyArchiveGap({ actor: 'test:gap' });
  assertEqual(out.closed, false, '仍有未归档原件时缺口必须保持 open');
  const row = db.get('SELECT * FROM data_gap WHERE gap_key=?', [GAP_KEY]);
  assertEqual(row.status, 'open');
  assertIncludes(row.title, '尚未全部归档', '未归档状态标题应写明尚未全部归档');
  assertIncludes(row.title, '待归档', '标题应给出待归档条数');
  assertNotIncludes(row.title, '人工');
  assertNotIncludes(row.auto_action, '人工');
  assertIncludes(row.auto_action, '自动', '自动处理方式应说明自动重试');
});

test('B2 原件已全部归档但正文不可提取 → 标题不再写「尚未归档」，并说明自动核验受阻', () => {
  // 其他政策补齐可核验原件；本测试政策只有一条 partial 归档（正文抽取受阻）
  archiveAllOthers({ except: ['POL-GAP-A'] });
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-GAP-A','POL-GAP-A','page.html','html','https://www.mee.gov.cn/gap.html','hash-gap-a','data/gap.html','partial','官方页面原件已落盘，但正文抽取结果过短（脚本渲染页）',?)`,
    [iso()]
  );
  const out = archiveSvc.syncPolicyArchiveGap({ actor: 'test:gap' });
  assertEqual(out.closed, false, '原件已归档但正文不可提取时必须保持 open（不强行清零）');
  assertEqual(out.pending, 0, '不应再有未归档条目');
  assert(out.unparsed >= 1, '应统计正文不可提取条目');
  const row = db.get('SELECT * FROM data_gap WHERE gap_key=?', [GAP_KEY]);
  assertEqual(row.status, 'open');
  assertNotIncludes(row.title, '尚未归档', '原件已全部归档时标题不得再写「尚未归档」');
  assertIncludes(row.title, '已全部归档', '标题应写明原件已全部归档');
  assertIncludes(row.title, '正文', '标题应点明剩余问题是正文不可提取');
  assertIncludes(row.impact, '无法按正文/页码引用', '影响应限定在正文不可提取的条目');
  assertNotIncludes(row.impact, '人工');
  assertIncludes(row.auto_action, '自动核验受阻', '自动处理方式应如实说明自动核验受阻');
  assertIncludes(row.auto_action, '未核实', '受阻时正文状态应标注未核实，而不是人工待办');
  assertNotIncludes(row.auto_action, '人工');
  assertIncludes(row.description, '不声称已读原文', '描述不得声称已读原文');
});

test('B3 全部归档且正文可提取 → 结清，标题不再是「尚未归档」句式', () => {
  db.run("UPDATE policy_attachment SET parse_quality='good' WHERE id='PAT-GAP-A'");
  const out = archiveSvc.syncPolicyArchiveGap({ actor: 'test:gap' });
  assertEqual(out.closed, true, '全部归档且正文可提取时应结清缺口');
  const row = db.get('SELECT * FROM data_gap WHERE gap_key=?', [GAP_KEY]);
  assertEqual(row.status, 'closed');
  assertNotIncludes(row.title, '尚未');
  assertIncludes(row.title, '全部完成');
  assertEqual(row.impact.includes('无缺少正文'), true, '结清后说明应写明没有缺正文，不能把HTML证据一概声称为PDF归档');
});

test('B4 展示层按实时状态推导：台账标题即使过期，后台缺口视图也不显示与事实相反的结论', () => {
  // 制造「原件已全部归档、1 条正文不可提取」的实时状态，但把台账标题改回过期基线
  db.run("UPDATE policy_attachment SET parse_quality='partial' WHERE id='PAT-GAP-A'");
  db.run(
    `UPDATE data_gap SET title='部分政策原件（PDF）尚未归档与页码提取', status='open',
       impact='政策条款无法按页码引用；规则卡的 clause_ref 只能引用到文件与章节层级。',
       auto_action='随每日巡检自动抓取原件并计算哈希；未归档时条款只引用到文件与章节层级，不声称已读原文。'
     WHERE gap_key=?`,
    [GAP_KEY]
  );
  const region = dash.regionView(dash.parseFilters({}));
  const shown = (region.data_gaps || []).find((g) => g.gap_key === GAP_KEY);
  assert(shown, '动态缺口仍应能按实时状态推导');
  assertNotIncludes(shown.title, '尚未归档', '不得显示与实时归档状态相反的标题');
  assertIncludes(shown.title, '已全部归档', '标题应来自实时归档状态');
  assertIncludes(shown.auto_action, '自动核验受阻', '自动处理方式应为实时口径');
  assertEqual(shown.manual_path, null, '不得展示人工路径');
  assertEqual(shown.handling, '自动运行状态（无人工待办）');
  // docs/44 第 4 条：总览接口不再返回缺口细节（改由后台「运行与内容维护」提供）
  const ov = dash.overview({});
  assertEqual(ov.region?.data_gaps, undefined, '总览接口不得暴露缺口细节');
  assertEqual(ov.updates, undefined, '总览接口不得暴露运行提醒');
});

test('B5 动态缺口文案同步幂等（无变化时不写库、不产生新审计）', () => {
  archiveSvc.syncPolicyArchiveGap({ actor: 'test:gap-converge' }); // 先让台账与实时状态一致
  const before = db.get('SELECT * FROM data_gap WHERE gap_key=?', [GAP_KEY]);
  const auditsBefore = db.get("SELECT COUNT(*) c FROM audit_log WHERE action='data_gap.sync'").c;
  const out = archiveSvc.syncPolicyArchiveGap({ actor: 'test:gap-idempotent' });
  const after = db.get('SELECT * FROM data_gap WHERE gap_key=?', [GAP_KEY]);
  assertEqual(out.changed_fields.length, 0, '无变化时不应报告字段变更');
  assertEqual(after.updated_at, before.updated_at, '无变化时不得改写 updated_at');
  assertEqual(
    db.get("SELECT COUNT(*) c FROM audit_log WHERE action='data_gap.sync'").c,
    auditsBefore,
    '无变化时不得写审计'
  );
});

/* ==================================================================== */
/*  C. 自动核验受阻口径：不写成人工待办                                  */
/* ==================================================================== */

test('C1 目录缺口台账：无法机器读取官方目录时写明「自动核验受阻、未核实」', () => {
  const gap = DATA_GAPS.find((g) => g.gap_key === 'gap-catalog-8-pending');
  assert(gap, '应存在目录缺口条目');
  assertIncludes(gap.description, '自动核验受阻', '必须标明自动核验受阻');
  assertIncludes(gap.description, '未核实', '必须标明未核实');
  assertIncludes(gap.description, '无人工待办', '必须写明平台无人工待办');
  assertNotIncludes(gap.description, '仍需人工', '不得再写成人工按周期核对');
  assertNotIncludes(gap.auto_action, '人工');
});

test('C2 注册登记系统目录告警种子文案：自动核验受阻、未核实（非人工待办）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/services/seed.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("'structure_changed'"), src.indexOf("'structure_changed'") + 600);
  assertIncludes(block, '自动核验受阻', '告警文案必须写明自动核验受阻');
  assertIncludes(block, '未核实', '告警文案必须写明未核实');
  assertNotIncludes(block, '须由研究员', '不得再写「须由研究员」人工待办');
  assertNotIncludes(block, '人工核对', '不得再写人工核对');
});

test('C3 展示层净化不得把「无人工待办」改写成病句', async () => {
  const { sanitizeLegacyWording } = await import('../src/core/util.mjs');
  const out = sanitizeLegacyWording('该事项为自动运行状态（无人工待办），不设人工待办；历史文案「人工待办」应改为自动运行状态。');
  assertIncludes(out, '无人工待办', '「无人工待办」是现行口径，必须原样保留');
  assertNotIncludes(out, '无自动运行状态', '不得把否定式人工待办改写成病句');
  assertIncludes(out, '应改为自动运行状态', '真正的历史「人工待办」措辞仍应被净化');
});
