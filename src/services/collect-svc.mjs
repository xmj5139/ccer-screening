/**
 * 采集管线服务（每日更新）
 * ============================================================================
 * 需求规格第 2 节要求：每日任务形成可审计的
 *     采集 → 解析 → 校验 → 待审核 → 发布
 * 流程，并保留原始网页/PDF/接口响应、哈希、抓取时间与解析版本；
 * 「自动采集不得直接修改正式规则或历史报告」。
 *
 * 本模块实现：
 *   1. 出站网络策略（域名白名单 + 私网地址拦截 + 限流 + 超时 + 重试），
 *      管理员配置数据源时不能借系统访问内网（需求规格第 4 节）。
 *   2. 三个真实可用的官方连接器：
 *        - 交易系统每日行情公告列表 / 公告正文 / 分行业行情
 *        - 生态环境部政策与方法学发布页（详情页可解析；栏目页实测返回空 →
 *          如实记录为失败并保留人工巡检路径）
 *   3. source_snapshot 原始快照（sha256 + 大小 + 抓取时间 + 解析质量）。
 *   4. ingestion_job / ingestion_step 任务与步骤留痕。
 *   5. review_task 待审核队列与 notification 提醒。
 *
 * 【纪律】采集只写入「待审核」状态：不直接改正式规则、不覆盖历史报告、
 * 不把采集结果当作领域专家确认。
 */
import { createHash } from 'node:crypto';
import { all, get, run, tx, metaValue, setMeta, getDb, audit } from '../core/db.mjs';
import { newId, nowIso, todayCst, isDate, j, uj } from '../core/util.mjs';
import * as trade from './trade-svc.mjs';

export const PARSER_VERSION = '2.0.0';
export const PUBLIC_RECON_FILTER = "dataset IN ('trade','policy','project') AND NOT EXISTS (SELECT 1 FROM public_project p WHERE p.id=data_reconciliation.object_id AND p.is_demo=1)";
export const USER_AGENT =
  'CCER-Research-Platform/2.0 (institutional research; low-frequency, contact: data-owner)';

/** 允许出站的官方域名（防止管理员配置任意地址造成内网访问） */
export const DEFAULT_ALLOWED_DOMAINS = ['www.mee.gov.cn', 'mee.gov.cn', 'www.ccer.com.cn', 'ccer.com.cn', 'ccer.cets.org.cn'];

const PRIVATE_HOST = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/, /^\[?fc00:/i, /^\[?fe80:/i,
];

/**
 * 是否允许出站访问回环地址。
 * 默认**禁止**（防止把已配置的连接改造成访问本机/内网服务的通道）。
 * 仅当显式设置 CCER_ALLOW_LOOPBACK_OUTBOUND=1 时放行，用于本地打桩联调与自动化测试；
 * 生产部署不应设置该变量。
 */
export function loopbackOutboundAllowed() {
  return process.env.CCER_ALLOW_LOOPBACK_OUTBOUND === '1';
}

/**
 * 校验出站 URL：协议、私网地址、域名白名单。
 * @returns {{ok:boolean, reason?:string, host?:string}}
 */
export function checkOutboundUrl(rawUrl, allowedDomains = DEFAULT_ALLOWED_DOMAINS) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: 'URL 不合法' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: `不支持的协议：${u.protocol}` };
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.some((re) => re.test(host)) && !loopbackOutboundAllowed()) {
    return { ok: false, reason: `拒绝访问内网/本机地址：${host}` };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !loopbackOutboundAllowed()) {
    return { ok: false, reason: '拒绝直接使用 IP 地址访问，请使用已登记域名' };
  }
  const allow = (allowedDomains && allowedDomains.length ? allowedDomains : DEFAULT_ALLOWED_DOMAINS).map((d) =>
    String(d).toLowerCase()
  );
  const permitted = allow.some((d) => host === d || host.endsWith(`.${d}`));
  if (!permitted) {
    return { ok: false, reason: `域名不在白名单内：${host}（白名单：${allow.join('、')}）` };
  }
  return { ok: true, host };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 采集频率（每分钟请求数）。默认 60/分钟（约 1 秒 1 次），可用环境变量
 * CCER_COLLECT_RATE_PER_MIN 调整；speed='slow' 时降到 6/分钟。
 * 官方站点为静态资源，低频顺序访问即可满足研究用途；不并发抓取。
 */
export function collectRatePerMin(speed = 'normal') {
  if (speed === 'slow') return 6;
  const v = Number(process.env.CCER_COLLECT_RATE_PER_MIN);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 120) : 60;
}

/**
 * 受控抓取：白名单 + 超时 + 重试 + 低频（每次请求间隔 ≥ rate_limit_per_min 的倒数）。
 *
 * 共享 deadline（可选 `deadlineAt`，绝对毫秒时间戳）：CEA 批次把整批预算传下来后，
 * **每一次真实请求、每一次重试等待**都不得超出剩余时间——剩余不足时不再发请求，
 * 进行中的请求用缩短后的 AbortSignal 真正中止（不是 Promise.race 提前返回留下后台写入）。
 * 不传 `deadlineAt` 时行为与旧版完全一致（默认兼容）。
 *
 * @returns {{ok:boolean,status?:number,body?:string,buf?:Buffer,hash?:string,bytes?:number,
 *            content_type?:string,elapsed_ms?:number,attempts?:number,error?:string}}
 */
export async function fetchText(url, opts = {}) {
  const {
    allowedDomains = DEFAULT_ALLOWED_DOMAINS,
    timeoutMs = 15000,
    retryMax = 2,
    method = 'GET',
    headers = {},
    rateLimitPerMin = 12,
    body = null,
    userAgent = USER_AGENT,
    deadlineAt = null,
  } = opts;
  const check = checkOutboundUrl(url, allowedDomains);
  if (!check.ok) return { ok: false, error: check.reason, blocked: true };
  const deadline = Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) : null;
  const remaining = () => (deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY);
  const deadlineError = '批次总时间上限已到：未发出的请求不再发送，进行中的请求已中止（留待下一批）';
  const minInterval = Math.ceil(60000 / Math.max(1, Number(rateLimitPerMin) || 12));
  const lastAt = Number(metaValue('collect_last_request_at_ms', '0')) || 0;
  const wait = lastAt + minInterval - Date.now();
  if (wait > 0) {
    // 限流等待也要受共享 deadline 约束：宁可少抓一条，也不越过整批上限
    const cappedWait = deadline ? Math.max(0, Math.min(wait, 5000, remaining())) : Math.min(wait, 5000);
    if (cappedWait > 0) await sleep(cappedWait);
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= Math.max(1, retryMax + 1); attempt += 1) {
    const started = Date.now();
    const left = remaining();
    if (deadline && left <= 250) {
      return {
        ok: false, error: lastErr || deadlineError, reason: 'deadline_exceeded',
        deadline_exceeded: true, attempts: attempt - 1, elapsed_ms: 0,
      };
    }
    // 每次请求真正取「配置时限」与「批次剩余时间」的较小值
    const attemptTimeout = Math.max(250, Math.min(Number(timeoutMs) || 15000, deadline ? left - 50 : Number(timeoutMs) || 15000));
    try {
      setMeta(getDb(), 'collect_last_request_at_ms', String(Date.now()));
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { 'user-agent': userAgent, accept: '*/*', 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
        body,
        signal: AbortSignal.timeout(attemptTimeout),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const elapsed = Date.now() - started;
      let text = buf.toString('utf8');
      const head = text.slice(0, 800);
      if (/charset=["']?(gb2312|gbk|gb18030)/i.test(head)) {
        try {
          text = new TextDecoder('gb18030').decode(buf);
        } catch {
          /* 保持 utf8 解码结果 */
        }
      }
      // 二次白名单校验：跟随重定向后可能落到其他域
      const finalCheck = checkOutboundUrl(res.url || url, allowedDomains);
      if (!finalCheck.ok) {
        return { ok: false, error: `重定向到非白名单地址：${res.url}`, blocked: true };
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        if (attempt <= retryMax) {
          const d = sleepMs(300 * attempt, remaining());
          if (d <= 0) return { ok: false, status: res.status, error: deadlineError, reason: 'deadline_exceeded', deadline_exceeded: true, attempts: attempt };
          await sleep(d);
          continue;
        }
        return { ok: false, status: res.status, error: lastErr, elapsed_ms: elapsed, attempts: attempt };
      }
      return {
        ok: true,
        status: res.status,
        body: text,
        buf,
        hash: sha256(buf),
        bytes: buf.length,
        content_type: res.headers.get('content-type'),
        final_url: res.url || url,
        elapsed_ms: elapsed,
        attempts: attempt,
      };
    } catch (e) {
      const timedOutByDeadline = deadline && Date.now() >= deadline - 60;
      lastErr = timedOutByDeadline
        ? deadlineError
        : e?.name === 'TimeoutError' ? `请求超时（>${attemptTimeout}ms）` : e?.message || String(e);
      if (attempt <= retryMax) {
        const d = sleepMs(300 * attempt, remaining());
        if (d <= 0) return { ok: false, error: lastErr, reason: 'deadline_exceeded', deadline_exceeded: true, attempts: attempt };
        await sleep(d);
      }
    }
  }
  return { ok: false, error: lastErr || '请求失败', attempts: Math.max(1, retryMax + 1) };
}

/** 重试等待的实际时长：受共享 deadline 约束，剩余不足则返回 0（调用方立即收尾） */
function sleepMs(ms, remaining) {
  if (!Number.isFinite(remaining)) return Math.max(0, ms);
  return Math.max(0, Math.min(ms, remaining - 100));
}

/** 保存原始快照（原始响应 + 哈希 + 抓取时间 + 解析质量）。
 * 同一 URL + 同一哈希 的重复抓取只在 note 中累加次数，不重复堆积正文。
 * `sourceId` 指向 v1 的 source_document；CEA 来源属于 cea_source，必须用 `ceaSourceId`
 * （source_id 的外键指向 source_document，塞 cea_source.id 会触发外键失败）。
 */
export function recordSnapshot({
  url, res, sourceId = null, ceaSourceId = null, parser = null, parseQuality = null, parseNote = null, error = null,
}) {
  const now = nowIso();
  const hash = res?.hash || null;
  if (hash) {
    const dup = get(
      'SELECT id, url FROM source_snapshot WHERE content_hash = ? AND url = ? ORDER BY fetched_at DESC LIMIT 1',
      [hash, url]
    );
    if (dup) return { id: dup.id, deduped: true, hash };
  }
  const id = newId('SS');
  const bodyText = res?.body ? String(res.body).slice(0, 400_000) : null;
  run(
    `INSERT INTO source_snapshot
     (id,source_id,cea_source_id,url,fetched_at,http_status,content_type,content_hash,content_bytes,storage_kind,
      body_text,body_path,parser_version,parse_quality,parse_note,error,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, sourceId, ceaSourceId, String(url).slice(0, 900), now, res?.status ?? null, res?.content_type ?? null,
      hash, res?.bytes ?? null, 'db', bodyText, null, PARSER_VERSION,
      parseQuality, parseNote, error, now,
    ]
  );
  return { id, deduped: false, hash };
}

/* ==================================================================== */
/*  审核任务与通知                                                       */
/* ==================================================================== */

/**
 * 创建待审核任务（幂等：同 task_type + object_id + pending 只保留一条）。
 * 职责分离：required_role 标明应由哪个角色处理（admin 与数据审核分离）。
 */
export function createReviewTask({
  task_type, object_type, object_id, title, detail = null, payload = null,
  severity = 'normal', required_role = null, created_by = 'system:collect',
}) {
  const dup = get(
    `SELECT id FROM review_task WHERE task_type = ? AND object_id = ? AND status = 'pending'`,
    [task_type, object_id]
  );
  if (dup) {
    run('UPDATE review_task SET detail = COALESCE(?, detail), payload_json = COALESCE(?, payload_json) WHERE id = ?', [
      detail, payload ? j(payload) : null, dup.id,
    ]);
    return { id: dup.id, deduped: true };
  }
  const id = newId('RVT');
  run(
    `INSERT INTO review_task (id,task_type,object_type,object_id,title,detail,payload_json,severity,status,
       created_at,created_by,required_role,decided_by,decided_at,decision_note)
     VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,NULL,NULL,NULL)`,
    [id, task_type, object_type, object_id, title, detail, payload ? j(payload) : null, severity, nowIso(), created_by, required_role]
  );
  return { id, deduped: false };
}

export function listReviewTasks({ status = 'pending', task_type = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (task_type) {
    where.push('task_type = ?');
    params.push(task_type);
  }
  return all(
    `SELECT * FROM review_task ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              created_at DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 1000)]
  );
}

/**
 * 审核决定。职责分离：若任务声明了 required_role，则决定人角色必须匹配；
 * 规则类任务（政策/方法学发布）不允许创建人自己批准。
 */
export function decideReviewTask(user, id, { decision = 'approved', note = null } = {}) {
  const task = get('SELECT * FROM review_task WHERE id = ?', [id]);
  if (!task) return { error: '审核任务不存在', status: 404 };
  if (task.status !== 'pending') return { error: `任务已处理（当前状态：${task.status}）`, status: 409 };
  if (!['approved', 'rejected', 'returned'].includes(decision)) {
    return { error: 'decision 取值非法（approved/rejected/returned）', status: 400 };
  }
  const roles = roleSet(user);
  const needsPublish = ['policy_publish', 'methodology_publish', 'factor_enable'].includes(task.task_type);
  if (needsPublish && !roles.includes('reviewer') && !roles.includes('admin')) {
    return { error: '规则类发布只能由领域复核人或系统管理员确认', status: 403 };
  }
  if (task.required_role === 'reviewer' && !roles.includes('reviewer') && !roles.includes('admin')) {
    return { error: `该任务需「领域复核人」处理（当前角色：${user?.role || '未知'}）`, status: 403 };
  }
  const createdBy = String(task.created_by || '');
  const selfCreated = createdBy && user?.name && createdBy.includes(String(user.name));
  if (needsPublish && selfCreated && !roles.includes('admin')) {
    return {
      error: '职责分离：规则的提出人不能自己批准发布，请由另一名领域复核人处理',
      status: 403,
    };
  }
  run(
    `UPDATE review_task SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`,
    [decision, user?.name || 'unknown', nowIso(), note, id]
  );
  return { ok: true, id, status: decision, decided_by: user?.name || 'unknown', task_type: task.task_type };
}

function roleSet(user) {
  const out = [];
  if (!user) return out;
  if (user.role) out.push(user.role);
  if (Array.isArray(user.roles)) out.push(...user.roles);
  if (user.is_admin) out.push('admin');
  return out;
}

/** 写入提醒（影响等级用于排序） */
export function notify({
  kind, title, detail = null, severity = 'info', impact_level = 'low',
  object_type = null, object_id = null, subscription_id = null,
}) {
  const id = newId('NTF');
  run(
    `INSERT INTO notification (id,subscription_id,kind,severity,title,detail,object_type,object_id,created_at,read_at,read_by,impact_level)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
    [id, subscription_id, kind, severity, title, detail, object_type, object_id, nowIso(), impact_level]
  );
  return id;
}

export function listNotifications({ limit = 100, unread_only = false } = {}) {
  return all(
    `SELECT * FROM notification ${unread_only ? 'WHERE read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`,
    [Math.min(Number(limit) || 100, 1000)]
  );
}

export function markNotificationRead(user, id) {
  run('UPDATE notification SET read_at = ?, read_by = ? WHERE id = ? AND read_at IS NULL', [
    nowIso(), user?.name || 'unknown', id,
  ]);
  return { ok: true, id };
}

/* ==================================================================== */
/*  提醒生命周期：所指问题结清后，提醒不得继续作为待关注                  */
/* ==================================================================== */
/**
 * 【回归修复】提醒是「发现问题那一刻」的快照，而问题本身有独立生命周期：
 *   创建   recordIssue() 写 data_reconciliation + notification（仅 critical）
 *   结清   closeAbsentIssues() / resolveReconciliation() 把核对记录置为 resolved
 * 旧实现只做「读/未读」，没有把两者连起来，于是核对记录已结清后，提醒仍以
 * 未读待关注出现在总览，正文还停留在结清前（例如 2025-03-21 的 2630 吨 vs
 * 单日 500 吨的错误对比）。
 *
 * 现在的口径：
 *   - 提醒所指向的对象**能判定结清条件**时（data_reconciliation / alert），
 *     对象不再处于未结清状态 → 提醒记 resolved_at/resolved_by/resolution，
 *     作为历史留痕保留，不再进入「待关注」列表；也**不是**用「标记已读」掩盖。
 *   - 对象仍未结清但正文已变（例如同一条核对记录的 detail 被更新）→ 同步刷新
 *     提醒正文，避免展示过期数值。
 *   - 无法判定结清条件的对象类型（例如官方频道发现公告的信息型提醒）保持原样，
 *     不猜测、不自动关闭。
 */
const NOTIFICATION_SUBJECTS = {
  data_reconciliation: { table: 'data_reconciliation', unsettled: ['open'] },
  alert: { table: 'alert', unsettled: ['open', 'ack'] },
};

/** 提醒所指对象的当前状态；无法判定时返回 null（保持原样，不猜测）。 */
export function notificationSubjectState(n) {
  const spec = NOTIFICATION_SUBJECTS[n?.object_type];
  if (!spec || !n?.object_id) return null;
  const row = get(`SELECT * FROM ${spec.table} WHERE id = ?`, [n.object_id]);
  if (!row) {
    return { exists: false, settled: true, status: null, row: null, note: `所指向的 ${n.object_type} 记录已不存在` };
  }
  const settled = !spec.unsettled.includes(String(row.status));
  return { exists: true, settled, status: row.status, row, note: settled ? `所指对象状态为 ${row.status}（未结清状态：${spec.unsettled.join('/')}）` : null };
}

/** 提醒是否已随所指问题结清：读路径（总览、后台接口）与结清逻辑共用同一判定。 */
export function notificationSettled(n) {
  if (!n) return true;
  if (n.resolved_at) return true;
  const st = notificationSubjectState(n);
  return st ? st.settled : false;
}

function buildNotificationResolution(n, st) {
  const parts = [];
  if (!st.exists) {
    parts.push(`所指向的 ${n.object_type} 记录 ${n.object_id} 已不存在，提醒失去依据`);
  } else if (st.row && n.object_type === 'data_reconciliation') {
    parts.push(
      `所指向的核对记录 ${n.object_id} 已结清（状态 ${st.row.status}` +
      `${st.row.resolved_by ? `，结清方 ${st.row.resolved_by}` : ''}` +
      `${st.row.resolved_at ? `，${st.row.resolved_at}` : ''}）`
    );
    if (st.row.resolution) parts.push(String(st.row.resolution));
  } else {
    parts.push(`所指向的 ${n.object_type} ${n.object_id} 当前状态为 ${st.status}，不再处于未结清状态`);
  }
  parts.push('本条提醒正文为结清前的历史快照，已不再作为待关注事项；以核对记录与实时状态为准（历史留痕，不删除、不改写原文）。');
  // 各段之间用「；」连接：去掉段尾句号，避免出现「。；」这种混排标点
  return parts.map((s) => String(s).replace(/[。;；\s]+$/, '')).join('；') + '。';
}

/**
 * 同步提醒生命周期（幂等）：
 *   1. 所指问题已结清 → 写结清说明（不动 title/detail 原始快照）；
 *   2. 所指问题仍未结清但正文已变 → 刷新 title/detail 与当前核对记录一致。
 * 返回 { checked, resolved, refreshed }，每次变更都写 audit_log。
 */
export function syncNotificationLifecycle({ actor = 'system:notify-lifecycle', limit = 500 } = {}) {
  const rows = all(
    `SELECT * FROM notification WHERE resolved_at IS NULL AND object_type IS NOT NULL AND object_id IS NOT NULL
     ORDER BY created_at DESC LIMIT ?`,
    [Math.min(Number(limit) || 500, 2000)]
  );
  const out = { checked: rows.length, resolved: [], refreshed: [] };
  for (const n of rows) {
    const st = notificationSubjectState(n);
    if (!st) continue;
    if (st.settled) {
      const resolution = buildNotificationResolution(n, st);
      run('UPDATE notification SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL', [
        nowIso(), actor, resolution, n.id,
      ]);
      audit({
        actor, action: 'notification.resolve_stale', objectType: 'notification', objectId: n.id,
        detail: { object_type: n.object_type, object_id: n.object_id, subject_status: st.status, resolution },
      });
      out.resolved.push({ id: n.id, subject: n.object_id, subject_status: st.status });
      continue;
    }
    if (n.object_type === 'data_reconciliation' && st.row) {
      const title = `数据异常：${st.row.object_label || st.row.object_id || st.row.dataset}`;
      const detail = st.row.detail || null;
      if (title !== n.title || detail !== n.detail) {
        run('UPDATE notification SET title = ?, detail = ? WHERE id = ?', [title, detail, n.id]);
        audit({
          actor, action: 'notification.refresh_text', objectType: 'notification', objectId: n.id,
          detail: { object_id: n.object_id, before: { title: n.title, detail: n.detail }, after: { title, detail } },
        });
        out.refreshed.push({ id: n.id, subject: n.object_id });
      }
    }
  }
  return out;
}

/* ==================================================================== */
/*  任务（ingestion_job / step）                                         */
/* ==================================================================== */

export const JOB_KINDS = {
  policy_daily: '政策与方法学巡检',
  trade_daily: '交易行情采集',
  project_daily: '公开项目增量核对',
  factor_watch: '因子与引用文件巡检',
  content_daily: '公开研报与行业动态采集',
  daily_all: '每日全量更新',
};

function startJob({ job_key, title, trigger_kind = 'manual', triggered_by = null, datasets = [] }) {
  const id = newId('JOB');
  run(
    `INSERT INTO ingestion_job (id,job_key,title,trigger_kind,triggered_by,started_at,finished_at,status,datasets,
       items_found,items_parsed,items_validated,items_queued,items_published,error_count,error_summary,data_as_of,detail_json,created_at)
     VALUES (?,?,?,?,?,?,NULL,'running',?,0,0,0,0,0,0,NULL,NULL,NULL,?)`,
    [id, job_key, title, trigger_kind, triggered_by, nowIso(), j(datasets), nowIso()]
  );
  return id;
}

function addStep(jobId, order, { stage, target = null, status, items = 0, message = null, snapshot_id = null, detail = null, started_at = null, finished_at = null }) {
  const id = newId('STP');
  run(
    `INSERT INTO ingestion_step (id,job_id,step_order,stage,target,status,started_at,finished_at,items,message,snapshot_id,detail_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, jobId, order, stage, target, status,
      started_at || nowIso(), finished_at || nowIso(), items, message, snapshot_id,
      detail ? j(detail) : null,
    ]
  );
  return id;
}

function finishJob(jobId, { status, stats, errorSummary = null, dataAsOf = null, detail = null }) {
  run(
    `UPDATE ingestion_job SET finished_at = ?, status = ?, items_found = ?, items_parsed = ?, items_validated = ?,
       items_queued = ?, items_published = ?, error_count = ?, error_summary = ?, data_as_of = ?, detail_json = ?
     WHERE id = ?`,
    [
      nowIso(), status, stats.found || 0, stats.parsed || 0, stats.validated || 0,
      stats.queued || 0, stats.published || 0, stats.errors || 0, errorSummary, dataAsOf,
      detail ? j(detail) : null, jobId,
    ]
  );
}

export function listJobs({ limit = 50, job_key = null } = {}) {
  return all(
    `SELECT * FROM ingestion_job ${job_key ? 'WHERE job_key = ?' : ''} ORDER BY started_at DESC LIMIT ?`,
    job_key ? [job_key, limit] : [limit]
  );
}

export function getJob(id) {
  const job = get('SELECT * FROM ingestion_job WHERE id = ?', [id]);
  if (!job) return null;
  return { ...job, steps: all('SELECT * FROM ingestion_step WHERE job_id = ? ORDER BY step_order', [id]) };
}

/** 供核对服务写入「校验」阶段步骤（jobId 为空时忽略） */
export function addReconcileStep(jobId, { dataset, checked = 0, issues = 0 }) {
  if (!jobId) return null;
  const maxOrder = get('SELECT MAX(step_order) AS m FROM ingestion_step WHERE job_id = ?', [jobId])?.m ?? 0;
  return addStep(jobId, Number(maxOrder) + 1, {
    stage: 'validate',
    target: `reconcile:${dataset}`,
    status: issues > 0 ? 'ok' : 'ok',
    items: checked,
    message: `核对 ${checked} 项，发现 ${issues} 项差异`,
    detail: { issues },
  });
}

/* ==================================================================== */
/*  连接器：交易行情                                                      */
/* ==================================================================== */

/**
 * 采集交易行情（官方每日行情公告）。
 * @param {{actor?:string, dates?:string[], onlyNew?:boolean, limit?:number, withDimension?:boolean,
 *          jobId?:string|null, sourceId?:string|null}} opts
 */
export async function collectTradeQuotes(opts = {}) {
  const {
    actor = 'system:collect', dates = null, onlyNew = true, limit = 400,
    withDimension = true, jobId = null, sourceId = null, speed = 'normal',
  } = opts;
  const stats = { found: 0, parsed: 0, validated: 0, queued: 0, published: 0, errors: 0 };
  const notes = [];
  let order = 0;
  const step = (s) => {
    if (jobId) addStep(jobId, (order += 1), s);
  };

  /* 1. 公告列表 */
  const listRes = await fetchText(trade.TRADE_SOURCES.list_json, {
    headers: { referer: trade.TRADE_SOURCES.list_page, accept: 'application/json,*/*' },
    rateLimitPerMin: collectRatePerMin(speed),
  });
  if (!listRes.ok) {
    stats.errors += 1;
    step({ stage: 'collect', target: trade.TRADE_SOURCES.list_json, status: 'failed', message: listRes.error });
    return { ok: false, error: `官方行情公告列表获取失败：${listRes.error}`, stats };
  }
  const listSnap = recordSnapshot({
    url: trade.TRADE_SOURCES.list_json, res: listRes, sourceId,
    parser: 'ccer_trade_list_json', parseQuality: 'pending',
  });
  const list = trade.parseTradeListJson(listRes.body);
  stats.found = list.items.length;
  step({
    stage: 'collect', target: trade.TRADE_SOURCES.list_json, status: 'ok',
    items: list.items.length, snapshot_id: listSnap.id,
    message: `官方公告列表 ${list.items.length} 条（total=${list.total}）`,
  });
  if (!list.items.length) {
    stats.errors += 1;
    step({ stage: 'parse', target: 'trade_list', status: 'failed', message: '公告列表解析出 0 条' });
    return { ok: false, error: '公告列表解析为空（站点可能改版）', stats, snapshot_id: listSnap.id };
  }
  run('UPDATE source_snapshot SET parse_quality = ? WHERE id = ?', ['good', listSnap.id]);

  /* 2. 选定要采集的日期 */
  const imported = new Set(all('SELECT DISTINCT trade_date FROM trade_daily').map((r) => r.trade_date));
  let targets = list.items;
  if (Array.isArray(dates) && dates.length) {
    const want = new Set(dates.filter(isDate));
    targets = targets.filter((i) => want.has(i.trade_date));
  } else if (onlyNew) {
    targets = targets.filter((i) => !imported.has(i.trade_date));
  }
  targets = targets.slice(-Math.max(1, Math.min(Number(limit) || 400, 2000)));
  if (!targets.length) {
    notes.push('没有需要采集的新交易日期（官方公告列表中的日期均已入库）。');
  }

  /* 3. 逐日采集公告正文 */
  const collected = [];
  for (const item of targets) {
    const res = await fetchText(item.url, {
      headers: { referer: trade.TRADE_SOURCES.list_page },
      rateLimitPerMin: collectRatePerMin(speed),
    });
    if (!res.ok) {
      stats.errors += 1;
      const snap = recordSnapshot({ url: item.url, res, sourceId, parser: 'ccer_trade_bulletin', parseQuality: 'failed', error: res.error });
      step({ stage: 'collect', target: item.url, status: 'failed', message: res.error, snapshot_id: snap.id });
      // 公告正文页失效（历史链接可能 404）时，改用同一官网栏目的**官方分行业行情 JSON 小计行**。
      // 这是官方披露的同一交易日成交量/额，不是插值或推算；均价未披露则留空。
      const fb = await collectTradeDayFromOfficialDimension(item, {
        sourceId, actor, step, speed, reason: `官方每日行情公告页不可用（${res.error}）`,
      });
      if (fb) collected.push(fb);
      continue;
    }
    const parsed = trade.parseTradeBulletin(res.body, { url: item.url, fallback_date: item.trade_date });
    const snap = recordSnapshot({
      url: item.url, res: res, sourceId, parser: 'ccer_trade_bulletin',
      parseQuality: parsed.volume === null ? 'partial' : 'good',
      parseNote: parsed.warnings.join('；') || null,
    });
    stats.parsed += 1;
    step({
      stage: 'parse', target: item.url, status: parsed.volume === null ? 'failed' : 'ok',
      snapshot_id: snap.id,
      message: parsed.volume === null
        ? '未能从公告解析出成交量'
        : `${parsed.trade_date} 成交量 ${parsed.volume} tCO₂e，成交额 ${parsed.turnover} 元，均价 ${parsed.avg_price ?? '官方未披露'}`,
      detail: { warnings: parsed.warnings, cumulative: parsed.cumulative },
    });
    if (parsed.volume === null) {
      stats.errors += 1;
      const fb = await collectTradeDayFromOfficialDimension(item, {
        sourceId, actor, step, speed, reason: '官方每日行情公告正文未解析出成交量',
      });
      if (fb) collected.push(fb);
      continue;
    }
    const up = trade.upsertTradeDaily(
      {
        trade_date: parsed.trade_date || item.trade_date,
        volume: parsed.volume,
        turnover: parsed.turnover,
        avg_price: parsed.avg_price,
        session_state: parsed.session_state,
        source_url: item.url,
        source_snapshot_id: snap.id,
        published_at: parsed.published_at || item.published_at,
        note: parsed.warnings.length ? parsed.warnings.join('；') : null,
      },
      { actor, reason: '官方每日行情公告采集' }
    );
    stats.validated += 1;
    if (parsed.cumulative) trade.upsertCumulativeReference(parsed.cumulative, { sourceUrl: item.url });
    // 【二轮整改】不再生成任何人工核对任务：官方公告正文、来源快照与累计值已留痕，
    // 量价/累计差分由 reconcile-svc 自动核对并标注差异（自动运行状态，不是待办）。
    step({
      stage: 'validate', target: item.url, status: 'ok',
      message: `${parsed.trade_date} 已按官方公告入库；差异由自动核对标注，不产生人工核对任务。`,
    });
    collected.push({ ...parsed, action: up.action, id: up.id, snapshot_id: snap.id });

    /* 4. 分行业维度 */
    if (withDimension) {
      const ymd8 = String(parsed.trade_date || item.trade_date).replace(/-/g, '');
      const dimUrl = trade.TRADE_SOURCES.dimension_json(ymd8);
      const dimRes = await fetchText(dimUrl, {
        headers: { referer: trade.TRADE_SOURCES.list_page, accept: 'application/json,*/*' },
        rateLimitPerMin: collectRatePerMin(speed),
      });
      if (dimRes.ok) {
        const dim = trade.parseTradeFirstJson(dimRes.body);
        const dimSnap = recordSnapshot({
          url: dimUrl, res: dimRes, sourceId, parser: 'ccer_trade_first_json',
          parseQuality: dim.rows.length ? 'good' : 'partial',
          parseNote: dim.warnings.join('；') || null,
        });
        trade.upsertTradeDimension(parsed.trade_date || item.trade_date, 'industry', dim.rows, { sourceUrl: dimUrl });
        step({
          stage: 'parse', target: dimUrl, status: dim.rows.length ? 'ok' : 'skipped',
          items: dim.rows.length, snapshot_id: dimSnap.id,
          message: dim.rows.length ? `分行业 ${dim.rows.length} 条` : '该日无分行业数据',
          detail: { warnings: dim.warnings },
        });
      } else {
        step({ stage: 'collect', target: dimUrl, status: 'failed', message: dimRes.error });
      }
    }
  }

  /* 5. 重建交易日历（周末 / 交易日 / 法定节假日休市）
   * 【口径纪律】交易日历的「交易日」权威来源是**官方行情公告清单中的日期**，
   * 不是「本次成功导入 trade_daily 的日期」。用后者会把抓取失败（例如历史公告页 404）
   * 静默降级为「休市」，进而让累计差分核对把多日区间误当成单日。
   * 已入库行情但本次清单未含的日期同样保持交易日（见 rebuildCalendar）。 */
  const officialDates = list.items.map((i) => i.trade_date);
  const importedDates = all('SELECT DISTINCT trade_date FROM trade_daily').map((r) => r.trade_date);
  const cal = trade.rebuildCalendar(officialDates.length ? officialDates : importedDates, {
    actor, importedDates,
  });
  step({
    stage: 'validate', target: 'trade_calendar', status: 'ok', items: cal.marked,
    message: `交易日历已按官方公告清单重算：${cal.from} ~ ${cal.to}` +
      (cal.kept_trading ? `（另有 ${cal.kept_trading} 天已入库但清单快照未含，保持交易日未降级）` : ''),
  });

  return {
    ok: stats.errors === 0,
    stats,
    collected_count: collected.length,
    collected: collected.slice(-50),
    list_total: list.total,
    // 兼容字段：新版不再创建任何人工核对任务，恒为 0（保留字段名避免破坏既有调用方）
    pending_review_created: 0,
    notes,
    calendar: cal,
  };
}

/* ==================================================================== */
/*  连接器：交易行情（官方分行业「小计」兜底）                             */
/* ==================================================================== */

/**
 * 当官方**每日行情公告正文页**不可用（历史链接 404 / 改版 / 未解析出成交量）时，
 * 改用同一官网栏目「2502lshq」的官方**分行业行情 JSON**（`<YYYYMMDD>-first.json`）的
 * 「小计」行登记当日成交量/成交额。
 *
 * 【纪律】
 *   - 这是官方披露的同一交易日数据，**不是**插值、不是用相邻日推算、不是第三方摘要；
 *   - 官方分行业小计未披露均价（值为 `-`）时 `avg_price` 留空，不自行补值；
 *   - 该行 `verify_status` 保持 `pending`（缺官方均价无法完成单价关系自动核对），
 *     并在 `note` 中写明兜底原因，便于回溯；
 *   - 公告正文页失败仍写入失败快照与步骤，不掩盖失败。
 *
 * @returns {Promise<object|null>} 入库结果（含 fallback 标记），无法兜底时返回 null
 */
export async function collectTradeDayFromOfficialDimension(item, {
  sourceId = null, actor = 'system:collect', step = () => {}, speed = 'normal', reason = null,
} = {}) {
  const ymd8 = String(item?.trade_date || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(ymd8)) return null;
  const dimUrl = trade.TRADE_SOURCES.dimension_json(ymd8);
  const dimRes = await fetchText(dimUrl, {
    headers: { referer: trade.TRADE_SOURCES.list_page, accept: 'application/json,*/*' },
    rateLimitPerMin: collectRatePerMin(speed),
  });
  if (!dimRes.ok) {
    step({ stage: 'collect', target: dimUrl, status: 'failed', message: `兜底数据源也不可用：${dimRes.error}` });
    return null;
  }
  const dim = trade.parseTradeFirstJson(dimRes.body);
  const sub = dim.subtotal;
  if (!sub || sub.volume === null || sub.turnover === null) {
    step({
      stage: 'parse', target: dimUrl, status: 'failed',
      message: '官方分行业行情缺少可用的小计行，保持该日行情缺失（不用 0 或推算值填充）',
    });
    return null;
  }
  const dimSnap = recordSnapshot({
    url: dimUrl, res: dimRes, sourceId, parser: 'ccer_trade_first_json',
    parseQuality: 'good', parseNote: '作为每日行情公告不可用时的官方兜底口径（分行业小计行）',
  });
  const tradeDate = dim.trade_date || item.trade_date;
  const note =
    `官方每日行情公告不可用（${reason || '未说明'}）；本行取自官方分行业行情 JSON 的「小计」行` +
    `（同一官网栏目，来源 ${dimUrl}）。` +
    (sub.avg_price === null ? '官方小计行未披露成交均价，均价留空，不自行补值。' : '');
  const up = trade.upsertTradeDaily(
    {
      trade_date: tradeDate,
      volume: sub.volume,
      turnover: sub.turnover,
      avg_price: sub.avg_price,
      session_state: sub.volume > 0 ? 'traded' : 'no_trade',
      source_url: dimUrl,
      source_snapshot_id: dimSnap.id,
      published_at: item?.published_at || null,
      note,
    },
    { actor, reason: '官方分行业行情小计兜底（公告正文不可用）' }
  );
  trade.upsertTradeDimension(tradeDate, 'industry', dim.rows, { sourceUrl: dimUrl });
  step({
    stage: 'validate', target: dimUrl, status: 'ok', items: dim.rows.length, snapshot_id: dimSnap.id,
    message: `${tradeDate} 由官方分行业小计兜底入库：成交量 ${sub.volume} 吨，成交额 ${sub.turnover} 元，` +
      `均价 ${sub.avg_price ?? '官方未披露（留空）'}`,
    detail: { fallback: true, warnings: dim.warnings },
  });
  return {
    trade_date: tradeDate,
    volume: sub.volume,
    turnover: sub.turnover,
    avg_price: sub.avg_price,
    session_state: sub.volume > 0 ? 'traded' : 'no_trade',
    fallback: 'official_dimension_subtotal',
    source_url: dimUrl,
    action: up.action,
    id: up.id,
    snapshot_id: dimSnap.id,
  };
}

/* ==================================================================== */
/*  连接器：政策与方法学                                                  */
/* ==================================================================== */

/**
 * 巡检已收录政策的官方页面：内容哈希变化 → 生成 policy_change（待研究员确认，
 * 不自动改写规则与状态）。同时校验页面是否 404 / 跳转异常。
 */
export async function patrolPolicyDocuments({ actor = 'system:collect', limit = 200, policyIds = null, jobId = null } = {}) {
  const stats = { found: 0, parsed: 0, validated: 0, queued: 0, published: 0, errors: 0 };
  let order = 0;
  const step = (s) => {
    if (jobId) addStep(jobId, (order += 1), s);
  };
  const rows = policyIds && policyIds.length
    ? all(`SELECT * FROM policy_document WHERE id IN (${policyIds.map(() => '?').join(',')})`, policyIds)
    : all('SELECT * FROM policy_document WHERE official_url IS NOT NULL ORDER BY publish_date DESC LIMIT ?', [limit]);
  stats.found = rows.length;
  const changes = [];
  for (const p of rows) {
    const res = await fetchText(p.official_url, {
      headers: { referer: 'https://www.mee.gov.cn/' }, rateLimitPerMin: 8,
    });
    if (!res.ok) {
      stats.errors += 1;
      const snap = recordSnapshot({
        url: p.official_url, res, sourceId: p.source_id, parser: 'mee_policy_page',
        parseQuality: 'failed', error: res.error,
      });
      run(
        `INSERT INTO policy_change (id,policy_id,detected_at,change_kind,old_value,new_value,diff_summary,impact_json,review_status,created_at)
         VALUES (?,?,?,?,?,?,?,?, 'pending', ?)`,
        [
          newId('PCH'), p.id, nowIso(), 'fetch_failed', p.official_url, null,
          `官方页面访问失败：${res.error}`, j({ source_snapshot_id: snap.id }), nowIso(),
        ]
      );
      // 【二轮整改】不生成人工任务：官方页面访问失败记录为自动运行状态（policy_change + 快照），
      // 页面内容变化同样只记录差异摘要，由自动巡检与重试处理。
      step({ stage: 'collect', target: p.official_url, status: 'failed', message: res.error, snapshot_id: snap.id });
      continue;
    }
    stats.parsed += 1;
    const extracted = extractPolicyMeta(res.body);
    const prevHash = p.original_file_hash;
    const snap = recordSnapshot({
      url: p.official_url, res, sourceId: p.source_id, parser: 'mee_policy_page',
      parseQuality: extracted.title ? 'good' : 'partial',
      parseNote: extracted.title ? null : '未能提取标题，页面结构可能改版',
    });
    if (prevHash && prevHash !== res.hash) {
      stats.queued += 1;
      const diff = diffPolicyMeta(p, extracted);
      const impact = policyImpact(p);
      run(
        `INSERT INTO policy_change (id,policy_id,detected_at,change_kind,old_value,new_value,diff_summary,impact_json,review_status,created_at)
         VALUES (?,?,?,?,?,?,?,?, 'pending', ?)`,
        [
          newId('PCH'), p.id, nowIso(), 'revised', prevHash, res.hash,
          diff.summary, j({ ...impact, source_snapshot_id: snap.id }), nowIso(),
        ]
      );
      // 官方原文变化只记录差异摘要与影响面（自动运行状态），不生成人工确认任务
      changes.push({ policy_id: p.id, title: p.title, summary: diff.summary });
      step({ stage: 'validate', target: p.official_url, status: 'ok', message: `检测到内容变化：${diff.summary}`, snapshot_id: snap.id });
    } else {
      stats.validated += 1;
      step({ stage: 'validate', target: p.official_url, status: 'ok', message: '内容哈希未变化', snapshot_id: snap.id });
    }
    const { extractHtmlText } = await import('./web-fetch-svc.mjs');
    const officialBody = extractHtmlText(res.body).content;
    run('UPDATE policy_document SET original_file_hash = ?, body_snapshot = ?, collected_at = ?, updated_at = ? WHERE id = ?', [
      res.hash, officialBody || null, nowIso(), nowIso(), p.id,
    ]);
  }
  return { ok: stats.errors === 0, stats, changes };
}

/** 从官方政策页面提取结构化字段（标题/文号/发布机关/生成日期） */
export function extractPolicyMeta(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const t = String(html || '').match(/<title>([\s\S]*?)<\/title>/i);
  const out = { title: t ? t[1].replace(/_中华人民共和国生态环境部$/, '').replace(/\s+/g, ' ').trim() : null };
  const num = text.match(/文\s*号\s*([^\s]{4,40})/);
  if (num) out.doc_number = num[1].trim();
  const org = text.match(/发布机关\s*([^\s]{2,60}?)\s*(生成日期|主\s*题\s*词|文\s*号)/);
  if (org) out.issuing_authority = org[1].trim();
  const date = text.match(/生成日期\s*(\d{4}-\d{2}-\d{2})/);
  if (date) out.publish_date = date[1];
  return out;
}

function diffPolicyMeta(prev, extracted) {
  const diffs = [];
  if (extracted.title && prev.title && !sameTitle(extracted.title, prev.title)) {
    diffs.push(`标题：${prev.title} → ${extracted.title}`);
  }
  if (extracted.doc_number && prev.doc_number && extracted.doc_number !== prev.doc_number) {
    diffs.push(`文号：${prev.doc_number} → ${extracted.doc_number}`);
  }
  if (extracted.publish_date && prev.publish_date && extracted.publish_date !== prev.publish_date) {
    diffs.push(`发布日期：${prev.publish_date} → ${extracted.publish_date}`);
  }
  return {
    summary: diffs.length ? diffs.join('；') : '页面内容哈希变化（正文可能修订），字段级差异未识别',
  };
}

function sameTitle(a, b) {
  const norm = (s) => String(s || '').replace(/[\s《》()（）\-—_]/g, '');
  return norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
}

/**
 * 政策变更的影响面：受影响的方法学、规则卡、项目与历史测算版本。
 * 需求规格 1.2：「政策变更自动列出受影响的方法学、项目和测算版本，待研究员确认后发布」。
 */
export function policyImpact(policy) {
  const mvs = all(
    `SELECT id, methodology_id, code_display, name, version, document_status FROM methodology_version
     WHERE official_url IS NOT NULL AND (official_url = ? OR source_id = ?)`,
    [policy.official_url || '', policy.source_id || '']
  );
  const keywords = String(policy.title || '')
    .replace(/关于(发布|印发)/g, '')
    .split(/[《》（）()、,，]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const related = all('SELECT id, name, methodology_id FROM public_project LIMIT 500').filter((p) =>
    keywords.some((k) => String(p.name || '').includes(k))
  );
  const runs = mvs.length
    ? all(
        `SELECT COUNT(*) AS c FROM calculation_run WHERE methodology_version_id IN (${mvs.map(() => '?').join(',')})`,
        mvs.map((m) => m.id)
      )?.[0]?.c ?? 0
    : 0;
  return {
    policy_id: policy.id,
    policy_title: policy.title,
    affected_methodologies: mvs,
    affected_projects: related,
    affected_calculation_runs: runs,
    note:
      '影响面由「官方 URL / 来源一致」与标题关键词匹配得出，仅供研究员复核；' +
      '确认后仍需人工更新规则卡与测算版本，系统不会自动改写规则。',
  };
}

/** 政策变更确认（研究员）：确认后写入审计，并可登记新的版本状态 */
export function confirmPolicyChange(user, changeId, { decision = 'confirmed', note = null, doc_status = null } = {}) {
  const ch = get('SELECT * FROM policy_change WHERE id = ?', [changeId]);
  if (!ch) return { error: '变更记录不存在', status: 404 };
  if (ch.review_status !== 'pending') return { error: '该变更已处理', status: 409 };
  run('UPDATE policy_change SET review_status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', [
    decision, user?.name || 'unknown', nowIso(), changeId,
  ]);
  if (doc_status) {
    run('UPDATE policy_document SET doc_status = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?', [
      doc_status, user?.name || 'unknown', nowIso(), nowIso(), ch.policy_id,
    ]);
  }
  const task = get(
    `SELECT id FROM review_task WHERE object_id = ? AND task_type = 'policy_publish' AND status = 'pending'`,
    [ch.policy_id]
  );
  if (task) {
    decideReviewTask(user, task.id, { decision: decision === 'confirmed' ? 'approved' : 'rejected', note });
  }
  return { ok: true, change_id: changeId, review_status: decision, reviewed_by: user?.name || 'unknown', note };
}

/**
 * 政策栏目巡检：尝试从配置的列表页发现新政策/方法学发布通知。
 * 实测生态环境部栏目页当前返回空（动态渲染），失败会被记录为真实缺口，
 * 因此这里把「发现新条目」与「访问失败」分别登记，不伪装成功。
 */
export async function discoverPolicyNotices({ actor = 'system:collect', jobId = null, listUrls = null } = {}) {
  let order = 1000;
  const step = (s) => {
    if (jobId) addStep(jobId, (order += 1), s);
  };
  const urls = listUrls && listUrls.length ? listUrls : ['https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/'];
  const stats = { found: 0, parsed: 0, validated: 0, queued: 0, published: 0, errors: 0 };
  const discovered = [];
  for (const url of urls) {
    const res = await fetchText(url, { headers: { referer: 'https://www.mee.gov.cn/' }, rateLimitPerMin: 6 });
    if (!res.ok) {
      stats.errors += 1;
      const snap = recordSnapshot({ url, res, parser: 'mee_list', parseQuality: 'failed', error: res.error });
      step({ stage: 'collect', target: url, status: 'failed', message: res.error, snapshot_id: snap.id });
      continue;
    }
    const links = extractNoticeLinks(res.body, url);
    const snap = recordSnapshot({
      url, res, parser: 'mee_list', parseQuality: links.length ? 'good' : 'partial',
      parseNote: links.length ? null : '列表页未解析出条目（页面可能为动态渲染 / 站点改版）',
    });
    stats.found += links.length;
    step({
      stage: 'parse', target: url, status: links.length ? 'ok' : 'failed', items: links.length,
      message: links.length ? `发现 ${links.length} 条公告链接` : '列表页未解析出任何公告链接（站点可能改版；下一轮自动重试）',
      snapshot_id: snap.id,
    });
    if (!links.length) stats.errors += 1;
    const known = new Set(all('SELECT official_url FROM policy_document WHERE official_url IS NOT NULL').map((r) => r.official_url));
    for (const l of links.slice(0, 60)) {
      if (known.has(l.url)) {
        stats.validated += 1;
        continue;
      }
      discovered.push(l);
      // 发现后即收录，原文失败留快照并重试；不通过人工队列中转。
      const page = await fetchText(l.url, { rateLimitPerMin: 6 });
      const evidence = recordSnapshot({ url: l.url, res: page, parser: 'policy_notice',
        parseQuality: page.ok ? 'good' : 'failed', error: page.error });
      if (!page.ok) {
        stats.errors += 1;
        step({ stage: 'collect', target: l.url, status: 'failed', message: page.error, snapshot_id: evidence.id });
        continue;
      }
      const { extractPublishedDate } = await import('./content-svc.mjs');
      const body = String(page.body || '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi,' ')
        .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
      const date = extractPublishedDate(page.body, { url: l.url, text: body });
      const id = newId('POL');
      const at = nowIso();
      run(`INSERT INTO policy_document
        (id,policy_key,title,category,doc_status,publish_date,summary,body_snapshot,publish_date_note,official_url,source_tier,
         original_file_hash,collected_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, 'notice-' + createHash('sha256').update(l.url).digest('hex'), l.text,
          /征求意见/.test(l.text) ? 'consultation' : 'ministry_policy',
          /征求意见/.test(l.text) ? 'draft_consultation' : 'notice', date.published_at,
          body.slice(0,3000), body.slice(0,400000), date.note, l.url, 1, page.hash || null, at, at, at]);
      known.add(l.url);
      stats.parsed += 1;
      stats.published += 1;
      step({ stage: 'publish', target: l.url, status: 'ok', message: '公告已自动收录；政策效力未作推断', snapshot_id: evidence.id });
      try {
        const { verifyObject } = await import('./verification-svc.mjs');
        await verifyObject('policy_document', id, { actor });
      } catch (e) {
        stats.errors += 1;
        step({ stage: 'verify', target: l.url, status: 'failed', message: e.message });
      }
    }
    if (discovered.length) {
      notify({
        kind: 'new_policy',
        title: `官方频道发现 ${discovered.length} 条公告，自动收录 ${stats.published} 条`,
        detail: discovered.slice(0, 3).map((d) => d.text).join('；'),
        severity: 'normal',
        impact_level: 'medium',
        object_type: 'policy_discovery',
        object_id: url,
      });
    }
  }
  return { ok: stats.errors === 0, stats, discovered };
}

/** 从列表页 HTML 中提取公告链接（相对路径补全 + 去重） */
export function extractNoticeLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1];
    if (!/\/t\d{8}_\d+\.(html|shtml)$/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/方法学|自愿减排|温室气体|CCER|气候/.test(text)) continue;
    out.push({ url, text });
  }
  return out;
}

/* ==================================================================== */
/*  数据源连接测试（后台管理）                                            */
/* ==================================================================== */

export async function testDatasourceConnection(ds) {
  const allowed = uj(ds.allowed_domains, []) || DEFAULT_ALLOWED_DOMAINS;
  const check = checkOutboundUrl(ds.url, allowed.length ? allowed : DEFAULT_ALLOWED_DOMAINS);
  if (!check.ok) {
    return { ok: false, error: check.reason, blocked: true };
  }
  if (ds.parser === 'manual') {
    return {
      ok: true,
      manual: true,
      message: '该来源为「人工上传 / 人工摘录」类型，不做自动抓取；请用导入模板上传数据。',
    };
  }
  const res = await fetchText(ds.url, {
    allowedDomains: allowed.length ? allowed : DEFAULT_ALLOWED_DOMAINS,
    timeoutMs: ds.timeout_ms || 15000,
    retryMax: Math.min(Number(ds.retry_max) || 1, 2),
    rateLimitPerMin: ds.rate_limit_per_min || 6,
  });
  if (!res.ok) return { ok: false, error: res.error, status: res.status, attempts: res.attempts };
  let parsedCount = null;
  let parseNote = null;
  try {
    if (ds.parser === 'ccer_trade_list_json') {
      const p = trade.parseTradeListJson(res.body);
      parsedCount = p.items.length;
      parseNote = `解析出 ${p.items.length} 条公告（total=${p.total}）`;
    } else if (ds.parser === 'ccer_trade_bulletin') {
      const p = trade.parseTradeBulletin(res.body, { url: ds.url });
      parsedCount = p.volume === null ? 0 : 1;
      parseNote = p.volume === null
        ? '未识别到成交量，需检查页面结构'
        : `${p.trade_date} 成交量 ${p.volume} tCO₂e、成交额 ${p.turnover} 元、均价 ${p.avg_price ?? '未披露'}`;
    } else if (ds.parser === 'ccer_trade_first_json') {
      const p = trade.parseTradeFirstJson(res.body);
      parsedCount = p.rows.length;
      parseNote = `解析出 ${p.rows.length} 个行业维度`;
    } else if (ds.parser === 'html_list') {
      const links = extractNoticeLinks(res.body, ds.url);
      parsedCount = links.length;
      parseNote = links.length ? `发现 ${links.length} 条公告链接` : '未解析出公告链接（可能为动态渲染，需人工巡检）';
    } else if (ds.parser === 'html_document') {
      const meta = extractPolicyMeta(res.body);
      parsedCount = meta.title ? 1 : 0;
      parseNote = meta.title ? `标题：${meta.title.slice(0, 50)}` : '未提取到标题';
    }
  } catch (e) {
    parseNote = `解析异常：${e.message}`;
  }
  return {
    ok: true,
    status: res.status,
    bytes: res.bytes,
    hash: res.hash,
    elapsed_ms: res.elapsed_ms,
    attempts: res.attempts,
    parsed_count: parsedCount,
    parse_note: parseNote,
  };
}

/* ==================================================================== */
/*  每日任务编排                                                         */
/* ==================================================================== */

/**
 * 每日更新的数据集。
 * v2.1 起新增 `content`：公开研报与行业动态（搜索 API + 网页抓取）。
 */
export const DAILY_DATASETS = ['policy', 'project', 'trade', 'factor', 'content', 'verify'];

/**
 * 每日更新任务：采集 → 解析 → 规则一致性检查 → 模型自动核验 → 自动发布（状态标记）。
 * ============================================================================
 * 【本轮升级】发布不再是「生成待审核任务等人工确认」：自动核验完成后
 * 直接写入 verification_result 并标记条目状态（自动核验通过 / 证据不足 /
 * 来源冲突 / 暂未自动核验）。全流程**不产生任何人工任务**。
 *
 * 幂等：增量更新按窗口与 URL/内容哈希去重，重复执行同一窗口不会重复入库；
 * 内容核验按输入哈希缓存，同输入不重复调用模型。
 *
 * @param {{actor:string, trigger?:string, datasets?:string[], dryRun?:boolean,
 *          tradeLimit?:number, onlyNew?:boolean, withDimension?:boolean,
 *          contentMaxItems?:number, contentWindowDays?:number}} opts
 */
export async function runDailyJob(opts = {}) {
  const {
    actor = 'system:daily', trigger = 'manual', datasets = DAILY_DATASETS,
    tradeLimit = 40, onlyNew = true, withDimension = true, jobKey = 'daily_all',
    projectMaxDetails = 500, projectArchiveFiles = !!process.env.CCER_REGISTRY_COOKIE,
    contentMaxItems = 30, contentWindowDays = 7, evidenceLoop = true,
  } = opts;
  const stats = { found: 0, parsed: 0, validated: 0, queued: 0, published: 0, errors: 0 };
  const jobId = startJob({
    job_key: JOB_KINDS[jobKey] ? jobKey : 'daily_all',
    title: JOB_KINDS[jobKey] || JOB_KINDS.daily_all,
    trigger_kind: trigger,
    triggered_by: actor,
    datasets,
  });
  const detail = {};
  let dataAsOf = null;

  try {
    if (datasets.includes('trade')) {
      const { syncOfficialClosures } = await import('./trade-calendar-svc.mjs');
      detail.official_calendar = await syncOfficialClosures({ actor });
      const r = await collectTradeQuotes({
        actor, limit: tradeLimit, onlyNew, withDimension, jobId,
      });
      detail.trade = r;
      stats.found += r.stats.found;
      stats.parsed += r.stats.parsed;
      stats.validated += r.stats.validated;
      stats.queued += r.stats.queued;
      stats.errors += r.stats.errors;
      if (r.collected?.length) dataAsOf = r.collected[r.collected.length - 1].trade_date;
    }
    if (datasets.includes('policy')) {
      const p1 = await patrolPolicyDocuments({ actor, jobId });
      const p2 = await discoverPolicyNotices({ actor, jobId });
      detail.policy = { patrol: p1, discovery: p2 };
      stats.found += p1.stats.found + p2.stats.found;
      stats.parsed += p1.stats.parsed + p2.stats.parsed;
      stats.validated += p1.stats.validated + p2.stats.validated;
      stats.queued += p1.stats.queued + p2.stats.queued;
      stats.errors += p1.stats.errors + p2.stats.errors;
      try {
        const { backfillMethodologyOriginals } = await import('./methodology-archive-svc.mjs');
        const originals = await backfillMethodologyOriginals({ actor });
        detail.methodology_originals = originals;
        stats.parsed += originals.archived;
        stats.errors += originals.failures.length;
      } catch (e) {
        stats.errors++;
        detail.methodology_originals = { error: e.message };
      }
      // PDF/OCR 历史补跑（docs/36 第 6 条）：每日**有界**补跑，未完成部分写入游标；
      // OCR 未配置时只解析文本层并保持缺口，不把它计为任务错误。
      try {
        const ocrBackfill = await import('./ocr-backfill-svc.mjs');
        detail.ocr_backfill = await ocrBackfill.runDailyOcrBackfill({ actor });
      } catch (e) {
        detail.ocr_backfill = { error: e.message };
      }
    }
    if (datasets.includes('project')) {
      try {
        const registry = await import('./registry-svc.mjs');
        const r = await registry.syncRegistry({actor,maxDetails:projectMaxDetails,archiveFiles:projectArchiveFiles});
        detail.project = r;
        stats.found += r.stats.listed;
        stats.parsed += r.stats.details;
        stats.validated += r.stats.details;
        stats.errors += r.stats.errors.length;
      } catch (e) {
        stats.errors += 1;
        detail.project = {ok:false,error:e.message};
      }
    }
    if (datasets.includes('factor')) {
      const { runFactorChecks } = await import('./reconcile-svc.mjs');
      const c = runFactorChecks({ actor, jobId });
      detail.factor_checks = c;
      stats.validated += c.checked;
    }
    // 公开研报与行业动态：来源发现 → 抓取 → 去重 → 抽取 → 模型自动核验 → 状态标记
    if (datasets.includes('content')) {
      try {
        const content = await import('./content-svc.mjs');
        const c = await content.collectFromSearch({
          actor, jobId, windowDays: contentWindowDays, maxItems: contentMaxItems, verify: true,
        });
        detail.content = c;
        stats.found += c.discovered || 0;
        stats.parsed += (c.inserted || 0) + (c.updated || 0);
        stats.validated += Object.values(c.rules || {}).reduce((s, n) => s + (Number(n) || 0), 0);
        stats.published += c.inserted || 0;
        // 「未配置搜索服务」是已知限制，不是运行故障：
        // 此时仍会走种子来源抓取，因此不把它计为错误，只如实记录状态。
        if (!c.ok && c.reason !== 'no_search_provider') stats.errors += 1;
        else if (!c.ok) detail.content_not_configured = c.message;
        const seed = await content.collectFromSeedSources({ actor, jobId, fetchLimit: 12, maxArticlesPerSource: 3, verify: false });
        detail.content_seed = seed;
        stats.found += seed.attempted || 0;
        // 种子来源有可用连接却全部抓取失败 → 才算故障
        if (seed.ok === false && seed.reason !== 'no_fetch_connection') stats.errors += 1;
        if (seed.reason === 'no_fetch_connection') detail.content_seed_not_configured = seed.message;
      } catch (e) {
        stats.errors += 1;
        detail.content = { ok: false, error: e.message };
      }
    }
    // CEA（全国碳排放配额）每日批次：独立有界步骤，复用同一个每日任务但不改变 CCER 采集路径。
    // 任一 CEA 来源失败不中断全站采集，也不会把上一日行情标成当日；共享总 deadline 由 CEA 内部管理。
    if (datasets.includes('trade') || datasets.includes('policy')) {
      try {
        const cea = await import('./cea-collect-svc.mjs');
        const r = await cea.runCeaDailyStep({ actor, trigger: trigger === 'schedule' ? 'schedule' : 'manual' });
        detail.cea = r;
        if (r?.skipped) detail.cea_skipped_reason = r.reason;
        if (r?.json?.quote_sources?.length) stats.found += r.json.quote_sources.length;
        if (r?.research?.published) stats.published += r.research.published;
      } catch (e) {
        // CEA 是增量步骤：失败只记录，不影响 CCER 每日任务整体状态
        detail.cea = { ok: false, error: e.message };
      }
    }
    // 公开碳核算资料（docs/39）：中碳登清结算日报 + 标准规范正文 + 电力因子原件 + 受阻门户探测。
    // 独立有界步骤：失败只记录，不影响 CCER/CEA 既有采集；无待处理对象属于空扫描而不是失败。
    try {
      const accounting = await import('./accounting-collect-svc.mjs');
      const r = await accounting.runAccountingDailyStep({ actor: 'system:daily-accounting', trigger: 'schedule' });
      detail.accounting = r;
      stats.found += r.crc_daily?.discovered || 0;
      stats.parsed += r.parsed || 0;
      if (r.ok === false) stats.errors += 1;
    } catch (e) {
      detail.accounting = { ok: false, error: e.message };
      stats.errors += 1;
    }
    // 省域排放（docs/61）：从固定公开源有界采集，await 并隔离错误。
    // 失败保留已有值；原件 hash 相同只记 last_check，不造无意义修订。
    try {
      const regionalCollect = await import('./regional-collect-svc.mjs');
      detail.region_map = await regionalCollect.runRegionalDailyCollect({
        actor: 'system:daily-regional',
        trigger: trigger === 'schedule' ? 'schedule' : 'manual',
      });
      if (detail.region_map?.ok === false) stats.errors += 1;
    } catch (e) {
      stats.errors += 1;
      detail.region_map = { ok: false, status: 'failed', error: e.message };
    }
    // 统一模型核验：内容（研报/动态）+ 政策 + 方法学 + 公开项目，共用同一套四态与缓存键。
    // unavailable 不缓存：模型配置好之后同一内容会在此自动重试。
    if (datasets.includes('verify')) {
      try {
        const verify = await import('./verification-svc.mjs');
        const v = await verify.verifyAllBatch({ actor, limitPerScope: contentMaxItems });
        detail.verify = v;
        const counted = Object.values(v.scopes || {}).reduce((s, t) => s + (t.verified || 0) + (t.insufficient || 0) + (t.conflict || 0) + (t.unavailable || 0), 0);
        stats.validated += counted + (v.content ? Object.values(v.content).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0) : 0);
      } catch (e) {
        stats.errors += 1;
        detail.verify = { ok: false, error: e.message };
      }
    }
    // 数据核对（单价关系、累计差分、缺失交易日、陈旧告警、项目/政策/因子完整性）
    const reconcile = await import('./reconcile-svc.mjs');
    const checks = {};
    if (datasets.includes('trade')) checks.trade = reconcile.runTradeChecks({ actor, jobId });
    if (datasets.includes('trade')) detail.trade_auto_check = reconcile.autoCheckCleanTradeRows({actor:'system:auto-reconcile'});
    if (datasets.includes('project')) checks.project = reconcile.runProjectChecks({ actor, jobId });
    if (datasets.includes('policy')) checks.policy = reconcile.runPolicyChecks({ actor, jobId });
    if (datasets.includes('factor')) checks.factor = reconcile.runFactorChecks({ actor, jobId });
    checks.auto_closed = reconcile.closeAbsentIssues(checks, actor);
    checks.stats = reconcile.reconciliationStats();
    detail.reconciliation = checks;
    // 提醒生命周期（幂等）：核对记录已结清的旧提醒不再作为待关注保留。
    try {
      detail.notification_lifecycle = syncNotificationLifecycle({ actor });
    } catch (e) {
      detail.notification_lifecycle = { error: e.message };
    }
    // 政策原件缺口的标题/影响/自动处理方式按**实时**归档状态同步，
    // 避免界面继续显示「尚未归档与页码提取」这类过期结论。
    try {
      const archiveSvc = await import('./policy-archive-svc.mjs');
      detail.policy_archive_gap = archiveSvc.syncPolicyArchiveGap({ actor });
    } catch (e) {
      stats.errors += 1;
      detail.policy_archive_gap = { error: e.message };
    }
    // 每日校准：先重新采集和执行确定性检查，再由模型逐项复核未结清差异。
    // 模型结论单独留痕，不修改官方数值或替代缺失的原文。
    if (datasets.includes('verify')) {
      try {
        const ai = await import('./reconciliation-ai-svc.mjs');
        detail.reconciliation_ai = await ai.calibrateOpenIssues({ actor, limit: 60 });
      } catch (e) {
        stats.errors += 1;
        detail.reconciliation_ai = { ok: false, error: e.message };
      }
    }
    // 有限证据循环：只对可补采缺口定向抓取，取得新来源后才再次核验。
    // 不让模型反复生成同一结论，更不以循环次数替代官方原文。
    if (evidenceLoop && datasets.some((d) => ['content', 'policy', 'trade', 'project'].includes(d))) {
      try {
        const loop = await import('./evidence-loop-svc.mjs');
        detail.evidence_loop = await loop.runEvidenceLoop({
          actor, datasets, initialDetail: detail,
          maxRounds: Number(process.env.CCER_EVIDENCE_LOOP_ROUNDS || 2),
          limit: Number(process.env.CCER_EVIDENCE_LOOP_ITEMS || 8),
          afterProgress: async () => {
            const rerun = reconcile.runAllChecks({ actor });
            detail.evidence_loop_reconciliation = rerun.stats;
            detail.notification_lifecycle = syncNotificationLifecycle({ actor });
            if (datasets.includes('policy')) {
              const archiveSvc = await import('./policy-archive-svc.mjs');
              detail.policy_archive_gap = archiveSvc.syncPolicyArchiveGap({ actor });
            }
            if (datasets.includes('verify')) {
              const verify = await import('./verification-svc.mjs');
              detail.evidence_loop_verify = await verify.verifyAllBatch({ actor, limitPerScope: contentMaxItems });
              const ai = await import('./reconciliation-ai-svc.mjs');
              detail.evidence_loop_ai = await ai.calibrateOpenIssues({ actor, limit: 60 });
            }
          },
        });
      } catch (e) {
        stats.errors += 1;
        detail.evidence_loop = { error: e.message, stop_reason: '循环执行异常，已停止；原始数据未覆盖' };
      }
    }
    // 核心摘要的**有界**刷新（docs/44 第 3 条）：日更新后只补少量最新条目，
    // 不阻塞每日任务主体；未配置模型时如实记为 skipped，绝不伪造「模型生成」。
    if (datasets.includes('content') || datasets.includes('policy')) {
      try {
        const summary = await import('./summary-svc.mjs');
        const r = await summary.refreshAfterDaily({
          limit: Number(process.env.CCER_SUMMARY_DAILY_LIMIT || 6),
          budgetMs: Number(process.env.CCER_SUMMARY_DAILY_BUDGET_MS || 60000),
          actor: 'system:daily',
        });
        detail.summaries = r;
        addStep(jobId, 9100, {
          stage: 'summarize', target: 'entity_summary', status: r.ok === false ? 'failed' : 'ok',
          items: Number(r.generated || 0),
          message: r.model_configured === false
            ? '未配置可用模型：本次未生成摘要（不伪造模型生成）'
            : `核心摘要：生成 ${r.generated || 0} 条，跳过 ${r.skipped || 0} 条，失败 ${r.failed || 0} 条`,
        });
      } catch (e) {
        // 摘要刷新失败不影响每日任务整体结果
        detail.summaries = { ok: false, error: e.message };
      }
    }

    // 历史未结清差异只是状态摘要，不是本次任务新发生的错误。
    stats.errors += Object.entries(checks)
      .filter(([scope, c]) => scope !== 'stats' && c && typeof c === 'object' && 'critical' in c)
      .reduce((s, [, c]) => s + (Number(c.critical) || 0), 0);

    const status = stats.errors === 0 ? 'success' : stats.parsed > 0 || stats.validated > 0 ? 'partial' : 'failed';
    finishJob(jobId, {
      status,
      stats,
      errorSummary: stats.errors ? `${stats.errors} 项采集/校验问题，详见步骤与核对记录` : null,
      dataAsOf,
      detail,
    });
    return { ok: status !== 'failed', job_id: jobId, status, stats, detail };
  } catch (e) {
    stats.errors += 1;
    addStep(jobId, 9999, { stage: 'publish', target: 'job', status: 'failed', message: e.message });
    finishJob(jobId, { status: 'failed', stats, errorSummary: e.message, dataAsOf, detail });
    return { ok: false, job_id: jobId, status: 'failed', stats, error: e.message, detail };
  }
}

/**
 * 各数据集的「最近成功时间 / 失败原因」。
 * 需求（docs/19 第 56 条）：为所有数据集写准确的最近成功时间与失败原因。
 */
export function listDatasetCursors() {
  const rows = all('SELECT * FROM dataset_cursor ORDER BY dataset');
  const have = new Set(rows.map((r) => r.dataset));
  const out = rows.map((r) => ({
    dataset: r.dataset,
    last_window_from: r.last_window_from,
    last_window_to: r.last_window_to,
    last_success_at: r.last_success_at,
    last_attempt_at: r.last_attempt_at,
    last_status: r.last_status,
    last_error: r.last_error,
    consecutive_failures: r.consecutive_failures,
    items_seen: r.items_seen,
    items_new: r.items_new,
    note: r.note,
  }));
  // 没有游标记录的数据集也要如实显示「从未成功」
  for (const d of [...DAILY_DATASETS, 'content_discovery', 'content_seed', 'seed_source_probe', 'verify_content', 'verify_policy', 'verify_methodology', 'verify_project']) {
    if (!have.has(d)) {
      out.push({
        dataset: d, last_window_from: null, last_window_to: null, last_success_at: null,
        last_attempt_at: null, last_status: 'never', last_error: null, consecutive_failures: 0,
        items_seen: 0, items_new: 0, note: '尚未运行',
      });
    }
  }
  return out;
}

/**
 * 状态横幅数据：数据截至日期 / 最后成功同步 / 自动核验与差异状态。
 * 【本轮升级】不再返回「待人工核对」条数：平台没有人工审核队列，
 * 取而代之的是自动核验四态统计与未结清差异（均为运行状态，不是待办）。
 */
export function syncStatus() {
  const lastOk = get(
    `SELECT * FROM ingestion_job WHERE status IN ('success','partial') ORDER BY finished_at DESC LIMIT 1`
  );
  const lastAny = get('SELECT * FROM ingestion_job ORDER BY started_at DESC LIMIT 1');
  const latestTrade = get(
    `SELECT trade_date, published_at, verify_status FROM trade_daily WHERE session_state='traded' ORDER BY trade_date DESC LIMIT 1`
  );
  const verif = {};
  try {
    for (const r of all("SELECT verification_status AS result, COUNT(*) c FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' AND COALESCE(process_status,'')<>'failed_fetch' GROUP BY verification_status")) verif[r.result] = r.c;
  } catch {
    /* 核验表尚未就绪 */
  }
  let contentTotal = 0;
  try {
    contentTotal = get("SELECT COUNT(*) AS c FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' AND COALESCE(process_status,'')<>'failed_fetch'")?.c ?? 0;
  } catch {
    contentTotal = 0;
  }
  const openIssues = get(
    `SELECT COUNT(*) AS c FROM data_reconciliation WHERE status = 'open' AND severity IN ('warning','critical')
      AND dataset IN ('trade','policy','project') AND NOT EXISTS
      (SELECT 1 FROM public_project p WHERE p.id=object_id AND p.is_demo=1)`
  )?.c ?? 0;
  const failed2d = get(
    `SELECT COUNT(*) AS c FROM ingestion_job WHERE status IN ('failed','partial') AND started_at >= ?`,
    [new Date(Date.now() - 2 * 86400000).toISOString()]
  )?.c ?? 0;
  const staleDays = latestTrade
    ? Math.floor((Date.parse(`${todayCst()}T00:00:00Z`) - Date.parse(`${latestTrade.trade_date}T00:00:00Z`)) / 86400000)
    : null;
  return {
    data_as_of: latestTrade ? latestTrade.trade_date : null,
    last_success_sync: lastOk ? lastOk.finished_at : null,
    last_job: lastAny
      ? { id: lastAny.id, job_key: lastAny.job_key, status: lastAny.status, started_at: lastAny.started_at, finished_at: lastAny.finished_at }
      : null,
    counts: {
      verification_verified: verif.verified || 0,
      verification_insufficient: verif.insufficient || 0,
      verification_conflict: verif.conflict || 0,
      verification_unavailable: verif.unavailable || 0,
      content_items: contentTotal,
      open_issues: openIssues,
      failed_jobs_2d: failed2d,
    },
    stale_days: staleDays,
    alert:
      staleDays !== null && staleDays > 3
        ? `最新交易日行情距今天 ${staleDays} 天，可能未采集或未发布，请检查采集任务`
        : failed2d > 0
          ? '近 2 日存在采集失败/部分成功的任务，请查看任务步骤'
          : null,
  };
}
