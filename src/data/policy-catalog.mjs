/**
 * v2 政策库种子数据
 * ============================================================================
 * 【来源纪律】本文件每一条都带官方出处；凡未从官方原文核实的字段一律留空并在
 * `data_gap` 台账中暴露，绝不用推测值填充。
 *
 * 分类沿用《CCER 信息与测算平台：第二版需求规格》1.2 节：
 *   management      管理办法
 *   registration    注册登记规则
 *   validation      审定核查规则
 *   trading         交易结算规则
 *   design_guide    项目设计实施指南
 *   factor_doc      监测 / 排放因子文件
 *   ministry_policy 相关部委政策
 *   consultation    征求意见文件
 */

export const POLICY_CATEGORIES = [
  { key: 'management', label: '管理办法' },
  { key: 'registration', label: '注册登记规则' },
  { key: 'validation', label: '审定核查规则' },
  { key: 'trading', label: '交易结算规则' },
  { key: 'design_guide', label: '项目设计实施指南' },
  { key: 'factor_doc', label: '监测与排放因子文件' },
  { key: 'ministry_policy', label: '相关部委政策' },
  { key: 'consultation', label: '征求意见文件' },
];

export const POLICY_CATEGORY_LABELS = Object.fromEntries(POLICY_CATEGORIES.map((c) => [c.key, c.label]));

export const POLICY_DOC_STATUS_LABELS = {
  effective: '现行有效',
  superseded: '已被替代',
  repealed: '已废止',
  draft_consultation: '征求意见中',
  notice: '公告 / 通知',
};

/**
 * 政策库种子。
 * evidence: 'official_original' 表示已核对官方原文页面；'official_notice' 表示依据官方发布通知。
 * parse_quality: 附件解析质量，not_attempted 表示尚未归档原件（真实缺口，已在 data_gap 台账登记）。
 */
export const POLICY_DOCUMENTS = [
  {
    policy_key: 'pol-measures-2023',
    title: '温室气体自愿减排交易管理办法（试行）',
    doc_number: '生态环境部、市场监管总局令 第31号',
    issuing_authority: '生态环境部、国家市场监督管理总局',
    category: 'management',
    doc_status: 'effective',
    publish_date: '2023-10-19',
    effective_date: '2023-10-19',
    summary:
      '自愿减排交易市场的基础性管理制度。规定项目业主、审定与核查机构、注册登记机构、交易机构的活动规则，' +
      '以及项目公示、审定、登记、减排量核查与登记、交易、注销的完整流程与各方责任。',
    official_url: 'https://www.mee.gov.cn/gzk/gz/202310/t20231020_1043695.shtml',
    source_key: 'src-measures',
    parse_quality: 'good',
    confirmed: true,
  },
  {
    policy_key: 'pol-reg-rules-2023',
    title: '温室气体自愿减排注册登记规则（试行）',
    doc_number: null,
    issuing_authority: '国家应对气候变化战略研究和国际合作中心',
    category: 'registration',
    doc_status: 'effective',
    publish_date: '2023-11-16',
    effective_date: '2023-11-16',
    summary:
      '规定注册登记系统的账户管理、项目登记、减排量登记、变更与注销等业务的操作要求与材料要求。',
    official_url: 'https://ccer.cets.org.cn/notice/noticeDetail?bulletinInfoId=1174755335156666368',
    source_key: 'src-reg-rules',
    parse_quality: 'good',
    confirmed: true,
  },
  {
    policy_key: 'pol-design-guide-2023',
    title: '温室气体自愿减排项目设计与实施指南',
    doc_number: null,
    issuing_authority: '国家应对气候变化战略研究和国际合作中心',
    category: 'design_guide',
    doc_status: 'effective',
    publish_date: '2023-11-16',
    effective_date: '2023-11-16',
    summary:
      '规定项目设计文件（PDD）的编制要求、项目边界与基准线论证、监测计划、数据质量管理与减排量计算的一般要求。',
    official_url: 'https://ccer.cets.org.cn/notice/noticeDetail?bulletinInfoId=1174755335156666368',
    source_key: 'src-reg-rules',
    parse_quality: 'good',
    confirmed: true,
  },
  {
    policy_key: 'pol-notice-202310-first4',
    title: '关于印发《温室气体自愿减排项目方法学 造林碳汇（CCER-14-001-V01）》等4项方法学的通知',
    doc_number: '环办气候函〔2023〕343号',
    issuing_authority: '生态环境部办公厅',
    category: 'ministry_policy',
    doc_status: 'effective',
    publish_date: '2023-10-24',
    effective_date: '2023-10-24',
    summary:
      '首批发布的 4 项方法学：造林碳汇（CCER-14-001-V01）、并网光热发电（CCER-01-001-V01）、' +
      '并网海上风力发电（CCER-01-002-V01）、红树林营造（CCER-14-002-V01）。' +
      '本通知正文逐项给出编号与名称，是编号—名称对应关系的权威来源。',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202310/t20231024_1043877.html',
    source_key: 'src-notice-202310',
    parse_quality: 'good',
    confirmed: true,
  },
  {
    policy_key: 'pol-notice-202501-10001',
    title:
      '关于发布《温室气体自愿减排项目方法学 甲烷体积浓度低于8%的煤矿低浓度瓦斯和风排瓦斯利用（CCER—10—001—V01）》的通知',
    doc_number: '环办气候函〔2025〕1号',
    issuing_authority: '生态环境部办公厅',
    category: 'ministry_policy',
    doc_status: 'effective',
    publish_date: '2025-01-03',
    effective_date: '2025-01-03',
    summary:
      '发布煤矿低浓度瓦斯和风排瓦斯利用方法学。适用井工煤矿（不含废弃或关闭矿井）的甲烷体积浓度低于 8% 的' +
      '低浓度瓦斯与风排瓦斯，销毁技术暂仅限于无焰氧化，利用方式为发电、供热或热电联产。',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099965.html',
    source_key: 'src-notice-202501',
    parse_quality: 'good',
    confirmed: true,
  },
  {
    policy_key: 'pol-notice-202501-07001',
    title: '关于发布《温室气体自愿减排项目方法学 公路隧道照明系统节能（CCER-07-001-V01）》的通知',
    doc_number: '环办气候函〔2024〕486号',
    issuing_authority: '生态环境部办公厅、交通运输部办公厅',
    category: 'ministry_policy',
    doc_status: 'effective',
    publish_date: '2025-01-03',
    // 落款（印发）日期 2024-12-30；通知正文「自印发之日起施行」。
    // publish_date 为官网生成（发布）日期。见 docs/28 的更正记录。
    effective_date: '2024-12-30',
    summary: '发布公路隧道照明系统节能方法学，适用于公路隧道照明系统的节能改造与新建项目。',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099966.html',
    source_key: 'src-notice-202501b',
    parse_quality: 'not_attempted',
    confirmed: true,
  },
  {
    policy_key: 'pol-notice-202511-og',
    title: '关于发布《温室气体自愿减排项目方法学 海上油田伴生气回收利用（CCER-10-002-V01）》等3项方法学的通知',
    doc_number: '环办气候函〔2025〕428号',
    issuing_authority: '生态环境部办公厅',
    category: 'ministry_policy',
    doc_status: 'effective',
    publish_date: '2025-11-21',
    effective_date: '2025-11-18',
    summary:
      '发布海上油田伴生气回收利用（CCER-10-002-V01）、陆上气田试气放喷气回收利用（CCER-10-003-V01）、' +
      '陆上油田低气量伴生气回收利用（CCER-10-004-V01）三项方法学。',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
    source_key: 'src-notice-202511',
    parse_quality: 'not_attempted',
    confirmed: true,
  },
  {
    policy_key: 'pol-notice-202512-yudiba',
    title: '关于发布《温室气体自愿减排项目方法学 淤地坝碳汇（CCER-14-005-V01）》的通知',
    doc_number: '环办气候函〔2025〕438号',
    issuing_authority: '生态环境部办公厅、水利部办公厅',
    category: 'ministry_policy',
    doc_status: 'effective',
    publish_date: '2025-12-02',
    effective_date: '2025-11-25',
    summary:
      '发布淤地坝碳汇方法学（CCER-14-005-V01）。通知正文说明：指导项目业主按《管理办法》' +
      '对项目唯一性及材料真实性、完整性、有效性作出承诺；县级水行政主管部门淤地坝管理台账' +
      '可依申请公开，供项目开发、审定与核查使用。通知自印发之日起施行。',
    // 2026-09-30：官方 URL 已从生态环境部官网核实（页面标题、文号、生成日期与正文一致），
    // 不再是「待研究员补录」状态。
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251202_1136958.html',
    source_key: 'src-notice-202512',
    parse_quality: 'good',
    confirmed: true,
    collect_note:
      '官方 URL、文号（环办气候函〔2025〕438号）与落款日期（2025-11-25）已从生态环境部官网原文核实；' +
      '生成日期 2025-12-02。原件 PDF（W020251202539685833521.pdf）已归档并提取文本。',
  },
  {
    policy_key: 'pol-faq-202601-methodologies',
    title: '生态环境部应对气候变化司有关负责同志就 2025 年发布的温室气体自愿减排项目方法学答记者问',
    doc_number: null,
    issuing_authority: '生态环境部',
    category: 'ministry_policy',
    doc_status: 'notice',
    publish_date: '2026-01-08',
    effective_date: null,
    summary:
      '就 2025 年发布的多项方法学的领域划分与适用对象作出说明。' +
      '本系统的处理原则：答记者问只作为线索与领域口径参考，**不用于推导方法学编号**。',
    official_url: 'https://www.mee.gov.cn/ywdt/zbft/202601/t20260108_1140251.shtml',
    source_key: 'src-faq-202601',
    parse_quality: 'good',
    confirmed: true,
  },
];

/**
 * 明确登记的「真实缺口」：数据源无法稳定自动获取，或原件尚未归档。
 * 这些条目会写入 data_gap 表并在界面上如实展示。
 * 【二轮整改 docs/22 第 16 条】处理路径一律写成**自动处理方式**（auto_action），
 * 不再要求人工核对/人工补录；历史人工路径仅作为 legacy_manual_path 留痕。
 */
export const DATA_GAPS = [
  {
    gap_key: 'gap-registry-project-list',
    dataset: '项目库',
    title: '注册登记系统公开项目接口改版与覆盖核对',
    description:
      '已核实公开页面使用站内项目列表与详情接口，系统按日低频同步。接口并非面向第三方承诺的稳定 API，' +
      '须持续监控分页总数、解析异常和字段变化；系统已收录数不自动等于全国总数。',
    impact:
      '公开项目库的「官方全量」属性无法保证；总量指标只能标注为「系统已收录、已排除演示条目」而非「全国总数」。',
    severity: 'normal',
    auto_action:
      '每日自动同步并监控分页总数与解析异常；发现字段变化时记录差异并自动重试，必要时用「公开项目导入模板」补充。',
    import_template: 'public-project',
  },
  {
    gap_key: 'gap-trade-daily',
    dataset: '交易行情',
    title: '全国温室气体自愿减排交易系统每日行情依赖公告页自动采集',
    description:
      '交易系统的「每日行情」与「交易数据查询」页面为前端渲染，未提供面向第三方的公开数据接口。' +
      '系统按官方公告口径自动采集，**不得以旧数据伪装当日行情**。' +
      '【2026-09-30 复核】官方行情公告清单共 384 个交易日（2024-01-22 ~ 2026-09-29）均已入库；' +
      '其中 2025-03-20 的官方公告正文页返回 404（历史链接失效），已改用**同一官网栏目的官方分行业行情 JSON 小计行**' +
      '（成交量 2130 吨、成交额 218408.40 元，官方披露值，非插值）补齐，均价官方未披露故留空；' +
      '该日现与 2025-03-19 → 2025-03-21 的官方累计差分（2630 吨 / 261157.40 元）完全一致。',
    impact:
      '交易信息模块在未采集到的日期显示「数据暂缺」，不显示 0 元价格；市场走势图按实际采集范围绘制。',
    severity: 'critical',
    auto_action:
      '每日自动抓取官方每日行情公告并入库（失败自动重试）；公告正文页不可用时回退到官方分行业行情小计行；' +
      '两条路径都不可用时如实显示「数据暂缺」，不用 0 或旧数据填充。',
    import_template: 'trade-daily',
  },
  {
    gap_key: 'gap-methodology-pdf-og',
    dataset: '方法学原文',
    title: 'CCER-10-002 / -003 / -004 三项方法学 PDF 原文尚未归档',
    description:
      '三项方法学已于 2025-11-18 印发（环办气候函〔2025〕428号）。' +
      '【2026-09-30 复核】三份官方 PDF 已从生态环境部官网下载归档并提取文本（SHA-256 与本地路径已入库），' +
      '本缺口据此结清；归档不等于完成规则卡与公式的逐条对照。',
    impact:
      '这三项方法学的规则卡与计算插件**只能检索与阅读，不可用于业务测算**；界面显示「暂不支持自动测算（待原文对照）」。',
    severity: 'high',
    status: 'closed',
    auto_action:
      '由自动采集任务从生态环境部官网抓取 PDF 原文并归档 SHA-256；未归档前只可检索，不参与测算。',
    import_template: 'methodology-pdf',
  },
  {
    gap_key: 'gap-catalog-8-pending',
    dataset: '方法学目录',
    title: '8 项方法学仅有名称口径、编号待逐条核实',
    description:
      '【2026-09-30 复核】原 8 项「仅答记者问口径」的方法学编号已**全部**从各自发布通知正文逐字核实：' +
      '环办气候函〔2025〕451号（CCER-14-003 / -004）、〔2025〕473号（CCER-15-001 / -002）、' +
      '〔2025〕485号（CCER-06-001）、〔2025〕491号（CCER-01-004 / CCER-11-001）、〔2025〕493号（CCER-01-003）。' +
      '本缺口据此结清。仍未核实项：注册登记系统方法学目录页为前端渲染、站内列表接口返回 401，' +
      '官方目录当前条目数**无法机器读取 → 自动核验受阻、未核实**；系统不推测条目数或编号，' +
      '该事项为自动运行状态（无人工待办），保留在 structure_changed 告警中由每日任务自动重试。',
    impact:
      '8 项编号已全部核实并录入，可进入「可申报候选」与测算；仍未核实的是注册登记系统官方目录页的整体条目数，' +
      '平台不以推测值充当官方目录，总量口径只标注「系统已收录」。',
    severity: 'high',
    status: 'closed',
    auto_action: '从官方发布通知自动逐条比对编号—名称对应关系；未核实前编号留空、不推测；官方目录页无法自动读取时如实标注「自动核验受阻、未核实」并自动重试。',
    import_template: null,
  },
  {
    gap_key: 'gap-policy-original-archive',
    dataset: '政策原文',
    title: '部分政策原件（PDF）尚未归档与页码提取',
    description:
      '部分政策条目只登记了官方页面 URL，尚未下载原件、计算哈希并提取页码级文本。' +
      '【2026-09-30 复核】全部现行政策的官方原件已下载落盘并记录 SHA-256；' +
      '其中注册登记系统的公告详情页为前端渲染（服务端只返回页面外壳），正文抽取不完整。' +
      '本缺口的 title/description/impact/auto_action 由 syncPolicyArchiveGap() 与展示层按实时归档状态同源推导' +
      '（原件已归档 ≠ 正文可引用；基线文案仅作初始值，实际展示以实时状态为准）。',
    impact: '政策条款无法按页码引用；规则卡的 clause_ref 只能引用到文件与章节层级。',
    severity: 'normal',
    auto_action: '随每日巡检自动抓取原件并计算哈希；未归档时条款只引用到文件与章节层级，不声称已读原文。',
    import_template: 'policy-pdf',
  },
  {
    gap_key: 'gap-llm-default-off',
    dataset: 'AI 辅助',
    title: '大模型接口默认关闭，未配置供应商时全部 AI 功能不可用',
    description:
      '按需求规格 1.6，LLM 必须由机构显式配置并逐用途开关，凭据只存服务端、不返给浏览器；' +
      '未配置时系统不调用任何外部模型，规则判断与交易数据展示完全不受影响。',
    impact: '政策摘要、方法学结构候选抽取、项目字段抽取、问答与报告草稿四项 AI 能力在未配置时不可用。',
    severity: 'normal',
    auto_action:
      '管理员在「后台管理 → 模型配置」填写 Base URL、模型名与凭据引用名并勾选「公开内容自动核验」；' +
      '未配置期间相关内容标记「暂未自动核验」，配置完成后每日任务自动重试，公开原始信息照常浏览。',
    import_template: null,
  },
];
