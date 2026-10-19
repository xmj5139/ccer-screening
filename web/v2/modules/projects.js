/**
 * 模块三：公开项目
 * ============================================================================
 * 需求（docs/19 第 22 条）：
 *   - 主来源 https://ccer.cets.org.cn/projectPublicity/projectPublicityList ；
 *   - 覆盖公开项目/减排量公示、登记等**可查阶段**；保留业主、方法学、地域、
 *     原始文件、阶段日期和历史变化；
 *   - **删除内部项目页签、项目创建和项目人工核对按钮**；
 *   - 附件不能下载时显示真实状态与官方链接。
 *
 * 口径纪律：公示量不当登记量；重复阶段不相加成项目总数；
 * 「自动核验」是规则与模型的一致性检查结论，不是人工确认、不是主管部门确认。
 */
import { api, setQuery, state } from '../app.js';
import {
  card, table, loading, emptyState, errorState, noteBlock, esc, shortDate, dateTime, chip,
  drawer, kv, toast, num,
} from '../ui.js';
import { verifyChip } from './verify-labels.js';
import { summaryBlock, summaryCoverageHint, sourceBlock } from '../platform.js';

const TABS = [
  { key: 'public', label: '公开项目库' },
  { key: 'import', label: '导入与模板' },
];

const VERIFY_OPTIONS = [
  ['verified', '自动核验通过'],
  ['insufficient', '证据不足'],
  ['conflict', '来源冲突'],
  ['unavailable', '暂未自动核验'],
];

const LINK_STATUS_LABEL = {
  ok: ['ok', '官方页面可访问'],
  blocked: ['warn', '官方页面拒绝访问'],
  not_found: ['warn', '官方页面已失效'],
  unreachable: ['warn', '官方页面暂时无法连接'],
  unknown: ['', '官方链接未检测'],
};

export async function renderProjects(root, route) {
  const q = route.query || {};
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'public';
  root.innerHTML = `
    <div class="tabs">${TABS.map((t) => `<a class="tab ${t.key === tab ? 'active' : ''}" href="#/projects?tab=${t.key}">${esc(t.label)}</a>`).join('')}</div>
    <div id="tab-body">${loading()}</div>`;
  const body = document.getElementById('tab-body');
  try {
    if (tab === 'public') await renderPublicTab(body, q);
    else await renderImportTab(body);
  } catch (e) {
    body.innerHTML = errorState(e);
  }
}

/**
 * CCER 公开项目 与 CEA 重点排放单位名录 是两个不同口径的数据集：
 * 前者是自愿减排项目（公示/登记阶段），后者是纳管企业名单（配额市场履约主体）。
 * 名录数量不等于买家数量，也不代表企业实际盈缺。
 */
function ceaEntityEntry(cea) {
  const err = cea?.__error;
  const total = err ? null : (cea?.total ?? 0);
  return card({
    title: 'CEA 重点排放单位名录（与 CCER 公开项目分开）',
    subtitle: '两个数据集口径不同，不能相加，也不能互相替代',
    actions: '<a class="btn btn-sm" href="#/cea?tab=entities">进入 CEA 企业名录</a>',
    body: `
      <ul class="bullets">
        <li><b>CCER 公开项目</b>：自愿减排项目的公示、审定、登记等可查阶段（本页上方清单）。</li>
        <li><b>CEA 重点排放单位名录</b>：被纳入全国碳排放配额管理的企业名单，按统一社会信用代码 + 名录年度标识。</li>
      </ul>
      ${err
        ? `<p class="hint">CEA 名录接口当前不可用（HTTP ${esc(String(err.status || '—'))}）：不显示替代数字。</p>`
        : (total === 0
          ? `<p class="hint">系统已收录 CEA 名录 <b>0</b> 条：来源解析缺口——公开样本（省级 PDF）为扫描件或无结构化名录行，<b>不添加假企业填充</b>。管理员可在后台补充官方原件。</p>`
          : `<p class="hint">系统已收录 CEA 名录 <b>${num(total)}</b> 条（本平台已收录数，不等于全国总数）。</p>`)}
      <p class="hint"><b>名录数量不等于买家数量</b>：进入名录只说明该企业被纳入碳市场管理，不代表它一定购买配额，也不代表企业实际盈缺；本平台不提供企业持仓或盈缺数据。</p>`,
  });
}

/* ------------------------------ 公开项目库 ------------------------------ */

async function renderPublicTab(body, q) {
  const registryStatus = await api('/api/v2/registry/status');
  // CEA 名录覆盖数（失败不阻塞 CCER 项目库）：0 表示来源解析缺口，不添加假企业填充
  const ceaEntities = await api('/api/v2/cea/entities?limit=1').catch((e) => ({ __error: e }));
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([k, v]) => v && k !== 'tab'))).toString();
  const data = await api(`/api/v2/public-projects${qs ? `?${qs}` : ''}`);
  const rows = data.rows || [];
  body.innerHTML = `
  <div class="callout"><b>官方主来源</b><p><a class="link" href="${esc(registryStatus.source)}" target="_blank" rel="noopener noreferrer">注册登记系统项目公示栏目</a>｜自动收录 ${num(registryStatus.projects)} 个项目｜最近同步 ${esc(registryStatus.last_sync_at || '尚未同步')}。列表、详情和附件来源均可在项目详情追溯。</p></div>
  ${ceaEntityEntry(ceaEntities)}
  <div class="filters">
    <label class="fld"><span>关键词（名称/业主/登记编号/信用代码）</span><input type="search" data-f="keyword" value="${esc(q.keyword || '')}"></label>
    <label class="fld"><span>省份</span><input type="search" data-f="province" value="${esc(q.province || '')}" placeholder="如 山西省"></label>
    <label class="fld"><span>方法学编号</span><input type="search" data-f="methodology_id" value="${esc(q.methodology_id || '')}" placeholder="CCER-10-001"></label>
    <label class="fld"><span>阶段</span><select data-f="stage"><option value="">全部</option>
      ${[['project_public', '项目公示'], ['validated', '审定'], ['project_registered', '项目登记'], ['reduction_public', '减排量公示'], ['verified', '核查'], ['reduction_registered', '减排量登记']]
        .map(([k, l]) => `<option value="${k}" ${q.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="fld"><span>自动核验</span><select data-f="auto_verify_status"><option value="">全部</option>
      ${VERIFY_OPTIONS.map(([k, l]) => `<option value="${k}" ${q.auto_verify_status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="fld"><span>证据等级</span><select data-f="evidence_level"><option value="">全部</option>
      ${[['official_registry', '官方登记/发布事实'], ['project_material', '业主公示或项目材料'], ['third_party', '第三方信息'], ['unverified', '待核实']]
        .map(([k, l]) => `<option value="${k}" ${q.evidence_level === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <span class="fld-actions">
      <a class="btn btn-sm" href="/api/v2/public-projects/export?format=csv${qs ? `&${qs}` : ''}" download>导出 CSV</a>
      <a class="btn btn-sm" href="/api/v2/public-projects/export?format=xlsx${qs ? `&${qs}` : ''}" download>导出 Excel</a>
    </span>
  </div>
  ${card({
    title: '公开项目清单',
    subtitle: `共 ${data.total} 条（本平台已自动收录数，不等于全国总数）`,
    body: table({
      rows,
      pageSize: 20,
      columns: [
        { key: 'registry_project_no', label: '官方 ID', render: (r) => `<a class="link" data-pp="${esc(r.id)}">${esc(r.registry_project_no || '（未登记）')}</a>` },
        { key: 'name', label: '项目名称与核心摘要', render: (r) => `<span class="title-cell">${esc(r.name)}</span>${summaryBlock(r, { compact: true })}` },
        { key: 'owner_name', label: '业主' },
        { key: 'province', label: '省份' },
        { key: 'methodology_id', label: '方法学' },
        { key: 'current_stage', label: '当前阶段' },
        { key: 'stage_flags', label: '阶段分列', definition: '各阶段是否已发生；阶段为并列标记，不相加成项目总数', render: (r) => (r.stage_flags || []).map((s) => (s.done ? `<span class="dot-ok" title="${esc(s.label)}">${esc(s.label.slice(0, 2))}</span>` : `<span class="dot-off">${esc(s.label.slice(0, 2))}</span>`)).join('') },
        { key: 'owner_announced_estimate', label: '公示预计量', align: 'right', render: (r) => num(r.owner_announced_estimate) },
        { key: 'verified_amount', label: '核查量', align: 'right', render: (r) => num(r.verified_amount) },
        { key: 'registered_amount', label: '登记量', align: 'right', render: (r) => num(r.registered_amount) },
        { key: 'source_display', label: '来源', definition: '官方信息 / 第三方实际发布机构 / 来源未标注', render: (r) => sourceBlock(r) },
        { key: 'manual_revision', label: '管理员修订', render: (r) => (r.manual_revision ? chip('已修订（覆盖层）', 'warn') : '—') },
      ],
      emptyText: '没有符合条件的公开项目',
      emptyHint: '尚未同步官方公开项目；可在「后台管理 → 采集连接」执行官方项目库同步。',
    }) + summaryCoverageHint(rows) + noteBlock(data.note),
  })}`;

  wireFilters(body, { keyword: 400 });
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-pp]');
    if (!a) return;
    try {
      const d = await api(`/api/v2/public-projects/${a.dataset.pp}`);
      let verif = { latest: [] };
      try {
        verif = await api(`/api/v2/public-projects/${a.dataset.pp}/verify`);
      } catch {
        /* 核验记录读取失败不影响主详情 */
      }
      showPublicDrawer(d, { ...verif });
    } catch (err) {
      toast(err.body?.message || err.message, 'danger');
    }
  });
}

function showPublicDrawer(d, verif = {}) {
  const p = d.project;
  const ta = d.trade_attribution || {};
  const events = (d.events || []).map((e) => `<tr><td>${esc(shortDate(e.event_date))}</td><td>${esc(EVENT_LABEL[e.event_type] || e.event_type)}</td>
    <td>${esc(e.period_start || '—')} ~ ${esc(e.period_end || '—')}</td><td class="ta-r">${num(e.amount)}</td>
    <td>${esc(e.amount_label)}</td><td>${esc(e.registry_ref || '—')}</td><td>${esc(e.source_url ? '官方页面' : '官方接口')}</td></tr>`).join('');
  const batches = (d.batches || []).map((b) => `<tr><td>${esc(b.batch_no || '—')}</td><td>${esc(b.period_start || '—')} ~ ${esc(b.period_end || '—')}</td>
    <td class="ta-r">${num(b.owner_announced_estimate)}</td><td class="ta-r">${num(b.verified_amount)}</td><td class="ta-r">${num(b.registered_amount)}</td>
    <td>${esc(b.registration_date || '—')}</td><td>${esc(b.cancellation_status || '—')}</td></tr>`).join('');
  const latest = (verif.latest || [])[0];
  const [linkCls, linkLabel] = LINK_STATUS_LABEL[p.link_status || 'unknown'] || LINK_STATUS_LABEL.unknown;

  document.body.insertAdjacentHTML('beforeend', drawer('公开项目详情', `
    <h4>${esc(p.name)}</h4>
    ${kv([
      ['官方项目 ID', esc(p.registry_project_no || '—')],
      ['业主', esc(p.owner_name || '—')],
      ['统一社会信用代码', esc(p.owner_credit_code || '—')],
      ['地区', esc(`${p.province || ''} ${p.city || ''}`)],
      ['领域 / 行业', esc(`${p.domain || '—'} / ${p.industry || '—'}`)],
      ['方法学', esc(`${p.methodology_id || '—'} ${p.methodology_version || ''}`)],
      ['技术路线', esc(p.technology_route || '—')],
      ['项目边界', esc(p.boundary_desc || '—')],
      ['投产时间', esc(shortDate(p.start_operation_date))],
      ['证据等级', chip(p.evidence_label, p.evidence_level === 'official_registry' ? 'ok' : 'warn')],
      ['自动核验', verifyChip(p.auto_verify_status)],
      ['自动核验时间', esc(p.auto_verify_at ? dateTime(p.auto_verify_at) : '尚未核验')],
      ['官方页面', p.official_url ? `<a class="link" href="${esc(p.official_url)}" target="_blank" rel="noreferrer noopener">打开</a> ${chip(linkLabel, linkCls)}` : '未登记'],
    ])}
    <div class="callout ${ta.attributable ? 'callout-ok' : 'callout-warn'}">
      <b>交易关联</b>
      <p>${esc(ta.message || '')}</p>
      ${ta.market_summary ? `<p class="muted">市场汇总（不能归因到本项目）：累计成交量 ${num(ta.market_summary.market_total?.volume)} tCO₂e｜累计成交额 ${num(ta.market_summary.market_total?.turnover)} 元｜区间均价 ${num(ta.market_summary.market_total?.avg_price, 2)} 元/tCO₂e</p>` : ''}
      ${ta.how_to_enable ? `<p class="hint">${esc(ta.how_to_enable)}</p>` : ''}
    </div>
    <h5>三套数字（分开存储，禁止互相替代）</h5>
    <div class="metrics metrics-sm">
      <article class="metric metric-sm"><div class="metric-label">业主公示预计量</div><div class="metric-value">${num(d.amounts_summary?.owner_announced_estimate)}<span class="metric-unit">tCO₂e</span></div><div class="metric-note">公示量不当登记量</div></article>
      <article class="metric metric-sm"><div class="metric-label">核查确定量</div><div class="metric-value">${num(d.amounts_summary?.verified_amount)}<span class="metric-unit">tCO₂e</span></div></article>
      <article class="metric metric-sm"><div class="metric-label">减排量登记量</div><div class="metric-value">${num(d.amounts_summary?.registered_amount)}<span class="metric-unit">tCO₂e</span></div></article>
    </div>
    <h5>阶段事件（${(d.events || []).length}）</h5>
    ${events ? `<table class="grid grid-sm"><thead><tr><th>日期</th><th>事件</th><th>期间</th><th>数量</th><th>口径</th><th>登记引用</th><th>来源</th></tr></thead><tbody>${events}</tbody></table>` : '<p class="muted">暂无事件记录。</p>'}
    <h5>减排量批次（${(d.batches || []).length}）</h5>
    ${batches ? `<table class="grid grid-sm"><thead><tr><th>批次</th><th>期间</th><th>公示预计量</th><th>核查量</th><th>登记量</th><th>登记日期</th><th>注销</th></tr></thead><tbody>${batches}</tbody></table>` : '<p class="muted">暂无批次记录。</p>'}
    <h5>自动核验</h5>
    ${latest ? `<div class="verify-box verify-${esc(latest.result)}">
        <div class="verify-head">${verifyChip(latest.result)}
          <span class="muted">${esc(dateTime(latest.created_at))}｜${latest.model_used ? `模型：${esc(latest.model || '—')}` : '未调用模型'}</span></div>
        <p>${esc(latest.summary || '')}</p>
        ${latest.capability_note ? `<p class="muted">${esc(latest.capability_note)}</p>` : ''}
        ${(latest.rules || []).length ? `<details><summary>规则一致性检查（${latest.rules.filter((r) => r.ok).length}/${latest.rules.length} 通过）</summary>
          <ul class="bullets">${latest.rules.map((r) => `<li>${r.ok ? '✓' : '✗'} ${esc(r.label || r.rule_key)}${r.message ? `：${esc(r.message)}` : ''}</li>`).join('')}</ul></details>` : ''}
      </div>`
      : '<p class="muted">本条尚无自动核验记录。核验由每日任务自动执行，无需人工确认。</p>'}
    <h5>附件与原始文件</h5>
    ${(d.attachments || []).length
      ? `<ul class="list">${d.attachments.map((a) => `<li>${esc(a.file_name || a.name || '未命名')}｜${a.available === false ? chip('官方链接不可下载', 'warn') : chip('已归档', 'ok')}${a.url ? `｜<a class="link" href="${esc(a.url)}" target="_blank" rel="noreferrer noopener">官方链接</a>` : ''}</li>`).join('')}</ul>`
      : `<p class="muted">未获取到附件清单。附件是否可下载以官方页面为准，平台不会用占位文件冒充已归档。</p>`}
    <div class="drawer-actions">
      ${p.official_url ? `<a class="btn" href="${esc(p.official_url)}" target="_blank" rel="noreferrer noopener">打开官方页面</a>` : ''}
      <span class="hint">本平台只自动收录公开资料；项目事实以官方页面与附件原文为准，无人工核对按钮。</span>
    </div>
  `, { wide: true }));
}

const EVENT_LABEL = {
  project_public: '项目公示', validation: '审定', project_registration: '项目登记',
  reduction_public: '减排量公示', verification: '核查', reduction_registration: '减排量登记', cancellation: '注销',
};

/* ------------------------------ 导入与模板 ------------------------------ */

async function renderImportTab(body) {
  const data = await api('/api/v2/meta/templates');
  // 只保留公开数据模板：内部项目模板已随内部项目模块下线
  const templates = (data.templates || []).filter((t) => t.key !== 'internal-project');
  body.innerHTML = `
  ${card({
    title: '公开数据导入模板',
    subtitle: '无法稳定自动获取的公开数据（公开项目列表、行情摘录）走模板导入，逐行校验后进入自动核验',
    body: `<table class="grid">
      <thead><tr><th>模板</th><th>用途</th><th>来源</th><th>下载</th><th>在线导入</th></tr></thead>
      <tbody>${templates.map((t) => `<tr>
        <td><b>${esc(t.name)}</b></td>
        <td>${esc(t.purpose)}</td>
        <td class="muted">${esc(t.source_note)}</td>
        <td><a class="btn btn-sm" href="/api/v2/meta/templates/${esc(t.key)}/file" download>下载模板</a></td>
        <td>${t.key === 'methodology-pdf' ? '<span class="muted">—</span>' : `<button class="btn btn-sm" data-import="${esc(t.key)}">粘贴 CSV 导入</button>`}</td>
      </tr>`).join('')}</tbody></table>`,
    note: '导入的公开数据同样走自动核验；平台不提供项目创建、尽调或投资审批入口。',
  })}
  <div id="import-panel"></div>`;
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-import]');
    if (!b) return;
    openImportPanel(b.dataset.import);
  });
}

function openImportPanel(key) {
  const panel = document.getElementById('import-panel');
  panel.innerHTML = card({
    title: `导入：${esc(key)}`,
    subtitle: '直接把 CSV 内容粘贴到下方（含表头），或选择文件',
    body: `
      <div class="filters">
        <label class="fld"><span>选择文件</span><input type="file" id="import-file" accept=".csv,text/csv"></label>
        <span class="fld-actions"><button class="btn btn-primary btn-sm" id="import-submit">校验并导入</button>
        <button class="btn btn-sm" id="import-dry">仅校验</button></span>
      </div>
      <textarea id="import-csv" rows="10" placeholder="交易日期,成交量(tCO₂e),成交额(元),成交均价(元/tCO₂e),官方公告链接&#10;2026-09-23,122,10497.10,86.04,https://..."></textarea>
      <div id="import-result"></div>`,
  });
  document.getElementById('import-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    document.getElementById('import-csv').value = await f.text();
  });
  document.getElementById('import-submit')?.addEventListener('click', () => doImport(key, false));
  document.getElementById('import-dry')?.addEventListener('click', () => doImport(key, true));
}

async function doImport(key, dryRun) {
  const csv = document.getElementById('import-csv').value;
  const out = document.getElementById('import-result');
  if (!csv.trim()) {
    out.innerHTML = '<p class="state-error">请先粘贴或选择 CSV 内容。</p>';
    return;
  }
  const preview = document.createElement('div');
  preview.className = 'note-block';
  preview.textContent = dryRun ? '校验中…' : '导入中…';
  out.innerHTML = '';
  out.appendChild(preview);
  if (dryRun) {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    preview.textContent = `解析到 ${Math.max(0, lines.length - 1)} 行数据（未写入）。点击「校验并导入」执行服务端逐行校验。`;
    return;
  }
  try {
    const res = await api(`/api/v2/import/${key}`, { method: 'POST', body: { csv } });
    const rejected = res.rejected || [];
    preview.className = 'note-block';
    preview.innerHTML = `<b>导入完成</b>：接收 ${res.accepted_count ?? 0} 行，拒绝 ${res.rejected_count ?? 0} 行。` +
      (res.inserted !== undefined ? `（新增 ${res.inserted}｜未变 ${res.unchanged}｜修订 ${res.revised}）` : '') +
      `<br><span class="hint">${esc(res.note || '')}</span>` +
      (rejected.length ? `<ul class="list">${rejected.slice(0, 20).map((r) => `<li>第 ${r.row} 行：${esc((r.errors || []).join('；'))}</li>`).join('')}</ul>` : '');
    toast('导入完成', 'ok');
  } catch (e) {
    preview.className = 'state-error';
    preview.textContent = e.body?.error || e.message;
  }
}

/* ------------------------------ 公共 ------------------------------ */

let debounceTimer = null;
function wireFilters(root, debounce = {}) {
  root.querySelectorAll('[data-f]').forEach((el) => {
    const apply = () => setQuery({ [el.dataset.f]: el.value });
    if (el.type === 'search' && debounce[el.dataset.f]) {
      el.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(apply, debounce[el.dataset.f]);
      });
    } else {
      el.addEventListener('change', apply);
    }
  });
}
