/**
 * DeepSeek 能力扩展（docs/54）
 * ============================================================================
 * 本模块只做四件事：
 *   1. 复用已有 `llm_provider` 凭据（只存 provider_id；服务端调用时再解析密钥）；
 *   2. 实现官方 Search / Fetch 两个独立能力（固定 https://api.deepseek.com 端点）；
 *   3. 管理视觉、工具问答、JSON 加固的能力预算与最近调用观测；
 *   4. 实现 Files API 的图片复用缓存（按 凭据归属 + 图片 hash），不做文件管理页面。
 *
 * 安全边界：
 *   · 凭据绝不复制到新表、日志、前端或文档；只保存 provider_id 关系。
 *   · 绑定对象必须是 **启用的官方 https://api.deepseek.com 模型配置**；
 *     代理商 / 自建接口的 Key 不会被转发给 DeepSeek。
 *   · 出站只发往官方端点（自动化测试可用 CCER_DEEPSEEK_TEST_BASE 指向回环桩，
 *     且必须同时设置 CCER_ALLOW_LOOPBACK_OUTBOUND=1；生产不应设置）。
 *   · 3xx 不自动跟随，避免把 Authorization 带给其它 host。
 *
 * 官方依据（2026-10-19 阅读）：
 *   - https://api-docs.deepseek.com/zh-cn/guides/search/
 *   - https://api-docs.deepseek.com/zh-cn/guides/vision/
 *   - https://api-docs.deepseek.com/zh-cn/guides/files_api/
 *   - https://api-docs.deepseek.com/zh-cn/guides/tool_calls/
 *   - https://api-docs.deepseek.com/zh-cn/guides/json_mode/
 *   - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
 *   - https://api-docs.deepseek.com/zh-cn/guides/kv_cache/
 */
import { createHash } from 'node:crypto';
import { all, get, run, audit, metaValue } from '../core/db.mjs';
import { newId, nowIso, j, uj, todayCst } from '../core/util.mjs';
import { resolveCredential } from './admin-v2-svc.mjs';
import { callVerifyModel } from './verification-svc.mjs';
import { keyStatus, validCredentialRef, resolveStoredCredential } from '../core/secrets.mjs';
import { checkOutboundUrl, sha256 } from './collect-svc.mjs';

/* ==================================================================== */
/*  一、官方端点与能力默认值                                             */
/* ==================================================================== */

export const DEEPSEEK_OFFICIAL_ORIGIN = 'https://api.deepseek.com';
export const DEEPSEEK_PATHS = {
  search: '/v1/tools/search',
  fetch: '/v1/tools/fetch',
  chat: '/chat/completions',
  files: '/files',
};
/** 当前公开价（2026-10-19 文档）：Search/Fetch 均 5 元/千次成功请求；界面注明可能调整。 */
export const DEEPSEEK_SEARCH_PRICE_CNY = 0.005;
export const DEEPSEEK_FETCH_PRICE_CNY = 0.005;

export const DEEPSEEK_CAPABILITY_KINDS = ['search', 'fetch', 'vision', 'chat_tools', 'json'];

export const DEEPSEEK_CAPABILITY_DEFAULTS = {
  search: {
    label: 'DeepSeek Search（联网发现）',
    enabled: 1,
    daily_quota: 300,
    max_per_turn: 2,
    timeout_ms: 25000,
    config: {
      count_default: 8,
      max_count: 20,
      need_content: false,
      max_attempts: 2,
      backoff_ms: 800,
      note: 'Search 只返回搜索结果；摘要与正文分开标记，不凭搜索摘要宣称已读全文。',
    },
  },
  fetch: {
    label: 'DeepSeek Fetch（公开网页正文）',
    enabled: 1,
    daily_quota: 300,
    max_per_turn: 2,
    timeout_ms: 40000,
    config: {
      max_url_chars: 8192,
      max_content_chars: 30000,
      max_attempts: 2,
      backoff_ms: 800,
      note: '只抓取允许的公开 HTTP(S) 地址；3xx 不跟随，绝不把管理员凭据转给目标站点。',
    },
  },
  vision: {
    label: 'DeepSeek Flash 视觉补充',
    enabled: 0,
    daily_quota: 120,
    max_per_turn: 2,
    timeout_ms: 60000,
    config: {
      model: 'deepseek-flash',
      dpi: 144,
      max_pages_per_doc: 3,
      max_image_bytes: 8 * 1024 * 1024,
      max_output_tokens: 1800,
      files_reuse: false,
      file_ttl_seconds: 86400,
      thinking: 'disabled',
      note: '仅对文本层/OCR 为空或质量不足的页做补充；输出为模型理解材料，不是官方事实。',
    },
  },
  chat_tools: {
    label: '工具化多轮问答',
    enabled: 0,
    daily_quota: 300,
    max_per_turn: 4,
    timeout_ms: 45000,
    config: {
      max_rounds: 4,
      max_tool_calls: 8,
      max_total_ms: 45000,
      max_output_tokens: 2800,
      thinking: 'auto',
      reasoning_effort: 'high',
      web_results: 4,
      web_fetch: 2,
      note: '工具最多 4 轮、总调用与总时长有硬上限；只执行服务端只读白名单函数。',
    },
  },
  json: {
    label: '结构化 JSON 可靠性',
    enabled: 1,
    daily_quota: 0,
    max_per_turn: 2,
    timeout_ms: 60000,
    config: {
      max_retry: 1,
      max_output_tokens: 2200,
      thinking: 'disabled',
      note: '空 content、截断、非 JSON 或缺少必填字段时只重试一次，不采用无界续写。',
    },
  },
};

/* ==================================================================== */
/*  二、模型配置引用与凭据解析（绝不返回密文/明文）                       */
/* ==================================================================== */

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i;

export function isLoopbackHost(host) {
  return LOOPBACK.test(String(host || '').toLowerCase());
}

/** 自动化测试用的回环桩；仅显式允许回环出站时生效，生产保持官方 origin。 */
export function deepseekOrigin() {
  const raw = process.env.CCER_DEEPSEEK_TEST_BASE;
  if (!raw || process.env.CCER_ALLOW_LOOPBACK_OUTBOUND !== '1') return DEEPSEEK_OFFICIAL_ORIGIN;
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || !isLoopbackHost(u.hostname)) return DEEPSEEK_OFFICIAL_ORIGIN;
    return u.origin;
  } catch {
    return DEEPSEEK_OFFICIAL_ORIGIN;
  }
}

export function deepseekUrl(path) {
  const p = String(path || '');
  return `${deepseekOrigin()}${p.startsWith('/') ? p : `/${p}`}`;
}

/**
 * 绑定对象必须是启用的官方 DeepSeek 模型配置。
 * 只校验配置，不读取密钥；返回可公开显示的原因。
 */
export function officialProviderError(provider) {
  if (!provider) return '未绑定模型配置';
  if (!provider.enabled) return '绑定的模型配置未启用';
  if (provider.archived) return '绑定的模型配置已归档';
  let u = null;
  try {
    u = new URL(String(provider.base_url || ''));
  } catch {
    return '模型配置的 Base URL 不合法';
  }
  if (u.protocol !== 'https:') return 'DeepSeek 官方能力只允许 HTTPS';
  if (u.hostname.toLowerCase() !== 'api.deepseek.com') {
    return `只允许绑定 https://api.deepseek.com 官方模型配置（当前 ${u.hostname}）；不会把其它服务商密钥转发给 DeepSeek`;
  }
  if (u.username || u.password) return '模型 Base URL 不能携带用户名或密码';
  return null;
}

export function isOfficialDeepSeekProvider(provider) {
  return !officialProviderError(provider);
}

/**
 * 搜索/抓取配置的凭据解析：
 *   · 配置了 provider_id → 读取对应 llm_provider 的凭据（模型 Key 轮换后自动使用新值）；
 *   · 未配置 provider_id → 保持既有独立凭据方式，兼容 Bocha / Firecrawl / 百度 OCR。
 * 返回值包含 secret，仅可用于服务端请求头，不得序列化给前端/日志。
 */
export function resolveCapabilityCredential(conf = {}) {
  if (!conf || typeof conf !== 'object') return { ok: false, reason: '缺少连接配置' };
  if (conf.provider_id) {
    // 只允许 DeepSeek 官方 Search/Fetch 连接引用模型凭据；防止把 DeepSeek Key
    // 通过一条自建/代理商搜索连接转发到其它 host。
    const kind = conf.provider_kind || conf.conn_kind || null;
    if (kind && !['deepseek_search', 'deepseek_fetch'].includes(kind)) {
      return { ok: false, reason: '引用模型凭据只允许用于 DeepSeek 官方 Search/Fetch 连接', provider: null, via: 'provider_id' };
    }
    const p = get('SELECT * FROM llm_provider WHERE id=?', [conf.provider_id]);
    if (!p) return { ok: false, reason: `引用的模型配置不存在：${conf.provider_id}`, provider: null };
    const officialError = officialProviderError(p);
    if (officialError) return { ok: false, reason: officialError, provider: p };
    if (!validCredentialRef(p.credential_ref)) return { ok: false, reason: '模型配置的凭据引用不合法', provider: p };
    const cred = resolveCredential(p);
    if (!cred.ok) {
      return {
        ok: false, reason: `引用的模型配置凭据不可用：${cred.reason}`, provider: p,
        credential_source: null, via: 'provider_id',
      };
    }
    return {
      ok: true, source: cred.source, secret: cred.secret || null,
      provider: p, via: 'provider_id',
      credential_label: `${p.name}（${p.model}）`,
    };
  }
  // 兼容旧路径：独立搜索/抓取连接仍可使用自己的环境变量引用或加密凭据
  const out = resolveStoredCredential(conf);
  return { ...out, provider: null, via: conf.credential_ref ? 'own_reference' : 'none' };
}

/* ==================================================================== */
/*  三、能力配置与预算                                                   */
/* ==================================================================== */

export function ensureDeepSeekCapabilityRows() {
  const now = nowIso();
  for (const kind of DEEPSEEK_CAPABILITY_KINDS) {
    const def = DEEPSEEK_CAPABILITY_DEFAULTS[kind];
    const exists = get('SELECT kind FROM deepseek_capability WHERE kind=?', [kind]);
    if (!exists) {
      run(
        `INSERT INTO deepseek_capability
          (kind,label,enabled,provider_id,config_json,daily_quota,max_per_turn,timeout_ms,calls_today,
           calls_today_date,total_calls,total_success,created_at,updated_at)
         VALUES (?,?,?,NULL,?,?,?,?,0,NULL,0,0,?,?)`,
        [kind, def.label, def.enabled, j(def.config), def.daily_quota, def.max_per_turn, def.timeout_ms, now, now]
      );
    }
  }
}

/**
 * 自动提供一套初始 DeepSeek 能力配置：
 *   · 只在已存在**启用、官方**模型配置时创建；
 *   · 已存在任何 deepseek_search / deepseek_fetch 配置时绝不重复创建或覆盖；
 *   · 新行标记为 fallback，主服务仍按 is_fallback=0 优先；不会替换用户已有主服务。
 */
export function ensureDeepSeekDefaults() {
  ensureDeepSeekCapabilityRows();
  const official = all(
    "SELECT * FROM llm_provider WHERE enabled=1 AND archived=0 ORDER BY created_at"
  ).find((p) => isOfficialDeepSeekProvider(p));
  if (!official) return { created: [], provider: null };

  const now = nowIso();
  // 能力行的 provider_id 仅在为空时补齐，不覆盖管理员已有选择。
  for (const kind of DEEPSEEK_CAPABILITY_KINDS) {
    run(
      'UPDATE deepseek_capability SET provider_id=?, provider_bound=1, updated_at=? WHERE kind=? AND provider_bound=0 AND (provider_id IS NULL OR provider_id=\'\')',
      [official.id, now, kind]
    );
  }
  const created = [];
  const hasSearch = get("SELECT id FROM search_provider WHERE provider_kind='deepseek_search' LIMIT 1");
  if (!hasSearch && !get("SELECT id FROM search_provider WHERE id='DS-SEARCH-AUTO'")) {
    const id = 'DS-SEARCH-AUTO';
    run(
      `INSERT INTO search_provider
        (id,name,provider_kind,base_url,search_path,http_method,auth_kind,auth_header,credential_ref,credential_cipher,
         param_map_json,response_map_json,timeout_ms,retry_max,daily_quota,calls_today,calls_today_date,enabled,
         allowed_domains,provider_id,is_fallback,fallback_priority,note,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,0,NULL,?,?,?,?,?,?,?,?,?)`,
      [
        id, 'DeepSeek Search（自动引用模型凭据）', 'deepseek_search', DEEPSEEK_OFFICIAL_ORIGIN,
        DEEPSEEK_PATHS.search, 'POST', 'bearer', null,
        j({ query_field: 'query', count_field: 'count', need_content_field: 'need_content', ori_question_field: 'ori_question', extra: {} }),
        j({ results_path: 'results', url_field: 'url', title_field: 'title', snippet_field: 'summary', snippet_fallback_field: 'snippet', raw_content_field: 'content', publisher_field: 'site_name', published_field: 'date', score_field: 'rerank_score' }),
        25000, 1, 300, 1, j(['api.deepseek.com']), official.id, 1, 100,
        '自动生成的备用通道：引用现有模型凭据，不复制 Key；已存在主搜索服务时只在主服务失败/无结果时尝试。',
        'system:deepseek-default', now, now,
      ]
    );
    created.push({ kind: 'search', id });
  }
  const hasFetch = get("SELECT id FROM web_fetch_connection WHERE conn_kind='deepseek_fetch' LIMIT 1");
  if (!hasFetch && !get("SELECT id FROM web_fetch_connection WHERE id='DS-FETCH-AUTO'")) {
    const id = 'DS-FETCH-AUTO';
    run(
      `INSERT INTO web_fetch_connection
        (id,name,conn_kind,base_url,endpoint_path,http_method,auth_kind,auth_header,credential_ref,credential_cipher,
         mcp_tool_name,mcp_list_tool,mcp_allowed_tools,param_map_json,response_map_json,timeout_ms,retry_max,daily_quota,
         calls_today,calls_today_date,enabled,allowed_domains,provider_id,is_fallback,fallback_priority,note,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,?,?,?,0,NULL,?,?,?,?,?,?,?,?,?)`,
      [
        id, 'DeepSeek Fetch（自动引用模型凭据）', 'deepseek_fetch', DEEPSEEK_OFFICIAL_ORIGIN,
        DEEPSEEK_PATHS.fetch, 'POST', 'bearer', null,
        j({ url_arg: 'url', format_arg: null, format_value: null, extra: {} }),
        j({ content_path: 'content', title_path: 'title' }),
        40000, 1, 300, 1, j(['api.deepseek.com']), official.id, 1, 100,
        '自动生成的备用通道：引用现有模型凭据，不复制 Key；已存在主抓取连接时只在主连接失败/缺正文时尝试。',
        'system:deepseek-default', now, now,
      ]
    );
    created.push({ kind: 'fetch', id });
  }
  if (created.length) {
    audit({
      actor: 'system:deepseek-default', action: 'deepseek.defaults.create',
      objectType: 'deepseek_capability', objectId: official.id,
      detail: { created, provider_id: official.id, mode: 'fallback' },
    });
  }
  return { created, provider: { id: official.id, name: official.name, model: official.model } };
}

export function capabilityRow(kind) {
  ensureDeepSeekCapabilityRows();
  return get('SELECT * FROM deepseek_capability WHERE kind=?', [kind]) || null;
}

export function capabilityConfig(kind) {
  const row = capabilityRow(kind);
  const def = DEEPSEEK_CAPABILITY_DEFAULTS[kind] || { config: {} };
  return { ...def.config, ...uj(row?.config_json, {}) };
}

export function capabilityBudgetState(kind) {
  const row = capabilityRow(kind);
  if (!row) return { ok: false, reason: 'unknown_capability', message: `未知能力：${kind}` };
  const today = todayCst();
  if (!row.enabled) return { ok: false, reason: 'disabled', message: `${row.label}未启用` };
  if (row.budget_stopped_date === today) {
    return { ok: false, reason: 'budget_stopped', message: `${row.label}今日因 402（余额不足）已停止调用` };
  }
  const used = row.calls_today_date === today ? Number(row.calls_today || 0) : 0;
  if (Number(row.daily_quota) > 0 && used >= Number(row.daily_quota)) {
    return { ok: false, reason: 'quota_exceeded', message: `${row.label}今日调用已达限额 ${row.daily_quota}` };
  }
  return { ok: true, used, quota: Number(row.daily_quota) || 0, row };
}

/** 在真实发出请求前预留一次能力调用；失败时返回可读原因。 */
export function reserveCapabilityCall(kind, n = 1) {
  const state = capabilityBudgetState(kind);
  if (!state.ok) return state;
  const today = todayCst();
  const used = state.used;
  run(
    `UPDATE deepseek_capability SET calls_today=?, calls_today_date=?, total_calls=total_calls+?,
       last_call_at=?, updated_at=? WHERE kind=?`,
    [used + n, today, n, nowIso(), nowIso(), kind]
  );
  return { ok: true, used: used + n };
}

export function recordCapabilitySuccess(kind) {
  run(
    `UPDATE deepseek_capability SET total_success=total_success+1, last_success_at=?, last_error=NULL,
       updated_at=? WHERE kind=?`,
    [nowIso(), nowIso(), kind]
  );
}

export function recordCapabilityFailure(kind, reason, message) {
  const today = todayCst();
  const stop = reason === 'budget_exhausted' ? today : null;
  run(
    `UPDATE deepseek_capability SET last_failure_at=?, last_error=?, updated_at=?,
       budget_stopped_date=COALESCE(?, budget_stopped_date) WHERE kind=?`,
    [nowIso(), `${reason}: ${String(message || '').slice(0, 400)}`, nowIso(), stop, kind]
  );
}

export function capabilityProviderBinding(kind) {
  const row = capabilityRow(kind);
  if (!row) return { ok: false, reason: 'unknown_capability' };
  if (!row.provider_id) return { ok: false, reason: 'no_provider', row };
  const p = get('SELECT * FROM llm_provider WHERE id=?', [row.provider_id]);
  if (!p) return { ok: false, reason: 'provider_missing', row, provider: null };
  const officialError = officialProviderError(p);
  if (officialError) return { ok: false, reason: 'invalid_provider', message: officialError, row, provider: p };
  const cred = resolveCredential(p);
  return {
    ok: cred.ok, reason: cred.ok ? null : 'no_credential', message: cred.ok ? null : cred.reason,
    provider: p, credential_source: cred.ok ? cred.source : null, row,
  };
}

export function capabilityPublic(kind) {
  const row = capabilityRow(kind);
  if (!row) return null;
  const binding = capabilityProviderBinding(kind);
  const budget = capabilityBudgetState(kind);
  return {
    kind,
    label: row.label,
    enabled: !!row.enabled,
    provider_id: row.provider_id || null,
    provider_name: binding.provider?.name || null,
    provider_model: binding.provider?.model || null,
    provider_official: binding.provider ? isOfficialDeepSeekProvider(binding.provider) : false,
    credential_configured: !!binding.ok,
    credential_source: binding.credential_source || null,
    binding_hint: binding.ok ? null : (binding.message || binding.reason || '未绑定可调用模型'),
    config: capabilityConfig(kind),
    daily_quota: row.daily_quota,
    max_per_turn: row.max_per_turn,
    timeout_ms: row.timeout_ms,
    calls_today: row.calls_today_date === todayCst() ? Number(row.calls_today || 0) : 0,
    total_calls: Number(row.total_calls || 0),
    total_success: Number(row.total_success || 0),
    last_call_at: row.last_call_at,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    last_error: row.last_error,
    budget_stopped_today: row.budget_stopped_date === todayCst(),
    budget: budget.ok ? { state: 'ok', used: budget.used, quota: budget.quota } : { state: budget.reason, message: budget.message },
  };
}

export function deepseekCapabilities() {
  ensureDeepSeekDefaults();
  return DEEPSEEK_CAPABILITY_KINDS.map(capabilityPublic).filter(Boolean);
}

export function saveDeepSeekCapability(user, kind, patch = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可配置 DeepSeek 能力', status: 403 };
  if (!DEEPSEEK_CAPABILITY_KINDS.includes(kind)) return { error: `未知能力：${kind}`, status: 400 };
  const existing = capabilityRow(kind);
  if (!existing) return { error: '能力配置不存在', status: 404 };
  const def = DEEPSEEK_CAPABILITY_DEFAULTS[kind];
  const out = { ...existing, ...patch };
  if (patch.provider_id !== undefined && patch.provider_id !== null && patch.provider_id !== '') {
    const p = get('SELECT * FROM llm_provider WHERE id=?', [patch.provider_id]);
    if (!p) return { error: '绑定的模型配置不存在', status: 400 };
    const officialError = officialProviderError(p);
    if (officialError) return { error: officialError, status: 400 };
  }
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;
  const dailyQuota = Number(patch.daily_quota ?? existing.daily_quota ?? def.daily_quota);
  const maxPerTurn = Number(patch.max_per_turn ?? existing.max_per_turn ?? def.max_per_turn);
  const timeoutMs = Number(patch.timeout_ms ?? existing.timeout_ms ?? def.timeout_ms);
  if (!Number.isFinite(dailyQuota) || dailyQuota < 0 || dailyQuota > 100000) return { error: '每日额度须在 0—100000', status: 400 };
  if (!Number.isFinite(maxPerTurn) || maxPerTurn < 1 || maxPerTurn > 20) return { error: '单轮次数须在 1—20', status: 400 };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) return { error: '超时须在 1000—180000 ms', status: 400 };
  const config = { ...capabilityConfig(kind), ...(patch.config && typeof patch.config === 'object' ? patch.config : {}) };
  run(
    `UPDATE deepseek_capability SET enabled=?, provider_id=?, provider_bound=CASE WHEN ? THEN 1 ELSE provider_bound END,
       config_json=?, daily_quota=?, max_per_turn=?, timeout_ms=?, budget_stopped_date=NULL, last_error=NULL,
       updated_at=? WHERE kind=?`,
    [enabled, patch.provider_id === undefined ? existing.provider_id : (patch.provider_id || null),
      patch.provider_id !== undefined ? 1 : 0, j(config),
      dailyQuota, maxPerTurn, timeoutMs, nowIso(), kind]
  );
  audit({
    actor: user.name, actorRole: user.role, action: 'deepseek.capability.save',
    objectType: 'deepseek_capability', objectId: kind,
    detail: { enabled, provider_id: patch.provider_id === undefined ? existing.provider_id : patch.provider_id || null, daily_quota: dailyQuota },
  });
  return { ok: true, capability: capabilityPublic(kind) };
}

/* ==================================================================== */
/*  四、Search 请求/响应与真实调用                                       */
/* ==================================================================== */

export function clipWellFormed(text, max) {
  const s = String(text ?? '');
  if (max <= 0) return '';
  if (s.length <= max) return s;
  let end = max;
  // 不把代理对切成半个字符（JSON 会变成无效 Unicode）
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

export function buildDeepSeekSearchRequest(provider, query, opts = {}) {
  const cfg = capabilityConfig('search');
  const q = clipWellFormed(String(query || '').trim(), 128);
  if (!q) return { error: 'query 不能为空', status: 400 };
  const count = Math.max(1, Math.min(Number(opts.count ?? cfg.count_default ?? 8) || 8, 50, Number(cfg.max_count) || 50));
  const body = {
    query: q,
    count,
    need_content: opts.need_content === true,
  };
  if (opts.ori_question) body.ori_question = clipWellFormed(String(opts.ori_question), 128);
  const cred = resolveCapabilityCredential(provider);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (cred.ok && cred.secret) headers.authorization = `Bearer ${cred.secret}`;
  return {
    url: deepseekUrl(DEEPSEEK_PATHS.search), method: 'POST', headers, body,
    credential: cred, endpoint_origin: deepseekOrigin(),
  };
}

export function normalizeDeepSeekSearchResults(payload, { needContent = false } = {}) {
  const arr = Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.data?.results) ? payload.data.results
      : Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.search_results) ? payload.search_results
          : [];
  return arr.map((r) => {
    const url = r?.url || r?.link;
    const content = typeof r?.content === 'string' && r.content.trim() ? r.content : null;
    const summary = r?.summary || r?.snippet || r?.description || '';
    const published = r?.date || r?.published_at || r?.published || null;
    return {
      url: url ? String(url) : null,
      canonical_url: url ? canonicalize(url) : null,
      title: r?.title ? String(r.title).slice(0, 400) : null,
      snippet: summary ? String(summary).slice(0, 4000) : null,
      raw_content: content,
      content_kind: content ? 'full_text' : 'search_summary',
      need_content: !!needContent,
      published_at: published ? String(published).slice(0, 10) : null,
      publisher: r?.site_name || r?.publisher || null,
      score: Number.isFinite(Number(r?.rerank_score ?? r?.score)) ? Number(r?.rerank_score ?? r?.score) : null,
      authority: Number.isFinite(Number(r?.authority)) ? Number(r.authority) : null,
      source_kind: 'deepseek_search',
    };
  }).filter((r) => r.url && /^https?:\/\//i.test(r.url));
}

function canonicalize(raw) {
  try {
    const u = new URL(String(raw));
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'ref']) u.searchParams.delete(k);
    u.hash = '';
    return u.toString().replace(/\?$/, '');
  } catch {
    return String(raw || '');
  }
}

export function classifyDeepSeekHttp(status) {
  if (status === 401) return 'auth_error';
  if (status === 402) return 'budget_exhausted';
  if (status === 403) return 'blocked_by_policy';
  if (status === 404) return 'not_found';
  if (status === 408) return 'upstream_timeout';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  if (status >= 500) return 'provider_error';
  if (status >= 300 && status < 400) return 'redirect_blocked';
  return 'http_error';
}

function retryable(reason) {
  return ['upstream_timeout', 'rate_limited', 'provider_error', 'network', 'timeout'].includes(reason);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestDeepSeek(kind, req, {
  deadlineAt = null, retryMax = 1, timeoutMs = 25000, backoffMs = 800, recordSuccess = true,
} = {}) {
  const started = Date.now();
  const cfg = capabilityConfig(kind);
  const budget = reserveCapabilityCall(kind);
  if (!budget.ok) return { ok: false, reason: budget.reason, message: budget.message, latency_ms: 0, attempts: 0 };
  const deadline = deadlineAt !== null && deadlineAt !== undefined && deadlineAt !== '' && Number(deadlineAt) > 0
    ? Number(deadlineAt)
    : null;
  const left = () => (deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY);
  let attempts = 0;
  let last = { ok: false, reason: 'unknown', message: '未执行' };
  while (attempts <= retryMax) {
    attempts += 1;
    if (deadline && left() <= 250) {
      last = { ok: false, reason: 'deadline_exceeded', message: '整批时间上限已到，未再发出 DeepSeek 请求' };
      break;
    }
    const attemptTimeout = Math.max(250, Math.min(Number(timeoutMs) || 25000, left() - 50, 120000));
    try {
      const res = await fetch(req.url, {
        method: req.method || 'POST',
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(attemptTimeout),
      });
      const text = await res.text();
      if (!res.ok) {
        const reason = classifyDeepSeekHttp(res.status);
        let message = `HTTP ${res.status}：${text.slice(0, 300)}`;
        try {
          const e = JSON.parse(text);
          if (e?.error?.message) message = `HTTP ${res.status}：${String(e.error.message).slice(0, 300)}`;
        } catch { /* 保留原始响应片段 */ }
        last = {
          ok: false, reason, message, http_status: res.status,
          retryable: retryable(reason) && attempts <= retryMax,
        };
        if (reason === 'budget_exhausted') {
          recordCapabilityFailure(kind, reason, message);
          return { ...last, latency_ms: Date.now() - started, attempts };
        }
        if (!retryable(reason) || attempts > retryMax) break;
        const wait = Math.max(0, Math.min(Number(backoffMs) * attempts, 5000));
        if (wait > 0) await sleep(wait);
        continue;
      }
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        last = { ok: false, reason: 'bad_response', message: `响应不是合法 JSON：${text.slice(0, 200)}` };
        break;
      }
      if (recordSuccess) recordCapabilitySuccess(kind);
      last = {
        ok: true, payload, http_status: res.status, latency_ms: Date.now() - started,
        attempts, usage: payload?.usage || null,
      };
      break;    } catch (e) {
      const timeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
      last = {
        ok: false, reason: timeout ? 'timeout' : 'network',
        message: `${e.message}${e.cause?.code ? `（${e.cause.code}）` : ''}`,
      };
      if (attempts > retryMax) break;
      const wait = Math.max(0, Math.min(Number(backoffMs) * attempts, 5000));
      if (wait > 0) await sleep(wait);
    }
  }
  if (!last.ok) recordCapabilityFailure(kind, last.reason, last.message);
  return { ...last, latency_ms: Date.now() - started, attempts };
}

export async function runDeepSeekSearch(provider, query, opts = {}) {
  if (!provider) return { ok: false, reason: 'not_configured', message: '未配置 DeepSeek Search' };
  if (!provider.enabled) return { ok: false, reason: 'disabled', message: 'DeepSeek Search 未启用' };
  const cap = capabilityBudgetState('search');
  if (!cap.ok) return { ok: false, reason: cap.reason, message: cap.message };
  const cfg = capabilityConfig('search');
  const req = buildDeepSeekSearchRequest(provider, query, opts);
  if (req.error) return { ok: false, reason: 'bad_request', message: req.error };
  if (!req.credential.ok) return { ok: false, reason: 'no_credential', message: req.credential.reason };
  // endpoint 由服务端固定（或回环测试桩），配置里的 base_url 不参与实际 URL 拼接。
  const outChk = checkOutboundUrl(req.url, [new URL(req.url).hostname]);
  if (!outChk.ok) return { ok: false, reason: 'blocked_url', message: outChk.reason };
  const retryMax = Math.max(0, Math.min(Number(opts.retry_max ?? cfg.max_attempts - 1 ?? 1), 2));
  const out = await requestDeepSeek('search', req, {
    deadlineAt: opts.deadlineAt,
    retryMax,
    timeoutMs: Math.min(Number(provider.timeout_ms) || Number(cfg.timeout_ms) || 25000, Number(opts.timeoutMs) || 25000),
    backoffMs: Number(cfg.backoff_ms) || 800,
    recordSuccess: false,
  });
  const usage = out.usage || null;
  const results = out.ok ? normalizeDeepSeekSearchResults(out.payload, { needContent: req.body.need_content }) : [];
  const usable = !!out.ok && results.length > 0;
  if (usable) recordCapabilitySuccess('search');
  else if (out.ok) recordCapabilityFailure('search', 'empty_result', 'DeepSeek Search 返回 0 条结果（空结果不计成功）');
  try {
    run(
      `UPDATE search_provider SET last_call_at=?, last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
         total_calls=total_calls+?, total_success=total_success+CASE WHEN ? THEN 1 ELSE 0 END,
         last_error=?, last_usage_json=?, updated_at=? WHERE id=?`,
      [nowIso(), usable ? 1 : 0, nowIso(), out.attempts || 0, usable ? 1 : 0,
        usable ? null : `${out.reason || 'empty_result'}: ${out.message || ''}`.slice(0, 500), usage ? j(usage) : null, nowIso(), provider.id]
    );
  } catch { /* 统计失败不影响结果 */ }
  if (!out.ok) return { ...out, provider_id: provider.id, provider_name: provider.name };
  return {
    ok: true,
    results,
    raw_count: results.length,
    empty: results.length === 0,
    empty_note: results.length === 0 ? 'DeepSeek Search 返回 0 条结果（空结果按空结果展示）' : null,
    usage,
    latency_ms: out.latency_ms,
    attempts: out.attempts,
    query,
    provider_id: provider.id,
    provider_name: provider.name,
    search_engine: 'deepseek',
    need_content: req.body.need_content,
    content_note: req.body.need_content
      ? '已请求 need_content=true；仍以每条实际 content 是否为空判断是否取得正文。'
      : '未请求正文（need_content=false），结果只能作为搜索摘要引用。',
    price_note: `按公开价 5 元/千次成功请求估算，单次约 ¥${DEEPSEEK_SEARCH_PRICE_CNY}；价格可能调整。`,
  };
}

/* ==================================================================== */
/*  五、Fetch 目标校验与真实调用                                         */
/* ==================================================================== */

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const METADATA_HOSTS = new Set([
  'metadata.google.internal', 'metadata.google.com', 'metadata.azure.internal',
  '169.254.169.254', '100.100.100.200', '0.0.0.0', 'localhost', 'localhost.localdomain',
]);

export function unsafeFetchUrlReason(raw, { allowLoopback = false } = {}) {
  let u = null;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return '目标 URL 不合法';
  }
  if (!['http:', 'https:'].includes(u.protocol)) return `不支持的目标协议：${u.protocol}`;
  if (u.username || u.password) return '目标 URL 不能携带用户名或密码';
  if (String(raw).length > 8192) return '目标 URL 超过 8192 字符';
  const rawHost = u.hostname.toLowerCase();
  const host = rawHost.replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '');
  if (host.endsWith('.internal') || host.endsWith('.local') || host === 'localhost' || host.endsWith('.localhost')) {
    return `拒绝内部/本机域名：${rawHost}`;
  }
  if (METADATA_HOSTS.has(host) && !(allowLoopback && isLoopbackHost(host))) return `拒绝访问元数据/本机地址：${host}`;
  if (isLoopbackHost(host) && !allowLoopback) return `拒绝访问本机地址：${host}`;
  if (PRIVATE_V4.test(host) && !(allowLoopback && isLoopbackHost(host))) return `拒绝访问内网地址：${host}`;
  // IPv6：loopback、ULA(fc00::/7)、link-local(fe80::/10)、IPv4-mapped 均不得作为抓取目标。
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return `拒绝访问本机/未指定 IPv6 地址：${host}`;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return `拒绝访问 IPv6 内网地址：${host}`;
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return `拒绝访问 IPv6 链路本地地址：${host}`;
    if (/^::ffff:/i.test(host) || /^0:0:0:0:0:ffff:/i.test(host)) return `拒绝访问 IPv4-mapped IPv6 地址：${host}`;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !allowLoopback) return '拒绝直接使用 IP 地址抓取，请使用公开域名';
  return null;
}

export function assertSafeFetchTarget(raw, { allowLoopback = process.env.CCER_ALLOW_LOOPBACK_OUTBOUND === '1' } = {}) {
  const reason = unsafeFetchUrlReason(raw, { allowLoopback });
  return reason ? { ok: false, reason } : { ok: true, url: String(raw) };
}

export function buildDeepSeekFetchRequest(provider, url, opts = {}) {
  const safe = assertSafeFetchTarget(url);
  if (!safe.ok) return { error: safe.reason, status: 400 };
  const cred = resolveCapabilityCredential(provider);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (cred.ok && cred.secret) headers.authorization = `Bearer ${cred.secret}`;
  return {
    url: deepseekUrl(DEEPSEEK_PATHS.fetch), method: 'POST', headers,
    body: { url: String(url) }, credential: cred, endpoint_origin: deepseekOrigin(),
  };
}

export function normalizeDeepSeekFetch(payload) {
  const title = payload?.title ? String(payload.title).slice(0, 400) : null;
  const content = typeof payload?.content === 'string' ? payload.content : '';
  return {
    title,
    content: content || null,
    chars: content ? content.length : 0,
    content_hash: content ? sha256(Buffer.from(content, 'utf8')) : null,
    empty: !content,
  };
}

export async function runDeepSeekFetch(conn, targetUrl, opts = {}) {
  if (!conn) return { ok: false, url: targetUrl, reason: 'not_configured', message: '未配置 DeepSeek Fetch' };
  if (!conn.enabled) return { ok: false, url: targetUrl, reason: 'disabled', message: 'DeepSeek Fetch 未启用', latency_ms: 0 };
  const cap = capabilityBudgetState('fetch');
  if (!cap.ok) return { ok: false, url: targetUrl, reason: cap.reason, message: cap.message, latency_ms: 0 };
  const cfg = capabilityConfig('fetch');
  const safe = assertSafeFetchTarget(targetUrl);
  if (!safe.ok) return { ok: false, url: targetUrl, reason: 'blocked_url', message: safe.reason, latency_ms: 0 };
  const req = buildDeepSeekFetchRequest(conn, targetUrl, opts);
  if (req.error) return { ok: false, url: targetUrl, reason: 'blocked_url', message: req.error, latency_ms: 0 };
  if (!req.credential.ok) return { ok: false, url: targetUrl, reason: 'no_credential', message: req.credential.reason, latency_ms: 0 };
  const outChk = checkOutboundUrl(req.url, [new URL(req.url).hostname]);
  if (!outChk.ok) return { ok: false, url: targetUrl, reason: 'blocked_url', message: outChk.reason, latency_ms: 0 };
  const retryMax = Math.max(0, Math.min(Number(opts.retry_max ?? cfg.max_attempts - 1 ?? 1), 2));
  const started = Date.now();
  const out = await requestDeepSeek('fetch', req, {
    deadlineAt: opts.deadlineAt,
    retryMax,
    timeoutMs: Math.min(Number(conn.timeout_ms) || Number(cfg.timeout_ms) || 40000, Number(opts.timeoutMs) || 40000),
    backoffMs: Number(cfg.backoff_ms) || 800,
    recordSuccess: false,
  });
  const content = out.ok ? normalizeDeepSeekFetch(out.payload) : { content: null, chars: 0 };
  const usable = !!out.ok && !!content.content;
  if (usable) recordCapabilitySuccess('fetch');
  else if (out.ok) recordCapabilityFailure('fetch', 'empty_content', 'DeepSeek Fetch 未返回正文（空结果不计成功）');
  try {
    run(
      `UPDATE web_fetch_connection SET last_call_at=?, last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
         total_calls=total_calls+?, total_success=total_success+CASE WHEN ? THEN 1 ELSE 0 END,
         last_error=?, last_usage_json=?, updated_at=? WHERE id=?`,
      [nowIso(), usable ? 1 : 0, nowIso(), out.attempts || 0, usable ? 1 : 0,
        usable ? null : `${out.reason || 'empty_content'}: ${out.message || ''}`.slice(0, 500), out.usage ? j(out.usage) : null, nowIso(), conn.id]
    );
  } catch { /* 统计失败不影响结果 */ }
  if (!out.ok) {
    return {
      ok: false, url: targetUrl, reason: out.reason, message: out.message,
      latency_ms: Date.now() - started, attempts: out.attempts,
      provider_id: conn.id, provider_name: conn.name, conn_kind: 'deepseek_fetch',
    };
  }
  if (!content.content) {
    return {
      ok: false, url: targetUrl, reason: 'empty_content',
      message: 'DeepSeek Fetch 成功但未返回正文（不伪造已读全文）',
      latency_ms: Date.now() - started, attempts: out.attempts,
      provider_id: conn.id, provider_name: conn.name, conn_kind: 'deepseek_fetch',
    };
  }
  const limited = clipWellFormed(content.content, Number(cfg.max_content_chars) || 30000);
  return {
    ok: true,
    url: targetUrl,
    title: content.title,
    content: limited,
    chars: limited.length,
    content_hash: sha256(Buffer.from(limited, 'utf8')),
    metadata: { origin: 'deepseek_fetch', full_content_chars: content.chars },
    availability: content.chars >= 1200 ? 'full_text' : 'partial',
    reason: null,
    message: null,
    attempts: out.attempts,
    latency_ms: Date.now() - started,
    usage: out.usage || null,
    provider_id: conn.id,
    provider_name: conn.name,
    conn_kind: 'deepseek_fetch',
    price_note: `按公开价 5 元/千次成功请求估算，单次约 ¥${DEEPSEEK_FETCH_PRICE_CNY}；价格可能调整。`,
  };
}

/* ==================================================================== */
/*  六、Files API 图片复用（只用于视觉补充，不上传整份 PDF）              */
/* ==================================================================== */

export const FILE_TTL_MIN = 3600;
export const FILE_TTL_MAX = 2592000;

export function fileCachePublic(limit = 20) {
  const rows = all(
    `SELECT id,provider_id,image_hash,file_id,bytes,filename,expires_at,uploaded_at,last_used_at,deleted_at,status,error
     FROM deepseek_file_cache ORDER BY uploaded_at DESC LIMIT ?`, [Math.min(Number(limit) || 20, 100)]
  );
  return rows.map((r) => ({
    id: r.id, provider_id: r.provider_id, image_hash: r.image_hash,
    file_id: r.file_id ? `${String(r.file_id).slice(0, 16)}…` : null,
    bytes: r.bytes, filename: r.filename, expires_at: r.expires_at,
    uploaded_at: r.uploaded_at, last_used_at: r.last_used_at,
    status: r.status, error: r.error,
  }));
}

export function activeCachedFile(providerId, imageHash) {
  const row = get(
    "SELECT * FROM deepseek_file_cache WHERE provider_id=? AND image_hash=? AND status='active'",
    [providerId, imageHash]
  );
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now() + 60_000) return null;
  return row;
}

export async function uploadVisionImage(provider, imageBuffer, {
  filename = 'page.png', ttlSeconds = 86400, deadlineAt = null,
} = {}) {
  const binding = officialProviderError(provider);
  if (binding) return { ok: false, reason: 'invalid_provider', message: binding };
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return { ok: false, reason: 'bad_image', message: '图片为空' };
  if (imageBuffer.length > 64 * 1024 * 1024) return { ok: false, reason: 'image_too_large', message: '图片超过 64 MiB' };
  const cap = capabilityBudgetState('vision');
  if (!cap.ok) return { ok: false, reason: cap.reason, message: cap.message };
  const cred = resolveCredential(provider);
  if (!cred.ok) return { ok: false, reason: 'no_credential', message: cred.reason };
  const ttl = Math.max(FILE_TTL_MIN, Math.min(Number(ttlSeconds) || 86400, FILE_TTL_MAX));
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('expires_after[anchor]', 'created_at');
  form.append('expires_after[seconds]', String(ttl));
  form.append('file', new Blob([imageBuffer], { type: 'image/png' }), filename);
  const deadline = deadlineAt !== null && deadlineAt !== undefined && deadlineAt !== '' && Number(deadlineAt) > 0
    ? Number(deadlineAt)
    : null;
  const timeoutMs = Math.max(500, Math.min(60000, deadline ? deadline - Date.now() - 50 : 60000));
  let res = null;
  let text = '';
  try {
    res = await fetch(deepseekUrl(DEEPSEEK_PATHS.files), {
      method: 'POST',
      headers: { authorization: `Bearer ${cred.secret}` },
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: 'network', message: e.message };
  }
  if (!res.ok) {
    const reason = classifyDeepSeekHttp(res.status);
    if (reason === 'budget_exhausted') recordCapabilityFailure('vision', reason, text.slice(0, 300));
    return { ok: false, reason, message: `Files 上传失败 HTTP ${res.status}：${text.slice(0, 200)}` };
  }
  let payload = null;
  try { payload = JSON.parse(text); } catch { return { ok: false, reason: 'bad_response', message: 'Files 上传响应不是 JSON' }; }
  if (!payload?.id) return { ok: false, reason: 'bad_response', message: 'Files 上传响应缺少 id' };
  const now = nowIso();
  const expiresAt = payload.expires_at
    ? new Date(Number(payload.expires_at) * 1000).toISOString()
    : new Date(Date.now() + ttl * 1000).toISOString();
  const imageHash = sha256(imageBuffer);
  const existing = get('SELECT id FROM deepseek_file_cache WHERE provider_id=? AND image_hash=?', [provider.id, imageHash]);
  if (existing) {
    run(
      `UPDATE deepseek_file_cache SET file_id=?,bytes=?,filename=?,expires_at=?,uploaded_at=?,last_used_at=?,
         deleted_at=NULL,status='active',error=NULL WHERE id=?`,
      [payload.id, imageBuffer.length, filename, expiresAt, now, now, existing.id]
    );
  } else {
    run(
      `INSERT INTO deepseek_file_cache
        (id,provider_id,image_hash,file_id,bytes,filename,purpose,expires_at,uploaded_at,last_used_at,deleted_at,status,error)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'active',NULL)`,
      [newId('DSF'), provider.id, imageHash, payload.id, imageBuffer.length, filename, 'user_data', expiresAt, now, now]
    );
  }
  return { ok: true, file_id: payload.id, expires_at: expiresAt, image_hash: imageHash, bytes: imageBuffer.length };
}

export async function deleteVisionFile(provider, fileId) {
  const officialError = officialProviderError(provider);
  if (officialError) return { ok: false, reason: 'invalid_provider', message: officialError };
  const cred = resolveCredential(provider);
  if (!cred.ok) return { ok: false, reason: 'no_credential', message: cred.reason };
  try {
    const res = await fetch(deepseekUrl(`${DEEPSEEK_PATHS.files}/${encodeURIComponent(fileId)}`), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${cred.secret}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, reason: classifyDeepSeekHttp(res.status), message: `删除文件失败 HTTP ${res.status}：${text.slice(0, 200)}` };
    }
    return { ok: true, file_id: fileId };
  } catch (e) {
    return { ok: false, reason: 'network', message: e.message };
  }
}

/** 过期清理：先删远端，再标记本地记录；不建独立文件管理页面。 */
export async function cleanupExpiredFiles({ limit = 10, provider = null } = {}) {
  const rows = all(
    "SELECT * FROM deepseek_file_cache WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT ?",
    [nowIso(), Math.max(1, Math.min(Number(limit) || 10, 50))]
  );
  const out = [];
  for (const row of rows) {
    let p = provider;
    if (!p) p = get('SELECT * FROM llm_provider WHERE id=?', [row.provider_id]);
    let deleted = { ok: false, reason: 'provider_missing' };
    if (p) deleted = await deleteVisionFile(p, row.file_id);
    run(
      `UPDATE deepseek_file_cache SET status=?,deleted_at=?,error=? WHERE id=?`,
      [deleted.ok ? 'deleted' : 'expired', nowIso(), deleted.ok ? null : (deleted.message || deleted.reason), row.id]
    );
    out.push({ file_id: `${String(row.file_id).slice(0, 12)}…`, deleted: deleted.ok, reason: deleted.reason || null });
  }
  return { scanned: rows.length, results: out };
}

/* ==================================================================== */
/*  七、后台概览与测试                                                   */
/* ==================================================================== */

export function deepseekOverview() {
  const defaults = ensureDeepSeekDefaults();
  const schemaVersion = metaValue('schema_version', null);
  const providers = all('SELECT * FROM llm_provider WHERE archived=0 ORDER BY created_at')
    .map((p) => ({
      id: p.id, name: p.name, model: p.model, base_url: p.base_url,
      enabled: !!p.enabled, official: isOfficialDeepSeekProvider(p),
      credential_configured: resolveCredential(p).ok,
    }));
  const files = get("SELECT COUNT(*) n, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active FROM deepseek_file_cache") || {};
  const vision = get("SELECT COUNT(*) n, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN applied=1 THEN 1 ELSE 0 END) applied FROM deepseek_vision_page") || {};
  const usage = get(
    `SELECT COUNT(*) calls, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok,
            SUM(COALESCE(cache_hit_tokens,0)) cache_hit, SUM(COALESCE(cache_miss_tokens,0)) cache_miss,
            SUM(COALESCE(tool_calls,0)) tool_calls, SUM(CASE WHEN cost_estimated=1 THEN 1 ELSE 0 END) cost_estimated_calls,
            SUM(COALESCE(estimated_cost_cny,0)) estimated_cost_cny
     FROM llm_call_log`
  ) || {};
  const recentCalls = all(
    `SELECT at,purpose,model,status,latency_ms,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,
            tool_calls,thinking_enabled,finish_reason,cost_estimated,estimated_cost_cny,error
     FROM llm_call_log ORDER BY at DESC LIMIT 8`
  );
  const toolStats = get(
    `SELECT COUNT(*) calls, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok FROM chat_tool_call`
  ) || {};
  return {
    capabilities: deepseekCapabilities(),
    providers,
    secret_key: keyStatus(),
    defaults,
    file_cache: { total: Number(files.n || 0), active: Number(files.active || 0) },
    vision: { total: Number(vision.n || 0), ok: Number(vision.ok || 0), applied: Number(vision.applied || 0) },
    usage: {
      calls: Number(usage.calls || 0), ok: Number(usage.ok || 0),
      cache_hit_tokens: Number(usage.cache_hit || 0), cache_miss_tokens: Number(usage.cache_miss || 0),
      tool_calls: Number(usage.tool_calls || 0), cost_estimated_calls: Number(usage.cost_estimated_calls || 0),
      estimated_cost_cny: Number(usage.estimated_cost_cny || 0),
    },
    recent_calls: recentCalls.map((r) => ({
      at: r.at, purpose: r.purpose, model: r.model, status: r.status, latency_ms: r.latency_ms,
      prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens,
      cache_hit_tokens: r.cache_hit_tokens, cache_miss_tokens: r.cache_miss_tokens,
      tool_calls: r.tool_calls, thinking: r.thinking_enabled === 1,
      finish_reason: r.finish_reason, cost_estimated: !!r.cost_estimated,
      estimated_cost_cny: r.estimated_cost_cny, error: r.error,
    })),
    tool_calls: { calls: Number(toolStats.calls || 0), ok: Number(toolStats.ok || 0) },
    schema_version: schemaVersion,
    pricing_note:
      'Search/Fetch 当前公开价为 5 元/千次成功请求（价格可能调整，界面不承诺永久价）。' +
      '模型 token 仅在存在 usage 字段或配置了明确单价时估算，并标注“估算”。',
    boundary_note:
      'Search 与 Fetch 是两个独立能力；搜索摘要不等于全文，多引擎返回同一 URL 也不构成多源验证。' +
      '视觉输出只是有页图依据的模型理解材料，不自动改写正式因子，也不冒充官方事实。',
  };
}

/**
 * 视觉 / 工具问答 / JSON 的按钮只做「鉴权与模型连接测试」：
 *   · 真实发一次有配额、有超时、写入 llm_call_log 的最小文本请求；
 *   · 明确 capability_verified=false，不把文本 ping 冒充视觉/工具/JSON 完整能力验收；
 *   · Search/Fetch 的真实能力测试在路由层走各自适配器，不经过本函数。
 */
export async function testDeepSeekBinding(user, kind, { deadlineAt = null } = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可测试 DeepSeek 能力', status: 403 };
  if (!DEEPSEEK_CAPABILITY_KINDS.includes(kind)) return { error: `未知能力：${kind}`, status: 400 };
  if (kind === 'search' || kind === 'fetch') {
    return { error: 'Search/Fetch 必须通过对应连接执行真实能力测试，不能用文本 ping 代替', status: 400 };
  }
  const capabilityLabel = DEEPSEEK_CAPABILITY_DEFAULTS[kind]?.label || kind;
  const binding = capabilityProviderBinding(kind);
  const provider = binding.provider || null;
  const out = {
    ok: false, configured: !!binding.ok, callable: false, real_call_performed: false,
    test_scope: 'auth_and_model_connectivity',
    capability_verified: false,
    test_label: '鉴权与模型连接测试',
    capability: kind,
    capability_label: capabilityLabel,
    note: '只验证引用凭据和模型端点能否返回文本；不等于视觉页图识别、工具协议调用或 JSON 结构化字段的完整能力验收。',
    provider: provider
      ? { id: provider.id, name: provider.name, model: provider.model, official: isOfficialDeepSeekProvider(provider) }
      : null,
    endpoint: deepseekUrl(DEEPSEEK_PATHS.chat),
    credential_configured: !!binding.ok,
    credential_source: binding.credential_source || null,
  };
  if (!provider) {
    out.reason = binding.reason || 'no_provider';
    out.message = binding.message || '未绑定模型配置';
    return out;
  }
  if (!binding.ok) {
    out.reason = binding.reason || 'invalid_provider';
    out.message = `已配置但不可调用：${binding.message || binding.reason}`;
    return out;
  }
  // 连接测试也占用能力配额，不能绕过每日额度/402 停止标记。
  const budget = reserveCapabilityCall(kind);
  if (!budget.ok) {
    out.reason = budget.reason;
    out.message = `未发起连接测试：${budget.message}`;
    return out;
  }
  out.capability_quota_reserved = true;
  const started = Date.now();
  const remaining = deadlineAt ? Math.max(1000, Math.min(30000, Number(deadlineAt) - Date.now())) : 30000;
  const call = await callVerifyModel({
    provider,
    prompt: '鉴权与模型连接测试：请只回复 ok',
    systemPrompt: '这是平台管理员的鉴权与模型连接测试。只回复 ok，不要解释。',
    purpose: `deepseek_test_${kind}`,
    actor: user?.name || 'admin',
    objectType: 'deepseek_capability',
    objectId: kind,
    maxTokens: 16,
    timeoutMs: remaining,
    thinking: 'disabled',
    jsonMode: false,
    requireJson: false,
    retryCount: 0,
  });
  out.real_call_performed = true;
  out.http_status = call.http_status ?? null;
  out.latency_ms = Date.now() - started;
  out.call_logged = true;
  out.finish_reason = call.finish_reason || null;
  if (!call.ok || call.http_status === null) {
    out.reason = call.reason || 'network';
    out.message = `鉴权与模型连接测试未通过（${out.reason}）：${String(call.detail || '').slice(0, 200)}`;
    recordCapabilityFailure(kind, out.reason, out.message);
    return out;
  }
  const content = typeof call.raw === 'string' ? call.raw.trim() : '';
  out.callable = content.length > 0;
  out.response_preview = content ? content.slice(0, 80) : null;
  if (!out.callable) {
    out.reason = 'empty_response';
    out.message = '鉴权与模型连接测试未通过：模型返回空文本。';
    recordCapabilityFailure(kind, out.reason, out.message);
    return out;
  }
  out.ok = true;
  recordCapabilitySuccess(kind);
  out.message =
    `鉴权与模型连接测试通过：HTTP ${call.http_status}，${out.latency_ms} ms，调用已记录；` +
    `仅验证凭据与模型端点可调用，不等于${capabilityLabel}完整能力验收（capability_verified=false）。`;
  return out;
}

export { keyStatus };
