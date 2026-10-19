/**
 * 百度 OCR 服务（docs/36 第 1、3、4 条）
 * ============================================================================
 * 【范围】只做两件事：
 *   1. 经典**高精度**接口 accurate_basic 的单页识别（本轮主线，完整实现）；
 *   2. 异步文档解析的能力探测、提交、查询与结果下载（默认尚未探测；
 *      实际获得可核对页码的文字后才计成功，不自动切换付费模式）。
 *
 * 【凭据纪律】
 *   · 两个字段（api_key + secret_key）作为**一个 JSON 整体**用既有 AES-256-GCM
 *     `encryptSecret()` 加密后存入 `system_meta.baidu_ocr_config_v1`；
 *   · 支持服务端环境变量 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY；
 *   · `baiduOcrPublicConfig()` 是唯一允许返回给接口/界面的视图：只给
 *     `credential_configured` / 来源 / 模式 / 配额限时 / 统计，**绝不含 cipher 或 secret**；
 *   · 本模块不打印、不返回、不写日志任何明文密钥；access_token 只存内存。
 *
 * 【接口域名固定】
 *   `CCER_BAIDU_OCR_BASE_URL` 只在显式开启回环出站（`CCER_ALLOW_LOOPBACK_OUTBOUND=1`，
 *   仅自动化测试/本机联调设置）时才被采用；生产启动不设该变量 → 基址恒为百度官方域名。
 *   后台配置里**没有**任何 base_url 字段，管理员无法把接口改到私网地址。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as dbGet, metaValue, setMeta, getDb, audit } from '../core/db.mjs';
import { newId, nowIso, uj, j } from '../core/util.mjs';
import { encryptSecret, decryptSecret, secretsConfigured, validCredentialRef } from '../core/secrets.mjs';
import { fetchText, loopbackOutboundAllowed, checkOutboundUrl } from './collect-svc.mjs';
import { runToolToFile } from './exec-tool.mjs';

/* ==================================================================== */
/*  一、常量：接口端点（固定，不可由后台修改）                           */
/* ==================================================================== */

/** 百度 AI 开放平台官方域名（鉴权 + 经典 OCR） */
export const BAIDU_OFFICIAL_HOSTS = ['aip.baidubce.com'];
/** 文档解析结果链接允许的官方对象存储域名（BOS） */
export const BAIDU_BOS_SUFFIXES = ['bcebos.com', 'baidubce.com'];

export const OCR_AUTH_PATH = '/oauth/2.0/token';
export const OCR_ACCURATE_PATH = '/rest/2.0/ocr/v1/accurate_basic';
export const DOC_PARSER_SUBMIT_PATH = '/rest/2.0/brain/online/v2/parser/task';
export const DOC_PARSER_QUERY_PATH = '/rest/2.0/brain/online/v2/parser/task/query';

/** 接口基址：生产恒为官方域名；仅联调/测试（显式允许回环出站）可注入本机 stub。 */
export function ocrBaseUrl() {
  const raw = process.env.CCER_BAIDU_OCR_BASE_URL;
  if (!raw) return 'https://aip.baidubce.com';
  if (!loopbackOutboundAllowed()) return 'https://aip.baidubce.com';
  const cleaned = String(raw).trim().replace(/\/+$/, '');
  try {
    new URL(cleaned);
    return cleaned;
  } catch {
    return 'https://aip.baidubce.com';
  }
}

/** 当前基址对应的出站白名单（默认只有官方域名）。 */
export function ocrAllowedDomains() {
  try {
    return [new URL(ocrBaseUrl()).hostname];
  } catch {
    return [...BAIDU_OFFICIAL_HOSTS];
  }
}

/** 单次可内联提交的 PDF 上限：经典接口 pdf_file 为 base64，原始上限 4MB。 */
export const OCR_MAX_INLINE_PDF_BYTES = 4 * 1024 * 1024;
/** base64 后不得越界，因此原始字节上限取 3/4。 */
export const OCR_MAX_RAW_PDF_BYTES = Math.floor((OCR_MAX_INLINE_PDF_BYTES / 4) * 3);

/* ==================================================================== */
/*  二、错误分类（鉴权 / 额度 / 权限 / 超时 分列，不混为一谈）             */
/* ==================================================================== */

/** access_token 失效类：允许「刷新一次 + 重试一次」，绝不无限重试。 */
export const BAIDU_AUTH_CODES = new Set([110, 111]);
/** 额度类：日/总量/QPS 超限。 */
export const BAIDU_QUOTA_CODES = new Set([4, 17, 18, 19]);
/** 权限类：未开通/无权限访问该接口或数据。 */
export const BAIDU_PERMISSION_CODES = new Set([6, 14]);
/** 名额/并发类：并发超限，属可重试但不属鉴权。 */
export const BAIDU_BUSY_CODES = new Set([18]);

/**
 * 把百度错误码/错误名归到稳定分类。
 * @returns {'auth'|'quota'|'permission'|'param'|'busy'|'server'|'network'|'timeout'|'not_configured'|'limit'|'unknown'}
 */
export function classifyBaiduError({ code = null, name = null } = {}) {
  const n = name ? String(name).toLowerCase() : null;
  if (n === 'invalid_client' || n === 'invalid_grant' || n === 'unauthorized_client') return 'auth';
  if (n === 'invalid_request') return 'param';
  const c = code === null || code === undefined || code === '' ? null : Number(code);
  if (c !== null && Number.isFinite(c)) {
    if (BAIDU_AUTH_CODES.has(c)) return 'auth';
    if (BAIDU_QUOTA_CODES.has(c)) return 'quota';
    if (BAIDU_PERMISSION_CODES.has(c)) return 'permission';
    if (c >= 100 && c <= 116) return 'param';
    if (c >= 500 && c < 600) return 'server';
  }
  return n ? 'unknown' : 'unknown';
}

/** 人类可读分类名（界面与日志统一用中文，便于运维判断） */
export const ERROR_CATEGORY_LABEL = {
  auth: '鉴权失败',
  quota: '额度/配额不足',
  permission: '无接口权限',
  param: '参数或文件不合法',
  busy: '并发超限',
  server: '服务端错误',
  network: '网络失败',
  timeout: '超时',
  not_configured: '未配置凭据',
  limit: '超出接口限制',
  unsupported: '该模式未支持',
  unknown: '未知错误',
};

/** 把 fetchText 的失败结果归到稳定分类：**整批 deadline 到点属于超时，不是普通网络失败**。 */
function classifyFetchFailure(res = {}, deadlineAt = null) {
  if (res.deadline_exceeded) return 'timeout';
  if (Number.isFinite(Number(deadlineAt)) && deadlineAt && Date.now() >= Number(deadlineAt) - 60) return 'timeout';
  return 'network';
}

/* ==================================================================== */
/*  三、配置存储                                                        */
/* ==================================================================== */

const CFG_KEY = 'baidu_ocr_config_v1';
const QUOTA_KEY = 'baidu_ocr_quota_v1';
const STATS_KEY = 'baidu_ocr_stats_v1';
const RECORD_PARSER_VERSION = 'baidu-ocr-v1';

export const BAIDU_OCR_DEFAULT_CONFIG = {
  enabled: false,
  /** accurate_basic（经典高精度，本轮完整实现）｜doc_parser（异步文档解析，能力探测后启用） */
  mode: 'accurate_basic',
  request_timeout_ms: 30000,
  /** 整批时间上限：传给真实 fetch，到点不再发请求并真正中止在途请求 */
  batch_budget_ms: 120000,
  /** 当日 OCR 页数配额（按实际尝试计数） */
  daily_page_limit: 500,
  /** 当日 OCR 文档数配额 */
  daily_doc_limit: 50,
  /** 单文档最多送 OCR 的页数（防止一本 800 页扫描件一次吃掉全部配额） */
  max_pages_per_doc: 50,
  /** 单页可提取文字少于此长度即视为「缺文字」，转入 OCR */
  ocr_min_chars: 12,
  /** 文档解析模式的能力状态：unsupported | supported | unknown */
  doc_parser_state: 'unsupported',
  doc_parser_note: '本轮未开通文档解析接口权限；配置中如实标为 unsupported，不伪实现。',
  doc_parser_checked_at: null,
  updated_at: null,
  updated_by: null,
};

/** 内部完整配置（**含** credential_cipher，仅供服务端使用，绝不直接返回）。 */
export function baiduOcrConfig() {
  const saved = uj(metaValue(CFG_KEY, null), {}) || {};
  return { ...BAIDU_OCR_DEFAULT_CONFIG, ...saved };
}

/** 配置文件里剔除所有凭据字段后的安全副本。 */
function stripCredential(conf) {
  const { credential_cipher, ...rest } = conf || {};
  return rest;
}

/**
 * 凭据解析：环境变量优先，其次加密存储。
 * @returns {{ok:boolean, api_key?:string, secret_key?:string, source?:string, reason?:string}}
 */
export function baiduOcrCredential(conf = baiduOcrConfig()) {
  const envKey = process.env.BAIDU_OCR_API_KEY;
  const envSecret = process.env.BAIDU_OCR_SECRET_KEY;
  if (envKey && envSecret) {
    return { ok: true, api_key: String(envKey), secret_key: String(envSecret), source: '环境变量 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY' };
  }
  if (!conf?.credential_cipher) {
    return {
      ok: false,
      reason:
        '未配置百度 OCR 凭据：请在后台上传 API Key 与 Secret Key（服务端加密存储），' +
        '或由运维设置环境变量 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY。',
    };
  }
  if (!secretsConfigured()) {
    return { ok: false, reason: '库中有加密凭据，但服务端没有主密钥（CCER_SECRET_KEY 或本机密钥文件），无法解密。' };
  }
  const plain = decryptSecret(conf.credential_cipher);
  if (!plain) return { ok: false, reason: '加密凭据无法解密（主密钥可能已更换）；请重新录入凭据。' };
  let parsed;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return { ok: false, reason: '凭据内容损坏，无法解析；请重新录入。' };
  }
  if (!parsed?.api_key || !parsed?.secret_key) {
    return { ok: false, reason: '凭据不完整（缺少 api_key 或 secret_key）；请重新录入。' };
  }
  return { ok: true, api_key: String(parsed.api_key), secret_key: String(parsed.secret_key), source: '服务端加密存储（AES-256-GCM）' };
}

/** 凭据指纹：只用于让 token 缓存在凭据变化时自动失效，不可逆推明文。 */
export function credentialFingerprint(cred) {
  return createHash('sha256').update(`${cred?.api_key || ''}\u0000${cred?.secret_key || ''}`).digest('hex').slice(0, 16);
}

/**
 * 安全返回给接口/界面的配置视图。
 * **不含** credential_cipher、api_key、secret_key、access_token。
 */
export function baiduOcrPublicConfig() {
  const conf = baiduOcrConfig();
  const cred = baiduOcrCredential(conf);
  const envOnly = !!(process.env.BAIDU_OCR_API_KEY && process.env.BAIDU_OCR_SECRET_KEY);
  return {
    ...stripCredential(conf),
    credential_configured: cred.ok,
    credential_source: cred.ok ? cred.source : null,
    credential_hint: cred.ok ? null : cred.reason,
    credential_editable: secretsConfigured() || envOnly,
    master_key_available: secretsConfigured(),
    record_parser_version: RECORD_PARSER_VERSION,
    endpoint: {
      auth: `https://aip.baidubce.com${OCR_AUTH_PATH}`,
      accurate_basic: `https://aip.baidubce.com${OCR_ACCURATE_PATH}`,
      doc_parser_submit: `https://aip.baidubce.com${DOC_PARSER_SUBMIT_PATH}`,
      doc_parser_query: `https://aip.baidubce.com${DOC_PARSER_QUERY_PATH}`,
      fixed: true,
      note: '接口域名固定为百度官方域名，后台不提供修改入口，也无法改到私网/自建地址。',
    },
    quota: baiduOcrQuotaState(),
    stats: baiduOcrStats(),
  };
}

/** 保存配置：空密钥表示保留，只有显式 clear_credentials 才删除。 */
export function saveBaiduOcrConfig(user, patch = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可配置百度 OCR', status: 403 };
  const conf = baiduOcrConfig();
  const next = stripCredential(conf);
  const intRange = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;

  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.mode !== undefined) {
    const modes = ['accurate_basic', 'doc_parser', 'unsupported'];
    if (!modes.includes(String(patch.mode))) {
      return { error: `mode 须为 ${modes.join(' | ')}`, status: 400 };
    }
    const mode = String(patch.mode);
    // 文档解析未通过真实能力探测前不允许被选为生效模式（不伪实现）
    if (mode === 'doc_parser' && next.doc_parser_state !== 'supported') {
      return {
        error: `文档解析模式当前为 ${next.doc_parser_state}，未通过真实能力探测，不能作为生效模式；请先执行能力探测。`,
        status: 400,
        doc_parser_state: next.doc_parser_state,
      };
    }
    next.mode = mode;
  }
  if (patch.request_timeout_ms !== undefined) {
    if (!intRange(patch.request_timeout_ms, 3000, 120000)) return { error: 'request_timeout_ms 须为 3000—120000 的整数', status: 400 };
    next.request_timeout_ms = Number(patch.request_timeout_ms);
  }
  if (patch.batch_budget_ms !== undefined) {
    if (!intRange(patch.batch_budget_ms, 5000, 600000)) return { error: 'batch_budget_ms 须为 5000—600000 的整数', status: 400 };
    next.batch_budget_ms = Number(patch.batch_budget_ms);
  }
  if (patch.daily_page_limit !== undefined) {
    if (!intRange(patch.daily_page_limit, 1, 20000)) return { error: 'daily_page_limit 须为 1—20000 的整数', status: 400 };
    next.daily_page_limit = Number(patch.daily_page_limit);
  }
  if (patch.daily_doc_limit !== undefined) {
    if (!intRange(patch.daily_doc_limit, 1, 2000)) return { error: 'daily_doc_limit 须为 1—2000 的整数', status: 400 };
    next.daily_doc_limit = Number(patch.daily_doc_limit);
  }
  if (patch.max_pages_per_doc !== undefined) {
    if (!intRange(patch.max_pages_per_doc, 1, 500)) return { error: 'max_pages_per_doc 须为 1—500 的整数', status: 400 };
    next.max_pages_per_doc = Number(patch.max_pages_per_doc);
  }
  if (patch.ocr_min_chars !== undefined) {
    if (!intRange(patch.ocr_min_chars, 1, 200)) return { error: 'ocr_min_chars 须为 1—200 的整数', status: 400 };
    next.ocr_min_chars = Number(patch.ocr_min_chars);
  }

  let credentialAction = 'kept';
  let cipher = conf.credential_cipher || null;
  if (patch.clear_credentials === true) {
    cipher = null;
    credentialAction = 'cleared';
  } else {
    const apiKey = patch.api_key === undefined ? '' : String(patch.api_key).trim();
    const secretKey = patch.secret_key === undefined ? '' : String(patch.secret_key).trim();
    // 空字符串 = 保留原值；只有两个字段都非空才覆盖（避免「只填了 key」把旧 secret 冲掉）
    if (apiKey || secretKey) {
      if (!apiKey || !secretKey) {
        return { error: 'API Key 与 Secret Key 需同时填写（留空表示保留原凭据）', status: 400 };
      }
      if (apiKey.length > 512 || secretKey.length > 512) return { error: '凭据长度超出上限（512 字符）', status: 400 };
      if (!secretsConfigured()) {
        return {
          error: '服务端尚未初始化主密钥，无法加密保存凭据；请先初始化主密钥，或改用环境变量方式。',
          status: 409,
          hint: '后台「系统状态」提供「初始化本机主密钥」。',
        };
      }
      const encrypted = encryptSecret(j({ api_key: apiKey, secret_key: secretKey }));
      if (!encrypted) return { error: '凭据加密失败，未保存（不写明文）', status: 500 };
      cipher = encrypted;
      credentialAction = 'updated';
    }
  }
  // 不做「凭据引用名」的隐式转换：该字段只接受真实密钥，引用名请用环境变量方式。
  if (patch.credential_ref !== undefined && String(patch.credential_ref).trim()) {
    const ref = String(patch.credential_ref).trim();
    if (!validCredentialRef(ref)) return { error: '凭据引用名不合法', status: 400 };
    if (process.env[ref]) return { error: `请直接使用环境变量 ${ref}，不要在配置里填引用名`, status: 400 };
  }

  if (cipher) next.credential_cipher = cipher;
  else delete next.credential_cipher;
  next.updated_at = nowIso();
  next.updated_by = user?.name || user?.id || 'admin';

  setMeta(getDb(), CFG_KEY, j(next));
  audit({
    actor: user.name || user.id, actorRole: 'admin', action: 'baidu_ocr.config',
    objectType: 'system_meta', objectId: CFG_KEY,
    // 审计只记动作与开关，绝不写凭据内容或 cipher
    detail: {
      enabled: next.enabled, mode: next.mode, credential_action: credentialAction,
      request_timeout_ms: next.request_timeout_ms, batch_budget_ms: next.batch_budget_ms,
      daily_page_limit: next.daily_page_limit, daily_doc_limit: next.daily_doc_limit,
      max_pages_per_doc: next.max_pages_per_doc,
    },
  });
  return { ok: true, config: baiduOcrPublicConfig(), credential_action: credentialAction };
}

/* ==================================================================== */
/*  四、配额与统计                                                      */
/* ==================================================================== */

const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

function readQuota() {
  const raw = uj(metaValue(QUOTA_KEY, null), null) || {};
  const date = todayKey();
  if (raw.date !== date) {
    return { date, pages_attempted: 0, docs_attempted: 0, token_requests: 0, by_category: {} };
  }
  return {
    date, pages_attempted: Number(raw.pages_attempted) || 0,
    docs_attempted: Number(raw.docs_attempted) || 0,
    token_requests: Number(raw.token_requests) || 0,
    by_category: raw.by_category || {},
  };
}

function bumpQuota(field, n = 1, category = null) {
  const q = readQuota();
  q[field] = (Number(q[field]) || 0) + n;
  if (category) q.by_category[category] = (Number(q.by_category[category]) || 0) + 1;
  setMeta(getDb(), QUOTA_KEY, j(q));
  return q;
}

/** 配额状态（配置视图与 CLI 共用） */
export function baiduOcrQuotaState(cfg = baiduOcrConfig()) {
  const q = readQuota();
  const pageLimit = Number(cfg.daily_page_limit) || 0;
  const docLimit = Number(cfg.daily_doc_limit) || 0;
  return {
    date: q.date,
    pages_attempted: q.pages_attempted,
    pages_limit: pageLimit,
    pages_remaining: Math.max(0, pageLimit - q.pages_attempted),
    docs_attempted: q.docs_attempted,
    docs_limit: docLimit,
    docs_remaining: Math.max(0, docLimit - q.docs_attempted),
    token_requests: q.token_requests,
    by_category: q.by_category,
    counted_by: '实际发出的 HTTP 尝试次数（重试与失败同样计数）',
  };
}

function readStats() {
  return uj(metaValue(STATS_KEY, null), null) || {
    pages_ok: 0, pages_failed: 0, docs_ok: 0, docs_partial: 0, docs_failed: 0,
    cache_hits: 0, last_success_at: null, last_error_at: null, last_error: null,
    last_category: null, token_refreshes: 0, auth_retry_once: 0,
  };
}

function bumpStats(patch = {}) {
  const s = { ...readStats() };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number') s[k] = (Number(s[k]) || 0) + v;
    else s[k] = v;
  }
  setMeta(getDb(), STATS_KEY, j(s));
  return s;
}

export function baiduOcrStats() {
  return readStats();
}

/** 测试用：清空当日配额与累计统计（不触碰配置与凭据）。 */
export function resetBaiduOcrCounters() {
  setMeta(getDb(), QUOTA_KEY, j({ date: todayKey(), pages_attempted: 0, docs_attempted: 0, token_requests: 0, by_category: {} }));
  setMeta(getDb(), STATS_KEY, j({
    pages_ok: 0, pages_failed: 0, docs_ok: 0, docs_partial: 0, docs_failed: 0,
    cache_hits: 0, last_success_at: null, last_error_at: null, last_error: null,
    last_category: null, token_refreshes: 0, auth_retry_once: 0,
  }));
}

export function baiduOcrQuotaExhausted(cfg = baiduOcrConfig()) {
  const q = readQuota();
  return {
    page_exhausted: q.pages_attempted >= (Number(cfg.daily_page_limit) || 0),
    doc_exhausted: q.docs_attempted >= (Number(cfg.daily_doc_limit) || 0),
    quota: baiduOcrQuotaState(cfg),
  };
}

/* ==================================================================== */
/*  五、access_token：仅内存缓存，按 expires_in 提前刷新                  */
/* ==================================================================== */

/** 提前刷新窗口：expires_in 的 10%，夹在 30s—300s 之间。 */
export function tokenRefreshAheadMs(expiresInSec) {
  const total = Math.max(0, Number(expiresInSec) || 0) * 1000;
  return Math.min(300000, Math.max(30000, Math.floor(total * 0.1)));
}

let _tokenCache = { token: null, expires_at_ms: 0, fingerprint: null };

/** 测试/排障用：清空内存 token（不写库）。 */
export function resetTokenCache() {
  _tokenCache = { token: null, expires_at_ms: 0, fingerprint: null };
}

export function tokenCacheState() {
  if (!_tokenCache.token) return { cached: false, expires_at: null, expires_in_ms: null };
  return {
    cached: true,
    expires_at: new Date(_tokenCache.expires_at_ms).toISOString(),
    expires_in_ms: Math.max(0, _tokenCache.expires_at_ms - Date.now()),
  };
}

/**
 * 取 access_token。命中未过期缓存（且凭据未变）直接返回；否则真实请求鉴权接口。
 * @param {{force?:boolean, deadlineAt?:number|null, cfg?:object}} opts
 */
export async function getAccessToken({ force = false, deadlineAt = null, cfg = baiduOcrConfig() } = {}) {
  const cred = baiduOcrCredential(cfg);
  if (!cred.ok) {
    return { ok: false, error_category: 'not_configured', error: cred.reason, retryable: false };
  }
  const fp = credentialFingerprint(cred);
  const now = Date.now();
  if (!force && _tokenCache.token && _tokenCache.fingerprint === fp && _tokenCache.expires_at_ms - now > 1000) {
    return { ok: true, token: _tokenCache.token, cached: true, expires_at: new Date(_tokenCache.expires_at_ms).toISOString() };
  }
  const url = `${ocrBaseUrl()}${OCR_AUTH_PATH}`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cred.api_key,
    client_secret: cred.secret_key,
  }).toString();
  bumpQuota('token_requests', 1);
  bumpStats({ token_refreshes: 1 });
  const res = await fetchText(url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    allowedDomains: ocrAllowedDomains(),
    timeoutMs: Math.min(Number(cfg.request_timeout_ms) || 30000, 30000),
    retryMax: 0,
    rateLimitPerMin: 600,
    deadlineAt,
  });
  if (!res.ok) {
    const category = classifyFetchFailure(res, deadlineAt);
    const message = category === 'timeout'
      ? '鉴权请求超出整批时间上限，已中止（未发出的请求不再发送）'
      : `鉴权请求失败：${res.error || res.status}`;
    bumpStats({ last_error_at: nowIso(), last_error: message, last_category: category });
    return { ok: false, error_category: category, error: message, retryable: !res.blocked };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    const message = '鉴权接口未返回 JSON（可能被网关拦截）';
    bumpStats({ last_error_at: nowIso(), last_error: message, last_category: 'server' });
    return { ok: false, error_category: 'server', error: message, retryable: true };
  }
  if (parsed.error) {
    // invalid_client / unknown client id 等：如实回报，不猜测密钥、不声称可用
    const category = classifyBaiduError({ name: parsed.error });
    const message = `鉴权失败（${parsed.error}）：${parsed.error_description || '百度未提供说明'}`;
    bumpStats({ last_error_at: nowIso(), last_error: message, last_category: category });
    return { ok: false, error_category: category, error: message, error_code: parsed.error, retryable: false };
  }
  if (!parsed.access_token) {
    const message = '鉴权接口未返回 access_token';
    bumpStats({ last_error_at: nowIso(), last_error: message, last_category: 'auth' });
    return { ok: false, error_category: 'auth', error: message, retryable: false };
  }
  const expiresIn = Number(parsed.expires_in) || 2592000;
  const ahead = tokenRefreshAheadMs(expiresIn);
  _tokenCache = {
    token: String(parsed.access_token),
    expires_at_ms: Date.now() + Math.max(1000, expiresIn * 1000 - ahead),
    fingerprint: fp,
  };
  return {
    ok: true, token: _tokenCache.token, cached: false,
    expires_at: new Date(_tokenCache.expires_at_ms).toISOString(),
    expires_in_s: expiresIn, refresh_ahead_ms: ahead,
  };
}

/* ==================================================================== */
/*  六、经典高精度接口：单页识别                                         */
/* ==================================================================== */

/** 解析 accurate_basic 的响应体为纯文本。 */
export function parseAccurateResponse(parsed) {
  const words = Array.isArray(parsed?.words_result) ? parsed.words_result : [];
  const text = words.map((w) => String(w?.words ?? '')).filter((s) => s.length).join('\n');
  return { text, lines: words.length, chars: text.replace(/\s/g, '').length };
}

/**
 * 把超大 PDF 的**指定单页**拆出来（pdfseparate）。
 * 明确禁止「静默只处理第一页」：拆不出来就如实失败。
 */
async function splitSinglePage(pdfBuffer, pageNum, { timeoutMs = 30000 } = {}) {
  const dir = join(tmpdir(), `ccer-ocr-split-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'src.pdf');
  const out = join(dir, 'page.pdf');
  try {
    writeFileSync(src, pdfBuffer);
    // 无管道异步执行（受限环境禁止子进程打开管道，execFile 会得到 EPERM）
    const r = await runToolToFile(
      process.env.CCER_PDFSEPARATE || 'pdfseparate',
      ['-f', String(pageNum), '-l', String(pageNum), src, out],
      { timeoutMs, tag: 'pdfseparate' }
    );
    if (!r.ok) {
      return {
        ok: false,
        error:
          `PDF 超过 ${Math.round(OCR_MAX_INLINE_PDF_BYTES / 1024 / 1024)}MB 的 base64 上限，` +
          `且本机 pdfseparate 不可用或拆分失败（${r.missing ? '未安装 poppler-utils/pdfseparate' : r.error}）：` +
          '拒绝静默只处理第一页，请安装 poppler-utils 或改用文档解析模式。',
      };
    }
    if (!existsSync(out)) return { ok: false, error: 'pdfseparate 未生成单页文件' };
    const buf = readFileSync(out);
    if (buf.subarray(0, 5).toString() !== '%PDF-') return { ok: false, error: 'pdfseparate 输出不是 PDF' };
    return { ok: true, buf };
  } catch (e) {
    return {
      ok: false,
      error:
        `PDF 超过 ${Math.round(OCR_MAX_INLINE_PDF_BYTES / 1024 / 1024)}MB 的 base64 上限，` +
        `且单页拆分过程异常（${e?.message || e}）：拒绝静默只处理第一页，请安装 poppler-utils 或改用文档解析模式。`,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
}

/**
 * 识别 PDF 的**单页**（经典高精度接口，pdf_file_num 从 1 起）。
 *
 * 纪律：
 *   · 每一次真实 HTTP 尝试都计入配额（失败与重试同样计数）；
 *   · 110/111（token 失效）**只刷新并重试一次**，不无限重试；
 *   · 鉴权 / 额度 / 权限 / 超时分别返回稳定的 error_category；
 *   · 整批 deadline 透传到真实 fetch，到点真正中止（不留后台写入）。
 *
 * @returns {Promise<{ok:boolean, text?:string, chars?:number, error?:string,
 *   error_category?:string, error_code?:number|string|null, attempts?:number, elapsed_ms?:number,
 *   token_refreshed?:boolean, oversized?:boolean}>}
 */
export async function recognizePage({
  pdfBuffer, pageNum, deadlineAt = null, cfg = baiduOcrConfig(), purpose = 'pdf-parse',
} = {}) {
  const page = Number(pageNum);
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) return { ok: false, error: '缺少 PDF 内容', error_category: 'param', attempts: 0 };
  if (!Number.isInteger(page) || page < 1) return { ok: false, error: 'pdf_file_num 必须是从 1 开始的整数', error_category: 'param', attempts: 0 };
  if (cfg.mode === 'doc_parser') return recognizeDocumentPage({ pdfBuffer, pageNum: page, deadlineAt, cfg });

  const cred = baiduOcrCredential(cfg);
  if (!cred.ok) return { ok: false, error: cred.reason, error_category: 'not_configured', attempts: 0 };

  const quota = baiduOcrQuotaExhausted(cfg);
  if (quota.page_exhausted) {
    return {
      ok: false, error_category: 'quota', attempts: 0, quota_exhausted: true,
      error: `当日 OCR 页数配额已用尽（${quota.quota.pages_attempted}/${quota.quota.pages_limit}），留待次日；未发生请求、未写入任何结果。`,
    };
  }

  // 超大 PDF：先拆单页（禁止静默只处理第一页）
  let payload = pdfBuffer;
  let oversized = false;
  if (pdfBuffer.length > OCR_MAX_RAW_PDF_BYTES) {
    oversized = true;
    const split = await splitSinglePage(pdfBuffer, page, {
      timeoutMs: Math.max(3000, Math.min(30000, deadlineAt ? deadlineAt - Date.now() : 30000)),
    });
    if (!split.ok) return { ok: false, error: split.error, error_category: 'limit', attempts: 0, oversized: true };
    payload = split.buf;
    if (payload.length > OCR_MAX_RAW_PDF_BYTES) {
      return {
        ok: false, error_category: 'limit', attempts: 0, oversized: true,
        error: `拆分出的第 ${page} 页仍超过 ${Math.round(OCR_MAX_INLINE_PDF_BYTES / 1024 / 1024)}MB base64 上限，未提交（不截断、不降级）。`,
      };
    }
  }

  const body = new URLSearchParams({
    pdf_file: payload.toString('base64'),
    pdf_file_num: String(page),
  }).toString();

  const started = Date.now();
  let attempts = 0;
  let tokenRefreshed = false;

  for (let round = 0; round < 2; round += 1) {
    if (deadlineAt && Date.now() >= deadlineAt - 100) {
      return {
        ok: false, error_category: 'timeout', attempts, oversized,
        error: '整批时间上限已到：未发出的 OCR 请求不再发送（留待下一批，未写入任何结果）。',
        elapsed_ms: Date.now() - started, deadline_exceeded: true,
      };
    }
    const tokenOut = await getAccessToken({ force: tokenRefreshed, deadlineAt, cfg });
    if (!tokenOut.ok) {
      return {
        ok: false, error_category: tokenOut.error_category, error: tokenOut.error,
        error_code: tokenOut.error_code ?? null, attempts, oversized, elapsed_ms: Date.now() - started,
      };
    }
    const url = `${ocrBaseUrl()}${OCR_ACCURATE_PATH}?access_token=${encodeURIComponent(tokenOut.token)}`;
    attempts += 1;
    // 配额按**实际尝试**计数（成功、失败、重试都算一次真实调用）
    bumpQuota('pages_attempted', 1);
    const res = await fetchText(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      allowedDomains: ocrAllowedDomains(),
      timeoutMs: Number(cfg.request_timeout_ms) || 30000,
      retryMax: 0,
      rateLimitPerMin: 600,
      deadlineAt,
    });
    if (!res.ok) {
      const category = classifyFetchFailure(res, deadlineAt);
      const message = category === 'timeout'
        ? 'OCR 请求超出整批时间上限，已中止（未写入任何结果）'
        : `OCR 请求失败：${res.error || `HTTP ${res.status}`}`;
      bumpStats({ pages_failed: 1, last_error_at: nowIso(), last_error: message, last_category: category });
      return { ok: false, error_category: category, error: message, attempts, oversized, elapsed_ms: Date.now() - started, deadline_exceeded: category === 'timeout' };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.body || '{}');
    } catch {
      const message = 'OCR 接口未返回 JSON（可能被网关或代理拦截）';
      bumpStats({ pages_failed: 1, last_error_at: nowIso(), last_error: message, last_category: 'server' });
      return { ok: false, error_category: 'server', error: message, attempts, oversized, elapsed_ms: Date.now() - started };
    }
    if (parsed.error_code !== undefined && parsed.error_code !== null && Number(parsed.error_code) !== 0) {
      const code = Number(parsed.error_code);
      const category = classifyBaiduError({ code });
      const message = `OCR 接口返回错误 ${code}：${parsed.error_msg || ERROR_CATEGORY_LABEL[category] || '未提供说明'}`;
      // 110/111：只刷新 token 重试一次
      if (category === 'auth' && BAIDU_AUTH_CODES.has(code) && !tokenRefreshed) {
        tokenRefreshed = true;
        resetTokenCache();
        bumpStats({ auth_retry_once: 1 });
        audit({
          actor: `system:baidu-ocr(${purpose})`, action: 'baidu_ocr.token_refresh_retry',
          objectType: 'baidu_ocr', objectId: `page-${page}`,
          detail: { code, category, note: 'access_token 失效，刷新一次后重试一次（不无限重试）' }, result: 'warning',
        });
        continue;
      }
      bumpStats({ pages_failed: 1, last_error_at: nowIso(), last_error: message, last_category: category });
      return {
        ok: false, error_category: category,
        error: tokenRefreshed ? `${message}（已刷新并重试一次，停止重试（不无限重试））` : message,
        error_code: code,
        attempts, oversized, token_refreshed: tokenRefreshed, elapsed_ms: Date.now() - started,
      };
    }
    const { text, chars, lines } = parseAccurateResponse(parsed);
    if (!text) {
      const message = 'OCR 未识别出任何文字（页面可能为空白页或图片质量过低）';
      bumpStats({ pages_failed: 1, last_error_at: nowIso(), last_error: message, last_category: 'unknown' });
      return {
        ok: false, error_category: 'unknown', error: message, attempts, oversized,
        token_refreshed: tokenRefreshed, elapsed_ms: Date.now() - started, empty: true,
      };
    }
    bumpStats({ pages_ok: 1, last_success_at: nowIso() });
    return {
      ok: true, text, chars, lines, attempts, oversized,
      token_refreshed: tokenRefreshed, elapsed_ms: Date.now() - started, page,
    };
  }
  bumpStats({ pages_failed: 1, last_error_at: nowIso(), last_error: 'token 刷新重试后仍未成功', last_category: 'auth' });
  return {
    ok: false, error_category: 'auth', attempts, oversized, token_refreshed: tokenRefreshed,
    error: 'access_token 失效后已刷新并重试一次仍未成功，停止重试（不无限重试）。',
    elapsed_ms: Date.now() - started,
  };
}

/* ==================================================================== */
/*  七、真实连接测试                                                     */
/* ==================================================================== */

/** 生成一张最小可用的单页 PDF（仅用于连接测试，不包含任何业务数据）。 */
export function buildProbePdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 80] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 10 40 Td (CCER OCR PROBE) Tj ET\nendstream\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objects) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * 真实连接测试：**真的**请求鉴权接口并**真的**对一页 PDF 调一次 OCR。
 * 未配置凭据 / 无权限 / 额度不足一律如实返回，不把失败说成可用。
 */
export async function testBaiduOcrConnection({ user, actor = null, deadlineAt = null } = {}) {
  const who = actor || user?.name || user?.id || 'admin';
  const cfg = baiduOcrConfig();
  const cred = baiduOcrCredential(cfg);
  if (!cred.ok) {
    return {
      ok: false, status: 'not_configured', error_category: 'not_configured',
      message: cred.reason,
      hint: '凭据由管理员在后台录入（服务端 AES-256-GCM 加密），或由运维注入 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY。',
      credential_configured: false,
    };
  }
  if (cfg.mode === 'unsupported') {
    return { ok: false, status: 'unsupported', error_category: 'unsupported', message: 'OCR 模式被显式配置为 unsupported，未发起真实调用。', credential_configured: true };
  }
  const started = Date.now();
  resetTokenCache();
  const token = await getAccessToken({ force: true, deadlineAt: deadlineAt || Date.now() + 60000, cfg });
  const tokenPart = token.ok
    ? { ok: true, cached: false, expires_at: token.expires_at, refresh_ahead_ms: token.refresh_ahead_ms }
    : { ok: false, error_category: token.error_category, error: token.error };
  let ocrPart = { ok: false, skipped: true, error: '鉴权未通过，未发起 OCR 调用（不伪造可用）' };
  if (token.ok) {
    const pdf = buildProbePdf();
    ocrPart = await recognizePage({ pdfBuffer: pdf, pageNum: 1, deadlineAt: deadlineAt || Date.now() + 60000, cfg, purpose: 'connection-test' });
    ocrPart = ocrPart.ok
      ? { ok: true, chars: ocrPart.chars, lines: ocrPart.lines, attempts: ocrPart.attempts, elapsed_ms: ocrPart.elapsed_ms }
      : { ok: false, error_category: ocrPart.error_category, error: ocrPart.error, error_code: ocrPart.error_code ?? null, attempts: ocrPart.attempts };
  }
  const ok = !!(token.ok && ocrPart.ok);
  audit({
    actor: who, actorRole: 'admin', action: 'baidu_ocr.connection_test', objectType: 'baidu_ocr', objectId: 'config',
    detail: {
      ok, mode: cfg.mode, credential_source: cred.source,
      token_ok: token.ok, token_category: token.ok ? null : token.error_category,
      ocr_ok: !!ocrPart.ok, ocr_category: ocrPart.ok ? null : ocrPart.error_category,
      elapsed_ms: Date.now() - started,
    },
    result: ok ? 'ok' : 'warning',
  });
  return {
    ok,
    status: ok ? 'ok' : (token.ok ? 'ocr_failed' : 'auth_failed'),
    credential_configured: true,
    credential_source: cred.source,
    mode: cfg.mode,
    token: tokenPart,
    ocr: ocrPart,
    elapsed_ms: Date.now() - started,
    message: ok
      ? '鉴权与经典高精度接口均真实调用成功（测试页识别到文字）。'
      : `真实调用未通过：${token.ok ? `OCR 阶段 ${ocrPart.error_category}` : `鉴权阶段 ${token.error_category}`}`,
    note: '本测试发起的是一次真实计费调用（仅 1 页），会计入当日配额统计。',
  };
}

/* ==================================================================== */
/*  八、文档解析（异步任务）：契约实现 + 能力探测，默认 unsupported      */
/* ==================================================================== */

/**
 * 校验文档解析返回的结果链接：必须是 HTTPS 的百度 BOS/官方域名，
 * 且不得指向私网地址、不得为 IP 直连。**签名 URL 绝不原样输出或落日志**。
 */
export function validateParserResultUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: '结果链接不是合法 URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: `结果链接必须是 HTTPS（实际 ${u.protocol}）` };
  const host = u.hostname.toLowerCase();
  const official = BAIDU_BOS_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  if (!official) return { ok: false, reason: `结果链接域名不是百度官方对象存储：${host}` };
  const guard = checkOutboundUrl(u.href, [host]);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: false, reason: '结果链接不得使用 IP 直连' };
  return { ok: true, host, path: u.pathname };
}

/** 结果链接的展示用脱敏形式：只保留域名与路径前缀，去掉查询串（签名）。 */
export function redactParserResultUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    return `${u.protocol}//${u.host}${u.pathname}（含签名参数，已隐藏）`;
  } catch {
    return '（链接不合法，已隐藏）';
  }
}

/** 文档解析提交表单（page_filter 从 0 起，与经典接口的 1 起**不同**，不可混用）。 */
export function buildDocParserForm({ fileBuffer, fileName, pages = null }) {
  const form = new URLSearchParams();
  form.set('file_data', fileBuffer.toString('base64'));
  form.set('file_name', String(fileName || 'document.pdf'));
  if (Array.isArray(pages) && pages.length) form.set('page_filter', pages.map((p) => String(Number(p))).join(','));
  return form.toString();
}

/**
 * 提交异步文档解析任务。
 * @returns {Promise<{ok:boolean, task_id?:string, error?:string, error_category?:string}>}
 */
export async function submitDocParserTask({ fileBuffer, fileName, pages = null, deadlineAt = null, cfg = baiduOcrConfig() } = {}) {
  if (cfg.doc_parser_state !== 'supported') {
    return {
      ok: false, error_category: 'unsupported',
      error: `文档解析模式当前为 ${cfg.doc_parser_state}：未通过真实能力探测，不发起调用、不伪实现。`,
    };
  }
  const token = await getAccessToken({ deadlineAt, cfg });
  if (!token.ok) return { ok: false, error_category: token.error_category, error: token.error };
  const res = await fetchText(`${ocrBaseUrl()}${DOC_PARSER_SUBMIT_PATH}?access_token=${encodeURIComponent(token.token)}`, {
    method: 'POST',
    body: buildDocParserForm({ fileBuffer, fileName, pages }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    allowedDomains: ocrAllowedDomains(),
    timeoutMs: Number(cfg.request_timeout_ms) || 30000,
    retryMax: 0, rateLimitPerMin: 600, deadlineAt,
  });
  if (!res.ok) return { ok: false, error_category: res.deadline_exceeded ? 'timeout' : 'network', error: res.error || `HTTP ${res.status}` };
  let parsed;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    return { ok: false, error_category: 'server', error: '文档解析提交未返回 JSON' };
  }
  const code = parsed.error_code === undefined ? 0 : Number(parsed.error_code);
  if (code) {
    return { ok: false, error_category: classifyBaiduError({ code }), error: `提交失败 ${code}：${parsed.error_msg || ''}`, error_code: code };
  }
  const taskId = parsed.result?.task_id || parsed.task_id || null;
  if (!taskId) return { ok: false, error_category: 'server', error: '提交成功但未返回 task_id' };
  return { ok: true, task_id: String(taskId) };
}

/** 查询文档解析任务状态（pending/running/success/failed）。 */
export async function queryDocParserTask({ taskId, deadlineAt = null, cfg = baiduOcrConfig(), internalResult = false } = {}) {
  if (!taskId) return { ok: false, error_category: 'param', error: '缺少 task_id' };
  const token = await getAccessToken({ deadlineAt, cfg });
  if (!token.ok) return { ok: false, error_category: token.error_category, error: token.error };
  const res = await fetchText(`${ocrBaseUrl()}${DOC_PARSER_QUERY_PATH}?access_token=${encodeURIComponent(token.token)}`, {
    method: 'POST',
    body: new URLSearchParams({ task_id: String(taskId) }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    allowedDomains: ocrAllowedDomains(),
    timeoutMs: Number(cfg.request_timeout_ms) || 30000,
    retryMax: 0, rateLimitPerMin: 600, deadlineAt,
  });
  if (!res.ok) return { ok: false, error_category: res.deadline_exceeded ? 'timeout' : 'network', error: res.error || `HTTP ${res.status}` };
  let parsed;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    return { ok: false, error_category: 'server', error: '文档解析查询未返回 JSON' };
  }
  const code = parsed.error_code === undefined ? 0 : Number(parsed.error_code);
  if (code) return { ok: false, error_category: classifyBaiduError({ code }), error: `查询失败 ${code}：${parsed.error_msg || ''}`, error_code: code };
  const result = parsed.result || {};
  const status = String(result.status || 'unknown');
  const urlCheck = result.parse_result_url ? validateParserResultUrl(result.parse_result_url) : null;
  return {
    ok: true,
    status,
    task_id: String(taskId),
    // 只回脱敏链接；原始签名 URL 不返回、不落非加密日志
    parse_result_url_redacted: result.parse_result_url ? redactParserResultUrl(result.parse_result_url) : null,
    parse_result_url_host: urlCheck?.ok ? urlCheck.host : null,
    parse_result_url_safe: urlCheck ? (urlCheck.ok ? true : false) : null,
    ...(internalResult && urlCheck?.ok ? { _result_url: result.parse_result_url } : {}),
    // pages/page_num 从 0 起（与经典接口 1 起不同）
    page_num_zero_based: result.page_num === undefined ? null : Number(result.page_num),
    pages: Array.isArray(result.pages)
      ? result.pages.map((p) => ({
        page_num: Number(p.page_num),
        chars: String(p.text || '').length,
        tables: Array.isArray(p.tables) ? p.tables.length : 0,
        text: String(p.text || ''),
      }))
      : [],
    error: status === 'failed' ? (result.error_msg || result.msg || '文档解析任务失败') : null,
  };
}

/** 能力探测：只有真实拿到权限才算 supported，否则如实标注。 */
export async function probeDocParserCapability({ actor = 'admin', deadlineAt = null } = {}) {
  const cfg = baiduOcrConfig();
  const cred = baiduOcrCredential(cfg);
  const patch = {};
  let out;
  if (!cred.ok) {
    out = { ok: false, state: 'unknown', error_category: 'not_configured', message: cred.reason };
  } else {
    const token = await getAccessToken({ deadlineAt, cfg });
    if (!token.ok) {
      out = { ok: false, state: 'unknown', error_category: token.error_category, message: `鉴权未通过，无法探测文档解析权限：${token.error}` };
    } else {
      // 真实提交一次最小任务；无权限必然在提交阶段被拒（不伪造成功）
      const probe = buildProbePdf();
      const relaxed = { ...cfg, doc_parser_state: 'supported' };
      const sub = await submitDocParserTask({ fileBuffer: probe, fileName: 'ccer-probe.pdf', pages: [0], deadlineAt, cfg: relaxed });
      if (sub.ok) {
        out = { ok: true, state: 'supported', task_id: sub.task_id, message: '文档解析接口真实受理了探测任务，能力探测通过。' };
      } else if (sub.error_category === 'permission') {
        out = { ok: false, state: 'unsupported', error_category: 'permission', message: `接口返回无权限（${sub.error}）：本轮保持 unsupported，不自动切换付费服务。` };
      } else {
        out = { ok: false, state: 'unsupported', error_category: sub.error_category, message: `能力探测未通过：${sub.error}` };
      }
    }
  }
  const before = baiduOcrConfig();
  const next = {
    ...before,
    doc_parser_state: out.state,
    doc_parser_note: out.message,
    doc_parser_checked_at: nowIso(),
  };
  if (next.doc_parser_state !== 'supported' && next.mode === 'doc_parser') {
    next.mode = 'accurate_basic';
  }
  // stripCredential仅用于对外视图；内部持久化必须保留现有密文，探测不能删除凭据。
  setMeta(getDb(), CFG_KEY, j(next));
  audit({
    actor, actorRole: 'admin', action: 'baidu_ocr.probe_doc_parser', objectType: 'baidu_ocr', objectId: 'config',
    detail: { state: out.state, error_category: out.error_category || null }, result: out.ok ? 'ok' : 'warning',
  });
  return { ...out, config: baiduOcrPublicConfig() };
}

/** 给 OCR 结果记录用的解析器版本标识 */
export function recordParserVersion(mode = 'accurate_basic') {
  return mode === 'doc_parser' ? 'baidu-document-parser-v2' : RECORD_PARSER_VERSION;
}

/** 文档解析模式实际消费一个原始物理页；任务受理不等于已经取得正文。 */
async function recognizeDocumentPage({ pdfBuffer, pageNum, deadlineAt, cfg }) {
  const deadline = deadlineAt || Date.now() + Math.min(Number(cfg.batch_budget_ms) || 120000, 600000);
  if (cfg.doc_parser_state !== 'supported') return { ok: false, error_category: 'unsupported', error: '文档解析接口尚未通过能力探测', attempts: 0 };
  const quota = baiduOcrQuotaExhausted(cfg);
  if (quota.page_exhausted || quota.doc_exhausted) return { ok: false, error_category: 'quota', error: '当日OCR配额已用尽', attempts: 0 };
  if (Date.now() >= deadline - 500) return { ok: false, error_category: 'timeout', error: '批次时间不足，未提交文档', attempts: 0 };
  bumpQuota('pages_attempted', 1);
  const submitted = await submitDocParserTask({ fileBuffer: pdfBuffer, fileName: 'original.pdf', pages: [pageNum - 1], deadlineAt: deadline, cfg });
  if (!submitted.ok) return { ...submitted, attempts: 1 };
  while (Date.now() < deadline - 500) {
    const queried = await queryDocParserTask({ taskId: submitted.task_id, deadlineAt: deadline, cfg, internalResult: true });
    if (!queried.ok) return { ok: false, error_category: queried.error_category, error: queried.error, attempts: 1 };
    if (queried.status === 'failed') return { ok: false, error_category: 'server', error: '百度文档解析任务失败', attempts: 1 };
    if (queried.status === 'success') {
      if (!queried._result_url) return { ok: false, error_category: 'server', error: '结果链接不属于允许的百度官方存储域名', attempts: 1 };
      const host = new URL(queried._result_url).hostname;
      const file = await fetchText(queried._result_url, { allowedDomains: [host], deadlineAt: deadline, timeoutMs: Math.min(Number(cfg.request_timeout_ms) || 30000, deadline - Date.now()), retryMax: 0 });
      if (!file.ok) return { ok: false, error_category: file.deadline_exceeded ? 'timeout' : 'network', error: '文档解析结果下载未完成', attempts: 1 };
      let parsed;
      try { parsed = JSON.parse(file.body); } catch { return { ok: false, error_category: 'server', error: '文档解析结果不是JSON', attempts: 1 }; }
      const pages = parsed.pages || parsed.result?.pages || [];
      const selected = pages.find(p => Number(p.page_num) === pageNum - 1);
      if (!selected || pages.length !== 1) return { ok: false, error_category: 'param', error: '返回页码与请求原始页码不一致，未写入正文', attempts: 1 };
      const text = String(selected.text || '').trim();
      if (!text) return { ok: false, error_category: 'server', error: '文档解析返回空正文', attempts: 1 };
      return { ok: true, text, chars: text.replace(/\s/g, '').length, lines: text.split('\n').length, attempts: 1, parser: 'baidu-document-parser-v2', page_num: pageNum, table_count: selected.tables?.length || 0 };
    }
    const wait = Math.min(5000, deadline - Date.now() - 500);
    if (wait <= 0) break;
    await new Promise(r => setTimeout(r, wait));
  }
  return { ok: false, error_category: 'timeout', error: '文档解析轮询达到整批时间上限，未将受理状态当作解析成功', attempts: 1 };
}

/** 便捷：当前 OCR 是否可用于自动补跑（配置齐全 + 开关打开 + 模式不是 unsupported + 配额未耗尽） */
export function baiduOcrReady(cfg = baiduOcrConfig()) {
  // category 让调用方能区分「未配置」「停用」「配额耗尽」「鉴权失败」，
  // 而不是把所有不可用都报成同一件事（docs/36：鉴权/额度/权限/超时分列）。
  if (!cfg.enabled) return { ready: false, category: 'disabled', reason: 'OCR 未启用（后台配置 enabled=false）' };
  if (cfg.mode === 'unsupported') return { ready: false, category: 'unsupported', reason: 'OCR 模式为 unsupported' };
  const cred = baiduOcrCredential(cfg);
  if (!cred.ok) return { ready: false, category: 'not_configured', reason: cred.reason };
  const q = baiduOcrQuotaExhausted(cfg);
  if (q.page_exhausted) return { ready: false, category: 'quota', reason: '当日 OCR 页数配额已用尽' };
  if (q.doc_exhausted) return { ready: false, category: 'quota', reason: '当日 OCR 文档数配额已用尽' };
  // 配置齐全不代表真的能用：最近一次真实调用若以鉴权/无权限失败收场，
  // 必须如实说明「当前不可自动补跑」，而不是给出乐观结论（docs/36：不声称可用）。
  const s = readStats();
  const lastFail = s.last_error_at ? Date.parse(s.last_error_at) || 0 : 0;
  const lastOk = s.last_success_at ? Date.parse(s.last_success_at) || 0 : 0;
  if (lastFail > lastOk && ['auth', 'permission'].includes(s.last_category)) {
    return {
      ready: false,
      category: s.last_category,
      last_category: s.last_category,
      reason: `最近一次真实调用失败（${ERROR_CATEGORY_LABEL[s.last_category] || s.last_category}）：${s.last_error}。请核对凭据/权限后重新测试连接。`,
    };
  }
  return { ready: true, category: null, reason: null };
}

/** 便于统计：数据库里是否有该配置行（排障用，不泄露内容） */
export function baiduOcrConfigRowExists() {
  return !!dbGet('SELECT key FROM system_meta WHERE key = ?', [CFG_KEY]);
}

export { CFG_KEY as BAIDU_OCR_CONFIG_KEY, newId as _newId };
