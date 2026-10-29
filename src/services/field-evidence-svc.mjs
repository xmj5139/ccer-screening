/**
 * 结构字段与逐字引句证据（docs/86 第一阶段第 3 节）
 * ============================================================================
 * 硬约束：
 *   · quote 必须是正文中真实、连续、逐字的片段；char_start / char_end 使用
 *     Unicode 码点偏移（同时保存 UTF-16 偏移供浏览器高亮）。
 *   · 无法定位的引句一律 status='invalid'，不进入前台有效字段。
 *   · 确定性抽取 method='deterministic_rule'；模型抽取 method='model'，
 *     必须记录实际 model / provider / prompt 版本，不能冒充规则结果。
 *   · 正文变化后旧证据一律 stale；前台只读当前 body_hash 的 valid 记录。
 *   · 模型抽取只由后台显式动作触发，复用既有 callStructuredModel 出站封装。
 */
import { get, run, all, audit } from '../core/db.mjs';
import { newId, nowIso, j } from '../core/util.mjs';
import { cleanText, sha256Text } from './content-clean-svc.mjs';
import { callStructuredModel } from './structured-model-svc.mjs';
import { pickVerifyProvider } from './verification-svc.mjs';

export const FIELD_PROMPT_VERSION = 'field-evidence-p1';
export const MODEL_EXTRACTOR_VERSION = 'model-field-p1';

export const FIELD_DEFS = {
  region: {
    label: '地区（仅正文提及）', type: 'text', mention_only: true,
    scope_warning: '仅表示正文提及该地区，不代表官方适用范围、项目合格或政策效力。',
  },
  industry: {
    label: '行业（仅正文提及）', type: 'text', mention_only: true,
    scope_warning: '仅表示正文提及该行业，不代表官方适用范围、项目合格或政策效力。',
  },
  year: { label: '年度', type: 'year' },
  methodology_code: { label: '方法学编号', type: 'text' },
  threshold: { label: '阈值/门槛', type: 'number' },
  publish_date: { label: '发布日期', type: 'date' },
  effective_date: { label: '生效/实施日期', type: 'date' },
};

const ENTITY_TYPES = {
  content_item: { table: 'content_item', title: 'title' },
  policy_document: { table: 'policy_document', title: 'title' },
  methodology_version: { table: 'methodology_version', title: 'name' },
  public_project: { table: 'public_project', title: 'name' },
};

export function fieldLabel(key) {
  return FIELD_DEFS[key]?.label || key;
}

/** 取对象当前正文与 body_hash；没有正文的对象返回 null。 */
export function loadEntityBody(entityType, entityId) {
  const meta = ENTITY_TYPES[entityType];
  if (!meta) return null;
  const row = get(`SELECT * FROM ${meta.table} WHERE id=?`, [String(entityId)]);
  if (!row) return null;
  const text = cleanText(row.body_snapshot || '');
  if (!text) return { row, text: '', body_hash: null, title: row[meta.title] || null };
  const bodyHash = entityType === 'content_item'
    ? (row.body_fingerprint || row.content_hash || sha256Text(text))
    : sha256Text(text);
  return { row, text, body_hash: bodyHash, title: row[meta.title] || null };
}

/** 码点偏移：把 JS UTF-16 下标转为 Unicode 码点下标。 */
export function codePointIndex(text, jsIndex) {
  return Array.from(String(text || '').slice(0, Math.max(0, jsIndex))).length;
}

/** 由码点区间取子串。 */
export function sliceCodePoints(text, start, end) {
  return Array.from(String(text || '')).slice(start, end).join('');
}

function normalizeForCompare(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sentenceAround(text, index) {
  const src = String(text || '');
  let start = index;
  while (start > 0 && !/[。！？；\n]/.test(src[start - 1])) start -= 1;
  let end = index;
  while (end < src.length && !/[。！？；\n]/.test(src[end])) end += 1;
  if (end < src.length && /[。！？；]/.test(src[end])) end += 1;
  while (start < end && /\s/.test(src[start])) start += 1;
  while (end > start && /\s/.test(src[end - 1])) end -= 1;
  return { start, end, quote: src.slice(start, end) };
}

function pushCandidate(out, text, index, value, key, valueType = 'text') {
  if (index < 0 || !value) return;
  const bound = sentenceAround(text, index);
  if (!bound.quote || bound.quote.length > 500) return;
  const valueText = String(value);
  if (!bound.quote.includes(valueText) && valueType !== 'date' && valueType !== 'number') return;
  out.push({
    field_key: key, field_value: valueText, value_type: valueType,
    quote: bound.quote, char_start: codePointIndex(text, bound.start),
    char_end: codePointIndex(text, bound.end),
    utf16_start: bound.start, utf16_end: bound.end, page: null,
  });
}

const REGIONS = [
  '内蒙古自治区', '广西壮族自治区', '宁夏回族自治区', '新疆维吾尔自治区', '西藏自治区',
  '香港特别行政区', '澳门特别行政区', '北京市', '天津市', '上海市', '重庆市',
  '河北省', '山西省', '辽宁省', '吉林省', '黑龙江省', '江苏省', '浙江省', '安徽省',
  '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '海南省',
  '四川省', '贵州省', '云南省', '陕西省', '甘肃省', '青海省', '台湾省',
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏',
  '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南',
  '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '宁夏', '新疆', '西藏',
  '全国',
];

const INDUSTRIES = [
  '煤矿瓦斯', '瓦斯利用', '甲烷回收', '林业碳汇', '海洋碳汇', '可再生能源', '生物质能',
  '垃圾填埋气', '污水处理', '余热余压', '钢铁', '水泥', '电解铝', '石化', '化工', '造纸',
  '民航', '电力', '有色', '建材', '焦化', '煤炭', '油气', '农业', '交通', '建筑',
];

function normalizeDate(y, m, d) {
  const yy = Number(y); const mm = Number(m); const dd = Number(d);
  if (!(yy >= 2000 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function dateMatches(text, regex, fieldKey, out) {
  for (const m of String(text || '').matchAll(regex)) {
    const iso = normalizeDate(m[2] ?? m[1], m[3] ?? m[2], m[4] ?? m[3]);
    if (!iso) continue;
    const index = m.index ?? 0;
    const bound = sentenceAround(text, index);
    if (!bound.quote) continue;
    out.push({
      field_key: fieldKey, field_value: iso, value_type: 'date', quote: bound.quote,
      char_start: codePointIndex(text, bound.start), char_end: codePointIndex(text, bound.end),
      utf16_start: bound.start, utf16_end: bound.end, page: null,
    });
  }
}

/**
 * 确定性基础抽取：只做可复现的字段定位，不生成摘要或结论。
 * 返回候选（尚未落库），调用方统一做 quote 校验。
 */
export function extractDeterministicCandidates(text) {
  const body = cleanText(text);
  const out = [];
  if (!body) return out;

  for (const region of REGIONS.sort((a, b) => b.length - a.length)) {
    // 短名后面紧跟省/市/自治区时，交给更长的全称匹配，避免「广东」抢在「广东省」前重复。
    const suffix = Array.from(region).length <= 3 && !/(省|市|自治区|特别行政区)$/.test(region)
      ? '(?![省市自治区])'
      : '';
    const re = new RegExp(region + suffix, 'g');
    for (const m of body.matchAll(re)) {
      pushCandidate(out, body, m.index ?? 0, region, 'region', 'text');
    }
  }
  for (const industry of INDUSTRIES) {
    const re = new RegExp(industry, 'g');
    for (const m of body.matchAll(re)) {
      pushCandidate(out, body, m.index ?? 0, industry, 'industry', 'text');
    }
  }
  for (const m of body.matchAll(/(20\d{2})\s*年(?:度)?/g)) {
    pushCandidate(out, body, m.index ?? 0, m[1], 'year', 'year');
  }
  for (const m of body.matchAll(/CCER-\d{2}-\d{3}(?:-V\d{2})?/g)) {
    pushCandidate(out, body, m.index ?? 0, m[0].toUpperCase(), 'methodology_code', 'text');
  }
  for (const m of body.matchAll(/(?:(?:阈值|门槛|上限|下限)\s*(?:为|设定为)?\s*[：:]?\s*(?:不超过|不高于|不低于|低于|高于)?|(?:不超过|不高于|不低于|低于|高于))\s*[0-9]+(?:\.[0-9]+)?\s*(?:%|％|tCO2e|tCO₂e|万吨|吨|万千瓦|MW|GW|万kWh|kWh|立方米|m³|年|个月|小时)?/gi)) {
    const value = m[0].replace(/\s+/g, ' ').trim();
    pushCandidate(out, body, m.index ?? 0, value, 'threshold', 'number');
  }
  dateMatches(body, /(?:发布日期|发布时间|发布日|公布日期|公布时间|生成日期|成文日期|印发日期|公开日期|发文日期|发布于|生成于)\s*[：:]?\s*((20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2}))/g, 'publish_date', out);
  dateMatches(body, /(?:施行日期|实施日期|生效日期|施行时间|实施时间|生效时间)\s*[：:]?\s*((20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2}))/g, 'effective_date', out);
  dateMatches(body, /自\s*((20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2}))\s*起(?:施行|实施|生效)/g, 'effective_date', out);

  const seen = new Set();
  return out.filter((c) => {
    const key = `${c.field_key}|${c.field_value}|${c.char_start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 校验引句是否真实连续，并校验字段值与引句可核对。
 * @returns {{ok:boolean,start?:number,end?:number,utf16_start?:number,utf16_end?:number,error?:string}}
 */
export function validateQuote(text, quote, {
  charStart = null, charEnd = null, utf16Start = null, utf16End = null,
  value = null, valueType = 'text',
} = {}) {
  const body = String(text || '');
  const q = String(quote || '');
  if (!q.trim()) return { ok: false, error: '引句为空' };
  if (!body) return { ok: false, error: '正文为空，无法定位引句' };

  let start = Number.isInteger(charStart) ? charStart : null;
  let end = Number.isInteger(charEnd) ? charEnd : null;
  let uStart = Number.isInteger(utf16Start) ? utf16Start : null;
  let uEnd = Number.isInteger(utf16End) ? utf16End : null;

  if (start !== null && end !== null) {
    if (!(start >= 0 && end > start)) return { ok: false, error: '字符区间非法' };
    if (sliceCodePoints(body, start, end) !== q) {
      return { ok: false, error: `字符区间与引句不一致（码点 ${start}-${end}）` };
    }
    // 码点区间是权威定位；UTF-16 区间必须由同一段码点换算而来。
    // 不能各自用 indexOf 命中“另一个”同文片段——两组偏移必须指同一处。
    const jsPrefix = Array.from(body).slice(0, start).join('');
    const jsStartFromCp = jsPrefix.length;
    const jsEndFromCp = jsStartFromCp + q.length;
    if (uStart !== null && uStart !== jsStartFromCp) {
      return { ok: false, error: '码点区间与 UTF-16 起始偏移指向不同片段' };
    }
    if (uEnd !== null && uEnd !== jsEndFromCp) {
      return { ok: false, error: '码点区间与 UTF-16 结束偏移指向不同片段' };
    }
    uStart = jsStartFromCp;
    uEnd = jsEndFromCp;
  } else {
    // 没有码点区间时才允许从 UTF-16 起点定位；未提供起点则取第一个出现位置。
    const jsStart = uStart !== null
      ? (body.slice(uStart, uStart + q.length) === q ? uStart : -1)
      : body.indexOf(q);
    if (jsStart < 0) return { ok: false, error: '引句不是正文中的连续片段' };
    start = codePointIndex(body, jsStart);
    end = start + Array.from(q).length;
    uStart = jsStart;
    uEnd = jsStart + q.length;
  }
  if (uStart !== null && uEnd !== null && body.slice(uStart, uEnd) !== q) {
    return { ok: false, error: 'UTF-16 区间与引句不一致' };
  }

  if (value !== null && value !== undefined && String(value).trim() !== '') {
    const v = String(value);
    const nq = normalizeForCompare(q);
    const nv = normalizeForCompare(v);
    let valueOk;
    if (valueType === 'date') {
      // 日期值先做真实日历校验：2026-02-31 不是可核对的日期。
      const dm = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const valueIso = dm ? normalizeDate(dm[1], dm[2], dm[3]) : null;
      if (!valueIso) return { ok: false, error: `字段值「${v}」不是日历上存在的 YYYY-MM-DD 日期` };
      const dates = [];
      for (const m of q.matchAll(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/g)) {
        const iso = normalizeDate(m[1], m[2], m[3]);
        if (iso) dates.push(iso);
      }
      valueOk = dates.includes(valueIso);
    } else {
      valueOk = nq.includes(nv);
    }
    if (!valueOk && valueType === 'number') {
      const numbers = (q.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      const target = Number((v.match(/-?\d+(?:\.\d+)?/) || [])[0]);
      valueOk = Number.isFinite(target) && numbers.some((n) => n === target);
    }
    if (!valueOk && valueType === 'year') valueOk = q.includes(v);
    if (!valueOk) return { ok: false, error: `字段值「${v}」无法在引句中核对` };
  }
  return { ok: true, start, end, utf16_start: uStart, utf16_end: uEnd };
}

const DATE_UNIT_RE = /(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/;
const DIRECTION_RE = /(不超过|不高于|不低于|及以上|及以下|以上|以下|低于|高于|大于|小于|≥|≤|>|<)/;
const UNIT_RE = /(%|％|tCO2e|tCO₂e|亿吨|万吨|吨|万千瓦|MW|GW|万kWh|kWh|立方米|m³|年|个月|小时)/i;

/** 明确写出“日期/时间/日”的发布日期标签；纯“发布/公布/印发”不算。 */
const PUBLISH_STRONG_LABEL_RE = /(发布日期|发布时间|发布日|公布日期|公布时间|生成日期|成文日期|印发日期|公开日期|发文日期)/g;
/** “发布于 2025-01-03”这类前置动词；必须紧邻日期。 */
const PUBLISH_PREP_LABEL_RE = /(发布于|生成于|公布于|发布于)/g;
/** 明确写出“日期/时间”的施行标签；“自……起施行”另行判断。 */
const EFFECTIVE_STRONG_LABEL_RE = /(施行日期|实施日期|生效日期|施行时间|实施时间|生效时间)/g;
const EFFECTIVE_SINCE_BEFORE_RE = /(?:自|从)\s*$/;
const EFFECTIVE_SINCE_AFTER_RE = /^\s*起\s*(?:施行|实施|生效)/;

function normalizeUnit(unit) {
  return String(unit || '').replace(/\s+/g, '').replace('％', '%')
    .replace(/tCO₂e/i, 'tCO2e').replace(/m³/, 'm3').toLowerCase();
}

const DIRECTION_KEYS = {
  不超过: '<=', 不高于: '<=', '≤': '<=', '<=': '<=',
  不低于: '>=', '≥': '>=', '>=': '>=', 以上: '>=', 及以上: '>=',
  低于: '<', 小于: '<', '<': '<',
  高于: '>', 大于: '>', '>': '>',
  以下: '<=', 及以下: '<=',
};

function normalizeDirection(direction) {
  return DIRECTION_KEYS[String(direction || '').trim()] || null;
}

function dateRegexFor(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!(y && m && d)) return null;
  return new RegExp(`${y}\\s*[-/年.]\\s*0?${m}\\s*[-/月.]\\s*0?${d}\\s*日?`);
}

function semanticError(message) {
  return { ok: false, error: message };
}

/**
 * 在日期所在句内寻找“明确标签”。纯落款（只有日期，或日期后跟“印发/发布”）
 * 不构成发布日期；标签与日期之间不得跨句号/分号/换行。
 */
function findDateLabel({ body, datePos, dateEnd, fieldKey }) {
  const sentence = sentenceAround(body, datePos);
  const localDateStart = datePos - sentence.start;
  const localDateEnd = localDateStart + (dateEnd - datePos);
  const text = sentence.quote;
  const strongRe = fieldKey === 'publish_date' ? PUBLISH_STRONG_LABEL_RE : EFFECTIVE_STRONG_LABEL_RE;
  const prepRe = fieldKey === 'publish_date' ? PUBLISH_PREP_LABEL_RE : null;

  const candidates = [];
  for (const m of text.matchAll(strongRe)) {
    const labelStart = m.index ?? 0;
    const labelEnd = labelStart + m[0].length;
    if (labelEnd > localDateStart) continue;
    const distance = localDateStart - labelEnd;
    if (distance > 40) continue;
    const between = text.slice(labelEnd, localDateStart);
    if (/[。！？；\n]/.test(between)) continue;
    candidates.push({ label: m[0], distance });
  }
  if (prepRe) {
    for (const m of text.matchAll(prepRe)) {
      const labelStart = m.index ?? 0;
      const labelEnd = labelStart + m[0].length;
      if (labelEnd > localDateStart) continue;
      const distance = localDateStart - labelEnd;
      if (distance > 8) continue;
      const between = text.slice(labelEnd, localDateStart);
      if (/[。！？；\n]/.test(between)) continue;
      candidates.push({ label: m[0], distance });
    }
  }

  // “自 2025-01-01 起施行”/“2025-01-01 起施行”：日期后紧跟明确的施行动词。
  if (fieldKey === 'effective_date') {
    const before = text.slice(Math.max(0, localDateStart - 4), localDateStart);
    const after = text.slice(localDateEnd, localDateEnd + 12);
    if (EFFECTIVE_SINCE_AFTER_RE.test(after) || (EFFECTIVE_SINCE_BEFORE_RE.test(before) && EFFECTIVE_SINCE_AFTER_RE.test(after))) {
      candidates.push({ label: '起施行/实施/生效', distance: 1 });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0];
}

/**
 * 字段语义校验（不是只看“数字相同”）：
 *   · 发布/生效日期必须有明确标签，且标签与日期在同一句、相邻；
 *     纯落款日期（如文末“2024年12月31日”或“2024年12月31日印发”）不能当发布日期。
 *   · 阈值必须同时核对方位与单位；quote 写“低于8%”不能支持 value“8吨”或“高于8%”。
 *   · 地区/行业只作为正文提及，不声明官方适用范围（由展示文案与提示词说明）。
 */
export function validateFieldSemantics({ fieldKey, value, quote, text, utf16Start = null, utf16End = null } = {}) {
  const q = String(quote || '');
  const v = String(value ?? '');
  const body = String(text || '');
  if (fieldKey === 'publish_date' || fieldKey === 'effective_date') {
    const dm = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dm || !normalizeDate(dm[1], dm[2], dm[3])) {
      return semanticError('日期值不是日历上存在的 YYYY-MM-DD');
    }
    const dateRe = dateRegexFor(v);
    if (!dateRe) return semanticError('日期值不是可核对的 YYYY-MM-DD');
    const qIndex = q.search(dateRe);
    let datePos;
    if (qIndex >= 0 && Number.isInteger(utf16Start)) datePos = utf16Start + qIndex;
    else if (Number.isInteger(utf16Start)) {
      const cStart = Math.max(0, utf16Start - 120);
      const ctx = body.slice(cStart, Math.min(body.length, (utf16End ?? utf16Start) + 120));
      const m = ctx.match(dateRe);
      if (!m) return semanticError('日期未出现在引句或相邻上下文中');
      datePos = cStart + (m.index ?? 0);
    } else {
      const local = q.match(dateRe);
      if (!local) return semanticError('日期未出现在引句中');
      datePos = local.index ?? 0;
    }
    const rawDate = body.slice(datePos).match(dateRe)?.[0] || v;
    const dateEnd = datePos + rawDate.length;
    const best = findDateLabel({ body, datePos, dateEnd, fieldKey });
    if (!best) {
      return semanticError(fieldKey === 'publish_date'
        ? '日期附近没有“发布日期/发布时间/生成日期/印发日期”等明确标签；落款日期不得作为发布日期'
        : '日期附近没有“施行日期/实施日期/生效日期”等明确标签，也没有“自……起施行/实施/生效”；落款日期不得作为生效日期');
    }
    return { ok: true, label: best.label };
  }

  if (fieldKey === 'threshold') {
    const numMatch = v.match(/[0-9]+(?:\.[0-9]+)?/);
    if (!numMatch) return semanticError('阈值字段值没有数字');
    const num = numMatch[0];
    const vUnit = v.match(UNIT_RE)?.[1] || null;
    const vDir = v.match(DIRECTION_RE)?.[1] || null;

    const occurrences = [];
    for (const m of q.matchAll(new RegExp(num.replace('.', '\\.'), 'g'))) {
      const start = m.index ?? 0;
      const end = start + num.length;
      const after = q.slice(end, end + 12);
      const before = q.slice(Math.max(0, start - 16), start);
      const qUnit = after.match(new RegExp(`^\\s*(${UNIT_RE.source})`, 'i'))?.[1] || null;
      const beforeDirs = [...before.matchAll(new RegExp(DIRECTION_RE.source, 'g'))].map((x) => x[1]);
      const afterDir = after.match(DIRECTION_RE)?.[1] || null;
      const qDir = afterDir || beforeDirs[beforeDirs.length - 1] || null;
      occurrences.push({ start, qUnit, qDir });
    }
    if (!occurrences.length) return semanticError('阈值数字未出现在引句中');

    let chosen = null;
    if (vUnit) {
      chosen = occurrences.find((o) => o.qUnit && normalizeUnit(o.qUnit) === normalizeUnit(vUnit)) || null;
      if (!chosen) return semanticError('字段值含单位，但数字后没有对应单位；不能只用相同数字');
    } else {
      chosen = occurrences.find((o) => !o.qUnit) || null;
      if (!chosen) return semanticError('引句含单位，但字段值没有单位；不能只用相同数字');
    }
    if (vUnit && chosen.qUnit && normalizeUnit(chosen.qUnit) !== normalizeUnit(vUnit)) {
      return semanticError(`单位不一致：引句为 ${chosen.qUnit}，字段值为 ${vUnit}`);
    }

    const qDirKey = normalizeDirection(chosen.qDir);
    const vDirKey = normalizeDirection(vDir);
    if (qDirKey && !vDirKey) return semanticError('引句含方向，但字段值没有方向；不能丢失“低于/高于”等语义');
    if (vDirKey && !qDirKey) return semanticError('字段值含方向，但数字附近没有对应方向；不能只凭相同数字');
    if (qDirKey && vDirKey && qDirKey !== vDirKey) {
      return semanticError(`方向不一致：引句为 ${chosen.qDir}，字段值为 ${vDir}`);
    }
    return { ok: true };
  }
  return { ok: true };
}

/** 写入一条证据；invalid 记录保留审计但不进入前台。 */
export function upsertFieldEvidence({
  entityType, entityId, bodyHash, fieldKey, fieldValue, valueType = 'text', quote,
  charStart = null, charEnd = null, utf16Start = null, utf16End = null, page = null,
  method, model = null, providerId = null, promptVersion = null, extractorVersion = null,
  text, actor = 'system:field-evidence',
}) {
  const now = nowIso();
  const verdict = validateQuote(text, quote, {
    charStart, charEnd, utf16Start, utf16End, value: fieldValue, valueType,
  });
  const semantic = verdict.ok
    ? validateFieldSemantics({
        fieldKey, value: fieldValue, quote, text, utf16Start: verdict.utf16_start, utf16End: verdict.utf16_end,
      })
    : null;
  const valid = verdict.ok && (!semantic || semantic.ok);
  const status = valid ? 'valid' : 'invalid';
  const error = valid ? null : (verdict.ok ? semantic?.error : verdict.error);
  const id = newId('FEV');
  run(
    `INSERT INTO field_evidence
       (id,entity_type,entity_id,body_hash,field_key,field_label,field_value,value_type,quote,
        char_start,char_end,utf16_start,utf16_end,offset_unit,page,method,model,provider_id,
        prompt_version,extractor_version,status,validation_error,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(entity_type,entity_id,body_hash,field_key,method,quote) DO UPDATE SET
       field_value=excluded.field_value, value_type=excluded.value_type,
       char_start=excluded.char_start, char_end=excluded.char_end,
       utf16_start=excluded.utf16_start, utf16_end=excluded.utf16_end,
       page=excluded.page, model=excluded.model, provider_id=excluded.provider_id,
       prompt_version=excluded.prompt_version, extractor_version=excluded.extractor_version,
       status=excluded.status, validation_error=excluded.validation_error, updated_at=excluded.updated_at`,
    [
      id, entityType, String(entityId), bodyHash, fieldKey, fieldLabel(fieldKey), String(fieldValue),
      valueType, String(quote), valid ? verdict.start : null, valid ? verdict.end : null,
      valid ? verdict.utf16_start : null, valid ? verdict.utf16_end : null,
      'unicode_code_point', page, method, model, providerId, promptVersion, extractorVersion,
      status, error, now, now,
    ]
  );
  if (!valid) {
    audit({
      actor, action: 'field_evidence.rejected', objectType: entityType, objectId: String(entityId),
      detail: { field: fieldKey, method, error, quote: String(quote).slice(0, 160) },
    });
  }
  return {
    id, ok: valid, status, error,
    char_start: valid ? verdict.start : null, char_end: valid ? verdict.end : null,
    utf16_start: valid ? verdict.utf16_start : null, utf16_end: valid ? verdict.utf16_end : null,
  };
}

/** 正文变化后，旧证据全部 stale（保留原始记录，不删除）。 */
export function markFieldsStale(entityType, entityId, reason = '正文变化：字段引句证据失效') {
  return run(
    `UPDATE field_evidence SET status='stale', validation_error=?, updated_at=?
      WHERE entity_type=? AND entity_id=? AND status='valid'`,
    [reason, nowIso(), entityType, String(entityId)]
  );
}

/** 确定性抽取并落库；返回实际写入的有效字段与拒绝数。 */
export function extractDeterministicFields(entityType, entityId, {
  text = null, bodyHash = null, actor = 'system:field-evidence', markStale = false,
} = {}) {
  const loaded = text === null ? loadEntityBody(entityType, entityId) : null;
  const body = text === null ? loaded?.text || '' : cleanText(text);
  const hash = bodyHash || loaded?.body_hash || sha256Text(body);
  if (!body) return { ok: false, reason: 'no_body', fields: [], rejected: 0, method: 'deterministic_rule' };
  if (markStale) markFieldsStale(entityType, entityId, '正文变化：重新执行确定性字段抽取');
  const candidates = extractDeterministicCandidates(body);
  const fields = [];
  let rejected = 0;
  for (const c of candidates) {
    const r = upsertFieldEvidence({
      entityType, entityId, bodyHash: hash, fieldKey: c.field_key, fieldValue: c.field_value,
      valueType: c.value_type, quote: c.quote, charStart: c.char_start, charEnd: c.char_end,
      utf16Start: c.utf16_start, utf16End: c.utf16_end, page: c.page,
      method: 'deterministic_rule', extractorVersion: 'det-field-p1', text: body, actor,
    });
    if (r.ok) fields.push({ ...c, id: r.id, status: r.status });
    else rejected += 1;
  }
  audit({
    actor, action: 'field_evidence.deterministic_extract', objectType: entityType, objectId: String(entityId),
    detail: { fields: fields.length, rejected, body_hash: hash },
  });
  return { ok: true, method: 'deterministic_rule', fields, rejected, body_hash: hash };
}

/** 读取当前有效字段；旧 body_hash 自动标 stale。 */
export function getFieldEvidence(entityType, entityId) {
  const loaded = loadEntityBody(entityType, entityId);
  const currentHash = loaded?.body_hash || null;
  if (currentHash) {
    run(
      `UPDATE field_evidence SET status='stale', validation_error=?, updated_at=?
        WHERE entity_type=? AND entity_id=? AND status='valid' AND body_hash<>?`,
      ['正文已变化：旧字段证据不再对应当前正文', nowIso(), entityType, String(entityId), currentHash]
    );
    // 规则/语义收紧后，旧记录即使同 body_hash 也要按当前规则重新校验；
    // 不符合的旧 valid 不得继续展示。这里只做读取时的确定性复核，不调用模型。
    if (loaded?.text) {
      const currentRows = all(
        `SELECT * FROM field_evidence
          WHERE entity_type=? AND entity_id=? AND status='valid' AND body_hash=?`,
        [entityType, String(entityId), currentHash]
      );
      for (const r of currentRows) {
        const verdict = validateQuote(loaded.text, r.quote, {
          charStart: r.char_start, charEnd: r.char_end,
          utf16Start: r.utf16_start, utf16End: r.utf16_end,
          value: r.field_value, valueType: r.value_type,
        });
        const semantic = verdict.ok
          ? validateFieldSemantics({
              fieldKey: r.field_key, value: r.field_value, quote: r.quote, text: loaded.text,
              utf16Start: verdict.utf16_start, utf16End: verdict.utf16_end,
            })
          : null;
        if (!verdict.ok || (semantic && !semantic.ok)) {
          run(
            `UPDATE field_evidence SET status='invalid', validation_error=?, updated_at=? WHERE id=?`,
            [`规则升级后重新校验未通过：${verdict.ok ? semantic?.error : verdict.error}`, nowIso(), r.id]
          );
        }
      }
    }
  }
  const rows = all(
    `SELECT * FROM field_evidence WHERE entity_type=? AND entity_id=? AND status='valid'
      ORDER BY field_key, char_start`,
    [entityType, String(entityId)]
  );
  const counts = get(
    `SELECT SUM(CASE WHEN status='stale' THEN 1 ELSE 0 END) stale,
            SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) invalid
       FROM field_evidence WHERE entity_type=? AND entity_id=?`,
    [entityType, String(entityId)]
  ) || { stale: 0, invalid: 0 };
  return {
    fields: rows.map((r) => ({
      id: r.id, field: r.field_key, field_key: r.field_key,
      label: r.field_label || fieldLabel(r.field_key),
      value: r.field_value, field_value: r.field_value, value_type: r.value_type,
      quote: r.quote,
      char_start: r.char_start, char_end: r.char_end,
      utf16_start: r.utf16_start, utf16_end: r.utf16_end, offset_unit: r.offset_unit,
      page: r.page, method: r.method, model: r.model, provider_id: r.provider_id,
      prompt_version: r.prompt_version, extractor_version: r.extractor_version,
      body_hash: r.body_hash, status: r.status, created_at: r.created_at,
      mention_only: !!FIELD_DEFS[r.field_key]?.mention_only,
      scope_warning: FIELD_DEFS[r.field_key]?.scope_warning || null,
    })),
    body_hash: currentHash,
    stale: Number(counts.stale || 0),
    invalid: Number(counts.invalid || 0),
    note: '字段引句为原文连续片段；char_start/end 为 Unicode 码点偏移。地区/行业仅表示正文提及，' +
      '不代表官方适用范围；日期必须带明确标签，阈值必须同时核对方向与单位。' +
      '模型抽取记录 method=model，不冒充官方事实。',
  };
}

export function fieldCounts(entityType, entityId) {
  return get(
    `SELECT COUNT(*) total, SUM(CASE WHEN status='valid' THEN 1 ELSE 0 END) valid,
            SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) invalid,
            SUM(CASE WHEN status='stale' THEN 1 ELSE 0 END) stale
       FROM field_evidence WHERE entity_type=? AND entity_id=?`,
    [entityType, String(entityId)]
  ) || { total: 0, valid: 0, invalid: 0, stale: 0 };
}

function buildModelPrompt(body, title) {
  const max = 12000;
  const clipped = body.length > max;
  return [
    '请从下面公开正文中抽取结构字段，并给出可逐字定位的原文引句。',
    '只输出 JSON，格式：{"fields":[{"field":"region|industry|year|methodology_code|threshold|publish_date|effective_date","value":"字段值","quote":"正文中逐字连续的引句"}]}。',
    '规则：',
    '1) quote 必须从正文原样复制，不能改写、拼接、概括或添加省略号；',
    '2) value 必须能在 quote 中核对（日期用 YYYY-MM-DD，但 quote 保留原文写法）；',
    '3) 没有明确依据就不要输出该字段；不要猜测；',
    '4) region / industry 只表示正文“提及”，不代表官方适用范围，不得据此推断项目合格；展示时必须标为“仅提及”；',
    '5) publish_date 附近必须有“发布日期/发布时间/生成日期/印发日期/发布于”等明确标签；纯落款日期或“日期+印发/发布”不算发布日期；',
    '6) effective_date 附近必须有“施行日期/实施日期/生效日期”等明确标签，或“自……起施行/实施/生效”；纯落款日期不算；',
    '7) threshold 的 value 必须同时保留方向（低于/高于/不超过等）和单位，不得只凭相同数字匹配；',
    '8) 模型抽取只是候选证据，不是官方确认。',
    clipped ? `5) 正文超过 ${max} 字符，只提供前 ${max} 字符；超出部分无法引用，请勿编造。` : '',
    '',
    `标题：${String(title || '').slice(0, 300)}`,
    '正文：',
    body.slice(0, max),
  ].filter(Boolean).join('\n');
}

const MODEL_SYSTEM = '你是公开信息字段抽取器。只依据给定正文，逐字复制引句，绝不补写原文。输出 JSON，不要解释。';

/**
 * 后台模型抽取：复用既有 callStructuredModel（含出站校验、配额、重试与 JSON 加固）。
 * 模型伪造/改写引句会被 validateQuote 拒绝，不写入有效证据。
 * @param {{providerId?:string, callModel?:Function, actor?:string, force?:boolean}} opts
 */
export async function extractFieldsWithModel(entityType, entityId, {
  providerId = null, callModel = null, actor = 'system:field-evidence', force = false,
} = {}) {
  const loaded = loadEntityBody(entityType, entityId);
  if (!loaded?.text) return { ok: false, reason: 'no_body', message: '该条目没有可抽取的公开正文，未调用模型。', status: 400 };
  const provider = providerId
    ? get('SELECT * FROM llm_provider WHERE id=? AND enabled=1', [providerId])
    : pickVerifyProvider();
  if (!provider) {
    return {
      ok: false, reason: 'no_provider', status: 400,
      message: '未配置可用模型：字段抽取未执行，确定性字段仍可查看；不会伪造模型结果。',
      deterministic_available: true,
    };
  }
  if (!force) {
    const cached = get(
      `SELECT COUNT(*) c FROM field_evidence
        WHERE entity_type=? AND entity_id=? AND body_hash=? AND method='model' AND status='valid'`,
      [entityType, String(entityId), loaded.body_hash]
    );
    if (Number(cached?.c || 0) > 0) {
      return {
        ok: true, cached: true, method: 'model', model: provider.model,
        fields: getFieldEvidence(entityType, entityId).fields.filter((f) => f.method === 'model'),
        message: '当前正文已有模型字段证据；force=true 可重新抽取。',
      };
    }
  }
  const prompt = buildModelPrompt(loaded.text, loaded.title);
  const out = callModel
    ? await callModel({ provider, prompt, systemPrompt: MODEL_SYSTEM, entityType, entityId, body: loaded.text })
    : await callStructuredModel({
        provider, prompt, systemPrompt: MODEL_SYSTEM,
        requiredFields: { fields: { type: 'array', min_items: 0, max_items: 20, item_type: 'object' } },
        purpose: 'content_field_extract', maxTokens: 1800, timeoutMs: 45000,
        actor, objectType: entityType, objectId: String(entityId),
      });
  if (!out?.ok) {
    return {
      ok: false, reason: out?.reason || 'model_failed',
      message: out?.detail || out?.message || '模型调用失败；未写入任何有效字段。',
      status: out?.reason === 'no_provider' ? 400 : 502,
      rejected: 0,
    };
  }
  const rawFields = Array.isArray(out.parsed?.fields) ? out.parsed.fields : [];
  // 成功得到合法新 JSON 后，本正文的旧模型字段集合整体让位：
  // 包括新 fields=[] / 全部校验拒绝的情况。只有网络/输出失败才保留旧证据。
  run(
    `UPDATE field_evidence SET status='stale', validation_error=?, updated_at=?
      WHERE entity_type=? AND entity_id=? AND method='model' AND status='valid'`,
    ['同正文模型重新抽取成功：旧字段集合已被本次结果替换', nowIso(), entityType, String(entityId)]
  );
  const accepted = [];
  const rejected = [];
  for (const item of rawFields.slice(0, 20)) {
    const key = String(item?.field || '').trim();
    const value = String(item?.value ?? '').trim();
    const quote = String(item?.quote ?? '').trim();
    if (!FIELD_DEFS[key] || !value || !quote) {
      rejected.push({ field: key, value, quote, reason: '字段/值/引句缺失或字段不支持' });
      continue;
    }
    const verdict = validateQuote(loaded.text, quote, { value, valueType: FIELD_DEFS[key].type });
    if (!verdict.ok) {
      rejected.push({ field: key, value, quote, reason: verdict.error });
      continue;
    }
    const saved = upsertFieldEvidence({
      entityType, entityId, bodyHash: loaded.body_hash, fieldKey: key, fieldValue: value,
      valueType: FIELD_DEFS[key].type, quote, charStart: verdict.start, charEnd: verdict.end,
      utf16Start: verdict.utf16_start, utf16End: verdict.utf16_end, page: null,
      method: 'model', model: provider.model, providerId: provider.id,
      promptVersion: FIELD_PROMPT_VERSION, extractorVersion: MODEL_EXTRACTOR_VERSION,
      text: loaded.text, actor,
    });
    if (saved.ok) accepted.push({ field: key, value, quote, method: 'model', model: provider.model });
    else rejected.push({ field: key, value, quote, reason: saved.error });
  }
  audit({
    actor, action: 'field_evidence.model_extract', objectType: entityType, objectId: String(entityId),
    detail: { model: provider.model, provider_id: provider.id, accepted: accepted.length, rejected: rejected.length },
  });
  return {
    ok: accepted.length > 0,
    method: 'model', model: provider.model, provider_id: provider.id,
    prompt_version: FIELD_PROMPT_VERSION,
    accepted: accepted.length,
    rejected: rejected.length,
    fields: accepted,
    rejected_items: rejected,
    message: accepted.length
      ? '模型字段已写入；每条均通过原文连续片段校验，仍属候选证据，不是官方确认。'
      : '模型未给出可定位的真实引句；已全部拒绝，未写入有效字段。',
  };
}

export { ENTITY_TYPES };
