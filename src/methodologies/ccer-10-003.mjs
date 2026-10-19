/**
 * CCER-10-003-V01 陆上气田试气放喷气回收利用
 * ============================================================================
 * 发布依据：环办气候函〔2025〕428号
 *   https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html
 * 适用对象：常规天然气井、页岩气井和致密气井的试气放喷阶段，回收的试气放喷气
 *   处理为管输天然气、压缩天然气、液化天然气等产品。
 *
 * 本方法学的监测与核算体系为国内外首创（生态环境部答记者问明确指出「填补国际空白」），
 * 因此本插件中的一切方法学专属系数均标记为 placeholder，必须逐条对照原文确认。
 *
 * ⚠️ 待领域专家确认项：EXP-201 ~ EXP-207
 */

import { GLOBAL_FACTORS } from './lib/global-factors.mjs';
import {
  step, num, validateNumeric, sensitivity, nm3Ch4ToTonnes, ch4ToCo2e,
  aggregateCrediting, buildAnnualSeries, detectPeriodOverlap, SCENARIO_LABELS,
} from './lib/calc-kit.mjs';
import { round } from '../core/util.mjs';

const MID = 'CCER-10-003';
const MV = 'V01';
const CLAUSE = '【占位】待对照方法学 PDF 回填条款号与页码';

/* ================================ 规则卡 ================================ */

export const rulecard = [
  {
    layer: 'specific',
    rule_id: 'M10-003-01',
    title: '气源为陆上气田试气放喷气',
    condition_text: '项目回收利用的气源应为陆上气田试气放喷阶段产生的放喷气。',
    expression_text: "og.source_type == '陆上气田试气放喷气'",
    expr: { op: 'eq', field: 'og.source_type', value: '陆上气田试气放喷气' },
    required_fields: ['og.source_type'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'blocking',
    fail_conclusion: '气源不属于陆上气田试气放喷气，不适用本方法学。',
    sort_order: 110,
  },
  {
    layer: 'specific',
    rule_id: 'M10-003-02',
    title: '井型属于方法学适用井型',
    condition_text: '项目应属于常规天然气井、页岩气井或致密气井。',
    expression_text: "og.well_type ∈ {常规天然气井, 页岩气井, 致密气井}",
    expr: { op: 'in', field: 'og.well_type', values: ['常规天然气井', '页岩气井', '致密气井'] },
    required_fields: ['og.well_type'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'blocking',
    fail_conclusion: '井型不属于方法学适用井型。',
    sort_order: 120,
  },
  {
    layer: 'specific',
    rule_id: 'M10-003-03',
    title: '回收气产品去向符合方法学认可路径',
    condition_text: '回收的试气放喷气应处理为管输天然气、压缩天然气或液化天然气等产品。',
    expression_text: "og.product_route ∈ {管输天然气, 压缩天然气（CNG）, 液化天然气（LNG）}",
    expr: {
      op: 'in',
      field: 'og.product_route',
      values: ['管输天然气', '压缩天然气（CNG）', '液化天然气（LNG）'],
    },
    required_fields: ['og.product_route'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'blocking',
    fail_conclusion: '回收气产品去向不属于方法学认可的产品路径。',
    sort_order: 130,
  },
  {
    layer: 'specific',
    rule_id: 'M10-003-04',
    title: '试气放喷天数已记录',
    condition_text: '应记录试气放喷作业的天数，作为回收气量核算的期间依据。',
    expression_text: 'og.trial_gas_days 存在',
    expr: { op: 'exists', field: 'og.trial_gas_days' },
    required_fields: ['og.trial_gas_days'],
    evidence_policy: 'strict',
    evidence_requirement: '试气作业记录 / 放喷台账（含起止日期）',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '未记录试气放喷天数，回收气量的期间口径无法确认。',
    sort_order: 140,
  },
  {
    layer: 'specific',
    rule_id: 'M10-003-05',
    title: '回收气甲烷体积分数有气质分析证据',
    condition_text: '应提供试气放喷气的组分分析结果。',
    expression_text: 'og.ch4_fraction 存在',
    expr: { op: 'exists', field: 'og.ch4_fraction' },
    required_fields: ['og.ch4_fraction'],
    evidence_policy: 'strict',
    evidence_requirement: '气质分析报告',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '缺少有证据支持的甲烷体积分数。',
    sort_order: 150,
  },
  {
    layer: 'specific',
    rule_id: 'M10-003-06',
    title: '监测数据联网（临时作业口径须核对原文）',
    condition_text: '试气放喷为临时性作业，其监测数据联网要求须按方法学原文执行。',
    expression_text: 'mon.metering_online == true',
    expr: { op: 'is_true', field: 'mon.metering_online' },
    required_fields: ['mon.metering_online'],
    evidence_policy: 'strict',
    evidence_requirement: '联网方案 / 数据报送安排',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '未落实监测数据传输要求，须补充说明。',
    unknown_action: '临时作业的联网口径列入 EXP-206 待专家确认。',
    sort_order: 160,
  },
  {
    layer: 'specific',
    rule_id: 'M10-003-07',
    title: '额外性采用免予论证',
    condition_text: '本方法学采用免予额外性论证方式。',
    expression_text: "comp.additionality_route == '免予论证'",
    expr: { op: 'eq', field: 'comp.additionality_route', value: '免予论证' },
    required_fields: ['comp.additionality_route'],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '额外性论证路径与免予论证要求不一致，需说明理由。',
    sort_order: 170,
  },
  {
    layer: 'specific',
    rule_id: 'M10-003-08',
    title: '具备计算所需的回收气量数据',
    condition_text: '应具备日均回收气量或年回收气量，方可进行情景初算。',
    expression_text: '或(og.recovery_volume_nm3 存在, og.trial_gas_days 存在)',
    expr: {
      op: 'or',
      args: [
        { op: 'exists', field: 'og.recovery_volume_nm3' },
        { op: 'exists', field: 'og.trial_gas_days' },
      ],
    },
    required_fields: [],
    evidence_policy: 'normal',
    clause_ref: CLAUSE,
    severity: 'major',
    fail_conclusion: '缺少回收气量数据，暂不支持自动测算。',
    sort_order: 180,
  },
];

/* ============================== 计算插件 =============================== */

export const plugin = {
  plugin_key: 'calc-ccer-10-003',
  plugin_version: '1.0.0',
  methodology_id: MID,
  methodology_version: MV,
  title: '陆上气田试气放喷气回收利用 —— 减排量初算',
  status_note:
    '本领域核算规则为国内外首创，方法学专属系数全部为占位值，须由领域专家逐条对照原文确认。',

  formula_refs: [
    { formula_id: 'F1', title: '试气放喷阶段回收气总量', expression: 'V_gas = q_daily × D_trial', unit: 'Nm³', clause_ref: CLAUSE },
    { formula_id: 'F2', title: '回收甲烷体积', expression: 'V_CH4 = V_gas × f_CH4', unit: 'Nm³', clause_ref: CLAUSE },
    { formula_id: 'F3', title: '回收甲烷质量', expression: 'M_CH4 = V_CH4 × ρ_CH4 / 1000', unit: 'tCH₄', clause_ref: CLAUSE },
    { formula_id: 'F4', title: '基准线排放（放喷气点火燃烧）', expression: 'BE = M_CH4 × [(1−η_flare) × GWP + η_flare × EF_CO2_CH4]', unit: 'tCO₂e', clause_ref: CLAUSE },
    { formula_id: 'F5', title: '回收装置自耗气排放', expression: 'PE_fuel = M_CH4 × s_self × EF_CO2_CH4', unit: 'tCO₂e', clause_ref: CLAUSE },
    { formula_id: 'F6', title: '可计减排量', expression: 'ER = BE − PE_fuel − PE_power − LE', unit: 'tCO₂e', clause_ref: CLAUSE },
  ],

  factors: [
    ...GLOBAL_FACTORS,
    {
      factor_key: 'c10-003.flare.efficiency.default',
      name: '基准线放喷气点火燃烧效率缺省值',
      value: 0.98,
      unit: '无量纲(0-1)',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】试气放喷现场点火燃烧效率，待方法学原文确认',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-201：现场点火放喷的燃烧效率可能显著低于常规火炬，须以原文规定为准。',
      reasonable_min: 0.3,
      reasonable_max: 1.0,
    },
    {
      factor_key: 'c10-003.trial.days.default',
      name: '试气放喷天数缺省值',
      value: 30,
      unit: '天',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】仅用于缺省提示，正式计算必须使用项目台账实测天数',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-202：严禁以缺省天数替代实测台账。',
      reasonable_min: 1,
      reasonable_max: 365,
    },
    {
      factor_key: 'c10-003.selfuse.gas.fraction',
      name: '回收装置自耗气比例',
      value: 0.05,
      unit: '无量纲(0-1)',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】待填入方法学规定口径',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-203',
      reasonable_min: 0,
      reasonable_max: 0.3,
    },
    {
      factor_key: 'c10-003.leakage.rate',
      name: '泄漏率',
      value: 0.01,
      unit: '无量纲(0-1)',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】待核实方法学泄漏项设置',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-204',
      reasonable_min: 0,
      reasonable_max: 0.2,
    },
    {
      factor_key: 'c10-003.process.power.ef',
      name: '回收处理装置电力排放因子',
      value: 0.581,
      unit: 'tCO₂/MWh',
      methodology_version_id: `${MID}::${MV}`,
      scope: 'methodology',
      source_ref: '【占位】待填入方法学指定引用的电力排放因子',
      source_year: null,
      value_status: 'placeholder',
      verification_note: 'EXP-205',
      reasonable_min: 0.1,
      reasonable_max: 1.2,
    },
  ],

  parameters: [
    { key: 'daily_recovery_nm3', label: '日均回收放喷气量（标态）', unit: 'Nm³/天', source: 'fact', fact_key: 'og.daily_recovery_nm3', type: 'number', required: false, min: 1, max: 5e7 },
    { key: 'trial_gas_days', label: '试气放喷天数', unit: '天', source: 'fact', fact_key: 'og.trial_gas_days', type: 'number', required: false, min: 1, max: 365 },
    { key: 'recovery_volume_nm3', label: '回收气总量（标态，可直接填列）', unit: 'Nm³', source: 'fact', fact_key: 'og.recovery_volume_nm3', type: 'number', required: false, min: 1, max: 5e9 },
    { key: 'ch4_fraction', label: '回收气甲烷体积分数', unit: '无量纲(0-1)', source: 'fact', fact_key: 'og.ch4_fraction', type: 'number', required: true, min: 0.01, max: 1 },
    { key: 'baseline_flare_efficiency', label: '基准线点火燃烧效率（放空填 0）', unit: '无量纲(0-1)', source: 'fact', fact_key: 'og.flare_baseline_efficiency', type: 'number', required: false, min: 0, max: 1, default: 0.98 },
    { key: 'selfuse_fraction', label: '自耗气比例', unit: '无量纲(0-1)', source: 'input', type: 'number', required: false, min: 0, max: 0.3, factor_fallback: 'c10-003.selfuse.gas.fraction' },
    { key: 'leakage_rate', label: '泄漏率', unit: '无量纲(0-1)', source: 'input', type: 'number', required: false, min: 0, max: 0.2, factor_fallback: 'c10-003.leakage.rate' },
    { key: 'process_power_mwh', label: '回收处理装置年耗电量', unit: 'MWh', source: 'input', type: 'number', required: false, min: 0, max: 5e6 },
    { key: 'process_power_ef', label: '电力排放因子', unit: 'tCO₂/MWh', source: 'input', type: 'number', required: false, min: 0.1, max: 1.2, factor_fallback: 'c10-003.process.power.ef' },
    { key: 'crediting_years', label: '申请计入期长度', unit: '年', source: 'input', type: 'number', required: false, min: 1, max: 30, default: 1 },
    { key: 'crediting_start_year', label: '计入期起始年份', unit: null, source: 'fact', fact_key: 'time.crediting_start', type: 'date', required: true },
    { key: 'data_years', label: '有可用监测数据的年份', unit: null, source: 'input', type: 'list', required: false },
  ],

  scenarios: {
    conservative: {
      label: SCENARIO_LABELS.conservative,
      multipliers: { ch4: 0.95, days: 0.9, selfuse: 1.2 },
      note: '甲烷分数下调 5%、放喷天数按台账下限、自耗气上调 20%。',
    },
    base: { label: SCENARIO_LABELS.base, multipliers: { ch4: 1.0, days: 1.0, selfuse: 1.0 }, note: '按试气台账实测值。' },
    optimistic: { label: SCENARIO_LABELS.optimistic, multipliers: { ch4: 1.0, days: 1.0, selfuse: 0.8 }, note: '自耗气取设计低值。' },
  },

  validate(inputs) {
    const errors = [];
    const warnings = [];
    const v = num(inputs, 'recovery_volume_nm3');
    const q = num(inputs, 'daily_recovery_nm3');
    const d = num(inputs, 'trial_gas_days');

    if (v === null && (q === null || d === null)) {
      errors.push({
        field: 'recovery_volume_nm3',
        kind: 'missing',
        message: '既未提供回收气总量，也未同时提供日均回收气量与试气放喷天数，禁止出数。',
      });
    }
    const checks = [
      validateNumeric('回收气甲烷体积分数', num(inputs, 'ch4_fraction'), { min: 0.01, max: 1, unit: '无量纲', field: 'ch4_fraction' }),
      validateNumeric('试气放喷天数', d, { min: 1, max: 365, unit: '天', field: 'trial_gas_days' }),
    ];
    for (const c of checks) if (c) errors.push(c);

    if (d !== null && d > 180) {
      warnings.push({ field: 'trial_gas_days', message: `试气放喷天数 ${d} 天偏长，请确认是否为多个井次合并填报。` });
    }
    const f = num(inputs, 'ch4_fraction');
    if (f !== null && f > 0.95) {
      warnings.push({ field: 'ch4_fraction', message: `甲烷体积分数 ${f} 接近 1，请确认是否误填百分数。` });
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

    const steps = [];
    let n = 1;

    const qDaily = num(inputs, 'daily_recovery_nm3');
    const days = (num(inputs, 'trial_gas_days') ?? 0) * m.days;
    let vGas = num(inputs, 'recovery_volume_nm3');
    if (vGas === null && qDaily !== null && days > 0) {
      vGas = qDaily * days;
      steps.push(step(n++, {
        title: '试气放喷阶段回收气总量',
        formula: 'V_gas = q_daily × D_trial',
        substitution: `V_gas = ${qDaily} × ${round(days, 3)}`,
        result: vGas, unit: 'Nm³', clauseRef: CLAUSE,
        note: '放喷天数来自试气台账（严格证据要求）。',
      }));
    } else {
      steps.push(step(n++, {
        title: '试气放喷阶段回收气总量',
        formula: 'V_gas（直接填列）',
        substitution: `V_gas = ${vGas}`,
        result: vGas, unit: 'Nm³', clauseRef: CLAUSE,
        note: '回收气总量由用户直接填列，须与计量记录一致。',
      }));
    }

    const ch4f = num(inputs, 'ch4_fraction') * m.ch4;
    const vCh4 = vGas * ch4f;
    steps.push(step(n++, {
      title: '回收甲烷体积（标态）',
      formula: 'V_CH4 = V_gas × f_CH4',
      substitution: `V_CH4 = ${round(vGas, 2)} × ${round(ch4f, 6)}`,
      result: vCh4, unit: 'Nm³', clauseRef: CLAUSE,
    }));

    const mCh4 = nm3Ch4ToTonnes(vCh4, rho);
    steps.push(step(n++, {
      title: '回收甲烷质量',
      formula: 'M_CH4 = V_CH4 × ρ_CH4 / 1000',
      substitution: `M_CH4 = ${round(vCh4, 2)} × ${rho} ÷ 1000`,
      result: mCh4, unit: 'tCH₄', factorRefs: ['rho.ch4.standard'], clauseRef: CLAUSE, factorStatus: 'verified',
    }));

    const etaFlare = num(inputs, 'baseline_flare_efficiency') ?? fac.value('c10-003.flare.efficiency.default');
    const be = etaFlare <= 0
      ? ch4ToCo2e(mCh4, gwp)
      : mCh4 * ((1 - etaFlare) * gwp + etaFlare * efCo2Ch4);
    steps.push(step(n++, {
      title: etaFlare <= 0 ? '基准线排放（放喷气直接放空）' : '基准线排放（放喷气点火燃烧）',
      formula: etaFlare <= 0
        ? 'BE = M_CH4 × GWP_CH4'
        : 'BE = M_CH4 × [(1 − η_flare) × GWP_CH4 + η_flare × EF_CO2_CH4]',
      substitution: etaFlare <= 0
        ? `BE = ${round(mCh4, 4)} × ${gwp}`
        : `BE = ${round(mCh4, 4)} × [(${round(1 - etaFlare, 4)}) × ${gwp} + ${etaFlare} × ${efCo2Ch4}]`,
      result: be, unit: 'tCO₂e',
      factorRefs: ['gwp.ch4.fossil.ar5', 'ef.co2.ch4.combustion', 'c10-003.flare.efficiency.default'],
      clauseRef: CLAUSE, factorStatus: 'placeholder',
    }));

    const selfUse = Math.min(num(inputs, 'selfuse_fraction') ?? fac.value('c10-003.selfuse.gas.fraction'), 0.5) * m.selfuse;
    const peFuel = mCh4 * selfUse * efCo2Ch4;
    steps.push(step(n++, {
      title: '回收装置自耗气排放',
      formula: 'PE_fuel = M_CH4 × s_self × EF_CO2_CH4',
      substitution: `PE_fuel = ${round(mCh4, 4)} × ${round(selfUse, 5)} × ${efCo2Ch4}`,
      result: peFuel, unit: 'tCO₂e',
      factorRefs: ['c10-003.selfuse.gas.fraction', 'ef.co2.ch4.combustion'],
      clauseRef: CLAUSE, factorStatus: 'placeholder',
    }));

    let pePower = 0;
    const pwrMwh = num(inputs, 'process_power_mwh');
    const pwrEf = num(inputs, 'process_power_ef');
    if (pwrMwh !== null && pwrEf !== null) {
      pePower = pwrMwh * pwrEf;
      steps.push(step(n++, {
        title: '回收处理装置电力消耗排放',
        formula: 'PE_power = E_power × EF_power',
        substitution: `PE_power = ${pwrMwh} × ${pwrEf}`,
        result: pePower, unit: 'tCO₂e', factorRefs: ['c10-003.process.power.ef'],
        clauseRef: CLAUSE, factorStatus: 'placeholder',
      }));
    }

    const lambda = num(inputs, 'leakage_rate') ?? fac.value('c10-003.leakage.rate');
    const le = mCh4 * lambda * gwp;
    steps.push(step(n++, {
      title: '泄漏',
      formula: 'LE = M_CH4 × λ_leak × GWP_CH4',
      substitution: `LE = ${round(mCh4, 4)} × ${lambda} × ${gwp}`,
      result: le, unit: 'tCO₂e',
      factorRefs: ['c10-003.leakage.rate', 'gwp.ch4.fossil.ar5'], clauseRef: CLAUSE, factorStatus: 'placeholder',
    }));

    const er = be - peFuel - pePower - le;
    steps.push(step(n++, {
      title: '可计减排量（本试气放喷作业期）',
      formula: 'ER = BE − PE_fuel − PE_power − LE',
      substitution: `ER = ${round(be, 4)} − ${round(peFuel, 4)} − ${round(pePower, 4)} − ${round(le, 4)}`,
      result: er, unit: 'tCO₂e', clauseRef: CLAUSE,
      note: '试气放喷为一次性作业，本结果为该作业期总量，不按年重复。',
    }));

    const years = Math.max(1, Math.round(num(inputs, 'crediting_years') || 1));
    const startYear = Number(String(inputs.crediting_start_year || '').slice(0, 4)) || new Date().getUTCFullYear();
    const dataYears = Array.isArray(inputs.data_years) ? inputs.data_years.map(Number) : [startYear];
    const annual = buildAnnualSeries({
      startYear,
      years,
      perYear: years === 1 ? er : 0,
      dataAvailableYears: years === 1 ? [startYear] : dataYears,
    });
    const crediting = aggregateCrediting(annual.filter((a) => a.reduction !== null));

    const assumptions = [];
    if (m.ch4 !== 1 || m.days !== 1 || m.selfuse !== 1) assumptions.push(`情景乘数（模型假设）：${JSON.stringify(m)}`);
    if (num(inputs, 'trial_gas_days') === null && num(inputs, 'recovery_volume_nm3') !== null) {
      assumptions.push('未提供试气放喷天数，期间口径按单次作业整体处理（模型假设）');
    }
    for (const p of fac.placeholders()) {
      assumptions.push(`因子「${p.name}」= ${p.value} ${p.unit} 为占位值（${p.verification_note || '待确认'}）`);
    }

    const missing = [];
    if (pwrMwh === null) missing.push('回收处理装置耗电量（未提供，电力排放未扣减）');
    if (num(inputs, 'recovery_volume_nm3') === null) missing.push('回收气总量实测值（当前由日均值 × 天数推算）');

    const sens = sensitivity(
      (over) => {
        const dd = (over.trial_gas_days ?? num(inputs, 'trial_gas_days') ?? 0) * m.days;
        const qq = over.daily_recovery_nm3 ?? qDaily;
        const vv = num(inputs, 'recovery_volume_nm3') ?? (qq !== null ? qq * dd : 0);
        const cc = (over.ch4_fraction ?? num(inputs, 'ch4_fraction')) * m.ch4;
        const mm = nm3Ch4ToTonnes(vv * cc, rho);
        const bb = etaFlare <= 0 ? mm * gwp : mm * ((1 - etaFlare) * gwp + etaFlare * efCo2Ch4);
        return bb - mm * selfUse * efCo2Ch4 - pePower - mm * lambda * gwp;
      },
      inputs,
      [
        { key: 'daily_recovery_nm3', label: '日均回收气量', unit: 'Nm³/天', delta: 0.15 },
        { key: 'ch4_fraction', label: '甲烷体积分数', unit: '无量纲', delta: 0.1 },
        { key: 'trial_gas_days', label: '试气放喷天数', unit: '天', delta: 0.2 },
        { key: 'baseline_flare_efficiency', label: '基准线点火燃烧效率', unit: '无量纲', delta: 0.1 },
      ]
    );

    return { steps, annual, crediting, assumptions, missing, sensitivity: sens, er_annual: round(er, 4) };
  },

  selfCheckSamples: [
    {
      name: '样例 A：页岩气井试气放喷气回收，日均 5 万 Nm³、放喷 30 天、甲烷 0.92、基准线点火燃烧 0.98',
      inputs: {
        daily_recovery_nm3: 50000,
        trial_gas_days: 30,
        ch4_fraction: 0.92,
        baseline_flare_efficiency: 0.98,
        selfuse_fraction: 0.05,
        leakage_rate: 0.01,
        crediting_years: 1,
        crediting_start_year: '2025-01-01',
      },
      expect: {
        // V_gas = 50000 × 30 = 1,500,000 Nm³
        // V_CH4 = 1.5e6 × 0.92 = 1,380,000 Nm³
        // M_CH4 = 1.38e6 × 0.716 / 1000 = 988.08 tCH₄
        // BE = 988.08 × [0.02×28 + 0.98×2.7432] = 988.08 × 3.248336 = 3209.61583488
        // PE_fuel = 988.08 × 0.05 × 2.7432 = 49.404 × 2.7432 = 135.5250528
        // LE = 988.08 × 0.01 × 28 = 276.6624
        // ER = 3209.61583488 − 135.5250528 − 276.6624 = 2797.42838208
        v_gas_nm3: 1500000,
        v_ch4_nm3: 1380000,
        m_ch4_t: 988.08,
        be_tco2e: 3209.61583488,
        pe_fuel_tco2e: 135.5250528,
        er_annual_tco2e: 2797.42838208,
      },
      tolerance: 0.01,
    },
  ],
};

export const meta = {
  methodology_id: MID,
  version: MV,
  display_name: 'CCER-10-003-V01 陆上气田试气放喷气回收利用',
  project_type: '陆上气田试气放喷气回收利用',
};

export default { meta, rulecard, plugin };
