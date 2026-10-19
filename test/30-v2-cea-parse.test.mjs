/**
 * v2 测试 30：CEA 官方行情原文解析与确定性核对（纯函数，不需要数据库）
 * ============================================================================
 * 覆盖规范用例：CEA-02、CEA-03、CEA-04、CEA-05、CEA-10（名录页面判定）。
 *
 * 【测试夹具的真实来源】
 *   FIXTURE_0730 / FIXTURE_0811 中的**语句为官方原文逐字复制**，取自：
 *     · https://overview.cneeex.com/c/2026-07-30/498086.shtml
 *     · https://overview.cneeex.com/c/2026-08-11/498128.shtml
 *   真实采集时间：2026-10-14（本地 CEA 隔离库 data/cea-dev-20261014.db 的
 *   source_snapshot 记录，content_hash: b0c81c509230d7ea… / 2a34cb7ac03c88c1…）。
 *   这里只保留正文语句（去掉页面导航/样式），不改动任何数值、标点或单位。
 *
 *   凡属**构造**的夹具（单位换算、缺字段、月报、CCER 页面、异常数值）均在用例名与
 *   注释中显式标注「构造样本」，不冒充官方原文。
 */
import { test, assert, assertEqual, assertIncludes, summary } from './v2-helpers.mjs';

const {
  parseCeaDailyReport, deriveDaily, runDailyChecks, decimalShift, parseAmountToken,
  extractTradeDate, htmlToText, parseEntityRows, checkEntityPage, matchOfficialTemplate,
} = await import('../src/services/cea-parse.mjs');

console.log('\n[v2-30] CEA 官方行情解析与确定性核对');

/* ------------------------------------------------------------------ */
/* 真实官方原文夹具（逐字复制，采集于 2026-10-14）                     */
/* ------------------------------------------------------------------ */

const URL_0730 = 'https://overview.cneeex.com/c/2026-07-30/498086.shtml';
const URL_0811 = 'https://overview.cneeex.com/c/2026-08-11/498128.shtml';

const FIXTURE_0730 = `【CEA】全国碳市场每日综合价格行情及成交信息20260730-上海环境能源交易所
今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨，收盘价较前一日上涨1.00%。
今日挂牌协议交易成交量544,313吨，成交额52,585,579.00元；大宗协议交易成交量500,000吨，成交额47,575,000.00元；今日无单向竞价。
今日全国碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。
2026年1月1日至7月30日，全国碳市场碳排放配额成交量68,966,986吨，成交额5,499,968,391.61元。
截至2026年7月30日，全国碳市场碳排放配额累计成交量933,833,506吨，累计成交额63,162,586,623.18元。`;

const FIXTURE_0811 = `【CEA】全国碳市场每日综合价格行情及成交信息20260811-上海环境能源交易所
今日全国碳排放权交易市场综合价格行情为: 开盘价98.30元/吨，最高价98.50元/吨，最低价98.30元/吨，收盘价98.32元/吨，收盘价较前一日下跌0.20%。
今日挂牌协议交易成交量244,814吨，成交额24,069,216.20元；大宗协议交易成交量100,000吨，成交额9,810,000.00元；今日无单向竞价。
今日全国碳排放权交易市场配额总成交量344,814吨，总成交额33,879,216.20元。
2026年1月1日至8月11日，全国碳排放权交易市场配额成交量76,603,636吨，成交额6,224,769,077.55元。
截至2026年8月11日，全国碳排放权交易市场配额累计成交量941,470,156吨，累计成交额63,887,387,309.12元。`;

/* ------------------------------------------------------------------ */
/* CEA-02 / CEA-03：两个真实样本逐字段对照                            */
/* ------------------------------------------------------------------ */

const p0730 = parseCeaDailyReport(FIXTURE_0730, { url: URL_0730 });
const p0811 = parseCeaDailyReport(FIXTURE_0811, { url: URL_0811 });

test('CEA-02 2026-07-30 真实样本：OHLC 与涨跌幅逐项一致', () => {
  assertEqual(p0730.parse_status, 'ok', '解析状态');
  assertEqual(p0730.trade_date, '2026-07-30');
  assertEqual(p0730.fields.open, 96.0, 'open');
  assertEqual(p0730.fields.high, 97.0, 'high');
  assertEqual(p0730.fields.low, 95.9, 'low');
  assertEqual(p0730.fields.close, 96.61, 'close');
  assertEqual(p0730.fields.change_pct, 1.0, 'change_pct');
});

test('CEA-02 2026-07-30 真实样本：分方式量额、总计、年累计、历史累计', () => {
  assertEqual(p0730.fields.listed_volume, 544313, '挂牌成交量');
  assertEqual(p0730.fields.listed_turnover, 52585579, '挂牌成交额');
  assertEqual(p0730.fields.block_volume, 500000, '大宗成交量');
  assertEqual(p0730.fields.block_turnover, 47575000, '大宗成交额');
  assertEqual(p0730.fields.total_volume, 1044313, '总成交量');
  assertEqual(p0730.fields.total_turnover, 100160579, '总成交额');
  assertEqual(p0730.fields.year_volume, 68966986, '年成交量');
  assertEqual(p0730.fields.year_turnover, 5499968391.61, '年成交额');
  assertEqual(p0730.fields.lifetime_volume, 933833506, '历史累计成交量');
  assertEqual(p0730.fields.lifetime_turnover, 63162586623.18, '历史累计成交额');
});

test('CEA-02 2026-07-30 真实样本：「今日无单向竞价」→ 竞价量为 0 且有原文依据', () => {
  assertEqual(p0730.fields.auction_volume, 0, '明确无竞价应为 0');
  assertEqual(p0730.fields.auction_turnover, 0, '明确无竞价应为 0');
  assert(p0730.explicit_none.includes('auction_volume'), '应记录 explicit_none 依据');
  assertIncludes(p0730.raw_fields.auction_volume, '无单向竞价', '应保留「无」的原文');
});

test('CEA-03 2026-08-11 真实样本：OHLC、分方式、总计逐项一致', () => {
  assertEqual(p0811.parse_status, 'ok', '解析状态');
  assertEqual(p0811.trade_date, '2026-08-11');
  assertEqual(p0811.fields.open, 98.3, 'open');
  assertEqual(p0811.fields.high, 98.5, 'high');
  assertEqual(p0811.fields.low, 98.3, 'low');
  assertEqual(p0811.fields.close, 98.32, 'close');
  assertEqual(p0811.fields.change_pct, -0.2, 'change_pct 必须为负（下跌）');
  assertEqual(p0811.fields.listed_volume, 244814, '挂牌成交量');
  assertEqual(p0811.fields.listed_turnover, 24069216.2, '挂牌成交额');
  assertEqual(p0811.fields.block_volume, 100000, '大宗成交量');
  assertEqual(p0811.fields.block_turnover, 9810000, '大宗成交额');
  assertEqual(p0811.fields.total_volume, 344814, '总成交量');
  assertEqual(p0811.fields.total_turnover, 33879216.2, '总成交额');
});

test('CEA-02/03 真实样本：交易日期取自标题，年度区间起点不被误认', () => {
  // 正文含「2026年1月1日至7月30日」，旧实现会把 2026-01-01 当成交易日
  assertEqual(p0730.trade_date, '2026-07-30');
  assertEqual(p0730.date_source, 'title');
  assertEqual(p0730.data_as_of, '2026-07-30', '数据截止日应为「截至…」日期');
  assertEqual(p0730.date_consistent, true, '各来源日期应一致');
  const sources = p0730.date_candidates.map((c) => c.source);
  assert(sources.includes('title') && sources.includes('url'), '应同时记录标题与 URL 候选');
  assert(!p0730.date_candidates.some((c) => c.date === '2026-01-01'), '年度区间起点不得作为日期候选');
});

test('CEA-05 真实样本：确定性核对全部通过，且不把口径差异判为冲突', () => {
  for (const [label, p] of [['07-30', p0730], ['08-11', p0811]]) {
    const d = deriveDaily(p.fields);
    const c = runDailyChecks({ ...p.fields, ...d }, {
      dateInfo: { candidates: p.date_candidates, consistent: p.date_consistent, source: p.date_source },
    });
    assertEqual(c.status, 'pass', `${label} 确定性核对应通过：${JSON.stringify(c.checks.filter((x) => !x.ok))}`);
    const caliber = c.checks.find((x) => x.check_key === 'close_vs_avg_price');
    assertEqual(caliber.ok, true, '综合收盘价与全方式均价不同不得判为冲突');
    assertIncludes(caliber.detail, '不判为冲突', '应说明口径差异');
  }
});

test('CEA-05 真实样本：全方式均价 = 总额/总量，与官方收盘价分列', () => {
  const d = deriveDaily(p0730.fields);
  assertEqual(d.computed_avg_price, Math.round((100160579 / 1044313) * 1e6) / 1e6);
  assert(d.computed_avg_price !== p0730.fields.close, '两个口径不应相等（否则本用例无区分力）');
  assertEqual(d.sum_volume, 1044313, '分项合计=官方总量');
  assertEqual(d.sum_turnover, 100160579, '分项合计=官方总额');
  assertEqual(d.session_state, 'traded');
});

/* ------------------------------------------------------------------ */
/* CEA-04：单位、千分位、无竞价、未披露、月报、非 CEA 页面             */
/* ------------------------------------------------------------------ */

test('CEA-04 单位换算：万吨/亿吨、万元/亿元均正确换算为吨/元（构造样本）', () => {
  assertEqual(decimalShift('5258.5579', 4), 52585579, '万元 → 元');
  assertEqual(decimalShift('0.52585579', 8), 52585579, '亿元 → 元');
  assertEqual(decimalShift('54.4313', 4), 544313, '万吨 → 吨');
  assertEqual(decimalShift('9.33833506', 8), 933833506, '亿吨 → 吨');
  assertEqual(decimalShift('631.6258662318', 8), 63162586623.18, '亿元 → 元（长小数不丢精度）');
  assertEqual(decimalShift('1,044,313', 0), 1044313, '千分位');
  assertEqual(decimalShift('-0.20', 0), -0.2, '负值');
  assertEqual(decimalShift('abc', 0), null, '非数值返回 null');

  // 构造样本：与官方 2026-07-30 同日数值等价，仅把单位改写为万吨/亿元，用于验证换算
  // 注意换算关系：47,575,000 元 = 4,757.5 万元 = 0.47575 亿元
  const constructed = '今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨，收盘价较前一日上涨1.00%。\n' +
    '今日挂牌协议交易成交量54.4313万吨，成交额5,258.5579万元；大宗协议交易成交量50万吨，成交额0.47575亿元；今日无单向竞价。\n' +
    '今日全国碳排放配额总成交量104.4313万吨，总成交额1.00160579亿元。\n' +
    '2026年1月1日至7月30日，全国碳市场碳排放配额成交量6,896.6986万吨，成交额54.9996839161亿元。\n' +
    '截至2026年7月30日，全国碳市场碳排放配额累计成交量9.33833506亿吨，累计成交额631.6258662318亿元。';
  const c = parseCeaDailyReport(constructed, { url: URL_0730 });
  assertEqual(c.fields.listed_volume, 544313, '万吨→吨');
  assertEqual(c.fields.listed_turnover, 52585579, '万元→元');
  assertEqual(c.fields.block_turnover, 47575000, '亿元→元');
  assertEqual(c.fields.total_volume, 1044313, '总成交量（万吨）');
  assertEqual(c.fields.total_turnover, 100160579, '总成交额（亿元）');
  assertEqual(c.fields.year_volume, 68966986, '年成交量（万吨）');
  assertEqual(c.fields.year_turnover, 5499968391.61, '年成交额（亿元）');
  assertEqual(c.fields.lifetime_volume, 933833506, '历史累计（亿吨）');
  assertEqual(c.fields.lifetime_turnover, 63162586623.18, '历史累计（亿元）');
});

test('CEA-04 未披露字段必须为 null，不得用 0 或前值填充（构造样本）', () => {
  const partial = '今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨。\n' +
    '今日全国碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。';
  const r = parseCeaDailyReport(partial, { url: URL_0730 });
  assertEqual(r.parse_status, 'partial', '缺字段应判 partial');
  assertEqual(r.fields.listed_volume, null, '未披露的挂牌量必须为 null');
  assertEqual(r.fields.change_pct, null, '未披露的涨跌幅必须为 null');
  assertEqual(r.fields.lifetime_volume, null, '未披露的历史累计必须为 null');
  assert(r.missing_fields.includes('listed_volume'), '应记录缺失字段清单');
  assert(!r.explicit_none.includes('listed_volume'), '「未披露」不得记成「明确为无」');
});

test('CEA-04 正文没有目标内容 → 解析失败，且不产生任何零值字段', () => {
  // ① 连 CEA 标识都没有的页面：按「页面归属」直接拒绝
  const junk = '<html><body><h1>关于召开碳市场培训会议的通知</h1><p>各有关单位：请于本周五参会。</p></body></html>';
  const rj = parseCeaDailyReport(junk, { url: 'https://overview.cneeex.com/c/2026-09-01/000000.shtml' });
  assertEqual(rj.ok, false, '应判失败');
  assertEqual(rj.parse_status, 'failed');
  assertEqual(rj.rejection_reason, 'not_cea_page');
  assertIncludes(rj.parse_note, '拒绝解析为 CEA 行情');

  // ② 有 CEA 标识但正文没有行情字段：走「找不到字段 → 失败」，同样不得写 0
  const emptyCea = '<html><body><h1>全国碳市场综合价格行情</h1><p>今日无相关信息发布。</p></body></html>';
  const r = parseCeaDailyReport(emptyCea, { url: 'https://overview.cneeex.com/c/2026-09-01/000000.shtml' });
  assertEqual(r.ok, false, '应判失败');
  assertEqual(r.parse_status, 'failed');
  assertIncludes(r.parse_note, '本页记为解析失败并留缺口');
  for (const k of ['total_volume', 'total_turnover', 'close', 'open']) {
    assertEqual(r.fields[k], null, `${k} 不得被写成 0 或任意值`);
  }
});

test('CEA-04 CCER（自愿减排）页面不得被 CEA 解析器接收', () => {
  const ccer = '截至2026年2月11日，全国温室气体自愿减排交易市场累计成交量10,607,514吨，累计成交额757,692,183.59元。';
  const r = parseCeaDailyReport(ccer, { url: 'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/20260211/152816392.shtml' });
  assertEqual(r.ok, false, 'CCER 页面必须被拒绝');
  assertIncludes(r.parse_note, 'CCER');
  assertEqual(r.fields.lifetime_volume, null, '不得把 CCER 累计量写进 CEA 字段');
});

test('CEA-04 月报必须单独标记 period，不得作为日行情', () => {
  const monthly = '全国碳排放权交易市场月度报告\n本月全国碳市场碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。';
  const r = parseCeaDailyReport(monthly, { url: 'https://overview.cneeex.com/qgtpfqjy/jysj/ydgk/2026n/' });
  assertEqual(r.period, 'month', '应识别为月报');
  assertIncludes(r.parse_note, '禁止写入日行情表');
});

test('CEA-04 单位与字段语义不符时拒绝取值并留痕（构造样本）', () => {
  // 成交量字段给了「元」单位：属于口径错配，必须拒绝而不是当成吨
  const wrong = '今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨。\n' +
    '今日挂牌协议交易成交量52,585,579元；今日全国碳排放配额总成交额100,160,579.00元。';
  const r = parseCeaDailyReport(wrong, { url: URL_0730 });
  assertEqual(r.fields.listed_volume, null, '单位为元的成交量必须留空');
  assert(r.invalid_fields.some((i) => i.field === 'listed_volume'), '应记录被拒绝的候选值');
});

/* ------------------------------------------------------------------ */
/* 确定性核对：异常必须被标出                                          */
/* ------------------------------------------------------------------ */

test('确定性核对：OHLC 上下界不自洽必须判 fail', () => {
  const bad = { open: 100, high: 95, low: 90, close: 96, total_volume: 10, total_turnover: 1000 };
  const c = runDailyChecks(bad, {});
  const ohlc = c.checks.find((x) => x.check_key === 'ohlc_bounds');
  assertEqual(ohlc.ok, false, '最高价低于开盘价应判不自洽');
  assertEqual(c.status, 'fail');
});

test('确定性核对：分项合计与官方总量不一致必须判 fail', () => {
  const bad = { listed_volume: 100, block_volume: 200, total_volume: 999, total_turnover: 1000, close: 10 };
  const c = runDailyChecks(bad, {});
  const sum = c.checks.find((x) => x.check_key === 'parts_sum_volume');
  assertEqual(sum.ok, false, '300 ≠ 999 应判不一致');
});

test('确定性核对：负数量/负金额必须判 fail；涨跌幅为负不算异常', () => {
  const neg = { listed_volume: -1, total_volume: 10, total_turnover: 100, close: 10, change_pct: -0.2 };
  const c = runDailyChecks(neg, {});
  const nonNeg = c.checks.find((x) => x.check_key === 'non_negative');
  assertEqual(nonNeg.ok, false, '负成交量应判 fail');
  assert(!nonNeg.detail.includes('change_pct'), '涨跌幅为负属正常，不得列入负值异常');
});

test('确定性核对：无成交时计算均价必须为 NULL（不是 0）', () => {
  const noTrade = { total_volume: 0, total_turnover: 0, close: null };
  const d = deriveDaily(noTrade);
  assertEqual(d.computed_avg_price, null, '无成交量不得算出均价');
  assertEqual(d.session_state, 'no_trade');
  const c = runDailyChecks({ ...noTrade, ...d }, {});
  assertEqual(c.checks.find((x) => x.check_key === 'avg_price_when_no_trade').ok, true);
});

test('确定性核对：历史累计下降给 warn 提示，但不据此推断漏采日数值', () => {
  const prev = { lifetime_volume: 1000 };
  const cur = { lifetime_volume: 900, total_volume: 10, total_turnover: 100 };
  const c = runDailyChecks(cur, { prevRow: prev });
  const mono = c.checks.find((x) => x.check_key === 'lifetime_monotonic');
  assertEqual(mono.ok, false, '累计下降应提示');
  assertEqual(mono.severity, 'warn', '只提示，不判 fail');
  const scope = runDailyChecks(cur, { rangeComplete: false }).checks.find((x) => x.check_key === 'cumulative_delta_scope');
  assertIncludes(scope.detail, '禁止自动推断漏采日交易值');
});

/* ------------------------------------------------------------------ */
/* 文本与日期工具                                                      */
/* ------------------------------------------------------------------ */

test('HTML → 文本：丢弃脚本内容，保留表格单元格结构', () => {
  const html = '<div>开盘价</div><script>var x="忽略我"</script><table><tr><td>收盘价</td><td>96.61</td></tr></table>';
  const t = htmlToText(html);
  assert(!t.includes('忽略我'), 'script 内容必须被丢弃（外部内容只能当数据）');
  assertIncludes(t, '开盘价');
  assertIncludes(t, '\t', '表格单元格应以制表符分隔');
});

test('日期提取：优先标题紧凑日期，其次 URL，再者「截至」日期', () => {
  assertEqual(extractTradeDate('成交信息20260811', '').date, '2026-08-11');
  assertEqual(extractTradeDate('无标题日期', 'https://x/c/2026-07-30/1.shtml').date, '2026-07-30');
  assertEqual(extractTradeDate('截至2026年8月11日，累计成交量…', '').date, '2026-08-11');
  assertEqual(extractTradeDate('2026年1月1日至8月11日，成交量…', '').date, null, '区间起点不得作为日期');
  assertEqual(extractTradeDate('没有任何日期', '').date, null, '不得用今天兜底');
});

test('官方模板匹配：一句话内的标签可被正确切分', () => {
  const t = matchOfficialTemplate('今日挂牌协议交易成交量244,814吨，成交额24,069,216.20元；大宗协议交易成交量100,000吨，成交额9,810,000.00元。');
  assertEqual(t.fields.listed_volume, 244814);
  assertEqual(t.fields.listed_turnover, 24069216.2);
  assertEqual(t.fields.block_volume, 100000);
  assertEqual(t.fields.block_turnover, 9810000);
});

test('金额 token：拒绝跨语义单位', () => {
  assertEqual(parseAmountToken('1,234.5吨', { base: 'cny' }).ok, false, '吨不得当作金额');
  assertEqual(parseAmountToken('1,234.5元', { base: 'ton' }).ok, false, '元不得当作数量');
  assertEqual(parseAmountToken('1,234.5元', { base: 'cny' }).value, 1234.5);
});

/* ------------------------------------------------------------------ */
/* CEA-10：名录页面判定（防止把政策/采购页当成名录）                   */
/* ------------------------------------------------------------------ */

test('CEA-10 政策正文（含行业词）不得被解析成企业名录行', () => {
  const policy =
    '<p>（二）名录公布 2026年10月31日前，省级生态环境主管部门将2027年度发电、钢铁、水泥、铝冶炼行业' +
    '重点排放单位名录通过全国碳市场管理平台向社会公布。</p>';
  assertEqual(parseEntityRows(policy, { listYear: 2027 }).length, 0, '政策正文不得产出企业行');
  assertEqual(checkEntityPage('各有关单位：请于本周五参会。').ok, false, '无名录标识的页面应被拒绝');
});

test('CEA-10 名录表格：识别主体与信用代码，缺代码保留 null，行数不足不入库', () => {
  const list =
    '<p>2026年度重点排放单位名录（发电、钢铁、水泥、铝冶炼行业）</p><table>' +
    '<tr><td>1</td><td>华能福州电厂</td><td>91350100123456789X</td></tr>' +
    '<tr><td>2</td><td>福建三钢闽光股份有限公司</td><td>91350400123456789Y</td></tr>' +
    '<tr><td>3</td><td>福建水泥股份有限公司</td><td></td></tr>' +
    '</table>';
  const rows = parseEntityRows(list, { listYear: 2026, province: '福建' });
  assertEqual(rows.length, 3, '应识别 3 行');
  assertEqual(rows[0].credit_code, '91350100123456789X');
  assertEqual(rows[2].credit_code, null, '未披露信用代码必须为 null');
  assertEqual(rows[0].list_year, 2026);
  // 行数不足（像误命中的栏目页）时宁可不入库
  assertEqual(parseEntityRows('<p>2026年度重点排放单位名录</p><table><tr><td>某某公司</td></tr></table>', { listYear: 2026 }).length, 0);
});

process.exit(summary('30-v2-cea-parse.test.mjs') ? 1 : 0);
