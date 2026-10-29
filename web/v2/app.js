/**
 * v2 工作台 · 应用骨架（路由 / API 客户端 / 全局状态）
 * ============================================================================
 * 固定一级导航（docs/19「产品定位与导航」，docs/34 起为八模块）：八个主模块
 *   总览｜政策和方法学｜公开项目｜交易信息｜碳计算与因子｜研报与行业动态｜后台管理
 * 路由：hash 路由（#/、#/policies、#/projects、#/trades、#/measure、#/content、#/admin），
 *       支持二级参数（如 #/content?tab=research_report&q=煤矿瓦斯）用于钻取。
 *
 * 【本轮升级】不再提供内部项目、项目录入、尽调与投资审批入口，
 * 也不再提供任何人工审核 / 复核 / 待办入口：采集与核验完全自动化。
 *
 * 安全相关：身份由服务端会话决定（Cookie / Bearer）；前端不发送 x-user-id，
 * 也不把用户写入 localStorage；401 时显示登录面板。
 */
import { toast, errorState, loading, esc, setTablePage, dateTime } from './ui.js';
import { renderOverview } from './modules/overview.js';
import { renderPolicies } from './modules/policies.js';
import { renderProjects } from './modules/projects.js';
import { renderTrades } from './modules/trades.js';
import { renderCea } from './modules/cea.js';
import { renderMeasure } from './modules/measure.js';
import { renderContent } from './modules/content.js';
import { renderAdmin } from './modules/admin.js';
import { renderSearch } from './modules/search.js';

export const state = {
  user: null,
  authMode: null,
  route: { name: 'overview', query: {} },
  sync: null,
  v2: null,
  demoProjects: 0,
  demoContent: 0,
  contentStats: null,
  caliber: new Map(),
};

let activeCleanup = null;
let renderSeq = 0;

const MODULES = [
  { key: 'overview', label: '总览', icon: 'overview', render: renderOverview, desc: '最新政策、方法与项目分布、量价趋势、CEA 配额市场概况、最新研报与动态', summary: 'CCER 与 CEA 公开信息的综合视图，指标和图表跟随筛选。' },
  { key: 'policies', label: '政策和方法学', icon: 'policies', render: renderPolicies, desc: '全国 CCER 规则、配套技术文件与相关部委政策；CEA 配额政策入口、方法学原文与自动解读', summary: '官方政策原文、方法学文件与自动解读，按发布机关和状态归档。' },
  { key: 'projects', label: '公开项目', icon: 'projects', render: renderProjects, desc: 'CCER 公开项目与减排量公示、登记等可查阶段；CEA 重点排放单位名录入口（仅公开资料）', summary: 'CCER 公开项目与减排量公示、登记等可查阶段。' },
  { key: 'trades', label: '交易信息', icon: 'trades', render: renderTrades, desc: 'CCER 官方市场量价、CEA 独立行情与 CEA/CCER 同日对比、区间汇总与 CSV/JSON 下载', summary: 'CCER 与 CEA 官方行情、区间汇总与来源口径。' },
  { key: 'cea', label: 'CEA市场', icon: 'cea', render: renderCea, desc: '全国碳排放配额：行情与口径分层、政策配额、履约日历、企业名录、交易意向、成本情景、研报动态、来源与缺口', summary: '全国碳排放配额的行情、政策、履约与公开主体信息。' },
  { key: 'measure', label: '碳计算与因子', icon: 'measure', render: renderMeasure, desc: '低浓度煤矿瓦斯粗估、碳排放计算（外购电力/燃料燃烧）、公开排放因子库、标准规范与资料来源', summary: '低浓度煤矿瓦斯粗估、排放计算，以及公开因子与规范。' },
  { key: 'content', label: '研报与行业动态', icon: 'content', render: renderContent, desc: '公开研报、行业动态、机构观点与企业公告；含 CEA 研报与行业动态入口', summary: '公开研报、行业动态、机构观点与企业公告，来源优先。' },
  { key: 'admin', label: '后台管理', icon: 'admin', render: renderAdmin, desc: '采集连接、CEA 配额市场配置与采集、搜索 API/MCP、模型配置、自动核验策略、每日任务与用户管理', summary: '采集连接、数据源、核验、任务与用户配置。' },
];

/* 统一检索是顶栏入口 + 独立页，不增加一级导航（既有验收要求 8 个主模块）。 */
const SEARCH_MODULE = {key:'search',label:'统一检索',icon:'search',summary:'跨政策、方法学、公开项目、研报动态、CEA 文件、排放因子与企业名录检索。'};

/* 统一线性图标：24×24、1.7px 描边、圆角端点和连接点。 */
const NAV_ICON_PATHS = {
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  policies: '<path d="M7 3.5h7.2L19 8.3v12.2H7z"/><path d="M14 3.5v5h5M10 12h6M10 15.5h6"/>',
  projects: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 10h17"/>',
  trades: '<path d="M4 4v16h16"/><path d="m7 15 3.2-4.1 3.1 2.2L20 6.8"/><path d="M16.5 6.8H20v3.5"/>',
  cea: '<path d="m12 3.2 7.6 4.3v8.6L12 20.4 4.4 16.1V7.5z"/><path d="M8.5 10h7M8.5 13.2h4.5"/><path d="M12 3.2v17.2"/>',
  measure: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.2"/><path d="M8 7.5h8M8 11.2h2.2M13.8 11.2H16M8 15h2.2M13.8 15H16M10.9 17.8h2.2"/>',
  content: '<path d="M4 5.5h12.5v13.8H6.4A2.4 2.4 0 0 1 4 16.9z"/><path d="M16.5 8H20v9.4a2 2 0 0 1-2 2h-8.5"/><path d="M7.5 9h5.5M7.5 12.2h5.5M7.5 15.4h3.2"/>',
  admin: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.5 15.5 4.1 4.1"/>',
};

function navIcon(name) {
  const paths = NAV_ICON_PATHS[name] || NAV_ICON_PATHS.overview;
  return `<svg class="navicon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/* ------------------------------ API 客户端 ------------------------------ */

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

export async function api(path, { method = 'GET', body = null, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: '响应不是合法 JSON', raw: text.slice(0, 400) };
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export function exportUrl(dataset, format, query = {}) {
  const qs = new URLSearchParams({ format, ...query }).toString();
  return `/api/v2/${dataset}?${qs}`;
}

/* ------------------------------ 路由 ------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  const key = segs[0] || 'overview';
  if (key === 'search') return { name: 'search', sub: segs[1] || null, query };
  const known = MODULES.some((m) => m.key === key) ? key : 'overview';
  return { name: known, sub: segs[1] || null, query };
}

export function goto(name, query = {}) {
  const qs = new URLSearchParams(query).toString();
  location.hash = `#/${name}${qs ? `?${qs}` : ''}`;
}

export function setQuery(patch = {}) {
  const route = parseHash();
  const merged = { ...route.query, ...patch };
  for (const [k, v] of Object.entries(merged)) {
    if (v === null || v === undefined || v === '') delete merged[k];
  }
  goto(route.name, merged);
}

/* ------------------------------ 渲染 ------------------------------ */

const app = () => document.getElementById('app');

function headerHtml() {
  const u = state.user;
  const sync = state.sync || {};
  const c = sync.counts || {};
  const content = state.contentStats || {};
  const vv = content.by_verification || {};
  // docs/44 第 4 条 + docs/46 第 8 条 + docs/47：运行告警 / 来源冲突 / 未结清差异属于
  // **后台运行信息**，只有管理员且当前就在后台路线时才显示（isAdmin && route==='admin'）。
  // 管理员在总览等公开页面同样看到阅读界面；接口侧 `/api/v2/status` 对非管理员也不返回。
  const isAdmin = u?.role === 'admin';
  const showRunInfo = isAdmin && state.route.name === 'admin';
  const initial = u ? Array.from(String(u.name || '用'))[0] : '';
  return `
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" title="碳市场信息平台" aria-hidden="true">碳</span>
      <div class="brand-copy">
        <h1>碳市场信息平台 <span class="ver">v2.7</span></h1>
        <p class="brand-sub">汇集 CCER 与 CEA 公开政策、项目、交易和研究资料</p>
      </div>
    </div>
    <form class="topbar-search" id="topbar-search" role="search" aria-label="统一检索入口">
      <label class="sr-only" for="topbar-search-input">检索公开资料</label>
      <input id="topbar-search-input" name="q" type="search" maxlength="100"
        value="${esc(state.route.name === 'search' ? state.route.query.q || '' : '')}"
        placeholder="检索政策、方法学、项目、研报…" autocomplete="off">
      <button type="submit" aria-label="开始检索" title="统一检索">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.5 15.5 4.1 4.1"/></svg>
      </button>
    </form>
    <div class="topbar-right">
      <div class="sync-badges" aria-label="数据状态">
        <span class="badge badge-asof">数据截至 <b>${esc(sync.data_as_of || '—')}</b></span>
        <span class="badge badge-sync" title="北京时间">最近成功同步 <b>${esc(dateTime(sync.last_success_sync).slice(0, 16))}</b></span>
        <span class="badge badge-content">内容 <b>${esc(String(c.content_items ?? 0))}</b> 条</span>
        ${showRunInfo ? `<span class="badge ${vv.conflict ? 'badge-warn' : ''}" title="来源冲突：不覆盖官方数值，也不计入已核验统计">来源冲突 <b>${esc(String(vv.conflict ?? 0))}</b></span>
        <span class="badge ${c.open_issues ? 'badge-warn' : ''}" title="数据核对发现的未结清差异（后台运行信息，仅后台管理页对管理员可见）">未结清差异 <b>${esc(String(c.open_issues ?? 0))}</b></span>` : ''}
      </div>
      <div class="who">
        ${u ? `<span class="who-avatar" aria-hidden="true">${esc(initial)}</span><span class="who-name">${esc(u.name)}</span><span class="chip chip-role">${esc(roleLabel(u.role))}</span>
              <button class="btn btn-sm" id="btn-logout" type="button">退出</button>`
            : '<span class="muted">未登录</span>'}
      </div>
    </div>
  </header>`;
}

function bannersHtml() {
  const v2 = state.v2 || {};
  const sync = state.sync || {};
  const isAdmin = state.user?.role === 'admin';
  const showRunInfo = isAdmin && state.route.name === 'admin';
  return [
    v2.production_db ? '<div class="banner banner-warn">当前数据库路径等于在用生产库 <code>data/ccer.db</code>：v2 只读展示，采集/导入等写操作会被服务端拒绝。</div>' : '',
    v2.ok || v2.enabled === false ? '' : `<div class="banner banner-warn">${esc(v2.message || '')}</div>`,
    showRunInfo && sync.alert ? `<div class="banner banner-warn"><b>运行告警</b> ${esc(sync.alert)}</div>` : '',
  ].filter(Boolean).join('');
}

function roleLabel(role) {
  return {
    admin: '系统管理员', researcher: '政策研究员', analyst: '投资分析师', viewer: '只读用户',
  }[role] || role;
}

function navHtml() {
  const route = state.route;
  const visibleModules = MODULES.filter((m) => m.key !== 'admin' || state.user?.role === 'admin');
  return `<nav class="mainnav" aria-label="主要导航">${visibleModules.map((m) => `
    <a href="#/${m.key}" class="navitem ${route.name === m.key ? 'active' : ''}" title="${esc(m.desc)}" ${route.name === m.key ? 'aria-current="page"' : ''}>
      ${navIcon(m.icon)}<span>${esc(m.label)}</span>
    </a>`).join('')}</nav>`;
}

async function refreshStatus() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    state.authMode = me.auth_mode;
  } catch {
    state.user = null;
  }
  try {
    const st = await api('/api/v2/status');
    state.v2 = st.v2;
    state.sync = st.sync || null;
    state.demoProjects = st.demo_projects || 0;
    state.demoContent = st.demo_content || 0;
    state.contentStats = st.content || null;
  } catch (e) {
    state.v2 = e.body?.v2 || { ok: false, message: e.body?.message || e.message };
    state.sync = null;
    state.demoProjects = 0;
    state.demoContent = 0;
    state.contentStats = null;
  }
}

let authView = 'login';
let authPending = false;

function loginPanel(message = '') {
  const registering = authView === 'register';
  return `
  <div class="auth-page">
    <div class="auth-background" aria-hidden="true"></div>
    <div class="auth-sheen" aria-hidden="true"></div>
    <header class="auth-header">
      <div class="auth-brand">
        <span class="brand-mark auth-logo" aria-hidden="true">碳</span>
        <div class="auth-wordmark"><strong>碳市场信息平台</strong><span>公开信息工作台</span></div>
      </div>
      <span class="auth-header-note">CARBON MARKET WORKSPACE</span>
    </header>
    <div class="auth-layout">
      <div class="auth-intro">
        <h1>让每一份公开信息<br>都有迹可循<span>。</span></h1>
        <p>政策、方法学、项目、行情与研报，来源和口径一并可查。</p>
        <div class="auth-intro-rule"></div>
        <div class="auth-footnote">公开来源，持续更新，可追溯核验</div>
      </div>
      <section class="auth-card" aria-label="${registering ? '注册账号' : '登录工作台'}">
        <div class="auth-card-heading">
          <h2>${registering ? '创建账号' : '登录工作台'}</h2>
          <p>${registering ? '注册后即可浏览公开信息。' : '使用已有账号进入公开信息平台。'}</p>
        </div>
        <form id="auth-form" novalidate>
          <label class="auth-field"><span>账号</span><input id="login-user" name="username" autocomplete="username" required maxlength="32" placeholder="请输入账号"></label>
          ${registering ? '<label class="auth-field"><span>显示名称 <em>选填</em></span><input id="register-name" name="display_name" maxlength="40" autocomplete="name" placeholder="如何称呼你"></label>' : ''}
          <label class="auth-field"><span>密码</span><input id="login-pass" name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" required placeholder="${registering ? '至少 12 位，含大小写字母和数字' : '请输入密码'}"></label>
          ${registering ? '<label class="auth-field"><span>确认密码</span><input id="register-confirm" name="confirm_password" type="password" autocomplete="new-password" required placeholder="再次输入密码"></label>' : ''}
          <p class="auth-error" id="auth-error" role="alert" aria-live="polite">${esc(message)}</p>
          <button class="auth-submit" id="btn-auth-submit" type="submit">${registering ? '注册普通账号' : '进入工作台'}</button>
        </form>
        <div class="auth-card-bottom">${registering ? '已有账号？<button type="button" class="auth-text-button" id="auth-switch">返回登录</button>' : '还没有账号？<button type="button" class="auth-text-button" id="auth-switch">注册账号</button>'}</div>
      </section>
    </div>
    <div class="auth-bottom"><span>碳市场信息平台</span><span>公开资料整合与减排粗估</span></div>
  </div>`;
}

async function doLogin() {
  if (authPending) return;
  const user_id = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const error = document.getElementById('auth-error');
  if (!user_id || !password) { error.textContent = '请输入账号和密码'; return; }
  authPending = true;
  const button = document.getElementById('btn-auth-submit');
  button.disabled = true;
  button.firstChild.textContent = '正在登录… ';
  try {
    const out = await api('/api/auth/login', { method: 'POST', body: { user_id, password } });
    state.user = out.user;
    await refreshStatus();
    if (out.must_change_password) toast('账号需要修改密码，请联系管理员。', 'warn');
    await render();
  } catch (e) {
    error.textContent = e.body?.error || e.message;
  } finally {
    authPending = false;
    if (button.isConnected) { button.disabled = false; button.firstChild.textContent = '进入工作台 '; }
  }
}

async function doRegister() {
  if (authPending) return;
  const username = document.getElementById('login-user').value.trim();
  const display_name = document.getElementById('register-name').value.trim();
  const password = document.getElementById('login-pass').value;
  const confirm = document.getElementById('register-confirm').value;
  const error = document.getElementById('auth-error');
  if (!username || !password || !confirm) { error.textContent = '请填写账号和密码'; return; }
  if (password !== confirm) { error.textContent = '两次输入的密码不一致'; return; }
  authPending = true;
  const button = document.getElementById('btn-auth-submit');
  button.disabled = true;
  button.firstChild.textContent = '正在注册… ';
  try {
    await api('/api/auth/register', { method: 'POST', body: { username, display_name, password } });
    authView = 'login';
    document.title = '登录 · 碳市场信息平台';
    app().innerHTML = loginPanel('注册成功，请登录工作台。');
    bindAuthPanel();
    document.getElementById('login-user').value = username;
    document.getElementById('login-pass').focus();
  } catch (e) {
    error.textContent = e.body?.error || e.message;
  } finally {
    authPending = false;
    if (button.isConnected) { button.disabled = false; button.firstChild.textContent = '注册普通账号 '; }
  }
}

function bindAuthPanel() {
  document.getElementById('auth-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (authView === 'register') doRegister();
    else doLogin();
  });
  document.getElementById('auth-switch')?.addEventListener('click', () => {
    authView = authView === 'login' ? 'register' : 'login';
    document.title = `${authView === 'register' ? '注册' : '登录'} · 碳市场信息平台`;
    app().innerHTML = loginPanel();
    bindAuthPanel();
    document.getElementById('login-user')?.focus();
  });
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  state.user = null;
  state.v2 = null;
  state.sync = null;
  state.demoProjects = 0;
  state.demoContent = 0;
  state.contentStats = null;
  await render();
}

function pageHeadHtml(mod) {
  const asOf = state.sync?.data_as_of || '—';
  const isAdminView = state.route.name === 'admin';
  return `
    <header class="page-head" aria-labelledby="page-title">
      <div class="page-head-copy">
        <h2 id="page-title">${esc(mod.label)}</h2>
        <p>${esc(mod.summary)}</p>
      </div>
      <div class="page-meta" aria-label="页面数据状态">
        <div class="page-meta-item"><span>数据截至</span><b>${esc(asOf)}</b></div>
        <div class="page-meta-item"><span>当前视图</span><b>${isAdminView ? '管理员' : state.route.name === 'search' ? '公开检索' : '公开信息'}</b></div>
      </div>
    </header>`;
}

function bindTopbarSearch() {
  const form = document.getElementById('topbar-search');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('topbar-search-input')?.value.trim() || '';
    goto('search', q ? { q } : {});
  });
}

export async function render() {
  const seq = ++renderSeq;
  const cleanup = activeCleanup;
  activeCleanup = null;
  try { cleanup?.(); } catch { /* 清理失败不阻塞路由 */ }
  state.route = parseHash();
  if (!state.user) {
    document.title = `${authView === 'register' ? '注册' : '登录'} · 碳市场信息平台`;
    app().innerHTML = loginPanel();
    bindAuthPanel();
    return;
  }
  if (state.route.name === 'admin' && state.user.role !== 'admin') {
    goto('overview');
    return;
  }
  const mod = state.route.name === 'search'
    ? SEARCH_MODULE
    : (MODULES.find((m) => m.key === state.route.name) || MODULES[0]);
  const banners = bannersHtml();
  document.title = `${mod.label} · 碳市场信息平台`;
  app().innerHTML = `
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    ${headerHtml()}
    ${navHtml()}
    ${banners ? `<div class="global-banners">${banners}</div>` : ''}
    <main class="content" id="main-content" tabindex="-1">
      ${pageHeadHtml(mod)}
      <div class="module-root" id="module-root" data-module="${esc(mod.key)}">${loading()}</div>
    </main>
    <footer class="footer">
      <span>碳市场信息平台：只整合公开资料，不管理机构的私有项目；采集与发布自动化，无人工审核环节。</span>
      <span>公示量 ≠ 登记量；成交均价 ≠ 收盘价；市场成交量不归属到具体项目；公开页面的来源标签只表示发布方，不构成独立审计或投资建议。</span>
      <span>CEA：官方综合收盘价 ≠ 全方式计算均价；来源历史价格的参考数量不是成交量；交易意向不等于成交；履约日历以正式公告优先，机器辅助列表异常独立告警。</span>
      <span>核心摘要由已配置模型依据所示输入范围生成，未生成时如实显示空态；平台不使用模型记忆替代公开证据。</span>
    </footer>`;

  document.getElementById('btn-logout')?.addEventListener('click', logout);
  bindSkipLink();
  bindTopbarSearch();
  const root = document.getElementById('module-root');

  let cleanupNext = null;
  try {
    cleanupNext = state.route.name === 'search'
      ? await renderSearch(root, state.route)
      : await mod.render(root, state.route);
  } catch (e) {
    console.error(e);
    root.innerHTML = errorState(e);
  }
  if (seq !== renderSeq) {
    if (typeof cleanupNext === 'function') {
      try { cleanupNext(); } catch { /* 过期渲染的清理失败不阻塞新路由 */ }
    }
    return;
  }
  activeCleanup = typeof cleanupNext === 'function' ? cleanupNext : null;
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** 跳转主内容只移动焦点/滚动，不使用 hash，避免误触路由重渲染。 */
function bindSkipLink() {
  document.querySelector('.skip-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    const main = document.getElementById('main-content');
    if (!main) return;
    main.focus({ preventScroll: true });
    main.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
}

/* ------------------------------ 全局事件 ------------------------------ */

window.addEventListener('hashchange', render);

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close-drawer]');
  if (close) document.querySelector('.drawer-backdrop')?.remove(), document.querySelector('.drawer')?.remove();
  const nav = e.target.closest('[data-goto]');
  if (nav) {
    const [name, queryStr] = String(nav.dataset.goto).split('?');
    goto(name.replace(/^#\/?/, ''), Object.fromEntries(new URLSearchParams(queryStr || '')));
  }
  const sortTh = e.target.closest('th[data-sort]');
  if (sortTh && sortTh.dataset.sort) {
    const wrap = sortTh.closest('.table-wrap');
    if (wrap) sortTable(wrap, sortTh);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const th = e.target.closest?.('th[data-sort]');
  if (!th || !th.dataset.sort) return;
  e.preventDefault();
  const wrap = th.closest('.table-wrap');
  if (wrap) sortTable(wrap, th);
});

/** 前端排序（点击表头）：按当前列的值升/降序，仅对已渲染的 tbody 生效 */
function sortTable(wrap, th) {
  const key = th.dataset.sort;
  const table = wrap.querySelector('table');
  const tbody = table.querySelector('tbody');
  const rows = [...tbody.querySelectorAll('tr')];
  const idx = [...th.parentElement.children].indexOf(th);
  const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
  [...th.parentElement.children].forEach((c) => {
    delete c.dataset.dir;
    if (c.dataset?.sort) c.setAttribute('aria-sort', 'none');
  });
  th.dataset.dir = dir;
  th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
  const val = (tr) => {
    const cell = tr.children[idx];
    const raw = cell?.dataset?.sortValue ?? cell?.textContent?.trim() ?? '';
    const n = Number(String(raw).replace(/[,，%\s]/g, ''));
    return Number.isFinite(n) && String(raw).trim() !== '' && /^[-+]?[\d,.\s%]+$/.test(String(raw).trim()) ? n : String(raw);
  };
  rows.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va;
    return dir === 'asc' ? String(va).localeCompare(String(vb), 'zh-CN') : String(vb).localeCompare(String(va), 'zh-CN');
  });
  rows.forEach((r) => tbody.appendChild(r));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-page-prev],[data-page-next]');
  if (!btn) return;
  const wrap = btn.closest('.table-wrap');
  const page = Number(wrap.dataset.page || '1');
  setTablePage(wrap, btn.hasAttribute('data-page-next') ? page + 1 : page - 1);
});

/* ------------------------------ 启动 ------------------------------ */

(async function boot() {
  await refreshStatus();
  await render();
  // 顶部同步横幅每 60 秒刷新一次（不自动刷新业务数据，避免打断阅读）
  setInterval(async () => {
    await refreshStatus();
    const header = document.querySelector('.topbar');
    if (header && state.user) {
      const fresh = new DOMParser().parseFromString(headerHtml(), 'text/html');
      const freshBadges = fresh.querySelector('.sync-badges');
      if (freshBadges) document.querySelector('.sync-badges')?.replaceWith(freshBadges);
      const bannerBox = document.querySelector('.global-banners');
      if (bannerBox) bannerBox.innerHTML = bannersHtml();
    }
  }, 60000);
})();

export { MODULES };
