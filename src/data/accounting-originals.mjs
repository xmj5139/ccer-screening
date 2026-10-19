import {EXTRA_SOURCES,EXTRA_STANDARDS} from './accounting-extra-sources.mjs';
/**
 * 公开碳核算资料：随代码提供的**已核实静态数据**（docs/39 第 1 条末段）
 * ============================================================================
 * 允许 seed 的内容（严格限定）：
 *   1. 来源登记（URL / 权威主体 / 允许域名 / 类型）——不含任何「抓取成功」状态；
 *   2. 规范元数据（标准编号、标题、发布机构、发布/落款日期、原 PDF URL、哈希、页数）；
 *   3. **已核实**的静态数值（2023 年电力 CO2 因子 40 行）与该原件的哈希、物理页/打印页。
 *
 * 绝不允许 seed：
 *   · 编造的「最近抓取成功时间 / HTTP 200 / 解析成功」；
 *   · 编造的模型核验结论（一律 unavailable，等真实模型跑过再写）；
 *   · 把 2026-05 发电指南**征求意见稿**当成正式版；
 *   · 把 NCSC 的 HTTP 412 校验页当成因子数据。
 *
 * 本文件所有数值均可回溯到公开原件：
 *   · 电力因子：https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf
 *     原件 SHA-256 d43b60a3eaad9f3fe59ca37c204d3d0e1b6ea52742a092f0d856971a3f018e5a（121854 字节，物理 2 页）
 *     实测：pdftotext -layout 逐页提取，物理页 1 = 打印页 3，物理页 2 = 打印页 4，共 40 行数值；
 *   · 规范元数据：Codex 独立核验清单 verified-source-manifest.json（10 份原件，含 sha256/字节/页数/字数）；
 *   · 中碳登日报：https://www.chinacrc.net.cn/view/8753.html（2026-10-14，表格 + 正文双证据）。
 */

/* ==================================================================== */
/*  一、来源登记                                                        */
/* ==================================================================== */

const CRC = ['www.chinacrc.net.cn', 'chinacrc.net.cn'];
const MEE = ['www.mee.gov.cn', 'mee.gov.cn'];
const NCSC = ['www.ncsc.org.cn', 'ncsc.org.cn'];
const NCSC_DATA = ['data.ncsc.org.cn'];
const CETS = ['www.cets.org.cn', 'cets.org.cn'];

/**
 * 来源登记表。`status` 一律以 'registered' 起步：
 * 本模块只登记「我们知道这个公开入口在哪、允许抓哪些域名」，
 * 真实的 HTTP 状态 / 成功时间 / 采集数量由 accounting-collect-svc 抓取后写入。
 */
export const ACCOUNTING_SOURCES = [...EXTRA_SOURCES,
  /* ---------------- 中碳登（中国碳排放权注册登记结算有限责任公司） ---------------- */
  {
    code: 'chinacrc_home',
    name: '中国碳排放权注册登记结算有限责任公司（中碳登）首页',
    url: 'https://www.chinacrc.net.cn/',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'portal',
    category: 'crc',
    fetch_kind: 'direct_html',
    cets_relation:
      '中碳登是**注册登记结算**机构门户，与全国碳市场信息网（CETS，www.cets.org.cn）是两个系统；' +
      '本库只读其公开页面，不登录企业账户、不读取账户内数据。',
    note: '公开 HTML 可读，不需要登录；站点抬头以网页实际名称为准。',
  },
  {
    code: 'chinacrc_daily_list',
    name: '中碳登·信息日报（列表）',
    url: 'https://www.chinacrc.net.cn/list/18.html',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'list',
    category: 'crc',
    fetch_kind: 'direct_html',
    cets_relation: '清结算日报属登记结算公开披露，与 CETS 交易数据分属两个来源，不做合并。',
    note: '列表页 dl/dt/dd 结构：a.href 指向 /view/<id>.html，标题含数据日期；详情页才有量额数值。',
  },
  {
    code: 'chinacrc_overview',
    name: '中碳登·数据总览',
    url: 'https://www.chinacrc.net.cn/list/19.html',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'list',
    category: 'crc',
    fetch_kind: 'direct_html',
    note: '总量与分布类公开数据入口；未取得结构化数值前只登记来源，不写数值。',
  },
  {
    code: 'chinacrc_guide',
    name: '中碳登·操作指南',
    url: 'https://www.chinacrc.net.cn/list/46.html',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'list',
    category: 'crc',
    fetch_kind: 'direct_html',
    note: '业务流程类公开指南，不含账户数据。',
  },
  {
    code: 'chinacrc_notice',
    name: '中碳登·通知公告',
    url: 'https://www.chinacrc.net.cn/list/9.html',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'list',
    category: 'crc',
    fetch_kind: 'direct_html',
    note: '公告正文按真实 a.href 发现详情页后采集。',
  },
  {
    code: 'chinacrc_law',
    name: '中碳登·法律法规',
    url: 'https://www.chinacrc.net.cn/list/29.html',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'list',
    category: 'crc',
    fetch_kind: 'direct_html',
    note: '法规清单入口；正式规范正文以生态环境部发布原文为准。',
  },
  {
    code: 'chinacrc_cancel_disclosure',
    name: '中碳登·自愿注销公示',
    url: 'https://www.chinacrc.net.cn/list/21.html',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'list',
    category: 'crc',
    fetch_kind: 'direct_html',
    note: '**公示量不计入成交量**：与交易/履约清缴分开统计，本库只登记来源与公示条目。',
  },
  {
    code: 'chinacrc_daily_detail',
    name: '中碳登·清结算信息日报（详情页）',
    url: 'https://www.chinacrc.net.cn/view/8753.html',
    authority: '中国碳排放权注册登记结算有限责任公司',
    allowed_domains: CRC,
    source_type: 'detail',
    category: 'crc',
    fetch_kind: 'direct_html',
    note:
      '详情页模板：div.title=标题、div.time 内「发布时间：YYYY-MM-DD」、div.wrapIntel 内 Excel 风格表格 + 两段正文；' +
      '表格与正文互为交叉证据（正文给出公布均价，表格给出分层明细）。',
  },

  /* ---------------- NCSC 国家温室气体排放因子数据库 ---------------- */
  {
    code: 'ncsc_factor_portal',
    name: '国家温室气体排放因子数据库（NCSC 因子库）',
    url: 'https://data.ncsc.org.cn/factories/index',
    authority: '国家应对气候变化战略研究和国际合作中心（NCSC）',
    allowed_domains: NCSC_DATA,
    source_type: 'portal',
    category: 'ncsc_factor',
    fetch_kind: 'direct_html',
    note:
      '本机直接请求返回 HTTP 412 校验页（JS 挑战、正文为空）。**该页面不得当作因子数据**；' +
      '不破解校验、不猜 API；实际因子值优先采集同一主管部门的官方公告与附件。',
  },
  {
    code: 'ncsc_factor_v2_announce',
    name: '国家温室气体排放因子数据库（第二版）发布公告',
    url: 'https://www.ncsc.org.cn/xwdt/gnxw/202603/t20260302_1145270.shtml',
    authority: '国家应对气候变化战略研究和国际合作中心（NCSC）',
    allowed_domains: NCSC,
    source_type: 'detail',
    category: 'ncsc_factor',
    fetch_kind: 'direct_html',
    note:
      '公告称第二版共 576 个因子——这是**公告中的因子总数**，不是本应用已导入条数；' +
      '本库绝不据此生成 576 条记录。',
  },
  {
    code: 'ncsc_factor_v2_tech',
    name: '国家温室气体排放因子数据库（第二版）技术说明',
    url: 'https://www.ncsc.org.cn/xwdt/zxxw/202603/t20260302_1145271.shtml',
    authority: '国家应对气候变化战略研究和国际合作中心（NCSC）',
    allowed_domains: NCSC,
    source_type: 'detail',
    category: 'ncsc_factor',
    fetch_kind: 'direct_html',
    note: '与发布公告配对的技术说明，用于解释口径；不是主库（data.ncsc.org.cn）。',
  },

  /* ---------------- 生态环境部：电力 CO2 因子原件 ---------------- */
  {
    code: 'mee_electricity_factor_2023',
    name: '2023 年电力二氧化碳排放因子（生态环境部公告附件）',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf',
    authority: '生态环境部',
    allowed_domains: MEE,
    source_type: 'pdf',
    category: 'mee_factor',
    fetch_kind: 'pdf',
    note:
      '2025-12-31 公告发布的正式附件；2023 数据年度；物理 2 页（打印页 3—4）；40 行数值。' +
      '三种口径（平均 / 不含市场化非化石电量 / 化石能源电力）不可互换。',
  },
  {
    code: 'mee_electricity_factor_interpretation',
    name: '2023 年电力二氧化碳排放因子解读',
    url: 'https://www.mee.gov.cn/ywdt/zbft/202601/t20260105_1139911.shtml',
    authority: '生态环境部',
    allowed_domains: MEE,
    source_type: 'detail',
    category: 'mee_factor',
    fetch_kind: 'direct_html',
    note: '官方解读，用于口径说明；数值仍以 PDF 附件原文为准。',
  },

  /* ---------------- 全国碳市场管理平台（CETS） ---------------- */
  {
    code: 'cets_portal',
    name: '全国碳市场管理平台（CETS）',
    url: 'https://www.cets.org.cn/',
    authority: '全国碳排放权注册登记结算机构 / 生态环境部（以门户实际抬头为准）',
    allowed_domains: CETS,
    source_type: 'portal',
    category: 'cets',
    fetch_kind: 'direct_html',
    note:
      '本机请求返回 HTTP 412 校验页（JS 挑战、<body> 为空）。生态环境部明确部分操作需登录管理平台账户，' +
      '本库**不采集企业账户内数据**，也不假装取得登录后公告；只登记门户与公开可核实的入口。',
  },

  /* ---------------- 标准与技术规范（生态环境部正式发布原文） ---------------- */
  {
    code: 'mee_power_guide_2026',
    name: '关于更新《企业温室气体排放核算与报告指南 发电设施》和《企业温室气体排放核查技术指南 发电设施》有关技术要求的通知',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260629_1160473.html',
    authority: '生态环境部（环办气候函〔2026〕237号）',
    allowed_domains: MEE,
    source_type: 'detail',
    category: 'standard',
    fetch_kind: 'direct_html',
    cets_relation:
      '本通知发布的两份规范即全国碳排放权交易市场技术规范 CETS-AG-01.01-V04-2026 与 CETS-VG-01.01-V02-2026；' +
      '规范正文以生态环境部原文为准，CETS 门户只作关联登记。',
    note:
      '落款 2026-06-23、网页发布 2026-06-29、自 2026 核算年度适用；公告页含 4 个真实 PDF href。' +
      '**2026-05 征求意见稿不是正式版**，本库不把草案登记为现行正式规范。',
  },
  {
    code: 'mee_steel_guides_2024',
    name: '关于印发《企业温室气体排放核算与报告指南 钢铁行业（CETS—AG—03.01—V01—2024）》等2项全国碳排放权交易市场技术规范的通知',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250124_1101316.html',
    authority: '生态环境部（环办气候函〔2025〕27号）',
    allowed_domains: MEE,
    source_type: 'detail',
    category: 'standard',
    fetch_kind: 'direct_html',
    cets_relation: '钢铁行业两项规范的 CETS 编号体系与 CETS 门户一致。',
    note: '落款 2025-01-21、发布 2025-01-24；公告页含 2 个真实 PDF href（不拼猜 URL）。',
  },
  {
    code: 'mee_cement_aluminum_guides_2024',
    name: '关于印发《企业温室气体排放核算与报告指南 水泥行业（CETS—AG—02.01—V01—2024）》等4项全国碳排放权交易市场技术规范的通知',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/t20240914_1086067.html',
    authority: '生态环境部',
    allowed_domains: MEE,
    source_type: 'detail',
    category: 'standard',
    fetch_kind: 'direct_html',
    cets_relation: '水泥、铝冶炼四项规范的 CETS 编号体系与 CETS 门户一致。',
    note: '发布 2024-09-14；公告页含 4 个真实 PDF href（原文内的真实链接，不拼接猜测）。',
  },
];

/* ==================================================================== */
/*  二、2023 年电力二氧化碳排放因子（40 行，逐行带物理页/打印页）        */
/* ==================================================================== */

export const ELECTRICITY_FACTOR_SOURCE = {
  code: 'mee_electricity_factor_2023',
  url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf',
  sha256: 'd43b60a3eaad9f3fe59ca37c204d3d0e1b6ea52742a092f0d856971a3f018e5a',
  bytes: 121854,
  pages_physical: 2,
  printed_pages: '3—4',
  data_year: 2023,
  publish_date: '2025-12-31',
  version: '2023',
  unit: 'kgCO2/kWh',
  gas: 'CO2',
};

const P1 = { page_physical: 1, page_printed: '3' };
const P2 = { page_physical: 2, page_printed: '4' };

/** 表号 → 口径。三种口径**不可互换**（docs/39 第 38 行）。 */
export const ELECTRICITY_CATEGORIES = {
  national_average: {
    label: '全国电力平均二氧化碳排放因子',
    caliber: '全国电力平均二氧化碳排放因子（表1）；2023 数据年度',
    note: '示例：100 万 kWh × 0.5306 kgCO2/kWh = 530.6 tCO2。',
  },
  regional_average: {
    label: '区域电力平均二氧化碳排放因子',
    caliber: '区域电力平均二氧化碳排放因子（表2）；2023 数据年度',
  },
  provincial_average: {
    label: '省级电力平均二氧化碳排放因子',
    caliber: '省级电力平均二氧化碳排放因子（表3）；2023 数据年度；不含西藏（原文未列）',
  },
  national_excl_market_nonfossil: {
    label: '全国电力平均二氧化碳排放因子（不包括市场化交易的非化石能源电量）',
    caliber:
      '全国电力平均二氧化碳排放因子（不包括市场化交易的非化石能源电量）（表4）；' +
      '**与表1 口径不同，不得互换**',
  },
  national_fossil: {
    label: '全国化石能源电力二氧化碳排放因子',
    caliber: '全国化石能源电力二氧化碳排放因子（表5）；仅化石能源电力，**与表1 口径不同**',
  },
};

/** 表2 区域（7 个，原文顺序）。 */
const REGIONS = [
  ['华北', 0.6361],
  ['东北', 0.5122],
  ['华东', 0.5500],
  ['华中', 0.5271],
  ['西北', 0.5543],
  ['南方', 0.4042],
  ['西南', 0.2472],
];

/** 表3 省级（30 个，原文顺序；不补西藏）。前 10 行在物理页 1，其余在物理页 2。 */
const PROVINCES = [
  ['北京', 0.5554], ['天津', 0.6796], ['河北', 0.6516], ['山西', 0.6634], ['内蒙古', 0.6479],
  ['辽宁', 0.4878], ['吉林', 0.4671], ['黑龙江', 0.5229], ['上海', 0.5737], ['江苏', 0.5827],
  ['浙江', 0.4974], ['安徽', 0.6553], ['福建', 0.4211], ['江西', 0.5836], ['山东', 0.6191],
  ['河南', 0.5897], ['湖北', 0.4044], ['湖南', 0.4976], ['广东', 0.4419], ['广西', 0.4476],
  ['海南', 0.3648], ['重庆', 0.5581], ['四川', 0.1564], ['贵州', 0.5683], ['云南', 0.1333],
  ['陕西', 0.6335], ['甘肃', 0.4471], ['青海', 0.1796], ['宁夏', 0.6187], ['新疆', 0.6021],
];

function factorRow({ category, region, region_level, value, locator, page }) {
  const cat = ELECTRICITY_CATEGORIES[category];
  const s = ELECTRICITY_FACTOR_SOURCE;
  return {
    source_code: s.code,
    name: region ? `${cat.label}｜${region}` : cat.label,
    value,
    original_unit: s.unit,
    standard_unit: s.unit,
    gas: s.gas,
    category,
    caliber: cat.caliber,
    region: region || null,
    region_level,
    industry: '电力',
    data_year: s.data_year,
    publish_date: s.publish_date,
    version: s.version,
    applicability:
      '用于**外购电力**的二氧化碳排放参考计算（CO2，不是 CO2e）。' +
      '本因子是电力二氧化碳排放因子，**不是**产品全生命周期碳足迹因子，' +
      '**也不是** CCER 区域电网基准线排放因子；不得用于 CCER 项目签发量估算。',
    page_physical: page.page_physical,
    page_printed: page.page_printed,
    locator,
    original_url: s.url,
    original_sha256: s.sha256,
    evidence_level: 'full',
    metadata_origin: 'seed:verified-original(electricity-co2-2023.pdf|sha256:' + s.sha256.slice(0, 12) + ')',
  };
}

/** 40 行：表1(1) + 表2(7) + 表3(30) + 表4(1) + 表5(1)。 */
export const ELECTRICITY_FACTORS_2023 = [
  factorRow({
    category: 'national_average', region: null, region_level: 'national', value: 0.5306,
    locator: '表1 2023 年全国电力平均二氧化碳排放因子｜全国', page: P1,
  }),
  ...REGIONS.map(([region, value]) =>
    factorRow({
      category: 'regional_average', region, region_level: 'region', value,
      locator: `表2 2023 年区域电力平均二氧化碳排放因子｜${region}`, page: P1,
    })
  ),
  ...PROVINCES.map(([region, value], i) =>
    factorRow({
      category: 'provincial_average', region, region_level: 'province', value,
      locator: `表3 2023 年省级电力平均二氧化碳排放因子｜${region}`, page: i < 10 ? P1 : P2,
    })
  ),
  factorRow({
    category: 'national_excl_market_nonfossil', region: null, region_level: 'national', value: 0.6096,
    locator: '表4 2023 年全国电力平均二氧化碳排放因子（不包括市场化交易的非化石能源电量）｜全国', page: P2,
  }),
  factorRow({
    category: 'national_fossil', region: null, region_level: 'national', value: 0.8273,
    locator: '表5 2023 年全国化石能源电力二氧化碳排放因子｜全国', page: P2,
  }),
];

/* ==================================================================== */
/*  三、标准与技术规范元数据（10 份原件 + 3 个公告页）                   */
/* ==================================================================== */

const MANIFEST_ORIGIN = 'seed:verified-source-manifest-20261015';

/** 元数据来自 Codex 独立核验清单；`body_status` 一律 metadata_only（本库尚未取得正文）。 */
export const ACCOUNTING_STANDARDS = [...EXTRA_STANDARDS,
  {
    code: 'CETS-AG-01.01-V04-2026',
    title: '企业温室气体排放核算与报告指南 发电设施',
    sector: '发电',
    standard_type: 'accounting',
    status: 'formal',
    version: 'V04-2026',
    issue_date: '2026-06-23',
    publish_date: '2026-06-29',
    effective_year: 2026,
    announcement_code: 'mee_power_guide_2026',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260629_1160473.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673485282202.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核算与报告指南 发电设施》（全国碳排放权交易市场技术规范编号：CETS-AG-01.01-V04-2026）',
    sha256: '6054f6166cbe2dc12b3d18726fe2e6c0add4210559968a3ac30a17623e2a317e',
    bytes: 1538857,
    pages_total: 39,
    chars: 26107,
    cets_relation: '全国碳排放权交易市场技术规范编号体系；正文以生态环境部发布原文为准。',
    replaces_code: null,
    related_codes: ['CETS-VG-01.01-V02-2026'],
    applicability: '自 2026 核算年度适用（环办气候函〔2026〕237号）。',
  },
  {
    code: 'CETS-VG-01.01-V02-2026',
    title: '企业温室气体排放核查技术指南 发电设施',
    sector: '发电',
    standard_type: 'verification',
    status: 'formal',
    version: 'V02-2026',
    issue_date: '2026-06-23',
    publish_date: '2026-06-29',
    effective_year: 2026,
    announcement_code: 'mee_power_guide_2026',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260629_1160473.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673486224832.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核查技术指南 发电设施》（全国碳排放权交易市场技术规范编号：CETS-VG-01.01-V02-2026）',
    sha256: 'ba86e646dc1f8954340a81604a1164f5a60938688f907a7d37985cd025ecd4b3',
    bytes: 569347,
    pages_total: 44,
    chars: 30043,
    cets_relation: '全国碳排放权交易市场技术规范编号体系；正文以生态环境部发布原文为准。',
    related_codes: ['CETS-AG-01.01-V04-2026'],
    applicability: '自 2026 核算年度适用（环办气候函〔2026〕237号）。',
  },
  {
    code: null,
    title: '《企业温室气体排放核算与报告指南 发电设施》技术要求更新内容',
    sector: '发电',
    standard_type: 'update_note',
    status: 'formal',
    version: null,
    issue_date: '2026-06-23',
    publish_date: '2026-06-29',
    effective_year: 2026,
    announcement_code: 'mee_power_guide_2026',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260629_1160473.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673483846592.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核算与报告指南 发电设施》技术要求更新内容',
    sha256: 'b2456e4dd4e32d8651633e61fd5ff88dbe2fea59007ddda98a900d1219d3c4d6',
    bytes: 266200,
    pages_total: 3,
    chars: 1396,
    cets_relation: 'CETS-AG-01.01-V04-2026 的配套更新说明（不是独立规范）。',
    related_codes: ['CETS-AG-01.01-V04-2026'],
    applicability: '与 CETS-AG-01.01-V04-2026 同步适用（2026 核算年度）。',
  },
  {
    code: null,
    title: '《企业温室气体排放核查技术指南 发电设施》技术要求更新内容',
    sector: '发电',
    standard_type: 'update_note',
    status: 'formal',
    version: null,
    issue_date: '2026-06-23',
    publish_date: '2026-06-29',
    effective_year: 2026,
    announcement_code: 'mee_power_guide_2026',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260629_1160473.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673484936970.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核查技术指南 发电设施》技术要求更新内容',
    sha256: 'bc8f081f029b76750064c393037657b0f456ac0bf2d939dce4fa41151779cd0e',
    bytes: 266351,
    pages_total: 3,
    chars: 1472,
    cets_relation: 'CETS-VG-01.01-V02-2026 的配套更新说明（不是独立规范）。',
    related_codes: ['CETS-VG-01.01-V02-2026'],
    applicability: '与 CETS-VG-01.01-V02-2026 同步适用（2026 核算年度）。',
  },
  {
    code: 'CETS-AG-03.01-V01-2024',
    title: '企业温室气体排放核算与报告指南 钢铁行业',
    sector: '钢铁',
    standard_type: 'accounting',
    status: 'formal',
    version: 'V01-2024',
    issue_date: '2025-01-21',
    publish_date: '2025-01-24',
    effective_year: null,
    announcement_code: 'mee_steel_guides_2024',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250124_1101316.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250124388842647934.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核算与报告指南 钢铁行业（CETS—AG—03.01—V01—2024）》',
    sha256: 'fb4c1fdc11f7ed9bb6153ba281d72f3801d7774a11beb65e21c2c4aee2250185',
    bytes: 1476156,
    pages_total: 51,
    chars: 32477,
    cets_relation: '全国碳排放权交易市场技术规范编号体系。',
    related_codes: ['CETS-VG-03.01-V01-2024'],
    applicability: '适用年度以规范正文与主管部门公告为准；本库未从原文提取到明确适用年度，不做推断。',
  },
  {
    code: 'CETS-VG-03.01-V01-2024',
    title: '企业温室气体排放核查技术指南 钢铁行业',
    sector: '钢铁',
    standard_type: 'verification',
    status: 'formal',
    version: 'V01-2024',
    issue_date: '2025-01-21',
    publish_date: '2025-01-24',
    effective_year: null,
    announcement_code: 'mee_steel_guides_2024',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250124_1101316.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250124388843909905.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核查技术指南 钢铁行业（CETS—VG—03.01—V01—2024）》',
    sha256: '64922b7224ff3ebb79086e06882a4a62a3de162d910acfce4f250f7e6981a33c',
    bytes: 1394440,
    pages_total: 49,
    chars: 41931,
    cets_relation: '全国碳排放权交易市场技术规范编号体系。',
    related_codes: ['CETS-AG-03.01-V01-2024'],
    applicability: '适用年度以规范正文与主管部门公告为准；本库未从原文提取到明确适用年度，不做推断。',
  },
  {
    code: 'CETS-AG-02.01-V01-2024',
    title: '企业温室气体排放核算与报告指南 水泥行业',
    sector: '水泥',
    standard_type: 'accounting',
    status: 'formal',
    version: 'V01-2024',
    issue_date: null,
    publish_date: '2024-09-14',
    effective_year: null,
    announcement_code: 'mee_cement_aluminum_guides_2024',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/t20240914_1086067.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705756032366.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核算与报告指南 水泥行业（CETS—AG—02.01—V01—2024）》',
    sha256: 'd99bb8e2d7df39ba2c1491c043a59f278443beb691057b0b7fc96628155c0ebb',
    bytes: 1397460,
    pages_total: 41,
    chars: 27116,
    cets_relation: '全国碳排放权交易市场技术规范编号体系。',
    related_codes: ['CETS-VG-02.01-V01-2024'],
    applicability: '适用年度以规范正文与主管部门公告为准；本库未从原文提取到明确适用年度，不做推断。',
  },
  {
    code: 'CETS-VG-02.01-V01-2024',
    title: '企业温室气体排放核查技术指南 水泥行业',
    sector: '水泥',
    standard_type: 'verification',
    status: 'formal',
    version: 'V01-2024',
    issue_date: null,
    publish_date: '2024-09-14',
    effective_year: null,
    announcement_code: 'mee_cement_aluminum_guides_2024',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/t20240914_1086067.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705757419213.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核查技术指南 水泥行业（CETS—VG—02.01—V01—2024）》',
    sha256: '86d179c261d572eb96dabec15623cedff218ec00b9e1a844fab4990800c8b1d1',
    bytes: 478244,
    pages_total: 26,
    chars: 16519,
    cets_relation: '全国碳排放权交易市场技术规范编号体系。',
    related_codes: ['CETS-AG-02.01-V01-2024'],
    applicability: '适用年度以规范正文与主管部门公告为准；本库未从原文提取到明确适用年度，不做推断。',
  },
  {
    code: 'CETS-AG-04.01-V01-2024',
    title: '企业温室气体排放核算与报告指南 铝冶炼行业',
    sector: '铝冶炼',
    standard_type: 'accounting',
    status: 'formal',
    version: 'V01-2024',
    issue_date: null,
    publish_date: '2024-09-14',
    effective_year: null,
    announcement_code: 'mee_cement_aluminum_guides_2024',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/t20240914_1086067.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705758174865.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核算与报告指南 铝冶炼行业（CETS—AG—04.01—V01—2024）》',
    sha256: '270dd9e3aae99db48635a79ac4f90c497b03927ea55365bc54303c643bc313f6',
    bytes: 1460837,
    pages_total: 44,
    chars: 28233,
    cets_relation: '全国碳排放权交易市场技术规范编号体系。',
    related_codes: ['CETS-VG-04.01-V01-2024'],
    applicability: '适用年度以规范正文与主管部门公告为准；本库未从原文提取到明确适用年度，不做推断。',
  },
  {
    code: 'CETS-VG-04.01-V01-2024',
    title: '企业温室气体排放核查技术指南 铝冶炼行业',
    sector: '铝冶炼',
    standard_type: 'verification',
    status: 'formal',
    version: 'V01-2024',
    issue_date: null,
    publish_date: '2024-09-14',
    effective_year: null,
    announcement_code: 'mee_cement_aluminum_guides_2024',
    announcement_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/t20240914_1086067.html',
    original_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705759175761.pdf',
    source_locator: '公告附件锚文本：《企业温室气体排放核查技术指南 铝冶炼行业（CETS—VG—04.01—V01—2024）》',
    sha256: 'cd414b600d876d1a4bbc43405e4ebe679d882f90b7548bed876a39f63046faa3',
    bytes: 422369,
    pages_total: 22,
    chars: 15202,
    cets_relation: '全国碳排放权交易市场技术规范编号体系。',
    related_codes: ['CETS-AG-04.01-V01-2024'],
    applicability: '适用年度以规范正文与主管部门公告为准；本库未从原文提取到明确适用年度，不做推断。',
  },
].map((s) => ({ ...s, metadata_origin: MANIFEST_ORIGIN, body_status: 'metadata_only', issuer: '生态环境部' }));

/* ==================================================================== */
/*  四、中碳登清结算日报已核实样本（2026-10-14）                         */
/* ==================================================================== */

/**
 * 该样本的**每一个数值**都同时出现在详情页的 Excel 风格表格与正文段落中，
 * 表格与正文互为交叉证据；`交易合计` 行等于 6 个「小计」行之和（量、额均成立）。
 * content_hash 为已核实原件（HTML）的 SHA-256，可据此确认同页内容未被替换。
 */
export const CRC_DAILY_SAMPLE = {
  source_code: 'chinacrc_daily_detail',
  url: 'https://www.chinacrc.net.cn/view/8753.html',
  title: '2026年10月14日全国碳排放权交易市场清结算信息日报',
  trade_date: '2026-10-14',
  published_at: '2026-10-14',
  content_hash: '539139c45e440e7137b3c0353dc705cd11ddbcb858e554383d8f3dfbc3044be5',
  daily_volume_t: 2861440,
  daily_amount_yuan: 258301176.6,
  daily_avg_price_published: 90.27,
  cumulative_volume_t: 1001935009,
  cumulative_amount_yuan: 69547332187.35,
  caliber: '全国碳排放权交易市场（中碳登清结算信息日报口径：交易合计行）',
  scope: 'market_total',
  parse_note:
    '表格 r26「交易合计」与两段正文一致；公布均价 90.27 元/吨为原文四位小数以下四舍五入值，' +
    '按量额复算为 90.2696…元/吨，两者分别保存（published / derived），不互相覆盖。',
  /** 分层明细（原文顺序）；counts_to_total=1 的只有 6 个「小计」行。 */
  components: [
    ['碳排放配额19-20', '挂牌协议交易', null, null, 49401470, 2741445972.29],
    ['碳排放配额19-20', '大宗协议交易', null, null, 238356649, 11912560236.02],
    ['碳排放配额19-20', '单向竞价', null, null, null, null],
    ['碳排放配额19-20', '小计', null, null, 287758119, 14654006208.31],
    ['碳排放配额21', '挂牌协议交易', null, null, 11490465, 906812458.63],
    ['碳排放配额21', '大宗协议交易', null, null, 38356687, 2690231860.57],
    ['碳排放配额21', '单向竞价', null, null, null, null],
    ['碳排放配额21', '小计', null, null, 49847152, 3597044319.20],
    ['碳排放配额22', '挂牌协议交易', null, null, 37075764, 3097709083.84],
    ['碳排放配额22', '大宗协议交易', null, null, 161724216, 12250273789.43],
    ['碳排放配额22', '单向竞价', null, null, null, null],
    ['碳排放配额22', '小计', null, null, 198799980, 15347982873.27],
    ['碳排放配额23', '挂牌协议交易', null, null, 35010470, 2875743178.56],
    ['碳排放配额23', '大宗协议交易', null, null, 122855354, 10874538553.83],
    ['碳排放配额23', '单向竞价', null, null, 102000, 7586800.00],
    ['碳排放配额23', '小计', null, null, 157967824, 13757868532.39],
    ['碳排放配额24', '挂牌协议交易', null, null, 56384339, 3454543612.57],
    ['碳排放配额24', '大宗协议交易', null, null, 115179867, 6942983369.43],
    ['碳排放配额24', '单向竞价', null, null, 235000, 12038050.00],
    ['碳排放配额24', '小计', null, null, 171799206, 10409565032.00],
    ['碳排放配额25', '挂牌协议交易', 1087950, 106773995.05, 39859636, 3600812655.22],
    ['碳排放配额25', '大宗协议交易', 1773490, 151527181.55, 95902092, 8179972136.96],
    ['碳排放配额25', '单向竞价', null, null, 1000, 80430.00],
    ['碳排放配额25', '小计', 2861440, 258301176.60, 135762728, 11780865222.18],
  ].map(([year_label, trade_method, dv, da, cv, ca]) => ({
    year_label,
    trade_method,
    is_subtotal: trade_method === '小计' ? 1 : 0,
    counts_to_total: trade_method === '小计' ? 1 : 0,
    daily_volume_t: dv,
    daily_amount_yuan: da,
    cumulative_volume_t: cv,
    cumulative_amount_yuan: ca,
  })),
};

/* ==================================================================== */
/*  五、来源未取得正文时的缺口说明（供界面「资料来源」页签展示）          */
/* ==================================================================== */

export const SOURCE_GAPS = [
  {
    code: 'ncsc_factor_portal',
    kind: 'http_412_challenge',
    note:
      'HTTP 412 + JS 校验页，正文为空。**不是**因子数据；不破解校验、不猜 API。' +
      '实际因子值改由同一主管部门的公开公告/附件获取。',
  },
  {
    code: 'cets_portal',
    kind: 'http_412_challenge',
    note: 'HTTP 412 + JS 校验页；且部分操作需登录管理平台账户——本库不采集账户内数据。',
  },
  {
    code: 'ncsc_factor_v2_announce',
    kind: 'count_not_imported',
    note: '公告称第二版共 576 个因子；这是公告口径的总数，不是本应用已导入条数。',
  },
];
