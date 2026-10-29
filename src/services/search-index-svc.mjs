/**
 * 中文全文索引（docs/86 第二阶段第 1 节）
 * ============================================================================
 * 目标：
 *   · 可重建、增量/hash 识别；查询不得每次全库重建；
 *   · 中文按“双字词 + 单字”切分，英文/编号保留（含 - _ .），
 *     支持“瓦斯”两字词与 CCER-10-001 这类编号；
 *   · 保留统一检索的类型、来源、来源类别、地区、日期过滤与项目去重口径；
 *   · 总数来自索引真实 COUNT，分页可真实到达，不再受旧版单类型 400 条
 *     日期扫描预算限制；
 *   · 索引不可用时由统一检索如实回退既有 LIKE 检索，并显示 mode。
 *
 * 设计：
 *   search_index_doc 保存可展示 payload、来源 hash 与过滤列；
 *   search_index_fts 是 FTS5 外部内容表，由触发器与 doc 表同步。
 *   查询只 JOIN 这两张表，不再回表扫描业务表。
 */
import { createHash } from 'node:crypto';
import { all, get, run, audit } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';
import { SEARCH_TYPES } from './unified-search-svc.mjs';
import { aggregateProjectRows } from './project-aggregate.mjs';

export const SEARCH_INDEX_VERSION = 'fts5-zh-bigram-v1';
export const SEARCH_INDEX_MAX_BODY = 80000;
export const SEARCH_INDEX_DEFAULT_BATCH = 2000;
export const SEARCH_INDEX_MAX_BATCH = 20000;

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const LATIN_TOKEN_RE = /[A-Za-z0-9._-]/;

export function indexMeta(key, fallback = null) {
  try {
    return get('SELECT value FROM search_index_meta WHERE key=?', [key])?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function setIndexMeta(key, value, now = nowIso()) {
  run(
    `INSERT INTO search_index_meta(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, String(value ?? ''), now]
  );
}

export function searchIndexDirtyCount(type = null) {
  try {
    return Number((type
      ? get('SELECT COUNT(*) c FROM search_index_dirty WHERE type=?', [type])
      : get('SELECT COUNT(*) c FROM search_index_dirty'))?.c || 0);
  } catch {
    return 0;
  }
}

function clearDirty(type, entityId = null) {
  try {
    if (entityId === null) run('DELETE FROM search_index_dirty WHERE type=?', [type]);
    else run('DELETE FROM search_index_dirty WHERE type=? AND entity_id=?', [type, String(entityId)]);
  } catch {
    /* dirty 表不存在时不影响旧库只读流程 */
  }
}

export function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** NFKC + 常见全角/破折号归一；只影响检索，不改原正文。 */
export function normalizeTokenText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[—–−]/g, '-')
    .replace(/\u3000/g, ' ')
    .toLowerCase();
}

/**
 * 中文连续串：先输出全部双字词，再在串尾补单字（保证单字查询可用，
 * 同时不打断双字词的相邻位置，短语查询“甲烷回收”仍可命中）。
 */
function tokenizeCjkRun(runText) {
  const chars = Array.from(runText);
  const out = [];
  if (chars.length === 1) out.push(chars[0]);
  else for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
  for (const ch of chars) out.push(ch);
  return out;
}

/**
 * 预切分。输出 token 用空格连接，交给 FTS5 unicode61(tokenchars -_.);
 * token 本身只含字母/数字/中文/._-，不会引入 MATCH 语法。
 */
export function tokenizeForIndex(text) {
  const src = normalizeTokenText(text).slice(0, SEARCH_INDEX_MAX_BODY);
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (CJK_RE.test(ch)) {
      let j = i + 1;
      while (j < src.length && CJK_RE.test(src[j])) j += 1;
      tokens.push(...tokenizeCjkRun(src.slice(i, j)));
      i = j;
      continue;
    }
    if (LATIN_TOKEN_RE.test(ch)) {
      let j = i + 1;
      while (j < src.length && LATIN_TOKEN_RE.test(src[j])) j += 1;
      const raw = src.slice(i, j).replace(/^[._-]+|[._-]+$/g, '');
      if (raw) {
        tokens.push(raw);
        const compact = raw.replace(/[._-]/g, '');
        if (compact && compact !== raw) tokens.push(compact);
        // 编号前缀：让 CCER-10-001 也能命中 CCER-10-001-V01，同时保留完整编号。
        const parts = raw.split(/[._-]+/).filter(Boolean);
        if (parts.length > 1) {
          let acc = '';
          let accCompact = '';
          for (const part of parts) {
            acc = acc ? `${acc}-${part}` : part;
            accCompact += part;
            tokens.push(acc);
            if (accCompact !== acc) tokens.push(accCompact);
          }
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  // FTS phrase matching depends on positions. Deduplication would join unrelated
  // occurrences and erase later phrases such as “碳市场交易”.
  return tokens.join(' ');
}

/**
 * 查询词转 FTS5 MATCH 表达式：
 *   · 以空白/常见标点分段；
 *   · 每段内按中文/英文连续串切分，中文串联成双字短语，英文/编号整体成短语；
 *   · 段与段、串与串之间 AND；所有 token 加双引号，禁止把用户输入当 FTS 语法。
 */
export function buildFtsMatch(query) {
  const src = normalizeTokenText(query).trim();
  if (!src) return null;
  const segments = src.split(/[\s,，。；;、:：/\\|()[\]{}<>]+/).filter(Boolean).slice(0, 8);
  const clauses = [];
  for (const seg of segments) {
    let i = 0;
    while (i < seg.length) {
      const ch = seg[i];
      if (CJK_RE.test(ch)) {
        let j = i + 1;
        while (j < seg.length && CJK_RE.test(seg[j])) j += 1;
        const chars = Array.from(seg.slice(i, j));
        const toks = chars.length === 1
          ? [chars[0]]
          : chars.slice(0, -1).map((c, idx) => c + chars[idx + 1]);
        if (toks.length) clauses.push(`"${toks.join(' ')}"`);
        i = j;
        continue;
      }
      if (LATIN_TOKEN_RE.test(ch)) {
        let j = i + 1;
        while (j < seg.length && LATIN_TOKEN_RE.test(seg[j])) j += 1;
        const raw = seg.slice(i, j).replace(/^[._-]+|[._-]+$/g, '');
        if (raw) {
          clauses.push(`"${raw.replace(/"/g, '""')}"`);
          const compact = raw.replace(/[._-]/g, '');
          if (compact && compact !== raw) clauses.push(`"${compact.replace(/"/g, '""')}"`);
        }
        i = j;
        continue;
      }
      i += 1;
    }
  }
  const unique = [...new Set(clauses)];
  if (!unique.length) return null;
  // 同一段内的英文原文与 compact 形式都写入索引，AND 不会误伤；
  // 所有子句仍以 AND 连接，禁止用户输入直接进入 FTS 语法。
  return unique.join(' AND ');
}

function rowTitle(spec, row) {
  return String(row.title || row.name || row.code_display || row.registry_project_no || row.id || '(无标题)');
}

function rowBodyText(spec, row) {
  return spec.cols.map((c) => row[c]).filter((v) => v !== null && v !== undefined && String(v).trim())
    .join('\n').slice(0, SEARCH_INDEX_MAX_BODY);
}

function rowSourceText(spec, row) {
  if (!spec.source_col) return null;
  return row[spec.source_col] === null || row[spec.source_col] === undefined
    ? null : String(row[spec.source_col]);
}

function rowRegionText(spec, row) {
  if (!spec.region_col) return null;
  const cols = Array.isArray(spec.region_col) ? spec.region_col : [spec.region_col];
  return cols.map((c) => row[c]).filter(Boolean).join(' / ') || null;
}

/**
 * 管理覆盖层：管理员修订只读合并进索引 payload，绝不 UPDATE 业务表。
 * 索引记录 manual_revision/manual_fields/original_values；来源 hash 会随覆盖层变化，
 * 下一次重建即更新检索结果与筛选值。
 */
function overlaysForRows(entityType, ids) {
  const out = new Map();
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) return out;
  try {
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const rows = all(
        `SELECT entity_id, field_key, value FROM admin_revision
          WHERE entity_type=? AND status='active' AND entity_id IN (${chunk.map(() => '?').join(',')})`,
        [entityType, ...chunk]
      );
      for (const r of rows) {
        if (!out.has(r.entity_id)) out.set(r.entity_id, {});
        out.get(r.entity_id)[r.field_key] = r.value;
      }
    }
  } catch {
    /* 旧库没有 admin_revision 时不影响索引主流程 */
  }
  return out;
}

function mergeOverlayRow(row, overlay) {
  if (!overlay || !Object.keys(overlay).length) {
    return { ...row, manual_revision: false, manual_fields: [], original_values: {} };
  }
  const merged = { ...row };
  const original = {};
  for (const [k, value] of Object.entries(overlay)) {
    original[k] = row[k] === undefined ? null : row[k];
    merged[k] = value;
  }
  return {
    ...merged,
    manual_revision: true,
    manual_fields: Object.keys(overlay),
    original_values: original,
  };
}

/**
 * 供 legacy 回退复用的管理覆盖层合并：索引不可用时也必须显示当前公开标题，
 * 不能因为命中 SQL 原始行就把覆盖层丢掉。
 */
export function mergeAdminOverlays(type, rows = []) {
  const spec = SEARCH_TYPES[type];
  if (!spec) return rows;
  const ids = rows.map((r) => r.id);
  const overlays = overlaysForRows(spec.entity_type, ids);
  return rows.map((r) => mergeOverlayRow(r, overlays.get(String(r.id))));
}

function docForRow(type, spec, row) {
  const title = rowTitle(spec, row);
  const bodyText = rowBodyText(spec, row);
  const payload = JSON.stringify(row);
  const sourceHash = sha256Text(`${type}|${row.id}|${payload}`);
  return {
    entity_type: spec.entity_type,
    entity_id: String(row.id),
    type,
    title,
    body_text: bodyText,
    title_tokens: tokenizeForIndex(title),
    body_tokens: tokenizeForIndex(bodyText),
    date_value: spec.date_col ? (row[spec.date_col] || null) : null,
    source_text: rowSourceText(spec, row),
    region_text: rowRegionText(spec, row),
    source_category: spec.source_category ? (row.source_category || null) : null,
    payload_json: payload,
    source_hash: sourceHash,
  };
}

function upsertDoc(doc, { force = false } = {}) {
  const existing = get(
    'SELECT id, source_hash FROM search_index_doc WHERE type=? AND entity_id=?',
    [doc.type, doc.entity_id]
  );
  if (existing && !force && existing.source_hash === doc.source_hash) return 'skipped';
  const now = nowIso();
  if (existing) {
    run(
      `UPDATE search_index_doc SET entity_type=?, title=?, body_text=?, title_tokens=?, body_tokens=?,
         date_value=?, source_text=?, region_text=?, source_category=?, payload_json=?, source_hash=?,
         indexed_at=? WHERE id=?`,
      [
        doc.entity_type, doc.title, doc.body_text, doc.title_tokens, doc.body_tokens,
        doc.date_value, doc.source_text, doc.region_text, doc.source_category,
        doc.payload_json, doc.source_hash, now, existing.id,
      ]
    );
    return 'updated';
  }
  run(
    `INSERT INTO search_index_doc
       (entity_type,entity_id,type,title,body_text,title_tokens,body_tokens,date_value,
        source_text,region_text,source_category,payload_json,source_hash,indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      doc.entity_type, doc.entity_id, doc.type, doc.title, doc.body_text,
      doc.title_tokens, doc.body_tokens, doc.date_value, doc.source_text,
      doc.region_text, doc.source_category, doc.payload_json, doc.source_hash, now,
    ]
  );
  return 'inserted';
}

function sourceRows(type, { limit, offset }) {
  const spec = SEARCH_TYPES[type];
  if (!spec) return { rows: [], total: 0, aggregated: false };
  const baseWhere = spec.baseWhere.length ? ` WHERE ${spec.baseWhere.join(' AND ')}` : '';
  if (spec.key === 'project') {
    // 项目与总览/地图同一口径：按登记编号去重、阶段取并集后再索引。
    const rows = all(`SELECT ${spec.select} FROM ${spec.from}${baseWhere} ORDER BY id DESC`);
    const agg = aggregateProjectRows(rows);
    return {
      rows: agg.projects.slice(offset, offset + limit),
      total: agg.total,
      aggregated: true,
      raw_total: rows.length,
    };
  }
  const total = Number(get(`SELECT COUNT(*) c FROM ${spec.from}${baseWhere}`)?.c || 0);
  const rows = all(
    `SELECT ${spec.select} FROM ${spec.from}${baseWhere} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return { rows, total, aggregated: false };
}

/**
 * 当前“合法来源 ID 全集合”。末批清理必须用它判断，不能用本批 seen：
 * 末批 offset>0 时 seen 只含最后一页，拿它清理会误删前几批的索引行。
 */
function sourceIds(type) {
  const spec = SEARCH_TYPES[type];
  if (!spec) return new Set();
  const baseWhere = spec.baseWhere.length ? ` WHERE ${spec.baseWhere.join(' AND ')}` : '';
  if (spec.key === 'project') {
    const rows = all(`SELECT ${spec.select} FROM ${spec.from}${baseWhere} ORDER BY id DESC`);
    return new Set(aggregateProjectRows(rows).projects.map((p) => String(p.id)));
  }
  return new Set(all(`SELECT id FROM ${spec.from}${baseWhere}`).map((r) => String(r.id)));
}

function removeMissingForType(type, validIds) {
  if (!validIds) return 0;
  const existing = all('SELECT entity_id FROM search_index_doc WHERE type=?', [type]);
  let removed = 0;
  for (const row of existing) {
    if (!validIds.has(String(row.entity_id))) {
      run('DELETE FROM search_index_doc WHERE type=? AND entity_id=?', [type, String(row.entity_id)]);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 有限批次重建/增量刷新。
 * @param {{types?:string[], maxDocs?:number, offset?:number, force?:boolean, actor?:string}} opts
 * @returns {{ok:boolean, indexed:number, updated:number, skipped:number, removed:number,
 *            types:object, truncated:boolean, next:null|{type:string,offset:number},
 *            version:string, built_at:string}}
 */
export function buildSearchIndex({
  types = null, maxDocs = SEARCH_INDEX_DEFAULT_BATCH, offset = null, force = false,
  rotate = false, actor = 'system:search-index',
} = {}) {
  const selected = (Array.isArray(types) && types.length ? types : Object.keys(SEARCH_TYPES))
    .filter((t) => SEARCH_TYPES[t]);
  const limit = Math.max(1, Math.min(Number(maxDocs) || SEARCH_INDEX_DEFAULT_BATCH, SEARCH_INDEX_MAX_BATCH));
  const now = nowIso();
  const stats = {
    ok: true, indexed: 0, inserted: 0, updated: 0, skipped: 0, removed: 0,
    types: {}, truncated: false, next: null, version: SEARCH_INDEX_VERSION, built_at: now,
  };

  for (const type of selected) {
    const spec = SEARCH_TYPES[type];
    // 日常批次按每类型游标旋转；显式 offset（后台单批）优先。
    let startOffset = offset === null || offset === undefined
      ? (rotate ? Number(indexMeta(`cursor:${type}`) || 0) : 0)
      : Math.max(0, Number(offset) || 0);
    if (rotate && !(startOffset >= 0)) startOffset = 0;
    let src = sourceRows(type, { limit, offset: startOffset });
    // 游标越过当前总数（数据缩减/新插入）时回到 0，避免永久空转。
    if (rotate && startOffset > 0 && startOffset >= src.total) {
      startOffset = 0;
      src = sourceRows(type, { limit, offset: startOffset });
    }
    const overlays = overlaysForRows(spec.entity_type, src.rows.map((r) => r.id));
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const rawRow of src.rows) {
      const row = mergeOverlayRow(rawRow, overlays.get(String(rawRow.id)));
      const doc = docForRow(type, spec, row);
      const action = upsertDoc(doc, { force });
      // 单条刷新成功后即可从 dirty 队列移除；失败会向上抛出，队列保留。
      clearDirty(type, doc.entity_id);
      if (action === 'inserted') inserted += 1;
      else if (action === 'updated') updated += 1;
      else skipped += 1;
    }
    const complete = startOffset + src.rows.length >= src.total;
    // 关键：清理依据“全量合法来源 ID”，不是本批 seen。
    const removed = complete ? removeMissingForType(type, sourceIds(type)) : 0;
    if (complete) {
      // 整个类型已完整处理（项目类型聚合会读取全部来源行），可清空该类型 dirty。
      clearDirty(type);
    }
    if (rotate) {
      const nextOffset = complete ? 0 : startOffset + src.rows.length;
      setIndexMeta(`cursor:${type}`, String(nextOffset), now);
      stats.types[type] = {
        total: src.total, processed: src.rows.length, inserted, updated, skipped, removed,
        aggregated: src.aggregated, raw_total: src.raw_total ?? null,
        complete, offset: startOffset, next_offset: nextOffset,
      };
    } else {
      stats.types[type] = {
        total: src.total, processed: src.rows.length, inserted, updated, skipped, removed,
        aggregated: src.aggregated, raw_total: src.raw_total ?? null,
        complete, offset: startOffset,
      };
    }
    stats.indexed += src.rows.length;
    stats.inserted += inserted;
    stats.updated += updated;
    stats.skipped += skipped;
    stats.removed += removed;
    if (!complete && !stats.next) {
      stats.next = { type, offset: startOffset + src.rows.length };
      stats.truncated = true;
    }
  }

  setIndexMeta('version', SEARCH_INDEX_VERSION, now);
  setIndexMeta('last_build_at', now, now);
  setIndexMeta('last_batch_types', selected.join(','), now);
  const docCount = Number(get('SELECT COUNT(*) c FROM search_index_doc')?.c || 0);
  setIndexMeta('doc_count', docCount, now);
  const allTypes = Object.keys(SEARCH_TYPES);
  const fullCoverage = !stats.truncated && selected.length === allTypes.length;
  if (fullCoverage) {
    setIndexMeta('last_full_build_at', now, now);
    setIndexMeta('last_full_status', 'complete', now);
  } else if (!indexMeta('last_full_status')) {
    setIndexMeta('last_full_status', 'partial', now);
  }
  audit({
    actor, action: 'search_index.build', objectType: 'search_index', objectId: SEARCH_INDEX_VERSION,
    detail: {
      types: selected, max_docs: limit, offset: offset ?? (rotate ? 'rotate' : 0), indexed: stats.indexed,
      inserted: stats.inserted, updated: stats.updated, skipped: stats.skipped,
      removed: stats.removed, truncated: stats.truncated, doc_count: docCount,
    },
  });
  return stats;
}

/**
 * 有界消费 dirty 队列：最多刷新 maxDocs 个实体，不重建全库。
 * 查询路径只调用这个函数；仍有剩余时由调用方如实回退 legacy。
 */
export function consumeSearchDirty({ maxDocs = 25, actor = 'system:search-index' } = {}) {
  const cap = Math.max(1, Math.min(Number(maxDocs) || 25, 200));
  let rows = [];
  try {
    rows = all(
      `SELECT type, entity_id FROM search_index_dirty
        ORDER BY queued_at, type, entity_id LIMIT ?`,
      [cap]
    );
  } catch (e) {
    return { ok: false, consumed: 0, refreshed: 0, remaining: 0, errors: [e.message] };
  }
  if (!rows.length) return { ok: true, consumed: 0, refreshed: 0, remaining: 0, errors: [] };
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(String(r.entity_id));
  }
  let consumed = 0;
  let refreshed = 0;
  const errors = [];
  for (const [type, ids] of byType.entries()) {
    if (!SEARCH_TYPES[type]) {
      // 已下线的检索类型：清掉 dirty，避免永久阻塞其它类型。
      clearDirty(type);
      consumed += ids.length;
      continue;
    }
    if (type === 'project') {
      const before = searchIndexDirtyCount('project');
      try {
        const out = buildSearchIndex({
          types: ['project'], maxDocs: SEARCH_INDEX_MAX_BATCH, offset: 0, actor,
        });
        refreshed += 1;
        consumed += Math.max(0, before - searchIndexDirtyCount('project'));
        if (out.types?.project && !out.types.project.complete) {
          errors.push('project: 单批未覆盖全部公开项目，dirty 保留');
        }
      } catch (e) {
        errors.push(`project: ${e.message}`);
      }
      continue;
    }
    for (const id of ids) {
      try {
        const out = refreshSearchEntity(type, id, { actor });
        if (out?.ok && !out.skipped) {
          clearDirty(type, id);
          consumed += 1;
          refreshed += 1;
        } else if (out?.skipped) {
          errors.push(`${type}/${id}: ${out.reason || 'skipped'}`);
          break;
        }
      } catch (e) {
        errors.push(`${type}/${id}: ${e.message}`);
      }
    }
  }
  const remaining = searchIndexDirtyCount();
  return { ok: errors.length === 0, consumed, refreshed, remaining, errors: [...new Set(errors)].slice(0, 8) };
}

/** 索引状态；fts_count 与 doc_count 不一致时 ready=false（索引损坏/未建成）。 */
export function searchIndexStatus() {
  try {
    const docs = Number(get('SELECT COUNT(*) c FROM search_index_doc')?.c || 0);
    const fts = Number(get('SELECT COUNT(*) c FROM search_index_fts')?.c || 0);
    const fullStatus = indexMeta('last_full_status');
    const ready = docs > 0 && docs === fts && fullStatus === 'complete';
    return {
      available: true,
      ready,
      doc_count: docs,
      fts_count: fts,
      dirty_count: searchIndexDirtyCount(),
      version: indexMeta('version'),
      last_build_at: indexMeta('last_build_at'),
      last_full_build_at: indexMeta('last_full_build_at'),
      last_full_status: fullStatus,
      built_types: indexMeta('last_batch_types'),
      note: docs === 0
        ? '全文索引尚未构建；统一检索会如实回退既有 LIKE 检索。'
        : ready
          ? 'FTS5 中文双字索引可用；查询使用索引，不在查询时全库重建。'
          : docs !== fts
            ? 'FTS5 文档数与索引数不一致；统一检索将回退既有检索，请管理员重建。'
            : '全文索引尚未完成全类型构建；统一检索将回退既有检索，请管理员执行完整重建。',
    };
  } catch (e) {
    return {
      available: false, ready: false, doc_count: 0, fts_count: 0, dirty_count: 0,
      version: null, last_build_at: null, last_full_build_at: null,
      last_full_status: null, built_types: null,
      note: `全文索引不可用（${e.message}）；统一检索会如实回退既有 LIKE 检索。`,
    };
  }
}

function escLike(value) {
  return String(value).replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 单类型索引查询：返回真实 count 与最多 offset+page_size 条候选。
 * 只使用参数绑定；MATCH 表达式由 buildFtsMatch 生成。
 */
export function searchIndexType(type, f, { fetchLimit = 50 } = {}) {
  const spec = SEARCH_TYPES[type];
  if (!spec) return { count: 0, rows: [], error: null };
  const where = ['d.type=?'];
  const params = [type];
  // 原查询始终保留；扩展词只与其做 OR 候选合并，不替换原查询。
  const baseMatch = f.q ? buildFtsMatch(f.q) : null;
  const expansionMatches = (Array.isArray(f.expansion_terms) ? f.expansion_terms : [])
    .map((t) => buildFtsMatch(t)).filter(Boolean);
  const match = baseMatch
    ? [`(${baseMatch})`, ...expansionMatches.map((m) => `(${m})`)].join(' OR ')
    : (expansionMatches.length ? expansionMatches.map((m) => `(${m})`).join(' OR ') : null);
  try {
    if (match) {
      where.push('search_index_fts MATCH ?');
      params.push(match);
    }
    if (f.from || f.to) {
      if (spec.date_col) {
        if (f.from) { where.push('d.date_value >= ?'); params.push(f.from); }
        if (f.to) { where.push('d.date_value <= ?'); params.push(f.to); }
        if (spec.key === 'content') where.push('d.date_value IS NOT NULL');
      }
    }
    if (f.source && spec.source_col) {
      where.push("d.source_text LIKE ? ESCAPE '\\'");
      params.push(`%${escLike(f.source)}%`);
    }
    if (f.source_category && spec.source_category) {
      where.push('d.source_category = ?');
      params.push(f.source_category);
    }
    if (f.region && spec.region_col) {
      where.push("d.region_text LIKE ? ESCAPE '\\'");
      params.push(`%${escLike(f.region)}%`);
    }
    const fromSql = 'search_index_doc d JOIN search_index_fts ON search_index_fts.rowid=d.id';
    const whereSql = where.join(' AND ');
    const count = Number(get(`SELECT COUNT(*) c FROM ${fromSql} WHERE ${whereSql}`, params)?.c || 0);
    const order = match
      ? 'bm25(search_index_fts, 8.0, 1.0), d.date_value DESC, d.id DESC'
      : 'd.date_value DESC, d.id DESC';
    const rows = all(
      `SELECT d.*, ${match ? 'bm25(search_index_fts, 8.0, 1.0)' : '0'} rank
         FROM ${fromSql} WHERE ${whereSql} ORDER BY ${order} LIMIT ?`,
      [...params, Math.max(1, Math.min(Number(fetchLimit) || 50, 20050))]
    );
    return { count, rows, error: null, match };
  } catch (e) {
    return { count: 0, rows: [], error: e.message, match };
  }
}

export function decodeIndexRow(row) {
  try {
    return { ...JSON.parse(row.payload_json), __index_rank: Number(row.rank || 0), __indexed_at: row.indexed_at };
  } catch {
    return null;
  }
}

/**
 * 单实体增量刷新（当前用于 content_item 的入库/更新路径）。
 * 只有索引曾经完整构建过才更新，避免在未构建时产生“半套索引”；
 * 其它公开类型仍由后台/每日有限批次刷新。
 */
export function refreshSearchEntity(type, entityId, { actor = 'system:search-index' } = {}) {
  if (!indexMeta('last_full_build_at')) return { ok: true, skipped: true, reason: 'index_not_built' };
  const spec = SEARCH_TYPES[type];
  if (!spec) return { ok: false, error: `未知检索类型 ${type}` };
  if (spec.key === 'project') {
    return buildSearchIndex({ types: ['project'], maxDocs: SEARCH_INDEX_MAX_BATCH, actor });
  }
  const baseWhere = spec.baseWhere.length ? ` AND ${spec.baseWhere.join(' AND ')}` : '';
  const row = get(`SELECT ${spec.select} FROM ${spec.from} WHERE id=?${baseWhere}`, [String(entityId)]);
  const now = nowIso();
  if (!row) {
    run('DELETE FROM search_index_doc WHERE type=? AND entity_id=?', [type, String(entityId)]);
    clearDirty(type, entityId);
    setIndexMeta('doc_count', Number(get('SELECT COUNT(*) c FROM search_index_doc')?.c || 0), now);
    return { ok: true, action: 'removed', entity_id: String(entityId) };
  }
  const overlays = overlaysForRows(spec.entity_type, [entityId]);
  const merged = mergeOverlayRow(row, overlays.get(String(entityId)));
  const action = upsertDoc(docForRow(type, spec, merged));
  clearDirty(type, entityId);
  setIndexMeta('doc_count', Number(get('SELECT COUNT(*) c FROM search_index_doc')?.c || 0), now);
  return { ok: true, action, entity_id: String(entityId) };
}

export function removeSearchEntity(type, entityId) {
  try {
    run('DELETE FROM search_index_doc WHERE type=? AND entity_id=?', [type, String(entityId)]);
    setIndexMeta('doc_count', Number(get('SELECT COUNT(*) c FROM search_index_doc')?.c || 0));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export { SEARCH_TYPES };
