/**
 * CEA 官方来源登记与基础数据（不含任何模拟行情）
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md 第「官方来源清单（已完成公开资料初查）」节、
 * docs/21-公开来源与连接参考.md、docs/decisions/ADR-002。
 *
 * 硬约束：
 *   1. 本文件只登记**真实存在的官方地址与官方已公开的元数据**（文号、印发日期、
 *      适用行业与年度），不包含任何编造的行情数值、企业名录行或交易意向行。
 *   2. 真实行情数值、正文全文、名录与意向明细**只能**由真实采集（网络读取官方原文）
 *      写库；获取失败就登记缺口，不用种子/占位数据顶替。
 *   3. 每条基础数据的 provenance 必须说明具体来源（URL + 该事实在哪个文件里），
 *      不能写「来自官方」这类不可核对的说明。
 */

/** 各来源允许出站的域名白名单（写入 cea_source.allowed_domains） */
const DOMAINS = {
  cneeex_overview: ['overview.cneeex.com'],
  cneeex_shyx: ['shyx.cneeex.com'],
  mee: ['www.mee.gov.cn', 'mee.gov.cn'],
  iigf: ['iigf.cufe.edu.cn'],
  fujian: ['sthjt.fujian.gov.cn'],
};

/**
 * 官网页面自身使用的**公开 JSON 通道**（Codex 2026-10-14 实测 200）。
 * 这不是商用行情 API 授权承诺；上游结构变更必须如实报错。
 * 用途分工见 docs/31「独立取样新增」段与 CEA-16：
 *   - 精确成交量额只认 querySubStat 的 COMCEA 聚合；
 *   - dailyov 只是概览（舍入展示值），不得覆盖精确值；
 *   - hiskline 用于发现真实交易日（源目录可能滞后），其数量不作为全方式成交量；
 *   - queryMarketByDate 的 dealQty/dealAmt 是挂牌口径。
 */
export const CEA_JSON_SOURCES = [
  {
    code: 'cea_json_dailyov',
    name: 'CEA 最新行情概览（官网公开 JSON，舍入展示层）',
    url: 'https://shyx.cneeex.com/assets/json/dailyov.json',
    dataset: 'daily_overview',
    kind: 'official_json',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 20,
    method: 'GET',
    note: '最新日期/OHLC 与概览；数量金额为万吨/亿元/亿吨舍入展示值，仅作概览与交叉核对，不能覆盖精确原始成交量额（CEA-16）。',
  },
  {
    code: 'cea_json_hiskline',
    name: 'CEA 历史 K 线数组（官网公开 JSON）',
    url: 'https://shyx.cneeex.com/assets/json/hiskline.json',
    dataset: 'daily_index',
    kind: 'official_json',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 15,
    method: 'GET',
    note: '优先用于发现真实交易日与最近日期（原始目录可能滞后）；其中数量不能擅自当作全国全方式成交量。',
  },
  {
    code: 'cea_json_market_by_date',
    name: 'CEA 按日期查综合行情（官网公开 JSON）',
    url: 'https://shyx.cneeex.com/gateway/common/queryMarketByDate',
    dataset: 'daily_quote',
    kind: 'official_json',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 10,
    method: 'POST',
    body_template: { tradeDate: '{YYYYMMDD}', goodsCode: 'COMCEA' },
    note: 'success=true 时 data[0] 提供 OHLC 与昨收；其 dealQty/dealAmt 是挂牌口径，不能当全方式成交；limiUpPric/averPric/updaTime 字段名被复用，实测语义不符，一律不采用。',
  },
  {
    code: 'cea_json_substat',
    name: 'CEA 分方式精确成交统计（官网公开 JSON）',
    url: 'https://shyx.cneeex.com/gateway/common/querySubStat',
    dataset: 'daily_precise',
    kind: 'official_json',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 10,
    method: 'POST',
    body_template: { tradeDate: '{YYYYMMDD}' },
    note: '精确成交量额的唯一依据：取 COMCEA 三行按 tradeMethod 聚合（10 挂牌/20 大宗/21 单向竞价）；年度标的行不得与 COMCEA 重复相加。HTTP 200 但 success/code 失败必须判失败。',
  },
  {
    code: 'cea_json_trade_intent',
    name: 'CEA 公开交易意向列表（官网公开 JSON）',
    url: 'https://shyx.cneeex.com/assets/json/tradeIntent.json',
    dataset: 'intention',
    kind: 'official_json',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 10,
    method: 'GET',
    note: '真实意向列表（id/startTime/goodsName/dir/volume/areaName）。dir==1 买入、dir==2 卖出（2026-10-14 真实 69 条复验：dir 仅取 1/2），其它取值记 unknown 不猜；价格与主体未公开为 null；意向不计入成交。',
  },
  {
    code: 'cea_json_holidays',
    name: 'CEA 官方休市日期（官网公开 JSON）',
    url: 'https://shyx.cneeex.com/assets/json/holidays.json',
    dataset: 'calendar',
    kind: 'official_json',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 10,
    method: 'GET',
    note: '官方查询页使用的非周末休市日期，作为 CEA 独立日历证据（不复用 CCER 日历）。',
  },
];

/** 官方来源清单。`dataset` 决定采集器如何使用该来源。
 * priority 数值越小越优先（同一 dataset 内先试高优先级来源）。
 * 公开 JSON 通道（CEA_JSON_SOURCES）追加在 HTML/PDF 来源之后。 */
export const CEA_SOURCES = [
  {
    code: 'cea_daily_2026',
    name: '全国碳排放配额每日概况（2026 年目录）',
    url: 'https://overview.cneeex.com/qgtpfqjy/mrgk/2026n/',
    dataset: 'daily',
    kind: 'official_list',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_overview,
    priority: 10,
    note: '官方日行情目录页。列表可能为动态加载；动态失败时用搜索在官方域名内发现候选 URL，再实际读取命中原文。不得编造页面 URL。',
  },
  {
    code: 'cea_daily_query',
    name: '全国碳排放配额行情查询页',
    url: 'https://shyx.cneeex.com/qdata.html',
    dataset: 'daily',
    kind: 'official_portal',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 20,
    note: '存在日期与标的选择。未公开 API 协议，不得宣称已接入授权行情 API；仅作为人工可核对的公开入口登记。',
  },
  {
    code: 'cea_daily_sample_1',
    name: 'CEA 日报样本 2026-07-30（验收基准）',
    url: 'https://overview.cneeex.com/c/2026-07-30/498086.shtml',
    dataset: 'daily',
    kind: 'official_html',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_overview,
    priority: 30,
    note: '真实日报：OHLC、挂牌/大宗/单向竞价、日/年/历史累计。作为 CEA-02 验收基准样本。',
  },
  {
    code: 'cea_daily_sample_2',
    name: 'CEA 日报样本 2026-08-11（独立验证）',
    url: 'https://overview.cneeex.com/c/2026-08-11/498128.shtml',
    dataset: 'daily',
    kind: 'official_html',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_overview,
    priority: 30,
    note: '真实日报：用于独立验证解析结果（CEA-03）。',
  },
  {
    code: 'cea_monthly',
    name: '全国碳排放配额交易数据月报（2026 年目录）',
    url: 'https://overview.cneeex.com/qgtpfqjy/jysj/ydgk/2026n/',
    dataset: 'monthly',
    kind: 'official_list',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_overview,
    priority: 40,
    note: '月报必须单独标记 period，禁止混入每日数据（CEA-04）。',
  },
  {
    code: 'cea_price_regime',
    name: '2026 版行情编制方案',
    url: 'https://overview.cneeex.com/c/2025-12-29/496985.shtml',
    dataset: 'regime',
    kind: 'official_html',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_overview,
    priority: 50,
    note: '2026-01-05 起 CEA25 权重 1、其他年度权重 0。综合行情是年度标的价格指定权重指数，不是全方式量加权均价。',
  },
  {
    code: 'cea_allocation',
    name: '2025、2026 年度全国碳排放权交易市场配额总量与分配方案（正式文件）',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk03/202609/t20260903_1165029.html',
    dataset: 'allocation',
    kind: 'official_html',
    authority: '生态环境部',
    allowed_domains: DOMAINS.mee,
    priority: 10,
    note: '国环规气候〔2026〕1号，印发日 2026-09-01。最新正式分配方案。',
  },
  {
    code: 'cea_allocation_pdf',
    name: '配额分配方案官方原件（PDF）',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk03/202609/W020260903551498752549.pdf',
    dataset: 'allocation',
    kind: 'official_pdf',
    authority: '生态环境部',
    allowed_domains: DOMAINS.mee,
    priority: 20,
    note: '发电 2025/2026；钢铁、水泥、铝冶炼 2026。不能误用于 2025 年新增行业。',
  },
  {
    code: 'cea_annual_work',
    name: '全国碳排放权交易市场年度管理工作通知',
    url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202602/t20260209_1143900.html',
    dataset: 'calendar',
    kind: 'official_html',
    authority: '生态环境部',
    allowed_domains: DOMAINS.mee,
    priority: 10,
    note: '2025 年度清缴截止 2026-12-31；2027 年度名录公布截止 2026-10-31。后续修订优先。',
  },
  {
    code: 'cea_carryover',
    name: '配额结转相关规定',
    url: 'https://overview.cneeex.com/c/2026-01-04/497013.shtml',
    dataset: 'calendar',
    kind: 'official_html',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_overview,
    priority: 20,
    note: '时效性规则；过期后仍作为历史保留，不删除。',
  },
  {
    code: 'cea_intentions',
    name: '公开交易意向（门户）',
    url: 'https://shyx.cneeex.com/',
    dataset: 'intention',
    kind: 'official_portal',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_shyx,
    priority: 10,
    note: '意向不等于成交，不计入成交额/成交量；未公开价格或主体时为 NULL。',
  },
  {
    code: 'cea_entity_fujian_2026',
    name: '福建省 2026 年度重点排放单位名录（省级样本，PDF）',
    url: 'https://sthjt.fujian.gov.cn/zwgk/gsgg/202510/P020251030551328818102.pdf',
    dataset: 'entity',
    kind: 'official_pdf',
    authority: '福建省生态环境厅',
    allowed_domains: DOMAINS.fujian,
    priority: 10,
    note: 'PDF 可能获取失败：失败就登记缺口，不伪造名录行。可通过搜索发现官方 HTML 或其他省官方样本补充。',
  },
  {
    code: 'cea_annual_closures_2026',
    name: '关于全国碳排放权交易市场2026年全年休市安排的通知',
    url: 'https://overview.cneeex.com/c/2025-12-24/496961.shtml',
    dataset: 'calendar',
    kind: 'official_html',
    authority: '上海环境能源交易所',
    allowed_domains: DOMAINS.cneeex_overview,
    // 优先级高于机器辅助列表类来源：正式公告是日历的**首选**依据
    priority: 5,
    note:
      '沪环境交〔2025〕44号，2025-12-24 发布。**正式**全年休市安排，优先于官方查询页使用的机器辅助休市列表；' +
      '休市范围只按公告原文写明的「X月Y日至X月Z日休市」解析，并记录原文写明「起照常开市」的日期，不按节假日名称推测。',
  },
  {
    code: 'cea_research_iigf',
    name: '2025 中国碳市场年报（公开研究原文）',
    url: 'https://iigf.cufe.edu.cn/info/1012/10973.htm',
    dataset: 'research',
    kind: 'official_html',
    authority: '中央财经大学绿色金融国际研究院',
    allowed_domains: DOMAINS.iigf,
    priority: 10,
    note: '属于研究观点，不是现行规则；不得作为配额或履约义务的依据。',
  },
  // 官网公开 JSON 通道（与 HTML/PDF 来源并存，互不替代）
  ...CEA_JSON_SOURCES,
];

/**
 * 基础数据：**已由公开官方文件确认的元数据**（不含行情数值）。
 * 这些行的正文/原件仍需真实采集；未采集前 evidence_level 保持 metadata_only，
 * AI 核验结论保持 unverified，不因「来自官方」直接判为已核验。
 *
 * `coverage` = **行业 × 年度配对覆盖**（规范要求，避免笛卡尔积误判）：
 *   2026 年 9 月印发的分配方案中，发电适用 2025 与 2026 年度，
 *   钢铁 / 水泥 / 铝冶炼只适用 2026 年度 —— 「钢铁 2025 适用」是错误结论。
 */
export const CEA_DOCUMENTS = [
  {
    doc_key: 'cea_allocation_2026_1',
    doc_type: 'policy',
    category: 'allocation',
    title: '关于印发《全国碳排放权交易市场2025、2026年度发电行业以及2026年度钢铁、水泥、铝冶炼行业配额总量和分配方案》的通知',
    doc_number: '国环规气候〔2026〕1号',
    issuer: '生态环境部',
    publish_date: '2026-09-01',
    covered_sectors: ['发电', '钢铁', '水泥', '铝冶炼'],
    applicable_years: [2025, 2026],
    // 精确配对：不得由 covered_sectors × applicable_years 推导
    coverage: [
      { sector: '发电', years: [2025, 2026] },
      { sector: '钢铁', years: [2026] },
      { sector: '水泥', years: [2026] },
      { sector: '铝冶炼', years: [2026] },
    ],
    coverage_source:
      '配对依据 docs/31-CEA扩展开发规范.md 官方来源清单 cea_allocation_pdf 行：「发电2025/2026；钢铁水泥铝冶炼2026，不能误用于2025新增行业」。',
    doc_status: 'formal',
    version: '2026版',
    source_code: 'cea_allocation',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk03/202609/t20260903_1165029.html',
    provenance_note:
      '元数据登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」第 cea_allocation 行（印发日 2026-09-01、文号 国环规气候〔2026〕1号）。正文与原件需真实采集后回填，未采集前 evidence_level=metadata_only。',
    note: '最新正式分配方案。发电行业覆盖 2025/2026 年度；钢铁、水泥、铝冶炼覆盖 2026 年度。不得把 2026 年新增行业规则误用于 2025 年。',
  },
  {
    doc_key: 'cea_allocation_pdf_2026_1',
    doc_type: 'policy',
    category: 'allocation',
    title: '全国碳排放权交易市场2025、2026年度发电行业以及2026年度钢铁、水泥、铝冶炼行业配额总量和分配方案（官方 PDF 原件）',
    doc_number: '国环规气候〔2026〕1号',
    issuer: '生态环境部',
    publish_date: '2026-09-01',
    covered_sectors: ['发电', '钢铁', '水泥', '铝冶炼'],
    applicable_years: [2025, 2026],
    coverage: [
      { sector: '发电', years: [2025, 2026] },
      { sector: '钢铁', years: [2026] },
      { sector: '水泥', years: [2026] },
      { sector: '铝冶炼', years: [2026] },
    ],
    coverage_source: '同 cea_allocation（同一份文件的官方 PDF 原件）。',
    doc_status: 'formal',
    version: '2026版',
    source_code: 'cea_allocation_pdf',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk03/202609/W020260903551498752549.pdf',
    // 同一份通知的正文页与 PDF 原件：PDF 行作为正文行的附件，统计只计一次
    attachment_of_doc_key: 'cea_allocation_2026_1',
    provenance_note:
      '元数据登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」第 cea_allocation_pdf 行。PDF 正文需真实抓取；抓取失败登记缺口，不伪造。',
    note: '官方原件，作为 cea_allocation_2026_1 的附件关联；政策计数不重复统计。发电 2025/2026；钢铁、水泥、铝冶炼 2026。',
  },
  {
    doc_key: 'cea_annual_work_2026',
    doc_type: 'policy',
    category: 'annual_work',
    title: '关于做好2026年全国碳排放权交易市场有关工作的通知',
    issuer: '生态环境部办公厅',
    publish_date: '2026-02-09',
    applicable_years: [2026],
    covered_sectors: ['发电', '钢铁', '水泥', '铝冶炼'],
    doc_status: 'formal',
    source_code: 'cea_annual_work',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202602/t20260209_1143900.html',
    provenance_note:
      '元数据登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」第 cea_annual_work 行。关键日期（清缴 2026-12-31、名录公布 2026-10-31）以原文为准，正文采集后回填 source_quote。',
    note: '后续修订版本优先；旧版本保留为 historical，不删除。',
  },
  {
    doc_key: 'cea_carryover_2026',
    doc_type: 'policy',
    category: 'carryover',
    title: '全国碳排放配额结转相关规定',
    issuer: '上海环境能源交易所',
    publish_date: '2026-01-04',
    applicable_years: [2026],
    doc_status: 'formal',
    source_code: 'cea_carryover',
    official_url: 'https://overview.cneeex.com/c/2026-01-04/497013.shtml',
    provenance_note:
      '元数据登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」第 cea_carryover 行。属时效性规则，过期后保留为历史记录。',
    note: '时效性规则；到期后仍作为历史保留，不删除、不改写。',
  },
  {
    doc_key: 'cea_price_regime_2026',
    doc_type: 'technical',
    category: 'price_regime',
    title: '全国碳排放配额综合行情编制方案（2026 版）',
    issuer: '上海环境能源交易所',
    publish_date: '2025-12-29',
    effective_date: '2026-01-05',
    applicable_years: [2026],
    doc_status: 'formal',
    version: '2026版',
    source_code: 'cea_price_regime',
    official_url: 'https://overview.cneeex.com/c/2025-12-29/496985.shtml',
    provenance_note:
      '元数据登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」第 cea_price_regime 行。2026-01-05 起 CEA25 权重 1、其他年度权重 0。',
    note: '2026 年版综合行情是年度标的价格的指定权重指数，不是全方式量加权均价（CEA-05）。',
  },
  {
    doc_key: 'cea_research_iigf_2025',
    doc_type: 'research',
    category: 'research',
    title: '2025 中国碳市场年报',
    issuer: '中央财经大学绿色金融国际研究院',
    applicable_years: [2025],
    doc_status: 'formal',
    source_code: 'cea_research_iigf',
    official_url: 'https://iigf.cufe.edu.cn/info/1012/10973.htm',
    provenance_note:
      '元数据登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」第 cea_research_iigf 行。属研究观点，不是现行规则，不得作为配额或履约义务依据。',
    note: '研究观点归档，不作为现行规则。',
  },
  {
    doc_key: 'cea_annual_closures_2026',
    doc_type: 'policy',
    category: 'calendar',
    title: '关于全国碳排放权交易市场2026年全年休市安排的通知',
    doc_number: '沪环境交〔2025〕44号',
    issuer: '上海环境能源交易所',
    publish_date: '2025-12-24',
    applicable_years: [2026],
    doc_status: 'formal',
    source_code: 'cea_annual_closures_2026',
    official_url: 'https://overview.cneeex.com/c/2025-12-24/496961.shtml',
    provenance_note:
      '元数据登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」第 cea_annual_closures_2026 行（沪环境交〔2025〕44号）。' +
      '正文与休市范围必须由真实采集的公告原文解析（parseAnnualClosureNotice），不按节假日名称推测。',
    note:
      '正式全年休市公告：优先于官方查询页使用的机器辅助休市列表。' +
      '2026 年休市范围（原文）：元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动节 5/1–5/5、' +
      '端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7；10/8 起照常开市。',
  },
];

/**
 * 基础数据：履约日历事件。
 * 关键日期必须能回溯到原文片段；正文未采集前 date_verify_status 保持 unverified，
 * date_extract_status 记录该日期是「原文引用」还是「来自来源清单登记」。
 */
export const CEA_EVENTS = [
  {
    event_key: 'surrender_deadline_emission_2025',
    event_type: 'surrender_deadline',
    title: '2025 年度全国碳排放权交易市场配额清缴截止',
    deadline: '2026-12-31',
    emission_year: 2025,
    quota_year: 2025,
    source_doc_key: 'cea_annual_work_2026',
    source_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202602/t20260209_1143900.html',
    date_extract_status: 'extracted',
    note: '日期登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」cea_annual_work 行（2025 年度清缴 2026-12-31）。正文采集后必须回填 source_quote 并重新核验；后续修订优先。',
  },
  {
    event_key: 'list_published_2027',
    event_type: 'list_published',
    title: '2027 年度重点排放单位名录公布截止',
    deadline: '2026-10-31',
    list_year: 2027,
    source_doc_key: 'cea_annual_work_2026',
    source_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202602/t20260209_1143900.html',
    date_extract_status: 'extracted',
    note: '日期登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」cea_annual_work 行（2027 名录公布 2026-10-31）。不能只按标题年份识别履约年度。',
  },
  {
    event_key: 'price_regime_2026_effective',
    event_type: 'other',
    title: '2026 版综合行情编制方案生效（CEA25 权重 1）',
    deadline: '2026-01-05',
    quota_year: 2026,
    source_doc_key: 'cea_price_regime_2026',
    source_url: 'https://overview.cneeex.com/c/2025-12-29/496985.shtml',
    date_extract_status: 'extracted',
    note: '日期登记来源：docs/31-CEA扩展开发规范.md「官方来源清单」cea_price_regime 行（2026-01-05 起生效）。',
  },
];

/** 情景工具默认参考价来源说明（不写死价格；价格必须来自实际入库行情） */
export const CEA_SCENARIO_NOTE =
  '抵销比例 r 必须由用户显式选择或自定义；历史上 5% 的抵销比例不能无条件当作所有年度的现行规则。';

/** 采集配额默认值（有界默认，可由 auto_verify_config 覆盖） */
export const CEA_DEFAULTS = {
  /** 单批采集总时间上限（毫秒）——建议 ≤120 秒首期 CEA 批次 */
  batch_budget_ms: 120000,
  /** 每轮最多新增采集条数 */
  max_items_per_round: 8,
  /** 最多补证轮数（不能用循环次数替代证据） */
  max_evidence_rounds: 2,
  /** 单条请求超时 */
  request_timeout_ms: 20000,
  /** 每日抓取条数上限（服务端校验） */
  daily_fetch_limit: 60,
  /** 北京时间收盘后采集的默认时刻（HH:MM）；不改变既有 CCER 调度 */
  after_close_time: '16:30',
};
