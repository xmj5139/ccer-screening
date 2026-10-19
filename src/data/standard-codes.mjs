/**
 * 标准与依据编码表
 * ============================================================================
 * 方法学的公式、因子与监测要求常引用外部标准、指南与清单文件。
 * 这些引用文件的版本直接决定计算口径，因此必须与研究的方法学版本一起绑定、一起审计。
 *
 * 纪律：
 *   - 每条记录标注 official_url 与发布机关；未核实的条目标记 verified:false
 *   - 引用关系（referenced_by）标注哪些方法学版本引用该文件
 *   - 本表不存放推测的编号或名称
 */

export const STANDARD_CODES = [
  {
    code: 'GB/T 32150',
    title: '工业企业温室气体排放核算和报告通则',
    kind: '国家标准',
    issuing_authority: '国家市场监督管理总局、国家标准化管理委员会',
    official_url: null,
    verified: false,
    note: '编号与年份版本须由领域专家核对后回填；用于甲烷类项目活动数据与排放核算口径参考。',
    referenced_by: [],
  },
  {
    code: 'GB/T 32151',
    title: '温室气体排放核算与报告要求（系列标准，含煤炭生产、石油天然气生产等分册）',
    kind: '国家标准系列',
    issuing_authority: '国家市场监督管理总局、国家标准化管理委员会',
    official_url: null,
    verified: false,
    note: '具体分册编号与年份须核对；煤矿瓦斯与油气田伴生气的活动数据口径可能引用相应分册。',
    referenced_by: [],
  },
  {
    code: 'IPCC-GL',
    title: '《IPCC 国家温室气体清单指南》',
    kind: '国际指南',
    issuing_authority: '政府间气候变化专门委员会（IPCC）',
    official_url: 'https://www.ipcc-nggip.iges.or.jp/',
    verified: true,
    note: '缺省排放因子与火炬燃烧效率的常见来源。**具体引用的指南年份（1996 修订版 / 2006 / 2019  refinement）必须由领域专家逐方法学确认。**',
    referenced_by: [],
  },
  {
    code: 'IPCC-AR5',
    title: 'IPCC 第五次评估报告（AR5）第一工作组报告第 8 章：人为与自然辐射强迫',
    kind: '国际评估报告',
    issuing_authority: 'IPCC',
    official_url: 'https://www.ipcc.ch/report/ar5/wg1/',
    verified: true,
    note: '甲烷化石源 100 年 GWP = 28。本系统默认采用，属保守选择。',
    referenced_by: ['CCER-10-001', 'CCER-10-002', 'CCER-10-003', 'CCER-10-004'],
  },
  {
    code: 'IPCC-AR6',
    title: 'IPCC 第六次评估报告（AR6）第一工作组报告第 7 章表 7.15',
    kind: '国际评估报告',
    issuing_authority: 'IPCC',
    official_url: 'https://www.ipcc.ch/report/ar6/wg1/',
    verified: true,
    note: '甲烷化石源 100 年 GWP = 29.8。仅当方法学明确引用 AR6 时使用。',
    referenced_by: [],
  },
  {
    code: 'MEE-METHOD-NOTICE',
    title: '生态环境部方法学发布通知（各批次）',
    kind: '主管部门文件',
    issuing_authority: '生态环境部（办公厅）、国家能源局（综合司）',
    official_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/',
    verified: true,
    note: '方法学编号、名称、发布与生效日期的唯一权威来源。本系统的目录条目以此为准。',
    referenced_by: ['CCER-10-001', 'CCER-10-002', 'CCER-10-003', 'CCER-10-004'],
  },
  {
    code: 'MEE-MEASURES-2023',
    title: '《温室气体自愿减排交易管理办法（试行）》',
    kind: '部门规章',
    issuing_authority: '生态环境部、国家市场监督管理总局',
    official_url: 'https://www.mee.gov.cn/gzk/gz/202310/t20231020_1043695.shtml',
    verified: true,
    note: '通用门槛（开工日期、减排量产生时间、法定减排义务、配额管理、唯一性）的法定依据。',
    referenced_by: ['__COMMON__'],
  },
  {
    code: 'MEE-REG-RULES',
    title: '《温室气体自愿减排注册登记规则（试行）》与《温室气体自愿减排项目设计与实施指南》',
    kind: '配套规则',
    issuing_authority: '国家应对气候变化战略研究和国际合作中心（全国温室气体自愿减排注册登记机构）',
    official_url: 'https://ccer.cets.org.cn/notice/noticeDetail?bulletinInfoId=1174755335156666368',
    verified: true,
    note: '项目设计、监测计划、登记流程与材料要求的操作层依据。',
    referenced_by: [],
  },
];

export function standardCodes() {
  return {
    standards: STANDARD_CODES,
    pending_verification: STANDARD_CODES.filter((s) => !s.verified).map((s) => s.code),
    note:
      '凡 verified=false 的条目表示编号或版本尚未从官方原文核实，不得用于计算口径判定；' +
      '对应条目已列入 docs/11-领域专家确认清单.md。',
  };
}
