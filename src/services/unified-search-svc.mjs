/**
 * 统一检索（docs/74 D）
 * ============================================================================
 * 只查询公开实体白名单：政策、方法学、公开项目、研报动态、CEA 公开文件、
 * 排放因子、企业名录。表名/列名全部来自代码常量，SQL 只使用绑定参数；
 * 不查询用户、账号、审计、配置、密钥、导入任务等内部表。
 *
 * 行为：
 *   - 空查询返回最近公开记录（浏览模式），不是报错；
 *   - 中文 1 字短词、组合词、英文缩写均按 LIKE 子串检索（有界扫描）；
 *   - 类型/来源/来源类别/日期/地区筛选只作用于**支持该字段的类型**，
 *     不支持的筛选会在 filter_notes 中明确说明，不会静默清空其它类型；
 *   - 不适用筛选不会把该类型结果隐藏；
 *   - 总数 = 实际可返回结果数（受扫描预算约束，超出时 truncated=true 并说明）；
 *   - 排序稳定：相关度 → 日期 → 类型 → ID；date 模式为日期 → 相关度 → 类型 → ID。
 */
import { all, get } from '../core/db.mjs';
import { isDate, todayCst } from '../core/util.mjs';
import { sourceDisplay } from './source-display-svc.mjs';
import { aggregateProjectRows, STAGE_LABELS as PROJECT_STAGE_LABELS } from './project-aggregate.mjs';
import {
  searchIndexStatus, searchIndexType, decodeIndexRow, consumeSearchDirty,
  mergeAdminOverlays, SEARCH_INDEX_VERSION,
} from './search-index-svc.mjs';

export const SEARCH_TYPES = {
  policy: {
    key: 'policy', label: '政策文件', entity_type: 'policy_document', date_col: 'publish_date',
    source_col: 'issuing_authority', region_col: null, source_category: false,
    detail_base: '#/policies?tab=policies&keyword=',
    select: `id,title,doc_number,issuing_authority,publish_date,official_url,summary,body_snapshot,doc_status,category`,
    from: `policy_document`,
    baseWhere: [`duplicate_of IS NULL`],
    cols: ['title', 'doc_number', 'issuing_authority', 'summary', 'body_snapshot'],
    note: '政策全文/摘要来自已归档原文；效力状态不因搜索命中而改变。',
  },
  methodology: {
    key: 'methodology', label: '方法学', entity_type: 'methodology_version', date_col: 'release_date',
    source_col: null, region_col: null, source_category: false,
    detail_base: '#/policies?tab=methodologies&keyword=',
    select: `id,methodology_id,name,code_display,version,document_status,domain,release_date,effective_date,official_url,evidence_note,body_snapshot`,
    from: `methodology_version`,
    baseWhere: [],
    cols: ['name', 'code_display', 'methodology_id', 'domain', 'evidence_note', 'body_snapshot'],
    note: '方法学按版本记录；编号待核实/草案状态以库内字段为准，不在此处升格为正式。',
  },
  project: {
    key: 'project', label: '公开项目', entity_type: 'public_project', date_col: 'last_checked_at',
    source_col: 'owner_name', region_col: ['province', 'city'], source_category: false,
    detail_base: '#/projects?tab=public&q=',
    select: `id,name,registry_project_no,owner_name,province,city,domain,current_stage,methodology_id,official_url,last_checked_at,updated_at,note,owner_announced_estimate,verified_amount,registered_amount,
      stage_project_public,stage_validated,stage_project_registered,stage_reduction_public,stage_verified,stage_reduction_registered`,
    from: `public_project`,
    baseWhere: [`COALESCE(is_demo,0)=0`],
    cols: ['name', 'registry_project_no', 'owner_name', 'province', 'city', 'domain', 'methodology_id', 'note'],
    note: '按官方登记编号去重、阶段取并集（与总览同一口径）；三套数字（公示预计/核查/登记）不合并；项目日期为最近核对日期。',
  },
  content: {
    key: 'content', label: '研报与行业动态', entity_type: 'content_item', date_col: 'published_at',
    source_col: 'publisher', region_col: null, source_category: true,
    detail_base: '#/content?q=',
    select: `id,title,publisher,author,source_category,published_at,source_url,summary,auto_summary,body_snapshot,content_type,body_availability,industry,topics_json`,
    from: `content_item`,
    baseWhere: [`is_demo=0`, `duplicate_of IS NULL`, `record_kind='article'`, `COALESCE(process_status,'')<>'failed_fetch'`],
    cols: ['title', 'publisher', 'author', 'summary', 'auto_summary', 'body_snapshot', 'industry'],
    note: '搜索摘要不等于原文；正文可得性在结果字段中如实标注，演示条目与转载副本不计入。',
  },
  cea_document: {
    key: 'cea_document', label: 'CEA 公开文件', entity_type: 'cea_document', date_col: 'publish_date',
    source_col: 'issuer', region_col: null, source_category: false,
    detail_base: '#/cea?tab=docs&q=',
    select: `id,title,issuer,doc_type,publish_date,official_url,page_url,note,body_snapshot,data_cutoff_date,evidence_level,count_in_stats`,
    from: `cea_document`,
    baseWhere: [],
    cols: ['title', 'issuer', 'note', 'body_snapshot'],
    note: 'CEA 文件以原文/页面为准；附件行与正文行可能同时存在，各自保留来源。',
  },
  factor: {
    key: 'factor', label: '公开排放因子', entity_type: 'emission_factor', date_col: 'publish_date',
    source_col: 'source_code', region_col: ['region'], source_category: false,
    detail_base: '#/measure?tab=factors&q=',
    select: `id,name,category,region,value,original_unit,standard_unit,publish_date,original_url,source_code,caliber,locator,data_year`,
    from: `emission_factor`,
    baseWhere: [`is_current=1`],
    cols: ['name', 'category', 'region', 'source_code', 'caliber', 'locator'],
    note: '因子值附单位与年份；当前版本只检索 is_current=1，历史版本不混入结果。',
  },
  entity: {
    key: 'entity', label: '企业名录', entity_type: 'cea_entity', date_col: 'data_as_of',
    source_col: 'source_code', region_col: ['province', 'city'], source_category: false,
    detail_base: '#/cea?tab=entities&q=',
    select: `id,name,credit_code,province,city,sector,list_year,status,source_url,source_code,data_as_of,verify_status`,
    from: `cea_entity`,
    baseWhere: [],
    cols: ['name', 'credit_code', 'province', 'city', 'sector'],
    note: '企业名录是公开名录记录，不代表持仓、买家身份或履约义务。',
  },
};

export const SEARCH_TYPE_KEYS = Object.keys(SEARCH_TYPES);
export const MAX_QUERY_CHARS = 100;
export const MAX_PAGE_SIZE = 50;
export const MAX_OFFSET = 10000;
export const MAX_SCAN_PER_TYPE = 400;

function escLike(value) {
  return String(value).replace(/[\\%_]/g, (m) => `\\${m}`);
}

function normQuery(q) {
  return String(q || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_QUERY_CHARS);
}

function queryTerms(q) {
  const full = normQuery(q);
  if (!full) return [];
  const parts = full.split(/\s+/).filter(Boolean).slice(0, 4);
  return [...new Set([full, ...parts])].slice(0, 5);
}

function parseFilters(input = {}) {
  const pageSize = Math.max(1, Math.min(Number(input.page_size) || 10, MAX_PAGE_SIZE));
  // 页码必须与最终 offset 一致：先按扫描预算限制页码，再由页码推导 offset。
  // 只截断 offset 而保留 page=25 会让第 2 页重复第 1 页内容（独立回归 140）。
  const maxPage = Math.max(1, Math.floor(MAX_OFFSET / pageSize) + 1);
  const page = Math.max(1, Math.min(Number(input.page) || 1, maxPage));
  const offsetRaw = Number(input.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0
    ? Math.min(Math.floor(offsetRaw), MAX_OFFSET)
    : (page - 1) * pageSize;
  const effectivePage = Number.isFinite(offsetRaw) && offsetRaw >= 0
    ? Math.floor(offset / pageSize) + 1
    : page;
  const types = Array.isArray(input.types)
    ? input.types.map(String).filter((t) => SEARCH_TYPES[t])
    : String(input.types || '').split(',').map((s) => s.trim()).filter((t) => SEARCH_TYPES[t]);
  const from = String(input.from || input.date_from || '').slice(0, 10);
  const to = String(input.to || input.date_to || '').slice(0, 10);
  return {
    q: normQuery(input.q),
    terms: queryTerms(input.q),
    types: types.length ? [...new Set(types)] : SEARCH_TYPE_KEYS.slice(),
    source: String(input.source || '').trim().slice(0, 60),
    source_category: String(input.source_category || '').trim().slice(0, 30),
    region: String(input.region || '').trim().slice(0, 30),
    from: isDate(from) ? from : null,
    to: isDate(to) ? to : null,
    sort: input.sort === 'date' ? 'date' : 'relevance',
    page: effectivePage,
    page_size: pageSize,
    offset,
  };
}

/**
 * 公开字段的“生效值”：active admin_revision 有该字段时用覆盖值（含显式 NULL），
 * 否则用原始列。仅用于白名单表/列常量，不接受用户输入拼 SQL。
 */
function effectivePublicColumn(spec, column) {
  if (!column) return null;
  const idExpr = `CAST(${spec.from}.id AS TEXT)`;
  const where = `ar.entity_type='${spec.entity_type}' AND ar.entity_id=${idExpr} AND ar.status='active' AND ar.field_key='${column}'`;
  return `(CASE WHEN EXISTS (SELECT 1 FROM admin_revision ar WHERE ${where})
    THEN (SELECT ar.value FROM admin_revision ar WHERE ${where} ORDER BY ar.revision_no DESC LIMIT 1)
    ELSE ${column} END)`;
}

function buildWhere(spec, f, notes, unknownDateTypes) {
  const where = [...spec.baseWhere];
  const params = [];
  const terms = [...new Set([...(f.terms || []), ...(f.expansion_terms || [])])];
  if (terms.length) {
    const rawClause = spec.cols.map((c) => `REPLACE(COALESCE(${c},''),' ','') LIKE ? ESCAPE '\\'`).join(' OR ');
    // 索引不可用时也不能漏掉管理员公开覆盖层：SQL 同时匹配 active admin_revision 的公开字段。
    // entity_type/字段名全部来自代码常量，只有搜索词走参数绑定。
    const overlayClause = `EXISTS (
      SELECT 1 FROM admin_revision ar
       WHERE ar.entity_type=? AND ar.entity_id=CAST(${spec.from}.id AS TEXT)
         AND ar.status='active'
         AND ar.field_key IN (${spec.cols.map(() => '?').join(',')})
         AND REPLACE(COALESCE(ar.value,''),' ','') LIKE ? ESCAPE '\\')`;
    const group = terms.map(() => `((${rawClause}) OR (${overlayClause}))`);
    where.push(`(${group.join(' OR ')})`);
    for (const term of terms) {
      const pattern = `%${escLike(term.replace(/\s+/g, ''))}%`;
      for (let i = 0; i < spec.cols.length; i += 1) params.push(pattern);
      params.push(spec.entity_type, ...spec.cols, pattern);
    }
  }
  if (f.from || f.to) {
    if (!spec.date_col) {
      notes.push(`${spec.label}没有日期字段，日期筛选未应用。`);
    } else {
      const effectiveDate = effectivePublicColumn(spec, spec.date_col);
      if (f.from) { where.push(`${effectiveDate} >= ?`); params.push(f.from); }
      if (f.to) { where.push(`${effectiveDate} <= ?`); params.push(f.to); }
      if (spec.key === 'content') {
        // 内容发布日期可能未披露：日期筛选下不能把 NULL 当成窗口内日期。
        where.push(`${effectiveDate} IS NOT NULL`);
        unknownDateTypes.push(spec.key);
      }
    }
  }
  if (f.source) {
    if (!spec.source_col) {
      notes.push(`${spec.label}没有可用的来源字段，来源筛选未应用。`);
    } else {
      where.push(`${effectivePublicColumn(spec, spec.source_col)} LIKE ? ESCAPE '\\'`);
      params.push(`%${escLike(f.source)}%`);
    }
  }
  if (f.source_category) {
    if (!spec.source_category) {
      notes.push(`${spec.label}没有来源类别字段，来源类别筛选未应用。`);
    } else {
      where.push('source_category = ?');
      params.push(f.source_category);
    }
  }
  if (f.region) {
    if (!spec.region_col) {
      notes.push(`${spec.label}没有地区字段，地区筛选未应用；该类型结果仍保留。`);
    } else {
      const cols = Array.isArray(spec.region_col) ? spec.region_col : [spec.region_col];
      where.push(`(${cols.map((c) => `${effectivePublicColumn(spec, c)} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      for (let i = 0; i < cols.length; i += 1) params.push(`%${escLike(f.region)}%`);
    }
  }
  return { where: where.join(' AND ') || '1=1', params };
}

function snippetOf(row, terms) {
  const candidates = [row.summary, row.auto_summary, row.note, row.caliber, row.evidence_note, row.body_snapshot]
    .filter((x) => x && String(x).trim());
  if (terms.length) {
    for (const c of candidates) {
      const text = String(c);
      const idx = terms.map((t) => text.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (idx !== undefined) {
        const start = Math.max(0, idx - 70);
        return text.slice(start, Math.min(text.length, idx + 190)).replace(/\s+/g, ' ').trim();
      }
    }
  }
  const first = candidates[0] ? String(candidates[0]) : '';
  return first.replace(/\s+/g, ' ').slice(0, 240);
}

function scoreOf(row, terms) {
  const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
  const title = norm([row.title, row.name, row.code_display, row.doc_number, row.registry_project_no, row.credit_code].filter(Boolean).join(' '));
  const source = norm([row.issuing_authority, row.publisher, row.issuer, row.owner_name, row.source_code].filter(Boolean).join(' '));
  const summary = norm([row.summary, row.auto_summary, row.note, row.caliber, row.evidence_note].filter(Boolean).join(' '));
  const body = norm(row.body_snapshot || '');
  let score = 0;
  for (const t of terms) {
    const n = norm(t);
    if (!n) continue;
    if (title.includes(n)) score += 10;
    else if (source.includes(n)) score += 5;
    else if (summary.includes(n)) score += 3;
    else if (body.includes(n)) score += 1;
  }
  const date = String(row.date || '');
  if (date) {
    const days = (Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86400000;
    if (Number.isFinite(days) && days >= 0 && days <= 90) score += 2;
    else if (Number.isFinite(days) && days <= 365) score += 1;
  }
  return score;
}

function normalizeRow(spec, row) {
  const title = String(row.title || row.name || '(无标题)');
  const date = spec.date_col ? (row[spec.date_col] || null) : null;
  const url = row.official_url || row.source_url || row.page_url || row.original_url || null;
  const sourceName = row.issuing_authority || row.publisher || row.issuer || row.owner_name
    || row.source_code || (spec.key === 'entity' ? 'CEA 公开企业名录' : null)
    || (spec.key === 'methodology' ? '方法学归档（以原文为准）' : null)
    || (spec.key === 'factor' ? '公开排放因子库' : null);
  const projectStage = spec.key === 'project'
    ? (PROJECT_STAGE_LABELS[row.current_stage] || row.current_stage || null)
    : null;
  return {
    entity_type: spec.entity_type,
    entity_id: String(row.id),
    type: spec.key,
    type_label: spec.label,
    title,
    subtitle: row.code_display || row.doc_number || row.registry_project_no || row.credit_code || null,
    snippet: snippetOf(row, []),
    date: date ? String(date).slice(0, 10) : null,
    // 日期口径分开：项目 last_checked_at 是核对时间，企业 data_as_of 是名录数据截止日；
    // 都不能被界面统一写成「发布日期」。
    date_label: spec.key === 'project' ? '最近核对日期'
      : spec.key === 'entity' ? '名录数据截至'
        : '发布日期',
    source: sourceName || '来源未标注',
    source_category: row.source_category || null,
    source_display: sourceDisplay({ url, publisher: sourceName, source_category: row.source_category }),
    original_url: /^https?:\/\//i.test(String(url || '')) ? String(url) : null,
    detail_url: `${spec.detail_base}${encodeURIComponent(title.slice(0, 40))}`,
    locator: row.clause_ref || row.locator || (row.body_snapshot ? '正文快照' : '公开字段'),
    page_number: null,
    status: projectStage || row.doc_status || row.document_status || row.current_stage || row.verify_status || row.status || row.evidence_level || null,
    manual_revision: !!row.manual_revision,
    manual_fields: Array.isArray(row.manual_fields) ? row.manual_fields : [],
    extra: spec.key === 'project'
      ? { province: row.province, city: row.city, methodology_id: row.methodology_id, owner_announced_estimate: row.owner_announced_estimate, verified_amount: row.verified_amount, registered_amount: row.registered_amount, stage_union: true }
      : spec.key === 'entity'
        ? { province: row.province, city: row.city, sector: row.sector, list_year: row.list_year }
        : spec.key === 'factor'
          ? { value: row.value, unit: row.standard_unit || row.original_unit, data_year: row.data_year, region: row.region }
          : spec.key === 'content'
            ? { publisher: row.publisher, body_availability: row.body_availability, content_type: row.content_type, industry: row.industry }
            : spec.key === 'cea_document'
              ? { doc_type: row.doc_type, data_cutoff_date: row.data_cutoff_date }
              : spec.key === 'methodology'
                ? { version: row.version, domain: row.domain, effective_date: row.effective_date }
                : {},
    body_available: spec.key === 'content' ? row.body_availability || null : null,
  };
}

/**
 * 统一检索主入口。
 * 有查询词且 FTS5 索引完整时走索引；索引未构建/损坏/查询失败时如实回退
 * 既有 LIKE 检索，并在 mode / fallback_reason 中说明，不把失败当无结果。
 */
export function searchUnified(input = {}, { expansionTerms = [] } = {}) {
  const f = parseFilters(input);
  const notes = [];
  const status = searchIndexStatus();
  if (!status.ready) {
    notes.push(status.note || '全文索引未就绪，已回退既有检索。');
    return searchLegacy(f, notes, {
      mode: 'legacy_fallback',
      fallbackReason: status.available ? 'index_not_ready' : 'index_unavailable',
      indexStatus: status,
    });
  }
  // 查询只做有界 dirty 消费：最多刷新少量已变化的公开实体，不在查询时全库重建。
  // 仍有剩余 dirty 时回退 legacy（直接读源表），绝不把旧 payload 当最新文本。
  let refresh = { ok: true, consumed: 0, remaining: status.dirty_count || 0, errors: [] };
  try {
    refresh = consumeSearchDirty({ maxDocs: 25, actor: 'system:search-query' });
  } catch (e) {
    refresh = { ok: false, consumed: 0, remaining: status.dirty_count || 0, errors: [e.message] };
  }
  status.dirty_count = refresh.remaining;
  if (refresh.remaining > 0) {
    notes.push(
      `全文索引仍有 ${refresh.remaining} 条源数据变化待刷新（本次查询已刷新 ${refresh.consumed} 条）；` +
      '为避免把旧索引内容当最新文本，本次已回退既有检索。'
    );
    return searchLegacy(f, notes, {
      mode: 'legacy_fallback', fallbackReason: 'index_dirty', indexStatus: status,
    });
  }
  // 模型扩展词只做候选召回；原查询保留，类型/地区/年度/来源筛选完全不变。
  f.expansion_terms = [...new Set((Array.isArray(expansionTerms) ? expansionTerms : [])
    .map((t) => String(t || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 4);
  try {
    return searchIndexed(f, notes, status);
  } catch (e) {
    notes.push(`全文索引查询失败（${e.message}），已回退既有检索；这不是“没有结果”。`);
    return searchLegacy(f, notes, {
      mode: 'legacy_fallback', fallbackReason: 'index_query_failed', indexStatus: status,
    });
  }
}

function addFilterBoundaryNotes(f, notes) {
  const chosen = f.types.map((t) => SEARCH_TYPES[t]).filter(Boolean);
  if ((f.from || f.to) && chosen.some((s) => !s.date_col)) {
    notes.push('部分类型没有日期字段，日期筛选未应用到这些类型；它们的结果仍保留。');
  }
  if (f.source && chosen.some((s) => !s.source_col)) {
    notes.push('部分类型没有可用的来源字段，来源筛选未应用到这些类型。');
  }
  if (f.source_category && chosen.some((s) => !s.source_category)) {
    notes.push('来源类别筛选只作用于研报/行业动态；其它类型不因此被清空。');
  }
  if (f.region && chosen.some((s) => !s.region_col)) {
    notes.push('地区筛选只作用于公开项目、排放因子与企业名录；其它类型仍保留在结果中并已标注。');
  }
}

function searchIndexed(f, notes, status) {
  const perType = {};
  const collected = [];
  const allTerms = [...new Set([...(f.terms || []), ...(f.expansion_terms || [])])];
  let matchedTotal = 0;
  const fetchLimit = Math.min(f.offset + f.page_size, MAX_OFFSET + MAX_PAGE_SIZE);

  for (const type of f.types) {
    const spec = SEARCH_TYPES[type];
    if (!spec) continue;
    const res = searchIndexType(type, f, { fetchLimit });
    if (res.error) throw new Error(`${spec.label}：${res.error}`);
    if (f.q && !res.match) throw new Error(`${spec.label}：查询词无法构成索引条件`);
    matchedTotal += res.count;
    perType[type] = {
      count: res.count, raw_rows: res.rows.length, returned: 0,
      truncated: false, index: 'fts5', match: res.match || null,
      ...(spec.key === 'project' ? { dedupe: 'registry_project_no_or_id_indexed' } : {}),
    };
    for (const indexRow of res.rows) {
      const row = decodeIndexRow(indexRow);
      if (!row) continue;
      const norm = normalizeRow(spec, row);
      const rankBonus = Number.isFinite(Number(indexRow.rank))
        ? Math.max(0, 20 - Math.abs(Number(indexRow.rank))) : 0;
      collected.push({
        ...norm,
        snippet: snippetOf(row, allTerms),
        score: scoreOf({ ...row, date: norm.date }, allTerms) + rankBonus,
        matched_terms: allTerms.filter((t) => JSON.stringify(row).replace(/\s+/g, '').includes(t.replace(/\s+/g, ''))),
        indexed_at: indexRow.indexed_at || null,
      });
      perType[type].returned += 1;
    }
  }

  const byEntity = new Map();
  for (const r of collected) {
    const key = `${r.entity_type}:${r.entity_id}`;
    if (!byEntity.has(key) || byEntity.get(key).score < r.score) byEntity.set(key, r);
  }
  let list = [...byEntity.values()];
  list.sort((a, b) => {
    if (f.sort === 'date') {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d) return d;
    }
    if (b.score !== a.score) return b.score - a.score;
    const d = String(b.date || '').localeCompare(String(a.date || ''));
    if (d) return d;
    const t = String(a.type).localeCompare(String(b.type));
    if (t) return t;
    return String(a.entity_id).localeCompare(String(b.entity_id));
  });

  const total = matchedTotal;
  const pageRows = list.slice(f.offset, f.offset + f.page_size);
  const paginationTruncated = total > MAX_OFFSET + f.page_size;
  if (paginationTruncated) {
    notes.push(`当前分页最多可翻到 offset ${MAX_OFFSET}；总数仍按索引真实命中数显示，更多结果请缩小关键词或筛选范围。`);
  }
  addFilterBoundaryNotes(f, notes);
  if (f.types.includes('project')) {
    notes.push('公开项目索引按官方登记编号去重、阶段取并集；与总览/地图同一口径。');
  }
  notes.push(
    `全文索引模式（FTS5 双字切分，${SEARCH_INDEX_VERSION}）：总数来自索引真实 COUNT，` +
    '不再受旧版单类型 400 条日期扫描预算限制；索引内容由后台/每日任务增量刷新。'
  );

  return {
    ok: true,
    query: f.q,
    expansion_terms: f.expansion_terms || [],
    empty_query: !f.q,
    mode: 'fts5',
    index: {
      version: status.version || SEARCH_INDEX_VERSION,
      doc_count: status.doc_count,
      last_build_at: status.last_build_at,
      last_full_build_at: status.last_full_build_at,
    },
    types: f.types,
    filters: {
      source: f.source || null, source_category: f.source_category || null,
      region: f.region || null, from: f.from, to: f.to, sort: f.sort,
    },
    page: f.page,
    page_size: f.page_size,
    offset: f.offset,
    total,
    total_pages: Math.max(1, Math.ceil(total / f.page_size)),
    truncated: paginationTruncated,
    pagination_truncated: paginationTruncated,
    matched_total: total,
    results: pageRows,
    per_type: perType,
    filter_notes: [...new Set(notes)],
    generated_at: new Date().toISOString(),
    disclaimer:
      '全文索引只覆盖本库已收录的公开实体；索引命中不等于官方确认，搜索摘要不能代替原文。' +
      '未命中不代表全网没有公开信息，可能只是本库尚未收录。',
  };
}

function searchLegacy(f, notes, { mode = 'legacy', fallbackReason = null, indexStatus = null } = {}) {
  const unknownDateTypes = [];
  const perType = {};
  const collected = [];
  const allTerms = [...new Set([...(f.terms || []), ...(f.expansion_terms || [])])];
  let anyTruncated = false;
  let matchedTotal = 0;

  for (const type of f.types) {
    const spec = SEARCH_TYPES[type];
    if (!spec) continue;
    const where = buildWhere(spec, f, notes, unknownDateTypes);
    let count = 0;
    let rows = [];
    try {
      count = Number(get(`SELECT COUNT(*) c FROM ${spec.from} WHERE ${where.where}`, where.params)?.c || 0);
      rows = all(
        `SELECT ${spec.select} FROM ${spec.from} WHERE ${where.where}
         ORDER BY ${spec.date_col ? `${spec.date_col} DESC NULLS LAST,` : ''} id DESC
         LIMIT ?`,
        [...where.params, MAX_SCAN_PER_TYPE]
      );
    } catch (e) {
      notes.push(`${spec.label}检索失败（${e.message}）；该类型结果暂时不可用，不代表库内没有公开信息。`);
      perType[type] = { count: 0, returned: 0, error: e.message };
      continue;
    }
    // 公开项目按官方登记编号去重、阶段取并集，与总览/省域地图同一口径；
    // 不能把同一项目的多行阶段记录当成多个项目（Codex 复查 299 vs 237）。
    let typeRows = rows;
    let typeCount = count;
    if (spec.key === 'project') {
      const agg = aggregateProjectRows(rows);
      typeRows = mergeAdminOverlays(type, agg.projects);
      typeCount = agg.total;
    } else {
      typeRows = mergeAdminOverlays(type, rows);
    }
    matchedTotal += typeCount;
    if (count > rows.length) anyTruncated = true;
    perType[type] = {
      count: typeCount, raw_rows: rows.length, returned: 0,
      truncated: count > rows.length,
      ...(spec.key === 'project' ? { dedupe: 'registry_project_no_or_id', raw_match_count: count } : {}),
    };
    for (const row of typeRows) {
      const norm = normalizeRow(spec, row);
      const score = scoreOf({ ...row, date: norm.date }, allTerms);
      if ((f.q || allTerms.length) && score <= 0) continue;
      collected.push({
        ...norm,
        snippet: snippetOf(row, allTerms),
        score,
        matched_terms: allTerms.filter((t) => JSON.stringify(row).replace(/\s+/g, '').includes(t.replace(/\s+/g, ''))),
      });
      perType[type].returned += 1;
    }
  }

  const byEntity = new Map();
  for (const r of collected) {
    const key = `${r.entity_type}:${r.entity_id}`;
    if (!byEntity.has(key) || byEntity.get(key).score < r.score) byEntity.set(key, r);
  }
  let list = [...byEntity.values()];
  list.sort((a, b) => {
    if (f.sort === 'date') {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d) return d;
    }
    if (b.score !== a.score) return b.score - a.score;
    const d = String(b.date || '').localeCompare(String(a.date || ''));
    if (d) return d;
    const t = String(a.type).localeCompare(String(b.type));
    if (t) return t;
    return String(a.entity_id).localeCompare(String(b.entity_id));
  });
  const reachableCap = MAX_OFFSET + f.page_size;
  const paginationTruncated = list.length > reachableCap;
  if (paginationTruncated) list = list.slice(0, reachableCap);
  const total = list.length;
  const pageRows = list.slice(f.offset, f.offset + f.page_size);
  notes.push('结果总数按实际可返回记录计算；单类型最多扫描 400 条，超出时 truncated=true，请用筛选缩小范围。');
  if (paginationTruncated) notes.push(`分页预算上限为 ${reachableCap} 条；更多匹配请缩小关键词或筛选范围。`);
  if (unknownDateTypes.length && (f.from || f.to)) {
    notes.push('研报/动态中发布日期未披露的条目不参与日期筛选（无法确认落在所选区间），也不会用采集日期冒充。');
  }
  if (f.region) notes.push('地区筛选只作用于公开项目、排放因子与企业名录；其它类型仍保留在结果中并已标注。');
  if (f.source_category) notes.push('来源类别筛选只作用于研报/行业动态；其它类型不因此被清空。');
  if (f.types.includes('project')) notes.push('公开项目按官方登记编号去重、阶段取并集；原始阶段行数保留在 per_type.raw_match_count 供审计。');

  return {
    ok: true,
    query: f.q,
    expansion_terms: f.expansion_terms || [],
    empty_query: !f.q,
    mode,
    fallback_reason: fallbackReason,
    index: indexStatus ? {
      ready: indexStatus.ready, version: indexStatus.version || null,
      doc_count: indexStatus.doc_count || 0, note: indexStatus.note || null,
    } : null,
    types: f.types,
    filters: {
      source: f.source || null, source_category: f.source_category || null,
      region: f.region || null, from: f.from, to: f.to, sort: f.sort,
    },
    page: f.page,
    page_size: f.page_size,
    offset: f.offset,
    total,
    total_pages: Math.max(1, Math.ceil(total / f.page_size)),
    truncated: anyTruncated || paginationTruncated,
    pagination_truncated: paginationTruncated,
    matched_total: matchedTotal,
    results: pageRows,
    per_type: perType,
    filter_notes: [...new Set(notes)],
    generated_at: new Date().toISOString(),
    disclaimer:
      '统一检索只覆盖列出的公开实体；搜索摘要不能代替原文，AI 问答的使用需回到实体 ID 与原文链接核对。' +
      '未命中不代表全网没有公开信息，可能只是本库尚未收录。',
  };
}

/** 元数据：类型、适用筛选、当前条目数。 */
export function searchMeta() {
  const types = Object.entries(SEARCH_TYPES).map(([key, spec]) => {
    let count = 0;
    try {
      const where = spec.baseWhere.length ? ` WHERE ${spec.baseWhere.join(' AND ')}` : '';
      if (key === 'project') {
        // 与总览/检索结果同一口径：按登记编号去重，不把阶段行当项目数。
        count = Number(get(
          `SELECT COUNT(DISTINCT COALESCE(NULLIF(registry_project_no,''), id)) c FROM public_project${where}`
        )?.c || 0);
      } else {
        count = Number(get(`SELECT COUNT(*) c FROM ${spec.from}${where}`)?.c || 0);
      }
    } catch { count = 0; }
    return {
      key, label: spec.label, entity_type: spec.entity_type, count,
      supports: {
        date: !!spec.date_col,
        source: !!spec.source_col,
        source_category: !!spec.source_category,
        region: !!spec.region_col,
      },
      note: spec.note,
    };
  });
  return {
    types,
    sorts: [
      { key: 'relevance', label: '相关度' },
      { key: 'date', label: '日期（新→旧）' },
    ],
    limits: {
      max_query_chars: MAX_QUERY_CHARS,
      max_page_size: MAX_PAGE_SIZE,
      max_offset: MAX_OFFSET,
      scan_per_type: MAX_SCAN_PER_TYPE,
    },
    note: '检索不包含用户、账号、审计日志、配置、密钥或导入任务；空查询返回各类型最近记录。',
    semantic: {
      mode: 'explicit_post_only',
      action: 'POST /api/v2/search/semantic',
      max_terms: 4,
      note: '语义扩展只在显式点击时调用一次模型；精确编号不扩展；失败回退关键词并标注。',
    },
    today: todayCst(),
    index: searchIndexStatus(),
    mode_note: 'FTS5 索引完整时（含空查询浏览）使用 mode=fts5；索引未构建/损坏时回退 mode=legacy_fallback，不把失败当无结果。',
  };
}
