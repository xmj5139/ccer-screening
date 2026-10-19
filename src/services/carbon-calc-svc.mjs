/**
 * 碳排放计算（docs/39 第 3 条）
 * ============================================================================
 * 硬约束：
 *   1. **纯函数 / 无副作用**：不保存用户的私有项目或输入到数据库，
 *      不写任何表，只返回结果与可下载的 JSON；
 *   2. 数值公式**不由大模型生成**：公式、换算与代入值全部是确定性代码；
 *   3. 单位不同一律拒绝，不做隐式换算（万 kWh ↔ kWh 是唯一允许的显式换算）；
 *   4. 因子未知就要求用户输入，不默认编值；选择区域/省份时**不静默落回全国**；
 *   5. 0.6096 / 0.8273 有各自独立口径约束，必须由用户显式选择，界面与结果都标注口径；
 *   6. CO2 不自动标成 CO2e；本页排放总量**不是** CCER 预计签发量；
 *   7. 年度不一致必须明确提示并要求显式接受参考年份（不能把 2023 因子写成 2026）。
 */
import { selectableFactors, FACTOR_CATEGORY_LABELS } from './accounting-svc.mjs';

/* ==================================================================== */
/*  一、输入校验（确定性、可复现）                                      */
/* ==================================================================== */

/** 数量上限：超过即拒绝（防止误填导致离谱结果）。 */
export const LIMITS = {
  max_energy_kwh: 1e12,        // 1 万亿 kWh
  max_fuel_amount: 1e9,        // 10 亿 t 或 万Nm³
  max_ncv: 1e4,                // GJ/t
  max_cc: 1e3,                 // tC/TJ
  max_oxidation: 1,
  max_string_len: 64,
};

export class CalcInputError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'CalcInputError';
    this.detail = detail;
    this.status = 400;
  }
}

/**
 * 解析一个数值输入。拒绝：非有限数、NaN、Infinity、超长字符串、空、非数字。
 * @returns {number}
 */
export function readNumber(raw, { field, min = 0, max = Infinity, required = true, allowZero = true } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    if (required) throw new CalcInputError(`${field}：必填项缺失`);
    return null;
  }
  if (typeof raw === 'string' && raw.length > LIMITS.max_string_len) {
    throw new CalcInputError(`${field}：输入过长（超过 ${LIMITS.max_string_len} 字符），已拒绝`);
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new CalcInputError(`${field}：输入类型不支持`);
  }
  const s = typeof raw === 'string' ? raw.trim().replace(/,/g, '') : raw;
  if (s === '') {
    if (required) throw new CalcInputError(`${field}：必填项缺失`);
    return null;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) throw new CalcInputError(`${field}：必须是有限数值（收到 ${JSON.stringify(raw)}）`);
  if (n < min) throw new CalcInputError(`${field}：不得小于 ${min}`);
  if (n > max) throw new CalcInputError(`${field}：不得大于 ${max}`);
  if (!allowZero && n === 0) throw new CalcInputError(`${field}：不得为 0`);
  return n;
}

/** 电量单位（唯一允许的显式换算集合）。 */
export const ENERGY_UNITS = {
  kWh: { label: 'kWh', to_kwh: 1 },
  MWh: { label: 'MWh', to_kwh: 1000 },
  '万kWh': { label: '万kWh', to_kwh: 10000 },
};

/** 燃料活动数据单位。 */
export const FUEL_UNITS = {
  t: { label: 't（吨）', kind: 'mass' },
  '万Nm³': { label: '万Nm³', kind: 'volume' },
  'Nm³': { label: 'Nm³', kind: 'volume' },
};

/* ==================================================================== */
/*  二、外购电力排放                                                     */
/* ==================================================================== */

export const ELECTRICITY_FORMULA = 'E = AD × EF ÷ 1000';

/**
 * 外购电力排放（CO2）。
 * @param {{energy:number|string, energy_unit:string, factor_id?:string,
 *          source_code?:string, category?:string, region?:string, data_year?:number,
 *          factor_value?:number, factor_unit?:string, accept_reference_year?:boolean,
 *          target_year?:number}} input
 */
export function calculateElectricity(input = {}) {
  for(const field of ['factor_id','source_code','category','region','factor_unit']){
    if(input[field]!==undefined&&input[field]!==null&&(typeof input[field]!=='string'||input[field].length>64))throw new CalcInputError(`${field}须为不超过64字符的文本`);
  }
  if(input.data_year!==undefined&&input.data_year!==null&&(!['string','number'].includes(typeof input.data_year)||!Number.isInteger(Number(input.data_year))||Number(input.data_year)<1900||Number(input.data_year)>2100))throw new CalcInputError('因子数据年度须为1900—2100之间的整数年份');
  const energyUnit = String(input.energy_unit || '');
  const unit = ENERGY_UNITS[energyUnit];
  if (!unit) {
    throw new CalcInputError(
      `电量单位不支持：${energyUnit || '（未提供）'}。可选：${Object.keys(ENERGY_UNITS).join('、')}`
    );
  }
  const energy = readNumber(input.energy, {
    field: '电量', min: 0, max: LIMITS.max_energy_kwh / unit.to_kwh,
  });
  const kwh = energy * unit.to_kwh;

  // ---- 因子选择：显式优先，绝不静默回落 ----
  let factor = null;
  if (input.factor_id || input.source_code) {
    const list = selectableFactors({
      data_year: input.data_year ?? null,
      category: input.category ?? null,
      region: input.region ?? null,
    });
    if (input.factor_id) {
      factor = list.find((f) => f.id === String(input.factor_id)) || null;
    } else {
      if (!input.category || !input.data_year || !input.region) throw new CalcInputError('按来源选择时须明确口径、地区和数据年度，或直接选择唯一因子ID');
      const candidates = selectableFactors({ data_year: input.data_year, category: input.category })
        .filter(f => f.source_code === input.source_code && (f.region || '全国') === input.region);
      if (candidates.length !== 1) throw new CalcInputError('所选条件不能唯一确定电力因子',{available:list.map(f=>({id:f.id,label:f.name,category:f.category,region:f.region}))});
      factor = candidates[0];
    }
    if (!factor) {
      throw new CalcInputError(
        `未找到匹配的电力因子（来源=${input.source_code || '—'}｜口径=${input.category || '—'}｜` +
        `地区=${input.region || '全国'}｜数据年=${input.data_year ?? '—'}）。` +
        '系统不会自动改用其他地区或全国平均值，请显式选择可用因子。',
        { available: list.map((f) => ({ id: f.id, label: f.name, category: f.category, region: f.region })) }
      );
    }
  } else if (input.factor_value !== undefined && input.factor_value !== null && input.factor_value !== '') {
    // 用户手工输入因子：必须同时给出口径与单位，不猜
    const fv = readNumber(input.factor_value, { field: '电力因子数值', min: 0, max: 100, allowZero: false });
    const fu = String(input.factor_unit || '');
    if (!input.region || !input.factor_caliber || !Number.isInteger(input.data_year) || input.data_year<1900 || input.data_year>2100) throw new CalcInputError('手工因子须明确地区、口径和数据年度');
    if (fu !== 'kgCO2/kWh') {
      throw new CalcInputError(`手工因子单位仅支持 kgCO2/kWh（收到 ${fu}）；其他单位请先自行换算并注明`);
    }
    factor = {
      id: null,
      source_code: 'manual',
      name: String(input.factor_name || '用户手工输入的电力二氧化碳排放因子'),
      value: fv,
      original_unit: fu,
      standard_unit: fu,
      gas: 'CO2',
      category: input.category || 'manual',
      category_label: FACTOR_CATEGORY_LABELS[input.category] || '用户手工输入',
      caliber: String(input.factor_caliber || '用户手工输入的口径，未经本平台核验'),
      region: input.region || null,
      data_year: input.data_year ?? null,
      version: null,
      publish_date: null,
      applicability: null,
      page_physical: null,
      page_printed: null,
      locator: null,
      original_url: null,
      original_sha256: null,
      evidence_level: 'user_input',
      model_verify_status: 'unavailable',
      calculable: true,
    };
  } else {
    throw new CalcInputError('未选择电力 CO2 因子：请显式选择因子，或手工输入因子数值与口径（系统不默认编值）');
  }

  // ---- 年度一致性：不把 2023 因子写成目标年 ----
  const warning = [];
  let referenceYearAccepted = true;
  if (!['number','string'].includes(typeof input.target_year) || String(input.target_year).trim()==='') throw new CalcInputError('目标年度必填');
  const targetYear = Number(input.target_year);
  if (!Number.isInteger(targetYear) || targetYear<1900 || targetYear>2100) throw new CalcInputError('目标年度须为1900—2100之间的整数年份');
  if (targetYear !== null && factor.data_year !== null && Number(factor.data_year) !== targetYear) {
    if (input.accept_reference_year !== true) {
      throw new CalcInputError(
        `年度不一致：所选因子为 ${factor.data_year} 数据年度，而目标年度为 ${targetYear}。` +
        '如需按参考年份计算，请显式确认「接受使用参考年份因子」；系统不会把参考年因子当成目标年因子。',
        { factor_data_year: factor.data_year, target_year: targetYear }
      );
    }
    referenceYearAccepted = true;
    warning.push(
      `结果按 **${factor.data_year} 数据年度**的电力因子计算，目标年度为 ${targetYear}；` +
      '两者不一致，已按你的显式确认使用参考年份因子。'
    );
  }

  const factorUnit = factor.standard_unit || factor.original_unit || 'kgCO2/kWh';
  if (factorUnit !== 'kgCO2/kWh') {
    throw new CalcInputError(`所选因子单位为 ${factorUnit}，本计算仅支持 kgCO2/kWh（不做隐式换算）`);
  }
  const tco2 = (kwh * Number(factor.value)) / 1000;

  if (factor.category === 'national_excl_market_nonfossil') {
    warning.push(
      '所选因子口径为「全国电力平均二氧化碳排放因子（**不包括市场化交易的非化石能源电量**）」，' +
      '与全国平均值（表1）口径不同，不能互换使用。'
    );
  }
  if (factor.category === 'national_fossil') {
    warning.push(
      '所选因子口径为「全国**化石能源电力**二氧化碳排放因子」，只覆盖化石能源电力，' +
      '与全国平均值口径不同；不是全口径电网排放因子。'
    );
  }
  if (factor.category === 'manual') {
    warning.push('因子为用户手工输入，未经平台核验；结果仅代表该输入下的算术结果。');
  }
  if (energy === 0) warning.push('活动数据为 0，结果为 0（0 活动量输出 0，不是缺数据）。');

  return {
    kind: 'electricity',
    gas: 'CO2',
    result_unit: 'tCO2',
    total_tco2: tco2,
    /** 明确不产出 CO2e：避免把 CO2 自动标成 CO2e */
    total_tco2e: null,
    gas_note: '结果是二氧化碳（CO2）排放量，不是 CO2 当量（CO2e）；本计算不做 GWP 折算。',
    formula: ELECTRICITY_FORMULA,
    formula_note: 'E(tCO2) = 活动数据(kWh) × 电力 CO2 因子(kgCO2/kWh) ÷ 1000',
    steps: [
      { step: '1. 活动数据单位换算', expression: `${energy} ${energyUnit} × ${unit.to_kwh} = ${kwh} kWh` },
      { step: '2. 代入计算', expression: `${kwh} kWh × ${factor.value} kgCO2/kWh ÷ 1000 = ${tco2} tCO2` },
    ],
    inputs: {
      energy,
      energy_unit: energyUnit,
      energy_kwh: kwh,
      target_year: targetYear,
      reference_year_accepted: referenceYearAccepted,
    },
    factor: {
      id: factor.id,
      source_code: factor.source_code,
      name: factor.name,
      value: Number(factor.value),
      unit: factorUnit,
      gas: factor.gas,
      category: factor.category,
      category_label: factor.category_label,
      caliber: factor.caliber,
      region: factor.region,
      data_year: factor.data_year,
      version: factor.version,
      publish_date: factor.publish_date,
      applicability: factor.applicability,
      page_physical: factor.page_physical,
      page_printed: factor.page_printed,
      locator: factor.locator,
      original_url: factor.original_url,
      original_sha256: factor.original_sha256,
      evidence_level: factor.evidence_level,
      model_verify_status: factor.model_verify_status,
      source_verified: factor.source_code !== 'manual',
    },
    assumptions: [
      '只计算外购电力的二氧化碳排放（范围二·电力），不含外购热力、燃料燃烧与工艺过程排放。',
      '未做绿电/市场化交易非化石电量的扣减；本计算**不**把绿电自动按 0 处理。',
      '因子是电力二氧化碳排放因子，不是产品全生命周期碳足迹因子，也不是 CCER 区域电网基准线因子。',
    ],
    warnings: warning,
    limitation:
      '本结果**不是** CCER 预计签发量，也不构成履约全口径核算；正式履约核算须按适用行业指南与实测数据完成。',
  };
}

/* ==================================================================== */
/*  三、燃料燃烧参考估算                                                 */
/* ==================================================================== */

export const FUEL_FORMULA = 'E = AD × NCV × CC ÷ 1000 × OF × 44/12';

/**
 * 燃料燃烧参考估算（CO2）。
 * AD 单位必须与 NCV 单位匹配：t ↔ GJ/t；万Nm³ ↔ GJ/万Nm³；Nm³ ↔ GJ/Nm³。
 * 单位不同一律拒绝（不做隐式换算）。
 */
export function calculateFuelCombustion(input = {}) {
  if (input.carbon_content_unit !== 'tC/TJ') throw new CalcInputError('单位热值含碳量单位须明确为tC/TJ');
  const amountUnit = String(input.amount_unit || '');
  const ncvUnit = String(input.ncv_unit || '');
  if (!FUEL_UNITS[amountUnit]) {
    throw new CalcInputError(
      `燃料消耗单位不支持：${amountUnit || '（未提供）'}。可选：${Object.keys(FUEL_UNITS).join('、')}`
    );
  }
  const expectedNcv = { t: 'GJ/t', '万Nm³': 'GJ/万Nm³', 'Nm³': 'GJ/Nm³' }[amountUnit];
  if (!ncvUnit) throw new CalcInputError('低位发热量单位缺失：请显式选择低位发热量单位');
  if (ncvUnit !== expectedNcv) {
    throw new CalcInputError(
      `单位不匹配：燃料消耗单位为 ${amountUnit}，低位发热量单位必须为 ${expectedNcv}（收到 ${ncvUnit}）。` +
      '本计算不做隐式单位换算。',
      { expected_ncv_unit: expectedNcv }
    );
  }

  const amount = readNumber(input.amount, { field: '燃料消耗量', min: 0, max: LIMITS.max_fuel_amount });
  const ncv = readNumber(input.ncv, { field: '低位发热量', min: 0, max: LIMITS.max_ncv });
  const cc = readNumber(input.carbon_content, { field: '单位热值含碳量', min: 0, max: LIMITS.max_cc });
  const of = readNumber(input.oxidation_rate, {
    field: '碳氧化率', min: 0, max: LIMITS.max_oxidation,
  });
  if (amount > 0 && (ncv === 0 || cc === 0)) {
    throw new CalcInputError(
      '因子缺失：低位发热量与单位热值含碳量在有活动数据时不得为 0；' +
      '系统不提供默认因子，请按实测值或适用指南给定值填写并注明出处。'
    );
  }
  if (amount > 0 && of === 0) {
    throw new CalcInputError('碳氧化率不得为 0（有燃料消耗时）：请填写 0—1 之间的实测/指南值');
  }

  const energyGj = amount * ncv;                       // GJ
  const carbonT = (energyGj * cc) / 1000;              // tC
  const co2T = carbonT * of * (44 / 12);               // tCO2

  const warnings = [];
  if (amount === 0) warnings.push('活动数据为 0，结果为 0（0 活动量输出 0，不是缺数据）。');
  warnings.push(
    '本计算按你输入的 NCV / 单位热值含碳量 / 氧化率做**参考估算**；这些因子必须来自实测或适用行业指南，' +
    '本平台不提供默认值，也不声称这是正式履约全口径核算。'
  );

  return {
    kind: 'fuel_combustion',
    gas: 'CO2',
    result_unit: 'tCO2',
    total_tco2: co2T,
    total_tco2e: null,
    gas_note: '结果是燃料燃烧产生的二氧化碳（CO2），不是 CO2 当量（CO2e）。',
    formula: FUEL_FORMULA,
    formula_note: 'E(tCO2) = 消耗量 × 低位发热量 × 单位热值含碳量 ÷ 1000 × 氧化率 × 44/12',
    steps: [
      { step: '1. 活动数据 × 低位发热量 = 能源消费量', expression: `${amount} ${amountUnit} × ${ncv} ${ncvUnit} = ${energyGj} GJ` },
      { step: '2. 能源消费量 × 单位热值含碳量 ÷ 1000 = 碳量', expression: `${energyGj} GJ × ${cc} tC/TJ ÷ 1000 = ${carbonT} tC` },
      { step: '3. 碳量 × 氧化率 × 44/12 = CO2 排放量', expression: `${carbonT} tC × ${of} × 44/12 = ${co2T} tCO2` },
    ],
    inputs: {
      amount, amount_unit: amountUnit,
      ncv, ncv_unit: ncvUnit,
      carbon_content: cc, carbon_content_unit: 'tC/TJ',
      oxidation_rate: of,
      energy_gj: energyGj,
      carbon_t: carbonT,
      carbon_to_co2_ratio: 44 / 12,
    },
    factor: {
      source_code: 'user_input',
      name: '用户输入的燃料特性参数',
      value: null,
      unit: '—',
      category: 'user_input',
      category_label: '用户输入（未经平台核验）',
      original_url: null,
      evidence_level: 'user_input',
      model_verify_status: 'unavailable',
      source_verified: false,
    },
    assumptions: [
      '单位热值含碳量按 tC/TJ 口径；碳氧化率取 0—1（如 0.99 表示 99%）。',
      '44/12 为 CO2 与 C 的摩尔质量比（确定性常数）。',
      '未包含 CH4、N2O 等其他温室气体，因此结果不是 CO2e。',
    ],
    warnings,
    limitation:
      '本结果是参考估算，不构成履约全口径核算，也**不是** CCER 预计签发量。',
  };
}

/* ==================================================================== */
/*  四、多能源分项汇总                                                   */
/* ==================================================================== */

/**
 * 多能源分项汇总：区分**直接排放**（燃料燃烧，范围一）与**间接排放**（外购电力，范围二），
 * 并明确气体口径为 CO2（不自动升级为 CO2e）；不给出「总量即 CCER 签发量」的结论。
 */
export function summarizeEmissions(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new CalcInputError('至少需要一项计算分项');
  }
  if (items.length > 50) throw new CalcInputError('分项数量过多（上限 50）');
  const rows = items.map((it, i) => {
    const kind = String(it.kind || '');
    if (kind === 'electricity') return { index: i + 1, scope: 'scope2_indirect', ...calculateElectricity(it) };
    if (kind === 'fuel_combustion') return { index: i + 1, scope: 'scope1_direct', ...calculateFuelCombustion(it) };
    throw new CalcInputError(`第 ${i + 1} 项类型不支持：${kind || '（未提供）'}`);
  });
  const sum = (pred) => rows.filter(pred).reduce((s, r) => s + r.total_tco2, 0);
  const direct = sum((r) => r.scope === 'scope1_direct');
  const indirect = sum((r) => r.scope === 'scope2_indirect');
  return {
    kind: 'summary',
    gas: 'CO2',
    result_unit: 'tCO2',
    items: rows.map((r) => ({
      index: r.index, kind: r.kind, scope: r.scope, total_tco2: r.total_tco2,
      warning_count: (r.warnings || []).length,
    })),
    subtotals: {
      direct_tco2: direct,
      indirect_tco2: indirect,
      total_tco2: direct + indirect,
      total_tco2e: null,
    },
    gas_note:
      '直接排放（燃料燃烧）与间接排放（外购电力）分列，合计口径为 **CO2**；' +
      '未包含其他温室气体，不把 CO2 自动标成 CO2e。',
    warnings: [
      '汇总只做算术相加：分项之间不得重复计入同一活动数据（例如已计入外购电力的电量不得再作为燃料折算）。',
    ],
    limitation:
      '汇总结果**不是** CCER 预计签发量，也不构成履约全口径核算或第三方核查结论。',
  };
}

/* ==================================================================== */
/*  五、结果 JSON（供下载，不保存）                                     */
/* ==================================================================== */

export function buildResultJson(kind, result, { meta = {} } = {}) {
  return {
    schema: 'ccer-accounting-calc/1',
    kind,
    generated_at: new Date().toISOString(),
    platform: 'CCER 公开信息平台 · 碳计算与因子',
    disclaimer:
      '本文件由确定性计算程序生成，仅代表所列输入与所引用公开因子下的算术结果；' +
      '不是 CCER 预计签发量，不构成履约全口径核算、审计或投资建议。' +
      '平台不保存用户输入与计算结果。',
    ...meta,
    result,
  };
}
