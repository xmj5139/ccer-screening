#!/usr/bin/env node
/**
 * CCER 公开信息平台 —— HTTP 服务
 * ============================================================================
 * 挂载 v1（历史接口，保留兼容）与 v2（八模块公开信息平台）两套路由。
 * v2 只整合公开资料，采集与核验完全自动化，不含内部项目与人工审核环节；
 * 设计依据：docs/19-公开信息整合平台升级任务.md，实施记录：docs/20-DSH升级实施记录.md
 * ============================================================================
 * 设计约束（设计文档第 8、11 节）：
 *   - 部署在机构内网或私有服务器；仅绑定回环地址，不对外暴露
 *   - 零第三方依赖，仅使用 Node 内置模块
 *   - 所有结论返回 source_ids / rule_version / unknown 原因 与运行时间
 *   - 大文件异步处理、批量导入与重跑由同一接口层承载
 *
 * 身份认证（安全基线，见 src/services/auth-svc.mjs）：
 *   - 默认 session 模式：身份**只**来自服务端会话（Authorization: Bearer 或
 *     Cookie ccer_session）；请求头 x-user-id 与查询参数 ?user= 一律忽略。
 *   - dev 模式（必须显式开启，仅本地演示）：才允许 x-user-id / ?user= 直连，
 *     启动时打印醒目警告；与 CCER_ALLOW_REMOTE=1 组合时拒绝启动。
 *
 * 启动：node src/server.mjs            （默认 http://127.0.0.1:8787）
 * 环境：PORT / HOST / CCER_DB_PATH / CCER_AUTH_MODE / CCER_ALLOW_REMOTE
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { getDb, dbPath, metaValue } from './core/db.mjs';
import { ensureSeeded } from './services/seed.mjs';
import * as auth from './services/auth-svc.mjs';
import * as projects from './services/project-svc.mjs';
import * as engine from './services/engine.mjs';
import * as calc from './services/calc-svc.mjs';
import * as reports from './services/report-svc.mjs';
import * as radar from './services/radar-svc.mjs';
import { FACT_FIELDS, FACT_GROUP_ORDER, SOURCE_KIND_LABELS } from './data/fact-fields.mjs';
import { listMethodologyModules, collectSelfCheckSamples } from './methodologies/index.mjs';
import { standardCodes } from './data/standard-codes.mjs';
import { V2_ROUTES } from './routes-v2.mjs';
import { v2Status } from './services/v2-guard.mjs';
import { registerUser } from './services/registration-svc.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

/**
 * v2 公开信息平台是否启用（与 routes-v2 的判定一致）。
 * 启用时：根路径导向 /v2，且旧版「内部项目 / 项目录入 / 尽调 / 投资审批 / 人工复核」
 * 相关 API 一律返回 410，不依赖前端隐藏入口（docs/22 第 18 条）。
 */
const V2_ACTIVE = process.env.CCER_ENABLE_V2 === '1';

/**
 * v2 启用时必须停用的旧 v1 业务接口（前缀匹配）。
 * 只停用私有/审批/内部项目类接口：健康检查、认证、公开数据类接口保留，
 * 且所有旧的 410 响应都带明确说明，不是 404 或 500。
 */
const V1_RETIRED_PREFIXES = [
  '/api/projects',            // 内部项目档案、事实、证据、匹配、条件检查
  '/api/calculations',        // 依赖项目档案的计算运行
  '/api/reviews',             // 人工审核队列与决定
  '/api/reports',             // 项目报告与审核放行
  '/api/dashboard',           // 旧投资雷达工作台
  '/api/subscriptions',       // 旧订阅（人工跟踪）
];
const V1_RETIRED_EXACT = new Set([
  '/api/admin/plugins',
  '/api/admin/demo-channel',
]);

function retiredV1Payload(pathname) {
  return {
    status: 410,
    body: {
      error: '该旧版功能已停用',
      retired: true,
      path: pathname,
      message:
        '本服务已升级为「CCER 公开信息平台」（v2）：不再提供内部项目档案、项目录入、尽调、' +
        '投资审批、人工复核/审核队列与专家签字。采集、核验与发布全部自动化。',
      use_instead: ['/v2', '/api/v2/content', '/api/v2/public-projects', '/api/v2/policies', '/api/v2/trade'],
    },
  };
}

/**
 * 免登录接口白名单（仅这三条）：
 *   - /api/health        健康检查（只返回版本、模式等非敏感信息，不含任何业务数据）
 *   - /api/auth/login    登录本身
 *   - /api/auth/register 公开注册（只创建 viewer 账号，不签发会话）
 * 其余 /api/* 一律要求有效会话。GET / 与 web/ 静态资源无需会话
 * （它们只有前端骨架，不含任何数据）。
 */
const AUTH_ALLOW_LIST = new Set(['/api/health', '/api/auth/login', '/api/auth/register']);


/* --------------------------- 请求辅助 --------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, mime = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'content-type': mime, 'content-length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

async function readBody(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('请求体过大（超过 32 MB）');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  // v2 启用时：根路径与旧版工作台页面统一导向新版公开信息平台，
  // 避免用户默认进入旧版投资筛选 / 人工审批工作台（docs/22 第 10、18 条）。
  if (V2_ACTIVE) {
    if (p === '/' || p === '' || p === '/index.html') {
      res.writeHead(302, { location: '/v2', 'cache-control': 'no-store' });
      return res.end();
    }
    // 旧版静态资源（web/app.js、web/styles.css）不再对外提供，避免旧工作台被直接打开
    if (p === '/app.js' || p === '/styles.css') {
      return sendText(res, 410, '旧版工作台已停用，请使用新版公开信息平台：/v2', 'text/plain; charset=utf-8');
    }
  }
  if (p === '/' || p === '') p = '/index.html';
  // v2 八模块工作台：/v2 与 /v2/... 都指向 web/v2/index.html（前端使用 hash 路由）
  if (p === '/v2' || p === '/v2/' || p === '/v2/index.html') p = '/v2/index.html';
  const safe = normalize(p).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const full = join(WEB_DIR, safe);
  if (!full.startsWith(WEB_DIR)) return sendText(res, 403, '禁止访问');
  try {
    const data = await readFile(full);
    const mime = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    sendText(res, 404, `未找到静态资源：${p}`, 'text/plain; charset=utf-8');
  }
}

/* --------------------------- 路由表 --------------------------- */
/* 每项：[方法, 路径模式, 处理函数]；路径段以 : 开头表示参数 */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const rp = r.pattern.split('/').filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i += 1) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (rp[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/* --------------------------- 系统 --------------------------- */

route('GET', '/api/health', async () => ({
  ok: true,
  app: 'CCER 公开信息平台',
  product_note:
    '只整合公开资料：政策与方法学、公开项目、交易信息、减排粗估、研报与行业动态。' +
    '采集与核验完全自动化，不含内部项目档案与人工审核环节。',
  version: '2.7.0',
  version_note: 'v2.7：DeepSeek 搜索与抓取备用、指定页视觉补充、工具化多轮问答与结构化输出加固（见 docs/54、docs/55、docs/56）。',
  database: dbPath(),
  calculator_gate_mode: metaValue('calculator_gate_mode', 'strict'),
  demo_channel_enabled: metaValue('demo_channel_enabled', 'false') === 'true',
  auth_mode: auth.authMode(),
  auth_note: '身份只来自服务端会话；x-user-id 与 ?user= 仅在 dev 演示模式生效。',
  registered_plugins: listMethodologyModules().map((m) => `${m.meta.methodology_id}::${m.meta.version}`),
  self_check_samples: collectSelfCheckSamples().length,
  v2: v2Status(),
  disclaimer: '判断与测算均为筛选辅助结果，须由分析师复核。',
}));

/* --------------------------- 认证与会话 --------------------------- */

function isHttpsFromLocalProxy(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return local && req.headers['x-forwarded-proto'] === 'https';
}

route('POST', '/api/auth/login', async (ctx) => {
  // 正式部署：此处应替换为机构统一身份认证（SSO/OIDC）的身份断言校验，
  // 当前的「演示口令」只是原型占位机制（见 src/data/users.mjs 文件头说明）。
  // v2：若账号已由管理员设置服务端口令（scrypt 哈希），则优先校验哈希并记录登录日志。
  const out = auth.loginWithPassphrase(ctx.body.user_id, ctx.body.password, {
    ip: ctx.ip,
    userAgent: ctx.req?.headers?.['user-agent'] || null,
  });
  if (!out.ok) return { status: out.status, body: { error: out.error, locked_until: out.locked_until || null } };
  return {
    raw: {
      mime: 'application/json; charset=utf-8',
      body: JSON.stringify(
        {
          token: out.token,
          expires_at: out.expires_at,
          // 只返回身份字段，绝不返回口令；库里也只有令牌摘要
          user: { id: out.user.id, name: out.user.name, role: out.user.role, team_id: out.user.team_id },
          auth_mode: auth.authMode(),
          must_change_password: !!out.must_change_password,
        },
        null,
        2
      ),
      // Cookie 与 Authorization 两种回传方式同时支持；令牌禁止走查询参数
      headers: { 'set-cookie': auth.sessionCookie(out.token, { secure: isHttpsFromLocalProxy(ctx.req) }) },
    },
  };
});

/* 公开注册：未登录可用，只创建 viewer 账号（普通团队），不签发会话。
 * 角色/团队/启用状态等账号属性由服务端固定；客户端传入 role/team_id/active 等
 * 提权字段一律 400 拒绝（见 src/services/registration-svc.mjs）。 */
route('POST', '/api/auth/register', async (ctx) => {
  const out = registerUser(ctx.body || {}, {
    ip: ctx.ip,
    userAgent: ctx.req?.headers?.['user-agent'] || null,
  });
  if (!out.ok) {
    const body = { error: out.error };
    if (out.message) body.message = out.message;
    if (out.issues && out.issues.length) body.issues = out.issues;
    return { status: out.status || 400, body };
  }
  // 不返回 token / 不写会话 Cookie：注册成功后由用户自行回登录页登录
  return {
    status: 201,
    body: {
      ok: true,
      user: out.user,
      message: out.message,
      login_endpoint: out.login_endpoint,
    },
  };
});

route('POST', '/api/auth/logout', async (ctx) => {
  const done = auth.destroySession(ctx.token, {
    actor: ctx.user ? ctx.user.name : null,
    actorRole: ctx.user ? ctx.user.role : null,
    ip: ctx.ip,
  });
  return {
    raw: {
      mime: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: true, revoked: done, message: '已退出登录' }, null, 2),
      headers: { 'set-cookie': auth.clearSessionCookie({ secure: isHttpsFromLocalProxy(ctx.req) }) },
    },
  };
});

route('GET', '/api/auth/me', async (ctx) => {
  const mode = auth.authMode();
  return {
    user: { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, team_id: ctx.user.team_id },
    auth_mode: mode,
    dev_mode: mode === 'dev',
    session: {
      id: ctx.session ? ctx.session.session_id : null,
      expires_at: ctx.session ? ctx.session.session_expires_at : null,
      source: ctx.identity_source,
    },
    warning: mode === 'dev' ? '当前为 dev 演示模式：服务端直接信任 x-user-id / ?user=，认证已关闭。' : null,
  };
});

route('GET', '/api/admin/sessions', async (ctx) => {
  const out = auth.listSessions(ctx.user);
  if (out.error) return { status: out.status, body: out };
  return { sessions: out, total: out.length, note: '仅返回活跃会话；令牌摘要不会通过接口返回。' };
});

route('DELETE', '/api/admin/sessions/:id', async (ctx) => {
  // 管理员专属：非管理员一律 403（不得依赖前端隐藏入口）
  const denied = projects.requireRole(ctx.user, ['admin'], '撤销他人会话');
  if (denied) return { status: denied.status, body: denied };
  const out = auth.revokeSessionById(ctx.params.id, ctx.user);
  if (out.error) return { status: out.status, body: out };
  return { ok: true, revoked: true, session_id: out.id, message: '会话已撤销' };
});


route('GET', '/api/dashboard', async (ctx) => radar.dashboard(ctx.user));
route('GET', '/api/users', async () => projects.ROLES.map((r) => ({ role: r, label: projects.ROLE_LABELS[r] })));

route('GET', '/api/meta/fact-fields', async () => ({
  fields: FACT_FIELDS,
  group_order: FACT_GROUP_ORDER,
  source_kind_labels: SOURCE_KIND_LABELS,
}));

route('GET', '/api/meta/standard-codes', async () => standardCodes());

/* --------------------------- 方法学库 --------------------------- */

route('GET', '/api/methodologies', async (ctx) => {
  const { status, domain, keyword } = ctx.query;
  let list = engine.listMethodologyVersions();
  if (status) list = list.filter((m) => m.document_status === status);
  if (domain) list = list.filter((m) => m.domain === domain);
  if (keyword) {
    const k = String(keyword).toLowerCase();
    list = list.filter(
      (m) => m.name.toLowerCase().includes(k) ||
        String(m.methodology_id).toLowerCase().includes(k) ||
        String(m.code_display || '').toLowerCase().includes(k)
    );
  }
  const modules = new Map(listMethodologyModules().map((m) => [`${m.meta.methodology_id}::${m.meta.version}`, m]));
  return {
    formal: list.filter((m) => m.document_status === 'formal').map((m) => decorate(m, modules)),
    draft: list.filter((m) => m.document_status !== 'formal').map((m) => decorate(m, modules)),
    counts: {
      formal: list.filter((m) => m.document_status === 'formal').length,
      draft: list.filter((m) => m.document_status !== 'formal').length,
      candidate_eligible: list.filter((m) => m.document_status === 'formal' && m.is_candidate_eligible).length,
    },
    note: '正式发布与征求意见分栏展示；草案仅作观察项，不得列为可申报候选或用于计算。',
  };
});

function decorate(m, modules) {
  const mod = modules.get(`${m.methodology_id}::${m.version}`);
  return {
    id: m.id,
    methodology_id: m.methodology_id,
    code_display: m.code_display,
    name: m.name,
    version: m.version,
    document_status: m.document_status,
    domain: m.domain,
    project_types: m.project_types,
    tech_routes: m.tech_routes,
    scale_note: m.scale_note,
    release_date: m.release_date,
    effective_date: m.effective_date,
    official_url: m.official_url,
    rulecard_status: m.rulecard_status,
    calculator_status: m.calculator_status,
    catalog_confidence: m.catalog_confidence,
    is_candidate_eligible: !!m.is_candidate_eligible,
    exclusion_note: m.exclusion_note,
    supersedes_id: m.supersedes_id,
    has_rulecard_module: !!mod?.rulecard?.length,
    has_plugin_module: !!mod?.plugin,
    plugin_version: mod?.plugin?.plugin_version || null,
    // 业务测算可用性：必须插件已审批、无占位系数、条款页码齐全。
    // 与 calc-svc.assertCalculationPreconditions 保持同一判据，避免界面与后端不一致。
    auto_calculation: (() => {
      if (!mod?.plugin) return '暂不支持自动测算（无插件）';
      const ph = mod.plugin.factors.filter((f) => f.value_status === 'placeholder');
      const pend = mod.plugin.formula_refs.filter(
        (f) => !f.clause_ref || f.clause_ref.includes('【占位】') || f.clause_ref.includes('待对照')
      );
      if (m.calculator_status !== 'approved') return `暂不支持自动测算（审批状态：${m.calculator_status}）`;
      if (ph.length) return `暂不支持自动测算（含 ${ph.length} 项未确认占位系数）`;
      if (pend.length) return `暂不支持自动测算（有 ${pend.length} 条公式缺条款页码）`;
      return '可出数（业务通道）';
    })(),
  };
}

route('GET', '/api/methodologies/:id', async (ctx) => {
  const versions = engine.listMethodologyVersions().filter((m) => m.id === ctx.params.id);
  if (!versions.length) return { status: 404, body: { error: '方法学版本不存在' } };
  const m = versions[0];
  const rules = ctx.db.all(
    'SELECT * FROM rule WHERE methodology_version_id = ? ORDER BY sort_order',
    [m.id]
  ).map((r) => ({ ...r, expr: JSON.parse(r.expr), required_fields: JSON.parse(r.required_fields) }));
  const formulas = ctx.db.all('SELECT * FROM formula WHERE methodology_version_id = ?', [m.id]);
  const factors = ctx.db.all(
    'SELECT * FROM factor_version WHERE methodology_version_id = ? OR methodology_version_id = ?',
    [`${m.methodology_id}::${m.version}`, '']
  );
  const mod = listMethodologyModules().find(
    (x) => x.meta.methodology_id === m.methodology_id && x.meta.version === m.version
  );
  return {
    version: decorate(m, new Map([[`${m.methodology_id}::${m.version}`, mod]])),
    rules,
    formulas,
    factors,
    plugin: mod?.plugin
      ? {
          plugin_key: mod.plugin.plugin_key,
          plugin_version: mod.plugin.plugin_version,
          title: mod.plugin.title,
          status_note: mod.plugin.status_note,
          formula_refs: mod.plugin.formula_refs,
          parameters: mod.plugin.parameters,
          scenarios: mod.plugin.scenarios,
          self_check_samples: mod.plugin.selfCheckSamples,
        }
      : null,
    change_log: m.change_log,
  };
});

/* --------------------------- 来源与雷达 --------------------------- */

route('GET', '/api/sources', async (ctx) => ({ sources: radar.listSources(ctx.query) }));
route('POST', '/api/sources', async (ctx) => {
  const denied = projects.requireRole(ctx.user, ['admin', 'researcher'], '新增来源');
  if (denied) return { status: denied.status, body: denied };
  return { status: 201, body: radar.createSource(ctx.user, ctx.body) };
});

route('POST', '/api/sources/sync', async (ctx) => {
  const out = await radar.syncSources(ctx.user, {
    timeoutMs: ctx.body.timeoutMs ? Number(ctx.body.timeoutMs) : 15000,
    dryRun: !!ctx.body.dryRun,
  });
  if (out.error) return { status: out.status || 400, body: out };
  return out;
});

route('GET', '/api/source-changes', async (ctx) => ({
  changes: radar.listSourceChanges(Number(ctx.query.limit) || 100),
}));
route('POST', '/api/source-changes/:id/confirm', async (ctx) => {
  const out = radar.confirmSourceChange(ctx.user, ctx.params.id, ctx.body);
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});

route('GET', '/api/alerts', async (ctx) => ({ alerts: radar.listAlerts(ctx.query), grouped: radar.alertsForSubscriptions() }));
route('PATCH', '/api/alerts/:id', async (ctx) => {
  const denied = projects.requireRole(ctx.user, ['admin', 'researcher', 'reviewer'], '变更告警状态');
  if (denied) return { status: denied.status, body: denied };
  const out = radar.updateAlert(ctx.user, ctx.params.id, ctx.body.status);
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});
route('GET', '/api/subscriptions', async () => ({ subscriptions: radar.listSubscriptions() }));
route('POST', '/api/subscriptions', async (ctx) => {
  const denied = projects.requireRole(ctx.user, ['admin', 'researcher', 'analyst', 'reviewer'], '创建订阅');
  if (denied) return { status: denied.status, body: denied };
  return { status: 201, body: radar.createSubscription(ctx.user, ctx.body) };
});
route('GET', '/api/audit', async (ctx) => {
  const out = radar.listAudit(ctx.user, ctx.query);
  return Array.isArray(out) ? { audit: out } : { status: out.status, body: out };
});

/* --------------------------- 项目 --------------------------- */

route('GET', '/api/projects', async (ctx) => ({ projects: projects.listProjects(ctx.user, ctx.query) }));
route('POST', '/api/projects', async (ctx) => {
  const denied = projects.requireRole(ctx.user, ['admin', 'researcher', 'analyst'], '创建项目');
  if (denied) return { status: denied.status, body: denied };
  return { status: 201, body: projects.createProject(ctx.user, ctx.body) };
});

route('GET', '/api/projects/:id', async (ctx) => {
  const out = projects.getProjectFull(ctx.user, ctx.params.id);
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});

route('PATCH', '/api/projects/:id/registry', async (ctx) => {
  const out = projects.updateProjectRegistry(ctx.user, ctx.params.id, ctx.body);
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});

route('GET', '/api/projects/:id/facts', async (ctx) => {
  const out = projects.getProjectFull(ctx.user, ctx.params.id);
  return out.error ? { status: out.status, body: out } : { status: 200, body: { facts: out.facts } };
});

route('POST', '/api/projects/:id/facts', async (ctx) => {
  const out = projects.upsertFact(ctx.user, ctx.params.id, ctx.body);
  return out.error ? { status: out.status, body: out } : { status: 201, body: out };
});

route('POST', '/api/projects/:id/evidence', async (ctx) => {
  const out = projects.addEvidence(ctx.user, ctx.params.id, ctx.body);
  return out.error ? { status: out.status, body: out } : { status: 201, body: out };
});

route('GET', '/api/projects/:id/runs', async (ctx) => {
  const access = projects.requireProjectAccess(ctx.user, ctx.params.id);
  if (access.error) return { status: access.status, body: access };
  return projects.listRuns(ctx.params.id);
});

/* --------------------------- 匹配 / 条件检查 --------------------------- */

route('POST', '/api/projects/:id/match', async (ctx) => {
  const out = engine.runMatch(ctx.user, ctx.params.id, ctx.body || {});
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});

route('POST', '/api/projects/:id/eligibility', async (ctx) => {
  const out = engine.runEligibility(ctx.user, ctx.params.id, ctx.body || {});
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});

route('GET', '/api/projects/:id/eligibility', async (ctx) => {
  const access = projects.requireProjectAccess(ctx.user, ctx.params.id);
  if (access.error) return { status: access.status, body: access };
  const latest = projects.latestEligibilityRun(ctx.params.id);
  const history = engine.eligibilityHistory(ctx.params.id);
  return { latest, history };
});

/* --------------------------- 计算 --------------------------- */

route('POST', '/api/projects/:id/calculate', async (ctx) => {
  const out = calc.runCalculation(ctx.user, ctx.params.id, ctx.body || {});
  if (out.error) return { status: out.status || 400, body: out };
  // 前置条件未满足（审批未通过 / 含占位系数 / 缺条款页码 / 无条件检查快照 / 存在硬障碍）
  // 属于业务性拒绝，返回 409 并说明具体原因，不产生任何数值。
  if (out.rejected && out.kind === 'precondition') return { status: 409, body: out };
  // 输入校验未通过（单位错误 / 超范围 / 期间重叠）：返回 422
  if (out.rejected) return { status: 422, body: out };
  return { status: 200, body: out };
});

route('GET', '/api/projects/:id/calculations', async (ctx) => {
  const access = projects.requireProjectAccess(ctx.user, ctx.params.id);
  if (access.error) return { status: access.status, body: access };
  return { runs: calc.listCalculationRuns(ctx.params.id) };
});
route('GET', '/api/calculations/:id', async (ctx) => {
  const out = calc.getCalculationRun(ctx.params.id);
  if (!out) return { status: 404, body: { error: '计算运行不存在' } };
  const access = projects.requireProjectAccess(ctx.user, out.project_id);
  if (access.error) return { status: access.status, body: access };
  return { calculation: out };
});

route('GET', '/api/calculations', async (ctx) => {
  const { a, b } = ctx.query;
  if (!a || !b) return { status: 400, body: { error: '需要 a 与 b 两个计算运行 ID' } };
  const runA = calc.getCalculationRun(a);
  const runB = calc.getCalculationRun(b);
  if (!runA || !runB) return { status: 404, body: { error: '计算运行不存在' } };
  const access = projects.requireProjectAccess(ctx.user, runA.project_id);
  if (access.error) return { status: access.status, body: access };
  const out = calc.compareRuns(a, b);
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});

/* --------------------------- 报告与审核 --------------------------- */

route('POST', '/api/projects/:id/report', async (ctx) => {
  const out = reports.generateReport(ctx.user, ctx.params.id, ctx.body || {});
  return out.error ? { status: out.status, body: out } : { status: 201, body: out };
});

route('GET', '/api/projects/:id/reports', async (ctx) => {
  const out = reports.listReports(ctx.user, ctx.params.id);
  return out.error ? { status: out.status, body: out } : { status: 200, body: { reports: out } };
});

route('GET', '/api/reports/:id/export', async (ctx) => {
  const out = reports.exportReport(ctx.user, ctx.params.id, ctx.query.format || 'markdown');
  if (out.error) return { status: out.status, body: out };
  const encoded = encodeURIComponent(out.file_name);
  return {
    raw: {
      mime: out.mime,
      body: out.body,
      headers: { 'content-disposition': `attachment; filename*=UTF-8''${encoded}` },
    },
  };
});

route('GET', '/api/reviews/pending', async (ctx) => {
  const denied = projects.requireRole(ctx.user, ['admin', 'researcher', 'reviewer'], '查看待审列表');
  if (denied) return { status: denied.status, body: denied };
  return reports.listPendingReviews();
});
route('POST', '/api/reviews', async (ctx) => {
  const out = reports.decideReview(ctx.user, ctx.body || {});
  return out.error ? { status: out.status, body: out } : { status: 201, body: out };
});

/* --------------------------- 管理后台 --------------------------- */

route('GET', '/api/admin/plugins', async () => ({
  gate_mode: metaValue('calculator_gate_mode', 'strict'),
  demo_channel: calc.demoChannelState(),
  plugins: calc.methodologyPluginStatus(),
}));

/** 演示通道状态与各方法学的业务测算可用性 */
route('GET', '/api/admin/demo-channel', async () => ({
  ...calc.demoChannelState(),
  plugins: calc.methodologyPluginStatus(),
}));

/** 开启 / 关闭演示通道（仅管理员）。开启后仍不产生可用于投资筛选报告的数字。 */
route('POST', '/api/admin/demo-channel', async (ctx) => {
  const denied = projects.requireRole(ctx.user, ['admin'], '切换演示通道');
  if (denied) return { status: denied.status, body: denied };
  const enabled = ctx.body && (ctx.body.enabled === true || ctx.body.enabled === 'true');
  const out = calc.setDemoChannel(enabled, ctx.user, ctx.body && ctx.body.note);
  return out.error ? { status: out.status, body: out } : { status: 200, body: out };
});

/**
 * 方法学规则卡 / 计算插件审批。
 * 审批是业务测算放行的唯一途径；仍有占位系数或缺条款页码时不允许批准计算插件。
 */
route('POST', '/api/admin/methodology/:id/approve', async (ctx) => {
  const denied = projects.requireRole(ctx.user, ['admin', 'reviewer'], '执行方法学审批');
  if (denied) return { status: denied.status, body: denied };
  const out = calc.approveMethodology(ctx.user, ctx.params.id, {
    target: ctx.body && ctx.body.target,
    decision: ctx.body && ctx.body.decision,
    comment: ctx.body && ctx.body.comment,
  });
  return out.error ? { status: out.status || 400, body: out } : { status: 200, body: out };
});

/* --------------------------- 主处理 --------------------------- */

/* v2 六模块路由（/api/v2/*）：追加到同一张路由表，v1 接口与历史行为不受影响。
 * 未开启 v2（CCER_ENABLE_V2≠1）时这些接口返回 503 与明确说明，不会写库。 */
for (const [method, pattern, handler] of V2_ROUTES) route(method, pattern, handler);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  // 仅回环访问（设计文档第 8 节：内网或私有服务器部署）
  const remote = req.socket.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLoopback && process.env.CCER_ALLOW_REMOTE !== '1') {
    return sendJson(res, 403, { error: '本服务默认仅允许回环访问，如需内网开放请设置 CCER_ALLOW_REMOTE=1' });
  }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(res, pathname);
  }

  // v2 启用时：旧私有/审批业务接口明确停用（410），不能成为绕过权限或自动核验的入口
  if (V2_ACTIVE) {
    const hit =
      V1_RETIRED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
      V1_RETIRED_EXACT.has(pathname);
    if (hit) {
      const r = retiredV1Payload(pathname);
      return sendJson(res, r.status, r.body);
    }
  }

  const m = matchRoute(req.method, pathname);
  if (!m) {
    return sendJson(res, 404, { error: `未找到接口：${req.method} ${pathname}`, hint: 'GET /api/health' });
  }

  /* ---- 身份判定：会话为准，白名单放行，其余一律 401 ----
   * 1) session 模式（默认、生产）：身份**只**能来自能解析出有效会话的令牌；
   *    请求头 x-user-id 与查询参数 user= 被完全忽略（不报错、不记录）。
   * 2) dev 模式（仅本地演示）：自报身份（x-user-id / ?user=）优先，会话作为回退；
   *    启动时会打印醒目警告横幅。
   * 3) /api/health 与 /api/auth/login 在白名单内，无需会话。
   */
  const token = auth.resolveToken(req);
  const session = auth.resolveSession(token);
  const devMode = auth.authMode() === 'dev';
  const devUserId = devMode ? req.headers['x-user-id'] || url.searchParams.get('user') || undefined : undefined;
  const devUser = devMode ? projects.resolveUser(devUserId) : null;
  // dev 模式下显式的自报身份优先于会话身份（前端「演示模式：可直接切换身份」即依赖此分支）；
  // session 模式下 devUser 恒为 null，身份只能来自会话。
  const user = devUser || session;
  const identitySource = devUser ? 'dev_header' : session ? 'session' : 'none';
  const allowedWithoutSession = AUTH_ALLOW_LIST.has(pathname);

  if (!user && !allowedWithoutSession) {
    return sendJson(res, 401, {
      error: '未认证',
      message: '请先登录（POST /api/auth/login）并携带会话令牌（Authorization: Bearer 或 Cookie ccer_session）。',
      auth_mode: auth.authMode(),
      login_endpoint: '/api/auth/login',
    });
  }

  // 请求体解析在业务 try 之外，确保「超限 / 非法 JSON」返回 400 而不是 500
  let body = {};
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: '请求体解析失败', message: e.message });
    }
  }

  try {
    const ctx = {
      user,
      session,
      token,
      auth_mode: auth.authMode(),
      identity_source: identitySource,
      ip: req.socket.remoteAddress || null,
      body,
      params: m.params,
      query: Object.fromEntries(url.searchParams.entries()),
      req,
      rawDb: null,
      db: {
        all: (sql, params) => getDb().prepare(sql).all(...params),
        get: (sql, params) => {
          const r = getDb().prepare(sql).get(...params);
          return r === undefined ? null : r;
        },
        run: (sql, params) => getDb().prepare(sql).run(...params),
      },
    };
    const out = await m.handler(ctx);

    /* ---- 统一响应规约 ----
     * 1) { raw: { mime, body, headers } }            → 原始文件下载
     * 2) { status, body }                            → 显式信封
     * 3) { error, status? }                          → 业务错误
     * 4) { rejected: true, ... }                     → 422 校验未通过而拒绝出数（业务结果）
     * 5) { status: 200|201, ...其余字段 }             → 成功，剥掉数字型 status 标记
     * 6) 其他对象 / 数组                              → 200 直接返回
     */
    if (out && out.raw) {
      return sendText(res, 200, out.raw.body, out.raw.mime, out.raw.headers || {});
    }
    if (out && typeof out === 'object' && out.body !== undefined && typeof out.status === 'number') {
      return sendJson(res, out.status, out.body);
    }
    if (out && out.error) {
      return sendJson(res, out.status || 400, out);
    }
    if (out && out.rejected) {
      const { status, ...rest } = out;
      void status;
      return sendJson(res, 422, rest);
    }
    let payload = out;
    let code = 200;
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.status === 'number') {
      code = payload.status === 201 ? 201 : 200;
      const { status, ...rest } = payload;
      void status;
      payload = rest;
    }
    return sendJson(res, code, payload);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${pathname} 处理失败：`, e);
    return sendJson(res, 500, {
      error: '服务端处理失败',
      message: e?.message || String(e),
      path: pathname,
      trace: String(e?.stack || '').split('\n').slice(0, 4),
    });
  }
});

/* --------------------------- 启动 --------------------------- */
/* 直接以 `node src/server.mjs` 运行时自动监听；被测试或其他模块 import 时只导出
 * server 实例，由调用方自行 listen(0)（避免与已运行的服务争抢端口）。 */

const isMainModule =
  !!process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();

/**
 * 启动服务（供 `node src/server.mjs` 与 scripts/v2-start.mjs 共用）。
 * @param {{port?:number, host?:string}} [opts]
 * @returns {Promise<import('node:http').Server>}
 */
export async function startServer({ port = PORT, host = HOST } = {}) {
  getDb();
  const seeded = ensureSeeded();
  if (seeded) console.log('检测到空库，已自动完成初始化与方法学目录种子写入。');

  // 启动期安全策略：dev 模式与「允许远程访问」不得同时出现 —— 以明确的中文错误退出。
  // enforceStartupPolicy() 抛出的错误未捕获时，Node 以非零码退出，配置不会被静默放宽。
  const policy = auth.enforceStartupPolicy();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      console.log('');
      console.log('  CCER 公开信息平台已启动');
      console.log('  ─────────────────────────────────────────────');
      if (V2_ACTIVE) {
        console.log(`  公开信息平台（八模块）：${url}/v2　← 根路径 ${url}/ 会自动跳转到此`);
        console.log('  旧版 v1 私有/审批接口：已停用（返回 410）；公开数据请使用 /api/v2/*');
      } else {
        console.log(`  公开信息平台（八模块）：${url}/v2（当前未启用 v2：CCER_ENABLE_V2≠1）`);
        console.log(`  v1 历史工作台：${url}`);
      }
      console.log(`  接口健康检查：${url}/api/health`);
      console.log(`  数据库：${dbPath()}`);
      console.log(`  计算门禁：${metaValue('calculator_gate_mode', 'strict')}　｜　演示通道：${metaValue('demo_channel_enabled', 'false') === 'true' ? '已开启（隔离的反事实演示）' : '关闭'}`);
      console.log(`  身份认证：${auth.authMode()}`);
      console.log(`  认证模式来源：${policy.source}`);
      for (const line of auth.authStartupBanner(policy.mode)) console.log(line);
      const v2 = v2Status();
      console.log(`  v2 状态：${v2.ok ? '已启用' : '未启用'}`);
      if (v2.production_db) {
        console.log('  ⚠ 当前库路径等于在用生产库 data/ccer.db：v2 只读展示，写操作（采集/导入/核对）一律被拒绝。');
      }
      console.log(`  v2 说明：${v2.message}`);
      if (v2.ok && process.env.CCER_DAILY_SYNC === '1') {
        import('./services/daily-scheduler.mjs').then((m) => m.startDailyScheduler())
          .catch((e) => console.error(`  每日调度未启动：${e.message}`));
      }
      // 入库摘要 worker 与 06:30 每日调度相互独立：默认随 v2 服务启动，
      // 可显式用 CCER_INGEST_SUMMARY_WORKER=0 停用；生产只读库不启动写入型 worker。
      if (v2.ok && !v2.production_db) {
        import('./services/ingest-summary-svc.mjs').then(async (m) => {
          const st = m.startIngestSummaryWorker();
          if (st.started) {
            console.log(`  入库摘要队列：已启动（${st.config.interval_ms / 1000} 秒周期，单批 ≤${st.config.batch_size} 条 / ${st.config.budget_ms / 1000} 秒）`);
            try {
              const filled = m.enqueueMissedContentSummaries({ limit: 20, actor: 'system:startup-backfill', source: 'startup_backfill' });
              if (filled.queued) console.log(`  入库摘要队列：启动兜底补入 ${filled.queued} 条漏队内容`);
            } catch { /* 兜底失败不影响服务，队列状态接口可见 */ }
          } else {
            console.log(`  入库摘要队列：未启动（${st.reason}）`);
          }
        }).catch((e) => console.error(`  入库摘要队列未启动：${e.message}`));
      }
      server.on('close', () => {
        import('./services/ingest-summary-svc.mjs').then((m) => m.stopIngestSummaryWorker({ reason: 'server_close' })).catch(() => {});
      });
      console.log('  ─────────────────────────────────────────────');
      console.log(process.env.CCER_ENABLE_V2 === '1'
        ? '  提示：公开资料自动采集与核验；减排量为规模粗估。'
        : '  提示：本服务默认仅允许回环访问；判断与测算结果均须分析师复核。');
      console.log('');
      resolve(server);
    });
  });
}

if (isMainModule) {
  await startServer();
}

export { server, AUTH_ALLOW_LIST };
