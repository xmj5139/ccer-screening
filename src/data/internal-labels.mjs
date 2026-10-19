/**
 * 内部枚举 → 中文业务表述（docs/46 第 12 条、docs/47）
 * ============================================================================
 * 摘要与问答把库内字段交给模型时，**不得直接复述内部枚举**（national_average、
 * notice、project_public 等）或字段名、内部状态。这里集中维护唯一的中文口径，
 * 由摘要服务（summary-svc）与库内检索服务（retrieval-svc）共用，避免两处
 * 翻译不一致。
 *
 * 约定：
 *   - 只做展示与模型输入口径，**不改变库内取值**，也不参与任何判定；
 *   - 未登记的取值一律退回调用方给的兜底文案（默认「未标注」），
 *     不回显英文枚举，避免把内部状态泄露到摘要/答复里；
 *   - 正文范围（full / partial / abstract / none）以库内已有
 *     body_status / body_availability / evidence_level / full_text_available
 *     为准，不能只看正文长度就认定「已取得全文」。
 */

/* ------------------------------ 枚举中文表 ------------------------------ */

export const POLICY_STATUS_LABELS = {
  effective: '现行有效',
  superseded: '已被替代',
  repealed: '已废止',
  draft_consultation: '征求意见中',
  notice: '公告 / 通知',
};

export const POLICY_CATEGORY_LABELS = {
  management: '管理办法',
  registration: '注册登记规则',
  validation: '审定核查规则',
  trading: '交易结算规则',
  design_guide: '项目设计实施指南',
  factor_doc: '监测与排放因子文件',
  ministry_policy: '相关部委政策',
  consultation: '征求意见文件',
};

export const PROJECT_STAGE_LABELS = {
  project_public: '项目公示',
  validated: '审定',
  project_registered: '项目登记',
  reduction_public: '减排量公示',
  verified: '核查',
  reduction_registered: '减排量登记',
  registered: '登记',
  cancelled: '已注销',
};

export const METHODOLOGY_STATUS_LABELS = {
  formal: '正式发布',
  draft: '草案',
  consultation: '征求意见中',
  historical: '历史版本',
  superseded: '已被替代',
  repealed: '已废止',
};

export const EMISSION_FACTOR_CATEGORY_LABELS = {
  national_average: '全国电力平均二氧化碳排放因子',
  regional_average: '区域电力平均二氧化碳排放因子',
  provincial_average: '省级电力平均二氧化碳排放因子',
};

export const ACCOUNTING_STANDARD_STATUS_LABELS = {
  formal: '现行正式',
  draft: '草案',
  consultation: '征求意见稿',
  historical: '历史版本',
  superseded: '已被替代',
  repealed: '已废止',
};

export const PUBLIC_DOC_CATEGORY_LABELS = {
  policy: '政策',
  standard: '标准',
  notice: '通知公告',
  faq: '公开问答',
  guide: '指南',
  ccer_guide: 'CCER 指南',
};

export const CEA_DOC_TYPE_LABELS = {
  policy: '政策',
  technical: '技术文件',
  research: '研究',
  news: '动态',
};

export const CEA_CATEGORY_LABELS = {
  allocation: '配额分配',
  annual_work: '年度工作',
  carryover: '配额结转',
  price_regime: '价格机制',
  research: '研究',
  other: '其他',
};

/** 中文标签（未登记时退回 fallback；fallback 为空则「未标注」，绝不回显英文枚举）。 */
export function cnLabel(map, value, fallback = null) {
  const key = String(value ?? '').trim();
  if (!key) return fallback;
  return map[key] || fallback || '未标注';
}

/**
 * 内部枚举的兜底对照表：模型输出里若仍出现内部取值（national_average、notice、
 * project_public 等），落库前替换为中文业务表述（docs/46 第 12 条、docs/47）。
 * 只匹配**小写**且两侧不是 ASCII 词字符的独立取值，避免误伤
 * 「Verified Carbon Standard」这类专有名词。
 */
export const INTERNAL_ENUM_TO_CN = {
  national_average: '全国电力平均二氧化碳排放因子',
  regional_average: '区域电力平均二氧化碳排放因子',
  provincial_average: '省级电力平均二氧化碳排放因子',
  project_public: '项目公示',
  project_registered: '项目登记',
  reduction_public: '减排量公示',
  reduction_registered: '减排量登记',
  draft_consultation: '征求意见中',
  ministry_policy: '相关部委政策',
  design_guide: '项目设计实施指南',
  factor_doc: '监测与排放因子文件',
  annual_work: '年度工作',
  price_regime: '价格机制',
  index_only: '栏目索引',
  metadata_only: '仅公开字段',
  full_text: '已取得正文',
  partial_text: '部分正文',
  abstract_only: '仅摘要',
  // 单个词只收最明确的内部状态（小写匹配，专有名词首字母大写不受影响）
  allocation: '配额分配',
  carryover: '配额结转',
  notice: '公告 / 通知',
  effective: '现行有效',
  superseded: '已被替代',
  repealed: '已废止',
};

/** 把文本里残留的内部枚举替换成中文业务表述（不改变数字与其它内容）。 */
export function stripInternalEnums(text) {
  let out = String(text ?? '');
  if (!out) return out;
  for (const [token, cn] of Object.entries(INTERNAL_ENUM_TO_CN)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_./-])${token}(?![A-Za-z0-9_./-])`, 'g'), cn);
  }
  return out;
}

/* ------------------------------ 正文范围 ------------------------------ */

const RANGE_FULL = new Set(['full', 'full_text', 'complete', 'complete_text']);
const RANGE_PARTIAL = new Set(['partial', 'partial_text', 'partial_content', 'rendered_capture']);
const RANGE_SUMMARY = new Set(['abstract_only', 'abstract', 'summary', 'summary_only']);
const RANGE_NONE = new Set(['index_only', 'list_only', 'menu', 'metadata_only', 'unavailable', 'none', 'missing', 'not_available']);

/** 归一化正文范围：full_text | partial_text | summary_only | metadata_only | unknown。 */
export function bodyRangeOf(status) {
  const s = String(status ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (RANGE_FULL.has(s)) return 'full_text';
  if (RANGE_PARTIAL.has(s)) return 'partial_text';
  if (RANGE_SUMMARY.has(s)) return 'summary_only';
  if (RANGE_NONE.has(s)) return 'metadata_only';
  return 'unknown';
}

/**
 * 摘要输入范围（与 entity_summary.input_kind 同口径）。
 * @param {{body?:string, status?:string, available?:boolean, hasSummary?:boolean}} input
 *   status：库内正文状态字段（body_status / body_availability / evidence_level）；
 *   available：full_text_available 之类的布尔可得性标记（可选，仅在 status 缺失/未登记时生效）。
 * @returns {'full_text'|'partial_text'|'summary_only'|'metadata_only'}
 */
export function inputKindOf({ body = '', status = null, available = null, hasSummary = false } = {}) {
  const text = String(body || '').trim();
  const hasBody = text.length >= 200;
  const range = bodyRangeOf(status);
  // 库内正文状态字段是**逐条正文**的权威口径（例如 attachStandardBody 同时写入 body_status）
  if (range === 'full_text') return hasBody ? 'full_text' : (hasSummary ? 'summary_only' : 'metadata_only');
  if (range === 'partial_text') return hasBody ? 'partial_text' : (hasSummary ? 'summary_only' : 'metadata_only');
  if (range === 'summary_only') return 'summary_only';
  if (range === 'metadata_only') return hasBody ? 'partial_text' : 'metadata_only';
  // 没有可用的范围字段时：先看布尔可得性，再退回长度（policy/methodology 无正文状态列）
  if (available === true) return hasBody ? 'full_text' : (hasSummary ? 'summary_only' : 'metadata_only');
  if (available === false) return hasBody ? 'partial_text' : 'metadata_only';
  return hasBody ? 'full_text' : (hasSummary ? 'summary_only' : 'metadata_only');
}

/** 输入范围的中文说明（前端与提示词共用，避免出现内部枚举）。 */
export const INPUT_KIND_LABELS = {
  full_text: '已取得正文',
  partial_text: '部分正文（未取得完整原文）',
  summary_only: '来源摘要（非全文）',
  metadata_only: '仅公开字段（无正文）',
  data_range: '按筛选区间聚合',
};

export function inputKindLabel(kind) {
  return INPUT_KIND_LABELS[String(kind || '')] || '输入范围未标注';
}
