/**
 * 平台问答 · 库内检索服务（retrieval-svc）
 * ============================================================================
 * 需求（docs/44 第 6 条）：
 *   - 服务端**先检索系统公开数据库**（政策、方法学、项目、CCER/CEA 交易、
 *     研报、因子、规范、CETS 问答等）；
 *   - 未找到或证据不足**再调用已有搜索/抓取服务**；
 *   - 优先库内事实；**最新/具体日期问题须校验时效和匹配**，不能只因有弱相关
 *     记录就禁止联网；
 *   - 网络请求必须使用原有 SSRF/白名单/超时/配额适配器（本模块自己不发起请求）。
 *
 * 本模块只做**只读**库内检索，返回可追溯证据（含原文定位所需的文本）。
 * 所有表名/列名来自下方白名单常量，**不接受调用方传入的表名或列名**。
 */
import { all } from '../core/db.mjs';
import { sourceDisplay } from './source-display-svc.mjs';
import {
  cnLabel, bodyRangeOf, POLICY_STATUS_LABELS, POLICY_CATEGORY_LABELS, PROJECT_STAGE_LABELS, METHODOLOGY_STATUS_LABELS,
  ACCOUNTING_STANDARD_STATUS_LABELS, PUBLIC_DOC_CATEGORY_LABELS, CEA_DOC_TYPE_LABELS,
  EMISSION_FACTOR_CATEGORY_LABELS,
} from '../data/internal-labels.mjs';

/** 单次检索最多命中的证据条数（硬上限）。 */
export const MAX_EVIDENCE = 8;
/** 每条证据提供给模型的最大字符数（避免超长提示）。 */
export const MAX_EVIDENCE_CHARS = 1800;
/** 每条证据用于关键词匹配/展示的正文摘要长度。 */
export const SNIPPET_CHARS = 700;

/**
 * 公开数据库检索白名单。
 * 每一项都硬编码表名与列名；检索只在这些表内进行。
 */
export const RETRIEVAL_SOURCES = [
  {
    key: 'policy', entity_type: 'policy_document', label: '政策文件',
    sql: `SELECT id, title, doc_number AS sub, issuing_authority AS org, publish_date AS date,
                 official_url AS url, summary, body_snapshot AS body, doc_status, category
          FROM policy_document WHERE duplicate_of IS NULL`,
    title_col: 'title', q_cols: ['title', 'doc_number', 'issuing_authority', 'summary', 'body_snapshot'],
    detail(r) {
      return [
        r.sub ? `文号 ${r.sub}` : null,
        r.org,
        r.category ? cnLabel(POLICY_CATEGORY_LABELS, r.category) : null,
        r.doc_status ? cnLabel(POLICY_STATUS_LABELS, r.doc_status) : null,
        r.summary,
      ].filter(Boolean).join('｜');
    },
    drill: (r) => `#/policies?tab=policies&keyword=${encodeURIComponent(r.title || '')}`,
  },
  {
    key: 'methodology', entity_type: 'methodology_version', label: '方法学',
    sql: `SELECT id, name AS title, code_display AS sub, domain AS org, release_date AS date,
                 official_url AS url, evidence_note AS summary, body_snapshot AS body, document_status
          FROM methodology_version`,
    title_col: 'name', q_cols: ['name', 'code_display', 'methodology_id', 'domain', 'evidence_note', 'body_snapshot'],
    detail(r) {
      return [
        r.sub ? `编号 ${r.sub}` : null, r.org,
        r.document_status ? cnLabel(METHODOLOGY_STATUS_LABELS, r.document_status) : null,
      ].filter(Boolean).join('｜');
    },
    drill: (r) => `#/policies?tab=methodologies&methodology_id=${encodeURIComponent(r.id || '')}`,
  },
  {
    key: 'project', entity_type: 'public_project', label: '公开项目',
    sql: `SELECT id, name AS title, registry_project_no AS sub, province AS org, COALESCE(last_checked_at, updated_at) AS date,
                 official_url AS url, note AS summary, NULL AS body, current_stage, methodology_id, owner_announced_estimate
          FROM public_project WHERE COALESCE(is_demo,0)=0`,
    title_col: 'name', q_cols: ['name', 'registry_project_no', 'province', 'domain', 'methodology_id', 'owner_name', 'note'],
    detail(r) {
      return [
        r.sub, r.org,
        r.current_stage ? cnLabel(PROJECT_STAGE_LABELS, r.current_stage) : null,
        r.methodology_id,
      ].filter(Boolean).join('｜');
    },
    drill: (r) => `#/projects?tab=public&q=${encodeURIComponent(r.title || '')}`,
  },
  {
    key: 'content', entity_type: 'content_item', label: '研报与行业动态',
    sql: `SELECT id, title, publisher AS sub, source_category AS org, published_at AS date,
                 source_url AS url, summary, body_snapshot AS body, body_availability
          FROM content_item
          WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' AND COALESCE(process_status,'')<>'failed_fetch'`,
    title_col: 'title', q_cols: ['title', 'publisher', 'summary', 'body_snapshot'],
    detail(r) { return [r.sub, r.summary].filter(Boolean).join('｜'); },
    drill: (r) => `#/content?q=${encodeURIComponent(String(r.title || '').slice(0, 24))}`,
  },
  {
    key: 'cea_document', entity_type: 'cea_document', label: 'CEA 政策与研报',
    sql: `SELECT id, title, issuer AS sub, doc_type AS org, publish_date AS date,
                 COALESCE(official_url, page_url) AS url, note AS summary, body_snapshot AS body, data_cutoff_date, evidence_level
          FROM cea_document`,
    title_col: 'title', q_cols: ['title', 'issuer', 'note', 'body_snapshot'],
    detail(r) {
      return [
        r.sub,
        r.org ? cnLabel(CEA_DOC_TYPE_LABELS, r.org) : null,
        r.data_cutoff_date ? `数据截止 ${r.data_cutoff_date}` : null,
      ].filter(Boolean).join('｜');
    },
    drill: (r) => `#/cea?tab=docs&q=${encodeURIComponent(r.title || '')}`,
  },
  {
    key: 'cea_trade', entity_type: 'cea_trade_daily', label: 'CEA 行情',
    sql: `SELECT id, trade_date AS title, instrument AS sub, session_state AS org, trade_date AS date,
                 source_url AS url, NULL AS summary, NULL AS body, close, total_volume, total_turnover, computed_avg_price
          FROM cea_trade_daily`,
    title_col: 'trade_date', q_cols: ['trade_date', 'instrument', 'price_regime', 'source_url'],
    date_col: 'trade_date',
    detail(r) {
      return [
        r.close !== null && r.close !== undefined ? `综合收盘价 ${r.close} 元/吨` : null,
        r.total_volume !== null && r.total_volume !== undefined ? `总成交量 ${r.total_volume} 吨` : null,
        r.computed_avg_price !== null && r.computed_avg_price !== undefined ? `全方式均价 ${r.computed_avg_price} 元/吨` : null,
      ].filter(Boolean).join('｜');
    },
    drill: (r) => `#/cea?tab=quote&from=${r.date}&to=${r.date}`,
  },
  {
    key: 'trade', entity_type: 'trade_daily', label: 'CCER 行情',
    sql: `SELECT id, trade_date AS title, trade_method AS sub, session_state AS org, trade_date AS date,
                 source_url AS url, NULL AS summary, NULL AS body, volume, turnover, avg_price
          FROM trade_daily`,
    title_col: 'trade_date', q_cols: ['trade_date', 'trade_method', 'note', 'source_url'],
    date_col: 'trade_date',
    detail(r) {
      return [
        r.volume !== null && r.volume !== undefined ? `成交量 ${r.volume} tCO2e` : null,
        r.avg_price !== null && r.avg_price !== undefined ? `成交均价 ${r.avg_price} 元/tCO2e` : null,
        r.turnover !== null && r.turnover !== undefined ? `成交额 ${r.turnover} 元` : null,
      ].filter(Boolean).join('｜');
    },
    drill: (r) => `#/trades?from=${r.date}&to=${r.date}`,
  },
  {
    key: 'factor', entity_type: 'emission_factor', label: '公开排放因子',
    sql: `SELECT id, name AS title, original_unit AS sub, category AS org, publish_date AS date,
                 original_url AS url, caliber AS summary, NULL AS body, value, data_year, region
          FROM emission_factor WHERE is_current=1`,
    title_col: 'name', q_cols: ['name', 'category', 'region', 'source_code', 'caliber', 'locator'],
    detail(r) {
      return [
        r.value !== null && r.value !== undefined ? `${r.value} ${r.sub || ''}`.trim() : null,
        r.data_year ? `${r.data_year} 年` : null,
        r.region,
        r.org ? cnLabel(EMISSION_FACTOR_CATEGORY_LABELS, r.org) : null,
      ].filter(Boolean).join('｜');
    },
    drill: () => '#/measure?tab=factors',
  },
  {
    key: 'standard', entity_type: 'accounting_standard', label: '标准规范',
    sql: `SELECT id, title, code AS sub, sector AS org, publish_date AS date,
                 COALESCE(original_url, announcement_url, source_locator) AS url, NULL AS summary, body_text AS body, status, body_status
          FROM accounting_standard`,
    title_col: 'title', q_cols: ['title', 'code', 'sector', 'body_text'],
    detail(r) {
      return [
        r.sub, r.org,
        r.status ? cnLabel(ACCOUNTING_STANDARD_STATUS_LABELS, r.status) : null,
      ].filter(Boolean).join('｜');
    },
    drill: () => '#/measure?tab=standards',
  },
  {
    key: 'public_doc', entity_type: 'accounting_public_document', label: '公开资料与 CETS 问答',
    sql: `SELECT id, title, issuer AS sub, category AS org, published_at AS date,
                 url, limitation AS summary, body_text AS body, doc_type, body_status
          FROM accounting_public_document WHERE is_current=1`,
    title_col: 'title', q_cols: ['title', 'issuer', 'category', 'body_text'],
    detail(r) {
      return [
        r.sub,
        r.org ? cnLabel(PUBLIC_DOC_CATEGORY_LABELS, r.org) : null,
        r.limitation,
      ].filter(Boolean).join('｜');
    },
    drill: () => '#/measure?tab=public',
  },
  {
    key: 'public_qa', entity_type: 'accounting_public_qa', label: '公开问答原文',
    sql: `SELECT q.id, q.question AS title, q.category AS sub, d.issuer AS org, d.published_at AS date,
                 q.source_url AS url, NULL AS summary, q.answer AS body, d.body_status
          FROM accounting_public_qa q JOIN accounting_public_document d ON d.id = q.document_id
          WHERE d.is_current=1`,
    title_col: 'question', q_cols: ['q.question', 'q.answer', 'q.category'],
    detail(r) { return [r.sub, r.org].filter(Boolean).join('｜'); },
    drill: () => '#/measure?tab=public',
  },
  {
    key: 'entity', entity_type: 'cea_entity', label: 'CEA 重点排放单位名录',
    sql: `SELECT id, name AS title, credit_code AS sub, sector AS org, data_as_of AS date,
                 source_url AS url, NULL AS summary, NULL AS body, province, city, list_year, verify_status
          FROM cea_entity`,
    title_col: 'name', q_cols: ['name', 'credit_code', 'province', 'city', 'sector'],
    date_col: 'data_as_of',
    detail(r) {
      return [
        r.province, r.city, r.org,
        r.list_year ? `${r.list_year} 年名录` : null,
        r.verify_status ? `核验状态 ${r.verify_status}` : null,
      ].filter(Boolean).join('｜');
    },
    drill: (r) => `#/cea?tab=entities&q=${encodeURIComponent(r.title || '')}`,
  },
];

const STOP_WORDS = new Set([
  '什么', '哪些', '怎么', '如何', '是否', '多少', '为什么', '可以', '有没有', '请问', '介绍', '一下',
  '现在', '目前', '最新', '情况', '相关', '关于', '以及', '还有', '这个', '那个', '我们', '他们',
]);

/** 从问题里抽取检索词（中文按 2—6 字滑窗，英文/数字按词）。
 * 关键修正（docs/46 第 5 条）：不能只取句首长滑窗而丢掉句尾核心词，
 * 因此首尾都取样，并保留 2—3 字的核心短词。
 */
export function extractTerms(question, { max = 14 } = {}) {
  const q = String(question || '').replace(/[\s\p{P}]+/gu, ' ').trim();
  const terms = new Set();
  const addChunkWindows = (han) => {
    for (let n = Math.min(6, han.length); n >= 2; n -= 1) {
      const windows = [];
      for (let i = 0; i + n <= han.length; i += 1) windows.push(han.slice(i, i + n));
      if (!windows.length) continue;
      // 首 3 个 + 尾 3 个窗口：句尾的核心词不会被截掉
      for (const t of [...windows.slice(0, 3), ...windows.slice(-3)]) {
        if (STOP_WORDS.has(t)) continue;
        terms.add(t);
      }
    }
  };
  for (const chunk of q.split(' ')) {
    if (!chunk) continue;
    if (/^[A-Za-z0-9%.\-]+$/.test(chunk)) {
      if (chunk.length >= 2) terms.add(chunk.toLowerCase());
      continue;
    }
    const han = chunk.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    if (!han) continue;
    if (han.length <= 6) terms.add(han);
    addChunkWindows(han);
  }
  // 长词优先，避免「碳市场」被「市场」之类的碎片淹没
  return [...terms].sort((a, b) => b.length - a.length).slice(0, max);
}

/** 问题中出现的 4 位年份（用于时效校验）。 */
export function extractYears(question) {
  const years = [...String(question || '').matchAll(/(19|20)\d{2}/g)].map((m) => Number(m[0]));
  return [...new Set(years)].filter((y) => y >= 1990 && y <= 2100);
}

/**
 * 问题中出现的**具体日期**（docs/46 第 5 条：只判断年份不够）。
 * 支持 2026-10-16 / 2026年10月16日 / 2026/10/16 / 10月16日（按当年计）以及「今天 / 昨天」。
 * @returns {string[]} YYYY-MM-DD 列表
 */
export function extractDates(question, { today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) } = {}) {
  const q = String(question || '');
  const out = new Set();
  for (const m of q.matchAll(/((?:19|20)\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/g)) {
    out.add(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`);
  }
  if (!out.size) {
    for (const m of q.matchAll(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
      out.add(`${today.slice(0, 4)}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`);
    }
  }
  if (/今天|今日/.test(q)) out.add(today);
  if (/昨天|昨日/.test(q)) {
    out.add(new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10));
  }
  return [...out].filter((d) => Number.isFinite(Date.parse(`${d}T00:00:00Z`)));
}

/** 问题是否要求「最新 / 当前」时效。 */
export function wantsLatest(question) {
  return /最新|目前|当前|今年|今天|今日|本月|本周|现在|近期|截至/.test(String(question || ''));
}

/** 问题是否属于行情 / 时效敏感类（价格、成交、行情、收盘…）。 */
export function isMarketQuestion(question) {
  return /行情|价格|成交|成交量|成交额|收盘|开盘|均价|配额价|元\/吨|元每吨/.test(String(question || ''));
}

/**
 * 问题是否在问**行情数值**（收盘价 / 开盘价 / 均价 / 成交量 / 成交额…）。
 *
 * 只有这类问题才要求「相应市场 + 日期匹配」的行情证据：政策、研报、方法学
 * 即便同年度或标题相关，也不能充当某一天收盘价/成交量的依据，更不能因为
 * 库内有它们就算「证据充分」而阻止联网（docs/44 第 6 条）。
 *
 * 泛泛问「价格机制/配额价格如何确定」不属于行情数值问题，仍按通用文档检索。
 */
export function needsMarketQuote(question) {
  const q = String(question || '');
  if (!isMarketQuestion(q)) return false;
  if (/收盘|开盘|最高价|最低价|成交价|成交均价|均价|成交量|成交额|报价|行情|吨价|元\/吨|元每吨/.test(q)) return true;
  // 单说「价格」可能只是问机制：必须带数值意图（是多少 / 什么价格…）才算行情数值问题
  return /价格(?:是|为)?多少|价格是多少|什么价格|价格为多少|多少钱/.test(q);
}

/** 行情来源与市场的对应关系（白名单内固定）。 */
const MARKET_OF_SOURCE = { cea_trade: 'cea', trade: 'ccer' };

/**
 * 问题指向哪个市场的行情：CEA（全国碳市场）还是 CCER（自愿减排）。
 * 两个都提到 → 两个市场的行情都算；都没提到 → 不限定市场。
 */
export function marketScopeOf(question) {
  const q = String(question || '');
  const cea = /(?:^|[^a-z])cea(?:[^a-z]|$)/i.test(q)
    || /全国碳市场|全国碳排放权|碳排放权交易|配额市场/.test(q);
  const ccer = /CCER|自愿减排|减排量交易/i.test(q);
  return { cea, ccer };
}

/** 该行情来源是否属于问题所指的市场（问题未点市场时不限定）。 */
function sourceMatchesMarket(scope, sourceKey) {
  const market = MARKET_OF_SOURCE[sourceKey];
  if (!market) return false;
  if (!scope.cea && !scope.ccer) return true;
  return market === 'cea' ? scope.cea : scope.ccer;
}

/** 时效敏感来源（行情类）：其日期必须与问题指向的日期精确匹配。 */
const TIME_SENSITIVE_SOURCES = new Set(['trade', 'cea_trade']);
/** 「最新」类问题可接受的最大数据陈旧天数（超过即视为证据不足，必须联网）。 */
export const LATEST_STALE_DAYS = 7;

function scoreRow(row, terms, meta) {
  // 匹配前统一去掉空白：数据库文本里常写成「2023 年全国电力…」，
  // 而提问写成「2023年全国电力…」，不归一化会漏掉真实命中。
  const strip = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const title = strip(row.title);
  const extra = strip([row.sub, row.org, row.summary, row.detail_blob].filter(Boolean).join(' '));
  const body = strip(row.body);
  let score = 0;
  const hits = [];
  for (const t of terms) {
    const tl = strip(t);
    if (!tl) continue;
    if (title.includes(tl)) { score += 6; hits.push(t); continue; }
    if (extra.includes(tl)) { score += 2; hits.push(t); continue; }
    if (body && body.includes(tl)) { score += 1; hits.push(t); }
  }
  // 精确子串加分：问题本身出现在标题里
  const raw = strip(meta.rawQuestion);
  if (raw && title.includes(raw)) score += 8;
  return { score, hits: [...new Set(hits)] };
}

/** SQL 侧参与 LIKE 的检索词：长词优先，再补短词以提高召回。 */
export function pickSqlTerms(terms, max = 10) {
  const long = terms.filter((t) => t.length >= 4).slice(0, Math.ceil(max / 2));
  const short = terms.filter((t) => t.length <= 3).slice(0, max - long.length);
  return [...new Set([...long, ...short])].slice(0, max);
}

/**
 * 证据的正文完整度（docs/46 第 12 条）：按库内 body_status / body_availability /
 * evidence_level 判定，**不能只凭正文长度就当作完整正文**。
 * full_text | partial_text | summary | metadata
 */
function kindOf(row) {
  const body = String(row.body || '');
  const range = bodyRangeOf(row.body_status);
  if (range === 'partial_text') return body.length >= 200 ? 'partial_text' : (row.summary ? 'summary' : 'metadata');
  if (range === 'summary_only') return 'summary';
  if (range === 'metadata_only') return body.length >= 200 ? 'partial_text' : (row.summary ? 'summary' : 'metadata');
  if (range === 'full_text') return body.length >= 200 ? 'full_text' : (row.summary ? 'summary' : 'metadata');
  if (body.length >= 200) return 'full_text';
  if (row.summary) return 'summary';
  return 'metadata';
}

/** 正文完整度的中文标签（提示词与前端共用口径）。 */
export function kindLabel(kind) {
  return kind === 'full_text' ? '已获取正文'
    : kind === 'partial_text' ? '部分正文（非全文）'
      : kind === 'search_snippet' ? '搜索摘要（非全文）'
        : kind === 'summary' ? '来源摘要（非全文）'
          : kind === 'calculated' ? '程序计算'
            : '仅元数据';
}

/**
 * 库内检索（只读）。
 * @returns {{evidence:Array, weak:boolean, reason:string|null, terms:Array, years:Array}}
 */
export function retrieveEvidence(question, { limit = MAX_EVIDENCE, sources = null } = {}) {
  const terms = extractTerms(question);
  const years = extractYears(question);
  const dates = extractDates(question);
  const latest = wantsLatest(question);
  const marketQ = isMarketQuestion(question);
  const quoteQ = needsMarketQuote(question);
  const marketScope = marketScopeOf(question);
  const rawQuestion = String(question || '').trim().slice(0, 60);
  const picked = sources ? RETRIEVAL_SOURCES.filter((s) => sources.includes(s.key)) : RETRIEVAL_SOURCES;
  const out = [];
  const perSource = new Map();
  const sourceErrors = [];

  for (const src of picked) {
    const timeSensitive = TIME_SENSITIVE_SOURCES.has(src.key);
    const where = [];
    const params = [];
    // 去掉空白后比较：来源正文里的「2023 年全国…」与提问的「2023年全国…」视为同一串
    const norm = (col) => `REPLACE(COALESCE(${col},''),' ','')`;
    for (const col of src.q_cols) {
      where.push(`${norm(col)} LIKE ?`);
      params.push(`%${rawQuestion.replace(/\s+/g, '')}%`);
    }
    for (const t of pickSqlTerms(terms)) {
      const needle = `%${t.replace(/\s+/g, '')}%`;
      for (const col of src.q_cols) {
        where.push(`${norm(col)} LIKE ?`);
        params.push(needle);
      }
    }
    // 行情类来源：问题里出现的具体日期单独作为等值条件（2026年10月16日 → 2026-10-16）
    if (timeSensitive && dates.length) {
      where.push(`${src.date_col} IN (${dates.map(() => '?').join(',')})`);
      params.push(...dates);
    }
    let rows = [];
    try {
      // 行情类来源按日期倒序：SQL 不排序 + LIMIT 会把最新记录漏掉（docs/46 第 5 条）
      const order = timeSensitive && src.date_col ? ` ORDER BY ${src.date_col} DESC` : '';
      rows = all(
        `${src.sql}${src.sql.includes('WHERE') ? ' AND' : ' WHERE'} (${where.join(' OR ')})${order} LIMIT 40`,
        params
      );
    } catch (e) {
      rows = [];
      // 表/字段不可用不是「没有公开信息」：如实记录来源错误，供问答避免误判。
      sourceErrors.push({ source: src.key, label: src.label, message: String(e.message || e).slice(0, 200) });
    }
    // 行情类问题：额外把**最新**的行情记录作为候选（保证「最新价」能拿到真实最新行），
    // 其时效是否可用于回答由下面统一的时效校验判定。
    if (timeSensitive && (marketQ || latest) && !dates.length && rows.length < 3) {
      try {
        const extra = all(`${src.sql} ORDER BY ${src.date_col} DESC LIMIT 2`);
        const seen = new Set(rows.map((r) => String(r.id)));
        for (const r of extra) if (!seen.has(String(r.id))) rows.push(r);
      } catch {
        /* 该来源不可用时忽略 */
      }
    }
    perSource.set(src.key, rows.length);
    for (const r of rows) {
      const detail = src.detail(r) || '';
      const scored = scoreRow({ ...r, detail_blob: detail }, terms, { rawQuestion });
      const dateStr = String(r.date || '').slice(0, 10);
      const yearHit = years.length
        ? years.some((y) => dateStr.includes(String(y)) || `${r.title} ${detail}`.includes(String(y)))
        : null;
      const dateHit = dates.length
        ? dates.includes(dateStr)
        : null;
      // 行情来源需要日期精确匹配；非行情来源按年份匹配即可（年份也没提则不约束）
      const timeMatch = timeSensitive
        ? (dates.length ? dateHit === true : true)
        : (years.length ? yearHit !== false : true);
      // 关键词没命中但作为「最新行情」候选被纳入的行，也给一个基础分，避免被直接丢掉
      const baseScore = scored.score > 0 ? scored.score : (timeSensitive ? 3 : 0);
      if (baseScore <= 0) continue;
      out.push({
        source_key: src.key,
        source_id: `${src.key}:${r.id}`,
        entity_type: src.entity_type,
        entity_id: String(r.id),
        label: src.label,
        title: String(r.title || '').slice(0, 200),
        url: r.url || null,
        published_at: dateStr || null,
        collected_at: null,
        origin: 'db',
        kind: kindOf(r),
        snippet: detail.slice(0, SNIPPET_CHARS),
        text: String(r.body || '').slice(0, MAX_EVIDENCE_CHARS) || null,
        drill: src.drill ? src.drill(r) : null,
        time_sensitive: timeSensitive,
        year_match: yearHit,
        date_match: dateHit,
        _timeMatch: timeMatch,
        _score: baseScore + (yearHit ? 4 : 0) + (dateHit ? 8 : 0) + (latest && dateStr ? recencyBoost(dateStr) : 0)
          // 行情数值问题：问题所指日期 + 相应市场的行情必须排在最前，
          // 确保它真的进入给模型的证据列表（不被同年度政策/研报挤掉）。
          + (quoteQ && timeSensitive && dateHit === true && sourceMatchesMarket(marketScope, src.key) ? 50 : 0),
        _hits: scored.hits,
      });
    }
  }

  // 同一实体只保留最高分
  const byId = new Map();
  for (const e of out) {
    const cur = byId.get(e.source_id);
    if (!cur || e._score > cur._score) byId.set(e.source_id, e);
  }
  const ranked = [...byId.values()].sort((a, b) => b._score - a._score).slice(0, Math.max(1, Math.min(Number(limit) || MAX_EVIDENCE, MAX_EVIDENCE)));

  /* ---------------- 时效校验（年份 / 具体日期 / 最新） ---------------- */
  const marketEvidence = ranked.filter((e) => e.time_sensitive);
  // 1) 指定年份时，没有任何证据命中该年份 → 证据不足
  const yearMismatch = years.length > 0 && ranked.length > 0 && ranked.every((e) => e.year_match === false);
  // 2) 指定具体日期时，行情证据必须精确命中该日期，否则不能用其它日期的数据回答
  const dateMismatch = dates.length > 0 && marketEvidence.length > 0 && marketEvidence.every((e) => e.date_match !== true);
  // 3) 「最新 / 当前」问题：库内行情证据过旧 → 不足以回答，必须联网
  let staleLatest = false;
  let newestMarketDate = null;
  if ((latest || marketQ) && marketEvidence.length) {
    const dts = marketEvidence.map((e) => e.published_at).filter(Boolean).sort();
    newestMarketDate = dts[dts.length - 1] || null;
    if (latest && newestMarketDate) {
      const ageDays = (Date.now() - Date.parse(`${newestMarketDate}T00:00:00Z`)) / 86400000;
      staleLatest = ageDays > LATEST_STALE_DAYS;
    }
  }
  /**
   * 4) 行情数值问题（收盘价 / 开盘价 / 均价 / 成交量 / 成交额…）：
   *    必须存在**相应市场且日期匹配**的行情证据（问具体日期就要求当日行情）。
   *    同年度政策 / 研报 / 方法学只是标题或年份相关，不能充当行情数值的依据，
   *    也不能因为库内有它们就判为「证据充分」而跳过联网（docs/44 第 6 条）。
   */
  const scopedMarket = marketEvidence.filter((e) => sourceMatchesMarket(marketScope, e.source_key));
  const scopedDated = dates.length ? scopedMarket.filter((e) => e.date_match === true) : scopedMarket;
  const missingQuote = quoteQ && scopedDated.length === 0;
  const scopeLabel = marketScope.cea && !marketScope.ccer ? 'CEA '
    : marketScope.ccer && !marketScope.cea ? 'CCER ' : '';
  const strong = ranked.filter((e) => e._score >= 6);
  const weak = ranked.length === 0 || strong.length === 0 || yearMismatch || dateMismatch || staleLatest || missingQuote;

  const reason = ranked.length === 0
    ? (sourceErrors.length
      ? `库内检索有 ${sourceErrors.length} 个来源执行失败（${sourceErrors.map((x) => x.label).join('、')}），` +
        '不能据此判断没有公开信息；可稍后重试或查看对应数据源状态'
      : dates.length
        ? `库内没有 ${dates.join('/')} 的匹配记录（行情类问题不得用其它日期的数据回答）`
        : '库内没有可检索的匹配记录')
    : strong.length === 0
      ? '库内仅有弱相关记录（未达到可用证据阈值）'
      : yearMismatch
        ? '库内记录的时间与问题指向的年份不一致（不得用旧年份数据回答）'
        : dateMismatch
          ? `库内没有 ${dates.join('/')} 的行情记录（不得用其它日期的行情回答）`
          : staleLatest
            ? `库内最新行情为 ${newestMarketDate}，已超过 ${LATEST_STALE_DAYS} 天，不足以回答「最新」问题`
            : missingQuote
              ? (dates.length
                ? `库内没有 ${dates.join('/')} 的${scopeLabel}行情证据（政策、研报不能代替行情数值）`
                : `库内没有匹配的${scopeLabel}行情证据（政策、研报不能代替行情数值）`)
              : null;

  return {
    evidence: ranked.map(({ _score, _hits, _timeMatch, ...rest }) => ({
      ...rest,
      score: _score,
      matched_terms: _hits,
      source_display: sourceDisplay({ url: rest.url, publisher: rest.label }),
    })),
    weak,
    reason,
    terms,
    years,
    dates,
    newest_market_date: newestMarketDate,
    per_source: Object.fromEntries(perSource),
    source_errors: sourceErrors,
  };
}

function recencyBoost(date) {
  const t = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  if (days < 0) return 0;
  if (days <= 90) return 3;
  if (days <= 365) return 1.5;
  return 0;
}

/** 供提示词使用的证据块（数据，不是指令）。 */
export function evidenceForPrompt(evidence) {
  return evidence.map((e) => {
    const head = [
      `[${e.source_id}] 来源类型：${e.origin === 'db' ? '系统公开数据库' : '联网检索'}`,
      `标题：${e.title}`,
      e.published_at ? `日期：${e.published_at}` : '日期：来源未标注',
      e.url ? `原文链接：${e.url}` : '原文链接：无',
      `内容完整度：${kindLabel(e.kind)}`,
    ].join('\n');
    const body = e.text ? `正文（截取）：\n${e.text}` : `摘要/字段：\n${e.snippet || '（无）'}`;
    return `${head}\n${body}`;
  }).join('\n\n---\n\n');
}
