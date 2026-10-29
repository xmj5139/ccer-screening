/**
 * 历史补采（docs/74 B）
 * ============================================================================
 * 范围：当前只对「公开内容（研报 / 动态 / 观点 / 企业公告）」提供按日期窗口、
 * 按来源/查询组的补采。政策、公开项目、交易等资料的历史覆盖依赖各自的官方
 * 分页能力，本任务不会把「最近几条」冒充全量历史，界面明确列出不支持范围。
 *
 * 关键纪律：
 *   - 搜索日期条件必须由连接显式声明并实际发送（start_field/end_field）；
 *     未声明时任务阻塞并说明，不用「最近结果」冒充日期范围结果；
 *   - 结果按真实发布日期落窗；未知发布日期单列并保留 NULL，绝不默认成窗口日期；
 *   - 正文只来自实际抓取（或搜索连接直接返回的正文），搜索摘要不写入正文；
 *   - 任务、每个窗口与页码游标持久化；暂停/继续/取消/失败重试/重启恢复；
 *   - 已抓 URL/正文哈希由 upsertContent 去重；已完成页不重复调用；
 *   - 每日任务与补采共享 collection 租约，单任务并发 1。
 */
import { all, get, run } from '../core/db.mjs';
import { newId, nowIso, isDate, j, uj } from '../core/util.mjs';
import { SEED_SOURCES, KEYWORD_GROUPS, upsertContent, normalizeBody } from './content-svc.mjs';
import { pickSearchCandidates, runSearch } from './search-svc.mjs';
import { pickFetchConnection } from './web-fetch-svc.mjs';
import { fetchWithFallback } from './deepseek-fallback-svc.mjs';
import {
  acquireLease, releaseLease, getLease, reapExpiredLease, governanceConfig,
} from './governance-svc.mjs';

export const BACKFILL_DATASETS = {
  content: {
    key: 'content',
    label: '公开内容（研报 / 行业动态 / 机构观点 / 企业公告）',
    supported: true,
    date_field: 'published_at',
    note: '搜索连接须显式支持起止日期字段；正文由真实抓取连接取得。',
  },
  policy: { key: 'policy', label: '政策文件', supported: false, note: '政策历史依赖官方栏目分页；本轮未提供统一搜索日期补采，避免把最近条目称为全量。' },
  methodology: { key: 'methodology', label: '方法学', supported: false, note: '方法学按官方编号/版本归档，不走搜索历史翻页；请在方法学库核对原文。' },
  project: { key: 'project', label: '公开项目', supported: false, note: '项目历史依赖注册登记系统分页与详情抓取，当前未接入统一补采。' },
  trade: { key: 'trade', label: '交易行情', supported: false, note: '行情按官方交易日采集与核对，不能用搜索补造历史成交数据。' },
  factor: { key: 'factor', label: '排放因子', supported: false, note: '因子以官方发布文件为准，不走搜索历史补采。' },
};

const CONTENT_TYPES = new Set(['research_report', 'industry_news', 'institution_view', 'enterprise_news', 'policy_notice']);
const MAX_RANGE_DAYS = 1830; // 5 年硬上限
const MAX_WINDOWS = 1000;
const MAX_TERMS = 12;

function capabilitiesOverride(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    search_configured: input.search_configured !== false,
    date_filter_supported: input.date_filter_supported === true,
    pagination_supported: input.pagination_supported === true,
    fetch_configured: input.fetch_configured !== false,
    provider: input.provider || null,
  };
}

/** 单个搜索连接是否能把起止日期真正发送出去。 */
function providerDateMode(provider) {
  if (!provider) return 'none';
  const pm = uj(provider.param_map_json, {}) || {};
  if (pm.start_field && pm.end_field) return 'range_fields';
  if (pm.freshness_field && (pm.freshness_range === true || provider.provider_kind === 'bocha')) return 'freshness_range';
  return 'none';
}

/**
 * 只返回具备同等日期能力的连接（主服务优先）。历史补采绝不把日期条件
 * 回退到不支持的备用通道；没有同等能力时宁可阻塞，也不伪造完成。
 */
function dateCapableCandidates() {
  return pickSearchCandidates().filter((p) => providerDateMode(p) !== 'none');
}

/** 真实搜索/抓取能力（供预览、创建、启动共同使用）。 */
export function backfillCapabilities() {
  const allCandidates = pickSearchCandidates();
  const capable = allCandidates.filter((p) => providerDateMode(p) !== 'none');
  const provider = capable[0] || allCandidates[0] || null;
  const capability = capable[0] || null;
  const mode = providerDateMode(capability);
  const fetchConn = pickFetchConnection();
  return {
    search_configured: !!provider,
    date_filter_supported: capable.length > 0,
    date_filter_mode: mode,
    date_capable_providers: capable.map((p) => ({ id: p.id, name: p.name, kind: p.provider_kind, mode: providerDateMode(p) })),
    pagination_supported: !!provider && !!(uj(provider.param_map_json, {}) || {}).page_field,
    fetch_configured: !!fetchConn,
    provider: provider ? { id: provider.id, name: provider.name, kind: provider.provider_kind } : null,
    fetch: fetchConn ? { id: fetchConn.id, name: fetchConn.name, kind: fetchConn.conn_kind } : null,
    notes: [
      !provider ? '未配置搜索连接：无法发送日期条件，补采不能启动。' : null,
      provider && !capable.length
        ? '当前搜索连接均未声明可用的日期条件字段（start_field/end_field 或 freshness_range）：无法保证日期条件真正发送，补采将阻塞。'
        : null,
      provider && mode === 'freshness_range'
        ? '日期条件通过供应商 freshness 精确区间（YYYY-MM-DD..YYYY-MM-DD）发送；结果仍按真实发布日期二次过滤。'
        : null,
      capable.length > 1
        ? `备用搜索通道也限制为同等日期能力（共 ${capable.length} 个）；不会回退到不支持日期条件的连接。`
        : null,
      provider && !(uj(provider.param_map_json, {}) || {}).page_field
        ? '当前搜索连接未声明分页字段：只按日期窗口采集，不宣称覆盖全部分页结果。'
        : null,
      !fetchConn ? '未配置网页抓取连接：只能保留搜索摘要/元数据，正文阶段会标记阻塞。' : null,
    ].filter(Boolean),
  };
}

export function backfillSources() {
  const caps = backfillCapabilities();
  return {
    datasets: Object.values(BACKFILL_DATASETS).map((d) => ({ ...d })),
    query_groups: KEYWORD_GROUPS.map((g) => ({ key: g.key, label: g.label, terms: g.terms })),
    seed_sources: SEED_SOURCES.map((s) => ({
      id: s.id, name: s.name, source_category: s.source_category,
      enabled: !!s.enabled, url: s.url,
    })),
    capabilities: caps,
    note:
      '支持范围以 dataset.supported 为准；不支持的资料类型在本页明确列出，不用「最近几条」冒充全量历史。' +
      '来源筛选通过搜索连接的域名条件并本地按 hostname 复核；未知发布日期单列，不默认成窗口日期。',
  };
}

function normDomain(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return null; }
}

function hostMatches(host, domains) {
  if (!host || !domains.length) return true;
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function addDays(date, days) {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

function parseRange(input) {
  const from = String(input.date_from || input.from || '').slice(0, 10);
  const to = String(input.date_to || input.to || '').slice(0, 10);
  if (!isDate(from) || !isDate(to)) return { error: '起止日期必须是 YYYY-MM-DD', status: 400 };
  if (from > to) return { error: '起始日期不得晚于截止日期', status: 400 };
  const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) return { error: `日期范围过大（${days} 天，硬上限 ${MAX_RANGE_DAYS} 天）`, status: 400 };
  return { from, to, days };
}

function parseWindowDays(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) return null;
  return n;
}

function parseInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function buildWindows(from, to, windowDays) {
  const out = [];
  let start = from;
  let seq = 1;
  while (start <= to && out.length < MAX_WINDOWS) {
    const end = addDays(start, windowDays - 1) > to ? to : addDays(start, windowDays - 1);
    out.push({ seq, window_from: start, window_to: end });
    seq += 1;
    start = addDays(end, 1);
  }
  return out;
}

function computeTerms(input) {
  const explicit = String(input.query || '').trim();
  if (explicit) {
    const terms = explicit.split(/[\n,，、;；|]+/).map((t) => t.trim()).filter(Boolean);
    if (terms.length > MAX_TERMS) return { error: `检索词最多 ${MAX_TERMS} 个`, status: 400 };
    return { terms: terms.length ? terms : [explicit.slice(0, 100)] };
  }
  const groupKeys = Array.isArray(input.group_keys) && input.group_keys.length
    ? input.group_keys.map(String)
    : ['ccer', 'voluntary'];
  const groups = KEYWORD_GROUPS.filter((g) => groupKeys.includes(g.key));
  if (!groups.length) return { error: '未选择有效的查询组', status: 400 };
  const terms = [...new Set(groups.flatMap((g) => g.terms))].slice(0, MAX_TERMS);
  return { terms, groups: groups.map((g) => g.key) };
}

function sourceSelection(input) {
  const ids = Array.isArray(input.source_ids) ? input.source_ids.map(String).filter(Boolean).slice(0, 30) : [];
  const picked = ids.length ? SEED_SOURCES.filter((s) => ids.includes(s.id)) : [];
  const domains = [...new Set(picked.map((s) => normDomain(s.url)).filter(Boolean))];
  return { ids, sources: picked, domains };
}

function todayNote(caps) {
  const bits = [];
  if (!caps.search_configured) bits.push('未配置搜索连接');
  if (caps.search_configured && !caps.date_filter_supported) bits.push('搜索连接未声明日期字段');
  if (!caps.fetch_configured) bits.push('未配置抓取连接：正文可能阻塞');
  if (caps.search_configured && !caps.pagination_supported) bits.push('搜索连接未声明分页：仅按日期窗口');
  return bits.length ? bits.join('；') : '日期条件与正文抓取能力均已声明';
}

/**
 * 预览计划：不写库、不调用外部搜索；只计算窗口和估算调用数。
 */
export function previewBackfill(input = {}, { capabilities = null } = {}) {
  const dataset = String(input.dataset || 'content');
  const def = BACKFILL_DATASETS[dataset];
  if (!def || !def.supported) {
    return {
      error: `资料类型「${dataset}」不支持统一日期补采`,
      status: 400,
      supported: Object.values(BACKFILL_DATASETS).filter((d) => d.supported).map((d) => d.key),
      note: def?.note || '请选择受支持的资料类型。',
    };
  }
  const range = parseRange(input);
  if (range.error) return range;
  const windowDays = parseWindowDays(input.window_days || 7) || 7;
  const pageSize = parseInteger(input.page_size, 10, 1, 50);
  const maxPages = parseInteger(input.max_pages, 1, 1, 10);
  const terms = computeTerms(input);
  if (terms.error) return terms;
  const source = sourceSelection(input);
  const caps = capabilitiesOverride(capabilities) || backfillCapabilities();
  const disabled = source.sources.filter((s) => !s.enabled);
  const windows = buildWindows(range.from, range.to, windowDays);
  const pages = caps.pagination_supported ? maxPages : 1;
  const estimatedCalls = windows.length * terms.terms.length * pages;
  return {
    ok: true,
    dataset,
    dataset_label: def.label,
    date_from: range.from,
    date_to: range.to,
    range_days: range.days,
    window_days: windowDays,
    window_count: windows.length,
    windows: windows.slice(0, 60),
    terms: terms.terms,
    group_keys: terms.groups || [],
    sources: source.sources.map((s) => ({ id: s.id, name: s.name, source_category: s.source_category, enabled: !!s.enabled })),
    source_ids: source.ids,
    source_domains: source.domains,
    page_size: pageSize,
    max_pages: maxPages,
    pagination_supported: caps.pagination_supported,
    date_filter_supported: caps.date_filter_supported,
    search_configured: caps.search_configured,
    fetch_configured: caps.fetch_configured,
    provider: caps.provider,
    estimated_search_calls: estimatedCalls,
    estimated_pages_per_window: pages,
    blocking_reasons: [
      !caps.search_configured ? '未配置搜索连接，不能发送日期条件。' : null,
      caps.search_configured && !caps.date_filter_supported ? '搜索连接未声明起止日期字段，日期条件无法保证真正发送。' : null,
      disabled.length ? `所选来源已停用：${disabled.map((s) => s.name).join('、')}` : null,
      !caps.fetch_configured ? '未配置网页抓取连接：搜索摘要不会被当作正文。' : null,
      estimatedCalls > 2000 ? '估算调用次数超过单任务硬上限，请缩短范围/减少查询组。' : null,
    ].filter(Boolean),
    coverage_note:
      `按 ${windowDays} 天窗口逐窗处理；${caps.pagination_supported ? `每个窗口最多 ${maxPages} 页。` : '搜索连接未声明分页，仅处理每窗第 1 页，不宣称覆盖全部分页结果。'}` +
      '「完成」只表示计划窗口已处理，不代表全网资料完整。' + todayNote(caps),
    window_preview_truncated: windows.length > 60,
  };
}

/**
 * 创建补采任务（仅管理员）。计划窗口与游标立即持久化。
 */
export function createBackfillTask(user, input = {}, { capabilities = null } = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可创建历史补采任务', status: 403 };
  const preview = previewBackfill(input, { capabilities });
  if (!preview.ok) return preview;
  if (preview.estimated_search_calls > 2000) {
    return { error: preview.blocking_reasons.join('；') || '估算调用次数过多', status: 400, preview };
  }
  const caps = capabilitiesOverride(capabilities) || backfillCapabilities();
  if (!caps.search_configured || !caps.date_filter_supported) {
    return {
      error: '搜索连接不能保证日期条件真正发送，已拒绝创建补采任务',
      status: 409,
      preview,
      message: preview.blocking_reasons.join('；'),
    };
  }
  const disabled = preview.sources.filter((s) => !s.enabled);
  if (disabled.length) {
    return { error: `所选来源已停用：${disabled.map((s) => s.name).join('、')}`, status: 400, preview };
  }
  const id = newId('BFT');
  const now = nowIso();
  const ids = preview.source_ids;
  const options = {
    max_calls: parseInteger(input.options?.max_calls, 200, 1, 2000),
    max_ms: parseInteger(input.options?.max_ms, 120_000, 5_000, 300_000),
    page_supported: caps.pagination_supported,
  };
  run(
    `INSERT INTO backfill_task
       (id,dataset,status,source_ids_json,query,group_keys_json,terms_json,options_json,
        date_from,date_to,window_days,page_size,max_pages,page_supported,planned_windows,
        coverage_note,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, preview.dataset, 'queued', ids.length ? j(ids) : null, input.query ? String(input.query).slice(0, 100) : null,
      preview.group_keys.length ? j(preview.group_keys) : null, j(preview.terms), j(options),
      preview.date_from, preview.date_to, preview.window_days, preview.page_size, preview.max_pages,
      caps.pagination_supported ? 1 : 0, preview.window_count, preview.coverage_note,
      user.name || 'admin', now, now,
    ]
  );
  for (const w of buildWindows(preview.date_from, preview.date_to, preview.window_days)) {
    run(
      `INSERT INTO backfill_window (id,task_id,seq,window_from,window_to,status,cursor_page,updated_at)
       VALUES (?,?,?,?,?,'pending',1,?)`,
      [newId('BFW'), id, w.seq, w.window_from, w.window_to, now]
    );
  }
  return { ok: true, task: getBackfillTask(id), preview };
}

export function listBackfillTasks({ limit = 30 } = {}) {
  recoverInterruptedBackfill();
  return all(
    'SELECT * FROM backfill_task ORDER BY created_at DESC LIMIT ?',
    [Math.max(1, Math.min(Number(limit) || 30, 100))]
  ).map(taskPublic);
}

export function getBackfillTask(id) {
  const task = get('SELECT * FROM backfill_task WHERE id=?', [String(id)]);
  if (!task) return null;
  const windows = all('SELECT * FROM backfill_window WHERE task_id=? ORDER BY seq', [task.id]).map((w) => ({
    ...w,
    page_label: `${w.cursor_page}/${task.max_pages}`,
  }));
  return { ...taskPublic(task), windows, lease: getLease('collection') };
}

function taskPublic(task) {
  const windows = all(
    'SELECT status, COUNT(*) c FROM backfill_window WHERE task_id=? GROUP BY status',
    [task.id]
  );
  const byStatus = Object.fromEntries(windows.map((w) => [w.status, w.c]));
  const done = (byStatus.done || 0) + (byStatus.failed || 0) + (byStatus.skipped || 0);
  return {
    ...task,
    source_ids: uj(task.source_ids_json, []),
    group_keys: uj(task.group_keys_json, []),
    terms: uj(task.terms_json, []),
    options: uj(task.options_json, {}),
    progress: {
      windows_done: done,
      windows_total: task.planned_windows,
      percent: task.planned_windows ? Math.min(100, Math.round((done / task.planned_windows) * 100)) : 0,
      by_status: byStatus,
      cursor_window: task.cursor_window,
    },
  };
}

function taskStatus(id) {
  return get('SELECT status FROM backfill_task WHERE id=?', [String(id)])?.status || null;
}

function touchTask(id, fields = {}) {
  const allowed = new Set([
    'status', 'processed_windows', 'hits', 'inserted', 'updated', 'duplicates', 'outside_window',
    'failed', 'blocked', 'unknown_dates', 'cursor_window', 'last_error', 'started_at',
    'paused_at', 'finished_at', 'search_calls', 'page_supported',
  ]);
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`);
  const params = keys.map((k) => fields[k]);
  run(`UPDATE backfill_task SET ${sets.join(',')}, updated_at=? WHERE id=?`, [...params, nowIso(), String(id)]);
}

function windowUpdate(id, fields = {}) {
  const allowed = new Set([
    'status', 'cursor_page', 'pages_done', 'attempts', 'hits', 'inserted', 'updated',
    'duplicates', 'outside_window', 'failed', 'blocked', 'unknown_dates', 'error', 'started_at',
    'finished_at', 'search_calls',
  ]);
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`);
  const params = keys.map((k) => fields[k]);
  run(`UPDATE backfill_window SET ${sets.join(',')}, updated_at=? WHERE id=?`, [...params, nowIso(), id]);
}

/** 进程/租约中断的 running 任务转为 interrupted，窗口 running 回到 pending。 */
export function recoverInterruptedBackfill() {
  reapExpiredLease('collection');
  // 只有「running 且超过租约 TTL 没有心跳」才算进程中断；刚跑完一步、租约
  // 已释放但仍有待处理窗口的任务，下一轮可直接续跑，不应被误标 interrupted。
  const cfg = governanceConfig();
  const cutoff = new Date(Date.now() - cfg.lease_ttl_ms).toISOString();
  const stale = all(
    `SELECT t.id FROM backfill_task t
      WHERE t.status='running' AND COALESCE(t.updated_at,'') <= ?
        AND NOT EXISTS (SELECT 1 FROM governance_lease l WHERE l.lease_key='collection' AND l.expires_at > ?)`,
    [cutoff, nowIso()]
  );
  for (const t of stale) {
    run("UPDATE backfill_task SET status='interrupted', last_error=COALESCE(last_error,?), paused_at=?, updated_at=? WHERE id=?",
      ['任务中断（租约到期/进程退出），可从游标继续', nowIso(), nowIso(), t.id]);
    run("UPDATE backfill_window SET status='pending', updated_at=? WHERE task_id=? AND status='running'",
      [nowIso(), t.id]);
  }
  return { interrupted: stale.length };
}

export function pauseBackfillTask(user, id) {
  if (user?.role !== 'admin') return { error: '仅管理员可暂停', status: 403 };
  const task = get('SELECT * FROM backfill_task WHERE id=?', [String(id)]);
  if (!task) return { error: '任务不存在', status: 404 };
  if (['completed', 'cancelled', 'failed'].includes(task.status)) return { error: `任务状态 ${task.status} 不可暂停`, status: 409 };
  run("UPDATE backfill_task SET status='paused', paused_at=?, updated_at=? WHERE id=?", [nowIso(), nowIso(), task.id]);
  run("UPDATE backfill_window SET status='pending', updated_at=? WHERE task_id=? AND status='running'", [nowIso(), task.id]);
  return { ok: true, task: getBackfillTask(task.id) };
}

export function cancelBackfillTask(user, id) {
  if (user?.role !== 'admin') return { error: '仅管理员可取消', status: 403 };
  const task = get('SELECT * FROM backfill_task WHERE id=?', [String(id)]);
  if (!task) return { error: '任务不存在', status: 404 };
  if (task.status === 'completed' || task.status === 'cancelled') return { ok: true, task: getBackfillTask(task.id) };
  run("UPDATE backfill_task SET status='cancelled', finished_at=?, updated_at=? WHERE id=?", [nowIso(), nowIso(), task.id]);
  run("UPDATE backfill_window SET status='skipped', finished_at=?, updated_at=? WHERE task_id=? AND status IN ('pending','running')",
    [nowIso(), nowIso(), task.id]);
  return { ok: true, task: getBackfillTask(task.id) };
}

export function resumeBackfillTask(user, id) {
  if (user?.role !== 'admin') return { error: '仅管理员可继续', status: 403 };
  const task = get('SELECT * FROM backfill_task WHERE id=?', [String(id)]);
  if (!task) return { error: '任务不存在', status: 404 };
  if (task.status === 'cancelled') return { error: '已取消的任务不能继续，请新建', status: 409 };
  if (task.status === 'completed') return { ok: true, task: getBackfillTask(task.id), note: '任务已完成' };
  run("UPDATE backfill_task SET status='running', paused_at=NULL, last_error=NULL, updated_at=? WHERE id=?", [nowIso(), task.id]);
  run("UPDATE backfill_window SET status='pending', updated_at=? WHERE task_id=? AND status IN ('running','paused')", [nowIso(), task.id]);
  return { ok: true, task: getBackfillTask(task.id) };
}

export function retryBackfillTask(user, id) {
  if (user?.role !== 'admin') return { error: '仅管理员可重试', status: 403 };
  const task = get('SELECT * FROM backfill_task WHERE id=?', [String(id)]);
  if (!task) return { error: '任务不存在', status: 404 };
  if (task.status === 'running') return { error: '任务正在运行；如需重启请先暂停', status: 409 };
  run(
    "UPDATE backfill_window SET status='pending', failed=0, blocked=0, error=NULL, finished_at=NULL, updated_at=? WHERE task_id=? AND status IN ('failed','blocked','paused')",
    [nowIso(), task.id]
  );
  run(
    "UPDATE backfill_task SET status='queued', last_error=NULL, finished_at=NULL, paused_at=NULL, updated_at=? WHERE id=?",
    [nowIso(), task.id]
  );
  return { ok: true, task: getBackfillTask(task.id), note: '失败/阻塞窗口已重置，从各自页码游标继续；已完成窗口不会重复调用。' };
}

function shouldStop(taskId) {
  const st = taskStatus(taskId);
  return st && ['paused', 'cancelled'].includes(st);
}

function countProcessed(taskId) {
  return get(
    "SELECT COUNT(*) c FROM backfill_window WHERE task_id=? AND status IN ('done','failed','skipped')",
    [String(taskId)]
  )?.c || 0;
}

function pickContentType(hit, selectedSources) {
  const src = selectedSources[0];
  if (src?.kinds?.length) {
    const k = src.kinds.find((x) => CONTENT_TYPES.has(x));
    if (k) return k;
  }
  if (selectedSources.some((s) => s.source_category === 'institution')) return 'research_report';
  if (selectedSources.some((s) => s.source_category === 'enterprise')) return 'enterprise_news';
  if (selectedSources.some((s) => s.source_category === 'official')) return 'policy_notice';
  return 'industry_news';
}

/**
 * 执行一次有界补采步骤。默认在路由中后台调用；测试可直接传入 searchFn/fetchFn。
 * 所有游标在每页结束时写库，进程退出后可从相同页继续。
 */
export async function runBackfillStep(id, {
  actor = 'system:backfill', maxWindows = 3, maxMs = 90_000,
  searchFn = null, fetchFn = null, capabilities = null, owner = null,
} = {}) {
  recoverInterruptedBackfill();
  const task = get('SELECT * FROM backfill_task WHERE id=?', [String(id)]);
  if (!task) return { error: '任务不存在', status: 404 };
  if (['completed', 'cancelled'].includes(task.status)) return { ok: true, task: getBackfillTask(task.id), note: '任务已结束' };
  if (task.status === 'paused') return { ok: false, reason: 'paused', task: getBackfillTask(task.id) };
  if (task.status === 'failed') return { ok: false, reason: 'failed', task: getBackfillTask(task.id), note: '请先重试失败窗口' };

  const caps = capabilitiesOverride(capabilities) || backfillCapabilities();
  if (!searchFn && (!caps.search_configured || !caps.date_filter_supported)) {
    const reason = !caps.search_configured
      ? '未配置搜索连接，不能发送日期条件'
      : '搜索连接未声明可用的日期条件（start_field/end_field 或 freshness_range），不能保证日期条件真正发送';
    touchTask(task.id, { status: 'failed', last_error: reason, finished_at: nowIso() });
    return { ok: false, reason: 'date_filter_unsupported', message: reason, task: getBackfillTask(task.id) };
  }

  const leaseOwner = owner || `backfill:${process.pid}:${Date.now()}`;
  const lease = acquireLease({ key: 'collection', owner: leaseOwner, purpose: `backfill:${task.id}` });
  if (!lease.ok) {
    return { ok: false, reason: 'lease_busy', message: '已有采集/补采任务在运行；租约到期后可继续。', lease: lease.lease, task: getBackfillTask(task.id) };
  }
  touchTask(task.id, {
    status: 'running', started_at: task.started_at || nowIso(), last_error: null,
    page_supported: caps.pagination_supported ? 1 : 0,
  });

  const options = uj(task.options_json, {}) || {};
  const terms = uj(task.terms_json, []) || [];
  const sourceIds = uj(task.source_ids_json, []) || [];
  const selectedSources = SEED_SOURCES.filter((s) => sourceIds.includes(s.id));
  const domains = [...new Set(selectedSources.map((s) => normDomain(s.url)).filter(Boolean))];
  const maxCalls = Math.max(1, Math.min(Number(options.max_calls) || 200, 2000));
  const stepDeadline = Date.now() + Math.max(5_000, Math.min(Number(maxMs) || 90_000, 300_000));
  const windowsLimit = Math.max(1, Math.min(Number(maxWindows) || 3, 20));
  const results = [];
  let callsThisStep = 0;
  let processed = 0;
  let stopReason = null;

  const callSearch = searchFn || (async (term, opts) => {
    const hasPage = (p) => !!(uj(p.param_map_json, {}) || {}).page_field;
    // 备用通道除日期能力外，还必须与任务使用的分页语义一致；否则一个通道
    // 返回第 2 页、另一个忽略 page，会把重复结果当成新页。
    const competent = dateCapableCandidates().filter((p) => hasPage(p) === !!caps.pagination_supported);
    const capable = (competent.length ? competent : dateCapableCandidates()).slice(0, 3);
    if (!capable.length) {
      return { ok: false, reason: 'date_filter_unsupported', message: '没有具备日期条件的搜索连接', results: [] };
    }
    let empty = null;
    let last = null;
    for (const provider of capable) {
      // 逐个尝试，但只在**同等日期能力**的连接间回退；每个连接仍受其
      // 自身配额、鉴权、超时与白名单约束（runSearch 内部处理）。
      const out = await runSearch(provider, term, {
        ...opts, raw_content: true, count: opts.page_size, page: opts.page,
        start_date: opts.start_date, end_date: opts.end_date,
        include_domains: domains, deadlineAt: opts.deadlineAt,
      });
      last = out;
      if (out.ok && (out.results || []).length) return out;
      if (out.ok && !empty) empty = out;
    }
    return empty || last || { ok: false, reason: 'no_provider', results: [] };
  });
  const callFetch = fetchFn || (async (url) => fetchWithFallback(url, { attempts: 2 }));

  try {
    while (processed < windowsLimit) {
      if (Date.now() >= stepDeadline) { stopReason = 'step_time_budget'; break; }
      if (shouldStop(task.id)) { stopReason = 'paused_or_cancelled'; break; }
      if (Number(get('SELECT search_calls FROM backfill_task WHERE id=?', [task.id])?.search_calls || 0) >= maxCalls) {
        stopReason = 'task_call_budget'; break;
      }
      const win = get(
        "SELECT * FROM backfill_window WHERE task_id=? AND status='pending' ORDER BY seq LIMIT 1",
        [task.id]
      );
      if (!win) break;
      windowUpdate(win.id, { status: 'running', started_at: win.started_at || nowIso(), attempts: Number(win.attempts || 0) + 1 });
      let page = Math.max(1, Number(win.cursor_page || 1));
      let pageDone = false;
      while (!pageDone) {
        if (Date.now() >= stepDeadline) { stopReason = 'step_time_budget'; break; }
        if (shouldStop(task.id)) { stopReason = 'paused_or_cancelled'; break; }
        if (callsThisStep >= Math.max(20, maxCalls)) { stopReason = 'step_call_budget'; break; }
        const callBudgetLeft = maxCalls - Number(get('SELECT search_calls FROM backfill_task WHERE id=?', [task.id])?.search_calls || 0);
        if (callBudgetLeft <= 0) { stopReason = 'task_call_budget'; break; }

        let pageHits = 0;
        let pageFailures = 0;
        let pageInserted = 0;
        let pageUpdated = 0;
        let pageDuplicates = 0;
        let pageBlocked = 0;
        let pageUnknown = 0;
        let pageOutside = 0;
        let pageCalls = 0;
        let anyFullPage = false;
        const pageErrors = [];

        for (const term of terms) {
          if (Date.now() >= stepDeadline) { stopReason = 'step_time_budget'; break; }
          if (callsThisStep >= Math.max(20, maxCalls) || pageCalls >= callBudgetLeft) { stopReason = 'step_call_budget'; break; }
          if (shouldStop(task.id)) { stopReason = 'paused_or_cancelled'; break; }
          callsThisStep += 1;
          pageCalls += 1;
          let searchOut;
          try {
            searchOut = await callSearch(term, {
              page, page_size: task.page_size, start_date: win.window_from, end_date: win.window_to,
              deadlineAt: Math.min(stepDeadline, Date.now() + 30_000), source_ids: sourceIds,
            });
          } catch (e) {
            searchOut = { ok: false, reason: 'exception', message: e.message, results: [] };
          }
          if (!searchOut?.ok) {
            pageFailures += 1;
            pageErrors.push(`「${term}」第 ${page} 页搜索失败：${searchOut?.reason || 'unknown'} ${searchOut?.message || ''}`.slice(0, 240));
            continue;
          }
          if ((searchOut.results || []).length >= Number(task.page_size || 10)) anyFullPage = true;
          for (const hit of (searchOut.results || [])) {
            if (!hit?.url || !/^https?:\/\//i.test(String(hit.url))) continue;
            const host = normDomain(hit.url);
            if (!hostMatches(host, domains)) continue;
            pageHits += 1;
            const published = isDate(String(hit.published_at || '').slice(0, 10))
              ? String(hit.published_at).slice(0, 10) : null;
            if (!published) pageUnknown += 1;
            else if (published < win.window_from || published > win.window_to) { pageOutside += 1; continue; } // 真实发布日期不在本窗口：不写入本窗
            let body = hit.raw_content ? normalizeBody(hit.raw_content) : '';
            let fetchNote = null;
            if (!body) {
              try {
                const fr = await callFetch(hit.url, { window_from: win.window_from, window_to: win.window_to });
                if (fr?.ok && fr.content) body = normalizeBody(fr.content);
                else fetchNote = fr?.reason === 'not_configured'
                  ? '未配置网页抓取连接：只保留搜索摘要/元数据，未取得正文'
                  : `正文抓取失败（${fr?.reason || 'unknown'}）：只保留搜索摘要/元数据`;
              } catch (e) {
                fetchNote = `正文抓取异常：${e.message}`;
              }
            }
            const availability = body.length >= 1200 ? 'full_text'
              : body.length > 0 ? 'partial'
                : hit.snippet ? 'abstract_only' : 'metadata_only';
            if (!body) pageBlocked += 1;
            try {
              const up = upsertContent({
                content_type: pickContentType(hit, selectedSources),
                record_kind: 'article',
                title: hit.title || '(无标题)',
                publisher: hit.publisher || selectedSources[0]?.name || host || null,
                published_at: published,
                source_url: hit.url,
                source_category: selectedSources[0]?.source_category || undefined,
                summary: hit.snippet ? String(hit.snippet).slice(0, 1200) : null,
                key_points: [],
                claims: [],
                topics: ['历史补采', term],
                body_snapshot: body,
                body_availability: availability,
                note: [
                  `历史补采窗口 ${win.window_from}～${win.window_to}；检索词「${term}」第 ${page} 页。`,
                  published ? null : '搜索结果未提供可解析的真实发布日期：发布日期保留为空，未用窗口日期代替。',
                  fetchNote,
                ].filter(Boolean).join('；'),
              }, { actor });
              if (up.action === 'inserted') pageInserted += 1;
              else if (up.action === 'updated') pageUpdated += 1;
              else if (up.action === 'duplicate' || up.action === 'unchanged') pageDuplicates += 1;
            } catch (e) {
              pageFailures += 1;
              pageErrors.push(`入库失败：${e.message}`.slice(0, 240));
            }
          }
        }

        // 每页结束即持久化游标与累计数；完成页不重复调用。
        // 只要本页有检索失败或本页处理被时间/预算/暂停打断，游标就停留在本页；
        // 重试/恢复会重发该页，已入库结果由 URL/内容哈希去重，不会重复入库。
        const nextPage = page + 1;
        const pageSupported = caps.pagination_supported && task.page_supported;
        const pageFailed = pageFailures > 0;
        const interruptedPage = !!stopReason;
        const nextCursor = pageFailed || interruptedPage ? page : nextPage;
        const keepGoing = pageSupported && !pageFailed && !interruptedPage && nextPage <= task.max_pages
          && anyFullPage && !shouldStop(task.id) && !stopReason;
        const winNow = get('SELECT * FROM backfill_window WHERE id=?', [win.id]);
        const add = {
          hits: Number(winNow.hits || 0) + pageHits,
          inserted: Number(winNow.inserted || 0) + pageInserted,
          updated: Number(winNow.updated || 0) + pageUpdated,
          duplicates: Number(winNow.duplicates || 0) + pageDuplicates,
          outside_window: Number(winNow.outside_window || 0) + pageOutside,
          failed: Number(winNow.failed || 0) + pageFailures,
          blocked: Number(winNow.blocked || 0) + pageBlocked,
          unknown_dates: Number(winNow.unknown_dates || 0) + pageUnknown,
          search_calls: Number(winNow.search_calls || 0) + pageCalls,
          pages_done: Number(winNow.pages_done || 0) + 1,
          cursor_page: nextCursor,
          error: pageErrors.length ? pageErrors.slice(0, 4).join(' | ') : winNow.error,
          status: keepGoing ? 'running' : 'pending',
        };
        windowUpdate(win.id, add);
        touchTask(task.id, {
          hits: Number(task.hits || 0) + pageHits,
          inserted: Number(task.inserted || 0) + pageInserted,
          updated: Number(task.updated || 0) + pageUpdated,
          duplicates: Number(task.duplicates || 0) + pageDuplicates,
          outside_window: Number(task.outside_window || 0) + pageOutside,
          failed: Number(task.failed || 0) + pageFailures,
          blocked: Number(task.blocked || 0) + pageBlocked,
          unknown_dates: Number(task.unknown_dates || 0) + pageUnknown,
          search_calls: Number(task.search_calls || 0) + pageCalls,
        });
        // 刷新内存中的 task 累计数，避免多窗口覆盖
        const fresh = get('SELECT * FROM backfill_task WHERE id=?', [task.id]);
        Object.assign(task, fresh);
        pageDone = !keepGoing;
        page = keepGoing ? nextPage : page;
        if (!pageSupported && page === 1) pageDone = true;
      }

      const winAfter = get('SELECT * FROM backfill_window WHERE id=?', [win.id]);
      const stopNow = shouldStop(task.id) || stopReason === 'paused_or_cancelled';
      let finalStatus;
      // paused/cancelled 由任务状态表达；窗口回到 pending，继续时不会找不到可处理窗口。
      if (stopNow) finalStatus = taskStatus(task.id) === 'cancelled' ? 'skipped' : 'pending';
      else if (winAfter.failed > 0) finalStatus = 'failed';
      else if (winAfter.status === 'pending' && stopReason) finalStatus = 'pending';
      else finalStatus = 'done';
      if (finalStatus !== 'pending') {
        windowUpdate(win.id, {
          status: finalStatus,
          cursor_page: finalStatus === 'done' ? task.max_pages + 1 : winAfter.cursor_page,
          finished_at: finalStatus === 'failed' ? nowIso() : finalStatus === 'done' ? nowIso() : null,
        });
        touchTask(task.id, {
          cursor_window: win.seq,
          processed_windows: countProcessed(task.id),
        });
        processed += 1;
      } else {
        windowUpdate(win.id, { status: 'pending' });
      }
      results.push({ window: win.seq, from: win.window_from, to: win.window_to, status: finalStatus });
      if (finalStatus === 'pending') { stopReason = stopReason || 'window_incomplete'; break; }
    }
  } finally {
    releaseLease({ key: 'collection', owner: leaseOwner });
  }

  const fresh = get('SELECT * FROM backfill_task WHERE id=?', [task.id]);
  const pending = get("SELECT COUNT(*) c FROM backfill_window WHERE task_id=? AND status IN ('pending','running')", [task.id])?.c || 0;
  const failed = get("SELECT COUNT(*) c FROM backfill_window WHERE task_id=? AND status='failed'", [task.id])?.c || 0;
  const blockedWindows = get(
    'SELECT COUNT(*) c FROM backfill_window WHERE task_id=? AND blocked > 0',
    [task.id]
  )?.c || 0;
  let status = fresh.status;
  if (fresh.status === 'running' && pending === 0) {
    status = failed > 0 || blockedWindows > 0 ? 'partial' : 'completed';
    touchTask(task.id, {
      status, finished_at: nowIso(), cursor_window: fresh.planned_windows,
      processed_windows: countProcessed(task.id),
    });
  } else if (fresh.status === 'running' && stopReason === 'task_call_budget') {
    status = 'partial';
    touchTask(task.id, {
      status,
      last_error: `达到单任务搜索调用上限 ${maxCalls}；已完成窗口保留，未完成窗口可从游标继续。`,
      finished_at: nowIso(),
      processed_windows: countProcessed(task.id),
    });
  }
  return {
    ok: true,
    task: getBackfillTask(task.id),
    step: {
      processed_windows: processed,
      search_calls: callsThisStep,
      stop_reason: stopReason || (pending === 0 ? 'all_windows_processed' : 'window_batch_limit'),
      windows: results,
    },
  };
}

/** 后台异步启动：立即返回 queued/running，由 UI 轮询；不阻塞 HTTP。 */
export function scheduleBackfillRun(id, { actor = 'admin', maxWindows = 2, maxMs = 60_000 } = {}) {
  setImmediate(async () => {
    try {
      // 每次只处理少量窗口，循环续跑直到结束/暂停/预算耗尽；游标每页落库。
      for (let i = 0; i < 50; i += 1) {
        const r = await runBackfillStep(id, { actor, maxWindows, maxMs });
        if (!r || r.error) break;
        if (r.ok === false) break;
        const t = r.task;
        if (!t || ['paused', 'cancelled', 'completed', 'partial', 'failed', 'interrupted'].includes(t.status)) break;
        if (r.step?.stop_reason === 'all_windows_processed' || r.step?.stop_reason === 'task_call_budget') break;
      }
    } catch (e) {
      try {
        touchTask(id, {
          status: 'failed',
          last_error: `补采执行异常：${String(e.message || e).slice(0, 300)}`,
          finished_at: nowIso(),
        });
      } catch { /* 忽略 */ }
    }
  });
  return { ok: true, accepted: true, task_id: id, poll: `/api/v2/admin/backfill/tasks/${id}` };
}
