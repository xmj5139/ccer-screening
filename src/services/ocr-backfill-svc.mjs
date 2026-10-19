/**
 * OCR / PDF 历史补跑服务（docs/36 第 6 条）
 * ============================================================================
 * 【做什么】扫描四类真实记录里「本地有 PDF 原件、但正文缺失或解析失败」的对象，
 *   用统一异步解析服务（pdf-parse-svc）逐页补正文；缺文字/乱码的页走 OCR。
 *
 * 【安全边界（硬约束）】
 *   · 只允许处理**当前数据库目录**下 `official-originals/` 与 `registry-files/`
 *     两个受限根内的文件；任何 `..`、绝对路径逃逸、符号链接指向外部一律拒绝；
 *     **不开放任意服务器路径**。
 *   · 单并发（同一时刻只有一个补跑任务在跑），重入合并到运行中的任务，
 *     不重复抓取、不改动原任务状态。
 *   · 配额、单文档页上限、整批限时三重约束；quota/timeout 中止不留残留写。
 *   · 每日任务有界补跑，并在 dataset_cursor 保留**未完成游标**。
 *   · 不触碰 data/backups/**：扫描根只有上面两个。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { all, get, run, audit, dbPath, metaValue, setMeta, getDb } from '../core/db.mjs';
import { newId, nowIso, j, uj } from '../core/util.mjs';
import {
  baiduOcrConfig, baiduOcrReady, baiduOcrQuotaState, saveBaiduOcrConfig, baiduOcrPublicConfig,
} from './baidu-ocr-svc.mjs';
import { parsePdfDocument, persistParseResult, ocrRoot, readDocResult } from './pdf-parse-svc.mjs';
import { sha256 } from './collect-svc.mjs';
import { readFileSync } from 'node:fs';

/* ==================================================================== */
/*  一、受限路径根                                                      */
/* ==================================================================== */

/** 允许被 OCR 补跑读取的两个受限根（相对当前数据库目录）。 */
export const RESTRICTED_ROOT_NAMES = ['official-originals', 'registry-files'];

export function restrictedRoots() {
  const base = dirname(resolve(dbPath()));
  return RESTRICTED_ROOT_NAMES.map((n) => resolve(join(base, n)));
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 校验路径是否落在受限根内。
 * 同时做**真实路径**（符号链接解析）校验，防止用软链接把根指到外部。
 * @returns {{ok:boolean, reason?:string, resolved?:string, root?:string}}
 */
export function assertRestrictedPath(p) {
  if (!p || typeof p !== 'string') return { ok: false, reason: '路径为空' };
  const roots = restrictedRoots();
  let resolved;
  try {
    resolved = resolve(p);
  } catch {
    return { ok: false, reason: '路径无法解析' };
  }
  const root = roots.find((r) => isInside(resolved, r));
  if (!root) {
    return {
      ok: false,
      reason:
        `路径不在受限根内：${resolved}。只允许当前数据库目录下的 ` +
        `${RESTRICTED_ROOT_NAMES.join(' / ')}，不开放任意服务器路径。`,
    };
  }
  if (resolved.includes('..')) return { ok: false, reason: '路径含上级跳转（..），已拒绝' };
  if (!existsSync(resolved)) return { ok: false, reason: `文件不存在：${resolved}` };
  let st;
  try {
    st = statSync(resolved);
  } catch (e) {
    return { ok: false, reason: `无法读取文件状态：${e.message}` };
  }
  if (!st.isFile()) return { ok: false, reason: '目标不是普通文件' };
  // 真实路径（软链接）也必须落在同一个根内
  try {
    const real = realpathSync(resolved);
    const realRoot = realpathSync(root);
    if (!isInside(resolve(real), resolve(realRoot))) {
      return { ok: false, reason: `真实路径逃逸受限根（软链接指向 ${real}），已拒绝` };
    }
  } catch {
    /* realpath 失败不影响已通过的静态检查 */
  }
  const ext = resolved.toLowerCase();
  if (!ext.endsWith('.pdf')) return { ok: false, reason: '补跑只处理 PDF 原件（其它类型不在此范围）' };
  let head = '';
  try {
    head = readFileSync(resolved).subarray(0, 5).toString('latin1');
  } catch (e) {
    return { ok: false, reason: `无法读取文件头：${e.message}` };
  }
  if (head !== '%PDF-') return { ok: false, reason: '文件头不是 %PDF-，拒绝按 PDF 解析（不把二进制当文本）' };
  return { ok: true, resolved, root };
}

/* ==================================================================== */
/*  二、缺口扫描                                                        */
/* ==================================================================== */

const hasBody = (v, min = 200) => typeof v === 'string' && v.replace(/\s+/g, '').length >= min;

/**
 * 扫描真实缺正文且本地有 PDF 原件的对象。
 * 只返回**通过受限根校验**的条目；越界条目单独列在 rejected 里如实说明。
 */
export function scanOcrCandidates({ limit = 200, objectId = null } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const rows = [];
  const push = (r) => rows.push(r);

  // 1) policy_attachment：有本地 PDF、但解析质量不是 good
  for (const a of all(
    `SELECT a.id, a.policy_id, a.file_name, a.local_path, a.file_hash, a.parse_quality, a.parse_note,
            p.title AS policy_title, p.body_snapshot AS policy_body
     FROM policy_attachment a JOIN policy_document p ON p.id = a.policy_id
     WHERE a.local_path IS NOT NULL AND (a.parse_quality IS NULL OR a.parse_quality != 'good')
     ORDER BY a.created_at DESC LIMIT ?`,
    [cap]
  )) {
    if (hasBody(a.policy_body)) continue; // 同政策已有可核对正文 → 不是真缺口
    push({
      kind: 'policy_attachment', id: a.id, parent_id: a.policy_id,
      title: a.policy_title || a.file_name, local_path: a.local_path, file_hash: a.file_hash,
      reason: `附件解析质量为 ${a.parse_quality || '未记录'}：${a.parse_note || '未取得正文'}`,
    });
  }

  // 2) policy_document：本地有 PDF、但正文缺失
  for (const p of all(
    `SELECT id, title, local_path, original_file_hash, body_snapshot FROM policy_document
     WHERE local_path IS NOT NULL AND doc_status != 'superseded' AND duplicate_of IS NULL
     ORDER BY COALESCE(publish_date,'1900-01-01') DESC LIMIT ?`,
    [cap]
  )) {
    if (hasBody(p.body_snapshot)) continue;
    if (!/\.pdf$/i.test(String(p.local_path))) continue;
    push({
      kind: 'policy_document', id: p.id, parent_id: p.id, title: p.title,
      local_path: p.local_path, file_hash: p.original_file_hash, reason: '政策本地原件已有，但正文（body_snapshot）缺失或过短',
    });
  }

  // 3) methodology_version：有原件路径、但正文缺失
  for (const m of all(
    `SELECT id, name, code_display, original_file_path, original_file_hash, body_snapshot
     FROM methodology_version
     WHERE original_file_path IS NOT NULL AND document_status = 'formal'
     ORDER BY release_date DESC LIMIT ?`,
    [cap]
  )) {
    if (hasBody(m.body_snapshot)) continue;
    push({
      kind: 'methodology_version', id: m.id, parent_id: m.id,
      title: `${m.code_display || ''} ${m.name}`.trim(),
      local_path: m.original_file_path, file_hash: m.original_file_hash,
      reason: '方法学官方原件已归档，但正文缺失或过短',
    });
  }

  // 4) cea_document：有附件、但证据等级不是 full_text
  for (const d of all(
    `SELECT id, title, doc_number, attachment_path, attachment_hash, evidence_level, body_snapshot
     FROM cea_document
     WHERE attachment_path IS NOT NULL AND count_in_stats = 1
     ORDER BY COALESCE(publish_date,'') DESC LIMIT ?`,
    [cap]
  )) {
    if (hasBody(d.body_snapshot)) continue;
    push({
      kind: 'cea_document', id: d.id, parent_id: d.id,
      title: `${d.title || d.doc_number || ''}`.trim(),
      local_path: d.attachment_path, file_hash: d.attachment_hash,
      reason: `CEA 文件证据等级为 ${d.evidence_level || '未知'}，需要逐页解析/OCR 补正文`,
    });
  }

  const accepted = [];
  const rejected = [];
  for (const r of rows) {
    if (objectId && r.id !== objectId) continue;
    const chk = assertRestrictedPath(r.local_path);
    if (!chk.ok) rejected.push({ ...r, reject_reason: chk.reason });
    else accepted.push({ ...r, local_path: chk.resolved });
  }
  return { candidates: accepted, rejected, scanned: rows.length, roots: restrictedRoots() };
}

/** 单个对象的补跑候选（按对象 ID 选择） */
export function findCandidateByObject(kind, id) {
  const { candidates } = scanOcrCandidates({ limit: 2000 });
  return candidates.find((c) => c.kind === kind && c.id === id) || null;
}

/* ==================================================================== */
/*  三、任务（202 + task_id + 轮询，单并发，重入合并）                    */
/* ==================================================================== */

export const OCR_BACKFILL_JOB_KEY = 'ocr_backfill';
export const OCR_BACKFILL_CURSOR = 'ocr_backfill';

export const OCR_BACKFILL_DEFAULT_CONFIG = {
  max_docs_per_run: 5,
  batch_budget_ms: 120000,
  /** 单文档最多解析页数 */
  max_pages_per_doc: 20,
  /** 每日自动补跑的任务数上限（有界） */
  daily_docs: 10,
};

const CFG_KEY = 'ocr_backfill_config_v1';

export function ocrBackfillConfig() {
  const saved = uj(metaValue(CFG_KEY, null), {}) || {};
  return { ...OCR_BACKFILL_DEFAULT_CONFIG, ...saved };
}

export function saveOcrBackfillConfig(user, patch = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可配置 OCR 补跑', status: 403 };
  const next = { ...ocrBackfillConfig() };
  const intRange = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  if (patch.max_docs_per_run !== undefined) {
    if (!intRange(patch.max_docs_per_run, 1, 50)) return { error: 'max_docs_per_run 须为 1—50 的整数', status: 400 };
    next.max_docs_per_run = Number(patch.max_docs_per_run);
  }
  if (patch.batch_budget_ms !== undefined) {
    if (!intRange(patch.batch_budget_ms, 5000, 600000)) return { error: 'batch_budget_ms 须为 5000—600000 的整数', status: 400 };
    next.batch_budget_ms = Number(patch.batch_budget_ms);
  }
  if (patch.max_pages_per_doc !== undefined) {
    if (!intRange(patch.max_pages_per_doc, 1, 200)) return { error: 'max_pages_per_doc 须为 1—200 的整数', status: 400 };
    next.max_pages_per_doc = Number(patch.max_pages_per_doc);
  }
  if (patch.daily_docs !== undefined) {
    if (!intRange(patch.daily_docs, 0, 200)) return { error: 'daily_docs 须为 0—200 的整数', status: 400 };
    next.daily_docs = Number(patch.daily_docs);
  }
  setMeta(getDb(), CFG_KEY, j(next));
  audit({
    actor: user.name || user.id, actorRole: 'admin', action: 'ocr.backfill_config',
    objectType: 'system_meta', objectId: CFG_KEY, detail: next,
  });
  return { ok: true, config: next };
}

const OCR_TASKS = new Map();
const OCR_TASK_KEEP = 50;
/** 运行中任务超过该时长视为僵死（进程中断），自动收尾避免永久阻塞后续补跑。 */
export const OCR_STALE_TASK_MS = 30 * 60 * 1000;

function publicTask(t) {
  return {
    task_id: t.id, mode: t.mode, status: t.status,
    queued_at: t.queued_at, started_at: t.started_at, finished_at: t.finished_at,
    actor: t.actor, budget_ms: t.budget_ms,
    elapsed_ms: t.started_at ? (t.finished_at ? Date.parse(t.finished_at) - Date.parse(t.started_at) : Date.now() - Date.parse(t.started_at)) : null,
    job_id: t.job_id || null,
    error: t.error || null,
    result: t.result || null,
  };
}

export function getOcrBackfillTask(taskId) {
  const t = OCR_TASKS.get(String(taskId));
  return t ? publicTask(t) : null;
}

export function listOcrBackfillTasks({ limit = 20 } = {}) {
  return [...OCR_TASKS.values()]
    .sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)))
    .slice(0, Math.min(Number(limit) || 20, OCR_TASK_KEEP))
    .map(publicTask);
}

function runningTask() {
  for (const t of OCR_TASKS.values()) {
    if (t.status !== 'queued' && t.status !== 'running') continue;
    const startedMs = Date.parse(t.started_at || t.queued_at || '') || 0;
    if (startedMs && Date.now() - startedMs > OCR_STALE_TASK_MS) {
      t.status = 'failed';
      t.error = `任务僵死：已超过 ${Math.round(OCR_STALE_TASK_MS / 60000)} 分钟未收尾，自动标记失败（可能因进程中断）。`;
      t.finished_at = nowIso();
      continue;
    }
    return t;
  }
  return null;
}

function trimTasks() {
  const list = [...OCR_TASKS.values()].sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)));
  for (const t of list.slice(OCR_TASK_KEEP)) OCR_TASKS.delete(t.id);
}

/**
 * 受理一个补跑任务：**立即返回 202 语义**，真正解析在后台有界执行。
 * 重入：已有 queued/running 任务 → 合并（不重复解析、不改动原任务状态）。
 */
export function startOcrBackfillTask({ actor = 'system:ocr-backfill', body = {}, mode = 'scan' } = {}) {
  const existing = runningTask();
  if (existing) {
    return {
      ...publicTask(existing), merged: true, accepted: true, http_status: 202,
      message: `已有${existing.status === 'queued' ? '排队' : '运行'}中的补跑任务（task=${existing.id}），本次请求合并，不重复解析。`,
    };
  }
  const cfg = ocrBackfillConfig();
  const id = newId('OCRTASK');
  const task = {
    id, mode, status: 'queued', queued_at: nowIso(), started_at: null, finished_at: null,
    actor, result: null, error: null, job_id: null, budget_ms: cfg.batch_budget_ms, body,
  };
  OCR_TASKS.set(id, task);
  setTimeout(() => {
    runOcrBackfillTask(id, { actor, body, mode }).catch((e) => {
      task.status = 'failed';
      task.error = `后台任务异常：${e.message}`;
      task.finished_at = nowIso();
    });
  }, 0);
  trimTasks();
  audit({
    actor, action: 'ocr.backfill_task_accepted', objectType: 'ocr_task', objectId: id,
    detail: { mode, budget_ms: cfg.batch_budget_ms },
  });
  return { ...publicTask(task), accepted: true, http_status: 202 };
}

async function runOcrBackfillTask(id, { actor, body, mode }) {
  const task = OCR_TASKS.get(id);
  if (!task) return;
  task.status = 'running';
  task.started_at = nowIso();
  const cfg = ocrBackfillConfig();
  const deadlineAt = Date.now() + (Number(cfg.batch_budget_ms) || 120000);
  try {
    let out;
    if (mode === 'single') {
      out = await reparseObject({
        kind: String(body.kind || ''), id: String(body.id || ''),
        actor, force: body.force === true, deadlineAt,
      });
    } else {
      out = await runBackfillBatch({
        actor, deadlineAt, limit: Number(body.limit) || cfg.max_docs_per_run,
        objectKind: body.kind || null, objectId: body.id || null,
      });
    }
    task.result = out;
    task.job_id = out?.job_id || null;
    // 无任何成功、且有失败 → failed；有成功但也有失败 → partial
    if (mode === 'single' && out?.ok) task.status = out.status === 'full' ? 'success' : 'partial';
    else if (out?.ok_count > 0) task.status = out.fail_count > 0 ? 'partial' : 'success';
    else if (mode === 'scan' && out?.candidates === 0 && !out?.error && !out?.rejected_by_path) task.status = 'success';
    else task.status = 'failed';
    if (out?.error) task.error = out.error;
    else if (task.status === 'failed') task.error = out?.note || '未取得任何正文';
  } catch (e) {
    task.status = 'failed';
    task.error = `补跑异常：${e.message}`;
  } finally {
    if (task.status === 'running') task.status = 'failed';
    task.finished_at = nowIso();
    audit({
      actor, action: 'ocr.backfill_task_finished', objectType: 'ocr_task', objectId: id,
      detail: { mode, status: task.status, job_id: task.job_id }, result: task.status === 'success' ? 'ok' : 'warning',
    });
  }
}

/* ==================================================================== */
/*  四、有界批次执行                                                    */
/* ==================================================================== */

function openJob({ actor, trigger = 'manual' }) {
  const running = get(
    `SELECT * FROM ingestion_job WHERE job_key=? AND status='running' ORDER BY started_at DESC LIMIT 1`,
    [OCR_BACKFILL_JOB_KEY]
  );
  if (running && Date.now() - (Date.parse(running.started_at || '') || 0) < OCR_STALE_TASK_MS) {
    return { id: running.id, reused: true, job: running };
  }
  const id = newId('JOB');
  const now = nowIso();
  run(
    `INSERT INTO ingestion_job (id,job_key,title,trigger_kind,triggered_by,started_at,status,datasets,
       items_found,items_parsed,items_validated,items_queued,items_published,error_count,created_at)
     VALUES (?,?,?,?,?,?,'running',?,0,0,0,0,0,0,?)`,
    [id, OCR_BACKFILL_JOB_KEY, 'PDF/OCR 历史补跑', trigger, actor, now, j(['ocr']), now]
  );
  return { id, reused: false, job: get('SELECT * FROM ingestion_job WHERE id=?', [id]) };
}

function closeJob(jobId, { status, found = 0, parsed = 0, published = 0, errors = 0, errorSummary = null, detail = null }) {
  run(
    `UPDATE ingestion_job SET finished_at=?, status=?, items_found=?, items_parsed=?, items_validated=?,
       items_published=?, error_count=?, error_summary=?, detail_json=? WHERE id=?`,
    [nowIso(), status, found, parsed, parsed, published, errors, errorSummary, detail ? j(detail) : null, jobId]
  );
}

/**
 * 执行一批有界补跑。
 * @returns {Promise<object>} 汇总（candidates / ok_count / fail_count / status / skipped_reason ...）
 */
export async function runBackfillBatch({
  actor = 'system:ocr-backfill', deadlineAt = null, limit = 5, objectKind = null, objectId = null,
  trigger = 'manual',
} = {}) {
  const cfg = ocrBackfillConfig();
  const ocr = baiduOcrConfig();
  const ocrState = baiduOcrReady(ocr);
  const scan = scanOcrCandidates({ limit: 500, objectId });
  let candidates = scan.candidates;
  if (objectKind) candidates = candidates.filter((c) => c.kind === objectKind);
  const cap = Math.min(Math.max(Number(limit) || 1, 1), 50);
  const selected = candidates.slice(0, cap);

  const out = {
    candidates: candidates.length,
    rejected_by_path: scan.rejected.length,
    rejected: scan.rejected.slice(0, 20).map((r) => ({ kind: r.kind, id: r.id, title: r.title, reason: r.reject_reason })),
    selected: selected.length,
    ok_count: 0, fail_count: 0, ocr_calls: 0, cached_pages: 0,
    docs: [], note: null, error: null, job_id: null,
    ocr_ready: ocrState.ready, ocr_note: ocrState.reason,
    quota: baiduOcrQuotaState(ocr),
    roots: scan.roots,
  };
  if (!candidates.length) {
    out.note = '没有落在受限根内、且确实缺正文的 PDF 原件；无可补跑对象（缺口如实保留）。';
    return out;
  }

  const job = openJob({ actor, trigger });
  out.job_id = job.id;
  if (job.reused) {
    out.note = `已并入运行中的补跑任务 ${job.id}（不重复解析）。`;
  }

  for (const c of selected) {
    if (Number(deadlineAt) > 0 && Date.now() >= Number(deadlineAt) - 500) {
      out.note = `${out.note ? `${out.note} ` : ''}整批时间上限已到，剩余 ${selected.length - out.docs.length} 个对象留待下一批（游标已保留）。`;
      break;
    }
    const q = baiduOcrReady(ocr);
    if (!q.ready && !cachedTextAvailable(c)) {
      out.note = `${out.note ? `${out.note} ` : ''}OCR 不可用（${q.reason}），仅解析已有文本层；缺文字页保持缺口。`;
    }
    const r = await parseOne(c, { actor, deadlineAt, cfg, jobId: job.id });
    out.docs.push(r);
    out.ocr_calls += r.ocr_calls || 0;
    out.cached_pages += r.cached_pages || 0;
    if (r.ok) out.ok_count += 1; else out.fail_count += 1;
  }

  closeJob(job.id, {
    status: out.ok_count > 0 ? (out.fail_count ? 'partial' : 'success') : 'failed',
    found: out.candidates, parsed: out.ok_count, published: out.ok_count,
    errors: out.fail_count,
    errorSummary: out.fail_count ? `${out.fail_count} 个对象未取得正文（原因见 detail_json）` : null,
    detail: { ...out, docs: out.docs.map((d) => ({ ...d, text: undefined })) },
  });
  return out;
}

function cachedTextAvailable(c) {
  try {
    const res = readDocResult(c.file_hash || '');
    return !!(res && res.text);
  } catch {
    return false;
  }
}

/** 解析并落库单个对象 */
export async function parseOne(c, { actor, deadlineAt, cfg, jobId = null } = {}) {
  const check = assertRestrictedPath(c.local_path);
  if (!check.ok) {
    return { kind: c.kind, id: c.id, title: c.title, ok: false, reason: 'path_rejected', message: check.reason };
  }
  let hash = c.file_hash;
  if (!hash) {
    try {
      hash = sha256(readFileSync(check.resolved));
    } catch (e) {
      return { kind: c.kind, id: c.id, title: c.title, ok: false, reason: 'hash_failed', message: e.message };
    }
  }
  // 注意：null / 0 都表示「没有显式 deadline」，不能因 Number(null)===0 就判成「已过期」
  const deadline = Number(deadlineAt) > 0
    ? Number(deadlineAt)
    : Date.now() + (Number(cfg.batch_budget_ms) || 120000);
  const result = await parsePdfDocument({
    filePath: check.resolved, sha256: hash, deadlineAt: deadline,
    cfg: baiduOcrConfig(), maxPages: Number(cfg.max_pages_per_doc) || 20,
  });
  const persisted = await persistParseResult(result, { kind: c.kind, id: c.id, actor });  // docs/54 C：文本层/OCR 仍失败时，若视觉能力已显式启用且预算允许，自动补 **一页**
  // 作为有界回退；逐页结果与来源继续分开标记，不把模型理解当成官方事实。
  let vision = null;
  if (result.pages_failed > 0 && deadline - Date.now() > 8000) {
    try {
      const cap = (await import('./deepseek-capability-svc.mjs')).capabilityPublic('vision');
      if (cap?.enabled && cap.credential_configured) {
        const visionSvc = await import('./vision-svc.mjs');
        const already = get("SELECT COUNT(*) n FROM deepseek_vision_page WHERE doc_hash=? AND status='ok'", [hash]);
        if (Number(already?.n || 0) < Number(cap.config?.max_pages_per_doc || 3)) {
          const failed = (result.pages || []).filter((p) => !p.text && p.page).slice(0, 1);
          if (failed.length) {
            const v = await visionSvc.visionSupplementPage({
              kind: c.kind, id: c.id, page: failed[0].page,
              filePath: check.resolved, docHash: hash, title: c.title, actor,
              deadlineAt: deadline, apply: true,
            });
            vision = {
              ok: !!v.ok, page: failed[0].page, reason: v.reason || null,
              message: v.message || null, applied: v.applied || null,
              image_hash: v.image_hash || null, latency_ms: v.latency_ms || null,
            };
            if (v.ok) {
              const updated = readDocResult(hash);
              if (updated) result = updated;
            }
          }
        }
      }
    } catch (e) {
      vision = { ok: false, reason: 'vision_failed', message: e.message };
    }
  }
  if (vision?.ok) persisted.verify_eligible = !!result.text;
  let verification = null;
  if (persisted.verify_eligible && deadline - Date.now() > 3000) {
    try {
      const { verifyObject } = await import('./verification-svc.mjs');
      const kind = c.kind === 'policy_attachment' ? 'policy_document' : c.kind;
      const id = c.kind === 'policy_attachment' ? c.parent_id : c.id;
      const checked = await verifyObject(kind, id, {
        actor, force: true, timeoutMs: Math.min(25000, deadline - Date.now() - 500),
      });
      const record = checked.id ? get('SELECT model_used,latency_ms FROM verification_result WHERE id=?', [checked.id]) : null;
      verification = { id: checked.id, result: checked.result, model_used: record?.model_used ?? null, latency_ms: record?.latency_ms ?? null };
    } catch (e) {
      verification = { result: 'unavailable', error: e.message };
    }
  }
  return {
    kind: c.kind, id: c.id, title: c.title,
    ok: !!result.text,
    status: result.status,
    pages_total: result.pages_total,
    pages_text: result.pages_text,
    pages_ocr: result.pages_ocr,
    pages_failed: result.pages_failed,
    failed_pages: result.failed_pages || [],
    cached_pages: result.cached_pages || 0,
    ocr_calls: result.ocr_calls || 0,
    pages_vision: result.pages_vision || 0,
    vision,
    aborted: result.aborted || null,
    result_written: !!result.result_written,
    verify_eligible: persisted.verify_eligible,
    need_verify: persisted.verify_eligible,
    verification,
    reason: result.aborted || (result.text ? null : (result.error || 'no_text')),
    message: result.note || result.error || null,
    job_id: jobId,
  };
}

/**
 * 按对象 ID 选择性重解析（CLI reparse 与后台单条补跑共用）。
 */
export async function reparseObject({ kind, id, actor = 'system:ocr-backfill', force = false, deadlineAt = null } = {}) {
  if (!kind || !id) return { error: '缺少 kind 或 id', status: 400 };
  const allowed = ['policy_attachment', 'policy_document', 'methodology_version', 'cea_document'];
  if (!allowed.includes(String(kind))) return { error: `kind 须为 ${allowed.join(' | ')}`, status: 400, allowed };
  const found = findCandidateByObject(String(kind), String(id));
  if (!found) {
    // 允许对已有正文的对象做显式重解析（force），但必须仍然落在受限根内
    const row = locateObjectPath(String(kind), String(id));
    if (!row) return { error: '未找到该对象，或该对象没有本地 PDF 原件', status: 404 };
    const chk = assertRestrictedPath(row.local_path);
    if (!chk.ok) return { error: chk.reason, status: 400, path_rejected: true };
    if (!force) {
      return {
        error: '该对象当前没有识别到缺正文；如确需重解析请显式传 force=true', status: 409,
        local_path: chk.resolved,
      };
    }
    return parseOne({ ...row, local_path: chk.resolved }, { actor, deadlineAt, cfg: ocrBackfillConfig() });
  }
  return parseOne(found, { actor, deadlineAt, cfg: ocrBackfillConfig() });
}

export function locateObjectPath(kind, id) {
  if (kind === 'policy_attachment') {
    const r = get(`SELECT a.id, a.policy_id, a.file_name, a.local_path, a.file_hash, p.title
                   FROM policy_attachment a JOIN policy_document p ON p.id=a.policy_id WHERE a.id=?`, [id]);
    return r ? { kind, id: r.id, parent_id: r.policy_id, title: r.title || r.file_name, local_path: r.local_path, file_hash: r.file_hash } : null;
  }
  if (kind === 'policy_document') {
    const r = get('SELECT id, title, local_path, original_file_hash FROM policy_document WHERE id=?', [id]);
    return r ? { kind, id: r.id, parent_id: r.id, title: r.title, local_path: r.local_path, file_hash: r.original_file_hash } : null;
  }
  if (kind === 'methodology_version') {
    const r = get('SELECT id, name, code_display, original_file_path, original_file_hash FROM methodology_version WHERE id=?', [id]);
    return r ? { kind, id: r.id, parent_id: r.id, title: `${r.code_display || ''} ${r.name}`.trim(), local_path: r.original_file_path, file_hash: r.original_file_hash } : null;
  }
  const r = get('SELECT id, title, attachment_path, attachment_hash FROM cea_document WHERE id=?', [id]);
  return r ? { kind, id: r.id, parent_id: r.id, title: r.title, local_path: r.attachment_path, file_hash: r.attachment_hash } : null;
}

/* ==================================================================== */
/*  五、每日有界补跑 + 未完成游标                                        */
/* ==================================================================== */

export function readBackfillCursor() {
  const row = get('SELECT * FROM dataset_cursor WHERE dataset=?', [OCR_BACKFILL_CURSOR]);
  if (!row) return { dataset: OCR_BACKFILL_CURSOR, pending_ids: [], last_id: null, last_status: 'never' };
  const note = uj(row.note, {}) || {};
  return {
    dataset: row.dataset,
    last_window_from: row.last_window_from,
    last_success_at: row.last_success_at,
    last_attempt_at: row.last_attempt_at,
    last_status: row.last_status,
    last_error: row.last_error,
    consecutive_failures: row.consecutive_failures,
    pending_ids: Array.isArray(note.pending_ids) ? note.pending_ids : [],
    last_id: note.last_id || null,
  };
}

function writeBackfillCursor({ pendingIds = [], lastId = null, status = 'ok', error = null, seen = 0, newCount = 0 }) {
  const now = nowIso();
  const prev = get('SELECT consecutive_failures FROM dataset_cursor WHERE dataset=?', [OCR_BACKFILL_CURSOR]);
  const fails = status === 'failed' ? (Number(prev?.consecutive_failures) || 0) + 1 : 0;
  run(
    `INSERT INTO dataset_cursor (dataset,last_window_from,last_window_to,last_success_at,last_attempt_at,
       last_status,last_error,consecutive_failures,items_seen,items_new,note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET last_window_from=excluded.last_window_from,last_window_to=excluded.last_window_to,
       last_success_at=excluded.last_success_at,last_attempt_at=excluded.last_attempt_at,last_status=excluded.last_status,
       last_error=excluded.last_error,consecutive_failures=excluded.consecutive_failures,items_seen=excluded.items_seen,
       items_new=excluded.items_new,note=excluded.note`,
    [
      OCR_BACKFILL_CURSOR, lastId, pendingIds.length ? pendingIds[pendingIds.length - 1] : null,
      status === 'ok' ? now : null, now, status, error, fails, seen, newCount,
      j({ pending_ids: pendingIds, last_id: lastId, updated_at: now }),
    ]
  );
}

/**
 * 每日任务的有界补跑入口：默认受 daily_docs 限制，保留未完成游标。
 */
export async function runDailyOcrBackfill({ actor = 'system:daily-ocr', deadlineAt = null } = {}) {
  const cfg = ocrBackfillConfig();
  const budget = Number(cfg.daily_docs);
  if (!budget) {
    return { skipped: true, reason: 'daily_docs_disabled', message: '每日 OCR 补跑被配置为 0（关闭），未执行。' };
  }
  const cursor = readBackfillCursor();
  const out = await runBackfillBatch({
    actor, deadlineAt, limit: budget, trigger: 'schedule',
  });
  const processed = out.docs.map((d) => d.id);
  const remaining = (out.candidates || 0) - (out.selected || 0);
  // 未完成游标 = 本轮结束后**重新扫描**到的真实缺口（已被补上正文的对象自然不再出现；
  // 处理失败的对象仍在列表里，属于「未完成」，下次继续）。不能对旧列表做 slice，
  // 否则会把已消失的条目也算成待处理，产生 off-by-one。
  const pendingIds = scanOcrCandidates({ limit: 500 }).candidates.map((c) => c.id);
  writeBackfillCursor({
    pendingIds, lastId: processed[processed.length - 1] || cursor.last_id,
    status: out.fail_count && !out.ok_count ? 'failed' : 'ok',
    error: out.fail_count && !out.ok_count ? (out.note || '未取得正文') : null,
    seen: out.candidates, newCount: out.ok_count,
  });
  return {
    ...out,
    cursor: readBackfillCursor(),
    daily_budget: budget,
    note: `${out.note || ''} 有界补跑：本轮处理 ${out.selected} / ${out.candidates} 个对象，未完成 ${Math.max(0, remaining)} 个已写入游标。`.trim(),
  };
}

/* ==================================================================== */
/*  六、CLI / 状态                                                     */
/* ==================================================================== */

export function ocrBackfillStatus() {
  const scan = scanOcrCandidates({ limit: 500 });
  const ocr = baiduOcrPublicConfig();
  const backfill = ocrBackfillConfig();
  return {
    config: backfill,
    ocr_config: ocr,
    candidates: scan.candidates.length,
    rejected_by_path: scan.rejected.length,
    rejected_sample: scan.rejected.slice(0, 20).map((r) => ({ kind: r.kind, id: r.id, title: r.title, reason: r.reject_reason })),
    candidate_sample: scan.candidates.slice(0, 50).map((c) => ({ kind: c.kind, id: c.id, title: c.title, reason: c.reason, local_path: c.local_path })),
    roots: scan.roots,
    cursor: readBackfillCursor(),
    tasks: listOcrBackfillTasks({ limit: 10 }),
    quota: baiduOcrQuotaState(),
    ocr_root: ocrRoot(),
    note:
      '只扫描当前数据库目录下的 official-originals / registry-files 两个受限根；' +
      '越界路径一律拒绝并列在 rejected_sample，不开放任意服务器路径。',
  };
}

export { saveBaiduOcrConfig };
