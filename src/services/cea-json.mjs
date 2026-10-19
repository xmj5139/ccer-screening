/**
 * CEA 官方公开 JSON 解析（纯函数，不依赖数据库、不发网络请求）
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md「独立取样新增：官方网页使用的公开JSON」段与 CEA-16。
 *
 * 这些路径是官网页面自身使用的无登录公共数据路径（Codex 于 2026-10-14 实测 200），
 * **不是**商用行情 API 授权承诺；上游结构变更必须如实报错，不得猜测。
 *
 * 口径纪律（每条都来自实测样本，不能凭字段名推断）：
 *   1. `queryMarketByDate.data[0].dealQty/dealAmt` 是**挂牌口径**，不是全方式成交；
 *      且 `limiUpPric` / `averPric` / `updaTime` 等字段名被复用，值明显不是字面含义
 *      （实测 averPric=227473904、limiUpPric=39047447），**一律不采用**。
 *   2. 精确成交量额只能来自 `querySubStat` 的 **COMCEA** 三行按 tradeMethod 聚合
 *      （10 挂牌 / 20 大宗 / 21 单向竞价）；年度标的行不得与 COMCEA 重复相加。
 *   3. `dailyov.json` 的数量/金额是「万吨/亿元/亿吨」舍入展示值，只能作为概览与交叉核对，
 *      **不得覆盖**精确原始成交量额。两层数值都要保留。
 *   4. `hiskline.json` 的数量不能当作全国全方式成交量，只用于发现真实交易日与交叉核对 OHLC。
 *   5. HTTP 200 且业务码失败时必须判为失败（`success!==true` 或 `code!==200`）。
 */

/** 站点业务码判定：HTTP 200 不代表业务成功 */
export function checkBusinessCode(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: '响应不是 JSON 对象' };
  if (payload.success !== true) return { ok: false, reason: `业务码失败：success=${JSON.stringify(payload.success)}` };
  if (payload.code !== undefined && payload.code !== null && Number(payload.code) !== 200) {
    return { ok: false, reason: `业务码失败：code=${payload.code}` };
  }
  return { ok: true, reason: null };
}

/** "1,224,197" / "0.00" / 数字 → number；无法解析返回 null（不返回 0） */
export function parseCneexNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[,\s\uFF0C]/g, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 展示用数量/金额："297.34万吨" / "2.88亿元" / "9.99亿吨" → { value(基准单位), unit, text, tolerance } */
export function parseCneexDisplayAmount(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/^([+-]?\d[\d,]*(?:\.\d+)?)\s*(亿吨|万吨|万元|亿元|吨|元)$/);
  if (!m) return null;
  const num = parseCneexNumber(m[1]);
  if (num === null) return null;
  const unit = m[2];
  const exp10 = { 吨: 0, 万吨: 4, 亿吨: 8, 元: 0, 万元: 4, 亿元: 8 }[unit];
  const base = unit.endsWith('吨') ? 'ton' : 'cny';
  // 用十进制字符串移位避免浮点噪声
  const scaled = shiftDecimalString(m[1], exp10);
  // 舍入容差 = 展示值最后一位的半个单位。
  // 例：「9.99亿吨」最后一位是 0.01 亿吨 = 1,000,000 吨 → 容差 500,000 吨；
  //     「297.34万吨」最后一位是 0.01 万吨 = 100 吨 → 容差 50 吨。
  const decimals = (m[1].split('.')[1] || '').length;
  const tolerance = 0.5 * 10 ** Math.max(0, exp10 - decimals);
  return { value: scaled, unit, base, text: raw, decimals, tolerance };
}

function shiftDecimalString(numText, exp10) {
  let s = String(numText).replace(/,/g, '');
  let sign = 1;
  if (s[0] === '+' || s[0] === '-') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  let [intPart, fracPart = ''] = s.split('.');
  const digits = `${intPart}${fracPart}`;
  const fracLen = fracPart.length - Number(exp10 || 0);
  let out;
  if (fracLen <= 0) out = digits + '0'.repeat(-fracLen);
  else if (fracLen >= digits.length) out = `0.${'0'.repeat(fracLen - digits.length)}${digits}`;
  else out = `${digits.slice(0, digits.length - fracLen)}.${digits.slice(digits.length - fracLen)}`;
  const n = Number(out);
  return Number.isFinite(n) ? sign * n : null;
}

/** "20261013" → "2026-10-13"；已是 YYYY-MM-DD 则原样返回 */
export function parseCneexDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const out = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${out}T00:00:00Z`)) ? null : out;
}

/* ==================================================================== */
/*  dailyov.json —— 概览层（舍入展示值，不得覆盖精确值）                 */
/* ==================================================================== */

/**
 * 解析最新概览。返回值分两层：
 *   precise_candidates：来自概览的 OHLC 与昨收（概览本身就是精确报价，非舍入项）
 *   rounded：数量/金额的舍入展示层（万吨/亿元/亿吨）
 */
export function parseDailyOverview(payload) {
  const json = typeof payload === 'string' ? safeJson(payload) : payload;
  if (!json) return { ok: false, reason: 'dailyov 响应不是合法 JSON' };
  const tradeDate = parseCneexDate(json.tradeDate);
  if (!tradeDate) return { ok: false, reason: `dailyov 缺少可解析的 tradeDate：${json.tradeDate}` };
  const pct = String(json.ad ?? '').trim();
  const changePct = pct ? parseCneexNumber(pct.replace('%', '')) : null;
  const todayQty = parseCneexDisplayAmount(json.todayQty);
  const todayAmt = parseCneexDisplayAmount(json.todayAmt);
  const totalQty = parseCneexDisplayAmount(json.totalQty);
  const totalAmt = parseCneexDisplayAmount(json.totalAmt);
  return {
    ok: true,
    trade_date: tradeDate,
    open: parseCneexNumber(json.openPrice),
    high: parseCneexNumber(json.highPrice),
    low: parseCneexNumber(json.lowPrice),
    close: parseCneexNumber(json.closePrice),
    prev_close: parseCneexNumber(json.beforeClose),
    change_pct: Number.isFinite(changePct) ? changePct : null,
    rounded: {
      today_qty: todayQty, today_amt: todayAmt, lifetime_qty: totalQty, lifetime_amt: totalAmt,
      note:
        'dailyov 的数量/金额为「万吨/亿元/亿吨」舍入展示值，仅用于概览与交叉核对；' +
        '精确成交量额以 querySubStat 的 COMCEA 聚合为准，两者都保留、不互相覆盖。',
    },
    source_kind: 'dailyov_json',
  };
}

/* ==================================================================== */
/*  queryMarketByDate —— 综合行情 OHLC（挂牌口径需单列）                */
/* ==================================================================== */
/*
 * 只有 `subjCode=COMCEA` 的汇总行才是全国综合行情。响应里只有年度标的行
 * （CEA21/CEA22/CEA23/CEA24/CEA25 等）时**判失败**，绝不把年度标的 OHLC
 * 当全国综合行情展示或入库（docs/35「17:00 之后的独立故障注入追加」）。
 */

export function parseMarketByDate(payload) {
  const json = typeof payload === 'string' ? safeJson(payload) : payload;
  if (!json) return { ok: false, reason: 'queryMarketByDate 响应不是合法 JSON' };
  const biz = checkBusinessCode(json);
  if (!biz.ok) return { ok: false, reason: biz.reason };
  const rows = Array.isArray(json.data) ? json.data : [];
  const aggRows = rows.filter((r) => String(r.subjCode || '').toUpperCase() === 'COMCEA');
  // ② 必须存在 COMCEA 综合行情行：只有年度标的（CEA21/CEA22/…/CEA25）时**不得**取第一行冒充全国综合行情。
  //    （2026-10-14 独立故障注入：只有 CEA25 时旧实现回落到 rows[0] 仍返回 ok=true。）
  if (!aggRows.length) {
    const codes = [...new Set(rows.map((r) => String(r.subjCode || '').trim()).filter(Boolean))];
    return {
      ok: false,
      reason:
        'queryMarketByDate 响应没有 COMCEA 综合行情行' +
        (codes.length ? `（只有年度标的：${codes.join('、')}）` : '（data 为空）') +
        '：年度标的行情不得冒充全国综合行情，本通道按失败处理，不产出任何行情数值。',
      subject_codes: codes,
      source_kind: 'queryMarketByDate_json',
    };
  }
  const candidates = aggRows;
  const row = candidates[0];
  // 同一响应里若出现多条标的行，日期必须一致；否则无法确认这条行情属于哪一天（不猜）
  const dates = candidates.map((r) => parseCneexDate(r.quotPoin));
  const distinct = [...new Set(dates.filter(Boolean))];
  if (candidates.length > 1 && (distinct.length !== 1 || dates.some((d) => !d))) {
    return {
      ok: false,
      reason: `queryMarketByDate 响应内日期不一致或缺失：${dates.map((d) => d || '（空）').join('、')}`,
      dates, source_kind: 'queryMarketByDate_json',
    };
  }
  const tradeDate = parseCneexDate(row.quotPoin);
  const chanRate = String(row.chanRate ?? '').trim();
  return {
    ok: true,
    trade_date: tradeDate,
    // 响应没有可解析日期时保持 trade_date=null：调用方必须据此判定「本通道无法确认日期」，不得当成请求日
    date_confirmed: !!tradeDate,
    subject_code: row.subjCode || null,
    open: parseCneexNumber(row.openPric),
    high: parseCneexNumber(row.highPric),
    low: parseCneexNumber(row.lowPric),
    close: parseCneexNumber(row.closPric),
    prev_close: parseCneexNumber(row.lastClosPric),
    change_pct: chanRate ? parseCneexNumber(chanRate.replace('%', '')) : null,
    // 明确命名：这是**挂牌口径**，不是全方式成交（CEA-16）
    listed_deal_volume: parseCneexNumber(row.dealQty),
    listed_deal_turnover: parseCneexNumber(row.dealAmt),
    caliber_note:
      'dealQty/dealAmt 为挂牌口径，不等于全方式成交；limiUpPric/averPric/updaTime 等字段名被上游复用，' +
      '实测取值与字面含义不符，一律不采用。',
    ignored_fields: ['limiUpPric', 'limiDownPric', 'averPric', 'updaTime', 'chanPric'],
    source_kind: 'queryMarketByDate_json',
  };
}

/* ==================================================================== */
/*  querySubStat —— 精确分方式量额与累计（COMCEA 三行聚合）             */
/* ==================================================================== */

/** tradeMethod 语义（由官网 displayStat 源码确认） */
export const TRADE_METHODS = { 10: 'listed', 20: 'block', 21: 'auction' };

/**
 * 取 subjectCode=COMCEA 的三行按交易方式聚合。
 * **不得**把各年度标的行与 COMCEA 相加（会重复计数）。
 *
 * 完整性纪律（docs/35 第 1 条，防止「少数行合成完整总量」）：
 *   1. COMCEA 汇总行的 tradeDate 必须**全部可解析且完全一致**，否则本通道直接判失败（不产出任何数值）；
 *   2. 同一 tradeMethod 出现多行 → 判为重复行，拒绝合计（重复会让总量虚高）；
 *   3. 未知 tradeMethod 行 → 无法归入已知方式，拒绝合计；
 *   4. 10/20/21 任一方式缺失 → 分方式值照实保留，但 total/year/lifetime 合计保持 **null（未知）**，
 *      绝不用「已见方式之和」冒充完整总量。`complete=false` 时调用方必须据此留缺口；
 *   5. 方式齐全但某个**累计/总量字段**在其中一行未披露（null）→ 只有该字段保持 null，
 *      其余已完整披露的字段照常给出合计（逐字段判定，见 `field_disclosure` / `fields_undisclosed`）。
 */
export function parseSubStat(payload, { subjectCode = 'COMCEA' } = {}) {
  const json = typeof payload === 'string' ? safeJson(payload) : payload;
  if (!json) return { ok: false, reason: 'querySubStat 响应不是合法 JSON' };
  const biz = checkBusinessCode(json);
  if (!biz.ok) return { ok: false, reason: biz.reason };
  const all = Array.isArray(json.data) ? json.data : [];
  if (!all.length) return { ok: false, reason: 'querySubStat 返回 data 为空' };
  const aggRows = all.filter((r) => String(r.subjectCode || '').toUpperCase() === subjectCode.toUpperCase());
  if (!aggRows.length) {
    return {
      ok: false,
      reason: `未找到 ${subjectCode} 汇总行（可用的标的：${[...new Set(all.map((r) => r.subjectCode))].join('、')}）`,
    };
  }
  // ① 汇总行日期一致性
  const rowDates = aggRows.map((r) => parseCneexDate(r.tradeDate));
  const distinctDates = [...new Set(rowDates.filter(Boolean))];
  if (distinctDates.length !== 1 || rowDates.some((d) => !d)) {
    return {
      ok: false,
      reason:
        `${subjectCode} 汇总行日期不一致或缺失：${rowDates.map((d) => d || '（无法解析）').join('、')}。` +
        '拒绝在无法确认交易日的情况下聚合量额。',
      trade_date: distinctDates.length === 1 ? distinctDates[0] : null,
      row_dates: rowDates,
      methods_seen: aggRows.map((r) => String(r.tradeMethod)),
      source_kind: 'querySubStat_json',
    };
  }
  const tradeDate = distinctDates[0];
  // ② 方式去重 + 未知方式识别
  const byMethod = new Map();
  const duplicated = [];
  const unknownMethods = [];
  for (const r of aggRows) {
    const key = TRADE_METHODS[String(r.tradeMethod)];
    if (!key) { unknownMethods.push(String(r.tradeMethod)); continue; }
    if (byMethod.has(key)) { duplicated.push(String(r.tradeMethod)); continue; }
    byMethod.set(key, r);
  }
  const missing = Object.entries(TRADE_METHODS)
    .filter(([, key]) => !byMethod.has(key))
    .map(([code, key]) => ({ trade_method: code, method: key }));
  const complete = duplicated.length === 0 && unknownMethods.length === 0 && missing.length === 0;
  const out = {
    ok: true,
    trade_date: tradeDate,
    date_confirmed: true,
    subject_code: subjectCode,
    /** 三方式是否齐全且无重复/未知行。false 时下列合计值必须视为未知（null） */
    complete,
    methods_missing: missing,
    methods_duplicated: duplicated,
    methods_unknown: unknownMethods,
    listed_volume: null, listed_turnover: null,
    block_volume: null, block_turnover: null,
    auction_volume: null, auction_turnover: null,
    total_volume: null, total_turnover: null,
    year_volume: null, year_turnover: null,
    lifetime_volume: null, lifetime_turnover: null,
    methods_seen: [],
    instrument_rows_excluded: all.length - aggRows.length,
    caliber_note:
      `精确量额来自 ${subjectCode} 汇总行的 tradeMethod 10(挂牌)/20(大宗)/21(单向竞价) 分项相加；` +
      '各年度标的行不参与相加，避免重复计数。' +
      (complete
        ? ''
        : `本响应汇总行不完整（缺失方式 ${missing.map((m) => m.method).join('、') || '无'}；` +
          `重复 ${duplicated.join('、') || '无'}；未知方式 ${unknownMethods.join('、') || '无'}），` +
          '合计值一律保持 null，绝不用已见方式之和冒充完整总量。'),
    source_kind: 'querySubStat_json',
  };
  // 逐方法保留原始分项，便于核验时呈现「哪些数相加得到累计值」（可审计、可复算）
  out.per_method = [];
  for (const [key, r] of byMethod.entries()) {
    out.methods_seen.push(String(r.tradeMethod));
    const row = {
      trade_method: String(r.tradeMethod),
      method: key,
      volume: parseCneexNumber(r.tradeVolume),
      turnover: parseCneexNumber(r.tradeAmount),
      year_volume: parseCneexNumber(r.yearVolume),
      year_turnover: parseCneexNumber(r.yearAmount),
      lifetime_volume: parseCneexNumber(r.totalVolume),
      lifetime_turnover: parseCneexNumber(r.totalAmount),
    };
    out.per_method.push(row);
    out[`${key}_volume`] = row.volume;
    out[`${key}_turnover`] = row.turnover;
  }
  // ③ 合计：方式齐全只是前提；**每个累计/总量字段**还必须三行都披露该字段才给合计。
  //    某方式把 tradeVolume 写成 null 时，其余方式之和不是「完整总量」，该字段保持 null；
  //    其余已完整披露的字段不受影响、照常单独保留（docs/35 17:00 追加的独立故障注入）。
  out.field_disclosure = {};
  out.fields_undisclosed = [];
  for (const [outField, rawField, label] of AGGREGATE_FIELDS) {
    const undisclosed = [...byMethod.entries()]
      .filter(([, r]) => parseCneexNumber(r[rawField]) === null)
      .map(([key, r]) => ({ method: key, trade_method: String(r.tradeMethod) }));
    const fieldComplete = complete && undisclosed.length === 0;
    out.field_disclosure[outField] = { complete: fieldComplete, undisclosed_methods: undisclosed };
    if (!fieldComplete) {
      out.fields_undisclosed.push({
        field: outField,
        label,
        methods: undisclosed.map((m) => m.method),
        reason: complete
          ? `方式 ${undisclosed.map((m) => m.method).join('、')} 未披露该字段：合计保持 null（不把缺项当 0）`
          : '方式不齐全（缺失/重复/未知行）：合计保持 null',
      });
      continue;
    }
    const sumValue = [...byMethod.values()]
      .map((r) => parseCneexNumber(r[rawField]))
      .reduce((a, b) => a + b, 0);
    // 金额保留分位精度（最小币单位 0.01）；数量为整数吨
    out[outField] = outField.endsWith('turnover') ? Math.round(sumValue * 100) / 100 : sumValue;
  }
  if (complete && out.fields_undisclosed.length) {
    out.caliber_note +=
      ` 本响应三方式齐全，但以下字段并非三方式全部披露，按字段单独保持 null：` +
      `${out.fields_undisclosed.map((f) => `${f.label}(${f.field})`).join('、')}；` +
      '其余已完整披露的字段照常给出合计。';
  }
  return out;
}

/** 会参与「合计」的累计/总量字段：输出字段 ↔ 上游原始字段 ↔ 中文字段名 */
const AGGREGATE_FIELDS = [
  ['total_volume', 'tradeVolume', '总成交量'],
  ['total_turnover', 'tradeAmount', '总成交额'],
  ['year_volume', 'yearVolume', '年累计成交量'],
  ['year_turnover', 'yearAmount', '年累计成交额'],
  ['lifetime_volume', 'totalVolume', '历史累计成交量'],
  ['lifetime_turnover', 'totalAmount', '历史累计成交额'],
];

/* ==================================================================== */
/*  tradeIntent.json —— 真实公开交易意向                                */
/* ==================================================================== */

/** "碳排放配额25" → 2025；"碳排放配额19-20" → [2019,2020]；无法判断 → null（不猜） */
export function quotaYearFromGoodsName(name) {
  const s = String(name || '');
  let m = s.match(/碳排放配额\s*(\d{4})\s*[-~至]\s*(\d{4})/);
  if (m) return { from: Number(m[1]), to: Number(m[2]), label: s, ambiguous: true };
  m = s.match(/碳排放配额\s*(\d{2})\s*[-~至]\s*(\d{2})/);
  if (m) return { from: 2000 + Number(m[1]), to: 2000 + Number(m[2]), label: s, ambiguous: true };
  m = s.match(/碳排放配额\s*(\d{4})/);
  if (m) return { year: Number(m[1]), label: s, ambiguous: false };
  m = s.match(/碳排放配额\s*(\d{2})(?!\d)/);
  if (m) return { year: 2000 + Number(m[1]), label: s, ambiguous: false };
  return { year: null, label: s, ambiguous: true };
}

/**
 * 解析公开交易意向列表。
 * 方向：官网源码 `dir == 1` 为买入，`dir == 2` 为卖出；其它取值不猜，记 unknown。
 *   （2026-10-14 独立复验真实 tradeIntent.json 全部 69 条的 dir 唯一取值为 1(47 条)/2(22 条)，
 *    结合官网显示源码 dir==1 买入、else 卖出；早期把 0 当卖出的假设已被真实样本否定。）
 * 价格与主体公开页未给出 → 一律 null（不用 0 或地区名顶替主体）。
 */
export function parseTradeIntents(payload, { sourceUrl = '' } = {}) {
  const json = typeof payload === 'string' ? safeJson(payload) : payload;
  if (!Array.isArray(json)) return { ok: false, reason: 'tradeIntent 响应不是数组', rows: [] };
  const rows = [];
  const unknownDir = [];
  for (const r of json) {
    const dirRaw = r?.dir;
    let direction;
    if (Number(dirRaw) === 1) direction = 'buy';
    else if (Number(dirRaw) === 2) direction = 'sell';
    else {
      direction = 'unknown';
      unknownDir.push({ id: r?.id, dir: dirRaw });
    }
    const qy = quotaYearFromGoodsName(r?.goodsName);
    const volume = parseCneexNumber(r?.volume);
    const published = parseCneexDate(r?.startTime);
    rows.push({
      intention_key: `cneeex-intent-${r?.id ?? `${published}-${dirRaw}-${volume}`}`,
      published_date: published,
      instrument_label: qy.label || null,
      quota_year: qy.ambiguous ? null : qy.year,
      quota_year_note: qy.ambiguous ? `品种标注为区间或无法唯一判断年度，quota_year 留空：${qy.label}` : null,
      direction,
      volume,
      price: null,          // 公开页未提供价格
      participant: null,    // 公开页未提供主体（areaName 是地区，不是主体）
      region: r?.areaName || null,
      source_url: sourceUrl,
      raw: { id: r?.id, dir: dirRaw, goodsName: r?.goodsName, volume: r?.volume, startTime: r?.startTime, areaName: r?.areaName },
    });
  }
  return {
    ok: true, rows,
    unknown_direction: unknownDir,
    note:
      '公开交易意向：不代表成交，不计入成交量/成交额。方向取自官网 dir（1=买入、2=卖出），' +
      '其它取值记为 unknown 不做猜测；价格与主体公开页未给出，保持 null；areaName 是地区，不作为主体。',
  };
}

/* ==================================================================== */
/*  holidays.json —— 官方休市日期证据                                   */
/* ==================================================================== */

export function parseHolidays(payload) {
  const json = typeof payload === 'string' ? safeJson(payload) : payload;
  if (!Array.isArray(json)) return { ok: false, reason: 'holidays 响应不是数组', dates: [] };
  const dates = [];
  const bad = [];
  for (const d of json) {
    const iso = parseCneexDate(d);
    if (iso) dates.push(iso);
    else bad.push(String(d));
  }
  return {
    ok: true, dates, invalid: bad,
    note: '官方查询页使用的非周末休市日期，作为 CEA 独立日历证据；不等同于全部交易日信息。',
  };
}

/* ==================================================================== */
/*  hiskline.json —— 用于发现真实交易日（数量不作为全方式成交量）        */
/* ==================================================================== */

/**
 * 元素顺序按 ECharts K 线约定：[date, open, close, low, high, volume]。
 * volume **不能**当作全国全方式成交量，只登记为参考并在界面注明。
 */
export function parseHisKline(payload, { limit = 0 } = {}) {
  const json = typeof payload === 'string' ? safeJson(payload) : payload;
  if (!Array.isArray(json)) return { ok: false, reason: 'hiskline 响应不是数组', points: [] };
  const points = [];
  for (const row of json) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const tradeDate = parseCneexDate(row[0]);
    if (!tradeDate) continue;
    points.push({
      trade_date: tradeDate,
      open: parseCneexNumber(row[1]),
      close: parseCneexNumber(row[2]),
      low: parseCneexNumber(row[3]),
      high: parseCneexNumber(row[4]),
      volume_reference: row[5] === undefined ? null : parseCneexNumber(row[5]),
    });
  }
  points.sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
  const sliced = limit > 0 ? points.slice(-limit) : points;
  return {
    ok: true,
    points: sliced,
    latest_date: points.length ? points[points.length - 1].trade_date : null,
    earliest_date: points.length ? points[0].trade_date : null,
    note:
      'hiskline 用于发现真实交易日与交叉核对 OHLC；其中数量为参考值，' +
      '不得当作全国全方式成交量（精确量额以 querySubStat 的 COMCEA 聚合为准）。',
  };
}

function safeJson(s) {
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}
