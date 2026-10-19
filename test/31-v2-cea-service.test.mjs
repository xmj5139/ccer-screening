/**
 * v2 测试 31：CEA 增量数据库、数据服务、情景与导出
 * ============================================================================
 * 覆盖规范用例：CEA-01（重复迁移不丢旧数据）、CEA-05（缺一侧为 null、不补 0）、
 * CEA-06（同 URL 同哈希幂等、修订留痕）、CEA-10（意向不计入成交）、
 * CEA-11（情景边界）、CEA-12（导出字段/单位与 CSV 公式注入）、CEA-08（配额与白名单）。
 *
 * 【数据来源说明】
 *   - 入库的行情数值全部取自 **官方真实日报**（单位：元、吨），来源见 `OFFICIAL_0730`；
 *     仅在**临时测试库**中写入，绝不写入任何正式/开发库。
 *   - 凡构造值（如用于触发修订的改动值）在注释中标明「构造」。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish, hasTable, hasColumn,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const { parseCeaDailyReport } = await import('../src/services/cea-parse.mjs');
const { toCsv } = await import('../src/services/export-svc.mjs');

console.log('\n[v2-31] CEA 增量数据库 / 服务 / 情景 / 导出');

const URL_0730 = 'https://overview.cneeex.com/c/2026-07-30/498086.shtml';
const OFFICIAL_0730 = `【CEA】全国碳市场每日综合价格行情及成交信息20260730-上海环境能源交易所
今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨，收盘价较前一日上涨1.00%。
今日挂牌协议交易成交量544,313吨，成交额52,585,579.00元；大宗协议交易成交量500,000吨，成交额47,575,000.00元；今日无单向竞价。
今日全国碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。
2026年1月1日至7月30日，全国碳市场碳排放配额成交量68,966,986吨，成交额5,499,968,391.61元。
截至2026年7月30日，全国碳市场碳排放配额累计成交量933,833,506吨，累计成交额63,162,586,623.18元。`;

const parsed0730 = parseCeaDailyReport(OFFICIAL_0730, { url: URL_0730 });

function insert0730(extra = {}) {
  return cea.upsertCeaTradeDaily({
    trade_date: parsed0730.trade_date,
    fields: parsed0730.fields,
    parse: parsed0730,
    meta: {
      sourceCode: 'cea_daily_sample_1',
      sourceUrl: URL_0730,
      snapshotId: 'SS-TEST-0730',
      contentHash: 'hash-0730-v1',
      fetchedAt: '2026-10-14T00:00:00.000Z',
      actor: 'test',
      ...extra,
    },
  });
}

/* ------------------------------------------------------------------ */
/* CEA-01 / 结构                                                       */
/* ------------------------------------------------------------------ */

test('CEA-01 增量迁移：CEA 独立表全部建立，CCER 表与账号数据保留', () => {
  for (const t of ['cea_source', 'cea_trade_daily', 'cea_trade_revision', 'cea_document',
    'cea_event', 'cea_entity', 'cea_entity_revision', 'cea_intention', 'cea_check']) {
    assert(hasTable(db.getDb(), t), `缺表：${t}`);
  }
  assert(hasColumn(db.getDb(), 'source_snapshot', 'cea_source_id'), 'source_snapshot 应补出 cea_source_id 列');
  // 旧 CCER 表仍在且有数据（seed 产生的 30 天日历等）
  for (const t of ['trade_daily', 'policy_document', 'public_project', 'app_user']) {
    assert(hasTable(db.getDb(), t), `旧表丢失：${t}`);
  }
  assert(db.get('SELECT COUNT(*) AS c FROM app_user').c > 0, '账号数据必须保留');
  assert(db.get('SELECT COUNT(*) AS c FROM trade_calendar').c > 0, 'CCER 交易日历必须保留');
});

test('CEA-01 重复迁移幂等：再次执行 migrate 不报错、不丢数据', () => {
  const before = {
    users: db.get('SELECT COUNT(*) AS c FROM app_user').c,
    calendar: db.get('SELECT COUNT(*) AS c FROM trade_calendar').c,
    cea_src: db.get('SELECT COUNT(*) AS c FROM cea_source').c,
  };
  db.migrate(db.getDb());
  db.migrate(db.getDb());
  assertEqual(db.get('SELECT COUNT(*) AS c FROM app_user').c, before.users, '账号不得变化');
  assertEqual(db.get('SELECT COUNT(*) AS c FROM trade_calendar').c, before.calendar, 'CCER 日历不得变化');
  assertEqual(db.get('SELECT COUNT(*) AS c FROM cea_source').c, before.cea_src, 'CEA 来源不得重复插入');
});

test('schema_cea_applied 元数据与版本号已写入', () => {
  assert(db.metaValue('schema_version_cea_applied', null), '应记录 CEA 迁移时间');
  // Accounting is a later additive migration; CEA requires at least v2.3, not a global downgrade.
  const [major,minor]=String(db.metaValue('schema_version',null)).split('.').map(Number);
  assert(major>2||(major===2&&minor>=3),'全局schema须包含CEA v2.3及以后增量');
});

/* ------------------------------------------------------------------ */
/* 来源与基础数据                                                      */
/* ------------------------------------------------------------------ */

test('基础数据：官方来源登记含真实地址，且不含任何行情数值', () => {
  const seeded = cea.seedCeaBaseData({ actor: 'test' });
  assert(seeded.sources.created + seeded.sources.updated >= 13, '应登记 13 个官方来源');
  const daily = cea.getCeaSourceByCode('cea_daily_sample_1');
  assertEqual(daily.url, URL_0730);
  assert(daily.allowed_domains.includes('overview.cneeex.com'), '应带域名白名单');
  assertEqual(db.get('SELECT COUNT(*) AS c FROM cea_trade_daily').c, 0, '基础数据不得写入任何行情行');
  const again = cea.seedCeaBaseData({ actor: 'test' });
  assertEqual(again.docs_created, 0, '重复 seed 不得重复插入政策');
  assertEqual(again.events_created, 0, '重复 seed 不得重复插入事件');
});

test('基础数据：政策与日历事件元数据带真实来源说明，未采集正文时保持 metadata_only', () => {
  const docs = cea.listCeaDocuments({ limit: 50 }).rows;
  assert(docs.length >= 6, '应有多条政策/技术/研报条目');
  const alloc = docs.find((d) => d.doc_number === '国环规气候〔2026〕1号');
  assert(alloc, '应登记最新正式分配方案');
  assertEqual(alloc.evidence_level, 'metadata_only', '未抓正文前不得声称已读原文');
  assertEqual(alloc.ai_status, 'unverified', '不得预先标记为已核验');
  assertIncludes(alloc.provenance_note, 'docs/31', '元数据来源必须可核对');
  const events = cea.listCeaEvents({}).rows;
  const surrender = events.find((e) => e.event_type === 'surrender_deadline');
  assertEqual(surrender.deadline, '2026-12-31');
  assertEqual(surrender.emission_year, 2025, '必须区分排放年度');
  assertEqual(surrender.date_verify_status, 'unverified', '未用原文核对前不得标 verified');
});

/* ------------------------------------------------------------------ */
/* CEA-06 幂等与修订留痕                                               */
/* ------------------------------------------------------------------ */

test('CEA-06 首次入库：官方数值与推导值分列写入，确定性核对落库', () => {
  const out = insert0730();
  assert(out.ok, JSON.stringify(out));
  assertEqual(out.created, true);
  assertEqual(out.check_status, 'pass');
  const row = cea.getCeaTradeDaily(out.id);
  assertEqual(row.close, 96.61, '官方综合收盘价');
  assertEqual(row.computed_avg_price, Math.round((100160579 / 1044313) * 1e6) / 1e6, '全方式计算均价');
  assertEqual(row.auction_volume, 0, '明确无竞价 → 0');
  assertEqual(row.revision, 1);
  assertEqual(row.verification_status, 'unverified', '未经模型核验前必须为 unverified');
  assertEqual(row.source_url, URL_0730);
  assertEqual(row.snapshot_id, 'SS-TEST-0730');
  assertEqual(row.content_hash, 'hash-0730-v1');
  const checks = cea.listCeaChecks({ object_type: 'cea_trade_daily', object_id: out.id });
  assert(checks.length >= 6, '确定性核对结果应落库');
  assert(checks.find((c) => c.check_key === 'close_vs_avg_price').ok, '口径差异不判冲突');
});

test('CEA-06 同 URL 同哈希重采幂等：数值不变、revision 不增、不产生修订记录', () => {
  const before = db.get('SELECT * FROM cea_trade_daily').rows?.[0] || db.get('SELECT id, revision FROM cea_trade_daily ORDER BY trade_date').rows;
  const rowBefore = db.get('SELECT id, revision FROM cea_trade_daily WHERE trade_date=?', ['2026-07-30']);
  const revBefore = db.get('SELECT COUNT(*) AS c FROM cea_trade_revision').c;
  const out = insert0730();
  assertEqual(out.unchanged, true, '应识别为幂等重采');
  assertEqual(out.deduped, true);
  const rowAfter = db.get('SELECT id, revision FROM cea_trade_daily WHERE trade_date=?', ['2026-07-30']);
  assertEqual(rowAfter.id, rowBefore.id, '不得新建行');
  assertEqual(rowAfter.revision, rowBefore.revision, 'revision 不得增加');
  assertEqual(db.get('SELECT COUNT(*) AS c FROM cea_trade_revision').c, revBefore, '不得产生修订记录');
  void before;
});

test('CEA-06 官方数值变化 → 旧值进修订表、revision+1，且不静默覆盖', () => {
  const revBefore = db.get('SELECT COUNT(*) AS c FROM cea_trade_revision').c;
  // 构造：把收盘价改为 96.99 模拟官方改数（仅用于验证修订留痕机制）
  const changed = { ...parsed0730, fields: { ...parsed0730.fields, close: 96.99 } };
  const out = cea.upsertCeaTradeDaily({
    trade_date: '2026-07-30', fields: changed.fields, parse: changed,
    meta: { sourceCode: 'cea_daily_sample_1', sourceUrl: URL_0730, snapshotId: 'SS-TEST-0730-B',
      contentHash: 'hash-0730-v2', fetchedAt: '2026-10-14T01:00:00.000Z', actor: 'test' },
  });
  assertEqual(out.revised, true);
  assertEqual(out.revision, 2);
  const revs = cea.listCeaTradeRevisions({ trade_daily_id: out.id });
  assertEqual(db.get('SELECT COUNT(*) AS c FROM cea_trade_revision').c, revBefore + 1);
  const closeRev = revs.find((r) => r.field === 'close');
  assert(closeRev, '应记录 close 的修订');
  assertEqual(closeRev.old_value, '96.61', '旧值必须保留');
  assertEqual(closeRev.new_value, '96.99');
  assertIncludes(closeRev.reason, '旧值保留可审计');
  // 恢复官方真值，避免影响后续用例
  const restore = cea.upsertCeaTradeDaily({
    trade_date: '2026-07-30', fields: parsed0730.fields, parse: parsed0730,
    meta: { sourceCode: 'cea_daily_sample_1', sourceUrl: URL_0730, snapshotId: 'SS-TEST-0730',
      contentHash: 'hash-0730-v1', fetchedAt: '2026-10-14T02:00:00.000Z', actor: 'test' },
  });
  assertEqual(cea.getCeaTradeDaily(restore.id).close, 96.61, '恢复官方原值');
});

test('CEA-06 入库必须可回溯来源：缺 source_url 直接拒绝', () => {
  const out = cea.upsertCeaTradeDaily({
    trade_date: '2026-07-31', fields: parsed0730.fields, parse: parsed0730, meta: {},
  });
  assert(out.error, '缺来源 URL 应被拒绝');
  assertIncludes(out.error, '来源 URL');
});

test('CEA-05 日期非法必须拒绝，不得用采集日兜底', () => {
  const out = cea.upsertCeaTradeDaily({
    trade_date: 'not-a-date', fields: parsed0730.fields, parse: parsed0730,
    meta: { sourceUrl: URL_0730 },
  });
  assert(out.error);
  assertIncludes(out.error, 'YYYY-MM-DD');
});

/* ------------------------------------------------------------------ */
/* 序列 / 汇总 / 对比                                                  */
/* ------------------------------------------------------------------ */

test('CEA-05 区间汇总只在真实交易日上计算，缺失日不补 0', () => {
  const s = cea.ceaSummary({ from: '2026-07-01', to: '2026-07-31' });
  assertEqual(s.trading_days, 1, '只统计真实采集到的 1 天');
  assertEqual(s.total_volume, 1044313);
  assertEqual(s.total_turnover, 100160579);
  assertEqual(s.vwap, Math.round((100160579 / 1044313) * 1e6) / 1e6);
  assertIncludes(s.caliber_note, '不补 0');
  const empty = cea.ceaSummary({ from: '2020-01-01', to: '2020-12-31' });
  assertEqual(empty.total_volume, null, '无数据区间必须为 null，不是 0');
  assertEqual(empty.vwap, null);
});

test('CEA-05 序列不含缺失日产生的 0 值点', () => {
  const day = cea.ceaSeries({ from: '2026-07-01', to: '2026-07-31', granularity: 'day' });
  assertEqual(day.points.length, 1, '只有 1 个真实交易日');
  assertEqual(day.points[0].trade_date, '2026-07-30');
  assert(day.points.every((p) => p.total_volume !== 0), '不得出现 0 值点');
  const month = cea.ceaSeries({ from: '2026-01-01', to: '2026-12-31', granularity: 'month' });
  assertEqual(month.points.length, 1, '没有数据的月份不生成点');
});

test('CEA-05 同日对比：CCER 缺数据时为 null，不沿用前值、不填 0', async () => {
  // 该交易日在 CCER trade_daily 中不存在 → 对比点两侧应保持 null
  const cmp = cea.ceaComparison({ from: '2026-07-01', to: '2026-07-31' });
  assertEqual(cmp.points.length, 1);
  const p = cmp.points[0];
  assertEqual(p.cea_composite_close, 96.61, 'CEA 侧有官方收盘价');
  assertEqual(p.ccer_computed_avg_price, null, 'CCER 侧缺数据必须为 null');
  assertEqual(p.spread_close_minus_ccer, null, '缺一侧时价差必须为 null');
  assertEqual(p.same_day_complete, false);
  assertIncludes(cmp.caliber_note, '不沿用前值');

  // 造一条同日 CCER 行情，验证三个价格字段分别保留
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO trade_daily (id,trade_date,trade_method,volume,turnover,avg_price,market,session_state,collected_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['TD-CEA-TEST', '2026-07-30', '挂牌协议', 1000, 95000, 95.0, 'CCER', 'traded', now, now, now]
  );
  const cmp2 = cea.ceaComparison({ from: '2026-07-01', to: '2026-07-31' });
  const p2 = cmp2.points[0];
  assertEqual(p2.ccer_computed_avg_price, 95.0);
  assertEqual(p2.cea_composite_close, 96.61);
  assertEqual(p2.cea_computed_avg_price, Math.round((100160579 / 1044313) * 1e6) / 1e6);
  assertEqual(p2.spread_close_minus_ccer, Math.round((96.61 - 95.0) * 1e6) / 1e6);
  assertEqual(p2.same_day_complete, true);
});

/* ------------------------------------------------------------------ */
/* CEA-10 意向与名录                                                   */
/* ------------------------------------------------------------------ */

test('CEA-10 交易意向不进入成交表、不计入成交统计', () => {
  const beforeVol = cea.ceaSummary({ from: '2026-07-30', to: '2026-07-30' }).total_volume;
  const out = cea.upsertCeaIntention({
    source_code: 'cea_intentions', published_date: '2026-10-01', direction: 'buy',
    volume: 200000, price: null, participant: null, instrument_label: 'CEA 2025年度配额',
    source_url: 'https://shyx.cneeex.com/', note: '测试：意向不等于成交',
  }, { actor: 'test' });
  assert(out.ok);
  const list = cea.listCeaIntentions({});
  assertEqual(list.total, 1);
  assertEqual(list.not_turnover, true);
  assertIncludes(list.note, '不计入成交量/成交额');
  assertEqual(list.rows[0].price, null, '未公开价格必须为 null，不得用 0');
  assertEqual(list.rows[0].participant, null, '未公开主体必须为 null');
  assertEqual(cea.ceaSummary({ from: '2026-07-30', to: '2026-07-30' }).total_volume, beforeVol, '意向不得改变成交量');
  assertEqual(db.get("SELECT COUNT(*) AS c FROM cea_trade_daily WHERE total_volume=?", [200000]).c, 0, '意向不得写入行情表');
});

test('CEA-10 名录：信用代码+年度为标识，名称变化留痕，不同法人不合并', () => {
  const a = cea.upsertCeaEntity({
    name: '华能福州电厂', credit_code: '91350100123456789X', province: '福建', list_year: 2026,
    source_code: 'cea_entity_fujian_2026', source_url: 'https://sthjt.fujian.gov.cn/x.pdf', data_as_of: '2026-10-14',
  }, { actor: 'test' });
  assert(a.created);
  // 同一主体更名 → 保留旧值
  const b = cea.upsertCeaEntity({
    name: '华能（福建）能源开发有限公司福州电厂', credit_code: '91350100123456789X', province: '福建', list_year: 2026,
  }, { actor: 'test' });
  assertEqual(b.updated, true);
  assert(b.revisions >= 1, '名称变化应留痕');
  const revs = db.all('SELECT * FROM cea_entity_revision WHERE entity_id=?', [a.id]);
  assertEqual(revs.length, 1);
  assertEqual(revs[0].old_value, '华能福州电厂');
  // 同集团不同法人（不同信用代码）必须是两行
  const c = cea.upsertCeaEntity({ name: '福建三钢闽光股份有限公司', credit_code: '91350400123456789Y', province: '福建', list_year: 2026 }, { actor: 'test' });
  assert(c.created);
  const listed = cea.listCeaEntities({ list_year: 2026 });
  assertEqual(listed.total, 2, '不同法人不得合并');
  assertEqual(listed.coverage.provinces, 1);
  assertIncludes(listed.note, '名录数量不等于买家数量');
  // 缺名录年度必须拒绝
  assert(cea.upsertCeaEntity({ name: '某公司' }, { actor: 'test' }).error);
});

/* ------------------------------------------------------------------ */
/* CEA-11 情景边界                                                     */
/* ------------------------------------------------------------------ */

test('CEA-11 情景：基本公式与额度耗尽', () => {
  const r = cea.runCeaScenario({ E: 1000, A: 400, C: 500, U: 0, r: 0.05, P1: 100, P2: 60, extra_cost: 0 });
  assert(r.ok && r.persisted === false, '情景不得持久化');
  assertEqual(r.result.gap_D, 600);
  assertEqual(r.result.offset_room, 50, 'E*r - U = 50');
  assertEqual(r.result.offset_used_Q, 50);
  assertEqual(r.result.remaining_offset_room, 0);
  assertEqual(r.result.cea_only_cost, 60000);
  assertEqual(r.result.combined_reference_cost, 550 * 100 + 50 * 60);
  assertEqual(r.result.difference, -2000);
});

test('CEA-11 情景：D=0（配额足够）时成本为 0，不产生抵销需求', () => {
  const r = cea.runCeaScenario({ E: 100, A: 500, C: 100, U: 0, r: 0.05, P1: 90, P2: 50 });
  assertEqual(r.result.gap_D, 0);
  assertEqual(r.result.offset_used_Q, 0);
  assertEqual(r.result.cea_only_cost, 0);
  assertEqual(r.result.combined_reference_cost, 0);
});

test('CEA-11 情景：U > E*r 时剩余抵销额度为 0（不产生负额度）', () => {
  const r = cea.runCeaScenario({ E: 1000, A: 0, C: 100, U: 80, r: 0.05, P1: 100, P2: 50 });
  assertEqual(r.result.offset_room, 0, 'E*r=50 < U=80 → 额度为 0');
  assertEqual(r.result.offset_used_Q, 0, '不得用超额抵销再抵扣');
});

test('CEA-11 情景：CCER 价格高于 CEA 时差额为正，但不自动建议购买', () => {
  const r = cea.runCeaScenario({ E: 100, A: 0, C: 100, U: 0, r: 0.1, P1: 90, P2: 120 });
  assert(r.result.difference > 0, 'CCER 更贵时组合成本更高');
  assertIncludes(r.disclaimer, '不自动建议购买');
  assertIncludes(r.disclaimer, '不等于真实成交价');
});

test('CEA-11 情景：负数 / NaN / Infinity / 过大数 / 比例越界一律拒绝', () => {
  const base = { E: 100, A: 0, C: 10, U: 0, r: 0.05, P1: 90, P2: 50 };
  for (const [patch, label] of [
    [{ E: -1 }, '负应清缴量'],
    [{ P1: Number.NaN }, 'NaN'],
    [{ P2: Number.POSITIVE_INFINITY }, 'Infinity'],
    [{ extra_cost: 1e13 }, '过大数'],
    [{ r: 1.5 }, '比例 >1'],
    [{ r: -0.1 }, '比例 <0'],
  ]) {
    const out = cea.runCeaScenario({ ...base, ...patch });
    assert(out.error, `${label} 应被拒绝`);
  }
  assert(cea.runCeaScenario({ ...base, E: undefined }).error, '缺 E 应被拒绝');
});

test('CEA-11 情景：不提供 r 时要求显式选择，不默认套用历史 5%', () => {
  const out = cea.runCeaScenario({ E: 100, A: 0, C: 10, U: 0, P1: 90, P2: 50 });
  assert(out.error, '缺 r 应被拒绝');
  assertIncludes(out.error, '必须显式选择抵销比例');
  assert(out.presets.some((p) => p.key === 'historical_5pct'), '预设中应包含历史 5% 并注明非现行承诺');
  assertIncludes(out.presets.find((p) => p.key === 'historical_5pct').note, '不得');
  assertIncludes(cea.CEA_SCENARIO_NOTE, '不能无条件当作所有年度的现行规则');
});

/* ------------------------------------------------------------------ */
/* CEA-12 导出                                                         */
/* ------------------------------------------------------------------ */

test('CEA-12 导出字段带单位与口径，且不泄露凭据字段', () => {
  const built = cea.ceaExportRows('trade', { from: '2026-07-01', to: '2026-07-31' });
  assertEqual(built.error, undefined);
  assertEqual(built.rows.length, 1);
  const closeCol = built.columns.find((c) => c.key === 'close');
  assertEqual(closeCol.unit, '元/吨');
  assertIncludes(closeCol.definition, '不是全方式量加权均价');
  assertEqual(built.rows[0].close, 96.61);
  assertEqual(built.rows[0].instrument, 'CEA');
  const keys = built.columns.map((c) => c.key);
  assert(!keys.some((k) => /key|secret|token|password/i.test(k)), '导出不得包含凭据类字段');
  assert(cea.ceaExportRows('nope').error, '未知数据集应被拒绝');
});

test('CEA-12 CSV：公式注入被转义，单位写入表头，元信息含口径', () => {
  const built = cea.ceaExportRows('intentions', {});
  const csv = toCsv(built.columns, built.rows, { meta: built.meta });
  assertIncludes(csv, '价格(元/吨)', '表头应带单位');
  assertIncludes(csv, '公开交易意向不等于成交', '元信息应声明口径');
  const evil = toCsv([{ key: 'name', label: '名称' }], [{ name: '=cmd|calc!A1' }, { name: '+1+1' }, { name: '@SUM(1)' }]);
  assertIncludes(evil, "'=cmd|calc!A1", '= 开头必须加前缀转义');
  assertIncludes(evil, "'+1+1");
  assertIncludes(evil, "'@SUM(1)");
});

test('CEA-12 JSON 导出内容与查询范围一致（同一筛选条件）', () => {
  const inRange = cea.ceaExportRows('trade', { from: '2026-07-01', to: '2026-07-31' });
  const outRange = cea.ceaExportRows('trade', { from: '2026-01-01', to: '2026-01-31' });
  assertEqual(inRange.rows.length, 1);
  assertEqual(outRange.rows.length, 0, '范围外不得出现数据');
});

/* ------------------------------------------------------------------ */
/* CEA-08 配额、白名单、重入                                           */
/* ------------------------------------------------------------------ */

test('CEA-08 采集配置服务端校验：每轮 ≤8、补证 ≤2 轮、超时与日限额有上下界', () => {
  const admin = { role: 'admin', name: 'test-admin' };
  assertEqual(collect.saveCeaCollectConfig({ role: 'viewer' }, {}).status, 403, '普通用户不得改配置');
  assert(collect.saveCeaCollectConfig(admin, { max_items_per_round: 99 }).error, '每轮超 8 应拒绝');
  assert(collect.saveCeaCollectConfig(admin, { max_evidence_rounds: 5 }).error, '补证超 2 轮应拒绝');
  assert(collect.saveCeaCollectConfig(admin, { batch_budget_ms: 999999999 }).error, '批次时长越界应拒绝');
  assert(collect.saveCeaCollectConfig(admin, { daily_fetch_limit: 0 }).error, '日限额 0 应拒绝');
  assert(collect.saveCeaCollectConfig(admin, { after_close_time: '25:99' }).error, '非法时刻应拒绝');
  const ok = collect.saveCeaCollectConfig(admin, { max_items_per_round: 4, batch_budget_ms: 60000, after_close_time: '16:30' });
  assert(ok.ok, JSON.stringify(ok));
  assertEqual(ok.config.max_items_per_round, 4);
  assertEqual(collect.ceaCollectConfig().after_close_time, '16:30');
});

test('CEA-08 出站白名单与 SSRF：私网与非法协议被拒绝', async () => {
  const { checkOutboundUrl } = await import('../src/services/collect-svc.mjs');
  assertEqual(checkOutboundUrl('http://127.0.0.1/x', ['127.0.0.1']).ok, false, '回环地址应被拒绝');
  assertEqual(checkOutboundUrl('http://10.0.0.5/x', ['10.0.0.5']).ok, false, '私网应被拒绝');
  assertEqual(checkOutboundUrl('file:///etc/passwd', ['localhost']).ok, false, '非 http(s) 应被拒绝');
  assertEqual(checkOutboundUrl('https://evil.example.com/x', ['overview.cneeex.com']).ok, false, '白名单外应被拒绝');
  assertEqual(checkOutboundUrl(URL_0730, ['overview.cneeex.com']).ok, true, '白名单内应放行');
});

await testAsync('CEA-08 任务重入：运行中的 CEA 任务被复用，不重复抓取', async () => {
  const job = collect.openCeaJob({ jobKey: 'cea_daily', title: '测试任务', trigger: 'test', actor: 'test' });
  assertEqual(job.reused, false);
  const again = collect.openCeaJob({ jobKey: 'cea_daily', title: '测试任务', trigger: 'test', actor: 'test' });
  assertEqual(again.reused, true, '第二次应复用运行中的任务');
  assertEqual(again.id, job.id);
  const reopened = await collect.collectCeaDaily({ actor: 'test', trigger: 'test' });
  assertEqual(reopened.reused, true, '采集入口应识别重入');
  // 收尾，避免影响后续
  collect.closeStaleCeaJobs({ actor: 'test', maxAgeMs: 0 });
  assertEqual(db.get("SELECT COUNT(*) AS c FROM ingestion_job WHERE job_key='cea_daily' AND status='running'").c, 0, '僵死任务应被收尾');
});

await testAsync('CEA-08 未配置模型时不伪造 verified（无 provider → unavailable）', async () => {
  const { verifyObject, verifyConfig } = await import('../src/services/verification-svc.mjs');
  const cfg = verifyConfig();
  // 临时停用全部模型，模拟「无凭据/无模型」环境
  const saved = db.metaValue('auto_verify_config_v1', null);
  db.setMeta(db.getDb(), 'auto_verify_config_v1', JSON.stringify({ ...cfg, provider_id: null }));
  db.run('UPDATE llm_provider SET enabled=0');
  db.run('UPDATE llm_provider SET use_content_verify=0');
  const row = db.get('SELECT id FROM cea_trade_daily LIMIT 1');
  const out = await verifyObject('cea_trade_daily', row.id, { actor: 'test', force: true });
  assertEqual(out.result, 'unavailable', '无模型时必须 unavailable，不得 verified');
  assertIncludes(out.capability_note, '模型');
  const after = db.get('SELECT verification_status, close FROM cea_trade_daily WHERE id=?', [row.id]);
  assertEqual(after.verification_status, 'unavailable');
  assertEqual(after.close, 96.61, 'AI 结论不得覆盖官方数值');
  // 还原
  db.run("UPDATE llm_provider SET enabled=1 WHERE id=(SELECT id FROM llm_provider LIMIT 1)");
  if (saved) db.setMeta(db.getDb(), 'auto_verify_config_v1', saved);
});

/* ------------------------------------------------------------------ */
/* 缺口台账                                                            */
/* ------------------------------------------------------------------ */

test('缺口：登记后可结清，记录保留不删除', () => {
  const g = cea.recordCeaGap({ dataset: 'cea_trade', title: '测试缺口', description: '用于验证结清', severity: 'warning' });
  assert(g.created);
  assertEqual(cea.listCeaGaps({ status: 'open' }).some((x) => x.id === g.id), true);
  const closed = cea.closeCeaGap(`cea:cea_trade:测试缺口`, { note: '测试结清' });
  assertEqual(closed.closed, true);
  assertEqual(cea.listCeaGaps({ status: 'open' }).some((x) => x.id === g.id), false);
  assert(db.get('SELECT COUNT(*) AS c FROM data_gap WHERE id=?', [g.id]).c === 1, '记录必须保留');
});

finish('31-v2-cea-service.test.mjs');
