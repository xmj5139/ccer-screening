/**
 * 确定性规则引擎
 * ============================================================================
 * 设计原则（对应设计文档第 1、6 节）：
 *   - 规则以「JSON 表达式树」存储并执行，绝不使用 eval，绝不由大模型生成判断结果。
 *   - 判断结果为三态：PASS（通过）/ FAIL（不通过）/ UNKNOWN（待核实）。
 *   - 事实存在但证据不满足规则的 evidence_policy 时，结果为 UNKNOWN 而非 PASS。
 *     （文档第 6 节：「日期和义务状态必须有证据，不能仅凭业主自述直接判'通过'」）
 *   - 每次判断输出可点击依据：rule_id、条款页码、事实值、证据 ID、判断时间。
 *
 * 表达式节点（op）：
 *   const            { op:'const', value:boolean }
 *   fact             { op:'fact', field }                       —— 取值（不判断）
 *   exists           { op:'exists', field }
 *   missing          { op:'missing', field }
 *   eq/ne            { op:'eq', field, value }
 *   in / not_in      { op:'in', field, values:[...] }
 *   gt/gte/lt/lte    { op:'gt', field, value }
 *   date_after       { op:'date_after', field, value }          —— 严格晚于
 *   date_on_or_after { op:'date_on_or_after', field, value }
 *   date_before      { op:'date_before', field, value }
 *   date_on_or_before{ op:'date_on_or_before', field, value }
 *   is_true/is_false { op:'is_true', field }
 *   contains_any     { op:'contains_any', field, values:[...] } —— 文本/数组字段包含任一
 *   any_of / all_of  { op:'any_of'|'all_of', field, values }    —— 同 contains_any 的多值语义
 *   and/or/not
 *   within_years     { op:'within_years', field, years, ref_field? } —— 相对分析基准日的年限窗
 */
import { isDate, compareDate } from '../core/util.mjs';

export const PASS = 'pass';
export const FAIL = 'fail';
export const UNKNOWN = 'unknown';

/** 可作为「严格证据」的来源类型 */
export const STRICT_EVIDENCE_KINDS = new Set(['official', 'project_doc']);
/** 完全不能用于判断的来源类型（模型假设只能进情景） */
export const NON_JUDGING_KINDS = new Set(['assumption']);

const TRUTHY = new Set(['true', 'yes', '1', 'y', '是', '有', 'true ']);

function coerceBool(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === '') return null;
  if (TRUTHY.has(s)) return true;
  if (['false', 'no', '0', 'n', '否', '无'].includes(s)) return false;
  return null;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function arr(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p)) return p;
    } catch {
      /* fall through */
    }
  }
  return s
    .split(/[;,，、|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 事实访问器：把 project_fact 行包装为可判断对象，并执行证据策略。
 */
export class FactStore {
  /**
   * @param {Array<{field_key:string,value_text:string,value_num:number,value_type:string,
   *                source_kind:string,evidence_id:string,unit:string,asserted_at:string}>} rows
   * @param {Map<string,{file_name:string,page:number,excerpt:string}>} evidenceById
   */
  constructor(rows, evidenceById = new Map()) {
    this.map = new Map();
    for (const r of rows) this.map.set(r.field_key, r);
    this.evidence = evidenceById;
  }

  raw(field) {
    return this.map.get(field) || null;
  }

  /** 值语义取值：按 value_type 返回 date/number/bool/string/array */
  value(field) {
    const r = this.raw(field);
    if (!r) return null;
    if (r.value_type === 'number') {
      const n = toNum(r.value_num !== null && r.value_num !== undefined ? r.value_num : r.value_text);
      return n;
    }
    if (r.value_type === 'bool') return coerceBool(r.value_text);
    if (r.value_type === 'multi') return arr(r.value_text);
    const t = r.value_text;
    return t === undefined || t === null || t === '' ? null : t;
  }

  /**
   * 判断该字段在当前证据策略下是否「可用于判定」。
   * @returns {{usable:boolean, reason?:string, kind?:string, evidenceId?:string}}
   */
  usable(field, evidencePolicy) {
    const r = this.raw(field);
    if (!r) return { usable: false, reason: '字段缺失', kind: 'missing' };
    const v = this.value(field);
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) || v === '') {
      return { usable: false, reason: '字段为空', kind: 'empty' };
    }
    if (NON_JUDGING_KINDS.has(r.source_kind)) {
      return {
        usable: false,
        reason: `来源为「${kindLabel(r.source_kind)}」，只能用于情景估算，不能用于条件判定`,
        kind: r.source_kind,
      };
    }
    if (evidencePolicy === 'strict') {
      if (!STRICT_EVIDENCE_KINDS.has(r.source_kind)) {
        return {
          usable: false,
          reason: `该规则要求官方文件或项目资料证据，当前来源为「${kindLabel(r.source_kind)}」`,
          kind: r.source_kind,
        };
      }
      if (!r.evidence_id) {
        return { usable: false, reason: '该规则要求附带证据定位（文件+页码），当前事实无证据', kind: r.source_kind };
      }
      const ev = this.evidence.get(r.evidence_id);
      if (!ev) {
        return { usable: false, reason: '所引用的证据记录不存在（可能已删除）', kind: r.source_kind };
      }
    }
    return { usable: true, kind: r.source_kind, evidenceId: r.evidence_id };
  }

  evidenceOf(field) {
    const r = this.raw(field);
    if (!r || !r.evidence_id) return null;
    const ev = this.evidence.get(r.evidence_id);
    if (!ev) return null;
    return {
      evidence_id: r.evidence_id,
      file_name: ev.file_name,
      doc_type: ev.doc_type,
      page: ev.page,
      line_ref: ev.line_ref,
      excerpt: ev.excerpt,
    };
  }
}

export function kindLabel(kind) {
  return (
    {
      official: '官方文件',
      project_doc: '项目资料',
      owner_claim: '业主自述',
      analyst: '分析师录入',
      assumption: '模型假设',
      missing: '无',
      empty: '无',
    }[kind] || kind
  );
}

class Ctx {
  constructor(facts, policy, baseDate) {
    this.facts = facts;
    this.policy = policy;
    this.baseDate = baseDate;
    this.missing = new Set();
    this.reasons = [];
  }
  touch(field) {
    const u = this.facts.usable(field, this.policy);
    if (!u.usable) {
      this.missing.add(field);
      if (u.reason) this.reasons.push({ field, reason: u.reason, kind: u.kind });
    }
    return u;
  }
}

const LEAF_OPS = new Set([
  'exists', 'missing', 'eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte',
  'date_after', 'date_on_or_after', 'date_before', 'date_on_or_before',
  'is_true', 'is_false', 'contains_any', 'all_of', 'any_of', 'within_years',
]);

/**
 * 递归求值。返回 { state, detail }
 */
function evalNode(node, ctx) {
  if (!node || typeof node !== 'object') return { state: UNKNOWN, detail: '非法表达式节点' };
  const op = node.op;

  if (op === 'const') return { state: node.value ? PASS : FAIL, detail: `常量 ${node.value}` };

  if (op === 'and' || op === 'or') {
    const results = (node.args || []).map((a) => evalNode(a, ctx));
    if (op === 'and') {
      if (results.some((r) => r.state === FAIL)) return { state: FAIL, detail: '存在不满足项' };
      if (results.some((r) => r.state === UNKNOWN)) return { state: UNKNOWN, detail: '存在待核实项' };
      return { state: PASS, detail: '全部满足' };
    }
    if (results.some((r) => r.state === PASS)) return { state: PASS, detail: '存在满足项' };
    if (results.some((r) => r.state === UNKNOWN)) return { state: UNKNOWN, detail: '存在待核实项' };
    return { state: FAIL, detail: '全部不满足' };
  }

  if (op === 'not') {
    const r = evalNode(node.arg, ctx);
    if (r.state === UNKNOWN) return r;
    return { state: r.state === PASS ? FAIL : PASS, detail: `取反(${r.detail})` };
  }

  if (!LEAF_OPS.has(op)) return { state: UNKNOWN, detail: `未知操作符 ${op}` };

  // 复合存在量词节点
  if (op === 'any_of' || op === 'all_of') {
    const field = node.field;
    const u = ctx.touch(field);
    if (!u.usable) return { state: UNKNOWN, detail: u.reason };
    const values = arr(ctx.facts.value(field)).map((x) => String(x).trim());
    const want = (node.values || []).map((x) => String(x).trim());
    const hit = want.filter((w) => values.some((v) => v === w || v.includes(w)));
    if (op === 'any_of') {
      return hit.length
        ? { state: PASS, detail: `命中：${hit.join('、')}` }
        : { state: FAIL, detail: `未命中任何要求值（要求：${want.join('、')}；实际：${values.join('、')}）` };
    }
    const miss = want.filter((w) => !hit.includes(w));
    return miss.length
      ? { state: FAIL, detail: `缺少：${miss.join('、')}` }
      : { state: PASS, detail: `全部命中：${hit.join('、')}` };
  }

  const field = node.field;
  const u = ctx.touch(field);
  if (!u.usable) {
    if (op === 'exists') return { state: FAIL, detail: u.reason || '字段缺失' };
    if (op === 'missing') return { state: PASS, detail: '確认字段缺失' };
    return { state: UNKNOWN, detail: u.reason || '待核实' };
  }
  const v = ctx.facts.value(field);

  switch (op) {
    case 'exists':
      return { state: PASS, detail: '字段存在且证据满足' };
    case 'missing':
      return { state: FAIL, detail: '字段存在' };
    case 'is_true': {
      if (v === true) return { state: PASS, detail: '为真' };
      if (v === false) return { state: FAIL, detail: '为假' };
      return { state: UNKNOWN, detail: `无法解析为布尔值：${v}` };
    }
    case 'is_false': {
      if (v === false) return { state: PASS, detail: '为假' };
      if (v === true) return { state: FAIL, detail: '为真' };
      return { state: UNKNOWN, detail: `无法解析为布尔值：${v}` };
    }
    case 'eq':
      return v === node.value || String(v) === String(node.value)
        ? { state: PASS, detail: `= ${node.value}` }
        : { state: FAIL, detail: `实际为 ${fmt(v)}，要求 = ${node.value}` };
    case 'ne':
      return String(v) !== String(node.value)
        ? { state: PASS, detail: `≠ ${node.value}` }
        : { state: FAIL, detail: `实际为 ${fmt(v)}，要求 ≠ ${node.value}` };
    case 'in': {
      const vs = (node.values || []).map(String);
      return vs.includes(String(v))
        ? { state: PASS, detail: `属于 {${vs.join('、')}}` }
        : { state: FAIL, detail: `实际为 ${fmt(v)}，不在 {${vs.join('、')}}` };
    }
    case 'not_in': {
      const vs = (node.values || []).map(String);
      return !vs.includes(String(v))
        ? { state: PASS, detail: `不属于 {${vs.join('、')}}` }
        : { state: FAIL, detail: `实际为 ${fmt(v)}，属于排除集 {${vs.join('、')}}` };
    }
    case 'contains_any': {
      const values = arr(v).map(String);
      const want = (node.values || []).map(String);
      const hit = want.filter((w) => values.some((x) => x === w || x.includes(w)));
      return hit.length
        ? { state: PASS, detail: `命中：${hit.join('、')}` }
        : { state: FAIL, detail: `未命中任何要求值（要求：${want.join('、')}；实际：${values.join('、') || '空'}）` };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const n = toNum(v);
      const t = toNum(node.value);
      if (n === null || t === null) return { state: UNKNOWN, detail: `无法比较：${fmt(v)} 与 ${node.value}` };
      const ok =
        op === 'gt' ? n > t : op === 'gte' ? n >= t : op === 'lt' ? n < t : n <= t;
      const sym = { gt: '>', gte: '≥', lt: '<', lte: '≤' }[op];
      return ok
        ? { state: PASS, detail: `${n} ${sym} ${t}` }
        : { state: FAIL, detail: `实际 ${n}，要求 ${sym} ${t}` };
    }
    case 'date_after':
    case 'date_on_or_after':
    case 'date_before':
    case 'date_on_or_before': {
      const c = compareDate(String(v), String(node.value));
      if (c === null) return { state: UNKNOWN, detail: `日期无法解析：${fmt(v)} 与 ${node.value}` };
      const ok =
        op === 'date_after' ? c > 0
        : op === 'date_on_or_after' ? c >= 0
        : op === 'date_before' ? c < 0
        : c <= 0;
      const sym = { date_after: '晚于', date_on_or_after: '不早于', date_before: '早于', date_on_or_before: '不晚于' }[op];
      return ok
        ? { state: PASS, detail: `${v} ${sym} ${node.value}` }
        : { state: FAIL, detail: `实际 ${v}，要求${sym} ${node.value}` };
    }
    case 'within_years': {
      // 以 baseDate（分析基准日）为参照的年限窗口
      const ref = node.ref_field ? ctx.facts.value(node.ref_field) : ctx.baseDate;
      if (!isDate(String(v)) || !isDate(String(ref))) return { state: UNKNOWN, detail: '日期缺失，无法计算年限窗' };
      const years = Number(node.years);
      const [sy] = String(v).split('-').map(Number);
      const [ry] = String(ref).split('-').map(Number);
      const diff = ry - sy;
      const ok = node.mode === 'before' ? diff <= years : diff >= 0 && diff <= years;
      return ok
        ? { state: PASS, detail: `距基准日 ${diff} 年，窗口 ${years} 年` }
        : { state: FAIL, detail: `距基准日 ${diff} 年，超出 ${years} 年窗口` };
    }
    default:
      return { state: UNKNOWN, detail: `未实现的操作符 ${op}` };
  }
}

function fmt(v) {
  if (v === null || v === undefined) return '（空）';
  if (Array.isArray(v)) return v.join('、');
  return String(v);
}

/**
 * 执行单条规则。
 * @param {object} rule rule 表行（含 expr / evidence_policy / required_fields）
 * @param {FactStore} facts
 * @param {{baseDate:string}} opts
 * @returns {{rule_id:string, title:string, layer:string, state:string, detail:string,
 *            severity:string, condition_text:string, expression_text:string,
 *            clause_ref:string, evidence_policy:string, missing_fields:string[],
 *            unknown_reasons:object[], fact_value:any, evidence:object|null,
 *            judged_at:string}}
 */
export function evaluateRule(rule, facts, opts = {}) {
  const expr = typeof rule.expr === 'string' ? JSON.parse(rule.expr) : rule.expr;
  const policy = rule.evidence_policy || 'normal';
  const ctx = new Ctx(facts, policy, opts.baseDate || null);
  let res;
  try {
    res = evalNode(expr, ctx);
  } catch (e) {
    res = { state: UNKNOWN, detail: `规则执行异常：${e.message}` };
  }

  const requiredFields = safeArr(rule.required_fields);
  for (const f of requiredFields) ctx.touch(f);

  // 规则带 required_fields 时，任一必需字段不可用 => 强制 UNKNOWN（不能凭推断判通过）
  if (res.state !== UNKNOWN && requiredFields.length) {
    const bad = requiredFields.filter((f) => !facts.usable(f, policy).usable);
    if (bad.length) {
      res = { state: UNKNOWN, detail: `必需字段不可用：${bad.join('、')}` };
      bad.forEach((f) => ctx.missing.add(f));
    }
  }

  // 主字段（第一个 fact 节点引用的字段）用于展示事实值与证据
  const primary = requiredFields[0] || firstField(expr);
  const factRow = primary ? facts.raw(primary) : null;

  return {
    rule_id: rule.rule_id,
    title: rule.title,
    layer: rule.layer,
    state: res.state,
    detail: res.detail,
    severity: rule.severity,
    condition_text: rule.condition_text,
    expression_text: rule.expression_text,
    clause_ref: rule.clause_ref || null,
    evidence_policy: policy,
    evidence_requirement: rule.evidence_requirement || null,
    fail_conclusion: rule.fail_conclusion || null,
    missing_fields: [...ctx.missing],
    unknown_reasons: dedupeReasons(ctx.reasons),
    fact_field: primary || null,
    fact_value: primary ? facts.value(primary) : null,
    fact_source_kind: factRow ? factRow.source_kind : null,
    fact_asserted_at: factRow ? factRow.asserted_at : null,
    evidence: primary ? facts.evidenceOf(primary) : null,
    judged_at: new Date().toISOString(),
    rule_version: rule.methodology_version_id || 'common',
  };
}

function dedupeReasons(reasons) {
  const seen = new Set();
  const out = [];
  for (const r of reasons) {
    const k = `${r.field}|${r.reason}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function firstField(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.field === 'string') return node.field;
  if (Array.isArray(node.args)) {
    for (const a of node.args) {
      const f = firstField(a);
      if (f) return f;
    }
  }
  if (node.arg) return firstField(node.arg);
  return null;
}

function safeArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

/** 汇总：给定规则结果集合，导出结论与统计 */
export function summarize(results) {
  const blockingFails = results.filter((r) => r.state === FAIL && r.severity === 'blocking');
  const majorFails = results.filter((r) => r.state === FAIL && r.severity === 'major');
  const unknown = results.filter((r) => r.state === UNKNOWN);
  const unknownBlocking = unknown.filter((r) => r.severity === 'blocking' || r.severity === 'major');
  return {
    pass: results.filter((r) => r.state === PASS).length,
    fail: results.filter((r) => r.state === FAIL).length,
    unknown: unknown.length,
    blocking_failures: blockingFails.length,
    major_failures: majorFails.length,
    unknown_blocking: unknownBlocking.length,
    blocking_fail_list: blockingFails.map((r) => ({ rule_id: r.rule_id, title: r.title, detail: r.detail })),
    unknown_list: unknown.map((r) => ({
      rule_id: r.rule_id,
      title: r.title,
      missing_fields: r.missing_fields,
      reasons: r.unknown_reasons,
    })),
  };
}

/**
 * 由规则汇总导出四态结论（设计文档第 6 节枚举）。
 * @param {object} s summarize() 结果
 * @param {{hasFormalCandidate:boolean}} ctx
 */
export function conclude(s, ctx = {}) {
  if (ctx.hasFormalCandidate === false) return '无已发布适用方法学';
  if (s.blocking_failures > 0) return '存在明确障碍';
  if (s.unknown_blocking > 0) return '资料不足暂无法判断';
  return '可继续尽调';
}
