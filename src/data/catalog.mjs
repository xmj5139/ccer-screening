/**
 * 官方来源库 + 方法学目录种子数据
 * ============================================================================
 * 【数据来源纪律】本文件的每一条都标注了其官方出处。凡未能从官方原文核实的字段，
 * 一律写入 catalog_confidence 并在 `catalog_gap` 告警中暴露，绝不用推测值填充。
 *
 * 已从一级来源核实的发布通知：
 *   N1 2023-10-24/31 首批 4 项（造林碳汇、并网光热发电、并网海上风力发电、红树林营造）
 *      https://www.gov.cn/lianbo/bumen/202310/content_6912782.htm
 *   N2 2025-01-03 CCER-10-001-V01
 *      https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099965.html
 *   N3 2025-11-18/21 CCER-10-002-V01 / -003-V01 / -004-V01
 *      https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html
 *   N4 2026-01-08 生态环境部就 2025 年发布的 12 项方法学答记者问（领域与适用对象口径）
 *      https://www.mee.gov.cn/ywdt/zbft/202601/t20260108_1140251.shtml
 *   N5 2025-12-03 环办气候函〔2025〕451号 滨海盐沼植被修复（CCER-14-003-V01）等2项
 *      https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251203_1137023.html
 *   N6 2025-12-17 环办气候函〔2025〕473号 规模化猪场粪污沼气回收利用工程（CCER-15-001-V01）等2项
 *      https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251217_1138026.html
 *   N7 2025-12-23 环办气候函〔2025〕485号 既有公共建筑围护结构与供暖通风空调系统能效提升（CCER-06-001-V01）
 *      https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251223_1138457.html
 *   N8 2025-12-26 环办气候函〔2025〕491号 可再生能源电解水制氢（CCER-01-004-V01）等2项
 *      https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139056.html
 *   N9 2025-12-26 环办气候函〔2025〕493号 中深层地热能井下换热供暖技术应用工程（CCER-01-003-V01）
 *      https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139063.html
 *
 * 【2026-09-30 复核】N5—N9 五份发布通知的正文已逐份抓取核对（scripts/dsh-verify-official-notices.mjs），
 * 原「仅答记者问口径、编号待核实」的 8 项方法学编号—名称对应关系**全部**在通知正文／附件清单中逐字出现，
 * 因此其 catalog_confidence 由 name_only_pending_code 升为 verified_from_official_notice，
 * official_url 由答记者问页面改指向各自的发布通知页面。答记者问仍保留为领域与适用对象的口径来源。
 */

export const OFFICIAL_SOURCES = [
  {
    key: 'src-measures',
    url: 'https://www.mee.gov.cn/gzk/gz/202310/t20231020_1043695.shtml',
    title: '《温室气体自愿减排交易管理办法（试行）》',
    issuing_authority: '生态环境部、市场监管总局',
    doc_number: '生态环境部令 第31号',
    publish_date: '2023-10-19',
    effective_date: '2023-10-19',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '管理制度',
  },
  {
    key: 'src-registry',
    url: 'https://ccer.cets.org.cn/',
    title: '全国温室气体自愿减排注册登记系统及信息平台（方法学目录、项目及减排量公示）',
    issuing_authority: '国家应对气候变化战略研究和国际合作中心',
    doc_number: null,
    publish_date: '2024-01-22',
    effective_date: null,
    tier: 1,
    is_official: 1,
    status: 'notice',
    parse_quality: 'partial',
    parse_note: '目录页为动态渲染，需按固定周期人工核对条目数与编号；系统以官方目录为准。',
    domain: '注册登记',
  },
  {
    key: 'src-reg-rules',
    url: 'https://ccer.cets.org.cn/notice/noticeDetail?bulletinInfoId=1174755335156666368',
    title: '《温室气体自愿减排注册登记规则（试行）》《温室气体自愿减排项目设计与实施指南》',
    issuing_authority: '国家应对气候变化战略研究和国际合作中心',
    doc_number: null,
    publish_date: '2023-11-16',
    effective_date: '2023-11-16',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '注册登记',
  },
  {
    key: 'src-notice-202310',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202310/t20231024_1043877.html',
    title: '关于印发《温室气体自愿减排项目方法学 造林碳汇（CCER-14-001-V01）》等4项方法学的通知',
    issuing_authority: '生态环境部办公厅',
    doc_number: '环办气候函〔2023〕343号',
    publish_date: '2023-10-24',
    effective_date: '2023-10-24',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
    note: '本通知正文逐项给出 4 项方法学的编号与名称，是编号—名称对应关系的唯一权威来源。',
  },
  {
    key: 'src-notice-202501',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099965.html',
    title: '关于发布《温室气体自愿减排项目方法学 甲烷体积浓度低于8%的煤矿低浓度瓦斯和风排瓦斯利用（CCER—10—001—V01）》的通知',
    issuing_authority: '生态环境部办公厅、国家能源局综合司',
    doc_number: '环办气候函〔2025〕1号',
    publish_date: '2025-01-03',
    effective_date: '2025-01-03',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
    note: 'PDF 原文已解析并归档，见 src-notice-202501 的本地副本记录。',
  },
  {
    key: 'src-notice-202501-07001',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099966.html',
    title: '关于发布《温室气体自愿减排项目方法学 公路隧道照明系统节能（CCER—07—001—V01）》的通知',
    issuing_authority: '生态环境部办公厅、交通运输部办公厅',
    doc_number: '环办气候函〔2024〕486号',
    publish_date: '2025-01-03',
    // 落款（印发）日期 2024-12-30（见 docs/28 的更正记录：通知正文「自印发之日起施行」）。
    effective_date: '2024-12-30',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
  },
  {
    key: 'src-notice-202511',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
    title: '关于发布《温室气体自愿减排项目方法学 海上油田伴生气回收利用（CCER—10—002—V01）》等3项方法学的通知',
    issuing_authority: '生态环境部办公厅、国家能源局综合司',
    doc_number: '环办气候函〔2025〕428号',
    publish_date: '2025-11-21',
    // 通知正文「四、本通知自印发之日起施行」，落款（印发）日期 2025-11-18；
    // publish_date 为官网生成（发布）日期。口径与 policy_document 的
    // publish_date=生成日期 / effective_date=印发日期 保持一致。
    effective_date: '2025-11-18',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
  },
  {
    key: 'src-notice-202512',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251202_1136958.html',
    title: '关于发布《温室气体自愿减排项目方法学 淤地坝碳汇（CCER—14—005—V01）》的通知',
    issuing_authority: '生态环境部办公厅、水利部办公厅',
    doc_number: '环办气候函〔2025〕438号',
    publish_date: '2025-12-02',
    // 落款（印发）日期 2025-11-25；官网生成日期 2025-12-02。
    effective_date: '2025-11-25',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
  },
  {
    key: 'src-brief-2026',
    url: 'https://www.mee.gov.cn/ywdt/zbft/202601/t20260108_1140251.shtml',
    title: '生态环境部应对气候变化司相关负责人就 2025 年发布的 12 项温室气体自愿减排项目方法学答记者问',
    issuing_authority: '生态环境部',
    doc_number: null,
    publish_date: '2026-01-08',
    effective_date: null,
    tier: 1,
    is_official: 1,
    status: 'notice',
    parse_quality: 'good',
    domain: '方法学解读',
  },
  {
    key: 'src-notice-202512-451',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251203_1137023.html',
    title: '关于发布《温室气体自愿减排项目方法学 滨海盐沼植被修复（CCER—14—003—V01）》等2项方法学的通知',
    issuing_authority: '生态环境部办公厅、自然资源部办公厅',
    doc_number: '环办气候函〔2025〕451号',
    publish_date: '2025-12-03',
    effective_date: '2025-11-28',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
    note: '正文与附件清单逐项给出编号：滨海盐沼植被修复 CCER-14-003-V01、海草床植被修复 CCER-14-004-V01。',
  },
  {
    key: 'src-notice-202512-473',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251217_1138026.html',
    title: '关于发布《温室气体自愿减排项目方法学 规模化猪场粪污沼气回收利用工程（CCER—15—001—V01）》等2项方法学的通知',
    issuing_authority: '生态环境部办公厅、农业农村部办公厅',
    doc_number: '环办气候函〔2025〕473号',
    publish_date: '2025-12-17',
    effective_date: '2025-12-12',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
    note: '正文与附件清单逐项给出编号：规模化猪场粪污沼气回收利用工程 CCER-15-001-V01、农业废弃物集中处理工程 CCER-15-002-V01。',
  },
  {
    key: 'src-notice-202512-485',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251223_1138457.html',
    title: '关于发布《温室气体自愿减排项目方法学 既有公共建筑围护结构与供暖通风空调系统能效提升（CCER—06—001—V01）》的通知',
    issuing_authority: '生态环境部办公厅、住房城乡建设部办公厅',
    doc_number: '环办气候函〔2025〕485号',
    publish_date: '2025-12-23',
    effective_date: '2025-12-19',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
    note: '正文与附件清单给出编号：既有公共建筑围护结构与供暖通风空调系统能效提升 CCER-06-001-V01。',
  },
  {
    key: 'src-notice-202512-491',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139056.html',
    title: '关于发布《温室气体自愿减排项目方法学 可再生能源电解水制氢（CCER—01—004—V01）》等2项方法学的通知',
    issuing_authority: '生态环境部办公厅、国家能源局综合司',
    doc_number: '环办气候函〔2025〕491号',
    publish_date: '2025-12-26',
    effective_date: '2025-12-23',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
    note: '正文与附件清单逐项给出编号：可再生能源电解水制氢 CCER-01-004-V01、电气设备六氟化硫回收和净化 CCER-11-001-V01。',
  },
  {
    key: 'src-notice-202512-493',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139063.html',
    title: '关于发布《温室气体自愿减排项目方法学 中深层地热能井下换热供暖技术应用工程（CCER—01—003—V01）》的通知',
    issuing_authority: '生态环境部办公厅、住房城乡建设部办公厅、国家能源局综合司',
    doc_number: '环办气候函〔2025〕493号',
    publish_date: '2025-12-26',
    effective_date: '2025-12-25',
    tier: 1,
    is_official: 1,
    status: 'formal',
    parse_quality: 'good',
    domain: '方法学发布',
    note: '正文与附件清单给出编号：中深层地热能井下换热供暖技术应用工程 CCER-01-003-V01。',
  },
  {
    key: 'src-draft-2026',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260626_1160307.html',
    title: '2026 年造林碳汇、红树林营造方法学修订征求意见稿',
    issuing_authority: '生态环境部',
    doc_number: null,
    publish_date: '2026-06-26',
    effective_date: null,
    tier: 1,
    is_official: 1,
    status: 'draft',
    parse_quality: 'good',
    domain: '方法学修订',
    note: '征求意见稿，须保持草案状态，不得自动替换现行正式版本。',
  },
];

/**
 * 方法学目录。
 * document_status: formal 正式发布 | draft 征求意见 | revised_draft 修订征求意见 | repealed 废止
 * catalog_confidence:
 *   verified_from_official_notice  —— 编号与名称均已从发布通知核实
 *   name_only_pending_code         —— 仅从主管部门答记者问获得领域与适用对象口径，编号待核对注册登记系统
 */
export const METHODOLOGY_CATALOG = [
  /* ------------------------- 2023 年首批 4 项 ------------------------- */
  {
    methodology_id: 'CCER-01-001',
    code_display: 'CCER-01-001-V01',
    name: '并网光热发电',
    version: 'V01',
    document_status: 'formal',
    domain: '能源产业',
    project_types: ['并网光热发电'],
    tech_routes: ['塔式光热', '槽式光热', '菲涅尔式光热', '光热+一体化项目的光热部分'],
    scale_note: '适用于独立的并网光热发电项目以及“光热+”一体化项目中的并网光热发电部分。',
    release_date: '2023-10-24',
    effective_date: '2023-10-24',
    source_key: 'src-notice-202310',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202310/t20231024_1043877.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-01-002',
    code_display: 'CCER-01-002-V01',
    name: '并网海上风力发电',
    version: 'V01',
    document_status: 'formal',
    domain: '能源产业',
    project_types: ['并网海上风力发电'],
    tech_routes: ['海上风电'],
    scale_note: '适用于离岸 30 公里以外，或者水深大于 30 米的并网海上风力发电项目。',
    release_date: '2023-10-24',
    effective_date: '2023-10-24',
    source_key: 'src-notice-202310',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202310/t20231024_1043877.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-14-001',
    code_display: 'CCER-14-001-V01',
    name: '造林碳汇',
    version: 'V01',
    document_status: 'formal',
    domain: '林业和其他碳汇',
    project_types: ['造林碳汇'],
    tech_routes: ['乔木造林', '竹子造林', '灌木造林'],
    scale_note: '适用于乔木、竹子和灌木荒地造林。',
    release_date: '2023-10-24',
    effective_date: '2023-10-24',
    source_key: 'src-notice-202310',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202310/t20231024_1043877.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-14-002',
    code_display: 'CCER-14-002-V01',
    name: '红树林营造',
    version: 'V01',
    document_status: 'formal',
    domain: '林业和其他碳汇',
    project_types: ['红树林营造'],
    tech_routes: ['红树林人工种植'],
    scale_note: '适用于在无植被潮滩和退养的养殖塘等适宜红树林生长的区域人工种植红树林项目。',
    release_date: '2023-10-24',
    effective_date: '2023-10-24',
    source_key: 'src-notice-202310',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202310/t20231024_1043877.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },

  /* --------- 2025 年发布的 12 项中，油气田回收利用领域 4 项 --------- */
  {
    methodology_id: 'CCER-10-001',
    code_display: 'CCER-10-001-V01',
    name: '甲烷体积浓度低于8%的煤矿低浓度瓦斯和风排瓦斯利用',
    short_name: '煤矿低浓度瓦斯和风排瓦斯利用',
    version: 'V01',
    document_status: 'formal',
    domain: '燃料逸散性排放',
    project_types: ['煤矿瓦斯回收利用'],
    tech_routes: ['低浓度瓦斯发电', '低浓度瓦斯提纯', '风排瓦斯利用', '瓦斯氧化'],
    scale_note: '适用于甲烷体积浓度低于 8% 的煤矿低浓度瓦斯和风排瓦斯利用项目。',
    crediting_note: '采用免予额外性论证方式，需按要求将监测数据与全国碳市场管理平台联网。',
    release_date: '2025-01-03',
    effective_date: '2025-01-03',
    source_key: 'src-notice-202501',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099965.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
    first_batch_focus: true,
  },
  {
    methodology_id: 'CCER-10-002',
    code_display: 'CCER-10-002-V01',
    name: '海上油田伴生气回收利用',
    version: 'V01',
    document_status: 'formal',
    domain: '燃料逸散性排放',
    project_types: ['海上油田伴生气回收利用'],
    tech_routes: ['管输天然气', '液化天然气（LNG）', '压缩天然气（CNG）', '液化石油气（LPG）'],
    scale_note: '适用于海上油田产生的伴生气，回收后用于生产管输天然气、液化天然气、压缩天然气、液化石油气等产品。',
    crediting_note: '采用免予额外性论证方式，需按要求将监测数据与全国碳市场管理平台联网。',
    release_date: '2025-11-18',
    effective_date: '2025-11-18',
    source_key: 'src-notice-202511',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
    first_batch_focus: true,
  },
  {
    methodology_id: 'CCER-10-003',
    code_display: 'CCER-10-003-V01',
    name: '陆上气田试气放喷气回收利用',
    version: 'V01',
    document_status: 'formal',
    domain: '燃料逸散性排放',
    project_types: ['陆上气田试气放喷气回收利用'],
    tech_routes: ['管输天然气', '压缩天然气（CNG）', '液化天然气（LNG）'],
    scale_note: '适用于常规天然气井、页岩气井和致密气井的试气放喷阶段，回收的试气放喷气处理为管输天然气、压缩天然气、液化天然气等产品。',
    crediting_note: '该细分领域监测与核算体系为开创性构建，无国际先例可循，规则卡须逐条对照原文核对。',
    release_date: '2025-11-18',
    effective_date: '2025-11-18',
    source_key: 'src-notice-202511',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
    first_batch_focus: true,
  },
  {
    methodology_id: 'CCER-10-004',
    code_display: 'CCER-10-004-V01',
    name: '陆上油田低气量伴生气回收利用',
    version: 'V01',
    document_status: 'formal',
    domain: '燃料逸散性排放',
    project_types: ['陆上油田低气量伴生气回收利用'],
    tech_routes: ['管输天然气', '液化天然气（LNG）', '压缩天然气（CNG）', '液化石油气（LPG）', '稳定轻烃', '混烃'],
    scale_note: '适用于陆上油田产生的伴生气，且同一站场内伴生气处理系统设计总规模小于 3 万立方米/天。',
    crediting_note: '免予额外性论证；规模上限为硬性适用条件，须以设计文件证据判定。',
    release_date: '2025-11-18',
    effective_date: '2025-11-18',
    source_key: 'src-notice-202511',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
    first_batch_focus: true,
  },

  /* ---- 2025 年 1 月与 11—12 月发布的其余方法学 ---- */
  {
    methodology_id: 'CCER-07-001',
    code_display: 'CCER-07-001-V01',
    name: '公路隧道照明系统节能',
    version: 'V01',
    document_status: 'formal',
    domain: '交通运输业',
    project_types: ['公路隧道照明系统节能'],
    tech_routes: [],
    scale_note: '适用于公路隧道照明系统节能项目。',
    release_date: '2024-12-30',
    effective_date: '2024-12-30',
    source_key: 'src-notice-202501-07001',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099966.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-14-005',
    code_display: 'CCER-14-005-V01',
    name: '淤地坝碳汇',
    version: 'V01',
    document_status: 'formal',
    domain: '林业和其他碳汇',
    project_types: ['淤地坝碳汇'],
    tech_routes: [],
    scale_note: '适用于按照水利行业淤地坝技术规范建设的淤地坝项目，坝地可种植作物或水土保持林。',
    release_date: '2025-11-25',
    effective_date: '2025-11-25',
    source_key: 'src-notice-202512',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251202_1136958.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },

  /* ---- 2025 年 12 月发布的其余 8 项 ----
   * 【2026-09-30 复核】编号—名称对应关系已从各自发布通知正文/附件清单逐字核实：
   *   环办气候函〔2025〕451号（滨海盐沼植被修复 / 海草床植被修复）
   *   环办气候函〔2025〕473号（规模化猪场粪污沼气回收利用工程 / 农业废弃物集中处理工程）
   *   环办气候函〔2025〕485号（既有公共建筑围护结构与供暖通风空调系统能效提升）
   *   环办气候函〔2025〕491号（可再生能源电解水制氢 / 电气设备六氟化硫回收和净化）
   *   环办气候函〔2025〕493号（中深层地热能井下换热供暖技术应用工程）
   * 因此不再标记为「仅答记者问口径」；official_url 指向发布通知而非答记者问页面。
   * release_date 取通知落款（印发）日期，effective_date 取官网生成（发布）日期。
   * 仍未建立规则卡与计算插件，业务测算依旧被 methodologyGate 阻止。 */
  {
    methodology_id: 'CCER-PENDING-01',
    code_display: 'CCER-14-003-V01',
    name: '滨海盐沼植被修复',
    version: 'V01',
    document_status: 'formal',
    domain: '林业和其他碳汇',
    project_types: ['滨海盐沼植被修复'],
    tech_routes: [],
    scale_note: '适用于在无植被滩涂以及清退废弃、非法海洋工程、海水养殖等人为活动后的滩涂上人工种植盐沼植被项目。',
    release_date: '2025-11-28',
    effective_date: '2025-11-28',
    source_key: 'src-notice-202512-451',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251203_1137023.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-PENDING-02',
    code_display: 'CCER-14-004-V01',
    name: '海草床植被修复',
    version: 'V01',
    document_status: 'formal',
    domain: '林业和其他碳汇',
    project_types: ['海草床植被修复'],
    tech_routes: [],
    scale_note: '适用于在适宜海草生长的潮间带或潮下带区域人工种植海草床植被项目。',
    release_date: '2025-11-28',
    effective_date: '2025-11-28',
    source_key: 'src-notice-202512-451',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251203_1137023.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-PENDING-04',
    code_display: 'CCER-15-001-V01',
    name: '规模化猪场粪污沼气回收利用工程',
    version: 'V01',
    document_status: 'formal',
    domain: '农业废弃物资源化利用',
    project_types: ['规模化猪场粪污沼气回收利用'],
    tech_routes: [],
    scale_note: '适用于使用厌氧消化反应器处理规模化猪场粪污，并对所产生的沼气进行回收利用的项目。',
    release_date: '2025-12-12',
    effective_date: '2025-12-12',
    source_key: 'src-notice-202512-473',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251217_1138026.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-PENDING-05',
    code_display: 'CCER-15-002-V01',
    name: '农业废弃物集中处理工程',
    version: 'V01',
    document_status: 'formal',
    domain: '农业废弃物资源化利用',
    project_types: ['农业废弃物集中处理'],
    tech_routes: [],
    scale_note: '适用于将畜禽粪污、作物秸秆、尾菜等农业废弃物通过厌氧消化反应器处理，并对所产生的沼气进行发电、供应沼气或生产生物天然气等。',
    release_date: '2025-12-12',
    effective_date: '2025-12-12',
    source_key: 'src-notice-202512-473',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251217_1138026.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-PENDING-06',
    code_display: 'CCER-01-004-V01',
    name: '可再生能源电解水制氢',
    version: 'V01',
    document_status: 'formal',
    domain: '新能源利用',
    project_types: ['可再生能源电解水制氢'],
    tech_routes: [],
    scale_note: '适用于自建有风力、光伏发电设施，并利用可再生能源电力驱动电解水反应以制取氢气的项目；从电网获得的电量不计入减排量计算。',
    release_date: '2025-12-23',
    effective_date: '2025-12-23',
    source_key: 'src-notice-202512-491',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139056.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-PENDING-07',
    code_display: 'CCER-01-003-V01',
    name: '中深层地热能井下换热供暖技术应用工程',
    version: 'V01',
    document_status: 'formal',
    domain: '新能源利用',
    project_types: ['中深层地热能井下换热供暖'],
    tech_routes: [],
    scale_note: '适用于利用井下换热技术开发中深层地热能为建筑物进行供暖的项目。',
    release_date: '2025-12-25',
    effective_date: '2025-12-25',
    source_key: 'src-notice-202512-493',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139063.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-PENDING-08',
    code_display: 'CCER-06-001-V01',
    name: '既有公共建筑围护结构与供暖通风空调系统能效提升',
    version: 'V01',
    document_status: 'formal',
    domain: '节能提高能效',
    project_types: ['既有公共建筑能效提升'],
    tech_routes: [],
    scale_note: '适用于对办公、旅馆、商场、文教、医疗、观演、交通、体育、博览等既有公共建筑，开展外墙保温改造、墙内保温改造、加换窗户、幕墙和采光顶更换、冷水机组更换、热泵机组更换、多联式空调机组更换等成本较高的节能改造项目。',
    release_date: '2025-12-19',
    effective_date: '2025-12-19',
    source_key: 'src-notice-202512-485',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251223_1138457.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },
  {
    methodology_id: 'CCER-PENDING-09',
    code_display: 'CCER-11-001-V01',
    name: '电气设备六氟化硫回收和净化',
    version: 'V01',
    document_status: 'formal',
    domain: '六氟化硫减排',
    project_types: ['电气设备六氟化硫回收和净化'],
    tech_routes: [],
    scale_note: '适用于电网、发电、交通运输领域的 66 千伏及以上电压等级电气设备对其退役、检修时排放的六氟化硫气体进行回收净化的项目。',
    release_date: '2025-12-23',
    effective_date: '2025-12-23',
    source_key: 'src-notice-202512-491',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139056.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 1,
  },

  /* ---------------- 2026 年修订征求意见稿（草案状态，不得替换正式版） ---------------- */
  {
    methodology_id: 'CCER-14-001',
    code_display: 'CCER-14-001-V01（修订征求意见稿）',
    name: '造林碳汇（修订征求意见稿）',
    version: 'V01-draft-2026',
    document_status: 'revised_draft',
    domain: '林业和其他碳汇',
    project_types: ['造林碳汇'],
    tech_routes: ['乔木造林', '竹子造林', '灌木造林'],
    scale_note: '本次为现行 CCER-14-001-V01（造林碳汇）的修订征求意见稿，尚未生效。',
    release_date: '2026-06-26',
    effective_date: null,
    source_key: 'src-draft-2026',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260626_1160307.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 0,
    supersedes_code: 'CCER-14-001-V01',
    exclusion_note: '草案状态，仅供观察与变更跟踪，不得列为可申报候选，不得用于计算。',
  },
  {
    methodology_id: 'CCER-14-002',
    code_display: 'CCER-14-002-V01（修订征求意见稿）',
    name: '红树林营造（修订征求意见稿）',
    version: 'V01-draft-2026',
    document_status: 'revised_draft',
    domain: '林业和其他碳汇',
    project_types: ['红树林营造'],
    tech_routes: ['红树林人工种植'],
    scale_note: '本次为现行 CCER-14-002-V01（红树林营造）的修订征求意见稿，尚未生效。',
    release_date: '2026-06-26',
    effective_date: null,
    source_key: 'src-draft-2026',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260626_1160307.html',
    catalog_confidence: 'verified_from_official_notice',
    is_candidate_eligible: 0,
    supersedes_code: 'CCER-14-002-V01',
    exclusion_note: '草案状态，仅供观察与变更跟踪，不得列为可申报候选，不得用于计算。',
  },
];

/**
 * 目录基线说明。
 * ============================================================================
 * 【纪律】编号—名称的对应关系只能来自发布通知正文。凡未经通知核实的编号一律留空，
 * 由研究员在注册登记系统核对后补录；系统不推测编号，也不依据「系列号相邻」推断。
 * （本项目曾在 2023 年首批 4 项上把 14-001/14-002 的对应关系写反，
 *   根因是依据新闻稿的列举顺序而非发布通知正文，现已修正并加来源驱动测试。）
 *
 * 【2026-09-30 复核结果】18 项正式方法学的编号与名称已**全部**从发布通知正文核实：
 *   2023-10-24 环办气候函〔2023〕343号 4 项
 *   2025-01-03 环办气候函〔2025〕1号 / 〔2024〕486号 2 项
 *   2025-11-21 环办气候函〔2025〕428号 3 项
 *   2025-12-02 环办气候函〔2025〕438号 1 项
 *   2025-12-03 环办气候函〔2025〕451号 2 项
 *   2025-12-17 环办气候函〔2025〕473号 2 项
 *   2025-12-23 环办气候函〔2025〕485号 1 项
 *   2025-12-26 环办气候函〔2025〕491号 2 项 / 〔2025〕493号 1 项
 * 合计 18 项，与设计基线记载的条目数一致。
 *
 * 【仍未核实的事项（保留为真实缺口，不强行关闭）】
 *   注册登记系统方法学目录页为前端渲染，其列表接口对本系统返回 401，
 *   无法机器读取「官方目录当前列出的条目数」，因此
 *   `registry_listing_count_verified` 保持 false：
 *   上述 18 项是「已通过官方发布通知发布的正式方法学」，**不等同于**
 *   「注册登记系统目录当前展示的条目数」。注册登记系统目录条目数仍需人工按周期核对。
 */
export const CATALOG_BASELINE = {
  design_doc_count: 18,
  seeded_methodology_ids: 18,
  verified_code_count: 18,
  pending_code_count: 0,
  registry_listing_count_verified: false,
  verified_against: [
    '环办气候函〔2023〕343号',
    '环办气候函〔2025〕1号',
    '环办气候函〔2024〕486号',
    '环办气候函〔2025〕428号',
    '环办气候函〔2025〕438号',
    '环办气候函〔2025〕451号',
    '环办气候函〔2025〕473号',
    '环办气候函〔2025〕485号',
    '环办气候函〔2025〕491号',
    '环办气候函〔2025〕493号',
  ],
  note:
    '设计文档记载官方注册登记系统列出 18 项方法学。本库已录入 18 项，且 18 项的编号与名称**全部**已从发布通知正文逐字核实' +
    '（环办气候函〔2023〕343号、〔2024〕486号、〔2025〕1号、〔2025〕428号、〔2025〕438号、〔2025〕451号、' +
    '〔2025〕473号、〔2025〕485号、〔2025〕491号、〔2025〕493号）；原「仅答记者问口径」的 8 项已按其发布通知补全编号。' +
    '系统仍不推测编号，也不依据「系列号相邻」推断（该项目曾在 2023 年首批 4 项上把 14-001/14-002 写反）。' +
    '未核实项：注册登记系统方法学目录页为前端渲染、列表接口对本系统返回 401，' +
    '无法机器读取官方目录当前条目数，故「已发布 18 项」不等同于「注册登记系统目录展示 18 项」，该条目数仍需人工按周期核对。',
};
