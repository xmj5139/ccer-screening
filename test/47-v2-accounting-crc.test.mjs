/**
 * 47-v2-accounting-crc.test.mjs —— 中碳登清结算日报：入库、修订、与 CEA 同日对照
 * ============================================================================
 * 使用的都是**真实公开夹具**：
 *   · test/fixtures/accounting/chinacrc-daily-20261014.html  中碳登 2026-10-14 日报
 *   · test/fixtures/cea/queryMarketByDate-20261014.json      CEA 官方公共接口同日响应
 *   · test/fixtures/cea/querySubStat-20261014.json           CEA 官方公共接口同日分方式精确量额
 *
 * 断言重点（docs/39 第 63、99 条）：
 *   CRC 日期与量额/均价分层/不重复加总；与 CEA 同日量额**分列两方原值、差异保留**；
 *   修订不覆盖原值；累计口径不得写成 CCER 累计；自愿注销公示不计入成交。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
console.log('\n[v2-47] 中碳登清结算日报：入库 / 修订 / 与 CEA 同日对照');

const FIX = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const parse = await import('../src/services/accounting-parse.mjs');
const acc = await import('../src/services/accounting-svc.mjs');
const ceaJson = await import('../src/services/cea-json.mjs');
const ceaSvc = await import('../src/services/cea-svc.mjs');
const { fetchStatus } = await import('../src/services/web-fetch-svc.mjs');

acc.seedAccountingBase();

const parsed = parse.parseCrcDailyDetail(readFileSync(FIX('accounting/chinacrc-daily-20261014.html'), 'utf8'), {
  url: 'https://www.chinacrc.net.cn/view/8753.html',
});
assert(parsed.ok, `日报解析必须成功：${parsed.reason}`);

function rowFrom(d, over = {}) {
  return {
    source_code: 'chinacrc_daily_detail',
    detail_url: 'https://www.chinacrc.net.cn/view/8753.html',
    title: d.title,
    trade_date: d.trade_date,
    published_at: d.published_at,
    daily_volume_t: d.daily_volume_t,
    daily_amount_yuan: d.daily_amount_yuan,
    daily_avg_price_published: d.daily_avg_price_published,
    cumulative_volume_t: d.cumulative_volume_t,
    cumulative_amount_yuan: d.cumulative_amount_yuan,
    caliber: d.caliber,
    scope: d.scope,
    content_hash: '539139c45e440e7137b3c0353dc705cd11ddbcb858e554383d8f3dfbc3044be5',
    components: d.components,
    ...over,
  };
}

/* ==================================================================== */
/*  一、落库与分层                                                       */
/* ==================================================================== */

let saved = null;

test('真实日报已随代码核实并 seed 入库：本日/累计量额、公布均价与复算均价分列保存', () => {
  const seededRow = acc.getCrcDaily('2026-10-14');
  assert(seededRow, 'seed 应已写入 2026-10-14 的真实日报（随代码核实的静态数据）');
  saved = { id: seededRow.id };
  assertEqual(seededRow.trade_date, '2026-10-14');
  assertEqual(seededRow.published_at, '2026-10-14');
  assertEqual(seededRow.daily_volume_t, 2861440);
  assertEqual(seededRow.daily_amount_yuan, 258301176.6);
  assertEqual(seededRow.daily_avg_price_published, 90.27);
  assertEqual(seededRow.daily_avg_price_derived, 258301176.6 / 2861440);
  assertEqual(seededRow.avg_price_origin, 'published');
  assertEqual(seededRow.cumulative_volume_t, 1001935009);
  assertEqual(seededRow.cumulative_amount_yuan, 69547332187.35);
  assertEqual(seededRow.revision_no, 1);
  assertEqual(seededRow.is_current, true);
  assertEqual(seededRow.content_hash.length, 64);
  assertEqual(seededRow.content_hash, parsed.data ? '539139c45e440e7137b3c0353dc705cd11ddbcb858e554383d8f3dfbc3044be5' : null);
  assertIncludes(seededRow.caliber, '中碳登清结算信息日报口径');
  assertEqual(seededRow.components.length, 24);
});

test('用真实夹具重新解析并写回：逐字段一致 → unchanged（来源未变命中缓存）', () => {
  const again = acc.upsertCrcDaily(rowFrom(parsed.data), { actor: 'test:47' });
  assertEqual(again.action, 'unchanged', '与已核实值逐字段一致：不新增行、不改写原值');
  assertEqual(again.id, saved.id);
  const n = ctx.db.get('SELECT COUNT(*) AS c FROM crc_clearing_daily WHERE trade_date=?', ['2026-10-14']).c;
  assertEqual(n, 1, '同源同日同口径只应有一行 current');
});

test('分层明细只把小计计入合计：入库后的加总核对必须通过', () => {
  const r = acc.getCrcDaily(saved.id);
  assertEqual(r.subtotal_check.agree, true);
  assertEqual(r.subtotal_check.mismatches.length, 0);
  assertEqual(r.subtotal_check.sum_of_subtotals.daily_volume_t, r.daily_volume_t);
  assertEqual(r.subtotal_check.sum_of_subtotals.cumulative_amount_yuan, r.cumulative_amount_yuan);
  assertIncludes(r.subtotal_check.note, '不得与合计再相加');
  // 只统计 counts_to_total=1 的行
  assertEqual(r.components.filter((c) => c.counts_to_total).length, 6);
  assertEqual(r.components.filter((c) => c.counts_to_total && c.trade_method !== '小计').length, 0);
});

test('官方修订：旧行保留为历史（is_current=0），新修订行关联 revision_of 且原值不被覆盖', () => {
  const revised = acc.upsertCrcDaily(rowFrom(parsed.data, {
    daily_avg_price_published: 90.28, // 模拟官方修订后的公布均价
    content_hash: 'f'.repeat(64),
  }), { actor: 'test:47' });
  assertEqual(revised.action, 'revision');
  assert(revised.id !== saved.id);
  const old = ctx.db.get('SELECT * FROM crc_clearing_daily WHERE id=?', [saved.id]);
  assertEqual(old.is_current, 0, '旧修订必须保留为历史');
  assertEqual(old.daily_avg_price_published, 90.27, '旧行的原值不得被改写');
  const cur = acc.getCrcDaily('2026-10-14');
  assertEqual(cur.revision_no, 2);
  assertEqual(cur.revision_of, saved.id);
  assertEqual(cur.daily_avg_price_published, 90.28);
  assertEqual(cur.revisions.length, 2, '修订历史两条都在');
  assertEqual(cur.revisions[0].revision_no, 2);
});

test('修订历史可导出，且导出包含修订号与原件哈希（不隐藏旧值）', () => {
  const rows = acc.crcExportRows({});
  assertEqual(rows.length, 2);
  const nos = rows.map((r) => r.revision_no).sort();
  assertEqual(nos.join(','), '1,2');
  assert(rows.every((r) => r.content_hash && r.content_hash.length === 64));
  assert(rows.some((r) => r.avg_price_published === 90.27), '旧修订的公布均价仍在导出里');
});

test('列表默认只返回当前修订，历史需显式 include_history', () => {
  const cur = acc.listCrcDaily({});
  assertEqual(cur.rows.length, 1);
  assertEqual(cur.rows[0].revision_no, 2);
  const all = acc.listCrcDaily({ include_history: true });
  assertEqual(all.rows.length, 2);
});

/* ==================================================================== */
/*  二、与 CEA 同日量额交叉核对（两个官方来源互为独立证据）              */
/* ==================================================================== */

testAsync('把 CEA 官方同日夹具按真实解析链路入库（querySubStat 精确量额）', async () => {  ceaSvc.seedCeaBaseData();
  const mb = ceaJson.parseMarketByDate(readFileSync(FIX('cea/queryMarketByDate-20261014.json'), 'utf8'));
  const ss = ceaJson.parseSubStat(readFileSync(FIX('cea/querySubStat-20261014.json'), 'utf8'));
  assertEqual(mb.ok, true, `queryMarketByDate 应解析成功：${mb.reason || ''}`);
  assertEqual(ss.ok, true, `querySubStat 应解析成功：${ss.reason || ''}`);
  assertEqual(mb.trade_date, '2026-10-14');
  assertEqual(ss.trade_date, '2026-10-14');
  assertEqual(ss.complete, true, '分方式应完整（挂牌/大宗/单向竞价齐全）');
  const r = ceaSvc.upsertCeaTradeDaily({
    trade_date: '2026-10-14',
    fields: {
      open: mb.open, high: mb.high, low: mb.low, close: mb.close,
      prev_close: mb.prev_close, change_pct: mb.change_pct,
      listed_volume: ss.listed_volume, listed_turnover: ss.listed_turnover,
      block_volume: ss.block_volume, block_turnover: ss.block_turnover,
      auction_volume: ss.auction_volume, auction_turnover: ss.auction_turnover,
      total_volume: ss.total_volume, total_turnover: ss.total_turnover,
      year_volume: ss.year_volume, year_turnover: ss.year_turnover,
      lifetime_volume: ss.lifetime_volume, lifetime_turnover: ss.lifetime_turnover,
    },
    parse: { parse_status: 'ok', raw_fields: { listed: ss.per_method } },
    meta: {
      sourceUrl: 'https://shyx.cneeex.com/gateway/common/querySubStat',
      sourceCode: 'cea_json_substat',
      contentHash: 'e'.repeat(64),
      dataAsOf: '2026-10-14',
    },
  });
  assert(r.ok, `CEA 入库应成功：${JSON.stringify(r)}`);
  assert(r.created || r.revision, '应写入一行真实 CEA 行情');
});

test('中碳登与 CEA 同日量额交叉核对：两方原值都保留，且本样本逐项一致', () => {
  const out = acc.crcDailyWithCeaCompare({ limit: 10 });
  assertEqual(out.rows.length, 1);
  const row = out.rows[0];
  assertEqual(row.cea_available, true, '同日应存在 CEA 行情');
  const cmp = row.cea_compare;
  assertEqual(cmp.crc.daily_volume_t, 2861440);
  assertEqual(cmp.cea.total_volume, 2861440, 'CEA 精确分方式合计与本日成交量一致（两个独立官方来源）');
  assertEqual(cmp.crc.daily_amount_yuan, 258301176.6);
  assertEqual(cmp.cea.total_turnover, 258301176.6);
  assertEqual(cmp.crc.cumulative_volume_t, 1001935009);
  assertEqual(cmp.cea.lifetime_volume, 1001935009);
  assertEqual(cmp.crc.cumulative_amount_yuan, 69547332187.35);
  assertEqual(cmp.cea.lifetime_turnover, 69547332187.35);
  assertEqual(cmp.differences.length, 0, `两方应逐项一致：${JSON.stringify(cmp.differences)}`);
  assertEqual(cmp.match, true);
  assertIncludes(cmp.note, '差异保留两方原值');
  assertIncludes(cmp.note, '不做平均');
  assertIncludes(cmp.note, '不做相加');
  assertEqual(out.note.includes('两列不做加总'), true);
});

test('绝不提供"合并总量"字段：combined_total 恒为 null', () => {
  const out = acc.crcDailyWithCeaCompare({ limit: 10 });
  assertEqual(out.rows[0].cea_compare.combined_total, null, '两份来源的同日成交量不得相加成一个字段');
});

test('CEA 行情缺失时如实标注：match=null（缺失既不算一致也不算差异），不回落不推算', () => {
  const cmp = acc.compareCrcWithCea({ trade_date: '2026-09-01', daily_volume_t: 1, daily_amount_yuan: 2, source_code: 'chinacrc_daily_detail' }, null);
  assertEqual(cmp.cea, null);
  assertEqual(cmp.combined_total, null);
  assertEqual(cmp.match, null, '只有一侧数据时不得判"一致"');
  assertEqual(cmp.differences.length, 0, '缺一侧时不产生"差异"记录，只标注缺失');
  const out = acc.crcDailyWithCeaCompare({ from: '2026-09-01', to: '2026-09-30' });
  assertEqual(out.rows.length, 0, '没有该区间的日报就是不返回行，而不是补 0');
});

test('对照函数是纯函数：对手工构造的另一侧输入也能正确报告差异（构造样本，仅测对照逻辑）', () => {
  const cmp = acc.compareCrcWithCea(
    { trade_date: '2026-10-14', daily_volume_t: 100, daily_amount_yuan: 1000, source_code: 'x', caliber: 'c', detail_url: 'u' },
    { total_volume: 90, total_turnover: 900, source_url: 'v', instrument: 'CEA' }
  );
  assertEqual(cmp.match, false);
  assertEqual(cmp.differences.length, 2);
  assertEqual(cmp.differences[0].crc, 100);
  assertEqual(cmp.differences[0].cea, 90);
  assertEqual(cmp.differences[0].diff, 10);
  assertEqual(cmp.combined_total, null);
});

/* ==================================================================== */
/*  三、口径纪律：不与 CCER/公示混用                                     */
/* ==================================================================== */

test('累计量额口径写明是"中碳登日报公布口径"，不写成 CCER 累计成交量', () => {
  const r = acc.getCrcDaily('2026-10-14');
  assertIncludes(r.caliber, '全国碳排放权交易市场');
  assertNotIncludes(r.caliber, 'CCER');
  const sources = acc.listSources({ category: 'crc' });
  const cancel = sources.find((s) => s.code === 'chinacrc_cancel_disclosure');
  assert(cancel, '自愿注销公示来源必须单独登记');
  assertIncludes(cancel.status_note, '不计入成交量');
});

test('中碳登数据独立存放：不写入 CCER trade_daily，也不改 CEA 官方值', () => {
  const tradeDaily = ctx.db.get("SELECT COUNT(*) AS c FROM trade_daily").c;
  assertEqual(tradeDaily, 0, '本测试不应向 CCER 行情表写入任何行（中碳登数据只进 crc_clearing_daily）');
  const cea = ctx.db.get("SELECT * FROM cea_trade_daily WHERE trade_date='2026-10-14'");
  assert(cea, '同日 CEA 行情应已入库');
  assertEqual(cea.total_volume, 2861440);
  assertEqual(cea.close, 98.14, 'CEA 官方收盘价不得被中碳登均价覆盖');
  assert(Math.abs(cea.computed_avg_price - 258301176.6 / 2861440) < 1e-5, 'CEA 的复算均价是它自己的字段（CEA 侧按 6 位小数取整）');
  // 中碳登的公布均价 90.27 与 CEA 综合收盘价 98.14 是两个不同东西
  const crc = acc.getCrcDaily('2026-10-14');
  assert(crc.daily_avg_price_published !== cea.close, '成交均价 ≠ 收盘价，必须分列');
});

/* ==================================================================== */
/*  四、来源状态与缺口                                                   */
/* ==================================================================== */

test('来源状态：未抓取的来源保持 registered，不预填成功状态', () => {
  const s = acc.listSources({}).find((x) => x.code === 'cets_portal');
  assertEqual(s.status, 'registered');
  assertEqual(s.last_success_at, null, '没有真实抓取就不能有成功时间');
  assertEqual(s.last_http_status, null);
  assertEqual(s.collected_count, 0);
});

test('accountingStatus 把 412 缺口与"公告 576 个因子"缺口如实列出', () => {
  const st = acc.accountingStatus();
  assertEqual(st.seeded, true);
  assertEqual(st.counts.factors, 40);
  assertEqual(st.counts.standards, 12);
  assertEqual(st.counts.crc_daily, 2, '两条修订都在（1 历史 + 1 当前）');
  const kinds = st.gaps.map((g) => g.kind);
  assert(kinds.includes('http_412_challenge'), '必须登记 412 缺口');
  assert(kinds.includes('count_not_imported'), '必须登记"公告总数不是已导入数"缺口');
  assert(kinds.includes('standard_body_missing'), '规范缺正文必须列为缺口而不是假装已取得');
  const n576 = st.gaps.find((g) => g.kind === 'count_not_imported');
  assertIncludes(n576.note, '不是本应用已导入条数');
  assertEqual(st.counts.standards_with_body, 0, '本轮没有任何规范正文，统计必须为 0');
});

test('来源登记不返回任何凭据类字段', () => {
  const s = acc.listSources({})[0];
  const keys = Object.keys(s).join(',');
  for (const bad of ['credential', 'api_key', 'secret', 'token', 'password']) {
    assertNotIncludes(keys, bad);
  }
  assertEqual(JSON.stringify(acc.accountingStatus()).includes('secret'), false);
});

test('web_fetch 状态接口可用（采集通道存在且可读，不做真实外部调用）', () => {
  const st = fetchStatus();
  assert(st && typeof st === 'object');
});

finish('47-v2-accounting-crc.test.mjs');
