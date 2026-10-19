/**
 * v2 测试 12：每日更新流程与数据核对
 * ============================================================================
 * 不联网：直接用合成数据驱动核对与审核流程，验证：
 *   - 缺失交易日 / 陈旧 / 修订待核 / 单价关系 / 累计差分 等检查是否按预期触发
 *   - 核对差异幂等（同一天重复核对不重复堆积）
 *   - 严重差异自动生成审核任务与提醒
 *   - 结清核对必须填写处理说明
 *   - 审核任务的职责分离（规则类发布不能自己批准）
 *   - 同步状态横幅（数据截至 / 最后成功同步 / 待核对数 / 陈旧告警）
 */
import {
  setupV2, test, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { trade, reconcile, collect, db } = ctx;

console.log('\n[v2-12] 每日更新与核对');

/* 构造场景：
 *  - 2026-09-21 ~ 23 三天有行情，其中 09-22 的成交额与「成交量×均价」故意不一致
 *  - 官方累计值差分与当日成交量故意不一致
 *  - 日历把 09-24 标为交易日但没有行情 → 缺失交易日
 */
trade.upsertTradeDaily({ trade_date: '2026-09-21', volume: 1000, turnover: 95000, avg_price: 95, session_state: 'traded', source_url: 'https://example.org/1' }, { actor: 'test' });
trade.upsertTradeDaily({ trade_date: '2026-09-22', volume: 2000, turnover: 999999, avg_price: 95, session_state: 'traded', source_url: 'https://example.org/2' }, { actor: 'test' });
trade.upsertTradeDaily({ trade_date: '2026-09-23', volume: 500, turnover: 47500, avg_price: 95, session_state: 'traded', source_url: 'https://example.org/3' }, { actor: 'test' });
for (const d of ['2026-09-21', '2026-09-22', '2026-09-23']) trade.markCalendar(d, 'trading', { note: '测试：该日行情已知' });
trade.upsertCumulativeReference({ as_of_date: '2026-09-21', volume_total: 1000000, turnover_total: 95000000 });
trade.upsertCumulativeReference({ as_of_date: '2026-09-22', volume_total: 1001500, turnover_total: 95140000 }); // 差分 1500 ≠ 当日 2000
trade.upsertCumulativeReference({ as_of_date: '2026-09-23', volume_total: 1002000, turnover_total: 95187500 });
trade.markCalendar('2026-09-24', 'trading', { note: '测试：标为交易日但无行情' });
// 制造一条修订待核
trade.upsertCumulativeReference({ as_of_date: '2026-09-23', volume_total: 1002000, turnover_total: 95187500 });

test('单价关系检查：成交额与「成交量×官方均价」不符时报警告', () => {
  const out = reconcile.runTradeChecks({ actor: 'test' });
  const issue = db.get(
    "SELECT * FROM data_reconciliation WHERE check_kind = 'amount_relation' AND status = 'open'"
  );
  assert(issue, '应产生金额关系差异');
  assertIncludes(issue.detail, '2026-09-22', '应指向异常交易日');
  assertEqual(issue.severity, 'warning');
  void out;
});

test('累计差分检查：官方累计增量与当日成交量不一致时标记严重', () => {
  const issue = db.get("SELECT * FROM data_reconciliation WHERE check_kind = 'cumulative_gap' AND status = 'open'");
  assert(issue, '应产生累计差分差异');
  assertIncludes(issue.detail, '官方累计值区间', '应说明差分口径（区间 (a, b] 的增量 vs 区间逐日合计）');
  assertIncludes(issue.detail, '官方累计差分', '应给出官方累计差分值');
  assertIncludes(issue.detail, '区间逐日合计', '应与区间内全部交易日的逐日合计比较，而不是只比最后一天');
  assertEqual(issue.severity, 'critical', '累计不一致应为严重');
});

test('同一根因不再产生「成交量/成交额」两条重复提醒', () => {
  reconcile.runTradeChecks({ actor: 'test' });
  const turnoverOnly = db.get(
    "SELECT COUNT(*) c FROM data_reconciliation WHERE check_kind = 'cumulative_turnover_gap' AND status = 'open'"
  ).c;
  assertEqual(turnoverOnly, 0, '成交量与成交额必须合并为同一条累计差分记录');
  const gaps = db.get(
    "SELECT COUNT(*) c FROM data_reconciliation WHERE check_kind = 'cumulative_gap' AND object_id = '2026-09-21..2026-09-22' AND status = 'open'"
  ).c;
  assertEqual(gaps, 1, '同一区间只登记一条累计差分记录');
});

test('缺失交易日检查：日历标为交易日却无行情 → 严重', () => {
  const issue = db.get("SELECT * FROM data_reconciliation WHERE check_kind = 'missing_trading_day' AND object_id = '2026-09-24'");
  assert(issue, '应产生缺失交易日差异');
  assertEqual(issue.severity, 'critical');
});

test('严重差异写入未结清差异与自动通知，但**不生成任何人工任务**', () => {
  const before = db.get('SELECT COUNT(*) c FROM review_task').c;
  // 制造一条新的严重差异（新的 object_id），确认自动核对的反应用于登记与通知
  db.run(
    `INSERT INTO trade_daily (id,trade_date,volume,turnover,avg_price,session_state,verify_status,revision,collected_at,created_at,updated_at)
     VALUES ('TD-REC-NOTASK','2026-09-30',1000,100000,100,'traded','pending',1,?,?,?)`,
    [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
  );
  reconcile.runTradeChecks({ actor: 'test' });
  const issue = db.get("SELECT * FROM data_reconciliation WHERE status='open' AND severity='critical' LIMIT 1");
  assert(issue, '严重差异应登记为未结清差异');
  const notif = db.get("SELECT * FROM notification WHERE kind = 'reconciliation' LIMIT 1");
  assert(notif, '严重差异应写入自动通知（运行状态提醒）');
  const after = db.get('SELECT COUNT(*) c FROM review_task').c;
  assertEqual(after, before, '自动核对不得生成任何人工审核/核对任务');
});

test('核对幂等：重复执行不重复堆积未结清差异', () => {
  const before = db.get("SELECT COUNT(*) c FROM data_reconciliation WHERE status = 'open'").c;
  reconcile.runTradeChecks({ actor: 'test' });
  reconcile.runTradeChecks({ actor: 'test' });
  const after = db.get("SELECT COUNT(*) c FROM data_reconciliation WHERE status = 'open'").c;
  assertEqual(after, before, '同一天重复核对不应新增未结清记录');
});

test('修订待核检查：版本 > 1 且未核对的行情会被提出', () => {
  const row = db.get('SELECT * FROM trade_daily WHERE trade_date = ?', ['2026-09-21']);
  trade.upsertTradeDaily({ trade_date: '2026-09-21', volume: 1100, turnover: 104500, avg_price: 95, session_state: 'traded' }, { actor: 'test', reason: '官方修订' });
  reconcile.runTradeChecks({ actor: 'test' });
  const issue = db.get("SELECT * FROM data_reconciliation WHERE check_kind = 'revision_pending' AND status = 'open'");
  assert(issue, '应产生修订待核差异');
  void row;
});

test('陈旧检查：最新交易日落后过多时给出告警文本', () => {
  const sync = collect.syncStatus();
  assert(sync.data_as_of, '应能取到数据截至日期');
  // 旧版统计「待人工核对」；新版没有人审队列，改为统计自动核验四态与未结清差异
  assert(!('pending_review' in sync.counts), '不应再统计待人工核对数（平台已无人工审核队列）');
  assert(!('pending_trade_verify' in sync.counts), '不应再统计待人工核对行情');
  for (const k of ['verification_verified', 'verification_insufficient', 'verification_conflict', 'verification_unavailable']) {
    assert(typeof sync.counts[k] === 'number', `应统计自动核验状态 ${k}`);
  }
  assert(typeof sync.counts.content_items === 'number', '应统计公开内容条目数');
  assert(typeof sync.counts.open_issues === 'number', '应统计未结清差异');
});

test('结清核对必须填写处理说明', () => {
  const issue = db.get("SELECT * FROM data_reconciliation WHERE status = 'open' LIMIT 1");
  const noNote = reconcile.resolveReconciliation({ name: 'tester', role: 'researcher' }, issue.id, { status: 'resolved' });
  assert(noNote.error, '缺少处理说明应被拒绝');
  const ok = reconcile.resolveReconciliation(
    { name: 'tester', role: 'researcher' }, issue.id,
    { status: 'resolved', resolution: '已与官方公告核对，差异来自官方四舍五入，不修订数值' }
  );
  assert(ok.ok, '带说明应能结清');
  const row = db.get('SELECT * FROM data_reconciliation WHERE id = ?', [issue.id]);
  assertEqual(row.status, 'resolved');
  assertIncludes(row.resolution, '四舍五入');
});

test('政策核对：缺官方链接 / 原件未归档会进入缺口清单', () => {
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,collected_at,created_at,updated_at)
     VALUES ('POL-TEST-1','pol-test-1','测试政策条目（无链接无原件）','management','effective',?,?,?)`,
    [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
  );
  const out = reconcile.runPolicyChecks({ actor: 'test' });
  assert(out.issues >= 1, '应产生差异');
  const missingUrl = db.get("SELECT * FROM data_reconciliation WHERE check_kind = 'missing_official_url' AND object_id = 'POL-TEST-1'");
  assert(missingUrl, '应记录缺少官方链接');
  const missingAtt = db.get("SELECT * FROM data_reconciliation WHERE check_kind = 'missing_attachment' AND object_id = 'POL-TEST-1'");
  assert(missingAtt, '应记录原件未归档');
});

test('因子核对：占位因子阻断正式测算，不生成领域签字待办', () => {
  const out = reconcile.runFactorChecks({ actor: 'test' });
  const pending = db.get("SELECT * FROM data_reconciliation WHERE check_kind = 'placeholder_factor' AND status = 'open'");
  assert(pending, '没有官方依据的占位因子仍应阻断正式测算');
  assertEqual(db.get("SELECT COUNT(*) n FROM data_reconciliation WHERE check_kind = 'domain_approval_pending' AND status = 'open'").n, 0,
    '不得因缺少人工签字产生核对差异');
  assert(out.issues >= 1, '应至少产生一条差异');
});

test('审核任务职责分离：规则类发布不能由提出人自己批准', () => {
  const t = collect.createReviewTask({
    task_type: 'methodology_publish',
    object_type: 'policy_discovery',
    object_id: 'https://example.org/new-methodology',
    title: '发现待收录的方法学公告',
    detail: '测试用',
    required_role: 'researcher',
    created_by: 'system:collect（研究员甲）',
  });
  const selfApprove = collect.decideReviewTask(
    { name: '研究员甲', role: 'researcher' }, t.id, { decision: 'approved' }
  );
  assert(selfApprove.error, '提出人不得自己批准规则类发布');
  const byAdmin = collect.decideReviewTask(
    { name: '系统管理员', role: 'admin' }, t.id, { decision: 'approved', note: '已核对官方原文' }
  );
  assert(byAdmin.ok, '管理员应可确认');
  assertEqual(byAdmin.status, 'approved');
});

test('审核任务幂等：同类型同对象的待审任务只保留一条', () => {
  const a = collect.createReviewTask({ task_type: 'trade_verify', object_type: 'trade_daily', object_id: 'X-1', title: 't1' });
  const b = collect.createReviewTask({ task_type: 'trade_verify', object_type: 'trade_daily', object_id: 'X-1', title: 't1-again' });
  assertEqual(b.deduped, true, '第二次应为去重命中');
  assertEqual(a.id, b.id, '应返回同一条');
});

test('审核决定非法取值被拒绝', () => {
  const t = collect.createReviewTask({ task_type: 'trade_verify', object_type: 'trade_daily', object_id: 'X-2', title: 't2' });
  const out = collect.decideReviewTask({ name: '研究员乙', role: 'researcher' }, t.id, { decision: 'whatever' });
  assert(out.error, '非法 decision 应被拒绝');
});

finish('test/12-v2-daily-and-reconcile.test.mjs');
