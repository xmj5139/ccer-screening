/**
 * 网页抓取连接（web-fetch-svc）
 * ============================================================================
 * 需求（docs/19 第 36 条）：提供一个**真正可工作**的网页抓取连接，可选
 *   A) Firecrawl Scrape API   B) 远端 Streamable HTTP MCP 的 tools/list + tools/call。
 * 配置须写清：服务地址、工具名、参数映射、鉴权、域名与测试结果。
 *
 * 【MCP 实现要点】（依据 modelcontextprotocol 规范的 Streamable HTTP 传输）
 *   - 单一端点，JSON-RPC 2.0；请求头 Accept: application/json, text/event-stream。
 *   - 先 POST initialize（protocolVersion / capabilities / clientInfo），
 *     从响应头 `mcp-session-id` 取得会话；随后发送 notifications/initialized。
 *   - POST tools/list 拿工具清单；POST tools/call 执行工具。
 *   - 响应可能是 application/json，也可能是 text/event-stream（SSE），两种都要解析。
 *   - **只读约束**：只允许调用白名单里列出的工具；未列入者一律拒绝，
 *     因此不会因为远端服务器暴露了写入类工具就产生副作用。
 *
 * 【安全】远端返回的一切文本都是数据。写入库前只做长度截断与哈希，
 * 不执行、不解释为指令；下游核验另有提示注入防护。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj, todayCst } from '../core/util.mjs';
import { encryptSecret, resolveStoredCredential, keyStatus, validCredentialRef, CREDENTIAL_REF_HINT, redactCredentialText } from '../core/secrets.mjs';
import { checkOutboundUrl, sha256 } from './collect-svc.mjs';
import {
  DEEPSEEK_OFFICIAL_ORIGIN, DEEPSEEK_PATHS, resolveCapabilityCredential,
  runDeepSeekFetch, officialProviderError, ensureDeepSeekDefaults,
} from './deepseek-capability-svc.mjs';

export const FETCH_KINDS = {
  mcp_http: {
    label: 'Firecrawl v2 MCP（用户指定 · 推荐）',
    recommended: true,
    preset_key: 'firecrawl_mcp',
    base_url: 'https://mcp.firecrawl.dev',
    endpoint_path: '/v2/mcp',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: 'FIRECRAWL_API_KEY',
    allowed_domains: ['mcp.firecrawl.dev'],
    mcp_tool_name: 'firecrawl_scrape',
    mcp_allowed_tools: ['firecrawl_scrape'],
    param_map: { url_arg: 'url', format_arg: 'formats', format_value: ['markdown'], extra: {} },
    response_map: { content_path: 'markdown', title_path: 'metadata.title', status_path: 'success' },
    keyless_trial: true,
    doc_url: 'https://docs.firecrawl.dev/mcp-server/tools',
    notes:
      'Streamable HTTP MCP：同一端点做 initialize → tools/list → tools/call，只允许调用只读白名单内的工具。' +
      '官方该固定地址提供**无密钥限额试用**，但抓取可能被拒（Anonymous keyless access is unavailable）；' +
      '生产请配置 FIRECRAWL_API_KEY（Bearer，仅服务端解析，禁止写入 URL）。' +
      '「连接及工具可用」与「抓取授权/实际调用成功」在测试结果中分开显示。',
  },
  firecrawl_mcp: {
    label: 'Firecrawl v2 MCP（别名）',
    base_url: 'https://mcp.firecrawl.dev',
    endpoint_path: '/v2/mcp',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: 'FIRECRAWL_API_KEY',
    allowed_domains: ['mcp.firecrawl.dev'],
    mcp_tool_name: 'firecrawl_scrape',
    mcp_allowed_tools: ['firecrawl_scrape'],
    param_map: { url_arg: 'url', format_arg: 'formats', format_value: ['markdown'], extra: {} },
    response_map: { content_path: 'markdown', title_path: 'metadata.title', status_path: 'success' },
    keyless_trial: true,
    doc_url: 'https://docs.firecrawl.dev/mcp-server/tools',
    notes: '与 conn_kind=mcp_http 等价；保留别名以兼容既有配置与测试。',
  },
  firecrawl_scrape: {
    label: 'Firecrawl Scrape API',
    base_url: 'https://api.firecrawl.dev',
    endpoint_path: '/v1/scrape',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: 'FIRECRAWL_API_KEY',
    allowed_domains: ['api.firecrawl.dev'],
    param_map: { url_arg: 'url', format_arg: 'formats', format_value: ['markdown'], extra: { onlyMainContent: true } },
    response_map: { content_path: 'data.markdown', title_path: 'data.metadata.title', status_path: 'success' },
    doc_url: 'https://docs.firecrawl.dev/api-reference/v1-endpoint/scrape',
    notes: 'Bearer 鉴权；formats=["markdown"] 返回正文 markdown；data.metadata 含 title/sourceURL/statusCode。',
  },
  direct_http: {
    label: '直连 HTTP 抓取（本服务自行请求，无需第三方密钥）',
    base_url: 'https://www.mee.gov.cn',
    endpoint_path: '/',
    http_method: 'GET',
    auth_kind: 'none',
    credential_ref: null,
    allowed_domains: ['mee.gov.cn', 'www.mee.gov.cn', 'ccer.cets.org.cn', 'www.ccer.com.cn'],
    param_map: { url_arg: null, format_arg: null, format_value: null, extra: {} },
    response_map: { content_path: null, title_path: null, status_path: null },
    doc_url: null,
    notes:
      '由本服务直接 GET 目标页面并抽取正文文本（确定性规则，不用大模型改写）。' +
      '无需任何第三方密钥，适合政府/协会官网等静态页面；不执行 JS，动态渲染页面会取不到内容。',
  },
  mcp_streamable_http: {
    label: '远端 MCP（Streamable HTTP，只调用只读工具）',
    base_url: '',
    endpoint_path: '/mcp',
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: null,
    allowed_domains: [],
    mcp_tool_name: null,
    mcp_allowed_tools: [],
    param_map: { url_arg: 'url', format_arg: null, format_value: null, extra: {} },
    response_map: { content_path: null, title_path: null, status_path: null },
    doc_url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http',
    notes:
      '同一端点做 initialize → tools/list → tools/call；支持 application/json 与 text/event-stream 两种响应。' +
      '只允许调用白名单内的只读工具。',
  },
  deepseek_fetch: {
    label: 'DeepSeek Fetch（官方 · 引用模型凭据）',
    base_url: DEEPSEEK_OFFICIAL_ORIGIN,
    endpoint_path: DEEPSEEK_PATHS.fetch,
    http_method: 'POST',
    auth_kind: 'bearer',
    credential_ref: null,
    allowed_domains: ['api.deepseek.com'],
    provider_required: true,
    fallback: true,
    param_map: { url_arg: 'url', format_arg: null, format_value: null, extra: {} },
    response_map: { content_path: 'content', title_path: 'title' },
    doc_url: 'https://api-docs.deepseek.com/zh-cn/guides/search/',
    notes:
      '官方固定端点 POST https://api.deepseek.com/v1/tools/fetch，请求 {url}，返回 title/content（Markdown）。' +
      '凭据通过 provider_id 引用现有官方模型配置，不复制 Key。目标必须是允许的公开 HTTP(S) 地址；' +
      '3xx 不跟随、不把管理员凭据转给目标站点。成功且返回正文才计费（公开价 5 元/千次，价格可能调整）。',
  },
};

/** 所有 MCP 传输类别（历史别名与新增预设等价处理） */
export const MCP_CONN_KINDS = ['mcp_http', 'firecrawl_mcp', 'mcp_streamable_http'];

/** 是否 MCP 传输 */
export function isMcpKind(kind) {
  return MCP_CONN_KINDS.includes(String(kind || ''));
}


export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_INFO = { name: 'ccer-public-info-platform', version: '2.1.0' };

/* ==================================================================== */
/*  一、MCP JSON-RPC 传输（纯函数 + 真实 HTTP）                          */
/* ==================================================================== */

/**
 * 解析 MCP 响应体：可能是 JSON，也可能是 SSE（每行 `data: {...}`）。
 * @param {string} text
 * @param {string} contentType
 */
export function parseMcpBody(text, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (ct.includes('text/event-stream') || /^event:|^data:/m.test(trimmed)) {
    const payloads = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      const chunk = m[1].trim();
      if (!chunk || chunk === '[DONE]') continue;
      try {
        payloads.push(JSON.parse(chunk));
      } catch {
        /* 单个 SSE 块解析失败不影响其它块 */
      }
    }
    if (!payloads.length) return null;
    // 取最后一个带 result 或 error 的消息（通常是最终响应）
    return payloads.reverse().find((p) => p && (p.result !== undefined || p.error !== undefined)) || payloads[0];
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 构造 JSON-RPC 请求体 */
export function mcpRequest(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

/**
 * 无凭据（keyless）调用远端 MCP 的**唯一**允许对象：
 * 官方固定地址 https://mcp.firecrawl.dev（docs/23 明确的限额试用）。
 * 这条规则不放宽任意远端 MCP 免鉴权、也不放宽任意工具调用。
 */
export function keylessAllowed(conn) {
  try {
    const u = new URL(String(conn.base_url || ''));
    const host = u.hostname.toLowerCase();
    const domains = uj(conn.allowed_domains, []);
    return u.protocol === 'https:' && host === 'mcp.firecrawl.dev' && domains.length === 1 && domains[0] === 'mcp.firecrawl.dev';
  } catch {
    return false;
  }
}

/**
 * 一次 MCP HTTP 往返。
 * @returns {Promise<{ok:boolean, message?:object, sessionId:string|null, status:number,
 *                    error?:string, raw?:string}>}
 */
export async function mcpRpc(conn, { method, params, id = 1, sessionId = null, notification = false, timeoutMs = null, deadlineAt = null }) {
  const base = String(conn.base_url || '').replace(/\/+$/, '');
  const path = String(conn.endpoint_path || '/mcp');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const allowed = uj(conn.allowed_domains, []);
  const chk = checkOutboundUrl(url, allowed);
  if (!chk.ok) return { ok: false, status: 0, error: chk.reason, sessionId };
  const cred = resolveStoredCredential(conn);
  const hasCredConf = !!conn.credential_ref || !!conn.credential_cipher;
  if (hasCredConf && !cred.ok) {
    return { ok: false, status: 0, sessionId, error: `MCP 凭据不可用：${cred.reason}`, authorization_required: true };
  }
  if (!hasCredConf && !keylessAllowed(conn)) {
    return {
      ok: false, status: 0, sessionId,
      error:
        '未配置凭据的远端 MCP 默认拒绝调用：仅官方固定地址 https://mcp.firecrawl.dev 支持显式 keyless 限额试用；' +
        '其它远端 MCP 必须配置服务端凭据。',
      authorization_required: true,
    };
  }
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  };
  if (cred.ok && cred.secret) {
    if ((conn.auth_kind || 'bearer') === 'bearer') headers.authorization = `Bearer ${cred.secret}`;
    else if (conn.auth_kind === 'header') headers[conn.auth_header || 'x-api-key'] = cred.secret;
  }
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const body = mcpRequest(method, params, id);
  if (notification) delete body.id;

  // 共享 deadline：MCP 每次往返（含 initialize / tools/list / tools/call）都取
  // min(连接配置时限, 调用方时限, 批次剩余时间)，剩余不足则不发请求。
  const leftForMcp = deadlineLeftMs(deadlineAt);
  if (leftForMcp !== null && leftForMcp <= 200) {
    return { ok: false, status: 0, sessionId, error: '批次总时间上限已到：MCP 请求未发出（留待下一批）', reason: 'deadline_exceeded', deadline_exceeded: true };
  }
  const mcpTimeout = Math.max(250, Math.min(
    Number(conn.timeout_ms) || 30000,
    Number(timeoutMs) > 0 ? Number(timeoutMs) : Number.POSITIVE_INFINITY,
    leftForMcp === null ? Number.POSITIVE_INFINITY : leftForMcp - 50,
    120000
  ));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(mcpTimeout),
    });
    const newSession = res.headers.get('mcp-session-id') || sessionId;
    const text = await res.text();
    if (res.status === 202) return { ok: true, message: null, sessionId: newSession, status: 202, raw: text };
    if (!res.ok) {
      return { ok: false, status: res.status, sessionId: newSession, error: `HTTP ${res.status}：${text.slice(0, 300)}` };
    }
    const message = parseMcpBody(text, res.headers.get('content-type'));
    if (!message) return { ok: false, status: res.status, sessionId: newSession, error: `MCP 响应无法解析：${text.slice(0, 200)}` };
    if (message.error) {
      return {
        ok: false, status: res.status, sessionId: newSession, message,
        error: `MCP 错误 ${message.error.code}：${message.error.message || ''}`,
      };
    }
    return { ok: true, message, sessionId: newSession, status: res.status, raw: text };
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
    const deadlineHit = deadlineLeftMs(deadlineAt) !== null && deadlineLeftMs(deadlineAt) <= 60;
    return {
      ok: false, status: 0, sessionId,
      reason: deadlineHit ? 'deadline_exceeded' : undefined,
      deadline_exceeded: deadlineHit || undefined,
      error: deadlineHit
        ? '批次总时间上限已到：MCP 请求已中止（留待下一批）'
        : `${isTimeout ? 'MCP 请求超时' : 'MCP 请求失败'}：${e.message}${e.cause?.code ? `（${e.cause.code}）` : ''}`,
    };
  }
}

/** 距共享 deadline 的剩余毫秒；未传 deadline 返回 null（表示不受限） */
function deadlineLeftMs(deadlineAt) {
  const d = Number(deadlineAt);
  return Number.isFinite(d) && d > 0 ? d - Date.now() : null;
}

/** initialize 握手（返回会话与服务器信息） */
export async function mcpInitialize(conn, opts = {}) {
  const rpc = await mcpRpc(conn, {
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO },
    ...opts,
  });
  if (!rpc.ok) return rpc;
  // 规范要求初始化后发送 initialized 通知（失败不阻断）
  await mcpRpc(conn, { method: 'notifications/initialized', params: {}, notification: true, sessionId: rpc.sessionId, ...opts });
  return { ...rpc, serverInfo: rpc.message?.result?.serverInfo || null, protocolVersion: rpc.message?.result?.protocolVersion || null, capabilities: rpc.message?.result?.capabilities || null };
}

/** tools/list */
export async function mcpListTools(conn, sessionId = null, opts = {}) {
  const rpc = await mcpRpc(conn, { method: 'tools/list', params: {}, id: 2, sessionId, ...opts });
  if (!rpc.ok) return rpc;
  const tools = rpc.message?.result?.tools;
  if (!Array.isArray(tools)) return { ...rpc, ok: false, error: 'tools/list 未返回 tools 数组' };
  return {
    ...rpc,
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title || null,
      description: t.description ? String(t.description).slice(0, 400) : null,
      input_schema: t.inputSchema || t.input_schema || null,
      read_only_hint: t.annotations?.readOnlyHint ?? null,
      destructive_hint: t.annotations?.destructiveHint ?? null,
    })),
  };
}

/** tools/call（只读白名单校验） */
export async function mcpCallTool(conn, toolName, args, sessionId = null, opts = {}) {
  const allow = uj(conn.mcp_allowed_tools, []);
  if (!allow.length) {
    return { ok: false, error: '未配置允许调用的 MCP 只读工具白名单，已拒绝调用' };
  }
  if (!allow.includes(toolName)) {
    return { ok: false, error: `工具 ${toolName} 不在只读白名单内（白名单：${allow.join('、')}），已拒绝调用` };
  }
  const rpc = await mcpRpc(conn, { method: 'tools/call', params: { name: toolName, arguments: args }, id: 3, sessionId, ...opts });
  if (!rpc.ok) return rpc;
  const result = rpc.message?.result;
  if (!result) return { ...rpc, ok: false, error: 'tools/call 未返回 result' };
  if (result.isError) {
    return { ...rpc, ok: false, auth_like: isAuthorizationError(JSON.stringify(result.content || result)), error: `工具返回错误：${JSON.stringify(result.content || result).slice(0, 300)}` };
  }
  // 提取文本内容：content: [{type:'text', text:'...'}]
  const texts = Array.isArray(result.content)
    ? result.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text)
    : [];
  return { ...rpc, ok: true, tool_result: result, text: texts.join('\n') || null, structured: result.structuredContent || null };
}

/** 鉴权/额度类错误识别（用于「不反复无密钥重试」） */
export function isAuthorizationError(text) {
  return /unauthori[sz]ed|forbidden|api[\s_-]?key|keyless|anonymous|402|payment|quota|insufficient|401|403/i.test(String(text || ''));
}

/** 点号路径取值（本地实现，避免跨模块依赖） */
function pickDot(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), obj);
}

/**
 * 依据 tools/list 返回的 inputSchema 映射工具参数（url / formats）。
 * 供应商 schema 里 formats 可能是 array，也可能是 string，按 schema 类型对齐。
 */
export function buildMcpToolArgs(tool, url, opts = {}, paramMap = {}) {
  const props = tool?.input_schema?.properties || tool?.inputSchema?.properties || null;
  const args = { ...(paramMap.extra || {}) };
  const urlArg = paramMap.url_arg || (props && Object.prototype.hasOwnProperty.call(props, 'url') ? 'url' : 'url');
  args[urlArg] = url;
  const formatArg = paramMap.format_arg || (props && Object.prototype.hasOwnProperty.call(props, 'formats') ? 'formats' : null);
  if (formatArg) {
    const formats = opts.format ? [opts.format] : (paramMap.format_value || ['markdown']);
    const type = props?.[formatArg]?.type;
    args[formatArg] = type === 'string' ? (Array.isArray(formats) ? formats[0] : String(formats)) : formats;
  }
  return args;
}

/**
 * 解析 Firecrawl v2 MCP tools/call 的返回。
 * firecrawl_scrape 的 content[0].text 通常是 JSON 字符串：{markdown, metadata, links, success}。
 * 解析失败时按纯文本正文处理（不伪造字段）。
 */
export function parseMcpScrapeResult(conn, call) {
  const rm = uj(conn.response_map_json, {}) || {};
  let payload = call.structured || null;
  if (!payload && call.text) {
    try {
      payload = JSON.parse(call.text);
    } catch {
      payload = null;
    }
  }
  if (payload && typeof payload === 'object') {
    const content =
      pickDot(payload, rm.content_path || 'markdown') ??
      payload.markdown ?? payload.data?.markdown ?? null;
    const title =
      pickDot(payload, rm.title_path || 'metadata.title') ??
      payload.metadata?.title ?? payload.data?.metadata?.title ?? null;
    const metadata = payload.metadata || payload.data?.metadata || null;
    const links = Array.isArray(payload.links) ? payload.links
      : Array.isArray(payload.data?.links) ? payload.data.links : null;
    if (typeof content === 'string' && content.trim()) {
      return { content, title: typeof title === 'string' ? title : null, metadata, links, parsed_json: true };
    }
    if (payload.success === false && payload.error) {
      return { content: null, title: null, metadata: null, links: null, error: String(payload.error).slice(0, 300) };
    }
  }
  return { content: call.text || null, title: null, metadata: null, links: null, parsed_json: false };
}

/** 从已发现的工具清单/工具 schema 中取出目标工具定义 */
export function pickToolSchema(conn) {
  const name = String(conn.mcp_tool_name || '');
  const tools = uj(conn.tool_schemas_json, []) || [];
  if (name && Array.isArray(tools)) {
    const hit = tools.find((t) => t?.name === name);
    if (hit) return hit;
  }
  return null;
}


/* ==================================================================== */
/*  二、连接配置 CRUD                                                   */
/* ==================================================================== */

export function listFetchConnections() {
  ensureDeepSeekDefaults();
  return all('SELECT * FROM web_fetch_connection WHERE archived=0 ORDER BY is_fallback, fallback_priority, created_at').map((c) => {
    const cred = resolveCapabilityCredential(c);
    return {
      id: c.id,
      name: c.name,
      conn_kind: c.conn_kind,
      kind_label: FETCH_KINDS[c.conn_kind]?.label || c.conn_kind,
      base_url: c.base_url,
      endpoint_path: c.endpoint_path,
      http_method: c.http_method,
      auth_kind: c.auth_kind,
      auth_header: c.auth_header,
      provider_id: c.provider_id || null,
      provider_name: cred.provider?.name || null,
      provider_model: cred.provider?.model || null,
      credential_ref: validCredentialRef(c.credential_ref) ? c.credential_ref : null,
      credential_configured: cred.ok,
      credential_source: cred.ok ? cred.source : null,
      credential_hint: cred.ok ? null : cred.reason,
      credential_stored_encrypted: !!c.credential_cipher,
      credential_via: cred.via || null,
      mcp_tool_name: c.mcp_tool_name,
      mcp_allowed_tools: uj(c.mcp_allowed_tools, []),
      param_map: uj(c.param_map_json, {}),
      response_map: uj(c.response_map_json, {}),
      timeout_ms: c.timeout_ms,
      retry_max: c.retry_max,
      daily_quota: c.daily_quota,
      calls_today: c.calls_today_date === todayCst() ? Number(c.calls_today || 0) : 0,
      total_calls: Number(c.total_calls || 0),
      total_success: Number(c.total_success || 0),
      last_call_at: c.last_call_at,
      last_success_at: c.last_success_at,
      last_usage: uj(c.last_usage_json, null),
      enabled: !!c.enabled,
      is_fallback: !!c.is_fallback,
      fallback_priority: Number(c.fallback_priority ?? 100),
      allowed_domains: uj(c.allowed_domains, []),
      discovered_tools: uj(c.discovered_tools_json, []),
      tool_schemas: uj(c.tool_schemas_json, []),
      keyless_trial: !!FETCH_KINDS[c.conn_kind]?.keyless_trial,
      scrape_authorized: c.scrape_authorized === null || c.scrape_authorized === undefined ? null : !!c.scrape_authorized,
      last_test_at: c.last_test_at,
      last_test_result: c.last_test_result,
      last_test_message: redactCredentialText(c.last_test_message),
      note: c.note,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  });
}

export function upsertFetchConnection(user, payload = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可配置抓取连接', status: 403 };
  const existing = payload.id ? get('SELECT * FROM web_fetch_connection WHERE id=?', [payload.id]) : null;
  const isNew = !existing;
  const kind = payload.conn_kind ?? existing?.conn_kind ?? 'firecrawl_scrape';
  const preset = FETCH_KINDS[kind] || FETCH_KINDS.firecrawl_scrape;

  const fields = {
    name: payload.name ?? existing?.name ?? preset.label,
    conn_kind: kind,
    base_url: payload.base_url ?? existing?.base_url ?? preset.base_url ?? '',
    endpoint_path: payload.endpoint_path ?? existing?.endpoint_path ?? preset.endpoint_path,
    http_method: payload.http_method ?? existing?.http_method ?? preset.http_method,
    auth_kind: payload.auth_kind ?? existing?.auth_kind ?? preset.auth_kind,
    auth_header: payload.auth_header ?? existing?.auth_header ?? null,
    provider_id: payload.provider_id === undefined ? existing?.provider_id ?? null : (payload.provider_id || null),
    is_fallback: payload.is_fallback === undefined ? existing?.is_fallback ?? (preset.fallback ? 1 : 0) : (payload.is_fallback ? 1 : 0),
    fallback_priority: Number(payload.fallback_priority ?? existing?.fallback_priority ?? 100),
    credential_ref: payload.credential_ref === undefined ? existing?.credential_ref ?? preset.credential_ref : payload.credential_ref,
    mcp_tool_name: payload.mcp_tool_name === undefined
      ? existing?.mcp_tool_name ?? preset.mcp_tool_name ?? null
      : payload.mcp_tool_name,
    mcp_allowed_tools: payload.mcp_allowed_tools
      ? j(payload.mcp_allowed_tools)
      : existing?.mcp_allowed_tools
        ?? j(preset.mcp_allowed_tools?.length ? preset.mcp_allowed_tools
          : payload.mcp_tool_name ? [payload.mcp_tool_name] : []),
    param_map: payload.param_map ? j(payload.param_map) : existing?.param_map_json ?? j(preset.param_map),
    response_map: payload.response_map ? j(payload.response_map) : existing?.response_map_json ?? j(preset.response_map),
    timeout_ms: Number(payload.timeout_ms ?? existing?.timeout_ms ?? 30000),
    retry_max: Number(payload.retry_max ?? existing?.retry_max ?? 2),
    daily_quota: Number(payload.daily_quota ?? existing?.daily_quota ?? 500),
    enabled: payload.enabled === undefined ? existing?.enabled ?? 0 : payload.enabled ? 1 : 0,
    allowed_domains: payload.allowed_domains ? j(payload.allowed_domains) : existing?.allowed_domains ?? j(preset.allowed_domains || []),
    note: payload.note ?? existing?.note ?? null,
  };
  if (kind === 'deepseek_fetch') {
    if (!fields.provider_id) return { error: 'DeepSeek Fetch 必须引用现有官方模型配置（provider_id），不要单独填写 Key', status: 400 };
    const p = get('SELECT * FROM llm_provider WHERE id=?', [fields.provider_id]);
    const providerError = officialProviderError(p);
    if (providerError) return { error: providerError, status: 400 };
    fields.base_url = DEEPSEEK_OFFICIAL_ORIGIN;
    fields.endpoint_path = DEEPSEEK_PATHS.fetch;
    fields.http_method = 'POST';
    fields.auth_kind = 'bearer';
    fields.auth_header = null;
    fields.credential_ref = null;
    fields.allowed_domains = j(['api.deepseek.com']);
    fields.mcp_tool_name = null;
    fields.mcp_allowed_tools = j([]);
  }
  if (fields.provider_id) {
    if (fields.conn_kind !== 'deepseek_fetch') {
      return { error: '引用模型凭据只允许用于 DeepSeek Fetch 官方连接；其它抓取连接请使用自己的凭据引用', status: 400 };
    }
    const p = get('SELECT * FROM llm_provider WHERE id=?', [fields.provider_id]);
    const providerError = officialProviderError(p);
    if (providerError) return { error: providerError, status: 400 };
  }
  if (!fields.name) return { error: '缺少配置名称', status: 400 };
  if (!validCredentialRef(fields.credential_ref)) return { error: CREDENTIAL_REF_HINT, status: 400 };
  if (!/^https?:\/\//i.test(String(fields.base_url))) return { error: '服务地址必须以 http(s):// 开头', status: 400 };
  const domains = uj(fields.allowed_domains, []);
  if (!domains.length) return { error: '必须配置出站域名白名单', status: 400 };
  const chk = checkOutboundUrl(fields.base_url, domains);
  if (!chk.ok) return { error: chk.reason, status: 400 };
  if (isMcpKind(kind) && !fields.mcp_tool_name) {
    return { error: 'MCP 连接必须指定要调用的只读抓取工具名（可先「连接测试」拉取工具清单）', status: 400 };
  }
  if (isMcpKind(kind)) {
    const allow = uj(fields.mcp_allowed_tools, []);
    if (!allow.length) return { error: 'MCP 连接必须配置只读工具白名单（不允许调用白名单外的工具）', status: 400 };
    if (!allow.includes(fields.mcp_tool_name)) {
      return { error: `抓取工具「${fields.mcp_tool_name}」必须包含在只读白名单内：${allow.join('、')}`, status: 400 };
    }
  }
  if (fields.timeout_ms < 1000 || fields.timeout_ms > 120000) return { error: '超时须在 1000—120000 ms', status: 400 };
  if (fields.retry_max < 0 || fields.retry_max > 5) return { error: '重试次数须在 0—5', status: 400 };
  if (fields.daily_quota < 1) return { error: '调用限额须大于 0', status: 400 };
  if (!Number.isFinite(fields.fallback_priority) || fields.fallback_priority < 0 || fields.fallback_priority > 1000) {
    return { error: '备用顺序须在 0—1000', status: 400 };
  }
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
        message: '可在「后台管理 → 模型与连接」初始化本机主密钥，或设置 CCER_SECRET_KEY，或只用环境变量凭据引用名。',
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
    const id = payload.id ? String(payload.id) : newId('WFC');
    const clash = get('SELECT id FROM web_fetch_connection WHERE id=?', [id]);
    if (clash) return { error: `抓取连接 ID 已存在：${id}`, status: 409 };
    run(
      `INSERT INTO web_fetch_connection (id,name,conn_kind,base_url,endpoint_path,http_method,auth_kind,auth_header,
        credential_ref,credential_cipher,mcp_tool_name,mcp_list_tool,mcp_allowed_tools,param_map_json,response_map_json,
        timeout_ms,retry_max,daily_quota,calls_today,calls_today_date,enabled,allowed_domains,discovered_tools_json,
        provider_id,is_fallback,fallback_priority,last_test_at,last_test_result,last_test_message,last_error,
        created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,NULL,?,?,?,NULL,NULL,NULL,NULL,?,?,?)`,
      [
        id, fields.name, fields.conn_kind, fields.base_url, fields.endpoint_path, fields.http_method,
        fields.auth_kind, fields.auth_header, fields.credential_ref, cipher, fields.mcp_tool_name,
        'tools/list', fields.mcp_allowed_tools, fields.param_map, fields.response_map, fields.timeout_ms,
        fields.retry_max, fields.daily_quota, fields.enabled, fields.allowed_domains,
        fields.provider_id, fields.is_fallback, fields.fallback_priority,
        user?.name || 'unknown', now, now,
      ]
    );
    audit({ actor: user?.name, actorRole: user?.role, action: 'web_fetch.create', objectType: 'web_fetch_connection', objectId: id, detail: { name: fields.name, kind: fields.conn_kind } });
    return { ok: true, id, action: 'inserted', credential: secretNote };
  }
  run(
    `UPDATE web_fetch_connection SET name=?,conn_kind=?,base_url=?,endpoint_path=?,http_method=?,auth_kind=?,
       auth_header=?,credential_ref=?,credential_cipher=?,mcp_tool_name=?,mcp_allowed_tools=?,param_map_json=?,
       response_map_json=?,timeout_ms=?,retry_max=?,daily_quota=?,enabled=?,allowed_domains=?,provider_id=?,
       is_fallback=?,fallback_priority=?,note=?,updated_at=?
     WHERE id=?`,
    [
      fields.name, fields.conn_kind, fields.base_url, fields.endpoint_path, fields.http_method, fields.auth_kind,
      fields.auth_header, fields.credential_ref, cipher, fields.mcp_tool_name, fields.mcp_allowed_tools,
      fields.param_map, fields.response_map, fields.timeout_ms, fields.retry_max, fields.daily_quota,
      fields.enabled, fields.allowed_domains, fields.provider_id, fields.is_fallback, fields.fallback_priority,
      fields.note, now, existing.id,
    ]
  );
  audit({ actor: user?.name, actorRole: user?.role, action: 'web_fetch.update', objectType: 'web_fetch_connection', objectId: existing.id, detail: { enabled: fields.enabled } });
  return { ok: true, id: existing.id, action: 'updated', credential: secretNote };
}

export function pauseFetchConnection(user, id, { enabled = false } = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可启停抓取连接', status: 403 };
  const c = get('SELECT * FROM web_fetch_connection WHERE id=?', [id]);
  if (!c) return { error: '抓取连接不存在', status: 404 };
  run('UPDATE web_fetch_connection SET enabled=?, updated_at=? WHERE id=?', [enabled ? 1 : 0, nowIso(), id]);
  audit({ actor: user?.name, actorRole: user?.role, action: 'web_fetch.toggle', objectType: 'web_fetch_connection', objectId: id, detail: { enabled } });
  return { ok: true, id, enabled: !!enabled };
}

/* ==================================================================== */
/*  三、抓取执行                                                        */
/* ==================================================================== */

/** Firecrawl Scrape 请求构造 */
export function buildScrapeRequest(conn, url, opts = {}) {
  const pm = uj(conn.param_map_json, {}) || {};
  const rm = uj(conn.response_map_json, {}) || {};
  const base = String(conn.base_url || '').replace(/\/+$/, '');
  const path = String(conn.endpoint_path || '/v1/scrape');
  const body = { ...(pm.extra || {}) };
  body[pm.url_arg || 'url'] = url;
  if (pm.format_arg && pm.format_value) body[pm.format_arg] = opts.format ? [opts.format] : pm.format_value;
  if (pm.timeout_arg) {
    // 供应商 timeout 参数同样取「配置时限」与「调用方/批次剩余时间」的较小值
    const caller = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : Number.POSITIVE_INFINITY;
    body[pm.timeout_arg] = Math.max(250, Math.min(Number(conn.timeout_ms) || 30000, caller, 60000));
  }
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const cred = resolveStoredCredential(conn);
  if (cred.ok && cred.secret) {
    if ((conn.auth_kind || 'bearer') === 'bearer') headers.authorization = `Bearer ${cred.secret}`;
    else if (conn.auth_kind === 'header') headers[conn.auth_header || 'x-api-key'] = cred.secret;
  }
  return {
    url: `${base}${path.startsWith('/') ? path : `/${path}`}`,
    method: String(conn.http_method || 'POST').toUpperCase(),
    headers,
    body,
    response_map: rm,
    credential: cred,
  };
}

/** 从 Firecrawl 抓取响应抽取正文 */
export function extractScrapeContent(conn, payload) {
  const rm = uj(conn.response_map_json, {}) || {};
  const contentPath = rm.content_path || 'data.markdown';
  const titlePath = rm.title_path || 'data.metadata.title';
  const content = contentPath
    .split('.')
    .reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), payload);
  const title = titlePath
    .split('.')
    .reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), payload);
  return {
    content: typeof content === 'string' ? content : null,
    title: typeof title === 'string' ? title : null,
    metadata: payload?.data?.metadata || null,
    success: payload?.success !== false,
  };
}

/**
 * 直连 HTTP 抓取：由本服务自行 GET 目标页面，并用**确定性规则**抽取正文文本。
 * 不用大模型改写内容；不做 JS 渲染（动态页面取不到正文时如实返回 empty_content）。
 * @returns {Promise<{ok:boolean, content?:string, title?:string, reason?:string, message?:string}>}
 */
export async function directHttpGet(url, { timeoutMs = 30000, allowedDomains = null, userAgent = null, deadlineAt = null } = {}) {
  const chk = checkOutboundUrl(url, allowedDomains && allowedDomains.length ? allowedDomains : undefined);
  if (!chk.ok) return { ok: false, reason: 'blocked_url', message: chk.reason };
  const leftDirect = deadlineLeftMs(deadlineAt);
  if (leftDirect !== null && leftDirect <= 200) {
    return { ok: false, reason: 'deadline_exceeded', message: '批次总时间上限已到：直连抓取未发出请求（留待下一批）', deadline_exceeded: true };
  }
  const directTimeout = Math.max(250, Math.min(Number(timeoutMs) || 30000, leftDirect === null ? Number.POSITIVE_INFINITY : leftDirect - 50));
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': userAgent || 'Mozilla/5.0 (compatible; CCER-public-info/2.1; +research use)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(directTimeout),
    });
    if (!res.ok) {
      return { ok: false, reason: 'http_error', message: `HTTP ${res.status}`, http_status: res.status };
    }
    const ctype = String(res.headers.get('content-type') || '');
    const buf = Buffer.from(await res.arrayBuffer());
    const charset = (ctype.match(/charset=([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
    let text;
    try {
      text = new TextDecoder(charset === 'gb2312' || charset === 'gbk' ? 'gbk' : charset).decode(buf);
    } catch {
      text = buf.toString('utf8');
    }
    if (/application\/pdf/i.test(ctype)) {
      // PDF 不做解析：如实标注为需要专门解析器，避免把二进制当正文
      return { ok: false, reason: 'pdf_not_supported', message: '目标为 PDF，需专门解析器；本次未归档正文', http_status: res.status };
    }
    const extracted = extractHtmlText(text);
    return {
      ok: !!extracted.content,
      content: extracted.content,
      title: extracted.title,
      raw_html: text,
      // 采集器返回的可获得性优先于下游的长度猜测（docs/22 第 8 条）
      availability: extracted.content ? (extracted.content.length >= 1200 ? 'full_text' : 'partial') : undefined,
      http_status: res.status,
      reason: extracted.content ? null : 'empty_content',
      message: extracted.content ? null : '页面未抽取到正文文本（可能是动态渲染或纯脚本页面）',
      bytes: buf.length,
      content_type: ctype,
    };
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
    const deadlineHit = deadlineLeftMs(deadlineAt) !== null && deadlineLeftMs(deadlineAt) <= 60;
    return {
      ok: false,
      reason: deadlineHit ? 'deadline_exceeded' : isTimeout ? 'timeout' : 'network',
      deadline_exceeded: deadlineHit || undefined,
      message: deadlineHit
        ? '批次总时间上限已到：直连抓取已中止（留待下一批）'
        : `${e.message}${e.cause?.code ? `（${e.cause.code}）` : ''}`,
    };
  }
}

/**
 * 从 HTML 抽取正文文本（确定性规则，不改写语义）：
 * 去掉脚本/样式/导航/页脚等非正文块，保留标题与可读文本段落。
 */
export function extractHtmlText(html) {
  const src = String(html || '');
  if (!src) return { title: null, content: null };
  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  // 大学CMS把正文放在form内；先定位已知正文容器，再移除表单导航。
  // 不用非贪婪div正则截断嵌套段落，按div深度找完整闭合位置。
  const start = /<div\b[^>]*class\s*=\s*["'][^"']*\bv_news_content\b[^"']*["'][^>]*>/i.exec(src);
  let article = null;
  if (start) {
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = start.index + start[0].length;
    let depth = 1, token;
    while ((token = tags.exec(src))) {
      depth += /^<\//.test(token[0]) ? -1 : 1;
      if (depth === 0) { article = src.slice(start.index + start[0].length, token.index); break; }
    }
  }
  const stripped = (article || src)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const content = decodeEntities(stripped)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, content: content || null };
}

/** 常见 HTML 实体解码（够用即可，避免引入依赖） */
function decodeEntities(s) {
  const named = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, (m) => named[m.toLowerCase()] ?? m);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 抓取一个 URL 的正文。
 * @returns {Promise<{ok:boolean, url:string, title?:string, content?:string, chars?:number,
 *                    content_hash?:string, reason?:string, message?:string, latency_ms:number}>}
 */
export async function fetchUrlContent(conn, url, opts = {}) {
  const started = Date.now();
  const outChk = checkOutboundUrl(url, uj(conn.allowed_domains, []));
  // 抓取目标站点与「服务端点」白名单是两件事：服务端点必须在白名单，
  // 目标站点由网页抓取服务代取，因此这里只校验协议与私网，不强制同白名单。
  if (!/^https?:\/\//i.test(String(url))) {
    return { ok: false, url, reason: 'bad_url', message: '目标 URL 必须是 http(s)', latency_ms: 0 };
  }
  if (outChk.reason && /内网|本机|IP 地址/.test(outChk.reason)) {
    return { ok: false, url, reason: 'blocked_url', message: outChk.reason, latency_ms: 0 };
  }
  if (!conn?.enabled) return { ok: false, url, reason: 'disabled', message: '抓取连接未启用', latency_ms: 0 };
  // DeepSeek Fetch 是官方固定端点 + 引用模型凭据；目标 URL 校验、预算与去重统计都在该分支内。
  if (conn.conn_kind === 'deepseek_fetch') {
    return runDeepSeekFetch(conn, url, opts);
  }
  const today = todayCst();
  const used = conn.calls_today_date === today ? Number(conn.calls_today || 0) : 0;
  if (used >= Number(conn.daily_quota || 0)) {
    return { ok: false, url, reason: 'quota_exceeded', message: `今日抓取已达限额 ${conn.daily_quota}`, latency_ms: 0 };
  }
  const cred = resolveStoredCredential(conn);
  // 无需鉴权的连接（如直连 HTTP 抓取）不要求凭据；
  // 官方 Firecrawl 固定地址允许显式 keyless 限额试用（可能被官方拒绝，如实记录，不反复重试）。
  const noAuthNeeded = (conn.auth_kind || 'none') === 'none' && !conn.credential_ref && !conn.credential_cipher;
  const keylessTrial = !cred.ok && isMcpKind(conn.conn_kind) && keylessAllowed(conn);
  if (!cred.ok && !noAuthNeeded && !keylessTrial) {
    return { ok: false, url, reason: 'no_credential', message: cred.reason, latency_ms: 0 };
  }

  const retryMax = Math.max(0, Math.min(Number(conn.retry_max ?? 2), 5));
  let attempt = 0;
  let last = { ok: false, reason: 'unknown', message: '未执行' };
  // 共享 deadline / 调用方时限：以前这里忽略了 opts.timeoutMs，三个分支都只用 conn 原值，
  // 于是 CEA 批次传下来的剩余时间在网络层失效。现统一取三者最小值并逐次重算剩余时间。
  const deadlineAt = Number.isFinite(Number(opts.deadlineAt)) ? Number(opts.deadlineAt) : null;
  const callerTimeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : null;
  const fetchLeft = () => (deadlineAt ? deadlineAt - Date.now() : null);
  const deadlineMsg = '批次总时间上限已到：网页抓取已中止（留待下一批）';
  const currentTimeout = () => Math.max(250, Math.min(
    Number(conn.timeout_ms) || 30000,
    callerTimeoutMs ?? Number.POSITIVE_INFINITY,
    fetchLeft() === null ? Number.POSITIVE_INFINITY : fetchLeft() - 50,
    120000
  ));
  const retryWaitMs = (ms) => {
    const left = fetchLeft();
    return left === null ? ms : Math.max(0, Math.min(ms, left - 100));
  };
  while (attempt <= retryMax) {
    attempt += 1;
    const left = fetchLeft();
    if (left !== null && left <= 200) {
      last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true };
      break;
    }
    const effectiveTimeoutMs = currentTimeout();
    try {
      if (conn.conn_kind === 'direct_http') {
        const r = await directHttpGet(url, {
          timeoutMs: effectiveTimeoutMs,
          allowedDomains: uj(conn.allowed_domains, []),
          deadlineAt,
        });
        if (!r.ok) {
          last = { ok: false, reason: r.reason, message: r.message, deadline_exceeded: r.deadline_exceeded };
          if (r.reason === 'deadline_exceeded') break;
          // 网络类问题可重试；4xx/内容为空不重试
          if (!['timeout', 'network'].includes(r.reason) || attempt > retryMax) break;
          const w = retryWaitMs(700 * attempt);
          if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
          await sleep(w);
          continue;
        }
        last = {
          ok: true, content: r.content, title: r.title,
          metadata: { contentType: r.content_type, bytes: r.bytes },
          raw_html: r.raw_html || null, availability: r.availability || null,
        };
        break;
      }

      if (isMcpKind(conn.conn_kind)) {
        const init = await mcpInitialize(conn, { timeoutMs: effectiveTimeoutMs, deadlineAt });
        if (!init.ok) {
          last = { ok: false, reason: init.reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'mcp_init_failed', message: init.error, deadline_exceeded: init.deadline_exceeded };
          if (init.reason === 'deadline_exceeded' || attempt > retryMax) break;
          const w = retryWaitMs(500 * attempt);
          if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
          await sleep(w);
          continue;
        }
        const pm = uj(conn.param_map_json, {}) || {};
        const toolSchema = pickToolSchema(conn);
        const args = buildMcpToolArgs(toolSchema, url, opts, pm);
        const call = await mcpCallTool(conn, conn.mcp_tool_name, args, init.sessionId, { timeoutMs: effectiveTimeoutMs, deadlineAt });
        if (!call.ok) {
          const authLike = call.auth_like || isAuthorizationError(call.error);
          const dl = call.reason === 'deadline_exceeded';
          last = {
            ok: false,
            reason: dl ? 'deadline_exceeded' : authLike ? 'mcp_unauthorized' : 'mcp_call_failed',
            message: call.error,
            authorization_required: authLike,
            deadline_exceeded: dl || undefined,
          };
          // 鉴权/无密钥试用被拒：重试无意义，也会造成无意义的重复请求
          if (authLike || dl || attempt > retryMax) break;
          const w = retryWaitMs(500 * attempt);
          if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
          await sleep(w);
          continue;
        }
        const parsed = parseMcpScrapeResult(conn, call);
        if (!parsed.content) {
          last = { ok: false, reason: 'empty_content', message: parsed.error || 'MCP 工具未返回文本内容' };
          break;
        }
        last = {
          ok: true,
          content: parsed.content,
          title: parsed.title || (typeof parsed.metadata?.title === 'string' ? parsed.metadata.title : null),
          metadata: parsed.metadata,
          links: parsed.links,
          availability: 'full_text',
          published_hint: parsed.metadata?.publishedTime || parsed.metadata?.published_time || null,
        };
        break;
      }

      // Firecrawl Scrape
      const req = buildScrapeRequest(conn, url, { ...opts, timeoutMs: effectiveTimeoutMs });
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        last = {
          ok: false, reason: 'auth_error', authorization_required: true,
          message: `鉴权失败 HTTP ${res.status}（请配置 FIRECRAWL_API_KEY，重试无意义）：${text.slice(0, 200)}`,
        };
        break;
      }
      if (!res.ok) {
        last = { ok: false, reason: 'http_error', message: `HTTP ${res.status}：${text.slice(0, 300)}` };
        if (res.status < 500 || attempt > retryMax) break;
        const w = retryWaitMs(600 * attempt);
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
      const ex = extractScrapeContent(conn, payload);
      last = ex.content
        ? {
            ok: true, content: ex.content, title: ex.title, metadata: ex.metadata, reason: null, message: null,
            availability: 'full_text', // Firecrawl 返回整页 markdown，不再用字符数猜
            published_hint: ex.metadata?.publishedTime || ex.metadata?.published_time || null,
          }
        : { ok: false, reason: 'empty_content', message: `抓取成功但未返回正文（success=${ex.success}）` };
      break;
    } catch (e) {
      const isTimeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
      const deadlineHit = fetchLeft() !== null && fetchLeft() <= 60;
      last = {
        ok: false,
        reason: deadlineHit ? 'deadline_exceeded' : isTimeout ? 'timeout' : 'network',
        deadline_exceeded: deadlineHit || undefined,
        message: deadlineHit ? deadlineMsg : `${e.message}${e.cause?.code ? `（${e.cause.code}）` : ''}`,
      };
      if (attempt > retryMax) break;
      if (deadlineHit) break;
      const w = retryWaitMs(600 * attempt);
      if (w <= 0) { last = { ok: false, reason: 'deadline_exceeded', message: deadlineMsg, deadline_exceeded: true }; break; }
      await sleep(w);
    }
  }

  try {
    run('UPDATE web_fetch_connection SET calls_today=?, calls_today_date=?, last_error=?, updated_at=? WHERE id=?', [
      used + attempt, today, last.ok ? null : `${last.reason}: ${last.message || ''}`.slice(0, 500), nowIso(), conn.id,
    ]);
  } catch {
    /* 计数失败不影响结果 */
  }
  const content = last.content || null;
  return {
    ok: !!last.ok,
    url,
    title: last.title || null,
    content,
    raw_html: last.raw_html || null,
    links: last.links || null,
    availability: last.availability || null,
    published_hint: last.published_hint || null,
    chars: content ? content.length : 0,
    content_hash: content ? sha256(Buffer.from(content, 'utf8')) : null,
    metadata: last.metadata || null,
    reason: last.reason || null,
    message: last.message || null,
    authorization_required: !!last.authorization_required,
    deadline_exceeded: !!last.deadline_exceeded,
    attempts: attempt,
    latency_ms: Date.now() - started,
    provider_id: conn.id,
    provider_name: conn.name,
    conn_kind: conn.conn_kind,
  };
}

export function pickFetchConnection(id = null) {
  ensureDeepSeekDefaults();
  if (id) return get('SELECT * FROM web_fetch_connection WHERE id=?', [id]);
  return get(
    `SELECT * FROM web_fetch_connection WHERE enabled=1 AND archived=0
     ORDER BY is_fallback, fallback_priority,
       CASE WHEN scrape_authorized=1 AND last_test_result='ok' THEN 0 ELSE 1 END, created_at
     LIMIT 1`
  );
}

/** 主连接 → 备用连接；调用方负责整体尝试次数/请求数/总时长上限。 */
export function pickFetchCandidates(id = null) {
  ensureDeepSeekDefaults();
  if (id) {
    const one = get('SELECT * FROM web_fetch_connection WHERE id=?', [id]);
    return one ? [one] : [];
  }
  return all(
    `SELECT * FROM web_fetch_connection WHERE enabled=1 AND archived=0
     ORDER BY is_fallback, fallback_priority,
       CASE WHEN scrape_authorized=1 AND last_test_result='ok' THEN 0 ELSE 1 END, created_at`
  );
}

/**
 * 连接测试：
 *   - MCP：真实执行 initialize + tools/list，确认所选工具存在并把 inputSchema 一起写回；
 *          **连接/工具可用** 与 **抓取授权与实际调用** 分开报告：
 *            · 无凭据的官方 keyless 试用：只做握手与工具发现，不反复请求抓取（官方可能拒绝）；
 *            · 有凭据：额外做一次最小真实抓取，报告 scrape_authorized / scrape_ok。
 *         管理员也可显式传 { probe_scrape: true } 主动尝试一次 keyless 抓取，
 *         失败则如实记录「需要 API Key」，不伪造成功。
 *   - Firecrawl Scrape API / 直连 HTTP：真实抓取一个公开页面，校验返回结构。
 * 区分 configured / callable 两个状态。
 */
export async function testFetchConnection(user, id, opts = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可测试抓取连接', status: 403 };
  const c = get('SELECT * FROM web_fetch_connection WHERE id=?', [id]);
  if (!c) return { error: '抓取连接不存在', status: 404 };
  const cred = resolveCapabilityCredential(c);
  const noAuthNeeded = (c.auth_kind || 'none') === 'none' && !c.credential_ref && !c.credential_cipher;
  const domains = uj(c.allowed_domains, []);
  const chk = domains.length ? checkOutboundUrl(c.base_url, domains) : { ok: false, reason: '未配置出站域名白名单' };
  const configured = (cred.ok || noAuthNeeded) && chk.ok;
  const out = {
    ok: false,
    configured,
    callable: false,
    connection_ok: false,
    tools_ok: false,
    scrape_authorized: null,
    scrape_call_performed: false,
    real_call_performed: false,
    keyless_trial: !!FETCH_KINDS[c.conn_kind]?.keyless_trial,
    connection: {
      id: c.id, name: c.name, kind: c.conn_kind, base_url: c.base_url,
      endpoint: c.conn_kind === 'deepseek_fetch'
        ? `${DEEPSEEK_OFFICIAL_ORIGIN}${DEEPSEEK_PATHS.fetch}`
        : `${c.base_url}${c.endpoint_path || ''}`,
      provider_id: c.provider_id || null,
    },
    credential_source: cred.ok ? cred.source : noAuthNeeded ? '无需凭据' : null,
    credential_via: cred.via || null,
    message: '',
  };
  if (!configured) {
    out.message = [cred.ok || noAuthNeeded ? null : cred.reason, chk.ok ? null : chk.reason].filter(Boolean).join('；');
    run('UPDATE web_fetch_connection SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
      nowIso(), 'configured_only', out.message, nowIso(), id,
    ]);
    return out;
  }

  out.real_call_performed = true;
  if (isMcpKind(c.conn_kind)) {
    const init = await mcpInitialize(c);
    if (!init.ok) {
      out.message = `MCP initialize 失败：${init.error}`;
      run('UPDATE web_fetch_connection SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
        nowIso(), 'failed', out.message.slice(0, 800), nowIso(), id,
      ]);
      return out;
    }
    const list = await mcpListTools(c, init.sessionId);
    if (!list.ok) {
      out.message = `MCP tools/list 失败：${list.error}`;
      run('UPDATE web_fetch_connection SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
        nowIso(), 'failed', out.message.slice(0, 800), nowIso(), id,
      ]);
      return out;
    }
    out.server = init.serverInfo;
    out.protocol_version = init.protocolVersion;
    out.tools = list.tools;
    out.tool_schemas = list.tools.map((t) => ({ name: t.name, input_schema: t.input_schema }));
    out.read_only_tools = list.tools.filter((t) => t.read_only_hint !== false).map((t) => t.name);
    out.connection_ok = true;
    const selected = String(c.mcp_tool_name || '');
    const found = selected ? list.tools.find((t) => t.name === selected) : null;
    out.tools_ok = !!found;
    run(
      `UPDATE web_fetch_connection SET last_test_at=?, last_test_result=?, last_test_message=?,
         discovered_tools_json=?, tool_schemas_json=?, updated_at=? WHERE id=?`,
      [
        nowIso(), found ? 'ok' : 'failed',
        (found
          ? `MCP 握手成功：协议 ${init.protocolVersion || '未声明'}，服务器 ${init.serverInfo?.name || '未声明'}，发现 ${list.tools.length} 个工具；已确认只读工具 ${selected} 存在。`
          : `MCP 握手成功（${list.tools.length} 个工具），但未找到配置的工具「${selected || '（空）'}」。`).slice(0, 800),
        j(list.tools.map((t) => ({ name: t.name, title: t.title, read_only_hint: t.read_only_hint }))),
        j(list.tools.map((t) => ({ name: t.name, input_schema: t.input_schema }))),
        nowIso(), id,
      ]
    );
    if (!found) {
      out.message = `MCP 连接与工具发现成功，但白名单工具「${selected || '（空）'}」不在返回的工具清单中，未执行抓取。`;
      return out;
    }
    // 抓取授权与真实调用：有凭据或管理员显式要求时才真正发起一次抓取
    const probeScrape = opts.probe_scrape === true || cred.ok;
    if (!probeScrape) {
      out.callable = true;
      out.ok = true;
      out.message =
        `MCP 连接及工具可用：协议 ${init.protocolVersion || '未声明'}，发现 ${list.tools.length} 个工具，` +
        `已确认 ${selected} 存在于工具清单。**未执行抓取**：该地址为官方 keyless 限额试用，` +
        '抓取授权需配置 FIRECRAWL_API_KEY；测试结果不代表抓取已成功。';
      audit({ actor: user.name, actorRole: user.role, action: 'web_fetch.test', objectType: 'web_fetch_connection', objectId: id, detail: { kind: 'mcp', tools: list.tools.length, scrape_probe: false } });
      return out;
    }
    const target = process.env.CCER_FETCH_TEST_URL || 'https://www.mee.gov.cn/';
    const res = await fetchUrlContent({ ...c, enabled: 1, retry_max: 0 }, target, {});
    out.scrape_call_performed = true;
    out.scrape_authorized = !!res.ok;
    out.callable = !!res.ok;
    out.ok = !!res.ok;
    out.sample = res.ok
      ? { url: res.url, title: res.title, chars: res.chars, content_hash: res.content_hash, preview: String(res.content || '').slice(0, 300) }
      : null;
    out.reason = res.reason || null;
    out.message = res.ok
      ? `MCP 连接、工具与抓取均成功：${target} → ${res.chars} 字符（${res.latency_ms} ms）。`
      : `MCP 连接与工具发现成功，但抓取未获授权/失败（${res.reason}）：${res.message || ''}`;
    run('UPDATE web_fetch_connection SET last_test_at=?, last_test_result=?, last_test_message=?, scrape_authorized=?, updated_at=? WHERE id=?', [
      nowIso(), res.ok ? 'ok' : 'tools_ok_scrape_failed', out.message.slice(0, 800), res.ok ? 1 : 0, nowIso(), id,
    ]);
    audit({
      actor: user.name, actorRole: user.role, action: 'web_fetch.test', objectType: 'web_fetch_connection', objectId: id,
      detail: { kind: 'mcp', target, tools: list.tools.length, scrape_ok: res.ok, reason: res.reason || null },
      result: res.ok ? 'ok' : 'failed',
    });
    return out;
  }

  const target = process.env.CCER_FETCH_TEST_URL || 'https://www.mee.gov.cn/';
  const res = await fetchUrlContent({ ...c, enabled: 1, retry_max: 0 }, target, {});
  out.callable = !!res.ok;
  out.ok = !!res.ok;
  out.sample = res.ok
    ? { url: res.url, title: res.title, chars: res.chars, content_hash: res.content_hash, preview: String(res.content || '').slice(0, 300) }
    : null;
  out.latency_ms = res.latency_ms;
  out.reason = res.reason || null;
  out.message = res.ok
    ? `真实抓取成功：${target} → ${res.chars} 字符（${res.latency_ms} ms）。`
    : `已配置但不可调用（${res.reason}）：${res.message || ''}`;
  run('UPDATE web_fetch_connection SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
    nowIso(), res.ok ? 'ok' : 'failed', out.message.slice(0, 800), nowIso(), id,
  ]);
  audit({
    actor: user.name, actorRole: user.role, action: 'web_fetch.test', objectType: 'web_fetch_connection', objectId: id,
    detail: { kind: c.conn_kind, target, ok: res.ok, chars: res.chars || 0 }, result: res.ok ? 'ok' : 'failed',
  });
  return out;
}

export function fetchStatus() {
  ensureDeepSeekDefaults();
  const rows = all('SELECT * FROM web_fetch_connection');
  const usable = rows.filter((c) => {
    if (!c.enabled) return false;
    const cred = resolveCapabilityCredential(c);
    return cred.ok || ((c.auth_kind || 'none') === 'none' && !c.credential_ref && !c.credential_cipher);
  });
  return {
    connections: rows.length,
    enabled: rows.filter((c) => c.enabled).length,
    callable: usable.length,
    available: usable.length > 0,
    primary_count: rows.filter((c) => c.enabled && !c.is_fallback).length,
    fallback_count: rows.filter((c) => c.enabled && c.is_fallback).length,
    detail: rows.map((c) => ({
      id: c.id, name: c.name, kind: c.conn_kind, enabled: !!c.enabled,
      credential_configured: resolveCapabilityCredential(c).ok,
      requires_credential: !((c.auth_kind || 'none') === 'none' && !c.credential_ref && !c.credential_cipher),
      provider_id: c.provider_id || null,
      is_fallback: !!c.is_fallback,
      calls_today: c.calls_today_date === todayCst() ? Number(c.calls_today || 0) : 0,
      total_calls: Number(c.total_calls || 0),
      total_success: Number(c.total_success || 0),
      last_call_at: c.last_call_at, last_success_at: c.last_success_at,
      last_test_result: c.last_test_result, last_test_at: c.last_test_at,
      tool: c.mcp_tool_name || null,
    })),
    note: usable.length
      ? `网页抓取连接可用于归档公开全文（主连接 ${rows.filter((c) => c.enabled && !c.is_fallback).length} 个，备用 ${rows.filter((c) => c.enabled && c.is_fallback).length} 个）。`
      : '未配置可用的网页抓取连接：只能归档搜索摘要与元数据，不会假装已读全文。',
  };
}
