/**
 * 46-v2-accounting-calc.test.mjs —— 碳排放计算（纯函数、无副作用、可复算）
 * ============================================================================
 * 断言重点（docs/39 第 99 条）：
 *   kWh/MWh/万kWh 等价及缺单位/年错配；燃料公式量纲/缺参；
 *   校验 finite、非负、数量上限、非法单位、过长输入与 NaN/Infinity；0 活动量输出 0；
 *   缺年份/地区/因子清楚报错；区域选择不静默落回全国；三种口径必须显式选择；
 *   不把 CO2 自动标成 CO2e；结果不保存用户输入。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertThrows, finish } from './v2-helpers.mjs';

const ctx = await setupV2();
console.log('\n[v2-46] 碳排放计算：纯函数与输入校验');

const acc = await import('../src/services/accounting-svc.mjs');
const calc = await import('../src/services/carbon-calc-svc.mjs');
acc.seedAccountingBase();

const national = acc.selectableFactors({ data_year: 2023, category: 'national_average' })[0];
const beijing = acc.selectableFactors({ data_year: 2023, category: 'provincial_average', region: '北京' })[0];
const nonFossilExcluded = acc.selectableFactors({ data_year: 2023, category: 'national_excl_market_nonfossil' })[0];
const fossil = acc.selectableFactors({ data_year: 2023, category: 'national_fossil' })[0];

/* ==================================================================== */
/*  一、外购电力：单位等价与样本                                          */
/* ==================================================================== */

test('样本：100 万 kWh × 全国 2023 平均 0.5306 = 530.6 tCO2', () => {
  const r = calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: national.id, target_year: 2023 });
  assertEqual(r.total_tco2, 530.6);
  assertEqual(r.result_unit, 'tCO2');
  assertEqual(r.gas, 'CO2');
  assertEqual(r.inputs.energy_kwh, 1000000);
  assertEqual(r.factor.value, 0.5306);
  assertEqual(r.factor.data_year, 2023);
  assertEqual(r.formula, 'E = AD × EF ÷ 1000');
});

test('100 万 kWh、1000 MWh、100 万kWh 三种单位等价（服务端严格换算）', () => {
  const a = calc.calculateElectricity({ energy: 1000000, energy_unit: 'kWh', factor_id: national.id, target_year: 2023 });
  const b = calc.calculateElectricity({ energy: 1000, energy_unit: 'MWh', factor_id: national.id, target_year: 2023 });
  const c = calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: national.id, target_year: 2023 });
  assertEqual(a.total_tco2, b.total_tco2);
  assertEqual(b.total_tco2, c.total_tco2);
  assertEqual(a.inputs.energy_kwh, 1000000);
  assertEqual(b.inputs.energy_kwh, 1000000);
  assertEqual(c.inputs.energy_kwh, 1000000);
});

test('缺单位 / 非法单位一律拒绝，不做隐式假设', () => {
  assertThrows(() => calc.calculateElectricity({ energy: 100, factor_id: national.id, target_year: 2023 }), '缺单位应拒绝');
  assertThrows(() => calc.calculateElectricity({ energy: 100, energy_unit: '度', factor_id: national.id, target_year: 2023 }), '非法单位应拒绝');
  let msg = '';
  try {
    calc.calculateElectricity({ energy: 100, energy_unit: '度', factor_id: national.id, target_year: 2023 });
  } catch (e) {
    msg = e.message; }
  assertIncludes(msg, '电量单位不支持');
  assertIncludes(msg, 'kWh');
});

test('未选择因子时要求显式选择或手工输入，不默认编值', () => {
  let msg = '';
  try {
    calc.calculateElectricity({ energy: 100, energy_unit: '万kWh' });
  } catch (e) {
    msg = e.message; }
  assertIncludes(msg, '未选择电力 CO2 因子');
  assertIncludes(msg, '不默认编值');
});

test('选择区域/省份时不会静默落回全国平均', () => {
  const r = calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: beijing.id, target_year: 2023 });
  assertEqual(r.factor.value, 0.5554, '北京应使用北京因子，而不是全国 0.5306');
  assertEqual(r.factor.region, '北京');
  assert(r.factor.value !== national.value);
  // 请求一个不存在的省份因子 → 明确报错并给出可用清单，而不是回落
  let detail = null;
  try {
    calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', source_code: 'mee_electricity_factor_2023', category: 'provincial_average', region: '西藏', data_year: 2023 });
  } catch (e) {
    detail = e.detail; }
  assert(detail && Array.isArray(detail.available), '应返回可用因子清单而不是静默回落');
  assert(!detail.available.some((f) => f.region === '西藏'), '原文没有西藏，就不能出现在可用清单里');
});

test('目标年与因子数据年不一致：必须先显式接受参考年份', () => {
  let msg = '';
  try {
    calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: national.id, target_year: 2026 });
  } catch (e) {
    msg = e.message; }
  assertIncludes(msg, '年度不一致');
  assertIncludes(msg, '2023');
  assertIncludes(msg, '2026');
  const ok = calc.calculateElectricity({
    energy: 100, energy_unit: '万kWh', factor_id: national.id, target_year: 2026, accept_reference_year: true });
  assertEqual(ok.inputs.target_year, 2026);
  assertEqual(ok.inputs.reference_year_accepted, true);
  assert(ok.warnings.some((w) => w.includes('2023 数据年度')), '显式接受后仍必须在结果里写明参考年份');
  assert(!JSON.stringify(ok).includes('2026 数据年度'), '不能把 2023 因子写成 2026');
});

test('0.6096 / 0.8273 各有独立口径约束，必须由用户显式选择并显示口径', () => {
  const a = calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: nonFossilExcluded.id, target_year: 2023 });
  assertEqual(a.total_tco2, 609.6);
  assert(a.warnings.some((w) => w.includes('不包括市场化交易的非化石能源电量')), '必须提示表4 口径');
  assertIncludes(a.factor.caliber, '不得互换');
  const b = calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: fossil.id, target_year: 2023 });
  assertEqual(b.total_tco2, 827.3);
  assert(b.warnings.some((w) => w.includes('化石能源电力')), '必须提示表5 口径');
  assert(a.factor.category !== b.factor.category && b.factor.category !== national.category);
  assert(nonFossilExcluded.id !== national.id && fossil.id !== national.id, '三种口径必须是三条独立可选因子');
});

test('结果不把 CO2 标成 CO2e，也不推断绿电为 0', () => {
  const r = calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: national.id, target_year: 2023 });
  assertEqual(r.total_tco2e, null, 'CO2 结果不得自动给出 CO2e');
  assertIncludes(r.gas_note, '不是 CO2 当量');
  assert(r.assumptions.some((x) => x.includes('不') && x.includes('绿电')), '必须声明未做绿电扣减');
  assertIncludes(r.limitation, '不是');
  assertIncludes(r.limitation, 'CCER 预计签发量');
});

test('0 活动量输出 0（明确是 0，不是缺数据）', () => {
  const r = calc.calculateElectricity({ energy: 0, energy_unit: 'kWh', factor_id: national.id, target_year: 2023 });
  assertEqual(r.total_tco2, 0);
  assert(r.warnings.some((w) => w.includes('0 活动量')));
});

/* ==================================================================== */
/*  二、输入校验：finite / 非负 / 上限 / 过长 / NaN / Infinity           */
/* ==================================================================== */

test('拒绝负数、NaN、Infinity、非数值、超长字符串', () => {
  const cases = [
    [{ energy: -1, energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '不得小于'],
    [{ energy: 'NaN', energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '有限数值'],
    [{ energy: Infinity, energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '有限数值'],
    [{ energy: 'Infinity', energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '有限数值'],
    [{ energy: 'abc', energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '有限数值'],
    [{ energy: '1'.repeat(80), energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '输入过长'],
    [{ energy: 1e13, energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '不得大于'],
    [{ energy: null, energy_unit: 'kWh', factor_id: national.id, target_year: 2023 }, '必填项缺失'],
  ];
  for (const [input, expect] of cases) {
    let msg = '';
    try {
      calc.calculateElectricity(input); } catch (e) {
      msg = e.message; }
    assertIncludes(msg, expect, `输入 ${JSON.stringify(input.energy) } 应被拒绝并说明原因`);
  }
});

test('千分位输入可解析（研究场景常见），但结果仍为有限数', () => {
  const r = calc.calculateElectricity({ energy: '1,000,000', energy_unit: 'kWh', factor_id: national.id, target_year: 2023 });
  assertEqual(r.total_tco2, 530.6);
});

/* ==================================================================== */
/*  三、燃料燃烧：量纲与缺参                                             */
/* ==================================================================== */

test('燃料公式量纲：E = AD × NCV × CC ÷ 1000 × OF × 44/12', () => {
  const r = calc.calculateFuelCombustion({
    amount: 1000, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' });
  // 1000 t × 20 GJ/t = 20000 GJ；20000 × 25 / 1000 = 500 tC；500 × 0.99 × 44/12 = 1815 tCO2
  assertEqual(r.inputs.energy_gj, 20000);
  assertEqual(r.inputs.carbon_t, 500);
  assertEqual(r.total_tco2, 1815);
  assertEqual(r.result_unit, 'tCO2');
  assertEqual(r.gas, 'CO2');
  assertEqual(r.total_tco2e, null);
  assertEqual(r.formula, 'E = AD × NCV × CC ÷ 1000 × OF × 44/12');
  assertEqual(r.steps.length, 3);
  assertIncludes(r.steps[2].expression, '44/12');
});

test('单位不同必须拒绝（t ↔ GJ/t、万Nm³ ↔ GJ/万Nm³ 严格配对）', () => {
  let msg = '';
  try {
    calc.calculateFuelCombustion({ amount: 1000, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/万Nm³', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' });
  } catch (e) {
    msg = e.message; }
  assertIncludes(msg, '单位不匹配');
  assertIncludes(msg, 'GJ/t');
  assertIncludes(msg, '不做隐式单位换算');

  let msg2 = '';
  try {
    calc.calculateFuelCombustion({ amount: 1, amount_unit: '万Nm³', ncv: 1, carbon_content: 1, oxidation_rate: 1, carbon_content_unit: 'tC/TJ' });
  } catch (e) {
    msg2 = e.message; }
  assertIncludes(msg2, '低位发热量单位缺失');

  const ok = calc.calculateFuelCombustion({
    amount: 100, amount_unit: '万Nm³', ncv: 389.31, ncv_unit: 'GJ/万Nm³', carbon_content: 15.3, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' });
  assert(Number.isFinite(ok.total_tco2) && ok.total_tco2 > 0);
  assertEqual(ok.inputs.amount_unit, '万Nm³');
});

test('因子未知就要求输入，不默认编值；有活动量时 NCV/CC/OF 不得为 0', () => {
  const cases = [
    [{ amount: 1, amount_unit: 't', ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' }, '必填项缺失'],
    [{ amount: 1, amount_unit: 't', ncv: 0, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' }, '因子缺失'],
    [{ amount: 1, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 0, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' }, '因子缺失'],
    [{ amount: 1, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 0, carbon_content_unit: 'tC/TJ' }, '碳氧化率不得为 0'],
    [{ amount: 1, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 1.2, carbon_content_unit: 'tC/TJ' }, '不得大于'],
    [{ amount: 1, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: -0.1, carbon_content_unit: 'tC/TJ' }, '不得小于'],
  ];
  for (const [input, expect] of cases) {
    let msg = '';
    try {
      calc.calculateFuelCombustion(input); } catch (e) {
      msg = e.message; }
    assertIncludes(msg, expect, `输入 ${JSON.stringify(input) } 应被拒绝`);
  }
});

test('0 燃料消耗输出 0，且结果注明是参考估算而不是正式履约核算', () => {
  const r = calc.calculateFuelCombustion({
    amount: 0, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' });
  assertEqual(r.total_tco2, 0);
  assert(r.warnings.some((w) => w.includes('0 活动量')));
  assert(r.warnings.some((w) => w.includes('参考估算')));
  assertIncludes(r.limitation, '不构成履约全口径核算');
});

/* ==================================================================== */
/*  四、多能源分项汇总：直接/间接分列，气体口径不下沉                    */
/* ==================================================================== */

test('汇总区分直接（范围一）与间接（范围二），合计口径仍为 CO2', () => {
  const r = calc.summarizeEmissions([
    { kind: 'electricity', energy: 100, energy_unit: '万kWh', factor_id: national.id, target_year: 2023 },
    { kind: 'fuel_combustion', amount: 1000, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' },
  ]);
  assertEqual(r.subtotals.indirect_tco2, 530.6);
  assertEqual(r.subtotals.direct_tco2, 1815);
  assertEqual(r.subtotals.total_tco2, 2345.6);
  assertEqual(r.subtotals.total_tco2e, null);
  assertIncludes(r.gas_note, '不把 CO2 自动标成 CO2e');
  assertEqual(r.items[0].scope, 'scope2_indirect');
  assertEqual(r.items[1].scope, 'scope1_direct');
  assertIncludes(r.limitation, '不是');
});

test('汇总拒绝空列表、未知类型与超量分项', () => {
  assertThrows(() => calc.summarizeEmissions([]), '空列表应拒绝');
  assertThrows(() => calc.summarizeEmissions([{ kind: 'unknown' }]), '未知类型应拒绝');
  assertThrows(() => calc.summarizeEmissions(new Array(51).fill({ kind: 'electricity', energy: 0, energy_unit: 'kWh', factor_id: national.id, target_year: 2023 })), '超量应拒绝');
});

/* ==================================================================== */
/*  五、手工因子与结果 JSON                                              */
/* ==================================================================== */

test('手工输入因子必须同时给单位与口径，且结果标注未经平台核验', () => {
  const r = calc.calculateElectricity({
    energy: 1, energy_unit: 'kWh', factor_value: 0.5, factor_unit: 'kgCO2/kWh',
    factor_name: '自备电厂实测因子', factor_caliber: '企业实测（示例）',region:'全国',data_year:2023,target_year:2023 });
  assertEqual(r.total_tco2, 0.0005);
  assertEqual(r.factor.source_verified, false);
  assert(r.warnings.some((w) => w.includes('手工输入')));
  assertThrows(() => calc.calculateElectricity({
    energy: 1, energy_unit: 'kWh', factor_value: 0.5, factor_unit: 'tCO2/MWh' }), '手工因子单位不匹配应拒绝');
});

test('结果 JSON 含公式、代入值、因子来源与限制，且明确不保存用户输入', () => {
  const r = calc.calculateElectricity({ energy: 100, energy_unit: '万kWh', factor_id: national.id, target_year: 2023 });
  const payload = calc.buildResultJson('electricity', r);
  assertEqual(payload.schema, 'ccer-accounting-calc/1');
  assertIncludes(payload.disclaimer, '不保存');
  assertIncludes(payload.disclaimer, '不是 CCER 预计签发量');
  assertEqual(payload.result.formula, 'E = AD × EF ÷ 1000');
  assertEqual(payload.result.factor.original_url, 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf');
  assertIncludes(payload.result.factor.original_sha256, 'd43b60a3');
  assertEqual(payload.result.formula, 'E = AD × EF ÷ 1000');
  // 序列化后的 JSON 必须可被原样复算（无函数、无循环引用）
  const round = JSON.parse(JSON.stringify(payload));
  assertEqual(round.result.total_tco2, 530.6);
});

test('计算服务是纯函数：调用前后数据库行数与内容不变（不保存用户输入）', async () => {
  const dbMod = await import('../src/core/db.mjs');
  const before = {
    factors: dbMod.get('SELECT COUNT(*) AS c FROM emission_factor').c,
    crc: dbMod.get('SELECT COUNT(*) AS c FROM crc_clearing_daily').c,
    audit: dbMod.get('SELECT COUNT(*) AS c FROM audit_log').c };
  for (let i = 0; i < 5; i += 1) {
    calc.calculateElectricity({ energy: i * 10, energy_unit: 'MWh', factor_id: national.id, target_year: 2023 });
    calc.calculateFuelCombustion({ amount: i, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/t', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' });
  }
  const after = {
    factors: dbMod.get('SELECT COUNT(*) AS c FROM emission_factor').c,
    crc: dbMod.get('SELECT COUNT(*) AS c FROM crc_clearing_daily').c,
    audit: dbMod.get('SELECT COUNT(*) AS c FROM audit_log').c };
  assertEqual(JSON.stringify(after), JSON.stringify(before), '计算不得写入任何表');
});

finish('46-v2-accounting-calc.test.mjs');
