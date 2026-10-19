/**
 * v2 测试 11：交易行情（解析 / 写入 / 修订 / 统计 / 导入 / 导出 / 日历）
 * ============================================================================
 * 全部使用**离线夹具**（取自官方公告的真实文本格式），不依赖网络；
 * 另有一组可选联网用例（--net），用于核对官方数据源仍然可用。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish, netAllowed,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { trade, db, templates, exportSvc } = ctx;

console.log('\n[v2-11] 交易行情模块');

/* 官方公告正文的两种真实格式（去掉 HTML 标签后的文本） */
const BULLETIN_NEW = `
2026年9月23日全国温室气体自愿减排交易市场交易行情-全国温室气体自愿减排交易系统 当前位置： 首页 > 每日行情
2026年9月23日全国温室气体自愿减排交易市场交易行情 来源：本平台 时间：2026-09-23 16:43:34
2026年9月23日，核证自愿减排量成交量122吨，成交额10,497.10元，成交均价86.04元/吨。
截至 2026 年 9 月 23 日，全国温室气体自愿减排交易市场累计成交量 23,292,747 吨，累计成交额 1,884,199,847.62 元。`;

const BULLETIN_OLD = `
2024年1月22日全国温室气体自愿减排交易市场交易行情 来源：本平台 时间：2024-01-22 18:00:17
2024年1月22日，全国温室气体自愿减排交易市场总成交量375,315 吨，总成交额23,835,280.00 元。`;

const FIRST_JSON = JSON.stringify([
  { business_amount: '122', business_ave_price: '86.04', business_price: '10497.10', business_date: '20260923', profession_name: '能源产业(可再生/不可再生资源)' },
  { business_amount: '-', business_ave_price: '-', business_price: '-', business_date: '20260923', profession_name: '林业和其他碳汇类型' },
  { business_amount: '122', business_ave_price: '-', business_price: '10497.10', business_date: '20260923', profession_name: '小计' },
]);

const LIST_JSON = JSON.stringify({
  total: 2,
  rows: [
    { title: '2026年9月23日全国温室气体自愿减排交易市场交易行情', url: '2502lshq/20260923/153004998.shtml', publishedTime: '2026-09-23 16:43:34' },
    { title: '2024年1月22日全国温室气体自愿减排交易市场交易行情', url: '2502lshq/20250306/112020984.shtml', publishedTime: '2024-01-22 18:00:17' },
  ],
});

test('解析官方公告（新格式）：成交量/成交额/官方均价/累计值', () => {
  const p = trade.parseTradeBulletin(BULLETIN_NEW, { url: 'https://www.ccer.com.cn/x.shtml', fallback_date: '2026-09-23' });
  assertEqual(p.trade_date, '2026-09-23', '交易日应取自正文日期');
  assertEqual(p.volume, 122, '成交量');
  assertEqual(p.turnover, 10497.1, '成交额');
  assertEqual(p.avg_price, 86.04, '官方披露均价');
  assertEqual(p.session_state, 'traded', '状态');
  assertEqual(p.published_at, '2026-09-23 16:43:34', '发布时间');
  assertEqual(p.cumulative.volume_total, 23292747, '累计成交量');
  assertEqual(p.cumulative.turnover_total, 1884199847.62, '累计成交额');
  assertEqual(p.cumulative.as_of_date, '2026-09-23', '累计截至日');
});

test('解析官方公告（2024 旧格式）：均价与累计留空，不自行补值', () => {
  const p = trade.parseTradeBulletin(BULLETIN_OLD, { url: 'https://www.ccer.com.cn/y.shtml' });
  assertEqual(p.volume, 375315, '成交量');
  assertEqual(p.turnover, 23835280, '成交额');
  assertEqual(p.avg_price, null, '旧格式未披露均价 → 必须为空');
  assertEqual(p.cumulative, null, '旧格式无累计值 → 必须为空');
  assert(p.warnings.some((w) => w.includes('未披露成交均价')), '应给出缺口提示');
});

test('解析分行业行情：识别小计与各行业，去除小计行', () => {
  const d = trade.parseTradeFirstJson(FIRST_JSON);
  assertEqual(d.trade_date, '2026-09-23', '日期');
  assertEqual(d.rows.length, 2, '应有两行行业数据（不含小计）');
  assertEqual(d.subtotal.volume, 122, '小计成交量');
  assertEqual(d.rows[0].dimension_value, '能源产业(可再生/不可再生资源)');
  assertEqual(d.rows[1].volume, null, '“-”应解析为空值而不是 0');
});

test('解析公告列表：交易日期以标题为准（URL 路径可能是补发日期）', () => {
  const l = trade.parseTradeListJson(LIST_JSON);
  assertEqual(l.items.length, 2, '条目数');
  const old = l.items.find((i) => i.title.startsWith('2024年'));
  assertEqual(old.trade_date, '2024-01-22', '2024 条目日期应来自标题而不是 URL 路径（20250306）');
  assertIncludes(old.url, 'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/20250306/', 'URL 应补全为绝对地址');
  const sorted = l.items.map((i) => i.trade_date);
  assertEqual(sorted.join(','), '2024-01-22,2026-09-23', '条目应按日期升序返回');
});

test('写入行情：新增 → 未变（幂等）→ 官方修订（保留旧值）', () => {
  const url = 'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/20260923/153004998.shtml';
  const first = trade.upsertTradeDaily({
    trade_date: '2026-09-23', volume: 122, turnover: 10497.1, avg_price: 86.04,
    session_state: 'traded', source_url: url, published_at: '2026-09-23 16:43:34',
  }, { actor: 'test', reason: '官方公告采集' });
  assertEqual(first.action, 'inserted', '首次写入应为 inserted');

  const again = trade.upsertTradeDaily({
    trade_date: '2026-09-23', volume: 122, turnover: 10497.1, avg_price: 86.04,
    session_state: 'traded', source_url: url,
  }, { actor: 'test', reason: '重复采集' });
  assertEqual(again.action, 'unchanged', '相同数值重复采集应为 unchanged');
  assertEqual(db.get('SELECT COUNT(*) c FROM trade_daily WHERE trade_date = ?', ['2026-09-23']).c, 1, '不应产生重复行');

  const revised = trade.upsertTradeDaily({
    trade_date: '2026-09-23', volume: 130, turnover: 11180, avg_price: 86.0,
    session_state: 'traded', source_url: url,
  }, { actor: 'test', reason: '官方修订' });
  assertEqual(revised.action, 'revised', '数值变化应为 revised');
  const row = db.get('SELECT * FROM trade_daily WHERE trade_date = ?', ['2026-09-23']);
  assertEqual(row.volume, 130, '新值应写入');
  assertEqual(row.revision, 2, '版本号应递增');
  assertEqual(row.verify_status, 'pending', '修订后必须重新核对');
  const revs = db.all('SELECT * FROM trade_revision WHERE trade_daily_id = ?', [row.id]);
  assertEqual(revs.length, 3, '三个字段变化应各留一条修订记录');
  assertEqual(revs.find((r) => r.field === 'volume').old_value, '122', '旧值必须保留');
});

test('累计值写入与修订检测', () => {
  const a = trade.upsertCumulativeReference({ as_of_date: '2026-09-23', volume_total: 23292747, turnover_total: 1884199847.62 });
  assertEqual(a.action, 'inserted');
  const b = trade.upsertCumulativeReference({ as_of_date: '2026-09-23', volume_total: 23292747, turnover_total: 1884199847.62 });
  assertEqual(b.action, 'unchanged');
  const c = trade.upsertCumulativeReference({ as_of_date: '2026-09-23', volume_total: 23293000, turnover_total: 1884199847.62 });
  assertEqual(c.action, 'revised');
});

test('区间成交均价 = Σ成交额 ÷ Σ成交量（不是日均价的简单平均）', () => {
  // 造两天数据：第一天 100 t / 10000 元（100 元/t），第二天 900 t / 45000 元（50 元/t）
  trade.upsertTradeDaily({ trade_date: '2026-09-01', volume: 100, turnover: 10000, avg_price: 100, session_state: 'traded' }, { actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-09-02', volume: 900, turnover: 45000, avg_price: 50, session_state: 'traded' }, { actor: 'test' });
  const s = trade.tradeSummary({ from: '2026-09-01', to: '2026-09-02', granularity: 'month' });
  const bucket = s.buckets.find((b) => b.bucket === '2026-09');
  assertEqual(bucket.volume, 1000, '成交量合计');
  assertEqual(bucket.turnover, 55000, '成交额合计');
  assertEqual(bucket.avg_price, 55, '加权均价应为 55（简单平均 75 是错的）');
});

test('无成交交易日与数据暂缺分别表示（不用 0 混淆）', () => {
  trade.upsertTradeDaily({ trade_date: '2026-09-03', volume: 0, turnover: 0, avg_price: null, session_state: 'no_trade' }, { actor: 'test' });
  const list = trade.listTradeDaily({ from: '2026-09-01', to: '2026-09-03' });
  const noTrade = list.rows.find((r) => r.trade_date === '2026-09-03');
  assertEqual(noTrade.session_state, 'no_trade', '应为无成交交易日');
  assertEqual(noTrade.avg_price, null, '无成交不得给 0 元价格');
  assertEqual(noTrade.avg_price_derived, null, '成交量为 0 时不得给出计算均价');
});

test('交易日历：官方公告日=trading，有行情=有成交，标为交易日却无行情=数据暂缺，周末=休市', () => {
  const out = trade.rebuildCalendar(['2026-09-21', '2026-09-22', '2026-09-23'], { windowStart: '2026-09-21' });
  assertEqual(out.from, '2026-09-21');
  assertEqual(out.marked, 3, '窗口内三天都应写入日历');
  const cal = trade.tradeCalendar({ from: '2026-09-19', to: '2026-09-24' });
  const byDate = new Map(cal.days.map((d) => [d.trade_date, d]));
  assertEqual(byDate.get('2026-09-20').state, 'closed', '周日 → 休市');
  assertIncludes(byDate.get('2026-09-20').state_label, '周末');
  // 2026-09-23 在前面的用例中已写入行情 → 有成交
  assertEqual(byDate.get('2026-09-23').state, 'traded', '有行情 → 有成交');
  // 2026-09-21/22 被标为交易日但没有行情记录 → 数据暂缺（而不是 0 元、也不是休市）
  assertEqual(byDate.get('2026-09-21').state, 'missing', '标为交易日但无行情 → 数据暂缺');
  assertIncludes(byDate.get('2026-09-21').state_label, '数据暂缺');
  assertEqual(byDate.get('2026-09-24').state, 'missing', '窗口外未采集的日期也是数据暂缺');
  assert(cal.counts.missing >= 3, `应统计暂缺天数，实际 ${cal.counts.missing}`);
  assertIncludes(cal.note, '不是');
});

test('导入校验：日期/数值/量价关系错误逐行拒绝，合法行进入待核对', () => {
  const good = { __row: 2, trade_date: '2026-09-08', volume: '1000', turnover: '95000', avg_price: '95', session_state: null, source_url: null, published_at: null, note: null };
  const badDate = { __row: 3, trade_date: '2026/09/08', volume: '10', turnover: null, avg_price: null };
  const badRelation = { __row: 4, trade_date: '2026-09-09', volume: '100', turnover: '50000', avg_price: '95' };
  const out = trade.importTradeRows({ name: 'tester', role: 'researcher' }, [good, badDate, badRelation]);
  assertEqual(out.accepted_count, 1, '只应接受 1 行');
  assertEqual(out.rejected_count, 2, '应拒绝 2 行');
  assert(out.rejected[0].errors.join('；').includes('YYYY-MM-DD'), '应提示日期格式');
  assert(out.rejected[1].errors.join('；').includes('不一致'), '应提示量价关系不一致');
  const row = db.get('SELECT * FROM trade_daily WHERE trade_date = ?', ['2026-09-08']);
  assertEqual(row.verify_status, 'pending', '导入行必须是待核对');
});

test('模板导出与 CSV 解析可往返', () => {
  const csv = templates.templateCsv('trade-daily');
  assertIncludes(csv, '交易日期', '模板应含表头');
  assertIncludes(csv, '字段定义', '模板应含字段定义');
  const text = '\uFEFF交易日期,成交量(tCO₂e),成交额(元),成交均价(元/tCO₂e),官方公告链接\n2026-09-10,500,"47,500.00",95,https://example.org/a\n';
  const parsed = templates.rowsFromCsv('trade-daily', text);
  assertEqual(parsed.errors.length, 0, '解析不应报错');
  assertEqual(parsed.rows.length, 1, '应解析 1 行');
  assertEqual(parsed.rows[0].trade_date, '2026-09-10');
});

test('导出包含数据截点、来源与字段口径，并写入导出审计', () => {
  const { columns, rows, meta } = trade.tradeDailyExport({ from: '2026-09-01', to: '2026-09-30' });
  assert(columns.length >= 10, '导出列应包含明细字段');
  assert(meta['数据截至'], '应含数据截至');
  assertIncludes(meta['来源'], '自愿减排交易系统', '应含官方来源');
  assertIncludes(meta['口径'], '不是收盘价', '应说明均价口径');
  const out = exportSvc.buildExport({
    user: { name: 'tester', role: 'researcher' }, dataset: '交易行情明细', fileBase: 'trade_daily',
    format: 'csv', columns, rows, meta, filters: {},
  });
  assertIncludes(out.body.toString('utf8'), '数据截至', 'CSV 应含元信息');
  assert(out.sha256 && out.sha256.length === 64, '应计算 sha256');
  const log = db.get('SELECT * FROM export_log ORDER BY at DESC LIMIT 1');
  assert(log && log.dataset === '交易行情明细', '应写入导出审计');
});

test('CSV 公式注入被转义', () => {
  const out = exportSvc.toCsv([{ key: 'a', label: 'A' }], [{ a: '=cmd|calc' }], {});
  assertIncludes(out, "'=cmd|calc", '以 = 开头的单元格应加前缀防护');
});

test('人工更正必须给出原因，并保留旧值', () => {
  const row = db.get('SELECT * FROM trade_daily WHERE trade_date = ?', ['2026-09-08']);
  const noReason = trade.amendTradeDaily({ name: 'tester', role: 'researcher' }, row.id, { volume: 1200 });
  assert(noReason.error, '缺少原因应被拒绝');
  const ok = trade.amendTradeDaily({ name: 'tester', role: 'researcher' }, row.id, { volume: 1200, reason: '官方公告数字录入错误' });
  assert(ok.ok, '带原因的人工更正应通过');
  const rev = db.all('SELECT * FROM trade_revision WHERE trade_daily_id = ?', [row.id]);
  assert(rev.some((r) => r.field === 'volume' && r.old_value === '1000'), '旧值应留痕');
});

/* ------------------------------ 可选联网用例 ------------------------------ */

if (netAllowed()) {
  await testAsync('【联网】官方公告列表可获取且解析出多条公告', async () => {
    const res = await ctx.collect.fetchText(trade.TRADE_SOURCES.list_json, {
      headers: { referer: trade.TRADE_SOURCES.list_page, accept: 'application/json,*/*' }, rateLimitPerMin: 30,
    });
    assert(res.ok, `请求失败：${res.error}`);
    const list = trade.parseTradeListJson(res.body);
    assert(list.items.length > 100, `公告数量异常：${list.items.length}`);
    assert(list.items.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.trade_date)), '所有条目应有可解析日期');
  });

  await testAsync('【联网】官方公告正文可解析出成交量与累计值', async () => {
    const res = await ctx.collect.fetchText(trade.TRADE_SOURCES.list_json, { rateLimitPerMin: 30 });
    const list = trade.parseTradeListJson(res.body);
    const latest = list.items[list.items.length - 1];
    const page = await ctx.collect.fetchText(latest.url, { rateLimitPerMin: 30 });
    assert(page.ok, `公告页获取失败：${page.error}`);
    const p = trade.parseTradeBulletin(page.body, { url: latest.url, fallback_date: latest.trade_date });
    assert(p.volume !== null, '应解析出成交量');
    assert(p.cumulative && p.cumulative.volume_total > 0, '应解析出官方累计成交量');
  });
} else {
  console.log('  · 联网用例已跳过（npm run v2:test -- --net 可开启）');
}

finish('test/11-v2-trade.test.mjs');
