/** CCER-10-001 的甲烷处理部分粗估，不替代该方法学的完整减排量核算。 */
export const SOURCE = 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250103708572385358.pdf';

/**
 * 接口数值口径（**必须与元数据一致**，二轮整改 docs/22 第 11、17 条）：
 *   annual_gas_m3        年混合气量，单位 **m³/年**（常温常压）
 *   annual_gas_10k_m3    年混合气量，单位 **万 m³/年**；服务端严格 ×10000 换算为 m³
 * 两个键二选一；同时提交会被拒绝，避免「界面写万 m³、接口按 m³ 算」缩小 10000 倍。
 */
export const GAS_UNIT_OPTIONS = [
  { key: 'annual_gas_m3', label: 'm³/年', unit: 'm³/年', factor: 1 },
  { key: 'annual_gas_10k_m3', label: '万 m³/年', unit: '万 m³/年', factor: 10000 },
];

/**
 * 快捷估算的界面元数据（前端「减排粗估」模块直接消费）。
 * 主输入两项：年混合气量、平均甲烷浓度；处理比例与销毁效率为可选高级参数。
 * 本模块**不需要**任何项目档案、人工签字或审批。
 */
export function quickGasMeta() {
  return {
    title: '低浓度煤矿瓦斯减排粗估',
    subtitle: '低于 8% 甲烷浓度简表：只填两项即可得到规模量级',
    requires_project_dossier: false,
    requires_approval: false,
    primary_fields: [
      { key: 'annual_gas_m3', label: '年混合气量', unit: 'm³/年', type: 'number', required: true,
        hint: '常温常压（20℃、1 个标准大气压）下的混合气体体积。可在单位下拉切换「万 m³/年」，' +
          '系统按 1 万 m³ = 10000 m³ 严格换算，不会改变量级。',
        unit_options: GAS_UNIT_OPTIONS },
      { key: 'ch4_pct', label: '平均甲烷浓度', unit: '%', type: 'number', required: true,
        hint: '本简表仅处理大于 0 且低于 8% 的输入；≥8% 请按正式方法学核算。' },
    ],
    advanced_fields: [
      { key: 'treated_share_pct', label: '进入装置的处理比例', unit: '%', type: 'number', default: 100,
        hint: '可选项。未填按 100% 处理。' },
      { key: 'destruction_efficiency_pct', label: '销毁效率', unit: '%', type: 'number', default: 90,
        hint: '可选项。未填按方法学默认 90%。' },
    ],
    unit_contract: {
      annual_gas_m3: 'm³/年（立方米每年，常温常压）',
      annual_gas_10k_m3: '万 m³/年（1 单位 = 10000 m³/年，服务端严格换算）',
      note: '两个键只能提交一个，同时提交会被拒绝。',
    },
    formula: '全年气量 × 甲烷浓度 × 进入装置比例 × 0.67 ÷ 1000 × 销毁效率 × (28 − 2.75)',
    formula_origin: 'CCER-10-001-V01 §6.3 公式(3)、§6.4 公式(13)、§7.1 表2 因子',
    numeric_formula_source: 'deterministic_plugin',
    disclaimer:
      '结果为规模粗估，不是可签发 CCER 量。数值由确定性程序按公开方法学因子计算，' +
      '不由大模型生成公式；不含外供电/外供热替代、项目购电、分时浓度与监测联网等修正项。',
    source_url: SOURCE,
  };
}

export function quickGasEstimate(input={}) {
  const raw10k = input.annual_gas_10k_m3;
  const rawM3 = input.annual_gas_m3;
  const has10k = raw10k !== undefined && raw10k !== null && raw10k !== '';
  const hasM3 = rawM3 !== undefined && rawM3 !== null && rawM3 !== '';
  if (has10k && hasM3) {
    return { error: '气量只能按一种单位提交：annual_gas_m3（m³/年）或 annual_gas_10k_m3（万 m³/年），请勿同时提交', status: 400 };
  }
  let annual;
  let gasUnit = 'm3';
  if (has10k) {
    const v = Number(raw10k);
    if (!Number.isFinite(v)) return { error: '年混合气量（万 m³/年）须为数值', status: 400 };
    annual = v * 10000; // 严格换算：1 万 m³ = 10000 m³
    gasUnit = '10k_m3';
  } else {
    annual = Number(rawM3);
  }
  const concentration=Number(input.ch4_pct);
  const treated=input.treated_share_pct===undefined||input.treated_share_pct===''?100:Number(input.treated_share_pct);
  const efficiency=input.destruction_efficiency_pct===undefined||input.destruction_efficiency_pct===''?90:Number(input.destruction_efficiency_pct);
  if(!Number.isFinite(annual)||annual<=0||annual>1e12) return {error:'全年气量须为大于 0 的常温常压立方米数',status:400};
  if(!Number.isFinite(concentration)||concentration<=0||concentration>=8)
    return {error:'本快捷估算仅处理甲烷体积浓度大于 0 且低于 8% 的输入',status:400};
  if(!Number.isFinite(treated)||treated<0||treated>100) return {error:'预计进入装置的比例须在 0—100% 之间',status:400};
  if(!Number.isFinite(efficiency)||efficiency<0||efficiency>100) return {error:'销毁效率须在 0—100% 之间',status:400};
  const methaneT=annual*(concentration/100)*(treated/100)*0.67/1000;
  const gross=methaneT*28;
  const oxidizedCo2=methaneT*(efficiency/100)*2.75;
  const unoxidized=methaneT*(1-efficiency/100)*28;
  const methaneComponent=Math.max(0,gross-oxidizedCo2-unoxidized);
  const r=(n)=>Math.round(n*100)/100;
  return {
    kind:'rough_methane_component',
    label:'甲烷处理部分粗估',
    annual_tco2e:r(methaneComponent),
    methane_input_t:r(methaneT),
    baseline_methane_tco2e:r(gross),
    project_oxidation_co2_t:r(oxidizedCo2),
    project_unoxidized_methane_tco2e:r(unoxidized),
    inputs:{annual_gas_m3:annual,annual_gas_10k_m3:r(annual/10000),gas_unit_used:gasUnit,
      ch4_pct:concentration,treated_share_pct:treated,destruction_efficiency_pct:efficiency,
      gas_basis:'常温常压（20℃、1 个标准大气压）立方米'},
    unit_note:'接口口径：annual_gas_m3 = m³/年；annual_gas_10k_m3 = 万 m³/年（×10000）。'
      + `本次按 ${gasUnit === '10k_m3' ? '万 m³/年（已严格换算）' : 'm³/年'} 计算，等效 ${r(annual/10000)} 万 m³/年。`,
    formula:'全年气量 × 甲烷浓度 × 进入装置比例 × 0.67 ÷ 1000 × 销毁效率 × (28 − 2.75)',
    factors:[{name:'甲烷密度',value:0.67,unit:'kg/m³',source:'CCER-10-001-V01 §6.3 公式(3)'},
      {name:'甲烷 GWP100',value:28,unit:'tCO₂e/tCH₄',source:'CCER-10-001-V01 §7.1 表2'},
      {name:'甲烷氧化后的 CO₂ 因子',value:2.75,unit:'tCO₂/tCH₄',source:'CCER-10-001-V01 §6.4 公式(13)'},
      {name:'默认销毁效率',value:90,unit:'%',source:'CCER-10-001-V01 §6.4 公式(13)'}],
    source_url:SOURCE,
    omitted:['外供电替代排放','外供热替代排放','项目购电排放','实际分时浓度及 ≥8% 时段扣除',
      '装置进气甲烷量与按能源产出推算甲烷量取较小值','监测联网与适用条件'],
    caveat:'仅用于早期项目规模判断，不是预计可签发 CCER 量；完整申报量必须按正式方法学、监测数据和审核结果计算。',
  };
}
