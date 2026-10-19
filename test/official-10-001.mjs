/**
 * CCER-10-001-V01 官方公式链的**独立实现**（仅用于测试比对）
 * ============================================================================
 * 目的：为「整改清单 P0-1」提供独立复算依据。
 *
 * 【独立性声明】
 * 本文件不 import 任何 `src/methodologies/**` 的代码，也不复用插件的中间量。
 * 它逐字按照方法学原文 §6.3–§6.6 的公式（1）—（18）重新实现一遍，
 * 用于与插件的输出交叉比对。若两处实现不一致，说明至少有一处写错了。
 *
 * 来源：生态环境部《温室气体自愿减排项目方法学 甲烷体积浓度低于8%的煤矿低浓度瓦斯和
 *       风排瓦斯利用（CCER—10—001—V01）》，环办气候函〔2025〕1号，
 *       https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250103708572385358.pdf
 *
 * 【原文硬约束】（每一项都在下方实现中体现）
 *   §2     仅适用井工煤矿（不含废弃或关闭矿井）、仅限无焰氧化、仅限发电/供热/热电联产
 *   §2     浓度 < 8%，且不得由 ≥8% 的瓦斯人为稀释得到
 *   §2     减排量须产生于监测数据联网（完成联网试运行）之后
 *   §5.2   计入期最长 10 年
 *   §6.1   基准线为瓦斯全部排空 + 外供电替代电网 + 外供热替代天然气供热
 *   §6.2   额外性免予论证
 *   §6.3   公式(2)：MM_y 取实测与推算的**较小值**（保守原则）
 *   §6.3   公式(3)：ρ_CH4 = 0.67 kg/m³（常温常压 20 ℃、1 atm）
 *   §6.4   公式(13)：CEF_CH4 —— 原文未给出该参数的定义与数值（见 UNRESOLVED）
 *   §6.5   泄漏忽略不计 → ER 公式中**没有泄漏项**
 *   §6.6   公式(18)：ER_y = BE_y − PE_y
 *   §6.7a) 混配入口流量 > 抽采泵出口流量之和 → 不符合适用条件
 *   §6.7b) 浓度 ≥ 8% 的时段及其对应量须扣除
 */

/* ---------------- 官方默认参数（方法学表 2—表 6 与 §6.4、§6.5） ---------------- */
export const OFFICIAL_DEFAULTS = {
  GWP_CH4: 28,        // 表 2，参考 IPCC 第五次评估报告
  omega_OM: 0.5,      // 表 3，电量边际排放因子权重
  omega_BM: 0.5,      // 表 4，容量边际排放因子权重
  EF_HEAT: 0.06,      // 表 5，参考天然气供热的排放因子，tCO2/GJ
  EFF: 0.9,           // 表 6，无焰氧化装置甲烷销毁效率，参考 NB/T 51012-2014 5.5.1
  eta_FOEF: 0.91,     // §6.4，无焰氧化装置热利用效率
  eta_EH: 0.86,       // §6.4，热电联产机组综合效率
  eta_BOEF: 0.88,     // §6.4，锅炉热效率
  rho_CH4: 0.67,      // §6.3 公式(3) 原文数值，常温常压(20℃,1atm) kg/m³
  T_NPT: 20 + 273.15, // §6.3 公式(4) 常温的开尔文温度 K
  P_NPT: 101.325,     // §6.3 公式(4) 标准大气压 kPa
};

/**
 * 原文未给出定义与数值的参数。**不得臆造**。
 * 候选值来自化学计量（CH4 + 2O2 → CO2 + 2H2O）：M(CO2)/M(CH4) = 44.009/16.043 = 2.7432。
 * 在领域专家确认之前，任何测算都必须把它当作未确认项处理。
 */
export const UNRESOLVED = {
  CEF_CH4: {
    appears_in: '公式（13）PE_MD,y = MM_y × EFF_y × CEF_CH4',
    defined_in_pdf: false,
    stoichiometric_candidate: 44.009 / 16.043,
    stoichiometric_note: '按完全燃烧化学计量推导，候选值 2.7432 tCO2/tCH4',
    unit: 'tCO2/tCH4',
  },
};

/* ---------------------------- 公式(4)/(20)/(21) ---------------------------- */
/** 工况流量 → 常温常压流量 */
export function toNormalFlow({ F_operating, P_kPa, t_C }) {
  return (F_operating * OFFICIAL_DEFAULTS.T_NPT * P_kPa) / ((273.15 + t_C) * OFFICIAL_DEFAULTS.P_NPT);
}

/* ------------------------------- 公式(3) ---------------------------------- */
/**
 * 实测甲烷量 MM'_y，单位 tCH4
 * 原文：MM'_y = Σ_{h=1}^{time_y} F_NPT,h × PC_CH4,h × ρ_CH4 × 10^-3
 * 其中 PC_CH4,h 以 % 给出，故实现时除以 100；每个小时项的隐性时间因子为 1 h。
 * @param {Array<{F_NPT:number, PC_CH4:number}>} hours 逐小时记录（F_NPT 单位 m³/h，PC_CH4 单位 %）
 */
export function measuredMethane(hours) {
  return hours.reduce(
    (sum, h) => sum + h.F_NPT * (h.PC_CH4 / 100) * OFFICIAL_DEFAULTS.rho_CH4 * 1e-3,
    0
  );
}

/* ------------------------- 公式(15)/(16)/(17) 推算甲烷量 ------------------- */
/** 热电联产 */
export function inferredMethaneCHP({ Q_HEAT, ELEC_export_MWh, EFF, eta_FOEF, eta_EH }) {
  return (Q_HEAT + ELEC_export_MWh * 3.6) / (EFF * eta_FOEF * eta_EH * 55.64);
}
/** 仅发电 */
export function inferredMethanePower({ ELEC_export_MWh, EFF, eta_FOEF, eta_ELEC }) {
  return (ELEC_export_MWh * 3.6) / (EFF * eta_FOEF * eta_ELEC * 55.64);
}
/** 仅供热 */
export function inferredMethaneHeat({ Q_HEAT, EFF, eta_FOEF, eta_BOEF }) {
  return Q_HEAT / (EFF * eta_FOEF * eta_BOEF * 55.64);
}

/* --------------------------------- 公式(6) -------------------------------- */
export function combinedMarginEF({ EF_grid_OM, EF_grid_BM, omega_OM, omega_BM }) {
  return EF_grid_OM * omega_OM + EF_grid_BM * omega_BM;
}

/* ---------------------- 公式(8)/(9) 蒸汽与热水热量换算 ---------------------- */
export function steamHeat({ Ma_st, En_st }) {
  return Ma_st * (En_st - 83.74) * 1e-3;
}
export function waterHeat({ Ma_w, t_w }) {
  return Ma_w * (t_w - 20) * 4.1868 * 1e-3;
}

/* --------------------------------- 公式(12) ------------------------------- */
export function gridConsumption({ CONS_ELEC, TDL }) {
  return CONS_ELEC / (1 - TDL);
}

/* ========================================================================== */
/*  完整减排量链（公式 1—18）                                                  */
/* ========================================================================== */

/**
 * @param {object} p
 * @param {Array<{F_NPT:number,PC_CH4:number}>} p.hours 实测逐小时记录
 * @param {'power'|'heat'|'chp'} p.utilization 热能利用方式
 * @param {number} p.ELEC_export_MWh 外供电量 MW·h
 * @param {number} p.Q_HEAT 外供热量 GJ
 * @param {number} p.EF_grid_OM 电量边际排放因子 tCO2/MW·h
 * @param {number} p.EF_grid_BM 容量边际排放因子 tCO2/MW·h
 * @param {number} p.CONS_ELEC 项目下网电量 MW·h
 * @param {number} p.TDL 电网输配电损失率（小数）
 * @param {number} [p.eta_ELEC] 发电效率（仅 power 模式需要）
 * @param {number} [p.EFF] 销毁效率（默认 0.9）
 * @param {number} [p.CEF_CH4] 甲烷碳排放因子（未确认，必须显式传入）
 */
export function annualEmissionReduction(p) {
  const D = OFFICIAL_DEFAULTS;
  const EFF = p.EFF ?? D.EFF;
  const CEF = p.CEF_CH4; // 不设默认值：未确认项必须显式传入，避免静默臆造
  if (CEF === undefined || CEF === null) {
    throw new Error('CEF_CH4 未提供：该方法学原文未定义此参数，测试必须显式传入候选值。');
  }

  // --- 公式(3) 实测甲烷量 ---
  const MM_measured = measuredMethane(p.hours);

  // --- 公式(15)/(16)/(17) 推算甲烷量 ---
  let MM_inferred;
  if (p.utilization === 'chp') {
    MM_inferred = inferredMethaneCHP({
      Q_HEAT: p.Q_HEAT, ELEC_export_MWh: p.ELEC_export_MWh,
      EFF, eta_FOEF: D.eta_FOEF, eta_EH: D.eta_EH,
    });
  } else if (p.utilization === 'power') {
    MM_inferred = inferredMethanePower({
      ELEC_export_MWh: p.ELEC_export_MWh, EFF,
      eta_FOEF: D.eta_FOEF, eta_ELEC: p.eta_ELEC,
    });
  } else {
    MM_inferred = inferredMethaneHeat({
      Q_HEAT: p.Q_HEAT, EFF, eta_FOEF: D.eta_FOEF, eta_BOEF: D.eta_BOEF,
    });
  }

  // --- 公式(2) MM_y 取较小值（保守原则）---
  const MM = Math.min(MM_measured, MM_inferred);

  // --- 公式(2) 基准线：瓦斯排空 ---
  const BE_MR = MM * D.GWP_CH4;

  // --- 公式(6) 组合边际排放因子 ---
  const EF_CM = combinedMarginEF({
    EF_grid_OM: p.EF_grid_OM, EF_grid_BM: p.EF_grid_BM,
    omega_OM: D.omega_OM, omega_BM: D.omega_BM,
  });

  // --- 公式(5) 外供电替代、公式(7) 外供热替代 ---
  const BE_ELEC = p.ELEC_export_MWh * EF_CM;
  const BE_HEAT = p.Q_HEAT * D.EF_HEAT;

  // --- 公式(1) 基准线排放量 ---
  const BE = BE_MR + BE_ELEC + BE_HEAT;

  // --- 公式(12)(11) 项目耗电排放 ---
  const CONS_grid = gridConsumption({ CONS_ELEC: p.CONS_ELEC, TDL: p.TDL });
  const PE_ME = CONS_grid * EF_CM;

  // --- 公式(13) 氧化后排放、公式(14) 未氧化逃逸 ---
  const PE_MD = MM * EFF * CEF;
  const PE_UM = D.GWP_CH4 * MM * (1 - EFF);

  // --- 公式(10) 项目排放量 ---
  const PE = PE_ME + PE_MD + PE_UM;

  // --- 公式(18) 减排量：注意没有泄漏项（§6.5 泄漏忽略不计）---
  const ER = BE - PE;

  return {
    MM_measured, MM_inferred, MM,
    EF_CM,
    BE_MR, BE_ELEC, BE_HEAT, BE,
    CONS_grid, PE_ME, PE_MD, PE_UM, PE,
    ER,
    leakage: 0,
    steps: { EFF, CEF_CH4: CEF, rho_CH4: D.rho_CH4, GWP_CH4: D.GWP_CH4, EF_HEAT: D.EF_HEAT },
  };
}

/* ========================================================================== */
/*  §6.7 合规性判断                                                            */
/* ========================================================================== */

/** 公式(19)：返回 true 表示**不符合**适用条件（混配入口流量大于抽采泵出口流量之和） */
export function violatesApplicability({ sumDrainageFlow, importFlow }) {
  return sumDrainageFlow < importFlow;
}

/** §6.7 b)：返回应扣除的时段/量；浓度 ≥ 8% 的时段必须从 time_y 中扣除 */
export function deductOverLimitHours(hours, { limitPct = 8 } = {}) {
  const kept = hours.filter((h) => h.PC_CH4 < limitPct);
  const deducted = hours.filter((h) => h.PC_CH4 >= limitPct);
  return { kept, deducted, deductedHours: deducted.length, keptHours: kept.length };
}
