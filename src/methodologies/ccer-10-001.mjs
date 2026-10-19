/**
 * CCER-10-001-V01 甲烷体积浓度低于 8% 的煤矿低浓度瓦斯和风排瓦斯利用
 * ============================================================================
 * 规则卡 + 计算插件（v2.0.0：按官方 PDF §2 / §5 / §6 / §7 逐条重写）
 *
 * 官方依据：生态环境部 环办气候函〔2025〕1 号《温室气体自愿减排项目方法学
 *   甲烷体积浓度低于 8% 的煤矿低浓度瓦斯和风排瓦斯利用（CCER—10—001—V01）》，
 *   2025-01-03 发布
 *   https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250103708572385358.pdf
 *
 * 本次重写修复的领域性错误（v1.0.0 与官方原文冲突之处）：
 *   1. 基准线情景只有「煤矿低浓度瓦斯和风排瓦斯全部排空」一种（§6.1）。
 *      删除「瓦斯火炬燃烧基准线」「部分利用基准线」及火炬燃烧效率参数。
 *   2. 排放源与公式整体替换为官方公式(1)~(21)：基准线 = 排空 CH₄（公式2）+ 替代外供电量（公式5）
 *      + 替代外供热量（公式7）；项目排放 = 运维电力（公式11）+ 氧化后 CO₂（公式13）
 *      + 未氧化逃逸 CH₄（公式14）。蓄热体预热化石燃料 CO₂ 按 §5.3 表 1 计为 0。
 *   3. 泄漏按 §6.5「忽略不计」处理，公式(18) ER_y = BE_y − PE_y **没有泄漏项**。
 *   4. ρ_CH4 采用方法学专属值 0.67 kg/m³（常温常压 = 20 ℃、1 个标准大气压，公式(3)），
 *      不得回落到全局因子 rho.ch4.standard（0 ℃ 标态 0.716 kg/Nm³）——两者状态基准不同。
 *   5. 适用范围收窄为：井工煤矿（不包括废弃或关闭的井工煤矿）+ 分解销毁技术暂仅限于无焰氧化
 *      + 热能利用方式 ∈ {发电, 供热, 热电联产} + 甲烷体积浓度低于 8% 且非人为稀释
 *      + 监测数据与全国碳市场管理平台联网且减排量产生于完成联网试运行之后（§2）。
 *
 * ⚠ 未决项（value_status = 'placeholder'，须领域专家确认后方可用于正式报告）：
 *   CEF_CH4 —— 仅出现在公式(13)，官方正文既未把它列入参数表（表 2—表 33），也没有「式中」
 *              定义。本插件取 2.7432 tCO₂/tCH₄，即化学计量候选值 M(CO₂)/M(CH₄) = 44.009/16.043；
 *              **该候选值未经官方确认，不得视为已核实值**。
 *   TDL_y  —— 公式(12)中为项目所在省（自治区、直辖市）电网输配电损失率，官方未给出缺省值
 *              （来源《电力工业统计资料汇编》），须逐项目逐年填报。
 *   η_ELEC —— 公式(16)中出现，但官方「式中」只给出 η_FOEF = 91、η_EH = 86、η_BOEF = 88，
 *              **未给出 η_ELEC 的取值**，须取项目可研或机组实测值。
 *
 * 口径说明（PC_CH4,h 的百分号处理）：
 *   公式(3) 的印刷形式为 MM′_y = Σ ( F_NPT,h × PC_CH4,h × ρ_CH4 × 10⁻³ )，其「式中」说明
 *   PC_CH4,h 为「甲烷体积浓度，单位为百分比（%）」。按量纲核对，该项只在与**体积分数**相乘时
 *   才与 ρ_CH4（kg/m³）和 10⁻³（kg→t）自洽：F_NPT,h [m³/h] × 1 h × PC × ρ_CH4 × 10⁻³ = tCH₄。
 *   因此本插件在代入公式(3) 前把输入的百分数除以 100（1.2 % → 0.012），并在逐步明细中记录该换算；
 *   若直接以 1.2 代入，MM′_y 会放大 100 倍。该口径已列入 docs/12 领域专家确认清单（EXP-117）。
 */

import { GLOBAL_FACTORS } from './lib/global-factors.mjs';
import {
  step, num, validateNumeric, sensitivity, nm3Ch4ToTonnes, ch4ToCo2e,
  aggregateCrediting, buildAnnualSeries, SCENARIO_LABELS,
} from './lib/calc-kit.mjs';
import { round } from '../core/util.mjs';

const MID = 'CCER-10-001';
const MV = 'V01';
const MV_ID = `${MID}::${MV}`;

/** 条款定位：全部指向官方 PDF 的真实章节（不再使用【占位】） */
const R = {
  s2: 'CCER-10-001-V01 §2 适用条件',
  s2a: 'CCER-10-001-V01 §2 a）风排瓦斯分解销毁并利用热能（发电、供热或热电联产）',
  s2b: 'CCER-10-001-V01 §2 b）抽采泵站输出的浓度低于 8% 的低浓度瓦斯掺混后分解销毁并利用热能',
  s2_tech: 'CCER-10-001-V01 §2 第 3 段（分解销毁技术暂仅限于无焰氧化技术）',
  s2_dilute: 'CCER-10-001-V01 §2 第 4 段（不适用于人为稀释得到的低浓度瓦斯）',
  s2_online: 'CCER-10-001-V01 §2 第 5 段（监测数据联网，减排量产生于完成联网试运行之后）',
  s2_law: 'CCER-10-001-V01 §2 第 6 段（应符合《煤矿安全规程》等要求）',
  s5_2: 'CCER-10-001-V01 §5.2.2（计入期最长不超过 10 年）',
  s5_3: 'CCER-10-001-V01 §5.3 表 1（温室气体排放源）',
  s6_1: 'CCER-10-001-V01 §6.1（基准线情景识别：全部排空）',
  s6_2: 'CCER-10-001-V01 §6.2（额外性免予论证）',
  s6_5: 'CCER-10-001-V01 §6.5（项目泄漏：忽略不计）',
  s6_7a: 'CCER-10-001-V01 §6.7 a）（公式19：混配入口流量与抽采泵出口流量之和的判断）',
  s6_7b: 'CCER-10-001-V01 §6.7 b）（浓度不低于 8% 的时段与对应量扣除）',
  t7_1: (n) => `CCER-10-001-V01 §7.1 表 ${n}（设计阶段默认参数）`,
  t7_2: (n) => `CCER-10-001-V01 §7.2 表 ${n}（实施阶段监测参数）`,
};
/** 公式号 → 真实条款号：公式(1)~(9) 在 §6.3，公式(10)~(17) 在 §6.4，公式(18) 在 §6.6，公式(19)~(21) 在 §6.7 a） */
function eq(n) {
  const sec = n <= 9 ? '§6.3' : n <= 17 ? '§6.4' : n === 18 ? '§6.6' : '§6.7 a）';
  return `CCER-10-001-V01 ${sec} 公式（${n}）`;
}

/** 本插件声明的占位因子（在 assumptions 中无条件披露，不因本次运行是否用到而省略） */
const PLACEHOLDER_FACTORS = [
  {
    factor_key: 'c10-001.cef.ch4',
    name: '甲烷氧化（销毁）碳排放因子 CEF_CH4',
    value: 2.7432,
    unit: 'tCO₂/tCH₄',
    note:
      '官方正文仅在公式(13)引用 CEF_CH4：既未列入参数表（表 2—表 33），也无「式中」定义。' +
      '本值为化学计量候选值 M(CO₂)/M(CH₄) = 44.009/16.043 = 2.7432，属模型假设，未经官方确认。',
  },
  {
    factor_key: 'c10-001.tdl',
    name: '项目所在省电网输配电损失率 TDL_y',
    value: null,
    unit: '无量纲(0-1)',
    note:
      '公式(12)的「式中」仅说明 TDL_y 为项目所在省（自治区、直辖市）电网输配电损失率（原文单位 %），' +
      '未给出缺省值，须逐项目逐年填报（来源《电力工业统计资料汇编》）。' +
      '注意：公式(12)的分母为 (1 − TDL_y)，代入时须换算为小数（5% 填 0.05）。',
  },
  {
    factor_key: 'c10-001.eta.elec',
    name: '发电效率 η_ELEC',
    value: null,
    unit: '无量纲(0-1)',
    note:
      '公式(16)的「式中」只给出 η_FOEF = 91%、η_EH = 86%、η_BOEF = 88%，**未给出 η_ELEC 的取值**，' +
      '须取项目可研报告或机组实测发电效率（百分数换算为小数）。',
  },
];

/* ================================ 规则卡 ================================ */
/* 只保留与官方 §2 / §5 / §6 / §7 一致的专属条件：                              */
/*   删除原「露天煤矿亦可适用」「瓦斯提纯 / 民用及工业燃气利用方式」            */
/*   「瓦斯火炬燃烧 / 部分利用基准线情景」等与原文冲突的规则。                  */

export const rulecard = [
  {
    layer: 'specific',
    rule_id: 'M10-001-01',
    title: '井工煤矿（不包括废弃或关闭的井工煤矿）',
    condition_text:
      '本文件适用于井工煤矿（不包括废弃或关闭的井工煤矿）采用分解销毁减排技术的项目。',
    expression_text: "gas.mine_type == '井工煤矿' AND gas.mine_abandoned_or_closed == false",
    expr: {
      op: 'and',
      args: [
        { op: 'eq', field: 'gas.mine_type', value: '井工煤矿' },
        { op: 'is_false', field: 'gas.mine_abandoned_or_closed' },
      ],
    },
    required_fields: ['gas.mine_type', 'gas.mine_abandoned_or_closed'],
    evidence_policy: 'strict',
    evidence_requirement: '采矿许可证 / 矿井基本情况说明 / 关闭（废弃）矿井公告或验收文件',
    clause_ref: R.s2,
    severity: 'blocking',
    fail_conclusion:
      '露天煤矿，或属于废弃、关闭的井工煤矿，均不属于本文件适用范围，不得申请 CCER 减排量登记。',
    sort_order: 110,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-02',
    title: '瓦斯来源属于 §2 a）/b）认可的两条技术路线',
    condition_text:
      'a）对收集的风排瓦斯进行分解销毁，并将分解产生的热能加以利用；b）对瓦斯抽采泵站输出的甲烷体积浓度低于 8% 的煤矿低浓度瓦斯与收集的风排瓦斯或空气掺混，进行分解销毁，并将分解产生的热能加以利用。',
    expression_text:
      "gas.gas_category ∈ {风排瓦斯, 抽采低浓度瓦斯, 风排瓦斯+抽采低浓度瓦斯}",
    expr: {
      op: 'in',
      field: 'gas.gas_category',
      values: ['风排瓦斯', '抽采低浓度瓦斯', '风排瓦斯+抽采低浓度瓦斯'],
    },
    required_fields: ['gas.gas_category'],
    evidence_policy: 'normal',
    evidence_requirement: '瓦斯抽采与通风系统说明 / 配气系统流程图 / 监测台账',
    clause_ref: `${R.s2a}；${R.s2b}`,
    severity: 'major',
    fail_conclusion:
      '气源形态无法对应 §2 a）或 b）任一路线时，项目边界与监测点位无法确定，须人工核对。',
    unknown_action: '气源类别缺失时显示「待核实」，并核对配气系统流程与监测点位布置。',
    sort_order: 120,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-03',
    title: '分解销毁技术暂仅限于无焰氧化技术',
    condition_text: '本文件中分解销毁技术暂仅限于无焰氧化技术。',
    expression_text: "gas.oxidation_technology == '无焰氧化'",
    expr: { op: 'eq', field: 'gas.oxidation_technology', value: '无焰氧化' },
    required_fields: ['gas.oxidation_technology'],
    evidence_policy: 'strict',
    evidence_requirement: '工艺技术方案 / 主要设备清单（须体现无焰氧化装置及其技术参数）',
    clause_ref: R.s2_tech,
    severity: 'blocking',
    fail_conclusion:
      '采用无焰氧化以外的分解销毁技术（如催化氧化、蓄热燃烧等）暂不属于本文件适用范围。',
    sort_order: 130,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-04',
    title: '热能利用方式为发电、供热或热电联产',
    condition_text:
      '将分解产生的热能加以利用，利用方式包括发电、供热或热电联产。',
    expression_text: "gas.heat_utilization_route ∈ {发电, 供热, 热电联产}",
    expr: {
      op: 'in',
      field: 'gas.heat_utilization_route',
      values: ['发电', '供热', '热电联产'],
    },
    required_fields: ['gas.heat_utilization_route'],
    evidence_policy: 'strict',
    evidence_requirement: '可研报告 / 工艺方案（须明确外供电量、外供热量及其计量方式）',
    clause_ref: `${R.s2a}；${R.s2b}`,
    severity: 'blocking',
    fail_conclusion:
      '热能利用方式不属于发电、供热或热电联产（例如仅销毁不利用热能），不符合 §2 的适用条件；' +
      '该字段同时决定推算甲烷量按公式(15)、(16) 还是 (17) 计算。',
    sort_order: 140,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-05',
    title: '甲烷体积浓度低于 8%，且非人为稀释所得',
    condition_text:
      '本文件适用于甲烷体积浓度低于 8% 的煤矿低浓度瓦斯和风排瓦斯；本文件不适用于人为将甲烷体积浓度大于或等于 8% 的煤矿瓦斯进行稀释后得到的煤矿低浓度瓦斯。',
    expression_text:
      'gas.ch4_concentration_pct < 8 AND gas.diluted_from_high_concentration == false',
    expr: {
      op: 'and',
      args: [
        { op: 'lt', field: 'gas.ch4_concentration_pct', value: 8 },
        { op: 'is_false', field: 'gas.diluted_from_high_concentration' },
      ],
    },
    required_fields: ['gas.ch4_concentration_pct', 'gas.diluted_from_high_concentration'],
    evidence_policy: 'strict',
    evidence_requirement:
      '甲烷浓度监测报告 / 检测记录（含监测点位、仪表、时间）；气源为抽采瓦斯的还须说明是否存在掺混稀释',
    clause_ref: `${R.s2} 第 1 段；${R.s2_dilute}`,
    severity: 'blocking',
    fail_conclusion:
      '甲烷体积浓度不低于 8%，或系将浓度大于或等于 8% 的煤矿瓦斯人为稀释后得到，' +
      '均不属于本文件适用范围，不得申请减排量登记。',
    sort_order: 150,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-06',
    title: '监测数据联网，且减排量产生于完成联网试运行之后',
    condition_text:
      '项目监测数据应与全国碳市场管理平台（https://www.cets.org.cn）联网，减排量产生于项目相关监测数据联网（完成联网试运行）之后。',
    expression_text:
      'mon.metering_online == true AND mon.reduction_after_networking == true',
    expr: {
      op: 'and',
      args: [
        { op: 'is_true', field: 'mon.metering_online' },
        { op: 'is_true', field: 'mon.reduction_after_networking' },
      ],
    },
    required_fields: [
      'mon.metering_online',
      'mon.reduction_after_networking',
      'mon.networking_trial_completed_date',
      'time.reduction_generation_start',
    ],
    evidence_policy: 'strict',
    evidence_requirement:
      '联网方案与接入确认文件；联网试运行完成证明；减排量产生起始时间的监测记录',
    clause_ref: R.s2_online,
    severity: 'blocking',
    fail_conclusion:
      '监测数据未联网，或减排量产生时间早于监测数据联网（完成联网试运行）时间，' +
      '该期间产生的减排量不符合 §2 的适用条件。',
    unknown_action:
      'mon.reduction_after_networking 为「减排量产生起始时间是否不早于联网试运行完成日期」的判断结果字段；' +
      '两个原始日期中任一不可用时本规则强制为「待核实」；计算插件 validate() 亦会对两个日期做同样的时序校验。',
    sort_order: 160,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-07',
    title: '申请计入期最长不超过 10 年',
    condition_text:
      '项目计入期为可申请项目减排量登记的时间期限，从项目业主申请登记的项目减排量的产生时间开始，最长不超过 10 年。项目计入期须在项目寿命期限范围之内。',
    expression_text: 'time.crediting_period_years ≤ 10',
    expr: { op: 'lte', field: 'time.crediting_period_years', value: 10 },
    required_fields: ['time.crediting_period_years', 'time.reduction_generation_start'],
    evidence_policy: 'normal',
    evidence_requirement: '项目寿命期限与计入期安排说明（须能体现计入期起点与终点）',
    clause_ref: R.s5_2,
    severity: 'major',
    fail_conclusion:
      '申请计入期超过 10 年，超出 §5.2.2 的最长年限，超出部分不得申请减排量登记。',
    sort_order: 170,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-08',
    title: '§6.7 a）混配入口流量不大于抽采泵出口流量之和',
    condition_text:
      '当项目出现公式（19）的情形时，即第 h 小时煤矿低浓度瓦斯混配利用管道输送系统入口处的煤矿低浓度瓦斯常温常压流量大于为项目提供气源的所有地面瓦斯抽采泵出口端抽采瓦斯常温常压流量之和时，视为不符合项目适用条件的情形。项目审定与核查机构应将上述审定/核查发现书面报告项目所在地省级生态环境主管部门，省级生态环境主管部门经查实后通知全国温室气体自愿减排注册登记机构撤销项目登记。',
    expression_text:
      'Σ_{i=1}^{n} F_NPT,CH4,i,h,drainage ≥ F_NPT,CH4,h,import（gas.mixing_flow_check_ok == true）',
    expr: { op: 'is_true', field: 'gas.mixing_flow_check_ok' },
    required_fields: [
      'gas.mixing_flow_check_ok',
      'gas.drainage_flow_npt_m3h',
      'gas.mixing_inlet_flow_npt_m3h',
    ],
    evidence_policy: 'strict',
    evidence_requirement:
      '抽采泵出口端与混配管道入口端的流量监测记录（含公式(20)、(21) 所需的工况流量、温度、压力原始记录）',
    clause_ref: R.s6_7a,
    severity: 'blocking',
    fail_conclusion:
      '混配管道入口处的低浓度瓦斯常温常压流量大于为其提供气源的所有抽采泵出口端抽采瓦斯常温常压流量之和，' +
      '视为不符合项目适用条件：应书面报告项目所在地省级生态环境主管部门，由省级生态环境主管部门查实后' +
      '通知全国温室气体自愿减排注册登记机构撤销项目登记。',
    unknown_action:
      '规则引擎不支持字段间数值比较，故以判断结果字段 gas.mixing_flow_check_ok 承载结论、并把两个原始流量' +
      '列入 required_fields；计算插件 validate() 与 compute() 会按公式(19)~(21) 做实际比较，' +
      '不通过时返回 scope_violation 并拒绝出数。',
    sort_order: 180,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-09',
    title: '§6.7 b）浓度不低于 8% 的时段及对应量已扣除',
    condition_text:
      '当项目出现第 h 小时第 i 台地面瓦斯抽采泵出口端抽采瓦斯中的甲烷体积浓度或第 h 小时煤矿低浓度瓦斯混配利用管道输送系统入口处的煤矿低浓度瓦斯中的甲烷体积浓度不低于 8% 的情形时，项目业主做好数据记录，该时间段应从 time_y 中扣除，且对应时段内进入无焰氧化装置的甲烷量、外供电量和外供热量应从总量中扣除。',
    expression_text:
      'gas.high_conc_periods_recorded == true AND gas.hours_per_year 存在（time_y 为扣除后的运行总时长）',
    expr: {
      op: 'and',
      args: [
        { op: 'is_true', field: 'gas.high_conc_periods_recorded' },
        { op: 'exists', field: 'gas.hours_per_year' },
      ],
    },
    required_fields: ['gas.high_conc_periods_recorded', 'gas.hours_per_year'],
    evidence_policy: 'strict',
    evidence_requirement:
      '抽采泵出口端与混配管道入口端的甲烷浓度逐时记录；扣除时段的台账（time_y、甲烷量、外供电量、外供热量）',
    clause_ref: R.s6_7b,
    severity: 'major',
    fail_conclusion:
      '未记录浓度不低于 8% 的时段，或未从 time_y、进入装置的甲烷量、外供电量、外供热量中扣除对应时段，' +
      '将高估减排量，须补正后重新核算。',
    sort_order: 190,
  },
  {
    layer: 'specific',
    rule_id: 'M10-001-10',
    title: '额外性采用免予论证',
    condition_text:
      '煤矿低浓度瓦斯和风排瓦斯无焰氧化技术处于产业发展初期，投资建设成本和运维成本高，存在因技术和投资风险带来的障碍。符合本文件适用条件的项目，其额外性免予论证。',
    expression_text: "comp.additionality_route == '免予论证'",
    expr: { op: 'eq', field: 'comp.additionality_route', value: '免予论证' },
    required_fields: ['comp.additionality_route'],
    evidence_policy: 'normal',
    clause_ref: R.s6_2,
    severity: 'major',
    fail_conclusion:
      '额外性论证路径与本文件「免予论证」的规定不一致，须说明理由并核对适用条件是否全部满足。',
    sort_order: 200,
  },
];

/* ============================ 内部计算链 ================================ */
/* runChain 是唯一的数值实现点：compute() 与 sensitivity() 共用，保证复算一致。 */

/** 公式(4)/(20)/(21) 共用的常温常压换算：工况流量 → 常温常压（20 ℃、101.325 kPa）流量 */
function nptFromRaw(rawFlow, tempC, pressureKpa, tNpt, pNpt) {
  if (rawFlow === null || tempC === null || pressureKpa === null) return null;
  const denom = (273.15 + tempC) * pNpt;
  if (!(denom > 0)) return null;
  return (rawFlow * tNpt * pressureKpa) / denom;
}

/** 数值展示：缺失时给出中文说明，避免在报告中出现 null */
function tv(v, digits = 6) {
  return v === null || v === undefined ? '无法计算（数据缺失）' : String(round(v, digits));
}

function runChain(inputs, ctx) {
  const fac = ctx.factors;
  const m = ctx.scenarioMultipliers || { eff: 1, elec: 1, heat: 1, hours: 1 };
  const fv = (k) => fac.value(k, MV_ID); // 方法学专属因子须带版本 ID 查表，否则会静默取空

  /* ---------- 因子（全部来自官方表 2—表 6 与公式常数） ---------- */
  const gwp = fv('c10-001.gwp.ch4');                 // 28（表 2，IPCC AR5）
  const rho = fv('c10-001.rho.ch4');                 // 0.67 kg/m³（公式(3)，常温常压 20 ℃）
  const cef = fv('c10-001.cef.ch4');                 // placeholder：官方未定义
  const wOm = fv('c10-001.omega.om');                // 0.5（表 3）
  const wBm = fv('c10-001.omega.bm');                // 0.5（表 4）
  const efHeat = fv('c10-001.ef.heat');              // 0.06 tCO₂/GJ（表 5）
  const etaFoef = fv('c10-001.eta.foef');            // 0.91（公式 15~17 式中）
  const etaEh = fv('c10-001.eta.eh');                // 0.86
  const etaBoef = fv('c10-001.eta.boef');            // 0.88
  const tNpt = fv('c10-001.t.npt');                  // 293.15 K（公式(4)）
  const pNpt = fv('c10-001.p.npt');                  // 101.325 kPa（公式(4)）
  const hWater20 = fv('c10-001.h.water.20c');        // 83.74 kJ/kg（公式(8)）
  const cpWater = fv('c10-001.cp.water');            // 4.1868 kJ/(kg·℃)（公式(9)）
  const mwhGj = fv('c10-001.mwh.gj');                // 3.6 GJ/MW·h（公式 15、16）
  const hvCh4 = fv('c10-001.ch4.energy.value');      // 55.64（公式 15~17 印刷常数）

  const warnings = [];
  const missing = [];
  const steps = [];
  let n = 1;

  /* ---------- 情景乘数 ---------- */
  const hoursRaw = num(inputs, 'hours_per_year');
  const hours = hoursRaw === null ? null : Math.min(8760, hoursRaw * (m.hours ?? 1));
  const effBase = num(inputs, 'destruction_efficiency') ?? fv('c10-001.eff');
  const eff = Math.min(1, Math.max(0, (effBase ?? 0) * (m.eff ?? 1)));
  const elecRaw = num(inputs, 'elec_export_mwh');
  const elecExport = (elecRaw ?? 0) * (m.elec ?? 1);
  const etaElec = num(inputs, 'eta_elec') ?? fv('c10-001.eta.elec');

  /* ---------- 外供热量：优先直接监测值，否则按公式(8)/(9) 换算 ---------- */
  const maSt = num(inputs, 'steam_mass_t');
  const enSt = num(inputs, 'steam_enthalpy_kjkg');
  const maW = num(inputs, 'hot_water_mass_t');
  const tW = num(inputs, 'hot_water_temp_c');
  const qDeclared = num(inputs, 'heat_export_gj');
  let qHeatBase = qDeclared;
  if (qHeatBase === null && maSt !== null && enSt !== null && hWater20 !== null) {
    qHeatBase = maSt * (enSt - hWater20) * 1e-3;
    steps.push(step(n++, {
      title: '外供热量换算（蒸汽质量）',
      formula: 'Q_steam = Ma_st × ( En_st − 83.74 ) × 10⁻³',
      symbolic: 'Q_steam = Ma_st × ( En_st − 83.74 ) × 10⁻³',
      substitution: `Q_steam = ${maSt} × ( ${enSt} − ${hWater20} ) × 10⁻³`,
      result: qHeatBase,
      unit: 'GJ/年',
      factorRefs: ['c10-001.h.water.20c'],
      clauseRef: eq(8),
      note: '83.74 kJ/kg 为水温 20 ℃ 时的焓值；无法直接监测供热量时按本条换算（§6.3 公式(8)）。',
    }));
  } else if (qHeatBase === null && maW !== null && tW !== null && cpWater !== null) {
    qHeatBase = maW * (tW - 20) * cpWater * 1e-3;
    steps.push(step(n++, {
      title: '外供热量换算（热水质量）',
      formula: 'Q_water = Ma_w × ( t_w − 20 ) × 4.1868 × 10⁻³',
      symbolic: 'Q_water = Ma_w × ( t_w − 20 ) × 4.1868 × 10⁻³',
      substitution: `Q_water = ${maW} × ( ${tW} − 20 ) × ${cpWater} × 10⁻³`,
      result: qHeatBase,
      unit: 'GJ/年',
      factorRefs: ['c10-001.cp.water'],
      clauseRef: eq(9),
      note: '4.1868 kJ/(kg·℃) 为水在常温常压下的比热；无法直接监测供热量时按本条换算（§6.3 公式(9)）。',
    }));
  }
  const qHeat = (qHeatBase ?? 0) * (m.heat ?? 1);

  /* ---------- 热能利用方式：优先填报字段，否则按外供电量/外供热量是否非零推定公式(15)(16)(17) ---------- */
  const declaredMode = inputs.heat_utilization_route || null;
  let mode = ['发电', '供热', '热电联产'].includes(declaredMode) ? declaredMode : null;
  if (!mode) {
    const hasElec = (elecRaw ?? 0) > 0;
    const hasHeat = (qHeatBase ?? 0) > 0;
    if (hasElec && hasHeat) mode = '热电联产';
    else if (hasElec) mode = '发电';
    else if (hasHeat) mode = '供热';
  }

  /* ---------- 公式(4)：F_NPT,h；公式(3)：MM′_y ---------- */
  const fNptDirect = num(inputs, 'npt_flow_m3h');
  const fRaw = num(inputs, 'raw_flow_m3h');
  const tGas = num(inputs, 'gas_temp_c');
  const pGas = num(inputs, 'gas_pressure_kpa');
  const pc = num(inputs, 'ch4_concentration_pct');
  const vNptYear = num(inputs, 'recovery_volume_nm3');

  let fNpt = null;
  let fNptBasis = '';
  if (fNptDirect !== null) {
    fNpt = fNptDirect;
    fNptBasis = '小时值直接监测（§7.2 表 7：带内置转换装置的流量计）';
  } else if (fRaw !== null && tGas !== null && pGas !== null) {
    fNpt = nptFromRaw(fRaw, tGas, pGas, tNpt, pNpt);
    fNptBasis = '按公式（4）由工况流量换算';
  }

  if (fNpt !== null) {
    steps.push(step(n++, {
      title: '进入无焰氧化装置的混合气体常温常压流量（小时值）',
      formula: 'F_NPT,h = F_CH4,h × T_NPT × P_CH4,h / ( (273.15 + t_CH4,h) × P_NPT )',
      symbolic: 'F_NPT,h = F_CH4,h × T_NPT × P_CH4,h ÷ ( (273.15 + t_CH4,h) × P_NPT )',
      substitution: fNptDirect !== null
        ? `F_NPT,h = ${fNptDirect}（直接监测值）`
        : `F_NPT,h = ${fRaw} × ${tNpt} × ${pGas} ÷ ( (273.15 + ${tGas}) × ${pNpt} )`,
      result: fNpt,
      unit: 'm³/h',
      factorRefs: fNptDirect !== null ? [] : ['c10-001.t.npt', 'c10-001.p.npt'],
      clauseRef: eq(4),
      note:
        `T_NPT = 20 + 273.15 = ${tNpt} K，P_NPT = ${pNpt} kPa；常温常压指 20 ℃、1 个标准大气压。口径：${fNptBasis}。`,
      factorStatus: 'verified',
    }));
  }

  let vCh4 = null;
  let mmPrime = null;
  // ------------------------------------------------------------------
  // PC_CH4,h 的百分号处理（重要）
  //   公式(3) 的印刷式为 MM′_y = Σ ( F_NPT,h × PC_CH4,h × ρ_CH4 × 10⁻³ )，
  //   其「式中」说明 PC_CH4,h 是「甲烷体积浓度，单位为百分比（%）」。
  //   但按量纲核对：F_NPT,h [m³/h] × 1 h × PC × ρ_CH4 [kg/m³] × 10⁻³ = tCH₄，
  //   要求 PC 必须是**体积分数**（0.012），而不是百分数（1.2）。
  //   若直接把 1.2 代入，结果会放大 100 倍。
  //   因此本插件把输入的百分数除以 100 后再代入公式，并在步骤说明中记录该换算。
  //   （该口径差异已列入 docs/12 EXP-117 供领域专家复核。）
  // ------------------------------------------------------------------
  const pcFraction = pc === null ? null : pc / 100;
  if (fNpt !== null && hours !== null && pcFraction !== null) {
    vCh4 = hours * fNpt * pcFraction;
    steps.push(step(n++, {
      title: '进入无焰氧化装置的甲烷体积（按 time_y 求和）',
      formula: 'V_CH4,y = Σ_{h=1}^{time_y} ( F_NPT,h × PC_CH4,h ) = time_y × F_NPT,h × PC_CH4,h',
      symbolic: 'V_CH4,y = time_y × F_NPT,h × PC_CH4,h',
      substitution: `V_CH4,y = ${round(hours, 4)} × ${round(fNpt, 6)} × ${round(pcFraction, 8)}`,
      result: vCh4,
      unit: 'm³/年',
      clauseRef: eq(3),
      note:
        '公式(3) 为逐小时求和；当小时监测值在统计期内取定时值（每整点记录该小时流量与浓度，§7.2 表 7、表 9），' +
        `求和等价于「运行总时长 × 小时值」。输入浓度 ${pc} % 已换算为体积分数 ${round(pcFraction, 8)} 后代入。`,
    }));
  } else if (vNptYear !== null && pcFraction !== null) {
    vCh4 = vNptYear * pcFraction;
    steps.push(step(n++, {
      title: '进入无焰氧化装置的甲烷体积（年度常温常压流量口径）',
      formula: 'V_CH4,y = ( Σ_{h=1}^{time_y} F_NPT,h ) × PC_CH4,y = V_NPT,y × PC_CH4,y',
      symbolic: 'V_CH4,y = V_NPT,y × PC_CH4,y',
      substitution: `V_CH4,y = ${vNptYear} × ${round(pcFraction, 8)}`,
      result: vCh4,
      unit: 'm³/年',
      clauseRef: eq(3),
      note:
        '未提供小时工况流量与温压，改按「年进入无焰氧化装置的混合气体常温常压流量合计」代入公式(3) 的求和项' +
        '（要求小时浓度取统计期代表值；该口径差异已列入 missing[]）。' +
        `输入浓度 ${pc} % 已换算为体积分数后代入。`,
    }));
  }

  if (vCh4 !== null) {
    mmPrime = nm3Ch4ToTonnes(vCh4, rho);
    steps.push(step(n++, {
      title: '进入无焰氧化装置的实测甲烷量 MM′_y',
      formula: 'MM′_y = Σ_{h=1}^{time_y} ( F_NPT,h × PC_CH4,h × ρ_CH4 × 10⁻³ )',
      symbolic: 'MM′_y = V_CH4,y × ρ_CH4 × 10⁻³',
      substitution: `MM′_y = ${round(vCh4, 4)} × ${rho} ÷ 1000`,
      result: mmPrime,
      unit: 'tCH₄/年',
      factorRefs: ['c10-001.rho.ch4'],
      clauseRef: eq(3),
      note:
        `ρ_CH4 取方法学专属值 ${rho} kg/m³（常温常压 20 ℃；不是 0 ℃ 标态下的 0.716 kg/Nm³）。` +
        'PC_CH4,h 以体积分数代入（百分数 ÷ 100），以保证量纲与公式(3) 的 10⁻³ 系数一致。',
      factorStatus: 'verified',
    }));
  }

  /* ---------- 公式(15)/(16)/(17)：MM″_y ---------- */
  let mmDoublePrime = null;
  let modeLabel = '';
  if (mode === '热电联产') modeLabel = '公式（15）热电联产';
  else if (mode === '发电') modeLabel = '公式（16）仅发电';
  else if (mode === '供热') modeLabel = '公式（17）仅供热';

  // 只有在该利用方式所需的出力与效率数据齐备时才推算 MM″_y；缺数据时保持 null，
  // 由 validate() 拒绝出数，并在此处给出显式警示（不得用 0 冒充推算值）。
  const needElec = mode === '发电' || mode === '热电联产';
  const needHeat = mode === '供热' || mode === '热电联产';
  const canDerive = !!mode && eff > 0 && !!etaFoef
    && (!needElec || elecRaw !== null)
    && (!needHeat || qHeatBase !== null)
    && (mode !== '发电' || etaElec !== null);

  if (canDerive) {
    const eta = mode === '热电联产' ? etaEh : mode === '发电' ? etaElec : etaBoef;
    const numerator = mode === '热电联产' ? qHeat + elecExport * mwhGj
      : mode === '发电' ? elecExport * mwhGj
        : qHeat;
    const denom = eff * etaFoef * (eta ?? NaN) * hvCh4;
    if (Number.isFinite(denom) && denom > 0) mmDoublePrime = numerator / denom;
    const exprText = mode === '热电联产'
      ? 'MM″_y = ( Q_HEAT,y + ELEC_export,y × 3.6 ) / ( EFF_y × η_FOEF × η_EH × 55.64 )'
      : mode === '发电'
        ? 'MM″_y = ( ELEC_export,y × 3.6 ) / ( EFF_y × η_FOEF × η_ELEC × 55.64 )'
        : 'MM″_y = Q_HEAT,y / ( EFF_y × η_FOEF × η_BOEF × 55.64 )';
    steps.push(step(n++, {
      title: `进入无焰氧化装置的推算甲烷量 MM″_y（${modeLabel}）`,
      formula: exprText,
      symbolic: exprText,
      substitution: mode === '热电联产'
        ? `MM″_y = ( ${round(qHeat, 6)} + ${round(elecExport, 6)} × ${mwhGj} ) ÷ ( ${round(eff, 6)} × ${etaFoef} × ${etaEh} × ${hvCh4} )`
        : mode === '发电'
          ? `MM″_y = ( ${round(elecExport, 6)} × ${mwhGj} ) ÷ ( ${round(eff, 6)} × ${etaFoef} × ${round(etaElec ?? NaN, 6)} × ${hvCh4} )`
          : `MM″_y = ${round(qHeat, 6)} ÷ ( ${round(eff, 6)} × ${etaFoef} × ${etaBoef} × ${hvCh4} )`,
      result: mmDoublePrime,
      unit: 'tCH₄/年',
      factorRefs: ['c10-001.eff', 'c10-001.eta.foef', 'c10-001.ch4.energy.value']
        .concat(mode === '热电联产' ? ['c10-001.eta.eh'] : mode === '发电' ? ['c10-001.eta.elec'] : ['c10-001.eta.boef']),
      clauseRef: eq(mode === '热电联产' ? 15 : mode === '发电' ? 16 : 17),
      note:
        `η_FOEF = ${etaFoef}、` +
        (mode === '热电联产' ? `η_EH = ${etaEh}` : mode === '发电' ? `η_ELEC = ${etaElec}（官方未给缺省值）` : `η_BOEF = ${etaBoef}`) +
        `、55.64 为公式印刷常数；EFF_y = ${round(eff, 6)}（原文数值 ${effBase}，按小数代入，已施加情景乘数 ${m.eff ?? 1}）。` +
        '利用方式由 ' + (declaredMode ? '填报字段 gas.heat_utilization_route' : '填报的外供电量/外供热量推定'),
      factorStatus: mode === '发电' ? 'placeholder' : 'verified',
    }));
  } else {
    warnings.push({
      field: needElec && elecRaw === null ? 'elec_export_mwh' : needHeat && qHeatBase === null ? 'heat_export_gj' : 'heat_utilization_route',
      message:
        '无法按公式（15）、（16）或（17）计算推算甲烷量 MM″_y（缺少热能利用方式，' +
        '或该利用方式所需的外供电量/外供热量/效率数据）：公式(2) 的「取较小值」要求无法执行，' +
        '本次结果不可用于正式报告。',
    });
    missing.push('热能利用方式、外供电量/外供热量与效率（MM″_y 无法计算）');
  }

  /* ---------- 公式(2)：MM_y = min(MM′_y, MM″_y) ---------- */
  let mm = 0;
  if (mmPrime !== null && mmDoublePrime !== null) mm = Math.min(mmPrime, mmDoublePrime);
  else if (mmPrime !== null) mm = mmPrime;
  steps.push(step(n++, {
    title: '进入无焰氧化装置的甲烷量 MM_y（实测值与推算值取较小值）',
    formula: 'MM_y = min( MM′_y , MM″_y )',
    symbolic: 'MM_y = min( MM′_y , MM″_y )',
    substitution:
      mmPrime !== null && mmDoublePrime !== null
        ? `MM_y = min( ${round(mmPrime, 6)} , ${round(mmDoublePrime, 6)} )`
        : `MM_y = ${round(mm, 6)}（另一侧数值缺失，未执行取较小值）`,
    result: mm,
    unit: 'tCH₄/年',
    clauseRef: eq(2),
    note:
      '公式(2) 的「式中」明确：MM_y 取第 y 年实测甲烷量 MM′_y 与推算甲烷量 MM″_y 中的较小值，' +
      '这是方法学规定的保守取值，不得改用较大值或平均值。',
  }));

  /* ---------- 公式(2)：BE_MR,y ---------- */
  const beMr = ch4ToCo2e(mm, gwp);
  steps.push(step(n++, {
    title: '基准线排放——瓦斯直接排空（§6.1）',
    formula: 'BE_MR,y = MM_y × GWP_CH4',
    symbolic: 'BE_MR,y = MM_y × GWP_CH4',
    substitution: `BE_MR,y = ${round(mm, 6)} × ${gwp}`,
    result: beMr,
    unit: 'tCO₂e/年',
    factorRefs: ['c10-001.gwp.ch4'],
    clauseRef: eq(2),
    note: '基准线情景为煤矿低浓度瓦斯和风排瓦斯全部排空（§6.1），无火炬燃烧情形。',
    factorStatus: 'verified',
  }));

  /* ---------- 公式(6)：EF_grid,CM,y ---------- */
  const efOm = num(inputs, 'ef_grid_om');
  const efBm = num(inputs, 'ef_grid_bm');
  const efCm = efOm !== null && efBm !== null ? efOm * wOm + efBm * wBm : null;
  if (efCm !== null) {
    steps.push(step(n++, {
      title: '项目所在区域电网组合边际排放因子',
      formula: 'EF_grid,CM,y = EF_grid,OM,y × ω_OM + EF_grid,BM,y × ω_BM',
      symbolic: 'EF_grid,CM,y = EF_grid,OM,y × ω_OM + EF_grid,BM,y × ω_BM',
      substitution: `EF_grid,CM,y = ${efOm} × ${wOm} + ${efBm} × ${wBm}`,
      result: efCm,
      unit: 'tCO₂/MW·h',
      factorRefs: ['c10-001.omega.om', 'c10-001.omega.bm'],
      clauseRef: eq(6),
      note: 'ω_OM 与 ω_BM 均取官方缺省值 0.5（表 3、表 4）。',
      factorStatus: 'verified',
    }));
  } else {
    missing.push('区域电网电量边际排放因子 EF_grid,OM,y 与容量边际排放因子 EF_grid,BM,y（组合边际因子无法计算）');
  }

  /* ---------- 公式(5)：BE_ELEC,y ---------- */
  let beElec = 0;
  if (efCm !== null) {
    beElec = elecExport * efCm;
    steps.push(step(n++, {
      title: '基准线排放——项目外供电量替代电网发电',
      formula: 'BE_ELEC,y = ELEC_export,y × EF_grid,CM,y',
      symbolic: 'BE_ELEC,y = ELEC_export,y × EF_grid,CM,y',
      substitution: `BE_ELEC,y = ${round(elecExport, 6)} × ${round(efCm, 6)}`,
      result: beElec,
      unit: 'tCO₂e/年',
      clauseRef: eq(5),
      note: '按 §6.7 b），甲烷体积浓度不低于 8% 的时段内产生的外供电量已从总量中扣除。',
    }));
  }

  /* ---------- 公式(7)：BE_HEAT,y ---------- */
  const beHeat = qHeat * efHeat;
  steps.push(step(n++, {
    title: '基准线排放——项目外供热量替代既有或拟建供热设施',
    formula: 'BE_HEAT,y = Q_HEAT,y × EF_HEAT,y',
    symbolic: 'BE_HEAT,y = Q_HEAT,y × EF_HEAT,y',
    substitution: `BE_HEAT,y = ${round(qHeat, 6)} × ${efHeat}`,
    result: beHeat,
    unit: 'tCO₂e/年',
    factorRefs: ['c10-001.ef.heat'],
    clauseRef: eq(7),
    note: 'EF_HEAT,y 取缺省值 0.06 tCO₂/GJ（表 5，参考天然气供热的排放因子）。',
    factorStatus: 'verified',
  }));

  /* ---------- 公式(1)：BE_y ---------- */
  const be = beMr + beElec + beHeat;
  steps.push(step(n++, {
    title: '基准线排放量合计',
    formula: 'BE_y = BE_MR,y + BE_ELEC,y + BE_HEAT,y',
    symbolic: 'BE_y = BE_MR,y + BE_ELEC,y + BE_HEAT,y',
    substitution: `BE_y = ${round(beMr, 6)} + ${round(beElec, 6)} + ${round(beHeat, 6)}`,
    result: be,
    unit: 'tCO₂e/年',
    clauseRef: eq(1),
    note: '基准线排放源与 §5.3 表 1 一致：排空 CH₄、替代电网发电 CO₂、替代供热 CO₂。',
  }));

  /* ---------- 公式(12)：CONS_grid,y ---------- */
  const consElec = num(inputs, 'cons_elec_mwh');
  const tdl = num(inputs, 'tdl') ?? fv('c10-001.tdl');
  let consGrid = null;
  if (consElec !== null) {
    if (tdl !== null && tdl < 1) consGrid = consElec / (1 - tdl);
    steps.push(step(n++, {
      title: '项目消耗的所在区域电网电量',
      formula: 'CONS_grid,y = CONS_ELEC,y / ( 1 − TDL_y )',
      symbolic: 'CONS_grid,y = CONS_ELEC,y ÷ ( 1 − TDL_y )',
      substitution:
        consGrid !== null
          ? `CONS_grid,y = ${consElec} ÷ ( 1 − ${tdl} )`
          : `CONS_grid,y 无法计算（TDL_y 缺失）：CONS_ELEC,y = ${consElec}`,
      result: consGrid,
      unit: 'MW·h/年',
      factorRefs: tdl !== null ? ['c10-001.tdl'] : [],
      clauseRef: eq(12),
      note:
        'TDL_y 官方未给缺省值（placeholder），须填报项目所在省电网输配电损失率；' +
        '公式(12) 的分母为 (1 − TDL_y)，须以小数代入（5% 填 0.05）。',
      factorStatus: 'placeholder',
    }));
  } else {
    missing.push('项目运维电力消耗量 CONS_ELEC,y（未提供：PE_ME,y 未计入，结果偏大且不满足保守性要求）');
  }

  /* ---------- 公式(11)：PE_ME,y ---------- */
  let peMe = 0;
  if (consGrid !== null && efCm !== null) {
    peMe = consGrid * efCm;
    steps.push(step(n++, {
      title: '项目排放——运维电力消耗',
      formula: 'PE_ME,y = CONS_grid,y × EF_grid,CM,y',
      symbolic: 'PE_ME,y = CONS_grid,y × EF_grid,CM,y',
      substitution: `PE_ME,y = ${round(consGrid, 6)} × ${round(efCm, 6)}`,
      result: peMe,
      unit: 'tCO₂/年',
      clauseRef: eq(11),
    }));
  }

  /* ---------- 公式(13)：PE_MD,y ---------- */
  const peMd = mm * eff * (cef ?? 0);
  steps.push(step(n++, {
    title: '项目排放——无焰氧化装置氧化后的 CO₂',
    formula: 'PE_MD,y = MM_y × EFF_y × CEF_CH4',
    symbolic: 'PE_MD,y = MM_y × EFF_y × CEF_CH4',
    substitution: `PE_MD,y = ${round(mm, 6)} × ${round(eff, 6)} × ${cef}`,
    result: peMd,
    unit: 'tCO₂/年',
    factorRefs: ['c10-001.eff', 'c10-001.cef.ch4'],
    clauseRef: eq(13),
    note:
      'CEF_CH4 在官方正文中既无参数表也无「式中」定义（本插件按化学计量候选值 2.7432 代入，' +
      'placeholder，须领域专家确认）。',
    factorStatus: 'placeholder',
  }));

  /* ---------- 公式(14)：PE_UM,y ---------- */
  const peUm = gwp * mm * (1 - eff);
  steps.push(step(n++, {
    title: '项目排放——未氧化的瓦斯逃逸',
    formula: 'PE_UM,y = GWP_CH4 × MM_y × ( 1 − EFF_y )',
    symbolic: 'PE_UM,y = GWP_CH4 × MM_y × ( 1 − EFF_y )',
    substitution: `PE_UM,y = ${gwp} × ${round(mm, 6)} × ( 1 − ${round(eff, 6)} )`,
    result: peUm,
    unit: 'tCO₂e/年',
    factorRefs: ['c10-001.gwp.ch4', 'c10-001.eff'],
    clauseRef: eq(14),
    note: 'EFF_y 取无焰氧化装置甲烷销毁效率（表 6 缺省 90%，参考 NB/T 51012-2014 5.5.1）。',
    factorStatus: 'verified',
  }));

  /* ---------- 公式(10)：PE_y ---------- */
  const pe = peMe + peMd + peUm;
  steps.push(step(n++, {
    title: '项目排放量合计',
    formula: 'PE_y = PE_ME,y + PE_MD,y + PE_UM,y',
    symbolic: 'PE_y = PE_ME,y + PE_MD,y + PE_UM,y',
    substitution: `PE_y = ${round(peMe, 6)} + ${round(peMd, 6)} + ${round(peUm, 6)}`,
    result: pe,
    unit: 'tCO₂e/年',
    clauseRef: eq(10),
    note:
      '§5.3 表 1：无焰氧化装置蓄热体预热导致的化石燃料消耗排放「排放量小……计为 0」，故不列入项目排放；' +
      '应急排放在甲烷量计量仪表之前，无需考虑。',
  }));

  /* ---------- §6.5：泄漏 ---------- */
  steps.push(step(n++, {
    title: '项目泄漏量（忽略不计）',
    formula: 'LE_y = 0（§6.5 规定忽略不计，公式(18) 中不出现泄漏项）',
    symbolic: 'LE_y = 0',
    substitution: 'LE_y = 0',
    result: 0,
    unit: 'tCO₂e/年',
    clauseRef: R.s6_5,
    note:
      '§6.5：煤矿瓦斯抽采和矿井通风的首要目的是保障煤矿生产安全，不会因开发减排项目而新建扩建煤矿、' +
      '增加煤炭产量，泄漏较小，忽略不计。',
  }));

  /* ---------- 公式(18)：ER_y ---------- */
  const er = be - pe;
  steps.push(step(n++, {
    title: '项目减排量（年度）',
    formula: 'ER_y = BE_y − PE_y',
    symbolic: 'ER_y = BE_y − PE_y',
    substitution: `ER_y = ${round(be, 6)} − ${round(pe, 6)}`,
    result: er,
    unit: 'tCO₂e/年',
    clauseRef: eq(18),
    note:
      er < 0
        ? '⚠ 结果为负：项目甲烷销毁与热能利用不足以超越基准线排空情景，相对基准线不产生减排量（不作 0 截断）。'
        : '公式(18) 无泄漏项；泄漏已按 §6.5 忽略不计。',
  }));

  /* ---------- 公式(19)~(21)：§6.7 a）适用性合规判断 ---------- */
  const drainageNptRaw = num(inputs, 'drainage_flow_npt_m3h');
  const mixingNptRaw = num(inputs, 'mixing_inlet_flow_npt_m3h');
  const drainRawFlow = num(inputs, 'drainage_raw_flow_m3h');
  const drainTemp = num(inputs, 'drainage_temp_c');
  const drainPressure = num(inputs, 'drainage_pressure_kpa');
  const mixingRawFlow = num(inputs, 'mixing_raw_flow_m3h');
  const mixingTemp = num(inputs, 'mixing_temp_c');
  const mixingPressure = num(inputs, 'mixing_pressure_kpa');

  const drainageNpt = drainageNptRaw !== null
    ? drainageNptRaw
    : nptFromRaw(drainRawFlow, drainTemp, drainPressure, tNpt, pNpt);
  const mixingNpt = mixingNptRaw !== null
    ? mixingNptRaw
    : nptFromRaw(mixingRawFlow, mixingTemp, mixingPressure, tNpt, pNpt);

  if (drainageNpt !== null || mixingNpt !== null) {
    const ok = drainageNpt !== null && mixingNpt !== null ? drainageNpt >= mixingNpt : null;
    steps.push(step(n++, {
      title: '§6.7 a）项目适用性合规判断',
      formula: 'Σ_{i=1}^{n} F_NPT,CH4,i,h,drainage ≥ F_NPT,CH4,h,import',
      symbolic: 'Σ F_NPT,CH4,i,h,drainage ≥ F_NPT,CH4,h,import',
      substitution:
        `Σ_{i=1}^{n} F_NPT,CH4,i,h,drainage = ${round(drainageNpt ?? NaN, 6)} m³/h ；` +
        `F_NPT,CH4,h,import = ${round(mixingNpt ?? NaN, 6)} m³/h`,
      result: ok === null ? null : (ok ? 1 : 0),
      unit: null,
      factorRefs: [],
      clauseRef: eq(19),
      note:
        ok === null
          ? '两个流量未同时提供，公式(19) 的判断无法执行（须按公式(20)、(21) 或直接监测补齐）。'
          : ok
            ? '混配管道入口流量不大于抽采泵出口端流量之和，公式(19) 情形未出现，符合项目适用条件。'
            : '⚠ 混配管道入口流量大于为其提供气源的所有抽采泵出口端流量之和，公式(19) 情形出现：' +
              '视为不符合项目适用条件，应书面报告项目所在地省级生态环境主管部门，' +
              '并由省级生态环境主管部门查实后通知全国温室气体自愿减排注册登记机构撤销项目登记。',
    }));
  }

  return {
    steps,
    values: {
      f_npt_h: fNpt,
      v_ch4_nm3: vCh4,
      mm_measured_t: mmPrime,
      mm_derived_t: mmDoublePrime,
      mm_t: mm,
      be_mr_tco2e: beMr,
      ef_grid_cm: efCm,
      be_elec_tco2e: beElec,
      be_heat_tco2e: beHeat,
      be_tco2e: be,
      cons_grid_mwh: consGrid,
      pe_me_tco2e: peMe,
      pe_md_tco2e: peMd,
      pe_um_tco2e: peUm,
      pe_tco2e: pe,
      er_annual_tco2e: er,
      q_heat_gj: qHeat,
      eff: eff,
      mode: mode,
      drainage_npt_m3h: drainageNpt,
      mixing_npt_m3h: mixingNpt,
      compliance_ok: drainageNpt !== null && mixingNpt !== null ? drainageNpt >= mixingNpt : null,
    },
    er,
    warnings,
    missing,
  };
}

/* ============================== 计算插件 =============================== */

export const plugin = {
  plugin_key: 'calc-ccer-10-001',
  plugin_version: '2.0.0',
  methodology_id: MID,
  methodology_version: MV,
  title: '煤矿低浓度瓦斯和风排瓦斯利用（无焰氧化） —— 减排量初算',
  status_note:
    '本规则卡与计算插件已按官方 PDF（环办气候函〔2025〕1 号，CCER—10—001—V01）§2 / §5 / §6 / §7 ' +
    '逐条重写：规则卡 10 条专属条件（6 条硬障碍）对应 §2、§5.2.2、§6.2、§6.7 a）与 b）；' +
    '计算链覆盖公式(1)~(21)，基准线固定为瓦斯全部排空（§6.1），泄漏按 §6.5 忽略不计（公式18 无泄漏项），' +
    'MM_y 按公式(2) 取实测值与推算值较小值。' +
    '⚠ 仍未解决的官方参数：**CEF_CH4（公式13）在官方正文中既无参数表也无「式中」定义**，' +
    '本插件以化学计量候选值 2.7432 tCO₂/tCH₄ 代入并标记 placeholder；另 TDL_y（公式12）与 ' +
    'η_ELEC（公式16）官方亦未给出缺省值，同样为 placeholder。' +
    '严格模式下含占位系数的本插件被阻止出数；演示模式下所有输出逐项标注占位系数。',

  /* ------------------------- 公式声明（官方 21 式） ------------------------- */
  formula_refs: [
    { formula_id: 'F1', title: '公式（1）基准线排放量合计', expression: 'BE_y = BE_MR,y + BE_ELEC,y + BE_HEAT,y', unit: 'tCO₂e/年', clause_ref: eq(1) },
    { formula_id: 'F2', title: '公式（2）瓦斯排空基准线排放（MM_y 取实测值与推算值较小值）', expression: 'BE_MR,y = MM_y × GWP_CH4，MM_y = min( MM′_y , MM″_y )', unit: 'tCO₂e/年', clause_ref: eq(2) },
    { formula_id: 'F3', title: '公式（3）实测甲烷量', expression: 'MM′_y = Σ_{h=1}^{time_y} ( F_NPT,h × PC_CH4,h × ρ_CH4 × 10⁻³ )', unit: 'tCH₄/年', clause_ref: eq(3) },
    { formula_id: 'F4', title: '公式（4）混合气体常温常压流量换算', expression: 'F_NPT,h = F_CH4,h × T_NPT × P_CH4,h / ( (273.15 + t_CH4,h) × P_NPT )', unit: 'm³/h', clause_ref: eq(4) },
    { formula_id: 'F5', title: '公式（5）外供电量替代的基准线排放', expression: 'BE_ELEC,y = ELEC_export,y × EF_grid,CM,y', unit: 'tCO₂e/年', clause_ref: eq(5) },
    { formula_id: 'F6', title: '公式（6）区域电网组合边际排放因子', expression: 'EF_grid,CM,y = EF_grid,OM,y × ω_OM + EF_grid,BM,y × ω_BM', unit: 'tCO₂/MW·h', clause_ref: eq(6) },
    { formula_id: 'F7', title: '公式（7）外供热量替代的基准线排放', expression: 'BE_HEAT,y = Q_HEAT,y × EF_HEAT,y', unit: 'tCO₂e/年', clause_ref: eq(7) },
    { formula_id: 'F8', title: '公式（8）蒸汽热量换算', expression: 'Q_steam = Ma_st × ( En_st − 83.74 ) × 10⁻³', unit: 'GJ', clause_ref: eq(8) },
    { formula_id: 'F9', title: '公式（9）热水热量换算', expression: 'Q_water = Ma_w × ( t_w − 20 ) × 4.1868 × 10⁻³', unit: 'GJ', clause_ref: eq(9) },
    { formula_id: 'F10', title: '公式（10）项目排放量合计', expression: 'PE_y = PE_ME,y + PE_MD,y + PE_UM,y', unit: 'tCO₂e/年', clause_ref: eq(10) },
    { formula_id: 'F11', title: '公式（11）运维电力消耗排放', expression: 'PE_ME,y = CONS_grid,y × EF_grid,CM,y', unit: 'tCO₂/年', clause_ref: eq(11) },
    { formula_id: 'F12', title: '公式（12）项目消耗的电网电量（含输配电损失率）', expression: 'CONS_grid,y = CONS_ELEC,y / ( 1 − TDL_y )', unit: 'MW·h/年', clause_ref: eq(12) },
    { formula_id: 'F13', title: '公式（13）氧化后 CO₂ 排放（CEF_CH4 官方未定义）', expression: 'PE_MD,y = MM_y × EFF_y × CEF_CH4', unit: 'tCO₂/年', clause_ref: eq(13) },
    { formula_id: 'F14', title: '公式（14）未氧化瓦斯逃逸排放', expression: 'PE_UM,y = GWP_CH4 × MM_y × ( 1 − EFF_y )', unit: 'tCO₂e/年', clause_ref: eq(14) },
    { formula_id: 'F15', title: '公式（15）推算甲烷量（热电联产）', expression: 'MM″_y = ( Q_HEAT,y + ELEC_export,y × 3.6 ) / ( EFF_y × η_FOEF × η_EH × 55.64 )', unit: 'tCH₄/年', clause_ref: eq(15) },
    { formula_id: 'F16', title: '公式（16）推算甲烷量（仅发电）', expression: 'MM″_y = ( ELEC_export,y × 3.6 ) / ( EFF_y × η_FOEF × η_ELEC × 55.64 )', unit: 'tCH₄/年', clause_ref: eq(16) },
    { formula_id: 'F17', title: '公式（17）推算甲烷量（仅供热）', expression: 'MM″_y = Q_HEAT,y / ( EFF_y × η_FOEF × η_BOEF × 55.64 )', unit: 'tCH₄/年', clause_ref: eq(17) },
    { formula_id: 'F18', title: '公式（18）项目减排量（无泄漏项）', expression: 'ER_y = BE_y − PE_y', unit: 'tCO₂e/年', clause_ref: eq(18) },
    { formula_id: 'F19', title: '公式（19）混配入口流量与抽采泵出口流量之和的判断', expression: 'Σ_{i=1}^{n} F_NPT,CH4,i,h,drainage < F_NPT,CH4,h,import → 视为不符合项目适用条件', unit: '无量纲（条件判断）', clause_ref: eq(19) },
    { formula_id: 'F20', title: '公式（20）抽采泵出口端抽采瓦斯常温常压流量换算', expression: 'F_NPT,CH4,i,h,drainage = F_CH4,i,h,drainage × T_NPT × P_CH4,i,h,drainage / ( (273.15 + t_CH4,i,h,drainage) × P_NPT )', unit: 'm³/h', clause_ref: eq(20) },
    { formula_id: 'F21', title: '公式（21）混配管道入口处低浓度瓦斯常温常压流量换算', expression: 'F_NPT,CH4,h,import = F_CH4,h,import × T_NPT × P_CH4,h,import / ( (273.15 + t_CH4,h,import) × P_NPT )', unit: 'm³/h', clause_ref: eq(21) },
  ],

  /* ------------------------------- 因子 ------------------------------- */
  factors: [
    ...GLOBAL_FACTORS,
    {
      factor_key: 'c10-001.gwp.ch4',
      name: '甲烷 100 年全球增温潜势 GWP_CH4（方法学表 2）',
      value: 28,
      unit: 'tCO₂e/tCH₄',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §7.1 表 2：默认值，参考 IPCC 第五次评估报告；数值 28',
      source_year: 2013,
      gwp_assessment_report: 'IPCC AR5',
      value_status: 'verified',
      verification_note:
        '数值 28 与出处均为官方原文（表 2）。全局因子 gwp.ch4.fossil.ar5 数值相同，' +
        '本方法学一律使用本方法学专属因子。',
      reasonable_min: 1,
      reasonable_max: 100,
    },
    {
      factor_key: 'c10-001.omega.om',
      name: '电量边际排放因子权重 ω_OM',
      value: 0.5,
      unit: '无量纲(0-1)',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §7.1 表 3：默认值 0.5',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方表 3 给出的默认值（应用于公式(6)、(11)）。',
      reasonable_min: 0,
      reasonable_max: 1,
    },
    {
      factor_key: 'c10-001.omega.bm',
      name: '容量边际排放因子权重 ω_BM',
      value: 0.5,
      unit: '无量纲(0-1)',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §7.1 表 4：默认值 0.5',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方表 4 给出的默认值（应用于公式(6)、(11)）。',
      reasonable_min: 0,
      reasonable_max: 1,
    },
    {
      factor_key: 'c10-001.ef.heat',
      name: '热力排放因子 EF_HEAT,y',
      value: 0.06,
      unit: 'tCO₂/GJ',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §7.1 表 5：默认值 0.06，参考天然气供热的排放因子',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方表 5 给出的缺省值（应用于公式(7)）。',
      reasonable_min: 0.01,
      reasonable_max: 0.3,
    },
    {
      factor_key: 'c10-001.eff',
      name: '无焰氧化装置甲烷销毁效率 EFF_y',
      value: 0.9,
      unit: '无量纲(0-1)（原文单位 %）',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §7.1 表 6：默认值，参考 NB/T 51012-2014 5.5.1；数值 90',
      source_year: null,
      value_status: 'verified',
      verification_note:
        '官方表 6 数值为 90，单位 %；公式(13)(14)(15)(16)(17) 中 EFF 以小数参与乘除（×/÷ 效率），' +
        '故本因子按 0.90 记录。若采用实测销毁效率，须有检测报告并按小数填报。',
      reasonable_min: 0.5,
      reasonable_max: 1,
    },
    {
      factor_key: 'c10-001.eta.foef',
      name: '无焰氧化装置热利用效率 η_FOEF',
      value: 0.91,
      unit: '无量纲(0-1)（原文单位 %）',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.4 公式（15）（16）（17）式中：η_FOEF 取值 91（%）',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方原文取值 91%；公式中按小数 0.91 代入。',
      reasonable_min: 0.5,
      reasonable_max: 1,
    },
    {
      factor_key: 'c10-001.eta.eh',
      name: '热电联产机组综合效率 η_EH',
      value: 0.86,
      unit: '无量纲(0-1)（原文单位 %）',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.4 公式（15）式中：η_EH 取值 86（%）',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方原文取值 86%；公式中按小数 0.86 代入。',
      reasonable_min: 0.3,
      reasonable_max: 1,
    },
    {
      factor_key: 'c10-001.eta.boef',
      name: '锅炉热效率 η_BOEF',
      value: 0.88,
      unit: '无量纲(0-1)（原文单位 %）',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.4 公式（17）式中：η_BOEF 取值 88（%）',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方原文取值 88%；公式中按小数 0.88 代入。',
      reasonable_min: 0.3,
      reasonable_max: 1,
    },
    {
      factor_key: 'c10-001.rho.ch4',
      name: '甲烷常温常压密度 ρ_CH4（本方法学专属）',
      value: 0.67,
      unit: 'kg/m³',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.3 公式（3）式中：甲烷常温常压密度，数值为 0.67',
      source_year: null,
      value_status: 'verified',
      verification_note:
        '官方公式(3) 明确数值 0.67 kg/m³。方法学把「常温常压」定义为 20 ℃、1 个标准大气压，' +
        '与全局因子 rho.ch4.standard（0 ℃、101.325 kPa 标态下的 0.716 kg/Nm³）状态基准不同，' +
        '**不得相互替代或回落**。',
      reasonable_min: 0.6,
      reasonable_max: 0.75,
    },
    {
      factor_key: 'c10-001.cef.ch4',
      name: '甲烷氧化（销毁）碳排放因子 CEF_CH4',
      value: 2.7432,
      unit: 'tCO₂/tCH₄',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref:
        '方法学 §6.4 公式（13）：CEF_CH4 在官方正文中未列入参数表（表 2—表 33），' +
        '亦无「式中」定义；本值为化学计量候选值 M(CO₂)/M(CH₄) = 44.009/16.043 = 2.7432',
      source_year: null,
      value_status: 'placeholder',
      verification_note:
        '【官方未定义】CEF_CH4 仅出现在公式(13)，官方既未给出参数表，也未给出「式中」说明，' +
        '无法从原文确定其取值与单位。本插件暂按甲烷完全氧化的化学计量值 44.009/16.043 = 2.7432 ' +
        'tCO₂/tCH₄ 代入，**该候选值未经官方确认，不得作为已核实值使用**；' +
        '须由领域专家确认后改为 verified 或替换为官方值。',
      reasonable_min: 2.7,
      reasonable_max: 2.8,
    },
    {
      factor_key: 'c10-001.tdl',
      name: '项目所在省电网输配电损失率 TDL_y',
      value: null,
      unit: '无量纲(0-1)',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref:
        '方法学 §6.4 公式（12）式中：TDL_y 为项目所在省（自治区、直辖市）的电网输配电损失率，' +
        '单位为百分比（%）；官方未给出缺省值，数据来源为《电力工业统计资料汇编》',
      source_year: null,
      value_status: 'placeholder',
      verification_note:
        '【官方未给缺省值】公式(12) 的分母为 (1 − TDL_y)，代入时须以小数表示（5% 填 0.05），' +
        '否则分母为负、结果无意义。TDL_y 须按项目所在省最新年度《电力工业统计资料汇编》逐项目填报，' +
        '本插件不提供缺省值。',
      reasonable_min: 0,
      reasonable_max: 0.5,
    },
    {
      factor_key: 'c10-001.eta.elec',
      name: '发电效率 η_ELEC',
      value: null,
      unit: '无量纲(0-1)',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref:
        '方法学 §6.4 公式（16）：η_ELEC 为发电效率，官方「式中」仅给出 η_FOEF、η_EH、η_BOEF 的取值，' +
        '未给出 η_ELEC 的默认值',
      source_year: null,
      value_status: 'placeholder',
      verification_note:
        '【官方未给缺省值】仅「仅发电」项目按公式(16) 需要 η_ELEC，须取项目可研报告的设计发电效率' +
        '或机组实测效率（百分数换算为小数）。官方正文没有可引用的默认值。',
      reasonable_min: 0.1,
      reasonable_max: 0.6,
    },
    {
      factor_key: 'c10-001.t.npt',
      name: '常温的开尔文温度 T_NPT',
      value: 293.15,
      unit: 'K',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.3 公式（4）式中：T_NPT 数值为 20 + 273.15',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方原文明确「常温常压」为 20 ℃、1 个标准大气压，故 T_NPT = 293.15 K。',
      reasonable_min: 293,
      reasonable_max: 294,
    },
    {
      factor_key: 'c10-001.p.npt',
      name: '标准大气压 P_NPT',
      value: 101.325,
      unit: 'kPa',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.3 公式（4）式中：P_NPT 数值为 101.325 kPa',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方原文给定值。',
      reasonable_min: 101,
      reasonable_max: 102,
    },
    {
      factor_key: 'c10-001.h.water.20c',
      name: '水温 20 ℃ 时的焓值',
      value: 83.74,
      unit: 'kJ/kg',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.3 公式（8）式中：83.74 为水温 20 ℃ 时的焓值',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方原文给定常数（应用于公式(8)）。',
      reasonable_min: 80,
      reasonable_max: 90,
    },
    {
      factor_key: 'c10-001.cp.water',
      name: '水在常温常压下的比热',
      value: 4.1868,
      unit: 'kJ/(kg·℃)',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.3 公式（9）式中：4.1868 为水在常温常压下的比热',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方原文给定常数（应用于公式(9)）。',
      reasonable_min: 4,
      reasonable_max: 4.3,
    },
    {
      factor_key: 'c10-001.mwh.gj',
      name: '电量与热量的换算系数（1 MW·h = 3.6 GJ）',
      value: 3.6,
      unit: 'GJ/MW·h',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.4 公式（15）（16）：ELEC_export,y × 3.6',
      source_year: null,
      value_status: 'verified',
      verification_note: '官方公式中的换算常数（1 MW·h = 3.6 GJ）。',
      reasonable_min: 3.6,
      reasonable_max: 3.6,
    },
    {
      factor_key: 'c10-001.ch4.energy.value',
      name: '公式(15)(16)(17) 中的印刷常数 55.64',
      value: 55.64,
      unit: 'GJ/tCH₄（按公式量纲反推）',
      methodology_version_id: MV_ID,
      scope: 'methodology',
      source_ref: '方法学 §6.4 公式（15）（16）（17）分母中的常数 55.64',
      source_year: null,
      value_status: 'verified',
      verification_note:
        '数值直接取自官方公式(15)(16)(17) 的印刷常数 55.64；' +
        '官方式中未对该常数作「式中」说明（按量纲反推为甲烷热值，单位 GJ/tCH₄），' +
        '本插件按原文数值使用，不作换算。',
      reasonable_min: 50,
      reasonable_max: 60,
    },
  ],

  /* ------------------------------ 参数绑定 ------------------------------ */
  parameters: [
    // 适用范围（§2）
    { key: 'mine_type', label: '矿井类型', unit: null, source: 'fact', fact_key: 'gas.mine_type', type: 'enum', required: true },
    { key: 'mine_abandoned_or_closed', label: '是否废弃或关闭的井工煤矿', unit: null, source: 'fact', fact_key: 'gas.mine_abandoned_or_closed', type: 'bool', required: true },
    { key: 'oxidation_technology', label: '分解销毁技术', unit: null, source: 'fact', fact_key: 'gas.oxidation_technology', type: 'enum', required: true },
    { key: 'heat_utilization_route', label: '热能利用方式（决定公式15/16/17）', unit: null, source: 'fact', fact_key: 'gas.heat_utilization_route', type: 'enum', required: false },
    { key: 'diluted_from_high_concentration', label: '是否人为稀释浓度≥8% 的煤矿瓦斯后利用', unit: null, source: 'fact', fact_key: 'gas.diluted_from_high_concentration', type: 'bool', required: false },
    { key: 'gas_category', label: '瓦斯来源类别', unit: null, source: 'fact', fact_key: 'gas.gas_category', type: 'enum', required: false },
    // 活动数据（§6.3 公式3、4）
    { key: 'ch4_concentration_pct', label: '进入无焰氧化装置的甲烷体积浓度 PC_CH4,h', unit: '%', source: 'fact', fact_key: 'gas.ch4_concentration_pct', type: 'number', required: true, min: 0.01, max: 100 },
    { key: 'hours_per_year', label: '年运行总时长 time_y（已扣除浓度≥8% 时段）', unit: 'h/年', source: 'fact', fact_key: 'gas.hours_per_year', type: 'number', required: true, min: 1, max: 8784 },
    { key: 'npt_flow_m3h', label: '混合气体常温常压流量 F_NPT,h（小时值，直接监测）', unit: 'm³/h', source: 'fact', fact_key: 'gas.npt_flow_m3h', type: 'number', required: false, min: 0.001, max: 1e7 },
    { key: 'raw_flow_m3h', label: '混合气体工况流量 F_CH4,h（小时值）', unit: 'm³/h', source: 'fact', fact_key: 'gas.raw_flow_m3h', type: 'number', required: false, min: 0.001, max: 1e7 },
    { key: 'gas_temp_c', label: '进入装置的气体温度 t_CH4,h', unit: '℃', source: 'fact', fact_key: 'gas.gas_temp_c', type: 'number', required: false, min: -50, max: 200 },
    { key: 'gas_pressure_kpa', label: '进入装置的气体绝对压力 P_CH4,h', unit: 'kPa', source: 'fact', fact_key: 'gas.gas_pressure_kpa', type: 'number', required: false, min: 50, max: 300 },
    { key: 'recovery_volume_nm3', label: '年进入装置的混合气体常温常压流量合计（Σ F_NPT,h）', unit: 'Nm³/年', source: 'fact', fact_key: 'gas.recovery_volume_nm3', type: 'number', required: false, min: 1, max: 5e9 },
    // 外供电量 / 外供热量（§6.3 公式5、7、8、9）
    { key: 'elec_export_mwh', label: '年外供电量 ELEC_export,y', unit: 'MW·h/年', source: 'fact', fact_key: 'gas.elec_export_mwh', type: 'number', required: false, min: 0, max: 5e6 },
    { key: 'heat_export_gj', label: '年外供热量 Q_HEAT,y（可直接监测）', unit: 'GJ/年', source: 'fact', fact_key: 'gas.heat_export_gj', type: 'number', required: false, min: 0, max: 1e8 },
    { key: 'steam_mass_t', label: '外供蒸汽质量 Ma_st', unit: 't/年', source: 'fact', fact_key: 'gas.steam_mass_t', type: 'number', required: false, min: 0, max: 1e7 },
    { key: 'steam_enthalpy_kjkg', label: '蒸汽焓值 En_st', unit: 'kJ/kg', source: 'fact', fact_key: 'gas.steam_enthalpy_kjkg', type: 'number', required: false, min: 100, max: 4000 },
    { key: 'hot_water_mass_t', label: '外供热水质量 Ma_w', unit: 't/年', source: 'fact', fact_key: 'gas.hot_water_mass_t', type: 'number', required: false, min: 0, max: 1e8 },
    { key: 'hot_water_temp_c', label: '热水温度 t_w', unit: '℃', source: 'fact', fact_key: 'gas.hot_water_temp_c', type: 'number', required: false, min: 20, max: 200 },
    // 电网因子与项目用电（§6.4 公式6、11、12）
    { key: 'ef_grid_om', label: '区域电网电量边际排放因子 EF_grid,OM,y', unit: 'tCO₂/MW·h', source: 'fact', fact_key: 'gas.grid_ef_om', type: 'number', required: false, min: 0.05, max: 1.5 },
    { key: 'ef_grid_bm', label: '区域电网容量边际排放因子 EF_grid,BM,y', unit: 'tCO₂/MW·h', source: 'fact', fact_key: 'gas.grid_ef_bm', type: 'number', required: false, min: 0.05, max: 1.5 },
    { key: 'cons_elec_mwh', label: '项目运维电力消耗量 CONS_ELEC,y', unit: 'MW·h/年', source: 'fact', fact_key: 'gas.cons_elec_mwh', type: 'number', required: false, min: 0, max: 5e6 },
    { key: 'tdl', label: '项目所在省电网输配电损失率 TDL_y（小数，5% 填 0.05）', unit: '无量纲(0-1)', source: 'fact', fact_key: 'gas.tdl', type: 'number', required: false, min: 0, max: 0.5, factor_fallback: 'c10-001.tdl' },
    // 效率（§7.1 表 6 与公式16）
    { key: 'destruction_efficiency', label: '无焰氧化装置甲烷销毁效率 EFF_y（小数）', unit: '无量纲(0-1)', source: 'fact', fact_key: 'gas.destruction_efficiency', type: 'number', required: false, min: 0.3, max: 1, factor_fallback: 'c10-001.eff' },
    { key: 'eta_elec', label: '发电效率 η_ELEC（仅发电项目，官方无缺省值）', unit: '无量纲(0-1)', source: 'fact', fact_key: 'gas.elec_efficiency', type: 'number', required: false, min: 0.1, max: 0.6, factor_fallback: 'c10-001.eta.elec' },
    // §6.7 a）合规性判断
    { key: 'drainage_flow_npt_m3h', label: '抽采泵出口端抽采瓦斯常温常压流量之和 Σ F_NPT,CH4,i,h,drainage', unit: 'm³/h', source: 'fact', fact_key: 'gas.drainage_flow_npt_m3h', type: 'number', required: false, min: 0, max: 1e7 },
    { key: 'mixing_inlet_flow_npt_m3h', label: '混配管道入口处低浓度瓦斯常温常压流量 F_NPT,CH4,h,import', unit: 'm³/h', source: 'fact', fact_key: 'gas.mixing_inlet_flow_npt_m3h', type: 'number', required: false, min: 0, max: 1e7 },
    { key: 'mixing_flow_check_ok', label: '§6.7 a）混配入口流量是否不大于抽采泵出口流量之和', unit: null, source: 'fact', fact_key: 'gas.mixing_flow_check_ok', type: 'bool', required: false },
    { key: 'drainage_raw_flow_m3h', label: '抽采泵出口端工况流量 F_CH4,i,h,drainage（公式20）', unit: 'm³/h', source: 'fact', fact_key: 'gas.drainage_raw_flow_m3h', type: 'number', required: false, min: 0, max: 1e7 },
    { key: 'drainage_temp_c', label: '抽采泵出口端气体温度（公式20）', unit: '℃', source: 'fact', fact_key: 'gas.drainage_temp_c', type: 'number', required: false, min: -50, max: 200 },
    { key: 'drainage_pressure_kpa', label: '抽采泵出口端气体绝对压力（公式20）', unit: 'kPa', source: 'fact', fact_key: 'gas.drainage_pressure_kpa', type: 'number', required: false, min: 50, max: 300 },
    { key: 'drainage_ch4_pct', label: '抽采泵出口端甲烷体积浓度（§6.7 b）', unit: '%', source: 'fact', fact_key: 'gas.drainage_ch4_pct', type: 'number', required: false, min: 0, max: 100 },
    { key: 'mixing_raw_flow_m3h', label: '混配管道入口工况流量 F_CH4,h,import（公式21）', unit: 'm³/h', source: 'fact', fact_key: 'gas.mixing_raw_flow_m3h', type: 'number', required: false, min: 0, max: 1e7 },
    { key: 'mixing_temp_c', label: '混配管道入口气体温度（公式21）', unit: '℃', source: 'fact', fact_key: 'gas.mixing_temp_c', type: 'number', required: false, min: -50, max: 200 },
    { key: 'mixing_pressure_kpa', label: '混配管道入口气体绝对压力（公式21）', unit: 'kPa', source: 'fact', fact_key: 'gas.mixing_pressure_kpa', type: 'number', required: false, min: 50, max: 300 },
    { key: 'mixing_ch4_pct', label: '混配管道入口甲烷体积浓度（§6.7 b）', unit: '%', source: 'fact', fact_key: 'gas.mixing_ch4_pct', type: 'number', required: false, min: 0, max: 100 },
    { key: 'high_conc_periods_recorded', label: '是否已记录浓度≥8% 时段并从总量中扣除（§6.7 b）', unit: null, source: 'fact', fact_key: 'gas.high_conc_periods_recorded', type: 'bool', required: false },
    // 时间与联网（§2、§5.2.2）
    { key: 'crediting_years', label: '申请计入期长度', unit: '年', source: 'fact', fact_key: 'time.crediting_period_years', type: 'number', required: true, min: 1, max: 30 },
    { key: 'crediting_start_year', label: '计入期起始日期', unit: null, source: 'fact', fact_key: 'time.crediting_start', type: 'date', required: true },
    { key: 'reduction_generation_start', label: '减排量产生起始时间', unit: null, source: 'fact', fact_key: 'time.reduction_generation_start', type: 'date', required: false },
    { key: 'networking_trial_completed_date', label: '监测数据联网试运行完成日期', unit: null, source: 'fact', fact_key: 'mon.networking_trial_completed_date', type: 'date', required: false },
    { key: 'reduction_after_networking', label: '减排量产生时间是否不早于联网试运行完成日期', unit: null, source: 'fact', fact_key: 'mon.reduction_after_networking', type: 'bool', required: false },
    { key: 'metering_online', label: '监测数据是否与全国碳市场管理平台联网', unit: null, source: 'fact', fact_key: 'mon.metering_online', type: 'bool', required: false },
    { key: 'data_years', label: '有可用监测数据的年份', unit: null, source: 'input', type: 'list', required: false },
  ],

  /* ------------------------------- 情景 ------------------------------- */
  /* 乘数分别作用于：eff = EFF_y、elec = 外供电量、heat = 外供热量、hours = time_y。   */
  /* 方向性推导（ER_y = MM_y×EFF_y×(GWP−CEF_CH4) + BE_ELEC,y + BE_HEAT,y − PE_ME,y）：  */
  /*   · 当 MM_y 取推算值 MM″_y 时，MM_y×EFF_y = (Q_HEAT+3.6×ELEC)/(η_FOEF×η×55.64)， */
  /*     与 EFF 无关，故 EFF 下调不会抬高结果，只会通过 PE_UM 与取较小值边界保守化；   */
  /*   · 外供电量、外供热量线性进入 BE_ELEC、BE_HEAT，同时也线性进入 MM″_y；        */
  /*   · time_y 线性进入 MM′_y（气量受限时决定 MM_y）。                              */
  scenarios: {
    conservative: {
      label: SCENARIO_LABELS.conservative,
      multipliers: { eff: 0.95, elec: 0.9, heat: 0.9, hours: 0.9 },
      note:
        'EFF 取方法学缺省值的 95%（设备老化、氧化床性能衰减）；外供电量、外供热量按计量偏差与厂用电' +
        '口径保守下调 10%；time_y 扣减 10%（检修、停机与浓度≥8% 时段的不确定性）。' +
        '四个乘数均使 ER_y 不增大（EFF 在 MM″_y 支路中被约去，故不存在反向上抬），得到区间下限。',
    },
    base: {
      label: SCENARIO_LABELS.base,
      multipliers: { eff: 1.0, elec: 1.0, heat: 1.0, hours: 1.0 },
      note: '按监测记录原值计算：EFF 取表 6 缺省值 90%、time_y 取扣除浓度≥8% 时段后的运行总时长、外供电量与供热量取实测值。',
    },
    optimistic: {
      label: SCENARIO_LABELS.optimistic,
      multipliers: { eff: 1.05, elec: 1.1, heat: 1.1, hours: 1.05 },
      note:
        '设备满负荷、氧化装置达设计性能：EFF 上浮 5%（并截断至物理上限 1.0，不得超过 100%）；' +
        '外供电量与供热量按设计能力上浮 10%（不得超设计值）；time_y 上浮 5%（上限 8760 h）。' +
        '该情景均为模型假设，用于给出区间上界，不得当作可获得的减排量。',
    },
  },

  /* ------------------------------ 输入校验 ------------------------------ */
  validate(inputs) {
    const errors = [];
    const warnings = [];
    const push = (e) => { if (e) errors.push(e); };

    /* ---------- §2 适用范围 ---------- */
    const mineType = inputs.mine_type;
    if (mineType === null || mineType === undefined || mineType === '') {
      errors.push({ field: 'mine_type', kind: 'missing', message: '矿井类型缺失：无法确认是否属于「井工煤矿（不包括废弃或关闭的井工煤矿）」，禁止出数。' });
    } else if (mineType !== '井工煤矿') {
      errors.push({
        field: 'mine_type', kind: 'scope_violation',
        message: `矿井类型为「${mineType}」：§2 第 1 段仅适用于井工煤矿（不包括废弃或关闭的井工煤矿），露天煤矿不属于本文件适用范围。`,
      });
    }

    const closed = inputs.mine_abandoned_or_closed;
    if (closed === null || closed === undefined || closed === '') {
      errors.push({ field: 'mine_abandoned_or_closed', kind: 'missing', message: '未填写是否属于废弃或关闭的井工煤矿，无法确认 §2 的排除条件，禁止出数。' });
    } else if (closed === true) {
      errors.push({
        field: 'mine_abandoned_or_closed', kind: 'scope_violation',
        message: '项目属于废弃或关闭的井工煤矿：§2 第 1 段明确排除，不属于本文件适用范围。',
      });
    }

    const tech = inputs.oxidation_technology;
    if (tech === null || tech === undefined || tech === '') {
      errors.push({ field: 'oxidation_technology', kind: 'missing', message: '未填写分解销毁技术，无法确认是否为无焰氧化技术，禁止出数。' });
    } else if (tech !== '无焰氧化') {
      errors.push({
        field: 'oxidation_technology', kind: 'scope_violation',
        message: `分解销毁技术为「${tech}」：§2 第 3 段规定本文件中分解销毁技术暂仅限于无焰氧化技术。`,
      });
    }

    if (inputs.diluted_from_high_concentration === true) {
      errors.push({
        field: 'diluted_from_high_concentration', kind: 'scope_violation',
        message: '项目瓦斯系人为将甲烷体积浓度大于或等于 8% 的煤矿瓦斯稀释后得到：§2 第 4 段明确不适用于该情形。',
      });
    } else if (inputs.diluted_from_high_concentration === null || inputs.diluted_from_high_concentration === undefined || inputs.diluted_from_high_concentration === '') {
      warnings.push({ field: 'diluted_from_high_concentration', message: '未填写是否人为稀释高浓度瓦斯，§2 第 4 段的排除条件无法核验。' });
    }

    /* ---------- 甲烷体积浓度 ---------- */
    push(validateNumeric('进入无焰氧化装置的甲烷体积浓度', inputs.ch4_concentration_pct, { min: 0.01, max: 100, unit: '%', field: 'ch4_concentration_pct' }));
    const pc = num(inputs, 'ch4_concentration_pct');
    if (pc !== null && pc >= 8) {
      errors.push({
        field: 'ch4_concentration_pct', kind: 'scope_violation',
        message: `甲烷体积浓度 ${pc}% 不低于 8%：不符合 §2「甲烷体积浓度低于 8%」的适用条件；` +
          '且按 §6.7 b）该时段应从 time_y 中扣除，并扣除对应时段内进入装置的甲烷量、外供电量和外供热量。',
      });
    } else if (pc !== null && pc >= 7) {
      warnings.push({ field: 'ch4_concentration_pct', message: `甲烷体积浓度 ${pc}% 已接近 8% 上限，请核对监测点位是否为进入无焰氧化装置前端（§7.2 表 9）。` });
    }
    push(validateNumeric('抽采泵出口端甲烷体积浓度', inputs.drainage_ch4_pct, { min: 0, max: 100, unit: '%', field: 'drainage_ch4_pct', allowNull: true }));
    push(validateNumeric('混配管道入口甲烷体积浓度', inputs.mixing_ch4_pct, { min: 0, max: 100, unit: '%', field: 'mixing_ch4_pct', allowNull: true }));
    for (const [field, label] of [['drainage_ch4_pct', '抽采泵出口端'], ['mixing_ch4_pct', '混配管道入口']]) {
      const v = num(inputs, field);
      if (v !== null && v >= 8) {
        errors.push({
          field, kind: 'scope_violation',
          message: `${label}甲烷体积浓度 ${v}% 不低于 8%：按 §6.7 b）该时段应从 time_y 与对应量中扣除；若为常态则不符合 §2 的适用条件。`,
        });
      }
    }

    /* ---------- 热能利用方式与出力数据 ---------- */
    const route = inputs.heat_utilization_route;
    if (route && !['发电', '供热', '热电联产'].includes(route)) {
      errors.push({
        field: 'heat_utilization_route', kind: 'scope_violation',
        message: `热能利用方式为「${route}」：§2 a）/b）仅认可发电、供热或热电联产。`,
      });
    }
    const elecExport = num(inputs, 'elec_export_mwh');
    const heatDeclared = num(inputs, 'heat_export_gj')
      ?? ((num(inputs, 'steam_mass_t') !== null && num(inputs, 'steam_enthalpy_kjkg') !== null)
        ? num(inputs, 'steam_mass_t') * (num(inputs, 'steam_enthalpy_kjkg') - 83.74) * 1e-3 : null)
      ?? ((num(inputs, 'hot_water_mass_t') !== null && num(inputs, 'hot_water_temp_c') !== null)
        ? num(inputs, 'hot_water_mass_t') * (num(inputs, 'hot_water_temp_c') - 20) * 4.1868 * 1e-3 : null);
    const hasElec = (elecExport ?? 0) > 0;
    const hasHeat = (heatDeclared ?? 0) > 0;
    const mode = ['发电', '供热', '热电联产'].includes(route)
      ? route
      : hasElec && hasHeat ? '热电联产' : hasElec ? '发电' : hasHeat ? '供热' : null;
    if (mode === null) {
      errors.push({
        field: 'heat_utilization_route', kind: 'missing',
        message: '无法确定热能利用方式，且未提供年外供电量与年外供热量：公式（15）（16）（17）无法选择，' +
          '推算甲烷量 MM″_y 无法计算，禁止出数。',
      });
    } else {
      if ((mode === '发电' || mode === '热电联产') && !hasElec) {
        errors.push({ field: 'elec_export_mwh', kind: 'missing', message: `${mode}项目缺少年外供电量 ELEC_export,y，公式（5）（15）/（16）无法计算，禁止出数。` });
      }
      if ((mode === '供热' || mode === '热电联产') && !hasHeat) {
        errors.push({ field: 'heat_export_gj', kind: 'missing', message: `${mode}项目缺少年外供热量 Q_HEAT,y（也未提供蒸汽/热水换算数据），公式（7）（15）/（17）无法计算，禁止出数。` });
      }
      if (mode === '发电' && num(inputs, 'eta_elec') === null) {
        errors.push({ field: 'eta_elec', kind: 'missing', message: '仅发电项目按公式（16）计算推算甲烷量，须提供发电效率 η_ELEC（官方未给出缺省值），禁止出数。' });
      }
    }

    /* ---------- 数值合理范围 ---------- */
    push(validateNumeric('年运行总时长 time_y', inputs.hours_per_year, { min: 1, max: 8784, unit: 'h/年', field: 'hours_per_year' }));
    const hours = num(inputs, 'hours_per_year');
    if (hours !== null && hours > 8760) {
      warnings.push({ field: 'hours_per_year', message: `年运行总时长 ${hours} h 超过 8760 h，请确认是否跨年或未扣除浓度≥8% 时段（§6.7 b））。` });
    }
    push(validateNumeric('混合气体常温常压流量（小时值）', inputs.npt_flow_m3h, { min: 0.001, max: 1e7, unit: 'm³/h', field: 'npt_flow_m3h', allowNull: true }));
    push(validateNumeric('混合气体工况流量（小时值）', inputs.raw_flow_m3h, { min: 0.001, max: 1e7, unit: 'm³/h', field: 'raw_flow_m3h', allowNull: true }));
    push(validateNumeric('进入装置的气体温度', inputs.gas_temp_c, { min: -50, max: 200, unit: '℃', field: 'gas_temp_c', allowNull: true }));
    push(validateNumeric('进入装置的气体绝对压力', inputs.gas_pressure_kpa, { min: 50, max: 300, unit: 'kPa', field: 'gas_pressure_kpa', allowNull: true }));
    push(validateNumeric('年外供电量', inputs.elec_export_mwh, { min: 0, max: 5e6, unit: 'MW·h/年', field: 'elec_export_mwh', allowNull: true }));
    push(validateNumeric('年外供热量', inputs.heat_export_gj, { min: 0, max: 1e8, unit: 'GJ/年', field: 'heat_export_gj', allowNull: true }));
    push(validateNumeric('蒸汽焓值', inputs.steam_enthalpy_kjkg, { min: 100, max: 4000, unit: 'kJ/kg', field: 'steam_enthalpy_kjkg', allowNull: true }));
    push(validateNumeric('热水温度', inputs.hot_water_temp_c, { min: 20, max: 200, unit: '℃', field: 'hot_water_temp_c', allowNull: true }));
    push(validateNumeric('项目运维电力消耗量', inputs.cons_elec_mwh, { min: 0, max: 5e6, unit: 'MW·h/年', field: 'cons_elec_mwh', allowNull: true }));
    push(validateNumeric('发电效率 η_ELEC', inputs.eta_elec, { min: 0.1, max: 0.6, unit: '无量纲(0-1)', field: 'eta_elec', allowNull: true }));

    /* ---------- 带单位陷阱的数值（D-02：单位错误一律阻止出数） ---------- */
    // EFF_y：官方表 6 数值为 90（%），公式中按小数参与乘除；误填百分数时必须给出换算提示。
    const effErr = validateNumeric('无焰氧化装置甲烷销毁效率 EFF_y', inputs.destruction_efficiency, { min: 0.3, max: 1, unit: '无量纲(0-1)', field: 'destruction_efficiency', allowNull: true });
    if (effErr) {
      errors.push(effErr.kind === 'out_of_range'
        ? { ...effErr, message: `${effErr.message}（官方表 6 数值为 90，单位为 %，须换算为小数 0.90 后填报）` }
        : effErr);
    }
    // TDL_y：公式(12) 的分母为 (1 − TDL_y)，误把 5% 填成 5 会让分母变负，必须阻止出数。
    const tdlErr = validateNumeric('项目所在省电网输配电损失率 TDL_y', inputs.tdl, { min: 0, max: 0.5, unit: '无量纲(0-1)', field: 'tdl', allowNull: true });
    if (tdlErr) {
      errors.push(tdlErr.kind === 'out_of_range'
        ? { ...tdlErr, message: `${tdlErr.message}（公式（12）的分母为 (1 − TDL_y)，须以小数填报：例如 5% 填 0.05，不得填 5）` }
        : tdlErr);
    }

    /* ---------- 计入期（§5.2.2） ---------- */
    push(validateNumeric('申请计入期长度', inputs.crediting_years, { min: 1, max: 30, unit: '年', field: 'crediting_years' }));
    const cy = num(inputs, 'crediting_years');
    if (cy !== null && cy > 10) {
      errors.push({
        field: 'crediting_years', kind: 'out_of_range',
        message: `申请计入期 ${cy} 年超过 §5.2.2 规定的「最长不超过 10 年」，超出部分不得申请减排量登记。`,
      });
    }
    if (!inputs.crediting_start_year) {
      errors.push({ field: 'crediting_start_year', kind: 'missing', message: '计入期起始日期缺失，禁止出数。' });
    }

    /* ---------- §2：减排量产生时间不早于完成联网试运行 ---------- */
    const netDate = inputs.networking_trial_completed_date;
    const redDate = inputs.reduction_generation_start;
    if (netDate && redDate) {
      if (String(redDate) < String(netDate)) {
        errors.push({
          field: 'reduction_generation_start', kind: 'scope_violation',
          message: `减排量产生起始时间 ${redDate} 早于监测数据联网试运行完成日期 ${netDate}：` +
            '§2 第 5 段要求减排量产生于项目相关监测数据联网（完成联网试运行）之后，该期间的减排量不符合适用条件。',
        });
      }
    } else if (!netDate) {
      warnings.push({ field: 'networking_trial_completed_date', message: '未提供监测数据联网试运行完成日期，§2 第 5 段的时序条件无法核验。' });
    }
    if (inputs.reduction_after_networking === false) {
      errors.push({
        field: 'reduction_after_networking', kind: 'scope_violation',
        message: '减排量产生时间不满足「不早于监测数据联网（完成联网试运行）」的要求（§2 第 5 段）。',
      });
    }
    if (inputs.metering_online === false) {
      warnings.push({ field: 'metering_online', message: '监测数据尚未与全国碳市场管理平台联网（§2 第 5 段），联网前的减排量不得申请登记。' });
    }

    /* ---------- §6.7 a）合规性判断（公式19） ---------- */
    // validate 无法拿到因子注册表，故按公式(4) 的官方常数直接换算（T_NPT = 293.15 K、P_NPT = 101.325 kPa）。
    const drainage = num(inputs, 'drainage_flow_npt_m3h')
      ?? nptFromRaw(num(inputs, 'drainage_raw_flow_m3h'), num(inputs, 'drainage_temp_c'), num(inputs, 'drainage_pressure_kpa'), 293.15, 101.325);
    const mixing = num(inputs, 'mixing_inlet_flow_npt_m3h')
      ?? nptFromRaw(num(inputs, 'mixing_raw_flow_m3h'), num(inputs, 'mixing_temp_c'), num(inputs, 'mixing_pressure_kpa'), 293.15, 101.325);
    if (drainage !== null && mixing !== null) {
      if (drainage < mixing) {
        errors.push({
          field: 'mixing_inlet_flow_npt_m3h', kind: 'scope_violation',
          message:
            `公式（19）情形出现：Σ F_NPT,CH4,i,h,drainage = ${round(drainage, 4)} m³/h 小于 ` +
            `F_NPT,CH4,h,import = ${round(mixing, 4)} m³/h，即混配管道入口处的低浓度瓦斯常温常压流量大于` +
            '为其提供气源的所有地面瓦斯抽采泵出口端抽采瓦斯常温常压流量之和，视为不符合项目适用条件：' +
            '应书面报告项目所在地省级生态环境主管部门，省级生态环境主管部门经查实后通知全国温室气体自愿减排' +
            '注册登记机构撤销项目登记（§6.7 a））。',
        });
      }
    } else {
      warnings.push({
        field: 'mixing_inlet_flow_npt_m3h',
        message: '抽采泵出口端流量之和与混配管道入口流量未同时提供，§6.7 a）公式（19）的合规性判断（含"撤销项目登记"后果）无法执行。',
      });
    }
    if (inputs.mixing_flow_check_ok === false) {
      errors.push({
        field: 'mixing_flow_check_ok', kind: 'scope_violation',
        message: '§6.7 a）判断结果为「不符合」：混配入口流量大于抽采泵出口流量之和，应报告省级生态环境主管部门并撤销项目登记。',
      });
    }
    if (inputs.high_conc_periods_recorded === false) {
      warnings.push({
        field: 'high_conc_periods_recorded',
        message: '未记录甲烷体积浓度不低于 8% 的时段：§6.7 b）要求该时段从 time_y 中扣除，并扣除对应时段内的甲烷量、外供电量和外供热量。',
      });
    }

    /* ---------- 计算链所需的其他数据 ---------- */
    const efCmOk = num(inputs, 'ef_grid_om') !== null && num(inputs, 'ef_grid_bm') !== null;
    if (!efCmOk && ((hasElec) || num(inputs, 'cons_elec_mwh') !== null)) {
      errors.push({
        field: 'ef_grid_om', kind: 'missing',
        message: '缺少区域电网电量边际排放因子或容量边际排放因子：公式（6）EF_grid,CM,y 无法计算，公式（5）（11）无法执行，禁止出数。',
      });
    }
    const consElec = num(inputs, 'cons_elec_mwh');
    if (consElec !== null && num(inputs, 'tdl') === null) {
      errors.push({
        field: 'tdl', kind: 'missing',
        message: '提供了项目运维电力消耗量但缺少 TDL_y：公式（12）无法计算。TDL_y 官方未给缺省值（placeholder），须填报项目所在省电网输配电损失率（小数）。',
      });
    }
    if (consElec === null) {
      warnings.push({
        field: 'cons_elec_mwh',
        message: '未提供项目运维电力消耗量 CONS_ELEC,y：PE_ME,y 无法计入（§5.3 表 1 该项目排放源应计），结果偏大且不满足保守性要求。',
      });
    }
    if (num(inputs, 'npt_flow_m3h') === null && num(inputs, 'raw_flow_m3h') === null && num(inputs, 'recovery_volume_nm3') === null) {
      errors.push({
        field: 'recovery_volume_nm3', kind: 'missing',
        message: '缺少进入无焰氧化装置的混合气体流量：请提供 F_NPT,h（小时值）、或 F_CH4,h 与温度/压力（公式4 换算）、或年常温常压流量合计（公式3 求和项），否则实测甲烷量 MM′_y 无法计算。',
      });
    }
    if (num(inputs, 'npt_flow_m3h') === null && num(inputs, 'raw_flow_m3h') === null
      && num(inputs, 'recovery_volume_nm3') !== null && num(inputs, 'hours_per_year') === null) {
      errors.push({ field: 'hours_per_year', kind: 'missing', message: '按年度流量口径计算时需要年运行总时长 time_y（公式3 的求和上限）。' });
    }
    if (num(inputs, 'steam_mass_t') !== null && num(inputs, 'steam_enthalpy_kjkg') === null) {
      warnings.push({ field: 'steam_enthalpy_kjkg', message: '提供了蒸汽质量但缺少蒸汽焓值 En_st（按附件 B 查表或线性内插），公式（8）无法换算外供热量。' });
    }
    if (num(inputs, 'hot_water_mass_t') !== null && num(inputs, 'hot_water_temp_c') === null) {
      warnings.push({ field: 'hot_water_temp_c', message: '提供了热水质量但缺少热水温度 t_w，公式（9）无法换算外供热量。' });
    }

    return { errors, warnings };
  },

  /* ------------------------------ 计算链 ------------------------------ */
  compute(inputs, ctx) {
    const fac = ctx.factors;
    const m = ctx.scenarioMultipliers || { eff: 1, elec: 1, heat: 1, hours: 1 };
    const chain = runChain(inputs, ctx);

    /* ---------- 计入期年度序列 ---------- */
    // 计入期年度序列：validate() 已把超过 §5.2.2 的 10 年上限判为 out_of_range，
    // 此处再作一次防御性截断，保证直接调用 compute 时序列长度也不越界。
    const years = Math.min(10, Math.max(1, Math.round(num(inputs, 'crediting_years') || 1)));
    const startYear = Number(String(inputs.crediting_start_year || '').slice(0, 4)) || new Date().getUTCFullYear();
    const dataYears = Array.isArray(inputs.data_years) ? inputs.data_years.map(Number) : [];
    const annual = buildAnnualSeries({ startYear, years, perYear: chain.er, dataAvailableYears: dataYears });
    const crediting = aggregateCrediting(annual.filter((a) => a.reduction !== null));

    /* ---------- 模型假设与口径披露 ---------- */
    const assumptions = [
      '情景乘数（模型假设）：' + JSON.stringify(m) +
      '，分别作用于 EFF_y、年外供电量、年外供热量与 time_y；' +
      (m.eff === 1 && m.elec === 1 && m.heat === 1 && m.hours === 1
        ? '基准情景不施加任何乘数。'
        : `当前情景「${ctx.scenarioLabel || ctx.scenario || 'base'}」，三个情景的结果差异仅来自上述乘数。`),
      'MM_y 按公式(2) 取实测甲烷量 MM′_y 与推算甲烷量 MM″_y 中的较小值（方法学规定的保守取值，' +
      `本次运行 MM′_y = ${tv(chain.values.mm_measured_t)} tCH₄、MM″_y = ${tv(chain.values.mm_derived_t)} tCH₄，` +
      `故 MM_y = ${tv(chain.values.mm_t)} tCH₄）。`,
      '公式(3) 口径：官方印刷式为 F_NPT,h × PC_CH4,h × ρ_CH4 × 10⁻³，其「式中」说明 PC_CH4,h 为「甲烷体积浓度，' +
      '单位为百分比（%）」。本插件按量纲要求先把百分数换算为体积分数（PC_CH4,h ÷ 100）再代入；' +
      '若直接以 % 数值（如 1.2）相乘，MM′_y 会放大 100 倍。该换算已列入 docs/12 领域专家确认清单（EXP-117）。',
      `ρ_CH4 取方法学专属值 0.67 kg/m³（方法学定义常温常压为 20 ℃、1 个标准大气压），未使用全局因子 rho.ch4.standard = 0.716 kg/Nm³（0 ℃ 标态）。`,
      '基准线情景固定为煤矿低浓度瓦斯和风排瓦斯全部排空（§6.1），不存在火炬燃烧或部分利用的基准线变体。',
      '项目泄漏按 §6.5 忽略不计：公式(18) 不含泄漏项，本插件输出 LE_y = 0 仅作说明性步骤。',
      '按 §5.3 表 1，无焰氧化装置蓄热体预热导致的化石燃料消耗 CO₂ 计为 0；应急排放在甲烷量计量仪表之前，无需考虑。',
      '公式(15)(16)(17) 分母中的 55.64 为官方印刷常数（官方式中未作「式中」说明，按量纲反推为甲烷热值 GJ/tCH₄），本插件按原值使用。',
      'TDL_y 代入公式(12) 时须为小数（(1 − TDL_y) 为分母，5% 填 0.05）。',
    ];
    for (const p of PLACEHOLDER_FACTORS) {
      assumptions.push(
        `占位因子「${p.name}」（${p.factor_key}）= ${p.value === null ? '官方未给缺省值，须逐项目填报' : `${p.value} ${p.unit}`}：${p.note}`
      );
    }
    for (const p of fac.placeholders()) {
      if (PLACEHOLDER_FACTORS.some((x) => x.factor_key === p.factor_key)) continue;
      assumptions.push(`占位因子「${p.name}」= ${p.value} ${p.unit}（${p.verification_note || '待领域专家确认'}）`);
    }

    /* ---------- 缺失数据清单（未猜值） ---------- */
    const missing = [...chain.missing];
    if (dataYears.length === 0) missing.push('分年度实测运行数据（计入期按年度均值估算，未做逐年差异化）');
    if (!inputs.reduction_generation_start) missing.push('减排量产生起始时间（§2 联网时序条件无法核验）');
    if (!inputs.networking_trial_completed_date) {
      missing.push('监测数据联网试运行完成日期（§2 联网时序条件无法核验）');
    }
    if (num(inputs, 'npt_flow_m3h') === null && num(inputs, 'raw_flow_m3h') === null) {
      missing.push('小时工况流量与温度/压力（F_NPT,h 改用年度常温常压流量合计口径）');
    }

    /* ---------- 计算过程警示 ---------- */
    const warnings = [...chain.warnings];
    if (chain.er < 0) {
      warnings.push({
        field: 'er_annual',
        message:
          '可计减排量为负值：项目甲烷销毁与热能利用不足以超越基准线全部排空情景，相对基准线不产生减排量。' +
          '请复核甲烷体积浓度、销毁效率、外供电量/外供热量计量与 §6.7 b）扣除口径。',
      });
    }
    if (chain.values.mm_derived_t === null) {
      warnings.push({
        field: 'heat_utilization_route',
        message: 'MM″_y 缺失，公式(2) 的取较小值未完整执行，结果不可用于正式报告。',
      });
    }

    /* ---------- 敏感性分析 ---------- */
    const sens = sensitivity(
      (over) => runChain({ ...inputs, ...over }, ctx).er,
      inputs,
      [
        { key: 'ch4_concentration_pct', label: '甲烷体积浓度 PC_CH4,h', unit: '%', delta: 0.1 },
        { key: 'hours_per_year', label: '年运行总时长 time_y', unit: 'h/年', delta: 0.1 },
        { key: 'elec_export_mwh', label: '年外供电量 ELEC_export,y', unit: 'MW·h/年', delta: 0.1 },
        { key: 'heat_export_gj', label: '年外供热量 Q_HEAT,y', unit: 'GJ/年', delta: 0.1 },
        { key: 'destruction_efficiency', label: '无焰氧化装置销毁效率 EFF_y', unit: '无量纲', delta: 0.05 },
      ]
    );

    return {
      steps: chain.steps,
      annual,
      crediting,
      assumptions,
      missing,
      warnings,
      sensitivity: sens,
      er_annual: round(chain.er, 4),
      // 命名中间量：供自检样例、独立复算与报告逐项比对
      // （见 scripts/verify-10001.mjs 与 test/official-10-001.mjs 的第二套实现）
      checkpoints: chain.values,
    };
  },

  /* --------------------------- 独立复算样例 --------------------------- */
  /* 每个样例的期望值均由官方公式(1)~(21) 独立手算得出（注释中列出全部中间量），   */
  /* 未取自插件输出；引擎复算应与之一致（见 tolerance）。                        */
  selfCheckSamples: [
    {
      name: '样例 A：仅发电（公式4→3→16），工况流量 1000 m³/h、温度 20 ℃、绝对压力 101.325 kPa、浓度 1.2%、运行 8000 h、外供电量 30000 MW·h',
      inputs: {
        mine_type: '井工煤矿', mine_abandoned_or_closed: false,
        oxidation_technology: '无焰氧化', heat_utilization_route: '发电',
        diluted_from_high_concentration: false,
        ch4_concentration_pct: 1.2,
        raw_flow_m3h: 1000, gas_temp_c: 20, gas_pressure_kpa: 101.325,
        hours_per_year: 8000,
        elec_export_mwh: 30000, heat_export_gj: 0,
        ef_grid_om: 0.6, ef_grid_bm: 0.4,
        cons_elec_mwh: 380, tdl: 0.05, eta_elec: 0.35,
        destruction_efficiency: 0.9,
        metering_online: true,
        networking_trial_completed_date: '2024-01-01',
        reduction_generation_start: '2024-06-01',
        reduction_after_networking: true,
        high_conc_periods_recorded: true,
        drainage_flow_npt_m3h: 5000, mixing_inlet_flow_npt_m3h: 1000, mixing_flow_check_ok: true,
        crediting_years: 10, crediting_start_year: '2025-01-01',
      },
      expect: {
        // 手算过程（独立于插件，全部按官方公式）：
        //   公式(4)：F_NPT,h = 1000 × 293.15 × 101.325 ÷ ( (273.15+20) × 101.325 ) = 1000 × 293.15 ÷ 293.15 = 1000 m³/h
        //   公式(3)：浓度 1.2 % 先换算为体积分数 0.012（量纲要求，见 compute 中的说明）
        //            V_CH4,y = time_y × F_NPT,h × PC_CH4,h = 8000 × 1000 × 0.012 = 96,000 m³
        //            MM′_y = 96,000 × 0.67 ÷ 1000 = 64.32 tCH₄
        //   公式(16)：MM″_y = ( 30000 × 3.6 ) ÷ ( 0.9 × 0.91 × 0.35 × 55.64 )
        //                  = 108000 ÷ 15.949206 = 6771.49696355 tCH₄
        //   公式(2)： MM_y = min(64.32, 6771.49696355) = 64.32 tCH₄（**气量受限支路**）
        //            BE_MR,y = 64.32 × 28 = 1,800.96 tCO₂e
        //   公式(6)：EF_grid,CM,y = 0.6 × 0.5 + 0.4 × 0.5 = 0.5 tCO₂/MW·h
        //   公式(5)：BE_ELEC,y = 30000 × 0.5 = 15,000 tCO₂e ；公式(7)：BE_HEAT,y = 0 × 0.06 = 0
        //   公式(1)：BE_y = 1800.96 + 15000 + 0 = 16,800.96 tCO₂e
        //   公式(12)：CONS_grid,y = 380 ÷ (1 − 0.05) = 400 MW·h
        //   公式(11)：PE_ME,y = 400 × 0.5 = 200 tCO₂
        //   公式(13)：PE_MD,y = 64.32 × 0.9 × 2.7432 = 57.888 × 2.7432 = 158.7983616 tCO₂
        //   公式(14)：PE_UM,y = 28 × 64.32 × (1 − 0.9) = 180.096 tCO₂e
        //   公式(10)：PE_y = 200 + 158.7983616 + 180.096 = 538.8943616 tCO₂e
        //   公式(18)：ER_y = 16800.96 − 538.8943616 = 16,262.0656384 tCO₂e/年
        //   闭式校核：ER_y = MM_y×EFF_y×(GWP−CEF) + BE_ELEC + BE_HEAT − PE_ME
        //            = 64.32 × 0.9 × (28 − 2.7432) + 15000 + 0 − 200
        //            = 57.888 × 25.2568 + 14800 = 1462.0656384 + 14800 = 16,262.0656384 ✔
        f_npt_h: 1000,
        v_ch4_nm3: 96000,
        mm_measured_t: 64.32,
        mm_derived_t: 6771.49696355,
        mm_t: 64.32,
        be_mr_tco2e: 1800.96,
        ef_grid_cm: 0.5,
        be_elec_tco2e: 15000,
        be_heat_tco2e: 0,
        be_tco2e: 16800.96,
        cons_grid_mwh: 400,
        pe_me_tco2e: 200,
        pe_md_tco2e: 158.7983616,
        pe_um_tco2e: 180.096,
        pe_tco2e: 538.8943616,
        er_annual_tco2e: 16262.0656384,
      },
      tolerance: 0.01,
    },
    {
      name: '样例 B：仅供热（公式8→3→17），蒸汽 10000 t、焓值 2800 kJ/kg、年常温常压流量合计 1,000,000 Nm³、浓度 0.8%',
      inputs: {
        mine_type: '井工煤矿', mine_abandoned_or_closed: false,
        oxidation_technology: '无焰氧化', heat_utilization_route: '供热',
        diluted_from_high_concentration: false,
        ch4_concentration_pct: 0.8,
        recovery_volume_nm3: 1000000, hours_per_year: 6000,
        steam_mass_t: 10000, steam_enthalpy_kjkg: 2800,
        elec_export_mwh: 0,
        ef_grid_om: 0.6, ef_grid_bm: 0.4,
        cons_elec_mwh: 95, tdl: 0.05,
        destruction_efficiency: 0.9,
        metering_online: true,
        networking_trial_completed_date: '2024-01-01',
        reduction_generation_start: '2024-06-01',
        reduction_after_networking: true,
        high_conc_periods_recorded: true,
        crediting_years: 10, crediting_start_year: '2025-01-01',
      },
      expect: {
        // 手算过程：
        //   公式(8)：Q_steam = 10000 × ( 2800 − 83.74 ) × 10⁻³ = 10000 × 2716.26 × 10⁻³ = 27,162.6 GJ
        //   公式(3)：浓度 0.8 % → 体积分数 0.008
        //            V_CH4,y = 1,000,000 × 0.008 = 8,000 m³ ；MM′_y = 8000 × 0.67 ÷ 1000 = 5.36 tCH₄
        //   公式(17)：MM″_y = 27162.6 ÷ ( 0.9 × 0.91 × 0.88 × 55.64 ) = 27162.6 ÷ 40.1008608 = 677.3570307 tCH₄
        //   公式(2)： MM_y = min(5.36, 677.3570307) = 5.36 tCH₄ ；BE_MR,y = 5.36 × 28 = 150.08 tCO₂e
        //   公式(6)：EF_grid,CM,y = 0.5 ；公式(7)：BE_HEAT,y = 27162.6 × 0.06 = 1,629.756 tCO₂e
        //   公式(1)：BE_y = 150.08 + 0 + 1629.756 = 1,779.836 tCO₂e
        //   公式(12)：CONS_grid,y = 95 ÷ 0.95 = 100 MW·h ；公式(11)：PE_ME,y = 100 × 0.5 = 50 tCO₂
        //   公式(13)：PE_MD,y = 5.36 × 0.9 × 2.7432 = 4.824 × 2.7432 = 13.2331968 tCO₂
        //   公式(14)：PE_UM,y = 28 × 5.36 × 0.1 = 15.008 tCO₂e
        //   公式(10)：PE_y = 50 + 13.2331968 + 15.008 = 78.2411968 tCO₂e
        //   公式(18)：ER_y = 1779.836 − 78.2411968 = 1,701.5948032 tCO₂e/年
        //   闭式校核：5.36 × 0.9 × 25.2568 + 0 + 1629.756 − 50 = 121.8388032 + 1579.756 = 1,701.5948032 ✔
        q_heat_gj: 27162.6,
        v_ch4_nm3: 8000,
        mm_measured_t: 5.36,
        mm_derived_t: 677.3570307,
        mm_t: 5.36,
        be_mr_tco2e: 150.08,
        be_heat_tco2e: 1629.756,
        be_tco2e: 1779.836,
        cons_grid_mwh: 100,
        pe_me_tco2e: 50,
        pe_md_tco2e: 13.2331968,
        pe_um_tco2e: 15.008,
        pe_tco2e: 78.2411968,
        er_annual_tco2e: 1701.5948032,
      },
      tolerance: 0.01,
    },
    {
      name: '样例 C：热电联产（公式9→3→15），热水 5000 t、90 ℃、外供电量 3000 MW·h、年常温常压流量合计 500,000 Nm³、浓度 0.9%',
      inputs: {
        mine_type: '井工煤矿', mine_abandoned_or_closed: false,
        oxidation_technology: '无焰氧化', heat_utilization_route: '热电联产',
        diluted_from_high_concentration: false,
        ch4_concentration_pct: 0.9,
        recovery_volume_nm3: 500000, hours_per_year: 5000,
        hot_water_mass_t: 5000, hot_water_temp_c: 90,
        elec_export_mwh: 3000,
        ef_grid_om: 0.6, ef_grid_bm: 0.4,
        cons_elec_mwh: 47.5, tdl: 0.05,
        destruction_efficiency: 0.9,
        metering_online: true,
        networking_trial_completed_date: '2024-01-01',
        reduction_generation_start: '2024-06-01',
        reduction_after_networking: true,
        high_conc_periods_recorded: true,
        drainage_flow_npt_m3h: 3000, mixing_inlet_flow_npt_m3h: 2500, mixing_flow_check_ok: true,
        crediting_years: 10, crediting_start_year: '2025-01-01',
      },
      expect: {
        // 手算过程：
        //   公式(9)：Q_water = 5000 × ( 90 − 20 ) × 4.1868 × 10⁻³ = 5000 × 70 × 0.0041868 = 1,465.38 GJ
        //   公式(3)：浓度 0.9 % → 体积分数 0.009
        //            V_CH4,y = 500,000 × 0.009 = 4,500 m³ ；MM′_y = 4500 × 0.67 ÷ 1000 = 3.015 tCH₄
        //   公式(15)：MM″_y = ( 1465.38 + 3000 × 3.6 ) ÷ ( 0.9 × 0.91 × 0.86 × 55.64 )
        //                  = ( 1465.38 + 10800 ) ÷ 39.1894776 = 12265.38 ÷ 39.1894776 = 312.97635874 tCH₄
        //   公式(2)： MM_y = min(3.015, 312.97635874) = 3.015 tCH₄ ；BE_MR,y = 3.015 × 28 = 84.42 tCO₂e
        //   公式(5)：BE_ELEC,y = 3000 × 0.5 = 1,500 ；公式(7)：BE_HEAT,y = 1465.38 × 0.06 = 87.9228
        //   公式(1)：BE_y = 84.42 + 1500 + 87.9228 = 1,672.3428 tCO₂e
        //   公式(12)：CONS_grid,y = 47.5 ÷ 0.95 = 50 MW·h ；公式(11)：PE_ME,y = 50 × 0.5 = 25 tCO₂
        //   公式(13)：PE_MD,y = 3.015 × 0.9 × 2.7432 = 2.7135 × 2.7432 = 7.4436732 tCO₂
        //   公式(14)：PE_UM,y = 28 × 3.015 × 0.1 = 8.442 tCO₂e
        //   公式(10)：PE_y = 25 + 7.4436732 + 8.442 = 40.8856732 tCO₂e
        //   公式(18)：ER_y = 1672.3428 − 40.8856732 = 1,631.4571268 tCO₂e/年
        //   公式(19)：Σ F_NPT,CH4,i,h,drainage = 3000 ≥ F_NPT,CH4,h,import = 2500 → 未出现公式(19) 情形，合规
        //   闭式校核：3.015 × 0.9 × 25.2568 + 1500 + 87.9228 − 25 = 68.5343268 + 1562.9228 = 1,631.4571268 ✔
        //            （28 − 2.7432 = 25.2568 为精确值，闭式与逐式累加完全一致）
        q_heat_gj: 1465.38,
        v_ch4_nm3: 4500,
        mm_measured_t: 3.015,
        mm_derived_t: 312.97635874,
        mm_t: 3.015,
        be_mr_tco2e: 84.42,
        be_elec_tco2e: 1500,
        be_heat_tco2e: 87.9228,
        be_tco2e: 1672.3428,
        cons_grid_mwh: 50,
        pe_me_tco2e: 25,
        pe_md_tco2e: 7.4436732,
        pe_um_tco2e: 8.442,
        pe_tco2e: 40.8856732,
        er_annual_tco2e: 1631.4571268,
        compliance_ok: true,
      },
      tolerance: 0.01,
    },
    {
      name: '样例 D：仅发电且实测气量远大于发电量推算值（公式3→16→2 取推算值），小时常温常压流量 100000 m³/h、浓度 4%、运行 8000 h、外供电量 3000 MW·h',
      inputs: {
        mine_type: '井工煤矿', mine_abandoned_or_closed: false,
        oxidation_technology: '无焰氧化', heat_utilization_route: '发电',
        diluted_from_high_concentration: false,
        ch4_concentration_pct: 4,
        npt_flow_m3h: 100000, hours_per_year: 8000,
        elec_export_mwh: 3000, heat_export_gj: 0,
        ef_grid_om: 0.6, ef_grid_bm: 0.4,
        cons_elec_mwh: 47.5, tdl: 0.05, eta_elec: 0.35,
        destruction_efficiency: 0.9,
        metering_online: true,
        networking_trial_completed_date: '2024-01-01',
        reduction_generation_start: '2024-06-01',
        reduction_after_networking: true,
        high_conc_periods_recorded: true,
        drainage_flow_npt_m3h: 5000, mixing_inlet_flow_npt_m3h: 1000, mixing_flow_check_ok: true,
        crediting_years: 10, crediting_start_year: '2025-01-01',
      },
      expect: {
        // 手算过程（本样例演示公式(2)「取较小值」的另一支路：实测值较大时取推算值）：
        //   公式(3)：浓度 4 % → 体积分数 0.04
        //            V_CH4,y = time_y × F_NPT,h × ( PC_CH4,h ÷ 100 ) = 8000 × 100000 × 0.04 = 32,000,000 m³
        //            MM′_y = 32,000,000 × 0.67 ÷ 1000 = 21,440 tCH₄
        //   公式(16)：MM″_y = ( 3000 × 3.6 ) ÷ ( 0.9 × 0.91 × 0.35 × 55.64 )
        //                  = 10800 ÷ 15.949206 = 677.14969635 tCH₄
        //   公式(2)： MM_y = min(21,440 , 677.14969635) = 677.14969635 tCH₄（**推算值较小，取推算值**）
        //            BE_MR,y = 677.14969635 × 28 = 18,960.19149793 tCO₂e
        //   公式(5)：BE_ELEC,y = 3000 × 0.5 = 1,500 ；公式(7)：BE_HEAT,y = 0 × 0.06 = 0
        //   公式(1)：BE_y = 18960.19149793 + 1500 + 0 = 20,460.19149793 tCO₂e
        //   公式(12)：CONS_grid,y = 47.5 ÷ ( 1 − 0.05 ) = 50 MW·h ；公式(11)：PE_ME,y = 50 × 0.5 = 25 tCO₂
        //   公式(13)：PE_MD,y = 677.14969635 × 0.9 × 2.7432 = 609.43472672 × 2.7432 = 1,671.80134234 tCO₂
        //   公式(14)：PE_UM,y = 28 × 677.14969635 × ( 1 − 0.9 ) = 1,896.01914979 tCO₂e
        //   公式(10)：PE_y = 25 + 1671.80134234 + 1896.01914979 = 3,592.82049213 tCO₂e
        //   公式(18)：ER_y = 20460.19149793 − 3592.82049213 = 16,867.3710058 tCO₂e/年
        //   闭式校核：677.14969635 × 0.9 × 25.2568 + 1500 + 0 − 25
        //            = 609.43472672 × 25.2568 + 1475 = 15392.3710058 + 1475 = 16,867.3710058 ✔
        f_npt_h: 100000,
        v_ch4_nm3: 32000000,
        mm_measured_t: 21440,
        mm_derived_t: 677.14969635,
        mm_t: 677.14969635,
        be_mr_tco2e: 18960.19149793,
        ef_grid_cm: 0.5,
        be_elec_tco2e: 1500,
        be_heat_tco2e: 0,
        be_tco2e: 20460.19149793,
        cons_grid_mwh: 50,
        pe_me_tco2e: 25,
        pe_md_tco2e: 1671.80134234,
        pe_um_tco2e: 1896.01914979,
        pe_tco2e: 3592.82049213,
        er_annual_tco2e: 16867.3710058,
      },
      tolerance: 0.01,
    },
    {
      name: '样例 E（应被拒绝）：甲烷体积浓度 9% 不低于 8%，超出 §2 适用条件',
      inputs: {
        mine_type: '井工煤矿', mine_abandoned_or_closed: false,
        oxidation_technology: '无焰氧化', heat_utilization_route: '发电',
        diluted_from_high_concentration: false,
        ch4_concentration_pct: 9,
        raw_flow_m3h: 1000, gas_temp_c: 20, gas_pressure_kpa: 101.325,
        hours_per_year: 8000, elec_export_mwh: 30000,
        ef_grid_om: 0.6, ef_grid_bm: 0.4, eta_elec: 0.35,
        crediting_years: 10, crediting_start_year: '2025-01-01',
      },
      expect: {
        // 校验算术：浓度 9% > 8% → §2 适用条件不满足；同时按 §6.7 b）该时段本应从 time_y 及对应量中扣除。
        // 期望：validate() 返回 kind = 'scope_violation'，不产生任何减排量数值。
      },
      expectRejection: 'scope_violation',
      tolerance: 0.01,
    },
    {
      name: '样例 F（应被拒绝）：§6.7 a）混配管道入口流量 2500 m³/h 大于抽采泵出口流量之和 1000 m³/h',
      inputs: {
        mine_type: '井工煤矿', mine_abandoned_or_closed: false,
        oxidation_technology: '无焰氧化', heat_utilization_route: '发电',
        diluted_from_high_concentration: false,
        ch4_concentration_pct: 1.2,
        raw_flow_m3h: 1000, gas_temp_c: 20, gas_pressure_kpa: 101.325,
        hours_per_year: 8000, elec_export_mwh: 30000,
        ef_grid_om: 0.6, ef_grid_bm: 0.4, eta_elec: 0.35,
        drainage_flow_npt_m3h: 1000, mixing_inlet_flow_npt_m3h: 2500, mixing_flow_check_ok: false,
        crediting_years: 10, crediting_start_year: '2025-01-01',
      },
      expect: {
        // 公式(19)：Σ F_NPT,CH4,i,h,drainage = 1000 < F_NPT,CH4,h,import = 2500 → 出现公式(19) 情形，
        // 视为不符合项目适用条件：应书面报告省级生态环境主管部门，并由其查实后通知注册登记机构撤销项目登记。
        // 期望：validate() 返回 kind = 'scope_violation'，不产生任何减排量数值。
      },
      expectRejection: 'scope_violation',
      tolerance: 0.01,
    },
    {
      name: '样例 G（应被拒绝）：申请计入期 12 年，超过 §5.2.2「最长不超过 10 年」',
      inputs: {
        mine_type: '井工煤矿', mine_abandoned_or_closed: false,
        oxidation_technology: '无焰氧化', heat_utilization_route: '发电',
        diluted_from_high_concentration: false,
        ch4_concentration_pct: 1.2,
        raw_flow_m3h: 1000, gas_temp_c: 20, gas_pressure_kpa: 101.325,
        hours_per_year: 8000, elec_export_mwh: 30000,
        ef_grid_om: 0.6, ef_grid_bm: 0.4, eta_elec: 0.35,
        destruction_efficiency: 0.9,
        metering_online: true,
        networking_trial_completed_date: '2024-01-01',
        reduction_generation_start: '2024-06-01',
        reduction_after_networking: true,
        high_conc_periods_recorded: true,
        drainage_flow_npt_m3h: 5000, mixing_inlet_flow_npt_m3h: 1000, mixing_flow_check_ok: true,
        crediting_years: 12, crediting_start_year: '2025-01-01',
      },
      expect: {
        // 校验算术：12 年 > 10 年（§5.2.2）→ 期望 validate() 返回 kind = 'out_of_range'，
        // 其余输入均合规，本条为唯一阻断项。
      },
      expectRejection: 'out_of_range',
      tolerance: 0.01,
    },
  ],
};

/* ================================= 元数据 ================================ */

export const meta = {
  methodology_id: MID,
  version: MV,
  display_name: 'CCER-10-001-V01 甲烷体积浓度低于8%的煤矿低浓度瓦斯和风排瓦斯利用',
  project_type: '煤矿瓦斯回收利用',
  /** 本次重写的实现依据与未决项（供界面与报告直接引用） */
  implementation_basis:
    '规则卡与计算公式已按官方 PDF《温室气体自愿减排项目方法学 甲烷体积浓度低于 8% 的煤矿低浓度瓦斯和' +
    '风排瓦斯利用（CCER—10—001—V01）》（生态环境部 环办气候函〔2025〕1 号，2025-01-03）' +
    '§2 适用条件、§5 项目边界与计入期（§5.2.2 计入期 ≤ 10 年）、§6 减排量核算方法（公式(1)~(21)，' +
    '§6.1 基准线为全部排空、§6.5 泄漏忽略不计、§6.7 a）/b）适用性与合规性判断）、' +
    '§7 监测方法（表 2—表 33）逐条重写；条款引用均为真实章节号，不再使用【占位】。',
  unresolved_parameters: [
    'CEF_CH4（tCO₂/tCH₄，公式(13)）：官方正文既未列入参数表（表 2—表 33），也无「式中」定义，' +
      '本插件暂以化学计量候选值 44.009/16.043 = 2.7432 代入并标记 placeholder，未经官方确认。',
    'TDL_y（公式(12)）：官方未给出缺省值（来源《电力工业统计资料汇编》），须逐项目逐年填报，' +
      '且公式分母为 (1 − TDL_y)，须以小数代入。',
    'η_ELEC（公式(16)）：官方「式中」只给出 η_FOEF = 91、η_EH = 86、η_BOEF = 88，未给出 η_ELEC 取值，' +
      '须取项目可研或机组实测值。',
  ],
};

export default { meta, rulecard, plugin };
