import {verifyAccountingEvidence} from './accounting-evidence-svc.mjs';
import {collectCetsPublic} from './accounting-public-svc.mjs';
/**
 * 公开碳核算资料 · 真实采集服务（docs/39 第 4 条）
 * ============================================================================
 * 复用的既有真实能力（不另造一套）：
 *   · collect-svc.fetchText      —— 白名单 + 超时 + 重试 + 低频 + 共享 deadline（HTML/PDF 同一通道）
 *   · web-fetch-svc              —— 已配置抓取连接（MCP/Firecrawl）作为官方 HTML 的后备通道
 *   · search-svc.runSearch       —— 官方 HTML/PDF 失败时**只用于发现官方镜像 URL**
 *   · pdf-parse-svc              —— 逐页 pdftotext（异步、无管道）+ 页缓存
 *   · verification-svc           —— 已配置大模型做**带引用**的一致性核验（可引用性校验）
 *
 * 硬性纪律：
 *   1. HTTP 412 / JS 校验页 / 登录页**不当作正文**，不破解校验、不猜 API、不登录企业账户；
 *      NCSC 因子库与 CETS 门户按此处理，只登记来源、最近尝试、状态与缺口；
 *   2. 解析按明确结构取数（表格单元格 / 正文句式 / PDF 表行），
 *      **绝不**从搜索摘要或模型输出生成事实；
 *   3. 单位/日期/因子适用性用确定性规则；模型只做「正文与元数据是否一致」的带引用核验，
 *      没有模型/超时/配额耗尽一律 unavailable，**不伪造 verified**；
 *   4. 单批总预算 ≤ 120 秒、单并发、重入合并、单次最多文件/页数、重试游标、
 *      来源未变命中缓存（已有同日同源记录不重复抓取）；
 *   5. 异步触发立即返回 202 + task_id；"受理成功"与"解析到 0 行"都**不算成功**。
 */
import { existsSync, readFileSync } from 'node:fs';
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj } from '../core/util.mjs';
import { fetchText, sha256 } from './collect-svc.mjs';
import { parsePdfDocument, pdfTextPages, pdfInfoPages } from './pdf-parse-svc.mjs';
import {
  accountingConfig, accountingRoot, ensureAccountingRoot, ensureAccountingSeeded,
  recordSourceAttempt, upsertCrcDaily, upsertEmissionFactor, upsertAccountingStandard,
  getSource, writeAccountingOriginal, attachStandardBody,
} from './accounting-svc.mjs';
import {
  assessFetchedDocument, discoverCrcDetailLinks, parseCrcDailyDetail,
  parseAnnouncementAttachments, parseElectricityFactorPages, ELECTRICITY_FACTOR_PDF_URL,
} from './accounting-parse.mjs';
import { ELECTRICITY_FACTOR_SOURCE } from '../data/accounting-originals.mjs';

export const ACCOUNTING_JOB_KEY = 'accounting_collect';
export const ACCOUNTING_CURSOR_META_KEY = 'accounting_collect_cursor_v1';
export const ACCOUNTING_TASK_KEEP = 30;
/** 运行中任务超过该时长视为僵死（进程中断），自动收尾，避免永久阻塞后续采集。 */
export const ACCOUNTING_STALE_TASK_MS = 20 * 60 * 1000;

export const ACCOUNTING_TARGETS = ['crc_daily', 'standards', 'factor_pdf', 'portals', 'cets_public', 'all'];

/* ==================================================================== */
/*  一、作业记录（复用既有 ingestion_job / ingestion_step）             */
/* ==================================================================== */

function startJob({ title, trigger = 'manual', actor = 'system:accounting' }) {
  const id = newId('JOB');
  const now = nowIso();
  run(
    `INSERT INTO ingestion_job (id,job_key,title,trigger_kind,triggered_by,started_at,finished_at,status,datasets,
       items_found,items_parsed,items_validated,items_queued,items_published,error_count,error_summary,data_as_of,detail_json,created_at)
     VALUES (?,?,?,?,?,?,NULL,'running',?,0,0,0,0,0,0,NULL,NULL,NULL,?)`,
    [id, ACCOUNTING_JOB_KEY, title, trigger, actor, now, j(['accounting']), now]
  );
  return id;
}

function addStep(jobId, order, { stage, target = null, status, items = 0, message = null, detail = null }) {
  const now = nowIso();
  run(
    `INSERT INTO ingestion_step (id,job_id,step_order,stage,target,status,started_at,finished_at,items,message,snapshot_id,detail_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('STP'), jobId, order, stage, target, status, now, now, items, message, null, detail ? j(detail) : null]
  );
}

function finishJob(jobId, { status, stats, errorSummary = null, detail = null }) {
  run(
    `UPDATE ingestion_job SET finished_at=?, status=?, items_found=?, items_parsed=?, items_validated=?,
       items_queued=?, items_published=?, error_count=?, error_summary=?, data_as_of=?, detail_json=? WHERE id=?`,
    [nowIso(), status, stats.found || 0, stats.parsed || 0, stats.validated || 0, stats.queued || 0,
      stats.published || 0, stats.errors || 0, errorSummary, stats.data_as_of || null,
      detail ? j(detail) : null, jobId]
  );
}

/** 是否存在同 job_key 的运行中作业（重入合并）。 */
function runningJob() {
  const row=get(`SELECT * FROM ingestion_job WHERE job_key=? AND status='running' ORDER BY started_at DESC LIMIT 1`,
    [ACCOUNTING_JOB_KEY]);
  if(row&&Date.now()-Date.parse(row.started_at)>ACCOUNTING_STALE_TASK_MS){run("UPDATE ingestion_job SET status='failed',finished_at=?,error_summary='采集进程中断或超时，自动恢复后续重试' WHERE id=?",[nowIso(),row.id]);return null;}
  return row;
}

/* ==================================================================== */
/*  二、抓取通道                                                        */
/* ==================================================================== */

const BROWSER_UA =
  'Mozilla/5.0 (compatible; CCER-public-info/2.4; +research use; accounting-sources)';

/** 允许抓取的域名：只取来源登记的 allowed_domains，绝不放开任意 URL。 */
function domainsOf(source) {
  const list = Array.isArray(source?.allowed_domains) ? source.allowed_domains : (uj(source?.allowed_domains, []) || []);
  return list.length ? list : undefined;
}

/**
 * 抓取一个来源 URL（HTML 或 PDF 二进制）。返回真实 HTTP 状态、最终 URL、sha256、字节数。
 * 绝不把 412/登录页当正文：由调用方通过 assessFetchedDocument 判定。
 */
export async function fetchAccountingUrl(url, { source = null, deadlineAt = null, timeoutMs = 20000, retryMax = 1, kind = 'html' } = {}) {
  const allowedDomains = domainsOf(source);
  const r = await fetchText(url, {
    allowedDomains, timeoutMs, retryMax, userAgent: BROWSER_UA, deadlineAt,
    headers: kind === 'pdf' ? { accept: 'application/pdf,*/*;q=0.8' } : {},
  });
  if(!r.ok && kind!=='pdf' && allowedDomains?.includes(new URL(url).hostname) && (!deadlineAt || deadlineAt-Date.now()>2000)) {
    const wf=await import('./web-fetch-svc.mjs');const conn=wf.pickFetchConnection();
    if(conn){
      const fallback=await wf.fetchUrlContent(conn,url,{timeoutMs:Math.min(25000,deadlineAt?Math.max(1000,deadlineAt-Date.now()):25000),deadlineAt});
      if(fallback.ok){
        const text=String(fallback.content||'');let envelope=null;try{envelope=JSON.parse(text);}catch{}
        const metadata=fallback.metadata||envelope?.metadata||{};const actualStatus=Number(metadata.statusCode)||null;
        if((actualStatus&&actualStatus>=400)||(envelope&&envelope.markdown===''))return{ok:false,http_status:actualStatus,url,blocked:actualStatus===412,reason:actualStatus===412?'http_412_challenge':'empty_render',error:metadata.error||'抓取服务未取得来源正文'};
        const buf=Buffer.from(text);return{ok:true,http_status:actualStatus,url,content_type:'text/markdown',text,buf,bytes:buf.length,hash:sha256(buf),fetch_method:'configured_fetch'};
      }
    }
  }
  if (!r.ok) {
    return {
      ok: false,
      http_status: r.status ?? null,
      url: r.final_url || url,
      error: r.error || 'fetch_failed',
      reason: r.reason || (r.blocked ? 'blocked_url' : 'network'),
      deadline_exceeded: !!r.deadline_exceeded,
      blocked: !!r.blocked,
    };
  }
  const buf = r.buf || Buffer.from(String(r.body || ''), 'utf8');
  return {
    ok: true,
    http_status: r.status ?? null,
    url: r.final_url || url,
    content_type: r.content_type || '',
    text: r.body ?? buf.toString('utf8'),
    buf,
    bytes: buf.length,
    hash: sha256(buf),
    attempts: r.attempts ?? 1,
  };
}

/** 把原件落盘到 DB 旁的 official-originals/accounting（内容寻址）。 */
function persistOriginal(hash, buf, ext) {
  try {
    ensureAccountingRoot();
    return writeAccountingOriginal(hash, buf, ext);
  } catch {
    return null;
  }
}

/* ==================================================================== */
/*  三、中碳登清结算日报采集                                            */
/* ==================================================================== */

/**
 * 采集清结算日报：
 *   列表页（真实 a.href 发现详情） → 详情页逐条抓取 → 确定性解析 → 表格/正文交叉核对 → 落库。
 * 「来源未变命中缓存」：同源同日已有 current 记录时不再重复抓取该详情页。
 */
export async function collectCrcDaily({ actor = 'system:accounting', cfg = accountingConfig(), deadlineAt = null, jobId = null } = {}) {
  ensureAccountingSeeded();
  const listSource = getSource('chinacrc_daily_list');
  const detailSource = getSource('chinacrc_daily_detail');
  if (!listSource) return { ok: false, reason: 'no_source', message: '未登记中碳登信息日报来源' };

  const out = {
    ok: true, discovered: 0, fetched: 0, parsed: 0, inserted: 0, revisions: 0, unchanged: 0,
    cache_hits: 0, conflicts: 0, failures: [], truncated: false, empty_scan: false, pages: [],
  };
  const maxDetails = Math.max(0, Number(cfg.max_details_per_source) || 6);

  // ---- 1. 列表页发现（真实 a.href）----
  // 分页 URL 只从列表页自身已出现的真实 `?page=N` 链接扩展（不拼猜页码）。
  const listUrls = [listSource.url];
  const visited = new Set(listUrls);
  const links = [];
  for (let i = 0; i < listUrls.length && listUrls.length <= 3; i += 1) {
    const lu = listUrls[i];
    if (deadlineHit(deadlineAt)) { out.truncated = true; break; }
    const f = await fetchAccountingUrl(lu, { source: listSource, deadlineAt });
    if (!f.ok) {
      recordSourceAttempt(listSource.code, {
        status: f.blocked ? 'blocked' : 'error', blocked_kind: f.blocked ? f.reason : null,
        http_status: f.http_status, error: `${f.reason}: ${f.error}`.slice(0, 500), url: f.url,
      });
      out.failures.push({ source: listSource.code, url: lu, error: f.error, reason: f.reason });
      out.ok = false;
      continue;
    }
    const guard = assessFetchedDocument({ httpStatus: f.http_status, html: f.text, url: f.url, contentType: f.content_type });
    if (!guard.ok) {
      recordSourceAttempt(listSource.code, {
        status: guard.reason === 'http_412_challenge' || guard.reason === 'login_required' ? 'blocked' : 'error',
        blocked_kind: guard.reason, http_status: f.http_status, error: guard.message, url: f.url,
        content_hash: f.hash, content_bytes: f.bytes,
      });
      out.failures.push({ source: listSource.code, url: lu, error: guard.message, reason: guard.reason });
      out.ok = false;
      continue;
    }
    const found = discoverCrcDetailLinks(f.text, { baseUrl: lu });
    out.pages.push({ url: lu, http_status: f.http_status, hash: f.hash, links: found.length });
    recordSourceAttempt(listSource.code, {
      status: found.length ? 'ok' : 'empty', success: true, http_status: f.http_status, url: f.url,
      content_hash: f.hash, content_bytes: f.bytes, collected_count: found.length,
      status_note: found.length ? null : '列表页未发现任何详情链接（结构可能已变更或该栏目为空）',
    });
    for (const l of found) if (!links.some((x) => x.url === l.url)) links.push(l);
    // 真实分页链接（同栏目、同路径、带 page 参数）——只跟随页面里真实存在的 href
    for (const pu of paginationLinks(f.text, lu, listSource.url)) {
      if (!visited.has(pu) && listUrls.length < 3) { visited.add(pu); listUrls.push(pu); }
    }
    if (links.length >= maxDetails) break;
  }
  out.discovered = links.length;
  if (!links.length) {
    out.empty_scan = true;
    out.ok = out.failures.length === 0;
    return out;
  }

  // ---- 2. 详情页逐条抓取（列表按时间倒序，取最新 N 条）----
  for (const link of links.slice(0, maxDetails)) {
    if (deadlineHit(deadlineAt)) { out.truncated = true; break; }
    const dateGuess = (String(link.title || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/) || []);
    const tradeDate = dateGuess.length
      ? `${dateGuess[1]}-${String(dateGuess[2]).padStart(2, '0')}-${String(dateGuess[3]).padStart(2, '0')}`
      : null;
    if (tradeDate) {
      const have = get(
        `SELECT id, content_hash FROM crc_clearing_daily WHERE source_code=? AND trade_date=? AND is_current=1`,
        [detailSource?.code || 'chinacrc_daily_detail', tradeDate]
      );
      if (have?.content_hash && link !== links[0]) {
        out.cache_hits += 1;
        continue;
      }
    }
    const f = await fetchAccountingUrl(link.url, { source: detailSource || listSource, deadlineAt });
    if (!f.ok) {
      out.failures.push({ url: link.url, error: f.error, reason: f.reason });
      continue;
    }
    const guard = assessFetchedDocument({ httpStatus: f.http_status, html: f.text, url: f.url, contentType: f.content_type });
    if (!guard.ok) {
      out.failures.push({ url: link.url, error: guard.message, reason: guard.reason });
      recordSourceAttempt(detailSource?.code || listSource.code, {
        status: 'blocked', blocked_kind: guard.reason, http_status: f.http_status, error: guard.message, page_url: link.url,
      });
      continue;
    }
    out.fetched += 1;
    const snapshotPath = persistOriginal(f.hash, f.buf, 'html');
    const parsed = parseCrcDailyDetail(f.text, { url: f.url, httpStatus: f.http_status });
    if (!parsed.ok) {
      out.failures.push({ url: link.url, error: parsed.message, reason: parsed.reason });
      if (jobId) {
        addStep(jobId, 200 + out.fetched, {
          stage: 'parse', target: f.url, status: 'failed', items: 0, message: parsed.message,
        });
      }
      continue;
    }
    const d = parsed.data;
    const saved = upsertCrcDaily({
      source_code: detailSource?.code || 'chinacrc_daily_detail',
      detail_url: f.url,
      title: d.title || link.title,
      trade_date: d.trade_date,
      published_at: d.published_at,
      daily_volume_t: d.daily_volume_t,
      daily_amount_yuan: d.daily_amount_yuan,
      daily_avg_price_published: d.daily_avg_price_published,
      cumulative_volume_t: d.cumulative_volume_t,
      cumulative_amount_yuan: d.cumulative_amount_yuan,
      caliber: d.caliber,
      scope: d.scope,
      snapshot_path: snapshotPath,
      content_hash: f.hash,
      parse_note: [
        d.parse_note || null,
        `表格×正文交叉核对：${d.table_prose_cross_check.agree ? '一致' : '存在差异（两方原值均已保留）：' + d.table_prose_cross_check.conflicts.join('、')}`,
        `小计→合计加总核对：${d.subtotal_check.agree ? '一致' : '不一致'}`,
      ].filter(Boolean).join('；'),
      components: d.components,
    }, { actor });
    out.parsed += 1;
    if (saved.action === 'inserted') out.inserted += 1;
    else if (saved.action === 'revision') out.revisions += 1;
    else out.unchanged += 1;
    if (!d.table_prose_cross_check.agree) out.conflicts += 1;
    if (jobId) {
      addStep(jobId, 200 + out.parsed, {
        stage: 'collect', target: f.url, status: 'ok', items: 1,
        message: `清结算日报 ${d.trade_date}｜本日 ${d.daily_volume_t ?? '—'} 吨 / ${d.daily_amount_yuan ?? '—'} 元`,
        detail: { cross_check: d.table_prose_cross_check, subtotal_check: d.subtotal_check, action: saved.action },
      });
    }
  }

  if (detailSource) {
    recordSourceAttempt(detailSource.code, {
      status: out.parsed ? 'ok' : out.failures.length ? 'error' : 'empty',
      success: out.parsed > 0, http_status: 200,
      collected_count: out.parsed,
      status_note: out.parsed ? null : '本轮未解析出新的清结算日报（缓存命中或页面结构变化）',
      error: out.failures.length ? out.failures.map((x) => `${x.url}: ${x.error}`).join(' | ').slice(0, 500) : null,
    });
  }
  out.data_as_of = get('SELECT MAX(trade_date) AS d FROM crc_clearing_daily')?.d || null;
  // 抓取成功但解析 0 行：不是 success，也不能算空扫描（确实有待处理对象却没解析出来）
  if (out.fetched > 0 && out.parsed === 0) {
    out.ok = false;
    out.reason = 'parse_zero';
    out.message = `已抓取 ${out.fetched} 个详情页但解析出 0 行：按失败处理，不记为成功。`;
  }
  return out;
}

/**
 * 从列表页里发现**真实存在**的分页 URL：同路径 + `page=N` 参数。
 * 页面没有分页链接就只抓第一页（不拼猜页码）。
 */
export function paginationLinks(html, pageUrl, listUrl) {
  const out = [];
  const basePath = (() => {
    try { return new URL(listUrl).pathname; } catch { return null; }
  })();
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']*[?&]page=\d+[^"']*)["']/gi)) {
    let u;
    try { u = new URL(m[1], pageUrl); } catch { continue; }
    if (basePath && u.pathname !== basePath) continue;
    if (u.href === pageUrl) continue;
    if (!out.includes(u.href)) out.push(u.href);
  }
  return out.slice(0, 2);
}

function deadlineHit(deadlineAt) {
  return Number.isFinite(Number(deadlineAt)) && Number(deadlineAt) > 0 && Date.now() >= Number(deadlineAt);
}

/* ==================================================================== */
/*  四、标准与技术规范采集                                              */
/* ==================================================================== */

const CONSULTATION_RE = /(征求意见|公开征求|征求[^。；]{0,24}意见)/;
const FORMAL_RE = /(关于印发|关于更新|关于发布|公告)/;

/**
 * 判断规范状态（确定性规则；**不**把征求意见稿当正式版）。
 * @returns {'formal'|'consultation'|'draft'|'historical'}
 */
export function classifyStandardStatus({ title = '', anchor = '' } = {}) {
  const blob = `${title} ${anchor}`;
  if (CONSULTATION_RE.test(blob)) return 'consultation';
  if (/草案/.test(blob)) return 'draft';
  if (/(废止|不再适用|已被替代)/.test(blob)) return 'historical';
  return FORMAL_RE.test(blob) ? 'formal' : 'formal';
}

/**
 * 采集标准与技术规范：公告页 → 真实附件 href → PDF 正文（有页数/页预算上限）→ 模型带引用核验。
 */
export async function collectStandards({ actor = 'system:accounting', cfg = accountingConfig(), deadlineAt = null, jobId = null } = {}) {
  ensureAccountingSeeded();
  const sources = all("SELECT * FROM accounting_source WHERE category='standard' AND enabled=1 ORDER BY code")
    .map((r) => getSource(r.code));
  const out = {
    ok: true, announcements: 0, attachments: 0, new_standards: 0, bodies_fetched: 0,
    bodies_skipped: 0, verified: {}, failures: [], truncated: false, pages_used: 0,
  };
  const maxPdfs = Math.max(0, Number(cfg.max_pdfs_per_run ?? 8));
  let pdfsFetched = 0;

  for (const s of sources) {
    if (deadlineHit(deadlineAt)) { out.truncated = true; break; }
    const f = await fetchAccountingUrl(s.url, { source: s, deadlineAt });
    if (!f.ok) {
      recordSourceAttempt(s.code, {
        status: f.blocked ? 'blocked' : 'error', blocked_kind: f.blocked ? f.reason : null,
        http_status: f.http_status, error: `${f.reason}: ${f.error}`.slice(0, 500), url: f.url,
      });
      out.failures.push({ source: s.code, error: f.error });
      out.ok = false;
      continue;
    }
    const guard = assessFetchedDocument({ httpStatus: f.http_status, html: f.text, url: f.url, contentType: f.content_type });
    if (!guard.ok) {
      recordSourceAttempt(s.code, {
        status: 'blocked', blocked_kind: guard.reason, http_status: f.http_status, error: guard.message,
        url: f.url, content_hash: f.hash, content_bytes: f.bytes,
      });
      out.failures.push({ source: s.code, error: guard.message });
      out.ok = false;
      continue;
    }
    out.announcements += 1;
    const snapshotPath = persistOriginal(f.hash, f.buf, 'html');
    const parsed = parseAnnouncementAttachments(f.text, { baseUrl: f.url });
    recordSourceAttempt(s.code, {
      status: 'ok', success: true, http_status: f.http_status, url: f.url,
      content_hash: f.hash, content_bytes: f.bytes, file_path: snapshotPath,
      collected_count: parsed.files.length,
      status_note: parsed.files.length ? null : '公告页未发现任何附件链接（结构可能已变更）',
    });
    out.attachments += parsed.files.length;

    // 逐一登记 / 更新附件对应的规范元数据
    for (const file of parsed.files) {
      if (deadlineHit(deadlineAt)) { out.truncated = true; break; }
      const status = classifyStandardStatus({ title: parsed.title || s.name, anchor: file.anchor });
      const existing = file.code
        ? get('SELECT * FROM accounting_standard WHERE code = ?', [file.code])
        : get('SELECT * FROM accounting_standard WHERE original_url = ?', [file.url]);
      const row = {
        code: file.code,
        title: cleanStandardTitle(file.anchor),
        issuer: '生态环境部',
        sector: existing?.sector || sectorFromBlob(`${parsed.title} ${file.anchor}`),
        standard_type: file.kind === 'update_note' ? 'update_note' : file.kind === 'verification' ? 'verification' : 'accounting',
        status,
        version: existing?.version || versionFromCode(file.code),
        publish_date: existing?.publish_date || dateFromUrl(f.url),
        issue_date: existing?.issue_date || null,
        effective_year: existing?.effective_year ?? null,
        announcement_url: f.url,
        original_url: file.url,
        body_status: existing?.body_status || 'metadata_only',
        sha256: existing?.sha256 || null,
        pages_total: existing?.pages_total ?? null,
        chars: existing?.chars ?? null,
        source_locator: `公告附件锚文本：${file.anchor}`,
        cets_relation: existing?.cets_relation || '全国碳排放权交易市场技术规范编号体系；正文以生态环境部发布原文为准。',
        metadata_origin: existing?.metadata_origin || `collect:${f.url}`,
        announcement_code: s.code,
      };
      const saved = upsertAccountingStandard(row);
      if (saved.inserted) out.new_standards += 1;
      if (jobId) {
        addStep(jobId, 300 + out.new_standards, {
          stage: 'collect', target: file.url, status: 'ok', items: 1,
          message: `规范元数据：${row.code || row.title}（${row.status}）`,
          detail: { anchor: file.anchor, announcement: f.url },
        });
      }

      // ---- PDF 正文（有界：单次最多 maxPdfs 个）----
      const needBody = !existing || existing.body_status !== 'full';
      if (!needBody || pdfsFetched >= maxPdfs) {
        if(!needBody)out.cache_hits=(out.cache_hits||0)+1;
        if(!needBody && cfg.verify_with_model!==false && existing.model_verify_status!=='verified' && !deadlineHit(deadlineAt)){
          const retry=await verifyStandardWithModel(saved.id,{actor,deadlineAt});out.verified[retry.result]=(out.verified[retry.result]||0)+1;
        }
        if (needBody) out.bodies_skipped += 1;
        continue;
      }
      const body = await fetchStandardBody({
        url: file.url, source: s, deadlineAt, cfg, actor,
        standardId: saved.id, sha256Expected: existing?.sha256 || null,
      });
      pdfsFetched += 1;
      out.pages_used += body.pages_used || 0;
      if (body.ok) out.bodies_fetched += 1;
      else out.failures.push({ source: s.code, url: file.url, error: body.error, reason: body.reason });
      if(body.body_status==='partial'||body.truncated_pages)out.truncated=true;
      if (body.verify) {
        const key = body.verify.result;
        out.verified[key] = (out.verified[key] || 0) + 1;
      }
    }
  }

  // ---- 采集后：模型不会因「无模型」而伪造 verified ----
  out.pending_body = get("SELECT COUNT(*) AS c FROM accounting_standard WHERE body_status='metadata_only'")?.c || 0;
  out.ok=out.ok&&out.failures.length===0;
  if(out.bodies_skipped>0&&maxPdfs>0)out.truncated=true;
  return out;
}

function cleanStandardTitle(anchor) {
  return String(anchor || '')
    .replace(/^《([^《》]+)》$/, '$1')
    .replace(/（全国碳排放权交易市场技术规范编号：[^）]*）/g, '')
    .replace(/\(全国碳排放权交易市场技术规范编号：[^)]*\)/g, '')
    .replace(/（CETS[^）]*）/g, '')
    .replace(/\(CETS[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim() || String(anchor || '').trim();
}

function versionFromCode(code) {
  const m = String(code || '').match(/(V\d{2})-(\d{4})$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function sectorFromBlob(blob) {
  for (const s of ['发电', '钢铁', '水泥', '铝冶炼', '民航', '石化', '化工', '造纸']) {
    if (String(blob).includes(s)) return s;
  }
  return null;
}

function dateFromUrl(url) {
  const m = String(url).match(/\/(20\d{2})(\d{2})\/t(20\d{2})(\d{2})(\d{2})_/);
  return m ? `${m[3]}-${m[4]}-${m[5]}` : null;
}

/** 下载并逐页解析规范 PDF 正文，再交已配置模型做带引用核验（无模型则 unavailable）。 */
async function fetchStandardBody({ url, source, deadlineAt, cfg, actor, standardId, sha256Expected = null }) {
  const f = await fetchAccountingUrl(url, { source, deadlineAt, kind: 'pdf', timeoutMs: 30000 });
  if (!f.ok) return { ok: false, error: f.error, reason: f.reason };
  const isPdf = /application\/pdf/i.test(f.content_type || '') || f.buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf) {
    return { ok: false, error: `附件不是 PDF（content-type=${f.content_type || '未知'}）`, reason: 'not_pdf' };
  }
  const filePath = persistOriginal(f.hash, f.buf, 'pdf');
  const parsed = await parsePdfDocument({filePath,sha256:f.hash,deadlineAt,maxPages:Number(cfg.max_pages_per_pdf)||60});
  if(!parsed.text) return {ok:false,error:parsed.error||'未取得可用正文',reason:parsed.aborted||'pdf_no_text'};
  const info={pages:parsed.pages_total};const pagesToRead=parsed.pages.filter(p=>p.text).length;const body=parsed.text;
  const attach=attachStandardBody(standardId,{bodyText:body,source:url,sha256:f.hash,pagesTotal:info.pages,pagesRead:pagesToRead,extractionComplete:pagesToRead===info.pages&&!parsed.aborted,actor});
  const verify = cfg.verify_with_model !== false
    ? await verifyStandardWithModel(standardId, { actor, deadlineAt })
    : { result: 'unavailable', reason: 'disabled_by_config' };
  return {
    ok: true, pages_used: pagesToRead, pages_total: info.pages, chars: body.length,
    truncated_pages: pagesToRead < info.pages, sha256: f.hash, hash_changed: !!sha256Expected && f.hash !== sha256Expected,
    body_status: attach.body_status, verify,
  };
}

/* ==================================================================== */
/*  五、模型核验（带引用；无模型/超时 → unavailable，不伪造 verified）  */
/* ==================================================================== */

/**
 * 用已配置的真实模型核对「规范正文 ↔ 元数据」是否一致，并要求给出可定位引用。
 * 结论只写 model_verify_status；**不**修改任何官方数值或元数据。
 */
export async function verifyStandardWithModel(standardId,{actor='system:accounting',deadlineAt=null,force=false}={}) {
 const std=get('SELECT * FROM accounting_standard WHERE id=? OR code=?',[String(standardId),String(standardId)]);
 if(!std)return{result:'unavailable',reason:'not_found'};
 const out=await verifyAccountingEvidence({objectType:'accounting_standard',objectId:std.id,body:std.body_text,metadata:{code:std.code,title:std.title,sector:std.sector,version:std.version},url:std.original_url,complete:std.body_status==='full'&&!!std.extraction_complete,actor,deadlineAt,force});
 run('UPDATE accounting_standard SET model_verify_status=?,model_verify_at=?,verify_input_hash=?,verify_source_url=? WHERE id=?',[out.result,nowIso(),out.input_hash,std.original_url,std.id]);return out;
}

/* ==================================================================== */
/*  六、电力因子 PDF 采集（哈希校验：原件变了不覆盖已核实值）            */
/* ==================================================================== */

export async function collectElectricityFactorPdf({ actor = 'system:accounting', cfg = accountingConfig(), deadlineAt = null, jobId = null } = {}) {
  ensureAccountingSeeded();
  const source = getSource(ELECTRICITY_FACTOR_SOURCE.code);
  if (!source) return { ok: false, reason: 'no_source', message: '未登记电力因子原件来源' };
  const f = await fetchAccountingUrl(ELECTRICITY_FACTOR_PDF_URL, { source, deadlineAt, kind: 'pdf', timeoutMs: 30000 });
  if (!f.ok) {
    recordSourceAttempt(source.code, {
      status: f.blocked ? 'blocked' : 'error', blocked_kind: f.blocked ? f.reason : null,
      http_status: f.http_status, error: `${f.reason}: ${f.error}`.slice(0, 500), url: f.url,
    });
    return { ok: false, reason: f.reason, message: f.error };
  }
  const isPdf = /application\/pdf/i.test(f.content_type || '') || f.buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf) {
    recordSourceAttempt(source.code, {
      status: 'error', http_status: f.http_status, url: f.url,
      error: `原件不是 PDF（content-type=${f.content_type || '未知'}）：不解析、不写入任何因子值`,
    });
    return { ok: false, reason: 'not_pdf', message: '原件不是 PDF，未写入任何因子值' };
  }
  const filePath = persistOriginal(f.hash, f.buf, 'pdf');
  const info = await pdfInfoPages(filePath, { deadlineAt });
  if (!info.ok) return { ok: false, reason: 'pdf_info_failed', message: info.error };
  const text = await pdfTextPages(filePath, { deadlineAt, expectPages: info.pages });
  if (!text.ok) return { ok: false, reason: 'pdf_text_failed', message: text.error };
  const parsed = parseElectricityFactorPages(text.pages, { url: ELECTRICITY_FACTOR_PDF_URL, sha256: f.hash });
  if (!parsed.ok || parsed.stats?.structurally_expected===false) {
    recordSourceAttempt(source.code, {
      status: 'error', http_status: f.http_status, url: f.url, content_hash: f.hash,
      content_bytes: f.bytes, file_path: filePath, error: `${parsed.reason}: ${parsed.message}`,
    });
    return { ok: false, reason: parsed.reason, message: parsed.message };
  }
  const expectedSha = ELECTRICITY_FACTOR_SOURCE.sha256;
  const hashChanged = f.hash !== expectedSha;
  // 哈希变化时先比对数值：一致则只更新哈希；不一致则**不覆盖**已核实值，标记为待核实
  let mismatches = [];
  if (hashChanged) {
    const current = all('SELECT identity_key, value FROM emission_factor WHERE source_code=? AND is_current=1', [source.code]);
    const byIdentity = new Map(current.map((r) => [r.identity_key, r.value]));
    for (const row of parsed.rows) {
      const identity = [source.code, row.category, row.region || '全国', row.data_year, '2023'].join('|');
      const old = byIdentity.get(identity);
      if (old !== undefined && Math.abs(Number(old) - Number(row.value)) > 1e-9) {
        mismatches.push({ identity, old_value: old, new_value: row.value });
      }
    }
  }
  let written = 0;
  if (hashChanged && mismatches.length) {
    const verification=cfg.verify_with_model===false?{result:'unavailable',reason:'disabled_by_config'}:await verifyAccountingEvidence({objectType:'emission_factor_revision',objectId:f.hash,body:text.pages.join('\n\f\n'),metadata:{data_year:2023,gas:'CO2',unit:'kgCO2/kWh',differences:mismatches},url:ELECTRICITY_FACTOR_PDF_URL,complete:parsed.stats.structurally_expected,actor,deadlineAt});
    recordSourceAttempt(source.code, {
      status: 'stale', http_status: f.http_status, url: f.url, content_hash: f.hash,
      content_bytes: f.bytes, file_path: filePath, collected_count: 0,
      status_note:
        `原件哈希已变化（记录 ${String(expectedSha).slice(0, 12)}…，实际 ${f.hash.slice(0, 12)}…），` +
        `且有 ${mismatches.length} 行数值与已核实值不同：**不覆盖**已核实因子值，` +
        '按「来源已变更待核实」处理，下一轮自动核对原件并重试；保留原值及差异记录。',
      error: null,
    });
    return {
      ok: false, reason: 'hash_changed_values_differ', hash_changed: true, mismatches, verification,
      message: '原件哈希变化且数值不一致：未覆盖任何已核实值。', rows_parsed: parsed.rows.length,
    };
  }
  for (const row of parsed.rows) {
    const r = upsertEmissionFactor({
      ...row,
      source_code:source.code,name:row.locator,industry:'电力',standard_unit:row.original_unit,
      original_url:ELECTRICITY_FACTOR_PDF_URL,original_sha256:f.hash,
      version: '2023',
      publish_date: ELECTRICITY_FACTOR_SOURCE.publish_date,
      applicability:
        '用于外购电力的二氧化碳排放参考计算（CO2）。本因子不是产品全生命周期碳足迹因子，' +
        '也不是 CCER 区域电网基准线排放因子。',
      evidence_level: 'full',
      metadata_origin: `collect:${ELECTRICITY_FACTOR_PDF_URL}#sha256:${f.hash.slice(0, 12)}`,
    });
    if (r.inserted) written += 1;
  }
  let verification={result:'unavailable',reason:'disabled_by_config'};
  run('UPDATE emission_factor SET snapshot_path=? WHERE original_sha256=?',[filePath,f.hash]);
  if(cfg.verify_with_model!==false) verification=await verifyAccountingEvidence({objectType:'emission_factor_document',objectId:f.hash,body:text.pages.map((p,i)=>`第${i+1}页\n${p}`).join('\n'),metadata:{data_year:2023,gas:'CO2',unit:'kgCO2/kWh',rows:parsed.rows.map(r=>({region:r.region,category:r.category,value:r.value}))},url:ELECTRICITY_FACTOR_PDF_URL,complete:true,actor,deadlineAt});
  run('UPDATE emission_factor SET model_verify_status=?,model_verify_at=?,model_verify_input_hash=? WHERE original_sha256=?',[verification.result,nowIso(),verification.input_hash||null,f.hash]);
  // 原件页数/字数变化也要如实登记
  recordSourceAttempt(source.code, {
    status: 'ok', success: true, http_status: f.http_status, url: f.url, content_hash: f.hash,
    content_bytes: f.bytes, file_path: filePath, collected_count: parsed.rows.length,
    status_note: hashChanged
      ? `原件哈希与随代码核实记录不同但 40 行数值一致，已按新哈希登记（页数 ${info.pages}）。`
      : `哈希与随代码核实记录一致（${String(expectedSha).slice(0, 12)}…），40 行数值复核通过。`,
    error: null,
  });
  if (jobId) {
    addStep(jobId, 400, {
      stage: 'collect', target: ELECTRICITY_FACTOR_PDF_URL, status: 'ok', items: parsed.rows.length,
      message: `电力 CO2 因子 ${parsed.rows.length} 行（物理 ${info.pages} 页，打印页 ${parsed.stats.printed_pages.join('、')}）`,
      detail: { stats: parsed.stats, hash_changed: hashChanged },
    });
  }
  return {
    ok: true, rows: parsed.rows.length, written, stats: parsed.stats, hash_changed: hashChanged, verification,
    pages_total: info.pages, chars: text.pages.join('').length,
  };
}

/* ==================================================================== */
/*  七、受阻门户探测（412 / 登录页一律如实登记，不当正文）              */
/* ==================================================================== */

export async function probeBlockedPortals({ actor = 'system:accounting', deadlineAt = null, jobId = null } = {}) {
  ensureAccountingSeeded();
  const codes = ['ncsc_factor_portal', 'cets_portal', 'chinacrc_home', 'chinacrc_cancel_disclosure'];
  const out = { ok: true, probed: [], blocked: 0, reachable: 0, failures: [] };
  for (const code of codes) {
    if (deadlineHit(deadlineAt)) break;
    const s = getSource(code);
    if (!s) continue;
    const f = await fetchAccountingUrl(s.url, { source: s, deadlineAt, timeoutMs: 15000 });
    if (!f.ok) {
      const kind = f.http_status === 412 ? 'http_412_challenge' : f.blocked ? 'blocked_url' : 'network';
      recordSourceAttempt(code, {
        status: f.http_status === 412 ? 'blocked' : 'error', blocked_kind: kind,
        http_status: f.http_status, error: `${f.reason}: ${f.error}`.slice(0, 500), url: f.url,
      });
      out.probed.push({ code, http_status: f.http_status, status: f.http_status === 412 ? 'blocked' : 'error', kind });
      if (f.http_status === 412) out.blocked += 1; else out.failures.push({ code, error: f.error });
      continue;
    }
    const guard = assessFetchedDocument({ httpStatus: f.http_status, html: f.text, url: f.url, contentType: f.content_type });
    if (!guard.ok) {
      recordSourceAttempt(code, {
        status: 'blocked', blocked_kind: guard.reason, http_status: f.http_status, error: guard.message,
        url: f.url, content_hash: f.hash, content_bytes: f.bytes,
      });
      out.probed.push({ code, http_status: f.http_status, status: 'blocked', kind: guard.reason, message: guard.message });
      out.blocked += 1;
      continue;
    }
    // 可达：只登记 HTTP/哈希，**不采集正文数值**（门户页不是资料本身）
    recordSourceAttempt(code, {
      status: 'ok', success: true, http_status: f.http_status, url: f.url,
      content_hash: f.hash, content_bytes: f.bytes, collected_count: 0,
      status_note: '门户页可达：仅登记来源与快照哈希，未从门户页提取业务数值（门户页不是资料本身）。',
    });
    out.reachable += 1;
    out.probed.push({ code, http_status: f.http_status, status: 'ok', kind: null });
  }
  if (jobId) {
    addStep(jobId, 500, {
      stage: 'probe', target: 'portals', status: 'ok', items: out.probed.length,
      message: `门户探测：受阻 ${out.blocked}、可达 ${out.reachable}`,
      detail: { probed: out.probed },
    });
  }
  return out;
}

/* ==================================================================== */
/*  八、统一批次编排（有界、单并发、共享 deadline）                     */
/* ==================================================================== */

/**
 * 执行一次有界采集。所有子采集器共用同一个 deadlineAt，绝不各自重置批次预算。
 */
export async function runAccountingCollectTarget({ target = 'all', actor = 'system:accounting', trigger = 'manual', cfg = accountingConfig(), deadlineAt = null } = {}) {
  ensureAccountingSeeded();
  const budget = Math.max(5000, Math.min(Number(cfg.batch_budget_ms) || 120000, 120000));
  const started = Date.now();
  const deadline = deadlineAt || started + budget;
  const t = ACCOUNTING_TARGETS.includes(target) ? target : 'all';

  const running = runningJob();
  if (running) {
    return {
      ok: true, merged: true, merged_into_job_id: running.id, status: 'running',
      message: `已有运行中的碳核算资料采集作业（job=${running.id}），本次请求合并，不重复抓取。`,
      started_at: running.started_at,
    };
  }
  const jobId = startJob({ title: '公开碳核算资料采集', trigger, actor });
  const stats = { found: 0, parsed: 0, validated: 0, cached:0, checked:0, errors: 0 };
  const detail = {};
  try {
    if (t === 'cets_public' || t === 'all') {
      detail.cets_public=await collectCetsPublic({actor,cfg,deadlineAt:deadline});stats.found+=detail.cets_public.found||0;stats.parsed+=detail.cets_public.parsed||0;stats.errors+=(detail.cets_public.failures||[]).length;stats.validated+=(detail.cets_public.verification||[]).length;
      stats.cached+=detail.cets_public.unchanged||0;
    }
    if (t === 'crc_daily' || t === 'all') {
      detail.crc_daily = await collectCrcDaily({ actor, cfg, deadlineAt: deadline, jobId });
      stats.found += detail.crc_daily.discovered || 0;
      stats.parsed += detail.crc_daily.parsed || 0;
      stats.cached+=detail.crc_daily.cache_hits||0;
      if (detail.crc_daily.ok === false) stats.errors += 1;
    }
    if (t === 'standards' || t === 'all') {
      detail.standards = await collectStandards({ actor, cfg, deadlineAt: deadline, jobId });
      stats.found += detail.standards.attachments || 0;
      stats.parsed += detail.standards.bodies_fetched || 0;
      stats.cached+=detail.standards.cache_hits||0;
      const vv = detail.standards.verified || {};
      stats.validated += (vv.verified || 0) + (vv.insufficient || 0) + (vv.conflict || 0);
      if (detail.standards.ok === false) stats.errors += 1;
    }
    if (t === 'factor_pdf' || t === 'all') {
      detail.factor_pdf = await collectElectricityFactorPdf({ actor, cfg, deadlineAt: deadline, jobId });
      stats.found += detail.factor_pdf.rows || 0;
      stats.parsed += detail.factor_pdf.rows || 0;
      if(detail.factor_pdf.verification)stats.validated++;
      if (detail.factor_pdf.ok === false) stats.errors += 1;
    }
    if (t === 'portals' || t === 'all') {
      detail.portals = await probeBlockedPortals({ actor, deadlineAt: deadline, jobId });
      // 412 是**已知来源限制**，如实登记为缺口，不算任务故障
      stats.found += detail.portals.probed?.length || 0;
      stats.checked+=detail.portals.probed?.length||0;
      stats.errors += (detail.portals.failures || []).length;
    }
  } catch (e) {
    stats.errors += 1;
    addStep(jobId, 9999, { stage: 'collect', target: t, status: 'failed', message: e.message });
    detail.error = e.message;
  }
  const elapsed = Date.now() - started;
  const noPendingObjects = stats.errors===0 && (stats.found || 0) === 0 && (stats.parsed || 0) === 0 && !Object.values(detail).some(x=>x?.truncated);
  // 状态判定：0 行解析且确实无待处理对象 → success(empty)，否则 0 行按 partial/failed
  let status;
  if (Date.now()>=deadline || Object.values(detail).some(x=>x?.truncated)) status='partial';
  else if (stats.errors === 0) status = 'success';
  else if (stats.parsed > 0) status = 'partial';
  else status = 'failed';
  finishJob(jobId, {
    status, stats, dataAsOf: detail.crc_daily?.data_as_of || null,
    errorSummary: stats.errors ? `${stats.errors} 项采集/解析问题，详见步骤与来源状态` : null,
    detail: { ...detail, elapsed_ms: elapsed, budget_ms: budget, empty_scan: noPendingObjects, target: t },
  });
  return {
    ok: status !== 'failed', job_id: jobId, status, target: t, stats,
    elapsed_ms: elapsed, budget_ms: budget, empty_scan: noPendingObjects, detail,
  };
}

/* ==================================================================== */
/*  九、异步任务（POST 202 + task_id + 轮询；单并发、重入合并）         */
/* ==================================================================== */

const TASKS = new Map();

function publicTask(t) {
  return {
    task_id: t.id,
    target: t.target,
    status: t.status,
    queued_at: t.queued_at,
    started_at: t.started_at,
    finished_at: t.finished_at,
    actor: t.actor,
    budget_ms: t.budget_ms,
    elapsed_ms: t.started_at
      ? (t.finished_at ? Date.parse(t.finished_at) - Date.parse(t.started_at) : Date.now() - Date.parse(t.started_at))
      : null,
    job_id: t.job_id || null,
    error: t.error || null,
    progress: t.progress || null,
    result: t.result || null,
  };
}

function runningTaskFor(target) {
  for (const t of TASKS.values()) {
    if (t.target !== target) continue;
    if (t.status !== 'queued' && t.status !== 'running') continue;
    const startedMs = Date.parse(t.started_at || t.queued_at || '') || 0;
    if (startedMs && Date.now() - startedMs > ACCOUNTING_STALE_TASK_MS) {
      t.status = 'failed';
      t.error = `任务僵死：超过 ${Math.round(ACCOUNTING_STALE_TASK_MS / 60000)} 分钟未收尾，已标记失败（可能因进程中断）。`;
      t.finished_at = nowIso();
      continue;
    }
    return t;
  }
  return null;
}

function trimTasks() {
  const list = [...TASKS.values()].sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)));
  for (const t of list.slice(ACCOUNTING_TASK_KEEP)) TASKS.delete(t.id);
}

export function getAccountingCollectTask(taskId) {
  const t = TASKS.get(String(taskId));
  return t ? publicTask(t) : null;
}

export function listAccountingCollectTasks({ limit = 20 } = {}) {
  return [...TASKS.values()]
    .sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)))
    .slice(0, Math.min(Number(limit) || 20, ACCOUNTING_TASK_KEEP))
    .map(publicTask);
}

/**
 * 受理一次采集中（立即返回 202 语义）。重入：同目标已有 queued/running → 合并，不重复抓取。
 */
export function startAccountingCollectTask({ target = 'all', actor = 'system:accounting', body = {}, cfg = accountingConfig() } = {}) {
  if (!ACCOUNTING_TARGETS.includes(target)) {
    return { error: `未知采集目标：${target}`, allowed: ACCOUNTING_TARGETS, status: 400 };
  }
  const existing = runningTaskFor(target);
  if (existing) {
    return {
      ...publicTask(existing), merged: true, accepted: true, http_status: 202,
      message: `该目标已有${existing.status === 'queued' ? '排队' : '运行'}中的采集任务（task=${existing.id}），本次请求合并，不重复抓取。`,
    };
  }
  const budget = Math.max(5000, Math.min(Number(cfg.batch_budget_ms) || 120000, 120000));
  const id = newId('ACCTASK');
  const task = {
    id, target, status: 'queued', queued_at: nowIso(), started_at: null, finished_at: null,
    actor, result: null, error: null, job_id: null, budget_ms: budget, progress: { stage: 'queued' },
  };
  TASKS.set(id, task);
  setTimeout(() => {
    runTask(id, { target, actor, body, cfg, budget }).catch((e) => {
      task.status = 'failed';
      task.error = `后台任务异常：${e.message}`;
      task.finished_at = nowIso();
    });
  }, 0);
  trimTasks();
  audit({ actor, action: 'accounting.collect_task_accepted', objectType: 'accounting_task', objectId: id, detail: { target, budget_ms: budget } });
  return { ...publicTask(task), accepted: true, http_status: 202 };
}

async function runTask(id, { target, actor, cfg, budget }) {
  const task = TASKS.get(id);
  if (!task) return;
  task.status = 'running';
  task.started_at = nowIso();
  task.progress = { stage: 'collecting', target };
  const deadlineAt = Date.now() + budget;
  try {
    const out = await runAccountingCollectTarget({ target, actor, trigger: 'manual', cfg, deadlineAt });
    task.result = out;
    task.job_id = out?.job_id || out?.merged_into_job_id || null;
    // 「受理成功」不等于「采集成功」：0 行解析且非空扫描 → 不得标 success
    const sum = summarizeAccountingOutcome(out);
    task.status = sum.status;
    if (sum.status === 'failed') task.error = sum.note;
    task.progress = { stage: 'finished', summary: sum };
  } catch (e) {
    task.status = 'failed';
    task.error = `采集异常：${e.message}`;
  } finally {
    if (task.status === 'running') task.status = 'failed';
    task.finished_at = nowIso();
    audit({
      actor, action: 'accounting.collect_task_finished', objectType: 'accounting_task', objectId: id,
      detail: { target, status: task.status, job_id: task.job_id }, result: task.status === 'success' ? 'ok' : 'warning',
    });
  }
}

/** 把批次结果折算为任务状态（明确区分「空扫描」与「抓到了却解析 0 行」）。 */
export function summarizeAccountingOutcome(out = {}) {
  const stats = out.stats || {};
  const errs = Number(stats.errors) || 0;
  const parsed = Number(stats.parsed) || 0;
  const cached=Number(stats.cached)||0,checked=Number(stats.checked)||0;
  if(out.merged)return{status:'partial',note:'已有采集批次运行，本目标未重复执行；保留作业关联并在后续批次重试。'};
  if(out.status==='partial')return{status:'partial',note:'批次达到预算或仍有未处理资料，已保留本轮有效结果，后续继续。'};
  if(out.status==='failed')return{status:'failed',note:out.detail?.error||`${errs} 项采集/解析失败`};
  if (out.empty_scan && errs === 0) {
    return { status: 'success', note: '无待处理对象：空扫描，不是失败，也不是采集成功。', empty_scan: true };
  }
  if (errs === 0 && parsed+cached+checked > 0) return { status: 'success', note: cached>0?'有效资料未变化，已复用可追溯缓存。':checked>0?'来源可用性检查完成，受限来源仍保留缺口。':null };
  if (parsed+cached+checked > 0) return { status: 'partial', note: `${errs} 项问题，已解析 ${parsed} 项、复用 ${cached} 项` };
  if (errs === 0) {
    return {
      status: 'failed',
      note: '本次未解析出任何对象（也没有可判定为“无待处理对象”的依据）：按失败处理，不把 accepted 或 0 行解析称成功。',
    };
  }
  return { status: 'failed', note: `${errs} 项采集/解析失败` };
}

/** 任务运行状态与重试游标。 */
export function accountingCollectStatus() {
  return {
    job_key: ACCOUNTING_JOB_KEY,
    running_job: (() => {
      const r = runningJob();
      return r ? { id: r.id, started_at: r.started_at, trigger: r.trigger_kind, triggered_by: r.triggered_by } : null;
    })(),
    tasks: listAccountingCollectTasks({ limit: 10 }),
    cursor: readAccountingCursor(),
    last_job: (() => {
      const r = get(
        `SELECT * FROM ingestion_job WHERE job_key=? AND status!='running' ORDER BY started_at DESC LIMIT 1`,
        [ACCOUNTING_JOB_KEY]
      );
      if (!r) return null;
      return {
        id: r.id, status: r.status, started_at: r.started_at, finished_at: r.finished_at,
        items_found: r.items_found, items_parsed: r.items_parsed, items_validated: r.items_validated,
        error_count: r.error_count, error_summary: r.error_summary, data_as_of: r.data_as_of,
        detail: uj(r.detail_json, null),
      };
    })(),
    config: accountingConfig(),
    roots: { accounting_originals: accountingRoot() },
  };
}

/* ==================================================================== */
/*  十、重试游标                                                        */
/* ==================================================================== */

export function readAccountingCursor() {
  return uj(getCursorRaw(), null) || {
    last_run_at: null, crc_last_trade_date: null, standards_body_pending: null, note: '尚未执行过碳核算资料采集。',
  };
}

function getCursorRaw() {
  const row = get('SELECT value FROM system_meta WHERE key=?', [ACCOUNTING_CURSOR_META_KEY]);
  return row?.value || null;
}

export function writeAccountingCursor(patch = {}) {
  const next = { ...readAccountingCursor(), ...patch, updated_at: nowIso() };
  run(
    `INSERT INTO system_meta (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [ACCOUNTING_CURSOR_META_KEY, j(next), nowIso()]
  );
  return next;
}

/* ==================================================================== */
/*  十一、每日步骤（接入 06:30 全平台任务；有界 + 游标）                */
/* ==================================================================== */

/**
 * 每日有界采集步骤（由 collect-svc.runDailyJob 调用）。
 * 任一来源失败只影响该来源，不中断每日任务；无待处理对象属于**空扫描**。
 */
export async function runAccountingDailyStep({actor='system:daily-accounting',trigger='schedule',cfg=accountingConfig(),deadlineAt=null}={}) {
 const cursor=readAccountingCursor();const targets=['crc_daily','cets_public','standards','factor_pdf','portals'];const index=Number(cursor.rotation||0)%targets.length;
 // Every daily pass attempts latest CRC and CETS, then rotates a bounded remaining target.
 const deadline=deadlineAt||Date.now()+Math.min(120000,Number(cfg.batch_budget_ms)||120000);
 const results={};results.crc_daily=await collectCrcDaily({actor,cfg,deadlineAt:Math.min(deadline,Date.now()+25000)});
 results.cets_public=[];
 for(let i=0;i<4&&Date.now()<deadline-3000;i++)results.cets_public.push(await collectCetsPublic({actor,cfg,deadlineAt:Math.min(deadline,Date.now()+18000)}));
 const target=targets[index];if(Date.now()<deadline-3000 && !['crc_daily','cets_public'].includes(target))results.extra=await runAccountingCollectTarget({target,actor,trigger,cfg,deadlineAt:deadline});
 const parsed=(results.crc_daily?.parsed||0)+results.cets_public.reduce((n,r)=>n+(r.parsed||0),0)+(results.extra?.stats?.parsed||0);
 const errors=(results.crc_daily?.failures?.length||0)+results.cets_public.reduce((n,r)=>n+(r.failures?.length||0),0)+(results.extra?.stats?.errors||0);
 const truncated=Date.now()>=deadline||results.crc_daily?.truncated||results.cets_public.some(r=>r.truncated)||results.extra?.status==='partial';
 writeAccountingCursor({last_run_at:nowIso(),rotation:index+1,last_target:target,last_deadline_hit:!!truncated,crc_last_trade_date:results.crc_daily?.data_as_of||get('SELECT MAX(trade_date) d FROM crc_clearing_daily WHERE is_current=1')?.d||null,standards_body_pending:get("SELECT COUNT(*) c FROM accounting_standard WHERE body_status='metadata_only'")?.c||0,note:truncated?'本轮达到分项或整批预算，已保留有效资料并轮转重试。':errors?'本轮增量核对已完成；受限来源保留具体原因，后续自动重试。':'最近一次按日增量核对已完成。'});
 return{ok:errors===0&&!truncated,parsed,errors,empty_scan:parsed===0&&errors===0&&!truncated,...results,cursor:readAccountingCursor(),deadline_exceeded:!!truncated};
}

/* ==================================================================== */
/*  十二、搜索后备通道（**只用于发现官方镜像 URL**，不用摘要生成事实）  */
/* ==================================================================== */

/**
 * 官方 HTML/PDF 取不到时，用已配置搜索服务寻找**同一官方域名**上的镜像 URL。
 * 纪律：搜索结果只用于定位 URL；随后仍按同样的确定性解析器抓取与解析，
 * 绝不把搜索摘要、标题或模型改写内容当作事实写入。
 */
export async function findOfficialMirror(query, { allowedDomains = [], deadlineAt = null } = {}) {
  let search = null;
  try {
    search = await import('./search-svc.mjs');
  } catch (e) {
    return { ok: false, reason: 'search_module_error', message: e.message, urls: [] };
  }
  const provider = search.pickSearchProvider();
  if (!provider) return { ok: false, reason: 'no_search_provider', message: '未配置搜索服务：无法寻找官方镜像', urls: [] };
  if (deadlineHit(deadlineAt)) return { ok: false, reason: 'deadline_exceeded', message: '批次时间上限已到', urls: [] };
  const r = await search.runSearch(provider, query, { count: 8, timeoutMs: 15000 });
  if (!r.ok) return { ok: false, reason: r.reason || 'search_failed', message: r.message || '', urls: [] };
  const urls = [];
  for (const item of r.results || []) {
    let u;
    try {
      u = new URL(item.url);
    } catch {
      continue;
    }
    if (allowedDomains.length && !allowedDomains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))) continue;
    urls.push({ url: item.url, title: item.title || null, domain: u.hostname });
  }
  return {
    ok: urls.length > 0, urls,
    note: '搜索结果仅用于定位官方域名上的 URL；事实仍由确定性解析器从原文取数。',
  };
}

/* ==================================================================== */
/*  十三、管理员上传标准的 PDF 解析入口（复用 pdf-parse + 模型核验）     */
/* ==================================================================== */

/**
 * 解析管理员上传的标准 PDF 正文（供 document-upload 路径调用）。
 * 成功提取后自动交已配置模型核对；**不增加任何人工审核状态**。
 */
export async function ingestStandardPdf({ standardId, filePath, actor = 'system:upload', deadlineAt = null } = {}) {
  if (!filePath || !existsSync(filePath)) return { error: '文件不存在或无权限读取', status: 400 };
  const std = get('SELECT * FROM accounting_standard WHERE id=? OR code=?', [String(standardId), String(standardId)]);
  if (!std) return { error: '未找到该标准', status: 404 };
  const buf = readFileSync(filePath);
  const hash = sha256(buf);
  const parsed=await parsePdfDocument({filePath,sha256:hash,deadlineAt,maxPages:accountingConfig().max_pages_per_pdf});
  if(!parsed.text)return{error:parsed.error||'未获得可用正文，已尝试配置的OCR',status:422,needs_ocr:true,sha256:hash,pages_total:parsed.pages_total};
  const info={pages:parsed.pages_total};persistOriginal(hash,buf,'pdf');
  const usable=parsed.pages.filter(p=>p.text).length;
  const attach=attachStandardBody(std.id,{bodyText:parsed.text,source:'管理员补充PDF',sha256:hash,pagesTotal:info.pages,pagesRead:usable,extractionComplete:usable===info.pages&&!parsed.aborted,origin:'admin_upload',actor});
  if (attach.error) return { error: attach.error, status: attach.status || 400 };
  const verify = await verifyStandardWithModel(std.id, { actor, deadlineAt });
  return {
    ok: true, standard_id: std.id, body_status: attach.body_status, chars: attach.chars,
    pages_total: info.pages, sha256: hash, verify,
    note: '正文已落库并交已配置模型做带引用核验；核验结论不改变规范编号、日期等确定性元数据。',
  };
}
