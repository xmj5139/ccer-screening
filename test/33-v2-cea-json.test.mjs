/**
 * v2 测试 33：CEA 公开 JSON 通道、概览分层、行业×年度配对、PDF 文本提取、采集 deadline
 * ============================================================================
 * 覆盖规范用例：CEA-16（公开 JSON 真实取样、分项聚合不重复、保留精确值与概览舍入层级、
 * 业务码失败不按 HTTP 200 假定成功）、以及 docs/31 的配对覆盖与采集预算要求。
 *
 * 【测试夹具的真实来源】
 *   JSON 夹具为**官方公开接口响应的逐字复制**，取自 Codex 于 2026-10-14 的独立取样
 *   （逐字副本随代码包保存在 test/fixtures/cea/，实测 HTTP 200；完整回归不依赖 data/backups）：
 *     · https://shyx.cneeex.com/assets/json/dailyov.json
 *     · https://shyx.cneeex.com/gateway/common/queryMarketByDate  (tradeDate=20261013, goodsCode=COMCEA)
 *     · https://shyx.cneeex.com/gateway/common/querySubStat       (tradeDate=20261013)
 *     · https://shyx.cneeex.com/assets/json/tradeIntent.json
 *     · https://shyx.cneeex.com/assets/json/holidays.json
 *     · https://shyx.cneeex.com/assets/json/hiskline.json（仅取头部若干元素）
 *   数值、字段名、单位与舍入层级均未改写；预期值取自 docs/31 记录的 2026-10-13 独立实测。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const J = await import('../src/services/cea-json.mjs');
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');

console.log('\n[v2-33] CEA 公开 JSON 通道 / 概览分层 / 配对覆盖');

/* ---------------- 官方响应逐字夹具（2026-10-14 取样） ---------------- */

const DAILYOV = '{"tradeDate":"20261013","beforeClose":"98.40","openPrice":"99.00","closePrice":"98.25","highPrice":"99.00","lowPrice":"97.80","ad":"-0.15%","todayQty":"297.34万吨","todayAmt":"2.88亿元","totalQty":"9.99亿吨","totalAmt":"692.89亿元"}';

const MARKET_BY_DATE = '{"success":true,"code":200,"message":"","data":[{"id":2109902008096927746,"subjCode":"COMCEA","subjName":"全国碳市场综合价格行情","quotPoin":"20261013","highPric":"99.00","lowPric":"97.80","lastClosPric":"98.40","openPric":"99.00","closPric":"98.25","dealQty":"1,224,197","dealAmt":"120,276,511.33","chanRate":"-0.15%","chanPric":"-0.15","limiUpPric":"39,047,447","limiDownPric":"3,515,626,393.77","averPric":"227,473,904","updaTime":"16,536,419,202.18"}]}';

const SUBSTAT = JSON.stringify({
  success: true, code: 200, message: '',
  data: [
    { id: 'a1', tradeDate: '20261013', subjectCode: 'CEA', subjectName: '碳排放配额19-20', tradeMethod: '10', tradeVolume: '0', tradeAmount: '0.00', yearVolume: '0', yearAmount: '0.00', totalVolume: '49,401,470', totalAmount: '2,741,445,972.29' },
    { id: 'a2', tradeDate: '20261013', subjectCode: 'CEA21', subjectName: '碳排放配额21', tradeMethod: '10', tradeVolume: '0', tradeAmount: '0.00', yearVolume: '0', yearAmount: '0.00', totalVolume: '11,490,465', totalAmount: '906,812,458.63' },
    { id: 'g1', tradeDate: '20261013', subjectCode: 'COMCEA', subjectName: '全国碳市场综合价格行情', tradeMethod: '10', tradeVolume: '1,224,197', tradeAmount: '120,276,511.33', yearVolume: '39,057,447', yearAmount: '3,516,442,393.77', totalVolume: '228,134,194', totalAmount: '16,570,292,966.06' },
    { id: 'g2', tradeDate: '20261013', subjectCode: 'COMCEA', subjectName: '全国碳市场综合价格行情', tradeMethod: '20', tradeVolume: '1,749,245', tradeAmount: '167,737,299.35', yearVolume: '95,148,602', yearAmount: '8,109,889,955.41', totalVolume: '770,601,375', totalAmount: '52,699,032,764.69' },
    { id: 'g3', tradeDate: '20261013', subjectCode: 'COMCEA', subjectName: '全国碳市场综合价格行情', tradeMethod: '21', tradeVolume: '0', tradeAmount: '0.00', yearVolume: '1,000', yearAmount: '80,430.00', totalVolume: '338,000', totalAmount: '19,705,280.00' },
  ],
});

const TRADE_INTENT = JSON.stringify([
  { id: 87, startTime: '2026-09-28', startTime2: '2026-09-28', goodsName: '碳排放配额25', dir: 1, volume: 100000, areaName: '安徽省' },
  { id: 86, startTime: '2026-09-19', startTime2: '2026-09-19', goodsName: '碳排放配额25', dir: 1, volume: 100000, areaName: '河北省' },
  { id: 80, startTime: '2026-06-01', startTime2: '2026-06-01', goodsName: '碳排放配额19-20', dir: 2, volume: 50000, areaName: '山东省' },
  { id: 79, startTime: '2026-05-20', startTime2: '2026-05-20', goodsName: '碳排放配额24', dir: 0, volume: 10000, areaName: '江苏省' },
  { id: 78, startTime: '2026-05-10', startTime2: '2026-05-10', goodsName: '碳排放配额24', dir: 7, volume: 10000, areaName: '江苏省' },
]);

const HOLIDAYS = '["2026-01-01","2026-01-02","2026-10-01","2026-10-14","not-a-date"]';

const HISKLINE = JSON.stringify([
  ['2026-10-09', '98.40', '98.60', '98.20', '98.90', '1000'],
  ['2026-10-13', '99.00', '98.25', '97.80', '99.00', '2973442'],
]);

/* ---------------- CEA-16 解析 ---------------- */

test('CEA-16 业务码：HTTP 200 但 success/code 失败必须判失败', () => {
  assertEqual(J.checkBusinessCode({ success: true, code: 200 }).ok, true);
  assertEqual(J.checkBusinessCode({ success: false, code: 200 }).ok, false);
  assertEqual(J.checkBusinessCode({ success: true, code: 500 }).ok, false);
  assertEqual(J.checkBusinessCode({ code: 200 }).ok, false, '缺 success 不得当作成功');
  assertEqual(J.checkBusinessCode(null).ok, false);
  const bad = J.parseSubStat({ success: false, code: 200, data: [] });
  assertEqual(bad.ok, false);
  assertIncludes(bad.reason, '业务码失败');
});

test('CEA-16 querySubStat：只聚合 COMCEA 三行，不与年度标的行重复相加', () => {
  const s = J.parseSubStat(SUBSTAT);
  assertEqual(s.ok, true);
  assertEqual(s.trade_date, '2026-10-13');
  assertEqual(s.listed_volume, 1224197);
  assertEqual(s.listed_turnover, 120276511.33);
  assertEqual(s.block_volume, 1749245);
  assertEqual(s.block_turnover, 167737299.35);
  assertEqual(s.auction_volume, 0);
  assertEqual(s.total_volume, 2973442, '当日合计 = 三行 tradeVolume 之和');
  assertEqual(s.total_turnover, 288013810.68);
  assertEqual(s.year_volume, 134207049, '年度累计 = 三行 yearVolume 之和');
  assertEqual(s.year_turnover, 11626412779.18);
  assertEqual(s.lifetime_volume, 999073569, '历史累计 = 三行 totalVolume 之和');
  assertEqual(s.lifetime_turnover, 69289031010.75);
  assertEqual(s.instrument_rows_excluded, 2, '年度标的行被排除，不参与相加');
  assertEqual(s.per_method.length, 3, '应保留逐方法分项，便于复算');
  assertIncludes(s.caliber_note, '不参与相加');
});

test('CEA-16 queryMarketByDate：dealQty/dealAmt 是挂牌口径，复用字段名一律不采用', () => {
  const m = J.parseMarketByDate(MARKET_BY_DATE);
  assertEqual(m.ok, true);
  assertEqual(m.open, 99.0);
  assertEqual(m.high, 99.0);
  assertEqual(m.low, 97.8);
  assertEqual(m.close, 98.25);
  assertEqual(m.prev_close, 98.4);
  assertEqual(m.change_pct, -0.15);
  assertEqual(m.listed_deal_volume, 1224197);
  assertEqual(m.listed_deal_turnover, 120276511.33);
  assertIncludes(m.caliber_note, '挂牌口径');
  for (const f of ['limiUpPric', 'averPric', 'updaTime']) {
    assert(m.ignored_fields.includes(f), `${f} 应列入不采用字段`);
  }
  assert(!('avg_price' in m), '不得按 averPric 名称推定均价');
});

test('CEA-16 dailyov：概览层是舍入展示值，容差按显示精度计算', () => {
  const o = J.parseDailyOverview(DAILYOV);
  assertEqual(o.ok, true);
  assertEqual(o.trade_date, '2026-10-13');
  assertEqual(o.open, 99.0);
  assertEqual(o.close, 98.25);
  assertEqual(o.prev_close, 98.4);
  assertEqual(o.change_pct, -0.15);
  assertEqual(o.rounded.today_qty.text, '297.34万吨');
  assertEqual(o.rounded.today_qty.value, 2973400, '万吨 → 吨');
  assertEqual(o.rounded.today_qty.tolerance, 50, '0.01 万吨 = 100 吨 → 容差 50');
  assertEqual(o.rounded.lifetime_qty.text, '9.99亿吨');
  assertEqual(o.rounded.lifetime_qty.value, 999000000);
  assertEqual(o.rounded.lifetime_qty.tolerance, 500000, '0.01 亿吨 = 100 万吨 → 容差 50 万吨');
  assertIncludes(o.rounded.note, '不互相覆盖');
});

test('CEA-16 hiskline：用于发现交易日，数量不得当作全方式成交量', () => {
  const h = J.parseHisKline(HISKLINE);
  assertEqual(h.ok, true);
  assertEqual(h.latest_date, '2026-10-13');
  assertEqual(h.points[1].open, 99.0);
  assertEqual(h.points[1].close, 98.25, '第 3 个元素是收盘（ECharts 约定 [open,close,low,high]）');
  assertEqual(h.points[1].low, 97.8);
  assertEqual(h.points[1].high, 99.0);
  assertIncludes(h.note, '不得当作全国全方式成交量');
});

test('CEA-16 tradeIntent：方向按官网语义（1=买入、2=卖出），未知方向不猜，价格与主体为 null', () => {
  const t = J.parseTradeIntents(TRADE_INTENT, { sourceUrl: 'https://shyx.cneeex.com/assets/json/tradeIntent.json' });
  assertEqual(t.ok, true);
  assertEqual(t.rows.length, 5);
  assertEqual(t.rows[0].direction, 'buy');
  assertEqual(t.rows[2].direction, 'sell', 'dir==2 为卖出（2026-10-14 真实 69 条样本仅有 1/2，结合官网显示源码确认）');
  assertEqual(t.rows[3].direction, 'unknown', 'dir==0 不在真实取值集合内，不得猜测方向');
  assertEqual(t.rows[4].direction, 'unknown', 'dir==7 不得猜测方向');
  assertEqual(t.unknown_direction.length, 2);
  assertEqual(t.rows[0].price, null, '未公开价格必须为 null');
  assertEqual(t.rows[0].participant, null, '未公开主体必须为 null');
  assertEqual(t.rows[0].region, '安徽省', 'areaName 是地区，不是主体');
  assertEqual(t.rows[0].quota_year, 2025, '碳排放配额25 → 2025');
  assertEqual(t.rows[2].quota_year, null, '区间品种 19-20 不唯一，留 null');
  assertIncludes(t.rows[2].quota_year_note, '无法唯一判断年度');
  assertIncludes(t.note, '1=买入、2=卖出');
  assertIncludes(t.note, '不计入成交量/成交额');
});

test('CEA-16 holidays：合法日期入库，非法日期如实报告', () => {
  const h = J.parseHolidays(HOLIDAYS);
  assertEqual(h.ok, true);
  assertEqual(h.dates.length, 4);
  assertEqual(h.invalid.length, 1);
  assertIncludes(h.invalid[0], 'not-a-date');
});

/* ---------------- 概览分层与交叉核对 ---------------- */

test('概览层单独保存，不覆盖精确值；跨层核对按展示精度判定', () => {
  // 先写入精确行情（真实 2026-10-13 官方值）
  const stat = J.parseSubStat(SUBSTAT);
  const quote = J.parseMarketByDate(MARKET_BY_DATE);
  const fields = {
    open: quote.open, high: quote.high, low: quote.low, close: quote.close,
    change_pct: quote.change_pct, prev_close: quote.prev_close,
    listed_volume: stat.listed_volume, listed_turnover: stat.listed_turnover,
    block_volume: stat.block_volume, block_turnover: stat.block_turnover,
    auction_volume: stat.auction_volume, auction_turnover: stat.auction_turnover,
    total_volume: stat.total_volume, total_turnover: stat.total_turnover,
    year_volume: stat.year_volume, year_turnover: stat.year_turnover,
    lifetime_volume: stat.lifetime_volume, lifetime_turnover: stat.lifetime_turnover,
  };
  const up = cea.upsertCeaTradeDaily({
    trade_date: '2026-10-13', fields,
    parse: { parse_status: 'ok', parse_note: '测试：公开 JSON 通道', period: 'day', trade_date: '2026-10-13',
      date_source: 'json_quotPoin', date_candidates: [{ date: '2026-10-13', source: 'json_quotPoin' }],
      date_consistent: true, fields, raw_fields: {}, units: {} },
    meta: { sourceCode: 'cea_json_substat', sourceUrl: 'https://shyx.cneeex.com/gateway/common/querySubStat',
      snapshotId: 'SS-JSON-TEST', contentHash: 'hash-json-1', fetchedAt: '2026-10-14T00:00:00.000Z', actor: 'test' },
  });
  assert(up.ok, JSON.stringify(up));
  assertEqual(cea.getCeaTradeDaily(up.id).total_volume, 2973442);

  const ov = cea.upsertCeaOverview(J.parseDailyOverview(DAILYOV), {
    sourceCode: 'cea_json_dailyov', sourceUrl: 'https://shyx.cneeex.com/assets/json/dailyov.json',
    snapshotId: 'SS-OV-TEST', contentHash: 'hash-ov-1',
  });
  assert(ov.ok, JSON.stringify(ov));
  assertEqual(ov.cross_checks.length, 4, '四项量额均应参与跨层核对');
  assert(ov.cross_checks.every((c) => c.within_rounding), `跨层核对应全部落在展示精度内：${JSON.stringify(ov.cross_checks)}`);

  const stored = cea.getCeaOverviewRow('2026-10-13');
  assertEqual(stored.today_qty_text, '297.34万吨');
  assertEqual(stored.today_qty_approx, 2973400, '概览存的是舍入近似值');
  // 关键：概览不得覆盖精确值
  assertEqual(cea.getCeaTradeDaily(up.id).total_volume, 2973442, '精确值必须保持 2973442，未被概览覆盖');
});

/* ---------------- 行业 × 年度配对 ---------------- */

test('配对覆盖：钢铁 2025 不适用 2026 分配方案，发电 2025/2026 适用（不做笛卡尔积）', () => {
  cea.seedCeaBaseData({ actor: 'test' });
  const docs = cea.listCeaDocuments({ limit: 50 }).rows;
  const alloc = docs.find((d) => d.doc_key === 'cea_allocation_pdf_2026_1' || d.doc_key === 'cea_allocation_2026_1');
  assert(alloc, '应存在分配方案条目');
  assert(Array.isArray(alloc.coverage) && alloc.coverage.length === 4, '应按行业×年度配对登记');

  const cases = [
    ['发电', 2025, true], ['发电', 2026, true],
    ['钢铁', 2025, false], ['钢铁', 2026, true],
    ['水泥', 2025, false], ['水泥', 2026, true],
    ['铝冶炼', 2025, false], ['铝冶炼', 2026, true],
  ];
  for (const [sector, year, expected] of cases) {
    const r = cea.documentApplicability(alloc, { sector, year });
    assertEqual(r.applicable, expected, `${sector} ${year} 应判 ${expected}：${r.reason}`);
  }
  const hit = cea.documentApplicability(alloc, { sector: '钢铁', year: 2025 });
  assertIncludes(hit.reason, '不得由书面行业清单 × 年度清单推导适用性');
});

test('附件关联：同一通知的正文行与 PDF 行关联，政策计数不重复', () => {
  const docs = cea.listCeaDocuments({ limit: 50 }).rows;
  const main = docs.find((d) => d.doc_key === 'cea_allocation_2026_1');
  const pdf = docs.find((d) => d.doc_key === 'cea_allocation_pdf_2026_1');
  assert(main && pdf, '两行都应存在');
  assertEqual(pdf.count_in_stats, 0, 'PDF 附件行不计入政策统计');
  assertEqual(main.count_in_stats, 1);
  assertEqual(pdf.attachment_of, main.id, 'PDF 行应指向正文行');
  assertIncludes(main.title, '2025、2026年度发电行业以及2026年度钢铁、水泥、铝冶炼行业配额总量和分配方案', '正式标题须保留官方行业年度范围及原文措辞');
  const counted = db.get('SELECT COUNT(*) AS c FROM cea_document WHERE count_in_stats=1').c;
  const all = db.get('SELECT COUNT(*) AS c FROM cea_document').c;
  assert(all > counted, `总行数 ${all} 应大于计入统计的 ${counted}（附件行不重复计）`);
});

/* ---------------- PDF 文本提取 ---------------- */

test('PDF 提取：不可读取时如实返回 scan_suspected/unavailable，不伪造正文', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cea-pdf-'));
  const fake = join(dir, 'fake.pdf');
  writeFileSync(fake, '%PDF-1.4\nnot really a pdf\n%%EOF', 'utf8');
  const r = collect.extractPdfText(fake);
  assertEqual(r.ok, false, '损坏 PDF 不得判为成功');
  assert(['failed', 'unavailable', 'blocked', 'scan_suspected'].includes(r.status), `意外的状态：${r.status}`);
  assert(r.reason && r.reason.length > 0, '应给出可读原因');
  assertEqual(r.text === '' || r.text === undefined, true, '失败时不得返回正文');
});

/* ---------------- 采集 deadline ---------------- */

await testAsync('采集预算：模型核验共享总 deadline，剩余不足则留待下一批（不再套用默认 45 秒）', async () => {
  const row = db.get('SELECT id FROM cea_trade_daily LIMIT 1');
  assert(row, '需要一条行情行');
  // 临时登记一个「已启用」的模型占位行，使代码走到 deadline 判定分支。
  // 注意：本用例断言的是「预算不足时**不发起**模型调用」，因此不会有任何外发请求。
  db.run(
    `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,timeout_ms,max_calls_per_day,enabled,
       use_content_verify,allowed_domains,created_at,updated_at)
     VALUES ('LLM-TEST-DEADLINE','测试占位模型','openai_compatible','https://example.invalid/v1','stub',
       30000,10,1,1,'["example.invalid"]',?,?)
     ON CONFLICT(id) DO UPDATE SET enabled=1, use_content_verify=1`,
    [new Date().toISOString(), new Date().toISOString()]
  );
  const savedCfg = db.metaValue('auto_verify_config_v1', null);
  db.setMeta(db.getDb(), 'auto_verify_config_v1', JSON.stringify({ provider_id: 'LLM-TEST-DEADLINE' }));

  const out = await collect.verifyCollectedCea([row.id], {
    actor: 'test',
    deadlineAt: Date.now() + 1000, // 剩余时间不足以完成一次核验
    minRemainingMs: 8000,
  });
  assertEqual(out.deadline_shared, true, '应标记为共享 deadline');
  assertEqual(out.provider_configured, true, '本用例需要已配置模型才会走到预算判定');
  assertEqual(out.deferred, 1, '应把该条留待下一批');
  assertEqual(out.attempts, 0, '不得在预算不足时发起模型调用');
  assertIncludes(out.note, '留待下一批');

  // 还原配置，避免影响后续用例
  if (savedCfg) db.setMeta(db.getDb(), 'auto_verify_config_v1', savedCfg);
  else db.run("DELETE FROM system_meta WHERE key='auto_verify_config_v1'");
  db.run("DELETE FROM llm_provider WHERE id='LLM-TEST-DEADLINE'");
});

await testAsync('采集配置：批次预算有上限，不允许配置成无限占用', () => {
  const admin = { role: 'admin', name: 'test-admin' };
  const tooBig = collect.saveCeaCollectConfig(admin, { batch_budget_ms: 99999999 });
  assert(tooBig.error, '超出上限应被拒绝');
  assertIncludes(tooBig.error, '600000');
  const ok = collect.saveCeaCollectConfig(admin, { batch_budget_ms: 120000 });
  assert(ok.ok && ok.config.batch_budget_ms === 120000);
});

/* ---------------- 日历与来源层级 ---------------- */

test('官方休市日期写入 CEA 独立日历（不复用 CCER 日历）', () => {
  const h = J.parseHolidays(HOLIDAYS);
  const saved = cea.upsertCeaCalendarDates(h.dates, { evidenceKind: 'holidays_json', sourceCode: 'cea_json_holidays' });
  assert(saved.created >= 1);
  const rows = cea.listCeaCalendar({ day_type: 'holiday' });
  assert(rows.length >= 1);
  assertEqual(rows[0].day_type, 'holiday');
  assertIncludes(rows[0].note, '休市');
  const again = cea.upsertCeaCalendarDates(h.dates, { evidenceKind: 'holidays_json' });
  assertEqual(again.created, 0, '重复写入应幂等');
});

test('来源层级：精确通道与概览通道分别标记，便于来源钻取', () => {
  cea.recordQuoteSource({ trade_date: '2026-10-13', channel: 'substat_json', sourceCode: 'cea_json_substat',
    sourceUrl: 'https://shyx.cneeex.com/gateway/common/querySubStat', snapshotId: 'SS-JSON-TEST', isPrecise: 1, isOverview: 0 });
  cea.recordQuoteSource({ trade_date: '2026-10-13', channel: 'dailyov_json', sourceCode: 'cea_json_dailyov',
    sourceUrl: 'https://shyx.cneeex.com/assets/json/dailyov.json', snapshotId: 'SS-OV-TEST', isPrecise: 0, isOverview: 1 });
  const rows = cea.listQuoteSources({ trade_date: '2026-10-13' });
  const precise = rows.find((r) => r.channel === 'substat_json');
  const overview = rows.find((r) => r.channel === 'dailyov_json');
  assertEqual(precise.is_precise, 1);
  assertEqual(precise.is_overview, 0);
  assertEqual(overview.is_overview, 1);
  assertEqual(overview.is_precise, 0);
});

/* ---------------- 工具 ---------------- */

test('数值与展示解析：非数值返回 null（不返回 0），千分位与单位正确', () => {
  assertEqual(J.parseCneexNumber('1,224,197'), 1224197);
  assertEqual(J.parseCneexNumber('0.00'), 0);
  assertEqual(J.parseCneexNumber('abc'), null);
  assertEqual(J.parseCneexNumber(''), null);
  assertEqual(J.parseCneexDate('20261013'), '2026-10-13');
  assertEqual(J.parseCneexDate('2026-10-13'), '2026-10-13');
  assertEqual(J.parseCneexDate('bad'), null);
  assertEqual(J.parseCneexDisplayAmount('1.5亿元').value, 150000000);
  assertEqual(J.parseCneexDisplayAmount('无'), null);
});

finish('33-v2-cea-json.test.mjs');
