/**
 * 后台管理服务（六模块之「后台管理」）
 * ============================================================================
 * 需求规格 1.6 / 第 4 节：
 *   - 数据源配置：登记官方网页 / 文件下载地址 / 授权 API / 人工上传源；配置字段映射、
 *     抓取周期、限流、超时、重试、许可说明、数据责任人、运行状态；提供连接测试、
 *     最近成功时间、错误日志、暂停与回滚；自动采集不得直接修改正式规则或历史报告。
 *   - 模型配置：Base URL、模型名、凭据、超时、调用量、用途开关（政策摘要 / 方法学结构抽取 /
 *     项目字段抽取 / 问答与报告草稿）；凭据只存服务端，不返给浏览器；
 *     LLM 输出必须附来源片段与页码并经人工确认；数字计算始终由确定性程序执行。
 *   - 用户和权限：五类角色、团队/项目授权、账号启停、重置、登录记录、操作审计、导出审计；
 *     管理员角色与数据审核角色分离。
 *   - 规则与系统配置：方法学版本发布审批、因子版本、插件启停、订阅通知、备份、
 *     数据保留期、系统状态与异常告警。
 *
 * 【纪律】本模块不实现「云端正式身份认证」，界面与接口都如实标注当前仍是原型机制；
 * 规则卡状态必须反映真实人工复核，不因模块存在就标「已获批」。
 */
import { all, get, run, audit, metaValue, setMeta } from '../core/db.mjs';
import { newId, nowIso, j, uj, sanitizeLegacyWording } from '../core/util.mjs';
import { hashPassword, verifyPassword, checkPasswordStrength } from '../core/password.mjs';
import {
  keyStatus, initMasterKeyFile, encryptSecret, decryptSecret,
  resolveStoredCredential, secretsConfigured, validCredentialRef, CREDENTIAL_REF_HINT, redactCredentialText,
} from '../core/secrets.mjs';
import { requireRole } from './project-svc.mjs';
import { v2Status, isProductionDb } from './v2-guard.mjs';
import { testDatasourceConnection, DAILY_DATASETS, loopbackOutboundAllowed } from './collect-svc.mjs';
import { reconciliationStats, listReconciliation, resolveReconciliation } from './reconcile-svc.mjs';
import { syncStatus } from './collect-svc.mjs';

/* ==================================================================== */
/*  一、数据源配置                                                       */
/* ==================================================================== */

export const SOURCE_KINDS = {
  official_page: '官方网页',
  file_download: '文件下载地址',
  authorized_api: '授权 API',
  manual_upload: '人工上传 / 摘录',
};

export const PARSERS = {
  html_list: '列表页（发现公告链接）',
  html_table: '表格页',
  html_document: '单篇文档页（提取标题/文号/日期）',
  ccer_trade_list_json: '交易系统 · 每日行情公告列表',
  ccer_trade_bulletin: '交易系统 · 每日行情公告正文',
  ccer_trade_first_json: '交易系统 · 分行业行情',
  json: '通用 JSON',
  pdf: 'PDF 文件',
  manual: '不自动抓取（人工导入）',
};

/**
 * 出站地址安全校验（配置阶段）：返回拒绝原因，null 表示通过。
 * 注意：`URL.hostname` 在带端口时会包含端口（如 127.0.0.1:11434），
 * 因此这里必须做主机名归一化，否则本机 Ollama 会被误判为内网地址。
 * 回环地址的放行由 loopbackOutboundAllowed() 统一控制（默认拒绝）。
 */
export function unsafeUrlReason(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return 'URL 不合法';
  }
  if (!['http:', 'https:'].includes(u.protocol)) return `不支持的协议：${u.protocol}（仅允许 http/https）`;
  const host = normalizeHostname(u.hostname);
  if (isLoopbackHost(host)) {
    return loopbackOutboundAllowed() ? null : `拒绝内网/本机地址：${host}`;
  }
  if (
    /^(10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return `拒绝内网/本机地址：${host}`;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return loopbackOutboundAllowed() ? null : '拒绝直接使用 IP 地址，请使用已登记域名';
  }
  return null;
}

/** 主机名归一化：去掉端口、去掉 IPv6 方括号、统一小写 */
export function normalizeHostname(rawHost) {
  let h = String(rawHost || '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) h = h.slice(1, end);
  } else if (/:\d+$/.test(h)) {
    h = h.replace(/:\d+$/, '');
  }
  return h;
}

/** 是否回环地址（localhost / 127.0.0.0/8 / ::1） */
export function isLoopbackHost(host) {
  const h = normalizeHostname(host);
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

export function listDatasources({ include_paused = true } = {}) {
  const rows = all(
    `SELECT * FROM datasource_config ${include_paused ? '' : 'WHERE paused = 0'} ORDER BY enabled DESC, name`
  );
  return rows.map((d) => ({
    ...d,
    source_kind_label: SOURCE_KINDS[d.source_kind] || d.source_kind,
    parser_label: PARSERS[d.parser] || d.parser,
    allowed_domains: uj(d.allowed_domains, []),
    headers: uj(d.headers_json, null),
    field_mapping: uj(d.field_mapping, null),
    status_label: d.paused ? '已暂停' : d.enabled ? '已启用' : '未启用',
    // 最近快照
    last_snapshot: get(
      'SELECT id, fetched_at, http_status, parse_quality, parse_note, error FROM source_snapshot WHERE url = ? ORDER BY fetched_at DESC LIMIT 1',
      [d.url || '']
    ),
    recent_errors: all(
      `SELECT id, fetched_at, http_status, error, parse_note FROM source_snapshot
       WHERE url = ? AND (error IS NOT NULL OR parse_quality = 'failed') ORDER BY fetched_at DESC LIMIT 5`,
      [d.url || '']
    ),
  }));
}

export function upsertDatasource(user, payload = {}) {
  const denied = requireRole(user, ['admin'], '配置数据源');
  if (denied) return denied;
  const existing = payload.id ? get('SELECT * FROM datasource_config WHERE id = ?', [payload.id]) : null;
  const isNew = !existing;
  // 出站白名单：显式给出 > 既有配置 > 官方默认
  const allowedDomains = Array.isArray(payload.allowed_domains) && payload.allowed_domains.length
    ? [...payload.allowed_domains]
    : (uj(existing?.allowed_domains, []) || []).length
      ? [...uj(existing.allowed_domains, [])]
      : ['www.mee.gov.cn', 'www.ccer.com.cn'];
  const fields = {
    name: payload.name ?? existing?.name,
    source_kind: payload.source_kind ?? existing?.source_kind ?? 'official_page',
    url: payload.url ?? existing?.url ?? null,
    method: payload.method ?? existing?.method ?? 'GET',
    headers_json: payload.headers ? j(payload.headers) : existing?.headers_json ?? null,
    field_mapping: payload.field_mapping ? j(payload.field_mapping) : existing?.field_mapping ?? null,
    parser: payload.parser ?? existing?.parser ?? 'html_list',
    frequency: payload.frequency ?? existing?.frequency ?? 'daily',
    rate_limit_per_min: payload.rate_limit_per_min ?? existing?.rate_limit_per_min ?? 6,
    timeout_ms: payload.timeout_ms ?? existing?.timeout_ms ?? 15000,
    retry_max: payload.retry_max ?? existing?.retry_max ?? 2,
    license_note: payload.license_note ?? existing?.license_note ?? null,
    data_owner: payload.data_owner ?? existing?.data_owner ?? null,
    enabled: payload.enabled === undefined ? existing?.enabled ?? 0 : payload.enabled ? 1 : 0,
    paused: payload.paused === undefined ? existing?.paused ?? 0 : payload.paused ? 1 : 0,
    allowed_domains: j(allowedDomains),
  };
  if (!fields.name) return { error: '缺少数据源名称', status: 400 };
  if (!SOURCE_KINDS[fields.source_kind]) return { error: `source_kind 取值非法（${Object.keys(SOURCE_KINDS).join('/')}）`, status: 400 };
  // 出站安全（需求规格第 4 节）：配置阶段就拦住内网地址、字面 IP 与非 http(s) 协议，
  // 避免管理员误配导致系统被当作内网访问跳板。
  if (fields.url) {
    const reason = unsafeUrlReason(fields.url);
    if (reason) return { error: '数据源地址不被允许', message: reason, status: 400 };
    const host = new URL(fields.url).hostname.toLowerCase();
    const list = allowedDomains.map((d) => String(d).toLowerCase());
    if (list.length && !list.some((d) => host === d || host.endsWith(`.${d}`))) {
      return {
        error: 'URL 域名不在出站白名单内',
        message: `域名 ${host} 不在白名单（${list.join('、')}）；请先更新白名单，或改用白名单内的官方来源。`,
        status: 400,
      };
    }
    if (!list.length) {
      allowedDomains.push(host);
      fields.allowed_domains = j(allowedDomains);
    }
  }
  const now = nowIso();
  let id = existing?.id;
  if (isNew) {
    id = newId('DSC');
    run(
      `INSERT INTO datasource_config
       (id,source_id,name,source_kind,url,method,headers_json,field_mapping,parser,frequency,rate_limit_per_min,
        timeout_ms,retry_max,license_note,data_owner,enabled,paused,last_run_at,last_success_at,last_status,
        last_error,consecutive_failures,allowed_domains,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'never',NULL,0,?,?,?,?)`,
      [
        id, null, fields.name, fields.source_kind, fields.url, fields.method, fields.headers_json,
        fields.field_mapping, fields.parser, fields.frequency, fields.rate_limit_per_min, fields.timeout_ms,
        fields.retry_max, fields.license_note, fields.data_owner, fields.enabled, fields.paused,
        fields.allowed_domains, user?.name || 'unknown', now, now,
      ]
    );
  } else {
    // 变更前留回滚点
    run(
      `INSERT INTO datasource_rollback (id,datasource_id,created_at,created_by,reason,payload_json,restored_at,restored_by)
       VALUES (?,?,?,?,?,?,NULL,NULL)`,
      [newId('DSR'), id, now, user?.name || 'unknown', payload.reason || '配置变更前自动留点', j(existing)]
    );
    run(
      `UPDATE datasource_config SET name=?, source_kind=?, url=?, method=?, headers_json=?, field_mapping=?,
         parser=?, frequency=?, rate_limit_per_min=?, timeout_ms=?, retry_max=?, license_note=?, data_owner=?,
         enabled=?, paused=?, allowed_domains=?, updated_at=? WHERE id=?`,
      [
        fields.name, fields.source_kind, fields.url, fields.method, fields.headers_json, fields.field_mapping,
        fields.parser, fields.frequency, fields.rate_limit_per_min, fields.timeout_ms, fields.retry_max,
        fields.license_note, fields.data_owner, fields.enabled, fields.paused, fields.allowed_domains, now, id,
      ]
    );
  }
  audit({
    actor: user?.name, actorRole: user?.role, action: isNew ? 'datasource.create' : 'datasource.update',
    objectType: 'datasource_config', objectId: id, detail: { name: fields.name, enabled: fields.enabled, paused: fields.paused },
  });
  return { ok: true, id, action: isNew ? 'inserted' : 'updated', rollback_point: !isNew };
}

export function pauseDatasource(user, id, { paused = true, reason = null } = {}) {
  const denied = requireRole(user, ['admin'], '暂停/恢复数据源');
  if (denied) return denied;
  const ds = get('SELECT * FROM datasource_config WHERE id = ?', [id]);
  if (!ds) return { error: '数据源不存在', status: 404 };
  run('UPDATE datasource_config SET paused = ?, last_status = ?, updated_at = ? WHERE id = ?', [
    paused ? 1 : 0, paused ? 'paused' : 'never', nowIso(), id,
  ]);
  audit({
    actor: user?.name, actorRole: user?.role, action: paused ? 'datasource.pause' : 'datasource.resume',
    objectType: 'datasource_config', objectId: id, detail: { reason },
  });
  return { ok: true, id, paused: !!paused };
}

export async function testDatasource(user, id) {
  const denied = requireRole(user, ['admin', 'researcher'], '测试数据源连通性');
  if (denied) return denied;
  const ds = get('SELECT * FROM datasource_config WHERE id = ?', [id]);
  if (!ds) return { error: '数据源不存在', status: 404 };
  const out = await testDatasourceConnection(ds);
  run(
    `UPDATE datasource_config SET last_run_at = ?, last_status = ?, last_error = ?,
       last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
       consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures + 1 END, updated_at = ?
     WHERE id = ?`,
    [
      nowIso(), out.ok ? 'ok' : 'failed', out.ok ? null : out.error || '测试失败',
      out.ok ? 1 : 0, nowIso(), out.ok ? 1 : 0, nowIso(), id,
    ]
  );
  return { ok: out.ok, datasource: { id: ds.id, name: ds.name, url: ds.url }, ...out };
}

export function listDatasourceRollbacks(datasourceId) {
  return all(
    'SELECT id, datasource_id, created_at, created_by, reason, restored_at, restored_by FROM datasource_rollback WHERE datasource_id = ? ORDER BY created_at DESC',
    [datasourceId]
  );
}

export function rollbackDatasource(user, rollbackId) {
  const denied = requireRole(user, ['admin'], '回滚数据源配置');
  if (denied) return denied;
  const rb = get('SELECT * FROM datasource_rollback WHERE id = ?', [rollbackId]);
  if (!rb) return { error: '回滚点不存在', status: 404 };
  if (rb.restored_at) return { error: '该回滚点已被使用', status: 409 };
  const snap = uj(rb.payload_json, null);
  if (!snap) return { error: '回滚点内容损坏', status: 500 };
  run(
    `UPDATE datasource_config SET name=?, source_kind=?, url=?, method=?, headers_json=?, field_mapping=?, parser=?,
       frequency=?, rate_limit_per_min=?, timeout_ms=?, retry_max=?, license_note=?, data_owner=?, enabled=?,
       paused=?, allowed_domains=?, updated_at=? WHERE id=?`,
    [
      snap.name, snap.source_kind, snap.url, snap.method, snap.headers_json, snap.field_mapping, snap.parser,
      snap.frequency, snap.rate_limit_per_min, snap.timeout_ms, snap.retry_max, snap.license_note,
      snap.data_owner, snap.enabled, snap.paused, snap.allowed_domains, nowIso(), rb.datasource_id,
    ]
  );
  run('UPDATE datasource_rollback SET restored_at = ?, restored_by = ? WHERE id = ?', [nowIso(), user?.name || 'unknown', rollbackId]);
  audit({
    actor: user?.name, actorRole: user?.role, action: 'datasource.rollback',
    objectType: 'datasource_config', objectId: rb.datasource_id, detail: { rollback_id: rollbackId },
  });
  return { ok: true, datasource_id: rb.datasource_id, restored_from: rollbackId };
}

/* ==================================================================== */
/*  二、模型配置                                                         */
/* ==================================================================== */

export const LLM_PURPOSES = {
  use_policy_summary: '政策摘要',
  use_methodology_extract: '方法学结构候选抽取',
  use_content_verify: '公开内容/研报自动核验',
  use_project_extract: '项目字段抽取',
  use_qa_draft: '问答与报告草稿',
};

/**
 * 模型配置的出站主机白名单校验（供配置保存与真实连接测试共用）。
 * 判定顺序与 resolveCredential 一致：本机 Ollama → 白名单域名 → 协议/私网校验。
 * @returns {{ok:boolean, host:string|null, reason:string|null, local_ollama:boolean}}
 */
export function llmOutboundCheck(p) {
  let host = null;
  try {
    host = normalizeHostname(new URL(p.base_url).hostname);
  } catch {
    return { ok: false, host: null, reason: 'Base URL 不合法', local_ollama: false };
  }
  const localOllama = p.provider_kind === 'ollama' && isLoopbackHost(host);
  if (localOllama) return { ok: true, host, reason: null, local_ollama: true };
  const domains = uj(p.allowed_domains, []);
  if (!domains.length) return { ok: false, host, reason: '未配置出站域名白名单', local_ollama: false };
  if (!domains.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, host, reason: `Base URL 域名 ${host} 不在白名单内：${domains.join('、')}`, local_ollama: false };
  }
  const unsafe = unsafeUrlReason(p.base_url);
  if (unsafe) return { ok: false, host, reason: unsafe, local_ollama: false };
  return { ok: true, host, reason: null, local_ollama: false };
}

/** 主密钥状态（后台页面用于「初始化本机主密钥」提示；不返回任何密钥值） */
export function secretKeyStatus() {
  return keyStatus();
}

export function initSecretKey(user) {
  const denied = requireRole(user, ['admin'], '初始化本机主密钥');
  if (denied) return denied;
  const out = initMasterKeyFile();
  audit({
    actor: user?.name, actorRole: user?.role, action: 'secret.init_master_key',
    objectType: 'system', objectId: 'master_key', detail: { created: out.created, path: out.path },
  });
  return { ...out, status: keyStatus() };
}

/**
 * 凭据解析顺序：
 *   1. 本机 Ollama（无需密钥）
 *   2. 环境变量引用名（推荐，凭据不落库）
 *   3. 服务端 AES-256-GCM 加密存储（主密钥来自 CCER_SECRET_KEY 或本机密钥文件）
 */
export function resolveCredential(provider) {
  if (provider && !validCredentialRef(provider.credential_ref)) return { ok: false, reason: CREDENTIAL_REF_HINT };
  if (!provider) return { ok: false, reason: '未配置模型' };
  if (provider.provider_kind === 'ollama') {
    try {
      const u = new URL(provider.base_url);
      if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
        return { ok: true, source: '本机 Ollama（无需密钥）', secret: null };
      }
    } catch { /* 地址由配置校验报告 */ }
  }
  const out = resolveStoredCredential(provider);
  if (out.ok) return out;
  const ref = provider.credential_ref;
  if (ref && process.env[`CCER_LLM_KEY_${ref}`]) {
    return { ok: true, source: `环境变量 CCER_LLM_KEY_${ref}`, secret: process.env[`CCER_LLM_KEY_${ref}`] };
  }
  return {
    ok: false,
    reason: ref
      ? `${out.reason} 也可设置 CCER_LLM_KEY_${ref}（凭据不写入数据库、不返回浏览器）`
      : out.reason,
  };
}

export function listLlmProviders() {
  const rows = all('SELECT * FROM llm_provider WHERE archived=0 ORDER BY created_at');
  return rows.map((p) => {
    const cred = resolveCredential(p);
    return {
      // 只返回凭据是否存在与来源，绝不返回凭据本身
      id: p.id,
      name: p.name,
      provider_kind: p.provider_kind,
      base_url: p.base_url,
      model: p.model,
      credential_ref: validCredentialRef(p.credential_ref) ? p.credential_ref : null,
      credential_configured: cred.ok,
      credential_source: cred.ok ? cred.source : null,
      credential_hint: cred.ok ? null : cred.reason,
      credential_stored_encrypted: !!p.credential_cipher,
      timeout_ms: p.timeout_ms,
      max_calls_per_day: p.max_calls_per_day,
      enabled: !!p.enabled,
      purposes: Object.fromEntries(Object.keys(LLM_PURPOSES).map((k) => [k, !!p[k]])),
      allow_sensitive: !!p.allow_sensitive,
      allowed_domains: uj(p.allowed_domains, []),
      last_test_at: p.last_test_at,
      last_test_result: p.last_test_result,
      last_test_message: redactCredentialText(p.last_test_message),
      calls_today: p.calls_today,
      note: p.note,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  });
}

export function upsertLlmProvider(user, payload = {}) {
  const denied = requireRole(user, ['admin'], '配置模型');
  if (denied) return denied;
  const existing = payload.id ? get('SELECT * FROM llm_provider WHERE id = ?', [payload.id]) : null;
  const isNew = !existing;
  const now = nowIso();
  const fields = {
    name: payload.name ?? existing?.name,
    provider_kind: payload.provider_kind ?? existing?.provider_kind ?? 'openai_compatible',
    base_url: payload.base_url ?? existing?.base_url,
    model: payload.model ?? existing?.model,
    credential_ref: payload.credential_ref === undefined ? existing?.credential_ref ?? null : payload.credential_ref,
    timeout_ms: payload.timeout_ms ?? existing?.timeout_ms ?? 30000,
    max_calls_per_day: payload.max_calls_per_day ?? existing?.max_calls_per_day ?? 200,
    enabled: payload.enabled === undefined ? existing?.enabled ?? 0 : payload.enabled ? 1 : 0,
    allow_sensitive: payload.allow_sensitive === undefined ? existing?.allow_sensitive ?? 0 : payload.allow_sensitive ? 1 : 0,
    allowed_domains: payload.allowed_domains ? j(payload.allowed_domains) : existing?.allowed_domains ?? j([]),
    note: payload.note ?? existing?.note ?? null,
  };
  for (const k of Object.keys(LLM_PURPOSES)) {
    fields[k] = payload[k] === undefined ? existing?.[k] ?? 0 : payload[k] ? 1 : 0;
  }
  if (!fields.name) return { error: '缺少配置名称', status: 400 };
  if (!validCredentialRef(fields.credential_ref)) return { error: CREDENTIAL_REF_HINT, status: 400 };
  if (!fields.base_url || !/^https?:\/\//.test(String(fields.base_url))) {
    return { error: 'Base URL 必须以 http(s):// 开头', status: 400 };
  }
  if (!fields.model) return { error: '缺少模型名', status: 400 };
  const domains = uj(fields.allowed_domains, []);
  // 本机服务：主机名须做端口归一化（URL.hostname 在带端口时含端口）。
  // 本机 Ollama 天然免密钥；在显式开启回环出站（本地联调/自动化测试）时，
  // 指向回环地址的 OpenAI 兼容端点也按「本机服务」处理，允许 http 且不强制白名单。
  let hostname = null;
  try { hostname = normalizeHostname(new URL(fields.base_url).hostname); } catch { hostname = null; }
  const isLoopback = isLoopbackHost(hostname);
  const isLocalOllama = fields.provider_kind === 'ollama' && isLoopback;
  const isLocalService = isLocalOllama || (isLoopback && loopbackOutboundAllowed());
  if (!isLocalService && unsafeUrlReason(fields.base_url))
    return { error: unsafeUrlReason(fields.base_url), status: 400 };
  if (!isLocalService && new URL(fields.base_url).protocol !== 'https:')
    return { error: '外部模型必须使用 HTTPS', status: 400 };
  if (!domains.length && !isLocalService) return { error: '必须配置出站域名白名单', status: 400 };
  let cipher = existing?.credential_cipher || null;
  let secretNote = null;
  if (payload.secret !== undefined && payload.secret !== null && payload.secret !== '') {
    const enc = encryptSecret(payload.secret);
    if (!enc) {
      const ks = keyStatus();
      return {
        error: '未初始化服务端主密钥，拒绝保存明文凭据',
        message:
          '两种可操作方式（任选其一）：\n' +
          '  1) 在「后台管理 → 模型与连接」点击「初始化本机主密钥」，系统会在本机生成受限密钥文件后重试保存；\n' +
          '  2) 由运维设置环境变量 CCER_SECRET_KEY，然后重新提交凭据（AES-256-GCM 加密后入库）。\n' +
          '或者只填「凭据引用名」（如 DEEPSEEK_API_KEY）并把密钥放在服务端环境变量里，凭据完全不落库。',
        secret_key: ks,
        status: 400,
      };
    }
    cipher = enc;
    secretNote = `凭据已加密存储（AES-256-GCM，主密钥来源：${keyStatus().source === 'env' ? '环境变量 CCER_SECRET_KEY' : '本机受限密钥文件'}）`;
  }
  if (isNew) {
    const id = newId('LLM');
    run(
      `INSERT INTO llm_provider
       (id,name,provider_kind,base_url,model,credential_ref,credential_cipher,timeout_ms,max_calls_per_day,enabled,
        use_policy_summary,use_methodology_extract,use_content_verify,use_project_extract,use_qa_draft,allow_sensitive,allowed_domains,
        last_test_at,last_test_result,last_test_message,calls_today,calls_today_date,note,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,0,NULL,?,?,?,?)`,
      [
        id, fields.name, fields.provider_kind, fields.base_url, fields.model, fields.credential_ref, cipher,
        fields.timeout_ms, fields.max_calls_per_day, fields.enabled, fields.use_policy_summary,
        fields.use_methodology_extract, fields.use_content_verify, fields.use_project_extract, fields.use_qa_draft,
        fields.allow_sensitive, fields.allowed_domains, fields.note, user?.name || 'unknown', now, now,
      ]
    );
    audit({ actor: user?.name, actorRole: user?.role, action: 'llm.create', objectType: 'llm_provider', objectId: id, detail: { name: fields.name, model: fields.model } });
    return { ok: true, id, action: 'inserted', credential: secretNote };
  }
  run(
    `UPDATE llm_provider SET name=?, provider_kind=?, base_url=?, model=?, credential_ref=?, credential_cipher=?,
       timeout_ms=?, max_calls_per_day=?, enabled=?, use_policy_summary=?, use_methodology_extract=?,
       use_content_verify=?, use_project_extract=?, use_qa_draft=?, allow_sensitive=?, allowed_domains=?, note=?, updated_at=? WHERE id=?`,
    [
      fields.name, fields.provider_kind, fields.base_url, fields.model, fields.credential_ref, cipher,
      fields.timeout_ms, fields.max_calls_per_day, fields.enabled, fields.use_policy_summary,
      fields.use_methodology_extract, fields.use_content_verify, fields.use_project_extract, fields.use_qa_draft,
      fields.allow_sensitive, fields.allowed_domains, fields.note, now, existing.id,
    ]
  );
  audit({
    actor: user?.name, actorRole: user?.role, action: 'llm.update', objectType: 'llm_provider',
    objectId: existing.id, detail: { enabled: fields.enabled, purposes: Object.keys(LLM_PURPOSES).filter((k) => fields[k]) },
  });
  return { ok: true, id: existing.id, action: 'updated', credential: secretNote };
}

/**
 * 构建 OpenAI 兼容 / Anthropic 兼容的对话端点。
 * 兼容两种填写习惯：Base URL 已含完整路径（…/v1/chat/completions）或只到域名（…/v1）。
 * @returns {{url:string, kind:'openai'|'anthropic'}}
 */
export function chatEndpoint(p) {
  const raw = String(p.base_url || '').replace(/\/+$/, '');
  const kind = p.provider_kind === 'anthropic' ? 'anthropic' : 'openai';
  // 自动化测试回环桩：只在显式允许回环 + 提供回环地址时生效；生产保持官方 host。
  if (isDeepSeekBase(raw) && process.env.CCER_ALLOW_LOOPBACK_OUTBOUND === '1' && process.env.CCER_DEEPSEEK_TEST_BASE) {
    try {
      const u = new URL(process.env.CCER_DEEPSEEK_TEST_BASE);
      if (['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
        return { url: `${u.origin}/chat/completions`, kind: 'openai' };
      }
    } catch { /* 回落官方端点 */ }
  }
  if (/\/(chat\/completions|messages|completions)$/i.test(raw)) return { url: raw, kind };
  if (/\/v\d+$/i.test(raw) || /\/api\/v\d+$/i.test(raw)) {
    return { url: `${raw}${kind === 'anthropic' ? '/messages' : '/chat/completions'}`, kind };
  }
  if (kind === 'anthropic') return { url: `${raw}/v1/messages`, kind };
  if (/^https?:\/\/api\.deepseek\.com$/i.test(raw)) return { url: `${raw}/chat/completions`, kind };
  return { url: `${raw}/v1/chat/completions`, kind };
}

/**
 * 是否 DeepSeek 官方端点（连接测试同样需要关闭 thinking，见 docs/22 第 9 条）。
 * 依据 https://api-docs.deepseek.com/guides/thinking_mode/ （2026-09-29 核实）。
 */
export function isDeepSeekBase(baseUrl) {
  try {
    const host = new URL(String(baseUrl || '')).hostname.toLowerCase();
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

/**
 * 模型配置真实连接测试。
 * ============================================================================
 * 需求（docs/19 第 59 条）：连接测试应发**真实的短测试请求**，并区分
 * 「已配置」与「可调用」两个状态。因此本函数：
 *   1. 先做配置与凭据检查 → 得到 configured（是否具备可调用条件）；
 *   2. 若 configured，向模型端点发一条最短的真实请求（max_tokens=8）；
 *   3. callable 只有在真实 HTTP 200 且拿到可解析文本时才为 true；
 *   4. 全过程写入 llm_call_log（purpose='test'），便于审计与配额统计。
 * 网络失败 / 配额耗尽 / 鉴权失败都会被区分记录，不会假装成功。
 */
export async function testLlmProvider(user, id) {
  const denied = requireRole(user, ['admin'], '测试模型配置');
  if (denied) return denied;
  const p = get('SELECT * FROM llm_provider WHERE id = ?', [id]);
  if (!p) return { error: '模型配置不存在', status: 404 };
  const cred = resolveCredential(p);
  const issues = [];
  if (!cred.ok) issues.push(cred.reason);
  const outbound = llmOutboundCheck(p);
  if (!outbound.ok) issues.push(outbound.reason);
  const purposeCount = Object.keys(LLM_PURPOSES).filter((k) => p[k]).length;
  if (!purposeCount) issues.push('未开启任何用途（政策摘要/方法学抽取/内容核验/项目抽取/问答草稿）');
  if (!p.enabled) issues.push('该配置未启用（enabled=0）');
  const configured = issues.length === 0;

  const endpoint = chatEndpoint(p);
  const result = {
    ok: false,
    configured,
    callable: false,
    provider: { id: p.id, name: p.name, model: p.model, base_url: p.base_url, endpoint: endpoint.url },
    credential_configured: cred.ok,
    credential_source: cred.ok ? cred.source : null,
    purposes_enabled: Object.keys(LLM_PURPOSES).filter((k) => p[k]).map((k) => LLM_PURPOSES[k]),
    real_call_performed: false,
    http_status: null,
    latency_ms: null,
    response_preview: null,
    message: '',
    issues,
  };

  if (!configured) {
    result.message = `配置未就绪（已配置=${cred.ok ? '凭据已配置' : '凭据缺失'}，可调用=否）：${issues.join('；')}`;
    run('UPDATE llm_provider SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
      nowIso(), 'configured_only', result.message, nowIso(), id,
    ]);
    return result;
  }

  // ---- 真实短测试请求 ----
  result.real_call_performed = true;
  const started = Date.now();
  let httpStatus = null;
  let errText = null;
  let preview = null;
  try {
    const headers = { 'content-type': 'application/json' };
    if (cred.secret) {
      headers.authorization = endpoint.kind === 'anthropic' ? `x-api-key: ${cred.secret}` : `Bearer ${cred.secret}`;
      if (endpoint.kind === 'anthropic') {
        delete headers.authorization;
        headers['x-api-key'] = cred.secret;
        headers['anthropic-version'] = '2023-06-01';
      }
    }
    const body =
      endpoint.kind === 'anthropic'
        ? { model: p.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
        : { model: p.model, max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: 'ping' }] };
    // DeepSeek 默认 thinking enabled：连接测试用很小的 token 预算时可能只返回 reasoning、
    // 没有可解析文本，从而误判「不可调用」。依据
    // https://api-docs.deepseek.com/guides/thinking_mode/ 关闭 thinking；
    // 只对 api.deepseek.com 设置，不向不兼容供应商强塞该参数。
    if (endpoint.kind !== 'anthropic' && isDeepSeekBase(p.base_url)) {
      body.thinking = { type: 'disabled' };
    }
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(Number(p.timeout_ms) || 30000, 45000)),
    });
    httpStatus = res.status;
    const text = await res.text();
    if (!res.ok) {
      errText = `HTTP ${res.status}：${text.slice(0, 300)}`;
    } else {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        errText = `响应不是合法 JSON：${text.slice(0, 200)}`;
      }
      if (parsed) {
        preview =
          parsed?.choices?.[0]?.message?.content ??
          parsed?.content?.[0]?.text ??
          parsed?.message?.content ??
          null;
        if (typeof preview === 'string') preview = preview.slice(0, 120);
        if (preview === null) errText = '响应结构中没有可识别的文本内容';
      }
    }
  } catch (e) {
    errText = `请求失败：${e.message}${e.cause?.code ? `（${e.cause.code}）` : ''}`;
  }
  const latency = Date.now() - started;

  result.http_status = httpStatus;
  result.latency_ms = latency;
  result.response_preview = preview;
  result.callable = !errText && preview !== null;
  result.ok = result.callable;
  result.message = result.callable
    ? `真实调用成功：HTTP ${httpStatus}，${latency} ms，模型返回可解析文本。`
    : `已配置但不可调用：${errText || '未知错误'}`;

  try {
    run(
      `INSERT INTO llm_call_log (id,provider_id,at,purpose,actor,model,request_chars,response_chars,latency_ms,status,error,
        object_type,object_id,citations_json,draft_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId('LLC'), p.id, nowIso(), 'test', user?.name || 'unknown', p.model, JSON.stringify({ ping: true }).length,
        String(preview || '').length, latency, result.callable ? 'ok' : 'error', errText, 'llm_provider', p.id, null, null,
      ]
    );
  } catch {
    /* 日志失败不影响测试结论 */
  }
  run('UPDATE llm_provider SET last_test_at=?, last_test_result=?, last_test_message=?, updated_at=? WHERE id=?', [
    nowIso(), result.callable ? 'ok' : 'failed', result.message, nowIso(), id,
  ]);
  audit({
    actor: user?.name, actorRole: user?.role, action: 'llm.test', objectType: 'llm_provider', objectId: id,
    detail: { configured, callable: result.callable, http_status: httpStatus, latency_ms: latency },
    result: result.callable ? 'ok' : 'failed',
  });
  return result;
}

/** AI 能力总开关状态（供界面显示「AI 未配置，不影响规则与官方数据」） */
export function llmStatus() {
  const providers = all('SELECT * FROM llm_provider');
  const enabled = providers.filter((p) => p.enabled);
  const purposes = {};
  for (const k of Object.keys(LLM_PURPOSES)) {
    const usable = enabled.filter((p) => p[k] && resolveCredential(p).ok);
    purposes[k] = {
      label: LLM_PURPOSES[k],
      enabled: usable.length > 0,
      provider_count: usable.length,
    };
  }
  return {
    providers: providers.length,
    enabled_providers: enabled.length,
    purposes,
    any_ai_available: Object.values(purposes).some((p) => p.enabled),
    secret_key: keyStatus(),
    note:
      '模型仅用于公开资料的自动核验与摘要抽取，不需要任何人工确认环节。' +
      '模型不可用时：官方数据采集、交易行情、规则判断与快捷估算完全不受影响，' +
      '相关内容条目标记为「暂未自动核验」，不阻断全站。',
  };
}

/* ==================================================================== */
/*  三、用户 / 团队 / 授权                                               */
/* ==================================================================== */

export const ROLES = {
  admin: '系统管理员',
  researcher: '政策研究员',
  analyst: '投资分析师',
  reviewer: '领域复核人',
  viewer: '只读用户',
};

export function listUsers() {
  const rows = all('SELECT * FROM app_user ORDER BY role, name');
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    role_label: ROLES[u.role] || u.role,
    team_id: u.team_id,
    active: !!u.active,
    display_name: u.display_name || null,
    email: u.email || null,
    must_change_password: !!u.must_change_password,
    password_set: !!u.password_hash,
    failed_attempts: u.failed_attempts || 0,
    locked_until: u.locked_until || null,
    last_login_at: u.last_login_at || null,
    created_at: u.created_at || null,
    sessions: get('SELECT COUNT(*) AS c FROM user_session WHERE user_id = ? AND revoked_at IS NULL', [u.id])?.c ?? 0,
  }));
}

export function upsertUser(user, payload = {}) {
  const denied = requireRole(user, ['admin'], '管理用户');
  if (denied) return denied;
  // upsert 语义：提供 id 但库中不存在 → 视为新建（调用方无需先查询）
  const existing = payload.id ? get('SELECT * FROM app_user WHERE id = ?', [payload.id]) : null;
  const isNew = !existing;
  const role = payload.role ?? existing?.role ?? 'viewer';
  if (!ROLES[role]) return { error: `角色取值非法（${Object.keys(ROLES).join('/')}）`, status: 400 };
  const now = nowIso();
  if (isNew) {
    const id = payload.id || newId('USR');
    if (get('SELECT id FROM app_user WHERE id = ?', [id])) return { error: `用户 ID 已存在：${id}`, status: 409 };
    run(
      `INSERT INTO app_user (id,name,role,team_id,active,display_name,email,password_hash,password_algo,
         must_change_password,failed_attempts,locked_until,last_login_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,1,0,NULL,NULL,?,?)`,
      [id, payload.name || id, role, payload.team_id || 'team-default', payload.active === false ? 0 : 1,
        payload.display_name || null, payload.email || null, now, now]
    );
    audit({ actor: user?.name, actorRole: user?.role, action: 'user.create', objectType: 'app_user', objectId: id, detail: { role, team_id: payload.team_id } });
    return {
      ok: true, id, action: 'inserted',
      note: '新建账号未设置口令：请由管理员调用「重置口令」接口设置初始口令，并强制首次登录修改。',
    };
  }
  const fields = {
    name: payload.name ?? existing.name,
    role,
    team_id: payload.team_id ?? existing.team_id,
    active: payload.active === undefined ? existing.active : payload.active ? 1 : 0,
    display_name: payload.display_name ?? existing.display_name,
    email: payload.email ?? existing.email,
  };
  if (existing.id === user?.id && fields.active === 0) {
    return { error: '不能停用当前登录的管理员账号', status: 400 };
  }
  if (existing.role === 'admin' && fields.role !== 'admin') {
    const admins = get("SELECT COUNT(*) AS c FROM app_user WHERE role = 'admin' AND active = 1")?.c ?? 0;
    if (admins <= 1) return { error: '至少保留一名启用状态的管理员', status: 400 };
  }
  run(
    `UPDATE app_user SET name=?, role=?, team_id=?, active=?, display_name=?, email=?, updated_at=? WHERE id=?`,
    [fields.name, fields.role, fields.team_id, fields.active, fields.display_name, fields.email, now, existing.id]
  );
  audit({
    actor: user?.name, actorRole: user?.role, action: 'user.update', objectType: 'app_user', objectId: existing.id,
    detail: { before: { role: existing.role, team_id: existing.team_id, active: existing.active }, after: fields },
  });
  return { ok: true, id: existing.id, action: 'updated' };
}

/** 口令哈希：实现见 src/core/password.mjs（此处转出便于服务层统一引用） */
export { hashPassword, verifyPassword, checkPasswordStrength };

export function resetUserPassword(user, userId, { password = null, must_change = true } = {}) {
  const denied = requireRole(user, ['admin'], '重置口令');
  if (denied) return denied;
  const target = get('SELECT * FROM app_user WHERE id = ?', [userId]);
  if (!target) return { error: '用户不存在', status: 404 };
  if (!password) return { error: '必须提供新口令', status: 400 };
  const strength = checkPasswordStrength(password);
  if (!strength.ok) return { error: `口令强度不足：${strength.issues.join('；')}`, status: 400 };
  run(
    `UPDATE app_user SET password_hash = ?, password_algo = 'scrypt', must_change_password = ?,
       failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
    [hashPassword(password), must_change ? 1 : 0, nowIso(), userId]
  );
  // 重置口令后立即撤销该用户全部会话
  const revoked = run('UPDATE user_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]);
  audit({
    actor: user?.name, actorRole: user?.role, action: 'user.reset_password', objectType: 'app_user',
    objectId: userId, detail: { must_change, revoked_sessions: revoked.changes },
  });
  return {
    ok: true, id: userId, must_change_password: !!must_change, revoked_sessions: revoked.changes,
    note:
      '口令以 scrypt 哈希存储；重置后该账号的所有会话已撤销。' +
      '注意：本系统仍未接入机构统一身份认证（SSO/OIDC），云端上线前必须替换。',
  };
}

export function listTeams() {
  const teams = all('SELECT * FROM app_team ORDER BY id');
  return teams.map((t) => ({
    ...t,
    members: all('SELECT id, name, role FROM app_user WHERE team_id = ?', [t.id]),
    grants: get("SELECT COUNT(*) AS c FROM project_grant WHERE team_id = ?", [t.id])?.c ?? 0,
  }));
}

export function upsertTeam(user, payload = {}) {
  const denied = requireRole(user, ['admin'], '管理团队');
  if (denied) return denied;
  if (!payload.id && !payload.name) return { error: '缺少团队名称', status: 400 };
  const id = payload.id || newId('TEAM');
  run(
    `INSERT INTO app_team (id,name,description,active,created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, active=excluded.active`,
    [id, payload.name || id, payload.description || null, payload.active === false ? 0 : 1, nowIso()]
  );
  audit({ actor: user?.name, actorRole: user?.role, action: 'team.upsert', objectType: 'app_team', objectId: id, detail: payload });
  return { ok: true, id };
}

export function grantProject(user, { team_id, object_type = 'internal_project', object_id, note = null }) {
  const denied = requireRole(user, ['admin'], '分配项目授权');
  if (denied) return denied;
  if (!team_id || !object_id) return { error: '需要 team_id 与 object_id', status: 400 };
  if (!['internal_project', 'public_project'].includes(object_type)) {
    return { error: 'object_type 取值非法', status: 400 };
  }
  run(
    `INSERT INTO project_grant (id,team_id,object_type,object_id,granted_by,granted_at,note)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(team_id,object_type,object_id) DO UPDATE SET note=excluded.note`,
    [newId('PGR'), team_id, object_type, object_id, user?.name || 'unknown', nowIso(), note]
  );
  audit({ actor: user?.name, actorRole: user?.role, action: 'project.grant', objectType, objectId: object_id, detail: { team_id, note } });
  return { ok: true, team_id, object_type, object_id };
}

export function revokeProjectGrant(user, grantId) {
  const denied = requireRole(user, ['admin'], '撤销项目授权');
  if (denied) return denied;
  const g = get('SELECT * FROM project_grant WHERE id = ?', [grantId]);
  if (!g) return { error: '授权记录不存在', status: 404 };
  run('DELETE FROM project_grant WHERE id = ?', [grantId]);
  audit({ actor: user?.name, actorRole: user?.role, action: 'project.grant.revoke', objectType: g.object_type, objectId: g.object_id, detail: { team_id: g.team_id } });
  return { ok: true, id: grantId };
}

export function listLoginLogs({ limit = 200, result = null } = {}) {
  return all(
    `SELECT * FROM user_login_log ${result ? 'WHERE result = ?' : ''} ORDER BY at DESC LIMIT ?`,
    result ? [result, limit] : [limit]
  );
}

export function listAuditLogs({ limit = 200, action = null, object_type = null, actor = null } = {}) {
  const where = [];
  const params = [];
  if (action) {
    where.push('action LIKE ?');
    params.push(`%${action}%`);
  }
  if (object_type) {
    where.push('object_type = ?');
    params.push(object_type);
  }
  if (actor) {
    where.push('actor = ?');
    params.push(actor);
  }
  return all(
    `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 2000)]
  );
}

export function listExportLogs({ limit = 200 } = {}) {
  return all('SELECT * FROM export_log ORDER BY at DESC LIMIT ?', [Math.min(Number(limit) || 200, 2000)]);
}

/* ==================================================================== */
/*  四、自动核验运行状态 / 缺口 / 口径 / 系统状态                         */
/* ==================================================================== */
/*
 * 【本轮升级】删除 reviewsDashboard / decideTask：本平台不再有「人工审核任务」、
 * 「复核角色」与「专家审批」。采集—核验—发布全自动，模型核验结果只有四种状态，
 * 冲突与失败以**运行状态**呈现，不产生待办、不需要管理员批准内容。
 * 查询接口保留在 verification-svc（verificationStats / listVerifications）。
 */

/**
 * 数据缺口台账（**自动运行状态，不是人工待办**）。
 * 旧台账里的 manual_path / 描述含旧人工流程文案，这里改写成「自动处理方式」，
 * 原始文案只作历史留痕返回（legacy_*），不改写、不删除原始记录。
 */
export function listGaps({ status = 'open' } = {}) {
  const rows = all(
    `SELECT * FROM data_gap ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, detected_at DESC`,
    status === 'all' ? [] : [status]
  );
  return rows.map((g) => ({
    ...g,
    // 历史数据里的旧人工流程措辞在展示层改写为自动口径（原库不改写、不删除）
    title: sanitizeLegacyWording(g.title),
    description: sanitizeLegacyWording(g.description),
    auto_action: g.auto_action
      || {
        'gap-trade-daily': '自动采集官方每日行情公告（失败自动重试）；未采集到的日期显示「数据暂缺」，不用 0 或旧数据填充。',
        'gap-methodology-pdf-og': '自动抓取官方 PDF 原文并归档哈希；未归档前该方法学只可检索与阅读，不参与测算。',
        'gap-catalog-8-pending': '从官方发布通知自动逐条比对编号；未核实前编号留空，不推测。',
        'gap-policy-original-archive': '随每日巡检自动抓取原件并计算哈希；未归档时条款只引用到章节层级。',
        'gap-llm-default-off': '未配置模型属已知限制：官方采集、规则判断与快捷估算不受影响；内容标记「暂未自动核验」，配置后自动重试。',
      }[g.gap_key] || '由每日自动任务重试与补全；未完成时如实显示缺失状态。',
    handling: '自动运行状态（平台无人工待办）',
    legacy_manual_path: g.manual_path || null,
    manual_path: null,
    impact: sanitizeLegacyWording(g.impact),
  }));
}

export function updateGap(user, id, { status, note = null } = {}) {
  const denied = requireRole(user, ['admin', 'researcher'], '更新数据缺口');
  if (denied) return denied;
  const gap = get('SELECT * FROM data_gap WHERE id = ?', [id]);
  if (!gap) return { error: '缺口记录不存在', status: 404 };
  if (!['open', 'mitigated', 'closed'].includes(status)) {
    return { error: 'status 取值非法（open/mitigated/closed）', status: 400 };
  }
  run('UPDATE data_gap SET status = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?', [
    status, note ? `${gap.description}\n【处理说明】${note}` : null, nowIso(), id,
  ]);
  audit({ actor: user?.name, actorRole: user?.role, action: 'data_gap.update', objectType: 'data_gap', objectId: id, detail: { status, note } });
  return { ok: true, id, status };
}

export function listMetricDefinitions(module = null) {
  return all(
    `SELECT * FROM metric_definition ${module ? 'WHERE module = ?' : ''} ORDER BY module, key`,
    module ? [module] : []
  );
}

export function updateMetricDefinition(user, key, { caliber, source_note = null }) {
  const denied = requireRole(user, ['admin', 'researcher'], '维护指标口径');
  if (denied) return denied;
  const m = get('SELECT * FROM metric_definition WHERE key = ?', [key]);
  if (!m) return { error: '指标不存在', status: 404 };
  run('UPDATE metric_definition SET caliber = COALESCE(?, caliber), source_note = COALESCE(?, source_note), updated_at = ? WHERE key = ?', [
    caliber || null, source_note, nowIso(), key,
  ]);
  audit({ actor: user?.name, actorRole: user?.role, action: 'metric.update', objectType: 'metric_definition', objectId: key, detail: { caliber } });
  return { ok: true, key };
}

export function listSchedule() {
  return all('SELECT * FROM datasource_config ORDER BY frequency, name').map((d) => ({
    id: d.id,
    name: d.name,
    url: d.url,
    frequency: d.frequency,
    enabled: !!d.enabled,
    paused: !!d.paused,
    last_run_at: d.last_run_at,
    last_success_at: d.last_success_at,
    last_status: d.last_status,
    consecutive_failures: d.consecutive_failures,
    data_owner: d.data_owner,
  }));
}

/** 系统状态（后台首页）：库、任务、异常、覆盖状态与保留期 */
export function systemStatus() {
  const v2 = v2Status();
  const tables = [
    'policy_document', 'policy_attachment', 'public_project', 'project_event',
    'reduction_batch', 'trade_daily', 'trade_revision',
    'trade_dimension', 'trade_calendar', 'source_snapshot', 'ingestion_job', 'data_reconciliation',
    'notification', 'data_gap', 'evidence', 'export_log', 'user_login_log',
    // v2.1 公开信息整合（docs/19）
    'content_item', 'content_version', 'content_source_link',
    'search_provider', 'web_fetch_connection', 'verification_result',
  ];
  const counts = {};
  for (const t of tables) {
    try {
      counts[t] = get(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0;
    } catch {
      counts[t] = null;
    }
  }
  const sync = syncStatus();
  const rec = reconciliationStats();
  return {
    v2,
    database: {
      path: v2.db,
      is_production_db: isProductionDb(v2.db),
      writable: !isProductionDb(v2.db),
    },
    counts,
    sync,
    reconciliation: rec,
    jobs: all('SELECT * FROM ingestion_job ORDER BY started_at DESC LIMIT 10').map((j) => ({
      id: j.id, job_key: j.job_key, status: j.status, started_at: j.started_at, finished_at: j.finished_at,
      items_found: j.items_found, items_parsed: j.items_parsed, items_queued: j.items_queued, error_count: j.error_count,
    })),
    conflicts_open: sync.counts.verification_conflict,
    verifications_total: get("SELECT COUNT(*) AS c FROM verification_result")?.c ?? 0,
    data_gaps_open: get("SELECT COUNT(*) AS c FROM data_gap WHERE status='open'")?.c ?? 0,
    retention: metaValue('data_retention_note', '原始快照与采集日志默认保留 3 年；审计日志默认保留 3 年；历史修订记录长期保留。'),
    backup: metaValue('backup_note', '尚未配置自动备份；上线前须完成备份与恢复演练（见 scripts/backup.mjs）。'),
    scheduler: process.env.CCER_DAILY_SYNC === '1'
      ? `每日自动更新已启用：北京时间 ${process.env.CCER_DAILY_SYNC_HOUR || '6'}:${String(process.env.CCER_DAILY_SYNC_MINUTE || '30').padStart(2,'0')}；服务需保持运行。`
      : '每日自动更新当前未启用；可立即执行每日更新，或启动服务时设置 CCER_DAILY_SYNC=1。',
    dataset_kinds: DAILY_DATASETS,
    identity: {
      mode: metaValue('auth_mode', 'session'),
      note:
        '当前为原型身份机制：账号口令可用 scrypt 哈希存储，但**尚未接入机构统一身份认证（SSO/OIDC）**，' +
        '云端上线前必须替换；会话为服务端会话，x-user-id 等自报头在 session 模式下被忽略。',
    },
    ai: llmStatus(),
  };
}

export { setMeta, audit };
