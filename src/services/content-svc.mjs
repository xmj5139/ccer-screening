/**
 * 公开内容服务（content-svc）
 * ============================================================================
 * 承载「研报与行业动态」模块（docs/19 第 9、25、38—41、54 条）：
 *   - 收录政府政策与技术资料之外的 **公开研报、行业动态、机构观点、企业公告**；
 *   - 内容来源分类：证券/研究机构、行业协会、交易机构、碳市场专业媒体、企业公告；
 *   - 关键词组合检索（CCER、全国温室气体自愿减排、方法学、减排量登记、煤矿瓦斯、甲烷、
 *     碳汇、碳市场交易），按日期窗口与来源类别日更；
 *   - URL/内容哈希去重；同一篇多站转载**建关联、不重复统计**；
 *     原文变化保存版本与变化摘要；
 *   - 公开全文可归档；只有摘要或付费链接时保留元数据/公开摘要并标明，
 *     `body_availability` 明确写出「仅有摘要」，核验时不得声称读过全文。
 *
 * 【去重口径】统计一律 `is_demo=0 AND duplicate_of IS NULL`：
 *   演示条目与转载副本都不进入业务统计。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj, toIsoDate, todayCst, isDate } from '../core/util.mjs';
import { sha256, recordSnapshot } from './collect-svc.mjs';
import { canonicalizeUrl, pickSearchProvider } from './search-svc.mjs';
import { pickFetchConnection } from './web-fetch-svc.mjs';
import { runSearchWithFallback, fetchWithFallback } from './deepseek-fallback-svc.mjs';
import { verifyContentItem, verifyConfig, ensureBuiltinRules } from './verification-svc.mjs';

/* ==================================================================== */
/*  一、来源与关键词种子（官网可用性逐一验证后再作为种子来源）             */
/* ==================================================================== */

export const CONTENT_TYPES = {
  research_report: { label: '公开研报', tone: 'report' },
  industry_news: { label: '行业动态', tone: 'news' },
  institution_view: { label: '机构观点', tone: 'view' },
  enterprise_news: { label: '企业公告与项目主体新闻', tone: 'enterprise' },
  policy_notice: { label: '政策通告（非正式文件）', tone: 'notice' },
};

export const SOURCE_CATEGORIES = {
  official: { label: '政府 / 主管机构', tier: 'official_fact' },
  institution: { label: '证券 / 研究机构', tier: 'institution_analysis' },
  association: { label: '行业协会', tier: 'institution_analysis' },
  exchange: { label: '交易机构', tier: 'official_fact' },
  media: { label: '碳市场专业媒体', tier: 'media_report' },
  enterprise: { label: '企业公告与自述', tier: 'enterprise_claim' },
  unknown: { label: '未判定来源', tier: 'unknown' },
};

export const AUTHORITY_TIERS = {
  official_fact: '官方事实（主管部门/交易机构发布）',
  institution_analysis: '机构分析（研究机构/行业协会，属观点与分析）',
  media_report: '媒体报道（二次信息，需回溯原发）',
  enterprise_claim: '企业主张（不得标为政府确认）',
  unknown: '未判定',
};

/**
 * 非政府来源种子。
 * verified_at / website_status 字段记录**逐一验证官网可用性**的真实结果；
 * 未验证或不可用的来源不会进入自动采集（enabled=0）。
 * 二轮整改（docs/22 第 3 条）：按 docs/21 的真实来源核对——
 *   · ccer.com.cn 是**全国温室气体自愿减排交易系统**（交易机构），不是“中国碳排放交易网/media”；
 *   · 研究机构补入北京理工大学能源与环境政策研究中心原始发布页；
 *   · 券商首页无法验证的一律停用，不用无效首页冒充来源。
 */
export const SEED_SOURCES = [
  // —— 交易机构 / 行业协会 ——
  {
    id: 'src-cets', name: '全国温室气体自愿减排注册登记系统（CCER 官方）',
    url: 'https://ccer.cets.org.cn/', source_category: 'exchange',
    kinds: ['policy_notice', 'industry_news'], enabled: 1,
  },
  {
    id: 'src-ccer-com', name: '全国温室气体自愿减排交易系统（市场动态）',
    url: 'https://www.ccer.com.cn/', source_category: 'exchange',
    kinds: ['industry_news', 'policy_notice'], enabled: 1,
  },
  {
    id: 'src-cneeex', name: '上海环境能源交易所（全国碳市场）',
    url: 'https://www.cneeex.com/', source_category: 'exchange',
    kinds: ['industry_news', 'institution_view'], enabled: 1,
  },
  {
    id: 'src-cneeex-report', name: '上海环境能源交易所：碳市场报告栏目',
    url: 'https://overview.cneeex.com/tpfjy/xx/yjybg/tscbg/', source_category: 'exchange',
    kinds: ['research_report'], enabled: 1, is_index: true,
    note: '栏目页：应逐个读取内容页并过滤 CCER/碳市场相关性，不把整个栏目当一篇报告。',
  },
  // —— 政府 / 主管机构 ——
  {
    id: 'src-mee', name: '生态环境部（应对气候变化司）',
    url: 'https://www.mee.gov.cn/', source_category: 'official',
    kinds: ['policy_notice'], enabled: 1,
  },
  // —— 研究机构（原始发布页，不是券商转载首页） ——
  {
    id: 'src-bit-ceep', name: '北京理工大学能源与环境政策研究中心',
    url: 'https://ceep.bit.edu.cn/', source_category: 'institution',
    kinds: ['research_report', 'institution_view'], enabled: 1,
    note: 'docs/21 收录其《全球和中国碳市场回顾与展望（2026）》原始发布页；页面声明转载需事先同意，' +
      '平台只展示链接、元数据与简短摘要，不重新分发原 PDF。',
  },
  // —— 碳市场专业媒体 ——
  {
    id: 'src-tanpaifang', name: '碳排放交易网（行业动态）',
    url: 'https://www.tanpaifang.com/', source_category: 'media',
    kinds: ['industry_news'], enabled: 1,
  },
  {
    id: 'src-chinacarbon', name: '中国碳交易网',
    url: 'http://www.tanjiaoyi.com/', source_category: 'media',
    kinds: ['industry_news'], enabled: 1,
  },
  // —— 企业公告与项目主体新闻（企业自述，不得当作独立核证结论） ——
  {
    id: 'src-ctg', name: '三峡能源（企业公告与新闻）',
    url: 'https://www.ctg.com.cn/', source_category: 'enterprise',
    kinds: ['enterprise_news'], enabled: 1,
    note: 'docs/21 收录其获奖新闻；企业自述内容不得标为政府确认，须从正文再次确认日期。',
  },
  {
    id: 'src-ca-cws', name: '中国煤炭工业协会',
    url: 'https://www.chinacoal.gov.cn/', source_category: 'association',
    kinds: ['industry_news', 'institution_view'], enabled: 0,
  },
  {
    id: 'src-crea', name: '中国可再生能源学会',
    url: 'https://www.cresa.org.cn/', source_category: 'association',
    kinds: ['industry_news'], enabled: 0,
  },
  {
    id: 'src-hc', name: '华创证券研究报告（官网可用性未验证，停用）',
    url: 'https://www.hcyjs.com/', source_category: 'institution',
    kinds: ['research_report'], enabled: 0,
  },
  {
    id: 'src-cicc', name: '中金公司研究部（官网可用性未验证，停用）',
    url: 'https://www.cicc.com/', source_category: 'institution',
    kinds: ['research_report', 'institution_view'], enabled: 0,
  },
];

/** 关键词组合（不要只搜一个关键词） */
export const KEYWORD_GROUPS = [
  { key: 'ccer', label: 'CCER 基础', terms: ['CCER', '国家核证自愿减排量'] },
  { key: 'voluntary', label: '自愿减排机制', terms: ['全国温室气体自愿减排', '自愿减排交易市场'] },
  { key: 'methodology', label: '方法学', terms: ['CCER 方法学', '温室气体自愿减排方法学'] },
  { key: 'registration', label: '减排量登记', terms: ['减排量登记', 'CCER 登记'] },
  { key: 'coal-methane', label: '煤矿瓦斯', terms: ['煤矿瓦斯 减排', '瓦斯 利用 碳减排'] },
  { key: 'methane', label: '甲烷', terms: ['甲烷 减排 碳市场', '甲烷 排放 控制 政策'] },
  { key: 'sink', label: '碳汇', terms: ['林业碳汇 CCER', '碳汇 项目 开发'] },
  { key: 'market', label: '碳市场交易', terms: ['碳市场 成交量 价格', '全国碳市场 配额 交易'] },
];

/** 生成「关键词 × 来源类别」的检索组合 */
export function buildQueryPlan({ groups = null, categories = null, windowDays = 7, maxQueries = 24, rotationKey = todayCst() } = {}) {
  const gs = (groups && groups.length ? KEYWORD_GROUPS.filter((g) => groups.includes(g.key)) : KEYWORD_GROUPS);
  const cats = categories && categories.length ? categories : ['institution', 'association', 'exchange', 'media', 'enterprise'];
  const plan = [];
  // 先覆盖每个主题，再轮到同主题的第二个词。每日限额不足以跑完整计划时，
  // 不让排在数组末尾的碳汇、交易主题永久被截断。
  const depth = Math.max(0, ...gs.map((g) => g.terms.length));
  for (let i = 0; i < depth; i += 1) {
    // 第二轮起按日期轮换起点，使限额内没跑到的同义词次日获得机会。
    const offset = i === 0 || !gs.length ? 0 : Number(String(rotationKey).replace(/\D/g, '').slice(-6) || 0) % gs.length;
    for (let n = 0; n < gs.length; n += 1) {
      const g = gs[(n + offset) % gs.length];
      const term = g.terms[i];
      if (!term) continue;
      plan.push({ group: g.key, group_label: g.label, term, categories: cats, window_days: windowDays });
      if (plan.length >= maxQueries) return plan;
    }
  }
  return plan;
}

/** 从 URL 推断来源类别与可信度分层 */
export function classifySource(url, { publisher = null, hint = null } = {}) {
  if (hint && SOURCE_CATEGORIES[hint]) return { source_category: hint, authority_tier: SOURCE_CATEGORIES[hint].tier };
  let host = '';
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const official = ['gov.cn', 'mee.gov.cn', 'ndrc.gov.cn', 'nea.gov.cn'];
  // ccer.com.cn 是**全国温室气体自愿减排交易系统**（交易机构），不是媒体
  const exchange = ['cneeex.com', 'cets.org.cn', 'shcneeex.com', 'ccer.com.cn'];
  const association = ['org.cn', 'chinacoal.gov.cn'];
  const institution = ['cicc.com', 'hcyjs.com', 'htsc.com', 'citic.com', 'bit.edu.cn', 'research.'];
  const media = ['tanpaifang.com', 'tanjiaoyi.com', 'carbonnews', 'chinadialogue'];
  const enterprise = ['com.cn', 'cninfo.com.cn'];
  // 顺序很重要：登记系统 / 交易所先判，避免被 gov.cn 与 org.cn 的宽泛后缀抢先命中
  if (exchange.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { source_category: 'exchange', authority_tier: 'official_fact' };
  }
  if (official.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { source_category: 'official', authority_tier: 'official_fact' };
  }
  if (association.some((d) => host.endsWith(`.${d}`))) {
    return { source_category: 'association', authority_tier: 'institution_analysis' };
  }
  if (institution.some((d) => host.includes(d))) {
    return { source_category: 'institution', authority_tier: 'institution_analysis' };
  }
  if (media.some((d) => host.includes(d))) {
    return { source_category: 'media', authority_tier: 'media_report' };
  }
  if (enterprise.some((d) => host.endsWith(`.${d}`))) {
    // 企业站点的自述内容不得升格为官方事实
    return { source_category: 'enterprise', authority_tier: 'enterprise_claim' };
  }
  return { source_category: 'unknown', authority_tier: 'unknown' };
}

/* ==================================================================== */
/*  二、内容读写                                                        */
/* ==================================================================== */

const STAT_WHERE = "WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' AND COALESCE(process_status,'')<>'failed_fetch'";
/** 来源首页/栏目页归档：留痕但不进入文章业务列表与图表统计 */
const ARCHIVE_WHERE = "WHERE is_demo=0 AND record_kind IN ('source_homepage','source_index')";

export function listContentItems(filters = {}) {
  const includeArchive = filters.include_archive === true || filters.include_archive === 'true';
  const where = [includeArchive ? 'is_demo=0' : STAT_WHERE.replace('WHERE ', '')];
  const params = [];
  if (!includeArchive) {
    // 默认只列正文条目；归档记录只在「来源归档」筛选中出现
  } else if (filters.record_kind) {
    where.push('record_kind = ?');
    params.push(filters.record_kind);
  }
  if (filters.record_kind && !includeArchive) {
    where.push('record_kind = ?');
    params.push(filters.record_kind);
  }
  if (filters.content_type) {
    const types = Array.isArray(filters.content_type) ? filters.content_type : [filters.content_type];
    where.push(`content_type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  if (filters.source_category) {
    const cats = Array.isArray(filters.source_category) ? filters.source_category : [filters.source_category];
    where.push(`source_category IN (${cats.map(() => '?').join(',')})`);
    params.push(...cats);
  }
  if (filters.verification_status) {
    const vs = Array.isArray(filters.verification_status) ? filters.verification_status : [filters.verification_status];
    if (vs.includes('none')) {
      where.push(`(verification_status IS NULL OR verification_status IN (${vs.filter((v) => v !== 'none').map(() => '?').join(',') || "''"}))`);
      params.push(...vs.filter((v) => v !== 'none'));
    } else {
      where.push(`verification_status IN (${vs.map(() => '?').join(',')})`);
      params.push(...vs);
    }
  }
  if (filters.publisher) {
    where.push('publisher LIKE ?');
    params.push(`%${filters.publisher}%`);
  }
  if (filters.industry) {
    where.push('industry = ?');
    params.push(filters.industry);
  }
  if (filters.methodology_id) {
    where.push('methodology_ids_json LIKE ?');
    params.push(`%${filters.methodology_id}%`);
  }
  if (filters.from) {
    where.push("COALESCE(published_at, collected_at) >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("COALESCE(published_at, collected_at) <= ?");
    params.push(filters.to);
  }
  if (filters.q) {
    where.push('(title LIKE ? OR summary LIKE ? OR publisher LIKE ? OR topics_json LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  const limit = Math.min(Number(filters.limit) || 60, 500);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const order = {
    published_desc: "COALESCE(published_at, collected_at) DESC, collected_at DESC",
    published_asc: "COALESCE(published_at, collected_at) ASC",
    collected_desc: 'collected_at DESC',
    confidence_desc: 'confidence DESC NULLS LAST',
  }[filters.order] || "COALESCE(published_at, collected_at) DESC, collected_at DESC";

  const rows = all(
    `SELECT * FROM content_item WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) c FROM content_item WHERE ${where.join(' AND ')}`, params)?.c ?? 0;
  return {
    items: rows.map(mapContentRow),
    total,
    limit,
    offset,
    filters: filters || {},
    note:
      '统计口径：不含演示条目、不含转载副本（dup 关联到代表条目），且默认只列**正文条目**；' +
      '来源首页/栏目页归档记录（record_kind=source_homepage/source_index）只作来源发现与快照留痕，' +
      '不计入文章数量与图表。' +
      '「核验状态」为模型与规则的一致性检查结论，不代表独立审计。',
  };
}

export function mapContentRow(r) {
  return {
    id: r.id,
    content_type: r.content_type,
    content_type_label: CONTENT_TYPES[r.content_type]?.label || r.content_type,
    record_kind: r.record_kind || 'article',
    is_article: (r.record_kind || 'article') === 'article',
    title: r.title,
    publisher: r.publisher,
    author: r.author,
    published_at: r.published_at,
    published_at_known: !!r.published_at,
    discovered_at: r.discovered_at,
    collected_at: r.collected_at,
    source_url: r.source_url,
    canonical_url: r.canonical_url,
    source_category: r.source_category,
    source_category_label: SOURCE_CATEGORIES[r.source_category]?.label || r.source_category,
    authority_tier: r.authority_tier,
    authority_tier_label: AUTHORITY_TIERS[r.authority_tier] || r.authority_tier,
    body_availability: r.body_availability,
    summary: r.summary,
    auto_summary: r.auto_summary || null,
    auto_summary_kind: r.auto_summary_kind || null,
    cross_source_verified: !!r.cross_source_verified,
    citations_validated: r.citations_validated ?? 0,
    citations_rejected: r.citations_rejected ?? 0,
    key_points: uj(r.key_points_json, []),
    claims: uj(r.claims_json, []),
    topics: uj(r.topics_json, []),
    methodology_ids: uj(r.methodology_ids_json, []),
    industry: r.industry,
    body_chars: r.body_chars,
    public_files: uj(r.public_files_json, []),
    process_status: r.process_status,
    verification_status: r.verification_status,
    verification_at: r.verification_at,
    confidence: r.confidence,
    is_demo: !!r.is_demo,
    duplicate_of: r.duplicate_of,
    snapshot_id: r.snapshot_id,
    note: r.note || null,
  };
}

export function getContentDetail(id) {
  const r = get('SELECT * FROM content_item WHERE id=?', [id]);
  if (!r) return null;
  const versions = all('SELECT * FROM content_version WHERE content_item_id=? ORDER BY version_no DESC', [id]);
  const links = all('SELECT * FROM content_source_link WHERE content_item_id=?', [id]);
  const reps = get('SELECT id,title,publisher,source_url FROM content_item WHERE duplicate_of=?', [id]);
  const verifications = all(
    'SELECT * FROM verification_result WHERE object_type=? AND object_id=? ORDER BY created_at DESC LIMIT 10',
    ['content_item', id]
  ).map((v) => ({
    id: v.id,
    result: v.result,
    ui_state: v.ui_state,
    rules_ok: !!v.rules_ok,
    rules: uj(v.rules_json, []),
    model_used: !!v.model_used,
    model: v.model,
    evidence_level: v.evidence_level,
    capability_note: v.capability_note,
    confidence: v.confidence,
    summary: v.summary,
    conflict_fields: uj(v.conflict_fields_json, []),
    citations: uj(v.citations_json, []),
    created_at: v.created_at,
    error: v.error,
  }));
  return {
    item: {
      ...mapContentRow(r),
      body_snapshot: r.body_snapshot,
      body_chars: r.body_chars,
      note: r.note,
    },
    versions: versions.map((v) => ({
      version_no: v.version_no,
      content_hash: v.content_hash,
      change_kind: v.change_kind,
      change_summary: v.change_summary,
      diff_chars: v.diff_chars,
      fetched_at: v.fetched_at,
      title: v.title,
      body_chars: v.body_chars,
    })),
    other_sources: links.map((l) => ({
      url: l.url, publisher: l.publisher, relation: l.relation, source_category: l.source_category, similarity: l.similarity,
    })),
    reprints: reps ? [reps] : [],
    verifications,
    disclosure:
      '本条目为公开资料自动采集结果。核验状态表示证据一致性检查结论，不构成对内容真实性、准确性或投资价值的担保。',
  };
}

/** 归一化正文（去多余空白，便于内容哈希与比对） */
export function normalizeBody(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 写入 / 更新一条公开内容（幂等）。
 * 去重顺序：canonical url_hash → 内容哈希（转载）→ 新建。
 * @returns {{action:'inserted'|'updated'|'duplicate'|'unchanged', id:string, version_no?:number}}
 */
export function upsertContent(input, { actor = 'system:content', jobId = null } = {}) {
  const now = nowIso();
  const canonical = canonicalizeUrl(input.source_url || '');
  const urlHash = sha256(Buffer.from(canonical, 'utf8'));
  const body = normalizeBody(input.body_snapshot || '');
  const contentHash = body.length >= 80 ? sha256(Buffer.from(body, 'utf8')) : null;
  const cls = classifySource(input.source_url, { hint: input.source_category });
  const nowDate = todayCst();

  const existing = get('SELECT * FROM content_item WHERE url_hash=?', [urlHash]);
  if (existing) {
    // 同 URL：比较内容哈希，变化则保存新版本
    if (contentHash && existing.content_hash && contentHash === existing.content_hash) {
      return { action: 'unchanged', id: existing.id };
    }
    if (!contentHash && !existing.content_hash) return { action: 'unchanged', id: existing.id };
    const prevVer = get('SELECT MAX(version_no) n FROM content_version WHERE content_item_id=?', [existing.id])?.n || 0;
    const versionNo = prevVer + 1;
    const changeSummary = buildChangeSummary(existing, input, body);
    run(
      `INSERT INTO content_version (id,content_item_id,version_no,content_hash,title,body_snapshot,body_chars,
        change_kind,change_summary,diff_chars,snapshot_id,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId('CVR'), existing.id, versionNo, contentHash || existing.content_hash || '',
        String(input.title || existing.title).slice(0, 400), body.slice(0, 200000), body.length,
        versionNo === 1 ? 'initial' : 'updated', changeSummary, Math.abs(body.length - (existing.body_chars || 0)),
        input.snapshot_id || null, now,
      ]
    );
    run(
      `UPDATE content_item SET title=?, summary=COALESCE(?,summary), auto_summary=COALESCE(?,auto_summary),
         auto_summary_kind=COALESCE(?,auto_summary_kind),
         published_at=COALESCE(?,published_at),
         record_kind=COALESCE(?,record_kind),
         body_snapshot=?, body_chars=?, content_hash=?,
         collected_at=?, body_availability=?, note=COALESCE(?,note), snapshot_id=COALESCE(?,snapshot_id), updated_at=?,
         verification_status=NULL, process_status='fetched'
       WHERE id=?`,
      [
        String(input.title || existing.title).slice(0, 400), input.summary || null,
        input.auto_summary || null, input.auto_summary_kind || null,
        input.published_at || null, input.record_kind || null,
        body.slice(0, 200000), body.length,
        contentHash || existing.content_hash, now, input.body_availability || existing.body_availability,
        input.note || null, input.snapshot_id || null, now, existing.id,
      ]
    );
    return { action: 'updated', id: existing.id, version_no: versionNo, change_summary: changeSummary };
  }

  // 内容哈希命中 → 同一篇的转载：建关联，不重复统计
  if (contentHash) {
    const rep = get(
      `SELECT * FROM content_item WHERE content_hash=? AND duplicate_of IS NULL ORDER BY collected_at ASC LIMIT 1`,
      [contentHash]
    );
    if (rep) {
      const id = newId('CNT');
      run(
        `INSERT INTO content_item (id,content_type,record_kind,title,publisher,author,published_at,discovered_at,collected_at,
          source_url,canonical_url,url_hash,content_hash,source_category,authority_tier,body_availability,language,
          summary,body_snapshot,body_chars,duplicate_of,process_status,is_demo,note,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, input.content_type || rep.content_type, input.record_kind || 'article',
          String(input.title || rep.title).slice(0, 400),
          input.publisher || rep.publisher, input.author || null, input.published_at || rep.published_at,
          now, now, input.source_url, canonical, urlHash, contentHash, cls.source_category, cls.authority_tier,
          input.body_availability || rep.body_availability, 'zh', input.summary || null, null, 0, rep.id,
          'skipped_duplicate', 0, '同内容多站转载，已关联到代表条目，不重复统计。', now, now,
        ]
      );
      // 第二来源的**正文与字段**一并留痕：只有 URL 不足以做跨来源核验。
      run(
        `INSERT OR IGNORE INTO content_source_link (id,content_item_id,url,url_hash,publisher,source_category,relation,similarity,
           body_snapshot,body_chars,published_at,fetch_status,fetched_at,note,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('CSL'), rep.id, input.source_url, urlHash, input.publisher || null, cls.source_category, 'reprint', 1,
          body ? body.slice(0, 200000) : null, body.length, input.published_at || null,
          body ? 'ok' : 'url_only', now, '内容哈希一致（第二来源正文已留存）', now,
        ]
      );
      return { action: 'duplicate', id, representative_id: rep.id };
    }
  }

  const id = newId('CNT');
  const availability =
    input.body_availability ||
    (body.length >= 1200 ? 'full_text' : body.length > 0 ? 'partial' : input.summary ? 'abstract_only' : 'metadata_only');
  run(
    `INSERT INTO content_item (id,content_type,record_kind,title,publisher,author,published_at,discovered_at,collected_at,
      source_url,canonical_url,url_hash,content_hash,source_category,authority_tier,body_availability,language,
      summary,auto_summary,auto_summary_kind,auto_summary_at,key_points_json,claims_json,topics_json,methodology_ids_json,
      industry,body_snapshot,body_chars,public_files_json,process_status,is_demo,source_provider_id,snapshot_id,
      first_seen_job_id,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, input.content_type || 'industry_news', input.record_kind || 'article',
      String(input.title || '(无标题)').slice(0, 400),
      input.publisher || null, input.author || null, input.published_at || null, now,
      input.collected_at || (body ? now : null), input.source_url, canonical, urlHash, contentHash,
      cls.source_category, input.authority_tier || cls.authority_tier, availability, input.language || 'zh',
      input.summary || null, input.auto_summary || null, input.auto_summary_kind || null,
      input.auto_summary ? now : null,
      j(input.key_points || []), j(input.claims || []), j(input.topics || []),
      j(input.methodology_ids || []), input.industry || null, body.slice(0, 200000) || null, body.length,
      j(input.public_files || []), body ? 'fetched' : 'new', input.is_demo ? 1 : 0,
      input.source_provider_id || null, input.snapshot_id || null, jobId, input.note || null, now, now,
    ]
  );
  // 首次版本
  run(
    `INSERT INTO content_version (id,content_item_id,version_no,content_hash,title,body_snapshot,body_chars,
      change_kind,change_summary,diff_chars,snapshot_id,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('CVR'), id, 1, contentHash || sha256(Buffer.from(`${input.title}|${now}`, 'utf8')), String(input.title || '').slice(0, 400), body.slice(0, 200000), body.length, 'initial', '首次采集', 0, input.snapshot_id || null, now]
  );
  // 若提供了其它来源链接，一并建关联
  for (const link of input.other_sources || []) {
    try {
      const lc = canonicalizeUrl(link.url);
      run(
        `INSERT OR IGNORE INTO content_source_link (id,content_item_id,url,url_hash,publisher,source_category,relation,similarity,note,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('CSL'), id, link.url, sha256(Buffer.from(lc, 'utf8')), link.publisher || null,
          link.source_category || null, link.relation || 'reference', link.similarity ?? null, link.note || null, now,
        ]
      );
    } catch {
      /* 单条关联失败不影响主记录 */
    }
  }
  if (!input.silent) {
    audit({
      actor, action: 'content.insert', objectType: 'content_item', objectId: id,
      detail: { title: String(input.title || '').slice(0, 120), url: input.source_url, availability },
    });
  }
  return { action: 'inserted', id, availability };
}

function buildChangeSummary(prev, next, body) {
  const bits = [];
  if (String(prev.title || '') !== String(next.title || '')) bits.push('标题变化');
  const prevLen = Number(prev.body_chars || 0);
  const delta = body.length - prevLen;
  if (delta !== 0) bits.push(`正文长度 ${prevLen} → ${body.length}（${delta > 0 ? '+' : ''}${delta} 字符）`);
  if (String(prev.summary || '') !== String(next.summary || '')) bits.push('摘要变化');
  if (!bits.length) bits.push('原文哈希变化（细节未识别）');
  return bits.join('；');
}

/** 标记为演示条目（不计入业务统计） */
export function markDemo(id, note = '演示条目：用于界面与流程验证，不计入业务统计。') {
  run('UPDATE content_item SET is_demo=1, note=?, updated_at=? WHERE id=?', [note, nowIso(), id]);
  return { ok: true, id };
}

export function deleteContent(user, id) {
  if (user?.role !== 'admin') return { error: '仅管理员可删除内容条目', status: 403 };
  const r = get('SELECT * FROM content_item WHERE id=?', [id]);
  if (!r) return { error: '内容条目不存在', status: 404 };
  run('DELETE FROM content_version WHERE content_item_id=?', [id]);
  run('DELETE FROM content_source_link WHERE content_item_id=?', [id]);
  run('DELETE FROM verification_result WHERE object_type=? AND object_id=?', ['content_item', id]);
  run('DELETE FROM content_item WHERE id=?', [id]);
  audit({ actor: user.name, actorRole: user.role, action: 'content.delete', objectType: 'content_item', objectId: id, detail: { title: r.title } });
  return { ok: true, id };
}

/* ==================================================================== */
/*  三、统计与检索                                                      */
/* ==================================================================== */

export function contentStats() {
  const total = get(`SELECT COUNT(*) c FROM content_item ${STAT_WHERE}`)?.c ?? 0;
  const archiveTotal = get(`SELECT COUNT(*) c FROM content_item ${ARCHIVE_WHERE}`)?.c ?? 0;
  const byType = all(`SELECT content_type t, COUNT(*) c FROM content_item ${STAT_WHERE} GROUP BY content_type`);
  const byCategory = all(`SELECT source_category s, COUNT(*) c FROM content_item ${STAT_WHERE} GROUP BY source_category`);
  const byVerification = all(
    `SELECT COALESCE(verification_status,'none') v, COUNT(*) c FROM content_item ${STAT_WHERE} GROUP BY COALESCE(verification_status,'none')`
  );
  const byAvailability = all(
    `SELECT body_availability b, COUNT(*) c FROM content_item ${STAT_WHERE} GROUP BY body_availability`
  );
  const byMonth = all(
    `SELECT substr(COALESCE(published_at, collected_at),1,7) m, COUNT(*) c FROM content_item ${STAT_WHERE}
     GROUP BY m ORDER BY m DESC LIMIT 12`
  );
  const latest = get(`SELECT MAX(COALESCE(published_at, collected_at)) d FROM content_item ${STAT_WHERE}`);
  const lastCollect = get(`SELECT MAX(collected_at) d FROM content_item ${STAT_WHERE}`);
  const demoCount = get('SELECT COUNT(*) c FROM content_item WHERE is_demo=1')?.c ?? 0;
  const dupCount = get('SELECT COUNT(*) c FROM content_item WHERE duplicate_of IS NOT NULL')?.c ?? 0;
  // 抓取质量不合格（正文过短/跳转页）的记录保留在库中可审计，但不计入文章统计
  const failedFetch = get(
    "SELECT COUNT(*) c FROM content_item WHERE is_demo=0 AND record_kind='article' AND process_status='failed_fetch'"
  )?.c ?? 0;
  const toObj = (rows, key, val = 'c') => Object.fromEntries(rows.map((r) => [r[key], r[val]]));
  const datedCount = get(`SELECT COUNT(*) c FROM content_item ${STAT_WHERE} AND published_at IS NOT NULL`)?.c ?? 0;
  const undatedCount = total - datedCount;
  return {
    total,
    archive_records: archiveTotal,
    failed_fetch_records: failedFetch,
    published_date_known: datedCount,
    published_date_missing: undatedCount,
    demo_excluded: demoCount,
    reprints_linked: dupCount,
    by_type: toObj(byType, 't'),
    by_type_label: Object.fromEntries(byType.map((r) => [CONTENT_TYPES[r.t]?.label || r.t, r.c])),
    by_source_category: toObj(byCategory, 's'),
    by_verification: { verified: 0, insufficient: 0, conflict: 0, unavailable: 0, none: 0, ...toObj(byVerification, 'v') },
    by_availability: toObj(byAvailability, 'b'),
    by_month: byMonth.map((r) => ({ month: r.m, count: r.c })),
    latest_published_at: latest?.d || null,
    last_collected_at: lastCollect?.d || null,
    caliber:
      '公开研报与行业动态口径：只统计正文条目（record_kind=article），排除演示条目、转载副本、来源首页/栏目归档' +
      `与抓取质量不合格的记录（${failedFetch} 条正文过短/跳转页，保留在库可审计但不计入文章）。` +
      `其中 ${undatedCount} 条来源页面未披露发布日期，按「未披露」展示，不用采集时间冒充。` +
      '「仅有摘要」条目表示未获取公开全文，仅保留元数据与公开摘要。',
  };
}

/** 内部：在正文中提取要点/观点（确定性规则，不生成数值公式） */
export function extractClaimsAndPoints(text, { maxPoints = 6, maxClaims = 6 } = {}) {
  const body = normalizeBody(text);
  if (!body) return { key_points: [], claims: [] };
  const sentences = body
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
  const points = [];
  const claims = [];
  const opinionHints = /(预计|预期|有望|或将|可能|我们认为|看好|建议|展望|should|could|may|expect)/i;
  const forecastHints = /(20\d\d\s*年|未来|到\s*20\d\d|预计到|CAGR|复合增速)/i;
  for (const s of sentences) {
    if (points.length < maxPoints && !points.includes(s)) points.push(s);
    if (claims.length < maxClaims) {
      if (forecastHints.test(s) && opinionHints.test(s)) claims.push({ text: s, kind: 'forecast' });
      else if (opinionHints.test(s)) claims.push({ text: s, kind: 'opinion' });
      else if (/(已|累计|完成|发布|登记|成交)/.test(s) && /\d/.test(s)) claims.push({ text: s, kind: 'fact' });
    }
  }
  return { key_points: points, claims };
}

/** 按 URL/内容哈希去重后的统计与去重检查（供测试与后台使用） */
export function dedupeAudit() {
  const dupUrls = all(
    `SELECT url_hash, COUNT(*) c FROM content_item GROUP BY url_hash HAVING c > 1`
  );
  const dupHashes = all(
    `SELECT content_hash, COUNT(*) c FROM content_item WHERE content_hash IS NOT NULL AND duplicate_of IS NULL
     GROUP BY content_hash HAVING c > 1`
  );
  return {
    duplicate_urls: dupUrls.length,
    duplicate_content_hashes: dupHashes.length,
    ok: dupUrls.length === 0 && dupHashes.length === 0,
  };
}

/* ==================================================================== */
/*  三·B、正文页发现与发布日期抽取（确定性规则，不猜测日期）              */
/* ==================================================================== */

/** 正文候选链接关键词（命中标题文本或 URL） */
export const ARTICLE_LINK_KEYWORDS = [
  'ccer', '温室气体', '自愿减排', '减排量', '方法学', '碳市场', '碳交易', '碳汇',
  '瓦斯', '甲烷', '气候', '碳排放', '绿色', '研报', '报告', '动态', '公告', '新闻',
];

const URL_FULL_DATE = /\/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})[/_-]/;
const URL_T_DATE = /[t_](20\d{2})(\d{2})(\d{2})[_./-]/;

/** 中文/标准日期文本 → YYYY-MM-DD（非法日期返回 null） */
function toIsoDateSafe(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!(yy >= 2000 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** 明显是站内导航/产品页的链接文案（无日期时排除，避免把导航页当文章） */
const NAV_LINK_TEXT = /(下载|APP|客户端|登录|注册|关于我们|联系我们|广告|招聘|版权声明|网站地图|首页|订阅|投稿|免责声明)/i;

/** 正文页最少字符数：低于该值视为抓取到跳转/错误页，不算一次成功抓取 */
export const MIN_ARTICLE_BODY_CHARS = 60;

/** 栏目、导航和软件产品页面仅作来源发现，不作为文章。 */
export function isSourceIndexUrl(raw) {
  try {
    const p = new URL(raw).pathname;
    return /\/(?:index|default|main)(?:\d+)?\.(?:s?html?)$/i.test(p) ||
      /\/(?:app|download|downloads|about|contact)\/?$/i.test(p);
  } catch { return true; }
}

/** 从 HTML `<a>` 中发现候选正文链接（同域、非导航锚点、含主题关键词或完整日期） */
export function discoverArticleLinks(html, baseUrl, { max = 8 } = {}) {
  const src = String(html || '');
  const out = [];
  const seen = new Set();
  let base = null;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(src))) {
    const hrefRaw = m[1].trim();
    if (!hrefRaw || /^(#|javascript:|mailto:|tel:)/i.test(hrefRaw)) continue;
    let u;
    try {
      u = new URL(hrefRaw, base);
    } catch {
      continue;
    }
    if (u.hostname !== base.hostname) continue;
    if (isSourceIndexUrl(u.toString())) continue;
    if (/\.(pdf|docx?|xlsx?|zip|rar|jpe?g|png|gif|mp4)$/i.test(u.pathname)) continue;
    const text = String(m[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 6 || text.length > 120) continue;
    const path = u.pathname + u.search;
    if (/^\/(index|default|main)?\.?(s?html?)?$/i.test(u.pathname)) continue;
    const hasDate = URL_FULL_DATE.test(`${u.pathname}/`) || URL_T_DATE.test(`${u.pathname}/`);
    const kwHit = ARTICLE_LINK_KEYWORDS.some((k) => text.toLowerCase().includes(k) || path.toLowerCase().includes(k));
    if (!hasDate && !kwHit) continue;
    // 无完整日期的导航/产品页（下载、APP、关于我们…）不是文章
    if (!hasDate && NAV_LINK_TEXT.test(text)) continue;
    // 明显是栏目/导航的短路径不算正文
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    const key = canonicalizeUrl(u.toString());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: u.toString(),
      canonical_url: key,
      text,
      score: (hasDate ? 2 : 0) + (kwHit ? 1 : 0),
      date_in_url: hasDate ? extractDateFromUrl(u.pathname) : null,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Number(max) || 8));
}

/** 从 URL 路径中提取完整日期（仅接受 YYYYMMDD / YYYY-MM-DD 完整形式） */
export function extractDateFromUrl(pathname) {
  const t = String(pathname || '');
  const a = t.match(URL_T_DATE) || t.match(URL_FULL_DATE);
  if (!a) return null;
  return toIsoDateSafe(a[1], a[2], a[3]);
}

/** 抽取来源页面自带的摘要（meta description / og:description） */
export function extractMetaDescription(html) {
  const src = String(html || '');
  const pats = [
    /<meta[^>]+property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']description["']/i,
  ];
  for (const re of pats) {
    const m = src.match(re);
    if (m && m[1] && m[1].trim().length >= 10) return decodeHtmlEntities(m[1]).slice(0, 600);
  }
  return null;
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/**
 * 从正文页面抽取**发布日期**。
 * 只接受页面自带的日期声明：meta 标签 / JSON-LD datePublished / 正文可见的
 * 「发布时间」「发布日期」；URL 或事件日期仅为候选，不作为发布日期。
 * 绝不使用采集时间、也不从年份臆造日期；取不到返回 null（界面显示「未披露」）。
 * @returns {{published_at:string|null, date_source:string|null, note:string|null}}
 */
export function extractPublishedDate(html, { url = null, text = null } = {}) {
  const src = String(html || '');
  const patterns = [
    // 1) meta / JSON-LD（最高可信）
    { src: 'meta', re: /<meta[^>]+property\s*=\s*["']article:published_time["'][^>]*content\s*=\s*["']([^"']+)["']/i },
    { src: 'meta', re: /<meta[^>]+name\s*=\s*["'](?:publishdate|pubdate|publish_time|weibo:article:create_at|article:published_time)["'][^>]*content\s*=\s*["']([^"']+)["']/i },
    { src: 'meta', re: /<meta[^>]+name\s*=\s*["'](?:date|dc.date|dc.date.issued)["'][^>]*content\s*=\s*["']([^"']+)["']/i },
    { src: 'jsonld', re: /"datePublished"\s*:\s*"([^"]+)"/i },
  ];
  for (const p of patterns) {
    const m = src.match(p.re);
    if (!m) continue;
    const iso = normalizeDateText(m[1]);
    if (iso) return { published_at: iso, date_source: p.src, note: `发布日期依据：页面 ${p.src === 'meta' ? 'meta 标签' : 'JSON-LD datePublished'}（${m[1].slice(0, 40)}）` };
  }
  // meta 属性顺序任意；只读取具有明确发布时间语义的标签。
  for (const tag of src.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]]));
    if (/^(article:published_time|publishdate|pubdate|publish_time|dc.date.issued)$/i.test(attrs.name || attrs.property || '')) {
      const iso = normalizeDateText(attrs.content);
      if (iso) return { published_at: iso, date_source: 'meta', note: '发布日期依据：页面发布时间 meta 标签' };
    }
  }
  const timeTag = src.match(/<time\b[^>]*itemprop\s*=\s*["']datePublished["'][^>]*datetime\s*=\s*["']([^"']+)["']/i);
  if (timeTag) {
    const iso = normalizeDateText(timeTag[1]);
    if (iso) return { published_at: iso, date_source: 'time', note: '发布日期依据：页面 datePublished 时间标签' };
  }
  // 2) 正文可见声明
  const bodyText = text ? String(text) : src.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const visible = [
    /(?:发布(?:时间|日期)|发表(?:时间|日期))\s*[：:]\s*(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/,
  ];
  for (const re of visible) {
    const m = bodyText.match(re);
    if (!m) continue;
    const iso = toIsoDateSafe(m[1], m[2], m[3]);
    if (iso) return { published_at: iso, date_source: 'page_text', note: `发布日期依据：页面正文声明（${m[0].slice(0, 30)}）` };
  }
  // 3) URL 完整日期（低可信，明确标注）
  if (url) {
    try {
      const iso = extractDateFromUrl(new URL(url).pathname);
      if (iso) return { published_at: null, date_source: 'url_candidate', date_candidate: iso, note: `URL 日期候选 ${iso} 未经页面发布声明证实；发布日期未披露` };
    } catch {
      /* URL 不合法时忽略 */
    }
  }
  return { published_at: null, date_source: null, note: '来源页面未声明发布日期，按「未披露」处理（不用采集时间代替）' };
}

/** 归一化常见日期字符串为 YYYY-MM-DD */
export function normalizeDateText(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return toIsoDateSafe(m[1], m[2], m[3]);
  m = s.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (m) return toIsoDateSafe(m[1], m[2], m[3]);
  return null;
}

/**
 * 正文可获得性：**采集器返回的结果优先于长度猜测**（docs/22 第 8 条）。
 * 抓取连接明确返回整页内容（Firecrawl markdown / MCP 工具正文）时不再用 1200 字符猜。
 */
export function availabilityFromFetch(fr, body) {
  const text = String(body || '');
  if (!text) return fr?.summary ? 'abstract_only' : 'metadata_only';
  if (fr?.availability && ['full_text', 'partial', 'abstract_only', 'metadata_only'].includes(fr.availability)) {
    return fr.availability;
  }
  const kind = String(fr?.conn_kind || '');
  if (['firecrawl_scrape', 'firecrawl_mcp', 'mcp_http', 'mcp_streamable_http'].includes(kind)) {
    // Firecrawl / MCP 抓取返回的是页面正文（markdown 或纯文本），视为公开全文
    return 'full_text';
  }
  return text.length >= 1200 ? 'full_text' : 'partial';
}

/* ==================================================================== */
/*  四、自动采集：来源发现 → 抓取 → 去重 → 抽取 → 核验 → 自动发布         */
/* ==================================================================== */

/** 从搜索结果条目判断内容类型 */
export function guessContentType(hit, { group = null } = {}) {
  const text = `${hit.title || ''} ${hit.snippet || ''}`;
  if (/(研报|研究报告|深度报告|行业报告|策略报告|点评报告)/.test(text)) return 'research_report';
  if (/(公告|股份有限公司|有限公司.*公告|企业新闻)/.test(text)) return 'enterprise_news';
  if (/(观点|访谈|解读|专家|首席)/.test(text)) return 'institution_view';
  if (/(通知|公告|办法|规则|征求意见)/.test(text) && /gov\.cn|cets\.org\.cn/.test(hit.url || '')) return 'policy_notice';
  if (group === 'market' || group === 'coal-methane' || group === 'methane') return 'industry_news';
  return 'industry_news';
}

function guessPublisher(hit) {
  if (hit.publisher) return hit.publisher;
  try {
    return new URL(String(hit.url)).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * 从搜索结果采集一批公开内容。
 * 明确区分「真实联网」与「模拟」：本函数只处理真实搜索结果，
 * 结果里的每条都带 source_provider_id 与快照，便于追溯。
 */
export async function collectFromSearch({
  actor = 'system:collect', searchProviderId = null, groups = null, categories = null,
  windowDays = 7, countPerQuery = 8, maxQueries = 12, maxItems = 40,
  fetchBody = true, verify = true, jobId = null, log = () => {},
} = {}) {
  const provider = pickSearchProvider(searchProviderId);
  if (!provider) {
    return {
      ok: false,
      reason: 'no_search_provider',
      message: '未配置可用的搜索服务：不会用空结果假装采集成功。请在后台「采集连接」配置搜索 API。',
      discovered: 0, inserted: 0, duplicates: 0, updated: 0, fetched: 0, fetch_failed: 0, queries: 0,
    };
  }
  const plan = buildQueryPlan({ groups, categories, windowDays, maxQueries });
  const today = todayCst();
  const from = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const tally = {
    ok: true, reason: null, provider: { id: provider.id, name: provider.name, kind: provider.provider_kind },
    queries: 0, search_failures: 0, fallback_used: 0, discovered: 0, inserted: 0, duplicates: 0, unchanged: 0, updated: 0,
    fetched: 0, fetch_failed: 0, fetch_skipped: 0, rules: {}, failures: [],
  };
  const seen = new Set();

  for (const q of plan) {
    if (tally.discovered >= maxItems) break;
    log(`检索：${q.term}（${q.group_label}）`);
    const res = await runSearchWithFallback(q.term, {
      provider_id: searchProviderId,
      count: countPerQuery, raw_content: true, start_date: from, end_date: today, window_days: windowDays,
    });
    tally.queries += 1;
    if (!res.ok) {
      tally.search_failures += 1;
      tally.failures.push({
        query: q.term, reason: res.reason, message: res.message,
        attempts: res.attempts || [], fallback_used: !!res.fallback_used,
      });
      log(`  搜索失败（${res.reason}）：${res.message || ''}`);
      continue;
    }
    if (res.fallback_used) tally.fallback_used += 1;
    if (res.provider_name) {
      tally.provider.id = res.provider_id || tally.provider.id;
      tally.provider.name = res.provider_name;
      tally.provider.kind = res.search_engine || tally.provider.kind;
    }
    for (const hit of res.results) {
      if (tally.discovered >= maxItems) break;
      if (!hit.url || seen.has(hit.canonical_url)) continue;
      seen.add(hit.canonical_url);
      tally.discovered += 1;

      const contentType = guessContentType(hit, { group: q.group });
      const cls = classifySource(hit.url);
      let body = hit.raw_content ? normalizeBody(hit.raw_content) : '';
      // 搜索结果若直接带正文（如 Tavily raw_content），按采集器口径判定可获得性
      let availability = availabilityFromFetch({ conn_kind: 'search_raw_content' }, body);
      if (!body) availability = hit.snippet ? 'abstract_only' : 'metadata_only';
      let snapshotId = null;
      let fetchNote = null;
      let actualFetchProvider = null;

      // 只有搜索摘要时，明确标注「未获取全文」；不声称已读全文
      if (fetchBody && body.length < 1200) {
        const fr = await fetchWithFallback(hit.url, { attempts: 3 });
        if (!fr.ok) {
          tally.fetch_skipped += fr.reason === 'not_configured' ? 1 : 0;
          tally.fetch_failed += fr.reason === 'not_configured' ? 0 : 1;
          fetchNote = fr.reason === 'not_configured'
            ? '未配置网页抓取连接：仅归档搜索摘要，未读取全文。'
            : `正文抓取失败（${fr.reason}）：${fr.message || ''}；仅保留搜索摘要。`;
        } else {
          actualFetchProvider = fr.connection_id || fr.provider_id || null;
          body = normalizeBody(fr.content);
          availability = availabilityFromFetch(fr, body);
          tally.fetched += 1;
          if (fr.fallback_used) tally.fallback_used += 1;
          log(`  抓取正文成功：${hit.title?.slice(0, 40)}（${fr.chars} 字符${fr.fallback_used ? '，备用通道' : ''}）`);
        }
      }

      // 留痕：正文或摘要写入 source_snapshot，便于追溯与版本比对
      if (body || hit.snippet) {
        try {
          const snapBody = body || hit.snippet;
          const snap = recordSnapshot({
            url: hit.url,
            // 搜索/抓取连接与 datasource_config 属于不同的外键空间。
            sourceId: null,
            parseQuality: body ? 'good' : 'snippet_only',
            parseNote: [fetchNote || (hit.raw_content ? '搜索 API 直接返回正文' : '仅搜索摘要，未读取全文'),
              `搜索连接：${res.provider_id || provider.id}`,
              actualFetchProvider ? `正文抓取连接：${actualFetchProvider}` : null].filter(Boolean).join('；'),
            res: {
              ok: true,
              status: 200,
              content_type: 'text/plain; charset=utf-8',
              hash: sha256(Buffer.from(snapBody, 'utf8')),
              bytes: Buffer.byteLength(snapBody, 'utf8'),
              body: snapBody,
            },
          });
          snapshotId = snap?.id || null;
        } catch {
          snapshotId = null;
        }
      }

      const { key_points, claims } = extractClaimsAndPoints(body || hit.snippet || '');
      const upsert = upsertContent(
        {
          content_type: contentType,
          title: hit.title || '(无标题)',
          publisher: guessPublisher(hit),
          published_at: isDate(hit.published_at) ? hit.published_at : null,
          source_url: hit.url,
          source_category: cls.source_category,
          authority_tier: cls.authority_tier,
          body_availability: availability,
          summary: hit.snippet ? String(hit.snippet).slice(0, 1200) : null,
          key_points,
          claims,
          topics: [q.group_label, q.term],
          body_snapshot: body,
          snapshot_id: snapshotId,
          source_provider_id: res.provider_id || provider.id,
          note: fetchNote,
        },
        { actor, jobId }
      );
      if (upsert.action === 'inserted') tally.inserted += 1;
      else if (upsert.action === 'duplicate') tally.duplicates += 1;
      else if (upsert.action === 'updated') tally.updated += 1;
      else tally.unchanged += 1;
    }
  }

  // 自动核验（可选）：规则 + 模型；不产生任何人工任务
  if (verify) {
    const cfg = verifyConfig();
    const pending = all(
      `SELECT id FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL
         AND verification_status IS NULL ORDER BY COALESCE(published_at,'') DESC LIMIT ?`,
      [Math.min(cfg.max_per_run, maxItems)]
    );
    let verified = { verified: 0, insufficient: 0, conflict: 0, unavailable: 0 };
    for (const row of pending) {
      try {
        const out = await verifyContentItem(row.id, { actor });
        if (out.result && verified[out.result] !== undefined) verified[out.result] += 1;
      } catch (e) {
        tally.failures.push({ verify: row.id, reason: 'exception', message: e.message });
      }
    }
    tally.rules = verified;
  }

  // 更新数据集游标（最近成功时间 + 失败原因）
  const anyFailure = tally.search_failures > 0 || tally.fetch_failed > 0;
  run(
    `INSERT INTO dataset_cursor (dataset,last_window_from,last_window_to,last_success_at,last_attempt_at,last_status,
       last_error,items_seen,items_new,note)
     VALUES ('content_discovery',?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET last_window_from=excluded.last_window_from,last_window_to=excluded.last_window_to,
       last_success_at=excluded.last_success_at,last_attempt_at=excluded.last_attempt_at,last_status=excluded.last_status,
       last_error=excluded.last_error,items_seen=excluded.items_seen,items_new=excluded.items_new,note=excluded.note`,
    [
      from, today,
      tally.search_failures === tally.queries && tally.queries > 0 ? null : nowIso(),
      nowIso(),
      tally.search_failures === tally.queries && tally.queries > 0 ? 'failed' : anyFailure ? 'partial' : 'ok',
      tally.failures.length ? tally.failures.slice(0, 5).map((f) => `${f.query || f.verify}: ${f.reason} ${f.message || ''}`).join(' | ').slice(0, 900) : null,
      tally.discovered, tally.inserted,
      `检索 ${tally.queries} 次；新增 ${tally.inserted}；转载关联 ${tally.duplicates}；抓取正文 ${tally.fetched} 成功 / ${tally.fetch_failed} 失败`,
    ]
  );
  if (tally.search_failures === tally.queries && tally.queries > 0) {
    return { ...tally, ok: false, reason: 'all_searches_failed', message: '全部检索均失败，未采集到任何内容。' };
  }
  return tally;
}

/**
 * 对只有摘要/部分正文的公开文章定向补采。只接受实际抓到的更完整正文；
 * 搜索摘要、模型推断和抓取失败都不能补写为全文。每次有上限，供每日证据循环调用。
 */
export async function repairIncompleteContent({
  actor = 'system:evidence-loop', limit = 8, jobId = null,
  connection = null, fetcher = fetchUrlContent, verify = true, offset = null, round = 1,
} = {}) {
  const conn = connection || pickFetchConnection();
  const out = { attempted: 0, improved: 0, unchanged: 0, failed: 0, verified: 0, items: [] };
  if (!conn) return { ...out, unavailable: true, reason: '未配置可用的网页抓取连接' };
  const cfg = verifyConfig();
  const cap = Math.min(Math.max(Number(limit) || 8, 1), 30);
  const total = Number(get(`SELECT COUNT(*) n FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL
    AND record_kind='article' AND source_url IS NOT NULL
    AND COALESCE(body_availability,'metadata_only')!='full_text'`)?.n || 0);
  const dayNo = Math.floor(Date.parse(todayCst()) / 86400000);
  const start = total ? (offset === null
    ? (dayNo * cap + (Math.max(1, Number(round) || 1) - 1) * cap) % total
    : Math.max(0, Number(offset) || 0) % total) : 0;
  const rows = all(
    `SELECT * FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL
       AND record_kind='article' AND source_url IS NOT NULL
       AND COALESCE(body_availability,'metadata_only') != 'full_text'
     ORDER BY COALESCE(published_at,'') DESC, created_at DESC LIMIT ? OFFSET ?`,
    [cap, start]
  );
  for (const item of rows) {
    out.attempted += 1;
    let fr;
    try { fr = await fetcher(conn, item.source_url, {}); }
    catch (e) { fr = { ok: false, reason: 'exception', message: e.message }; }
    if (!fr?.ok) {
      out.failed += 1;
      out.items.push({ id: item.id, status: 'failed', reason: fr?.reason || 'fetch_failed' });
      continue;
    }
    try {
    const body = normalizeBody(fr.content);
    const availability = availabilityFromFetch(fr, body);
    if (availability !== 'full_text' || body.length < Math.max(200, Number(cfg.min_body_chars) || 400) ||
        (Number(item.body_chars || 0) > 0 && body.length < Number(item.body_chars) * 0.8)) {
      out.unchanged += 1;
      out.items.push({ id: item.id, status: 'insufficient', reason: '抓取结果仍不是可核验全文，或正文较原归档明显缩短' });
      continue;
    }
    const snap = recordSnapshot({
      // source_snapshot.source_id 指向 datasource_config，不是 web_fetch_connection。
      // 抓取连接 ID 只放说明，避免把两类配置混为同一外键。
      url: item.source_url, sourceId: null, parser: 'content_evidence_refetch',
      parseQuality: 'good', parseNote: `定向补采取得公开全文；抓取连接 ${conn.id || '未命名'}`,
      res: { status: 200, content_type: 'text/plain; charset=utf-8',
        hash: sha256(Buffer.from(body, 'utf8')), bytes: Buffer.byteLength(body, 'utf8'), body },
    });
    const date = item.published_at ? null : extractPublishedDate(fr.raw_html || fr.html || '', { url: item.source_url, text: body });
    const saved = upsertContent({
      title: item.title, source_url: item.source_url, content_type: item.content_type,
      record_kind: item.record_kind, publisher: item.publisher,
      published_at: item.published_at || date?.published_at || null,
      summary: item.summary, body_snapshot: body, body_availability: 'full_text',
      snapshot_id: snap.id, source_category: item.source_category,
      note: `证据循环：原始来源全文补采；${date?.note || '发布日期沿用原记录或保持未披露'}`,
    }, { actor, jobId });
    if (saved.action === 'unchanged') {
      // 原文哈希相同但抓取器确认取得全文：只升级证据可获得性，不伪造新版本。
      run(`UPDATE content_item SET body_availability='full_text', snapshot_id=?,
             verification_status=NULL, updated_at=? WHERE id=? AND body_availability!='full_text'`,
        [snap.id, nowIso(), item.id]);
    }
    out.improved += 1;
    out.items.push({ id: item.id, status: 'improved', snapshot_id: snap.id });
    audit({ actor, action: 'content.evidence_refetch', objectType: 'content_item', objectId: item.id,
      detail: { source_url: item.source_url, before: item.body_availability, after: 'full_text', snapshot_id: snap.id } });
    if (verify) {
      try { await verifyContentItem(item.id, { actor }); out.verified += 1; }
      catch (e) { out.items[out.items.length - 1].verify_error = e.message; }
    }
    } catch (e) {
      out.failed += 1;
      out.items.push({ id: item.id, status: 'failed', reason: 'store_failed', message: e.message });
    }
  }
  return out;
}

/**
 * 收录种子来源的**正文条目**（不依赖搜索 API）。
 * ============================================================================
 * 二轮整改（docs/22 第 2、15 条）：
 *   - 首页**不再**被写成一篇「今天发布的研报」：首页只作来源发现与快照归档
 *     （record_kind=source_homepage，published_at=NULL，不进入文章列表与图表统计）；
 *   - 先发现候选正文 URL，再逐篇抓取内容页；
 *   - 发布日期只取页面自带的 datePublished / 发布时间 / 发布日期（或 URL 完整日期并标注），
 *     取不到就 NULL，界面显示「未披露」；**绝不用采集时间冒充发布日期**；
 *   - 官网可用性由真实抓取结果决定：抓取失败如实记录，不伪造条目。
 * @param {{actor?:string, seedIds?:string[]|null, fetchLimit?:number, maxArticlesPerSource?:number,
 *          verify?:boolean, jobId?:string|null, log?:Function, archiveHomepages?:boolean}} opts
 */
export async function collectFromSeedSources({
  actor = 'system:collect', seedIds = null, fetchLimit = 12, maxArticlesPerSource = 4,
  verify = false, jobId = null, log = () => {}, archiveHomepages = true, seedSources = null,
} = {}) {
  const conn = pickFetchConnection();
  const pool = Array.isArray(seedSources) && seedSources.length ? seedSources : SEED_SOURCES;
  const seeds = pool.filter((s) => s.enabled && (!seedIds || seedIds.includes(s.id))).slice(0, fetchLimit);
  const tally = {
    ok: true, attempted: 0, fetched: 0, failed: 0, inserted: 0, updated: 0, unchanged: 0,
    archive_records: 0, articles_discovered: 0, articles_fetched: 0, articles_failed: 0,
    published_dated: 0, published_undated: 0, failures: [],
    provider: conn ? { id: conn.id, name: conn.name } : null,
  };
  if (!conn) {
    return { ...tally, ok: false, reason: 'no_fetch_connection', message: '未配置网页抓取连接，无法读取种子来源页面。' };
  }
  const maxArticles = Math.max(0, Math.min(Number(maxArticlesPerSource) || 0, 10));

  for (const s of seeds) {
    tally.attempted += 1;
    const fr = await fetchWithFallback(s.url, { attempts: 2 });
    if (!fr.ok) {
      tally.failed += 1;
      tally.failures.push({ source: s.id, url: s.url, reason: fr.reason, message: fr.message });
      log(`  种子来源抓取失败：${s.name}（${fr.reason}）`);
      continue;
    }
    tally.fetched += 1;

    /* ---- 1) 首页/栏目页：只作来源发现与快照归档，不作为文章 ---- */
    if (archiveHomepages) {
      const snapshot = fr.content ? String(fr.content) : null;
      const archive = upsertContent(
        {
          content_type: s.kinds[0],
          record_kind: s.is_index ? 'source_index' : 'source_homepage',
          title: `${s.name}${s.is_index ? '（栏目归档）' : '（来源首页归档）'}`,
          publisher: s.name,
          published_at: null, // 首页没有单一发布日期：不得用采集日冒充
          source_url: s.url,
          source_category: s.source_category,
          authority_tier: 'unknown',
          body_availability: snapshot ? 'partial' : 'metadata_only',
          summary: null,
          auto_summary: null,
          body_snapshot: snapshot,
          topics: ['来源归档', s.name],
          note:
            `来源${s.is_index ? '栏目' : '首页'}归档（${s.source_category}）：仅作来源发现与快照留痕，` +
            '不作为一篇文章/研报，也不计入文章数量与图表统计；内容变化会保存为版本。',
        },
        { actor, jobId }
      );
      if (archive.action === 'inserted') { tally.archive_records += 1; tally.inserted += 1; }
      else if (archive.action === 'updated') tally.updated += 1;
      else tally.unchanged += 1;
    }

    /* ---- 2) 发现候选正文 URL（确定性规则） ---- */
    const links = discoverArticleLinks(fr.raw_html || fr.html || '', s.url, { max: maxArticles });
    tally.articles_discovered += links.length;
    if (!links.length) {
      log(`  ${s.name}：首页未发现可用正文链接（不把首页当文章入库）`);
    }

    /* ---- 3) 逐篇抓取内容页并抽取真实发布日期 ---- */
    for (const link of links) {
      const ar = await fetchWithFallback(link.url, { attempts: 2 });
      if (!ar.ok) {
        tally.articles_failed += 1;
        tally.failures.push({ source: s.id, url: link.url, reason: ar.reason, message: ar.message });
        log(`  正文抓取失败（${ar.reason}）：${link.url}`);
        continue;
      }
      // 抓到的若是跳转/错误/占位页（正文过短），不算一次成功抓取，避免把导航页当文章
      if (String(ar.content || '').trim().length < MIN_ARTICLE_BODY_CHARS) {
        tally.articles_failed += 1;
        tally.failures.push({
          source: s.id, url: link.url, reason: 'body_too_short',
          message: `正文仅 ${String(ar.content || '').trim().length} 字符（低于 ${MIN_ARTICLE_BODY_CHARS}），疑似跳转/错误页，未作为文章入库`,
        });
        log(`  正文过短，跳过：${link.url}`);
        continue;
      }
      tally.articles_fetched += 1;
      const date = extractPublishedDate(ar.raw_html || ar.html || '', { url: link.url, text: ar.content });
      if (date.published_at) tally.published_dated += 1; else tally.published_undated += 1;
      const sourceSummary = extractMetaDescription(ar.raw_html || ar.html || '');
      const { key_points, claims } = extractClaimsAndPoints(ar.content || '');
      // 抽取式摘要与来源摘要分开：来源没有摘要时用抽取式，并标明 kind=extractive
      const autoSummary = sourceSummary ? null : String(ar.content || '').replace(/\s+/g, ' ').slice(0, 300) || null;
      const up = upsertContent(
        {
          content_type: s.kinds[0],
          record_kind: 'article',
          title: ar.title || link.text || '(无标题)',
          publisher: s.name,
          published_at: date.published_at,
          source_url: link.url,
          source_category: s.source_category,
          body_availability: availabilityFromFetch(ar, ar.content),
          summary: sourceSummary,
          auto_summary: autoSummary,
          auto_summary_kind: autoSummary ? 'extractive' : null,
          key_points,
          claims,
          topics: ['种子来源', s.name, ...(link.date_in_url ? ['URL 日期'] : [])],
          body_snapshot: ar.content,
          note: [date.note, `由「${s.name}」页面发现并抓取正文页；首页只作来源发现，不作为文章。`]
            .filter(Boolean).join('；'),
        },
        { actor, jobId }
      );
      if (up.action === 'inserted') tally.inserted += 1;
      else if (up.action === 'duplicate') tally.unchanged += 1;
      else if (up.action === 'updated') tally.updated += 1;
      else tally.unchanged += 1;
    }
  }

  // 记录本数据集自己的「最近成功时间 / 失败原因」：
  // 只要有来源抓取成功就算成功（部分失败记为 partial 并写明原因）。
  run(
    `INSERT INTO dataset_cursor (dataset,last_success_at,last_attempt_at,last_status,last_error,items_seen,items_new,note)
     VALUES ('content_seed',?,?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET last_success_at=excluded.last_success_at,
       last_attempt_at=excluded.last_attempt_at, last_status=excluded.last_status,
       last_error=excluded.last_error, items_seen=excluded.items_seen, items_new=excluded.items_new,
       note=excluded.note`,
    [
      tally.fetched > 0 ? nowIso() : null,
      nowIso(),
      tally.fetched > 0 ? (tally.failed > 0 || tally.articles_failed > 0 ? 'partial' : 'ok') : 'failed',
      tally.failures.length
        ? tally.failures.slice(0, 6).map((f) => `${f.source}: ${f.reason} ${f.message || ''}`).join(' | ').slice(0, 900)
        : null,
      tally.attempted, tally.inserted,
      `来源页抓取成功 ${tally.fetched}/${tally.attempted}；发现正文 ${tally.articles_discovered} 篇、` +
      `成功抓取 ${tally.articles_fetched} 篇（有日期 ${tally.published_dated} / 未披露 ${tally.published_undated}）；` +
      `来源归档 ${tally.archive_records} 条不计入文章。`,
    ]
  );
  return tally;
}

/**
 * 种子来源官网可用性验证（逐一真实请求）。
 * 结果写回 dataset_cursor 备注，便于后台与文档引用真实结论。
 */
export async function verifySeedSources({ actor = 'system:collect', timeoutMs = 20000 } = {}) {
  const conn = pickFetchConnection();
  const results = [];
  for (const s of SEED_SOURCES) {
    const started = Date.now();
    if (conn) {
      const fr = await fetchWithFallback(s.url, { attempts: 2 });
      results.push({
        id: s.id, name: s.name, url: s.url, source_category: s.source_category,
        ok: !!fr.ok, status: fr.ok ? 'ok' : fr.reason, message: fr.message || null,
        chars: fr.chars || 0, latency_ms: Date.now() - started, probe: 'web_fetch_connection',
      });
    } else {
      try {
        const res = await fetch(s.url, {
          method: 'GET',
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; CCER-public-info/2.1)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        results.push({
          id: s.id, name: s.name, url: s.url, source_category: s.source_category,
          ok: res.ok, status: res.ok ? 'ok' : `http_${res.status}`, message: null,
          chars: text.length, latency_ms: Date.now() - started, probe: 'direct_http',
        });
      } catch (e) {
        results.push({
          id: s.id, name: s.name, url: s.url, source_category: s.source_category,
          ok: false, status: 'network_error', message: `${e.message}${e.cause?.code ? `（${e.cause.code}）` : ''}`,
          chars: 0, latency_ms: Date.now() - started, probe: 'direct_http',
        });
      }
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  run(
    `INSERT INTO dataset_cursor (dataset,last_attempt_at,last_success_at,last_status,last_error,items_seen,items_new,note)
     VALUES ('seed_source_probe',?,?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
       last_status=excluded.last_status,last_error=excluded.last_error,items_seen=excluded.items_seen,
       items_new=excluded.items_new,note=excluded.note`,
    [
      nowIso(), okCount ? nowIso() : null, okCount === results.length ? 'ok' : okCount ? 'partial' : 'failed',
      results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.status}`).join(' | ').slice(0, 900),
      results.length, okCount,
      `可用 ${okCount}/${results.length}；仅「可用」的来源会被自动采集。`,
    ]
  );
  return { ok: okCount > 0, total: results.length, available: okCount, results, probed_at: nowIso() };
}

/** 公开内容模块的运行状态（后台与前端共用） */
export function contentStatus() {
  const stats = contentStats();
  const cur = get('SELECT * FROM dataset_cursor WHERE dataset=?', ['content_discovery']);
  const seedCur = get('SELECT * FROM dataset_cursor WHERE dataset=?', ['content_seed']);
  const probe = get('SELECT * FROM dataset_cursor WHERE dataset=?', ['seed_source_probe']);
  const verifyCur = get('SELECT * FROM dataset_cursor WHERE dataset=?', ['verify_content']);
  return {
    stats,
    last_discovery: cur
      ? {
          at: cur.last_attempt_at, status: cur.last_status, success_at: cur.last_success_at,
          error: cur.last_error, seen: cur.items_seen, new: cur.items_new, note: cur.note,
        }
      : null,
    last_seed_fetch: seedCur
      ? {
          at: seedCur.last_attempt_at, status: seedCur.last_status, success_at: seedCur.last_success_at,
          error: seedCur.last_error, seen: seedCur.items_seen, new: seedCur.items_new, note: seedCur.note,
        }
      : null,
    last_verify: verifyCur ? { at: verifyCur.last_attempt_at, status: verifyCur.last_status, success_at: verifyCur.last_success_at } : null,
    seed_sources: {
      total: SEED_SOURCES.length,
      enabled: SEED_SOURCES.filter((s) => s.enabled).length,
      probed_at: probe?.last_attempt_at || null,
      available: probe?.items_new ?? null,
      note: probe?.note || null,
    },
    keyword_groups: KEYWORD_GROUPS.map((g) => ({ key: g.key, label: g.label, terms: g.terms })),
    content_types: Object.entries(CONTENT_TYPES).map(([k, v]) => ({ key: k, label: v.label })),
    source_categories: Object.entries(SOURCE_CATEGORIES).map(([k, v]) => ({ key: k, label: v.label, tier: v.tier })),
    note:
      '公开研报与行业动态由搜索 API + 网页抓取连接自动采集，并由大模型按证据一致性自动核验。' +
      '全流程无人工审核环节；未配置连接时如实显示不可用，不用空结果假装采集成功。',
  };
}

export { ensureBuiltinRules };

