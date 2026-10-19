/**
 * 项目事实字段表（Fact Field Dictionary）
 * ============================================================================
 * 这是设计文档第 11 节要求「先提交供确认」的两份清单之一（另一份为方法学清单）。
 *
 * 约定：
 *   applies_to     —— 该字段对哪些 methodology_id 适用；[] 表示全部方法学通用
 *   required_for   —— 该字段是哪些 methodology_id 的必需字段；[] 表示通用必需
 *   evidence_policy—— strict 表示必须附官方文件或项目资料证据，仅凭业主自述不得判「通过」
 *
 * 字段 key 语义前缀：
 *   proj.*  项目本体
 *   time.*  时间与计入期
 *   comp.*  合规与义务
 *   own.*   权属与环境权益
 *   gas.*   煤矿瓦斯类项目专属
 *   og.*    油气田类项目专属
 *   mon.*   监测与数据质量
 *   com.*   成本与商业
 */

export const FACT_FIELDS = [
  /* ------------------------------ 项目本体 ------------------------------ */
  { key: 'proj.name', label: '项目名称', group_name: '项目本体', value_type: 'text', required_for: [], description: '与项目建议书 / 批复文件一致的全称' },
  { key: 'proj.owner', label: '项目业主', group_name: '项目本体', value_type: 'text', required_for: [], description: '项目业主单位全称' },
  { key: 'proj.province', label: '省份', group_name: '项目本体', value_type: 'text', required_for: [] },
  { key: 'proj.city', label: '地市', group_name: '项目本体', value_type: 'text', required_for: [] },
  {
    key: 'proj.project_type', label: '项目类型', group_name: '项目本体', value_type: 'enum', required_for: [],
    enum_values: [
      '并网光热发电', '并网海上风力发电', '红树林营造', '造林碳汇',
      '煤矿瓦斯回收利用', '海上油田伴生气回收利用', '陆上气田试气放喷气回收利用', '陆上油田低气量伴生气回收利用',
      '滨海盐沼植被修复', '海草床植被修复', '淤地坝碳汇', '规模化猪场粪污沼气回收利用',
      '农业废弃物集中处理', '可再生能源电解水制氢', '中深层地热能井下换热供暖',
      '既有公共建筑能效提升', '电气设备六氟化硫回收和净化', '其他',
    ],
    description: '用于候选方法学召回的第一层索引',
  },
  { key: 'proj.technology_route', label: '技术路线', group_name: '项目本体', value_type: 'text', required_for: [], description: '如“低浓度瓦斯发电”“LNG”等，用于专属条件匹配' },
  { key: 'proj.boundary_desc', label: '项目边界描述', group_name: '项目本体', value_type: 'text', required_for: [] },
  { key: 'proj.stage', label: '项目阶段', group_name: '项目本体', value_type: 'enum', enum_values: ['立项', '可研', '建设', '试运行', '运营'], required_for: [] },
  { key: 'proj.location_offshore_km', label: '离岸距离（km）', group_name: '项目本体', value_type: 'number', unit: 'km', applies_to: ['CCER-01-002'], required_for: [] },
  { key: 'proj.water_depth_m', label: '水深（m）', group_name: '项目本体', value_type: 'number', unit: 'm', applies_to: ['CCER-01-002'], required_for: [] },

  /* ---------------------------- 时间与计入期 ---------------------------- */
  {
    key: 'time.start_construction_date', label: '项目开工日期', group_name: '时间与计入期', value_type: 'date',
    required_for: ['__COMMON__'], evidence_policy: 'strict',
    description: '《管理办法》通用门槛：须不早于 2012-11-08。必须有开工证明（开工报告 / 监理记录 / 批复）。',
  },
  { key: 'time.operation_date', label: '投运日期', group_name: '时间与计入期', value_type: 'date', evidence_policy: 'strict', required_for: [] },
  { key: 'time.reduction_generation_start', label: '减排量产生起始时间', group_name: '时间与计入期', value_type: 'date', required_for: ['__COMMON__'], evidence_policy: 'strict', description: '通用门槛：须不早于 2020-09-22。' },
  { key: 'time.crediting_start', label: '计入期开始日期', group_name: '时间与计入期', value_type: 'date', evidence_policy: 'strict', required_for: [] },
  { key: 'time.crediting_period_years', label: '申请计入期长度（年）', group_name: '时间与计入期', value_type: 'number', unit: '年', required_for: [] },
  { key: 'time.first_registration_apply_date', label: '首次申请登记日期', group_name: '时间与计入期', value_type: 'date', required_for: [] },

  /* ---------------------------- 合规与义务 ---------------------------- */
  {
    key: 'comp.legal_ghg_obligation', label: '是否承担法定温室气体减排义务', group_name: '合规与义务',
    value_type: 'bool', required_for: ['__COMMON__'], evidence_policy: 'strict',
    description: '为真则不符合通用门槛。必须由官方文件或项目资料判定，不得凭业主自述。',
  },
  {
    key: 'comp.in_ets_quota', label: '是否纳入全国或地方碳排放权交易市场配额管理', group_name: '合规与义务',
    value_type: 'bool', required_for: ['__COMMON__'], evidence_policy: 'strict',
    description: '为真则不符合通用门槛。',
  },
  { key: 'comp.ets_scope_note', label: '配额管理核查说明', group_name: '合规与义务', value_type: 'text' },
  { key: 'comp.owner_commitment', label: '业主真实性与完整性承诺', group_name: '合规与义务', value_type: 'bool', required_for: ['__COMMON__'], description: '《管理办法》要求的项目业主承诺书。' },
  { key: 'comp.uniqueness_declared', label: '项目唯一性声明', group_name: '合规与义务', value_type: 'bool', required_for: ['__COMMON__'], evidence_policy: 'strict' },
  { key: 'comp.additionality_route', label: '额外性论证路径', group_name: '合规与义务', value_type: 'enum', enum_values: ['免予论证', '简化论证', '需完整论证', '待定'], required_for: [] },
  { key: 'comp.additionality_evidence_note', label: '额外性论证说明', group_name: '合规与义务', value_type: 'text' },

  /* -------------------------- 权属与环境权益 -------------------------- */
  { key: 'own.reduction_ownership_clear', label: '减排量权属清晰', group_name: '权属与环境权益', value_type: 'bool', required_for: [], description: '减排量归项目业主所有且无争议' },
  { key: 'own.ownership_doc_note', label: '权属证明文件说明', group_name: '权属与环境权益', value_type: 'text' },
  { key: 'own.other_mechanism_claim', label: '是否已在其他自愿减排机制申报或声明', group_name: '权属与环境权益', value_type: 'enum', enum_values: ['无', '是', '待核实'], required_for: [] },
  { key: 'own.renewable_certificate_claim', label: '是否存在绿证 / 绿电环境权益声明', group_name: '权属与环境权益', value_type: 'enum', enum_values: ['无', '是', '待核实'], required_for: [] },
  { key: 'own.subsidy_or_contract_claim', label: '是否存在补贴或合同已处分环境权益', group_name: '权属与环境权益', value_type: 'enum', enum_values: ['无', '是', '待核实'], required_for: [] },
  { key: 'own.ccus_boundary_note', label: '环境权益处分情况说明', group_name: '权属与环境权益', value_type: 'text' },

  /* ------------------------- 煤矿瓦斯类专属 ------------------------- */
  {
    key: 'gas.mine_type', label: '矿井类型', group_name: '煤矿瓦斯项目', value_type: 'enum',
    enum_values: ['井工煤矿', '露天煤矿'], applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'],
  },
  {
    key: 'gas.gas_category', label: '瓦斯来源类别', group_name: '煤矿瓦斯项目', value_type: 'enum',
    enum_values: ['风排瓦斯', '抽采低浓度瓦斯', '风排瓦斯+抽采低浓度瓦斯'],
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'],
  },
  {
    key: 'gas.ch4_concentration_pct', label: '甲烷体积浓度', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '%',
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'], evidence_policy: 'strict',
    description: '方法学适用上限为低于 8%，须有监测报告或检测记录证据。',
  },
  {
    key: 'gas.recovery_volume_nm3', label: '年回收瓦斯量（标态）', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'Nm³/年',
    applies_to: ['CCER-10-001'], required_for: [],
  },
  {
    key: 'gas.hours_per_year', label: '年运行小时数', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'h/年',
    applies_to: ['CCER-10-001'], required_for: [],
  },
  {
    key: 'gas.utilization_route', label: '瓦斯利用方式', group_name: '煤矿瓦斯项目', value_type: 'enum',
    enum_values: ['瓦斯发电', '瓦斯提纯', '瓦斯氧化', '民用/工业燃气', '其他'],
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'],
  },
  {
    key: 'gas.baseline_scenario', label: '基准线情景', group_name: '煤矿瓦斯项目', value_type: 'enum',
    enum_values: ['瓦斯排空', '瓦斯火炬燃烧', '部分利用', '按方法学规定确定'],
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'],
  },
  {
    key: 'gas.destruction_efficiency', label: '甲烷销毁 / 氧化效率', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '无量纲(0-1)',
    applies_to: ['CCER-10-001'], required_for: [], description: '优先采用方法学规定的缺省值，实测值须有检测报告。',
  },

  /* ---- CCER-10-001 §2 适用条件（无焰氧化 + 井工煤矿 + 热能利用 + 联网） ---- */
  {
    key: 'gas.mine_abandoned_or_closed', label: '是否属于废弃或关闭的井工煤矿', group_name: '煤矿瓦斯项目', value_type: 'bool',
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'], evidence_policy: 'strict',
    description: 'CCER-10-001 §2 第 1 段：仅适用于井工煤矿，且不包括废弃或关闭的井工煤矿；判错将直接改变适用性结论。须有采矿许可证、关闭（废弃）公告等证据。',
  },
  {
    key: 'gas.oxidation_technology', label: '分解销毁技术', group_name: '煤矿瓦斯项目', value_type: 'enum',
    enum_values: ['无焰氧化', '其他分解销毁技术'],
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'], evidence_policy: 'strict',
    description: 'CCER-10-001 §2 第 3 段：分解销毁技术暂仅限于无焰氧化技术；其他技术（催化氧化、蓄热燃烧等）暂不适用。',
  },
  {
    key: 'gas.heat_utilization_route', label: '热能利用方式', group_name: '煤矿瓦斯项目', value_type: 'enum',
    enum_values: ['发电', '供热', '热电联产', '其他'],
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'], evidence_policy: 'strict',
    description: 'CCER-10-001 §2 a）/b）：利用方式包括发电、供热或热电联产；该字段决定推算甲烷量按公式(15)、(16) 还是 (17) 计算。',
  },
  {
    key: 'gas.diluted_from_high_concentration', label: '是否人为稀释浓度≥8% 的煤矿瓦斯后利用', group_name: '煤矿瓦斯项目', value_type: 'bool',
    applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'], evidence_policy: 'strict',
    description: 'CCER-10-001 §2 第 4 段：人为将甲烷体积浓度大于或等于 8% 的煤矿瓦斯稀释后得到的低浓度瓦斯不适用。',
  },

  /* ---- CCER-10-001 §6.3 公式(3)(4)：进入无焰氧化装置的流量与温压 ---- */
  {
    key: 'gas.npt_flow_m3h', label: '混合气体常温常压流量（小时值）F_NPT,h', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'm³/h',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §7.2 表 7：进入无焰氧化装置的混合气体常温常压（20 ℃、1 个标准大气压）流量，计量仪表安装在配气系统应急排放之后、无焰氧化装置前端。',
  },
  {
    key: 'gas.raw_flow_m3h', label: '混合气体工况流量（小时值）F_CH4,h', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'm³/h',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.3 公式(4)：无法直接监测常温常压流量时，由工况流量与温度、压力换算得到 F_NPT,h。',
  },
  {
    key: 'gas.gas_temp_c', label: '进入装置的气体温度 t_CH4,h', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '℃',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.3 公式(4) 所需参数。',
  },
  {
    key: 'gas.gas_pressure_kpa', label: '进入装置的气体绝对压力 P_CH4,h', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'kPa',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.3 公式(4) 所需参数；注意与甲烷体积浓度 PC_CH4,h 的符号区别（该式中 P_CH4,h 指绝对压力）。',
  },

  /* ---- CCER-10-001 §6.3 公式(5)(7)(8)(9)：外供电量与外供热量 ---- */
  {
    key: 'gas.elec_export_mwh', label: '年外供电量 ELEC_export,y', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'MW·h/年',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.3 公式(5)：按 §6.7 b）应扣除甲烷体积浓度不低于 8% 的时段内产生的外供电量。',
  },
  {
    key: 'gas.heat_export_gj', label: '年外供热量 Q_HEAT,y', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'GJ/年',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.3 公式(7)：可直接监测；按 §6.7 b）应扣除浓度不低于 8% 的时段内产生的直接与间接供热量。',
  },
  {
    key: 'gas.steam_mass_t', label: '外供蒸汽质量 Ma_st', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 't/年',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.3 公式(8)：无法直接监测供热量时，按蒸汽质量与焓值换算。',
  },
  {
    key: 'gas.steam_enthalpy_kjkg', label: '蒸汽焓值 En_st', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'kJ/kg',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.3 公式(8)：按附件 B 对应温度、压力查焓值，未列明状态按邻近值线性内插。',
  },
  {
    key: 'gas.hot_water_mass_t', label: '外供热水质量 Ma_w', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 't/年',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.3 公式(9)：无法直接监测供热量时，按热水质量与温度换算。',
  },
  {
    key: 'gas.hot_water_temp_c', label: '热水温度 t_w', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '℃',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.3 公式(9) 所需参数（20 ℃ 为焓值基准温度）。',
  },

  /* ---- CCER-10-001 §6.4 公式(6)(11)(12)(16)：电网因子、项目用电与效率 ---- */
  {
    key: 'gas.grid_ef_om', label: '区域电网电量边际排放因子 EF_grid,OM,y', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'tCO₂/MW·h',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.4 公式(6)：按项目所在区域电网的官方年度数值填报。',
  },
  {
    key: 'gas.grid_ef_bm', label: '区域电网容量边际排放因子 EF_grid,BM,y', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'tCO₂/MW·h',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.4 公式(6)：按项目所在区域电网的官方年度数值填报。',
  },
  {
    key: 'gas.cons_elec_mwh', label: '项目运维电力消耗量 CONS_ELEC,y', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'MW·h/年',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.4 公式(11)(12)：电能表监测的项目消耗电量，须经输配电损失率换算为电网侧电量。',
  },
  {
    key: 'gas.tdl', label: '项目所在省电网输配电损失率 TDL_y', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '无量纲(0-1)',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.4 公式(12)：官方未给缺省值（来源《电力工业统计资料汇编》）；公式分母为 (1 − TDL_y)，须以小数填报（5% 填 0.05）。',
  },
  {
    key: 'gas.elec_efficiency', label: '发电效率 η_ELEC', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '无量纲(0-1)',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.4 公式(16)：官方未给出缺省值，须取可研设计值或机组实测值（百分数换算为小数）。',
  },

  /* ---- CCER-10-001 §6.7 a）合规性判断（公式19~21）：抽采泵出口与混配入口 ---- */
  {
    key: 'gas.drainage_flow_npt_m3h', label: '抽采泵出口端抽采瓦斯常温常压流量之和 Σ F_NPT,CH4,i,h,drainage', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'm³/h',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.7 a）公式(19)：为项目提供气源的所有地面瓦斯抽采泵出口端流量之和，须与混配管道入口流量逐时比较。',
  },
  {
    key: 'gas.mixing_inlet_flow_npt_m3h', label: '混配管道入口处低浓度瓦斯常温常压流量 F_NPT,CH4,h,import', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'm³/h',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.7 a）公式(19)：大于抽采泵出口流量之和时视为不符合适用条件，须报告省级生态环境主管部门并撤销项目登记。',
  },
  {
    key: 'gas.mixing_flow_check_ok', label: '§6.7 a）混配入口流量是否不大于抽采泵出口流量之和', group_name: '煤矿瓦斯项目', value_type: 'bool',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: '规则引擎不支持字段间数值比较，本字段承载公式(19) 的判断结论；底层须有抽采泵出口端与混配入口端的流量监测记录作为证据。',
  },
  {
    key: 'gas.drainage_raw_flow_m3h', label: '抽采泵出口端抽采瓦斯工况流量 F_CH4,i,h,drainage', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'm³/h',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.7 a）公式(20)：无法直接监测常温常压流量时用于换算。',
  },
  {
    key: 'gas.drainage_temp_c', label: '抽采泵出口端抽采瓦斯温度', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '℃',
    applies_to: ['CCER-10-001'], required_for: [], description: 'CCER-10-001 §6.7 a）公式(20) 所需参数。',
  },
  {
    key: 'gas.drainage_pressure_kpa', label: '抽采泵出口端抽采瓦斯绝对压力', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'kPa',
    applies_to: ['CCER-10-001'], required_for: [], description: 'CCER-10-001 §6.7 a）公式(20) 所需参数。',
  },
  {
    key: 'gas.drainage_ch4_pct', label: '抽采泵出口端甲烷体积浓度 PC_CH4,i,h,drainage', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '%',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.7 b）：该点浓度不低于 8% 的时段应从 time_y 及对应甲烷量、外供电量、外供热量中扣除。',
  },
  {
    key: 'gas.mixing_raw_flow_m3h', label: '混配管道入口处低浓度瓦斯工况流量 F_CH4,h,import', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'm³/h',
    applies_to: ['CCER-10-001'], required_for: [],
    description: 'CCER-10-001 §6.7 a）公式(21)：无法直接监测常温常压流量时用于换算。',
  },
  {
    key: 'gas.mixing_temp_c', label: '混配管道入口处低浓度瓦斯温度', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '℃',
    applies_to: ['CCER-10-001'], required_for: [], description: 'CCER-10-001 §6.7 a）公式(21) 所需参数。',
  },
  {
    key: 'gas.mixing_pressure_kpa', label: '混配管道入口处低浓度瓦斯绝对压力', group_name: '煤矿瓦斯项目', value_type: 'number', unit: 'kPa',
    applies_to: ['CCER-10-001'], required_for: [], description: 'CCER-10-001 §6.7 a）公式(21) 所需参数。',
  },
  {
    key: 'gas.mixing_ch4_pct', label: '混配管道入口处甲烷体积浓度 PC_CH4,h,import', group_name: '煤矿瓦斯项目', value_type: 'number', unit: '%',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.7 b）：该点浓度不低于 8% 的时段应从 time_y 及对应甲烷量、外供电量、外供热量中扣除。',
  },
  {
    key: 'gas.high_conc_periods_recorded', label: '是否已记录浓度≥8% 时段并完成相应扣除（§6.7 b）', group_name: '煤矿瓦斯项目', value_type: 'bool',
    applies_to: ['CCER-10-001'], required_for: [], evidence_policy: 'strict',
    description: 'CCER-10-001 §6.7 b）：业主须做好数据记录，该时间段从 time_y 中扣除，对应时段内的甲烷量、外供电量和外供热量从总量中扣除。',
  },

  /* -------------------------- 油气田类专属 -------------------------- */
  {
    key: 'og.source_type', label: '气源类型', group_name: '油气田项目', value_type: 'enum',
    enum_values: ['海上油田伴生气', '陆上气田试气放喷气', '陆上油田伴生气'],
    applies_to: ['CCER-10-002', 'CCER-10-003', 'CCER-10-004'], required_for: ['CCER-10-002', 'CCER-10-003', 'CCER-10-004'],
  },
  {
    key: 'og.station_design_scale_m3d', label: '站场伴生气处理系统设计规模', group_name: '油气田项目', value_type: 'number', unit: 'm³/天',
    applies_to: ['CCER-10-004'], required_for: ['CCER-10-004'], evidence_policy: 'strict',
    description: 'CCER-10-004 硬性适用条件：同一站场设计总规模须小于 3 万立方米/天。',
  },
  {
    key: 'og.product_route', label: '回收气产品去向', group_name: '油气田项目', value_type: 'enum',
    enum_values: ['管输天然气', '液化天然气（LNG）', '压缩天然气（CNG）', '液化石油气（LPG）', '稳定轻烃', '混烃', '火炬放空'],
    applies_to: ['CCER-10-002', 'CCER-10-003', 'CCER-10-004'], required_for: ['CCER-10-002', 'CCER-10-003', 'CCER-10-004'],
  },
  {
    key: 'og.well_type', label: '井型', group_name: '油气田项目', value_type: 'enum',
    enum_values: ['常规天然气井', '页岩气井', '致密气井'],
    applies_to: ['CCER-10-003'], required_for: ['CCER-10-003'],
  },
  {
    key: 'og.recovery_volume_nm3', label: '年回收气量（标态）', group_name: '油气田项目', value_type: 'number', unit: 'Nm³/年',
    applies_to: ['CCER-10-002', 'CCER-10-003', 'CCER-10-004'], required_for: [],
  },
  {
    key: 'og.ch4_fraction', label: '回收气甲烷体积分数', group_name: '油气田项目', value_type: 'number', unit: '无量纲(0-1)',
    applies_to: ['CCER-10-002', 'CCER-10-003', 'CCER-10-004'], required_for: [], evidence_policy: 'strict',
    description: '须有气质分析报告证据。',
  },
  {
    key: 'og.flare_baseline_efficiency', label: '基准线火炬燃烧效率', group_name: '油气田项目', value_type: 'number', unit: '无量纲(0-1)',
    applies_to: ['CCER-10-002', 'CCER-10-003', 'CCER-10-004'], required_for: [],
    description: '基准线为火炬燃烧时使用；为放空时按 0 处理。',
  },
  {
    key: 'og.trial_gas_days', label: '试气放喷天数', group_name: '油气田项目', value_type: 'number', unit: '天',
    applies_to: ['CCER-10-003'], required_for: [],
  },
  {
    key: 'og.daily_recovery_nm3', label: '日均回收放喷气量（标态）', group_name: '油气田项目',
    value_type: 'number', unit: 'Nm³/天', applies_to: ['CCER-10-003'], required_for: [],
    evidence_policy: 'strict', description: '试气放喷期间日均回收气量，须与计量记录或作业台账一致。',
  },

  /* --------------------------- 监测与数据质量 --------------------------- */
  {
    key: 'mon.metering_online', label: '监测数据是否与全国碳市场管理平台联网', group_name: '监测与数据质量',
    value_type: 'bool', evidence_policy: 'strict',
    applies_to: ['CCER-10-001', 'CCER-10-002', 'CCER-10-003', 'CCER-10-004'], required_for: ['CCER-10-001'],
  },
  {
    key: 'mon.networking_trial_completed_date', label: '监测数据联网试运行完成日期', group_name: '监测与数据质量',
    value_type: 'date', applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'], evidence_policy: 'strict',
    description: 'CCER-10-001 §2 第 5 段：减排量产生于项目相关监测数据联网（完成联网试运行）之后；该日期晚于减排量产生起始时间时，期间减排量不符合适用条件。',
  },
  {
    key: 'mon.reduction_after_networking', label: '减排量产生时间是否不早于联网试运行完成日期', group_name: '监测与数据质量',
    value_type: 'bool', applies_to: ['CCER-10-001'], required_for: ['CCER-10-001'], evidence_policy: 'strict',
    description: '规则引擎不支持字段间日期比较，本字段承载 §2 第 5 段时序条件的判断结论；底层须有联网试运行完成证明与减排量产生起始时间的监测记录。',
  },
  { key: 'mon.meter_calibration', label: '计量仪表检定 / 校准安排', group_name: '监测与数据质量', value_type: 'text' },
  { key: 'mon.monitoring_plan_doc', label: '监测计划文件', group_name: '监测与数据质量', value_type: 'text' },
  { key: 'mon.data_archive_note', label: '原始记录归档说明', group_name: '监测与数据质量', value_type: 'text' },
  { key: 'mon.quality_system_note', label: '内部数据质量管理制度', group_name: '监测与数据质量', value_type: 'text' },

  /* ---------------------------- 成本与商业 ---------------------------- */
  { key: 'com.carbon_price_scenario', label: '碳价情景参数（元/tCO₂e）', group_name: '成本与商业', value_type: 'number', unit: '元/tCO₂e', description: '仅作为用户填入的情景参数，不作为确定现金流。' },
  { key: 'com.development_cost_estimate', label: '开发 / 审定 / 核查成本估算（万元）', group_name: '成本与商业', value_type: 'number', unit: '万元' },
  { key: 'com.investment_amount', label: '项目投资额（万元）', group_name: '成本与商业', value_type: 'number', unit: '万元' },
  { key: 'com.expected_irr_note', label: '收益测算说明', group_name: '成本与商业', value_type: 'text' },
];

export const FACT_GROUP_ORDER = [
  '项目本体', '时间与计入期', '合规与义务', '权属与环境权益',
  '煤矿瓦斯项目', '油气田项目', '监测与数据质量', '成本与商业',
];

export const SOURCE_KIND_LABELS = {
  official: '官方文件',
  project_doc: '项目资料',
  owner_claim: '业主自述（不可单独作为判定依据）',
  analyst: '分析师录入',
  assumption: '模型假设（仅用于情景）',
};
