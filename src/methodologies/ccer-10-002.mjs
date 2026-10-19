/**
 * CCER-10-002-V01 海上油田伴生气回收利用
 * ============================================================================
 * 发布依据：环办气候函〔2025〕428号（2025-11-18 印发，2025-11-21 公开）
 *   https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html
 * 适用对象（生态环境部答记者问口径）：海上油田产生的伴生气，回收后用于生产
 *   管输天然气、液化天然气、压缩天然气、液化石油气等产品。
 *
 * ⚠️ 待领域专家确认项：EXP-101 ~ EXP-107，详见 docs/11-领域专家确认清单.md
 */

import { GLOBAL_FACTORS } from './lib/global-factors.mjs';
import {
  step, num, validateNumeric, sensitivity, nm3Ch4ToTonnes, ch4ToCo2e,
  aggregateCrediting, buildAnnualSeries, SCENARIO_LABELS,
} from './lib/calc-kit.mjs';
import { round } from '../core/util.mjs';

const MID = 'CCER-10-002';
const MV = 'V01';
const CLAUSE = '【占位】待对照方法学 PDF 回填条款号与页码';

/* ================================ 规则卡 ================================ */

export const rulecard = [
  {
    layer: 'specific',
    rule_id: 'M10-002-01',
    title: '气源为海上油田伴生气',
    condition_text: '项目回收利用的气源应为海上油田产生的伴生气。',
    expression_text: "og.source_type == '海上油田伴生气'",
    expr: { op: 'eq', field: 'og.source_type', value: '海上油田伴生气' },
    required_fields: ['og.source_type'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'blocking',
    fail_conclusion: '气源不属于海上油田伴生气，不适用本方法学。',
    sort_order: 110,
  },
  {
    layer: 'specific',
    rule_id: 'M10-002-02',
    title: '回收气产品去向符合方法学认可路径',
    condition_text: '回收的伴生气应处理为管输天然气、液化天然气、压缩天然气或液化石油气等产品。',
    expression_text: "og.product_route ∈ {管输天然气, 液化天然气（LNG）, 压缩天然气（CNG）, 液化石油气（LPG）}",
    expr: {
      op: 'in',
      field: 'og.product_route',
      values: ['管输天然气', '液化天然气（LNG）', '压缩天然气（CNG）', '液化石油气（LPG）'],
    },
    required_fields: ['og.product_route'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'blocking',
    fail_conclusion: '回收气产品去向不属于方法学认可的产品路径。',
    sort_order: 120,
  },
  {
    layer: 'specific',
    rule_id: 'M10-002-03',
    title: '回收气甲烷体积分数有气质分析证据',
    condition_text: '应提供回收伴生气的组分分析结果，用于确定甲烷体积分数。',
    expression_text: 'og.ch4_fraction 存在',
    expr: { op: 'exists', field: 'og.ch4_fraction' },
    required_fields: ['og.ch4_fraction'],
    evidence_policy: 'strict',
    evidence_requirement: '气质分析报告（含取样时间、分析单位、分析方法）',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '缺少有证据支持的甲烷体积分数，无法计算回收甲烷量。',
    sort_order: 130,
  },
  {
    layer: 'specific',
    rule_id: 'M10-002-04',
    title: '基准线情景已按方法学确定',
    condition_text: '应确定基准线情景（海上平台火炬燃烧或放空）及其燃烧效率。',
    expression_text: 'og.flare_baseline_efficiency 存在',
    expr: { op: 'exists', field: 'og.flare_baseline_efficiency' },
    required_fields: ['og.flare_baseline_efficiency'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '基准线情景未确定，无法建立基准线排放。',
    unknown_action: '基准线为放空时应填 0；缺失时显示「待核实」。',
    sort_order: 140,
  },
  {
    layer: 'specific',
    rule_id: 'M10-002-05',
    title: '监测数据与全国碳市场管理平台联网',
    condition_text: '项目监测数据应按要求与全国碳市场管理平台联网。',
    expression_text: 'mon.metering_online == true',
    expr: { op: 'is_true', field: 'mon.metering_online' },
    required_fields: ['mon.metering_online'],
    evidence_policy: 'strict',
    evidence_requirement: '联网方案 / 平台接入确认文件',
    clause_ref: CLAUSE,
    severity: 'blocking',
    fail_conclusion: '监测数据未按要求与全国碳市场管理平台联网。',
    sort_order: 150,
  },
  {
    layer: 'specific',
    rule_id: 'M10-002-06',
    title: '额外性采用免予论证',
    condition_text: '本方法学采用免予额外性论证方式。',
    expression_text: "comp.additionality_route == '免予论证'",
    expr: { op: 'eq', field: 'comp.additionality_route', value: '免予论证' },
    required_fields: ['comp.additionality_route'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '额外性论证路径与免予论证要求不一致，需说明理由。',
    sort_order: 160,
  },
  {
    layer: 'specific',
    rule_id: 'M10-002-07',
    title: '具备计算所需的年度回收气量',
    condition_text: '应具备年回收伴生气量，方可进行年度情景初算。',
    expression_text: 'og.recovery_volume_nm3 存在',
    expr: { op: 'exists', field: 'og.recovery_volume_nm3' },
    required_fields: ['og.recovery_volume_nm3'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '缺少年回收气量，暂不支持自动测算。',
    sort_order: 170,
  },
  {
    layer: 'specific',
    rule_id: 'M10-002-08',
    title: '计量仪表检定 / 校准安排已落实',
    condition_text: '海上平台的流量、组分计量仪表应按技术规范安装并定期检定、校准。',
    expression_text: 'mon.meter_calibration 存在',
    expr: { op: 'exists', field: 'mon.meter_calibration' },
    required_fields: ['mon.meter_calibration'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '未见计量仪表检定/校准安排。',
    sort_order: 180,
  },
];

/* ============================== 计算插件 =============================== */

export const plugin = {
  plugin_key: 'calc-ccer-10-002',
  plugin_version: '1.0.0',
  methodology_id: MID,
  methodology_version: MV,
  title: '海上油田伴生气回收利用 —— 减排量初算',
  status_note: '方法学专属系数为占位值，须领域专家确认（EXP-101 ~ EXP-105）。',

  formula_refs: [
    { formula_id: 'F1', title: '回收甲烷体积', expression: 'V_CH4 = V_gas × f_CH4', unit: 'Nm³/年', clause_ref: CLAUSE },
    { formula_id: 'F2', title: '回收甲烷质量', expression: 'M_CH4 = V_CH4 × ρ_CH4 / 1000', unit: 'tCH₄/年', clause_ref: CLAUSE },
    { formula_id: 'F3', title: '基准线排放（火炬）', expression: 'BE = M_CH4 × [(1−η_flare) × GWP + η_flare × EF_CO2_CH4]', unit: 'tCO₂e/年', clause_ref: CLAUSE },
    { formula_id: 'F4', title: '回收处理过程自耗气排放', expression: 'PE_fuel = M_CH4 × s_self × EF_CO2_CH4', unit: 'tCO₂e/年', clause_ref: CLAUSE },
    { formula_id: 'F5', title: '泄漏', expression: 'LE = M_CH4 × λ_leak × GWP', unit: 'tCO₂e/年', clause_ref: CLAUSE },
    { formula_id: 'F6', title: '可计减排量', expression: 'ER = BE − PE_fuel − PE_power − LE', unit: 'tCO₂e/年', clause_ref: CLAUSE },
  ],

  factors: [
    ...GLOBAL_FACTORS,
    {
      factor_key: 'c10-002.flare.efficiency.default',
      name: '基准线火炬燃烧效率缺省值',
      value: 0.98,
      unit: '无量纲(0-1)',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】待核对方法学指定引用文件',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-101：须确认方法学采用的火炬燃烧效率缺省值。',
      reasonable_min: 0.5,
      reasonable_max: 1.0,
    },
    {
      factor_key: 'c10-002.selfuse.gas.fraction',
      name: '回收处理过程自耗气比例',
      value: 0.03,
      unit: '无量纲(0-1)',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】待填入方法学规定的自耗气 / 燃料气扣减口径',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-102：须确认自耗气的计量口径与扣减方式。',
      reasonable_min: 0,
      reasonable_max: 0.3,
    },
    {
      factor_key: 'c10-002.leakage.rate',
      name: '泄漏率',
      value: 0.01,
      unit: '无量纲(0-1)',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】待核实方法学泄漏项设置',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-103',
      reasonable_min: 0,
      reasonable_max: 0.2,
    },
    {
      factor_key: 'c10-002.process.power.ef',
      name: '回收处理设施电力排放因子',
      value: 0.581,
      unit: 'tCO₂/MWh',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】待填入方法学指定引用的电力排放因子',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-104：海上设施供电方式（平台自备发电 / 岸电）不同，口径不同。',
      reasonable_min: 0.1,
      reasonable_max: 1.2,
    },
  ],

  parameters: [
    { key: 'recovery_volume_nm3', label: '年回收伴生气量（标态）', unit: 'Nm³/年', source: 'fact', fact_key: 'og.recovery_volume_nm3', type: 'number', required: true, min: 1, max: 5e9 },
    { key: 'ch4_fraction', label: '回收气甲烷体积分数', unit: '无量纲(0-1)', source: 'fact', fact_key: 'og.ch4_fraction', type: 'number', required: true, min: 0.01, max: 1 },
    { key: 'baseline_flare_efficiency', label: '基准线火炬燃烧效率（放空填 0）', unit: '无量纲(0-1)', source: 'fact', fact_key: 'og.flare_baseline_efficiency', type: 'number', required: true, min: 0, max: 1 },
    { key: 'selfuse_fraction', label: '自耗气比例', unit: '无量纲(0-1)', source: 'input', type: 'number', required: false, min: 0, max: 0.3, factor_fallback: 'c10-002.selfuse.gas.fraction' },
    { key: 'leakage_rate', label: '泄漏率', unit: '无量纲(0-1)', source: 'input', type: 'number', required: false, min: 0, max: 0.2, factor_fallback: 'c10-002.leakage.rate' },
    { key: 'process_power_mwh', label: '回收处理设施年耗电量', unit: 'MWh/年', source: 'input', type: 'number', required: false, min: 0, max: 5e6 },
    { key: 'process_power_ef', label: '电力排放因子', unit: 'tCO₂/MWh', source: 'input', type: 'number', required: false, min: 0.1, max: 1.2, factor_fallback: 'c10-002.process.power.ef' },
    { key: 'crediting_years', label: '申请计入期长度', unit: '年', source: 'fact', fact_key: 'time.crediting_period_years', type: 'number', required: true, min: 1, max: 30 },
    { key: 'crediting_start_year', label: '计入期起始年份', unit: null, source: 'fact', fact_key: 'time.crediting_start', type: 'date', required: true },
    { key: 'data_years', label: '有可用监测数据的年份', unit: null, source: 'input', type: 'list', required: false },
  ],

  scenarios: {
    conservative: {
      label: SCENARIO_LABELS.conservative,
      multipliers: { ch4: 0.95, availability: 0.85, selfuse: 1.2 },
      note: '甲烷分数保守下调 5%、可用率下调 15%、自耗气上调 20%。',
    },
    base: { label: SCENARIO_LABELS.base, multipliers: { ch4: 1.0, availability: 1.0, selfuse: 1.0 }, note: '按气质分析与运行记录取值。' },
    optimistic: { label: SCENARIO_LABELS.optimistic, multipliers: { ch4: 1.0, availability: 1.0, selfuse: 0.8 }, note: '设备满负荷、自耗气取设计低值。' },
  },

  validate(inputs) {
    const errors = [];
    const warnings = [];
    const checks = [
      validateNumeric('年回收伴生气量', inputs.recovery_volume_nm3, { min: 1, max: 5e9, unit: 'Nm³/年', field: 'recovery_volume_nm3' }),
      validateNumeric('回收气甲烷体积分数', inputs.ch4_fraction, { min: 0.01, max: 1, unit: '无量纲', field: 'ch4_fraction' }),
      validateNumeric('基准线火炬燃烧效率', inputs.baseline_flare_efficiency, { min: 0, max: 1, unit: '无量纲', field: 'baseline_flare_efficiency' }),
      validateNumeric('自耗气比例', inputs.selfuse_fraction, { min: 0, max: 0.3, unit: '无量纲', field: 'selfuse_fraction' }),
    ];
    for (const c of checks) if (c) errors.push(c);

    const f = num(inputs, 'ch4_fraction');
    if (f !== null && f > 0.95) {
      warnings.push({ field: 'ch4_fraction', message: `甲烷体积分数 ${f} 接近 1，请确认是否误填为百分数（如 90% 应填 0.9）。` });
    }
    if (!inputs.crediting_start_year) {
      errors.push({ field: 'crediting_start_year', kind: 'missing', message: '计入期起始时间缺失，禁止出数。' });
    }
    return { errors, warnings };
  },

  compute(inputs, ctx) {
    const fac = ctx.factors;
    const m = ctx.scenarioMultipliers;
    const gwp = fac.value('gwp.ch4.fossil.ar5');
    const rho = fac.value('rho.ch4.standard');
    const efCo2Ch4 = fac.value('ef.co2.ch4.combustion');

    const vGas = num(inputs, 'recovery_volume_nm3') * m.availability;
    const ch4f = num(inputs, 'ch4_fraction') * m.ch4;
    const etaFlare = num(inputs, 'baseline_flare_efficiency');
    const selfUse = Math.min(num(inputs, 'selfuse_fraction') ?? fac.value('c10-002.selfuse.gas.fraction'), 0.5) * m.selfuse;
    const lambda = num(inputs, 'leakage_rate') ?? fac.value('c10-002.leakage.rate');
    const pwrMwh = num(inputs, 'process_power_mwh');
    const pwrEf = num(inputs, 'process_power_ef');

    const steps = [];
    let n = 1;

    const vCh4 = vGas * ch4f;
    steps.push(step(n++, {
      title: '回收甲烷体积（标态）',
      formula: 'V_CH4 = V_gas × f_CH4',
      substitution: `V_CH4 = ${round(vGas, 2)} × ${round(ch4f, 6)}`,
      result: vCh4, unit: 'Nm³/年', clauseRef: CLAUSE,
      note: m.ch4 !== 1 || m.availability !== 1 ? `情景调整：可用率 × ${m.availability}，甲烷分数 × ${m.ch4}` : null,
    }));

    const mCh4 = nm3Ch4ToTonnes(vCh4, rho);
    steps.push(step(n++, {
      title: '回收甲烷质量',
      formula: 'M_CH4 = V_CH4 × ρ_CH4 / 1000',
      substitution: `M_CH4 = ${round(vCh4, 2)} × ${rho} ÷ 1000`,
      result: mCh4, unit: 'tCH₄/年', factorRefs: ['rho.ch4.standard'], clauseRef: CLAUSE, factorStatus: 'verified',
    }));

    const be = etaFlare <= 0
      ? ch4ToCo2e(mCh4, gwp)
      : mCh4 * ((1 - etaFlare) * gwp + etaFlare * efCo2Ch4);
    steps.push(step(n++, {
      title: etaFlare <= 0 ? '基准线排放（伴生气放空）' : '基准线排放（伴生气火炬燃烧）',
      formula: etaFlare <= 0
        ? 'BE = M_CH4 × GWP_CH4'
        : 'BE = M_CH4 × [(1 − η_flare) × GWP_CH4 + η_flare × EF_CO2_CH4]',
      substitution: etaFlare <= 0
        ? `BE = ${round(mCh4, 4)} × ${gwp}`
        : `BE = ${round(mCh4, 4)} × [(${round(1 - etaFlare, 4)}) × ${gwp} + ${etaFlare} × ${efCo2Ch4}]`,
      result: be, unit: 'tCO₂e/年',
      factorRefs: ['gwp.ch4.fossil.ar5', 'ef.co2.ch4.combustion', 'c10-002.flare.efficiency.default'],
      clauseRef: CLAUSE, factorStatus: 'placeholder',
    }));

    const mSelf = mCh4 * selfUse;
    const peFuel = mSelf * efCo2Ch4;
    steps.push(step(n++, {
      title: '回收处理过程自耗气燃烧排放',
      formula: 'PE_fuel = M_CH4 × s_self × EF_CO2_CH4',
      substitution: `PE_fuel = ${round(mCh4, 4)} × ${round(selfUse, 5)} × ${efCo2Ch4}`,
      result: peFuel, unit: 'tCO₂e/年',
      factorRefs: ['c10-002.selfuse.gas.fraction', 'ef.co2.ch4.combustion'],
      clauseRef: CLAUSE,
      note: '自耗气按完全燃烧计入；若方法学要求计入未燃甲烷逃逸，本项口径须调整（EXP-102）。',
      factorStatus: 'placeholder',
    }));

    let pePower = 0;
    if (pwrMwh !== null && pwrEf !== null) {
      pePower = pwrMwh * pwrEf;
      steps.push(step(n++, {
        title: '回收处理设施电力消耗排放',
        formula: 'PE_power = E_power × EF_power',
        substitution: `PE_power = ${pwrMwh} × ${pwrEf}`,
        result: pePower, unit: 'tCO₂e/年',
        factorRefs: ['c10-002.process.power.ef'], clauseRef: CLAUSE, factorStatus: 'placeholder',
      }));
    }

    const le = mCh4 * lambda * gwp;
    steps.push(step(n++, {
      title: '泄漏',
      formula: 'LE = M_CH4 × λ_leak × GWP_CH4',
      substitution: `LE = ${round(mCh4, 4)} × ${lambda} × ${gwp}`,
      result: le, unit: 'tCO₂e/年',
      factorRefs: ['c10-002.leakage.rate', 'gwp.ch4.fossil.ar5'], clauseRef: CLAUSE, factorStatus: 'placeholder',
    }));

    const er = be - peFuel - pePower - le;
    steps.push(step(n++, {
      title: '可计减排量（年度）',
      formula: 'ER = BE − PE_fuel − PE_power − LE',
      substitution: `ER = ${round(be, 4)} − ${round(peFuel, 4)} − ${round(pePower, 4)} − ${round(le, 4)}`,
      result: er, unit: 'tCO₂e/年', clauseRef: CLAUSE,
    }));

    const years = Math.max(1, Math.round(num(inputs, 'crediting_years') || 1));
    const startYear = Number(String(inputs.crediting_start_year || '').slice(0, 4)) || new Date().getUTCFullYear();
    const dataYears = Array.isArray(inputs.data_years) ? inputs.data_years.map(Number) : [];
    const annual = buildAnnualSeries({ startYear, years, perYear: er, dataAvailableYears: dataYears });
    const crediting = aggregateCrediting(annual.filter((a) => a.reduction !== null));

    const assumptions = [];
    if (m.ch4 !== 1 || m.availability !== 1 || m.selfuse !== 1) {
      assumptions.push(`情景乘数（模型假设）：${JSON.stringify(m)}`);
    }
    for (const p of fac.placeholders()) {
      assumptions.push(`因子「${p.name}」= ${p.value} ${p.unit} 为占位值（${p.verification_note || '待确认'}）`);
    }

    const missing = [];
    if (pwrMwh === null) missing.push('回收处理设施年耗电量（未提供，电力排放未扣减）');
    if (dataYears.length === 0) missing.push('分年度实测数据');

    const sens = sensitivity(
      (over) => {
        const v = (over.recovery_volume_nm3 ?? num(inputs, 'recovery_volume_nm3')) * m.availability;
        const c = (over.ch4_fraction ?? num(inputs, 'ch4_fraction')) * m.ch4;
        const mm = nm3Ch4ToTonnes(v * c, rho);
        const bb = etaFlare <= 0 ? mm * gwp : mm * ((1 - etaFlare) * gwp + etaFlare * efCo2Ch4);
        return bb - mm * selfUse * efCo2Ch4 - pePower - mm * lambda * gwp;
      },
      inputs,
      [
        { key: 'recovery_volume_nm3', label: '年回收伴生气量', unit: 'Nm³/年', delta: 0.1 },
        { key: 'ch4_fraction', label: '甲烷体积分数', unit: '无量纲', delta: 0.1 },
        { key: 'baseline_flare_efficiency', label: '基准线火炬效率', unit: '无量纲', delta: 0.05 },
      ]
    );

    return { steps, annual, crediting, assumptions, missing, sensitivity: sens, er_annual: round(er, 4) };
  },

  selfCheckSamples: [
    {
      name: '样例 A：海上平台伴生气回收生产 LNG，甲烷分数 0.85，年回收 2000 万 Nm³，基准线放空',
      inputs: {
        recovery_volume_nm3: 20000000,
        ch4_fraction: 0.85,
        baseline_flare_efficiency: 0,
        selfuse_fraction: 0.03,
        leakage_rate: 0.01,
        crediting_years: 10,
        crediting_start_year: '2025-01-01',
      },
      expect: {
        // V_CH4 = 2e7 × 0.85 = 1.7e7 Nm³
        // M_CH4 = 1.7e7 × 0.716 / 1000 = 12172 tCH₄
        // BE    = 12172 × 28 = 340816
        // PE_fuel = 12172 × 0.03 × 2.7432 = 365.16 × 2.7432 = 1001.706912
        // LE    = 12172 × 0.01 × 28 = 3408.16
        // ER    = 340816 − 1001.706912 − 3408.16 = 336406.133088
        v_ch4_nm3: 17000000,
        m_ch4_t: 12172,
        be_tco2e: 340816,
        pe_fuel_tco2e: 1001.706912,
        er_annual_tco2e: 336406.133088,
      },
      tolerance: 0.01,
    },
  ],
};

export const meta = {
  methodology_id: MID,
  version: MV,
  display_name: 'CCER-10-002-V01 海上油田伴生气回收利用',
  project_type: '海上油田伴生气回收利用',
};

export default { meta, rulecard, plugin };
