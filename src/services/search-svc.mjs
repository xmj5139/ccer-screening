/**
 * 搜索服务适配器（search-svc）
 * ============================================================================
 * 需求（docs/19 第 35 条、docs/23）：
 *   - **默认推荐博查 Web Search**（用户 2026-09-29 指定）；Tavily / Firecrawl Search /
 *     自建 JSON 网关保留为可选项；
 *   - 请求与响应结构以供应商当前官方文档核实；支持调用限额、超时、重试、
 *     凭据只存服务端；未配置时如实显示不可用，不用空返回假装成功。
 *
 * 已核实的供应商结构：
 *   博查 Bocha Web Search  POST https://api.bocha.cn/v1/web-search
 *           Authorization: Bearer <BOCHA_API_KEY>
 *           body: {query, summary:true, count:1..50, freshness: noLimit|oneDay|oneWeek|oneMonth|oneYear}
 *           resp: {code:200, log_id, data:{webPages:{value:[{name,url,summary,snippet,
 *                  siteName,datePublished,dateLastCrawled}]}}}
 *           注意：summary/snippet 只是**摘要，不是全文**，正文交给抓取连接获取；
 *           dateLastCrawled 是抓取时间，**不得**当作发布日期。
 *           旧地址 api.bochaai.com 可手工改写配置，但系统不会静默替换，也不会跨域发送密钥。
 *   Tavily  POST https://api.tavily.com/search
 *           Authorization: Bearer tvly-…   （也支持 api_key 放在 body）
 *           resp: {query, answer, results:[{title,url,content,score,raw_content,published_date}]}
 *   Firecrawl Search  POST https://api.firecrawl.dev/v1/search
 *           Authorization: Bearer fc-…
 *           resp: {success, data:{web:[{title,description,url,markdown}]}}
 *   generic_json：管理员可自定义 URL / 请求字段映射 / 响应路径，适配自建搜索网关。
 *
 * 【安全】搜索结果里的任何文本都是**数据**。本模块只做字段抽取与截断，
 * 不会把结果内容拼进任何指令位置；下游核验另有提示注入防护。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj, todayCst } from '../core/util.mjs';
import { encryptSecret, resolveStoredCredential, keyStatus, validCredentialRef, CREDENTIAL_REF_HINT, redactCredentialText } from '../core/secrets.mjs';
import { checkOutboundUrl } from './collect-svc.mjs';
import {
  DEEPSEEK_OFFICIAL_ORIGIN, DEEPSEEK_PATHS, resolveCapabilityCredential,
  runDeepSeekSearch, buildDeepSeekSearchRequest, officialProviderError, ensureDeepSeekDefaults,
} from './deepseek-capability-svc.mjs';

/* ==================================================================== */
/*  一、供应商预设（真实端点与字段路径）                                  */
/* ==================================================================== */

export const SEARCH_KINDS = {
  bocha: {
    label: '博查 Web Search（用户指定默认）',
    recommended: true,
    base_url: 'https://api.bocha.cn',
    search_path: '/v1/web-search',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: 'BOCHA_API_KEY',
    allowed_domains: ['api.bocha.cn'],
    param_map: {
      query_field: 'query',
      count_field: 'count',
      freshness_field: 'freshness',
      freshness_value: 'noLimit',
      summary_field: 'summary',
      raw_content_field: null,
      extra: {},
    },
    response_map: {
      results_path: 'data.webPages.value',
      url_field: 'url',
      title_field: 'name',
      snippet_field: 'summary',
      snippet_fallback_field: 'snippet',
      publisher_field: 'siteName',
      published_field: 'datePublished',
      // 明确不使用 dateLastCrawled（那是抓取时间，不能当发布日期）
      raw_content_field: null,
      score_field: null,
      business_code_field: 'code',
      business_code_ok: 200,
      log_id_field: 'log_id',
    },
    doc_url: 'https://github.com/Bocha-Labs/bocha-skills/blob/main/bocha-web-search/SKILL.md',
    notes:
      'Bearer 鉴权（凭据引用 BOCHA_API_KEY，服务端解析）；count 1—50；summary=true 返回摘要（**不是全文**，' +
      '正文由抓取连接获取）；freshness 支持 noLimit/oneDay/oneWeek/oneMonth/oneYear；' +
      'HTTP 200 但 code≠200 也算失败，log_id 可用于排错。旧地址 api.bochaai.com 可手工改写，' +
      '系统不会静默替换，也不会把密钥发往未列入白名单的域名。',
  },
  tavily: {
    label: 'Tavily Search API',
    base_url: 'https://api.tavily.com',
    search_path: '/search',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: 'TAVILY_API_KEY',
    allowed_domains: ['api.tavily.com'],
    param_map: {
      query_field: 'query',
      count_field: 'max_results',
      depth_field: 'search_depth',
      depth_value: 'basic',
      topic_field: 'topic',
      raw_content_field: 'include_raw_content',
      domains_field: 'include_domains',
      start_field: 'start_date',
      end_field: 'end_date',
      extra: {},
    },
    response_map: {
      results_path: 'results',
      url_field: 'url',
      title_field: 'title',
      snippet_field: 'content',
      raw_content_field: 'raw_content',
      published_field: 'published_date',
      score_field: 'score',
    },    doc_url: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
    notes:
      'Bearer 鉴权；max_results 上限 20；topic=news 适合行业动态；include_raw_content=true 可一次拿到正文（额外计费）。',
  },
  firecrawl_search: {
    label: 'Firecrawl Search API',
    base_url: 'https://api.firecrawl.dev',
    search_path: '/v1/search',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: 'FIRECRAWL_API_KEY',
    allowed_domains: ['api.firecrawl.dev'],
    param_map: {
      query_field: 'query',
      count_field: 'limit',
      sources_field: 'sources',
      sources_value: ['web', 'news'],
      scrape_formats: ['markdown'],
      extra: {},
    },
    response_map: {
      results_path: 'data.web',
      url_field: 'url',
      title_field: 'title',
      snippet_field: 'description',
      raw_content_field: 'markdown',
      published_field: 'date',
      score_field: null,
    },
    doc_url: 'https://docs.firecrawl.dev/api-reference/v1-endpoint/search',
    notes: 'Bearer 鉴权；sources 可选 web/news；scrapeOptions.formats 带 markdown 可直接获得正文。',
  },
  generic_json: {
    label: '自建 / 其它兼容 JSON 搜索网关',
    base_url: '',
    search_path: '/search',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: null,
    allowed_domains: [],
    param_map: {
      query_field: 'query',
      count_field: 'count',
      start_field: 'start_date',
      end_field: 'end_date',
      extra: {},
    },
    response_map: {
      results_path: 'results',
      url_field: 'url',
      title_field: 'title',
      snippet_field: 'snippet',
      raw_content_field: 'content',
      published_field: 'published_at',
      score_field: 'score',
    },
    doc_url: null,
    notes: '按贵方网关的实际字段填写请求映射与响应映射；路径用点号表示层级（如 data.items）。',
  },
  deepseek_search: {
    label: 'DeepSeek Search（官方 · 引用模型凭据）',
    base_url: DEEPSEEK_OFFICIAL_ORIGIN,
    search_path: DEEPSEEK_PATHS.search,
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: null,
    allowed_domains: ['api.deepseek.com'],
    provider_required: true,
    fallback: true,
    param_map: {
      query_field: 'query',
      count_field: 'count',
      need_content_field: 'need_content',
      ori_question_field: 'ori_question',
      extra: {},
    },
    response_map: {
      results_path: 'results',
      url_field: 'url',
      title_field: 'title',
      snippet_field: 'summary',
      snippet_fallback_field: 'snippet',
      raw_content_field: 'content',
      publisher_field: 'site_name',
      published_field: 'date',
      score_field: 'rerank_score',
    },
    doc_url: 'https://api-docs.deepseek.com/zh-cn/guides/search/',
    notes:
      '官方固定端点 POST https://api.deepseek.com/v1/tools/search；Bearer 鉴权，' +
      '凭据通过 provider_id 引用现有官方模型配置，不复制 Key。query 1—128 Unicode 字符，count 1—50；' +
      'need_content=true 才请求正文。成功且结果非空才计费（公开价 5 元/千次，价格可能调整）。' +
      '生成行默认作为 fallback：主服务失败/无结果时才尝试，不替换用户已有主服务。',
  },
};

/** 从对象里按点号路径取值（支持 a.b.c） */
export function pickPath(obj, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), obj);
}

/** 归一化 URL（去掉跟踪参数，用于去重） */
export function canonicalizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const drop = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'spm', 'from', 'share_token', 'ref', 'fbclid', 'gclid', 'scene',
    ];
    for (const k of drop) u.searchParams.delete(k);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('?')) s = s.slice(0, -1);
    return s;
  } catch {
    return String(raw || '');
  }
}

/* ==================================================================== */
/*  二、搜索服务配置 CRUD（凭据只存服务端）                               */
/* ==================================================================== */

export function listSearchProviders() {
  ensureDeepSeekDefaults();
  return all('SELECT * FROM search_provider WHERE archived=0 ORDER BY is_fallback, fallback_priority, created_at').map((p) => {
    const cred = resolveCapabilityCredential(p);
    return {
      id: p.id,
      name: p.name,
      provider_kind: p.provider_kind,
      kind_label: SEARCH_KINDS[p.provider_kind]?.label || p.provider_kind,
      base_url: p.base_url,
      search_path: p.search_path,
      http_method: p.http_method,
      auth_kind: p.auth_kind,
      auth_header: p.auth_header,
      provider_id: p.provider_id || null,
      provider_name: cred.provider?.name || null,
      provider_model: cred.provider?.model || null,
      credential_ref: validCredentialRef(p.credential_ref) ? p.credential_ref : null,
      // 只返回「是否已配置」，绝不返回凭据本身
      credential_configured: cred.ok,
      credential_source: cred.ok ? cred.source : null,
      credential_hint: cred.ok ? null : cred.reason,
      credential_stored_encrypted: !!p.credential_cipher,
      credential_via: cred.via || null,
      param_map: uj(p.param_map_json, {}),
      response_map: uj(p.response_map_json, {}),
      timeout_ms: p.timeout_ms,
      retry_max: p.retry_max,
      daily_quota: p.daily_quota,
      calls_today: p.calls_today_date === todayCst() ? p.calls_today : 0,
      calls_today_date: p.calls_today_date,
      total_calls: Number(p.total_calls || 0),
      total_success: Number(p.total_success || 0),
      last_call_at: p.last_call_at,
      last_success_at: p.last_success_at,
      last_usage: uj(p.last_usage_json, null),
      enabled: !!p.enabled,
      is_fallback: !!p.is_fallback,
      fallback_priority: Number(p.fallback_priority ?? 100),
      allowed_domains: uj(p.allowed_domains, []),
      last_test_at: p.last_test_at,
      last_test_result: p.last_test_result,
      last_test_message: redactCredentialText(p.last_test_message),
      note: p.note,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  });
}

export function upsertSearchProvider(user, payload = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可配置搜索服务', status: 403 };
  const existing = payload.id ? get('SELECT * FROM search_provider WHERE id=?', [payload.id]) : null;
  const isNew = !existing;
  const preset = SEARCH_KINDS[payload.provider_kind] || SEARCH_KINDS.generic_json;

  const fields = {
    name: payload.name ?? existing?.name ?? preset.label,
    provider_kind: payload.provider_kind ?? existing?.provider_kind ?? 'generic_json',
    base_url: payload.base_url ?? existing?.base_url ?? preset.base_url ?? '',
    search_path: payload.search_path ?? existing?.search_path ?? preset.search_path,
    http_method: payload.http_method ?? existing?.http_method ?? preset.http_method,
    auth_kind: payload.auth_kind ?? existing?.auth_kind ?? preset.auth_kind,
    auth_header: payload.auth_header ?? existing?.auth_header ?? null,
    provider_id: payload.provider_id === undefined ? existing?.provider_id ?? null : (payload.provider_id || null),
    is_fallback: payload.is_fallback === undefined ? existing?.is_fallback ?? (preset.fallback ? 1 : 0) : (payload.is_fallback ? 1 : 0),
    fallback_priority: Number(payload.fallback_priority ?? existing?.fallback_priority ?? 100),
    credential_ref: payload.credential_ref === undefined ? existing?.credential_ref ?? preset.credential_ref : payload.credential_ref,
    param_map: payload.param_map ? j(payload.param_map) : existing?.param_map_json ?? j(preset.param_map),
    response_map: payload.response_map ? j(payload.response_map) : existing?.response_map_json ?? j(preset.response_map),
    timeout_ms: Number(payload.timeout_ms ?? existing?.timeout_ms ?? 25000),
    retry_max: Number(payload.retry_max ?? existing?.retry_max ?? 2),
    daily_quota: Number(payload.daily_quota ?? existing?.daily_quota ?? 1000),
    enabled: payload.enabled === undefined ? existing?.enabled ?? 0 : payload.enabled ? 1 : 0,
    allowed_domains: payload.allowed_domains ? j(payload.allowed_domains) : existing?.allowed_domains ?? j(preset.allowed_domains || []),
    note: payload.note ?? existing?.note ?? null,
  };
  // DeepSeek Search 是官方固定端点：服务端强制端点、鉴权与凭据引用，
  // 不信任请求体里的 base_url/搜索路径，避免把管理员密钥发往其它 host。
  if (fields.provider_kind === 'deepseek_search') {
    if (!fields.provider_id) return { error: 'DeepSeek Search 必须引用现有官方模型配置（provider_id），不要单独填写 Key', status: 400 };
    const p = get('SELECT * FROM llm_provider WHERE id=?', [fields.provider_id]);
    const providerError = officialProviderError(p);
    if (providerError) return { error: providerError, status: 400 };
    fields.base_url = DEEPSEEK_OFFICIAL_ORIGIN;
    fields.search_path = DEEPSEEK_PATHS.search;
    fields.http_method = 'POST';
    fields.auth_kind = 'bearer';
    fields.auth_header = null;
    fields.credential_ref = null;
    fields.allowed_domains = j(['api.deepseek.com']);
    if (!fields.param_map || fields.param_map === '{}') {
      fields.param_map = j(SEARCH_KINDS.deepseek_search.param_map);
    }
    if (!fields.response_map || fields.response_map === '{}') {
      fields.response_map = j(SEARCH_KINDS.deepseek_search.response_map);
    }
  }
  if (fields.provider_id) {
    if (fields.provider_kind !== 'deepseek_search') {
      return { error: '引用模型凭据只允许用于 DeepSeek Search 官方连接；其它搜索服务请使用自己的凭据引用', status: 400 };
    }
    const p = get('SELECT * FROM llm_provider WHERE id=?', [fields.provider_id]);
    const providerError = officialProviderError(p);
    if (providerError) return { error: providerError, status: 400 };
  }
  if (!fields.name) return { error: '缺少配置名称', status: 400 };
  if (!validCredentialRef(fields.credential_ref)) return { error: CREDENTIAL_REF_HINT, status: 400 };
  if (!/^https?:\/\//i.test(String(fields.base_url))) return { error: '服务地址必须以 http(s):// 开头', status: 400 };
  const domains = uj(fields.allowed_domains, []);
  if (!domains.length) return { error: '必须配置出站域名白名单（防止被改造成访问内网的通道）', status: 400 };
  const chk = checkOutboundUrl(fields.base_url, domains);
  if (!chk.ok) return { error: chk.reason, status: 400 };
  if (!fields.search_path || !String(fields.search_path).startsWith('/')) {
    return { error: '请求路径须以 / 开头（例如 /search 或 /v1/search）', status: 400 };
  }
  if (fields.timeout_ms < 1000 || fields.timeout_ms > 120000) return { error: '超时须在 1000—120000 ms', status: 400 };
  if (fields.retry_max < 0 || fields.retry_max > 5) return { error: '重试次数须在 0—5', status: 400 };
  if (fields.daily_quota < 1) return { error: '调用限额须大于 0', status: 400 };
  if (!Number.isFinite(fields.fallback_priority) || fields.fallback_priority < 0 || fields.fallback_priority > 1000) {
    return { error: '备用顺序须在 0—1000', status: 400 };
  }
  // 引用模型凭据时不需要也不接受另行保存的直连密钥（避免复制同一把 Key）。
  if (fields.provider_id && payload.secret) {
    return { error: '该连接已引用模型凭据；请在该模型配置里更新 Key，系统会自动使用新值，不要在此重复保存', status: 400 };
  }

  let cipher = existing?.credential_cipher || null;
  let secretNote = null;
  if (payload.secret) {
    const enc = encryptSecret(payload.secret);
    if (!enc) {
      return {
        error: '未初始化服务端主密钥，拒绝保存明文凭据',
        message:
          '可在「后台管理 → 模型与连接」点击「初始化本机主密钥」，或由运维设置 CCER_SECRET_KEY；' +
          '也可以只填凭据引用名并把密钥放在服务端环境变量里（凭据完全不入库）。',
        secret_key: keyStatus(),
        status: 400,
      };
    }
    cipher = enc;
    secretNote = '凭据已加密存储（AES-256-GCM），不会返回浏览器。';
  }

  const now = nowIso();
  if (isNew) {
    // 允许调用方指定 id（便于按固定键做幂等配置与自动化测试）；未指定时生成
    const id = payload.id ? String(payload.id) : newId('SRCH');
    const clash = get('SELECT id FROM search_provider WHERE id=?', [id]);
    if (clash) return { error: `搜索服务 ID 已存在：${id}`, status: 409 };
    run(
      `INSERT INTO search_provider (id,name,provider_kind,base_url,search_path,http_method,auth_kind,auth_header,
        credential_ref,credential_cipher,param_map_json,response_map_json,timeout_ms,retry_max,daily_quota,
        calls_today,calls_today_date,enabled,allowed_domains,provider_id,is_fallback,fallback_priority,
        last_test_at,last_test_result,last_test_message,last_error,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,?)`,
      [
        id, fields.name, fields.provider_kind, fields.base_url, fields.search_path, fields.http_method,
        fields.auth_kind, fields.auth_header, fields.credential_ref, cipher, fields.param_map,
        fields.response_map, fields.timeout_ms, fields.retry_max, fields.daily_quota, fields.enabled,
        fields.allowed_domains, fields.provider_id, fields.is_fallback, fields.fallback_priority,
        user?.name || 'unknown', now, now,
      ]
    );
    audit({ actor: user?.name, actorRole: user?.role, action: 'search_provider.create', objectType: 'search_provider', objectId: id, detail: { name: fields.name, kind: fields.provider_kind } });
    return { ok: true, id, action: 'inserted', credential: secretNote };
  }
  run(
    `UPDATE search_provider SET name=?,provider_kind=?,base_url=?,search_path=?,http_method=?,auth_kind=?,
       auth_header=?,credential_ref=?,credential_cipher=?,param_map_json=?,response_map_json=?,timeout_ms=?,
       retry_max=?,daily_quota=?,enabled=?,allowed_domains=?,provider_id=?,is_fallback=?,fallback_priority=?,
       note=?,updated_at=? WHERE id=?`,
    [
      fields.name, fields.provider_kind, fields.base_url, fields.search_path, fields.http_method,
      fields.auth_kind, fields.auth_header, fields.credential_ref, cipher, fields.param_map,
      fields.response_map, fields.timeout_ms, fields.retry_max, fields.daily_quota, fields.enabled,
      fields.allowed_domains, fields.provider_id, fields.is_fallback, fields.fallback_priority,
      fields.note, now, existing.id,
    ]
  );
  audit({ actor: user?.name, actorRole: user?.role, action: 'search_provider.update', objectType: 'search_provider', objectId: existing.id, detail: { enabled: fields.enabled } });
  return { ok: true, id: existing.id, action: 'updated', credential: secretNote };
}

export function pauseSearchProvider(user, id, { enabled = false } = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可启停搜索服务', status: 403 };
  const p = get('SELECT * FROM search_provider WHERE id=?', [id]);
  if (!p) return { error: '搜索服务不存在', status: 404 };
  run('UPDATE search_provider SET enabled=?, updated_at=? WHERE id=?', [enabled ? 1 : 0, nowIso(), id]);
  audit({ actor: user?.name, actorRole: user?.role, action: 'search_provider.toggle', objectType: 'search_provider', objectId: id, detail: { enabled } });
  return { ok: true, id, enabled: !!enabled };
}

/* ==================================================================== */
/*  三、请求构造与执行                                                  */
/* ==================================================================== */

/** 把「最近 N 天」窗口映射为博查等供应商的 freshness 取值 */
export function freshnessForWindow(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 'noLimit';
  if (d <= 1) return 'oneDay';
  if (d <= 7) return 'oneWeek';
  if (d <= 31) return 'oneMonth';
  if (d <= 366) return 'oneYear';
  return 'noLimit';
}

/** 组装搜索请求（供真实调用与 mock 测试共用） */
export function buildSearchRequest(provider, query, opts = {}) {
  if (provider.provider_kind === 'deepseek_search') {
    const req = buildDeepSeekSearchRequest(provider, query, {
      ...opts,
      need_content: opts.need_content === true || opts.raw_content === true,
    });
    if (req.error) throw new Error(req.error);
    return req;
  }
  const paramMap = uj(provider.param_map_json, {}) || {};
  const base = String(provider.base_url || '').replace(/\/+$/, '');
  const path = String(provider.search_path || '/search');
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  const count = Math.min(Math.max(Number(opts.count ?? 10) || 10, 1), 50);

  const body = { ...(paramMap.extra || {}) };
  const set = (field, value) => {
    if (field && value !== undefined && value !== null && value !== '') body[field] = value;
  };
  set(paramMap.query_field || 'query', query);
  set(paramMap.count_field || 'count', count);
  if (paramMap.depth_field && paramMap.depth_value && opts.depth !== false) set(paramMap.depth_field, paramMap.depth_value);
  if (paramMap.topic_field && opts.topic) set(paramMap.topic_field, opts.topic);
  if (paramMap.raw_content_field) body[paramMap.raw_content_field] = opts.raw_content !== false;
  if (paramMap.summary_field) body[paramMap.summary_field] = opts.summary !== false;
  if (paramMap.sources_field && paramMap.sources_value) body[paramMap.sources_field] = paramMap.sources_value;
  if (paramMap.scrape_formats) body.scrapeOptions = { formats: paramMap.scrape_formats };
  if (paramMap.domains_field && Array.isArray(opts.include_domains) && opts.include_domains.length) {
    body[paramMap.domains_field] = opts.include_domains.slice(0, 300);
  }
  if (paramMap.start_field && opts.start_date) set(paramMap.start_field, opts.start_date);
  if (paramMap.end_field && opts.end_date) set(paramMap.end_field, opts.end_date);
  // freshness：显式传入优先；否则按「最近 N 天」窗口推导（供应商不支持时映射里不会有该字段）
  if (paramMap.freshness_field) {
    const fv = opts.freshness
      || (opts.window_days !== undefined && opts.window_days !== null
        ? freshnessForWindow(opts.window_days)
        : (opts.start_date ? 'noLimit' : paramMap.freshness_value));
    if (fv) set(paramMap.freshness_field, fv);
  }

  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const cred = resolveStoredCredential(provider);
  const authKind = provider.auth_kind || 'bearer';
  if (cred.ok && cred.secret) {
    if (authKind === 'bearer') headers.authorization = `Bearer ${cred.secret}`;
    else if (authKind === 'header') headers[provider.auth_header || 'x-api-key'] = cred.secret;
    else if (authKind === 'query') url.searchParams.set(provider.auth_header || 'api_key', cred.secret);
  }
  const method = String(provider.http_method || 'POST').toUpperCase();
  if (method === 'GET') {
    for (const [k, v] of Object.entries(body)) {
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return { url: url.toString(), method, headers, body: null, credential: cred };
  }
  return { url: url.toString(), method, headers, body, credential: cred };
}

/** 按响应映射抽取归一化结果（纯函数，便于用真实响应的 mock 测试） */
export function normalizeSearchResults(provider, payload) {
  const rm = uj(provider.response_map_json, {}) || {};
  let arr = pickPath(payload, rm.results_path || 'results');
  if (!Array.isArray(arr)) {
    // Firecrawl 的 data 有时直接是数组
    const data = pickPath(payload, 'data');
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.web)) arr = data.web;
    else if (Array.isArray(payload?.results)) arr = payload.results;
    else arr = [];
  }
  return arr
    .map((r) => {
      const url = pickPath(r, rm.url_field || 'url');
      const title = pickPath(r, rm.title_field || 'title');
      const snippet = pickPath(r, rm.snippet_field || 'content');
      const snippetFallback = rm.snippet_fallback_field ? pickPath(r, rm.snippet_fallback_field) : undefined;
      const raw = rm.raw_content_field ? pickPath(r, rm.raw_content_field) : undefined;
      // 只使用供应商声明的**发布日期字段**；绝不回退到抓取时间（dateLastCrawled）。
      const published = rm.published_field ? pickPath(r, rm.published_field) : undefined;
      const publisher = rm.publisher_field ? pickPath(r, rm.publisher_field) : undefined;
      const score = rm.score_field ? pickPath(r, rm.score_field) : undefined;
      const snippetText = snippet || snippetFallback;
      return {
        url: url ? String(url) : null,
        canonical_url: url ? canonicalizeUrl(url) : null,
        title: title ? String(title).slice(0, 400) : null,
        snippet: snippetText ? String(snippetText).slice(0, 4000) : null,
        raw_content: raw ? String(raw) : null,
        published_at: published ? String(published).slice(0, 10) : null,
        publisher: publisher ? String(publisher).slice(0, 200) : null,
        score: Number.isFinite(Number(score)) ? Number(score) : null,
      };
    })
    .filter((r) => r.url && /^https?:\/\//i.test(r.url));
}

/**
 * 供应商「HTTP 200 但业务码非 200」的映射（博查等）。
 * @returns {{failed:boolean, reason?:string, code?:any, log_id?:string|null, message?:string}}
 */
export function checkBusinessCode(provider, payload) {
  const rm = uj(provider.response_map_json, {}) || {};
  if (!rm.business_code_field) return { failed: false };
  const code = pickPath(payload, rm.business_code_field);
  if (code === undefined || code === null || code === '') return { failed: false };
  const okCode = rm.business_code_ok === undefined ? 200 : rm.business_code_ok;
  const logIdRaw = rm.log_id_field ? pickPath(payload, rm.log_id_field) ?? null : null;
  const logId = logIdRaw === null || logIdRaw === undefined ? null : String(logIdRaw);
  if (String(code) === String(okCode)) return { failed: false, code, log_id: logId };
  const bizMsg = payload?.message || payload?.msg || payload?.data?.message || null;
  const n = Number(code);
  const reason =
    n === 401 ? 'auth_error'
      : n === 403 ? 'insufficient_balance'
        : n === 429 ? 'rate_limited'
          : n === 400 ? 'bad_request'
            : n >= 500 ? 'provider_error'
              : 'business_error';
  return {
    failed: true,
    code,
    log_id: logId,
    reason,
    message: `业务码 ${code}${bizMsg ? `：${String(bizMsg).slice(0, 200)}` : ''}${logId ? `（log_id=${logId}）` : ''}`,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 执行一次真实搜索。
 * 失败语义明确，绝不返回空数组假装成功：
 *   {ok:false, reason:'not_configured'|'disabled'|'no_credential'|'quota_exceeded'
 *               |'http_error'|'auth_error'|'rate_limited'|'timeout'|'network'|'bad_response'}
 */
export async function runSearch(provider, query, opts = {}) {
  if (!provider) return { ok: false, reason: 'not_configured', message: '未配置搜索服务' };
  if (provider.provider_kind === 'deepseek_search') {
    const out = await runDeepSeekSearch(provider, query, {
      ...opts,
      need_content: opts.need_content === true || opts.raw_content === true,
    });
    return out;
  }
  if (!provider.enabled) return { ok: false, reason: 'disabled', message: '搜索服务未启用' };
  const today = todayCst();
  const used = provider.calls_today_date === today ? Number(provider.calls_today || 0) : 0;
  if (used >= Number(provider.daily_quota || 0)) {
    return { ok: false, reason: 'quota_exceeded', message: `今日调用已达限额 ${provider.daily_quota}`, calls_today: used };
  }
  const req = buildSearchRequest(provider, query, opts);
  if (!req.credential.ok) {
    return { ok: false, reason: 'no_credential', message: req.credential.reason };
  }
  const allowed = uj(provider.allowed_domains, []);
  const outChk = checkOutboundUrl(req.url, allowed);
  if (!outChk.ok) return { ok: false, reason: 'blocked_url', message: outChk.reason };

  const retryMax = Math.max(0, Math.min(Number(provider.retry_max ?? 2), 5));
  const started = Date.now();
  let attempt = 0;
  let last = null;
  // 共享 deadline（CEA 批次传入）：每次请求与每次重试等待都不得超出剩余时间。
  // 不传时行为与旧版一致（默认兼容）。
  const deadline = Number.isFinite(Number(opts.deadlineAt)) ? Number(opts.deadlineAt) : null;
  const remaining = () => (deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY);
  const deadlineMsg = '批次总时间上限已到：搜索请求不再重试或不再发出，留待下一批（不阻塞每日任务）';
  const retryWait = (ms) => (Number.isFinite(remaining()) ? Math.max(0, Math.min(ms, remaining() - 100)) : Math.max(0, ms));
  while (attempt <= retryMax) {
    attempt += 1;
    const left = remaining();
    if (deadline && left <= 250) {
      last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true };
      break;
    }
    const attemptTimeout = Math.max(
      250,
      Math.min(Math.min(Number(provider.timeout_ms) || 25000, 120000), deadline ? left - 50 : Number.POSITIVE_INFINITY)
    );
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(attemptTimeout),
      });
      const text = await res.text();
      if (res.status === 401) {
        last = { ok: false, reason: 'auth_error', message: `鉴权失败 HTTP ${res.status}（凭据无效）：${text.slice(0, 200)}` };
        break; // 鉴权问题重试无意义
      }
      if (res.status === 403) {
        last = { ok: false, reason: 'insufficient_balance', message: `拒绝访问 HTTP ${res.status}（余额不足或无权限，重试无意义）：${text.slice(0, 200)}` };
        break;
      }
      if (res.status === 429) {
        last = { ok: false, reason: 'rate_limited', message: `触发限流 HTTP 429：${text.slice(0, 200)}` };
        if (attempt > retryMax) break;
        const w = retryWait(1200 * attempt);
        if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
        await sleep(w);
        continue;
      }
      if (!res.ok) {
        last = { ok: false, reason: 'http_error', message: `HTTP ${res.status}：${text.slice(0, 300)}` };
        if (res.status < 500 || attempt > retryMax) break;
        const w = retryWait(600 * attempt);
        if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
        await sleep(w);
        continue;
      }
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        last = { ok: false, reason: 'bad_response', message: `响应不是合法 JSON：${text.slice(0, 200)}` };
        break;
      }
      // HTTP 200 但业务码非 200（博查等）→ 明确失败，保留可公开的 log_id 便于排错
      const biz = checkBusinessCode(provider, payload);
      if (biz.failed) {
        last = { ok: false, reason: biz.reason, message: biz.message, log_id: biz.log_id, business_code: biz.code };
        if (biz.reason === 'rate_limited' && attempt <= retryMax) {
          const w = retryWait(1200 * attempt);
          if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
          await sleep(w);
          continue;
        }
        break;
      }
      const results = normalizeSearchResults(provider, payload);
      last = {
        ok: true,
        results,
        raw_count: results.length,
        empty: results.length === 0,
        empty_note: results.length === 0 ? '供应商返回 0 条结果（空结果按空结果展示，不伪造内容）' : null,
        answer: payload?.answer ? String(payload.answer).slice(0, 2000) : null,
        log_id: biz.log_id ?? null,
        usage: payload?.usage ?? null,
        latency_ms: Date.now() - started,
        attempts: attempt,
        query,
      };
      break;
    } catch (e) {
      const timedOutByDeadline = deadline && Date.now() >= deadline - 60;
      const isTimeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
      last = {
        ok: false,
        reason: timedOutByDeadline ? 'deadline_exceeded' : isTimeout ? 'timeout' : 'network',
        message: timedOutByDeadline ? deadlineMsg : `${e.message}${e.cause?.code ? `（${e.cause.code}）` : ''}`,
        deadline_exceeded: timedOutByDeadline || undefined,
      };
      if (attempt > retryMax) break;
      const w = retryWait(600 * attempt);
      if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
      await sleep(w);
    }
  }

  // 调用计数只在真的发出请求后增加（未配置/超限不计数）
  if (last && last.reason !== 'no_credential' && last.reason !== 'blocked_url') {
    try {
      run('UPDATE search_provider SET calls_today=?, calls_today_date=?, last_error=?, updated_at=? WHERE id=?', [
        used + attempt, today, last.ok ? null : `${last.reason}: ${last.message || ''}`.slice(0, 500), nowIso(), provider.id,
      ]);
    } catch {
      /* 计数失败不影响结果 */
    }
  }
  return { ...last, provider_id: provider.id, provider_name: provider.name, attempts: attempt };
}

/** 取一个启用的搜索服务（可按 id 指定）；主服务优先，备用按 fallback_priority。 */
export function pickSearchProvider(id = null) {
  ensureDeepSeekDefaults();
  if (id) return get('SELECT * FROM search_provider WHERE id=?', [id]);
  return get(
    `SELECT * FROM search_provider WHERE enabled=1 AND archived=0
     ORDER BY is_fallback, fallback_priority, created_at LIMIT 1`
  );
}

/**
 * 按显式 id 或「主服务 → 备用」顺序返回候选连接。
 * 调用方负责限制整体尝试次数/请求数/总时长；这里只排序。
 */
export function pickSearchCandidates(id = null) {
  ensureDeepSeekDefaults();
  if (id) {
    const one = get('SELECT * FROM search_provider WHERE id=?', [id]);
    return one ? [one] : [];
  }
  return all(
    `SELECT * FROM search_provider WHERE enabled=1 AND archived=0
     ORDER BY is_fallback, fallback_priority, created_at`
  );
}

/** 真实连接测试：发一次最小查询，区分「已配置」与「可调用」 */
export async function testSearchProvider(user, id) {
  if (user?.role !== 'admin') return { error: '仅管理员可测试搜索服务', status: 403 };
  const p = get('SELECT * FROM search_provider WHERE id=?', [id]);
  if (!p) return { error: '搜索服务不存在', status: 404 };
  const cred = resolveCapabilityCredential(p);
  const domains = uj(p.allowed_domains, []);
  const chk = domains.length ? checkOutboundUrl(p.base_url, domains) : { ok: false, reason: '未配置出站域名白名单' };
  const configured = cred.ok && chk.ok;
  if (!configured) {
    const message = [cred.ok ? null : cred.reason, chk.ok ? null : chk.reason].filter(Boolean).join('；');
    run('UPDATE search_provider SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
      nowIso(), 'configured_only', message, nowIso(), id,
    ]);
    return { ok: false, configured: false, callable: false, real_call_performed: false, message };
  }
  // 用最省额度的一次真实查询
  const out = await runSearch({ ...p, enabled: 1, retry_max: 0 }, 'CCER 温室气体自愿减排', { count: 1, raw_content: false });
  const emptyNote = out.ok && out.empty ? '；供应商返回 0 条结果（空结果，非失败）' : '';
  const logNote = out.log_id ? `；log_id=${out.log_id}` : '';
  const message = out.ok
    ? `真实调用成功：返回 ${out.results.length} 条结果（${out.latency_ms} ms，尝试 ${out.attempts} 次）${emptyNote}${logNote}。`
    : `已配置但不可调用（${out.reason}）：${out.message || ''}`;
  run('UPDATE search_provider SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
    nowIso(), out.ok ? (out.empty ? 'ok_empty' : 'ok') : 'failed', message.slice(0, 800), nowIso(), id,
  ]);
  audit({
    actor: user.name, actorRole: user.role, action: 'search_provider.test',
    objectType: 'search_provider', objectId: id,
    detail: { configured, callable: out.ok, reason: out.reason || null, results: out.results?.length ?? 0 },
    result: out.ok ? 'ok' : 'failed',
  });
  return {
    ok: !!out.ok,
    configured: true,
    callable: !!out.ok,
    real_call_performed: true,
    provider: {
      id: p.id, name: p.name, kind: p.provider_kind,
      endpoint: p.provider_kind === 'deepseek_search' ? `${DEEPSEEK_OFFICIAL_ORIGIN}${DEEPSEEK_PATHS.search}` : `${p.base_url}${p.search_path}`,
      provider_id: p.provider_id || null,
    },
    credential_source: cred.source,
    credential_via: cred.via || null,
    sample: (out.results || []).slice(0, 3).map((r) => ({ title: r.title, url: r.url, published_at: r.published_at })),
    empty: !!out.empty,
    log_id: out.log_id || null,
    latency_ms: out.latency_ms ?? null,
    reason: out.reason || null,
    message,
  };
}

export function searchStatus() {
  ensureDeepSeekDefaults();
  const rows = all('SELECT * FROM search_provider');
  const enabled = rows.filter((r) => r.enabled);
  const usable = enabled.filter((r) => resolveCapabilityCredential(r).ok);
  const today = todayCst();
  return {
    providers: rows.length,
    enabled: enabled.length,
    callable: usable.length,
    available: usable.length > 0,
    primary_count: rows.filter((r) => !r.is_fallback && r.enabled).length,
    fallback_count: rows.filter((r) => r.is_fallback && r.enabled).length,
    detail: rows.map((r) => {
      const cred = resolveCapabilityCredential(r);
      const used = r.calls_today_date === today ? Number(r.calls_today || 0) : 0;
      return {
        id: r.id, name: r.name, kind: r.provider_kind,
        enabled: !!r.enabled, credential_configured: cred.ok,
        credential_via: cred.via || null,
        provider_id: r.provider_id || null,
        is_fallback: !!r.is_fallback,
        calls_today: used, daily_quota: r.daily_quota,
        total_calls: Number(r.total_calls || 0),
        total_success: Number(r.total_success || 0),
        last_call_at: r.last_call_at, last_success_at: r.last_success_at,
        last_test_result: r.last_test_result, last_test_at: r.last_test_at,
      };
    }),
    note: usable.length
      ? `搜索服务可用于发现公开研报与行业动态（主服务 ${rows.filter((r) => !r.is_fallback && r.enabled).length} 个，备用 ${rows.filter((r) => r.is_fallback && r.enabled).length} 个）。`
      : '未配置可调用的搜索服务：研报与动态模块只能展示已采集内容，不会用空结果假装采集成功。',
  };
}
