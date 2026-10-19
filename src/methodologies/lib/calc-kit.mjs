/**
 * 计算插件公共工具（calc-kit）
 * ============================================================================
 * 【纪律】这里只放与具体方法学无关的**数值与校验工具**。
 * 任何方法学专属的公式、基准线、扣减、排放因子、GWP 取值、舍入规则，
 * 都必须由各插件在本目录下自行声明，并从该方法学及其指定引用文件取值。
 * 通用计算链（设计文档第 7 节）不是任何方法学的官方公式，仅用于组织计算顺序。
 *
 * 插件接口（详见 docs/07-计算插件接口规范.md）：
 *   plugin = {
 *     plugin_key, plugin_version, methodology_id, methodology_version, title,
 *     formula_refs[], parameters[], scenarios{}, factors[],
 *     validate(inputs, ctx) -> { errors[], warnings[] },
 *     compute(inputs, ctx)  -> { steps[], annual[], crediting{}, assumptions[], missing[], sensitivity[] },
 *     selfCheckSamples[]
 *   }
 */
import { round, roundConservative, checkRange, isDate } from '../../core/util.mjs';

export const SCENARIOS = ['conservative', 'base', 'optimistic'];
export const SCENARIO_LABELS = {
  conservative: '保守情景',
  base: '基准情景',
  optimistic: '乐观情景',
};

/** 计算步骤：每一步都必须能追到公式、代入值、单位与因子来源 */
export function step(no, {
  title,
  formula,
  symbolic,
  substitution,
  result,
  unit,
  factorRefs = [],
  clauseRef = null,
  note = null,
  factorStatus = null,
}) {
  return {
    step_no: no,
    title,
    formula,
    symbolic: symbolic || null,
    substitution: substitution || null,
    result: typeof result === 'number' ? round(result, 10) : result,
    unit: unit || null,
    factor_refs: factorRefs,
    clause_ref: clauseRef,
    note,
    factor_status: factorStatus,
  };
}

/** 因子注册表：只读快照，保证可复算 */
export class FactorRegistry {
  constructor(rows) {
    this.map = new Map();
    for (const r of rows) this.map.set(`${r.factor_key}::${r.methodology_version_id || ''}`, r);
    this.used = new Map();
  }
  /** 先查方法学专属，再回落到全局 */
  get(key, methodologyVersionId = '') {
    const r =
      this.map.get(`${key}::${methodologyVersionId}`) ||
      this.map.get(`${key}::`) ||
      null;
    if (r) this.used.set(key, r);
    return r;
  }
  value(key, methodologyVersionId = '') {
    const r = this.get(key, methodologyVersionId);
    return r ? r.value : null;
  }
  /** 输出本次运行实际用到的因子快照（写入 calculation_run.factor_snapshot_json） */
  snapshot() {
    return [...this.used.values()].map((r) => ({
      factor_key: r.factor_key,
      name: r.name,
      value: r.value,
      unit: r.unit,
      source_ref: r.source_ref,
      source_year: r.source_year,
      value_status: r.value_status,
      verification_note: r.verification_note || null,
    }));
  }
  /** 本次运行中所有占位（未由领域专家确认）的因子 */
  placeholders() {
    return [...this.used.values()].filter((r) => r.value_status === 'placeholder');
  }
}

/* ------------------------------ 数据校验 ------------------------------ */

export function num(inputs, key) {
  const v = inputs[key];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 关键计量值校验：单位错误 / 期间重叠 / 超合理范围 → 阻止出数
 */
export function validateNumeric(label, value, { min, max, unit, allowNull = false, field }) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    return { field, label, kind: 'missing', message: `${label}缺失，禁止出数` };
  }
  if (typeof value === 'string' && Number.isNaN(Number(value))) {
    return { field, label, kind: 'not_numeric', message: `${label}不是数值："${value}"（疑似单位或格式错误）` };
  }
  const r = checkRange(value, min, max);
  if (!r.ok) {
    return { field, label, kind: 'out_of_range', message: `${label} = ${value}${unit ? ' ' + unit : ''} ${r.reason}` };
  }
  return null;
}

/** 期间重叠检测：同一数据行不得同时属于两个计入期 */
export function detectPeriodOverlap(periods = []) {
  const errs = [];
  const valid = periods.filter((p) => isDate(p.start) && isDate(p.end));
  for (let i = 0; i < valid.length; i += 1) {
    if (valid[i].start > valid[i].end) {
      errs.push({ kind: 'period_reversed', message: `期间 ${valid[i].label || i} 起止倒置（${valid[i].start} → ${valid[i].end}）` });
    }
  }
  for (let i = 0; i < valid.length; i += 1) {
    for (let k = i + 1; k < valid.length; k += 1) {
      const a = valid[i];
      const b = valid[k];
      if (a.start <= b.end && b.start <= a.end) {
        errs.push({
          kind: 'period_overlap',
          message: `期间重叠：${a.label || a.start} 与 ${b.label || b.start} 在时间上重叠，禁止重复计量`,
        });
      }
    }
  }
  return errs;
}

/* ------------------------------ 情景与敏感性 ------------------------------ */

/** 对基础值施加情景乘数（保守情景必须得到更小的减排量） */
export function applyScenario(base, factor) {
  if (base === null || base === undefined) return null;
  return base * factor;
}

/**
 * 敏感性分析：对给定输入按 ±delta 扰动，观察输出变化。
 * @param {(overrides:object)=>number} run 计算函数
 * @param {object} baseInputs
 * @param {Array<{key:string,label:string,unit:string,delta:number}>} drivers
 */
export function sensitivity(run, baseInputs, drivers) {
  const base = run({});
  const out = [];
  for (const d of drivers) {
    const cur = baseInputs[d.key];
    if (cur === null || cur === undefined || cur === '') continue;
    const n = Number(cur);
    if (!Number.isFinite(n)) continue;
    const up = run({ [d.key]: n * (1 + d.delta) });
    const down = run({ [d.key]: n * (1 - d.delta) });
    out.push({
      driver: d.key,
      label: d.label,
      unit: d.unit || null,
      base_value: round(n, 6),
      delta_pct: round(d.delta * 100, 2),
      result_up: round(up, 4),
      result_down: round(down, 4),
      swing: round(Math.abs((up ?? 0) - (down ?? 0)), 4),
      sensitivity_index: base ? round(Math.abs(((up ?? 0) - (down ?? 0)) / 2 / base) / d.delta, 4) : null,
    });
  }
  return out.sort((a, b) => (b.swing || 0) - (a.swing || 0));
}

/* ------------------------------ 单位换算 ------------------------------ */

/** 标准状态下甲烷质量：Nm³ 甲烷 → tCH₄。rho 单位 kg/Nm³ */
export function nm3Ch4ToTonnes(volNm3, rhoKgPerNm3) {
  return ((volNm3 * rhoKgPerNm3) / 1000);
}

/** tCH₄ → tCO₂e */
export function ch4ToCo2e(tCH4, gwp) {
  return tCH4 * gwp;
}

/** 保守取整到方法学要求的位数 */
export function conservativeRound(v, decimals = 0) {
  return roundConservative(v, decimals);
}

/* ------------------------------ 逐期汇总 ------------------------------ */

/**
 * 把年度结果汇总为计入期结果。
 * @param {Array<{year:number, reduction:number}>} annual
 */
export function aggregateCrediting(annual) {
  const total = annual.reduce((s, a) => s + (Number(a.reduction) || 0), 0);
  return {
    years: annual.length,
    total: round(total, 4),
    average: annual.length ? round(total / annual.length, 4) : null,
    max_year: annual.reduce((m, a) => (a.reduction > (m?.reduction ?? -Infinity) ? a : m), null),
    min_year: annual.reduce((m, a) => (a.reduction < (m?.reduction ?? Infinity) ? a : m), null),
  };
}

/**
 * 生成计入期年度序列（按自然年），并绑定「分析基准日 + 方法学版本 + 因子版本」。
 * 数据不足的年份标记为「无可用数据期间」，不得外推填补。
 */
export function buildAnnualSeries({ startYear, years, perYear, dataAvailableYears = [] }) {
  const out = [];
  for (let i = 0; i < years; i += 1) {
    const y = startYear + i;
    const hasData = dataAvailableYears.length === 0 || dataAvailableYears.includes(y);
    out.push({
      year: y,
      reduction: hasData ? round(perYear, 4) : null,
      data_status: hasData ? '有可用数据期间' : '无可用监测数据期间（不外推）',
    });
  }
  return out;
}
