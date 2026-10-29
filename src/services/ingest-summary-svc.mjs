/**
 * 入库即时摘要队列与独立 worker（docs/80 A）
 * ============================================================================
 * 目标：upsertContent 完成同步写库后只入队，不在写路径调用外部模型；
 * 独立轻量 worker 以 SQLite 持久队列、跨进程租约和短周期排空队列。
 *
 * 关键纪律：
 *   · 队列键包含实体/实际输入哈希/提示词版本/模型键，相同输入不重复付费；
 *   · 运行中输入变化时旧结果不能把新签名任务标成完成；
 *   · 租约忙只延后，不计入失败次数；失败才指数退避并受尝试上限约束；
 *   · 无模型明确 blocked，绝不写“已完成”；
 *   · worker 不依赖每日 06:30 调度，可显式用 CCER_INGEST_SUMMARY_WORKER=0 停用。
 *
 * 锁顺序（固定，避免死锁）：
 *   1) ingest_summary（本 worker 跨进程租约）
 *   2) summary_model（summary-svc 的模型批次租约）
 *   3) 队列行 lease（SQLite 条件更新）
 * 本 worker 从不获取 collection 租约，避免与每日采集/补采交叉等待。
 */
import { createHash } from 'node:crypto';
import { all, get, run, getDb, metaValue, setMeta, audit } from '../core/db.mjs';
import { newId, nowIso } from '../core/util.mjs';
import { acquireLease, releaseLease, renewLease, getLease } from './governance-svc.mjs';
import * as summary from './summary-svc.mjs';

const ENABLED_META_KEY = 'ingest_summary_worker_enabled_v1';
const BACKFILL_CURSOR_KEY = 'ingest_summary_backfill_cursor_v1';
const WORKER_LEASE_KEY = 'ingest_summary';
const ACTIVE_STATUSES = ['queued', 'running', 'failed', 'blocked'];

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function ingestSummaryConfig() {
  return {
    // 默认 12 秒；硬上限 5 分钟，避免环境变量把队列变成无界轮询。
    interval_ms: intEnv('CCER_INGEST_SUMMARY_INTERVAL_MS', 12_000, 5_000, 300_000),
    // 单批最多 3 条；需求硬上限即 3。
    batch_size: intEnv('CCER_INGEST_SUMMARY_BATCH', 3, 1, 3),
    // 单批 45 秒硬上限。
    budget_ms: intEnv('CCER_INGEST_SUMMARY_BUDGET_MS', 45_000, 5_000, 45_000),
    max_attempts: intEnv('CCER_INGEST_SUMMARY_MAX_ATTEMPTS', 5, 1, 10),
    retry_base_ms: intEnv('CCER_INGEST_SUMMARY_RETRY_BASE_MS', 60_000, 10_000, 3_600_000),
    retry_max_ms: intEnv('CCER_INGEST_SUMMARY_RETRY_MAX_MS', 6 * 3600 * 1000, 60_000, 7 * 24 * 3600 * 1000),
    lease_ttl_ms: intEnv('CCER_INGEST_SUMMARY_LEASE_TTL_MS', 120_000, 30_000, 300_000),
    env_disabled: process.env.CCER_INGEST_SUMMARY_WORKER === '0',
    hard_limits: { batch_size: 3, budget_ms: 45_000, max_attempts: 10 },
  };
}

export function ingestWorkerEnabled() {
  const cfg = ingestSummaryConfig();
  if (cfg.env_disabled) return false;
  return metaValue(ENABLED_META_KEY, '1') !== '0';
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/** 只有标题、演示、转载副本、来源归档、失败抓取不生成“伪全文摘要”。 */
export function contentIngestEligibility(rowOrId) {
  const row = typeof rowOrId === 'string'
    ? get('SELECT * FROM content_item WHERE id=?', [rowOrId])
    : rowOrId;
  if (!row) return { ok: false, reason: 'entity_missing' };
  if (Number(row.is_demo) === 1) return { ok: false, reason: 'demo' };
  if (row.duplicate_of) return { ok: false, reason: 'duplicate' };
  if (String(row.record_kind || 'article') !== 'article') return { ok: false, reason: 'source_archive' };
  if (String(row.process_status || '') === 'failed_fetch') return { ok: false, reason: 'failed_fetch' };
  const bodyChars = Number(row.body_chars || 0);
  const hasSummary = !!String(row.summary || '').trim();
  if (bodyChars <= 0 && !hasSummary) return { ok: false, reason: 'title_only' };
  return { ok: true, input_kind: hasSummary && bodyChars <= 0 ? 'summary_only' : null };
}

/**
 * 入队一个摘要任务。只读当前输入签名，不调用模型/外网。
 * @returns {{ok:boolean, queued?:boolean, deduped?:boolean, skipped?:boolean, id?:string, reason?:string}}
 */
export function enqueueSummaryTask(entityType, entityId, {
  source = 'ingest', reason = null, revive = false, priority = null,
} = {}) {
  if (!summary.SUMMARY_ENTITIES[entityType]) return { ok: false, skipped: true, reason: 'unsupported_entity' };
  if (entityType === 'content_item') {
    const eligible = contentIngestEligibility(String(entityId));
    if (!eligible.ok) return { ok: false, skipped: true, reason: eligible.reason };
  }
  const input = summary.loadSummaryInput(entityType, String(entityId));
  if (!input) return { ok: false, skipped: true, reason: 'entity_missing' };
  // 只有标题的记录不调用；即使未来新增适配器，也在通用入口再挡一次。
  if (entityType === 'content_item' && input.input_kind === 'metadata_only') {
    return { ok: false, skipped: true, reason: 'title_only' };
  }
  const inputHash = summary.summaryInputHash(input);
  const modelKey = summary.currentModelKey();
  const promptVersion = summary.PROMPT_VERSION;
  const dedupeKey = sha256(`${entityType}|${entityId}|${inputHash}|${promptVersion}|${modelKey}`);
  const existing = get('SELECT * FROM ingest_summary_queue WHERE dedupe_key=?', [dedupeKey]);
  const now = nowIso();
  const cfg = ingestSummaryConfig();
  if (existing) {
    if (revive && existing.status !== 'running' && existing.status !== 'succeeded') {
      run(
        `UPDATE ingest_summary_queue SET status='queued', attempts=0, max_attempts=?,
           next_attempt_at=?, lease_owner=NULL, lease_until=NULL, worker_started_at=NULL,
           finished_at=NULL, last_error=NULL, last_error_kind=NULL, reason=COALESCE(?,reason),
           source=?, updated_at=? WHERE id=?`,
        [cfg.max_attempts, now, reason, source, now, existing.id]
      );
      return { ok: true, queued: true, revived: true, id: existing.id };
    }
    return { ok: true, queued: existing.status === 'queued', deduped: true, id: existing.id, status: existing.status };
  }

  // 新签名入队：旧签名尚未执行的任务标记 superseded；运行中的任务不打断，
  // 但完成时会再次核对当前输入，绝不把旧结果标成新签名完成。
  run(
    `UPDATE ingest_summary_queue SET status='superseded', finished_at=?, last_error=?, last_error_kind='input_changed',
       updated_at=? WHERE entity_type=? AND entity_id=? AND status='queued' AND input_hash<>?`,
    [now, '输入签名/模型键已变化，旧任务不再调用模型', now, entityType, String(entityId), inputHash]
  );
  const id = newId('ISQ');
  const rank = Number.isFinite(Number(priority))
    ? Math.max(0, Math.min(Number(priority), 1000))
    : (source === 'ingest' ? 100 : 20);
  run(
    `INSERT INTO ingest_summary_queue
      (id,entity_type,entity_id,dedupe_key,input_hash,prompt_version,model_key,status,priority,source,reason,
       attempts,max_attempts,next_attempt_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'queued',?,?,?,0,?,?,?,?)`,
    [id, entityType, String(entityId), dedupeKey, inputHash, promptVersion, modelKey, rank, source,
      reason, cfg.max_attempts, now, now, now]
  );
  return { ok: true, queued: true, id, input_hash: inputHash, model_key: modelKey };
}

/** 内容写入口的兼容封装：只使用 upsertContent 已落库的真实行。 */
export function enqueueContentSummary(contentId, opts = {}) {
  return enqueueSummaryTask('content_item', contentId, { ...opts, source: opts.source || 'ingest' });
}

/**
 * 每日/启动兜底：只补“应该入队但队列里没有当前签名”的有效内容。
 * 使用持久游标分页扫描，避免只反复扫描最新一屏、让更老的漏队项永久饥饿。
 * 不重置已有失败任务的退避，也不重复调用模型。
 */
export function enqueueMissedContentSummaries({ limit = 20, actor = 'system:daily-ingest', source = 'daily_backfill' } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 20, 100));
  const scan = Math.min(cap * 10, 500);
  const cursor = Math.max(0, Number(metaValue(BACKFILL_CURSOR_KEY, '0')) || 0);
  const rows = all(
    `SELECT id, summary, body_chars FROM content_item
      WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article'
        AND COALESCE(process_status,'')<>'failed_fetch'
        AND (COALESCE(body_chars,0)>0 OR COALESCE(summary,'')<>'')
      ORDER BY COALESCE(published_at, collected_at) DESC, id ASC LIMIT ? OFFSET ?`,
    [scan, cursor]
  );
  const out = { scanned: rows.length, queued: 0, skipped: 0, deduped: 0, reasons: {}, cursor_from: cursor, cursor_next: cursor };
  let examined = 0;
  for (const row of rows) {
    if (out.queued >= cap) break;
    examined += 1;
    const input = summary.loadSummaryInput('content_item', row.id);
    if (!input) { out.skipped += 1; out.reasons.entity_missing = (out.reasons.entity_missing || 0) + 1; continue; }
    const fresh = summary.getSummary('content_item', row.id);
    if (fresh?.status === 'ok' && !fresh.stale) { out.skipped += 1; out.reasons.fresh = (out.reasons.fresh || 0) + 1; continue; }
    const inputHash = summary.summaryInputHash(input);
    const modelKey = summary.currentModelKey();
    const dedupeKey = sha256(`content_item|${row.id}|${inputHash}|${summary.PROMPT_VERSION}|${modelKey}`);
    if (get('SELECT id FROM ingest_summary_queue WHERE dedupe_key=?', [dedupeKey])) {
      out.deduped += 1;
      continue;
    }
    const saved = enqueueSummaryTask('content_item', row.id, { source, priority: 10, reason: '每日兜底补入漏队项' });
    if (saved.queued) out.queued += 1;
    else if (saved.deduped) out.deduped += 1;
    else {
      out.skipped += 1;
      const r = saved.reason || 'unknown';
      out.reasons[r] = (out.reasons[r] || 0) + 1;
    }
  }
  // 自然扫到窗口末尾且本页不足一屏 → 回到 0 轮转；提前达到入队上限 →
  // 从已检查位置续扫，避免下一轮又从头部开始而永远到不了后面的条目。
  const completedWindow = examined >= rows.length;
  const next = (completedWindow && rows.length < scan) ? 0 : cursor + Math.max(examined, 1);
  out.cursor_next = next;
  run(
    `INSERT INTO system_meta (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [BACKFILL_CURSOR_KEY, String(next), nowIso()]
  );
  if (out.queued) {
    audit({
      actor, action: 'ingest_summary.backfill_queue', objectType: 'ingest_summary_queue',
      detail: { queued: out.queued, scanned: out.scanned, source, cursor_from: cursor, cursor_next: next },
    });
  }
  return out;
}

/** 回收过期运行态：不增尝试次数，不伪造成功，重启后继续排队。 */
export function reapStaleIngestTasks({ limit = 100 } = {}) {
  const now = nowIso();
  const rows = all(
    `SELECT id FROM ingest_summary_queue
      WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?
      ORDER BY lease_until LIMIT ?`,
    [now, Math.max(1, Math.min(Number(limit) || 100, 500))]
  );
  for (const r of rows) {
    run(
      `UPDATE ingest_summary_queue
          SET status='queued', lease_owner=NULL, lease_until=NULL, worker_started_at=NULL,
              next_attempt_at=?, last_error=?, last_error_kind='interrupted',
              updated_at=?
        WHERE id=? AND status='running'`,
      [now, '运行租约过期（进程可能中断）：已回收并续跑，不计真实失败次数', now, r.id]
    );
  }
  return { reaped: rows.length };
}

function dueSql() {
  return `status IN ('queued','failed','blocked')
    AND attempts < COALESCE(max_attempts, 10)
    AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    AND (lease_until IS NULL OR lease_until<=?)`;
}

/**
 * 原子领取一批任务。先恢复过期运行态，再在 BEGIN IMMEDIATE 内条件更新；
 * 新内容优先占一个名额，其余从最久未尝试的旧待办补足，避免永久饥饿。
 */
export function claimIngestTasks({ limit = 3, owner, leaseTtlMs = 120_000 } = {}) {
  if (!owner) return { ok: false, reason: 'owner_required', tasks: [] };
  const cfg = ingestSummaryConfig();
  const cap = Math.max(1, Math.min(Number(limit) || cfg.batch_size, cfg.batch_size));
  reapStaleIngestTasks();
  const db = getDb();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + Math.max(30_000, Number(leaseTtlMs) || cfg.lease_ttl_ms)).toISOString();
  let picked = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const due = db.prepare(
      `SELECT * FROM ingest_summary_queue WHERE ${dueSql()} ORDER BY created_at DESC LIMIT 200`
    ).all(now, now);
    const fresh = due.find((t) => t.source === 'ingest' && Number(t.attempts) === 0
      && String(t.created_at || '') >= new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const freshId = fresh?.id || null;
    const older = due
      .filter((t) => t.id !== freshId)
      .sort((a, b) => String(a.last_attempt_at || a.created_at || '').localeCompare(String(b.last_attempt_at || b.created_at || '')));
    const selected = [];
    if (freshId) selected.push(fresh);
    for (const t of older) {
      if (selected.length >= cap) break;
      selected.push(t);
    }
    // 没有“新内容”时仍按最久未尝试排序，不让新抓取无限插队。
    const upd = db.prepare(
      `UPDATE ingest_summary_queue SET status='running', lease_owner=?, lease_until=?, worker_started_at=?,
         updated_at=? WHERE id=? AND ${dueSql()}`
    );
    for (const t of selected.slice(0, cap)) {
      const res = upd.run(owner, leaseUntil, now, now, t.id, now, now);
      if (Number(res.changes || 0) > 0) picked.push(get('SELECT * FROM ingest_summary_queue WHERE id=?', [t.id]));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, reason: e.message, tasks: [] };
  }
  return { ok: true, tasks: picked.filter(Boolean), lease_until: leaseUntil };
}

function summaryErrorKind(out, s) {
  if (out?.reason === 'no_model' || s?.status === 'skipped') return 'no_model';
  if (out?.busy) return 'busy';
  return 'model_failed';
}

function backoffIso(attempts, cfg) {
  const n = Math.max(1, Number(attempts) || 1);
  const ms = Math.min(cfg.retry_base_ms * 2 ** (n - 1), cfg.retry_max_ms);
  return new Date(Date.now() + ms).toISOString();
}

function finishTask(task, owner, patch) {
  run(
    `UPDATE ingest_summary_queue SET status=?, attempts=?, next_attempt_at=?, last_error=?, last_error_kind=?,
       finished_at=?, result_json=?, lease_owner=NULL, lease_until=NULL, updated_at=?
     WHERE id=? AND status='running' AND lease_owner=?`,
    [patch.status, patch.attempts, patch.next_attempt_at || null, patch.last_error || null,
      patch.last_error_kind || null, patch.finished_at || null,
      patch.result ? JSON.stringify(patch.result).slice(0, 4000) : null, nowIso(), task.id, owner]
  );
}

function releaseTask(task, owner, { delayMs = 5000, note = '批次忙，延后处理（不计失败次数）' } = {}) {
  run(
    `UPDATE ingest_summary_queue SET status='queued', attempts=?, next_attempt_at=?, last_error=?,
       last_error_kind='busy', lease_owner=NULL, lease_until=NULL, updated_at=?
     WHERE id=? AND status='running' AND lease_owner=?`,
    [Number(task.attempts || 0), new Date(Date.now() + delayMs).toISOString(), note,
      nowIso(), task.id, owner]
  );
}

async function processTask(task, { owner, deadlineAt, actor, cfg }) {
  // 领取后再次核对当前输入；排队期间正文/模型键变化则不调用模型。
  const current = summary.loadSummaryInput(task.entity_type, task.entity_id);
  if (!current) {
    finishTask(task, owner, {
      status: 'superseded', attempts: task.attempts, last_error: '实体已不存在或当前不可摘要',
      last_error_kind: 'entity_missing', finished_at: nowIso(),
    });
    return { status: 'superseded', reason: 'entity_missing' };
  }
  // 内容可能在排队后被标记为来源归档/演示/失败抓取；执行时重新检查资格，
  // 避免为已经不属于文章范围的记录调用模型。
  if (task.entity_type === 'content_item') {
    const eligible = contentIngestEligibility(task.entity_id);
    if (!eligible.ok) {
      finishTask(task, owner, {
        status: 'superseded', attempts: task.attempts,
        last_error: `排队后内容资格变化（${eligible.reason}）：不调用模型`,
        last_error_kind: 'ineligible_after_enqueue', finished_at: nowIso(),
      });
      return { status: 'superseded', reason: `ineligible_${eligible.reason}` };
    }
  }
  const currentHash = summary.summaryInputHash(current);
  if (currentHash !== task.input_hash || summary.currentModelKey() !== (task.model_key || 'none')) {
    finishTask(task, owner, {
      status: 'superseded', attempts: task.attempts,
      last_error: '排队期间输入签名/模型键已变化；旧签名不调用模型，已重新入队',
      last_error_kind: 'input_changed', finished_at: nowIso(),
    });
    enqueueSummaryTask(task.entity_type, task.entity_id, { source: 'reingest', reason: '输入变化后重新入队', priority: 100 });
    return { status: 'superseded', reason: 'input_changed_requeued' };
  }
  if (Date.now() >= deadlineAt - 1500) {
    releaseTask(task, owner, { delayMs: 2000, note: '批次时间预算不足，任务已延后（不计失败）' });
    return { status: 'deferred', reason: 'batch_budget' };
  }

  let out;
  try {
    out = await summary.runSummaryBatchExclusive({
      entityType: task.entity_type,
      ids: [task.entity_id],
      limit: 1,
      force: false,
      actor,
      budgetMs: Math.max(2000, Math.min(cfg.budget_ms, deadlineAt - Date.now() - 500)),
    });
  } catch (e) {
    const attempts = Number(task.attempts || 0) + 1;
    const exhausted = attempts >= Number(task.max_attempts || cfg.max_attempts);
    finishTask(task, owner, {
      status: exhausted ? 'dead' : 'failed', attempts,
      next_attempt_at: exhausted ? null : backoffIso(attempts, cfg),
      last_error: `摘要调用异常：${e.message}`.slice(0, 500), last_error_kind: 'exception',
      finished_at: exhausted ? nowIso() : null,
    });
    return { status: exhausted ? 'dead' : 'failed', reason: e.message };
  }
  if (out?.busy) {
    releaseTask(task, owner, {
      delayMs: 5000,
      note: `摘要批次忙（${out.reason || 'busy'}）：已延后，不消耗真实失败次数`,
    });
    return { status: 'deferred', reason: 'summary_busy' };
  }

  // 模型调用期间正文/模型键可能又变：旧结果不能把新签名任务标完成。
  const after = summary.loadSummaryInput(task.entity_type, task.entity_id);
  const afterHash = after ? summary.summaryInputHash(after) : null;
  const afterModel = summary.currentModelKey();
  if (!after || afterHash !== task.input_hash || afterModel !== (task.model_key || 'none')) {
    finishTask(task, owner, {
      status: 'superseded', attempts: task.attempts,
      last_error: '摘要生成期间输入签名/模型键变化；旧结果不标记完成，已按新签名重新入队',
      last_error_kind: 'input_changed', finished_at: nowIso(),
    });
    if (after) {
      enqueueSummaryTask(task.entity_type, task.entity_id, { source: 'reingest', reason: '飞行中输入变化后重新入队', priority: 100 });
    }
    return { status: 'superseded', reason: 'input_changed_during_run' };
  }

  const s = summary.getSummary(task.entity_type, task.entity_id);
  const attempts = Number(task.attempts || 0) + 1;
  if (s?.status === 'ok' && !s.stale) {
    finishTask(task, owner, {
      status: 'succeeded', attempts, next_attempt_at: null,
      last_error: null, last_error_kind: null, finished_at: nowIso(),
      result: { generated: true, input_kind: s.input_kind, model: s.model || null, generated_at: s.generated_at },
    });
    return { status: 'succeeded', result: 'ok' };
  }
  const kind = summaryErrorKind(out, s);
  const exhausted = attempts >= Number(task.max_attempts || cfg.max_attempts);
  if (kind === 'no_model') {
    finishTask(task, owner, {
      status: 'blocked', attempts,
      next_attempt_at: exhausted ? null : backoffIso(attempts, cfg),
      last_error: s?.error || '未配置可用模型：摘要未生成（blocked，不是已完成）',
      last_error_kind: 'no_model', finished_at: exhausted ? nowIso() : null,
      result: { model_configured: false },
    });
    return { status: 'blocked', reason: 'no_model' };
  }
  finishTask(task, owner, {
    status: exhausted ? 'dead' : 'failed', attempts,
    next_attempt_at: exhausted ? null : backoffIso(attempts, cfg),
    last_error: (s?.error || out?.error || out?.reason || '摘要生成失败').slice(0, 500),
    last_error_kind: kind, finished_at: exhausted ? nowIso() : null,
    result: { scanned: out?.scanned ?? null, generated: out?.generated ?? 0, reason: out?.reason || null },
  });
  return { status: exhausted ? 'dead' : 'failed', reason: s?.error || out?.reason || 'summary_failed' };
}

/* ==================================================================== */
/*  独立 worker 生命周期                                                */
/* ==================================================================== */

let timer = null;
let ticking = false;
let running = false;
let stopped = true;
let stopRequested = false;
let nextTickAt = null;
let lastTickAt = null;
let lastResult = null;
let lastError = null;

function schedule(delayMs) {
  if (stopped || !ingestWorkerEnabled()) return;
  const delay = Math.max(1000, Number(delayMs) || ingestSummaryConfig().interval_ms);
  nextTickAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(async () => {
    timer = null;
    nextTickAt = null;
    try { await tick(); } catch (e) { lastError = String(e?.message || e).slice(0, 500); }
    schedule(ingestSummaryConfig().interval_ms);
  }, delay);
  // 不阻止本地脚本/测试进程退出；服务进程由 HTTP server 保活。
  if (typeof timer.unref === 'function') timer.unref();
}

async function tick() {
  if (ticking || stopped || !ingestWorkerEnabled()) return null;
  ticking = true;
  running = true;
  stopRequested = false;
  const cfg = ingestSummaryConfig();
  const owner = `ingest-summary:${process.pid}:${newId('W')}`;
  const startedAt = Date.now();
  const deadlineAt = startedAt + cfg.budget_ms;
  let lease = null;
  const out = {
    ok: true, ticked_at: nowIso(), claimed: 0, succeeded: 0, failed: 0, blocked: 0,
    superseded: 0, deferred: 0, duration_ms: 0, results: [], reason: null,
  };
  try {
    if (!ingestWorkerEnabled()) { out.ok = false; out.reason = 'disabled'; return out; }
    // 锁顺序：先 worker 租约，后 summary_model；从不获取 collection。
    lease = acquireLease({
      key: WORKER_LEASE_KEY, owner, purpose: 'ingest_summary_worker',
      ttlMs: cfg.lease_ttl_ms,
    });
    if (!lease.ok) {
      out.ok = false; out.reason = lease.reason || 'lease_busy'; out.lease = lease.lease || null;
      return out;
    }
    const claim = claimIngestTasks({ limit: cfg.batch_size, owner, leaseTtlMs: cfg.lease_ttl_ms });
    if (!claim.ok) { out.ok = false; out.reason = claim.reason; return out; }
    out.claimed = claim.tasks.length;
    for (const task of claim.tasks) {
      if (stopRequested || !ingestWorkerEnabled() || Date.now() >= deadlineAt - 500) {
        releaseTask(task, owner, { delayMs: 1000, note: 'worker 停止/批次到期：任务放回队列，不计失败' });
        out.deferred += 1;
        continue;
      }
      renewLease({ key: WORKER_LEASE_KEY, owner, ttlMs: cfg.lease_ttl_ms });
      const r = await processTask(task, { owner, deadlineAt, actor: 'system:ingest-summary', cfg });
      out.results.push({ id: task.id, entity_id: task.entity_id, ...r });
      if (r.status === 'succeeded') out.succeeded += 1;
      else if (r.status === 'failed' || r.status === 'dead') out.failed += 1;
      else if (r.status === 'blocked') out.blocked += 1;
      else if (r.status === 'superseded') out.superseded += 1;
      else out.deferred += 1;
    }
    out.duration_ms = Date.now() - startedAt;
    return out;
  } finally {
    if (lease?.ok) releaseLease({ key: WORKER_LEASE_KEY, owner });
    running = false;
    ticking = false;
    lastTickAt = nowIso();
    lastResult = out;
    if (out.reason === 'lease_busy') lastError = 'worker 租约被占用，稍后重试';
  }
}

/** 单次排空（测试/后台“立即执行一次”也可用）；默认仍走跨进程租约。 */
export async function runIngestSummaryWorkerOnce({ actor = 'system:ingest-summary' } = {}) {
  // 手动单次执行不应被“尚未启动定时器”的 stopped 状态挡住；
  // 执行结束恢复原状态，不偷偷启动周期定时器。
  const wasStopped = stopped;
  if (wasStopped) stopped = false;
  try {
    return await tick();
  } finally {
    if (wasStopped) stopped = true;
  }
}

export function startIngestSummaryWorker() {
  if (stopped === false) {
    return { started: true, already: true, config: ingestSummaryConfig(), status: ingestWorkerStatus() };
  }
  stopped = false;
  stopRequested = false;
  if (!ingestWorkerEnabled()) {
    stopped = true;
    return {
      started: false, reason: ingestSummaryConfig().env_disabled ? 'env_disabled' : 'disabled',
      config: ingestSummaryConfig(), status: ingestWorkerStatus(),
    };
  }
  // 启动即安排一次近即时恢复，之后按短周期运行；与每日 06:30 调度完全独立。
  schedule(800);
  return { started: true, config: ingestSummaryConfig(), status: ingestWorkerStatus() };
}

export function stopIngestSummaryWorker({ reason = 'stop' } = {}) {
  stopRequested = true;
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  nextTickAt = null;
  return { stopped: true, reason };
}

export function ingestWorkerStatus() {
  const cfg = ingestSummaryConfig();
  return {
    running,
    timer_scheduled: !!timer,
    next_tick_at: nextTickAt,
    last_tick_at: lastTickAt,
    last_result: lastResult,
    last_error: lastError,
    lease: getLease(WORKER_LEASE_KEY),
    config: cfg,
    enabled: ingestWorkerEnabled(),
    env_disabled: cfg.env_disabled,
    locks: {
      order: [WORKER_LEASE_KEY, 'summary_model', 'queue_row_lease'],
      collection_shared: false,
      note: 'worker 先取独立 ingest_summary 租约，再进入 summary-svc 模型批次；不获取 collection 租约。',
    },
  };
}

/** 管理入口：开关；环境变量 kill switch 不可被后台覆盖。 */
export function setIngestWorkerEnabled(user, enabled) {
  if (user?.role !== 'admin') return { error: '仅管理员可切换入库摘要队列', status: 403 };
  const cfg = ingestSummaryConfig();
  if (cfg.env_disabled && enabled) {
    return {
      error: '环境变量 CCER_INGEST_SUMMARY_WORKER=0 已停用队列，后台开关不能覆盖',
      status: 409, env_disabled: true,
    };
  }
  setMeta(getDb(), ENABLED_META_KEY, enabled ? '1' : '0');
  if (enabled) startIngestSummaryWorker();
  else stopIngestSummaryWorker({ reason: 'admin_disabled' });
  audit({
    actor: user.name || 'admin', actorRole: user.role, action: 'ingest_summary.toggle',
    objectType: 'ingest_summary_queue', detail: { enabled: !!enabled, env_disabled: cfg.env_disabled },
  });
  return { ok: true, enabled: !!enabled, status: ingestQueueStatus() };
}

/** 管理员有界重入失败/阻塞/超限任务；保留上次错误文本，重置尝试次数。 */
export function retryIngestTasks(user, { ids = null, limit = 5 } = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可重试入库摘要任务', status: 403 };
  const cfg = ingestSummaryConfig();
  const cap = Math.max(1, Math.min(Number(limit) || 5, 20));
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))].filter(Boolean).slice(0, 100) : [];
  const rows = list.length
    ? all(`SELECT id FROM ingest_summary_queue WHERE id IN (${list.map(() => '?').join(',')})`, list)
    : all(
      `SELECT id FROM ingest_summary_queue WHERE status IN ('failed','blocked','dead')
        ORDER BY updated_at DESC LIMIT ?`,
      [cap]
    );
  const now = nowIso();
  let reset = 0;
  for (const r of rows.slice(0, cap)) {
    const res = run(
      `UPDATE ingest_summary_queue SET status='queued', attempts=0, max_attempts=?,
         next_attempt_at=?, lease_owner=NULL, lease_until=NULL, worker_started_at=NULL,
         finished_at=NULL, last_error_kind='manual_retry',
         last_error=CASE WHEN last_error IS NULL THEN '管理员手动重入' ELSE last_error END,
         updated_at=? WHERE id=?`,
      [cfg.max_attempts, now, now, r.id]
    );
    if (Number(res?.changes || 0) > 0) reset += 1;
  }
  audit({
    actor: user.name || 'admin', actorRole: user.role, action: 'ingest_summary.retry',
    objectType: 'ingest_summary_queue', detail: { requested: rows.length, reset, ids: list },
  });
  startIngestSummaryWorker();
  return { ok: true, requested: rows.length, reset, status: ingestQueueStatus() };
}

export function ingestQueueStatus({ limit = 20 } = {}) {
  const cfg = ingestSummaryConfig();
  const counts = Object.fromEntries(
    all('SELECT status, COUNT(*) c FROM ingest_summary_queue GROUP BY status').map((r) => [r.status, r.c])
  );
  const now = nowIso();
  const due = Number(get(
    `SELECT COUNT(*) c FROM ingest_summary_queue WHERE ${dueSql()}`,
    [now, now]
  )?.c || 0);
  const oldest = get(
    `SELECT id, entity_id, created_at FROM ingest_summary_queue
      WHERE status IN ('queued','failed','blocked','running') ORDER BY created_at ASC LIMIT 1`
  ) || null;
  const recent = all(
    `SELECT id,entity_type,entity_id,status,attempts,max_attempts,last_error,last_error_kind,
            next_attempt_at,created_at,updated_at,finished_at,input_hash,model_key
       FROM ingest_summary_queue ORDER BY updated_at DESC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))]
  );
  return {
    config: cfg,
    enabled: ingestWorkerEnabled(),
    worker: ingestWorkerStatus(),
    counts: { queued: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, dead: 0, superseded: 0, ...counts },
    due,
    oldest_pending: oldest,
    recent,
    note:
      '队列键包含实际输入签名、提示词版本与模型键；租约忙/重启回收不计失败次数。' +
      '摘要成功只代表摘要阶段完成，不代表核验通过。',
  };
}
