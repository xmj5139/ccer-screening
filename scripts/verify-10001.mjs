#!/usr/bin/env node
/**
 * CCER-10-001 交叉验证脚本
 * ============================================================================
 * 用两套完全独立的实现计算同一组输入，逐项比对：
 *   实现 A：插件 src/methodologies/ccer-10-001.mjs 的 compute()
 *   实现 B：测试用独立实现 test/official-10-001.mjs（按原文公式重写）
 * 另外比对插件自检样例中声明的 expect 值。
 *
 *   node scripts/verify-10001.mjs
 */
import { getDb, all } from '../src/core/db.mjs';
import mod from '../src/methodologies/ccer-10-001.mjs';
import { FactorRegistry } from '../src/methodologies/lib/calc-kit.mjs';
import { annualEmissionReduction, UNRESOLVED, OFFICIAL_DEFAULTS } from '../test/official-10-001.mjs';

getDb();
const factors = new FactorRegistry(all('SELECT * FROM factor_version'));
const CEF = UNRESOLVED.CEF_CH4.stoichiometric_candidate;

const SCENARIO = mod.plugin.scenarios.base;
let failures = 0;
const check = (label, a, b, tol = 0.01) => {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
  if (!ok) failures += 1;
  console.log(`    ${ok ? '✅' : '❌'} ${label.padEnd(28)} 插件=${Number(a).toFixed(6).padStart(18)}  独立=${Number(b).toFixed(6).padStart(18)}`);
  return ok;
};

for (const s of mod.plugin.selfCheckSamples) {
  console.log(`\n=== ${s.name}`);

  // ---- 实现 A：插件 ----
  const out = mod.plugin.compute(s.inputs, {
    factors,
    scenario: 'base',
    scenarioLabel: '基准情景',
    scenarioMultipliers: SCENARIO.multipliers,
    baseDate: '2026-09-24',
    project: {},
  });

  if (s.expectRejection) {
    const { errors } = mod.plugin.validate(s.inputs);
    const hit = errors.some((e) => e.kind === s.expectRejection);
    console.log(`    ${hit ? '✅' : '❌'} 应被拒绝（kind=${s.expectRejection}）：实际 errors = ${JSON.stringify(errors.map((e) => e.kind))}`);
    if (!hit) failures += 1;
    continue;
  }

  // ---- 与插件声明的 expect 比对 ----
  console.log('  [1] 插件输出 vs 样例声明的期望值');
  const cp = out.checkpoints || {};
  for (const [k, v] of Object.entries(s.expect)) {
    if (typeof v !== 'number') continue;
    if (!(k in cp)) {
      console.log(`    ⏭ ${k.padEnd(28)} checkpoints 中无此键，跳过`);
      continue;
    }
    check(k, cp[k], v, s.tolerance ?? 0.01);
  }

  // ---- 实现 B：独立实现 ----
  console.log('  [2] 插件输出 vs 独立实现（按原文公式重写）');
  const p = s.inputs;
  const util = p.heat_utilization_route === '热电联产' ? 'chp'
    : p.heat_utilization_route === '发电' ? 'power' : 'heat';
  const rho = OFFICIAL_DEFAULTS.rho_CH4;
  // 把年度常温常压流量合计 / 小时流量统一折算成逐小时记录数组（浓度取代表值）
  let hoursArr;
  if (p.raw_flow_m3h && p.gas_temp_c !== undefined && p.gas_pressure_kpa !== undefined) {
    const fNpt = (p.raw_flow_m3h * OFFICIAL_DEFAULTS.T_NPT * p.gas_pressure_kpa)
      / ((273.15 + p.gas_temp_c) * OFFICIAL_DEFAULTS.P_NPT);
    hoursArr = Array.from({ length: p.hours_per_year }, () => ({ F_NPT: fNpt, PC_CH4: p.ch4_concentration_pct }));
  } else if (p.npt_flow_m3h) {
    // 直接给出小时常温常压流量
    hoursArr = Array.from({ length: p.hours_per_year }, () => ({ F_NPT: p.npt_flow_m3h, PC_CH4: p.ch4_concentration_pct }));
  } else {
    const perHour = p.recovery_volume_nm3 / p.hours_per_year;
    hoursArr = Array.from({ length: p.hours_per_year }, () => ({ F_NPT: perHour, PC_CH4: p.ch4_concentration_pct }));
  }
  const qHeat = p.steam_mass_t
    ? (p.steam_mass_t * (p.steam_enthalpy_kjkg - 83.74)) / 1000
    : p.hot_water_mass_t
      ? (p.hot_water_mass_t * (p.hot_water_temp_c - 20) * 4.1868) / 1000
      : 0;

  const indep = annualEmissionReduction({
    hours: hoursArr,
    utilization: util,
    ELEC_export_MWh: p.elec_export_mwh || 0,
    Q_HEAT: qHeat,
    EF_grid_OM: p.ef_grid_om,
    EF_grid_BM: p.ef_grid_bm,
    CONS_ELEC: p.cons_elec_mwh,
    TDL: p.tdl,
    eta_ELEC: p.eta_elec,
    EFF: p.destruction_efficiency ?? OFFICIAL_DEFAULTS.EFF,
    CEF_CH4: CEF,
  });

  const cps = out.checkpoints || {};
  check('V_CH4 (m³)', cps.v_ch4_nm3, (indep.MM_measured / rho) * 1000, 1);
  check('MM′_y (tCH₄)', cps.mm_measured_t, indep.MM_measured, 0.01);
  check('MM″_y (tCH₄)', cps.mm_derived_t, indep.MM_inferred, 0.01);
  check('MM_y (tCH₄)', cps.mm_t, indep.MM, 0.01);
  check('BE_MR,y', cps.be_mr_tco2e, indep.BE_MR, 0.01);
  check('EF_grid,CM,y', cps.ef_grid_cm, indep.EF_CM, 1e-9);
  check('BE_ELEC,y', cps.be_elec_tco2e, indep.BE_ELEC, 0.01);
  check('BE_HEAT,y', cps.be_heat_tco2e, indep.BE_HEAT, 0.01);
  check('BE_y', cps.be_tco2e, indep.BE, 0.01);
  check('PE_ME,y', cps.pe_me_tco2e, indep.PE_ME, 0.01);
  check('PE_MD,y', cps.pe_md_tco2e, indep.PE_MD, 0.01);
  check('PE_UM,y', cps.pe_um_tco2e, indep.PE_UM, 0.01);
  check('PE_y', cps.pe_tco2e, indep.PE, 0.01);
  check('ER_y (tCO₂e/年)', out.er_annual, indep.ER, 0.02);
}

console.log('\n' + '='.repeat(80));
console.log(`两套实现的差异项数：${failures}`);
console.log(failures === 0
  ? '结论：插件实现与按原文公式重写的独立实现在全部样例上一致。'
  : '结论：存在不一致，必须修正后才能标记为可复算。');
process.exit(failures === 0 ? 0 : 1);
