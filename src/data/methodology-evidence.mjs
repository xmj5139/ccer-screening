/**
 * 方法学原文对照台账（机器可读）
 * ============================================================================
 * 需求规格 P0 验收要求：
 *   「以正式 PDF 第 2、5、6、7 节逐条建立『原文条款 → 输入字段 → 判断规则/公式 →
 *     测试样例』的对照表；删除不支持的路径；完成独立复算后才可标记已审核。」
 *
 * 本文件是这条验收要求的**机器可读凭证**：
 *   - 只有在这里登记了 `officialSource` 与 `independentRecheck` 的方法学，
 *     才有资格把 methodology_version.evidence_level 标记为
 *     'official_original_verified'；
 *   - calc-svc 的业务测算门禁会再次校验该标记与数据库中的核对台账
 *     （methodology_doc_verification 表）一致，二者缺一即拒绝出数。
 *
 * 【纪律】
 *   1. 不得凭「自动测试通过」判定已核对原文——测试只能证明实现自洽，不能证明与原文一致；
 *   2. 未登记原文对照的方法学一律为 'unverified'，业务测算被阻止，界面显示真实原因；
 *   3. 本文件不存放官方 PDF 的正文文本，只登记出处、哈希与核对结论。
 */

/** 证据等级取值与含义（写入 methodology_version.evidence_level） */
export const EVIDENCE_LEVELS = {
  official_original_verified: {
    label: '官方原文逐条对照 + 独立复算',
    short: '已对照原文',
    business_calculation: true,
    description:
      '规则卡的适用条件、基准线与公式已逐条对照官方发布的正式方法学 PDF，' +
      '且存在**不复用生产代码**的独立实现，在正结果与应拒绝样例上与生产实现一致。',
  },
  official_original_partial: {
    label: '官方原文部分对照（结构已核对，数值未复核）',
    short: '部分对照',
    business_calculation: false,
    description: '适用条件的文字已对照原文，但公式链、参数或因子尚未完成逐式核对与独立复算。',
  },
  draft_outline_pending_review: {
    label: '草案：仅有官方口径提纲，待原文对照',
    short: '草案待对照',
    business_calculation: false,
    description: '规则或公式部分依据官方答记者问、新闻稿等口径整理，尚未取得正式原文。',
  },
  unverified: {
    label: '未经原文对照（实现存在但不具备放行条件）',
    short: '未对照原文',
    business_calculation: false,
    description:
      '代码中存在规则卡或计算插件，但未完成官方原文的逐条对照与独立复算。' +
      '按需求规格，**任何模式**下都不得用于业务测算或可导出的投资报告。',
  },
};

/**
 * 官方原文出处登记（供 methodology_doc_verification 表与界面「原文出处」展示）。
 */
export const METHODOLOGY_DOC_SOURCES = {
  'CCER-10-001::V01': {
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250103708572385358.pdf',
    doc_number: '环办气候函〔2025〕1号',
    publish_date: '2025-01-03',
    title: '温室气体自愿减排项目方法学 甲烷体积浓度低于8%的煤矿低浓度瓦斯和风排瓦斯利用（CCER—10—001—V01）',
    sections_verified: ['§2 适用条件', '§5 计入期与排放源', '§6 基准线与计算', '§7 参数与监测'],
    traceability_doc: 'docs/22-方法学原文对照表.md',
  },
};

/**
 * 原文对照台账：key = `${methodology_id}::${version}`
 *
 * 只有 `evidenceLevel === 'official_original_verified'` 且 `independentRecheck` 齐备的条目，
 * 才允许在管理后台被批准为业务可用。
 */
export const DOC_VERIFICATIONS = {
  'CCER-10-001::V01': {
    evidenceLevel: 'official_original_verified',
    officialSource: METHODOLOGY_DOC_SOURCES['CCER-10-001::V01'],
    // 逐条对照成果统计（与实现一致；由 test/06-doc-traceability.test.mjs 守护）
    coverage: {
      rules: 10,
      blocking_rules: 5,
      formulas: 21,
      parameters: 44,
      factors_total: 24,
      factors_placeholder: 3,
      self_check_samples: 7,
    },
    // 独立复算：另写一套实现，不 import 任何生产代码
    independentRecheck: {
      implementation: 'test/official-10-001.mjs',
      runner: 'scripts/verify-10001.mjs',
      test_file: 'test/06-doc-traceability.test.mjs',
      method:
        '按官方 PDF 的公式与「式中」定义重新实现一遍计算链，覆盖 4 个正结果样例' +
        '（仅发电 / 仅供热 / 热电联产 / 实测气量远大于推算值时取推算值的 min 分支）' +
        '与 3 个应拒绝样例（浓度 9% / §6.7a) 合规性不满足 / 计入期 12 年）。',
      last_result: '一致（差异项数 0；仅 PE_MD 因舍入顺序差异 < 0.001 tCO₂e）',
    },
    // 明确记录「仍被阻断」的原因：不得因为对照完成就默认放行
    remaining_blockers: [
      'c10-001.cef.ch4：CEF_CH4 只出现在公式(13)，原文无「式中」定义也未列入参数表，当前为化学计量候选值（模型假设）',
      'c10-001.tdl：TDL_y 原文未给缺省值，须逐项目逐年填报',
      'c10-001.eta.elec：原文未给出「仅发电」模式的 η_ELEC，须取可研或实测值',
    ],
    note:
      '原文对照与独立复算已完成，但仍有 3 项参数未经官方确认，因此业务测算依然被阻止。' +
      '这是设计要求：**原文对照 ≠ 参数已确认**，两道门都必须过。',
  },
  'CCER-10-002::V01': {
    evidenceLevel: 'unverified',
    officialSource: {
      official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
      doc_number: '环办气候函〔2025〕428号',
      publish_date: '2025-11-21',
    },
    independentRecheck: null,
    remaining_blockers: [
      '未取得并归档官方方法学 PDF 原文，无法建立「原文条款 → 输入字段 → 规则/公式 → 测试样例」对照表',
      '现有 7 条规则与 6 条公式声明全部使用【占位】条款引用，未回填真实章节',
      '4 项方法学专属系数为占位值，未经领域专家确认',
    ],
    note: '仅可检索与阅读，界面显示「暂不支持自动测算（待原文对照）」。',
  },
  'CCER-10-003::V01': {
    evidenceLevel: 'unverified',
    officialSource: {
      official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
      doc_number: '环办气候函〔2025〕428号',
      publish_date: '2025-11-21',
    },
    independentRecheck: null,
    remaining_blockers: [
      '未取得并归档官方方法学 PDF 原文，无法建立条款对照表',
      '5 项专属系数为占位值；6 条公式缺真实条款引用',
    ],
    note: '仅可检索与阅读，界面显示「暂不支持自动测算（待原文对照）」。',
  },
  'CCER-10-004::V01': {
    evidenceLevel: 'unverified',
    officialSource: {
      official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html',
      doc_number: '环办气候函〔2025〕428号',
      publish_date: '2025-11-21',
    },
    independentRecheck: null,
    remaining_blockers: [
      '未取得并归档官方方法学 PDF 原文，无法建立条款对照表',
      '4 项专属系数为占位值；6 条公式缺真实条款引用',
    ],
    note: '仅可检索与阅读，界面显示「暂不支持自动测算（待原文对照）」。',
  },
};

/** 取某方法学版本的原文对照台账（不存在则返回一个显式的「未登记」结构） */
export function docVerification(methodologyId, version) {
  const key = `${methodologyId}::${version}`;
  const v = DOC_VERIFICATIONS[key];
  if (v) return { key, ...v };
  return {
    key,
    evidenceLevel: 'unverified',
    officialSource: null,
    independentRecheck: null,
    remaining_blockers: ['本方法学尚未登记官方原文对照台账'],
    note: '尚未建立原文对照台账，不得用于业务测算。',
  };
}

/** 该证据等级是否允许业务测算 */
export function evidenceLevelAllowsBusiness(level) {
  return !!EVIDENCE_LEVELS[level]?.business_calculation;
}
