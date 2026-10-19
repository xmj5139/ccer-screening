/**
 * 导入 / 导出模板定义（v2）
 * ============================================================================
 * 需求规格 1.3 / 1.4 / 第 2 节：
 *   - 无法稳定自动获取的数据（注册登记系统项目列表、交易行情人工摘录）必须提供
 *     可核实的「人工导入模板」，导入时逐行校验并生成核对任务；
 *   - 模板必须自带字段口径、单位、必填性与示例，避免线下表格口径漂移。
 *
 * 本文件同时提供零依赖的 CSV 解析（支持引号、换行、BOM）与行级校验，
 * 供 /api/v2/import/* 与 scripts 使用。
 */

/** 交易日行情导入模板（来源：全国温室气体自愿减排交易系统每日行情公告） */
export const TRADE_DAILY_TEMPLATE = {
  key: 'trade-daily',
  name: '每日行情导入模板',
  purpose:
    '用于官方页面人工摘录或授权数据导入。每行一个「交易日 × 交易方式」，' +
    '系统会校验成交量×均价的加总关系、与累计值的差分关系，并保留原始公告链接。',
  source_note:
    '官方来源：https://www.ccer.com.cn/wcm/ccer/html/2502lshq/index.html （每日行情）。' +
    '导入后逐条进入「待核对」，人工确认后才计入正式口径。',
  columns: [
    { key: 'trade_date', label: '交易日期', unit: 'YYYY-MM-DD', required: true, definition: '官方公告披露的交易日期（不是抓取日期）' },
    { key: 'trade_method', label: '交易方式', required: false, definition: '来源实际字段；官方未区分时留空，系统按「官方合计（未区分交易方式）」存储' },
    { key: 'volume', label: '成交量', unit: 'tCO₂e', required: true, definition: '当日成交量；0 表示有交易日但无成交；留空表示数据暂缺' },
    { key: 'turnover', label: '成交额', unit: '元', required: false, definition: '当日成交额（官方披露值）' },
    { key: 'avg_price', label: '成交均价', unit: '元/tCO₂e', required: false, definition: '官方披露的当日成交均价；不是收盘价。留空时系统不自行补值' },
    { key: 'session_state', label: '交易状态', required: false, definition: 'traded 有成交 / no_trade 无成交 / closed 休市 / missing 数据暂缺；留空由系统按成交量推断' },
    { key: 'source_url', label: '官方公告链接', required: false, definition: '该行数据的官方出处 URL' },
    { key: 'published_at', label: '官方发布时间', required: false, definition: '公告发布时间（YYYY-MM-DD HH:mm:ss）' },
    { key: 'note', label: '备注', required: false, definition: '摘录人、修订原因等' },
  ],
  example: [
    '2026-09-23,官方合计（未区分交易方式）,122,10497.10,86.04,traded,https://www.ccer.com.cn/wcm/ccer/html/2502lshq/20260923/153004998.shtml,2026-09-23 16:43:34,',
  ],
};

/** 公开项目库导入模板（来源：注册登记系统项目公示/登记页面人工导出） */
export const PUBLIC_PROJECT_TEMPLATE = {
  key: 'public-project',
  name: '公开项目导入模板',
  purpose:
    '注册登记系统的项目列表未提供第三方稳定接口，由研究员按周导出/摘录后上传。' +
    '系统逐行校验唯一 ID、阶段分列与「公示预计量 / 核查量 / 登记量」三类数字分离，' +
    '并生成待核对任务；未核对前证据等级一律为「待核实」。',
  source_note: '官方来源：https://ccer.cets.org.cn/ （项目公示、项目登记、减排量登记公开页面）',
  columns: [
    { key: 'registry_project_no', label: '官方项目 ID / 登记编号', required: true, definition: '注册登记系统的项目唯一标识；同名异项必须靠它区分' },
    { key: 'name', label: '项目名称', required: true, definition: '官方公示名称' },
    { key: 'owner_name', label: '项目业主', required: false, definition: '官方公示的业主名称' },
    { key: 'owner_credit_code', label: '统一社会信用代码', required: false, definition: '用于识别业主变更与重复申报' },
    { key: 'province', label: '省份', required: false, definition: '项目所在省级行政区' },
    { key: 'city', label: '城市', required: false, definition: '项目所在城市' },
    { key: 'domain', label: '领域', required: false, definition: '方法学领域，例如 燃料逸散性排放 / 林业和其他碳汇类型' },
    { key: 'industry', label: '行业', required: false, definition: '国民经济行业分类口径（有则填）' },
    { key: 'methodology_id', label: '方法学编号', required: false, definition: '例如 CCER-10-001；未核实编号时留空，系统不推测' },
    { key: 'methodology_version', label: '方法学版本', required: false, definition: '例如 V01' },
    { key: 'technology_route', label: '技术路线', required: false, definition: '例如 无焰氧化+发电' },
    { key: 'start_operation_date', label: '开工/投产时间', required: false, definition: 'YYYY-MM-DD' },
    { key: 'stage_project_public', label: '项目公示', unit: '1/0', required: false, definition: '是否已发生项目公示' },
    { key: 'stage_validated', label: '审定', unit: '1/0', required: false, definition: '是否已审定' },
    { key: 'stage_project_registered', label: '项目登记', unit: '1/0', required: false, definition: '是否已项目登记' },
    { key: 'stage_reduction_public', label: '减排量公示', unit: '1/0', required: false, definition: '是否已减排量公示' },
    { key: 'stage_verified', label: '核查', unit: '1/0', required: false, definition: '是否已核查' },
    { key: 'stage_reduction_registered', label: '减排量登记', unit: '1/0', required: false, definition: '是否已减排量登记' },
    { key: 'owner_announced_estimate', label: '业主公示预计量', unit: 'tCO₂e', required: false, definition: '业主公示的预计减排量；**不得**当作登记量' },
    { key: 'verified_amount', label: '核查确定量', unit: 'tCO₂e', required: false, definition: '核查机构确定的减排量' },
    { key: 'registered_amount', label: '减排量登记量', unit: 'tCO₂e', required: false, definition: '注册登记系统登记的减排量' },
    { key: 'official_url', label: '官方页面链接', required: false, definition: '该条目的官方公示/登记页面 URL' },
    { key: 'event_date', label: '最近事件日期', required: false, definition: '与当前阶段对应的官方事件日期' },
    { key: 'evidence_level', label: '证据等级', required: false, definition: 'official_registry / project_material / third_party / model_estimate / unverified（默认 unverified）' },
    { key: 'note', label: '备注', required: false, definition: '摘录人、核对情况等' },
  ],
  example: [
    'DEMO-REG-0001,某煤矿低浓度瓦斯利用项目,某煤业有限公司,91140000MA0XXXXXXX,山西省,晋城市,燃料逸散性排放,煤炭开采和洗选业,CCER-10-001,V01,无焰氧化+发电,2023-05-10,1,1,1,0,0,0,16262,,,https://ccer.cets.org.cn/,2025-06-30,unverified,示例行',
  ],
};

/** 机构内部项目库导入模板（机构自有资料，保密级别字段必填） */
export const INTERNAL_PROJECT_TEMPLATE = {
  key: 'internal-project',
  name: '机构内部项目导入模板',
  purpose: '批量登记机构内部项目档案；导入后进入「草稿」，须由责任人补充资料清单后提交复核。',
  source_note: '机构内部资料；导入内容不外发、不进入公开项目库。',
  columns: [
    { key: 'code', label: '内部编号', required: true, definition: '机构内部唯一编号' },
    { key: 'name', label: '项目名称', required: true, definition: '内部项目名称' },
    { key: 'owner_name', label: '业主', required: false, definition: '项目业主' },
    { key: 'province', label: '省份', required: false, definition: '项目所在省份' },
    { key: 'domain', label: '领域', required: false, definition: '方法学领域' },
    { key: 'methodology_id', label: '拟定方法学', required: false, definition: '初判方法学编号' },
    { key: 'stage', label: '当前阶段', required: false, definition: '内部跟踪阶段（与官方阶段分开记录）' },
    { key: 'owner_announced_estimate', label: '业主自述预计量', unit: 'tCO₂e', required: false, definition: '业主自述数字，仅作线索' },
    { key: 'team_id', label: '归属团队', required: false, definition: 'team-carbon / team-invest / team-other' },
    { key: 'analyst', label: '跟进负责人', required: false, definition: '分析师姓名' },
    { key: 'confidentiality', label: '保密级别', required: false, definition: 'internal / confidential / restricted' },
    { key: 'screening_conclusion', label: '筛选结论', required: false, definition: '初筛结论（可为空）' },
    { key: 'note', label: '备注', required: false, definition: '补充说明' },
  ],
  example: [
    'INV-2026-001,某油田伴生气回收项目,某石油公司,天津市,燃料逸散性排放,CCER-10-002,初筛,30000,team-invest,张分析师,internal,继续跟进,示例行',
  ],
};

export const IMPORT_TEMPLATES = {
  [TRADE_DAILY_TEMPLATE.key]: TRADE_DAILY_TEMPLATE,
  [PUBLIC_PROJECT_TEMPLATE.key]: PUBLIC_PROJECT_TEMPLATE,
  [INTERNAL_PROJECT_TEMPLATE.key]: INTERNAL_PROJECT_TEMPLATE,
};

export function getTemplate(key) {
  return IMPORT_TEMPLATES[key] || null;
}

export function templateCsv(key) {
  const t = getTemplate(key);
  if (!t) return null;
  const head = t.columns.map((c) => (c.unit ? `${c.label}(${c.unit})` : c.label)).join(',');
  const lines = [
    `# 模板：${t.name}`,
    `# 用途：${t.purpose}`,
    `# 来源：${t.source_note}`,
    `# 必填列：${t.columns.filter((c) => c.required).map((c) => c.label).join('、') || '（无）'}`,
    '# 说明：带 # 的行是注释行，导入时自动忽略；示例行可删除。',
    head,
    ...t.example,
    '',
    '# 字段定义',
    ...t.columns.map((c) => `# ${c.label}: ${c.definition}`),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/* ------------------------------ CSV 解析 ------------------------------ */

/**
 * 解析 CSV 文本（RFC4180 宽松实现：支持引号包裹、字段内换行与逗号、BOM、# 注释行）。
 * @param {string} text
 * @returns {string[][]} 行 × 单元格
 */
export function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let lineStart = true;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (lineStart && !quoted && (ch === '#' || (ch === '"' && false))) {
      // 注释行：跳到行尾
      while (i < src.length && src[i] !== '\n') i += 1;
      lineStart = true;
      continue;
    }
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      lineStart = false;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      lineStart = false;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      lineStart = true;
      continue;
    }
    cell += ch;
    lineStart = false;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // 去掉全空行
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/**
 * 按模板解析 CSV：以表头文字匹配列（容忍带单位后缀的写法）。
 * @returns {{rows:object[], errors:string[], matched_columns:string[], unknown_headers:string[]}}
 */
export function rowsFromCsv(templateKey, text) {
  const t = getTemplate(templateKey);
  if (!t) return { rows: [], errors: [`未知模板：${templateKey}`], matched_columns: [], unknown_headers: [] };
  const table = parseCsv(text);
  if (!table.length) return { rows: [], errors: ['文件为空'], matched_columns: [], unknown_headers: [] };
  const header = table[0].map((h) => String(h).trim());
  const idxByKey = new Map();
  const unknown = [];
  header.forEach((h, i) => {
    const bare = h.replace(/\(.*?\)\s*$/, '').trim();
    const col = t.columns.find((c) => c.label === h || c.label === bare || c.key === h);
    if (col) idxByKey.set(col.key, i);
    else if (h) unknown.push(h);
  });
  const missingRequired = t.columns.filter((c) => c.required && !idxByKey.has(c.key));
  const errors = [];
  if (missingRequired.length) {
    errors.push(`缺少必填列：${missingRequired.map((c) => c.label).join('、')}`);
  }
  const rows = [];
  for (let r = 1; r < table.length; r += 1) {
    const raw = table[r];
    const obj = { __row: r + 1 };
    let empty = true;
    for (const [key, i] of idxByKey.entries()) {
      const v = raw[i] === undefined ? '' : String(raw[i]).trim();
      obj[key] = v === '' ? null : v;
      if (v !== '') empty = false;
    }
    if (!empty) rows.push(obj);
  }
  return { rows, errors, matched_columns: [...idxByKey.keys()], unknown_headers: unknown };
}

/** 解析布尔/数值单元格 */
export function cellBool(v, dflt = 0) {
  if (v === null || v === undefined || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'y', 'yes', '是', '已'].includes(s)) return 1;
  if (['0', 'false', 'n', 'no', '否', '未'].includes(s)) return 0;
  return dflt;
}

export function cellNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
