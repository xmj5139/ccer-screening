/**
 * CEA 官方行情原文解析与确定性核对（纯函数，不依赖数据库）
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md「数据模型和口径」「验收用例」：
 *   - CEA-02/CEA-03：真实日报样本的 OHLC、分方式量额、总计、年累计、历史累计；
 *   - CEA-04：正确区分万吨/亿元、数字千分位、无竞价与字段未披露；
 *             月报不能进入日行情；正文无目标内容则**失败**，不能生成零值；
 *   - CEA-05：全方式均价与综合收盘价不同不误报；缺日期不补 0、不自动前填；
 *   - CEA-06：同一 URL 同一哈希重采幂等，不根据模型覆盖官方数值。
 *
 * 设计纪律：
 *   1. 解析器只做「原文 → 结构化字段」，不做任何网络访问、不写库。
 *   2. 未在原文出现的字段一律 null（未披露），**绝不用 0 或上一日值填充**。
 *   3. 「官方明确说无」与「原文没有这一项」严格区分：
 *        明确无   → 0，并在 raw_fields 里保留「无」的原文；
 *        原文缺失 → null，并计入 missing_fields。
 *   4. 金额统一元、数量统一吨；原文单位与展示串保留在 units/raw_fields 内以便审计。
 */
import { round } from '../core/util.mjs';

/* ==================================================================== */
/*  一、文本与单位                                                       */
/* ==================================================================== */

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”',
  mdash: '—', ndash: '–', hellip: '…', times: '×', permil: '‰', deg: '°',
};

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

function safeCodePoint(n) {
  try {
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

/**
 * HTML → 保留行/单元格结构的纯文本。
 * 表格按行、按单元格切分（\t 分隔），便于「标签列 + 数值列」的取值。
 * script/style 内容整体丢弃：正文里的脚本不是数据，也不能当指令。
 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|table|section|article)>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \u00a0\u3000]+/g, ' ');
  s = s
    .split('\n')
    .map((line) => line.split('\t').map((c) => c.trim()).join('\t').replace(/^\t+|\t+$/g, ''))
    .join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 单位换算表：unit → { base: 'ton'|'cny'|'pct', exp10 } */
const UNITS = {
  吨: { base: 'ton', exp10: 0 },
  万吨: { base: 'ton', exp10: 4 },
  亿吨: { base: 'ton', exp10: 8 },
  元: { base: 'cny', exp10: 0 },
  万元: { base: 'cny', exp10: 4 },
  亿元: { base: 'cny', exp10: 8 },
  '元/吨': { base: 'cny_per_ton', exp10: 0 },
  '%': { base: 'pct', exp10: 0 },
  '％': { base: 'pct', exp10: 0 },
};

/**
 * 精确十进制移位（避免 5258.5579 × 10000 = 52585579.00000001 这类浮点噪声）。
 * @param {string} numText 形如 "-1,234.5678"
 * @param {number} exp10 正数左移（乘 10^exp10），负数右移
 * @returns {number|null}
 */
export function decimalShift(numText, exp10 = 0) {
  let s = String(numText ?? '').trim().replace(/,/g, '').replace(/[，]/g, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  let sign = 1;
  if (s[0] === '+' || s[0] === '-') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  if (s.startsWith('.')) s = `0${s}`;
  let [intPart, fracPart = ''] = s.split('.');
  let digits = `${intPart}${fracPart}`;
  let fracLen = fracPart.length - Number(exp10 || 0);
  let outStr;
  if (fracLen <= 0) {
    outStr = digits + '0'.repeat(-fracLen);
  } else if (fracLen >= digits.length) {
    outStr = `0.${'0'.repeat(fracLen - digits.length)}${digits}`;
  } else {
    outStr = `${digits.slice(0, digits.length - fracLen)}.${digits.slice(digits.length - fracLen)}`;
  }
  const n = Number(outStr);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

/** 数值 token：千分位、可选单位 */
const VALUE_RE = /([+-]?\d[\d,\uFF0C]*(?:\.\d+)?)\s*(亿吨|万吨|万元|亿元|元\/吨|吨|元|%|％)?/;

/**
 * 解析一个「数值 + 单位」token。
 * @param {string} raw
 * @param {{base?:'ton'|'cny'|'pct'|'cny_per_ton', allowNegative?:boolean, defaultExp10?:number}} [opts]
 * @returns {{ok:boolean, value:number|null, raw:string, unit:string|null, base:string|null, exp10:number, reason?:string}}
 */
export function parseAmountToken(raw, opts = {}) {
  const text = String(raw ?? '').trim();
  const m = text.match(VALUE_RE);
  if (!m) return { ok: false, value: null, raw: text, unit: null, base: null, exp10: 0, reason: '未找到数值' };
  const numText = m[1];
  const unit = m[2] || null;
  const info = unit ? UNITS[unit] : null;
  if (unit && !info) return { ok: false, value: null, raw: text, unit, base: null, exp10: 0, reason: `未知单位：${unit}` };
  const base = info ? info.base : null;
  const exp10 = info ? info.exp10 : Number(opts.defaultExp10 || 0);
  const want = opts.base || null;
  if (want && base && want !== base) {
    return { ok: false, value: null, raw: text, unit, base, exp10, reason: `单位与字段语义不符（期望 ${want}，实际 ${base}）` };
  }
  const value = decimalShift(numText, exp10);
  if (value === null) return { ok: false, value: null, raw: text, unit, base, exp10, reason: '数值无法解析' };
  if (!opts.allowNegative && value < 0) {
    return { ok: false, value: null, raw: text, unit, base, exp10, reason: '数值为负，与量/额/价语义不符' };
  }
  return { ok: true, value, raw: text, display: m[0], unit, base: base || want || null, exp10 };
}

/* ==================================================================== */
/*  二·B、官方日报模板句式（优先于通用标签）                             */
/* ==================================================================== */

const NUM = '([0-9][0-9,]*(?:\\.[0-9]+)?)';
const TON = '(亿吨|万吨|吨)';
const CNY = '(亿元|万元|元)';

/**
 * 页面归属判定：必须是 CEA（全国碳排放权交易市场）页面。
 * CCER（全国温室气体自愿减排交易市场）的日报结构相似但品种与累计口径完全不同，
 * **绝不能**被 CEA 解析器接收（ADR-002：两套累计值不能共用）。
 */
const CEA_PAGE_RE = /碳排放权交易市场|碳排放配额|全国碳市场|【CEA】/;
const CCER_PAGE_RE = /温室气体自愿减排/;

/** 累计类句式的归属守卫：句子必须明确属于 CEA，而不是 CCER。 */
const CEA_CLAUSE_GUARD = /碳排放权|碳排放配额|全国碳市场/;

/**
 * 官方日报真实句式（依据 2026-10-14 实际抓取的原文）：
 *
 *   今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，
 *     最低价95.90元/吨，收盘价96.61元/吨，收盘价较前一日上涨1.00%。
 *   今日挂牌协议交易成交量544,313吨，成交额52,585,579.00元；
 *     大宗协议交易成交量500,000吨，成交额47,575,000.00元；今日无单向竞价。
 *   今日全国碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。
 *   2026年1月1日至7月30日，全国碳市场碳排放配额成交量68,966,986吨，成交额5,499,968,391.61元。
 *   截至2026年7月30日，全国碳市场碳排放配额累计成交量933,833,506吨，累计成交额63,162,586,623.18元。
 *
 * 这些句式比通用标签更可靠：先用模板匹配，未命中的字段再回退到通用标签，
 * 以便兼容表格排版、历史版本与其他展示形态（万吨/亿元等）。
 */
export const OFFICIAL_DAILY_PATTERNS = [
  { key: 'open', base: 'cny_per_ton', re: new RegExp(`开盘价\\s*${NUM}\\s*元\\/吨`) },
  { key: 'high', base: 'cny_per_ton', re: new RegExp(`最高价\\s*${NUM}\\s*元\\/吨`) },
  { key: 'low', base: 'cny_per_ton', re: new RegExp(`最低价\\s*${NUM}\\s*元\\/吨`) },
  { key: 'close', base: 'cny_per_ton', re: new RegExp(`收盘价\\s*${NUM}\\s*元\\/吨`) },
  {
    key: 'change_pct',
    base: 'pct',
    allowNegative: true,
    // 收盘价较前一日上涨1.00% / 下跌0.20% / 持平
    re: /收盘价较前一日\s*(上涨|下跌|下跌|持平|涨|跌)\s*([0-9]+(?:\.[0-9]+)?)?\s*%?/,
    map: (m) => {
      const dir = m[1];
      const n = m[2] === undefined || m[2] === '' ? 0 : Number(String(m[2]).replace(/,/g, ''));
      if (!Number.isFinite(n)) return null;
      if (/跌/.test(dir)) return -n;
      return n; // 上涨 / 持平（持平无数字时按 0）
    },
  },
  { key: 'listed_volume', base: 'ton', re: new RegExp(`挂牌协议交易成交量\\s*${NUM}\\s*${TON}`) },
  { key: 'listed_turnover', base: 'cny', re: new RegExp(`挂牌协议交易成交量[^；。]{0,60}?成交额\\s*${NUM}\\s*${CNY}`) },
  { key: 'block_volume', base: 'ton', re: new RegExp(`大宗协议交易成交量\\s*${NUM}\\s*${TON}`) },
  { key: 'block_turnover', base: 'cny', re: new RegExp(`大宗协议交易成交量[^；。]{0,60}?成交额\\s*${NUM}\\s*${CNY}`) },
  { key: 'total_volume', base: 'ton', re: new RegExp(`总成交量\\s*${NUM}\\s*${TON}`) },
  { key: 'total_turnover', base: 'cny', re: new RegExp(`总成交额\\s*${NUM}\\s*${CNY}`) },
  // 年度累计：由「Y年M月D日至M月D日」引出，不能跨句匹配，避免吃到总成交量
  { key: 'year_volume', base: 'ton', guard: CEA_CLAUSE_GUARD, re: new RegExp(`20\\d{2}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日至[^。]{0,120}?成交量\\s*${NUM}\\s*${TON}`) },
  { key: 'year_turnover', base: 'cny', guard: CEA_CLAUSE_GUARD, re: new RegExp(`20\\d{2}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日至[^。]{0,160}?成交额\\s*${NUM}\\s*${CNY}`) },
  // 历史累计：由「截至…」引出，同样要求句子属于 CEA
  { key: 'lifetime_volume', base: 'ton', guard: CEA_CLAUSE_GUARD, re: new RegExp(`截至[^。]{0,60}?累计成交量\\s*${NUM}\\s*${TON}`) },
  { key: 'lifetime_turnover', base: 'cny', guard: CEA_CLAUSE_GUARD, re: new RegExp(`截至[^。]{0,80}?累计成交额\\s*${NUM}\\s*${CNY}`) },
];

/** 「官方明确表示无单向竞价」的句式 → auction 两个字段均为 0（有依据，不是推测） */
const NO_AUCTION_RE = /(今日)?\s*无\s*单向竞价/;

/** 通用标签回退：值 + 单位 */
const LABEL_NUM = '([0-9][0-9,]*(?:\\.[0-9]+)?)';
const LABEL_TON = '(亿吨|万吨|吨)';
const LABEL_CNY = '(亿元|万元|元)';

/**
 * 表格/其他排版的通用标签匹配（含万吨、亿元等单位的正确换算）。
 * 只在官方模板句式未命中该字段时使用。
 */
function matchLabeledAmount(text, { labels, base }) {
  for (const label of labels) {
    const unitAlt = base === 'ton' ? LABEL_TON : base === 'cny' ? LABEL_CNY : null;
    const unitPart = unitAlt ? `\\s*${unitAlt}` : '';
    const re = new RegExp(`${escapeRe(label)}\\s*[:：]?\\s*${LABEL_NUM}${unitPart}`);
    const m = text.match(re);
    if (!m) continue;
    const parsed = parseAmountToken(`${m[1]}${m[2] || ''}`, { base });
    if (parsed.ok) return { value: parsed.value, raw: m[0].trim(), unit: parsed.unit };
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 模板化句式匹配（返回已解析的字段值） */
export function matchOfficialTemplate(text) {
  const src = String(text || '');
  const fields = {};
  const raw = {};
  const units = {};
  for (const p of OFFICIAL_DAILY_PATTERNS) {
    const m = src.match(p.re);
    if (!m) continue;
    // 归属守卫：累计类句式必须明确属于 CEA，避免误吃 CCER 的累计值
    if (p.guard && !p.guard.test(m[0])) continue;
    if (p.map) {
      const v = p.map(m);
      if (v === null || !Number.isFinite(v)) continue;
      fields[p.key] = v;
      raw[p.key] = m[0].trim();
      units[p.key] = p.base === 'pct' ? '%' : null;
      continue;
    }
    const parsed = parseAmountToken(`${m[1]}${m[2] || ''}`, { base: p.base, allowNegative: !!p.allowNegative });
    if (!parsed.ok) continue;
    fields[p.key] = parsed.value;
    raw[p.key] = m[0].trim();
    units[p.key] = parsed.unit;
  }
  return { fields, raw, units };
}

/* ==================================================================== */
/*  二·C、字段字典（标签别名，作为模板句式未命中时的回退）                */
/* ==================================================================== */

/**
 * 行情字段定义。
 * `labels` 按特异性从长到短排列：先匹配「历史累计成交量」再匹配「成交量」，
 * 避免把历史累计值错配到当日字段。标签取自官方日报的真实用词
 * （如「挂牌协议交易成交量」「累计成交量」），并保留简称以兼容其他排版。
 */
export const DAILY_FIELDS = [
  // 价格（元/吨）
  { key: 'open', kind: 'price', base: 'cny_per_ton', labels: ['今日开盘价', '开盘价', '今开盘', '开盘'] },
  { key: 'high', kind: 'price', base: 'cny_per_ton', labels: ['今日最高价', '最高价', '最高'] },
  { key: 'low', kind: 'price', base: 'cny_per_ton', labels: ['今日最低价', '最低价', '最低'] },
  { key: 'close', kind: 'price', base: 'cny_per_ton', labels: ['综合收盘价', '今日收盘价', '收盘价', '收盘'] },
  { key: 'change_pct', kind: 'pct', base: 'pct', allowNegative: true, labels: ['涨跌幅', '涨跌幅度', '涨跌', '涨跌百分比'] },
  { key: 'prev_close', kind: 'price', base: 'cny_per_ton', labels: ['昨日收盘价', '昨收盘价', '昨收价', '昨收', '前收盘价'] },

  // 累计（必须先于当日分项与总计匹配，标签最长）
  { key: 'lifetime_volume', kind: 'volume', base: 'ton', labels: ['历史累计成交量', '历史累积成交量', '累计成交量', '累计成交数量'] },
  { key: 'lifetime_turnover', kind: 'money', base: 'cny', labels: ['历史累计成交额', '历史累积成交额', '累计成交额', '累计成交金额'] },
  { key: 'year_volume', kind: 'volume', base: 'ton', labels: ['年度累计成交量', '本年累计成交量', '当年累计成交量', '年累计成交量', '年成交量', '年度成交量', '本年成交量'] },
  { key: 'year_turnover', kind: 'money', base: 'cny', labels: ['年度累计成交额', '本年累计成交额', '当年累计成交额', '年累计成交额', '年成交额', '年度成交额', '本年成交额'] },

  // 交易方式分项
  { key: 'listed_volume', kind: 'volume', base: 'ton', labels: ['挂牌协议交易成交量', '挂牌协议成交量', '挂牌协议成交数量', '挂牌成交量', '挂牌协议量'] },
  { key: 'listed_turnover', kind: 'money', base: 'cny', labels: ['挂牌协议成交额', '挂牌协议成交金额', '挂牌成交额'] },
  { key: 'block_volume', kind: 'volume', base: 'ton', labels: ['大宗协议交易成交量', '大宗协议成交量', '大宗协议成交数量', '大宗成交量', '大宗协议量'] },
  { key: 'block_turnover', kind: 'money', base: 'cny', labels: ['大宗协议成交额', '大宗协议成交金额', '大宗成交额'] },
  { key: 'auction_volume', kind: 'volume', base: 'ton', labels: ['单向竞价成交量', '单向竞价成交数量', '竞价成交量', '单向竞价量'] },
  { key: 'auction_turnover', kind: 'money', base: 'cny', labels: ['单向竞价成交额', '单向竞价成交金额', '竞价成交额'] },

  // 合计（标签最短，放在最后）
  { key: 'total_volume', kind: 'volume', base: 'ton', labels: ['总成交量', '成交总量', '合计成交量', '总计成交量', '成交量合计'] },
  { key: 'total_turnover', kind: 'money', base: 'cny', labels: ['总成交额', '成交总额', '合计成交额', '总计成交额', '成交金额合计'] },
];

/** 「官方明确表示无」的写法 */
const NONE_RE = /^(无|没有|暂无|未发生|无成交|—|–|-{1,2}|\/|0(?:\.0+)?)$/;

/** 月报特征：出现即拒绝写入日行情 */
const MONTHLY_RE = /(月报|月度报告|月度数据|本月累计|月度概况|月成交量|月成交额)/;

/**
 * 从原文与 URL 中确定行情日期。
 *
 * 优先级（依据 2026-10-14 真实抓取的官方日报原文）：
 *   1. 标题/导语中的紧凑日期 `...行情及成交信息YYYYMMDD`（官方日报标题格式）；
 *   2. URL 中的 `/YYYY-MM-DD/`（官方永久链接，本身即交易日）；
 *   3. `截至YYYY年M月D日` 的截止日（原文数据截止日）；
 *   4. 调用方提示。
 * **不使用「今天」兜底**——日期无法确定时必须失败（CEA-05）。
 *
 * 注意：官方正文里的 `2026年1月1日至8月11日` 是年度累计区间的起点，
 * 不能当作交易日；旧实现的首个中文日期匹配正是踩了这个坑。
 */
export function extractTradeDate(text, url = '', hint = null) {
  const body = String(text || '');
  const candidates = [];

  // 1. 标题紧凑日期：…行情及成交信息20260811（可出现在 <title> 或正文首行）
  let m = body.match(/成交信息\s*(20\d{2})(\d{2})(\d{2})/);
  if (m) candidates.push({ date: ymd(m[1], m[2], m[3]), source: 'title' });

  // 2. URL 永久链接日期
  m = String(url || '').match(/\/(20\d{2})-(\d{2})-(\d{2})\//) || String(url || '').match(/[/-](20\d{2})(\d{2})(\d{2})[/.-]/);
  if (m) candidates.push({ date: ymd(m[1], m[2], m[3]), source: 'url' });

  // 3. 数据截止日：截至2026年8月11日
  m = body.match(/截至\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) candidates.push({ date: ymd(m[1], m[2], m[3]), source: 'body_asof', kind: 'as_of' });

  // 4. 兜底：正文中孤立出现的中文日期（排除「Y年1月1日至」这类区间起点）
  const reAll = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  let g;
  while ((g = reAll.exec(body))) {
    const after = body.slice(g.index + g[0].length, g.index + g[0].length + 3);
    if (/^\s*至/.test(after) && Number(g[2]) === 1 && Number(g[3]) === 1) continue; // 年度区间起点
    candidates.push({ date: ymd(g[1], g[2], g[3]), source: 'body', kind: 'fallback' });
    break;
  }

  const valid = candidates.filter((c) => c.date);
  if (!valid.length) {
    if (hint) return { date: hint, source: 'hint', candidates: [], consistent: null };
    return { date: null, source: 'none', candidates: [], consistent: null };
  }
  const picked = valid[0];
  const distinct = [...new Set(valid.map((c) => c.date))];
  const asOf = valid.find((c) => c.kind === 'as_of')?.date || null;
  return {
    date: picked.date,
    source: picked.source,
    as_of: asOf,
    candidates: valid.map((c) => ({ date: c.date, source: c.source })),
    // 各来源日期不一致时如实暴露，由核对环节标注（不静默取一个）
    consistent: distinct.length === 1,
  };
}

function ymd(y, mo, d) {
  const mm = String(mo).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const s = `${y}-${mm}-${dd}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* ==================================================================== */
/*  三、日报解析                                                        */
/* ==================================================================== */

/** 把文本切成「行 → 单元格」 */
function toRows(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.split('\t').map((c) => c.trim()).filter((c) => c !== ''))
    .filter((cells) => cells.length > 0);
}

/**
 * 在单元格序列中查找某字段的值。
 * 支持两种排版：
 *   A. 标签与数值在同一单元格：`挂牌协议成交量：544,313吨`
 *   B. 标签单元格 + 后续数值单元格（表格）：`挂牌协议成交量 | 544,313 | 吨`
 * 只在标签**之后**的少量单元格内取值，避免串行错配。
 */
function findFieldValue(rows, field) {
  let firstRejection = null;
  for (const cells of rows) {
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      const label = matchLabel(cell, field);
      if (!label) continue;
      // A. 同单元格：标签之后的部分
      const rest = cell.slice(label.at + label.text.length).replace(/^[\s:：=＝]+/, '');
      const candidates = [rest, ...cells.slice(i + 1, i + 3)];
      for (let ci = 0; ci < candidates.length; ci += 1) {
        const probe = String(candidates[ci] || '').trim();
        if (!probe) continue;
        const layout = ci === 0 ? 'inline' : 'adjacent';
        if (NONE_RE.test(probe)) {
          return { present: true, explicitNone: true, raw: probe, label: label.text, layout };
        }
        const parsed = parseAmountToken(probe, { base: field.base, allowNegative: !!field.allowNegative });
        if (parsed.ok) {
          return { present: true, explicitNone: false, parsed, raw: parsed.raw, unit: parsed.unit, label: label.text, layout };
        }
        // 值存在但被拒绝（单位与字段语义不符 / 为负）：留下证据，供 CEA-04 报告，不静默当成「未披露」
        if (!firstRejection && parsed.reason && parsed.reason !== '未找到数值') {
          firstRejection = { reason: parsed.reason, raw: probe, label: label.text };
        }
        // 相邻单元格只用于「数值」或「纯单位」；若既非数值也非单位，说明标签后面不是它的值
        if (ci > 0 && !/^(亿吨|万吨|万元|亿元|元\/吨|吨|元|%|％)$/.test(probe)) break;
      }
    }
  }
  return { present: false, explicitNone: false, raw: null, rejection: firstRejection };
}

function matchLabel(cell, field) {
  const text = String(cell || '');
  for (const label of field.labels) {
    const at = text.indexOf(label);
    if (at >= 0) return { text: label, at };
  }
  return null;
}

/**
 * 解析 CEA 官方日报正文。
 *
 * @param {string} raw 原始响应（HTML 或纯文本）
 * @param {{url?:string, tradeDateHint?:string, instrument?:string, marketScope?:string, priceRegime?:string}} [opts]
 * @returns {{
 *   ok:boolean, parse_status:'ok'|'partial'|'failed', parse_note:string,
 *   period:'day'|'month', trade_date:string|null, date_source:string,
 *   fields:object, raw_fields:object, units:object, missing_fields:string[],
 *   explicit_none:string[], unexpected_units:string[], stats:object
 * }}
 */
export function parseCeaDailyReport(raw, opts = {}) {
  const text = looksLikeHtml(raw) ? htmlToText(raw) : String(raw || '');
  const url = String(opts.url || '');
  const rows = toRows(text);
  const period = MONTHLY_RE.test(text.slice(0, 4000)) ? 'month' : 'day';

  const dateInfo = extractTradeDate(text, url, opts.tradeDateHint);
  const tradeDate = dateInfo.date;
  const dateSource = dateInfo.source;

  const fields = {};
  const rawFields = {};
  const units = {};
  const missing = [];
  const explicitNone = [];
  const badUnits = [];
  const invalid = [];

  // ① 先用官方日报模板句式（对真实原文最可靠）
  const tpl = matchOfficialTemplate(text);
  for (const [k, v] of Object.entries(tpl.fields)) {
    fields[k] = v;
    rawFields[k] = tpl.raw[k];
    units[k] = tpl.units[k];
  }
  // ② 官方明确「无单向竞价」→ auction 两个字段均为 0（有依据），并在 raw 中保留原文
  const noAuction = text.match(NO_AUCTION_RE);
  if (noAuction) {
    for (const k of ['auction_volume', 'auction_turnover']) {
      if (!(k in fields)) {
        fields[k] = 0;
        rawFields[k] = noAuction[0];
        units[k] = null;
        explicitNone.push(k);
      }
    }
  }
  // ③ 模板未命中的字段回退到通用标签匹配（兼容表格排版与万吨/亿元等写法）
  for (const f of DAILY_FIELDS) {
    if (f.key in fields) continue;
    const hit = findFieldValue(rows, f);
    if (hit.present && !hit.explicitNone) {
      fields[f.key] = hit.parsed.value;
      rawFields[f.key] = hit.raw;
      units[f.key] = hit.parsed.unit || '（原文未标单位）';
      if (hit.parsed.base && hit.parsed.base !== f.base) badUnits.push(f.key);
      continue;
    }
    if (hit.present && hit.explicitNone) {
      fields[f.key] = 0;
      rawFields[f.key] = hit.raw;
      units[f.key] = null;
      explicitNone.push(f.key);
      continue;
    }
    if (hit.rejection) invalid.push({ field: f.key, ...hit.rejection });
  }
  // ④ 全量字段清点：未在原文出现的字段留 null（未披露），绝不用 0 填充
  for (const f of DAILY_FIELDS) {
    if (!(f.key in fields)) {
      fields[f.key] = null;
      missing.push(f.key);
    }
  }

  // 判定解析质量
  const ohlcPresent = ['open', 'high', 'low', 'close'].filter((k) => Number.isFinite(fields[k]));
  const tradeCore = [fields.total_volume, fields.total_turnover, fields.listed_volume, fields.listed_turnover];
  const tradeCorePresent = tradeCore.filter((v) => Number.isFinite(v));
  let parseStatus = 'ok';
  let parseNote = '';

  // 页面归属：CCER 页面绝不能被当作 CEA 行情解析（ADR-002 两套累计值不能共用）
  const isCeaPage = CEA_PAGE_RE.test(text);
  const isCcerOnly = CCER_PAGE_RE.test(text) && !/碳排放权交易市场|碳排放配额/.test(text);
  if (!isCeaPage || isCcerOnly) {
    parseNote =
      '正文未出现 CEA（全国碳排放权交易市场 / 全国碳排放权交易市场配额）标识：' +
      (isCcerOnly ? '该页面是 CCER（全国温室气体自愿减排）内容，' : '无法确认为 CEA 行情页面，') +
      '按规范拒绝解析为 CEA 行情，也不生成零值行。';
    // 归属判定失败时必须清空已匹配到的字段：调用方绝不能拿到来自 CCER 页面的数值
    const cleared = {};
    for (const k of Object.keys(fields)) cleared[k] = null;
    return {
      ok: false, parse_status: 'failed', parse_note: parseNote, period, trade_date: tradeDate,
      date_source: dateSource, date_candidates: dateInfo.candidates || [], date_consistent: dateInfo.consistent,
      data_as_of: dateInfo.as_of || tradeDate,
      fields: cleared, raw_fields: {}, units: {}, missing_fields: Object.keys(cleared),
      explicit_none: [], unexpected_units: [], invalid_fields: [],
      rejection_reason: isCcerOnly ? 'ccer_page' : 'not_cea_page',
      text, stats: { rows: rows.length, ohlc_present: 0, trade_core_present: 0, text_chars: text.length },
    };
  }

  if (!rows.length || (ohlcPresent.length === 0 && tradeCorePresent.length === 0)) {
    parseStatus = 'failed';
    parseNote =
      '正文中未找到任何可识别的 CEA 行情字段（开盘/最高/最低/收盘、成交量大类）。' +
      '按规范禁止生成零值行，本页记为解析失败并留缺口。';
    return {
      ok: false, parse_status: parseStatus, parse_note: parseNote, period, trade_date: tradeDate,
      date_source: dateSource, date_candidates: dateInfo.candidates || [], date_consistent: dateInfo.consistent,
      data_as_of: dateInfo.as_of || tradeDate, fields, raw_fields: rawFields, units, missing_fields: missing,
      explicit_none: explicitNone, unexpected_units: badUnits, invalid_fields: invalid,
      text, stats: { rows: rows.length, ohlc_present: 0, trade_core_present: 0, text_chars: text.length },
    };
  }
  if (ohlcPresent.length < 4 || tradeCorePresent.length < 4) {
    parseStatus = 'partial';
    parseNote =
      `部分字段未在原文披露：价格 ${ohlcPresent.length}/4，成交核心 ${tradeCorePresent.length}/4。` +
      '未披露字段一律留空（null），不用 0 或前值填充。';
  }
  if (badUnits.length) {
    parseNote = `${parseNote ? parseNote + ' ' : ''}以下字段在原文中的单位与字段语义不符，已拒绝取值并留空：${badUnits.join('、')}。`;
  }
  if (invalid.length) {
    parseNote = `${parseNote ? parseNote + ' ' : ''}以下字段的候选值被拒绝（未采纳，避免单位/符号错配）：${invalid
      .map((i) => `${i.field}（${i.reason}，原文「${i.raw}」）`)
      .join('；')}。`;
  }
  if (period === 'month') {
    parseNote = `${parseNote ? parseNote + ' ' : ''}识别为月报/月度数据：只登记 period=month，禁止写入日行情表。`;
  }
  if (dateInfo.consistent === false) {
    parseNote = `${parseNote ? parseNote + ' ' : ''}原文出现的日期不一致：${(dateInfo.candidates || [])
      .map((c) => `${c.date}(${c.source})`)
      .join('、')}；已按优先级采用 ${tradeDate}（${dateSource}），差异留痕供核对。`;
  }
  if (!tradeDate) {
    parseStatus = 'partial';
    parseNote = `${parseNote ? parseNote + ' ' : ''}未能确定交易日：不补 0、不用采集日兜底，该条不入库。`;
  }

  return {
    ok: parseStatus !== 'failed',
    parse_status: parseStatus,
    parse_note: parseNote.trim(),
    period,
    trade_date: tradeDate,
    date_source: dateSource,
    date_candidates: dateInfo.candidates || [],
    date_consistent: dateInfo.consistent,
    data_as_of: dateInfo.as_of || tradeDate,
    fields,
    raw_fields: rawFields,
    units,
    missing_fields: missing,
    explicit_none: explicitNone,
    unexpected_units: badUnits,
    invalid_fields: invalid,
    text,
    stats: {
      rows: rows.length,
      ohlc_present: ohlcPresent.length,
      trade_core_present: tradeCorePresent.length,
      text_chars: text.length,
    },
  };
}

/**
 * 在解析行情前判断页面是否明确为非目标页（企业基本信息、招聘、导航等）。
 *
 * 关键纪律：
 *   - 只看标题/主内容，不因页脚或导航里出现“基本信息”误伤真正日报；
 *   - 真正日报只要标题/主内容出现日报语义和行情字段，就不判非目标；
 *   - 未知、空正文、访问失败都不判非目标，由调用方保留缺口。
 *
 * @returns {{non_target:boolean, rule:string|null, title:string, evidence:string,
 *            main_excerpt:string, reason:string}}
 */
export function detectCeaNonTargetPage(raw, { url = '' } = {}) {
  const source = String(raw || '');
  const title = (() => {
    if (!looksLikeHtml(source)) return '';
    const t = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
      || '';
    return htmlToText(t).replace(/\s+/g, ' ').trim();
  })();
  let mainHtml = '';
  if (looksLikeHtml(source)) {
    const article = source.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
    if (article) mainHtml = article[2];
    else {
      mainHtml = source
        .replace(/<(script|style|noscript|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    }
  } else {
    mainHtml = source;
  }
  const main = htmlToText(mainHtml).replace(/\s+/g, ' ').trim();
  const top = main.slice(0, 1200);
  const heading = htmlToText(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const titleLike = [title, heading].filter(Boolean).join(' ｜ ').trim();
  const excerpt = main.slice(0, 240);
  const compactMain = main.replace(/\s+/g, '');
  const accessError = /访问过于频繁|Access\s*Denied|拒绝访问|请稍后重试|验证码|人机验证|403\s*Forbidden|404\s*Not\s*Found|页面不存在|服务异常|系统繁忙/i.test(top);

  // 访问失败/限流页即使保留了原“基本信息”标题，也不是确定性排除证据；
  // 只有标题而没有可用主内容同样不能结清历史缺口。
  if (accessError || compactMain.length === 0) {
    return {
      non_target: false, rule: null, title: titleLike || null,
      evidence: accessError ? '主内容是访问失败/限流提示，不能据标题判定非目标页' : '只有标题、主内容为空，不能判定非目标页',
      main_excerpt: excerpt, reason: accessError ? 'access_error_page' : 'empty_main_content',
    };
  }

  const reportSignal = /每日行情|行情日报|日行情|每日成交|交易行情|成交情况|碳排放权交易市场|全国碳排放权交易市场配额|CEA25|开盘价|收盘价|最高价|最低价|成交量|成交额|挂牌协议|大宗协议|单向竞价/.test(`${titleLike} ${top}`);
  const tradeFieldSignal = /(开盘价|收盘价|最高价|最低价|成交量|成交额|挂牌协议|大宗协议|单向竞价)/.test(`${titleLike} ${top}`)
    && /\d/.test(top);
  if (reportSignal && tradeFieldSignal) {
    return {
      non_target: false, rule: null, title: titleLike || null,
      evidence: '标题/主内容出现日报语义与行情字段，不因导航或页脚中的一般词误判',
      main_excerpt: excerpt, reason: 'target_daily_report',
    };
  }

  const titleRules = [
    ['entity_basic_info', /企业(?:单位)?基本信息|单位基本信息|企业信息查询|重点排放单位基本信息|基本信息/],
    ['recruitment', /招聘|招贤纳士|人才招聘|校园招聘|社会招聘/],
    ['navigation', /网站地图|网站导航|联系我们|联系方式|关于我们|^首页$|^导航$/],
  ];
  for (const [rule, re] of titleRules) {
    if (re.test(titleLike)) {
      const hit = titleLike.match(re)?.[0] || rule;
      return {
        non_target: true, rule: `title_${rule}`, title: titleLike,
        evidence: `标题明确为「${hit}」，且未见 CEA 行情字段`, main_excerpt: excerpt,
        reason: '标题表明是企业基本信息/招聘/导航等非目标页',
      };
    }
  }

  const mainRe = /企业基本信息|单位基本信息|人才招聘|招聘信息|网站地图|网站导航|联系我们/;
  if (mainRe.test(top) && !reportSignal) {
    const hit = top.match(mainRe)?.[0] || '';
    return {
      non_target: true, rule: 'main_non_target_content', title: titleLike || null,
      evidence: `主内容出现「${hit}」，且无 CEA 日报/行情字段`, main_excerpt: excerpt,
      reason: '主内容明确属于企业基本信息/招聘/导航等非目标页',
    };
  }

  return {
    non_target: false, rule: null, title: titleLike || null,
    evidence: '未发现明确的非目标页标题/主内容规则', main_excerpt: excerpt,
    reason: 'unknown_target',
  };
}

function looksLikeHtml(s) {
  return /<\s*(html|body|div|table|tr|td|p|span|br)\b/i.test(String(s || ''));
}

/* ==================================================================== */
/*  四、派生值与确定性核对                                               */
/* ==================================================================== */

/** 金额最小币单位（元）与数量最小单位（吨）的舍入容差 */
export const MONEY_EPS = 0.01;
export const VOLUME_EPS = 1e-6;

/**
 * 计算程序派生值。综合收盘价与全方式量加权均价是**两个不同口径**：
 *   - close：官方综合行情收盘价（2026 版为 CEA25 权重指数）
 *   - computed_avg_price：total_turnover / total_volume
 * 二者不同不得判为冲突（CEA-05）。
 */
export function deriveDaily(fields) {
  const tv = num(fields.total_volume);
  const tt = num(fields.total_turnover);
  const computedAvg = Number.isFinite(tv) && tv > 0 && Number.isFinite(tt) ? round(tt / tv, 6) : null;

  const parts = [
    ['listed', num(fields.listed_volume), num(fields.listed_turnover)],
    ['block', num(fields.block_volume), num(fields.block_turnover)],
    ['auction', num(fields.auction_volume), num(fields.auction_turnover)],
  ];
  const volParts = parts.filter(([, v]) => Number.isFinite(v));
  const cnyParts = parts.filter(([, , t]) => Number.isFinite(t));
  const sumVolume = volParts.length ? volParts.reduce((s, [, v]) => s + v, 0) : null;
  const sumTurnover = cnyParts.length ? cnyParts.reduce((s, [, , t]) => s + t, 0) : null;

  const sessionState = !Number.isFinite(tv) ? 'missing' : tv === 0 && (!Number.isFinite(tt) || tt === 0) ? 'no_trade' : 'traded';

  return {
    computed_avg_price: computedAvg,
    sum_volume: sumVolume === null ? null : round(sumVolume, 6),
    sum_turnover: sumTurnover === null ? null : round(sumTurnover, 6),
    session_state: sessionState,
    part_counts: { volume: volParts.length, turnover: cnyParts.length },
  };
}

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

/**
 * 确定性核对（先于任何模型核验；模型不能覆盖官方数值）。
 * @returns {{ok:boolean, status:'pass'|'warn'|'fail', checks:Array}}
 */
export function runDailyChecks(row, opts = {}) {
  const checks = [];
  const push = (check_key, label, ok, severity, detail = '', expected = null, actual = null) =>
    checks.push({ check_key, label, ok: !!ok, severity, detail, expected, actual: actual === null ? null : String(actual) });

  const nonNegative = [
    'open', 'high', 'low', 'close', 'prev_close',
    'listed_volume', 'listed_turnover', 'block_volume', 'block_turnover',
    'auction_volume', 'auction_turnover', 'total_volume', 'total_turnover',
    'year_volume', 'year_turnover', 'lifetime_volume', 'lifetime_turnover',
  ];
  const negatives = nonNegative.filter((k) => Number.isFinite(row[k]) && row[k] < 0);
  push('non_negative', '量价金额非负', negatives.length === 0, 'fail',
    negatives.length ? `以下字段为负：${negatives.join('、')}` : '量、额、价字段均非负或未披露',
    '所有量价金额 ≥ 0', negatives.join(','));

  // OHLC 上下界自洽
  const { open, high, low, close } = row;
  const haveAll = [open, high, low, close].every((v) => Number.isFinite(v));
  if (haveAll) {
    const bodyMax = Math.max(open, close);
    const bodyMin = Math.min(open, close);
    const ok1 = low <= bodyMin + 1e-9;
    const ok2 = high >= bodyMax - 1e-9;
    const ok3 = low <= high + 1e-9;
    const ok = ok1 && ok2 && ok3;
    push('ohlc_bounds', 'OHLC 上下界自洽', ok, 'fail',
      ok ? `最低 ${low} ≤ 开/收 ${bodyMin}/${bodyMax} ≤ 最高 ${high}` :
        `上下界不自洽：开${open} 高${high} 低${low} 收${close}`,
      `low ≤ min(open,close) 且 high ≥ max(open,close)`, `open=${open},high=${high},low=${low},close=${close}`);
  } else {
    push('ohlc_bounds', 'OHLC 上下界自洽', true, 'info', '价格字段未完整披露，跳过上下界检查（不推断缺失值）');
  }

  // 分项合计 = 官方总量/总额（仅在有完整分项时校验；考虑最小币单位舍入）
  const dv = deriveDaily(row);
  if (Number.isFinite(row.total_volume) && dv.part_counts.volume >= 2 && Number.isFinite(dv.sum_volume)) {
    const tol = VOLUME_EPS * dv.part_counts.volume + Math.abs(row.total_volume) * 1e-9;
    const diff = Math.abs(dv.sum_volume - row.total_volume);
    push('parts_sum_volume', '分项成交量合计等于官方总量', diff <= tol, 'fail',
      diff <= tol ? `分项合计 ${dv.sum_volume} = 官方总量 ${row.total_volume}` :
        `分项合计 ${dv.sum_volume} 与官方总量 ${row.total_volume} 不一致（差 ${round(diff, 6)}）`,
      String(row.total_volume), String(dv.sum_volume));
  } else {
    push('parts_sum_volume', '分项成交量合计等于官方总量', true, 'info', '分项或总量未完整披露，不做合计校验');
  }
  if (Number.isFinite(row.total_turnover) && dv.part_counts.turnover >= 2 && Number.isFinite(dv.sum_turnover)) {
    const tol = MONEY_EPS * dv.part_counts.turnover + Math.abs(row.total_turnover) * 1e-9;
    const diff = Math.abs(dv.sum_turnover - row.total_turnover);
    push('parts_sum_turnover', '分项成交额合计等于官方总额', diff <= tol, 'fail',
      diff <= tol ? `分项合计 ${dv.sum_turnover} = 官方总额 ${row.total_turnover}` :
        `分项合计 ${dv.sum_turnover} 与官方总额 ${row.total_turnover} 不一致（差 ${round(diff, 6)}）`,
      String(row.total_turnover), String(dv.sum_turnover));
  } else {
    push('parts_sum_turnover', '分项成交额合计等于官方总额', true, 'info', '分项或总额未完整披露，不做合计校验');
  }

  // 无成交 → 计算均价必须为 null，不能是 0
  const noTrade = !Number.isFinite(row.total_volume) || row.total_volume === 0;
  push('avg_price_when_no_trade', '无成交时计算均价为 NULL', noTrade ? dv.computed_avg_price === null : true, 'fail',
    noTrade ? (dv.computed_avg_price === null ? '无成交量，计算均价已置空' : '无成交量却算出均价，违反口径') : '有成交量，按量加权计算均价');

  // 综合收盘价 vs 全方式均价：口径不同，**不判冲突**
  const cc = num(row.close);
  const avg = dv.computed_avg_price;
  if (Number.isFinite(cc) && Number.isFinite(avg)) {
    const same = Math.abs(cc - avg) <= 1e-9;
    push('close_vs_avg_price', '综合收盘价与全方式均价口径分离', true, 'info',
      same
        ? `本日综合收盘价 ${cc} 与全方式量加权均价 ${avg} 数值相同（口径仍分别保留）`
        : `综合收盘价 ${cc}（官方指定权重指数）与全方式量加权均价 ${avg} 不同属正常口径差异，不判为冲突（CEA-05）`,
      'close 保留官方指数口径；computed_avg_price 为总量/总额推导', `close=${cc},avg=${avg}`);
  }

  // 累计差分：只在「区间完整」时才做，且只作提示，绝不据此推断漏采日的交易值
  if (opts.prevRow && Number.isFinite(row.lifetime_volume) && Number.isFinite(opts.prevRow.lifetime_volume)) {
    const grown = row.lifetime_volume >= opts.prevRow.lifetime_volume - VOLUME_EPS;
    push('lifetime_monotonic', '历史累计成交量不下降', grown, 'warn',
      grown
        ? '历史累计成交量不低于上一可比记录'
        : `历史累计成交量低于上一记录（${opts.prevRow.lifetime_volume} → ${row.lifetime_volume}）：可能官方修订或采集口径变化，需人工核对来源`,
      `≥ ${opts.prevRow.lifetime_volume}`, String(row.lifetime_volume));
  }
  if (opts.rangeComplete === false) {
    push('cumulative_delta_scope', '累计差值区间完整性', true, 'info',
      '区间存在未采集交易日：只展示官方累计值，不由累计差推断缺失日的成交量（规范禁止自动推断漏采日交易值）');
  }

  // 日期一致性：原文中不同位置的日期必须一致，否则如实暴露供核对
  if (opts.dateInfo) {
    const consistent = opts.dateInfo.consistent;
    push('date_consistency', '原文日期来源一致', consistent !== false, 'fail',
      consistent === false
        ? `原文出现的日期不一致：${(opts.dateInfo.candidates || []).map((c) => `${c.date}(${c.source})`).join('、')}`
        : `交易日 ${row.trade_date}（来源：${opts.dateInfo.source || 'unknown'}）`,
      '各处日期一致', (opts.dateInfo.candidates || []).map((c) => c.date).join(','));
  }

  const failed = checks.filter((c) => !c.ok && c.severity === 'fail');
  const warned = checks.filter((c) => !c.ok && c.severity === 'warn');
  return { ok: failed.length === 0, status: failed.length ? 'fail' : warned.length ? 'warn' : 'pass', checks };
}

/* ==================================================================== */
/*  五、名录 / 意向 / 政策正文的最小结构化提取                            */
/* ==================================================================== */

/**
 * 名录页面归属判定：必须是「重点排放单位名录」页面。
 *
 * 背景（真实踩坑）：用搜索在 *.gov.cn 内发现候选时，命中的可能是**政府采购公告**
 * 等无关页面。若不加判定，一两条含「有限公司」的句子就会被当成名录行写库——那是伪造数据。
 * 因此名录解析必须同时满足：
 *   ① 正文明确出现「重点排放单位名录 / 重点排放单位名单 / 温室气体重点排放单位」；
 *   ② 出现名录年度（如 2026年度）或纳管行业词（发电/钢铁/水泥/铝冶炼）之一。
 *
 * @returns {{ok:boolean, reason:string}}
 */
export function checkEntityPage(text, { listYear = null } = {}) {
  const s = String(text || '');
  const hasListMarker = /重点排放单位(名录|名单)|温室气体重点排放单位|纳入碳市场重点排放单位/.test(s);
  if (!hasListMarker) {
    return { ok: false, reason: '正文未出现「重点排放单位名录/名单」标识，不是纳管名录页面（可能是采购公告或栏目页），拒绝解析' };
  }
  const yearOk = listYear ? new RegExp(`${listYear}\\s*年度|${listYear}\\s*年`).test(s) : /20\\d{2}\\s*年度/.test(s);
  const sectorOk = /发电|钢铁|水泥|铝冶炼|石化|化工|建材|有色|造纸|民航/.test(s);
  if (!yearOk && !sectorOk) {
    return { ok: false, reason: '正文未出现名录年度或纳管行业信息，无法确认为可核对的名录页面' };
  }
  return { ok: true, reason: '正文包含名录标识与年度/行业信息' };
}

/**
 * 主体名称判定：必须以**组织机构后缀结尾**。
 * 只允许「公司/厂/集团/电厂/中心」等组织后缀，**不得**把行业词（水泥、钢铁、化工…）
 * 当作名称特征——否则政策正文里「2027年度发电、钢铁、水泥、铝冶炼行业重点排放单位名录」
 * 这样的句子会被误判成企业行（已实测踩坑，属于伪造名录数据）。
 */
const ORG_SUFFIX_RE = /(有限责任公司|股份有限公司|有限公司|公司|集团|电厂|热电厂|厂|中心|分公司|分厂)$/;

/** 明显不是企业名称的片段（政策/栏目用语） */
const NOT_ENTITY_RE = /(名录|名单|序号|行业|年度|省份|设区市|地市|备注|附件|公告|通知|公示|政府|生态环境|主管部门|管理平台|以下简称|重点排放单位$|发电$|钢铁$|水泥$|铝冶炼$|方案|办法|规则|要求|工作)/;

export function validEntityCreditCode(value) {
  const code = String(value || '').trim();
  const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  if (code.length !== 18 || [...code].some(c => !alphabet.includes(c))) return false;
  const sum = [...code.slice(0, 17)].reduce((n, c, i) => n + alphabet.indexOf(c) * weights[i], 0);
  return alphabet[(31 - sum % 31) % 31] === code[17];
}

function structuredEntityCells(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const records = [];
  // Markdown和HTML转出的制表符，保留原字段列关系。
  for (const line of lines) {
    const cells = line.includes('|') ? line.replace(/^\|\s*|\s*\|$/g, '').split('|').map(x => x.trim()) : line.split('\t').map(x => x.trim());
    if (cells.length >= 6 && /^\d{1,4}$/.test(cells[0]) && /市$/.test(cells[1])) records.push(cells.slice(0, 6));
  }
  if (records.length) return records;
  // 经典OCR逐单元格输出，依“序号+城市”确定边界，合并被换行的企业名称。
  const starts = [];
  for (let i = 0; i < lines.length - 1; i++) if (/^\d{1,4}$/.test(lines[i]) && /市$/.test(lines[i + 1])) starts.push(i);
  for (let n = 0; n < starts.length; n++) {
    const chunk = lines.slice(starts[n], starts[n + 1] ?? lines.length);
    const codeAt = chunk.findIndex((x, i) => i > 2 && /^[0-9A-Z]{15,20}$/.test(x));
    if (codeAt < 4) continue;
    let industry = chunk.findIndex((x, i) => i > 2 && i < codeAt && /^(发电|钢铁|水泥|铝冶炼|电解铝)$/.test(x));
    // 行业有识别错字时保留原字段但不映射成一个猜测行业；仍保留有明确代码和名称的主体行。
    if (industry < 0 && ORG_SUFFIX_RE.test(chunk[2]) && /^[\u4e00-\u9fa5]{2,4}$/.test(chunk[3])) industry = 3;
    if (industry < 3) continue;
    const state = chunk.slice(codeAt + 1).find(x => /^(既有|新增|退出)$/.test(x));
    if (!state) continue;
    const name = chunk.slice(2, codeAt).filter((_, i) => i + 2 !== industry).join('');
    records.push([chunk[0], chunk[1], name, chunk[industry], chunk[codeAt], state]);
  }
  return records;
}

/* ------------------------------------------------------------------ */
/*  名录年度识别：只认「名录/名单」标题附近的年度，不拿发布日期/引用年度  */
/* ------------------------------------------------------------------ */

const LIST_MARKER_RE = /重点排放单位(?:名录|名单)|温室气体重点排放单位|纳入碳市场重点排放单位名录|碳排放单位名录/;
const ENTITY_NAV_RE = /^\s*(?:上一条|下一条|上一篇|下一篇|相关阅读|相关链接|往期|历史)/;
const ENTITY_OUT_OF_SCOPE_RE = /地方试点|试点碳市场|碳排放权交易试点|仅报告|报告与核查|核查工作范围|拟纳入|征求意见|意见稿|采购公告|招标公告|中标公告|成交公告|比选公告|询价公告|采购项目/;
const ENTITY_SECTOR_WORDS = ['发电', '钢铁', '水泥', '铝冶炼'];
const CREDIT_TOKEN_ONE_RE = /[0-9A-Z]{15,20}/;
// 旧兜底路径的 18 位校验字符集：排除 I/O/S/V/Z
const LEGACY_CC_RE = /\b([0-9A-HJ-NPQRTUWXY]{18})\b/;

function entityLines(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u00a0\u3000]/g, ' ').trim())
    .filter(Boolean);
}

/** 标题区（用于省份/负面范围判断），不扫描正文中的历史名录链接 */
function entityTitleContext(text) {
  return entityLines(text).slice(0, 25).join(' ');
}

function entityProvince(text) {
  const s = entityTitleContext(text);
  const m = s.match(/(北京|天津|河北|山西|内蒙古|辽宁|吉林|黑龙江|上海|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|重庆|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆)(?:省|市|自治区|壮族自治区|回族自治区|维吾尔自治区)?/);
  return m?.[1] || null;
}

function entitySectorsIn(value) {
  const s = String(value || '').replace(/\s+/g, '');
  const out = [];
  if (/铝冶炼|电解铝/.test(s)) out.push('铝冶炼');
  if (/钢铁/.test(s)) out.push('钢铁');
  if (/水泥/.test(s)) out.push('水泥');
  if (/发电|电力/.test(s)) out.push('发电');
  return [...new Set(out)];
}

function normalizeEntitySector(value) {
  const hits = entitySectorsIn(value);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 仅在表头没有独立行业列、且同一表混合多个行业时，用**无歧义**的国民经济行业
 * 分类代码兜底。2511 等代码可能是发电名单中的自备电厂主业代码，故意不映射；
 * 有明确分节/表标题时仍以标题行业优先。
 */
function industryCodeSector(value) {
  const codes = [...String(value || '').matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]);
  const map = {
    4411: '发电', 4412: '发电',
    3011: '水泥',
    3110: '钢铁', 3120: '钢铁', 3130: '钢铁', 3140: '钢铁',
    3216: '铝冶炼',
  };
  const hits = [...new Set(codes.map((c) => map[c]).filter(Boolean))];
  return hits.length === 1 ? hits[0] : null;
}

function titleEntitySector(value) {
  // 表标题上下文可能把「现将…发电、钢铁、水泥、铝冶炼行业名录公告如下」公告句
  // 与真正的分行业标题拼在一起。只取最后一个句号后的明确标题，避免把多行业公告句
  // 当成表头行业而返回 null。
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const last = s.split(/[。；;]/).filter(Boolean).pop() || s;
  const hits = entitySectorsIn(last);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return normalizeEntitySector(s);
  return null;
}

function isOutOfScopeEntityText(value) {
  return ENTITY_OUT_OF_SCOPE_RE.test(String(value || ''));
}

function hasEntityHeader(text) {
  const s = String(text || '');
  return /企业名称|单位名称/.test(s) && /统一社会信用代码|信用代码|序号/.test(s);
}

/**
 * 识别名录年度。只读取包含「重点排放单位名录/名单」的标题行及其前两行，
 * 取**最靠近名录标识**的年度；避免把「发布时间 2025-10-27」或
 * 「关于做好2025年全国碳市场工作的通知」误作 2026 名录年度。
 *
 * 多个不同的名录标题年度 → conflict=true，由调用方登记缺口，不猜测。
 * 原文没有年度时才使用来源登记年度（listYear）。
 */
export function detectEntityListYear(raw, { listYear = null } = {}) {
  const text = looksLikeHtml(raw) ? htmlToText(raw) : String(raw || '');
  const lines = entityLines(text);
  const candidates = [];
  const seen = new Set();
  const add = (year, quote) => {
    const n = Number(year);
    if (!Number.isInteger(n) || n < 2000 || n > 2100 || seen.has(n)) return;
    seen.add(n);
    candidates.push({ year: n, quote: String(quote || '').replace(/\s+/g, ' ').slice(0, 160) });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!LIST_MARKER_RE.test(line)) continue;
    if (ENTITY_NAV_RE.test(line)) continue;
    const windowText = [lines[i - 2], lines[i - 1], line].filter(Boolean).join(' ');
    // 必须定位**当前行自己的**名录标识；windowText 前面可能还有上一行标题，
    // 用 search() 会取到上一行的标识，导致第二个年度被跳过。
    const markerInLine = line.search(LIST_MARKER_RE);
    if (markerInLine < 0) continue;
    const markerAt = windowText.length - line.length + markerInLine;
    const before = windowText.slice(Math.max(0, markerAt - 120), markerAt);
    const years = [...before.matchAll(/(20\d{2})(?=\s*年)/g)].map((m) => Number(m[1]));
    if (years.length) {
      add(years[years.length - 1], windowText);
      continue;
    }
    const after = windowText.slice(markerAt, markerAt + 100);
    const afterYear = after.match(/(20\d{2})\s*年/);
    if (afterYear) add(Number(afterYear[1]), windowText);
  }
  const distinct = [...new Set(candidates.map((c) => c.year))];
  if (distinct.length > 1) {
    return {
      year: null, year_source: null, candidates, conflict: true,
      reason: `名录年度在原文中冲突：${distinct.join('、')}；不猜测，返回缺口`,
    };
  }
  if (distinct.length === 1) {
    return { year: distinct[0], year_source: '原文', candidates, conflict: false, reason: null };
  }
  const metaYear = Number(listYear);
  if (Number.isInteger(metaYear) && metaYear >= 2000 && metaYear <= 2100) {
    return { year: metaYear, year_source: '来源登记年度', candidates, conflict: false, reason: null };
  }
  return {
    year: null, year_source: null, candidates, conflict: false,
    reason: '原文标题与来源登记均未明确名录年度；不拿当前年份顶替',
  };
}

/* ------------------------------------------------------------------ */
/*  名称/代码/地区/行业字段（只做原文列值规范化，不做跨列拼接）          */
/* ------------------------------------------------------------------ */

function stripTrailingRemarks(value) {
  return String(value || '')
    .replace(/(?:\s+(?:自备电厂|自备|电厂|热电厂|长流程|短流程|备注))+$/g, '')
    .trim();
}

function cleanEntityName(value) {
  let s = stripTrailingRemarks(String(value || ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u00a0\u3000]/g, ' ')
    .trim()
    .replace(/^[|｜\s]+|[|｜\s]+$/g, '');
  // 只剥离行号：阿拉伯数字可无分隔符；中文数字必须带「、.）」等分隔符，
  // 否则「四川亚东水泥有限公司」会被误剥成「川亚东水泥有限公司」。
  s = s.replace(/^[0-9]{1,4}\s*[、.．)）]?\s*/, '')
    .replace(/^[一二三四五六七八九十]{1,4}\s*[、.．)）]\s*/, '');
  const codeAt = s.search(CREDIT_TOKEN_ONE_RE);
  if (codeAt >= 0) s = s.slice(0, codeAt);
  return s.replace(/\s+/g, '').replace(/[，,;；、]+$/g, '').trim();
}

function validEntityName(name) {
  const s = String(name || '').trim();
  return s.length >= 4 && s.length <= 80 && ORG_SUFFIX_RE.test(s) && !NOT_ENTITY_RE.test(s) && !/^\d+$/.test(s);
}

function creditInfo(value) {
  const m = String(value || '').replace(/[\s\u00a0\u3000]/g, '').toUpperCase().match(CREDIT_TOKEN_ONE_RE);
  const raw = m?.[0] || null;
  const valid = !!raw && validEntityCreditCode(raw);
  return { raw, credit_code: valid ? raw : null, valid };
}

function cleanCity(value) {
  let s = String(value || '').replace(/[\s\u00a0\u3000]+/g, '').replace(/^[：:]+|[，,;；]+$/g, '');
  if (!s) return null;
  if (/[\/／]/.test(s)) s = s.split(/[\/／]/).filter(Boolean).pop() || s;
  return s || null;
}

function findCity(value) {
  const s = String(value || '').replace(/\s+/g, ' ');
  // 地区前常带「长流程」「铝冶炼」「自备电厂」等列值，先按空白/标点切分，
  // 再从右向左找明确的行政区后缀；不把公司名中的「万州」误当地区。
  const tokens = s.split(/[\s,，;；、|/／]+/).filter(Boolean).reverse();
  for (const token of tokens) {
    const cleaned = token
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/^(?:长流程|短流程|铝冶炼|电解铝|水泥|钢铁|电力|有色|建材|自备电厂|既有|新增|退出)+/, '')
      .replace(/[0-9]/g, '');
    if (/(?:市|盟|地区|县|区|自治州)$/.test(cleaned) && cleaned.length >= 2) return cleaned;
  }
  return null;
}

/** PDF 表格换行：地区列上一行「凉山彝族自」+ 下一行「治州」 */
function wrappedCityFromLines(lines, start) {
  let buf = '';
  for (let j = start; j < lines.length && j < start + 3; j += 1) {
    const line = String(lines[j] || '').replace(/\s+/g, '');
    if (!line || /^\d/.test(line) || CREDIT_TOKEN_ONE_RE.test(line) || ORG_SUFFIX_RE.test(line)) break;
    buf += line;
    if (/(?:市|州|盟|地区|县|区)$/.test(buf)) return { city: buf, count: j - start + 1 };
    if (!/[\u4e00-\u9fa5]/.test(line)) break;
  }
  return null;
}

function statusFromText(value) {
  if (/新增/.test(String(value || ''))) return 'new';
  if (/退出/.test(String(value || ''))) return 'exit';
  if (/既有/.test(String(value || ''))) return 'existing';
  return null;
}

const ENTITY_SECTOR_ORDER = ['发电', '钢铁', '水泥', '铝冶炼'];

/** 把「发电、钢铁」/「电力(44)」/分节标签拆成去重的纳管行业。 */
function sectorTags(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[、,，;；/／|]+/);
  const out = [];
  for (const part of parts) {
    for (const hit of entitySectorsIn(part)) if (!out.includes(hit)) out.push(hit);
  }
  return out.sort((a, b) => ENTITY_SECTOR_ORDER.indexOf(a) - ENTITY_SECTOR_ORDER.indexOf(b));
}

function joinSectorTags(tags) {
  return tags.length ? tags.join('、') : null;
}

/** 对外暴露同一套行业标签拆分规则，供成员关系入库复用。 */
export function entitySectorTags(value) {
  return sectorTags(value);
}

function rowSourceRef(row) {
  if (Array.isArray(row.row_sources) && row.row_sources.length) return row.row_sources;
  if (row.source_row === undefined || row.source_row === null) return [];
  return [{ source_row: row.source_row, sector: row.sector || null, note: row.note || null }];
}

/**
 * 同一原件内按信用代码去重：**合并**跨表/跨节的行业与行出处，不能只留最后一行。
 * 单行仍保持原来的字段形状；多行时 sector 用「、」连接，row_sources 保留每一行出处。
 */
function dedupeEntityRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = row.credit_code || `name:${row.name}`;
    const incomingTags = sectorTags([
      ...(Array.isArray(row.sectors) ? row.sectors : []),
      row.sector,
      row.source_sector,
    ]);
    const incomingSources = rowSourceRef(row);
    const incomingNotes = Array.isArray(row.notes) && row.notes.length ? row.notes : (row.note ? [row.note] : []);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, {
        ...row,
        sectors: incomingTags,
        row_sources: incomingSources,
        notes: incomingNotes,
      });
      continue;
    }
    const tags = [...new Set([...(prev.sectors || []), ...incomingTags])]
      .sort((a, b) => ENTITY_SECTOR_ORDER.indexOf(a) - ENTITY_SECTOR_ORDER.indexOf(b));
    const refs = [...(prev.row_sources || [])];
    for (const ref of incomingSources) {
      if (!refs.some((x) => x.source_row === ref.source_row && String(x.sector || '') === String(ref.sector || ''))) {
        refs.push(ref);
      }
    }
    const notes = [...new Set([...(prev.notes || []), ...incomingNotes])];
    merged.set(key, {
      ...prev,
      // 同代码的行只补空字段；名称/年度等以首次出现为准，具体差异留在各行 note 中。
      name: prev.name || row.name,
      province: prev.province || row.province || null,
      city: prev.city || row.city || null,
      raw_credit_code: prev.raw_credit_code || row.raw_credit_code || null,
      credit_code_valid: !!(prev.credit_code_valid || row.credit_code_valid),
      source_sector: prev.source_sector || row.source_sector || null,
      status: prev.status || row.status || null,
      sectors: tags,
      row_sources: refs,
      notes,
    });
  }
  const out = [];
  for (const row of merged.values()) {
    const tags = row.sectors || [];
    const refs = row.row_sources || [];
    const notes = row.notes || [];
    out.push({
      ...row,
      sector: joinSectorTags(tags),
      sectors: tags,
      source_rows: [...new Set(refs.map((x) => x.source_row).filter((n) => n !== undefined && n !== null))].sort((a, b) => a - b),
      row_sources: refs,
      note: notes.length ? notes.join('；') : (row.note || null),
      notes,
    });
  }
  return out;
}

function entityRowNote(rowNo, rawCode, valid, kind, { preserveCredit = false } = {}) {
  const invalidText = preserveCredit
    ? '位数或校验位异常，仅标注并保留原文'
    : '位数或校验位异常，标准信用代码留空';
  const codeText = rawCode
    ? `${rawCode}（${valid ? '18位及校验位通过' : invalidText}）`
    : '未披露';
  return `原表第${rowNo || '—'}行；原表信用代码：${codeText}；${kind}，行业/地区不拼入名称。`;
}

/* ------------------------------------------------------------------ */
/*  HTML 表格：按真实 <table>/<tr>/<td> 取列，支持列顺序变化和多表行业    */
/* ------------------------------------------------------------------ */

function htmlCellText(value) {
  return htmlToText(String(value || '')).replace(/\s+/g, ' ').trim();
}

function extractHtmlTables(html) {
  const out = [];
  const re = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(String(html || '')))) {
    const before = String(html).slice(lastEnd, m.index);
    const rows = [...m[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => (
      [...row[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((cell) => htmlCellText(cell[1]))
    ));
    out.push({ before, rows });
    lastEnd = re.lastIndex;
  }
  return out;
}

function tableTitleContext(beforeHtml) {
  const lines = entityLines(htmlToText(beforeHtml));
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (LIST_MARKER_RE.test(lines[i])) { at = i; break; }
  }
  if (at < 0) return '';
  return lines.slice(Math.max(0, at - 2), at + 1).join(' ');
}

function findEntityTableHeader(rows) {
  const headerAt = rows.findIndex((cells) => {
    const joined = cells.join('').replace(/\s+/g, '');
    return /企业名称|单位名称/.test(joined) && /统一社会信用代码|信用代码|序号/.test(joined);
  });
  if (headerAt < 0) return { headerAt: -1, header: null };
  return {
    headerAt,
    header: rows[headerAt].map((cell) => String(cell || '').replace(/[\s\u00a0\u3000]/g, '').replace(/[（）()]/g, '')),
  };
}

function firstTableNumber(rows) {
  for (const cells of rows) {
    const first = String(cells.find((cell) => String(cell || '').trim()) || '').trim();
    if (!first) continue;
    return /^\d{1,4}$/.test(first) ? Number(first) : null;
  }
  return null;
}

/** 续表判断必须同时满足：同列结构、行序连续、没有相反的新名录标题。 */
function canContinueEntityTable(prev, rows, title) {
  if (!prev?.header || !Number.isInteger(prev.lastRowNo)) return false;
  const firstNo = firstTableNumber(rows);
  if (!Number.isInteger(firstNo) || firstNo !== prev.lastRowNo + 1) return false;
  const firstData = rows.find((cells) => cells.some((cell) => String(cell || '').trim()));
  if (!firstData || firstData.length !== prev.header.length) return false;
  const titleHasMarker = LIST_MARKER_RE.test(String(title || ''));
  if (titleHasMarker) {
    const nextSector = titleEntitySector(title);
    const prevSector = titleEntitySector(prev.title || '');
    if (nextSector && prevSector && nextSector !== prevSector) return false;
    if (!prev.title || !LIST_MARKER_RE.test(prev.title)) return false;
    if (nextSector && !prevSector) return false;
  }
  // 非名录标题（如页眉/页码）不构成续表依据，交给行序与同列结构判断。
  return true;
}

function parseHtmlEntityTable(rows, opts = {}, { fallbackHeader = null } = {}) {
  const found = findEntityTableHeader(rows);
  const header = found.header || fallbackHeader;
  if (!header || !header.length) return { rows: [], header: null, lastRowNo: null, fallback: false };
  const headerAt = found.headerAt;
  const startAt = headerAt >= 0 ? headerAt + 1 : 0;
  const fallback = headerAt < 0;
  const idx = (re) => header.findIndex((h) => re.test(h));
  const nameIdx = idx(/企业名称|单位名称/) >= 0 ? idx(/企业名称|单位名称/) : idx(/名称/);
  const creditIdx = idx(/统一社会信用代码|信用代码/);
  const regionIdx = idx(/所属区|行政区划|地区|所在地|地市|城市/);
  const sectorIdx = header.findIndex((h) => /核算行业|所属行业|行业类别/.test(h) && !/代码/.test(h));
  const subSectorIdx = idx(/核算子行业|子行业/);
  const industryCodeIdx = header.findIndex((h) => /国民经济行业分类代码|行业分类代码|行业代码/.test(h));
  const statusIdx = header.findIndex((h) => /^(状态|既有新增|既有\/新增)$/.test(h));
  const noIdx = idx(/^序号$/);
  const titleSector = titleEntitySector(opts.title || '');
  const out = [];
  let currentSector = titleSector;
  let lastRowNo = null;

  for (let r = startAt; r < rows.length; r += 1) {
    const cells = rows[r].map((cell) => String(cell || '').replace(/\s+/g, ' ').trim());
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) continue;
    if (nonEmpty.length === 1) {
      const section = titleEntitySector(nonEmpty[0]);
      if (section && /行业/.test(nonEmpty[0])) { currentSector = section; continue; }
      if (/^(合计|总计|注|说明)/.test(nonEmpty[0])) continue;
    }
    const joined = cells.join(' ');
    if (/企业名称|统一社会信用代码/.test(joined)) continue;

    let name = cleanEntityName(nameIdx >= 0 ? cells[nameIdx] : '');
    if (!validEntityName(name)) {
      name = cells.map(cleanEntityName).find((c) => validEntityName(c) && !LIST_MARKER_RE.test(c)) || '';
    }
    if (!validEntityName(name)) continue;

    const credit = creditInfo(creditIdx >= 0 ? cells[creditIdx] : joined);
    const rawSector = [sectorIdx >= 0 ? cells[sectorIdx] : '', subSectorIdx >= 0 ? cells[subSectorIdx] : '']
      .filter(Boolean).join(' ');
    const industryCode = industryCodeIdx >= 0 ? cells[industryCodeIdx] : '';
    const rowSector = normalizeEntitySector(rawSector);
    const sector = currentSector || titleSector || rowSector || industryCodeSector(industryCode) || normalizeEntitySector(opts.sector);
    // 没有地区列时保持 NULL：不从企业名称里猜「万州」这类地名
    const city = regionIdx >= 0 ? cleanCity(cells[regionIdx]) : null;
    const status = statusFromText(statusIdx >= 0 ? cells[statusIdx] : '') || statusFromText(joined) || 'existing';
    const rawNo = noIdx >= 0 ? cells[noIdx] : '';
    const rowNo = /^\d{1,4}$/.test(rawNo) ? Number(rawNo) : (r - headerAt);
    const province = opts.province || entityProvince(opts.text || opts.title || '');
    out.push({
      name,
      credit_code: credit.credit_code,
      raw_credit_code: credit.raw,
      credit_code_valid: credit.valid,
      province,
      city,
      sector,
      source_sector: rawSector || currentSector || titleSector || null,
      list_year: opts.year,
      year_source: opts.yearSource,
      province_source: opts.province ? '来源登记省份' : (province ? '原文' : null),
      status,
      source_row: rowNo,
      note: entityRowNote(rowNo, credit.raw, credit.valid, 'HTML表格按表头列名解析'),
    });
    lastRowNo = rowNo;
  }
  return { rows: dedupeEntityRows(out), header, lastRowNo, fallback };
}

function parseHtmlEntityTables(html, opts = {}) {
  const out = [];
  // Word 分页续表不重复表头：只在上一个明确表头、列数一致、行序连续且无相反新标题时复用。
  let prev = null;
  for (const table of extractHtmlTables(html)) {
    const title = tableTitleContext(table.before);
    if (title && isOutOfScopeEntityText(title)) { prev = null; continue; }
    const titleHasMarker = !!title && LIST_MARKER_RE.test(title);
    const hasRows = table.rows.some((cells) => cells.some((cell) => String(cell || '').trim()));
    if (!titleHasMarker && !prev) continue;
    const ownHeader = findEntityTableHeader(table.rows).header;
    let fallbackHeader = null;
    if (prev && !ownHeader && canContinueEntityTable(prev, table.rows, title)) {
      fallbackHeader = prev.header;
    }
    if (!titleHasMarker && !fallbackHeader) {
      // 无标题、不能证明是续表的非空表格：断开续表链，避免后续任意表继承旧表头。
      if (hasRows) prev = null;
      continue;
    }
    const effectiveTitle = titleHasMarker ? title : (prev?.title || '');
    const parsed = parseHtmlEntityTable(table.rows, { ...opts, title: effectiveTitle }, { fallbackHeader });
    if (parsed.rows.length) {
      out.push(...parsed.rows);
      prev = {
        header: parsed.header,
        title: effectiveTitle,
        lastRowNo: parsed.lastRowNo,
      };
    } else if (titleHasMarker || (hasRows && !fallbackHeader)) {
      // 新标题但表头缺失/不可续，或非空异常表：不能把更后面的表接到旧表头上。
      prev = null;
    }
  }
  return dedupeEntityRows(out);
}

/* ------------------------------------------------------------------ */
/*  PDF / 纯文本：信用代码锚点 + 换行名称/地区，保留 OCR 逐单元格路径     */
/* ------------------------------------------------------------------ */

function rowsFromClassic(records, opts = {}) {
  const textProvince = entityProvince(opts.text || '');
  const province = textProvince || opts.province || null;
  const out = [];
  for (const c of records) {
    if (!ORG_SUFFIX_RE.test(c[2]) || !Number.isInteger(opts.year)) continue;
    const valid = validEntityCreditCode(c[4]);
    const sourceSector = String(c[3] || '').trim() || null;
    out.push({
      name: c[2],
      credit_code: valid ? c[4] : null,
      raw_credit_code: c[4],
      credit_code_valid: valid,
      province,
      city: c[1],
      // 经典 OCR 路径：行业识别不出来时保持 NULL，不拿标题行业覆盖（docs/44 回归）
      sector: normalizeEntitySector(sourceSector),
      source_sector: sourceSector,
      list_year: opts.year,
      status: c[5] === '新增' ? 'new' : c[5] === '既有' ? 'existing' : c[5] === '退出' ? 'exit' : 'unknown',
      source_row: Number(c[0]),
      year_source: opts.yearSource,
      province_source: textProvince ? '原文' : (opts.province ? '来源登记省份' : null),
      note: `原表第${c[0]}行；原表信用代码：${c[4]}（${valid ? '18位及校验位通过' : '位数或校验位异常，标准信用代码留空'}）；OCR提取不等同独立核验。`,
    });
  }
  return dedupeEntityRows(out);
}

function looksLikePendingName(line) {
  const s = String(line || '').trim();
  if (!s || CREDIT_TOKEN_ONE_RE.test(s)) return false;
  if (LIST_MARKER_RE.test(s)) return false;
  if (/^(序号|序\s|号\s|分类代码|国民经济行业|企业名称|单位名称|统一社会信用代码|信用代码|核算行业|核算子行业|地区|行业|备注|附件|自备|长流程|短流程)/.test(s)) return false;
  if (/^(自备|电厂|热电厂|长流程|短流程|备注)$/.test(s)) return false;
  if (/^[\d\s.、()（）—\-–]+$/.test(s)) return false;
  // 名称片段可能因版面右侧的备注而带大量空格（如「…有限公司        自备」）。
  // 先剥离行尾备注再判断长度，否则真实的换行公司名会被误当成页眉丢弃。
  const candidate = stripTrailingRemarks(s).replace(/\s+/g, '');
  if (/^[（(]/.test(candidate)) return false;
  // 行业子类的换行片段，如「水泥(硅酸盐」「水泥熟料)」，不是企业名称
  if (/^(水泥|钢铁|有色|建材|电力|发电|铝冶炼|自备|长流程|短流程)[（(]/.test(candidate)) return false;
  if (/[)）]$/.test(candidate) && !/公司|厂|集团|中心/.test(candidate)) return false;
  if (/(?:市|州|盟|地区|县|区)$/.test(candidate) && !/公司|厂|集团|中心/.test(candidate)) return false;
  if (candidate.length > 50) return false;
  return /[\u4e00-\u9fa5]/.test(candidate);
}

function parseAnchorTextRows(text, opts = {}) {
  const lines = entityLines(text).filter((line) => !/^[—\-–]\s*\d+\s*[—\-–]$/.test(line));
  const rows = [];
  const pending = [];
  let pendingRemark = false;
  let currentSector = null;
  let sequence = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!CREDIT_TOKEN_ONE_RE.test(line)) {
      if (/(?:行业|名录|名单)/.test(line) && !/公司|厂/.test(line)) {
        const section = titleEntitySector(line);
        if (section) currentSector = section;
        pending.length = 0;
      }
      // 「自备/电厂」是备注换行，不能作为下一条企业名称的前缀
      if (/^(自备|电厂|热电厂|长流程|短流程|备注)$/.test(line)) {
        if (line === '自备') pendingRemark = true;
        pending.length = 0;
        continue;
      }
      if (/^(号\s|序\s|分类代码|国民经济行业|企业名称|统一社会信用代码)/.test(line)) {
        pending.length = 0;
        continue;
      }
      if (looksLikePendingName(line)) {
        const fragment = stripTrailingRemarks(line);
        // 新行本身已是完整企业名时，重置 pending，避免把上一行备注拼进来
        if (validEntityName(fragment)) pending.length = 0;
        pending.push(fragment);
        if (pending.length > 3) pending.shift();
      }
      continue;
    }

    const codeMatch = line.match(CREDIT_TOKEN_ONE_RE);
    const rawCode = codeMatch?.[0];
    if (!codeMatch || !rawCode) continue;
    const before = line.slice(0, codeMatch.index);
    const after = line.slice(codeMatch.index + rawCode.length);
    const noMatch = before.match(/^\s*(\d{1,4})\s*[、.．)）]?\s*/);
    const rowNo = noMatch ? Number(noMatch[1]) : null;
    const namePart = cleanEntityName(noMatch ? before.slice(noMatch[0].length) : before);

    let name = namePart;
    if (!name && pending.length) {
      name = cleanEntityName(pending.join(''));
    } else if (name && !validEntityName(name) && pending.length) {
      // 名称前半段在上一行、后半段在本行代码前（如「…有限」+「公司」）
      const combined = cleanEntityName(`${pending.join('')}${name}`);
      if (combined) name = combined;
    }

    // 名称被 PDF 拆行：上一行「…有限公」+ 本行代码后「司」，或「…东部」+「电厂」
    const rowHasRemark = pendingRemark;
    pendingRemark = false;
    let extra = 0;
    while (!ORG_SUFFIX_RE.test(name) && i + 1 + extra < lines.length && extra < 2) {
      const frag = stripTrailingRemarks(lines[i + 1 + extra]).replace(/\s+/g, '');
      // 有「自备」备注时，行尾的「电厂」是备注而不是名称后缀；「公司」仍可作为名称补全
      if (rowHasRemark && /^(电厂|热电厂)$/.test(frag)) break;
      if (frag === '自备电厂') break;
      if (!/^[\u4e00-\u9fa5]{1,6}$/.test(frag)) break;
      const candidate = cleanEntityName(`${name}${frag}`);
      if (!ORG_SUFFIX_RE.test(candidate)) break;
      name = candidate;
      extra += 1;
    }
    // 表格单元在「有限公司」后仍有换行后缀（如「华能…有限公司 / 海门电厂」）：
    // 仅接一个短组织后缀行，避免把下一条完整企业名拼进来。
    let tail = 0;
    while (!rowHasRemark && tail < 1 && i + 1 + extra + tail < lines.length) {
      const frag = stripTrailingRemarks(lines[i + 1 + extra + tail]).replace(/\s+/g, '');
      // 「自备电厂」是备注换行，不是公司名后缀；「南山热电厂/东部电厂」仍应接上。
      if (frag === '自备电厂') break;
      if (!/^(?:[\u4e00-\u9fa5]{2,8}(?:电厂|分公司|集团|中心)|[\u4e00-\u9fa5]{2,8}厂)$/.test(frag)) break;
      const candidate = cleanEntityName(`${name}${frag}`);
      if (!ORG_SUFFIX_RE.test(candidate)) break;
      name = candidate;
      tail += 1;
    }
    pending.length = 0;
    if (!validEntityName(name)) continue;

    const nextAt = i + 1 + extra + tail;
    let city = cleanCity(findCity(after));
    let regionExtra = 0;
    if (!city) {
      const wrapped = wrappedCityFromLines(lines, nextAt);
      if (wrapped) { city = wrapped.city; regionExtra = wrapped.count; }
    }
    const status = statusFromText(line) || statusFromText(lines[nextAt] || '') || 'existing';
    const rowSector = normalizeEntitySector(after);
    const titleSector = titleEntitySector(entityTitleContext(text));
    const sector = currentSector || titleSector || rowSector || industryCodeSector(after) || normalizeEntitySector(opts.sector);
    const province = opts.province || entityProvince(text);
    const valid = validEntityCreditCode(rawCode);
    sequence += 1;
    rows.push({
      name,
      credit_code: valid ? rawCode : null,
      raw_credit_code: rawCode,
      credit_code_valid: valid,
      province,
      city,
      sector,
      source_sector: (currentSector || titleSector || (after ? after.slice(0, 60) : null)),
      list_year: opts.year,
      year_source: opts.yearSource,
      province_source: opts.province ? '来源登记省份' : (province ? '原文' : null),
      status,
      source_row: rowNo || sequence,
      note: entityRowNote(rowNo || sequence, rawCode, valid, 'PDF文本按信用代码锚点解析'),
    });
    i += extra + tail + regionExtra;
  }
  return dedupeEntityRows(rows);
}

function legacyEntityRows(text, opts = {}) {
  const rows = toRows(text);
  const out = [];
  let seq = 0;
  for (const cells of rows) {
    const joined = cells.join(' ');
    const cc = joined.match(LEGACY_CC_RE);
    const anyCode = joined.match(CREDIT_TOKEN_ONE_RE);
    const nameCand = cells
      .filter((c) => !CREDIT_TOKEN_ONE_RE.test(c) && /[\u4e00-\u9fa5]{3,}/.test(c))
      .filter((c) => !NOT_ENTITY_RE.test(c))
      .map(cleanEntityName)
      .filter(validEntityName)
      .filter((c) => (cc && joined.includes(c)) || ORG_SUFFIX_RE.test(c))
      .sort((a, b) => b.length - a.length)[0];
    if (!nameCand) continue;
    seq += 1;
    const rawCode = cc?.[1] || anyCode?.[0] || null;
    const first = cells[0];
    const rowNo = /^\d{1,4}$/.test(first) ? Number(first) : seq;
    out.push({
      name: nameCand,
      // 保持既有兜底契约：18 位原文即写入 credit_code，校验位异常只标注
      credit_code: cc?.[1] || null,
      raw_credit_code: rawCode,
      credit_code_valid: !!cc?.[1] && validEntityCreditCode(cc[1]),
      province: opts.province || null,
      city: null,
      sector: null,
      source_sector: null,
      list_year: opts.year,
      year_source: opts.yearSource,
      province_source: opts.province ? '来源登记省份' : null,
      status: 'existing',
      source_row: rowNo,
      note: entityRowNote(rowNo, rawCode, !!cc?.[1] && validEntityCreditCode(cc[1]), '文本兜底解析（无表头）', { preserveCredit: true }),
    });
  }
  return dedupeEntityRows(out);
}

/**
 * 从公开名录原文中提取行。**只提取原文明确出现的主体**：
 * 统一社会信用代码缺失时保留 NULL，不推测；不合并同一集团下不同法人。
 * 页面不像名录、或识别出的行少于阈值时返回空数组，由调用方登记缺口。
 *
 * 年度纪律：只认名录标题/表标题附近的年度；多个不同年度 → 返回空数组（缺口）。
 * 行业纪律：优先表标题/分节行业，其次行内行业，最后来源登记 sector；
 *           不把国民经济行业分类代码（如 2511）当实际纳管类别。
 * 小名单纪律：有正式名录标题 + 可识别表头 + 企业名称/代码时允许 1 行；
 *           无表头的兜底文本仍要求至少 3 行，不靠放宽全局 minRows 收任意页面。
 *
 * @param {string} raw
 * @param {{listYear?:number|null, province?:string|null, sector?:string|null, minRows?:number}} [opts]
 * @returns {Array<object>}
 */
export function parseEntityRows(raw, { listYear = null, province = null, sector = null, minRows = 3 } = {}) {
  const text = looksLikeHtml(raw) ? htmlToText(raw) : String(raw || '');
  const yearInfo = detectEntityListYear(raw, { listYear });
  if (yearInfo.conflict || !Number.isInteger(yearInfo.year)) return [];
  if (isOutOfScopeEntityText(entityTitleContext(text))) return [];
  const verdict = checkEntityPage(text, { listYear: yearInfo.year });
  if (!verdict.ok) return [];

  const base = {
    year: yearInfo.year, yearSource: yearInfo.year_source,
    province, sector: normalizeEntitySector(sector), text,
  };
  const isHtml = looksLikeHtml(raw);
  const hasTable = /<table\b/i.test(String(raw || ''));
  let rows = [];
  let trusted = false;

  if (isHtml && hasTable) {
    rows = parseHtmlEntityTables(raw, base);
    trusted = rows.length > 0;
    if (!rows.length) {
      // 无表头/非企业表的 HTML 保持旧兜底行为（test/30 的 3 行简单表）
      rows = legacyEntityRows(text, base);
      trusted = hasEntityHeader(text);
    }
  } else {
    const classic = structuredEntityCells(text);
    if (classic.length) {
      rows = rowsFromClassic(classic, base);
      trusted = true;
    } else {
      rows = parseAnchorTextRows(text, base);
      if (rows.length) {
        trusted = true;
      } else {
        rows = legacyEntityRows(text, base);
        trusted = hasEntityHeader(text);
      }
    }
  }

  const unique = dedupeEntityRows(rows);
  const threshold = trusted ? 1 : Math.max(1, Number(minRows) || 3);
  return unique.length >= threshold ? unique : [];
}

/**
 * 从公开交易意向原文中提取条目。
 * 意向 ≠ 成交：本函数输出只用于 cea_intention，任何调用方不得写入成交表。
 * 未公开的价格或主体保留 NULL。
 */
export function parseIntentionRows(raw, { url = '' } = {}) {
  const text = looksLikeHtml(raw) ? htmlToText(raw) : String(raw || '');
  const rows = toRows(text);
  const out = [];
  for (const cells of rows) {
    const joined = cells.join(' ');
    const dir = /(买入|求购|采购|buy)/i.test(joined) ? 'buy' : /(卖出|出售|转让|sell)/i.test(joined) ? 'sell' : null;
    if (!dir) continue;
    const vol = parseAmountToken(joined, { base: 'ton' });
    const dateM = joined.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
    if (!vol.ok && !dateM) continue;
    // 价格必须能明确识别为 元/吨；否则留 NULL，不用量或日期顶替
    const priceM = joined.match(/([\d,]+(?:\.\d+)?)\s*(?:元\s*\/\s*吨)/);
    out.push({
      direction: dir,
      volume: vol.ok ? vol.value : null,
      price: priceM ? decimalShift(priceM[1], 0) : null,
      published_date: dateM ? ymd(dateM[1], dateM[2], dateM[3]) : null,
      participant: null,
      source_url: url,
    });
  }
  return out;
}

/* ==================================================================== */
/*  正式全年休市公告解析（沪环境交〔2025〕44号一类文件）                 */
/* ==================================================================== */

const CN_MONTHS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

/** "10月1日" / "1月5日" → { month, day }；解析失败 null */
function cnMonthDay(text) {
  const m = String(text || '').match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  return { month, day };
}

/** 由月日与年度生成 YYYY-MM-DD（不改变年度，不做“跨年推断”） */
function ymdOf(year, month, day) {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const out = `${year}-${mm}-${dd}`;
  const d = new Date(`${out}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return out;
}

function eachDayInclusive(year, from, to, cap = 40) {
  const out = [];
  const start = Date.parse(`${ymdOf(year, from.month, from.day)}T00:00:00Z`);
  const end = Date.parse(`${ymdOf(year, to.month, to.day)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end && out.length < cap; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 解析**正式全国 CEA 全年休市公告**，按公告明确写出的范围提取日期。
 *
 * 真实样本（2026-10-14 抓取，32,708 字节，沪环境交〔2025〕44号）：
 *   「一、元旦 1月1日（星期四）至1月3日（星期六）休市，1月5日（星期一）起照常开市。
 *     另外，1月4日（星期日）为周末休市。…七、国庆节 10月1日（星期四）至10月7日（星期三）休市，
 *     10月8日（星期四）起照常开市。另外，9月20日（星期日）、10月10日（星期六）为周末休市。」
 *
 * 纪律：
 *   - 只认公告里**成段写明的范围**（`X月Y日…至X月Z日…休市`），不做任何按节假日名称的猜测；
 *   - 「起照常开市」的日期进入 `reopen_dates`，用于证明某日**不是**休市（优先于机器辅助列表）；
 *   - 「另外…为周末休市」的周末日单独记为 `weekend_closures`，不与法定休市范围混为一谈；
 *   - 标题/正文没写全年的，返回 ok:false，不硬凑。
 *
 * @returns {{ok:boolean, reason?:string, year:number|null, doc_number:string|null,
 *            publish_date:string|null, closed_dates:string[], reopen_dates:string[],
 *            weekend_closures:string[], ranges:Array<{label:string,from:string,to:string,quote:string}>,
 *            quotes:string[]}}
 */
export function parseAnnualClosureNotice(raw, { url = '' } = {}) {
  const text = looksLikeHtml(raw) ? htmlToText(String(raw)) : String(raw || '');
  if (!text) return { ok: false, reason: '公告内容为空', year: null, closed_dates: [], reopen_dates: [], weekend_closures: [], ranges: [], quotes: [] };
  const titleHit = /全年休市安排的通知/.test(text) || /全年休市安排/.test(text);
  const yearM = text.match(/(20\d{2})\s*年(?:全年)?休市/);
  const year = yearM ? Number(yearM[1]) : null;
  if (!titleHit || !year) {
    return { ok: false, reason: '不是「全年休市安排」类公告，或未能从原文确定适用年度', year, closed_dates: [], reopen_dates: [], weekend_closures: [], ranges: [], quotes: [] };
  }
  const flat = text.replace(/\s+/g, ' ');
  const docNumber = (flat.match(/([沪环京粤鄂渝川津冀晋蒙辽吉黑苏浙皖闽赣鲁豫湘桂琼贵云藏陕甘青宁新]?[^\s，。；]{0,12}〔20\d{2}〕\s*\d+\s*号)/) || [])[1] || null;
  const pubM = text.match(/发布时间[:：]?\s*(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  const publish_date = pubM ? ymd(pubM[1], pubM[2], pubM[3]) : null;

  const ranges = [];
  const closed = new Set();
  const reopen = new Set();
  const weekend = new Set();
  const quotes = [];

  // ① 休市范围：「X月Y日…至X月Z日…休市」；周几括注（星期四）会被忽略
  const rangeRe = /(\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\s*[（(][^）)]*[）)]\s*)?\s*(?:至|到|—|-|~)\s*(\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\s*[（(][^）)]*[）)]\s*)?\s*休市/g;
  for (const m of flat.matchAll(rangeRe)) {
    const a = cnMonthDay(m[1]);
    const b = cnMonthDay(m[2]);
    if (!a || !b) continue;
    const days = eachDayInclusive(year, a, b);
    if (!days.length) continue;
    for (const d of days) closed.add(d);
    ranges.push({ label: null, from: days[0], to: days[days.length - 1], quote: m[0] });
    quotes.push(m[0]);
  }
  // ② 开市日：「X月Y日…起照常开市」→ 该日不因机器列表被当成休市
  const reopenRe = /(\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\s*[（(][^）)]*[）)]\s*)?\s*起照常开市/g;
  for (const m of flat.matchAll(reopenRe)) {
    const a = cnMonthDay(m[1]);
    const d = a ? ymdOf(year, a.month, a.day) : null;
    if (d) { reopen.add(d); quotes.push(m[0]); }
  }
  // ③ 「另外，…为周末休市」：只取明写在“周末休市”之前的日期
  const extraRe = /另外[，,]([^。；]{0,80}?)为周末休市/g;
  for (const m of flat.matchAll(extraRe)) {
    const dates = [...String(m[1]).matchAll(/(\d{1,2}\s*月\s*\d{1,2}\s*日)/g)]
      .map((x) => cnMonthDay(x[1]))
      .filter(Boolean)
      .map((a) => ymdOf(year, a.month, a.day))
      .filter(Boolean);
    if (!dates.length) continue;
    for (const d of dates) weekend.add(d);
    quotes.push(m[0]);
  }
  const closedDates = [...closed].sort();
  if (!closedDates.length) {
    return { ok: false, reason: '公告中未解析出任何「X月Y日至X月Z日休市」的明确范围', year, doc_number: docNumber, publish_date, closed_dates: [], reopen_dates: [], weekend_closures: [], ranges: [], quotes, source_url: url };
  }
  return {
    ok: true,
    year,
    doc_number: docNumber,
    publish_date,
    closed_dates: closedDates,
    reopen_dates: [...reopen].sort(),
    weekend_closures: [...weekend].sort(),
    ranges,
    quotes: [...new Set(quotes)],
    source_url: url,
    note:
      '正式全年休市公告：本结果只包含公告原文明确写出的休市范围与开市日，' +
      '不按节假日名称推测；「另外…为周末休市」单独记录，不与法定休市范围混计。',
  };
}
