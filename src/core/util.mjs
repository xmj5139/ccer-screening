/**
 * 通用工具：ID、时间、JSON 安全读写、数值与单位处理。
 * 无第三方依赖。
 */
import { randomUUID } from 'node:crypto';

export const APP_TZ = 'Asia/Shanghai';

/** 生成带前缀的稳定 ID：PRE-<时间有序>-<随机段> */
export function newId(prefix) {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${prefix}-${ts}-${rand}`;
}

/** ISO 时间戳（本地时区偏移保留为 +08:00 语义，实际存 UTC ISO） */
export function nowIso() {
  return new Date().toISOString();
}

/** 取日期部分 YYYY-MM-DD（按东八区） */
export function todayCst() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * 把多种日期写法归一为 YYYY-MM-DD。
 * 支持：YYYY-MM-DD、YYYY/MM/DD、YYYYMMDD、Date 对象、ISO 时间戳。无法解析时回退到今日。
 */
export function toIsoDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return new Date(input.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
  if (typeof input === 'string') {
    const s = input.trim();
    if (isDate(s)) return s;
    let m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
    if (m) {
      return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    }
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  }
  return todayCst();
}

/** 比较两个 YYYY-MM-DD 字符串：a<b => -1, a>b => 1, 相等 => 0；非法返回 null */
export function compareDate(a, b) {
  if (!isDate(a) || !isDate(b)) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addYears(dateStr, years) {
  if (!isDate(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const ny = y + Number(years);
  const dim = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  const nd = Math.min(d, dim);
  return `${String(ny).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export function yearOf(dateStr) {
  return isDate(dateStr) ? Number(dateStr.slice(0, 4)) : null;
}

export function safeJsonParse(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export const j = (v) => JSON.stringify(v === undefined ? null : v);
export const uj = (v, fallback = null) => safeJsonParse(v, fallback);

/** 四舍五入到 n 位（返回值仍是 number） */
export function round(v, n = 6) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const f = 10 ** n;
  return Math.round((v + Number.EPSILON) * f) / f;
}

/** 保守取整：按方法学舍入要求向「减排量较小」方向取整 */
export function roundConservative(v, decimals = 0) {
  if (v === null || Number.isNaN(v)) return null;
  const f = 10 ** decimals;
  const scaled = v * f;
  const floored = Math.floor(scaled + 1e-9);
  return floored / f;
}

/**
 * node:sqlite 只接受 null | number | bigint | string | Uint8Array。
 * 这里统一把 undefined / boolean / object 归一化，避免绑定报错。
 */
export function bind(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

/** 把一行记录里的 0/1 还原为 boolean 的字段集合 */
export function rowToBool(row, keys) {
  for (const k of keys) if (k in row) row[k] = !!row[k];
  return row;
}

export function pct(a, b) {
  if (!b) return null;
  return round((a / b - 1) * 100, 2);
}

export function groupBy(arr, fn) {
  const out = new Map();
  for (const item of arr) {
    const k = fn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

export function sum(arr, fn = (x) => x) {
  return arr.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
}

/** 数值区间校验：超出合理范围返回 { ok:false, reason } */
export function checkRange(value, min, max) {
  if (value === null || value === undefined || value === '') return { ok: false, reason: '缺失' };
  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, reason: '非数值' };
  if (min !== null && min !== undefined && n < min) return { ok: false, reason: `低于合理下限 ${min}` };
  if (max !== null && max !== undefined && n > max) return { ok: false, reason: `高于合理上限 ${max}` };
  return { ok: true, value: n };
}

/* ------------------------------------------------------------------ */
/*  展示层文案净化（历史人工流程措辞 → 自动运行口径）                    */
/* ------------------------------------------------------------------ */

/**
 * 旧库中的 data_gap / data_reconciliation / alert 等记录写于人工审批时代，
 * 含「人工核对」「领域专家签字」「待领域复核」等字样。平台**不改写、不删除**
 * 这些原始证据（数据库保持原样），但界面与接口展示必须体现现行口径：
 * 采集、核验、发布全部自动化（docs/22 第 16 条）。本函数只作用于返回值。
 */
const LEGACY_WORDING_RULES = [
  [/待领域复核签字|领域复核签字|领域专家签字|专家签字|领域签字/g, '自动核验结论'],
  [/人工核对与导入/g, '自动采集'],
  // 「无人工待办 / 不设人工待办」本身就是现行口径，不能被改写成「无自动运行状态」
  // 之类的病句（前置否定的形式必须先于下面的「人工待办 → 自动运行状态」规则排除）。
  [/(?<!无)(?<!不设)人工待办|人工任务/g, '自动运行状态'],
  [/人工核对|人工复核|人工确认|人工补录|人工摘录/g, '自动核对'],
  [/人工路径\s*[：:]/g, '自动处理：'],
  [/须由研究员|须人工|需人工/g, '由每日自动任务'],
  [/待人工/g, '待自动'],
];

export function sanitizeLegacyWording(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  for (const [re, replacement] of LEGACY_WORDING_RULES) out = out.replace(re, replacement);
  return out;
}

/** 递归净化对象/数组中的字符串（用于接口返回前的统一处理） */
export function sanitizeDeep(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') return sanitizeLegacyWording(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v, depth + 1);
    return out;
  }
  return value;
}
