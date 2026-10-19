/**
 * 37-v2-cea-calendar-revision.test.mjs —— CEA 日历来源修订回归（docs/35 17:00 追加第 2 项）
 * ============================================================================
 * 真实来源修订：官方查询页使用的机器辅助列表
 *   · 旧 holidays.json     —— 101 项，含 2026-10-14（而当日官方行情显示有成交）
 *   · 最新 holidays-current.json —— 100 项，已删除 2026-10-14
 * 两份夹具都是官方公开响应的逐字副本（test/fixtures/cea/，无凭据）。
 *
 * 纪律（本文件逐条验证）：
 *   1. 成功且完整的来源快照 → 同步「当前有效集合」：来源已删除的日期标为过期（superseded），
 *      旧行、原 note 与快照 id 一律保留可追溯；
 *   2. 旧证据不再作为当前事实 / 告警依据：list / 分层 / 核对 / 统计只看 current，
 *      只由旧机器列表产生的永久告警自动结清；
 *   3. 失败 / 不完整结果**不得清空**当前集合，也不得改写或复活已过期证据；
 *   4. 采集链路（本机桩）真实走到上述行为，而不是只有单元函数正确。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const jsonSvc = await import('../src/services/cea-json.mjs');

const ROOT = process.cwd();
const FIX = join(ROOT, 'test', 'fixtures', 'cea');
const H101 = JSON.parse(readFileSync(join(FIX, 'holidays.json'), 'utf8'));
const H100 = JSON.parse(readFileSync(join(FIX, 'holidays-current.json'), 'utf8'));
const REVISED_DAY = '2026-10-14';
const ACTOR = 'test';

process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

console.log('\n[v2-37] CEA 日历来源修订：101→100 项，当前有效集合同步 / 旧证据保留 / 失败不清空');

cea.seedCeaBaseData({ actor: ACTOR });

/* ==================================================================== */
/*  夹具自身：101 与 100 的差别只有 2026-10-14                           */
/* ==================================================================== */

test('夹具核对：holidays.json 101 项含 10-14；holidays-current.json 100 项已删除该日', () => {
  assertEqual(H101.length, 101);
  assertEqual(H100.length, 100);
  assert(H101.includes(REVISED_DAY), '旧快照必须含 2026-10-14（这才构成可复现的来源修订）');
  assert(!H100.includes(REVISED_DAY), '新快照必须已删除 2026-10-14');
  assertEqual(H101.filter((d) => !H100.includes(d)).join(','), REVISED_DAY, '两份夹具的差异应只有该日');
  const parsed = jsonSvc.parseHolidays(H100);
  assertEqual(parsed.ok, true);
  assertEqual(parsed.invalid.length, 0);
  assertEqual(parsed.dates.length, 100);
});

/* ==================================================================== */
/*  1) 基线：旧 101 项 + 当日真实成交 → 机器列表异常                     */
/* ==================================================================== */

test('基线：写入旧 101 项并同步当前集合，10-14 被标休市且产生机器列表异常', () => {
  const parsed = jsonSvc.parseHolidays(H101);
  const saved = cea.upsertCeaCalendarDates(parsed.dates, {
    evidenceKind: 'holidays_json', sourceCode: 'cea_json_holidays',
    evidenceUrl: 'https://shyx.cneeex.com/assets/json/holidays.json',
    snapshotId: 'SS-HOL-101', note: '机器辅助列表原文（101 项）', complete: true,
  });
  assertEqual(saved.current_total, 101, '完整快照应同步出 101 条当前有效日期');
  assertEqual(saved.superseded, 0);

  // 当日官方行情显示有成交（真实样本：10-14 有成交，而旧机器列表把它标成休市）
  const now = new Date().toISOString();
  db.run('DELETE FROM cea_trade_daily WHERE trade_date=?', [REVISED_DAY]);
  db.run(
    `INSERT INTO cea_trade_daily (id,trade_date,instrument,market_scope,price_regime,close,total_volume,total_turnover,
       source_url,parse_status,check_status,verification_status,session_state,revision,created_at,updated_at)
     VALUES (?,?, 'CEA','national','CEA_COMPOSITE_2026',98.14,2861440,258301176.6,
       'https://shyx.cneeex.com/gateway/common/querySubStat','ok','pass','unverified','traded',1,?,?)`,
    [`CEATD-REV-${REVISED_DAY}`, REVISED_DAY, now, now]
  );

  const recon = cea.reconcileCeaCalendar({ actor: ACTOR });
  assert(recon.anomalies >= 1, '机器列表把有成交的交易日标成休市 → 必须独立告警');
  const check = db.get("SELECT * FROM cea_calendar_check WHERE trade_date=? AND check_key='machine_list_vs_actual'", [REVISED_DAY]);
  assert(check, '应有 10-14 的机器列表异常记录');
  assertEqual(check.severity, 'warn');
  assertEqual(check.manual_review, 0, '不得生成人工复核任务');
});

/* ==================================================================== */
/*  2) 完整快照修订：同步当前有效集合                                   */
/* ==================================================================== */

test('完整快照修订：10-14 标为过期（保留原 note/快照），当前集合 100 项', () => {
  const before = db.get("SELECT * FROM cea_calendar WHERE trade_date=? AND evidence_kind='holidays_json'", [REVISED_DAY]);
  assertEqual(before.source_state, 'current');
  assertEqual(before.note, '机器辅助列表原文（101 项）');

  const parsed = jsonSvc.parseHolidays(H100);
  const saved = cea.upsertCeaCalendarDates(parsed.dates, {
    evidenceKind: 'holidays_json', sourceCode: 'cea_json_holidays',
    evidenceUrl: 'https://shyx.cneeex.com/assets/json/holidays.json',
    snapshotId: 'SS-HOL-100', note: '机器辅助列表原文（100 项，来源修订）', complete: true,
  });
  assertEqual(saved.superseded, 1, '来源已删除的旧日期应恰好标为 1 条过期');
  assertEqual(saved.current_total, 100, '当前有效集合应同步为 100 项');

  const after = db.get("SELECT * FROM cea_calendar WHERE trade_date=? AND evidence_kind='holidays_json'", [REVISED_DAY]);
  assert(after, '旧证据行必须保留，不得删除');
  assertEqual(after.source_state, 'superseded');
  assertEqual(after.day_type, 'holiday', '原始 day_type 不改写，历史证据原样可追溯');
  assertEqual(after.note, '机器辅助列表原文（101 项）', '过期证据的原始 note 不得被新快照覆盖');
  assertEqual(after.snapshot_id, 'SS-HOL-101', '过期证据保留其原始快照 id');
  assert(after.superseded_at, '过期时间必须落库');
  assertEqual(after.superseded_by_snapshot, 'SS-HOL-100');
  assertIncludes(after.superseded_reason, '来源完整快照');
});

test('当前事实只看 current：list / 分层 / 统计不含 10-14，过期证据可显式追溯', () => {
  const rows = cea.listCeaCalendar({ day_type: 'holiday' });
  assertEqual(rows.length, 100, '当前有效集合应为 100 项');
  assert(!rows.some((r) => r.trade_date === REVISED_DAY), '当前列表不得再含来源已删除的 10-14');

  const withHistory = cea.listCeaCalendar({ day_type: 'holiday', include_superseded: true });
  assertEqual(withHistory.length, 101, '显式追溯时应能同时看到 101 条（含 1 条过期证据）');
  const old = withHistory.find((r) => r.trade_date === REVISED_DAY);
  assertEqual(old.source_state, 'superseded');

  const layered = cea.ceaCalendarLayered({ limit: 400 });
  assert(!layered.rows.some((r) => r.trade_date === REVISED_DAY), '分层视图不把过期证据当当前事实');
  assertEqual(layered.superseded_evidence.total, 1, '过期证据单独计数，保留可追溯');
  assertEqual(layered.superseded_evidence.by_kind[0].evidence_kind, 'holidays_json');
  assertIncludes(layered.layers_note, '过期证据');

  const counts = cea.ceaOverview().counts;
  assertEqual(counts.calendar_holidays, 100, '统计只计当前有效集合');
  assertEqual(counts.calendar_superseded, 1);
});

test('旧告警自动结清：来源修订后只由旧机器列表产生的异常不再残留', () => {
  // ① 10-14 仍有真实成交证据：核对时按「实际成交 > 机器辅助列表」处理，旧机器列表告警被删除
  cea.reconcileCeaCalendar({ actor: ACTOR });
  const check = db.get("SELECT * FROM cea_calendar_check WHERE trade_date=? AND check_key='machine_list_vs_actual'", [REVISED_DAY]);
  assert(!check, '来源已删除 10-14 后，该日的机器列表异常必须自动结清（不再作为当前告警）');
  assertEqual(cea.listCeaCalendarChecks({ severity: 'warn' }).rows.length, 0, '不应残留 warn 级告警');

  // ② 只剩过期证据、连成交证据也没有的日期：旧的遗留核对行也必须被清理，不得永久残留
  const now = new Date().toISOString();
  db.run('DELETE FROM cea_trade_daily WHERE trade_date=?', [REVISED_DAY]);
  db.run(
    `INSERT INTO cea_calendar_check (trade_date,check_key,severity,effective_state,detail,evidence_json,resolved_by,manual_review,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,0,?,?)
     ON CONFLICT(trade_date,check_key) DO UPDATE SET severity=excluded.severity, updated_at=excluded.updated_at`,
    [REVISED_DAY, 'machine_list_vs_actual', 'warn', 'unknown', '历史遗留（来源修订前产生）', '{}', 'none', now, now]
  );
  const recon = cea.reconcileCeaCalendar({ actor: ACTOR });
  assertEqual(recon.stale_checks_closed, 1, '只由过期证据产生的旧告警应由过期清理删除');
  const gone = db.get("SELECT * FROM cea_calendar_check WHERE trade_date=? AND check_key='machine_list_vs_actual'", [REVISED_DAY]);
  assert(!gone, '过期告警不得永久残留');
});

/* ==================================================================== */
/*  3) 失败 / 不完整结果不得清空当前集合                                 */
/* ==================================================================== */

test('失败/不完整结果不得清空：空数组与含非法日期的结果都只做增量、不改状态', () => {
  const empty = cea.upsertCeaCalendarDates([], {
    evidenceKind: 'holidays_json', sourceCode: 'cea_json_holidays', snapshotId: 'SS-EMPTY', complete: false,
  });
  assertEqual(empty.current_total, 100, '失败/空结果绝不能清空当前集合');
  assertEqual(empty.superseded, 0);

  const partial = cea.upsertCeaCalendarDates([REVISED_DAY, '不是日期', '2026-13-01'], {
    evidenceKind: 'holidays_json', sourceCode: 'cea_json_holidays', snapshotId: 'SS-PARTIAL', complete: false,
  });
  assertEqual(partial.total, 1, '只有可解析的真实日期参与');
  const row = db.get("SELECT * FROM cea_calendar WHERE trade_date=? AND evidence_kind='holidays_json'", [REVISED_DAY]);
  assertEqual(row.source_state, 'superseded', '不完整结果不得复活已过期证据');
  assertEqual(row.note, '机器辅助列表原文（101 项）', '不完整结果也不得改写过期证据的原文留痕');
  assertEqual(cea.listCeaCalendar({ day_type: 'holiday' }).length, 100, '当前集合保持不变');
});

/* ==================================================================== */
/*  4) 采集链路：完整 / 失败两条路径分别走到位                           */
/* ==================================================================== */

const calls = [];
const routes = new Map();
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const path = String(req.url || '').split('?')[0];
    calls.push(path);
    const r = routes.get(path) || { status: 404, body: { error: 'no route' } };
    const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    res.writeHead(r.status || 200, { 'content-type': r.contentType || 'application/json' });
    res.end(payload);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

function pointCeaSource(code, path, { method = 'GET' } = {}) {
  db.run('UPDATE cea_source SET url=?, allowed_domains=?, method=? WHERE code=?', [
    `${STUB}${path}`, JSON.stringify(['127.0.0.1']), method, code,
  ]);
}
function resetRateLimit() { db.run("DELETE FROM system_meta WHERE key='collect_last_request_at_ms'"); }
/** 其余 JSON 通道全部失败：本文件只验证日历通道的来源修订行为 */
function failOtherChannels() {
  for (const [code, path] of [
    ['cea_json_market_by_date', '/rev/market'], ['cea_json_substat', '/rev/substat'],
    ['cea_json_hiskline', '/rev/hiskline'], ['cea_json_dailyov', '/rev/dailyov'],
  ]) {
    routes.set(path, { status: 500, body: { error: 'stub down' } });
    pointCeaSource(code, path, { method: 'POST' });
  }
}

await testAsync('采集链路：成功且完整的 100 项快照 → 同步当前集合、自动结清旧告警', async () => {
  failOtherChannels();
  routes.set('/rev/holidays-ok', { status: 200, body: H100 });
  pointCeaSource('cea_json_holidays', '/rev/holidays-ok');
  resetRateLimit();

  const cfg = { ...collect.ceaCollectConfig(), auto_verify: false, request_timeout_ms: 4000, batch_budget_ms: 30000, daily_fetch_limit: 60 };
  const out = await collect.collectCeaJsonDaily({ actor: ACTOR, trigger: 'manual', dates: ['2026-10-13'], cfg });

  assert(out.calendar && out.calendar.ok, '日历通道应成功');
  assertEqual(out.calendar.snapshot_complete, true, '成功且完整的快照应标记 snapshot_complete');
  assertEqual(out.calendar.superseded, 0, '10-14 此前已过期，本次不重复计数');
  assertEqual(out.calendar.current_total, 100, '当前有效集合保持 100 项');
  assertIncludes(out.calendar.complete_note, '同步当前有效集合');
  assert(calls.includes('/rev/holidays-ok'), '必须真实请求该来源（非桩内造假）');

  const d14 = db.get("SELECT source_state, note, snapshot_id FROM cea_calendar WHERE trade_date=? AND evidence_kind='holidays_json'", [REVISED_DAY]);
  assertEqual(d14.source_state, 'superseded', '当前集合仍不含来源已删除的 10-14');
});

await testAsync('采集链路：来源修订把日期改回来 → 恢复为当前有效（可逆，不丢证据）', async () => {
  routes.set('/rev/holidays-back', { status: 200, body: H101 });
  pointCeaSource('cea_json_holidays', '/rev/holidays-back');
  resetRateLimit();
  const cfg = { ...collect.ceaCollectConfig(), auto_verify: false, request_timeout_ms: 4000, batch_budget_ms: 30000, daily_fetch_limit: 60 };
  const out = await collect.collectCeaJsonDaily({ actor: ACTOR, trigger: 'manual', dates: ['2026-10-13'], cfg });
  assertEqual(out.calendar.restored, 1, '来源把该日改回时应恢复为 current');
  assertEqual(out.calendar.current_total, 101);
  const d14 = db.get("SELECT source_state, superseded_at FROM cea_calendar WHERE trade_date=? AND evidence_kind='holidays_json'", [REVISED_DAY]);
  assertEqual(d14.source_state, 'current');
  assertEqual(d14.superseded_at, null, '恢复后不得残留过期标记');
});

await testAsync('采集链路：来源失败 → 不清空当前集合，登记缺口而不是把日历清空', async () => {
  routes.set('/rev/holidays-down', { status: 500, body: { error: 'upstream down' } });
  pointCeaSource('cea_json_holidays', '/rev/holidays-down');
  resetRateLimit();
  const before = cea.listCeaCalendar({ day_type: 'holiday' }).length;
  const cfg = { ...collect.ceaCollectConfig(), auto_verify: false, request_timeout_ms: 4000, batch_budget_ms: 30000, daily_fetch_limit: 60 };
  const out = await collect.collectCeaJsonDaily({ actor: ACTOR, trigger: 'manual', dates: ['2026-10-13'], cfg });
  assert(!out.calendar || out.calendar.ok !== true, '失败时不得报告日历成功');
  assert(out.failed.some((f) => f.channel === 'holidays'), '失败必须如实登记');
  assertEqual(cea.listCeaCalendar({ day_type: 'holiday' }).length, before, '失败结果绝不能清空原当前集合');
  const gap = db.get("SELECT gap_key,status FROM data_gap WHERE gap_key='cea:json:holidays'");
  assert(gap && gap.status === 'open', '失败应留下可追溯缺口');
});

await testAsync('采集链路：响应成功但内容不完整（含非法日期）→ 只增量补充，不同步当前集合', async () => {
  routes.set('/rev/holidays-partial', { status: 200, body: [...H100, 'not-a-date'] });
  pointCeaSource('cea_json_holidays', '/rev/holidays-partial');
  resetRateLimit();
  const before = cea.listCeaCalendar({ day_type: 'holiday' }).length;
  const cfg = { ...collect.ceaCollectConfig(), auto_verify: false, request_timeout_ms: 4000, batch_budget_ms: 30000, daily_fetch_limit: 60 };
  const out = await collect.collectCeaJsonDaily({ actor: ACTOR, trigger: 'manual', dates: ['2026-10-13'], cfg });
  assertEqual(out.calendar.snapshot_complete, false, '含非法日期即不算完整快照');
  assertIncludes(out.calendar.complete_note, '不清空原当前集合');
  assertEqual(cea.listCeaCalendar({ day_type: 'holiday' }).length, before, '不完整结果不得改动当前集合');
});

/* ==================================================================== */

await new Promise((r) => stub.close(r));
finish('37-v2-cea-calendar-revision.test.mjs');
