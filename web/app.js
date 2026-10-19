/**
 * CCER 投资筛选 AI 应用 —— 工作台前端
 * 零构建、无依赖，直接由后端静态托管。
 *
 * 身份与会话（安全基线）：
 *   - 前端不再「自由切换身份」：身份由服务端会话决定。
 *   - 令牌保存在内存 + localStorage（键 ccer.token），每个 api() 请求以
 *     Authorization: Bearer 回传；登录时服务端同时下发 HttpOnly Cookie。
 *   - 启动时先调用 GET /api/auth/me：401 则渲染登录面板，且不渲染工作台导航。
 */

/* ============================== 基础工具 ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function nl2br(s) { return h(s).replace(/\n/g, '<br/>'); }
function num(v, digits = 2) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return h(v);
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

const TOKEN_KEY = 'ccer.token';

const state = {
  /** 会话令牌：内存中保存一份，localStorage 用于刷新后恢复 */
  token: localStorage.getItem(TOKEN_KEY) || null,
  /** 当前登录用户（由 GET /api/auth/me 返回，只读，不可切换） */
  user: null,
  /** 'session' | 'dev' */
  authMode: 'session',
  /** 仅 dev 演示模式下的临时自报身份（服务端在 dev 模式下才认这个头） */
  devUser: null,
  /** 名册（登录面板展示用，由 /api/users 返回） */
  users: [],
  /** 演示通道是否开启（/api/admin/demo-channel；读取失败按未开启处理） */
  demoChannel: false,
  meta: null,
  hash: '',
};

function toast(msg, kind = '') {
  const t = $('#toast');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 9000 : 4200);
}

/** 统一请求头：有令牌时一律带 Authorization: Bearer（绝不放查询参数） */
function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  // 仅 dev 演示模式：允许通过自报请求头切换身份（服务端在该模式下才认这个头）
  if (state.authMode === 'dev' && state.devUser) headers['x-user-id'] = state.devUser;
  return headers;
}

/** 令牌失效（401）：清理本地会话并回到登录面板 */
function onAuthLost(message) {
  state.token = null;
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  showLogin(message || '会话已失效，请重新登录。');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (res.status === 401 && !String(path).startsWith('/api/auth/login')) {
    onAuthLost('登录状态已失效，请重新登录。');
  }
  // 422 = 校验未通过而拒绝出数。这是系统的正常业务结果，不作为异常抛出。
  if (res.status === 422) return { ...data, rejected: true };
  if (!res.ok) {
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function apiDownload(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) {
    onAuthLost('登录状态已失效，请重新登录。');
    throw new Error('未认证');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]) : 'export.txt';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`已导出：${name}`, 'ok');
}

const STATUS_LABEL = { formal: '正式发布', draft: '征求意见', revised_draft: '修订征求意见稿', repealed: '已废止' };
const ROLE_LABEL = {
  admin: '系统管理员', researcher: '政策研究员', analyst: '投资分析师',
  reviewer: '领域复核人', viewer: '只读用户',
};
const STATE_BADGE = { pass: ['pass', '通过'], fail: ['fail', '不通过'], unknown: ['unknown', '待核实'] };
const CONCLUSION_BADGE = {
  '可继续尽调': 'pass', '存在明确障碍': 'fail', '资料不足暂无法判断': 'unknown', '无已发布适用方法学': 'gray',
};
const SOURCE_KIND_LABEL = {
  official: '官方文件', project_doc: '项目资料', owner_claim: '业主自述',
  analyst: '分析师录入', assumption: '模型假设',
};
/** 方法学审批状态（规则卡 / 计算插件共用枚举） */
const APPROVAL_LABEL = {
  approved: '已通过', pending_review: '待审批', rejected: '已驳回', none: '未建立',
};
const APPROVAL_BADGE = { approved: 'pass', pending_review: 'unknown', rejected: 'fail', none: 'gray' };
const DEMO_WATERMARK_FALLBACK = '【演示通道 · 反事实推演】本结果不得用于投资筛选报告、对外材料或投资决策';

function approvalBadge(status) {
  const s = status || 'none';
  return `<span class="badge ${APPROVAL_BADGE[s] || 'gray'}">${h(APPROVAL_LABEL[s] || s)}</span>`;
}
function channelBadge(run) {
  return run.channel === 'demo' || run.demo
    ? '<span class="badge unknown">演示</span>'
    : '<span class="badge info">业务</span>';
}
/** 短时间戳（只用于紧凑展示；完整值仍保留在 title 里） */
function shortTime(iso) {
  return String(iso || '').slice(0, 16).replace('T', ' ');
}
/** 列出某个方法学插件的「业务测算阻断项」，逐条说明原因，供管理后台与初始测算页复用 */
function pluginBlockers(p) {
  const out = [];
  if (p.calculator_status !== 'approved') {
    out.push(`计算插件审批状态为「${APPROVAL_LABEL[p.calculator_status] || p.calculator_status || '未建立'}」，尚未完成审批流转`);
  }
  if (p.placeholder_factors?.length) {
    out.push(`含 ${p.placeholder_factors.length} 项未经领域专家确认的占位系数：${p.placeholder_factors.map((f) => f.factor_key).join('、')}`);
  }
  if (p.formulas_without_clause?.length) {
    out.push(`有 ${p.formulas_without_clause.length} 条公式未回填原文条款页码：${p.formulas_without_clause.join('、')}`);
  }
  return out;
}

/**
 * 读取演示通道状态。
 * 权限不足（403）或接口不可用一律「按未开启处理」——门禁类信息失败必须退到更严格的一侧。
 */
async function fetchDemoChannel() {
  try {
    const d = await api('/api/admin/demo-channel');
    return { ok: true, data: d, enabled: d.demo_channel_enabled === true, denied: false };
  } catch (e) {
    if (e.status === 401) throw e;
    return { ok: false, data: null, enabled: false, denied: true, status: e.status || 0 };
  }
}

/** 演示通道只能由系统管理员开启；出数还要求服务端认可的角色（与 calc-svc 的判定一致） */
function demoChannelUsable(enabled) {
  const role = (state.user && state.user.role) || '';
  return !!enabled && ['admin', 'researcher'].includes(role);
}

/** 把「业务测算被阻断」的原因渲染成醒目的红色提示；blockers 逐条列出 */
function gateNote(reason, blockers, className = 'danger') {
  const items = (blockers || []).filter(Boolean);
  return `<div class="note ${className}">
    <strong>业务测算当前被阻止出数。</strong>
    ${reason ? `<div style="margin-top:4px">${nl2br(reason).replace(/\*\*/g, '')}</div>` : ''}
    ${items.length ? `<div style="margin-top:6px">阻断原因（逐项）：</div>
      <ul class="blocker-list">${items.map((b) => `<li>${h(b)}</li>`).join('')}</ul>` : ''}
    <div class="tiny" style="margin-top:5px">
      该状态是设计要求的正常结果，不是系统故障：在 <span class="mono">docs/12-领域专家确认清单.md</span>
      全部确认完毕、且经管理后台记录审批人与时间之前，系统不得产出任何业务减排量数字。
    </div>
  </div>`;
}

/** 初始测算页顶部的门禁说明：信息源优先用插件清单（含逐条细节），缺失时退回条件检查快照 */
function calcGateNote(availability, scopedPlugins) {
  if (!availability) {
    return `<div class="note warn">条件检查快照尚未包含测算可用性字段。请先运行「申报条件检查」，
      或直接改走演示通道做反事实推演（若管理员已开启）。</div>`;
  }
  const detail = [];
  let hasBlocked = false;
  for (const p of scopedPlugins || []) {
    const list = pluginBlockers(p);
    if (list.length) hasBlocked = true;
    for (const b of list) detail.push(`【${p.methodology_id}】${b}`);
  }
  // 即使快照说「可用」，只要对应插件还有阻断项，也必须把原因摆出来（后端会拒绝出数）
  if (availability.available && !hasBlocked) return '';
  const blockers = detail.length ? detail : (availability.blockers || []);
  const reason = availability.available
    ? '条件检查快照显示可测算，但该版本计算插件仍未满足业务出数的全部前置条件（审批 / 占位系数 / 条款页码），实际提交会被服务端拒绝出数。'
    : availability.reason;
  return gateNote(reason, blockers);
}

/** 演示通道正在运行时的大号水印横幅：结果性质与使用禁区必须一眼可见 */
function demoWatermark(text, extra = '') {
  return `<div class="demo-watermark">
    <div class="wm-title">${h(text || DEMO_WATERMARK_FALLBACK)}</div>
    <div class="wm-sub">演示通道运行记录标记为 <span class="mono">demo</span>，已排除在投资筛选报告之外、不可导出，
      仅用于流程演示与内部讨论；其中的占位系数未经领域专家确认。${h(extra)}</div>
  </div>`;
}

function stateBadge(s) {
  const [cls, label] = STATE_BADGE[s] || ['gray', s];
  return `<span class="badge ${cls}">${label}</span>`;
}
function conclusionBadge(c) {
  return `<span class="badge ${CONCLUSION_BADGE[c] || 'gray'}">${h(c)}</span>`;
}
function sourceTag(kind) {
  if (!kind) return '';
  return `<span class="tag ${h(kind)}">${h(SOURCE_KIND_LABEL[kind] || kind)}</span>`;
}

/* ============================== 路由 ============================== */

const NAV = [
  ['#/dashboard', '总览看板'],
  ['#/radar', '信息雷达'],
  ['#/methodologies', '方法学库'],
  ['#/projects', '项目档案与筛选'],
  ['#/reviews', '人工审核'],
  ['#/admin', '管理后台'],
  ['#/about', '边界与说明'],
];

function parseHash() {
  const raw = (location.hash || '#/dashboard').slice(2);
  const [path, queryStr] = raw.split('?');
  const segs = path.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryStr || ''));
  return { segs, query, path };
}

async function boot() {
  try {
    state.meta = await api('/api/meta/fact-fields');
  } catch (e) {
    if (e.status !== 401) toast(`初始化失败：${e.message}`, 'err');
  }
  // 注意：index.html 中 #topbar / #disclaimer / #view 初始都带 hidden 属性，
  // 必须在渲染内容之前逐个解除，否则页面只会显示顶栏而内容区空白。
  $('#boot').hidden = true;
  $('#topbar').hidden = false;
  $('#disclaimer').hidden = false;
  $('#view').hidden = false;

  // 启动第一步：确认会话。401 → 渲染登录面板，且不渲染工作台导航。
  const me = await fetchMe();
  if (!me) {
    showLogin();
    return;
  }
  await enterWorkbench(me);
  window.addEventListener('hashchange', route);
  await route();
}

/** 退出登录：无论服务端是否成功撤销，本地会话一律清除并回到登录面板 */
function doLogout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  showLogin('已退出登录。如需继续使用，请重新登录。');
  toast('已退出登录', 'ok');
}

/** 读取当前会话；401（未登录）返回 null，其余错误抛出 */
async function fetchMe() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    state.authMode = me.auth_mode || 'session';
    return me;
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

/** 进入工作台：加载元数据与名册、渲染导航与身份区 */
async function enterWorkbench(me) {
  try {
    state.meta = await api('/api/meta/fact-fields');
  } catch (e) {
    if (e.status !== 401) toast(`元数据加载失败：${e.message}`, 'err');
  }
  try {
    const u = await api('/api/users');
    state.users = u.users || [];
  } catch { state.users = []; }
  renderNav();
  renderIdentity(me);
  await refreshGate();
}

/** 顶栏身份区：只读展示当前会话身份 + 退出登录按钮 */
function renderIdentity(me) {
  const u = me && me.user ? me.user : state.user;
  const box = $('#user-select');
  if (u) {
    box.innerHTML = `<strong>${h(u.name)}</strong>
      <span class="role">${h(ROLE_LABEL[u.role] || u.role)}</span>
      <span class="tiny muted">${h(u.team_id)}</span>`;
    box.title = `当前会话身份：${u.name}（${u.role}）。身份由服务端会话决定，页面不可切换。`;
  } else {
    box.innerHTML = '<span class="tiny muted">未登录</span>';
  }
  const dev = me && me.dev_mode;
  const nav = $('#nav');
  const old = document.getElementById('dev-mode-note');
  if (old) old.remove();
  if (dev) {
    // dev 演示模式：保留「可直接切换身份」的能力，但明确标注为不安全。
    const note = document.createElement('span');
    note.id = 'dev-mode-note';
    note.className = 'gate';
    note.style.background = '#7f1d1d';
    note.style.borderColor = '#fca5a5';
    note.title = '认证已关闭：服务端直接信任 x-user-id / ?user=。仅限本机演示，禁止暴露到内网。';
    note.textContent = '演示模式：可直接切换身份（不安全）';
    nav.appendChild(note);
    if (state.users.length) {
      const currentId = (u && u.id) || (state.users[0] && state.users[0].id) || '';
      const sel = document.createElement('select');
      sel.id = 'dev-user-select';
      sel.title = 'dev 演示模式专用：切换自报身份（x-user-id）。此模式关闭了认证，仅限本机演示。';
      sel.innerHTML = state.users
        .map((x) => `<option value="${h(x.id)}" ${x.id === currentId ? 'selected' : ''}>${h(x.name)}（${h(x.role)}）</option>`)
        .join('');
      sel.onchange = async (e) => {
        state.devUser = e.target.value;
        toast(`演示模式：已临时切换为 ${e.target.selectedOptions[0].textContent}（认证已关闭）`, 'err');
        await boot();
      };
      nav.appendChild(sel);
    }
  } else {
    state.devUser = null;
  }
}

/** 渲染登录面板（不含任何工作台导航） */
function showLogin(message) {
  const view = $('#view');
  $('#nav').innerHTML = '';
  const old = document.getElementById('dev-mode-note');
  if (old) old.remove();
  $('#topbar').hidden = true;
  $('#disclaimer').hidden = true;
  $('#view').hidden = false;

  const users = state.users.length
    ? state.users
    : [
        { id: 'user-analyst', name: '投资分析师', role: 'analyst', team_id: 'team-invest' },
        { id: 'user-researcher', name: '政策研究员', role: 'researcher', team_id: 'team-carbon' },
        { id: 'user-reviewer', name: '领域复核人', role: 'reviewer', team_id: 'team-carbon' },
        { id: 'user-admin', name: '系统管理员', role: 'admin', team_id: 'team-carbon' },
        { id: 'user-other', name: '其他团队成员', role: 'viewer', team_id: 'team-other' },
      ];

  view.innerHTML = `
  <div class="login-wrap">
    <div class="card">
      <h1 style="margin-top:0">登录 · CCER 投资筛选 AI 应用</h1>
      <p class="muted">身份由<strong>服务端会话</strong>决定：登录成功后服务端签发会话令牌（库里只保存令牌摘要），
        浏览器以 <span class="mono">Authorization: Bearer</span> 或 <span class="mono">HttpOnly Cookie</span> 回传。
        请求头 <span class="mono">x-user-id</span> 与 <span class="mono">?user=</span> 在默认模式下<strong>完全无效</strong>。</p>
      ${message ? `<div class="note warn">${h(message)}</div>` : ''}
      <form data-act="demo-login">
        <h3>选择身份</h3>
        <div id="login-users">
          ${users.map((u, i) => `
            <label class="login-user ${i === 0 ? 'sel' : ''}" data-user="${h(u.id)}">
              <input type="radio" name="user_id" value="${h(u.id)}" ${i === 0 ? 'checked' : ''} style="width:auto" />
              <span>
                <span class="nm">${h(u.name)}</span>
                <span class="meta">${h(u.id)}　团队 ${h(u.team_id || '—')}</span>
              </span>
              <span class="role">${h(ROLE_LABEL[u.role] || u.role)}</span>
            </label>`).join('')}
        </div>
        <label class="field" style="margin-top:12px"><span>演示口令</span>
          <input name="password" type="password" required autocomplete="current-password"
            placeholder="请输入该用户的演示口令" /></label>
        <div class="btn-row" style="margin-top:10px">
          <button class="primary" type="submit" data-role="login-submit">登录</button>
        </div>
      </form>
      <div class="note info" style="margin-top:12px">
        <strong>原型说明：</strong>本原型尚未接入机构统一身份认证，登录口令是<b>占位演示口令</b>
        （定义于 <span class="mono">src/data/users.mjs</span>，仅供本地演示）。
        正式部署必须替换为机构 SSO / OIDC，并在服务端完成断言校验。
      </div>
      <div class="note danger" data-role="login-error" hidden></div>
    </div>
  </div>`;

  $$('.login-user', view).forEach((el) => {
    el.addEventListener('click', () => {
      $$('.login-user', view).forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      const radio = el.querySelector('input[type=radio]');
      if (radio) radio.checked = true;
    });
  });
}

async function doLogin(userId, passphrase) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId, password: passphrase }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `登录失败（HTTP ${res.status}）`);
  return data;
}

function renderNav() {
  $('#nav').innerHTML = NAV.map(([href, label]) => `<a href="${href}" data-nav="${href}">${label}</a>`).join('');
}

async function refreshGate() {
  const el = $('#gate-badge');
  const d = await fetchDemoChannel();
  state.demoChannel = d.enabled;
  // 业务测算放行的唯一途径是「方法学审批 + 无占位系数 + 条款页码齐全 + 条件检查无硬障碍」，
  // 在新门禁模型下默认全部方法学都未通过审批，因此顶栏固定显示禁止出数。
  el.innerHTML = `<span class="badge fail">业务测算：禁止（未通过审批）</span>
    ${d.enabled ? '<span class="badge unknown">演示通道已开启</span>' : ''}`;
  el.className = 'gate';
  el.title = '业务测算需同时满足：计算插件已审批、无占位系数、公式条款页码齐全、同项目同版本同基准日条件检查无硬障碍。'
    + (d.enabled
      ? `演示通道已由管理员开启（开启人：${(d.data && d.data.enabled_by) || '—'}，开启时间：${shortTime(d.data && d.data.enabled_at) || '—'}）：演示结果标记为 demo，不进入报告、不可导出。`
      : (d.denied ? '演示通道状态读取失败（403），按未开启处理。' : '演示通道当前未开启。'));
}

async function route() {
  const r = parseHash();
  state.hash = location.hash;
  $$('#nav a').forEach((a) => {
    const base = '#' + '/' + (r.segs[0] || 'dashboard');
    a.classList.toggle('active', a.dataset.nav === base || (base === '#/projects' && a.dataset.nav === '#/projects'));
  });
  const view = $('#view');
  view.innerHTML = '<div class="card">加载中…</div>';
  try {
    const [head, ...rest] = r.segs;
    switch (head) {
      case undefined:
      case 'dashboard': return void (view.innerHTML = await DashboardView());
      case 'radar': return void (view.innerHTML = await RadarView());
      case 'methodologies':
        return void (view.innerHTML = rest[0] ? await MethodologyDetailView(rest[0]) : await MethodologyListView(r.query));
      case 'projects':
        return void (view.innerHTML = rest[0] ? await ProjectDetailView(rest[0], r.query) : await ProjectListView(r.query));
      case 'reviews': return void (view.innerHTML = await ReviewsView());
      case 'admin': return void (view.innerHTML = await AdminView());
      case 'about': return void (view.innerHTML = await AboutView());
      default: view.innerHTML = '<div class="card">未知页面。</div>';
    }
  } catch (e) {
    view.innerHTML = `<div class="note danger"><strong>加载失败：</strong>${h(e.message)}</div>
      <div class="card"><pre class="mono">${h(JSON.stringify(e.data || {}, null, 2))}</pre></div>`;
  }
}

/* ============================== 总览看板 ============================== */

async function DashboardView() {
  // 计算门禁不再有「严格 / 演示」二元开关：业务出数须通过审批，演示通道单独隔离。
  const [d, gate] = await Promise.all([api('/api/dashboard'), fetchDemoChannel()]);
  const m = d.methodology;
  const p = d.project;
  const a = d.alert;

  const kpi = [
    ['teal', m.distinct_methodologies, '方法学条目（按编号去重）'],
    ['blue', m.total_versions, '方法学版本记录'],
    ['green', m.formal_candidate_eligible, '正式且可列为候选'],
    ['amber', Object.values(p.by_conclusion).reduce((s, x) => s + x, 0) ? p.not_yet_analyzed : p.not_yet_analyzed, '尚未做条件检查的项目'],
    ['red', a.by_severity.warning + a.by_severity.critical, '待处理告警（警示及以上）'],
    ['amber', d.calculation.rejected_runs, '被拒绝出数的计算运行'],
  ];

  const conclusionRows = Object.entries(p.by_conclusion || {});
  const stageRows = Object.entries(p.by_registry_stage || {});
  const totalStage = stageRows.reduce((s, [, v]) => s + v, 0) || 1;

  return `
  <div class="page-head">
    <div>
      <h1>总览看板</h1>
      <p class="muted">分析基准日：${h(d.today)}　｜　计算门禁：<span class="badge fail">业务测算：禁止（未通过审批）</span>
        ${gate.enabled ? '<span class="badge unknown">演示通道已开启</span>' : '<span class="badge gray">演示通道未开启</span>'}</p>
    </div>
    <div class="btn-row">
      <a class="btn" href="#/radar">查看信息雷达</a>
      <a class="btn primary" href="#/projects">进入项目筛选</a>
    </div>
  </div>

  <div class="grid c6" style="margin:14px 0">
    ${kpi.map(([c, n, k]) => `<div class="stat ${c}"><div class="n">${num(n, 0)}</div><div class="k">${h(k)}</div></div>`).join('')}
  </div>

  <div class="grid c2">
    <div class="card">
      <h2>方法学目录结构</h2>
      <table>
        <tbody>
          <tr><th>正式发布（可列为候选）</th><td class="num">${num(m.formal_candidate_eligible, 0)}</td></tr>
          <tr><th>正式发布（编号待核实，仅观察）</th><td class="num">${num((m.by_document_status.formal || 0) - m.formal_candidate_eligible, 0)}</td></tr>
          <tr><th>修订征求意见稿 / 征求意见稿</th><td class="num">${num((m.by_document_status.revised_draft || 0) + (m.by_document_status.draft || 0), 0)}</td></tr>
          <tr><th>已获批规则卡</th><td class="num">${num(m.with_approved_rulecard, 0)}</td></tr>
          <tr><th>已注册计算插件</th><td class="num">${num(m.with_approved_calculator, 0)}</td></tr>
        </tbody>
      </table>
      ${m.catalog_gap ? `<div class="note warn" style="margin-top:10px">
        <strong>目录核对：</strong>${h(m.catalog_gap.note)}
      </div>` : ''}
    </div>

    <div class="card">
      <h2>项目筛选结论分布</h2>
      ${conclusionRows.length ? `
      <table>
        <thead><tr><th>四态结论</th><th class="num">项目数</th></tr></thead>
        <tbody>
        ${conclusionRows.map(([k, v]) => `<tr><td>${conclusionBadge(k)}</td><td class="num">${v}</td></tr>`).join('')}
        </tbody>
      </table>` : '<p class="muted">尚无已完成条件检查的项目。</p>'}
      <h3>注册登记链条状态（分列统计，不合并）</h3>
      ${stageRows.map(([k, v]) => `
        <div style="margin:6px 0">
          <div class="pill-row"><span class="tiny">${h(k)}</span><span class="tiny muted" style="margin-left:auto">${v}</span></div>
          <div class="bar"><i style="width:${Math.round((v / totalStage) * 100)}%"></i></div>
        </div>`).join('')}
    </div>
  </div>

  <div class="card">
    <h2>待处理告警</h2>
    ${a.top.length ? a.top.map(alertRow).join('') : '<p class="muted">无待处理告警。</p>'}
  </div>

  <div class="card flat">
    <p class="tiny muted">${h(d.catalog_note)}</p>
  </div>`;
}

function alertRow(al) {
  const sev = { critical: 'fail', warning: 'unknown', info: 'info' }[al.severity] || 'gray';
  return `<div class="rule ${al.severity === 'info' ? '' : al.severity === 'warning' ? 'unknown' : 'fail'}">
    <div class="head">
      <span class="badge ${sev}">${h(al.severity)}</span>
      <span class="badge gray">${h(al.kind)}</span>
      <span class="t">${h(al.title)}</span>
      ${al.status !== 'open' ? `<span class="badge gray">${h(al.status)}</span>` : ''}
    </div>
    <div class="body">${nl2br(al.detail || '')}</div>
    ${al.source_url ? `<div class="tiny" style="margin-top:4px">来源：<a href="${h(al.source_url)}" target="_blank" rel="noreferrer">${h(al.source_title || al.source_url)}</a>${al.source_publish_date ? `　发布日期 ${h(al.source_publish_date)}` : ''}</div>` : ''}
    ${al.status === 'open' ? `<div class="btn-row" style="margin-top:7px">
      <button data-act="alert-set" data-id="${h(al.id)}" data-status="ack">标记已知悉</button>
      <button data-act="alert-set" data-id="${h(al.id)}" data-status="closed">关闭</button>
    </div>` : ''}
  </div>`;
}

/* ============================== 信息雷达 ============================== */

async function RadarView() {
  const [alertsResp, sourcesResp, changesResp, subsResp] = await Promise.all([
    api('/api/alerts'), api('/api/sources'), api('/api/source-changes'), api('/api/subscriptions'),
  ]);
  const alerts = alertsResp.alerts;
  const sources = sourcesResp.sources;
  const changes = changesResp.changes;
  const subs = subsResp.subscriptions;

  return `
  <div class="page-head">
    <div>
      <h1>信息雷达</h1>
      <p class="muted">监测生态环境部、全国 CCER 注册登记系统及信息平台等官方来源；抓取结果只产生变更记录与告警，<strong>不自动修改方法学状态或规则卡</strong>。</p>
    </div>
    <div class="btn-row">
      <button data-act="sync-dry">演练比对（不发请求）</button>
      <button class="primary" data-act="sync-live">执行受控抓取</button>
    </div>
  </div>

  <div class="note info">官方来源采集须走受控出口，并由机构确认数据可否离开内网。抓取失败、来源结构变化和公告撤回均会产生告警。</div>

  <h2>一级来源库（${sources.length} 条）</h2>
  <div class="scroll-x"><table>
    <thead><tr>
      <th>状态</th><th>标题</th><th>发布机关</th><th>文号</th><th>发布日期</th>
      <th>生效日期</th><th>最近抓取</th><th>抓取质量</th><th>链接</th>
    </tr></thead>
    <tbody>
    ${sources.map((s) => `<tr>
      <td><span class="badge ${s.status === 'formal' ? 'pass' : s.status === 'draft' ? 'draft' : 'info'}">${h(s.status)}</span>
          ${s.tier === 1 ? '<span class="badge teal">一级</span>' : '<span class="badge gray">二级</span>'}</td>
      <td>${h(s.title)}${s.parse_note ? `<div class="tiny muted">${h(s.parse_note)}</div>` : ''}</td>
      <td class="tiny">${h(s.issuing_authority || '—')}</td>
      <td class="tiny">${h(s.doc_number || '—')}</td>
      <td class="tiny nowrap">${h(s.publish_date || '—')}</td>
      <td class="tiny nowrap">${h(s.effective_date || '—')}</td>
      <td class="tiny nowrap">${h((s.fetched_at || '').slice(0, 19).replace('T', ' '))}</td>
      <td class="tiny">${h(s.parse_quality || '—')}</td>
      <td class="tiny">${s.url ? `<a href="${h(s.url)}" target="_blank" rel="noreferrer">打开</a>` : '—'}</td>
    </tr>`).join('')}
    </tbody>
  </table></div>

  <h2>来源变更记录（待研究员确认）</h2>
  ${changes.length ? `<div class="scroll-x"><table>
    <thead><tr><th>检测时间</th><th>来源</th><th>变更类型</th><th>摘要</th><th>确认状态</th><th>操作</th></tr></thead>
    <tbody>${changes.map((c) => `<tr>
      <td class="tiny nowrap">${h(c.detected_at.slice(0, 19).replace('T', ' '))}</td>
      <td class="tiny">${h(c.source_title || '—')}</td>
      <td><span class="badge ${c.change_kind === 'fetch_failed' ? 'fail' : 'unknown'}">${h(c.change_kind)}</span></td>
      <td class="tiny">${h(c.diff_summary || '')}</td>
      <td>${c.review_status === 'pending' ? '<span class="badge unknown">待确认</span>' : `<span class="badge pass">${h(c.review_status)}</span>`}</td>
      <td>${c.review_status === 'pending' ? `<button data-act="change-confirm" data-id="${h(c.id)}">确认</button>` : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>` : '<div class="card"><p class="muted">尚无变更记录。点击「演练比对」或「执行受控抓取」建立基线。</p></div>'}

  <h2>告警（${alerts.length} 条）</h2>
  ${alerts.length ? alerts.map(alertRow).join('') : '<div class="card"><p class="muted">无告警。</p></div>'}

  <h2>订阅</h2>
  <div class="card">
    <table>
      <thead><tr><th>订阅名</th><th>领域</th><th>地区</th><th>项目类型</th><th>渠道</th><th>状态</th></tr></thead>
      <tbody>${subs.map((s) => `<tr>
        <td>${h(s.name)}</td>
        <td class="tiny">${h((s.domains || []).join('、') || '全部')}</td>
        <td class="tiny">${h((s.regions || []).join('、') || '全部')}</td>
        <td class="tiny">${h((s.project_types || []).join('、') || '全部')}</td>
        <td class="tiny">${h(s.channel)}</td>
        <td>${s.active ? '<span class="badge pass">启用</span>' : '<span class="badge gray">停用</span>'}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

/* ============================== 方法学库 ============================== */

async function MethodologyListView(query) {
  const qs = new URLSearchParams(query || {}).toString();
  const d = await api(`/api/methodologies${qs ? '?' + qs : ''}`);
  const domains = [...new Set([...d.formal, ...d.draft].map((m) => m.domain).filter(Boolean))];

  const row = (m) => `<tr>
    <td class="mono nowrap">${m.code_display ? h(m.code_display) : '<span class="badge unknown">编号待核实</span>'}<div class="tiny muted">${h(m.methodology_id)}</div></td>
    <td><a href="#/methodologies/${h(m.id)}">${h(m.name)}</a>
      ${m.exclusion_note ? `<div class="tiny muted">${h(m.exclusion_note)}</div>` : ''}</td>
    <td class="tiny">${h(m.domain || '—')}</td>
    <td class="tiny">${h((m.project_types || []).join('、') || '—')}</td>
    <td class="tiny nowrap">${h(m.release_date || '—')}</td>
    <td class="tiny nowrap">${h(m.effective_date || '—')}</td>
    <td>${m.rulecard_status === 'approved' ? '<span class="badge pass">已通过</span>' : '<span class="badge unknown">待审批</span>'}</td>
    <td>${m.has_plugin_module
      ? `<span class="badge ${m.calculator_status === 'approved' ? 'info' : 'fail'}">${m.calculator_status === 'approved' ? '已通过审批' : '禁止出数（未通过审批）'}</span>`
      : '<span class="badge gray">暂不支持自动测算</span>'}</td>
    <td class="tiny">${m.official_url ? `<a href="${h(m.official_url)}" target="_blank" rel="noreferrer">原文</a>` : '—'}</td>
  </tr>`;

  return `
  <div class="page-head">
    <div><h1>方法学库</h1>
      <p class="muted">按名称、编号、领域、版本、状态检索。正式发布与征求意见分栏；每条记录可打开官方原文。</p>
    </div>
  </div>

  <div class="card">
    <form class="inline-form" data-act="methodology-filter">
      <label class="field"><span>关键词（名称 / 编号）</span>
        <input name="keyword" value="${h(query.keyword || '')}" placeholder="如 瓦斯、CCER-10-001" /></label>
      <label class="field"><span>领域</span>
        <select name="domain"><option value="">全部领域</option>
          ${domains.map((x) => `<option value="${h(x)}" ${query.domain === x ? 'selected' : ''}>${h(x)}</option>`).join('')}
        </select></label>
      <label class="field"><span>状态</span>
        <select name="status"><option value="">全部</option>
          <option value="formal" ${query.status === 'formal' ? 'selected' : ''}>正式发布</option>
          <option value="revised_draft" ${query.status === 'revised_draft' ? 'selected' : ''}>修订征求意见稿</option>
          <option value="draft" ${query.status === 'draft' ? 'selected' : ''}>征求意见稿</option>
        </select></label>
      <div class="btn-row"><button class="primary" type="submit">检索</button>
        <a class="btn" href="#/methodologies">重置</a></div>
    </form>
  </div>

  <div class="grid c3">
    <div class="stat teal"><div class="n">${d.counts.formal}</div><div class="k">正式发布版本</div></div>
    <div class="stat green"><div class="n">${d.counts.candidate_eligible}</div><div class="k">可列为可申报候选</div></div>
    <div class="stat amber"><div class="n">${d.counts.draft}</div><div class="k">草案 / 征求意见稿（仅观察）</div></div>
  </div>

  <h2>正式发布</h2>
  <div class="scroll-x"><table>
    <thead><tr><th>编号</th><th>名称</th><th>领域</th><th>支持项目类型</th><th>发布日</th><th>生效日</th><th>规则卡</th><th>自动测算</th><th>来源</th></tr></thead>
    <tbody>${d.formal.map(row).join('') || '<tr><td colspan="9" class="muted">无匹配记录</td></tr>'}</tbody>
  </table></div>

  <h2>草案与征求意见稿</h2>
  <div class="note warn">${h(d.note)}</div>
  <div class="scroll-x"><table>
    <thead><tr><th>编号</th><th>名称</th><th>领域</th><th>支持项目类型</th><th>发布日</th><th>生效日</th><th>规则卡</th><th>自动测算</th><th>来源</th></tr></thead>
    <tbody>${d.draft.map(row).join('') || '<tr><td colspan="9" class="muted">无草案记录</td></tr>'}</tbody>
  </table></div>`;
}

async function MethodologyDetailView(id) {
  const d = await api(`/api/methodologies/${id}`);
  const v = d.version;

  const ruleBlock = (r) => `<div class="rule">
    <div class="head">
      <span class="badge gray">${h(r.rule_id)}</span>
      <span class="badge ${r.layer === 'common' ? 'info' : r.layer === 'conflict' ? 'unknown' : 'teal'}">${h({ common: '通用门槛', specific: '专属条件', conflict: '冲突与重复' }[r.layer] || r.layer)}</span>
      <span class="badge ${r.severity === 'blocking' ? 'fail' : r.severity === 'major' ? 'unknown' : 'gray'}">${h({ blocking: '硬障碍', major: '重大', minor: '提示' }[r.severity] || r.severity)}</span>
      <span class="t">${h(r.title)}</span>
    </div>
    <div class="body">${nl2br(r.condition_text)}</div>
    <dl class="kv">
      <dt>逻辑表达式</dt><dd class="mono">${h(r.expression_text)}</dd>
      <dt>证据要求</dt><dd>${h(r.evidence_requirement || '—')}${r.evidence_policy === 'strict' ? ' <span class="badge unknown">严格证据</span>' : ''}</dd>
      <dt>条款页码</dt><dd>${h(r.clause_ref || '—')}</dd>
      <dt>不通过含义</dt><dd>${h(r.fail_conclusion || '—')}</dd>
    </dl>
  </div>`;

  return `
  <div class="page-head">
    <div>
      <h1>${h(v.name)}</h1>
      <p class="muted">
        <span class="mono">${h(v.code_display || v.methodology_id)}</span>　
        <span class="badge ${v.document_status === 'formal' ? 'pass' : 'draft'}">${h(STATUS_LABEL[v.document_status] || v.document_status)}</span>
        <span class="badge gray">版本 ${h(v.version)}</span>
        <span class="badge gray">${h(v.domain || '—')}</span>
        ${v.official_url ? `<a href="${h(v.official_url)}" target="_blank" rel="noreferrer" style="margin-left:8px">打开官方原文</a>` : ''}
      </p>
    </div>
    <a class="btn" href="#/methodologies">← 返回目录</a>
  </div>

  ${v.exclusion_note ? `<div class="note warn">${h(v.exclusion_note)}</div>` : ''}

  <div class="grid c2">
    <div class="card">
      <h2>适用范围</h2>
      <dl class="kv" style="grid-template-columns:110px 1fr">
        <dt>支持项目类型</dt><dd>${h((v.project_types || []).join('、') || '—')}</dd>
        <dt>技术路径</dt><dd>${h((v.tech_routes || []).join('、') || '—')}</dd>
        <dt>规模 / 边界</dt><dd>${nl2br(v.scale_note || '—')}</dd>
        <dt>计入期与监测</dt><dd>${nl2br(v.crediting_note || '—')}</dd>
        <dt>目录置信度</dt><dd class="mono tiny">${h(v.catalog_confidence)}</dd>
        <dt>可列为候选</dt><dd>${v.is_candidate_eligible ? '<span class="badge pass">可以</span>' : '<span class="badge fail">不可以（见上）</span>'}</dd>
      </dl>
    </div>
    <div class="card">
      <h2>审计信息</h2>
      <dl class="kv" style="grid-template-columns:110px 1fr">
        <dt>发布机关</dt><dd>${h(v.release_date ? '生态环境部（依发布通知）' : '—')}</dd>
        <dt>发布日期</dt><dd>${h(v.release_date || '—')}</dd>
        <dt>生效日期</dt><dd>${h(v.effective_date || '—')}</dd>
        <dt>规则卡状态</dt><dd>${approvalBadge(v.rulecard_status)}</dd>
        <dt>计算插件审批</dt><dd>${approvalBadge(v.calculator_status)}</dd>
        <dt>业务测算</dt><dd><span class="badge ${v.calculator_status === 'approved' ? 'info' : 'fail'}">${v.calculator_status === 'approved' ? '已通过审批（仍须条件检查无硬障碍）' : '禁止出数（未通过审批）'}</span></dd>
        <dt>演示通道</dt><dd>${state.demoChannel ? '<span class="badge unknown">已开启（隔离的反事实推演）</span>' : '<span class="badge gray">未开启</span>'}</dd>
      </dl>
      ${d.plugin ? `<div class="note warn" style="margin-top:10px">${h(d.plugin.status_note)}</div>` : ''}
    </div>
  </div>

  ${d.plugin ? `
  <h2>计算插件</h2>
  <div class="card">
    <p><strong>${h(d.plugin.title)}</strong>　<span class="mono tiny">${h(d.plugin.plugin_key)} @ ${h(d.plugin.plugin_version)}</span></p>
    <h3>公式引用</h3>
    <table><thead><tr><th>ID</th><th>名称</th><th>表达式</th><th>单位</th><th>条款</th></tr></thead>
      <tbody>${d.plugin.formula_refs.map((f) => `<tr>
        <td class="mono">${h(f.formula_id)}</td><td>${h(f.title)}</td>
        <td class="mono">${h(f.expression)}</td><td>${h(f.unit || '—')}</td>
        <td class="tiny">${h(f.clause_ref || '—')}</td></tr>`).join('')}</tbody></table>

    <h3>输入参数与绑定方式</h3>
    <table><thead><tr><th>参数</th><th>来源</th><th>绑定字段 / 因子</th><th>单位</th><th>必需</th><th>合理范围</th></tr></thead>
      <tbody>${d.plugin.parameters.map((p) => `<tr>
        <td>${h(p.label)}<div class="tiny muted mono">${h(p.key)}</div></td>
        <td>${h({ fact: '项目事实', input: '情景输入' }[p.source] || p.source)}</td>
        <td class="mono tiny">${h(p.fact_key || p.factor_fallback || '—')}</td>
        <td class="tiny">${h(p.unit || '—')}</td>
        <td>${p.required ? '<span class="badge fail">必需</span>' : '<span class="badge gray">可选</span>'}</td>
        <td class="tiny">${p.min ?? '—'} ~ ${p.max ?? '—'}</td></tr>`).join('')}</tbody></table>

    <h3>情景定义</h3>
    <table><thead><tr><th>情景</th><th>乘数</th><th>说明</th></tr></thead>
      <tbody>${Object.entries(d.plugin.scenarios).map(([k, s]) => `<tr>
        <td class="mono">${h(k)}</td><td class="mono tiny">${h(JSON.stringify(s.multipliers))}</td>
        <td class="tiny">${h(s.note)}</td></tr>`).join('')}</tbody></table>

    <h3>独立复算样例（供领域人员手算 / 电子表格复核）</h3>
    ${d.plugin.self_check_samples.map((s) => `<div class="rule">
      <div class="head"><span class="badge teal">样例</span><span class="t">${h(s.name)}</span></div>
      <div class="kv" style="grid-template-columns:150px 1fr">
        ${Object.entries(s.inputs).map(([k, val]) => `<dt class="mono tiny">${h(k)}</dt><dd class="mono tiny">${h(JSON.stringify(val))}</dd>`).join('')}
      </div>
      ${s.expectRejection ? `<div class="body"><span class="badge fail">预期被拒绝</span> ${h(s.expectRejection)}</div>` : `
      <div class="kv" style="grid-template-columns:150px 1fr">
        ${Object.entries(s.expect || {}).map(([k, val]) => `<dt class="mono tiny">${h(k)}</dt><dd class="mono tiny">${h(val)}</dd>`).join('')}
      </div>`}
    </div>`).join('')}
  </div>` : ''}

  <h2>因子版本</h2>
  <div class="card scroll-x">
    <table><thead><tr><th>因子</th><th>名称</th><th class="num">取值</th><th>单位</th><th>出处</th><th>年份</th><th>状态</th><th>待确认说明</th></tr></thead>
      <tbody>${d.factors.map((f) => `<tr>
        <td class="mono tiny">${h(f.factor_key)}</td>
        <td>${h(f.name)}</td>
        <td class="num">${num(f.value, 6)}</td>
        <td class="tiny">${h(f.unit || '—')}</td>
        <td class="tiny">${h(f.source_ref || '—')}</td>
        <td class="tiny">${h(f.source_year ?? '—')}</td>
        <td><span class="badge ${f.value_status === 'verified' ? 'pass' : f.value_status === 'placeholder' ? 'unknown' : 'gray'}">${h({ verified: '已核实', placeholder: '占位待确认', deprecated: '已弃用' }[f.value_status] || f.value_status)}</span></td>
        <td class="tiny">${h(f.verification_note || '—')}</td></tr>`).join('')}</tbody></table>
  </div>

  <h2>规则卡（${d.rules.length} 条）</h2>
  ${d.rules.filter((r) => r.layer === 'specific').map(ruleBlock).join('') || '<div class="card"><p class="muted">该方法学尚未建立规则卡。可供检索，但不可显示为「已完成条件检查」。</p></div>'}

  ${d.rules.some((r) => r.layer !== 'specific') ? `<details><summary>查看通用门槛与冲突规则（所有方法学共用）</summary>
    <div>${d.rules.filter((r) => r.layer !== 'specific').map(ruleBlock).join('')}</div></details>` : ''}
  `;
}

/* ============================== 项目列表 ============================== */

async function ProjectListView(query) {
  const list = await api(`/api/projects${query.teamId ? '?teamId=' + encodeURIComponent(query.teamId) : ''}`);
  const projects = list.projects;
  const fields = state.meta?.fields || [];
  const types = (fields.find((f) => f.key === 'proj.project_type')?.enum_values) || [];

  return `
  <div class="page-head">
    <div><h1>项目档案与筛选</h1>
      <p class="muted">项目资料、证据定位、候选方法学匹配、申报条件检查、情景初算与报告全部落在同一个项目档案内。</p>
    </div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">新建项目档案</h2>
    <form class="inline-form" data-act="project-create">
      <label class="field"><span>项目名称</span><input name="name" required placeholder="如：××煤业低浓度瓦斯发电项目" /></label>
      <label class="field"><span>项目编号</span><input name="code" placeholder="留空自动生成" /></label>
      <label class="field"><span>业主</span><input name="owner_name" /></label>
      <label class="field"><span>项目类型</span>
        <select name="project_type">${types.map((t) => `<option value="${h(t)}">${h(t)}</option>`).join('')}</select></label>
      <label class="field"><span>技术路线</span><input name="technology_route" placeholder="如：低浓度瓦斯发电" /></label>
      <label class="field"><span>省份</span><input name="province" /></label>
      <label class="field"><span>保密等级</span>
        <select name="confidentiality">
          <option value="internal">internal（团队内可见）</option>
          <option value="public">public（全员可见）</option>
          <option value="confidential">confidential</option>
          <option value="restricted">restricted</option>
        </select></label>
      <div class="btn-row"><button class="primary" type="submit">创建项目</button></div>
    </form>
  </div>

  <div class="scroll-x"><table>
    <thead><tr>
      <th>编号</th><th>项目名称</th><th>业主</th><th>项目类型 / 技术路线</th><th>地点</th>
      <th>注册登记链条状态</th><th>三套数字（tCO₂e）</th><th>保密 / 团队</th><th>分析人</th><th>操作</th>
    </tr></thead>
    <tbody>
    ${projects.map((p) => `<tr>
      <td class="mono tiny nowrap">${h(p.code)}</td>
      <td><a href="#/projects/${h(p.id)}">${h(p.name)}</a></td>
      <td class="tiny">${h(p.owner_name || '—')}</td>
      <td class="tiny">${h(p.project_type || '—')}<div class="muted">${h(p.technology_route || '')}</div></td>
      <td class="tiny">${h([p.province, p.city].filter(Boolean).join(' ') || '—')}</td>
      <td class="tiny">${p.registry_stage.map((s) => `<span class="badge ${s === '未进入注册登记流程' ? 'gray' : 'teal'}">${h(s)}</span>`).join(' ')}</td>
      <td class="tiny">
        业主公示预计：${num(p.owner_announced_estimate, 0)}<br/>
        核查确定：${num(p.verified_amount, 0)}<br/>
        登记量：${num(p.registered_amount, 0)}
      </td>
      <td class="tiny">${h(p.confidentiality)}<div class="muted">${h(p.team_id)}</div></td>
      <td class="tiny">${h(p.analyst || '—')}</td>
      <td><a class="btn" href="#/projects/${h(p.id)}">打开</a></td>
    </tr>`).join('')}
    </tbody>
  </table></div>
  ${projects.length ? '' : `<div class="card"><p class="muted">当前登录身份（${h((state.user && state.user.name) || '未登录')}
    · ${h((state.user && state.user.team_id) || '—')}）下没有可见的项目。
    所有演示项目都属于 <span class="mono">team-invest</span>，如需查看请退出登录后以有权限的演示账号重新登录。</p></div>`}`;
}

/* ============================== 项目详情 ============================== */

async function ProjectDetailView(id, query) {
  const tab = query.tab || 'overview';
  const d = await api(`/api/projects/${id}`);
  const p = d.project;
  const tabs = [
    ['overview', '概览与合规状态'],
    ['facts', `事实与证据（${d.facts.length}）`],
    ['match', '候选方法学匹配'],
    ['eligibility', '申报条件检查'],
    ['calc', '减排量初算'],
    ['report', '投资筛选报告'],
  ];
  const body = await (async () => {
    switch (tab) {
      case 'facts': return FactsTab(p, d);
      case 'match': return await MatchTab(p);
      case 'eligibility': return await EligibilityTab(p, d);
      case 'calc': return await CalcTab(p, d);
      case 'report': return await ReportTab(p);
      default: return OverviewTab(p, d);
    }
  })();

  return `
  <div class="page-head">
    <div>
      <h1>${h(p.name)}</h1>
      <p class="muted">
        <span class="mono">${h(p.code)}</span>　${h(p.owner_name || '')}　${h([p.province, p.city].filter(Boolean).join(' '))}
        <span class="badge gray">${h(p.confidentiality)}</span>
        <span class="badge gray">${h(p.team_id)}</span>
      </p>
    </div>
    <a class="btn" href="#/projects">← 返回项目列表</a>
  </div>
  <div class="subtabs">
    ${tabs.map(([k, label]) => `<button data-nav-tab="${h(k)}" data-project="${h(p.id)}" class="${tab === k ? 'active' : ''}">${h(label)}</button>`).join('')}
  </div>
  ${body}`;
}

function OverviewTab(p, d) {
  const stage = [
    ['registry_project_public', '项目公示'],
    ['registry_validated', '审定'],
    ['registry_project_registered', '项目登记'],
    ['registry_reduction_public', '减排量公示'],
    ['registry_verified', '核查'],
    ['registry_reduction_registered', '减排量登记'],
  ];
  return `
  <div class="grid c2">
    <div class="card">
      <h2>项目本体</h2>
      <dl class="kv" style="grid-template-columns:110px 1fr">
        <dt>项目编号</dt><dd class="mono">${h(p.code)}</dd>
        <dt>业主</dt><dd>${h(p.owner_name || '—')}</dd>
        <dt>项目类型</dt><dd>${h(p.project_type || '—')}</dd>
        <dt>技术路线</dt><dd>${h(p.technology_route || '—')}</dd>
        <dt>地点</dt><dd>${h([p.province, p.city].filter(Boolean).join(' ') || '—')}</dd>
        <dt>阶段</dt><dd>${h(p.stage || '—')}</dd>
        <dt>产能 / 规模</dt><dd>${h(p.capacity_note || '—')}</dd>
        <dt>项目边界</dt><dd>${h(p.boundary_desc || '—')}</dd>
        <dt>分析人</dt><dd>${h(p.analyst || '—')}</dd>
        <dt>最近更新</dt><dd class="tiny">${h(p.updated_at.slice(0, 19).replace('T', ' '))}</dd>
      </dl>
    </div>

    <div class="card">
      <h2>注册登记链条状态（分列存储）</h2>
      <div class="note info">「项目公示」「审定」「项目登记」「减排量公示」「核查」「减排量登记」为六个独立状态，系统不将它们合并显示。</div>
      <form data-act="registry-update" data-project="${h(p.id)}">
        <table>
          <thead><tr><th>状态</th><th style="width:90px">已达成</th></tr></thead>
          <tbody>
          ${stage.map(([k, label]) => `<tr>
            <td>${h(label)}</td>
            <td><input type="checkbox" name="${k}" ${p[k] ? 'checked' : ''} style="width:auto" /></td>
          </tr>`).join('')}
          </tbody>
        </table>
        <h3>三套数字分开存储（tCO₂e）</h3>
        <div class="inline-form">
          <label class="field"><span>业主公示预计减排量</span><input name="owner_announced_estimate" type="number" value="${p.owner_announced_estimate ?? ''}" /></label>
          <label class="field"><span>核查报告确定的量</span><input name="verified_amount" type="number" value="${p.verified_amount ?? ''}" /></label>
          <label class="field"><span>登记量</span><input name="registered_amount" type="number" value="${p.registered_amount ?? ''}" /></label>
          <label class="field"><span>公示页地址</span><input name="registry_public_url" value="${h(p.registry_public_url || '')}" /></label>
        </div>
        <div class="btn-row" style="margin-top:9px"><button class="primary" type="submit">保存状态</button></div>
      </form>
    </div>
  </div>

  <div class="card">
    <h2>资料完备性速览</h2>
    <p>已录入事实字段 <strong>${d.facts.length}</strong> 条；证据记录 <strong>${d.evidence.length}</strong> 条
      ${d.evidence_hidden ? `（另有 ${d.evidence_hidden} 条因保密限制不可见）` : ''}。</p>
    <div class="btn-row">
      <button data-nav-tab="facts" data-project="${h(p.id)}">录入 / 查看事实与证据</button>
      <button data-act="quick-match" data-project="${h(p.id)}">运行候选方法学匹配</button>
      <button class="primary" data-act="quick-elig" data-project="${h(p.id)}">运行申报条件检查</button>
    </div>
  </div>`;
}

function FactsTab(p, d) {
  const groups = d.facts.reduce((acc, f) => {
    (acc[f.group_name] ||= []).push(f);
    return acc;
  }, {});
  const order = state.meta?.group_order || Object.keys(groups);
  const allFields = state.meta?.fields || [];

  return `
  <div class="grid c2">
    <div class="card">
      <h2>录入 / 更新项目事实</h2>
      <form data-act="fact-upsert" data-project="${h(p.id)}">
        <label class="field"><span>字段</span>
          <select name="field_key" required>
            ${allFields.map((f) => `<option value="${h(f.key)}">[${h(f.group_name)}] ${h(f.label)}${f.evidence_policy === 'strict' ? '（严格证据）' : ''}</option>`).join('')}
          </select></label>
        <div class="inline-form">
          <label class="field"><span>取值</span><input name="value" placeholder="日期填 YYYY-MM-DD" /></label>
          <label class="field"><span>来源类型</span>
            <select name="source_kind">
              <option value="project_doc">project_doc 项目资料</option>
              <option value="official">official 官方文件</option>
              <option value="analyst">analyst 分析师录入</option>
              <option value="owner_claim">owner_claim 业主自述</option>
              <option value="assumption">assumption 模型假设</option>
            </select></label>
          <label class="field"><span>关联证据</span>
            <select name="evidence_id"><option value="">（不关联）</option>
              ${d.evidence.map((e) => `<option value="${h(e.id)}">${h(e.file_name)}${e.page ? ` p.${e.page}` : ''}</option>`).join('')}
            </select></label>
        </div>
        <label class="field"><span>备注</span><input name="note" placeholder="说明口径或补充材料计划" /></label>
        <div class="btn-row"><button class="primary" type="submit">保存事实</button></div>
      </form>

      <div class="section-split"></div>
      <h3>新增证据记录</h3>
      <form data-act="evidence-add" data-project="${h(p.id)}">
        <div class="inline-form">
          <label class="field"><span>文件名</span><input name="file_name" required /></label>
          <label class="field"><span>文件类型</span>
            <select name="doc_type">
              ${['项目建议书', '可研', '环评', '能源台账', '监测台账', '合同', '开工报告', '公示截图', '其他']
                .map((x) => `<option value="${h(x)}">${h(x)}</option>`).join('')}
            </select></label>
          <label class="field"><span>页码</span><input name="page" type="number" min="1" /></label>
          <label class="field"><span>保密等级</span>
            <select name="confidentiality"><option value="internal">internal</option><option value="restricted">restricted（仅研究员/复核人/管理员）</option></select></label>
        </div>
        <label class="field"><span>证据片段（原文摘录）</span><textarea name="excerpt" placeholder="粘贴与判断直接相关的原文片段"></textarea></label>
        <div class="btn-row"><button type="submit">新增证据</button></div>
      </form>
    </div>

    <div class="card">
      <h2>证据清单</h2>
      ${d.evidence.length ? `<table>
        <thead><tr><th>文件</th><th>类型</th><th>页</th><th>保密</th><th>上传</th><th>片段</th></tr></thead>
        <tbody>${d.evidence.map((e) => `<tr>
          <td class="tiny">${h(e.file_name)}</td><td class="tiny">${h(e.doc_type || '—')}</td>
          <td class="tiny">${e.page ?? '—'}</td>
          <td class="tiny">${h(e.confidentiality)}</td>
          <td class="tiny">${h(e.uploaded_by || '')}<div class="muted">${h((e.uploaded_at || '').slice(0, 10))}</div></td>
          <td class="tiny">${h((e.excerpt || '').slice(0, 90))}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">暂无证据记录。</p>'}
      ${d.evidence_hidden ? `<div class="note warn">有 ${d.evidence_hidden} 条证据因保密等级限制，当前身份不可查看；导出记录已写入审计日志。</div>` : ''}
    </div>
  </div>

  <h2>项目事实</h2>
  ${order.filter((g) => groups[g]).map((g) => `
    <h3>${h(g)}</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>字段</th><th>取值</th><th>单位</th><th>来源标注</th><th>证据定位</th><th>录入</th><th>备注</th></tr></thead>
      <tbody>${groups[g].map((f) => `<tr>
        <td>${h(f.label)}<div class="tiny muted mono">${h(f.field_key)}</div></td>
        <td>${f.value === null || f.value === '' ? '<span class="badge unknown">未填写</span>' : h(Array.isArray(f.value) ? f.value.join('、') : f.value)}</td>
        <td class="tiny">${h(f.unit || '—')}</td>
        <td>${sourceTag(f.source_kind)}</td>
        <td class="tiny">${f.evidence
          ? (f.evidence.blocked
            ? `<span class="badge fail">受保密限制</span>`
            : `${h(f.evidence.file_name)}${f.evidence.page ? ` p.${f.evidence.page}` : ''}<div class="muted">${h((f.evidence.excerpt || '').slice(0, 60))}</div>`)
          : '<span class="badge gray">无证据</span>'}</td>
        <td class="tiny">${h(f.asserted_by || '')}<div class="muted">${h((f.asserted_at || '').slice(0, 10))}</div></td>
        <td class="tiny">${h(f.note || '—')}</td></tr>`).join('')}</tbody></table></div>
  `).join('') || '<div class="card"><p class="muted">尚未录入任何事实字段。</p></div>'}`;
}

async function MatchTab(p) {
  const [hist, gate] = await Promise.all([
    api(`/api/projects/${p.id}/runs`),
    fetchDemoChannel(),
  ]);
  const pluginKeys = new Set((gate.data?.plugins || []).filter((x) => x.calculator_status === 'approved').map((x) => x.methodology_id));
  const last = hist.matches[0];
  let result = null;
  if (last) {
    const r = await api(`/api/projects/${p.id}/match`, { method: 'POST', body: { analysisBaseDate: last.analysis_base_date, cached: true } });
    result = r;
  }
  return `
  <div class="card">
    <div class="btn-row">
      <button class="primary" data-act="run-match" data-project="${h(p.id)}" data-approved="${h([...pluginKeys].join(','))}">运行候选方法学匹配</button>
      <span class="tiny muted">匹配分数仅用于排序，不代表申报成功概率。</span>
    </div>
    <div class="note ${gate.enabled ? 'warn' : 'danger'}" style="margin-top:10px">
      <strong>业务测算当前一律被阻止出数</strong>（方法学审批未通过 / 含占位系数 / 缺条款页码）。
      匹配结果只用于排序候选与列出证据缺口，不产生任何减排量数字。
      ${gate.enabled ? '管理员已开启演示通道，如需流程演示可在「减排量初算」页选择演示通道。' : '演示通道当前未开启。'}
    </div>
  </div>
  <div id="match-result">${result ? matchResultHtml(result, pluginKeys) : '<div class="card"><p class="muted">尚未运行匹配。</p></div>'}</div>
  <div class="card">
    <h3>历史匹配运行</h3>
    <table><thead><tr><th>运行时间</th><th>分析基准日</th><th>操作人</th></tr></thead>
      <tbody>${hist.matches.map((m) => `<tr><td class="tiny">${h(m.run_at.slice(0, 19).replace('T', ' '))}</td>
        <td class="tiny">${h(m.analysis_base_date)}</td><td class="tiny">${h(m.operator || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">无</td></tr>'}</tbody></table>
  </div>`;
}

function matchResultHtml(r, approvedPlugins) {
  // 审批状态变化会改变「可测算 / 禁止出数」的显示，因此按最新插件状态实时判断
  const approved = approvedPlugins || new Set();
  return `
  <div class="card">
    <h3>可申报候选（${r.candidates.length}）</h3>
    ${r.candidates.length ? `<div class="scroll-x"><table>
      <thead><tr><th>候选方法学</th><th>版本状态</th><th class="num">匹配分</th><th>评分构成</th><th>规模/边界条件</th><th>自动测算</th></tr></thead>
      <tbody>${r.candidates.map((c) => `<tr>
        <td><a href="#/methodologies/${h(c.methodology_version_id)}">${h(c.code_display || c.methodology_id)} ${h(c.name)}</a></td>
        <td><span class="badge pass">正式发布</span><div class="tiny muted">生效 ${h(c.effective_date || '—')}</div></td>
        <td class="num">${c.score}</td>
        <td class="tiny">${c.score_breakdown.map((b) => `${h(b.item)} <strong>+${b.points}</strong>`).join('<br/>')}</td>
        <td class="tiny">${h(c.scale_note || '—')}</td>
        <td>${approved.has(c.methodology_id)
          ? '<span class="badge info">插件已通过审批</span>'
          : '<span class="badge fail">禁止出数（未通过审批）</span>'}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="note warn">无可申报候选。见下方排除理由。</div>'}
  </div>

  ${r.observations.length ? `<div class="card">
    <h3>观察项（草案 / 修订征求意见稿，不得列为候选）</h3>
    ${r.observations.map((o) => `<div class="rule unknown">
      <div class="head"><span class="badge draft">${h(STATUS_LABEL[o.document_status] || o.document_status)}</span><span class="t">${h(o.code_display || o.methodology_id)} ${h(o.name)}</span></div>
      <div class="body">${h(o.reason)}</div></div>`).join('')}
  </div>` : ''}

  <div class="card">
    <h3>被排除的方法学及理由（${r.excluded.length}）</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>方法学</th><th>排除代码</th><th>理由</th></tr></thead>
      <tbody>${r.excluded.map((e) => `<tr>
        <td class="tiny">${h(e.code_display || '（编号待核实）')} ${h(e.name)}</td>
        <td class="tiny mono">${h(e.reason_code)}</td><td class="tiny">${h(e.reason)}</td></tr>`).join('')}</tbody></table></div>
  </div>

  <div class="grid c2">
    <div class="card">
      <h3>最小补充材料清单</h3>
      ${r.gap_list.length ? `<table><thead><tr><th>字段</th><th>归属</th><th>证据策略</th></tr></thead>
        <tbody>${r.gap_list.map((g) => `<tr>
          <td class="tiny">${h(g.label)}<div class="muted mono">${h(g.field_key)}</div></td>
          <td class="tiny">${h(g.required_for)}</td>
          <td>${g.evidence_policy === 'strict' ? '<span class="badge unknown">严格证据</span>' : '<span class="badge gray">普通</span>'}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">无缺口。</p>'}
    </div>
    <div class="card">
      <h3>证据不足 / 来源不合格的字段</h3>
      ${r.unknown_fields.length ? `<table><thead><tr><th>字段</th><th>值</th><th>来源</th><th>原因</th></tr></thead>
        <tbody>${r.unknown_fields.map((u) => `<tr>
          <td class="tiny mono">${h(u.field_key)}</td><td class="tiny">${h(u.value ?? '—')}</td>
          <td>${sourceTag(u.source_kind)}</td><td class="tiny">${h(u.reason)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">无。</p>'}
    </div>
  </div>

  <div class="note info">${h(r.scoring_note)}</div>`;
}

/** 演示通道是否可用：以最新状态为准（任务组快照里的 demo_channel_available 可能已过期，不能单独采信） */
async function demoChannelUsableNow() {
  const gate = await fetchDemoChannel();
  return { enabled: gate.enabled, usable: demoChannelUsable(gate.enabled), denied: gate.denied };
}

async function EligibilityTab(p, d) {
  const [hist, chan] = await Promise.all([
    api(`/api/projects/${p.id}/eligibility`),
    demoChannelUsableNow(),
  ]);
  const latest = hist.latest;
  return `
  <div class="card">
    <div class="btn-row">
      <button class="primary" data-act="run-elig" data-project="${h(p.id)}">运行申报条件检查</button>
      <span class="tiny muted">自动选取匹配分最高的方法学版本；也可在下方历史记录中对比不同版本的判断。</span>
    </div>
  </div>
  <div id="elig-result">${latest && latest.result && latest.result.layers
    ? eligibilityResultHtml(latest.result, { linkProjectId: p.id, demoEnabled: chan.enabled, demoUsable: chan.usable })
    : '<div class="card"><p class="muted">尚未运行条件检查。</p></div>'}</div>

  <div class="card">
    <h3>历史条件检查运行</h3>
    <table><thead><tr><th>时间</th><th>基准日</th><th>方法学</th><th>结论</th><th>复核状态</th></tr></thead>
      <tbody>${hist.history.map((x) => `<tr>
        <td class="tiny">${h(x.run_at.slice(0, 19).replace('T', ' '))}</td>
        <td class="tiny">${h(x.analysis_base_date)}</td>
        <td class="tiny">${h(x.code_display || '—')} ${h(x.methodology_name || '')}</td>
        <td>${conclusionBadge(x.conclusion)}</td>
        <td><span class="badge ${x.review_status === 'approved' ? 'pass' : 'gray'}">${h(x.review_status)}</span></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">无</td></tr>'}</tbody></table>
    <div class="tiny muted" style="margin-top:8px">条件检查本身不受门禁限制：它只输出三态判断、硬障碍与证据缺口，不含任何减排量数字。
      演示通道状态（实时）：${chan.enabled ? '<span class="badge unknown">已开启</span>' : '<span class="badge gray">未开启</span>'}${chan.denied ? '（读取失败或权限不足，按未开启处理）' : ''}
      —— 快照里记录的通道状态可能已过期，以本行为准。</div>
  </div>`;
}

function eligibilityResultHtml(r, opts = {}) {
  const layerBlock = (title, rules, note) => `
    <div class="card">
      <h3>${h(title)}</h3>
      ${note ? `<div class="note info">${h(note)}</div>` : ''}
      ${rules.map(ruleHtml).join('') || '<p class="muted">无规则。</p>'}
    </div>`;

  const ca = r.calculation_availability || {};
  return `
  <div class="card">
    <div class="page-head">
      <div>
        <h3 style="margin-top:0">筛选结论</h3>
        <p style="font-size:17px">${conclusionBadge(r.conclusion)}</p>
      </div>
      <div class="tiny muted right">
        运行时间：${h(r.run_at.slice(0, 19).replace('T', ' '))}<br/>
        分析基准日：${h(r.analysis_base_date)}<br/>
        方法学版本：${r.methodology_version ? h(r.methodology_version.code_display || r.methodology_version.methodology_id) : '—'}
      </div>
    </div>
    <div class="grid c6" style="margin-top:10px">
      <div class="stat green"><div class="n">${r.summary.pass}</div><div class="k">通过</div></div>
      <div class="stat red"><div class="n">${r.summary.fail}</div><div class="k">不通过</div></div>
      <div class="stat amber"><div class="n">${r.summary.unknown}</div><div class="k">待核实</div></div>
      <div class="stat red"><div class="n">${r.summary.blocking_failures}</div><div class="k">硬障碍</div></div>
      <div class="stat amber"><div class="n">${r.summary.unknown_blocking}</div><div class="k">关键项待核实</div></div>
      <div class="stat blue"><div class="n">${r.gap_list.length}</div><div class="k">字段缺口</div></div>
    </div>
    <div class="note ${r.conclusion === '可继续尽调' ? 'ok' : r.conclusion === '存在明确障碍' ? 'danger' : 'warn'}" style="margin-top:12px">
      ${nl2br(r.summary_text)}
    </div>
    <div class="note ${ca.available ? 'info' : 'warn'}">
      <strong>测算可用性：</strong>${nl2br(ca.reason || '（本次运行未返回测算可用性说明）').replace(/\*\*/g, '')}
      ${!ca.available && (ca.blockers || []).length ? `
        <div style="margin-top:6px">阻断项（逐条）：</div>
        <ul class="blocker-list">${ca.blockers.map((b) => `<li>${h(b)}</li>`).join('')}</ul>` : ''}
      ${!ca.available && opts.demoUsable ? `
        <div class="tiny" style="margin-top:6px">
          管理员已开启<strong>演示通道</strong>：可在本项目的
          <a href="#/projects/${h(opts.linkProjectId || '')}?tab=calc">「减排量初算」页</a>
          选择「演示通道 · 反事实推演」做流程演示。演示结果标记为 demo，不进入投资筛选报告、不可导出，
          不得用于对外材料或投资决策。业务测算仍然保持禁止。
        </div>` : ''}
      ${!ca.available && !opts.demoUsable && opts.demoEnabled ? `
        <div class="tiny" style="margin-top:6px">演示通道已开启，但仅对系统管理员与政策研究员开放；当前身份不具备演示出数权限。</div>` : ''}
      ${!ca.available && !opts.demoEnabled && ca.demo_channel_available ? `
        <div class="tiny" style="margin-top:6px">（本快照记录当时演示通道为开启状态，现已关闭，以实时状态为准。）</div>` : ''}
    </div>
  </div>

  ${layerBlock('第一层：通用门槛', r.layers.common)}
  ${r.layers.specific.length ? layerBlock('第二层：方法学专属适用条件', r.layers.specific) : ''}
  ${r.layers.conflict.length ? layerBlock('第三层：冲突与重复（只标记，不自动判不合格）', r.layers.conflict,
    '不能仅凭发现同名机制就自动判不合格，须交人工核对其法律与方法学影响。') : ''}

  <div class="card">
    <h3>优先补充证据（最小补充材料清单）</h3>
    ${r.priority_gaps.length ? `<table><thead><tr><th>字段</th><th>归属</th><th>证据策略</th><th>说明</th></tr></thead>
      <tbody>${r.priority_gaps.map((g) => `<tr>
        <td class="tiny">${h(g.label)}<div class="mono muted">${h(g.field_key)}</div></td>
        <td class="tiny">${h(g.required_for)}</td>
        <td>${g.evidence_policy === 'strict' ? '<span class="badge unknown">严格证据</span>' : '<span class="badge gray">普通</span>'}</td>
        <td class="tiny">${h(g.description || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">无优先缺口。</p>'}
  </div>

  ${r.match_snapshot ? `<div class="card">
    <h3>本次检查所依据的匹配快照</h3>
    <p class="tiny muted">匹配运行 ID：<span class="mono">${h(r.match_snapshot.match_run_id)}</span></p>
    <p class="tiny">候选 ${r.match_snapshot.candidates.length} 项；观察项 ${r.match_snapshot.observations.length} 项；被排除 ${r.match_snapshot.excluded.length} 项。</p>
  </div>` : ''}

  <div class="note info">${h(r.disclaimer)}</div>`;
}

function ruleHtml(r) {
  return `<div class="rule ${r.state}">
    <div class="head">
      ${stateBadge(r.state)}
      <span class="badge gray">${h(r.rule_id)}</span>
      <span class="badge ${r.severity === 'blocking' ? 'fail' : r.severity === 'major' ? 'unknown' : 'gray'}">${h({ blocking: '硬障碍', major: '重大', minor: '提示' }[r.severity] || r.severity)}</span>
      ${r.evidence_policy === 'strict' ? '<span class="badge unknown">严格证据</span>' : ''}
      <span class="t">${h(r.title)}</span>
    </div>
    <div class="body">
      <div>${nl2br(r.condition_text)}</div>
      <dl class="kv">
        <dt>逻辑表达式</dt><dd class="mono">${h(r.expression_text)}</dd>
        <dt>判断详情</dt><dd>${h(r.detail)}</dd>
        <dt>项目事实</dt><dd>${r.fact_field ? `<span class="mono tiny">${h(r.fact_field)}</span> = <strong>${h(r.fact_value ?? '（空）')}</strong> ${sourceTag(r.fact_source_kind)}` : '—'}</dd>
        <dt>证据定位</dt><dd>${r.evidence ? `${h(r.evidence.file_name)}${r.evidence.page ? ` 第 ${r.evidence.page} 页` : ''}${r.evidence.excerpt ? `<div class="muted tiny">「${h(r.evidence.excerpt)}」</div>` : ''}` : '<span class="badge gray">无</span>'}</dd>
        <dt>条款页码</dt><dd class="tiny">${h(r.clause_ref || '—')}</dd>
        <dt>规则版本</dt><dd class="tiny mono">${h(r.rule_version || 'common')}</dd>
        <dt>判断时间</dt><dd class="tiny">${h((r.judged_at || '').slice(0, 19).replace('T', ' '))}</dd>
        ${r.missing_fields && r.missing_fields.length ? `<dt>缺口字段</dt><dd class="tiny mono">${h(r.missing_fields.join('、'))}</dd>` : ''}
        ${r.unknown_reasons && r.unknown_reasons.length ? `<dt>待核实原因</dt><dd class="tiny">${r.unknown_reasons.map((x) => h(x.reason)).join('<br/>')}</dd>` : ''}
      </dl>
    </div>
  </div>`;
}

async function CalcTab(p, d) {
  const [hist, gate, elig] = await Promise.all([
    api(`/api/projects/${p.id}/calculations`),
    fetchDemoChannel(),
    api(`/api/projects/${p.id}/eligibility`).catch((e) => {
      if (e.status === 401) throw e;
      return { latest: null };
    }),
  ]);
  const calcRuns = hist.runs;
  const demoOn = gate.enabled;
  const demoUsable = demoChannelUsable(demoOn);
  const plugins = gate.data?.plugins || [];
  const snap = elig?.latest?.result || null;
  // 快照已绑定「某方法学版本」：阻断原因只列该版本对应插件，避免把其他方法学的问题也算进来
  const snapPlugin = snap?.methodology_version
    ? plugins.find((x) => x.methodology_id === snap.methodology_version.methodology_id && x.version === snap.methodology_version.version)
    : null;
  const scopedPlugins = snapPlugin ? [snapPlugin] : plugins;
  const blockers = scopedPlugins.map((x) => `${pluginBlockers(x).length ? '【阻断】' : '【可出数】'}${x.methodology_id}：${pluginBlockers(x).join('；') || '无阻断项'}`);
  const anyBlocked = scopedPlugins.some((x) => pluginBlockers(x).length > 0);
  // 业务通道是否可用：只有「条件检查快照说可用」且「对应插件确实没有阻断项」同时成立才算可用。
  // 后端 runCalculation 会独立复核审批 / 占位系数 / 条款页码 / 快照绑定，前端一律就低不就高。
  const availability = snap?.calculation_availability
    || (plugins.length ? { available: false, channel: 'business', demo_channel_available: demoOn, blockers } : null);
  const businessOk = !!availability?.available && !!snapPlugin && !anyBlocked;
  const snapshotMvId = snap?.methodology_version?.id || '';
  const options = calcRuns.map((r) => `<option value="${h(r.id)}">${shortTime(r.run_at)} · ${r.channel === 'demo' ? '演示' : '业务'} · ${h(r.scenario)} · ${h(r.code_display || '')} · ${r.status === 'rejected' ? '被拒绝' : num(r.er_annual, 2) + ' tCO₂e/年'}</option>`).join('');

  return `
  <div class="card">
    <h2 style="margin-top:0">运行情景初算</h2>
    ${calcGateNote(availability, scopedPlugins)}

    <form data-act="run-calc" data-project="${h(p.id)}" data-business-ok="${businessOk ? '1' : '0'}">
      <h4>运行通道</h4>
      <div class="channel-picker">
        <label class="channel-opt ${businessOk ? '' : 'blocked'}">
          <input type="radio" name="channel" value="business" checked ${businessOk ? '' : 'disabled'} />
          <span class="nm">业务测算（须通过审批）</span>
          <span class="desc">${businessOk
            ? '插件已通过审批且条件检查无硬障碍，结果可作为正式业务测算，绑定本次条件检查快照。'
            : '当前被阻止出数（未通过审批 / 含占位系数 / 缺条款页码 / 条件检查有硬障碍）。'}</span>
        </label>
        <label class="channel-opt ${demoUsable ? 'demo' : 'blocked'}">
          <input type="radio" name="channel" value="demo" ${demoUsable ? '' : 'disabled'} />
          <span class="nm">演示通道 · 反事实推演</span>
          <span class="desc">${demoUsable
            ? '仅用于流程演示与内部讨论：结果标记为 demo，不进入投资筛选报告、不可导出，不得用于对外材料或投资决策。'
            : (demoOn
              ? `演示通道已开启，但仅对系统管理员与政策研究员开放（当前身份：${h(ROLE_LABEL[(state.user && state.user.role) || ''] || '未知')}）。`
              : '演示通道当前未开启：须由系统管理员在「管理后台 → 计算门禁与演示通道」显式开启。')}</span>
        </label>
      </div>

      <div class="inline-form">
        <label class="field"><span>方法学版本</span><input name="methodologyVersionId" value="${h(snapshotMvId)}" placeholder="留空自动选取正式版本" /></label>
        <label class="field"><span>运行方式</span>
          <select name="mode">
            <option value="all">三情景全部运行（保守 / 基准 / 乐观）</option>
            <option value="base">仅基准情景</option>
            <option value="conservative">仅保守情景</option>
            <option value="optimistic">仅乐观情景</option>
          </select></label>
        <label class="field"><span>碳价情景参数（元/tCO₂e）</span><input name="carbonPrice" type="number" step="0.01" value="${d.facts.find((f) => f.field_key === 'com.carbon_price_scenario')?.value ?? ''}" /></label>
      </div>
      <h4>情景输入覆盖（留空则使用项目事实或方法学缺省值）</h4>
      <div class="inline-form">
        <label class="field"><span>年回收瓦斯 / 伴生气量（Nm³）</span><input name="recovery_volume_nm3" type="number" step="any" /></label>
        <label class="field"><span>年回收气量（试气放喷，Nm³）</span><input name="og_recovery_volume_nm3" type="number" step="any" /></label>
        <label class="field"><span>日均回收气量（试气放喷，Nm³/天）</span><input name="daily_recovery_nm3" type="number" step="any" /></label>
        <label class="field"><span>甲烷体积浓度（%）</span><input name="ch4_concentration_pct" type="number" step="any" /></label>
        <label class="field"><span>甲烷体积分数（0-1）</span><input name="ch4_fraction" type="number" step="any" /></label>
        <label class="field"><span>年运行小时数</span><input name="hours_per_year" type="number" step="any" /></label>
        <label class="field"><span>销毁 / 氧化效率（0-1）</span><input name="destruction_efficiency" type="number" step="any" /></label>
        <label class="field"><span>基准线火炬效率（0-1，放空填 0）</span><input name="baseline_flare_efficiency" type="number" step="any" /></label>
        <label class="field"><span>自耗气比例（0-1）</span><input name="selfuse_fraction" type="number" step="any" /></label>
        <label class="field"><span>集输自耗气比例（0-1）</span><input name="gathering_selfuse_fraction" type="number" step="any" /></label>
        <label class="field"><span>泄漏率（0-1）</span><input name="leakage_rate" type="number" step="any" /></label>
        <label class="field"><span>发电量（MWh/年）</span><input name="grid_mwh" type="number" step="any" /></label>
        <label class="field"><span>处理设施耗电量（MWh/年）</span><input name="process_power_mwh" type="number" step="any" /></label>
        <label class="field"><span>电力排放因子（tCO₂/MWh）</span><input name="process_power_ef" type="number" step="any" /></label>
        <label class="field"><span>站场设计总规模（m³/天）</span><input name="station_design_scale_m3d" type="number" step="any" /></label>
        <label class="field"><span>计入期起始年（YYYY-MM-DD）</span><input name="crediting_start_year" placeholder="2025-01-01" /></label>
        <label class="field"><span>计入期长度（年）</span><input name="crediting_years" type="number" /></label>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="primary" type="submit" data-role="run-calc">执行计算</button>
        <span class="tiny muted">业务测算当前${businessOk ? '可用' : '被阻止出数'}；演示通道${demoUsable ? '可用（结果不可用于报告）' : '不可用'}。</span>
      </div>
    </form>
  </div>

  <div id="calc-result"></div>

  <div class="card">
    <h2>运行历史（旧结果与新结果并存，可解释差异）</h2>
    <div class="note info">按「通道」分列：<span class="badge info">业务</span> 可用于投资筛选报告；
      <span class="badge unknown">演示</span> 为隔离的反事实推演，<strong>不进入报告、不可导出</strong>。
      两类运行不得混用，也不得据演示结果形成投资结论。</div>
    ${calcRuns.length ? `<div class="scroll-x"><table>
      <thead><tr><th>运行时间</th><th>通道</th><th>方法学</th><th>情景</th><th class="num">年度结果</th><th class="num">计入期合计</th><th>状态</th><th>复核</th><th>操作</th></tr></thead>
      <tbody>${calcRuns.map((r) => `<tr class="${r.channel === 'demo' || r.demo ? 'demo-row' : ''}">
        <td class="tiny nowrap">${h(shortTime(r.run_at))}<div class="muted">基准日 ${h(r.analysis_base_date)}</div></td>
        <td>${channelBadge(r)}${r.channel === 'demo' || r.demo ? '<div class="tiny muted">不可用于报告</div>' : ''}</td>
        <td class="tiny">${h(r.code_display || '')}<div class="muted">${h(r.methodology_name || '')}</div></td>
        <td class="tiny">${h(r.scenario)}</td>
        <td class="num">${r.status === 'rejected' ? '—' : num(r.er_annual, 2)}</td>
        <td class="num">${r.status === 'rejected' ? '—' : num(r.crediting_total, 2)}</td>
        <td>${r.status === 'rejected' ? `<span class="badge fail">拒绝出数</span><div class="tiny muted">${h((r.rejection_reason || '').slice(0, 60))}</div>`
          : r.status === 'demo' ? '<span class="badge unknown">演示出数</span>'
            : '<span class="badge pass">已出数</span>'}</td>
        <td><span class="badge ${r.audit_status === 'approved' ? 'pass' : r.audit_status === 'rejected' ? 'fail' : 'gray'}">${h(r.audit_status)}</span></td>
        <td><button data-act="view-calc" data-id="${h(r.id)}">明细</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted">尚无计算运行。</p>'}
    ${calcRuns.length >= 2 ? `
    <div class="section-split"></div>
    <h3>两次运行差异对比</h3>
    <div class="inline-form">
      <label class="field"><span>运行 A</span><select id="cmp-a">${options}</select></label>
      <label class="field"><span>运行 B</span><select id="cmp-b">${options}</select></label>
      <div class="btn-row"><button data-act="compare-calc">对比差异</button></div>
    </div>
    <div id="cmp-result"></div>` : ''}
  </div>`;
}

/**
 * 业务出数所绑定的条件检查快照：用户必须能看见「这个数字绑在哪个版本的判断上」。
 * 演示通道不产生绑定快照，返回空串。
 */
function calcSnapshotBlock(out) {
  const s = out.eligibility_snapshot;
  if (out.demo || !s) return '';
  return `<div class="note info">
    <strong>本结果绑定的条件检查快照</strong>（同项目 + 同方法学版本 + 同分析基准日）：
    <dl class="kv" style="grid-template-columns:190px 1fr;margin-top:5px">
      <dt>条件检查运行 ID</dt><dd class="mono">${h(s.eligibility_run_id || '—')}</dd>
      <dt>分析基准日</dt><dd class="mono">${h(s.analysis_base_date || '—')}</dd>
      <dt>方法学版本</dt><dd class="mono tiny">${h(s.methodology_version_id || '—')}</dd>
      <dt>四态结论</dt><dd>${conclusionBadge(s.conclusion)}</dd>
      <dt>硬障碍数</dt><dd>${num(s.blocking_failures, 0)}</dd>
    </dl>
    <div class="tiny">快照随运行一起入库，库更新不会改写历史结果；报告只引用绑定快照的业务运行。</div>
  </div>`;
}

function calcResultHtml(out) {
  if (out.rejected) {
    // 门禁类拒绝（kind: precondition / gate_blocked）单独说明：这是审批纪律，不是输入错误
    const gateErrors = (out.errors || []).filter((e) => e.kind === 'gate_blocked' || e.field === '__precondition__');
    const otherErrors = (out.errors || []).filter((e) => !gateErrors.includes(e));
    return `<div class="card">
      <h2 style="margin-top:0">已拒绝出数</h2>
      <div class="note danger"><strong>${h(out.message)}</strong>
        ${out.channel ? `<div class="tiny" style="margin-top:4px">本次请求通道：${out.channel === 'demo' ? '演示通道' : '业务测算'}</div>` : ''}</div>
      ${gateErrors.length ? gateNote(out.gate_reason || out.message, gateErrors.map((e) => e.message)) : ''}
      ${otherErrors.length ? `<table><thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
        <tbody>${otherErrors.map((e) => `<tr>
          <td class="mono tiny">${h(e.field || '—')}</td>
          <td><span class="badge fail">${h(e.kind || 'error')}</span></td>
          <td>${h(e.message)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${out.warnings?.length ? `<h3>提示</h3>${out.warnings.map((w) => `<div class="note warn">${h(w.message)}</div>`).join('')}` : ''}
    </div>`;
  }
  return `
  <div class="card">
    ${out.demo ? demoWatermark(out.watermark) : (out.usable_for_report === false ? demoWatermark(out.watermark) : '')}
    <h2 style="margin-top:0">${h(out.plugin.title)}</h2>
    <p class="tiny muted">插件 ${h(out.plugin.plugin_key)} @ ${h(out.plugin.plugin_version)}　｜　分析基准日 ${h(out.analysis_base_date)}　｜　
      通道 ${channelBadge({ channel: out.channel, demo: out.demo })}　｜　可用于投资筛选报告：${out.usable_for_report === false ? '<span class="badge fail">否</span>' : '<span class="badge pass">是</span>'}</p>
    ${out.plugin.status_note ? `<div class="note warn">${h(out.plugin.status_note)}</div>` : ''}
    ${calcSnapshotBlock(out)}
    ${out.gate_reason && out.demo ? `<div class="note warn"><strong>通道说明：</strong>${nl2br(out.gate_reason).replace(/\*\*/g, '')}</div>` : ''}
    ${out.warnings?.length ? out.warnings.map((w) => `<div class="note warn">${h(w.message)}</div>`).join('') : ''}

    <h3>三情景结果</h3>
    <table><thead><tr><th>情景</th><th class="num">年度情景估算</th><th class="num">计入期合计</th><th>年数</th><th>说明</th></tr></thead>
      <tbody>${out.runs.map((r) => `<tr>
        <td><span class="badge ${r.scenario === 'conservative' ? 'unknown' : r.scenario === 'optimistic' ? 'info' : 'pass'}">${h(r.scenario_label)}</span></td>
        <td class="num"><strong>${num(r.er_annual, 2)}</strong> tCO₂e/年</td>
        <td class="num">${num(r.crediting?.total, 2)} tCO₂e</td>
        <td class="tiny">${r.crediting?.years ?? '—'}</td>
        <td class="tiny">${h(r.assumptions?.[0] || '')}</td></tr>`).join('')}
      </tbody></table>

    <h3>输入与来源标注</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>参数</th><th>取值</th><th>单位</th><th>来源</th></tr></thead>
      <tbody>${out.input_origins.map((o) => `<tr>
        <td class="tiny">${h(o.label)}<div class="mono muted">${h(o.key)}</div></td>
        <td>${o.value === null || o.value === '' ? '<span class="badge unknown">缺失</span>' : h(o.value)}</td>
        <td class="tiny">${h(o.unit || '—')}</td>
        <td class="tiny">${o.origin ? `${sourceTag(o.origin.kind === 'factor_default' || o.origin.kind === 'plugin_default' ? 'assumption' : o.origin.kind)} ${h(o.origin.label)}${o.origin.factor_key ? ` <span class="mono">${h(o.origin.factor_key)}</span>` : ''}` : '<span class="badge gray">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>
  </div>

  ${out.runs.map((r) => `
  <div class="card">
    <h3>${h(r.scenario_label)}：逐式明细</h3>
    ${r.steps.map((s) => `<div class="step">
      <div class="tiny muted">第 ${s.step_no} 步</div>
      <div><strong>${h(s.title)}</strong></div>
      <div class="f">${h(s.formula)}</div>
      ${s.substitution ? `<div class="tiny mono">代入：${h(s.substitution)}</div>` : ''}
      <div>结果：<span class="r">${num(s.result, 6)}</span> <span class="tiny muted">${h(s.unit || '')}</span>
        ${s.factor_status === 'placeholder' ? '<span class="badge unknown">占位系数</span>' : s.factor_status === 'verified' ? '<span class="badge pass">已核实</span>' : ''}</div>
      <div class="tiny muted">条款：${h(s.clause_ref || '—')}${s.factor_refs?.length ? `　因子：${h(s.factor_refs.join('、'))}` : ''}</div>
      ${s.note ? `<div class="tiny" style="color:#92400e">${h(s.note)}</div>` : ''}
    </div>`).join('')}

    <h3>假设与缺失数据</h3>
    ${r.assumptions?.length ? `<ul>${r.assumptions.map((a) => `<li class="tiny">${h(a)}</li>`).join('')}</ul>` : '<p class="tiny muted">无附加假设。</p>'}
    ${r.missing?.length ? `<div class="note warn"><strong>缺失数据（未猜值）：</strong><ul>${r.missing.map((m) => `<li>${h(m)}</li>`).join('')}</ul></div>` : ''}

    ${r.sensitivity?.length ? `<h3>敏感性分析</h3>
    <table><thead><tr><th>驱动因素</th><th class="num">基准值</th><th class="num">扰动</th><th class="num">结果上行</th><th class="num">结果下行</th><th class="num">摆动</th><th class="num">敏感度指数</th></tr></thead>
      <tbody>${r.sensitivity.map((s) => `<tr>
        <td class="tiny">${h(s.label)}${s.unit ? ` <span class="muted">(${h(s.unit)})</span>` : ''}</td>
        <td class="num">${num(s.base_value, 4)}</td>
        <td class="num">±${num(s.delta_pct, 2)}%</td>
        <td class="num">${num(s.result_up, 2)}</td>
        <td class="num">${num(s.result_down, 2)}</td>
        <td class="num">${num(s.swing, 2)}</td>
        <td class="num">${num(s.sensitivity_index, 4)}</td></tr>`).join('')}
      </tbody></table>` : ''}

    ${r.placeholder_factors?.length ? `<div class="note warn">
      <strong>本结果含 ${r.placeholder_factors.length} 项未经领域专家确认的占位系数：</strong>
      <ul>${r.placeholder_factors.map((f) => `<li class="tiny"><span class="mono">${h(f.factor_key)}</span> = ${num(f.value, 6)} ${h(f.unit || '')} —— ${h(f.verification_note || '')}</li>`).join('')}</ul>
    </div>` : ''}
  </div>`).join('')}

  <div class="card">
    <h3>因子快照（本次运行绑定，历史报告不受库更新影响）</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>因子</th><th>名称</th><th class="num">取值</th><th>单位</th><th>出处</th><th>年份</th><th>状态</th></tr></thead>
      <tbody>${out.factor_snapshot.map((f) => `<tr>
        <td class="mono tiny">${h(f.factor_key)}</td><td class="tiny">${h(f.name)}</td>
        <td class="num">${num(f.value, 6)}</td><td class="tiny">${h(f.unit || '')}</td>
        <td class="tiny">${h(f.source_ref || '')}</td><td class="tiny">${h(f.source_year ?? '')}</td>
        <td><span class="badge ${f.value_status === 'verified' ? 'pass' : 'unknown'}">${h(f.value_status)}</span></td></tr>`).join('')}
      </tbody></table></div>
  </div>

  <div class="note info">${h(out.runs[0]?.result?.disclaimer || '')}</div>`;
}

async function ReportTab(p) {
  const [list, calcRuns, gate] = await Promise.all([
    api(`/api/projects/${p.id}/reports`),
    api(`/api/projects/${p.id}/calculations`).catch(() => ({ runs: [] })),
    fetchDemoChannel(),
  ]);
  // 库里可能存在历史业务运行（旧模型遗留）。只要当前门禁仍然禁止业务出数，新报告就不可能有新数字。
  const historicalBusiness = (calcRuns.runs || []).filter((r) => r.status === 'ok' && !r.demo && r.usable_for_report !== false);
  return `
  <div class="card">
    <h2 style="margin-top:0">生成投资筛选报告</h2>
    <p class="tiny muted">报告会自动运行一次「候选匹配 + 条件检查 + 三情景计算」，并引用本次运行快照。库更新不会静默改写已生成的历史报告。</p>
    <div class="note danger">
      <strong>本报告不含任何减排量数字。</strong>
      这不是故障，而是设计要求的默认状态：业务测算必须同时满足「计算插件已通过审批、无占位系数、公式条款页码齐全、
      存在同项目同版本同基准日且硬障碍为 0 的条件检查快照」，四者缺一即拒绝出数。
      在 <span class="mono">docs/12-领域专家确认清单.md</span> 全部确认完毕之前，报告中的「情景估算」只输出原因说明，
      不含任何数值；报告可用于记录判断、硬障碍与证据缺口，但<strong>不得</strong>被理解为对减排量的确认。
    </div>
    ${historicalBusiness.length ? `<div class="note warn">
      该项目库内存在 ${historicalBusiness.length} 条<strong>历史业务运行</strong>（旧门禁模型下产生）。
      它们只有在人工审核通过后才会被报告引用；在当前门禁下不会产生新的业务数值。
    </div>` : ''}
    <div class="note warn">
      演示通道的运行<strong>不会</strong>进入本报告，也无法导出：演示结果是隔离的反事实推演，不得用于投资筛选报告、对外材料或投资决策。
      当前演示通道状态（实时）：${gate.enabled ? '<span class="badge unknown">已开启</span>' : '<span class="badge gray">未开启</span>'}。
    </div>
    <div class="inline-form">
      <label class="field"><span>分析基准日</span><input id="rpt-basedate" placeholder="留空为今日" /></label>
      <label class="field"><span>碳价情景参数（元/tCO₂e）</span><input id="rpt-price" type="number" step="0.01" /></label>
      <div class="btn-row"><button class="primary" data-act="gen-report" data-project="${h(p.id)}">生成报告</button></div>
    </div>
  </div>
  <div id="report-result"></div>
  <div class="card">
    <h2>历史报告版本</h2>
    ${list.reports?.length ? `<div class="scroll-x"><table>
      <thead><tr><th>版本</th><th>分析基准日</th><th>生成时间</th><th>生成人</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${list.reports.map((r) => `<tr>
        <td>r${r.revision}</td>
        <td class="tiny">${h(r.analysis_base_date)}</td>
        <td class="tiny">${h(r.generated_at.slice(0, 19).replace('T', ' '))}</td>
        <td class="tiny">${h(r.generated_by || '')}</td>
        <td><span class="badge ${r.status === 'approved' ? 'pass' : 'gray'}">${h(r.status)}</span></td>
        <td class="btn-row">
          <button data-act="export-report" data-id="${h(r.id)}" data-format="markdown">导出 Markdown</button>
          <button data-act="export-report" data-id="${h(r.id)}" data-format="html">导出 HTML（可打印为 PDF）</button>
          <button data-act="export-report" data-id="${h(r.id)}" data-format="doc">导出 Word（.doc）</button>
          <button data-act="export-report" data-id="${h(r.id)}" data-format="xls">导出 Excel（.xls）</button>
          <button data-act="export-report" data-id="${h(r.id)}" data-format="csv">导出 CSV</button>
        </td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">尚无报告。</p>'}
  </div>`;
}

function reportResultHtml(out) {
  const c = out.content;
  const block = (title, items) => `
    <h3>${h(title)}</h3>
    ${items.map((s) => `<div style="margin:5px 0"><span class="tag ${stmtTag(s.label)}">${h(s.label)}</span> ${h(s.text)}${s.note ? `<div class="tiny muted">${h(s.note)}</div>` : ''}</div>`).join('') || '<p class="muted">—</p>'}`;

  return `
  <div class="card">
    <h2 style="margin-top:0">报告已生成：r${out.revision}</h2>
    <p class="tiny muted">报告 ID <span class="mono">${h(out.report_id)}</span>　｜　分析基准日 ${h(out.analysis_base_date)}</p>
    <div class="grid c6" style="margin:10px 0">
      <div class="stat blue"><div class="n" style="font-size:15px">${h(out.snapshot.eligibility_run_id || '—')}</div><div class="k">条件检查运行</div></div>
      <div class="stat blue"><div class="n" style="font-size:15px">${h((out.snapshot.calculation_run_ids || []).length)}</div><div class="k">计算运行数</div></div>
      <div class="stat teal"><div class="n" style="font-size:15px">${h(out.content.one_page.conclusion.text)}</div><div class="k">四态结论</div></div>
    </div>
    <div class="btn-row">
      <button class="primary" data-act="export-report" data-id="${h(out.report_id)}" data-format="markdown">导出 Markdown</button>
      <button data-act="export-report" data-id="${h(out.report_id)}" data-format="html">导出 HTML（可打印为 PDF）</button>
      <button data-act="export-report" data-id="${h(out.report_id)}" data-format="doc">导出 Word（.doc）</button>
      <button data-act="export-report" data-id="${h(out.report_id)}" data-format="xls">导出 Excel（.xls）</button>
      <button data-act="export-report" data-id="${h(out.report_id)}" data-format="csv">导出 CSV</button>
      <button data-act="print">打印 / 存 PDF</button>
    </div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">一页结论</h2>
    ${block('项目概况', c.one_page.project_overview)}
    ${block('候选方法学与版本', c.one_page.candidate_methodology)}
    <h3>当前判断</h3>
    <p style="font-size:17px">${conclusionBadge(c.one_page.conclusion.text)}</p>
    ${block('关键硬障碍', c.one_page.blockers.length ? c.one_page.blockers : [{ label: '官方已确认', text: '无。' }])}
    ${block('需补充的前五项证据', c.one_page.top5_evidence_gaps.length ? c.one_page.top5_evidence_gaps : [{ label: '待核实', text: '无。' }])}
    ${block('情景估算', c.one_page.estimate.statements)}
    ${(out.snapshot.calculation_run_ids || []).length ? '' : `<div class="note danger">
      <strong>本报告不含任何减排量数字。</strong>
      这是设计要求的默认状态：方法学计算插件的审批未通过、仍含占位系数或缺原文条款页码，或条件检查存在硬障碍，
      系统一律不出数。须待 <span class="mono">docs/12-领域专家确认清单.md</span> 全部确认、
      并在管理后台完成审批流转后，报告才可能出现减排量估算。本报告可用于记录判断、硬障碍与证据缺口，但<strong>不得</strong>被理解为对减排量的确认。
    </div>`}
    ${c.one_page.estimate.carbon_revenue ? `<div class="note info">碳收益（情景参数）：碳价 ${num(c.one_page.estimate.carbon_revenue.price, 2)} 元/tCO₂e，
      年度约 ${num(c.one_page.estimate.carbon_revenue.annual, 0)} 元，计入期约 ${num(c.one_page.estimate.carbon_revenue.crediting, 0)} 元。${h(c.one_page.estimate.carbon_revenue.note)}</div>` : ''}
    <h3>数据可靠性</h3>
    <dl class="kv" style="grid-template-columns:200px 1fr">
      <dt>严格证据字段总数</dt><dd>${c.one_page.data_reliability.strict_evidence_fields_total}</dd>
      <dt>缺失</dt><dd>${h(c.one_page.data_reliability.strict_fields_missing.join('、') || '无')}</dd>
      <dt>证据不合格</dt><dd>${h(c.one_page.data_reliability.strict_fields_without_qualified_evidence.map((x) => `${x.label}（${x.source_kind}）`).join('、') || '无')}</dd>
      <dt>结论</dt><dd>${h(c.one_page.data_reliability.conclusion)}</dd>
    </dl>
    ${block('下一步尽调决定', [c.one_page.next_step])}
    <div class="note info">${h(c.disclaimer)}</div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">正文</h2>
    ${block('1 政策与方法学依据', c.body.policy_basis)}
    <h3>2 项目事实及来源</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>字段</th><th>值</th><th>单位</th><th>来源标注</th></tr></thead>
      <tbody>${c.body.project_facts.map((f) => `<tr>
        <td class="tiny">${h(f.label)}</td><td class="tiny">${h(f.value ?? '（空）')}</td>
        <td class="tiny">${h(f.unit || '')}</td>
        <td><span class="tag ${stmtTag(f.label_of_statement)}">${h(f.label_of_statement)}</span></td></tr>`).join('')}
      </tbody></table></div>

    <h3>3 逐项条件检查</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>规则</th><th>层级</th><th>条件</th><th>判断</th><th>依据</th><th>证据定位</th><th>条款</th></tr></thead>
      <tbody>${c.body.condition_checks.map((r) => `<tr>
        <td class="tiny">${h(r.rule_id)} ${h(r.title)}</td>
        <td class="tiny">${h(r.layer)}</td>
        <td class="mono tiny">${h(r.expression_text)}</td>
        <td>${stateBadge(r.state)}</td>
        <td class="tiny">${h(r.detail)}</td>
        <td class="tiny">${r.evidence ? `${h(r.evidence.file_name)}${r.evidence.page ? ` p.${r.evidence.page}` : ''}` : '—'}</td>
        <td class="tiny">${h(r.clause_ref || '—')}</td></tr>`).join('')}
      </tbody></table></div>

    <h3>4 公式和参数</h3>
    ${c.body.formulas_and_params.steps ? `
      <p class="tiny muted">插件：${h(c.body.formulas_and_params.methodology)}（${h(c.body.formulas_and_params.plugin_version)}）</p>
      ${c.body.formulas_and_params.steps.map((s) => `<div class="step">
        <div class="tiny muted">第 ${s.step_no} 步</div>
        <div><strong>${h(s.title)}</strong></div>
        <div class="f">${h(s.formula)}</div>
        ${s.substitution ? `<div class="tiny mono">${h(s.substitution)}</div>` : ''}
        <div>结果：<span class="r">${num(s.result, 6)}</span> ${h(s.unit || '')}</div>
      </div>`).join('')}` : `<div class="note warn">${h(c.body.formulas_and_params.note || '')}</div>`}

    ${c.body.scenarios.length ? `<h3>5 情景与敏感性</h3>
    <table><thead><tr><th>情景</th><th class="num">年度</th><th class="num">计入期</th><th>说明</th></tr></thead>
      <tbody>${c.body.scenarios.map((s) => `<tr><td>${h(s.scenario_label)}</td>
        <td class="num">${num(s.er_annual, 2)}</td><td class="num">${num(s.crediting_total, 2)}</td>
        <td class="tiny">${h(s.note || '')}</td></tr>`).join('')}</tbody></table>
    ${c.body.sensitivity.length ? `<table style="margin-top:8px"><thead><tr><th>驱动因素</th><th class="num">摆动</th><th class="num">敏感度</th></tr></thead>
      <tbody>${c.body.sensitivity.map((s) => `<tr><td class="tiny">${h(s.label)}</td>
        <td class="num">${num(s.swing, 2)}</td><td class="num">${num(s.sensitivity_index, 4)}</td></tr>`).join('')}</tbody></table>` : ''}` : ''}

    ${block('6 碳权属与重复计算风险', c.body.carbon_rights_risks)}
    ${block('7 待确认项', c.body.cost_items_pending)}
    ${block('8 投资建议', c.body.investment_view)}
  </div>

  <div class="card">
    <h2 style="margin-top:0">附录：可追溯索引</h2>
    <p class="tiny">${h(c.traceability.note)}</p>
    <dl class="kv" style="grid-template-columns:180px 1fr">
      <dt>方法学版本 ID</dt><dd class="mono tiny">${h(c.traceability.methodology_version_id || '—')}</dd>
      <dt>条件检查运行 ID</dt><dd class="mono tiny">${h(c.traceability.runs.eligibility_run_id)}</dd>
      <dt>匹配运行 ID</dt><dd class="mono tiny">${h(c.traceability.runs.match_run_id)}</dd>
      <dt>计算运行 ID</dt><dd class="mono tiny">${h((c.traceability.runs.calculation_run_ids || []).join('、') || '无')}</dd>
    </dl>
    <h3>因子版本索引</h3>
    <div class="scroll-x"><table>
      <thead><tr><th>因子</th><th class="num">取值</th><th>单位</th><th>出处</th><th>年份</th><th>状态</th></tr></thead>
      <tbody>${c.traceability.factor_versions.map((f) => `<tr>
        <td class="mono tiny">${h(f.factor_key)}</td><td class="num">${num(f.value, 6)}</td>
        <td class="tiny">${h(f.unit || '')}</td><td class="tiny">${h(f.source_ref || '')}</td>
        <td class="tiny">${h(f.source_year ?? '')}</td><td class="tiny">${h(f.value_status)}</td></tr>`).join('')}
      </tbody></table></div>
  </div>`;
}

function stmtTag(label) {
  if (!label) return 'unknown';
  if (label.includes('官方')) return 'official';
  if (label.includes('项目资料')) return 'project_doc';
  if (label.includes('分析师')) return 'analyst';
  if (label.includes('模型假设')) return 'assumption';
  return 'unknown';
}

/* ============================== 人工审核 ============================== */

async function ReviewsView() {
  const d = await api('/api/reviews/pending');
  const block = (title, rows, type, render) => `
    <div class="card">
      <h3>${h(title)}（${rows.length}）</h3>
      ${rows.length ? `<div class="scroll-x"><table>
        <thead><tr><th>对象</th><th>项目</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          ${render(r)}
          <td class="btn-row">
            <button data-act="review" data-type="${h(type)}" data-id="${h(r.id)}" data-decision="approved">通过</button>
            <button data-act="review" data-type="${h(type)}" data-id="${h(r.id)}" data-decision="needs_info">要求补充</button>
            <button class="danger" data-act="review" data-type="${h(type)}" data-id="${h(r.id)}" data-decision="rejected">驳回</button>
          </td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">无待审项。</p>'}
    </div>`;

  return `
  <div class="page-head">
    <div><h1>人工审核</h1>
      <p class="muted">关键结果由人审核。审核动作写入审计日志，并改变对应运行的复核状态；已通过的报告才能用于对外沟通。</p>
    </div>
  </div>
  ${block('待审核计算运行', d.calculations, 'calculation_run', (r) => `
    <td class="tiny"><span class="mono">${h(r.id)}</span><div class="muted">${h(r.code_display || '')} · ${h(r.scenario)}</div>
      ${r.channel === 'demo' || r.demo ? '<span class="badge unknown">演示</span>' : ''}</td>
    <td class="tiny">${h(r.project_name)}</td>
    <td class="tiny">${h(r.run_at.slice(0, 19).replace('T', ' '))}<div class="muted">${h(r.operator || '')}</div></td>
    <td>${r.status === 'rejected' ? '<span class="badge fail">拒绝出数</span>'
      : r.status === 'demo' ? '<span class="badge unknown">演示出数（不可用于报告）</span>'
        : '<span class="badge pass">已出数</span>'}`)}
  ${block('待复核条件检查', d.eligibility, 'eligibility_run', (r) => `
    <td class="tiny"><span class="mono">${h(r.id)}</span></td>
    <td class="tiny">${h(r.project_name)}</td>
    <td class="tiny">${h(r.run_at.slice(0, 19).replace('T', ' '))}<div class="muted">${h(r.operator || '')}</div></td>
    <td>${conclusionBadge(r.conclusion)}`)}
  ${block('待审报告', d.reports, 'report', (r) => `
    <td class="tiny">r${r.revision} <span class="mono">${h(r.id)}</span></td>
    <td class="tiny">${h(r.project_name)}</td>
    <td class="tiny">${h(r.generated_at.slice(0, 19).replace('T', ' '))}</td>
    <td><span class="badge gray">草稿</span>`)}`;
}

/* ============================== 管理后台 ============================== */

async function AdminView() {
  const [demo, standards, versions] = await Promise.all([
    api('/api/admin/demo-channel'),
    api('/api/meta/standard-codes'),
    api('/api/methodologies').catch(() => ({ formal: [], draft: [] })),
  ]);
  const plugins = demo.plugins || [];
  const versionRows = [...(versions.formal || []), ...(versions.draft || [])];
  // 审批接口按「方法学版本 ID」操作，插件清单只带 methodology_id + version / has_plugin_module 标记
  const mvByKey = new Map(versionRows.map((v) => [`${v.methodology_id}::${v.version}`, v]));
  const moduleIds = new Set(versionRows.filter((v) => v.has_rulecard_module || v.has_plugin_module).map((v) => v.id));
  const lastApproval = new Map();
  for (const v of versionRows) {
    const t = v.rulecard_approved_at || v.calculator_approved_at || '';
    if (t) lastApproval.set(v.id, t);
  }
  const approvalOrder = [...versionRows].sort((a, b) => String(lastApproval.get(b.id) || '').localeCompare(String(lastApproval.get(a.id) || '')));

  let audit = { audit: [] };
  let auditDeniedMsg = null;
  try {
    audit = await api('/api/audit?limit=60');
  } catch (e) {
    if (e.status === 403) {
      auditDeniedMsg = `当前登录身份（${h(e.data?.error || e.message)}）无审计日志查看权限。审计日志仅对「系统管理员」「政策研究员」「领域复核人」开放。`;
    } else {
      auditDeniedMsg = `读取审计日志失败：${h(e.message)}`;
    }
  }

  return `
  <div class="page-head">
    <div><h1>管理后台</h1>
      <p class="muted">计算门禁与演示通道、方法学审批、标准与依据编码表、审计日志。</p>
    </div>
  </div>

  ${adminGateCard(demo, plugins)}

  ${adminApprovalCard(plugins, moduleIds, approvalOrder)}

  <h2>标准与依据编码表</h2>
  <div class="card">
    <div class="note ${standards.pending_verification.length ? 'warn' : 'ok'}">${h(standards.note)}</div>
    <div class="scroll-x"><table>
      <thead><tr><th>编码</th><th>名称</th><th>类型</th><th>发布机关</th><th>核实</th><th>引用方</th><th>说明</th></tr></thead>
      <tbody>${standards.standards.map((s) => `<tr>
        <td class="mono tiny">${h(s.code)}</td>
        <td class="tiny">${h(s.title)}</td>
        <td class="tiny">${h(s.kind)}</td>
        <td class="tiny">${h(s.issuing_authority)}</td>
        <td>${s.verified ? '<span class="badge pass">已核实</span>' : '<span class="badge fail">待核实</span>'}</td>
        <td class="tiny">${h((s.referenced_by || []).join('、') || '—')}</td>
        <td class="tiny">${h(s.note)}</td></tr>`).join('')}
      </tbody></table></div>
  </div>

  <h2>审计日志（最近 60 条）</h2>
  <div class="card">
    ${auditDeniedMsg
      ? `<div class="note warn">${auditDeniedMsg}</div>`
      : (Array.isArray(audit.audit) && audit.audit.length
        ? `<div class="scroll-x"><table>
      <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th></tr></thead>
      <tbody>${audit.audit.map((a) => `<tr>
        <td class="tiny nowrap">${h(a.at.slice(0, 19).replace('T', ' '))}</td>
        <td class="tiny">${h(a.actor)}<div class="muted">${h(a.actor_role || '')}</div></td>
        <td class="tiny mono">${h(a.action)}</td>
        <td class="tiny mono">${h(a.object_type || '')}<div class="muted">${h((a.object_id || '').slice(0, 24))}</div></td>
        <td><span class="badge ${a.result === 'ok' ? 'pass' : 'fail'}">${h(a.result)}</span></td>
        <td class="tiny">${h((a.detail || '').slice(0, 150))}</td></tr>`).join('')}
      </tbody></table></div>`
        : '<p class="muted">暂无审计记录。</p>')}
  </div>
  <div data-role="approve-result"></div>`;
}

/** 计算门禁与演示通道：为什么禁止出数、演示通道开关、以及演示结果的绝对使用禁区 */
function adminGateCard(demo, plugins) {
  const enabled = demo.demo_channel_enabled === true;
  const blockedCount = plugins.filter((p) => p.calculator_status !== 'approved'
    || (p.placeholder_factors || []).length
    || (p.formulas_without_clause || []).length).length;

  return `
  <h2>计算门禁与演示通道</h2>
  <div class="card">
    <div class="note danger">
      <strong>业务测算（写入投资筛选报告的正式数字）当前全部被阻止出数。</strong>
      放行条件为<strong>四条同时满足</strong>：① 该版本计算插件审批状态为「已通过」；
      ② 插件不存在任何占位系数（<span class="mono">placeholder</span>）；③ 每条公式都有真实原文条款引用（无 <span class="mono">【占位】</span>）；
      ④ 存在同一项目、同一方法学版本、同一分析基准日、且硬障碍为 0 的申报条件检查快照。
      在 <span class="mono">docs/12-领域专家确认清单.md</span> 全部确认完毕前，任何方法学都不应通过审批。
    </div>
    <div class="grid c3" style="margin:12px 0">
      <div class="stat red"><div class="n">${plugins.length}</div><div class="k">已注册计算插件</div></div>
      <div class="stat red"><div class="n">${blockedCount}</div><div class="k">仍被阻止出数的插件</div></div>
      <div class="stat amber"><div class="n" style="font-size:18px">${enabled ? '已开启' : '未开启'}</div><div class="k">演示通道（隔离的反事实推演）</div></div>
    </div>

    <h3>各方法学的阻断原因（逐条）</h3>
    ${plugins.length ? plugins.map((p) => {
      const bs = pluginBlockers(p);
      return `<div class="rule ${bs.length ? 'fail' : 'pass'}">
        <div class="head">
          <span class="badge gray mono">${h(p.methodology_id)}::${h(p.version)}</span>
          <span class="t">${h(p.display_name)}</span>
          ${bs.length ? '<span class="badge fail">禁止业务出数</span>' : '<span class="badge pass">可业务出数</span>'}
          <span class="badge ${enabled ? 'unknown' : 'gray'}">演示通道${enabled ? '可用' : '未开启'}</span>
        </div>
        <div class="body">
          ${bs.length ? `<ul class="blocker-list">${bs.map((b) => `<li>${h(b)}</li>`).join('')}</ul>`
            : '<div class="tiny muted">该插件已满足业务出数前置条件；仍须绑定同项目、同版本、同基准日的条件检查快照。</div>'}
          <dl class="kv">
            <dt>规则卡审批</dt><dd>${approvalBadge(p.rulecard_status)}</dd>
            <dt>计算插件审批</dt><dd>${approvalBadge(p.calculator_status)}</dd>
            <dt>占位系数</dt><dd>${(p.placeholder_factors || []).length
              ? `<span class="badge unknown">${p.placeholder_factors.length} 项</span> <span class="mono tiny">${p.placeholder_factors.map((f) => h(f.factor_key)).join('、')}</span>`
              : '<span class="badge pass">无</span>'}</dd>
            <dt>缺条款页码的公式</dt><dd>${(p.formulas_without_clause || []).length
              ? `<span class="badge fail">${p.formulas_without_clause.length} 条</span> <span class="mono tiny">${p.formulas_without_clause.map(h).join('、')}</span>`
              : '<span class="badge pass">无（全部已回填）</span>'}</dd>
          </dl>
        </div>
      </div>`;
    }).join('') : '<p class="muted">尚未注册任何计算插件。</p>'}

    <div class="section-split"></div>
    <h3>演示通道开关</h3>
    <p class="tiny">
      演示通道是<strong>独立隔离</strong>的通道：开启后，管理员与政策研究员可对未通过审批的方法学做「反事实推演」，
      用于流程演示与内部讨论。演示运行以 <span class="mono">status='demo'</span> 入库，带
      <span class="mono">demo: true</span> / <span class="mono">usable_for_report: false</span> 标记，
      <strong>不进入投资筛选报告、不可导出</strong>。开启演示通道<strong>不会</strong>放行任何业务测算。
    </p>
    <div class="btn-row">
      <button class="${enabled ? '' : 'primary'}" data-act="demo-channel" data-enabled="1">${enabled ? '重新确认开启（更新开启时间）' : '开启演示通道'}</button>
      <button class="danger" data-act="demo-channel" data-enabled="0" ${enabled ? '' : 'disabled'}>关闭演示通道</button>
      <span class="tiny muted">当前状态：${enabled ? '<span class="badge unknown">演示通道已开启</span>' : '<span class="badge gray">演示通道未开启</span>'}</span>
    </div>
    <label class="field" style="margin-top:8px;max-width:560px"><span>变更说明（可选，写入审计日志）</span>
      <input data-role="demo-note" placeholder="如：用于 2026-09 内部评审流程演示" /></label>
    <dl class="kv" style="grid-template-columns:150px 1fr;margin-top:8px">
      <dt>开启人</dt><dd>${h(demo.enabled_by || '—')}</dd>
      <dt>开启时间</dt><dd>${h(demo.enabled_at || '—')}</dd>
      <dt>门禁模式值</dt><dd class="mono tiny">${h(demo.calculator_gate_mode || 'strict')}（历史遗留字段，业务出数不再由它决定）</dd>
      <dt>通道备注</dt><dd class="tiny">${h(demo.note || '—')}</dd>
    </dl>
    <div class="note danger">
      <strong>使用禁区（不可协商）：</strong>演示通道的结果是反事实推演，其中的缺省系数与条款页码尚未经领域专家确认。
      它<strong>不得用于投资筛选报告、不得用于对外材料（含尽调沟通、投委会材料、IR 材料）、不得用于任何投资决策</strong>，
      也不得与业务运行结果混排、比较或对外引用。任何对外结论都必须等 <span class="mono">docs/12</span> 清单确认完毕、
      审批流转完成、并以业务通道重新出数之后才能形成。
    </div>
  </div>`;
}

/** 审批失败（多为 409）：把服务端返回的待办清单内联展开，让复核人知道到底还差什么 */
function approvalErrorHtml(e, targetLabel) {
  const detail = e.data?.detail || {};
  const placeholders = detail.placeholder_factors || [];
  const formulas = detail.formulas_without_clause || detail.formulas || [];
  const hasDetail = placeholders.length || formulas.length;
  return `<div class="note danger" style="margin-top:10px">
    <strong>${targetLabel}审批被拒绝：</strong>${h(e.message)}
    ${e.status ? `<div class="tiny">HTTP ${h(String(e.status))}</div>` : ''}
    ${hasDetail ? `<div style="margin-top:6px">仍待完成的事项：</div>
      <ul class="blocker-list">
        ${placeholders.map((f) => `<li>占位系数 <span class="mono">${h(typeof f === 'string' ? f : f.factor_key)}</span>：须经领域专家确认取值与出处（对应 docs/12 的 EXP 条目）</li>`).join('')}
        ${formulas.map((f) => `<li>公式 <span class="mono">${h(typeof f === 'string' ? f : f.formula_id)}</span>：须回填方法学原文条款页码，去掉【占位】标记</li>`).join('')}
      </ul>` : ''}
    <div class="tiny" style="margin-top:5px">
      这些项目全部完成前，审批不能通过；即使强行改库，业务出数仍会被服务端前置校验拦下。
      请先在 <span class="mono">docs/12-领域专家确认清单.md</span> 完成对应条目的专家确认。
    </div>
  </div>`;
}

/** 方法学审批表：规则卡与计算插件分列，附审批动作与不通过理由。只有已注册模块的版本才有可审批对象。 */
function adminApprovalCard(plugins, moduleIds, approvalOrder) {
  const approvable = approvalOrder.filter((v) => moduleIds.has(v.id));
  const others = approvalOrder.filter((v) => !moduleIds.has(v.id));
  return `
  <h2>方法学审批</h2>
  <div class="card">
    <div class="note info">
      <strong>审批必须由领域专家确认背书。</strong>规则卡（判断条件）与计算插件（数值公式、缺省系数、条款页码）
      分别审批；审批动作记录审批人、时间与意见，并写入审计日志与 <span class="mono">review_decision</span> 表。
      审批依据是 <span class="mono">docs/12-领域专家确认清单.md</span>（17 项系数 + 9 项编号 + 33 条条款页码）：
      在该清单相应条目确认签字之前，<strong>不得</strong>把状态改为「通过」。
      计算插件仍含占位系数或缺条款页码时，服务端会拒绝批准并返回具体清单。
    </div>
    <label class="field" style="max-width:760px"><span>审批意见（随本次动作留痕，可留空）</span>
      <input data-role="approve-comment" placeholder="如：依据 docs/12 EXP-07 / EXP-12 确认记录，条款页码已回填 p.14" /></label>
    <div class="scroll-x"><table>
      <thead><tr>
        <th>方法学</th><th>文档状态</th><th>规则卡审批</th><th>规则卡审批人 / 时间</th>
        <th>计算插件审批</th><th>插件审批人 / 时间</th><th>未决事项</th><th>审批动作</th>
      </tr></thead>
      <tbody>
      ${approvable.map((v) => {
        const p = plugins.find((x) => x.methodology_id === v.methodology_id && x.version === v.version);
        const blockers = p ? pluginBlockers(p) : ['未注册计算插件（无可审批对象）'];
        const vid = v.id;
        const calcStatus = p ? p.calculator_status : 'none';
        return `<tr>
          <td class="tiny"><a href="#/methodologies/${h(vid)}">${h(v.code_display || v.methodology_id)}</a>
            <div class="muted">${h(v.name)}</div><div class="mono tiny muted">${h(vid)}</div></td>
          <td class="tiny">${h(STATUS_LABEL[v.document_status] || v.document_status || '—')}</td>
          <td>${approvalBadge(v.rulecard_status)}</td>
          <td class="tiny">${h(v.rulecard_approved_by || '—')}<div class="muted">${h(shortTime(v.rulecard_approved_at) || '—')}</div></td>
          <td>${approvalBadge(calcStatus)}</td>
          <td class="tiny">${h(v.calculator_approved_by || '—')}<div class="muted">${h(shortTime(v.calculator_approved_at) || '—')}</div></td>
          <td class="tiny">${blockers.length
            ? `<ul class="blocker-list">${blockers.map((b) => `<li>${h(b)}</li>`).join('')}</ul>`
            : '<span class="badge pass">无未决事项</span>'}</td>
          <td>
            <div class="tiny muted">规则卡</div>
            <div class="btn-row">
              <button data-act="approve-methodology" data-id="${h(vid)}" data-target="rulecard" data-decision="approved">通过</button>
              <button class="danger" data-act="approve-methodology" data-id="${h(vid)}" data-target="rulecard" data-decision="rejected">驳回</button>
              <button data-act="approve-methodology" data-id="${h(vid)}" data-target="rulecard" data-decision="pending_review">退回修改</button>
            </div>
            <div class="tiny muted" style="margin-top:5px">计算插件</div>
            <div class="btn-row">
              <button data-act="approve-methodology" data-id="${h(vid)}" data-target="calculator" data-decision="approved"
                ${p && calcStatus !== 'approved' && blockers.length ? 'disabled title="仍含占位系数或缺条款页码，服务端会拒绝批准；请先完成 docs/12 确认清单"' : ''}>通过</button>
              <button class="danger" data-act="approve-methodology" data-id="${h(vid)}" data-target="calculator" data-decision="rejected">驳回</button>
              <button data-act="approve-methodology" data-id="${h(vid)}" data-target="calculator" data-decision="pending_review">退回修改</button>
            </div>
            ${calcStatus === 'approved' && blockers.length ? `<div class="tiny" style="color:#991b1b;margin-top:4px">
              已标记通过审批，但数据库审批状态与插件代码不一致（插件仍含占位系数或缺条款页码），出数依旧被阻止。</div>` : ''}
          </td>
        </tr>`;
      }).join('')}
      </tbody>
    </table></div>
    <div data-role="approve-result-inline"></div>
    <div class="tiny muted" style="margin-top:8px">
      审批接口为 <span class="mono">POST /api/admin/methodology/:id/approve</span>，
      body 为 <span class="mono">{ target, decision, comment }</span>；仅「领域复核人」「系统管理员」可执行。
      计算插件仍含占位系数或缺条款页码时，服务端返回 409 并给出待办清单（本页会逐条展开）。
    </div>
  </div>

  <h3>其余目录条目（无可审批对象）</h3>
  <div class="card">
    <p class="tiny muted">下列方法学版本尚未在代码中注册规则卡或计算插件，因此<strong>没有可审批对象</strong>：
      它们可以检索、可以参与匹配排序，但界面一律显示「暂不支持自动判断 / 测算」。</p>
    <div class="scroll-x"><table>
      <thead><tr><th>方法学</th><th>文档状态</th><th>规则卡模块</th><th>计算插件模块</th><th>库内状态</th></tr></thead>
      <tbody>${others.map((v) => `<tr>
        <td class="tiny">${h(v.code_display || v.methodology_id)}<div class="muted">${h(v.name)}</div></td>
        <td class="tiny">${h(STATUS_LABEL[v.document_status] || v.document_status || '—')}</td>
        <td>${v.has_rulecard_module ? '<span class="badge info">已注册</span>' : '<span class="badge gray">未注册</span>'}</td>
        <td>${v.has_plugin_module ? '<span class="badge info">已注册</span>' : '<span class="badge gray">未注册</span>'}</td>
        <td class="tiny">规则卡 ${approvalBadge(v.rulecard_status)} 插件 ${approvalBadge(v.calculator_status)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">无。</td></tr>'}</tbody>
    </table></div>
  </div>`;
}

/* ============================== 边界与说明 ============================== */

async function AboutView() {
  return `
  <div class="page-head"><div><h1>产品边界与使用说明</h1></div></div>

  <div class="card">
    <h2 style="margin-top:0">产品定位与边界</h2>
    <p>本应用是<strong>投资筛选与研究辅助工具</strong>，输出「候选方法学、条件判断、证据缺口、初算结果、投资关注点」，供分析师复核。</p>
    <ul>
      <li>不替代项目业主、审定与核查机构、注册登记机构的工作。</li>
      <li>不把预计减排量、核查量、登记量、签发量或可交易量混为一谈。</li>
      <li>首期覆盖全国 CCER 的政策、方法学和公开项目资料；全国碳排放权配额、地方碳普惠、国际自愿减排机制只作关联信息标记，不纳入首期匹配和测算规则。</li>
    </ul>
  </div>

  <div class="card">
    <h2 style="margin-top:0">核心原则的落地方式</h2>
    <table>
      <thead><tr><th>原则</th><th>本系统中的实现</th></tr></thead>
      <tbody>
        <tr><td>官方原文优先</td><td>来源库每条记录保存 URL、发布机关、文号、发布/生效日、抓取时间、解析质量；方法学目录只从发布通知核实编号。</td></tr>
        <tr><td>原始文件可回看</td><td>项目证据表保存文件名、页码、原文片段；条件检查的每条判断都可点击追到证据定位。</td></tr>
        <tr><td>规则和公式版本可追溯</td><td>规则卡带 rule_version；计算运行绑定「分析基准日 + 方法学版本 + 因子快照」，历史报告不被库更新改写。</td></tr>
        <tr><td>证据不足时输出「待核实」</td><td>规则引擎为三态：通过 / 不通过 / 待核实。严格证据字段在来源仅为业主自述时<strong>不会</strong>返回「通过」。</td></tr>
        <tr><td>AI 负责抽取检索解释，规则负责判断，程序负责数值</td><td>条件判断由 JSON 表达式树的确定性规则引擎执行（不使用 eval，不由大模型生成结论）；数值由按方法学编号与版本注册的插件计算。</td></tr>
        <tr><td>关键结果由人审核</td><td>计算运行、条件检查、报告均有 pending → approved/rejected 的审核流，并写审计日志。</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2 style="margin-top:0">计算门禁模型：为什么现在一个数字都算不出来</h2>
    <div class="note danger">
      本系统当前处于<strong>原型验证阶段</strong>，<strong>尚未产出任何可用于投资筛选的减排量数字</strong>——这是设计要求的默认状态，不是故障。
    </div>
    <table>
      <thead><tr><th>规则</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td>默认不通过审批</td><td>每个方法学版本的 <span class="mono">rulecard_status</span> 与 <span class="mono">calculator_status</span> 初始值均为
          <span class="mono">pending_review</span>（未建立规则卡/插件的为 <span class="mono">none</span>）。代码里存在规则卡或插件模块<strong>不等于</strong>已通过领域专家审核；
          系统绝不自动写入 <span class="mono">approved</span>，必须由「领域复核人」或「系统管理员」在管理后台记录审批人与时间。</td></tr>
        <tr><td>业务测算的四个前置条件</td><td>业务通道（<span class="mono">channel: 'business'</span>）出数须<strong>同时</strong>满足：
          ① 计算插件审批状态为「已通过」；② 插件不存在任何 <span class="mono">placeholder</span> 缺省系数；
          ③ 每条公式都有真实原文条款引用（无 <span class="mono">【占位】</span>）；
          ④ 存在同一项目、同一方法学版本、同一分析基准日、且硬障碍为 0 的申报条件检查快照。任一不满足即拒绝出数，并在界面逐条列出原因。</td></tr>
        <tr><td>演示通道是隔离的</td><td>管理员可显式开启<strong>演示通道</strong>，供系统管理员与政策研究员对未通过审批的方法学做「反事实推演」。
          它<strong>默认关闭</strong>，开启也不放行业务测算：演示运行以 <span class="mono">status='demo'</span> 入库，带
          <span class="mono">demo: true</span> / <span class="mono">usable_for_report: false</span> 标记，
          <strong>不进入投资筛选报告、不可导出</strong>，界面会加盖不可忽略的水印横幅。</td></tr>
        <tr><td>当前实际状况</td><td>首批 4 项方法学（CCER-10-001 ~ 004）<strong>全部被阻止出数</strong>：CCER-10-001 仍有 3 项未经确认的占位系数；
          CCER-10-002 / 003 / 004 除占位系数外，还各有 6 条公式未回填原文条款页码。具体清单见「管理后台 → 计算门禁与演示通道」。</td></tr>
        <tr><td>放行前提</td><td>必须先把 <span class="mono">docs/12-领域专家确认清单.md</span> 的 17 项系数、9 项编号、33 条条款页码全部确认完毕，
          再在管理后台完成审批流转；<strong>在该清单确认完毕之前，系统输出不得对外出具、不得用于投资决策。</strong></td></tr>
      </tbody>
    </table>
    <div class="note warn" style="margin-top:10px">
      <strong>待领域专家确认项：</strong>方法学专属缺省系数（销毁/氧化效率、火炬燃烧效率、泄漏率、自耗气比例、电网排放因子、GWP 评估报告版本）
      与各公式的原文条款页码；另需按官方 PDF 逐条核对 <strong>CCER-10-002 / CCER-10-003 / CCER-10-004</strong> 的条款页码与缺省系数——
      这三项目前仅依据公开摘要与行业口径建立，尚未与官方 PDF 完成对账。任何未经确认的系数都不得用于对外报告或投资决策。
    </div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">其他已知限制</h2>
    <ul>
      <li>方法学目录已录入 17 项方法学（8 项编号已核实，9 项仅有主管部门口径），与设计文档记载的 18 项存在差额，已产生目录核对告警，须在注册登记系统人工逐条确认后补录；系统不推测编号。</li>
      <li>首批已实现规则卡与计算插件的方法学：CCER-10-001、CCER-10-002、CCER-10-003、CCER-10-004；四者当前均未通过审批，业务测算一律禁止。</li>
      <li>其余方法学可检索、可参与匹配排序，但界面显示「暂不支持自动判断 / 测算」，也没有可审批的规则卡或插件对象。</li>
      <li>报告导出提供 Markdown / HTML / CSV（Excel 可直接打开）；未生成二进制 .docx / .pdf，如需固定版式可在导出 HTML 后打印为 PDF。演示通道的运行不参与导出。</li>
    </ul>
  </div>

  <div class="card">
    <h2 style="margin-top:0">免责声明</h2>
    <p class="tiny">${h('本应用输出的全部结论、判断与情景估算均为筛选辅助结果，供分析师复核，不构成对减排量、签发量或可交易量的确认，不构成投资建议。情景估算不得称为「预计可签发量」。碳价仅为用户填入的情景参数，碳收益须与项目主业收益分开评估。')}</p>
  </div>`;
}

/* ============================== 事件处理 ============================== */

/* 退出登录按钮（顶栏，常驻：绑定在 document 上，登录面板与工作台都能响应） */
document.addEventListener('click', async (ev) => {
  if (!ev.target.closest || !ev.target.closest('#logout-btn')) return;
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch { /* 令牌可能已失效，忽略 */ }
  doLogout();
});

document.addEventListener('click', async (ev) => {
  const tabBtn = ev.target.closest('[data-nav-tab]');
  if (tabBtn) {
    location.hash = `#/projects/${tabBtn.dataset.project}?tab=${tabBtn.dataset.navTab}`;
    return;
  }

  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const projectId = btn.dataset.project;

  try {
    switch (act) {
      case 'alert-set': {
        await api(`/api/alerts/${id}`, { method: 'PATCH', body: { status: btn.dataset.status } });
        toast('告警状态已更新', 'ok');
        route();
        break;
      }
      case 'sync-dry':
      case 'sync-live': {
        btn.disabled = true;
        btn.textContent = '执行中…';
        try {
          const out = await api('/api/sources/sync', {
            method: 'POST',
            body: { dryRun: act === 'sync-dry', timeoutMs: 15000 },
          });
          toast(`同步完成：共 ${out.summary.total} 条；内容变化 ${out.summary.changed}；失败 ${out.summary.failed}；新编号 ${out.summary.new_codes_found}`, out.summary.failed ? 'err' : 'ok');
          route();
        } finally {
          btn.disabled = false;
        }
        break;
      }
      case 'change-confirm': {
        await api(`/api/source-changes/${id}/confirm`, { method: 'POST', body: { review_status: 'confirmed' } });
        toast('变更已确认', 'ok');
        route();
        break;
      }
      case 'run-match': {
        btn.disabled = true;
        const out = await api(`/api/projects/${projectId}/match`, { method: 'POST', body: {} });
        const el = document.getElementById('match-result');
        // 复用本页渲染时读到的审批状态，避免局部刷新与整页刷新显示不一致
        const approved = new Set((btn.dataset.approved || '').split(',').filter(Boolean));
        if (el) el.innerHTML = matchResultHtml(out, approved);
        toast(`匹配完成：候选 ${out.candidates.length} 项`, 'ok');
        btn.disabled = false;
        break;
      }
      case 'quick-match': {
        location.hash = `#/projects/${projectId}?tab=match`;
        break;
      }
      case 'run-elig':
      case 'quick-elig': {
        btn.disabled = true;
        const out = await api(`/api/projects/${projectId}/eligibility`, { method: 'POST', body: {} });
        if (act === 'quick-elig') {
          location.hash = `#/projects/${projectId}?tab=eligibility`;
        } else {
          const el = document.getElementById('elig-result');
          if (el) el.innerHTML = eligibilityResultHtml(out, { linkProjectId: projectId });
        }
        toast(`条件检查完成：${out.conclusion}`, out.conclusion === '存在明确障碍' ? 'err' : 'ok');
        btn.disabled = false;
        break;
      }
      case 'view-calc': {
        const d = await api(`/api/calculations/${id}`);
        const el = document.getElementById('calc-result');
        if (el) {
          const r = d.calculation.result || {};
          const isDemo = d.calculation.status === 'demo' || r.demo === true || r.channel === 'demo';
          el.innerHTML = d.calculation.status === 'rejected'
            ? calcResultHtml({ rejected: true, channel: r.channel || 'business', ...r, errors: r.errors || [] })
            : calcResultHtml({
                plugin: { title: r.methodology?.name || '', plugin_key: d.calculation.plugin_key, plugin_version: d.calculation.plugin_version, status_note: '' },
                analysis_base_date: d.calculation.analysis_base_date,
                // 历史明细必须保留通道标记：演示运行永远带着水印出现
                channel: isDemo ? 'demo' : 'business',
                demo: isDemo,
                usable_for_report: !isDemo,
                watermark: r.watermark || (isDemo ? DEMO_WATERMARK_FALLBACK : null),
                gate_reason: r.gate_reason || null,
                eligibility_snapshot: r.eligibility_snapshot || null,
                input_origins: r.input_origins || [],
                factor_snapshot: d.calculation.factor_snapshot,
                runs: [{
                  scenario: r.scenario,
                  scenario_label: r.scenario_label,
                  er_annual: r.er_annual,
                  crediting: r.crediting,
                  steps: r.steps,
                  assumptions: r.assumptions,
                  missing: r.missing,
                  sensitivity: r.sensitivity,
                  placeholder_factors: r.placeholder_factors,
                  result: r,
                }],
                warnings: r.warnings || [],
              });
          el.scrollIntoView({ behavior: 'smooth' });
        }
        break;
      }
      case 'compare-calc': {
        const a = document.getElementById('cmp-a')?.value;
        const b = document.getElementById('cmp-b')?.value;
        if (!a || !b) return;
        const d = await api(`/api/calculations?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
        const el = document.getElementById('cmp-result');
        if (el) {
          el.innerHTML = `<div class="note info">
            <strong>${h(d.run_a.scenario)}（${h(d.run_a.analysis_base_date)}）→ ${h(d.run_b.scenario)}（${h(d.run_b.analysis_base_date)}）</strong><br/>
            年度结果：${num(d.run_a.er_annual, 2)} → ${num(d.run_b.er_annual, 2)} tCO₂e（差异 ${num(d.delta_er_annual, 2)}，${num(d.delta_pct, 2)}%）
          </div>
          <h4>差异原因</h4><ul>${d.explanation.reasons.map((r) => `<li class="tiny">${h(r)}</li>`).join('')}</ul>
          ${d.input_diff.length ? `<h4>输入参数差异</h4><table><thead><tr><th>参数</th><th>A</th><th>B</th></tr></thead>
            <tbody>${d.input_diff.map((x) => `<tr><td class="mono tiny">${h(x.key)}</td><td class="tiny">${h(x.run_a)}</td><td class="tiny">${h(x.run_b)}</td></tr>`).join('')}</tbody></table>` : ''}
          ${d.factor_diff.length ? `<h4>因子版本差异</h4><table><thead><tr><th>因子</th><th>A</th><th>B</th></tr></thead>
            <tbody>${d.factor_diff.map((x) => `<tr><td class="tiny">${h(x.name || x.factor_key)}</td>
              <td class="tiny">${h(x.run_a ? `${x.run_a.value} ${x.run_a.unit || ''}（${x.run_a.status}）` : '无')}</td>
              <td class="tiny">${h(x.run_b ? `${x.run_b.value} ${x.run_b.unit || ''}（${x.run_b.status}）` : '无')}</td></tr>`).join('')}</tbody></table>` : ''}
          <div class="note ok">${h(d.note)}</div>`;
        }
        break;
      }
      case 'gen-report': {
        btn.disabled = true;
        const priceRaw = document.getElementById('rpt-price')?.value;
        const out = await api(`/api/projects/${projectId}/report`, {
          method: 'POST',
          body: {
            carbonPrice: priceRaw === '' || priceRaw === undefined ? null : Number(priceRaw),
            analysisBaseDate: document.getElementById('rpt-basedate')?.value || undefined,
          },
        });
        const el = document.getElementById('report-result');
        if (el) {
          el.innerHTML = reportResultHtml(out);
          el.scrollIntoView({ behavior: 'smooth' });
        }
        toast(`报告已生成 r${out.revision}`, 'ok');
        btn.disabled = false;
        break;
      }
      case 'export-report': {
        await apiDownload(`/api/reports/${id}/export?format=${encodeURIComponent(btn.dataset.format || 'markdown')}`);
        break;
      }
      case 'print': {
        window.print();
        break;
      }
      case 'review': {
        await api('/api/reviews', {
          method: 'POST',
          body: {
            objectType: btn.dataset.type,
            objectId: id,
            decision: btn.dataset.decision,
            comment: '工作台人工审核操作',
          },
        });
        toast(`审核完成：${btn.dataset.decision}`, 'ok');
        route();
        break;
      }
      case 'demo-channel': {
        const enabled = btn.dataset.enabled === '1';
        const noteEl = document.querySelector('[data-role="demo-note"]');
        const note = noteEl && noteEl.value.trim() ? noteEl.value.trim() : undefined;
        btn.disabled = true;
        try {
          const out = await api('/api/admin/demo-channel', { method: 'POST', body: { enabled, note } });
          await refreshGate();
          toast(out.message || (enabled ? '演示通道已开启' : '演示通道已关闭'), enabled ? '' : 'ok');
          route();
        } catch (e) {
          // 403（非管理员）/ 409 等：在开关旁原样呈现服务端原因；失败提示由外层统一 toast
          const box = btn.closest('.card');
          if (box) box.insertAdjacentHTML('beforeend', `<div class="note danger" style="margin-top:8px"><strong>演示通道变更失败：</strong>${h(e.message)}</div>`);
          throw e;
        }
        break;
      }
      case 'approve-methodology': {
        const target = btn.dataset.target;
        const decision = btn.dataset.decision;
        const commentEl = document.querySelector('[data-role="approve-comment"]');
        const comment = commentEl && commentEl.value.trim() ? commentEl.value.trim() : undefined;
        // 收拢页面上的所有结果容器：审批卡片内联一份、页面底部兜底一份
        const boxes = $$('[data-role="approve-result-inline"], [data-role="approve-result"]');
        boxes.forEach((b) => { b.innerHTML = ''; });
        const targetLabel = target === 'rulecard' ? '规则卡' : '计算插件';
        btn.disabled = true;
        try {
          const out = await api(`/api/admin/methodology/${id}/approve`, {
            method: 'POST',
            body: { target, decision, comment },
          });
          const label = { approved: '通过', rejected: '驳回', pending_review: '退回修改' }[out.decision] || out.decision;
          toast(`${targetLabel}审批已记录：${label}`, decision === 'rejected' ? '' : 'ok');
          route();
        } catch (e) {
          // 409：仍含占位系数或缺条款页码 —— 必须把待办清单原样展示给复核人。
          // 失败提示交由外层统一 toast，这里只负责把服务端返回的明细渲染出来。
          const html = approvalErrorHtml(e, targetLabel);
          for (const b of boxes) b.innerHTML = html;
          throw e;
        }
        break;
      }
      default:
        toast(`未实现的操作：${act}`, 'err');
    }
  } catch (e) {
    toast(`${act} 失败：${e.message}`, 'err');
  }
});

/* 表单提交 */
document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('[data-act]');
  if (!form) return;
  ev.preventDefault();
  const act = form.dataset.act;
  const projectId = form.dataset.project;
  const fd = Object.fromEntries(new FormData(form).entries());

  try {
    switch (act) {
      case 'demo-login': {
        const btn = $('[data-role="login-submit"]');
        const errBox = $('[data-role="login-error"]');
        if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
        if (errBox) errBox.hidden = true;
        try {
          const out = await doLogin(fd.user_id, fd.password);
          state.token = out.token;
          state.user = out.user;
          state.authMode = out.auth_mode || 'session';
          localStorage.setItem(TOKEN_KEY, out.token);
          toast(`已登录：${out.user.name}（${ROLE_LABEL[out.user.role] || out.user.role}）`, 'ok');
          // 登录成功后进入工作台（重新初始化一次，等价于刷新）
          await boot();
        } catch (e) {
          if (errBox) {
            errBox.hidden = false;
            errBox.innerHTML = `<strong>登录失败：</strong>${h(e.message)}`;
          }
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '登录'; }
        }
        break;
      }
      case 'methodology-filter': {
        const qs = new URLSearchParams(Object.entries(fd).filter(([, v]) => v !== '')).toString();
        location.hash = `#/methodologies${qs ? '?' + qs : ''}`;
        break;
      }
      case 'project-create': {
        const out = await api('/api/projects', { method: 'POST', body: fd });
        toast('项目已创建', 'ok');
        location.hash = `#/projects/${out.id}`;
        break;
      }
      case 'fact-upsert': {
        const payload = {
          field_key: fd.field_key,
          value: fd.value === '' ? null : fd.value,
          source_kind: fd.source_kind,
          evidence_id: fd.evidence_id || null,
          note: fd.note || null,
        };
        await api(`/api/projects/${projectId}/facts`, { method: 'POST', body: payload });
        toast('事实已保存', 'ok');
        route();
        break;
      }
      case 'evidence-add': {
        await api(`/api/projects/${projectId}/evidence`, {
          method: 'POST',
          body: {
            file_name: fd.file_name,
            doc_type: fd.doc_type,
            page: fd.page === '' ? null : Number(fd.page),
            excerpt: fd.excerpt || null,
            confidentiality: fd.confidentiality,
          },
        });
        toast('证据已新增', 'ok');
        route();
        break;
      }
      case 'registry-update': {
        const body = {};
        for (const k of ['registry_project_public', 'registry_validated', 'registry_project_registered',
          'registry_reduction_public', 'registry_verified', 'registry_reduction_registered']) {
          body[k] = form.elements[k]?.checked || false;
        }
        for (const k of ['owner_announced_estimate', 'verified_amount', 'registered_amount', 'registry_public_url']) {
          body[k] = fd[k] === '' || fd[k] === undefined ? null : fd[k];
        }
        await api(`/api/projects/${projectId}/registry`, { method: 'PATCH', body });
        toast('注册登记状态已保存', 'ok');
        route();
        break;
      }
      case 'run-calc': {
        const channel = fd.channel === 'demo' ? 'demo' : 'business';
        const overrides = {};
        const map = {
          recovery_volume_nm3: 'recovery_volume_nm3',
          og_recovery_volume_nm3: 'recovery_volume_nm3',
          daily_recovery_nm3: 'daily_recovery_nm3',
          ch4_concentration_pct: 'ch4_concentration_pct',
          ch4_fraction: 'ch4_fraction',
          hours_per_year: 'hours_per_year',
          destruction_efficiency: 'destruction_efficiency',
          baseline_flare_efficiency: 'baseline_flare_efficiency',
          selfuse_fraction: 'selfuse_fraction',
          gathering_selfuse_fraction: 'gathering_selfuse_fraction',
          leakage_rate: 'leakage_rate',
          grid_mwh: 'grid_mwh',
          process_power_mwh: 'process_power_mwh',
          process_power_ef: 'process_power_ef',
          station_design_scale_m3d: 'station_design_scale_m3d',
          crediting_start_year: 'crediting_start_year',
          crediting_years: 'crediting_years',
        };
        for (const [formKey, apiKey] of Object.entries(map)) {
          const v = fd[formKey];
          if (v !== undefined && v !== '') overrides[apiKey] = formKey === 'crediting_start_year' ? v : Number(v);
        }
        const mode = fd.mode || 'all';
        const submitBtn = $('[data-role="run-calc"]', form) || $('[data-role="run-calc"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = channel === 'demo' ? '演示运行中…' : '计算中…'; }
        let out = null;
        try {
          out = await api(`/api/projects/${projectId}/calculate`, {
            method: 'POST',
            body: {
              channel,
              allScenarios: mode === 'all',
              scenario: mode === 'all' ? 'base' : mode,
              overrides,
              methodologyVersionId: fd.methodologyVersionId || undefined,
            },
          });
        } catch (e) {
          // 409 门禁拒绝是正常业务结果：把服务端给出的阻断原因完整呈现在结果区
          if (e.status === 409 && (e.data?.kind === 'precondition' || e.data?.rejected)) {
            out = { ...e.data, rejected: true, channel: e.data.channel || channel };
          } else {
            throw e;
          }
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '执行计算'; }
        }
        const el = document.getElementById('calc-result');
        if (el) {
          el.innerHTML = calcResultHtml(out);
          el.scrollIntoView({ behavior: 'smooth' });
        }
        toast(channel === 'demo'
          ? '演示通道运行完成：结果不得用于投资筛选报告、对外材料或投资决策'
          : (out.rejected ? '业务测算被阻止出数（未通过门禁）' : '业务测算完成，已绑定本次条件检查快照'),
          out.rejected ? 'err' : (channel === 'demo' ? '' : 'ok'));
        break;
      }
      default:
        toast(`未实现的表单：${act}`, 'err');
    }
  } catch (e) {
    const detail = e.data?.errors
      ? '\n' + e.data.errors.map((x) => `· ${x.message}`).join('\n')
      : '';
    toast(`${act} 失败：${e.message}${detail}`, 'err');
  }
});

boot();
