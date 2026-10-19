/**
 * CEA API 查询参数统一校验（阶段B 尾项4）
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md「API契约」与阶段B任务书第 4 条：
 *   「统一校验 from/to 真实日期、倒置范围、limit/offset/year、dataset/format 等；
 *     错误返回 400，不默认吞掉非法参数。」
 *
 * 设计原则：
 *   1. **不做静默兜底**：`limit=abc`、`from=2026-13-45`、`year=abc` 一律 400，
 *      不回退成默认值——静默吞掉非法参数会让调用方以为筛选生效了。
 *   2. 空字符串/未提供（undefined、null）视为「未筛选」，这是正常用法，不报错。
 *   3. 范围倒置（from > to）返回 400，不自动交换。
 *   4. 只有明确的枚举值才放行（dataset/format/granularity/day_type/direction 等）。
 *   5. 所有错误结构一致：{ error, parameter, value, allowed? }，HTTP 400。
 */

export const CEA_LIMITS = {
  trade: { min: 1, max: 2000, def: 200 },
  offset: { min: 0, max: 1_000_000, def: 0 },
  generic: { min: 1, max: 2000, def: 200 },
  series: { min: 1, max: 2000, def: 2000 },
  comparison: { min: 1, max: 2000, def: 180 },
  history: { min: 1, max: 2000, def: 200 },
};

export const CEA_DATASETS = ['trade', 'entities', 'intentions', 'documents', 'events', 'research', 'price_history', 'calendar'];
export const CEA_FORMATS = ['csv', 'json'];
export const CEA_GRANULARITY = ['day', 'month'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格校验 YYYY-MM-DD（必须是真实存在的日期，2026-02-30 之类拒绝） */
export function isRealIsoDate(v) {
  const s = String(v ?? '').trim();
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

const err = (parameter, value, message, allowed = undefined) => ({
  error: `参数 ${parameter} 不合法：${message}`,
  parameter,
  value: value === undefined ? null : value,
  ...(allowed ? { allowed } : {}),
  status: 400,
});

/**
 * 校验一组查询参数。
 * @param {object} query 原始查询对象（ctx.query）
 * @param {{dates?:string[], ints?:Array<string|{name:string,min?:number,max?:number,def?:number,required?:boolean}>,
 *          enums?:Record<string,string[]>, range?:[string,string]|null, passthrough?:string[]}} spec
 * @returns {{ok:true, values:object} | {ok:false, error:object}}
 */
export function validateCeaParams(query = {}, spec = {}) {
  const values = {};
  // 1) 日期参数
  for (const name of spec.dates || []) {
    const raw = query[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    if (!isRealIsoDate(raw)) return { ok: false, error: err(name, raw, '须为真实存在的日期，格式 YYYY-MM-DD') };
    values[name] = String(raw).trim();
  }
  // 2) 整数参数（含 limit/offset/year）
  for (const item of spec.ints || []) {
    const cfg = typeof item === 'string' ? { name: item } : item;
    const raw = query[cfg.name];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      if (cfg.required) return { ok: false, error: err(cfg.name, raw, '必填') };
      if (cfg.def !== undefined) values[cfg.name] = cfg.def;
      continue;
    }
    const s = String(raw).trim();
    if (!/^[+-]?\d+$/.test(s)) return { ok: false, error: err(cfg.name, raw, '须为整数') };
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return { ok: false, error: err(cfg.name, raw, '超出安全整数范围') };
    if (cfg.min !== undefined && n < cfg.min) return { ok: false, error: err(cfg.name, raw, `不得小于 ${cfg.min}`) };
    if (cfg.max !== undefined && n > cfg.max) return { ok: false, error: err(cfg.name, raw, `不得大于 ${cfg.max}`) };
    values[cfg.name] = n;
  }
  // 3) 枚举参数
  for (const [name, allowed] of Object.entries(spec.enums || {})) {
    const raw = query[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const v = String(raw).trim();
    if (!allowed.includes(v)) return { ok: false, error: err(name, raw, `只接受 ${allowed.join(' | ')}`, allowed) };
    values[name] = v;
  }
  // 4) 范围倒置
  if (spec.range) {
    const [fromName, toName] = spec.range;
    const from = values[fromName];
    const to = values[toName];
    if (from && to && from > to) {
      return { ok: false, error: err(`${fromName}/${toName}`, `${from} ~ ${to}`, '起始日期晚于结束日期（范围倒置），不自动交换') };
    }
  }
  // 5) 原样透传（已单独校验过的字段，如 q 搜索词）
  for (const name of spec.passthrough || []) {
    const raw = query[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    values[name] = String(raw).trim().slice(0, 200);
  }
  return { ok: true, values };
}

/** 便捷封装：校验失败直接返回 {status:400, body}，成功返回 {values} */
export function guardCeaParams(query, spec) {
  const out = validateCeaParams(query, spec);
  if (!out.ok) return { denied: { status: 400, body: out.error } };
  return out;
}
