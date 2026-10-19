/**
 * 搜索 / 抓取备用通道编排（docs/54 第 B 节）
 * ============================================================================
 * 只做「主服务 → 备用服务」的顺序尝试与失败留痕，不改变各适配器自身的
 * 出站、配额、超时、重试纪律。约束：
 *   · 整体尝试次数、总请求数、总时长都有硬上限；
 *   · 每次尝试单独记录；主服务 404 等失败日志保留，备用成功另记；
 *   · 同一 URL 被不同引擎返回只算一条证据，不构成多源验证；
 *   · 搜索摘要与抓取正文严格分开：只有抓取成功且明确全文才升级。
 */
import { all } from '../core/db.mjs';
import { pickSearchCandidates, runSearch, canonicalizeUrl } from './search-svc.mjs';
import { pickFetchCandidates, fetchUrlContent } from './web-fetch-svc.mjs';
import { assertSafeFetchTarget } from './deepseek-capability-svc.mjs';

export const FALLBACK_LIMITS = {
  search_attempts: 3,
  fetch_attempts: 3,
  total_ms: 55_000,
};

/**
 * 主服务失败/无结果时按配置尝试备用。
 * @param {string} query
 * @param {{provider_id?:string|null, count?:number, raw_content?:boolean, need_content?:boolean,
 *          deadlineAt?:number|null, attempts?:number, notes?:string[], totalMs?:number}} opts
 */
export async function runSearchWithFallback(query, opts = {}) {
  const notes = Array.isArray(opts.notes) ? opts.notes : [];
  const candidates = pickSearchCandidates(opts.provider_id || null);
  if (!candidates.length) {
    return { ok: false, reason: 'not_configured', message: '未配置可用的搜索服务', results: [], attempts: [], notes };
  }
  const started = Date.now();
  const hasDeadline = opts.deadlineAt !== null && opts.deadlineAt !== undefined
    && opts.deadlineAt !== '' && Number(opts.deadlineAt) > 0;
  const deadlineAt = hasDeadline
    ? Number(opts.deadlineAt)
    : started + Math.min(Number(opts.totalMs) || FALLBACK_LIMITS.total_ms, FALLBACK_LIMITS.total_ms);
  const maxAttempts = Math.max(1, Math.min(Number(opts.attempts) || FALLBACK_LIMITS.search_attempts, candidates.length));
  const attempts = [];
  let last = null;
  let deepseekBudgetBlocked = false;
  const limited = candidates.slice(0, maxAttempts);
  for (let idx = 0; idx < limited.length; idx += 1) {
    const provider = limited[idx];
    // 402 只针对该账号；其它独立搜索厂商仍可尝试。共享同一 DeepSeek 账号的后续
    // DeepSeek 连接不再重复请求，但不会熔断 Bocha / 自建网关。
    if (deepseekBudgetBlocked && provider.provider_kind === 'deepseek_search') {
      attempts.push({
        provider_id: provider.id, provider_name: provider.name, kind: provider.provider_kind,
        ok: false, reason: 'budget_stopped', skipped: true,
      });
      continue;
    }
    if (Date.now() >= deadlineAt - 250) {
      attempts.push({
        provider_id: provider.id, provider_name: provider.name, kind: provider.provider_kind,
        ok: false, reason: 'deadline_exceeded', skipped: true,
      });
      notes.push(`备用搜索通道未尝试：整轮时间上限已到（${provider.name}）。`);
      break;
    }
    const remainingAttempts = limited.length - idx;
    const remainingMs = Math.max(600, deadlineAt - Date.now());
    // 给后续通道保留时间窗口：前一个通道不能用尽整轮预算。
    const attemptWindow = remainingAttempts > 1
      ? Math.max(600, Math.min(30000, remainingMs / remainingAttempts))
      : remainingMs;
    const attemptDeadline = Math.min(deadlineAt, Date.now() + attemptWindow);
    const out = await runSearch(provider, query, {
      ...opts, deadlineAt: attemptDeadline,
    });
    const entry = {
      provider_id: provider.id,
      provider_name: provider.name,
      kind: provider.provider_kind,
      is_fallback: !!provider.is_fallback,
      ok: !!out.ok,
      empty: !!out.empty,
      reason: out.reason || null,
      message: out.message ? String(out.message).slice(0, 300) : null,
      results: out.results?.length || 0,
      latency_ms: out.latency_ms ?? null,
      usage: out.usage || null,
    };
    attempts.push(entry);
    last = out;
    if (out.ok && (out.results || []).length > 0) {
      if (attempts.length > 1) notes.push(`主搜索通道未取得结果，备用「${provider.name}」返回 ${out.results.length} 条结果。`);
      return {
        ...out,
        results: dedupeSearchResults(out.results || []),
        attempts,
        fallback_used: attempts.length > 1,
        search_attempt_count: attempts.length,
        notes,
        deadline_at: deadlineAt,
      };
    }
    if (out.ok && !out.results?.length) {
      notes.push(`搜索通道「${provider.name}」返回空结果，按配置尝试下一备用通道。`);
      continue;
    }
    // 402 表示该账号预算不足：只跳过同账号的 DeepSeek 通道，独立厂商仍按配置尝试。
    if (out.reason === 'budget_exhausted' || out.reason === 'insufficient_balance') {
      if (provider.provider_kind === 'deepseek_search') deepseekBudgetBlocked = true;
      notes.push(`搜索通道「${provider.name}」预算不足（402）：跳过该账号的后续 DeepSeek 连接，独立厂商仍按配置尝试。`);
      continue;
    }
    notes.push(`搜索通道「${provider.name}」失败（${out.reason}）：${String(out.message || '').slice(0, 160)}`);
  }
  return {
    ok: false,
    reason: last?.ok ? 'empty' : (last?.reason || 'no_provider'),
    message: last?.ok ? '所有可用搜索通道均返回空结果' : (last?.message || '所有搜索通道均失败'),
    results: [],
    attempts,
    fallback_used: attempts.length > 1,
    search_attempt_count: attempts.length,
    notes,
    deadline_at: deadlineAt,
  };
}

/** 按 canonical URL 去重；同 URL 的多引擎结果只保留一条，并明确记录来源通道。 */
export function dedupeSearchResults(results = []) {
  const seen = new Map();
  for (const r of results) {
    const key = r.canonical_url || canonicalizeUrl(r.url);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, { ...r, also_from: [] });
      continue;
    }
    const cur = seen.get(key);
    // 不把同 URL 当第二来源；只在第一条缺正文时补正文，并记录另一通道
    if (!cur.raw_content && r.raw_content) cur.raw_content = r.raw_content;
    if (!cur.snippet && r.snippet) cur.snippet = r.snippet;
    if (!cur.published_at && r.published_at) cur.published_at = r.published_at;
    if (!cur.publisher && r.publisher) cur.publisher = r.publisher;
    if (r.source_kind && !cur.also_from.includes(r.source_kind)) cur.also_from.push(r.source_kind);
  }
  return [...seen.values()];
}

/**
 * 主抓取连接失败或缺正文时尝试备用。
 * @param {string} url
 * @param {{connection_id?:string|null, deadlineAt?:number|null, timeoutMs?:number, attempts?:number,
 *          notes?:string[], totalMs?:number}} opts
 */
export async function fetchWithFallback(url, opts = {}) {
  const notes = Array.isArray(opts.notes) ? opts.notes : [];
  const safe = assertSafeFetchTarget(url);
  if (!safe.ok) return { ok: false, url, reason: 'blocked_url', message: safe.reason, attempts: [], notes };
  const candidates = pickFetchCandidates(opts.connection_id || null);
  if (!candidates.length) {
    return { ok: false, url, reason: 'not_configured', message: '未配置可用的网页抓取连接', attempts: [], notes };
  }
  const started = Date.now();
  const hasDeadline = opts.deadlineAt !== null && opts.deadlineAt !== undefined
    && opts.deadlineAt !== '' && Number(opts.deadlineAt) > 0;
  const deadlineAt = hasDeadline
    ? Number(opts.deadlineAt)
    : started + Math.min(Number(opts.totalMs) || FALLBACK_LIMITS.total_ms, FALLBACK_LIMITS.total_ms);
  const maxAttempts = Math.max(1, Math.min(Number(opts.attempts) || FALLBACK_LIMITS.fetch_attempts, candidates.length));
  const attempts = [];
  let last = null;
  let deepseekBudgetBlocked = false;
  const limited = candidates.slice(0, maxAttempts);
  for (let idx = 0; idx < limited.length; idx += 1) {
    const conn = limited[idx];
    if (deepseekBudgetBlocked && conn.conn_kind === 'deepseek_fetch') {
      attempts.push({ connection_id: conn.id, connection_name: conn.name, ok: false, reason: 'budget_stopped', skipped: true });
      continue;
    }
    if (Date.now() >= deadlineAt - 250) {
      attempts.push({ connection_id: conn.id, connection_name: conn.name, ok: false, reason: 'deadline_exceeded', skipped: true });
      notes.push(`备用抓取通道未尝试：整轮时间上限已到（${conn.name}）。`);
      break;
    }
    const remainingAttempts = limited.length - idx;
    const remainingMs = Math.max(600, deadlineAt - Date.now());
    const attemptWindow = remainingAttempts > 1
      ? Math.max(600, Math.min(30000, remainingMs / remainingAttempts))
      : remainingMs;
    const attemptDeadline = Math.min(deadlineAt, Date.now() + attemptWindow);
    const out = await fetchUrlContent(conn, url, {
      deadlineAt: attemptDeadline,
      timeoutMs: Math.min(Number(opts.timeoutMs) || 30000, Math.max(600, attemptDeadline - Date.now() - 100)),
    });
    const entry = {
      connection_id: conn.id,
      connection_name: conn.name,
      kind: conn.conn_kind,
      is_fallback: !!conn.is_fallback,
      ok: !!out.ok,
      chars: out.chars || 0,
      availability: out.availability || null,
      reason: out.reason || null,
      message: out.message ? String(out.message).slice(0, 300) : null,
      latency_ms: out.latency_ms ?? null,
    };
    attempts.push(entry);
    last = out;
    if (out.ok && out.content) {
      if (attempts.length > 1) notes.push(`主抓取通道未取得正文，备用「${conn.name}」抓取成功（${out.chars} 字符）。`);
      return {
        ...out,
        attempts,
        fallback_used: attempts.length > 1,
        fetch_attempt_count: attempts.length,
        notes,
      };
    }
    if (out.reason === 'budget_exhausted' || out.reason === 'insufficient_balance') {
      if (conn.conn_kind === 'deepseek_fetch') deepseekBudgetBlocked = true;
      notes.push(`抓取通道「${conn.name}」预算不足（402）：跳过该账号的后续 DeepSeek 连接，独立连接仍按配置尝试。`);
      continue;
    }
    notes.push(`抓取通道「${conn.name}」失败（${out.reason}）：${String(out.message || '').slice(0, 160)}`);
  }
  return {
    ok: false,
    url,
    reason: last?.reason || 'no_provider',
    message: last?.message || '所有可用抓取通道均失败',
    attempts,
    fallback_used: attempts.length > 1,
    fetch_attempt_count: attempts.length,
    notes,
  };
}

/** 公开统计：只展示计数，不返回任何凭据或原始 URL 列表。 */
export function fallbackStatus() {
  const searches = all('SELECT id,name,provider_kind,is_fallback,fallback_priority,total_calls,total_success,last_call_at,last_success_at FROM search_provider WHERE archived=0');
  const fetches = all('SELECT id,name,conn_kind,is_fallback,fallback_priority,total_calls,total_success,last_call_at,last_success_at FROM web_fetch_connection WHERE archived=0');
  return {
    search: searches.map((r) => ({
      id: r.id, name: r.name, kind: r.provider_kind, is_fallback: !!r.is_fallback,
      priority: r.fallback_priority, calls: r.total_calls, success: r.total_success,
      last_call_at: r.last_call_at, last_success_at: r.last_success_at,
    })),
    fetch: fetches.map((r) => ({
      id: r.id, name: r.name, kind: r.conn_kind, is_fallback: !!r.is_fallback,
      priority: r.fallback_priority, calls: r.total_calls, success: r.total_success,
      last_call_at: r.last_call_at, last_success_at: r.last_success_at,
    })),
    limits: FALLBACK_LIMITS,
  };
}
