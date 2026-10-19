/**
 * 全局物理常数与温室气体潜势值
 * ============================================================================
 * 这些常数的**数值本身**可从公开权威文献核实，但每个方法学指定引用的是哪一版
 * （如 IPCC 第几次评估报告、哪一年国家清单指南、哪个区域电网排放因子年份）
 * 必须由领域专家逐方法学确认。因此：
 *   value_status = 'verified'   —— 数值与出处已核实，仍需确认方法学引用版本
 *   value_status = 'placeholder'—— 缺省值/效率值，必须由领域专家确认后方可用于正式报告
 */

export const GLOBAL_FACTORS = [
  {
    factor_key: 'gwp.ch4.fossil.ar5',
    name: '甲烷（化石源）100 年全球增温潜势 GWP₁₀₀',
    value: 28,
    unit: 'tCO₂e/tCH₄',
    source_ref: 'IPCC 第五次评估报告（AR5, 2013）第一工作组报告第 8 章，化石源甲烷 100 年 GWP',
    source_year: 2013,
    gwp_assessment_report: 'IPCC AR5',
    value_status: 'verified',
    verification_note: '数值已核实。须由领域专家确认所选方法学指定引用的是 AR5 还是 AR6；AR6 化石源甲烷 GWP₁₀₀ = 29.8。采用 AR5 属保守选择（减排量更小）。',
    reasonable_min: 1,
    reasonable_max: 100,
  },
  {
    factor_key: 'gwp.ch4.fossil.ar6',
    name: '甲烷（化石源）100 年 GWP（AR6）',
    value: 29.8,
    unit: 'tCO₂e/tCH₄',
    source_ref: 'IPCC 第六次评估报告（AR6, 2021）第一工作组报告第 7 章表 7.15，化石源甲烷 100 年 GWP',
    source_year: 2021,
    gwp_assessment_report: 'IPCC AR6',
    value_status: 'verified',
    verification_note: '仅当所选方法学明确引用 AR6 时使用。',
    reasonable_min: 1,
    reasonable_max: 100,
  },
  {
    factor_key: 'rho.ch4.standard',
    name: '标准状态下甲烷密度（0 ℃、101.325 kPa）',
    value: 0.716,
    unit: 'kg/Nm³',
    source_ref: '标准状态（0 ℃、101.325 kPa）下甲烷密度，由 CH₄ 摩尔质量 16.043 kg/kmol ÷ 标准摩尔体积 22.414 Nm³/kmol 得 0.7158 kg/Nm³',
    source_year: null,
    value_status: 'verified',
    verification_note:
      '物理常数，可由定义复算：16.043 / 22.414 = 0.7158 kg/Nm³。' +
      '⚠️ 仅适用于以 0 ℃ 为基准的标准状态。' +
      '若所选方法学定义的是「常温常压」（20 ℃、1 个标准大气压），则必须使用 16.043 / 24.055 = 0.6669 ≈ 0.67 kg/Nm³。' +
      'CCER-10-001-V01 §6.3 公式(3) 明确取 0.67，故该方法学使用其自带的 c10-001.rho.ch4，不使用本全局因子。',
    reasonable_min: 0.6,
    reasonable_max: 0.8,
  },
  {
    factor_key: 'molar.volume.standard',
    name: '标准摩尔体积',
    value: 22.414,
    unit: 'Nm³/kmol',
    source_ref: '理想气体在 0 ℃、101.325 kPa 下的摩尔体积',
    source_year: null,
    value_status: 'verified',
    verification_note: '物理常数。',
    reasonable_min: 22,
    reasonable_max: 23,
  },
  {
    factor_key: 'mw.ch4',
    name: '甲烷摩尔质量',
    value: 16.043,
    unit: 'kg/kmol',
    source_ref: 'IUPAC 原子量：C 12.011 + H 4×1.008',
    source_year: null,
    value_status: 'verified',
    verification_note: '物理常数。',
    reasonable_min: 16,
    reasonable_max: 16.1,
  },
  {
    factor_key: 'ef.co2.ch4.combustion',
    name: '甲烷完全燃烧化学计量 CO₂ 排放因子',
    value: 2.7432,
    unit: 'tCO₂/tCH₄',
    source_ref: 'CH₄ + 2O₂ → CO₂ + 2H₂O，按 M(CO₂)/M(CH₄) = 44.009/16.043 = 2.7432',
    source_year: null,
    value_status: 'verified',
    verification_note: '化学计量常数，可由分子量复算。用于基准线为火炬燃烧时的 CO₂ 部分。',
    reasonable_min: 2.7,
    reasonable_max: 2.8,
  },
];
