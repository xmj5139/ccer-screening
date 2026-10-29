/**
 * CEA 有界采集服务
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md「采集、AI核验与每日调度」：
 *   - 优先官方 HTML/PDF；搜索只用于发现候选 URL 或补证，**搜索摘要不能替代阅读全文**；
 *   - 复用已有 pickSearchProvider/runSearch、pickFetchConnection/fetchUrlContent、
 *     verifyConfig/pickVerifyProvider/callVerifyModel/validateCitations，不新建密钥输入流程；
 *   - 无服务 / 鉴权失败 / 超时 / 空结果分别记录（失败如实留缺口，不伪造成功）；
 *   - 有界默认：1 轮新增采集 + 最多 2 轮补证、每轮 ≤ 8 条、单任务总时间上限（默认 120 秒）；
 *     超限留待次日，不阻塞 CCER 每日任务；
 *   - 任务重入：已在运行的 CEA 任务 → 复用当前任务，不并发重复抓取；
 *   - 浏览器/接口只启动后台有界任务或立即返回状态，不阻塞前端。
 *
 * 安全：
 *   - 出站一律经 collect-svc.checkOutboundUrl（协议 + 私网 + 域名白名单）与 fetchText（限流/超时/重定向复检）；
 *   - 网页正文（含提示注入文本）只作为数据，绝不作为指令执行；
 *   - 不打印、不存储任何明文凭据。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, metaValue, setMeta, getDb, audit } from '../core/db.mjs';
import { newId, nowIso, todayCst, j, uj } from '../core/util.mjs';
import { CEA_DEFAULTS } from '../data/cea-sources.mjs';
import {
  fetchText, recordSnapshot, checkOutboundUrl, sha256, DEFAULT_ALLOWED_DOMAINS,
} from './collect-svc.mjs';
import { pickSearchProvider, runSearch } from './search-svc.mjs';
import { pickFetchConnection, fetchUrlContent } from './web-fetch-svc.mjs';
import { verifyConfig, pickVerifyProvider, verifyObject } from './verification-svc.mjs';
// 统一异步 PDF 解析（docs/36）：真实采集优先走逐页解析 + OCR 兜底
import { parsePdfDocument } from './pdf-parse-svc.mjs';
import {
  htmlToText, parseCeaDailyReport, parseEntityRows, parseIntentionRows, parseAnnualClosureNotice,
  detectCeaNonTargetPage,
} from './cea-parse.mjs';
import {
  parseDailyOverview, parseMarketByDate, parseSubStat, parseTradeIntents, parseHolidays, parseHisKline,
} from './cea-json.mjs';
import {
  getCeaSourceByCode, markCeaSourceRun, upsertCeaTradeDaily, upsertCeaDocument,
  upsertCeaEntity, upsertCeaIntention, upsertCeaOverview, upsertCeaCalendarDates, recordQuoteSource,
  recordCeaGap, closeCeaGapsByPrefixes, saveCeaChecks, CEA_GAP_DATASETS,
  seedCeaBaseData, CEA_PRICE_REGIME_2026, applyCeaAnnualClosureNotice, upsertCeaPriceHistory, reconcileCeaCalendar,
  recordCeaPageExclusion,
} from './cea-svc.mjs';

/* ==================================================================== */
/*  一、运行配置（服务端校验）                                          */
/* ==================================================================== */

const CFG_KEY = 'cea_collect_config_v1';

export const CEA_COLLECT_DEFAULT_CONFIG = {
  enabled: true,
  batch_budget_ms: CEA_DEFAULTS.batch_budget_ms,
  max_items_per_round: CEA_DEFAULTS.max_items_per_round,
  max_evidence_rounds: CEA_DEFAULTS.max_evidence_rounds,
  request_timeout_ms: CEA_DEFAULTS.request_timeout_ms,
  daily_fetch_limit: CEA_DEFAULTS.daily_fetch_limit,
  after_close_enabled: true,
  after_close_time: CEA_DEFAULTS.after_close_time,
  /** 采集后是否自动跑 AI 证据一致性核验（未配置模型时保持 unavailable，不伪造通过） */
  auto_verify: true,
  /** 核验与抓取使用的服务（null = 自动挑选已启用的） */
  search_provider_id: null,
  fetch_connection_id: null,
};

export function ceaCollectConfig() {
  const saved = uj(metaValue(CFG_KEY, null), {}) || {};
  return { ...CEA_COLLECT_DEFAULT_CONFIG, ...saved };
}

/** 管理员保存采集配置：全部字段服务端校验，越界即拒绝 */
export function saveCeaCollectConfig(user, patch = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可配置 CEA 采集', status: 403 };
  const next = { ...ceaCollectConfig() };
  const intRange = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.auto_verify !== undefined) next.auto_verify = !!patch.auto_verify;
  if (patch.after_close_enabled !== undefined) next.after_close_enabled = !!patch.after_close_enabled;
  if (patch.batch_budget_ms !== undefined) {
    // 首期 CEA 批次建议 ≤120 秒：不允许配置成无限占用（上限 10 分钟）
    if (!intRange(patch.batch_budget_ms, 5000, 600000)) return { error: 'batch_budget_ms 须为 5000—600000 的整数（建议 ≤120000）', status: 400 };
    next.batch_budget_ms = Number(patch.batch_budget_ms);
  }
  if (patch.max_items_per_round !== undefined) {
    if (!intRange(patch.max_items_per_round, 1, 8)) return { error: 'max_items_per_round 须为 1—8 的整数（规范上限每轮 8 条）', status: 400 };
    next.max_items_per_round = Number(patch.max_items_per_round);
  }
  if (patch.max_evidence_rounds !== undefined) {
    if (!intRange(patch.max_evidence_rounds, 0, 2)) return { error: 'max_evidence_rounds 须为 0—2 的整数（规范上限补证 2 轮）', status: 400 };
    next.max_evidence_rounds = Number(patch.max_evidence_rounds);
  }
  if (patch.request_timeout_ms !== undefined) {
    if (!intRange(patch.request_timeout_ms, 3000, 120000)) return { error: 'request_timeout_ms 须为 3000—120000 的整数', status: 400 };
    next.request_timeout_ms = Number(patch.request_timeout_ms);
  }
  if (patch.daily_fetch_limit !== undefined) {
    if (!intRange(patch.daily_fetch_limit, 1, 500)) return { error: 'daily_fetch_limit 须为 1—500 的整数', status: 400 };
    next.daily_fetch_limit = Number(patch.daily_fetch_limit);
  }
  if (patch.after_close_time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.after_close_time))) return { error: 'after_close_time 须为 HH:MM', status: 400 };
    next.after_close_time = String(patch.after_close_time);
  }
  if (patch.search_provider_id !== undefined) next.search_provider_id = patch.search_provider_id || null;
  if (patch.fetch_connection_id !== undefined) next.fetch_connection_id = patch.fetch_connection_id || null;
  setMeta(getDb(), CFG_KEY, j(next));
  audit({ actor: user.name, actorRole: user.role, action: 'cea.collect_config', objectType: 'system_meta', objectId: CFG_KEY, detail: next });
  return { ok: true, config: next };
}

/* ==================================================================== */
/*  二、任务与配额                                                      */
/* ==================================================================== */

const JOB_KEY_DAILY = 'cea_daily';
const JOB_KEY_DOC = 'cea_documents';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

/** 运行中的任务超过该时长即视为僵死（进程被中断/异常退出），自动收尾避免永久阻塞后续采集 */
export const CEA_STALE_JOB_MS = 30 * 60 * 1000;

/**
 * 取得（或复用）一个 CEA 任务：已在运行则复用，避免重复抓取。
 * 若「运行中」的任务已僵死（超过 CEA_STALE_JOB_MS），先如实标记为 failed 再新建，
 * 否则一次异常退出会让后续所有采集被永远拒绝（已实测踩坑）。
 */
export function openCeaJob({ jobKey = JOB_KEY_DAILY, title, trigger = 'manual', actor = 'system:cea' }) {
  const running = get(
    `SELECT * FROM ingestion_job WHERE job_key=? AND status='running' ORDER BY started_at DESC LIMIT 1`,
    [jobKey]
  );
  if (running) {
    const startedMs = Date.parse(running.started_at || '') || 0;
    const age = Date.now() - startedMs;
    if (startedMs && age > CEA_STALE_JOB_MS) {
      closeCeaJob(running.id, {
        status: 'failed',
        errorSummary: `任务僵死：开始于 ${running.started_at}，已超过 ${Math.round(CEA_STALE_JOB_MS / 60000)} 分钟未收尾，自动标记失败（可能因进程中断）。`,
        detail: { stale: true, age_ms: age },
      });
      audit({
        actor, action: 'cea.job_stale_closed', objectType: 'ingestion_job', objectId: running.id,
        detail: { job_key: jobKey, started_at: running.started_at, age_ms: age },
        result: 'warning',
      });
    } else {
      return { id: running.id, reused: true, job: running };
    }
  }
  const id = newId('JOB');
  const now = nowIso();
  run(
    `INSERT INTO ingestion_job (id,job_key,title,trigger_kind,triggered_by,started_at,status,datasets,
       items_found,items_parsed,items_validated,items_queued,items_published,error_count,created_at)
     VALUES (?,?,?,?,?,?, 'running',?,0,0,0,0,0,0,?)`,
    [id, jobKey, title, trigger, actor, now, j(['cea']), now]
  );
  return { id, reused: false, job: get('SELECT * FROM ingestion_job WHERE id=?', [id]) };
}

/**
 * 任务重入的统一返回：**绝不关闭仍在运行的原任务**。
 * 旧实现复用到一个运行中的任务后又调用 closeCeaJob('partial')，等于把另一个仍在运行的任务
 * 提前标成已结束、破坏真实状态；重入只应合并本次请求，不改变原任务的生命周期。
 */
export function ceaReentryResult(job, label = 'CEA 采集任务') {
  return {
    reused: true,
    merged: true,
    status: 'running',
    job_id: job.id,
    merged_into_job_id: job.id,
    started_at: job.job?.started_at || null,
    message: `已存在运行中的${label}（job=${job.id}）：本次请求合并到该任务，不重复抓取，也不改动原任务状态。`,
  };
}

export function addCeaStep(jobId, { stage, target = null, status = 'ok', items = 0, message = null, snapshotId = null, detail = null }) {
  const now = nowIso();
  let order = 1;
  try {
    order = (get('SELECT COALESCE(MAX(step_order),0) AS m FROM ingestion_step WHERE job_id=?', [jobId])?.m || 0) + 1;
  } catch { /* 忽略 */ }
  run(
    `INSERT INTO ingestion_step (id,job_id,step_order,stage,target,status,started_at,finished_at,items,message,snapshot_id,detail_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('STEP'), jobId, order, stage, target, status, now, now, items, message, snapshotId, detail ? j(detail) : null]
  );
}

export function closeCeaJob(jobId, { status, found = 0, parsed = 0, validated = 0, published = 0, errors = 0, errorSummary = null, dataAsOf = null, detail = null }) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  run(
    `UPDATE ingestion_job SET finished_at=?, status=?, items_found=?, items_parsed=?, items_validated=?,
       items_published=?, error_count=?, error_summary=?, data_as_of=?, detail_json=? WHERE id=?`,
    [nowIso(), status, n(found), n(parsed), n(validated), n(published), n(errors), errorSummary, dataAsOf, detail ? j(detail) : null, jobId]
  );
}

/** 读取异常信息。异常对象的 message getter 再次抛错时，也不能阻止任务收尾。 */
function ceaExceptionMessage(e) {
  try {
    if (e && typeof e === 'object' && e.message) return String(e.message);
    return String(e ?? '未知异常');
  } catch {
    return '未知异常（异常信息不可读取）';
  }
}

const CEA_FETCH_COUNTER_KEY = 'cea_fetch_counter_v1';

/** 当日 CEA 外发尝试计数（研究的正文抓取等非官方域名请求也计入，含失败尝试） */
function ceaFetchCounter() {
  const raw = uj(metaValue(CEA_FETCH_COUNTER_KEY, null), {}) || {};
  const today = todayCst();
  return raw.date === today
    ? { date: today, count: Math.max(0, Number(raw.count) || 0) }
    : { date: today, count: 0 };
}

/**
 * 记录一次 CEA 外发尝试（**按定义计数：网络失败/超时也计**）。
 * 官方域名抓取已经由 source_snapshot 统计，这里只补记「非官方域名但属于 CEA 批次」的调用，
 * 避免研究正文抓取绕过 daily_fetch_limit。
 */
export function bumpCeaFetchAttempts(n = 1, reason = null) {
  const cur = ceaFetchCounter();
  const next = {
    date: cur.date,
    count: cur.count + Math.max(0, Number(n) || 0),
    last_reason: reason ? String(reason).slice(0, 120) : null,
    updated_at: nowIso(),
  };
  setMeta(getDb(), CEA_FETCH_COUNTER_KEY, j(next));
  return next;
}

/** 当日 CEA 抓取次数（服务端配额；超限则不再外发请求） */
export function ceaFetchUsedToday() {
  const today = todayCst();
  const row = get(
    `SELECT COUNT(*) AS c FROM source_snapshot WHERE fetched_at LIKE ? AND (url LIKE ? OR url LIKE ? OR url LIKE ?)`,
    [`${today}%`, '%cneeex.com%', '%mee.gov.cn%', '%fujian.gov.cn%']
  );
  const official = Number(row?.c || 0);
  const extra = ceaFetchCounter();
  return official + extra.count;
}

export function ceaQuotaState(cfg = ceaCollectConfig()) {
  const used = ceaFetchUsedToday();
  const counter = ceaFetchCounter();
  return {
    used, limit: cfg.daily_fetch_limit, remaining: Math.max(0, cfg.daily_fetch_limit - used), date: todayCst(),
    breakdown: { official_snapshots: used - counter.count, research_and_other_attempts: counter.count },
  };
}

/* ==================================================================== */
/*  三、单条抓取 → 快照 → 解析 → 入库                                    */
/* ==================================================================== */

/**
 * 抓取并保存原始快照。所有外发请求都走这里，保证：
 *   白名单 + 私网拦截 + 限流 + 超时 + 重定向复检 + 快照哈希。
 */
export async function fetchAndSnapshot(url, { allowedDomains = DEFAULT_ALLOWED_DOMAINS, sourceId = null, sourceCode = null, timeoutMs = CEA_DEFAULTS.request_timeout_ms, actor = 'system:cea-collect', parserNote = null, deadlineAt = null } = {}) {
  const chk = checkOutboundUrl(url, allowedDomains);
  if (!chk.ok) {
    return { ok: false, reason: 'blocked_url', message: chk.reason, url };
  }
  const res = await fetchText(url, {
    allowedDomains, timeoutMs, retryMax: 1, rateLimitPerMin: 12,
    deadlineAt,
    userAgent: 'CCER-Research-Platform/2.2 (CEA public data; low-frequency, contact: data-owner)',
  });
  if (!res.ok) {
    // 失败也要留快照记录（记录 HTTP 状态与错误），便于「失败如实留缺口」可审计
    const snap = recordSnapshot({
      url, res: { status: res.status ?? null, hash: null, bytes: 0, body: null },
      ceaSourceId: sourceId, parseQuality: 'failed', parseNote: parserNote || '抓取失败，未获得正文',
      error: String(res.error || 'unknown').slice(0, 500),
    });
    return {
      ok: false, reason: res.reason || (res.status ? `http_${res.status}` : 'fetch_failed'),
      message: res.error, url, snapshotId: snap.id, deadline_exceeded: !!res.deadline_exceeded,
    };
  }
  const snap = recordSnapshot({
    url, res, ceaSourceId: sourceId, parseQuality: 'not_attempted',
    parseNote: parserNote || 'CEA 采集原始响应已保存，等待解析',
  });
  return {
    ok: true, url, body: res.body,
    // 原始字节必须保留：PDF/图片等二进制不能经字符串往返（会因 UTF-8 替换字符而损坏，
    // 实测 620KB 的 PDF 经字符串往返后落盘变成 2.3MB 且无法解析）
    buf: res.buf || null,
    hash: res.hash || sha256(Buffer.from(String(res.body || ''), 'utf8')),
    snapshotId: snap.id, deduped: !!snap.deduped, status: res.status, bytes: res.bytes,
    content_type: res.content_type || null, final_url: res.final_url,
  };
}

/** 采集并解析一条 CEA 日报 */
export async function collectOneCeaDaily(item, { actor = 'system:cea-collect', jobId = null, cfg = ceaCollectConfig(), rangeComplete = null, deadlineAt = null } = {}) {
  const source = item.sourceCode ? getCeaSourceByCode(item.sourceCode) : null;
  const allowed = source?.allowed_domains?.length ? source.allowed_domains : DEFAULT_ALLOWED_DOMAINS;
  if (deadlineAt && deadlineAt - Date.now() <= 500) {
    return { ok: false, stage: 'fetch', reason: 'batch_budget_exceeded', message: '批次总时间上限已到：该日报未发出请求（留待下一批）', url: item.url, deadline_exceeded: true };
  }
  // 已按标题/主内容确定性规则排除的非目标页：不重复抓取/解析，也不新建行情行。
  const knownExclusion = get('SELECT * FROM cea_page_exclusion WHERE url=?', [item.url]);
  if (knownExclusion) {
    const exclusion = recordCeaPageExclusion({
      url: item.url,
      sourceCode: item.sourceCode || knownExclusion.source_code || null,
      snapshotId: knownExclusion.snapshot_id,
      contentHash: knownExclusion.content_hash,
      title: knownExclusion.title,
      rule: knownExclusion.rule,
      evidence: knownExclusion.evidence,
      snapshotExcerpt: knownExclusion.snapshot_excerpt,
      actor,
    });
    if (jobId) {
      addCeaStep(jobId, {
        stage: 'parse', target: item.url, status: 'skipped', items: 0,
        message: `已登记非目标页（${knownExclusion.rule}）：不重复抓取/解析，不建行情行`,
        snapshotId: knownExclusion.snapshot_id,
        detail: { exclusion_id: knownExclusion.id, cached: true },
      });
    }
    return {
      ok: false, stage: 'non_target', reason: 'non_target_page_cached', excluded: true,
      message: `该 URL 已登记为非目标页（规则 ${knownExclusion.rule}）；按记录停止重复抓取/解析。`,
      url: item.url, snapshotId: knownExclusion.snapshot_id,
      exclusion_id: knownExclusion.id, exclusion_rule: knownExclusion.rule,
      gaps_mitigated: exclusion.gap_updated || 0,
    };
  }
  const fetched = await fetchAndSnapshot(item.url, {
    allowedDomains: allowed, sourceId: source?.id || null, sourceCode: item.sourceCode || null,
    timeoutMs: cfg.request_timeout_ms, actor, deadlineAt,
    parserNote: `CEA 日报采集（job=${jobId || 'cli'}）`,
  });
  if (jobId) {
    addCeaStep(jobId, {
      stage: 'collect', target: item.url, status: fetched.ok ? 'ok' : 'failed', items: fetched.ok ? 1 : 0,
      message: fetched.ok ? `HTTP ${fetched.status}，${fetched.bytes} 字节` : `${fetched.reason}：${fetched.message || ''}`,
      snapshotId: fetched.snapshotId,
    });
  }
  if (!fetched.ok) {
    if (item.sourceCode) markCeaSourceRun(item.sourceCode, { ok: false, error: `${fetched.reason}: ${fetched.message || ''}`, itemsFailed: 1 });
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.trade,
      title: `CEA 日报抓取失败：${item.url}`,
      description: `真实抓取未获得正文（${fetched.reason}：${fetched.message || ''}）。未写入任何行情行，不用占位或模拟数据顶替。`,
      impact: '该交易日行情缺失，序列中不生成 0 值点。',
      severity: 'warning',
      gapKey: `cea:trade:fetch:${item.url}`.slice(0, 300),
    });
    return { ok: false, stage: 'fetch', reason: fetched.reason, message: fetched.message, url: item.url, snapshotId: fetched.snapshotId };
  }

  // 解析行情前先做确定性的页面归属判定：企业基本信息、招聘、导航等明确非目标页
  // 不进入行情解析、不写任何行情行；同 URL 历史 parse gap 留痕后停止重复重试。
  // 未知/空/访问失败不在此判定，仍按原流程保留真实缺口。
  const pageKind = detectCeaNonTargetPage(fetched.body, { url: item.url });
  if (pageKind.non_target) {
    const exclusion = recordCeaPageExclusion({
      url: item.url,
      sourceCode: item.sourceCode || null,
      snapshotId: fetched.snapshotId,
      contentHash: fetched.hash,
      title: pageKind.title,
      rule: pageKind.rule,
      evidence: pageKind.evidence,
      snapshotExcerpt: pageKind.main_excerpt,
      actor,
    });
    if (jobId) {
      addCeaStep(jobId, {
        stage: 'parse', target: item.url, status: 'skipped', items: 0,
        message: `非目标页排除（${pageKind.rule}）：${pageKind.reason}；未建行情行，不反复重试`,
        snapshotId: fetched.snapshotId,
        detail: { exclusion_id: exclusion.id || null, rule: pageKind.rule, title: pageKind.title },
      });
    }
    return {
      ok: false, stage: 'non_target', reason: 'non_target_page', excluded: true,
      message: `${pageKind.reason}（规则 ${pageKind.rule}）；未写入行情行。`,
      url: item.url, snapshotId: fetched.snapshotId,
      exclusion_id: exclusion.id || null, exclusion_rule: pageKind.rule,
      gaps_mitigated: exclusion.gap_updated || 0,
    };
  }

  const parsed = parseCeaDailyReport(fetched.body, { url: item.url, tradeDateHint: item.dateHint || null });
  if (jobId) {    addCeaStep(jobId, {
      stage: 'parse', target: item.url, status: parsed.ok ? 'ok' : 'failed',
      message: `parse_status=${parsed.parse_status}；${parsed.parse_note}`.slice(0, 900),
      snapshotId: fetched.snapshotId,
      detail: { period: parsed.period, trade_date: parsed.trade_date, missing: parsed.missing_fields, explicit_none: parsed.explicit_none },
    });
  }
  // 正文无目标内容 → 失败并留缺口，绝不生成零值行（CEA-04）
  if (!parsed.ok) {
    if (item.sourceCode) markCeaSourceRun(item.sourceCode, { ok: false, error: parsed.parse_note, itemsFailed: 1 });
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.trade,
      title: `CEA 日报解析失败：${item.url}`,
      description: `${parsed.parse_note}（快照 ${fetched.snapshotId}，哈希 ${String(fetched.hash).slice(0, 16)}…）`,
      impact: '未写入任何行情行；不得以 0 值或估算值代替。',
      severity: 'critical',
      gapKey: `cea:trade:parse:${item.url}`.slice(0, 300),
    });
    return { ok: false, stage: 'parse', reason: 'parse_failed', message: parsed.parse_note, url: item.url, snapshotId: fetched.snapshotId, parsed };
  }
  // 月报不得进入日行情（CEA-04）
  if (parsed.period === 'month') {
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.trade,
      title: `月报被识别并拒绝写入日行情：${item.url}`,
      description: `${parsed.parse_note}（快照 ${fetched.snapshotId}）`,
      impact: '月报数据必须单独标记 period；本次未写入日行情表。',
      severity: 'warning',
      gapKey: `cea:trade:monthly:${item.url}`.slice(0, 300),
    });
    return { ok: false, stage: 'parse', reason: 'monthly_not_daily', message: parsed.parse_note, url: item.url, snapshotId: fetched.snapshotId, parsed };
  }
  if (!parsed.trade_date) {
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.trade,
      title: `无法确定 CEA 行情日期：${item.url}`,
      description: '正文与 URL 都没有可确认的交易日；按规范不补 0、不用采集日兜底。',
      impact: '该条未入库。',
      severity: 'critical',
      gapKey: `cea:trade:nodate:${item.url}`.slice(0, 300),
    });
    return { ok: false, stage: 'parse', reason: 'no_trade_date', url: item.url, snapshotId: fetched.snapshotId, parsed };
  }

  const out = upsertCeaTradeDaily({
    trade_date: parsed.trade_date,
    fields: parsed.fields,
    parse: parsed,
    meta: {
      sourceCode: item.sourceCode || null,
      sourceUrl: item.url,
      snapshotId: fetched.snapshotId,
      contentHash: fetched.hash,
      fetchedAt: nowIso(),
      actor,
      priceRegime: item.priceRegime || CEA_PRICE_REGIME_2026,
      dataAsOf: parsed.data_as_of || parsed.trade_date,
      rangeComplete,
    },
  });
  if (out.error) {
    if (jobId) addCeaStep(jobId, { stage: 'publish', target: item.url, status: 'failed', message: out.error, snapshotId: fetched.snapshotId });
    return { ok: false, stage: 'publish', reason: 'upsert_failed', message: out.error, url: item.url, parsed, snapshotId: fetched.snapshotId };
  }
  if (item.sourceCode) markCeaSourceRun(item.sourceCode, { ok: true, itemsOk: 1 });
  // 该 URL 之前登记的抓取/解析缺口本次已消除 → 自动结清（保留记录，只改状态并留痕）
  const closedGaps = closeCeaGapsByPrefixes(
    [`cea:trade:fetch:${item.url}`, `cea:trade:parse:${item.url}`, `cea:trade:nodate:${item.url}`],
    { note: `本次采集已成功解析并入库（交易日 ${parsed.trade_date}，快照 ${fetched.snapshotId}）`, actor }
  );
  if (jobId) {
    addCeaStep(jobId, {
      stage: 'validate', target: item.url, status: out.check_status === 'fail' ? 'failed' : 'ok',
      message: `确定性核对=${out.check_status}｜${out.created ? '新增' : out.revised ? `修订 r${out.revision}` : '幂等重采，数值未变'}`,
      snapshotId: fetched.snapshotId,
      detail: { changed: out.changed || null },
    });
  }
  return {
    ok: true, url: item.url, trade_date: parsed.trade_date, record_id: out.id,
    created: !!out.created, revised: !!out.revised, unchanged: !!out.unchanged,
    check_status: out.check_status, checks: out.checks, changed: out.changed || null,
    snapshot_id: fetched.snapshotId, gaps_closed: closedGaps,
    // 解析详情（去掉完整正文，避免接口/日志体积失控；正文已在 source_snapshot 中留存）
    parsed: {
      parse_status: parsed.parse_status, parse_note: parsed.parse_note, period: parsed.period,
      trade_date: parsed.trade_date, date_source: parsed.date_source,
      date_candidates: parsed.date_candidates, date_consistent: parsed.date_consistent,
      data_as_of: parsed.data_as_of,
      fields: parsed.fields, raw_fields: parsed.raw_fields, units: parsed.units,
      missing_fields: parsed.missing_fields, explicit_none: parsed.explicit_none,
      unexpected_units: parsed.unexpected_units, invalid_fields: parsed.invalid_fields,
      stats: parsed.stats,
    },
  };
}

/* ==================================================================== */
/*  四、候选 URL 发现（禁止编造 URL）                                    */
/* ==================================================================== */

/**
 * 从官方目录页发现日报链接。目录可能动态加载 → 找不到就返回空，
 * 由搜索发现补位或如实登记缺口，**不猜测/拼接页面 URL**。
 */
export function discoverDailyLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let href = m[1];
    const text = htmlToText(m[2]);
    if (!href || href.startsWith('#') || /^(javascript|mailto):/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    // 只接受官方域名下的 .shtml/.html 详情页，且日期可在 URL 中识别
    if (!/^https:\/\/overview\.cneeex\.com\//i.test(abs)) continue;
    if (!/\.s?html?$/i.test(abs)) continue;
    const dm = abs.match(/\/(20\d{2}-\d{2}-\d{2})\//);
    if (!dm) continue;
    if (!/行情|日报|成交|每日|概况/.test(text) && !/\/c\/20\d{2}-\d{2}-\d{2}\//.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, dateHint: dm[1], title: text.slice(0, 120), sourceCode: 'cea_daily_2026' });
  }
  return out.slice(0, 200);
}

/** 用已配置搜索服务在官方域名内发现候选日报（搜索只发现 URL，随后必须实际读取原文） */
export async function searchDailyCandidates({ query = null, limit = 5, actor = 'system:cea-collect', deadlineAt = null } = {}) {
  const cfg = ceaCollectConfig();
  const provider = cfg.search_provider_id ? pickSearchProvider(cfg.search_provider_id) : pickSearchProvider();
  if (!provider) return { ok: false, reason: 'not_configured', message: '未配置搜索服务：无法用搜索发现候选 URL', candidates: [] };
  const q = query || `CEA 全国碳排放配额 每日行情 ${todayCst().slice(0, 7)} site:overview.cneeex.com`;
  const out = await runSearch(provider, q, { count: Math.min(limit, 10), deadlineAt });
  if (!out.ok) return { ok: false, reason: out.reason, message: out.message, provider_id: provider.id, candidates: [] };
  const candidates = (out.results || [])
    .map((r) => ({ url: String(r.url || r.link || ''), title: r.title || '', dateHint: null, sourceCode: 'cea_daily_2026' }))
    .filter((r) => /^https:\/\/overview\.cneeex\.com\//i.test(r.url))
    .map((r) => {
      const dm = r.url.match(/\/(20\d{2}-\d{2}-\d{2})\//);
      return { ...r, dateHint: dm ? dm[1] : null };
    })
    .slice(0, limit);
  return {
    ok: true, provider_id: provider.id, provider_name: provider.name, query: q,
    raw_count: out.results.length, candidates,
    note: '搜索只用于发现候选 URL；是否入库必须以实际读取到的官方原文解析结果为准，搜索摘要不作为证据。',
  };
}

/* ==================================================================== */
/*  五、有界批次                                                        */
/* ==================================================================== */

/**
 * 有界 CEA 日报采集。遵守：
 *   - 每轮 ≤ max_items_per_round（默认 8）
 *   - 总时间 ≤ batch_budget_ms（默认 120 秒，超限立即收尾并记录「留待下一批」）
 *   - 当日抓取配额 daily_fetch_limit
 *   - 任务重入复用
 *
 * 生命周期：发现/采集/后处理发生未预期异常时，只关闭**本次新建且实际执行**的任务，
 * 先如实写入 failed、异常与已有结果，再把原异常交给调用者；复用的运行中任务绝不关闭。
 */
export async function collectCeaDaily(opts = {}) {
  const state = {
    job: null, result: null, finalized: false, started: null, found: null, discoveryNote: null,
  };
  try {
    return await collectCeaDailyBody(opts || {}, state);
  } catch (e) {
    const message = ceaExceptionMessage(e);
    if (state.job && !state.job.reused && !state.finalized) {
      const result = state.result && typeof state.result === 'object'
        ? state.result
        : { job_id: state.job.id, work_items: [], collected: [], skipped: [], failed: [], gaps: [], truncated: false };
      if (!Array.isArray(result.failed)) result.failed = [];
      result.failed.push({ reason: 'exception', message, stage: 'exception' });
      result.status = 'failed';
      const collected = Array.isArray(result.collected) ? result.collected : [];
      result.elapsed_ms = state.started ? Date.now() - state.started : result.elapsed_ms || 0;
      const priorFailures = result.failed
        .filter((f) => !(f && f.reason === 'exception' && f.message === message))
        .slice(0, 4)
        .map((f) => `${f.url || f.sourceCode || f.date || '?'}：${f.reason || ''} ${f.message || ''}`.trim())
        .join('；');
      try {
        addCeaStep(state.job.id, {
          stage: 'publish', status: 'failed', items: collected.length,
          message: `任务异常中止：${message}`.slice(0, 900),
        });
      } catch { /* 审计步骤失败不能掩盖原始异常；close 仍必须执行 */ }
      closeCeaJob(state.job.id, {
        status: 'failed',
        found: Number.isFinite(state.found) ? state.found : 0,
        parsed: collected.length,
        validated: collected.filter((c) => c && c.check_status && c.check_status !== 'fail').length,
        published: collected.length,
        errors: result.failed.length,
        errorSummary: `采集任务异常：${message}${priorFailures ? `；${priorFailures}` : ''}`.slice(0, 900),
        detail: {
          ...result,
          exception: message,
          phase: 'exception',
          discovery: state.discoveryNote || null,
          found: Number.isFinite(state.found) ? state.found : null,
        },
      });
    }
    throw e;
  }
}

/** 日报采集主体：由 collectCeaDaily 负责生命周期收尾，本函数不自行处理未预期异常。 */
async function collectCeaDailyBody({
  actor = 'system:cea-collect', trigger = 'manual', dates = null, sources = null,
  onlyNew = true, limit = null, cfg = ceaCollectConfig(), deadlineAt = null,
} = {}, state) {
  const guard = preflight(cfg, '采集 CEA 日报');
  if (guard) return guard;

  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const maxItems = Math.min(Number(limit) || cfg.max_items_per_round || 8, 8);
  const started = Date.now();
  state.started = started;
  // 共享总 deadline（runCeaDailyStep 传入）：整批共用一个预算，而不是每个子步骤各给 120 秒
  const deadline = deadlineAt || started + budget;
  const left = () => deadline - Date.now();
  if (deadlineAt && left() <= 0) {
    return {
      skipped: true, reason: 'batch_budget_exceeded',
      message: '批次总时间上限已到，日报 HTML 通道留待下一批（不阻塞 CCER 每日任务）',
      budget_ms: budget, deadline_shared: true, elapsed_ms: 0,
    };
  }
  const job = openCeaJob({ jobKey: JOB_KEY_DAILY, title: 'CEA 日行情采集', trigger, actor });
  state.job = job;
  const quota = ceaQuotaState(cfg);

  const result = {
    job_id: job.id, job_reused: !!job.reused, trigger,
    budget_ms: budget, max_items: maxItems, deadline_shared: !!deadlineAt,
    quota_before: quota,
    work_items: [], collected: [], skipped: [], failed: [], gaps: [],
    evidence_rounds: 0, elapsed_ms: 0, truncated: false,
  };
  state.result = result;
  if (job.reused) {
    // 重入：合并到运行中的任务，绝不关闭它（旧实现会把仍在运行的任务提前标成 partial）
    return { ...result, ...ceaReentryResult(job, 'CEA 日报采集任务') };
  }

  let items = [];
  let discoveryNote = '';
  if (Array.isArray(sources) && sources.length) {
    for (const code of sources.slice(0, maxItems)) {
      const s = getCeaSourceByCode(code);
      if (!s) { result.failed.push({ sourceCode: code, reason: 'unknown_source' }); continue; }
      items.push({ url: s.url, sourceCode: s.code, dateHint: null });
    }
    discoveryNote = `按显式来源采集 ${items.length} 条`;
  } else if (Array.isArray(dates) && dates.length) {
    // 指定日期：只能使用官方目录/搜索发现的真实 URL，不允许拼接页面地址
    const discovered = await discoverForDates(dates.slice(0, maxItems), { actor, cfg, deadlineAt: deadline });
    items = discovered.items;
    discoveryNote = discovered.note;
    // 失败清单是可选附加信息：只做数组防御，不吞掉发现过程本身的真实异常
    result.failed.push(...(Array.isArray(discovered.failed) ? discovered.failed : []));
  } else {
    const discovered = await discoverLatest({ maxItems, actor, cfg, deadlineAt: deadline });
    items = discovered.items;
    discoveryNote = discovered.note;
    result.failed.push(...(Array.isArray(discovered.failed) ? discovered.failed : []));
  }

  if (onlyNew) {
    const before = items.length;
    items = items.filter((it) => {
      const snap = get(
        'SELECT content_hash FROM source_snapshot WHERE url=? AND content_hash IS NOT NULL ORDER BY fetched_at DESC LIMIT 1',
        [it.url]
      );
      if (!snap) return true;
      const row = get('SELECT content_hash FROM cea_trade_daily WHERE source_url=? ORDER BY trade_date DESC LIMIT 1', [it.url]);
      if (row && row.content_hash === snap.content_hash) {
        result.skipped.push({ url: it.url, reason: 'already_collected_same_hash' });
        // 该 URL 已成功采集且哈希未变 → 之前登记的抓取/解析缺口应视为已消除
        const closed = closeCeaGapsByPrefixes(
          [`cea:trade:fetch:${it.url}`, `cea:trade:parse:${it.url}`, `cea:trade:nodate:${it.url}`],
          { note: '该页面此前已成功解析入库且内容哈希未变（本次 onlyNew 跳过重复抓取）', actor }
        );
        if (closed) result.gaps_closed = (result.gaps_closed || 0) + closed;
        return false;
      }
      return true;
    });
    discoveryNote += `；onlyNew 过滤掉 ${before - items.length} 条已采集且哈希未变的页面`;
  }

  state.found = items.length;
  state.discoveryNote = discoveryNote;
  addCeaStep(job.id, { stage: 'collect', status: items.length ? 'ok' : 'failed', items: items.length, message: `候选 ${items.length} 条：${discoveryNote}` });

  let parsed = 0;
  let validated = 0;
  let published = 0;
  let errors = 0;

  for (const it of items) {
    if (left() <= 0) {
      result.truncated = true;
      result.gaps.push({ reason: 'batch_budget_exceeded', note: `已达批次总时间上限（剩余 ${Math.max(0, left())}ms），剩余 ${items.length - result.collected.length} 条留待下一批（不阻塞 CCER 每日任务）` });
      break;
    }
    const q = ceaQuotaState(cfg);
    if (q.remaining <= 0) {
      result.truncated = true;
      result.gaps.push({ reason: 'daily_fetch_limit_reached', note: `当日抓取已达上限 ${q.limit} 次，剩余条目留待次日` });
      break;
    }
    let out;
    try {
      out = await collectOneCeaDaily(it, { actor, jobId: job.id, cfg, deadlineAt: deadline });
    } catch (e) {
      out = { ok: false, reason: 'exception', message: e.message, url: it.url };
    }
    if (out.ok) {
      result.collected.push(out);
      parsed += 1;
      published += 1;
      if (out.check_status && out.check_status !== 'fail') validated += 1;
      if (out.check_status === 'fail') errors += 1;
    } else {
      result.failed.push({ url: it.url, reason: out.reason, message: out.message });
      errors += 1;
    }
  }

  // 补证轮：只对「解析失败/缺口」的条目再做有界重试，最多 max_evidence_rounds 轮
  const cfgRounds = Math.min(Number(cfg.max_evidence_rounds) || 0, 2);
  for (let round = 1; round <= cfgRounds; round += 1) {
    if (left() <= 0) { result.truncated = true; break; }
    const retryable = result.failed.filter((f) => ['fetch_failed', 'http_5', 'exception', 'blocked_url'].includes(f.reason) || /^http_5/.test(String(f.reason)));
    if (!retryable.length) break;
    result.evidence_rounds = round;
    for (const f of retryable.slice(0, maxItems)) {
      if (left() <= 0) { result.truncated = true; break; }
      try {
        const out = await collectOneCeaDaily({ url: f.url, sourceCode: null }, { actor, jobId: job.id, cfg, deadlineAt: deadline });
        if (out.ok) { result.collected.push(out); parsed += 1; published += 1; }
      } catch { /* 补证失败已由缺口记录 */ }
    }
  }

  // AI 证据一致性核验（未配置模型时保持 unavailable，不伪造 verified）
  // 与整批共享同一 deadline：超出预算的条目 deferred 留待下一批，不把每日任务拖死
  let verifySummary = null;
  if (cfg.auto_verify) {
    verifySummary = await verifyCollectedCea(result.collected.map((c) => c.record_id), { actor, cfg, deadlineAt: deadlineAt || null });
  }

  result.elapsed_ms = Date.now() - started;
  result.quota_after = ceaQuotaState(cfg);
  const vcfg = verifyConfig();
  const provider = pickVerifyProvider(vcfg);
  result.ai_verification = {
    requested: !!cfg.auto_verify,
    provider_configured: !!provider,
    provider_note: provider ? null : '未配置可用模型：CEA 条目保持 unverified，不伪造 verified（符合 CEA-08/CEA-09）',
    summary: verifySummary,
  };
  const dataAsOf = result.collected.length
    ? result.collected.map((c) => c.trade_date).sort().slice(-1)[0]
    : get('SELECT MAX(trade_date) AS d FROM cea_trade_daily')?.d || null;

  const status = errors === 0 ? 'success' : published > 0 ? 'partial' : 'failed';
  addCeaStep(job.id, {
    stage: 'publish', status: errors === 0 ? 'ok' : 'failed', items: published,
    message: `入库 ${published} 条，失败 ${errors} 条${result.truncated ? '（受批次上限截断）' : ''}`,
  });
  closeCeaJob(job.id, {
    status, found: items.length, parsed, validated, published, errors,
    errorSummary: errors ? result.failed.slice(0, 5).map((f) => `${f.url || f.sourceCode || '?'}：${f.reason || ''} ${f.message || ''}`).join('；').slice(0, 900) : null,
    dataAsOf, detail: { discovery: discoveryNote, gaps: result.gaps, truncated: result.truncated, elapsed_ms: result.elapsed_ms },
  });
  run(
    `INSERT INTO dataset_cursor (dataset,last_attempt_at,last_status,last_success_at,last_error,items_seen,items_new)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_status=excluded.last_status,
       last_success_at=excluded.last_success_at, last_error=excluded.last_error,
       items_seen=excluded.items_seen, items_new=excluded.items_new`,
    ['cea_trade', nowIso(), status, published ? nowIso() : null,
      errors ? `${errors} 条失败` : null, items.length, published]
  );
  audit({ actor, action: 'cea.collect_daily', objectType: 'ingestion_job', objectId: job.id, detail: { published, errors, truncated: result.truncated, elapsed_ms: result.elapsed_ms } });
  state.finalized = true;
  return { ...result, status };
}

function preflight(cfg, action) {
  if (!cfg.enabled) return { error: `${action}未启用`, message: 'CEA 采集在后台配置中处于停用状态。', status: 409 };
  return null;
}

/** 无日期参数时：先读官方目录页，再退到搜索发现 */
async function discoverLatest({ maxItems, actor, cfg, deadlineAt = null }) {
  const listSource = getCeaSourceByCode('cea_daily_2026');
  const failed = [];
  if (listSource) {
    const fetched = await fetchAndSnapshot(listSource.url, {
      allowedDomains: listSource.allowed_domains, sourceId: listSource.id, timeoutMs: cfg.request_timeout_ms, actor, deadlineAt,
      parserNote: 'CEA 官方日行情目录页',
    });
    if (fetched.ok) {
      const links = discoverDailyLinks(fetched.body, fetched.url);
      if (links.length) {
        return { items: links.slice(0, maxItems), note: `官方目录页发现 ${links.length} 条日报链接`, failed };
      }
      markCeaSourceRun(listSource.code, { ok: false, error: '目录页未解析出日报链接（可能为动态加载）', itemsFailed: 0 });
      failed.push({ url: listSource.url, reason: 'list_dynamic', message: '官方目录页未解析出日报链接（可能动态加载）' });
    } else {
      markCeaSourceRun(listSource.code, { ok: false, error: fetched.message || fetched.reason, itemsFailed: 0 });
      failed.push({ url: listSource.url, reason: fetched.reason, message: fetched.message });
    }
  }
  const searched = await searchDailyCandidates({ limit: maxItems, actor, deadlineAt });
  if (searched.ok && searched.candidates.length) {
    return { items: searched.candidates, note: `目录页不可用，改用搜索在官方域名内发现 ${searched.candidates.length} 条候选（随后实际读取原文）`, failed, search: searched };
  }
  return {
    items: [],
    note: searched.ok ? '目录页与搜索均未发现候选日报 URL' : `目录页不可用且搜索不可用（${searched.reason}：${searched.message}）`,
    failed: [...failed, { reason: 'search_unavailable', message: searched.message }],
    search: searched,
  };
}

/** 指定日期：只能用官方目录/搜索实际发现的 URL */
async function discoverForDates(dates, { actor, cfg, deadlineAt = null }) {
  const failed = [];
  const listSource = getCeaSourceByCode('cea_daily_2026');
  const found = new Map();
  if (listSource) {
    const fetched = await fetchAndSnapshot(listSource.url, {
      allowedDomains: listSource.allowed_domains, sourceId: listSource.id, timeoutMs: cfg.request_timeout_ms, actor, deadlineAt,
      parserNote: 'CEA 官方日行情目录页（按日期检索）',
    });
    if (fetched.ok) {
      for (const l of discoverDailyLinks(fetched.body, fetched.url)) {
        if (dates.includes(l.dateHint)) found.set(l.dateHint, l);
      }
    } else {
      failed.push({ url: listSource.url, reason: fetched.reason, message: fetched.message });
    }
  }
  const missing = dates.filter((d) => !found.has(d));
  if (missing.length) {
    for (const d of missing) {
      const searched = await searchDailyCandidates({ query: `全国碳排放配额 每日行情 ${d} site:overview.cneeex.com`, limit: 3, actor, deadlineAt });
      if (searched.ok) {
        const hit = (searched.candidates || []).find((c) => c.dateHint === d) || null;
        if (hit) { found.set(d, hit); continue; }
      }
      failed.push({ date: d, reason: 'no_official_url_found', message: '官方目录与搜索均未找到该交易日的官方页面；按规范不拼接/不猜测 URL' });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.trade,
        title: `CEA ${d} 未找到官方行情页面`,
        description: '官方目录页与搜索均未发现该交易日的官方日报 URL。规范禁止编造页面 URL，因此该日留缺口。',
        impact: `序列中不生成 ${d} 的 0 值点。`,
        severity: 'warning',
        gapKey: `cea:trade:nourl:${d}`,
      });
    }
  }
  return { items: [...found.values()], note: `按 ${dates.length} 个指定交易日解析到 ${found.size} 条官方 URL`, failed };
}

/* ==================================================================== */
/*  六、政策 / 名录 / 意向 采集                                          */
/* ==================================================================== */

/**
 * 采集一条 CEA 政策/技术/研报来源的正文与原件。
 *
 * PDF 处理（规范要求「须自动提取可读 PDF，扫描件才交管理员补充」）：
 *   - 把 PDF 落盘到 data/cea-attachments/ 并保存 sha256；
 *   - 用 pdftotext 自动提取文本；提取成功 → evidence_level=full_text，正文入库；
 *   - 提取为空 → 判定为扫描件，保持 metadata_only 并登记缺口交管理员，**不伪造正文**；
 *   - pdftotext 不可用 → 如实记为 unavailable 并说明。
 */
export async function collectCeaDocumentByCode(code, { actor = 'system:cea-collect', jobId = null, cfg = ceaCollectConfig(), docKey = null, deadlineAt = null } = {}) {
  const source = getCeaSourceByCode(code);
  if (!source) return { ok: false, reason: 'unknown_source', message: `未登记的来源代码：${code}` };
  if (deadlineAt && deadlineAt - Date.now() <= 500) {
    return { ok: false, reason: 'batch_budget_exceeded', message: '批次总时间上限已到：该文件未发出请求（留待下一批）', source: code, deadline_exceeded: true };
  }
  const fetched = await fetchAndSnapshot(source.url, {
    allowedDomains: source.allowed_domains, sourceId: source.id, timeoutMs: cfg.request_timeout_ms, actor, deadlineAt,
    parserNote: `CEA 政策/文件正文来源：${source.code}`,
  });
  if (jobId) {
    addCeaStep(jobId, {
      stage: 'collect', target: source.url, status: fetched.ok ? 'ok' : 'failed', items: fetched.ok ? 1 : 0,
      message: fetched.ok ? `HTTP ${fetched.status}，${fetched.bytes} 字节` : `${fetched.reason}：${fetched.message || ''}`,
      snapshotId: fetched.snapshotId,
    });
  }
  if (!fetched.ok) {
    markCeaSourceRun(code, { ok: false, error: `${fetched.reason}: ${fetched.message || ''}` });
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.document,
      title: `CEA 官方原文获取失败：${source.name}`,
      description: `${source.url} 真实抓取失败（${fetched.reason}：${fetched.message || ''}）。该条目保持 metadata_only，不声称已读原文。`,
      impact: 'AI 证据一致性核验将判为证据不足；官方元数据照常展示。',
      severity: source.dataset === 'allocation' ? 'critical' : 'warning',
      manualPath: '管理员可在后台「文档上传」补充官方原件；上传副本保留来源层级。',
      gapKey: `cea:document:fetch:${code}`,
    });
    return { ok: false, reason: fetched.reason, message: fetched.message, source: code, snapshotId: fetched.snapshotId };
  }
  let text = htmlToText(fetched.body);
  const isPdf = /\.pdf($|\?)/i.test(source.url) || /application\/pdf/i.test(String(fetched.content_type || ''));
  let evidenceLevel = isPdf ? 'metadata_only' : text.length >= 400 ? 'full_text' : text.length ? 'partial' : 'metadata_only';
  let attachmentPath = null;
  let attachmentHash = null;
  let pdfNote = null;

  if (isPdf) {
    // 用原始字节落盘（不能用解码后的字符串，否则 PDF 会被 UTF-8 替换字符损坏）
    const saved = saveCeaAttachment(code, fetched.buf || fetched.body, { actor });
    attachmentPath = saved.path || null;
    attachmentHash = saved.hash || fetched.hash || null;
    if (saved.path) {
      // 落盘内容必须与已记录的快照哈希一致，否则说明保存过程损坏了原件
      if (fetched.hash && saved.hash !== fetched.hash) {
        pdfNote = `⚠ 落盘原件的 sha256（${String(saved.hash).slice(0, 16)}…）与抓取快照哈希（${String(fetched.hash).slice(0, 16)}…）不一致，已丢弃并登记缺口`;
        recordCeaGap({
          dataset: CEA_GAP_DATASETS.attachment,
          title: `CEA 官方 PDF 落盘校验失败：${source.name}`,
          description: `落盘文件哈希与抓取响应哈希不一致（原 ${fetched.bytes} 字节）。`,
          impact: '原件不可作为附件证据；该文件保持 metadata_only。',
          severity: 'warning', gapKey: `cea:document:pdf_hash:${code}`,
        });
      } else {
        // 统一异步逐页解析（docs/36 第 2、5 条）：先取文本层，缺文字/乱码的页再走 OCR。
        // 旧的同步 extractPdfText 保留为兼容工具（其它调用方与既有测试仍可用），
        // 真实采集路径优先走统一服务。
        const parsed = await parsePdfDocument({
          filePath: saved.path,
          sha256: saved.hash || fetched.hash,
          deadlineAt: deadlineAt || null,
          maxPages: Number(cfg.ocr_max_pages_per_doc) || 50,
        });
        if (parsed.text && parsed.chars > 0) {
          // 用不带页码标记的纯正文，保持与旧 pdftotext 输出等价的解析语义
          text = parsed.raw_text || parsed.text;
          // 只有**每一页**都取得可用正文才算 full_text；缺页一律 partial（不用整篇字数阈值掩盖缺页）
          evidenceLevel = parsed.status === 'full' && text.length >= 400 ? 'full_text' : 'partial';
          pdfNote =
            `PDF 逐页解析（${parsed.parser_version}）：共 ${parsed.pages_total} 页，` +
            `文本层 ${parsed.pages_text} 页 + OCR ${parsed.pages_ocr} 页，失败 ${parsed.pages_failed} 页 → ${parsed.status}；` +
            `原件 ${saved.bytes} 字节，sha256 ${String(saved.hash).slice(0, 16)}… 与快照一致。` +
            (parsed.note ? ` ${parsed.note}` : '');
          // 之前登记的「PDF 无法提取/落盘校验失败」缺口本次已消除 → 结清（记录保留）
          closeCeaGapsByPrefixes([`cea:document:pdf_text:${code}`, `cea:document:pdf_hash:${code}`], {
            note: `统一解析服务已取得正文（${parsed.chars} 字，文本层 ${parsed.pages_text} 页 / OCR ${parsed.pages_ocr} 页）并校验哈希一致`,
            actor,
          });
          if (parsed.status === 'partial') {
            recordCeaGap({
              dataset: CEA_GAP_DATASETS.attachment,
              title: `CEA 官方 PDF 仅部分页取得正文：${source.name}`,
              description:
                `${source.url} 已下载并落盘 ${saved.path}（${saved.bytes} 字节）；共 ${parsed.pages_total} 页，` +
                `成功 ${parsed.pages_total - parsed.pages_failed} 页，失败页：${JSON.stringify(parsed.failed_pages).slice(0, 300)}。`,
              impact: '该文件按 partial 记录：只有成功页的正文可引用，缺页不声称已读原文。',
              manualPath: '管理员可在「PDF 解析/OCR」页签用 OCR 补跑缺失页。',
              severity: 'warning',
              gapKey: `cea:document:pdf_text:${code}`,
            });
          }
        } else {
          pdfNote = `PDF 正文未提取成功（${parsed.status}）：${parsed.error || parsed.note || '逐页解析未取得可用正文'}`;
          recordCeaGap({
            dataset: CEA_GAP_DATASETS.attachment,
            title: `CEA 官方 PDF 无法自动提取正文：${source.name}`,
            description: `${source.url} 已下载（${saved.bytes} 字节，sha256 ${String(attachmentHash).slice(0, 16)}…）并落盘 ${saved.path}；${parsed.error || parsed.note || '逐页解析未取得可用正文'}${parsed.aborted ? `（中止原因：${parsed.aborted}）` : ''}`,
            impact: '该文件保持 metadata_only，AI 核验只能判证据不足；不伪造正文。',
            manualPath: '管理员可上传可读副本、OCR 文字，或在「PDF 解析/OCR」页签配置百度 OCR 后补跑。',
            severity: 'warning',
            gapKey: `cea:document:pdf_text:${code}`,
          });
        }
      }
    } else {
      pdfNote = `PDF 落盘失败：${saved.reason}`;
    }
  }

  // 附件链接（官方 PDF 原件）：只登记真实出现在页面里的链接
  let attachmentUrl = isPdf ? source.url : null;
  if (!isPdf) {
    const m = String(fetched.body).match(/href=["']([^"']+\.pdf)["']/i);
    if (m) {
      try { attachmentUrl = new URL(m[1], fetched.url).toString(); } catch { attachmentUrl = null; }
    }
  }

  const existing = docKey ? get('SELECT * FROM cea_document WHERE doc_key=?', [docKey]) : get('SELECT * FROM cea_document WHERE source_code=? ORDER BY created_at LIMIT 1', [code]);
  const derivedNumber = extractDocNumber(text);
  const patch = {
    doc_key: existing?.doc_key || docKey || `cea_src_${code}`,
    doc_type: existing?.doc_type || (source.dataset === 'research' ? 'research' : 'policy'),
    category: existing?.category || (source.dataset === 'research' ? 'research' : source.dataset),
    // 正式标题保持完整：已有标题（含「（官方 PDF 原件）」等后缀）不被缩短
    title: existing?.title || source.name,
    // 文号是从正文派生的元数据：已存值必须通过合法性校验，否则用本次正文重新派生
    // （早期正则会把页面「文 号」标签残留成「号环办气候函…」，这里可自愈）
    doc_number: isValidDocNumber(existing?.doc_number) ? existing.doc_number : (derivedNumber || existing?.doc_number || null),
    issuer: existing?.issuer || source.authority || null,
    publish_date: existing?.publish_date || extractPublishDate(text),
    covered_sectors: existing ? uj(existing.covered_sectors, []) : null,
    applicable_years: existing ? uj(existing.applicable_years, []) : null,
    doc_status: existing?.doc_status || 'formal',
    official_url: source.url,
    source_code: code,
    snapshot_id: fetched.snapshotId,
    content_hash: fetched.hash,
    fetched_at: nowIso(),
    body_snapshot: isPdf ? (evidenceLevel === 'metadata_only' ? null : text.slice(0, 300_000)) : text.slice(0, 300_000),
    attachment_path: attachmentPath,
    attachment_hash: attachmentHash,
    attachment_url: attachmentUrl,
    evidence_level: evidenceLevel,
    provenance_note:
      `正文由真实抓取写入：${source.url}（抓取时间 ${nowIso()}，快照 ${fetched.snapshotId}，` +
      `sha256 ${String(fetched.hash).slice(0, 16)}…）。${pdfNote || ''}`,
  };
  const out = upsertCeaDocument(patch, { actor });
  if (out.error) return { ok: false, reason: 'upsert_failed', message: out.error, source: code };
  markCeaSourceRun(code, { ok: true, itemsOk: 1 });

  // 正式全年休市公告：按**原文写明的范围**写入 CEA 独立日历（official_notice 证据层），
  // 并立即做「正式公告 / 机器辅助列表 / 实际成交」三方核对（异常独立告警，不生成人工复核）。
  let closure = null;
  if (/全年休市安排/.test(text)) {
    const parsedClosure = parseAnnualClosureNotice(text, { url: source.url });
    if (parsedClosure.ok) {
      closure = applyCeaAnnualClosureNotice(parsedClosure, {
        sourceCode: code, evidenceUrl: source.url, snapshotId: fetched.snapshotId, documentId: out.id, actor,
      });
      if (jobId) {
        addCeaStep(jobId, {
          stage: 'publish', target: source.url, status: 'ok', items: parsedClosure.closed_dates.length,
          message: `正式休市公告：写入休市 ${parsedClosure.closed_dates.length} 天（${parsedClosure.ranges
            .map((r) => `${r.from}~${r.to}`).join('、')}）；原文开市日 ${parsedClosure.reopen_dates.length} 天；` +
            `日历核对异常 ${closure?.reconcile?.anomalies ?? 0} 天（机器辅助列表异常独立告警，不生成人工复核任务）`,
          snapshotId: fetched.snapshotId,
        });
      }
      closeCeaGapsByPrefixes([`cea:calendar:notice:${code}`], { note: '正式休市公告已按原文范围解析入库', actor });
    } else {
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.calendar || 'cea_calendar',
        title: `正式休市公告未能解析出休市范围：${source.name}`,
        description: `${source.url} 已抓取（快照 ${fetched.snapshotId}），但解析失败：${parsedClosure.reason}。机器辅助列表继续作为辅助证据，不冒充正式公告。`,
        impact: '日历的正式公告层缺失，日期判断回退到机器辅助列表与实际成交；不生成人工复核任务。',
        severity: 'warning',
        gapKey: `cea:calendar:notice:${code}`,
      });
    }
  }
  return finishDocumentCollection({
    out, source, code, text, evidenceLevel, pdfNote, fetched, jobId, actor,
    isPdf, attachmentPath, closure,
  });
}

/** upsert 之后的公共收尾：事件原文回填、任务步骤、返回结构（含休市公告结果） */
async function finishDocumentCollection({
  out, source, code, text, evidenceLevel, pdfNote, fetched, jobId, actor,
  isPdf = false, attachmentPath = null, closure = null,
}) {
  // 用正文里的原文片段回填关联事件的 quote（真实原文 + 语义锚定核对，而不是标题年份推断）
  const quoteResult = backfillEventQuotes(out.id, text, { actor });
  if (jobId) {
    addCeaStep(jobId, {
      stage: 'publish', target: source.url, status: 'ok', items: 1,
      message: `证据等级=${evidenceLevel}；事件日期原文核对：已核验 ${quoteResult.verified} 条，未能在原文核对 ${quoteResult.unverified} 条${pdfNote ? `；${pdfNote}` : ''}`,
      snapshotId: fetched.snapshotId,
    });
  }
  return {
    ok: true, source: code, document_id: out.id, evidence_level: evidenceLevel, body_chars: text.length,
    pdf_extracted: isPdf ? evidenceLevel !== 'metadata_only' : null,
    attachment_path: attachmentPath,
    events_verified: quoteResult.verified, events_unverified: quoteResult.unverified,
    closure: closure ? { closed_dates: closure.closed_dates, reopened: closure.reopened, reconcile: closure.reconcile } : null,
    snapshot_id: fetched.snapshotId,
  };
}

/**
 * 官方 PDF 原件落盘目录。
 * 统一到既有 `data/official-originals/cea/`（与 CCER 原件同根），
 * 便于云端备份/路径迁移沿用同一策略（阶段B 尾项8）；旧的 `data/cea-attachments/` 仅作历史保留。
 */
export function ceaAttachmentDir() {
  return process.env.CCER_CEA_ATTACHMENT_DIR || join(PROJECT_ROOT, 'data', 'official-originals', 'cea');
}

/** 官方 PDF 原件落盘（data/official-originals/cea/）；返回路径与 sha256 */
export function saveCeaAttachment(code, rawBody, { actor = 'system:cea-collect' } = {}) {
  try {
    const dir = ceaAttachmentDir();
    mkdirSync(dir, { recursive: true });
    const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
    const hash = sha256(buf);
    const file = join(dir, `${code}-${hash.slice(0, 16)}.pdf`);
    if (!existsSync(file)) writeFileSync(file, buf);
    return { path: file, hash, bytes: buf.length, dir };
  } catch (e) {
    return { path: null, hash: null, reason: e.message };
  }
}

/** 文号合法性：不能以「号」开头（页面「文 号」标签残留），也不能含空白 */
export function isValidDocNumber(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  if (s.startsWith('号')) return false;
  if (/\s/.test(s)) return false;
  return /〔\s*\d{4}\s*〕\s*\d+\s*号$/.test(s);
}

/** 从正文里提取文号（如 国环规气候〔2026〕1号 / 沪环境交〔2025〕47号） */
export function extractDocNumber(text) {
  const m = String(text || '').match(/([\u4e00-\u9fa5]{2,12})〔\s*(\d{4})\s*〕\s*(\d+)\s*号/);
  if (!m) return null;
  // 前缀可能被前一句的「号」「、」等字符污染（实测出现「号环办气候函…」），去掉后校验
  const prefix = m[1].replace(/^[号函文发批公告通知：:、，,。\s]+/, '');
  if (prefix.length < 2) return null;
  return `${prefix}〔${m[2]}〕${m[3]}号`;
}

/**
 * 事件日期在原文中的定位（**必须语义锚定**）。
 *
 * 背景（真实踩坑）：年度工作通知里 `2026年12月31日` 同时出现在多个义务上
 * （2027 年度数据质量控制方案、配额清缴等）。只按「日期出现在正文」就把事件标成
 * `verified` 是**假核验**——规范明确要求「日期由原文核对」「不能只按标题年份识别履约年度」。
 *
 * 因此定位规则是：句子必须同时包含
 *   ① 目标日期，且 ② 与该事件类型 + 对应年度匹配的锚点词。
 * 找不到锚定句子时**不标 verified**，如实保留 unverified 并记录缺口。
 *
 * @returns {{ok:boolean, quote:string|null, reason:string}}
 */
export function locateEventQuote(text, ev) {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  if (!plain) return { ok: false, quote: null, reason: '原文正文为空' };
  if (!ev?.deadline) return { ok: false, quote: null, reason: '事件没有执行日期，无法在原文定位' };

  const [y, m, d] = String(ev.deadline).split('-');
  const mo = Number(m);
  const da = Number(d);
  const dateForms = [
    `${y}年${mo}月${da}日`,
    `${y}年0${mo}月0${da}日`,
    `${y}-${m}-${d}`,
    `${y}/${mo}/${da}`,
    `${mo}月${da}日`,
  ];

  const yearTerms = [];
  if (ev.emission_year) yearTerms.push(`${ev.emission_year}年度`, `${ev.emission_year}年`);
  if (ev.quota_year) yearTerms.push(`${ev.quota_year}年度`, `${ev.quota_year}年`);
  if (ev.list_year) yearTerms.push(`${ev.list_year}年度`, `${ev.list_year}年`);

  // 事件类型 → 必须出现的业务锚点词
  const TYPE_ANCHORS = {
    surrender_deadline: /清缴|履约|抵消|抵销/,
    list_published: /名录/,
    data_report_deadline: /数据质量控制方案|排放报告|核查报告|质控计划/,
    preallocation: /预分配|预先分配/,
    adjustment: /调整/,
    allocation_plan_issued: /分配方案|配额总量|分配/,
    carryover_deadline: /结转/,
  };
  const anchor = TYPE_ANCHORS[ev.event_type] || null;
  if (!anchor) {
    // 未定义锚点的事件类型：只接受标题关键词共同出现，否则不判核验
    const titleTerms = String(ev.title || '')
      .split(/[\s，,。、（）()【】]+/)
      .filter((t) => t.length >= 3);
    if (!titleTerms.length) return { ok: false, quote: null, reason: `事件类型 ${ev.event_type} 缺少可用的语义锚点` };
    return matchSentence(plain, dateForms, null, titleTerms, `标题关键词（${titleTerms.join('/')}）`);
  }
  return matchSentence(plain, dateForms, anchor, yearTerms, `业务锚点 ${anchor.source} + 年度词`);
}

function matchSentence(plain, dateForms, anchorRe, yearTerms, anchorLabel) {
  // 按句切分，逐句判断：日期与锚点必须出现在**同一句**内
  const sentences = plain.split(/(?<=[。；;!？?])/).map((s) => s.trim()).filter(Boolean);
  const hits = [];
  for (const s of sentences) {
    const dateForm = dateForms.find((f) => s.includes(f));
    if (!dateForm) continue;
    if (anchorRe && !anchorRe.test(s)) continue;
    if (!anchorRe && yearTerms.length && !yearTerms.some((t) => s.includes(t))) continue;
    hits.push({ sentence: s, dateForm });
  }
  if (!hits.length) {
    return {
      ok: false, quote: null,
      reason: `原文中未找到同时包含目标日期与 ${anchorLabel} 的句子：该日期无法用原文核对，保留 unverified（不用「日期出现过」冒充已核对）`,
    };
  }
  // 取最短的锚定句，并把引文窗口收敛到日期附近（去掉句首的导航噪声，便于人工核对）
  hits.sort((a, b) => a.sentence.length - b.sentence.length);
  const s = hits[0].sentence;
  const at = s.indexOf(hits[0].dateForm);
  const from = Math.max(0, at - 120);
  const to = Math.min(s.length, at + hits[0].dateForm.length + 240);
  const quote = `${from > 0 ? '…' : ''}${s.slice(from, to)}${to < s.length ? '…' : ''}`;
  return { ok: true, quote: quote.slice(0, 600), reason: `已在原文定位锚定句（匹配 ${anchorLabel}）`, candidates: hits.length };
}

/**
 * 用官方正文回填关联事件的原文片段。
 * **只对能通过语义锚定的事件标 verified**；其余保持/回落 unverified 并记缺口。
 * 每次都重新评估该文档的全部事件（包括已有 quote 的），以便纠正此前的错误标注。
 */
export function backfillEventQuotes(documentId, text, { actor = 'system:cea-collect' } = {}) {
  const doc = get('SELECT * FROM cea_document WHERE id=?', [documentId]);
  if (!doc) return { verified: 0, unverified: 0 };
  const events = all('SELECT * FROM cea_event WHERE source_document_id=?', [documentId]);
  let verified = 0;
  let unverified = 0;
  for (const ev of events) {
    const located = locateEventQuote(text, ev);
    if (located.ok) {
      run(
        `UPDATE cea_event SET source_quote=?, date_extract_status='quoted', date_verify_status='verified',
           verify_note=?, updated_at=? WHERE id=?`,
        [located.quote, `已在官方原文中定位到同日期的锚定句（${located.reason}；文档 ${documentId}，真实抓取正文）。`, nowIso(), ev.id]
      );
      verified += 1;
    } else {
      // 找不到锚定句：清掉可能存在的旧 quote，回落 unverified，并登记真实缺口
      run(
        `UPDATE cea_event SET source_quote=NULL, date_extract_status='extracted', date_verify_status='unverified',
           verify_note=?, updated_at=? WHERE id=?`,
        [`${located.reason}（文档 ${documentId}）。该日期目前只有来源清单登记，未获原文核对。`, nowIso(), ev.id]
      );
      unverified += 1;
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.document,
        title: `CEA 履约日历日期未能在原文核对：${ev.title}`,
        description: `事件 ${ev.event_key}（执行日期 ${ev.deadline}）在已抓取的官方正文中未找到同时包含日期与业务锚点的句子。${located.reason}`,
        impact: '该日期保持 unverified，不得作为确定的合规义务日期使用；后续批次会继续补证。',
        manualPath: '可补充抓取对应的年度管理工作通知或配额分配方案原文后再核对。',
        severity: 'warning',
        gapKey: `cea:event:unverified:${ev.event_key}`,
      });
    }
  }
  if (verified || unverified) {
    audit({
      actor, action: 'cea.event_quote_backfill', objectType: 'cea_document', objectId: documentId,
      detail: { verified, unverified, method: 'semantic_anchor' },
    });
  }
  return { verified, unverified };
}

function extractPublishDate(text) {
  const s = String(text || '');
  let m = s.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) m = s.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  const mm = String(m[2]).padStart(2, '0');
  const dd = String(m[3]).padStart(2, '0');
  const out = `${m[1]}-${mm}-${dd}`;
  return out >= '2005-01-01' && out <= '2100-01-01' ? out : null;
}

/** 采集已登记的 CEA 政策/技术/研报来源（有界） */
export async function collectCeaDocuments({ actor = 'system:cea-collect', codes = null, trigger = 'manual', cfg = ceaCollectConfig(), deadlineAt = null } = {}) {
  const guard = preflight(cfg, '采集 CEA 文件');
  if (guard) return guard;
  const list = (codes && codes.length)
    ? codes.map((c) => getCeaSourceByCode(c)).filter(Boolean)
    : all(
      `SELECT code FROM cea_source WHERE enabled=1 AND dataset IN ('allocation','calendar','regime','research')
         AND COALESCE(kind,'') <> 'official_json' ORDER BY priority`
    ).map((r) => getCeaSourceByCode(r.code));
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const started = Date.now();
  // 共享总 deadline（runCeaDailyStep 传入）：文件通道不再单独重置 120 秒预算
  const deadline = deadlineAt || started + budget;
  const left = () => deadline - Date.now();
  if (deadlineAt && left() <= 0) {
    return { skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，文件通道留待下一批', deadline_shared: true, elapsed_ms: 0 };
  }
  const job = openCeaJob({ jobKey: JOB_KEY_DOC, title: 'CEA 政策与官方文件采集', trigger, actor });
  if (job.reused) {
    return ceaReentryResult(job, 'CEA 文件采集任务');
  }
  const out = { job_id: job.id, ok: [], failed: [], truncated: false, deadline_shared: !!deadlineAt, verified: null };
  try {
    for (const s of list.slice(0, 8)) {
      if (left() <= 0) { out.truncated = true; out.gap_note = `已达批次总时间上限，剩余文件留待下一批（剩余 ${Math.max(0, left())}ms）`; break; }
      const q = ceaQuotaState(cfg);
      if (q.remaining <= 0) { out.truncated = true; out.quota_exhausted = true; break; }
      try {
        const r = await collectCeaDocumentByCode(s.code, { actor, jobId: job.id, cfg, docKey: matchingDocKey(s.code), deadlineAt: deadline });
        if (r.ok) out.ok.push(r); else out.failed.push(r);
      } catch (e) {
        out.failed.push({ source: s.code, reason: 'exception', message: e.message });
      }
    }
    // docs/35 尾项9：**采集后默认模型核验**必须真的触发。
    // 只把「本批实际取得全文/部分全文」的文件按共享 deadline 送入既有核验链路；
    // 未配置模型时保持 unverified（不伪造通过），预算不足的条目 deferred 留待每日有界补跑。
    const ids = out.ok
      .filter((r) => r.evidence_level === 'full_text' || r.evidence_level === 'partial')
      .map((r) => r.document_id)
      .filter(Boolean);
    if (cfg.auto_verify && ids.length) {
      if (left() > 3000) {
        out.verified = await verifyCeaDocuments({ actor, ids, limit: ids.length, deadlineAt: deadline });
        addCeaStep(job.id, {
          stage: 'verify', target: 'cea_document', status: out.verified.attempts ? 'ok' : 'skipped',
          items: out.verified.attempts,
          message:
            `自动核验（模型 ${out.verified.provider_id || '未配置'}）：尝试 ${out.verified.attempts} 条｜` +
            `verified ${out.verified.verified}／insufficient ${out.verified.insufficient}／unavailable ${out.verified.unavailable}／` +
            `conflict ${out.verified.conflict}／cached ${out.verified.cached}／deferred ${out.verified.deferred}`,
        });
      } else {
        out.verified = { deferred: ids.length, attempts: 0, note: '批次总时间上限已到：本批文件的模型核验留待每日有界补跑' };
        out.verify_deferred = true;
      }
    } else if (cfg.auto_verify && !ids.length) {
      out.verified = { attempts: 0, note: '本批没有取得全文的文件，无对象可核验（元数据条目不算已核验）' };
    } else if (!cfg.auto_verify) {
      out.verified = { attempts: 0, note: '后台配置 auto_verify=false：本次不自动核验，条目保持 unverified' };
    }
  } catch (e) {
    out.failed.push({ source: null, reason: 'exception', message: `文件采集异常：${e.message}` });
  } finally {
    out.elapsed_ms = Date.now() - started;
    closeCeaJob(job.id, {
      status: out.failed.length === 0 ? 'success' : out.ok.length ? 'partial' : 'failed',
      found: list.length, parsed: out.ok.length, validated: out.ok.length, published: out.ok.length,
      errors: out.failed.length,
      errorSummary: out.failed.length ? out.failed.slice(0, 5).map((f) => `${f.source}：${f.message || f.reason}`).join('；').slice(0, 900) : null,
      detail: { truncated: out.truncated, verified: out.verified ? { attempts: out.verified.attempts, deferred: out.verified.deferred || 0, verified: out.verified.verified || 0 } : null },
    });
    run(
      `INSERT INTO dataset_cursor (dataset,last_attempt_at,last_status,last_success_at,last_error,items_seen,items_new)
       VALUES ('cea_document',?,?,?,?,?,?)
       ON CONFLICT(dataset) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_status=excluded.last_status,
         last_success_at=excluded.last_success_at, last_error=excluded.last_error,
         items_seen=excluded.items_seen, items_new=excluded.items_new`,
      [nowIso(), out.failed.length ? (out.ok.length ? 'partial' : 'failed') : 'ok', out.ok.length ? nowIso() : null,
        out.failed.length ? `${out.failed.length} 条失败` : null, list.length, out.ok.length]
    );
    audit({ actor, action: 'cea.collect_documents', objectType: 'ingestion_job', objectId: job.id, detail: { ok: out.ok.length, failed: out.failed.length, verified_attempts: out.verified?.attempts || 0 } });
  }
  return out;
}

function matchingDocKey(sourceCode) {
  const m = {
    cea_allocation: 'cea_allocation_2026_1',
    cea_allocation_pdf: 'cea_allocation_pdf_2026_1',
    cea_annual_work: 'cea_annual_work_2026',
    cea_carryover: 'cea_carryover_2026',
    cea_price_regime: 'cea_price_regime_2026',
    cea_research_iigf: 'cea_research_iigf_2025',
  };
  return m[sourceCode] || null;
}

/**
 * 从**来源登记信息**（管理员登记的官方来源名称/说明）提取省份与年度。
 * 这是可核对的登记事实，不是猜测；提取不到就留 NULL。
 */
export function sourceEntityMeta(source = {}) {
  const blob = `${source.name || ''} ${source.note || ''} ${source.authority || ''}`;
  const year = Number((blob.match(/(20\d{2})\s*年/) || [])[1] || 0) || null;
  const prov = (blob.match(/(北京|天津|河北|山西|内蒙古|辽宁|吉林|黑龙江|上海|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|重庆|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆)(?:省|市|自治区)?/) || [])[1] || null;
  // 单一行业文件可由来源登记补充 sector；名称/说明同时出现多个行业时保持 null，
  // 交给表标题或表内分节判断，不按第一个行业词猜测。
  const sectors = [...new Set((blob.match(/发电|钢铁|水泥|铝冶炼/g) || []))];
  const explicitSector = /^(发电|钢铁|水泥|铝冶炼)$/.test(String(source.sector || '')) ? source.sector : null;
  const sector = explicitSector || (sectors.length === 1 ? sectors[0] : null);
  return { list_year: year, province: prov, sector, source: year || prov || sector ? '来源登记信息' : null };
}

/**
 * 默认名录来源轮换（docs/64 第 1 条）：
 *   - 未尝试来源优先（last_attempt_at 为空）；
 *   - 已尝试来源按 last_attempt_at 最旧优先；
 *   - 再按 priority 升序、code 字典序稳定排序。
 * 显式 codes 不走此函数：调用方按指定顺序处理，不擅自轮换。
 */
export function selectCeaEntitySourceBatch(sources = [], { limit = 4 } = {}) {
  const max = Math.max(1, Number(limit) || 4);
  const sorted = [...sources].sort((a, b) => {
    const aAt = a?.last_attempt_at ? (Date.parse(a.last_attempt_at) || 0) : null;
    const bAt = b?.last_attempt_at ? (Date.parse(b.last_attempt_at) || 0) : null;
    if (aAt === null && bAt !== null) return -1;
    if (aAt !== null && bAt === null) return 1;
    if (aAt !== null && bAt !== null && aAt !== bAt) return aAt - bAt;
    const aPri = Number.isFinite(Number(a?.priority)) ? Number(a.priority) : 100;
    const bPri = Number.isFinite(Number(b?.priority)) ? Number(b.priority) : 100;
    if (aPri !== bPri) return aPri - bPri;
    return String(a?.code || '').localeCompare(String(b?.code || ''));
  });
  return { selected: sorted.slice(0, max), deferred: sorted.slice(max) };
}

/** 响应是否为 PDF（内容类型或文件头）——名录 PDF 不能被当 HTML 解析 */
export function isPdfResponse(fetched = {}) {
  const ct = String(fetched.content_type || '').toLowerCase();
  if (ct.includes('application/pdf')) return true;
  const buf = fetched.buf;
  return !!(buf && Buffer.isBuffer(buf) && buf.subarray(0, 5).toString('latin1') === '%PDF-');
}

const MAX_ENTITY_DOCX_BYTES = 12 * 1024 * 1024;
const MAX_ENTITY_DOCX_XML_BYTES = 8 * 1024 * 1024;
const MAX_ENTITY_DOCX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTITY_DOCX_OUTPUT_CHARS = 2_000_000;
const MAX_ENTITY_PDF_WRAPPER_BYTES = 24 * 1024 * 1024;
const MAX_ENTITY_PDF_PAYLOAD_BYTES = 20 * 1024 * 1024;

/** 来源登记 kind / URL / content-type 明确指向 DOCX 时才按 DOCX 处理。 */
export function isDocxSource(source = {}, fetched = {}) {
  const kind = String(source.kind || '').toLowerCase();
  const url = String(source.url || fetched.final_url || '');
  const ct = String(fetched.content_type || '').toLowerCase();
  return kind === 'official_docx' || /\.docx(?:$|[?#])/i.test(url)
    || ct.includes('wordprocessingml.document');
}

function isPdfSource(source = {}) {
  return String(source.kind || '').toLowerCase() === 'official_pdf' || /\.pdf(?:$|[?#])/i.test(String(source.url || ''));
}

function pythonDocxCandidates() {
  if (process.env.CCER_PYTHON) return [process.env.CCER_PYTHON];
  return process.platform === 'win32' ? ['python'] : ['python3', 'python'];
}

// 只依赖 Python 标准库；不读宏、不执行附件代码，也不解压 word/document.xml 之外的部件。
const DOCX_EXTRACT_SCRIPT = String.raw`
import io, sys, zipfile, html, xml.etree.ElementTree as ET
in_path, out_path, err_path = sys.argv[1:4]
max_input, max_xml, max_total, max_out = map(int, sys.argv[4:8])
def fail(msg):
    with open(err_path, 'w', encoding='utf-8') as f:
        f.write(msg)
    raise SystemExit(2)
with open(in_path, 'rb') as f:
    raw = f.read(max_input + 1)
if len(raw) > max_input:
    fail('docx exceeds input size limit')
try:
    z = zipfile.ZipFile(io.BytesIO(raw))
except Exception as e:
    fail('invalid zip: ' + str(e))
infos = z.infolist()
if not infos or len(infos) > 10000:
    fail('invalid zip entry count')
names = {i.filename for i in infos}
if '[Content_Types].xml' not in names or 'word/document.xml' not in names:
    fail('missing docx part')
if any(n.startswith('/') or '..' in n.replace('\\', '/').split('/') for n in names):
    fail('unsafe zip member path')
if any(n.lower().endswith('vbaproject.bin') for n in names):
    fail('macro-bearing document rejected')
if any(i.flag_bits & 1 for i in infos):
    fail('encrypted zip entry rejected')
if sum(i.file_size for i in infos) > max_total:
    fail('docx uncompressed total exceeds limit')
doc = next(i for i in infos if i.filename == 'word/document.xml')
if doc.file_size > max_xml:
    fail('document.xml exceeds limit')
try:
    with z.open(doc) as f:
        xml_bytes = f.read(max_xml + 1)
except Exception as e:
    fail('cannot read document.xml: ' + str(e))
if len(xml_bytes) > max_xml:
    fail('document.xml exceeds limit after decompression')
# 拒绝 DTD/实体声明，避免实体膨胀；Word 正常文档不需要它们。
if b'<!DOCTYPE' in xml_bytes or b'<!ENTITY' in xml_bytes:
    fail('DTD/entity declarations rejected')
try:
    root = ET.fromstring(xml_bytes)
except Exception as e:
    fail('invalid document.xml: ' + str(e))
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def text_of(node):
    parts = []
    for n in node.iter():
        if n.tag == W + 't':
            parts.append(n.text or '')
        elif n.tag in (W + 'tab',):
            parts.append('\t')
        elif n.tag in (W + 'br', W + 'cr'):
            parts.append('\n')
    return ''.join(parts)
def blocks(node):
    for child in list(node):
        if child.tag == W + 'p':
            yield child
        elif child.tag == W + 'tbl':
            yield child
        elif child.tag in (W + 'sdt', W + 'sdtContent'):
            yield from blocks(child)
out = []
size = 0
def emit(piece):
    global size
    if size > max_out:
        fail('docx html output exceeds limit')
    out.append(piece)
    size += len(piece)
body = root.find(W + 'body')
if body is None:
    fail('missing document body')
for block in blocks(body):
    if block.tag == W + 'p':
        emit('<p>' + html.escape(text_of(block)) + '</p>')
    else:
        rows = []
        for tr in block.findall(W + 'tr'):
            cells = []
            for tc in tr.findall(W + 'tc'):
                cells.append('<td>' + html.escape(text_of(tc)) + '</td>')
            rows.append('<tr>' + ''.join(cells) + '</tr>')
        emit('<table>' + ''.join(rows) + '</table>')
if size > max_out:
    fail('docx html output exceeds limit')
with open(out_path, 'w', encoding='utf-8') as f:
    f.write('<!doctype html><html><head><meta charset="utf-8"></head><body>' + ''.join(out) + '</body></html>')
`;

/**
 * 有界 DOCX → 转义 HTML。只读 word/document.xml；失败时返回原因而不是把二进制当 HTML。
 * @returns {{ok:boolean, html?:string, reason?:string, message?:string, bytes?:number, xml_bytes?:number}}
 */
export function extractDocxEntityHtml(buf, {
  deadlineAt = null,
  maxBytes = MAX_ENTITY_DOCX_BYTES,
  maxXmlBytes = MAX_ENTITY_DOCX_XML_BYTES,
  maxTotalBytes = MAX_ENTITY_DOCX_TOTAL_BYTES,
  maxOutputChars = MAX_ENTITY_DOCX_OUTPUT_CHARS,
  timeoutMs = 15000,
} = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: 'empty_docx', message: 'DOCX 响应为空' };
  if (buf.length > maxBytes) return { ok: false, reason: 'docx_too_large', message: `DOCX 原件超过 ${maxBytes} 字节上限` };
  const hasDeadline = deadlineAt !== null && deadlineAt !== undefined && Number.isFinite(Number(deadlineAt));
  const remaining = hasDeadline ? Number(deadlineAt) - Date.now() : null;
  if (remaining !== null && remaining <= 1000) {
    return { ok: false, reason: 'deadline_exceeded', message: '批次总时间上限已到：DOCX 未开始解包（留待下一批）' };
  }
  const limitMs = remaining === null ? timeoutMs : Math.max(1000, Math.min(timeoutMs, remaining - 100));
  let lastError = null;
  // 受限环境禁止 Node 用管道捕获子进程输出（EPERM），且大 XML 也不适合走 maxBuffer。
  // 因此输入/HTML/错误都走临时文件，子进程 stdio 全忽略；结束即删除临时目录。
  const dir = mkdtempSync(join(tmpdir(), 'cea-docx-'));
  const inputPath = join(dir, 'input.docx');
  const outputPath = join(dir, 'output.html');
  const errorPath = join(dir, 'error.txt');
  try {
    writeFileSync(inputPath, buf);
    for (const cmd of pythonDocxCandidates()) {
      const r = spawnSync(cmd, [
        '-c', DOCX_EXTRACT_SCRIPT, inputPath, outputPath, errorPath,
        String(maxBytes), String(maxXmlBytes), String(maxTotalBytes), String(maxOutputChars),
      ], {
        timeout: limitMs,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      if (r.error?.code === 'ENOENT') { lastError = `未找到 Python 解释器（${cmd}）`; continue; }
      if (r.error) {
        if (r.error.code === 'ETIMEDOUT' || r.signal) {
          return { ok: false, reason: 'docx_timeout', message: `DOCX 解包超过 ${limitMs}ms 时限` };
        }
        return { ok: false, reason: 'python_failed', message: r.error.message };
      }
      if (r.status !== 0) {
        let msg = '';
        try { msg = String(readFileSync(errorPath, 'utf8') || '').trim().slice(0, 500); } catch { /* ignore */ }
        return { ok: false, reason: 'invalid_docx', message: msg || `Python 解包退出码 ${r.status}` };
      }
      let html = '';
      try { html = String(readFileSync(outputPath, 'utf8') || ''); } catch { /* ignore */ }
      if (!html) return { ok: false, reason: 'empty_docx_html', message: 'DOCX 未产出可解析 HTML' };
      return { ok: true, html, bytes: buf.length, xml_bytes: null };
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { ok: false, reason: 'python_unavailable', message: lastError || '未找到可用的 Python 解释器' };
}

function multipartBoundary(buf, contentType) {
  const ct = String(contentType || '');
  const fromHeader = ct.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  let boundary = fromHeader ? (fromHeader[1] || fromHeader[2]) : null;
  if (!boundary) {
    const firstEnd = buf.indexOf('\r\n');
    if (firstEnd > 2) {
      const first = buf.subarray(0, firstEnd).toString('latin1');
      if (first.startsWith('--')) boundary = first.slice(2);
    }
  }
  if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) return null;
  return boundary;
}

/**
 * 解码「单个完整 PDF 附件」的 multipart/form-data 外壳。
 * 只接受恰好一个、边界完整、以 %PDF- 开头并以 %%EOF 结束的 PDF 部件；
 * 异常/多附件/超限一律失败。原始 HTTP 字节与解码载荷的哈希分别返回，不混用。
 */
export function unwrapCeaMultipartPdf(fetched = {}, {
  maxBytes = MAX_ENTITY_PDF_WRAPPER_BYTES, maxPayloadBytes = MAX_ENTITY_PDF_PAYLOAD_BYTES,
} = {}) {
  const buf = fetched.buf;
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: 'empty_wrapper', message: '响应为空' };
  if (buf.length > maxBytes) return { ok: false, reason: 'wrapper_too_large', message: `multipart 外壳超过 ${maxBytes} 字节上限` };
  const ct = String(fetched.content_type || '');
  const boundary = multipartBoundary(buf, ct);
  if (!boundary) return { ok: false, reason: 'multipart_boundary_missing', message: '响应没有可确认的 multipart 边界' };
  const marker = Buffer.from(`--${boundary}`, 'latin1');
  if (buf.indexOf(marker) !== 0) {
    return { ok: false, reason: 'multipart_boundary_missing', message: 'multipart 边界不在响应开头，拒绝猜测' };
  }
  let pos = marker.length;
  if (buf.subarray(pos, pos + 2).toString('latin1') !== '\r\n') {
    return { ok: false, reason: 'multipart_incomplete', message: 'multipart 起始边界后缺少 CRLF' };
  }
  pos += 2;
  const parts = [];
  while (true) {
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0 || headEnd - pos > 8192) {
      return { ok: false, reason: 'multipart_bad_headers', message: 'multipart 部件头缺失或过长' };
    }
    const headersText = buf.subarray(pos, headEnd).toString('latin1');
    const next = buf.indexOf(Buffer.from(`\r\n--${boundary}`, 'latin1'), headEnd + 4);
    if (next < 0) return { ok: false, reason: 'multipart_incomplete', message: 'multipart 部件未闭合（可能是截断响应）' };
    // 独立提取的真实样本保留了边界前的 CRLF；为与证据文件/载荷哈希一致，
    // 这里也把该 CRLF 计入 PDF 载荷（PDF 解析会忽略尾随空白）。
    const payload = buf.subarray(headEnd + 4, next + 2);
    parts.push({ headersText, payload });
    if (parts.length > 1) {
      return { ok: false, reason: 'multipart_multiple_parts', message: 'multipart 包含多个附件，拒绝自动挑选' };
    }
    pos = next + 2 + marker.length;
    const after = buf.subarray(pos, pos + 2).toString('latin1');
    if (after === '--') {
      pos += 2;
      const rest = buf.subarray(pos).toString('latin1').replace(/[\r\n]/g, '');
      if (rest) return { ok: false, reason: 'multipart_trailing_data', message: 'multipart 结束边界后仍有多余数据' };
      break;
    }
    if (after === '\r\n') { pos += 2; continue; }
    return { ok: false, reason: 'multipart_incomplete', message: 'multipart 边界格式异常' };
  }
  if (parts.length !== 1) return { ok: false, reason: 'multipart_multiple_parts', message: 'multipart 必须恰好包含一个附件' };
  const part = parts[0];
  const transferEncoding = (part.headersText.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) || [])[1]?.trim().toLowerCase();
  if (transferEncoding && !['binary', '8bit', '7bit'].includes(transferEncoding)) {
    return { ok: false, reason: 'multipart_encoding_unsupported', message: '附件传输编码不是 binary/8bit，拒绝猜测解码' };
  }
  const filename = (part.headersText.match(/filename="?([^";\r\n]+)"?/i) || [])[1] || null;
  const partType = (part.headersText.match(/content-type:\s*([^;\r\n]+)/i) || [])[1] || '';
  if (!/%PDF-/i.test(part.payload.subarray(0, 8).toString('latin1'))) {
    return { ok: false, reason: 'multipart_not_pdf', message: '唯一附件不是 PDF（缺少 %PDF- 文件头）' };
  }
  if (!filename || !/\.pdf$/i.test(filename)) {
    if (!/application\/pdf/i.test(partType)) return { ok: false, reason: 'multipart_not_pdf', message: '唯一附件没有 .pdf 文件名或 PDF 类型' };
  }
  if (part.payload.length > maxPayloadBytes) {
    return { ok: false, reason: 'pdf_payload_too_large', message: `PDF 载荷超过 ${maxPayloadBytes} 字节上限` };
  }
  if (!part.payload.subarray(Math.max(0, part.payload.length - 2048)).toString('latin1').trimEnd().endsWith('%%EOF')) {
    return { ok: false, reason: 'pdf_incomplete', message: 'PDF 载荷缺少 %%EOF 结束标记' };
  }
  const payload = Buffer.from(part.payload);
  return {
    ok: true, kind: 'pdf', buf: payload, transport: 'multipart',
    hash: sha256(payload), raw_hash: fetched.hash || null, filename,
    payload_bytes: payload.length, content_type: partType || null,
  };
}

/**
 * 采集重点排放单位公开名录。获取失败**如实登记缺口**，不伪造名录行。
 * 不要求一次抓齐所有省份；返回真实覆盖数。
 *
 * 【docs/36 第 8 条修正】
 *   · PDF 名录必须**按 PDF 识别后用统一解析服务**取文本，绝不把二进制当 HTML 解析；
 *   · 名称/年度/省份必须有原文或来源登记依据，不用当前年份或请求参数顶替；
 *   · 抓取成功但解析出 0 行时**保留 parse gap**，任务状态不得为 success。
 */
export async function collectCeaEntities({ actor = 'system:cea-collect', codes = null, listYear = null, province = null, trigger = 'manual', cfg = ceaCollectConfig(), deadlineAt = null } = {}) {
  const guard = preflight(cfg, '采集 CEA 名录');
  if (guard) return guard;
  const explicit = Array.isArray(codes) && codes.length > 0;
  const unknownCodes = explicit
    ? codes.filter((c) => !getCeaSourceByCode(c))
    : [];
  const list = explicit
    ? codes.map((c) => getCeaSourceByCode(c)).filter(Boolean)
    : all("SELECT code FROM cea_source WHERE enabled=1 AND dataset='entity' ORDER BY priority, code").map((r) => getCeaSourceByCode(r.code));
  if (!list.length) {
    return {
      ok: false, reason: 'no_entity_source', message: '未登记可用的省级名录来源', entities: 0,
      unknown_codes: unknownCodes, sources_total: 0, sources_attempted: 0, sources_not_attempted: 0,
    };
  }
  // 每批最多 4 个来源；默认轮换，显式 codes 严格按给定顺序（不轮换）。
  const batch = explicit
    ? { selected: list.slice(0, 4), deferred: list.slice(4) }
    : selectCeaEntitySourceBatch(list, { limit: 4 });
  const selected = batch.selected;
  const selection = explicit ? 'explicit' : 'rotation';
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const started = Date.now();
  // 共享 deadline：名录通道同样不单独重置批次预算
  const deadline = deadlineAt || started + budget;
  const job = openCeaJob({ jobKey: 'cea_entities', title: 'CEA 重点排放单位名录采集', trigger, actor });
  if (job.reused) {
    return ceaReentryResult(job, 'CEA 名录采集任务');
  }
  const attemptedCodes = new Set();
  const out = {
    job_id: job.id, sources: [], entities_created: 0, entities_updated: 0, failed: [],
    parse_gaps: [], truncated: batch.deferred.length > 0, pdf_sources: 0, rows_parsed: 0,
    unchanged: 0,
    selection, batch_limit: 4,
    sources_total: list.length,
    sources_selected: selected.length,
    sources_attempted: 0,
    sources_not_attempted: list.length,
    unknown_codes: unknownCodes,
  };
  for (const s of selected) {
    if (Date.now() > deadline) {
      out.truncated = true;
      out.deadline_exceeded = true;
      out.unattempted_sources = selected.filter((x) => !attemptedCodes.has(x.code)).map((x) => x.code);
      break;
    }
    attemptedCodes.add(s.code);
    out.sources_attempted = attemptedCodes.size;
    const fetched = await fetchAndSnapshot(s.url, {
      allowedDomains: s.allowed_domains, sourceId: s.id, timeoutMs: cfg.request_timeout_ms, actor, deadlineAt: deadline,
      parserNote: `CEA 名录来源：${s.code}`,
    });
    if (!fetched.ok) {
      markCeaSourceRun(s.code, { ok: false, error: `${fetched.reason}: ${fetched.message || ''}`, itemsFailed: 1 });
      const gap = recordCeaGap({
        dataset: CEA_GAP_DATASETS.entity,
        title: `CEA 名录原件获取失败：${s.name}`,
        description: `${s.url} 真实抓取失败（${fetched.reason}：${fetched.message || ''}）。按规范登记真实缺口，不用种子/模拟名录行顶替。`,
        impact: '该省名录覆盖数为 0；名录数量不等于买家数量，缺口在覆盖统计中体现。',
        severity: 'warning',
        manualPath: '可通过搜索发现该省官方 HTML 名录，或由管理员上传官方原件。',
        gapKey: `cea:entity:fetch:${s.code}`,
      });
      out.failed.push({ source: s.code, reason: fetched.reason, message: fetched.message, gap_id: gap.id });
      addCeaStep(job.id, { stage: 'collect', target: s.url, status: 'failed', message: `${fetched.reason}：${fetched.message || ''}`, snapshotId: fetched.snapshotId });
      continue;
    }

    // 省份/年度：优先取**原文**，其次取来源登记信息；都没有就留 NULL（不猜测）
    const meta = sourceEntityMeta(s);
    const wantsDocx = isDocxSource(s, fetched);
    const wantsPdf = isPdfSource(s);
    const rawPdf = !wantsDocx && isPdfResponse(fetched);
    // 山西等站点把 PDF 包在 multipart/form-data 外壳里：先解码出唯一完整 PDF 载荷，
    // 原始 HTTP 哈希仍用于快照/缓存 identity，载荷哈希只随解析详情保存。
    const pdfEnvelope = !wantsDocx && !rawPdf && wantsPdf ? unwrapCeaMultipartPdf(fetched) : null;
    const envelopeError = pdfEnvelope && !pdfEnvelope.ok ? pdfEnvelope : null;
    const pdf = rawPdf || !!pdfEnvelope?.ok;
    const pdfPayload = rawPdf
      ? { buf: fetched.buf, hash: fetched.hash || sha256(fetched.buf || Buffer.alloc(0)), transport: 'raw', filename: null }
      : (pdfEnvelope?.ok ? pdfEnvelope : null);
    const accepted = uj(metaValue(`cea_entity_parse_result:${s.code}`, null), null);
    // 上次解析失败留下的 open gap 表示「该来源尚未完成」；即使旧缓存 hash 相同，
    // 也要重新解析并尝试结清缺口，不能靠旧缓存宣称本轮已恢复。
    const openParseGap = get(
      "SELECT id FROM data_gap WHERE dataset='cea_entity' AND status='open' AND gap_key=?",
      [`cea:entity:parse:${s.code}`]
    );
    if (accepted?.complete && accepted.hash === fetched.hash && !openParseGap) {
      // 缓存命中按本来源的**成员关系去重企业**计数，不能看 cea_entity 最后一次 source_code：
      // 同一主体同时出现在多个来源时，主体行的 source_code/source_hash 会被后一个来源覆盖。
      const savedCount = get(
        `SELECT COUNT(DISTINCT m.entity_id) AS n
           FROM cea_entity_membership m
           JOIN cea_entity e ON e.id = m.entity_id
          WHERE m.source_code=? AND m.source_hash=?`,
        [s.code, fetched.hash]
      )?.n || 0;
      const expectedEntities = Number(accepted.entities) || Number(accepted.rows) || 0;
      if (savedCount === expectedEntities && savedCount > 0) {
        out.rows_parsed += savedCount;
        out.unchanged = (out.unchanged || 0) + savedCount;
        out.sources.push({ source: s.code, rows: savedCount, created: 0, updated: 0, unchanged: true, parser: accepted.parser });
        markCeaSourceRun(s.code, { ok: true, itemsOk: savedCount });
        closeCeaGapsByPrefixes([`cea:entity:fetch:${s.code}`, `cea:entity:parse:${s.code}`], {
          note: `官方原件 hash 未变，复用 ${savedCount} 行已完成结构化结果`, actor,
        });
        addCeaStep(job.id, { stage: 'parse', target: s.url, status: 'ok', items: savedCount, message: '官方文件哈希未变，复用已完成的结构化结果；不以较弱解析覆盖既有字段', snapshotId: fetched.snapshotId });
        continue;
      }
    }
    let parseSource = fetched.body;
    let parseKind = 'html';
    let parseDetail = null;
    if (wantsDocx) {
      // DOCX 是 ZIP 容器，绝不能按 UTF-8 字符串走 HTML 解析。只在内存中解包
      // word/document.xml；失败如实留 parse gap，不输出半份名录。
      const docx = extractDocxEntityHtml(fetched.buf, { deadlineAt: deadline });
      if (!docx.ok) {
        const gap = recordCeaGap({
          dataset: CEA_GAP_DATASETS.entity,
          title: `CEA 名录 DOCX 无法安全解包：${s.name}`,
          description:
            `${s.url} 已真实抓取（快照 ${fetched.snapshotId}，${fetched.bytes} 字节，sha256 ${String(fetched.hash).slice(0, 16)}…），` +
            `但 DOCX 解包失败（${docx.reason}：${docx.message || ''}）。` +
            '仅读取 word/document.xml，不执行宏/附件代码；本来源未写入任何名录行。',
          impact: '该省名录覆盖数为 0；parse gap 如实保留，不把二进制或半份表格当名录。',
          severity: 'warning',
          manualPath: '可核对官方 DOCX 是否损坏/改版，或由管理员上传可读副本。',
          gapKey: `cea:entity:parse:${s.code}`,
        });
        out.parse_gaps.push({
          source: s.code, reason: docx.reason, message: docx.message || null,
          gap_id: gap.id, kind: 'docx',
        });
        addCeaStep(job.id, {
          stage: 'parse', target: s.url, status: 'failed', items: 0,
          message: `DOCX 解包失败（${docx.reason}），保留 parse gap，未写入任何行`,
          snapshotId: fetched.snapshotId,
        });
        markCeaSourceRun(s.code, { ok: false, error: `docx:${docx.reason}`, itemsFailed: 1 });
        continue;
      }
      parseKind = 'docx';
      parseSource = docx.html;
      parseDetail = {
        transport: 'docx', bytes: docx.bytes, original_http_sha256: fetched.hash,
        parser_version: 'docx-zip-xml-v1',
      };
    } else if (envelopeError) {
      // 来源明确是 PDF，但响应既不是裸 PDF，也不是边界完整的单个 PDF 附件。
      const gap = recordCeaGap({
        dataset: CEA_GAP_DATASETS.entity,
        title: `CEA 名录 PDF 外壳无法安全解码：${s.name}`,
        description:
          `${s.url} 已真实抓取（快照 ${fetched.snapshotId}，${fetched.bytes} 字节，原始 HTTP sha256 ${String(fetched.hash).slice(0, 16)}…），` +
          `但响应不是可确认的单个完整 PDF 附件（${envelopeError.reason}：${envelopeError.message || ''}）。` +
          '异常、多附件或超限一律拒绝，不猜选其中一个。',
        impact: '该省名录覆盖数为 0；原始响应哈希保留，解析载荷未写入。',
        severity: 'warning',
        manualPath: '可核对官方返回的 multipart 结构，或由管理员上传单独的官方 PDF。',
        gapKey: `cea:entity:parse:${s.code}`,
      });
      out.parse_gaps.push({
        source: s.code, reason: envelopeError.reason, message: envelopeError.message || null,
        gap_id: gap.id, kind: 'pdf_wrapper',
      });
      addCeaStep(job.id, {
        stage: 'parse', target: s.url, status: 'failed', items: 0,
        message: `PDF 外壳解码失败（${envelopeError.reason}），保留 parse gap，未写入任何行`,
        snapshotId: fetched.snapshotId,
      });
      markCeaSourceRun(s.code, { ok: false, error: `pdf_wrapper:${envelopeError.reason}`, itemsFailed: 1 });
      continue;
    } else if (pdf) {
      out.pdf_sources += 1;
      parseKind = 'pdf';
      // 二进制绝不进 HTML 解析：先落盘 PDF 载荷（multipart 外壳只保存原始快照），再逐页解析。
      let saved = null;
      try {
        saved = saveCeaAttachment(s.code, pdfPayload.buf, { actor });
      } catch (e) {
        saved = { error: e.message };
      }
      if (!saved?.path) {
        const gap = recordCeaGap({
          dataset: CEA_GAP_DATASETS.entity,
          title: `CEA 名录 PDF 落盘失败：${s.name}`,
          description: `${s.url} 已抓取（${fetched.bytes} 字节）但落盘失败：${saved?.error || saved?.reason || '未知原因'}。`,
          impact: '该省名录覆盖数为 0，缺口如实保留。',
          severity: 'warning', gapKey: `cea:entity:parse:${s.code}`,
        });
        out.parse_gaps.push({ source: s.code, reason: 'pdf_save_failed', message: saved?.error || saved?.reason || null, gap_id: gap.id });
        addCeaStep(job.id, { stage: 'parse', target: s.url, status: 'failed', message: 'PDF 落盘失败，未解析（不把二进制当 HTML）', snapshotId: fetched.snapshotId });
        markCeaSourceRun(s.code, { ok: false, error: 'pdf_save_failed', itemsFailed: 1 });
        continue;
      }
      const parsed = await parsePdfDocument({
        filePath: saved.path, sha256: pdfPayload.hash,
        deadlineAt: deadline, maxPages: Number(cfg.ocr_max_pages_per_doc) || 50,
      });
      parseDetail = {
        parser_version: parsed.parser_version, status: parsed.status,
        pages_total: parsed.pages_total, pages_text: parsed.pages_text,
        pages_ocr: parsed.pages_ocr, pages_failed: parsed.pages_failed,
        failed_pages: parsed.failed_pages || [], aborted: parsed.aborted || null,
        local_path: saved.path, hash: saved.hash || pdfPayload.hash,
        transport: pdfPayload.transport, original_http_sha256: fetched.hash,
        payload_sha256: pdfPayload.hash, payload_bytes: pdfPayload.payload_bytes || saved.bytes || null,
      };
      if (!parsed.raw_text && !parsed.text) {
        const gap = recordCeaGap({
          dataset: CEA_GAP_DATASETS.entity,
          title: `CEA 名录 PDF 未取得可用文本：${s.name}`,
          description:
            `${s.url} 已按 PDF 识别并落盘 ${saved.path}（${saved.bytes} 字节，sha256 ${String(saved.hash).slice(0, 16)}…），` +
            `但逐页解析未取得正文（${parsed.error || parsed.note || '无可用页'}）${parsed.aborted ? `；中止原因 ${parsed.aborted}` : ''}。` +
            '名录需要结构化表格才可入企业，本轮**未写入任何名录行**。',
          impact: '该省名录覆盖数为 0；parse gap 如实保留，不凭猜测填主体。',
          severity: 'warning',
          manualPath: '可在「PDF 解析/OCR」页签配置 OCR 后按对象补跑该 PDF。',
          gapKey: `cea:entity:parse:${s.code}`,
        });
        out.parse_gaps.push({
          source: s.code, reason: parsed.aborted || 'no_text', message: parsed.error || parsed.note || null,
          gap_id: gap.id, kind: 'pdf', parse_detail: parseDetail,
        });
        addCeaStep(job.id, {
          stage: 'parse', target: s.url, status: 'failed', items: 0,
          message: `PDF 已按 PDF 识别（${parsed.pages_total} 页）但未取得正文，保留 parse gap，未写入任何行`,
          snapshotId: fetched.snapshotId,
        });
        markCeaSourceRun(s.code, { ok: true, itemsOk: 0 });
        out.sources.push({ source: s.code, kind: 'pdf', rows: 0, created: 0, updated: 0, no_credit_code: 0, parse_gap: true });
        continue;
      }
      parseSource = parsed.raw_text || parsed.text;
    }

    const rows = parseEntityRows(parseSource, {
      listYear: meta.list_year || listYear,
      province: meta.province || null,
      // 文件单一行业（如四川水泥/铝冶炼）允许来源登记 sector 补充；
      // 多行业来源保持 null，由表标题/分节决定。
      sector: meta.sector || null,
    });
    let created = 0;
    let updated = 0;
    let skippedNoYear = 0;
    for (const r of rows) {
      // 名称必须在原文出现（parseEntityRows 已保证）；年度必须来自原文或来源登记
      if (!Number.isInteger(Number(r.list_year))) { skippedNoYear += 1; continue; }
      const listYear = Number(r.list_year);
      const patch = {
        ...r,
        list_year: listYear,
        province: r.province || null,
        source_code: s.code, source_url: s.url, snapshot_id: fetched.snapshotId,
        source_hash: fetched.hash, data_as_of: todayCst(),
      };
      // 同一原件 hash 未变时复用缓存；若缓存因行数不一致而重解析，
      // 也不允许弱解析抹掉既有完整字段（代码/地区/行业/更完整名称）。
      let existing = get('SELECT * FROM cea_entity WHERE entity_key=? AND list_year=?', [r.credit_code || `name:${r.name}`, listYear]);
      if (!existing && !r.credit_code) {
        existing = get('SELECT * FROM cea_entity WHERE name=? AND list_year=? AND source_code=?', [r.name, listYear, s.code]);
      }
      if (existing) {
        if (!patch.credit_code && existing.credit_code) patch.credit_code = existing.credit_code;
        if (!patch.city && existing.city) patch.city = existing.city;
        // 有来源的采集不把主体聚合行业当作本行行业回填：成员关系按行行业拆分保存，
        // 主体聚合行业由 upsertCeaEntity 按全部成员关系合并。
        if (!patch.province && existing.province) patch.province = existing.province;
        if (existing.source_hash && patch.source_hash === existing.source_hash
          && existing.name && patch.name && patch.name.length < existing.name.length) {
          patch.name = existing.name;
        }
      }
      const res = upsertCeaEntity(patch, { actor });
      if (res.created) created += 1; else if (res.updated) updated += 1;
    }
    if (rows.length > 0) {
      // 既有 cache 契约：完整解析结果按 source code + 原件 hash 复用；
      // 记录真实行数，不以 0 行或弱解析覆盖已完成结构。
      setMeta(getDb(), `cea_entity_parse_result:${s.code}`, j({
        hash: fetched.hash,
        rows: rows.length,
        // 同一主体跨行业/跨表出现时 rows 会合并；缓存命中必须按去重企业数核对。
        entities: rows.length,
        complete: true,
        parser: `entity-directory-v2:${parseKind}`,
        source_snapshot_id: fetched.snapshotId,
        source_url: s.url,
        at: nowIso(),
      }));
      // 原件已实际取得并解析出主体：结清对应的抓取/解析缺口（记录保留）。
      closeCeaGapsByPrefixes([`cea:entity:fetch:${s.code}`, `cea:entity:parse:${s.code}`], {
        note: `已从 ${s.url} 解析并写入 ${rows.length} 行`, actor,
      });
    }
    out.entities_created += created;
    out.entities_updated += updated;
    out.rows_parsed += rows.length;
    out.sources.push({
      source: s.code, kind: parseKind, rows: rows.length, created, updated,
      no_credit_code: rows.filter((r) => !r.credit_code).length,
      skipped_no_year: skippedNoYear,
      year_source: rows[0]?.year_source || null, province_source: rows[0]?.province_source || null,
      province: rows[0]?.province || null, list_year: rows[0]?.list_year || null,
      parse_detail: parseDetail,
      parse_gap: rows.length === 0,
    });
    if (!rows.length) {
      // 抓取成功但解析出 0 行 → **保留 parse gap**，任务不得判 success
      const gap = recordCeaGap({
        dataset: CEA_GAP_DATASETS.entity,
        title: `CEA 名录原件已获取但未解析出主体行：${s.name}`,
        description:
          `已真实抓取（快照 ${fetched.snapshotId}，${fetched.bytes} 字节，按 ${parseKind === 'pdf' ? 'PDF 解析' : parseKind === 'docx' ? 'DOCX 解包解析' : 'HTML 解析'}），` +
          `但未识别出可核对的企业行（未披露统一社会信用代码、表格结构变化，或未出现名录年度/行业信息）。` +
          '未写入任何推测行，parse gap 如实保留。',
        impact: '该省覆盖数为 0；不凭猜测填主体。',
        severity: 'warning',
        manualPath: '可在「PDF 解析/OCR」页签按对象补跑，或核对官方名录表格结构是否改版。',
        gapKey: `cea:entity:parse:${s.code}`,
      });
      out.parse_gaps.push({ source: s.code, reason: 'rows_zero', message: '解析出 0 行', gap_id: gap.id, kind: parseKind, parse_detail: parseDetail });
    }
    markCeaSourceRun(s.code, { ok: rows.length > 0, itemsOk: rows.length, itemsFailed: rows.length ? 0 : 1 });
    addCeaStep(job.id, {
      stage: 'parse', target: s.url, status: rows.length ? 'ok' : 'failed', items: rows.length,
      message: `${parseKind === 'pdf' ? 'PDF 解析' : parseKind === 'docx' ? 'DOCX 解包解析' : 'HTML 解析'}：解析出 ${rows.length} 行（新建 ${created}，更新 ${updated}${skippedNoYear ? `，${skippedNoYear} 行缺年度未入库` : ''}）` +
        (rows.length ? '' : '；保留 parse gap，未写入任何行'),
      snapshotId: fetched.snapshotId,
    });
  }
  out.elapsed_ms = Date.now() - started;
  out.sources_attempted = attemptedCodes.size;
  out.deferred_sources = list.filter((s) => !attemptedCodes.has(s.code)).map((s) => s.code);
  out.sources_not_attempted = out.deferred_sources.length;
  out.truncated = out.truncated || out.sources_not_attempted > 0;
  // 【关键修正】任务状态只看**真实入库行数**：抓取成功但 0 行只能是 partial/failed，绝不 success
  const written = out.entities_created + out.entities_updated;
  const unchanged = out.unchanged || 0;
  // 缓存命中（hash 未变、复用已完成结构）也是真实完成，不因 published=0 误判 failed。
  const settled = written + unchanged;
  const jobStatus = settled > 0
    ? (out.parse_gaps.length || out.failed.length || out.truncated ? 'partial' : 'success')
    : 'failed';
  out.status = jobStatus;
  out.note = written > 0
    ? `写入 ${written} 个主体${unchanged ? `；另有 ${unchanged} 行因原件 hash 未变复用已完成结构` : ''}${out.parse_gaps.length ? `；${out.parse_gaps.length} 个来源保留 parse gap（0 行）` : ''}${out.failed.length ? `；${out.failed.length} 个来源抓取失败` : ''}`
    : unchanged > 0
      ? `原件 hash 未变，复用 ${unchanged} 行已完成结构化结果（未重复写入）${out.parse_gaps.length ? `；${out.parse_gaps.length} 个来源保留 parse gap` : ''}${out.failed.length ? `；${out.failed.length} 个来源抓取失败` : ''}`
      : `未写入任何主体：${out.failed.length} 个来源抓取失败、${out.parse_gaps.length} 个来源解析出 0 行（parse gap 已保留，任务状态为 ${jobStatus}）`;
  if (out.sources_not_attempted > 0 || out.truncated) {
    // 如实标记：本批最多 4 个来源，未尝试的来源留待下一批，不能宣称已完成。
    out.note += `；本批按${selection === 'explicit' ? '显式 codes 顺序' : '默认轮换'}选择 ${selected.length}/${list.length} 个来源，` +
      `实际尝试 ${out.sources_attempted} 个，${out.sources_not_attempted} 个未在本批处理（不表示已完成，留待下一批）`;
  }
  closeCeaJob(job.id, {
    status: jobStatus,
    found: out.sources_selected, parsed: out.rows_parsed, published: written,
    errors: out.failed.length + out.parse_gaps.length,
    errorSummary: (out.failed.length || out.parse_gaps.length)
      ? [
        ...out.failed.map((f) => `${f.source}：${f.message || f.reason}`),
        ...out.parse_gaps.map((g) => `${g.source}：${g.reason}${g.message ? `（${g.message}）` : ''}`),
      ].join('；').slice(0, 900)
      : null,
    detail: { ...out },
  });
  audit({ actor, action: 'cea.collect_entities', objectType: 'ingestion_job', objectId: job.id, detail: out });
  return out;
}

/**
 * 采集公开交易意向（**只写 cea_intention，绝不写入成交表**）。
 * 优先使用官网公开 JSON（tradeIntent.json，真实结构化列表）；
 * 失败时退回门户 HTML 解析；两者都拿不到就如实登记缺口，不用模拟数据。
 */
export async function collectCeaIntentions({ actor = 'system:cea-collect', trigger = 'manual', cfg = ceaCollectConfig(), deadlineAt = null } = {}) {
  const guard = preflight(cfg, '采集 CEA 交易意向');
  if (guard) return guard;
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const started = Date.now();
  // 共享 deadline：意向通道同样不得各自重置 120 秒预算
  const deadline = deadlineAt || started + budget;
  const left = () => deadline - Date.now();
  if (deadlineAt && left() <= 0) {
    return { skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，意向通道留待下一批', deadline_shared: true, elapsed_ms: 0 };
  }
  const job = openCeaJob({ jobKey: 'cea_intentions', title: 'CEA 公开交易意向采集', trigger, actor });
  if (job.reused) {
    return ceaReentryResult(job, 'CEA 意向采集任务');
  }
  const out = { job_id: job.id, channel: null, created: 0, updated: 0, rows: 0, unknown_direction: [], failed: null, note: null, deadline_shared: !!deadlineAt };
  try {
    await runCeaIntentionsBody({ actor, cfg, job, out, deadline, left });
  } catch (e) {
    out.failed = { reason: 'exception', message: `意向采集异常：${e.message}` };
    out.note = `意向采集在本次请求内异常收尾：${e.message}（不留 running，靠每日任务重试）。`;
  } finally {
    closeCeaJob(job.id, {
      status: out.rows ? 'success' : 'failed', found: out.rows, parsed: out.rows, published: out.created,
      errors: out.rows ? 0 : 1,
      errorSummary: out.rows ? null : `未取得意向条目：${out.failed?.reason || ''} ${out.failed?.message || ''}`.slice(0, 500),
      detail: out,
    });
    out.elapsed_ms = Date.now() - started;
    audit({ actor, action: 'cea.collect_intentions', objectType: 'ingestion_job', objectId: job.id, detail: { rows: out.rows, created: out.created, failed: out.failed?.reason || null } });
  }
  return out;
}

/** 意向采集主体：优先公开 JSON，失败退回门户 HTML（由 collectCeaIntentions 统一收尾） */
async function runCeaIntentionsBody({ actor, cfg, job, out, deadline, left }) {
  // ① 优先公开 JSON
  const json = await fetchJsonChannel('cea_json_trade_intent', { actor, timeoutMs: cfg.request_timeout_ms, deadlineAt: deadline });
  if (json.ok) {
    const parsed = parseTradeIntents(json.payload, { sourceUrl: getCeaSourceByCode('cea_json_trade_intent')?.url });
    if (parsed.ok) {
      out.channel = 'tradeIntent_json';
      for (const r of parsed.rows) {
        const res = upsertCeaIntention(
          {
            intention_key: r.intention_key, published_date: r.published_date, instrument_label: r.instrument_label,
            quota_year: r.quota_year, direction: r.direction, volume: r.volume, price: r.price, participant: r.participant,
            source_code: 'cea_json_trade_intent', source_url: r.source_url, source_hash: json.hash, snapshot_id: json.snapshotId,
            note: `${parsed.note}${r.quota_year_note ? `｜${r.quota_year_note}` : ''}${r.region ? `｜地区（非主体）：${r.region}` : ''}`,
          },
          { actor }
        );
        if (res.created) out.created += 1; else if (res.updated) out.updated += 1;
      }
      out.rows = parsed.rows.length;
      out.unknown_direction = parsed.unknown_direction;
      out.note = parsed.note;
      markCeaSourceRun('cea_json_trade_intent', { ok: true, itemsOk: parsed.rows.length });
      addCeaStep(job.id, { stage: 'parse', target: 'tradeIntent.json', status: 'ok', items: parsed.rows.length,
        message: `公开 JSON 意向 ${parsed.rows.length} 条（新建 ${out.created}，更新 ${out.updated}）；方向未识别 ${parsed.unknown_direction.length} 条`,
        snapshotId: json.snapshotId });
      closeCeaGapsByPrefixes(['cea:intention:'], { note: `已通过官方公开 JSON 取得 ${parsed.rows.length} 条真实意向`, actor });
      return out;
    }
    out.failed = { reason: 'json_parse_failed', message: parsed.reason };
  } else {
    out.failed = { reason: json.reason, message: json.message };
  }

  // ② 退回门户 HTML 解析
  const source = getCeaSourceByCode('cea_intentions');
  if (!source) {
    out.failed = { reason: 'no_intention_source', message: '未登记交易意向来源' };
    return out;
  }
  if (left() <= 2000) {
    out.failed = { reason: 'batch_budget_exceeded', message: '批次总时间上限已到：门户 HTML 通道未发出请求（留待下一批）' };
    return out;
  }
  const fetched = await fetchAndSnapshot(source.url, {
    allowedDomains: source.allowed_domains, sourceId: source.id, timeoutMs: cfg.request_timeout_ms, actor,
    parserNote: 'CEA 公开交易意向门户', deadlineAt: deadline,
  });
  if (!fetched.ok) {
    markCeaSourceRun(source.code, { ok: false, error: `${fetched.reason}: ${fetched.message || ''}` });
    const gap = recordCeaGap({
      dataset: CEA_GAP_DATASETS.intention,
      title: 'CEA 公开交易意向获取失败',
      description: `公开 JSON 与门户 HTML 均失败（JSON：${out.failed?.reason || '—'}；门户：${fetched.reason}：${fetched.message || ''}）。`,
      impact: '意向覆盖数为 0。意向不等同成交，缺口不影响行情统计。',
      severity: 'normal', gapKey: 'cea:intention:fetch',
    });
    out.failed = { reason: fetched.reason, message: fetched.message, gap_id: gap.id };
    addCeaStep(job.id, { stage: 'collect', target: source.url, status: 'failed', message: `${fetched.reason}：${fetched.message || ''}`, snapshotId: fetched.snapshotId });
    return out;
  }
  {
    const rows = parseIntentionRows(fetched.body, { url: source.url });
    out.channel = 'portal_html';
    for (const r of rows) {
      const res = upsertCeaIntention(
        { ...r, source_code: source.code, source_url: source.url, source_hash: fetched.hash, snapshot_id: fetched.snapshotId,
          note: '公开交易意向：不等于成交，不计入成交量/成交额；未公开字段为 null。' },
        { actor }
      );
      if (res.created) out.created += 1; else if (res.updated) out.updated += 1;
    }
    out.rows = rows.length;
    out.note = rows.length
      ? `门户 HTML 解析出 ${rows.length} 条公开意向（新建 ${out.created}，更新 ${out.updated}）。意向不计入成交统计。`
      : '公开 JSON 与门户静态页均未取得结构化意向条目。未写入任何推测条目。';
    if (!rows.length) {
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.intention,
        title: 'CEA 公开交易意向未能取得结构化条目',
        description: `公开 JSON 失败（${out.failed?.reason || '—'}），门户已真实抓取（快照 ${fetched.snapshotId}，${fetched.bytes} 字节）但为交互式查询，静态页面无条目。`,
        impact: '意向覆盖数为 0；不使用模拟意向数据。',
        severity: 'normal', gapKey: 'cea:intention:parse',
      });
    }
    markCeaSourceRun(source.code, { ok: true, itemsOk: rows.length });
    addCeaStep(job.id, { stage: 'parse', target: source.url, status: 'ok', items: rows.length, message: out.note, snapshotId: fetched.snapshotId });
  }
  return out;
}

/**
 * CEA 研报 / 行业动态：**有界定向发现 + 全文取得后再核验**。
 *
 * 规范要求（docs/31「CEA 研报/动态」）：
 *   - 复用已配置的博查/Firecrawl（既有 pickSearchProvider/runSearch、pickFetchConnection/fetchUrlContent），
 *     不新建密钥输入流程；
 *   - **搜索摘要不能作为事实**：必须实际取得正文（≥200 字）才入库；
 *   - 每条记录保留公开**第一来源** URL、机构、发布日期、数据截止日与观点标记；
 *   - 不能只展示一个固定年报就宣称「动态更新」：无搜索结果或抓取失败时如实登记缺口；
 *   - 有界：1 轮发现、每轮 ≤ limit（默认 6，上限 8）、受共享 deadline 与当日抓取配额约束。
 */
export async function collectCeaResearch({ actor = 'system:cea-collect', trigger = 'manual', cfg = ceaCollectConfig(), limit = 6, queries = null, deadlineAt = null } = {}) {
  const guard = preflight(cfg, '采集 CEA 研报与动态');
  if (guard) return guard;
  const started = Date.now();
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const deadline = deadlineAt || started + budget;
  const left = () => deadline - Date.now();
  const maxItems = Math.min(Math.max(Number(limit) || 6, 1), 8);
  const job = openCeaJob({ jobKey: 'cea_research', title: 'CEA 研报与行业动态发现', trigger, actor });
  if (job.reused) {
    return ceaReentryResult(job, 'CEA 研报采集任务');
  }
  const out = {
    job_id: job.id, channel: null, queries: [], candidates: 0, fetched: 0, published: 0,
    created: 0, updated: 0, skipped: [], failed: [], truncated: false, verified: null,
    note: null, deadline_shared: !!deadlineAt,
  };
  // 后台配置指定的服务必须真正生效：指定了 search_provider_id / fetch_connection_id 时，
  // 只用这两个服务；不存在 / 未启用 → 明确失败并留缺口，绝不悄悄切换成另一个服务。
  const wantedProviderId = cfg.search_provider_id || null;
  const provider = pickSearchProvider(wantedProviderId);
  if (wantedProviderId && !provider) {
    const msg = `后台指定的搜索服务不存在（id=${wantedProviderId}）：不自动改用其他服务`;
    out.failed.push({ reason: 'search_provider_missing', message: msg });
    out.note = msg;
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.research,
      title: 'CEA 研报与行业动态无法发现：指定的搜索服务不存在',
      description: `后台 CEA 采集配置 search_provider_id=${wantedProviderId}，但该服务已不存在。`,
      impact: '本轮不做定向发现（不静默切换到其他服务），研报/动态覆盖保持原状。',
      severity: 'warning', gapKey: 'cea:research:no_search',
    });
    closeCeaJob(job.id, { status: 'failed', errorSummary: msg, detail: out });
    return out;
  }
  if (wantedProviderId && provider && !provider.enabled) {
    const msg = `后台指定的搜索服务「${provider.name}」未启用（id=${wantedProviderId}）：不自动改用其他服务`;
    out.failed.push({ reason: 'search_provider_disabled', message: msg });
    out.note = msg;
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.research,
      title: 'CEA 研报与行业动态无法发现：指定的搜索服务未启用',
      description: `后台 CEA 采集配置指定了「${provider.name}」（${wantedProviderId}），但该服务 enabled=0。`,
      impact: '本轮不做定向发现（不静默切换到其他服务），研报/动态覆盖保持原状。',
      severity: 'warning', gapKey: 'cea:research:no_search',
    });
    closeCeaJob(job.id, { status: 'failed', errorSummary: msg, detail: out });
    return out;
  }
  if (!provider) {
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.research,
      title: 'CEA 研报与行业动态无法发现：未配置可用搜索服务',
      description: '后台未配置可用搜索 API，无法做定向发现。已登记的固定研究来源仍可采集。',
      impact: '研报/动态覆盖仅限已登记的第一来源；不使用模拟条目填充。',
      severity: 'warning', gapKey: 'cea:research:no_search',
    });
    out.failed.push({ reason: 'no_search_provider', message: '未配置可用搜索服务' });
    out.note = '未配置搜索服务：不伪造研报条目，如实登记缺口。';
    closeCeaJob(job.id, { status: 'failed', errorSummary: '未配置可用搜索服务', detail: out });
    return out;
  }
  out.search_provider = { id: provider.id, name: provider.name, source: wantedProviderId ? 'config' : 'auto' };

  const wantedConnId = cfg.fetch_connection_id || null;
  const conn = pickFetchConnection(wantedConnId);
  if (wantedConnId && (!conn || !conn.enabled || conn.archived)) {
    const why = !conn ? '不存在' : conn.archived ? '已归档' : '未启用';
    const msg = `后台指定的网页抓取连接${why}（id=${wantedConnId}）：不自动改用其他连接`;
    out.failed.push({ reason: 'fetch_connection_unusable', message: msg });
    out.note = msg;
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.research,
      title: `CEA 研报正文抓取连接不可用（指定服务${why}）`,
      description: `后台 CEA 采集配置 fetch_connection_id=${wantedConnId}，该连接${why}。`,
      impact: '本轮不取得正文、不写入任何研报条目；不静默切换到其他抓取服务。',
      severity: 'warning', gapKey: 'cea:research:no_fetch',
    });
    closeCeaJob(job.id, { status: 'failed', errorSummary: msg, detail: out });
    return out;
  }
  out.fetch_connection = conn
    ? { id: conn.id, name: conn.name, kind: conn.conn_kind, source: wantedConnId ? 'config' : 'auto' }
    : null;

  // 主体包在 try/catch/finally 中：任何异常都必须在本次收尾（不能靠 30 分钟僵死扫描），
  // 且不能把运行中的任务留成 running。
  try {
    await runCeaResearchBody({
      actor, cfg, provider, conn, queries, maxItems, out, deadline, left,
    });
  } catch (e) {
    out.failed.push({ reason: 'exception', message: `研报采集异常：${e.message}` });
    out.note = `研报采集在本次请求内异常收尾：${e.message}（已如实收尾任务，不留 running）。`;
  } finally {
    if (!out.note) {
      out.note = out.published
        ? `已取得 ${out.fetched} 篇全文，写入/更新 ${out.created + out.updated} 条研报与动态（来源：${provider.id}）。观点类内容标记为研究观点，不作为现行规则。`
        : '本轮未取得任何可入库的研报/动态全文（搜索无结果或正文过短）；不写入推测条目，如实登记缺口。';
    }
    if (!out.published && !out.failed.some((f) => f.reason === 'no_search_provider')) {
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.research,
        title: 'CEA 研报与行业动态本轮无新增可用全文',
        description: `搜索候选 ${out.candidates} 条，成功取得全文 ${out.fetched} 篇。跳过原因：${out.skipped.slice(0, 5).map((s) => `${s.url}（${s.reason}）`).join('；') || out.failed.slice(0, 3).map((f) => `${f.reason || ''} ${f.message || ''}`).join('；') || '无候选或搜索失败'}。`,
        impact: '研报/动态覆盖未更新；页面显示真实缺口，不用固定年报冒充动态更新。',
        severity: 'normal', gapKey: 'cea:research:empty_round',
      });
    }
    markCeaSourceRun('cea_research_discovery', { ok: out.published > 0, itemsOk: out.published, itemsFailed: out.failed.length });
    out.elapsed_ms = Date.now() - started;
    closeCeaJob(job.id, {
      status: out.published ? (out.failed.length ? 'partial' : 'success') : 'failed',
      found: out.candidates, parsed: out.fetched, validated: out.published, published: out.published,
      errors: out.failed.length,
      errorSummary: out.failed.length ? out.failed.slice(0, 3).map((f) => `${f.reason || ''} ${f.message || ''}`).join('；').slice(0, 500) : null,
      detail: { queries: out.queries, skipped: out.skipped.length, truncated: out.truncated, search_provider: out.search_provider, fetch_connection: out.fetch_connection },
    });
    audit({ actor, action: 'cea.collect_research', objectType: 'ingestion_job', objectId: job.id, detail: { published: out.published, fetched: out.fetched, provider: provider.id, conn: conn?.id || null } });
  }
  return out;
}

/**
 * 研报采集主体（发现 → 逐条取全文 → 入库 → 核验）。
 * 由 collectCeaResearch 包在 try/finally 中调用，保证异常也能收尾。
 */
async function runCeaResearchBody({ actor, cfg, provider, conn, queries, maxItems, out, deadline, left }) {
  const queryList = (Array.isArray(queries) && queries.length ? queries : [
    '全国碳排放权交易市场 配额 研究 报告',
    '全国碳市场 CEA 行业动态 配额分配',
    '碳排放配额 履约 清缴 研究 机构',
  ]).slice(0, 3);

  const seen = new Set();
  const pool = [];
  for (const q of queryList) {
    if (left() <= 3000) { out.truncated = true; out.failed.push({ reason: 'batch_budget_exceeded', note: '总时间上限已到，剩余查询留待下一批' }); break; }
    const searched = await runSearch(provider, q, { count: Math.min(Math.max(maxItems, 3), 10), deadlineAt: deadline });
    out.queries.push({ query: q, ok: !!searched.ok, count: searched.results?.length || 0, reason: searched.reason || null, deadline_exceeded: !!searched.deadline_exceeded });
    if (!searched.ok) {
      out.failed.push({ query: q, reason: searched.reason, message: searched.message });
      if (searched.deadline_exceeded) { out.truncated = true; break; }
      continue;
    }
    for (const hit of searched.results || []) {
      const url = hit.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.candidates += 1;
      pool.push({ url, title: hit.title || null, query: q, published_hint: hit.published_date || null, source: classifyResearchSource(url) });
    }
  }
  // 来源分级排序：官方交易机构/政府 → 高校研究机构 → 行业媒体 → 聚合转载站。
  // 目的是让「公开第一来源」优先入库，而不是把转载站当原始出处。
  pool.sort((a, b) => a.source.rank - b.source.rank);
  out.candidate_pool = pool.length;
  out.pool_by_source_kind = pool.reduce((acc, c) => { acc[c.source.kind] = (acc[c.source.kind] || 0) + 1; return acc; }, {});
  let primaryPublished = 0;

  for (const cand of pool) {
    if (out.published >= maxItems || left() <= 3000) { out.truncated = out.published < pool.length; break; }
    const url = cand.url;
    // 已有第一来源入库时，不再把聚合/转载站当作新增「动态」：
    // 记录跳过原因，避免用转载站冒充第一来源（不删除、不伪造）。
    if (cand.source.kind === 'media_repost' && primaryPublished > 0) {
      out.skipped.push({ url, reason: 'repost_not_first_source', message: '本轮已取得第一来源条目；聚合/转载站不作为新增研报入库' });
      continue;
    }
    // 出站校验：拒绝非 http(s) 与内网/本机地址（以该 URL 自身主机作为白名单，逐条校验）
    const host = cand.source.host;
    if (!host) { out.skipped.push({ url, reason: 'bad_url' }); continue; }
    const chk = checkOutboundUrl(url, [host]);
    if (!chk.ok) { out.skipped.push({ url, reason: 'outbound_blocked', message: chk.reason }); continue; }
    const q2 = ceaQuotaState(cfg);
    if (q2.remaining <= 0) { out.truncated = true; out.failed.push({ reason: 'daily_fetch_limit_reached', note: `当日抓取已达上限 ${q2.limit}` }); break; }
    // **必须取得全文**：搜索摘要不写入库。
    // 每次真实取正文的尝试（含失败/超时）都计入 CEA 当日调用数，避免绕过 daily_fetch_limit。
    bumpCeaFetchAttempts(1, `research:${host}`);
    out.fetch_attempts = (out.fetch_attempts || 0) + 1;
    const page = conn
      ? await fetchUrlContent(conn, url, {
        timeoutMs: Math.min(cfg.request_timeout_ms * 2, Math.max(3000, left() - 2000)),
        deadlineAt: deadline,
      })
      : { ok: false, reason: 'no_fetch_connection', message: '未配置可用的网页抓取连接' };
    if (page.deadline_exceeded) {
      out.truncated = true;
      out.skipped.push({ url, reason: 'deadline_exceeded', message: page.message });
      break;
    }
    const pageBody = String(page.content || '');
    if (!page.ok || pageBody.trim().length < 200) {
      out.skipped.push({ url, reason: page.reason || 'body_too_short', message: page.message || `正文 ${pageBody.length} 字，未达 200 字，不作为事实` });
      continue;
    }
    out.quoted_fetch_connection = { id: conn.id, conn_kind: conn.conn_kind };
    out.fetched += 1;
    const body = pageBody.slice(0, 200_000);
    const snap = recordSnapshot({
      url,
      res: { hash: page.content_hash || sha256(Buffer.from(pageBody, 'utf8')), bytes: Buffer.byteLength(pageBody, 'utf8'), status: 200, content_type: 'text/markdown' },
      parser: 'research_fetch', parseQuality: 'good',
      parseNote: `CEA 研报/动态正文：由抓取连接 ${conn ? conn.id : '—'} 实际取得 ${pageBody.length} 字（搜索摘要未作为事实）`,
    });
    const meta = deriveResearchMeta({ url, title: page.title || cand.title, body, published_at: page.published_hint || cand.published_hint || null });
    const docKey = `cea_research:${sha256(url).slice(0, 24)}`;
    // 公开第一来源：只有确认是原始发布方（非聚合/转载站）才写 first_source_url；
    // 转载站的原文出处未确认 → first_source_url 保持 null，当前页面 URL 另存 page_url。
    const isRepost = cand.source.kind === 'media_repost';
    const res = upsertCeaDocument({
      doc_key: docKey,
      doc_type: meta.doc_type,
      category: meta.doc_type === 'research' ? 'research' : 'news',
      title: String(cand.title || page.title || url).slice(0, 300),
      issuer: meta.issuer,
      publish_date: meta.publish_date,
      data_cutoff_date: meta.data_cutoff_date,
      data_cutoff_raw: meta.data_cutoff_raw,
      data_cutoff_precision: meta.data_cutoff_precision,
      viewpoint: meta.viewpoint,
      first_source_url: isRepost ? null : url,
      page_url: url,
      doc_status: 'formal',
      official_url: url,
      source_code: null,
      snapshot_id: snap.id,
      content_hash: snap.hash || null,
      fetched_at: nowIso(),
      body_snapshot: body,
      evidence_level: meta.doc_type === 'research' && (isRepost || /点击.{0,10}查看.{0,10}完整报告|点击免费查看完整报告/.test(body)) ? 'partial' : 'full_text',
      discovery_json: j({
        channel: conn ? `fetch:${conn.conn_kind || conn.id}` : 'direct', provider: provider.id, query: cand.query,
        title: cand.title || null, fetched_chars: body.length,
        source_kind: cand.source.kind, source_kind_label: cand.source.label, source_host: cand.source.host,
        page_url: url, first_source_unknown: isRepost,
      }),
      provenance_note:
        `公开来源：${url}（来源类型=${cand.source.label}；搜索发现 ${provider.id}，查询词「${cand.query}」；正文由 ` +
        `${conn ? conn.conn_kind || conn.id : '直连'} 实际取得 ${body.length} 字，快照 ${snap.id}，抓取时间 ${nowIso()}）。` +
        '搜索摘要未作为事实使用。' +
        (isRepost
          ? '该站点为聚合/转载站，原文出处未在来源页确认：first_source_url 保持 null（本页 URL 记在 page_url），不把转载页冒充公开第一来源。'
          : ''),
      note: meta.note,
    }, { actor });
    if (res.error) { out.failed.push({ url, reason: 'upsert_failed', message: res.error }); continue; }
    if (res.created) out.created += 1; else out.updated += 1;
    out.published += 1;
    if (cand.source.rank <= 2) primaryPublished += 1;
    closeCeaGapsByPrefixes([`cea:research:${docKey}`], { note: '研报/动态已取得全文并入库', actor });
    // 全文取得后再核验（真实模型调用；引文必须能在正文中定位），时限取批次剩余时间
    if (cfg.auto_verify && left() > 8000) {
      try {
        const v = await verifyObject('cea_document', res.id, {
          actor, cfg: verifyConfig(), force: false,
          timeoutMs: Math.min(60000, Math.max(2000, left() - 2000)),
        });
        out.last_verify = { document_id: res.id, result: v.result || null, cached: !!v.cached };
      } catch (e) {
        out.last_verify = { document_id: res.id, result: 'error', message: e.message };
      }
    }
    if (out.published >= maxItems) break;
  }
}

/**
 * 来源分级：公开第一来源的**可核对类型**。
 * 新闻聚合/转载站（搜狐、北极星等）不是第一来源，必须单独标记，
 * 不能把转载站说成「原始发布机构」。
 */
export const RESEARCH_SOURCE_KINDS = {
  official_exchange: { label: '官方交易机构', rank: 0 },
  official_government: { label: '政府公开网站', rank: 1 },
  institution: { label: '高校/研究机构', rank: 2 },
  media: { label: '行业媒体', rank: 3 },
  media_repost: { label: '聚合/转载站（非第一来源）', rank: 4 },
  unknown: { label: '未分类来源', rank: 5 },
};

const REPOST_HOSTS = [
  'sohu.com', 'bjx.com.cn', '163.com', 'sina.com.cn', 'qq.com', 'toutiao.com', 'baidu.com',
  'zhihu.com', 'xueqiu.com', 'eastmoney.com', '163.net', 'ifeng.com', 'chinanews.com',
  'thepaper.cn', 'caixin.com', 'huanqiu.com', 'sm.cn', '360doc.com', 'docin.com', 'renrendoc.com',
];

export function classifyResearchSource(url = '') {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return { kind: 'unknown', ...RESEARCH_SOURCE_KINDS.unknown, host: '' }; }
  const kind = /cneeex\.com$/.test(host) ? 'official_exchange'
    : /(\.gov\.cn|\.gov\.hk)$/.test(host) ? 'official_government'
      : /(\.edu\.cn|\.ac\.cn|\.edu$)/.test(host) ? 'institution'
        : REPOST_HOSTS.some((d) => host === d || host.endsWith(`.${d}`)) ? 'media_repost'
          : 'media';
  return { kind, ...RESEARCH_SOURCE_KINDS[kind], host };
}

/** 机构名：只接受**有发布语境的标注**或域名映射；不做无上下文的机构名猜测 */
const ISSUER_LABEL_RE = /(?:来源|机构|作者|发布(?:单位|机构|方)?|研究(?:团队|机构)|撰写|执笔)\s*[:：]\s*([\u4e00-\u9fa5A-Za-z0-9（）()·\s]{2,40}?(?:研究院|研究所|研究中心|大学|学院|证券|期货|基金|协会|交易所|咨询|智库|实验室|委员会|部|厅|局))/;
const ISSUER_DOMAIN_MAP = [
  [/cneeex\.com$/, '上海环境能源交易所'],
  [/mee\.gov\.cn$/, '生态环境部'],
  [/cufe\.edu\.cn$/, '中央财经大学绿色金融国际研究院'],
  [/tsinghua\.edu\.cn$/, '清华大学'],
  [/pku\.edu\.cn$/, '北京大学'],
  [/\.gov\.cn$/, '政府公开网站（具体机构以来源页标注为准）'],
];

/**
 * 从真实来源页派生研报元数据。**只使用能在正文/来源里核对到的信息**：
 *   - 机构：来源页「来源/机构/作者：X」标注，或域名映射；两者都没有 → null（不猜）；
 *   - 发布日期：来源页元数据（published_hint）优先；正文只在带「发布时间：」等标签时采用；
 *   - 数据截止日：正文出现「数据截至/截止 X年X月」时记录；
 *   - 观点标记：出现「观点/展望/预测/预计/建议」等表述 → research_opinion，否则 market_news。
 */
export function deriveResearchMeta({ url = '', title = '', body = '', published_at = null } = {}) {
  const text = String(body || '');
  const flat = text.replace(/\s+/g, ' ');
  const src = classifyResearchSource(url);
  const labelIssuer = (flat.match(ISSUER_LABEL_RE) || [])[1] || null;
  const domainIssuer = ISSUER_DOMAIN_MAP.find(([re]) => re.test(src.host));
  const issuer = labelIssuer ? labelIssuer.trim().slice(0, 40) : domainIssuer ? domainIssuer[1] : null;
  const issuer_source = labelIssuer ? 'source_page_label' : domainIssuer ? 'domain_map' : null;
  const dateFromMeta = published_at ? String(published_at).slice(0, 10) : null;
  // 正文日期必须在明确的发布语境里才采用（避免把正文里第一个业务日期当成发布日期）
  const labeled = flat.match(/(?:发布(?:时间|日期)?|发表(?:时间|日期)?|更新(?:时间|日期)?|时间)\s*[:：]?\s*(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/);
  const publish_date = dateFromMeta || (labeled
    ? `${labeled[1]}-${String(labeled[2]).padStart(2, '0')}-${String(labeled[3]).padStart(2, '0')}`
    : null);
  // 数据截止日：**原文精度不足时不补造日**（docs/35 第 5 条）。
  //   「截至2023年12月」→ data_cutoff_date='2023-12'（precision=month），绝不写成 2023-12-01；
  //   「截至2023年」    → data_cutoff_date='2023'（precision=year），绝不写成 2023-12-01；
  //   只有原文明确到「年月日」才写 YYYY-MM-DD（precision=day）。
  const cutoffDay = flat.match(/(?:数据)?(?:截至|截止)\s*(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
  const cutoffMonth = flat.match(/(?:数据)?(?:截至|截止)\s*(20\d{2})\s*[-/年]\s*(\d{1,2})\s*月?/);
  const cutoffYear = flat.match(/(?:数据)?(?:截至|截止)\s*(20\d{2})\s*年?/);
  let data_cutoff_date = null;
  let data_cutoff_precision = null;
  let data_cutoff_raw = null;
  if (cutoffDay) {
    const iso = `${cutoffDay[1]}-${String(cutoffDay[2]).padStart(2, '0')}-${String(cutoffDay[3]).padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
      data_cutoff_date = iso;
      data_cutoff_precision = 'day';
      data_cutoff_raw = cutoffDay[0].trim();
    }
  }
  if (!data_cutoff_date && cutoffMonth) {
    data_cutoff_date = `${cutoffMonth[1]}-${String(cutoffMonth[2]).padStart(2, '0')}`;
    data_cutoff_precision = 'month';
    data_cutoff_raw = cutoffMonth[0].trim();
  }
  if (!data_cutoff_date && cutoffYear) {
    data_cutoff_date = `${cutoffYear[1]}`;
    data_cutoff_precision = 'year';
    data_cutoff_raw = cutoffYear[0].trim();
  }
  const isOpinion = /(观点|展望|预测|预计|建议|我们认为|研判|分析认为)/.test(flat);
  return {
    doc_type: isOpinion ? 'research' : 'news',
    viewpoint: isOpinion ? 'research_opinion' : 'market_news',
    issuer,
    issuer_source,
    publish_date,
    data_cutoff_date,
    data_cutoff_precision,
    data_cutoff_raw,
    source_kind: src.kind,
    source_kind_label: src.label,
    host: src.host,
    note:
      `研报/行业动态：内容为公开来源原文，观点类标记 viewpoint=research_opinion，不作为现行规则或履约义务依据；` +
      `来源类型=${src.label}（${src.host}）；机构=${issuer || '未标注（保持 null）'}；发布日期=${publish_date || '未标注'}；` +
      `数据截止日=${data_cutoff_date || '未标注'}${data_cutoff_precision && data_cutoff_precision !== 'day' ? `（原文仅到${data_cutoff_precision === 'month' ? '月' : '年'}，按原精度记录，不补造具体日）` : ''}。` +
      (src.kind === 'media_repost'
        ? '该站点为聚合/转载站，不是公开第一来源，原文出处未在来源页确认（first_source_url 保持 null，本页 URL 记在 page_url）。'
        : ''),
  };
}

/**
 * 手动/定时收尾僵死的 CEA 任务（供 CLI 与后台「任务」页使用）。
 * @returns {{closed:number, jobs:Array}}
 */
export function closeStaleCeaJobs({ actor = 'system:cea', maxAgeMs = CEA_STALE_JOB_MS } = {}) {
  const rows = all(
    `SELECT id,job_key,started_at FROM ingestion_job WHERE job_key LIKE 'cea%' AND status='running' ORDER BY started_at`
  );
  const closed = [];
  for (const r of rows) {
    const startedMs = Date.parse(r.started_at || '') || 0;
    const age = Date.now() - startedMs;
    if (!startedMs || age <= maxAgeMs) continue;
    closeCeaJob(r.id, {
      status: 'failed',
      errorSummary: `任务僵死：开始于 ${r.started_at}，超过 ${Math.round(maxAgeMs / 60000)} 分钟未收尾，已自动标记失败。`,
      detail: { stale: true, age_ms: age },
    });
    closed.push({ id: r.id, job_key: r.job_key, started_at: r.started_at, age_ms: age });
  }
  if (closed.length) {
    audit({ actor, action: 'cea.jobs_stale_closed', objectType: 'ingestion_job', detail: { closed }, result: 'warning' });
  }
  return { closed: closed.length, jobs: closed, checked: rows.length };
}

/**
 * 用搜索在**官方政府域名**内发现省级重点排放单位名录页面（规范允许：
 * 「可通过搜索找到官方 HTML/其他省官方样本」）。
 *
 * 安全约束：
 *   - 只接受 https 且主机以 `.gov.cn` 结尾的命中（不接受 IP、不接受其他域名）；
 *   - 命中后**必须实际读取原文**再解析，搜索摘要不能作为名录事实；
 *   - 只发现与解析，来源登记由管理员/源码清单维护，不静默扩权。
 */
export async function discoverEntityCandidates({ limit = 5, actor = 'system:cea-collect', query = null, deadlineAt = null } = {}) {
  const cfg = ceaCollectConfig();
  const wanted = cfg.search_provider_id || null;
  const provider = pickSearchProvider(wanted);
  if (wanted && !provider) {
    return { ok: false, reason: 'search_provider_missing', message: `后台指定的搜索服务不存在（id=${wanted}）：不自动改用其他服务`, candidates: [] };
  }
  if (wanted && provider && !provider.enabled) {
    return { ok: false, reason: 'search_provider_disabled', message: `后台指定的搜索服务「${provider.name}」未启用：不自动改用其他服务`, candidates: [] };
  }
  if (!provider) return { ok: false, reason: 'not_configured', message: '未配置搜索服务：无法用搜索发现名录样本', candidates: [] };
  const q = query || `2026年度重点排放单位名录 碳排放 省级生态环境厅 site:gov.cn`;
  const out = await runSearch(provider, q, { count: Math.min(Number(limit) + 4, 10), deadlineAt });
  if (!out.ok) return { ok: false, reason: out.reason, message: out.message, candidates: [] };
  const candidates = [];
  for (const r of out.results || []) {
    const url = String(r.url || r.link || '');
    let u;
    try { u = new URL(url); } catch { continue; }
    if (u.protocol !== 'https:') continue;
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('.gov.cn') && host !== 'gov.cn') continue;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
    candidates.push({ url, host, title: r.title || '', summary_hint: r.snippet || r.summary || null });
    if (candidates.length >= limit) break;
  }
  return {
    ok: true, provider_id: provider.id, query: q, candidates,
    note: '搜索仅用于发现候选 URL；名录事实必须来自随后实际读取的官方原文。搜索摘要不作为证据。',
  };
}

/**
 * 从搜索发现的官方 HTML 名录页面采集主体行。
 * 每个候选都记录「是否真的读到原文、解析出多少行、缺口在哪」，不做任何推测补全。
 */
export async function collectCeaEntitiesFromDiscovery({ actor = 'system:cea-collect', limit = 3, listYear = null, trigger = 'manual', query = null, cfg = ceaCollectConfig(), deadlineAt = null } = {}) {
  const guard = preflight(cfg, '采集 CEA 名录');
  if (guard) return guard;
  const found = await discoverEntityCandidates({ limit, actor, query, deadlineAt });
  if (!found.ok) {
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.entity,
      title: 'CEA 名录搜索发现不可用',
      description: `搜索服务不可用（${found.reason}：${found.message}），无法用搜索补充官方 HTML 名录样本。`,
      impact: '名录覆盖数保持为 0，等待搜索服务恢复或管理员上传官方原件。',
      severity: 'normal',
      gapKey: 'cea:entity:search_unavailable',
    });
    return { ok: false, reason: found.reason, message: found.message, candidates: [] };
  }
  const job = openCeaJob({ jobKey: 'cea_entities', title: 'CEA 名录采集（搜索发现官方 HTML 样本）', trigger, actor });
  if (job.reused) {
    return ceaReentryResult(job, 'CEA 名录采集任务');
  }
  const out = { job_id: job.id, query: found.query, candidates: found.candidates.length, sources: [], entities_created: 0, entities_updated: 0, failed: [] };
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const started = Date.now();
  const deadline = deadlineAt || started + budget;
  try {
  for (const c of found.candidates.slice(0, limit)) {
    if (Date.now() > deadline) { out.truncated = true; break; }
    // 白名单：直接把该 gov.cn 主机作为本次出站白名单（协议与私网仍由 checkOutboundUrl 强制）
    const fetched = await fetchAndSnapshot(c.url, {
      allowedDomains: [c.host], timeoutMs: cfg.request_timeout_ms, actor, deadlineAt: deadline,
      parserNote: `CEA 名录（搜索发现的官方 HTML 样本）：${c.host}`,
    });
    if (!fetched.ok) {
      out.failed.push({ url: c.url, reason: fetched.reason, message: fetched.message });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.entity,
        title: `CEA 名录样本抓取失败：${c.host}`,
        description: `${c.url} 真实抓取失败（${fetched.reason}：${fetched.message || ''}）。`,
        impact: '该省覆盖数不计入；未写入任何推测行。',
        severity: 'normal',
        gapKey: `cea:entity:discovery_fetch:${c.url}`.slice(0, 300),
      });
      continue;
    }
    const rows = parseEntityRows(fetched.body, { listYear, province: null });
    let created = 0;
    let updated = 0;
    let skippedNoYear = 0;
    for (const r of rows) {
      // 年度必须来自原文或登记来源；都不成立时**不入库**，不拿当前年份顶替
      if (!Number.isInteger(Number(r.list_year))) { skippedNoYear += 1; continue; }
      const res = upsertCeaEntity(
        { ...r, list_year: Number(r.list_year), province: r.province || null, source_url: c.url, source_hash: fetched.hash, snapshot_id: fetched.snapshotId, data_as_of: todayCst() },
        { actor }
      );
      if (res.created) created += 1; else if (res.updated) updated += 1;
    }
    out.entities_created += created;
    out.entities_updated += updated;
    out.sources.push({ url: c.url, host: c.host, rows: rows.length, created, updated, skipped_no_year: skippedNoYear, no_credit_code: rows.filter((r) => !r.credit_code).length });
    if (!rows.length) {
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.entity,
        title: `CEA 名录样本已获取但未解析出主体行：${c.host}`,
        description: `已真实抓取（快照 ${fetched.snapshotId}，${fetched.bytes} 字节），但未识别出可核对的企业行（可能是栏目页/采购公告/扫描件，或表格结构不同；已由「重点排放单位名录」页面判定拦截）。`,
        impact: '该来源覆盖数为 0；未写入推测行，也不把行业词当作企业名称。',
        severity: 'normal',
        // 按主机聚合缺口，避免同站多个 URL 产生重复噪声
        gapKey: `cea:entity:discovery_parse:${c.host}`,
      });
    } else {
      closeCeaGapsByPrefixes(['cea:entity:fetch:', 'cea:entity:parse:', 'cea:entity:discovery_'], {
        note: `已通过搜索发现的官方页面成功入库 ${created} 行`, actor,
      });
    }
    addCeaStep(job.id, { stage: 'parse', target: c.url, status: 'ok', items: rows.length, message: `解析出 ${rows.length} 行（新建 ${created}，更新 ${updated}）`, snapshotId: fetched.snapshotId });
  }
  // 若本次仍无任何行入库，清掉「已通过搜索补充」的乐观结清，保持真实缺口
  if (!out.entities_created && !out.entities_updated) {
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.entity,
      title: 'CEA 省级名录暂无可解析的公开样本',
      description: `已用搜索发现 ${found.candidates.length} 个官方（*.gov.cn）候选并逐个实际抓取，但均未解析出可核对的企业行。`,
      impact: '名录覆盖数为 0（真实缺口）。名录数量不等于买家数量，缺口不影响行情与政策模块。',
      manualPath: '管理员可上传官方名录原件（保留来源层级），或后续批次继续补证。',
      severity: 'warning',
      gapKey: 'cea:entity:no_parseable_sample',
    });
  }
  closeCeaJob(job.id, {
    status: out.sources.some((s) => s.rows > 0) ? 'success' : 'failed',
    found: found.candidates.length, parsed: out.entities_created + out.entities_updated,
    published: out.entities_created, errors: out.failed.length,
    errorSummary: out.failed.length ? out.failed.map((f) => `${f.url}：${f.message || f.reason}`).join('；').slice(0, 900) : null,
    detail: out,
  });
  } catch (e) {
    // 任何异常都必须收尾任务，否则任务会永久停在 running 并阻塞后续采集
    closeCeaJob(job.id, { status: 'failed', errorSummary: `采集异常：${e.message}`.slice(0, 900), detail: { ...out, exception: e.message } });
    audit({ actor, action: 'cea.collect_entities_discovery', objectType: 'ingestion_job', objectId: job.id, detail: { exception: e.message }, result: 'error' });
    throw e;
  }
  audit({ actor, action: 'cea.collect_entities_discovery', objectType: 'ingestion_job', objectId: job.id, detail: out });
  return out;
}

/* ==================================================================== */
/*  六·B、公开 JSON 通道采集（CEA-16）                                   */
/* ==================================================================== */

/**
 * 该通道的分工（docs/31「独立取样新增」段）：
 *   - hiskline.json        → 发现真实交易日（源目录可能滞后）与 OHLC 交叉核对；
 *   - queryMarketByDate    → 该日综合行情 OHLC；dealQty/dealAmt 仅挂牌口径；
 *   - querySubStat         → **精确**分方式量额与累计（只取 COMCEA 三行聚合）；
 *   - dailyov.json         → 概览层（舍入展示值），单独保存、不覆盖精确值。
 * 全部要求业务码成功；HTTP 200 但 success/code 失败按失败处理并留缺口。
 */
export async function collectCeaJsonDaily({
  actor = 'system:cea-collect', trigger = 'manual', dates = null, cfg = ceaCollectConfig(), jobId = null, deadlineAt = null,
} = {}) {
  const guard = preflight(cfg, '采集 CEA 公开 JSON 行情');
  if (guard) return guard;
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const started = Date.now();
  const deadline = deadlineAt || started + budget;
  const left = () => deadline - Date.now();

  const out = {
    job_id: jobId, trigger, channel: 'json',
    discovered: null, dates_attempted: [], quote_sources: [], overlays: {}, calendar: null,
    failed: [], truncated: false, verified: null,
    // 串日通道与分方式不完整单独留痕（便于追溯，不影响同日正确通道入库）
    date_mismatches: [], substat_incomplete: [], substat_field_undisclosed: [],
  };
  const ownJob = !jobId;
  let job = jobId ? { id: jobId, reused: false } : openCeaJob({ jobKey: 'cea_json_daily', title: 'CEA 公开 JSON 行情采集', trigger, actor });
  out.job_id = job.id;
  if (ownJob && job.reused) {
    return { ...out, ...ceaReentryResult(job, 'CEA JSON 行情采集任务') };
  }

  // 1) 发现真实交易日：优先 hiskline（原始目录可能滞后）
  let targetDates = Array.isArray(dates) && dates.length ? dates.slice(0, 8) : null;
  const hist = await fetchJsonChannel('cea_json_hiskline', { actor, timeoutMs: cfg.request_timeout_ms, deadlineAt: deadline });
  if (hist.ok) {
    const parsed = parseHisKline(hist.payload);
    // 真实历史价格层：把官方公开的长期价格序列落库（不含成交额/均价，参考数量不当成交量）
    const saved = upsertCeaPriceHistory(parsed.points, {
      sourceCode: 'cea_json_hiskline',
      sourceUrl: getCeaSourceByCode('cea_json_hiskline')?.url,
      snapshotId: hist.snapshotId, contentHash: hist.hash, fetchedAt: nowIso(), actor,
    });
    out.price_history = { ...saved, earliest: parsed.earliest_date, latest: parsed.latest_date };
    closeCeaGapsByPrefixes(['cea:json:hiskline'], { note: 'hiskline 通道本次成功取得真实历史价格序列', actor });
    // 历史价格层的来源快照留痕（只读层要能钻取到来源与快照，且明确它不是精确成交量额依据）
    if (parsed.latest_date) {
      recordQuoteSource({
        trade_date: parsed.latest_date, channel: 'hiskline_json', sourceCode: 'cea_json_hiskline',
        sourceUrl: getCeaSourceByCode('cea_json_hiskline')?.url, snapshotId: hist.snapshotId, contentHash: hist.hash,
        parsed: { points: parsed.points.length, earliest: parsed.earliest_date, latest: parsed.latest_date, saved: saved.created + saved.updated },
        isPrecise: 0, isOverview: 0,
        note: '真实历史价格序列（来源历史价格层）：volume_reference 为参考数量，不是全方式成交量；不生成成交额/均价',
      });
    }
    out.discovered = {
      source: 'hiskline', latest_date: parsed.latest_date, earliest_date: parsed.earliest_date,
      points: parsed.points.length, note: parsed.note, snapshot_id: hist.snapshotId,
      price_history_saved: saved.created + saved.updated,
    };
    if (!targetDates && parsed.latest_date) targetDates = [parsed.latest_date];
    if (jobId === null) {
      addCeaStep(job.id, { stage: 'collect', target: 'hiskline.json', status: 'ok', items: parsed.points.length,
        message: `发现真实交易日：最早 ${parsed.earliest_date}，最新 ${parsed.latest_date}（共 ${parsed.points.length} 个）；` +
          `历史价格层写入 ${saved.created} 新增/${saved.updated} 更新（不含成交额与全方式均价）`, snapshotId: hist.snapshotId });
    }
  } else {
    out.failed.push({ channel: 'hiskline', reason: hist.reason, message: hist.message });
    recordCeaGap({
      dataset: CEA_GAP_DATASETS.trade,
      title: 'CEA 公开 JSON（hiskline）不可用',
      description: `无法用官方公开 JSON 发现最新交易日（${hist.reason}：${hist.message || ''}）。`,
      impact: '将退回使用指定日期或官方目录；不得把目录中的旧日期当作最新市场数据。',
      severity: 'warning', gapKey: 'cea:json:hiskline',
    });
  }
  if (!targetDates || !targetDates.length) {
    out.truncated = true;
    out.failed.push({ channel: 'discover', reason: 'no_target_date', message: '未能确定目标交易日（可用 --dates 指定）' });
    if (ownJob) closeCeaJob(job.id, { status: 'failed', errorSummary: '未能确定目标交易日', detail: out });
    return out;
  }

  // 2) 逐日采集：queryMarketByDate（OHLC）+ querySubStat（精确量额）
  for (const d of targetDates) {
    if (left() <= 2000) { out.truncated = true; out.failed.push({ reason: 'batch_budget_exceeded', note: '总时间上限已到，剩余日期留待下一批' }); break; }
    const q = ceaQuotaState(cfg);
    if (q.remaining <= 0) { out.truncated = true; out.failed.push({ reason: 'daily_fetch_limit_reached', note: `当日抓取已达上限 ${q.limit}` }); break; }
    const yyyymmdd = String(d).replace(/-/g, '');
    out.dates_attempted.push(d);

    const mkt = await fetchJsonChannel('cea_json_market_by_date', { actor, timeoutMs: cfg.request_timeout_ms, deadlineAt: deadline, body: { tradeDate: yyyymmdd, goodsCode: 'COMCEA' } });
    const quote = mkt.ok ? parseMarketByDate(mkt.payload) : { ok: false, reason: mkt.reason };
    const sub = await fetchJsonChannel('cea_json_substat', { actor, timeoutMs: cfg.request_timeout_ms, deadlineAt: deadline, body: { tradeDate: yyyymmdd } });
    const stat = sub.ok ? parseSubStat(sub.payload) : { ok: false, reason: sub.reason };

    // ---- 逐通道核对日期：请求参数 d 不是证据，响应里的 trade_date 才是 ----
    // 上游忽略查询日期或缓存串日时，绝不能把别的日期行情写成请求日。
    const quoteDateOk = quote.ok && quote.trade_date === d;
    const statDateOk = stat.ok && stat.trade_date === d;
    const quoteMismatch = quote.ok && !quoteDateOk;
    const statMismatch = stat.ok && !statDateOk;
    const channelDates = {
      market_by_date: quote.ok ? quote.trade_date || null : null,
      substat: stat.ok ? stat.trade_date || null : null,
    };
    if (quoteMismatch) {
      out.date_mismatches.push({ date: d, channel: 'market_by_date', requested: d, actual: quote.trade_date || null });
      out.failed.push({
        date: d, channel: 'market_by_date', reason: 'channel_date_mismatch',
        message: `queryMarketByDate 响应日期为 ${quote.trade_date || '（无法解析）'}，与请求日期 ${d} 不一致：本通道 OHLC 不写入 ${d}，不做任何回填`,
      });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.trade,
        title: `CEA ${d} 综合行情通道串日`,
        description: `请求 tradeDate=${yyyymmdd}，响应 trade_date=${quote.trade_date || '（无法解析）'}（快照 ${mkt.snapshotId || '—'}）。`,
        impact: `该日 open/high/low/close/change_pct/prev_close 全部保持 null；不把响应日期行情写成 ${d}。`,
        severity: 'warning', gapKey: `cea:json:date_mismatch:${d}:market_by_date`,
        manualPath: '确认上游是否忽略查询日期或存在缓存；下一批重试该交易日。',
      });
    }
    if (statMismatch) {
      out.date_mismatches.push({ date: d, channel: 'substat', requested: d, actual: stat.trade_date || null });
      out.failed.push({
        date: d, channel: 'substat', reason: 'channel_date_mismatch',
        message: `querySubStat 响应日期为 ${stat.trade_date || '（无法解析）'}，与请求日期 ${d} 不一致：本通道量额不写入 ${d}`,
      });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.trade,
        title: `CEA ${d} 精确量额通道串日`,
        description: `请求 tradeDate=${yyyymmdd}，响应 trade_date=${stat.trade_date || '（无法解析）'}（快照 ${sub.snapshotId || '—'}）。`,
        impact: `该日分方式量额与年度/历史累计全部保持 null；不把响应日期量额写成 ${d}。`,
        severity: 'warning', gapKey: `cea:json:date_mismatch:${d}:substat`,
        manualPath: '确认上游是否忽略查询日期或存在缓存；下一批重试该交易日。',
      });
    }
    // 分方式不完整（缺方式/重复行/未知方式）：分方式值保留，合计保持 null 并留缺口
    if (stat.ok && stat.complete === false) {
      out.substat_incomplete.push({
        date: d, missing: stat.methods_missing, duplicated: stat.methods_duplicated, unknown: stat.methods_unknown,
      });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.trade,
        title: `CEA ${d} 分方式量额不完整`,
        description:
          `querySubStat 汇总行缺失方式 ${stat.methods_missing.map((m) => m.method).join('、') || '无'}；` +
          `重复行 ${stat.methods_duplicated.join('、') || '无'}；未知方式 ${stat.methods_unknown.join('、') || '无'}。`,
        impact: '已披露方式的分项值照实保留；合计（total/year/lifetime）保持 null，不用少数行合成完整总量。',
        severity: 'warning', gapKey: `cea:json:substat_incomplete:${d}`,
      });
    } else if (stat.ok && stat.complete !== false && (stat.fields_undisclosed || []).length) {
      // 方式齐全、但个别累计/总量字段在其中一行未披露：只有该字段保持 null（不把缺项当 0），
      // 其余已完整披露的字段照常给出合计；单独登记缺口以便追溯。
      out.substat_field_undisclosed.push({ date: d, fields: stat.fields_undisclosed });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.trade,
        title: `CEA ${d} 部分累计字段未由三方式全部披露`,
        description: stat.fields_undisclosed
          .map((f) => `${f.label}（${f.field}）：${f.reason}`)
          .join('；'),
        impact: '仅这些字段的合计保持 null；其余已完整披露的字段照常给出合计，不用缺项当 0。',
        severity: 'warning', gapKey: `cea:json:substat_field_undisclosed:${d}`,
      });
    } else if (stat.ok && stat.complete !== false) {
      closeCeaGapsByPrefixes([`cea:json:substat_field_undisclosed:${d}`], {
        note: `${d} 三方式齐全且各累计字段均已披露`, actor,
      });
    }

    if (!quoteDateOk && !statDateOk) {
      const bothMismatch = quoteMismatch || statMismatch;
      out.failed.push({
        date: d, reason: bothMismatch ? 'both_channels_date_mismatch' : 'both_channels_failed',
        quote: quote.reason, substat: stat.reason,
      });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.trade,
        title: bothMismatch ? `CEA ${d} 两个通道均无法确认日期` : `CEA ${d} 公开 JSON 两个通道均失败`,
        description: bothMismatch
          ? `queryMarketByDate=${channelDates.market_by_date || quote.reason || '—'}；querySubStat=${channelDates.substat || stat.reason || '—'}（请求 ${d}）`
          : `queryMarketByDate：${quote.reason}；querySubStat：${stat.reason}`,
        impact: '该交易日不留行情行，也不生成 0 值点。', severity: 'warning',
        gapKey: `cea:json:failed:${d}`,
      });
      continue;
    }

    const row = {
      trade_date: d,
      open: quoteDateOk ? quote.open : null,
      high: quoteDateOk ? quote.high : null,
      low: quoteDateOk ? quote.low : null,
      close: quoteDateOk ? quote.close : null,
      change_pct: quoteDateOk ? quote.change_pct : null,
      prev_close: quoteDateOk ? quote.prev_close : null,
      // 精确口径（仅来自 COMCEA 聚合，且仅在三方式齐全时给合计）；缺失保持 null，不用挂牌口径顶替
      listed_volume: statDateOk ? stat.listed_volume : null,
      listed_turnover: statDateOk ? stat.listed_turnover : null,
      block_volume: statDateOk ? stat.block_volume : null,
      block_turnover: statDateOk ? stat.block_turnover : null,
      auction_volume: statDateOk ? stat.auction_volume : null,
      auction_turnover: statDateOk ? stat.auction_turnover : null,
      total_volume: statDateOk ? stat.total_volume : null,
      total_turnover: statDateOk ? stat.total_turnover : null,
      year_volume: statDateOk ? stat.year_volume : null,
      year_turnover: statDateOk ? stat.year_turnover : null,
      lifetime_volume: statDateOk ? stat.lifetime_volume : null,
      lifetime_turnover: statDateOk ? stat.lifetime_turnover : null,
    };
    const partial = !(quoteDateOk && statDateOk);
    // 挂牌口径与精确挂牌值做交叉核对（两者应一致；dealQty 只覆盖挂牌，不是总量）；
    // 只有两个通道都确认同一天时才比较，避免跨日比较得出假一致/假不一致
    const caliberChecks = [];
    if (quoteDateOk && statDateOk && Number.isFinite(quote.listed_deal_volume) && Number.isFinite(stat.listed_volume)) {
      caliberChecks.push({
        field: 'listed_volume',
        from_market_by_date: quote.listed_deal_volume,
        from_substat: stat.listed_volume,
        equal: Math.abs(quote.listed_deal_volume - stat.listed_volume) <= 0.01,
        note: 'queryMarketByDate.dealQty 与 querySubStat 挂牌行应一致；不等时以 querySubStat 为准并留痕',
      });
    }

    const parse = {
      parse_status: partial ? 'partial' : 'ok',
      parse_note:
        `公开 JSON 通道：queryMarketByDate（OHLC，挂牌口径量额单列）+ querySubStat（COMCEA 精确聚合）。${stat.caliber_note || ''}` +
        (partial
          ? `其中 ${quoteMismatch ? `market_by_date 响应日期 ${channelDates.market_by_date || '无法解析'}` : ''}` +
            `${quoteMismatch && statMismatch ? '、' : ''}${statMismatch ? `substat 响应日期 ${channelDates.substat || '无法解析'}` : ''}` +
            ` 与请求日期 ${d} 不一致：对应字段保持 null，仅保留日期一致的通道（partial）。`
          : ''),
      period: 'day',
      trade_date: d,
      date_source: partial ? 'json_quotPoin(partial)' : 'json_quotPoin',
      date_candidates: [
        { date: d, source: 'request' },
        ...(quote.ok ? [{ date: quote.trade_date || null, source: 'queryMarketByDate.quotPoin' }] : []),
        ...(stat.ok ? [{ date: stat.trade_date || null, source: 'querySubStat.tradeDate' }] : []),
      ],
      date_consistent: !partial,
      channel_dates: channelDates,
      data_as_of: d,
      fields: row,
      raw_fields: { market_by_date: quote.ok ? quote : null, substat: stat.ok ? stat : null },
      units: {},
    };
    const up = upsertCeaTradeDaily({
      trade_date: d, fields: row, parse,
      meta: {
        sourceCode: 'cea_json_substat', sourceUrl: getCeaSourceByCode('cea_json_substat')?.url || 'https://shyx.cneeex.com/gateway/common/querySubStat',
        snapshotId: sub.snapshotId || mkt.snapshotId || null,
        contentHash: sub.hash || mkt.hash || null, fetchedAt: nowIso(), actor,
        dataAsOf: d, instrument: 'CEA', marketScope: 'national',
        note: `JSON 通道采集；OHLC 来源 queryMarketByDate（快照 ${mkt.snapshotId || '—'}），精确量额来源 querySubStat（快照 ${sub.snapshotId || '—'}）`,
      },
    });
    if (up.error) {
      out.failed.push({ date: d, reason: 'upsert_failed', message: up.error });
      continue;
    }
    if (caliberChecks.length) {
      saveCeaChecks('cea_trade_daily', up.id, caliberChecks.map((c) => ({
        check_key: `json_caliber_${c.field}`, label: '挂牌口径跨通道一致性', ok: c.equal, severity: 'warn',
        detail: `${c.note}（marketByDate=${c.from_market_by_date}，subStat=${c.from_substat}）`,
        expected: String(c.from_substat), actual: String(c.from_market_by_date),
      })));
    }
    // 官方日历与行情数据的交叉核对：官方休市日期列表里却出现有成交的交易日 → 如实标注
    // （真实样本：holidays.json 含 2026-10-14，而当日 JSON 行情显示有成交；由 AI 核验首先发现，
    //   这里补成确定性核对，不依赖模型也能看到）
    const holidayHit = get("SELECT trade_date,evidence_kind FROM cea_calendar WHERE trade_date=? AND day_type='holiday' AND source_state='current' LIMIT 1", [d]);
    if (holidayHit && Number.isFinite(row.total_volume) && row.total_volume > 0) {
      saveCeaChecks('cea_trade_daily', up.id, [{
        check_key: 'calendar_conflict',
        label: '官方休市列表与行情数据一致性',
        ok: false,
        severity: 'warn',
        detail:
          `该交易日在官方休市日期列表（${holidayHit.evidence_kind}）中，但当日官方行情显示有成交（成交量 ${row.total_volume} 吨）：` +
          '两个官方来源不一致，需人工核对日历证据或当日行情口径；两侧数据均保留，不做取舍。',
        expected: '休市日无成交', actual: `${d} 成交量 ${row.total_volume}`,
      }]);
    } else {
      // 之前可能标注过该冲突而本次已消除 → 用 ok=true 覆盖，避免陈旧失败项残留
      saveCeaChecks('cea_trade_daily', up.id, [{
        check_key: 'calendar_conflict', label: '官方休市列表与行情数据一致性', ok: true, severity: 'info',
        detail: '未发现该交易日同时被列为休市日与有成交的矛盾',
      }]);
    }
    // 来源层级留痕（精确 / 概览分开标记）。
    // 串日通道按**它自己的真实日期**留痕（若可解析），并注明「未写入请求日字段」；
    // 日期无法解析时不落来源行（无法归属到任何一天），只留缺口。
    if (mkt.ok && quote.ok) {
      recordQuoteSource({ trade_date: quote.trade_date || d, channel: 'market_by_date_json', sourceCode: 'cea_json_market_by_date',
        sourceUrl: getCeaSourceByCode('cea_json_market_by_date')?.url, snapshotId: mkt.snapshotId, contentHash: mkt.hash,
        parsed: quote, isPrecise: 0, isOverview: 0,
        note: quoteDateOk
          ? '综合行情 OHLC；dealQty/dealAmt 为挂牌口径，不作全方式成交'
          : `响应日期 ${quote.trade_date || '无法解析'} ≠ 请求日期 ${d}：本行按响应自身日期留痕，其数值未写入 ${d}` });
    }
    if (sub.ok && stat.ok) {
      recordQuoteSource({ trade_date: stat.trade_date || d, channel: 'substat_json', sourceCode: 'cea_json_substat',
        sourceUrl: getCeaSourceByCode('cea_json_substat')?.url, snapshotId: sub.snapshotId, contentHash: sub.hash,
        parsed: stat, isPrecise: 1, isOverview: 0,
        note: statDateOk
          ? `精确成交量额依据：COMCEA ${stat.methods_seen.length} 行按交易方式聚合${stat.complete ? '' : '（方式不完整，合计保持 null）'}`
          : `响应日期 ${stat.trade_date || '无法解析'} ≠ 请求日期 ${d}：本行按响应自身日期留痕，其数值未写入 ${d}` });
    }
    out.quote_sources.push({
      date: d, record_id: up.id, check_status: up.check_status, partial,
      channels: { market_by_date: quoteDateOk ? 'used' : quoteMismatch ? 'date_mismatch' : 'failed', substat: statDateOk ? 'used' : statMismatch ? 'date_mismatch' : 'failed' },
      substat_complete: stat.ok ? stat.complete !== false : false,
      created: !!up.created, revised: !!up.revised, unchanged: !!up.unchanged,
    });
    // 该交易日已成功入库 → 结清此前登记的失败/串日缺口（历史记录保留，不删除）；
    // 但只有对应通道本次确实「同日」时才结清该通道的串日缺口，否则缺口继续保持打开。
    closeCeaGapsByPrefixes([`cea:json:failed:${d}`], { note: `${d} 公开 JSON 通道本次已成功入库，此前失败缺口结清`, actor });
    if (quoteDateOk) {
      closeCeaGapsByPrefixes([`cea:json:date_mismatch:${d}:market_by_date`], { note: `${d} 综合行情通道本次响应日期一致`, actor });
    }
    if (statDateOk) {
      closeCeaGapsByPrefixes([`cea:json:date_mismatch:${d}:substat`], { note: `${d} 精确量额通道本次响应日期一致`, actor });
    }
    if (stat.ok && stat.complete !== false) {
      closeCeaGapsByPrefixes([`cea:json:substat_incomplete:${d}`], { note: `${d} 分方式量额本次齐全`, actor });
    }
    // 只有真正解析出数值才结清「无成交额/字段缺失」类的取值缺口
    if (statDateOk && stat.total_volume !== null) {
      closeCeaGapsByPrefixes([`cea:json:novalue:${d}`], { note: `${d} 已取得精确成交量额`, actor });
    }

    // 3) 概览层（单独保存，不覆盖精确值）
    if (left() > 2000) {
      const ov = await fetchJsonChannel('cea_json_dailyov', { actor, timeoutMs: cfg.request_timeout_ms, deadlineAt: deadline });
      if (ov.ok) {
        const parsedOv = parseDailyOverview(ov.payload);
        if (parsedOv.ok) {
          // 概览可能滞后一个交易日（实测：hiskline 已到 10-14 时 dailyov 仍为 10-13）。
          // 概览属于**它自己的日期**，因此按 trade_date 落库，而不是硬塞给目标日期；
          // 若该日期还没有精确行情，交叉核对自然为空并如实留痕。
          const ovDate = parsedOv.trade_date;
          const saved = upsertCeaOverview(parsedOv, {
            sourceCode: 'cea_json_dailyov', sourceUrl: getCeaSourceByCode('cea_json_dailyov')?.url,
            snapshotId: ov.snapshotId, contentHash: ov.hash, fetchedAt: nowIso(),
          });
          out.overlays[ovDate] = {
            ok: true, id: saved.id, cross_checks: saved.cross_checks || [],
            lagged: ovDate !== d,
            note: ovDate === d
              ? '概览日期与目标交易日一致'
              : `概览日期 ${ovDate} 与目标交易日 ${d} 不一致：已按概览自身日期落库（官方概览可能滞后），未张冠李戴`,
          };
          recordQuoteSource({ trade_date: ovDate, channel: 'dailyov_json', sourceCode: 'cea_json_dailyov',
            sourceUrl: getCeaSourceByCode('cea_json_dailyov')?.url, snapshotId: ov.snapshotId, contentHash: ov.hash,
            parsed: parsedOv, isPrecise: 0, isOverview: 1,
            note: '概览层（舍入展示值）：仅供展示与交叉核对，不覆盖精确成交量额' });
          const allCross = saved.cross_checks || [];
          const targetRow = ovDate === d ? up.id : get('SELECT id FROM cea_trade_daily WHERE trade_date=? LIMIT 1', [ovDate])?.id;
          if (allCross.length && targetRow) {
            // 通过与否都要写回：否则此前因容差配置不当留下的失败记录会一直残留（实测踩坑）
            saveCeaChecks('cea_trade_daily', targetRow, allCross.map((c) => ({
              check_key: `overview_cross_${c.field}`,
              label: '概览层与精确值交叉核对',
              ok: !!c.within_rounding,
              severity: c.within_rounding ? 'info' : 'warn',
              detail: c.note,
              expected: String(c.precise),
              actual: String(c.overview_approx),
            })));
          }
          if (allCross.some((c) => !c.within_rounding)) {
            out.failed.push({
              date: ovDate, channel: 'dailyov', reason: 'overview_exceeds_rounding',
              message: `概览层与精确值差异超出展示舍入容差：${allCross.filter((c) => !c.within_rounding).map((c) => c.field).join('、')}（已标注，不覆盖任何一侧）`,
            });
          }
        } else {
          out.failed.push({ date: d, channel: 'dailyov', reason: 'overview_parse_failed', message: parsedOv.reason });
        }
      } else {
        out.failed.push({ date: d, channel: 'dailyov', reason: ov.reason, message: ov.message });
      }
    }
  }

  // 4) 官方休市日历证据
  if (left() > 2000) {
    const hol = await fetchJsonChannel('cea_json_holidays', { actor, timeoutMs: cfg.request_timeout_ms, deadlineAt: deadline });
    if (hol.ok) {
      const parsedHol = parseHolidays(hol.payload);
      if (parsedHol.ok) {
        // 只有「成功 + 完整 + 非空」的快照才同步当前有效集合：此时官方已从列表删除的旧日期
        // 会被标为过期（保留原文与快照），不再作为当前事实或永久告警依据；失败/不完整结果不清空原集合。
        const completeSnapshot = parsedHol.invalid.length === 0 && parsedHol.dates.length > 0;
        const saved = upsertCeaCalendarDates(parsedHol.dates, {
          evidenceKind: 'holidays_json', sourceCode: 'cea_json_holidays',
          evidenceUrl: getCeaSourceByCode('cea_json_holidays')?.url, snapshotId: hol.snapshotId,
          note: parsedHol.note, complete: completeSnapshot,
        });
        out.calendar = {
          ok: true, ...saved, invalid: parsedHol.invalid, snapshot_id: hol.snapshotId,
          snapshot_complete: completeSnapshot,
          complete_note: completeSnapshot
            ? '本次为成功且完整的来源快照：已同步当前有效集合（来源删除的旧日期标为过期并保留原文）'
            : '本次结果不完整（存在无法解析的日期或数组为空）：按纪律不清空原当前集合，仅做增量补充',
        };
        recordQuoteSource({ trade_date: parsedHol.dates[parsedHol.dates.length - 1] || todayCst(), channel: 'holidays_json',
          sourceCode: 'cea_json_holidays', sourceUrl: getCeaSourceByCode('cea_json_holidays')?.url,
          snapshotId: hol.snapshotId, contentHash: hol.hash, parsed: { count: parsedHol.dates.length },
          isPrecise: 0, isOverview: 0, note: '官方休市日期证据（CEA 独立日历）' });
        // 三方核对：正式公告 / 机器辅助列表 / 实际成交。
        // 机器列表把有成交的交易日标成休市 → 独立告警、保留原文、不判行情不真实、不生成人工复核任务。
        const recon = reconcileCeaCalendar({ actor });
        out.calendar.reconcile = recon;
        out.calendar.priority_note =
          '正式全年休市公告（official_notice）优先于本机器辅助列表（holidays_json）；' +
          '两者矛盾时保留双方原文并单独告警，实际成交记录证明该日仍在交易。';
        closeCeaGapsByPrefixes(['cea:json:holidays'], { note: 'holidays.json 本次采集成功', actor });
      }
    } else {
      out.failed.push({ channel: 'holidays', reason: hol.reason, message: hol.message });
      recordCeaGap({
        dataset: CEA_GAP_DATASETS.trade,
        title: 'CEA 官方休市日历证据不可用',
        description: `holidays.json 采集失败（${hol.reason}：${hol.message || ''}）。`,
        impact: 'CEA 日历缺少官方休市证据；不影响已入库行情。', severity: 'normal', gapKey: 'cea:json:holidays',
      });
    }
  }

  // 5) AI 证据一致性核验（共享总 deadline，避免模型等待超出批次预算）
  if (cfg.auto_verify && left() > 3000) {
    out.verified = await verifyCollectedCea(out.quote_sources.map((s) => s.record_id), { actor, cfg, deadlineAt: deadline });
  }

  const okDates = out.quote_sources.filter((s) => s.check_status !== 'fail').length;
  if (ownJob) {
    closeCeaJob(job.id, {
      status: out.quote_sources.length ? (out.failed.length ? 'partial' : 'success') : 'failed',
      found: targetDates.length, parsed: out.quote_sources.length, validated: okDates, published: out.quote_sources.length,
      errors: out.failed.length,
      errorSummary: out.failed.length ? out.failed.slice(0, 5).map((f) => `${f.date || f.channel || '?'}：${f.reason} ${f.message || ''}`).join('；').slice(0, 900) : null,
      dataAsOf: out.quote_sources.length ? out.quote_sources.map((s) => s.date).sort().slice(-1)[0] : null,
      detail: { ...out, elapsed_ms: Date.now() - started },
    });
  }
  run(
    `INSERT INTO dataset_cursor (dataset,last_attempt_at,last_status,last_success_at,last_error,items_seen,items_new)
     VALUES ('cea_json_daily',?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_status=excluded.last_status,
       last_success_at=excluded.last_success_at, last_error=excluded.last_error,
       items_seen=excluded.items_seen, items_new=excluded.items_new`,
    [nowIso(), out.failed.length ? (out.quote_sources.length ? 'partial' : 'failed') : 'ok',
      out.quote_sources.length ? nowIso() : null,
      out.failed.length ? `${out.failed.length} 项失败` : null, targetDates.length, out.quote_sources.length]
  );
  out.elapsed_ms = Date.now() - started;
  audit({ actor, action: 'cea.collect_json_daily', objectType: 'ingestion_job', objectId: job.id, detail: { dates: targetDates, published: out.quote_sources.length, failed: out.failed.length, elapsed_ms: out.elapsed_ms } });
  return out;
}

/**
 * 抓取一个公开 JSON 通道并保存原始快照。
 * 业务码失败（success!==true / code!==200）与 JSON 非法都判为失败，不当成成功。
 */
export async function fetchJsonChannel(code, { actor = 'system:cea-collect', timeoutMs = CEA_DEFAULTS.request_timeout_ms, body = null, deadlineAt = null } = {}) {
  const src = getCeaSourceByCode(code);
  if (!src) return { ok: false, reason: 'unknown_source', message: `未登记的来源代码：${code}` };
  const allowed = src.allowed_domains?.length ? src.allowed_domains : DEFAULT_ALLOWED_DOMAINS;
  const chk = checkOutboundUrl(src.url, allowed);
  if (!chk.ok) return { ok: false, reason: 'blocked_url', message: chk.reason };
  const res = await fetchText(src.url, {
    allowedDomains: allowed, timeoutMs, retryMax: 1, rateLimitPerMin: 12,
    deadlineAt,
    method: src.method === 'POST' ? 'POST' : 'GET',
    headers: src.method === 'POST' ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : null,
    userAgent: 'CCER-Research-Platform/2.2 (CEA public JSON; low-frequency, contact: data-owner)',
  });
  if (!res.ok) {
    const snap = recordSnapshot({
      url: src.url, res: { status: res.status ?? null, hash: null, bytes: 0, body: null }, ceaSourceId: src.id,
      parseQuality: 'failed', parseNote: `JSON 通道抓取失败：${code}`, error: String(res.error || 'unknown').slice(0, 500),
    });
    return {
      ok: false, reason: res.reason || (res.status ? `http_${res.status}` : 'fetch_failed'),
      message: res.error, snapshotId: snap.id, deadline_exceeded: !!res.deadline_exceeded,
    };
  }
  let payload = null;
  try {
    payload = JSON.parse(res.body);
  } catch (e) {
    const snap = recordSnapshot({
      url: src.url, res, ceaSourceId: src.id, parseQuality: 'failed',
      parseNote: `JSON 通道返回非合法 JSON：${code}`, error: e.message.slice(0, 300),
    });
    return { ok: false, reason: 'json_invalid', message: `响应不是合法 JSON：${e.message}`, snapshotId: snap.id, hash: res.hash };
  }
  const snap = recordSnapshot({
    url: src.url, res, ceaSourceId: src.id, parseQuality: 'good',
    parseNote: `CEA 公开 JSON 通道：${code}（业务码校验在解析层执行）`,
  });
  markCeaSourceRun(code, { ok: true, itemsOk: 1 });
  return { ok: true, payload, snapshotId: snap.id, hash: res.hash, status: res.status };
}

/* ==================================================================== */
/*  六·C、PDF 正文提取（可读 PDF 自动提取，扫描件交管理员）             */
/* ==================================================================== */

/**
 * 用系统 `pdftotext` 提取 PDF 可读文本。
 *
 * 实现说明：**让 pdftotext 把结果写进临时文件，再用 readFileSync 读回**，
 * 而不是通过管道捕获子进程 stdout。原因：受限运行环境下「用管道捕获其它程序输出」
 * 会被拒绝（Node 的 child_process 默认 stdio:'pipe' → EPERM），而写文件是允许的；
 * 写文件同时也避免了 maxBuffer 对大 PDF 的限制。
 *
 * 提取为空 → 判定为扫描件，如实标记 `scan_suspected`，交由管理员补充，**不伪造正文**。
 * 未安装 pdftotext 时返回 unavailable，并说明需要安装（不静默降级成功）。
 */
export function extractPdfText(filePath, { timeoutMs = 60000 } = {}) {
  let outFile = null;
  try {
    const dir = join(PROJECT_ROOT, 'data', 'cea-attachments');
    mkdirSync(dir, { recursive: true });
    outFile = join(dir, `.pdftotext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    const r = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, outFile], {
      timeout: timeoutMs, windowsHide: true, stdio: 'ignore',
    });
    if (r.error) {
      const code = r.error.code || r.error.errno || '';
      return {
        ok: false,
        status: code === 'EPERM' || /EPERM/.test(String(r.error.message)) ? 'blocked' : 'unavailable',
        reason: `无法运行 pdftotext（${code || r.error.message}）：需要系统安装 poppler-utils/pdftotext 且允许子进程写文件`,
      };
    }
    if (r.status !== 0) {
      return { ok: false, status: 'failed', reason: `pdftotext 退出码 ${r.status}` };
    }
    if (!existsSync(outFile)) {
      return { ok: false, status: 'failed', reason: 'pdftotext 未生成输出文件' };
    }
    const text = String(readFileSync(outFile, 'utf8')).replace(/\u0000/g, '').trim();
    if (!text) {
      return {
        ok: false, status: 'scan_suspected', text: '',
        reason: 'pdftotext 提取为空：多为扫描件（图片型 PDF），需管理员上传可读副本或 OCR，不能伪造正文',
      };
    }
    return { ok: true, status: 'extracted', text, chars: text.length };
  } catch (e) {
    return { ok: false, status: 'failed', reason: `pdftotext 调用异常：${e.message}` };
  } finally {
    if (outFile && existsSync(outFile)) {
      try { rmSync(outFile, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }
}

/* ==================================================================== */
/*  七、AI 证据一致性核验                                               */
/* ==================================================================== */

/**
 * 对刚采集的 CEA 行情行与文件跑既有核验链路。
 * **未配置模型/凭据缺失 → 保持 unavailable，不伪造 verified**（CEA-08/CEA-09）。
 *
 * `deadlineAt`：整批采集的共享总 deadline。每子批次 120 秒之外若再叠加多次 45 秒模型等待，
 * 会让任务实际耗时失控，因此这里：
 *   - 共享同一个 deadline，超时即停止并说明「未处理部分留待下一批」；
 *   - 把剩余时间传给模型调用（`timeoutMs`），不再套用默认 45 秒。
 */
export async function verifyCollectedCea(recordIds = [], { actor = 'system:cea-verify', cfg = ceaCollectConfig(), limit = 8, deadlineAt = null, minRemainingMs = 8000 } = {}) {
  const vcfg = verifyConfig();
  const provider = pickVerifyProvider(vcfg);
  const out = {
    provider_configured: !!provider,
    provider_id: provider?.id || null,
    model: provider?.model || null,
    attempts: 0, verified: 0, insufficient: 0, conflict: 0, unavailable: 0, cached: 0, failed: 0, skipped: 0,
    deferred: 0, deadline_shared: !!deadlineAt, note: null,
  };
  if (!provider) {
    out.note = '未配置可用模型或模型未启用：CEA 条目保持 unverified，不伪造 verified。';
    return out;
  }
  const ids = (recordIds || []).filter(Boolean).slice(0, Math.min(limit, 8));
  for (const id of ids) {
    const remaining = deadlineAt ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    if (remaining < minRemainingMs) {
      out.deferred += 1;
      out.note = `批次总时间上限已到：剩余 ${Math.max(0, remaining)} ms 不足以完成模型核验，${out.deferred} 条留待下一批（不阻塞 CCER 每日任务）。`;
      break;
    }
    out.attempts += 1;
    try {
      const r = await verifyObject('cea_trade_daily', id, {
        actor, cfg: vcfg,
        // 模型请求时限取「批次剩余时间」与 provider 配置的真正较小值（callVerifyModel 内部再取 min(provider, caller, 60000)）
        timeoutMs: Math.min(60000, Math.max(2000, remaining - 2000)),
      });
      if (r.cached) out.cached += 1;
      else if (r.skipped) out.skipped += 1;
      else if (r.result && out[r.result] !== undefined) out[r.result] += 1;
      else if (r.ok === false) out.failed += 1;
    } catch (e) {
      out.failed += 1;
      out.note = `核验异常：${e.message}`;
    }
  }
  return out;
}

/**
 * 对 CEA 政策/技术/研究文件跑核验（证据等级不足时会判 insufficient，不伪造通过）。
 *
 * @param {object} o
 * @param {string[]|null} o.ids       指定要核验的 CEA 文件 id（如「本批刚采集的文件」）；null = 按待核验列表取
 * @param {number|null}   o.deadlineAt 共享批次 deadline：剩余不足时不再发起调用并如实记 deferred
 */
export async function verifyCeaDocuments({
  actor = 'system:cea-verify', limit = 8, ids = null, cfg: _cfg = null, deadlineAt = null, minRemainingMs = 8000,
} = {}) {
  const vcfg = verifyConfig();
  const provider = pickVerifyProvider(vcfg);
  const remaining = () => (deadlineAt ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY);
  const max = Math.min(Number(limit) || 8, 20);
  const rows = Array.isArray(ids) && ids.length
    ? ids.slice(0, max).map((id) => ({ id }))
    : all(
      // 默认只取真的需要核验、且**确实有全文**的条目（没有正文的条目核验无意义，也避免空跑）
      `SELECT id FROM cea_document
        WHERE COALESCE(ai_status,'unverified') NOT IN ('verified','conflict')
          AND evidence_level IN ('full_text','partial')
        ORDER BY COALESCE(fetched_at,'') DESC, COALESCE(publish_date,'') DESC LIMIT ?`,
      [max]
    );
  const out = {
    provider_configured: !!provider, provider_id: provider?.id || null, provider_model: provider?.model || null,
    requested: Array.isArray(ids) ? ids.length : null,
    attempts: 0, verified: 0, insufficient: 0, conflict: 0, unavailable: 0, cached: 0, failed: 0,
    deferred: 0, deadline_shared: !!deadlineAt, details: [],
  };
  if (!provider) {
    out.note = '未配置可用模型：CEA 文件保持 unverified（证据不足不等于核验通过）。';
    return out;
  }
  for (const r of rows) {
    const left = remaining();
    if (left < minRemainingMs) {
      out.deferred = rows.length - out.attempts;
      out.note = `批次总时间上限已到：剩余 ${Math.max(0, Math.round(left))}ms 不足以完成模型核验，${out.deferred} 条留待每日有界补跑（不阻塞 CCER 每日任务）。`;
      break;
    }
    out.attempts += 1;
    try {
      const res = await verifyObject('cea_document', r.id, {
        actor, cfg: vcfg,
        timeoutMs: Math.min(60000, Math.max(2000, left - 2000)),
      });
      if (res.cached) out.cached += 1;
      else if (res.result && out[res.result] !== undefined) out[res.result] += 1;
      else if (res.ok === false) out.failed += 1;
      out.details.push({ id: r.id, result: res.result || null, cached: !!res.cached, note: res.capability_note || res.summary || null });
    } catch (e) {
      out.failed += 1;
      out.details.push({ id: r.id, error: e.message });
    }
  }
  return out;
}

/**
 * 每日**有界补跑**：把此前因批次预算不足而 deferred、或仍待核验的 CEA 文件，
 * 在后续批次里继续送模型核验（每次仍受共享 deadline 约束，不无限占用）。
 */
export async function verifyCeaDocumentsCatchUp({ actor = 'system:cea-verify', limit = 4, deadlineAt = null } = {}) {
  const pending = get(
    `SELECT COUNT(*) AS c FROM cea_document
      WHERE COALESCE(ai_status,'unverified')='unverified' AND evidence_level IN ('full_text','partial')`
  )?.c || 0;
  const out = { pending_before: Number(pending), ...(await verifyCeaDocuments({ actor, limit, deadlineAt })) };
  out.pending_after = get(
    `SELECT COUNT(*) AS c FROM cea_document
      WHERE COALESCE(ai_status,'unverified')='unverified' AND evidence_level IN ('full_text','partial')`
  )?.c || 0;
  return out;
}

/* ==================================================================== */
/*  九、管理员采集：后台有界任务（POST 立即 202 + task_id）               */
/* ==================================================================== */

/** 管理员可触发的采集目标（与 API 允许值一致） */
export const CEA_COLLECT_TARGETS = ['json', 'daily', 'documents', 'entities', 'intentions', 'research', 'all'];

/** 进程内任务登记表：POST 立即返回 task_id，采集在后台有界执行；GET /jobs 可看到 queued/running/结束与错误 */
const CEA_TASKS = new Map();
const CEA_TASK_KEEP = 50;

function publicTask(t) {
  return {
    task_id: t.id, target: t.target, status: t.status,
    queued_at: t.queued_at, started_at: t.started_at, finished_at: t.finished_at,
    elapsed_ms: t.started_at ? (t.finished_at ? Date.parse(t.finished_at) - Date.parse(t.started_at) : Date.now() - Date.parse(t.started_at)) : null,
    job_id: t.job_id || null, actor: t.actor, error: t.error || null,
    result_summary: t.result ? summarizeCeaResult(t.target, t.result) : null,
    result: t.result || null,
  };
}

/** 把采集结果压成可读摘要：无结果时绝不能显示「完成」 */
export function summarizeCeaResult(target, out = {}) {
  if (!out || typeof out !== 'object') return { status: 'failed', note: '未返回结果' };
  if (out.error) return { status: 'failed', note: `失败：${out.error}` };
  // 只有**布尔 true** 才表示整批未执行（预算到点 / 停用 / 收盘后关闭）。
  // research、daily 等采集器把 skipped 初始化为**逐条跳过原因数组**（含空数组），
  // 而空数组在 JS 中也是真值：用真值判断会把真实成功的批次误报成 skipped。
  if (out.skipped === true) return { status: 'skipped', note: out.message || out.reason || '本次未执行' };
  if (out.reused) return { status: 'running', note: out.message || '已合并到运行中的任务' };
  let published = 0;
  let failed = 0;
  if (target === 'json') { published = out.quote_sources?.length || 0; failed = out.failed?.length || 0; }
  else if (target === 'daily') { published = out.collected?.length || 0; failed = out.failed?.length || 0; }
  else if (target === 'documents') { published = out.ok?.length || 0; failed = out.failed?.length || 0; }
  else if (target === 'entities') { published = out.rows_parsed || ((out.entities_created || 0) + (out.entities_updated || 0)); failed = out.failed?.length || 0; }
  else if (target === 'intentions') { published = out.rows || 0; failed = out.failed ? 1 : 0; }
  else if (target === 'research') { published = out.published || 0; failed = out.failed?.length || 0; }
  else if (target === 'all') {
    const parts = ['json', 'daily', 'documents', 'intentions', 'research'].map((k) => out[k]).filter(Boolean);
    published = parts.reduce((n, p) => n + (p.quote_sources?.length || p.collected?.length || p.ok?.length || p.rows || p.published || 0), 0);
    failed = parts.reduce((n, p) => n + (p.failed?.length || 0), 0) + (out.error ? 1 : 0);
  }
  const status = published > 0 ? (failed ? 'partial' : 'success') : 'failed';
  const note = published > 0
    ? `取得 ${published} 项结果${failed ? `，${failed} 项失败` : ''}`
    : `未取得任何结果${failed ? `（${failed} 项失败）` : ''}：${errorSummaryOf(out) || '无可用结果'}`;
  return { status, published, failed, note: String(note).slice(0, 500) };
}

function errorSummaryOf(out = {}) {
  const f = out.failed || out.gaps || [];
  if (Array.isArray(f) && f.length) return f.slice(0, 3).map((x) => `${x.date || x.channel || x.url || x.source || ''} ${x.reason || ''} ${x.message || x.note || ''}`.trim()).join('；');
  return out.error_summary || out.note || null;
}

/** 同一目标的运行中任务（用于重入合并） */
export function ceaCollectTaskForTarget(target) {
  return [...CEA_TASKS.values()].find((t) => t.target === target && (t.status === 'queued' || t.status === 'running')) || null;
}

export function getCeaCollectTask(taskId) {
  const t = CEA_TASKS.get(String(taskId));
  return t ? publicTask(t) : null;
}

export function listCeaCollectTasks({ limit = 20 } = {}) {
  return [...CEA_TASKS.values()]
    .sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)))
    .slice(0, Math.min(Number(limit) || 20, CEA_TASK_KEEP))
    .map(publicTask);
}

/**
 * 立即受理一个采集请求：返回 202 语义的 { task_id, status }，采集在后台有界执行。
 * 重入：同一目标已有 queued/running 任务 → 合并到该任务（不重复抓取、不改动原任务状态）。
 */
export function startCeaCollectTask({ target = 'daily', body = {}, actor = 'system:cea', cfg = ceaCollectConfig() } = {}) {
  if (!CEA_COLLECT_TARGETS.includes(target)) {
    return { error: `未知采集目标：${target}`, allowed: CEA_COLLECT_TARGETS, status: 400 };
  }
  if (ceaCollectTaskForTarget(target)) {
    const existing = ceaCollectTaskForTarget(target);
    return { ...publicTask(existing), merged: true, accepted: true, http_status: 202, message: `该目标已有${existing.status === 'queued' ? '排队' : '运行'}中的采集任务（task=${existing.id}），本次请求合并，不重复抓取。` };
  }
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const id = newId('CEATASK');
  const task = {
    id, target, status: 'queued', queued_at: nowIso(), started_at: null, finished_at: null,
    actor, result: null, error: null, job_id: null, budget_ms: budget,
  };
  CEA_TASKS.set(id, task);
  // 后台执行：不 await，不阻塞 HTTP 响应；异常一律收尾为 failed（不留 queued/running）
  setTimeout(() => {
    runCeaCollectTask(id, { target, body, actor, cfg, budget }).catch((e) => {
      task.status = 'failed';
      task.error = `后台任务异常：${e.message}`;
      task.finished_at = nowIso();
    });
  }, 0);
  trimCeaTasks();
  audit({ actor, action: 'cea.collect_task_accepted', objectType: 'cea_task', objectId: id, detail: { target, budget_ms: budget } });
  return { ...publicTask(task), accepted: true, http_status: 202 };
}

function trimCeaTasks() {
  const list = [...CEA_TASKS.values()].sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)));
  for (const t of list.slice(CEA_TASK_KEEP)) CEA_TASKS.delete(t.id);
}

async function runCeaCollectTask(id, { target, body, actor, cfg, budget }) {
  const task = CEA_TASKS.get(id);
  if (!task) return;
  task.status = 'running';
  task.started_at = nowIso();
  const deadlineAt = Date.now() + budget;
  try {
    const out = await runCeaCollectTarget({ target, body, actor, cfg, deadlineAt });
    task.result = out;
    const sum = summarizeCeaResult(target, out);
    task.status = sum.status === 'running' ? 'running' : sum.status;
    task.job_id = out?.job_id || out?.merged_into_job_id || null;
    if (task.status === 'failed') task.error = sum.note;
    if (out?.error) { task.status = 'failed'; task.error = out.error; }
  } catch (e) {
    task.status = 'failed';
    task.error = `采集异常：${e.message}`;
  } finally {
    if (task.status === 'running') task.status = 'failed';
    task.finished_at = nowIso();
    audit({ actor, action: 'cea.collect_task_finished', objectType: 'cea_task', objectId: id, detail: { target, status: task.status, job_id: task.job_id }, result: task.status === 'success' ? 'ok' : 'warning' });
  }
}

/**
 * 按目标执行一次有界采集（管理员手动与后台任务共用同一实现）。
 * 所有子采集器都接收同一个 deadlineAt，绝不各自重置批次预算。
 */
export async function runCeaCollectTarget({ target = 'daily', body = {}, actor = 'system:cea', cfg = ceaCollectConfig(), deadlineAt = null } = {}) {
  const budget = Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const deadline = deadlineAt || Date.now() + budget;
  if (target === 'json') {
    return collectCeaJsonDaily({
      actor, trigger: 'manual', dates: Array.isArray(body.dates) ? body.dates : null, cfg, deadlineAt: deadline,
    });
  }
  if (target === 'daily') {
    return collectCeaDaily({
      actor, trigger: 'manual',
      dates: Array.isArray(body.dates) ? body.dates : null,
      sources: Array.isArray(body.sources) ? body.sources : null,
      onlyNew: body.onlyNew !== false,
      limit: Number(body.limit) || null,
      cfg, deadlineAt: deadline,
    });
  }
  if (target === 'documents') {
    return collectCeaDocuments({ actor, trigger: 'manual', codes: Array.isArray(body.codes) ? body.codes : null, cfg, deadlineAt: deadline });
  }
  if (target === 'entities') {
    return collectCeaEntities({
      actor, trigger: 'manual', codes: Array.isArray(body.codes) ? body.codes : null,
      listYear: body.list_year ? Number(body.list_year) : null, province: body.province || null, cfg, deadlineAt: deadline,
    });
  }
  if (target === 'intentions') {
    return collectCeaIntentions({ actor, trigger: 'manual', cfg, deadlineAt: deadline });
  }
  if (target === 'research') {
    return collectCeaResearch({
      actor, trigger: 'manual', cfg, limit: Number(body.limit) || 6,
      queries: Array.isArray(body.queries) ? body.queries : null, deadlineAt: deadline,
    });
  }
  if (target === 'all') {
    return runCeaDailyStep({ actor, trigger: 'manual', cfg, deadlineAt: deadline });
  }
  return { error: `未知采集目标：${target}`, allowed: CEA_COLLECT_TARGETS, status: 400 };
}

/* ==================================================================== */
/*  八、每日调度入口（不改变既有 CCER 调度）                             */
/* ==================================================================== */

/**
 * CEA 每日批次：接入现有 06:30 任务的**增量步骤**，也可由管理员手动或收盘后触发。
 * 严格有界：超时/超量立即收尾；某一来源失败不中断全站采集，也不把上一日行情标成当日。
 */
export async function runCeaDailyStep({ actor = 'system:cea-daily', trigger = 'schedule', cfg = ceaCollectConfig(), deadlineAt = null } = {}) {
  if (!cfg.enabled) {
    return { skipped: true, reason: 'disabled', message: 'CEA 采集已停用（后台配置）' };
  }
  // 先确保来源登记与基础数据存在（幂等），再采集
  seedCeaBaseData({ actor: 'system:cea-seed' });
  const summary = { trigger, started_at: nowIso(), json: null, daily: null, documents: null };
  // 共享总 deadline：所有子步骤与模型核验都必须在同一预算内完成
  const started = Date.now();
  const deadlineAtMs = deadlineAt || started + Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
    try {
    // 公开 JSON 通道优先：源目录可能滞后，JSON 才能给出当前行情日期（CEA-16）
    summary.json = await collectCeaJsonDaily({ actor, trigger, cfg, deadlineAt: deadlineAtMs });
  } catch (e) {
    summary.json = { error: e.message };
  }
  if (Date.now() < deadlineAtMs) {
    try {
      summary.daily = await collectCeaDaily({ actor, trigger, cfg, deadlineAt: deadlineAtMs });
    } catch (e) {
      summary.daily = { error: e.message };
    }
  } else {
    summary.daily = { skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，日报 HTML 通道留待下一批（不阻塞 CCER 每日任务）' };
  }
  if (Date.now() < deadlineAtMs) {
    try {
      summary.documents = await collectCeaDocuments({ actor, trigger, cfg, deadlineAt: deadlineAtMs });
    } catch (e) {
      summary.documents = { error: e.message };
    }
  } else {
    summary.documents = { skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，文件通道留待下一批' };
  }
  // 意向通道（公开 JSON，轻量；同样受共享 deadline 约束）
  if (Date.now() < deadlineAtMs) {
    try {
      summary.intentions = await collectCeaIntentions({ actor, trigger, cfg, deadlineAt: deadlineAtMs });
    } catch (e) {
      summary.intentions = { error: e.message };
    }
  } else {
    summary.intentions = { skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，意向通道留待下一批' };
  }
  // 研报/动态：有界定向发现（受同一 deadline 约束，模型核验也在预算内）
  if (deadlineAtMs - Date.now() > 15000) {
    try {
      summary.research = await collectCeaResearch({ actor, trigger, cfg, limit: 3, deadlineAt: deadlineAtMs });
    } catch (e) {
      summary.research = { error: e.message };
    }
  } else {
    summary.research = { skipped: true, reason: 'batch_budget_exceeded', message: '批次剩余时间不足，研报/动态发现留待下一批' };
  }
  // 每日有界补跑：此前 deferred 或仍待核验的 CEA 文件（含本批未及核验的）继续送模型；
  // 仍受同一共享 deadline 约束，预算不足则如实记录「留待下一批」，不无限占用。
  if (Date.now() < deadlineAtMs - 12000) {
    try {
      summary.verify_catchup = await verifyCeaDocumentsCatchUp({ actor: 'system:cea-verify', limit: 4, deadlineAt: deadlineAtMs });
    } catch (e) {
      summary.verify_catchup = { error: e.message };
    }
  } else {
    summary.verify_catchup = { skipped: true, reason: 'batch_budget_exceeded', message: '批次剩余时间不足，待核验 CEA 文件留待下一批有界补跑' };
  }
  summary.deadline_ms = deadlineAtMs - started;
  summary.elapsed_ms = Date.now() - started;
  summary.finished_at = nowIso();
  return summary;
}

/**
 * CEA **收盘后轻量增量**（docs/35 第 7 条）：北京时间默认 16:30，
 * 只跑「行情（公开 JSON）+ 交易意向」两个轻量通道，与早上 06:30 的全平台更新分开；
 * 与每日批次共享同一套 deadline / 配额 / 重入保护，超限立即收尾。
 */
export async function runCeaAfterCloseStep({ actor = 'system:cea-after-close', trigger = 'schedule', cfg = ceaCollectConfig(), deadlineAt = null } = {}) {
  if (!cfg.enabled) {
    return { skipped: true, reason: 'disabled', message: 'CEA 采集已停用（后台配置），收盘后增量一并跳过' };
  }
  if (!cfg.after_close_enabled) {
    return { skipped: true, reason: 'after_close_disabled', message: '收盘后增量未启用（后台配置 after_close_enabled=false）' };
  }
  seedCeaBaseData({ actor: 'system:cea-seed' });
  const started = Date.now();
  const deadlineAtMs = deadlineAt || started + Math.max(5000, Number(cfg.batch_budget_ms) || CEA_DEFAULTS.batch_budget_ms);
  const summary = { trigger, started_at: nowIso(), scope: 'after_close', json: null, intentions: null, deadline_ms: deadlineAtMs - started };
  if (Date.now() < deadlineAtMs) {
    try {
      summary.json = await collectCeaJsonDaily({ actor, trigger, cfg, deadlineAt: deadlineAtMs });
    } catch (e) {
      summary.json = { error: e.message };
    }
  } else {
    summary.json = { skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，收盘后行情留待次日' };
  }
  if (Date.now() < deadlineAtMs) {
    try {
      summary.intentions = await collectCeaIntentions({ actor, trigger, cfg, deadlineAt: deadlineAtMs });
    } catch (e) {
      summary.intentions = { error: e.message };
    }
  } else {
    summary.intentions = { skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，收盘后意向留待次日' };
  }
  summary.elapsed_ms = Date.now() - started;
  summary.finished_at = nowIso();
  audit({
    actor, action: 'cea.after_close_step', objectType: 'cea_batch', objectId: null,
    detail: { json_published: summary.json?.quote_sources?.length || 0, intentions_rows: summary.intentions?.rows || 0, elapsed_ms: summary.elapsed_ms },
  });
  return summary;
}

/** CEA 同步状态（供 API/CLI 展示真实运行结果，不美化失败） */
export function ceaSyncStatus() {
  const cfg = ceaCollectConfig();
  const vcfg = verifyConfig();
  const provider = pickVerifyProvider(vcfg);
  return {
    config: cfg,
    quota: ceaQuotaState(cfg),
    ai: {
      verify_enabled: !!vcfg.enabled,
      provider_configured: !!provider,
      provider_id: provider?.id || null,
      model: provider?.model || null,
      note: provider ? null : '未配置可用模型：CEA 条目保持 unverified，不伪造 verified。',
    },
    search: (() => {
      const p = cfg.search_provider_id ? get('SELECT id,name,enabled,last_test_result FROM search_provider WHERE id=?', [cfg.search_provider_id]) : get('SELECT id,name,enabled,last_test_result FROM search_provider WHERE enabled=1 ORDER BY created_at LIMIT 1');
      return p ? { configured: true, id: p.id, name: p.name, enabled: !!p.enabled, last_test_result: p.last_test_result || null } : { configured: false };
    })(),
    fetch: (() => {
      const c = cfg.fetch_connection_id
        ? get('SELECT id,name,enabled,conn_kind FROM web_fetch_connection WHERE id=?', [cfg.fetch_connection_id])
        : get("SELECT id,name,enabled,conn_kind FROM web_fetch_connection WHERE enabled=1 AND archived=0 ORDER BY created_at LIMIT 1");
      return c ? { configured: true, id: c.id, name: c.name, enabled: !!c.enabled, conn_kind: c.conn_kind } : { configured: false };
    })(),
    cursors: all("SELECT * FROM dataset_cursor WHERE dataset LIKE 'cea%' ORDER BY dataset"),
    gaps: all("SELECT dataset, COUNT(*) AS c FROM data_gap WHERE dataset LIKE 'cea%' AND status='open' GROUP BY dataset"),
    last_jobs: all("SELECT id,job_key,status,started_at,finished_at,items_found,items_published,error_count,error_summary FROM ingestion_job WHERE job_key LIKE 'cea%' ORDER BY started_at DESC LIMIT 8"),
  };
}

export { saveCeaChecks } from './cea-svc.mjs';
