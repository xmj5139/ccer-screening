/**
 * 行情区间摘要（market-summary-svc）
 * ============================================================================
 * 需求（docs/44 第 3 条）：行情数字表**在页面标题下汇总实际筛选区间并标明确切口径**，
 * **禁止逐行调用模型**。（docs/46 第 9 条进一步要求缺失值处理正确。）
 *
 * 本模块是**纯确定性程序**：只对当前筛选命中的行做聚合，输出区间、口径、单位与
 * 空缺说明。它不调用模型、不发外网请求，也不改写任何官方数值。
 *
 * 缺失值纪律：
 *   · 未披露的成交量 / 成交额单独计数，**保持 null，绝不当 0**；
 *   · 只要区间内有任一条已成交记录缺量或缺额，就不输出「区间完整均价」；
 *   · 交易日数按**日期去重**；同一天既有分项又有官方合计时只计合计，避免双计。
 */
import { all } from '../core/db.mjs';
import { TRADE_METHOD_TOTAL, SESSION_STATES } from './trade-svc.mjs';

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

function fmt(v, digits = 2) {
  if (!isNum(v)) return '—';
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function rangeOf(rows, col = 'trade_date') {
  const dates = [...new Set(rows.map((r) => String(r[col] || '')).filter(Boolean))].sort();
  return { from: dates[0] || null, to: dates[dates.length - 1] || null, days: dates.length };
}

function stateLabel(s) {
  return SESSION_STATES[s] || s || '未标注';
}

/**
 * 同一天既有「官方合计」行又有分项行时，只保留合计行，避免把同一天重复相加。
 * 没有合计行时保留全部分项行（由调用方在口径里说明是按交易方式分项汇总）。
 */
function dedupeDays(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.trade_date || '');
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const kept = [];
  let mergedDays = 0;
  for (const [, list] of byDate) {
    const totals = list.filter((r) => String(r.trade_method || '') === TRADE_METHOD_TOTAL);
    if (totals.length) {
      kept.push(...totals);
      if (list.length > totals.length) mergedDays += 1;
    } else {
      kept.push(...list);
    }
  }
  return { rows: kept, merged_days: mergedDays };
}

/** 汇总一组已成交记录的披露量/额：未披露返回 null，不返回 0。 */
function sumDisclosed(rows, key) {
  const disclosed = rows.filter((r) => isNum(r[key]));
  if (!disclosed.length) return { value: null, disclosed: 0, missing: rows.length, complete: rows.length === 0 };
  const value = disclosed.reduce((a, r) => a + Number(r[key]), 0);
  return { value, disclosed: disclosed.length, missing: rows.length - disclosed.length, complete: disclosed.length === rows.length };
}

/**
 * CCER 行情区间摘要（确定性）。
 * @param {{from?:string,to?:string,trade_method?:string}} filters 与列表接口相同的筛选条件
 */
export function tradeRangeSummary(filters = {}) {
  const where = [];
  const params = [];
  if (filters.from) { where.push('trade_date >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('trade_date <= ?'); params.push(filters.to); }
  if (filters.trade_method) { where.push('trade_method = ?'); params.push(filters.trade_method); }
  const raw = all(
    `SELECT trade_date, session_state, trade_method, volume, turnover, avg_price, verify_status
     FROM trade_daily ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY trade_date`,
    params
  );
  const dedup = filters.trade_method ? { rows: raw, merged_days: 0 } : dedupeDays(raw);
  const rows = dedup.rows;
  const traded = rows.filter((r) => r.session_state === 'traded' && (isNum(r.volume) || isNum(r.turnover)));
  const vSum = sumDisclosed(traded, 'volume');
  const tSum = sumDisclosed(traded, 'turnover');
  const prices = traded.filter((r) => isNum(r.avg_price)).map((r) => Number(r.avg_price));
  const r = rangeOf(rows);
  const byState = rows.reduce((acc, x) => { acc[x.session_state || 'unknown'] = (acc[x.session_state || 'unknown'] || 0) + 1; return acc; }, {});
  const byStateLabel = Object.fromEntries(Object.entries(byState).map(([k, v]) => [stateLabel(k), v]));
  // 只有量、额都**完整披露**且量大于 0 时才给出区间加权均价（不完整的区间不算完整均价）
  const complete = traded.length > 0 && vSum.complete && tSum.complete && Number(vSum.value) > 0;
  const avg = complete ? Number((Number(tSum.value) / Number(vSum.value)).toFixed(2)) : null;

  return {
    dataset: 'trade',
    label: 'CCER 行情区间汇总',
    filters: { from: filters.from || null, to: filters.to || null, trade_method: filters.trade_method || null },
    actual_range: r,
    rows: rows.length,
    raw_rows: raw.length,
    merged_total_days: dedup.merged_days,
    traded_days: traded.length,
    by_state: byState,
    by_state_label: byStateLabel,
    disclosure: {
      volume: { disclosed: vSum.disclosed, missing: vSum.missing, complete: vSum.complete },
      turnover: { disclosed: tSum.disclosed, missing: tSum.missing, complete: tSum.complete },
    },
    totals: {
      volume: vSum.value,
      volume_unit: 'tCO2e',
      turnover: tSum.value,
      turnover_unit: '元',
      // 区间成交均价 = 区间成交额 ÷ 区间成交量（加权），不是收盘价；
      // 量或额有未披露时保持 null，不给出「看起来完整」的均价。
      avg_price: avg,
      avg_price_unit: '元/tCO2e',
      avg_price_note: avg === null
        ? '区间内存在未披露的成交量或成交额（或成交量为 0），因此不计算区间加权均价。'
        : '区间成交额 ÷ 区间成交量（加权），不是收盘价。',
      price_min: prices.length ? Math.min(...prices) : null,
      price_max: prices.length ? Math.max(...prices) : null,
    },
    caliber:
      '区间汇总只统计 session_state=traded 的记录；未披露的成交量/成交额单独计数并保持为空（不当 0）。' +
      '同一天既有官方合计行又有分项行时只计合计行，避免双计；交易日数按日期去重。' +
      '成交量或成交额不完整时不输出区间均价。状态文案：' +
      Object.entries(byStateLabel).map(([k, v]) => `${k} ${v} 天`).join('、') + '。',
    text: buildTradeText(r, traded, vSum, tSum, byStateLabel, avg, dedup.merged_days),
    model_calls: 0,
    note: '本摘要由确定性程序按当前筛选条件聚合，不逐行调用模型，也不改写官方数值。',
  };
}

function buildTradeText(r, traded, vSum, tSum, byStateLabel, avg, mergedDays) {
  if (!r.days) return '当前筛选区间内没有已入库的行情记录。';
  const parts = [
    `实际区间 ${r.from} ~ ${r.to}（按日期去重 ${r.days} 天有记录）`,
    `其中已成交 ${traded.length} 天`,
    vSum.value === null ? '区间内没有已披露的成交量' : `已披露区间成交量 ${fmt(vSum.value)} tCO2e${vSum.missing ? `（另有 ${vSum.missing} 天未披露成交量）` : ''}`,
    tSum.value === null ? '区间内没有已披露的成交额' : `已披露区间成交额 ${fmt(tSum.value)} 元${tSum.missing ? `（另有 ${tSum.missing} 天未披露成交额）` : ''}`,
    avg === null ? '量或额不完整，不计算区间加权均价' : `区间加权均价 ${fmt(avg)} 元/tCO2e`,
  ];
  if (mergedDays) parts.push(`同日官方合计已优先，合并 ${mergedDays} 天分项`);
  const others = Object.entries(byStateLabel).filter(([k]) => k !== stateLabel('traded')).map(([k, n]) => `${k} ${n} 天`);
  if (others.length) parts.push(`其它状态：${others.join('、')}`);
  return parts.join('；') + '。';
}

/**
 * CEA 行情区间摘要（确定性）。
 * 按 instrument 与 price_regime 口径分组：不同标的/口径不可混算。
 */
export function ceaRangeSummary(filters = {}) {
  const where = [];
  const params = [];
  if (filters.from) { where.push('trade_date >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('trade_date <= ?'); params.push(filters.to); }
  if (filters.instrument) { where.push('instrument = ?'); params.push(filters.instrument); }
  if (filters.price_regime) { where.push('price_regime = ?'); params.push(filters.price_regime); }
  const rows = all(
    `SELECT trade_date, instrument, price_regime, session_state, close, total_volume, total_turnover, computed_avg_price, verification_status
     FROM cea_trade_daily ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY trade_date`,
    params
  );
  const withTrade = rows.filter((r) => isNum(r.total_volume) || isNum(r.total_turnover));
  const vSum = sumDisclosed(withTrade, 'total_volume');
  const tSum = sumDisclosed(withTrade, 'total_turnover');
  const closes = rows.filter((r) => isNum(r.close)).map((r) => Number(r.close));
  const r = rangeOf(rows);
  const complete = withTrade.length > 0 && vSum.complete && tSum.complete && Number(vSum.value) > 0;
  const avg = complete ? Number((Number(tSum.value) / Number(vSum.value)).toFixed(2)) : null;
  const instruments = [...new Set(rows.map((x) => x.instrument).filter(Boolean))];
  const regimes = [...new Set(rows.map((x) => x.price_regime).filter(Boolean))];
  const mixed = instruments.length > 1 || regimes.length > 1;

  return {
    dataset: 'cea',
    label: 'CEA 行情区间汇总',
    filters: {
      from: filters.from || null, to: filters.to || null,
      instrument: filters.instrument || null, price_regime: filters.price_regime || null,
    },
    actual_range: r,
    rows: rows.length,
    traded_days: withTrade.length,
    instruments,
    price_regimes: regimes,
    mixed_caliber: mixed,
    disclosure: {
      volume: { disclosed: vSum.disclosed, missing: vSum.missing, complete: vSum.complete },
      turnover: { disclosed: tSum.disclosed, missing: tSum.missing, complete: tSum.complete },
    },
    totals: {
      volume: vSum.value,
      total_volume: vSum.value,
      volume_unit: '吨',
      turnover: tSum.value,
      total_turnover: tSum.value,
      turnover_unit: '元',
      computed_avg_price: avg,
      computed_avg_price_unit: '元/吨',
      computed_avg_price_note: avg === null
        ? '区间内存在未披露的总成交量或总成交额（或总量为 0），不计算「总成交额 ÷ 总成交量」。'
        : '总成交额 ÷ 总成交量（全方式加权），与官方综合收盘价是两个口径。',
      close_min: closes.length ? Math.min(...closes) : null,
      close_max: closes.length ? Math.max(...closes) : null,
      close_unit: '元/吨',
    },
    caliber:
      '官方综合收盘价（指定权重指数）与「全方式计算均价 = 总成交额 ÷ 总成交量」分列，两个口径不互相替代；' +
      '未披露的字段保持为空，不用 0 或前值填充；量与额不完整时不计算均价。' +
      (mixed ? '当前区间包含多个标的或行情编制口径，分项不可混算，请分别筛选后再汇总。' : ''),
    text: r.days
      ? `实际区间 ${r.from} ~ ${r.to}（${r.days} 个交易日）；` +
        (withTrade.length
          ? [
            vSum.value === null ? '总成交量未披露' : `已披露总成交量 ${fmt(vSum.value)} 吨${vSum.missing ? `（另有 ${vSum.missing} 天未披露）` : ''}`,
            tSum.value === null ? '总成交额未披露' : `已披露总成交额 ${fmt(tSum.value)} 元${tSum.missing ? `（另有 ${tSum.missing} 天未披露）` : ''}`,
            avg === null ? '量或额不完整，不计算全方式均价' : `全方式计算均价 ${fmt(avg)} 元/吨`,
            closes.length ? `官方综合收盘价区间 ${fmt(Math.min(...closes))} ~ ${fmt(Math.max(...closes))} 元/吨` : '官方收盘价未披露',
          ].join('；') + '。'
          : '区间内没有已披露量额的记录。')
      : '当前筛选区间内没有已入库的 CEA 行情记录。',
    model_calls: 0,
    note: '本摘要由确定性程序按当前筛选条件聚合，不逐行调用模型，也不改写官方数值。',
  };
}
