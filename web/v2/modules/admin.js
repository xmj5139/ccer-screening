/**
 * 模块七：后台管理
 * ============================================================================
 * 需求（docs/19 第 26 条）：采集连接、搜索 API/MCP、模型配置与**真实连接测试**、
 * 自动核验策略、每日任务/重试/错误日志、用户管理和操作日志。
 * **删除人工审核任务、复核角色、专家审批等**。
 * 故障/冲突只作为自动运行状态展示，不要求管理员审批内容。
 */
import { api, setQuery, state } from '../app.js';
import {
  card, table, loading, emptyState, errorState, noteBlock, esc, shortDate, dateTime, chip,
  drawer, kv, toast, num, truncate,
} from '../ui.js';
import { verifyChip } from './verify-labels.js';
import { renderAccountingSourceTable, renderAccountingGaps, techDetails } from './accounting.js';
import { renderMaintenance } from './maintenance.js';
import { renderGovernance } from './governance.js';
import {
  fallbackFormOptions, loadFormOptions, selectOptionsHtml,
} from '../form-selects.js';

function safeHttpHref(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? esc(url.href) : null;
  } catch { return null; }
}

const TABS = [
  { key: 'maintenance', label: '运行与内容维护' },
  { key: 'governance', label: '信息治理与历史补采' },
  { key: 'status', label: '系统状态' },
  { key: 'datasources', label: '官方数据源' },
  { key: 'cea', label: 'CEA 配额市场' },
  { key: 'ocr', label: 'PDF 解析/OCR' },
  { key: 'accounting', label: '碳核算资料' },
  { key: 'connectors', label: '采集连接（搜索 API / 抓取 MCP）' },
  { key: 'intelligence', label: '公开信息智能化' },
  { key: 'llm', label: '模型配置' },
  { key: 'deepseek', label: 'DeepSeek 能力' },
  { key: 'verify', label: '自动核验策略' },
  { key: 'users', label: '用户管理' },
  { key: 'reconciliation', label: '核对与缺口' },
  { key: 'jobs', label: '任务与快照' },
  { key: 'audit', label: '操作日志与导出' },
];

export async function renderAdmin(root, route) {
  const q = route.query || {};
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'maintenance';
  root.innerHTML = `
    <div class="tabs">${TABS.map((t) => `<a class="tab ${t.key === tab ? 'active' : ''}" href="#/admin?tab=${t.key}">${esc(t.label)}</a>`).join('')}</div>
    <div id="tab-body">${loading()}</div>`;
  const body = document.getElementById('tab-body');
  let cleanup = null;
  try {
    if (tab === 'maintenance') await renderMaintenance(body, q);
    else if (tab === 'governance') cleanup = await renderGovernance(body, q);
    else if (tab === 'status') await renderStatus(body);
    else if (tab === 'datasources') await renderDatasources(body);
    else if (tab === 'cea') await renderCeaAdmin(body, q);
    else if (tab === 'ocr') await renderOcrAdmin(body);
    else if (tab === 'accounting') await renderAccountingAdmin(body, q);
    else if (tab === 'connectors') await renderConnectors(body);
    else if (tab === 'intelligence') await renderIntelligence(body, q);
    else if (tab === 'llm') await renderLlm(body);
    else if (tab === 'deepseek') await renderDeepSeek(body);
    else if (tab === 'verify') await renderVerify(body);
    else if (tab === 'users') await renderUsers(body);
    else if (tab === 'reconciliation') await renderReconciliation(body, q);
    else if (tab === 'jobs') await renderJobs(body);
    else await renderAudit(body);
  } catch (e) {
    body.innerHTML = errorState(e);
  }
  return cleanup;
}

/* ------------------------------ 采集连接 ------------------------------ */

async function renderConnectors(body) {
  const [sp, fc, cs, dsp] = await Promise.all([
    api('/api/v2/admin/search-providers'),
    api('/api/v2/admin/fetch-connections'),
    api('/api/v2/content/stats'),
    api('/api/v2/admin/deepseek').catch(() => ({ providers: [] })),
  ]);
  const providers = dsp.providers || [];
  const st = cs.seed_sources || {};
  body.innerHTML = `
  <div class="callout ${sp.status?.available && fc.status?.available ? 'callout-ok' : 'callout-warn'}">
    <b>自动采集链路：${sp.status?.available ? '搜索 API 可用' : '搜索 API 未配置'} ｜ ${fc.status?.available ? '网页抓取可用' : '网页抓取未配置'}</b>
    <p>${esc(sp.status?.note || '')} ${esc(fc.status?.note || '')}</p>
    <p class="hint">未配置时界面如实显示不可用，采集接口不会用空结果假装成功。
    官方政策 / 公开项目 / 交易行情三条官方连接独立于此，不受模型与搜索 API 是否配置影响。</p>
  </div>

  ${card({
    title: '搜索服务（默认推荐：博查 Web Search）',
    subtitle: '用于按关键词组合发现公开研报与行业动态；请求与响应字段按供应商当前官方文档预设',
    actions: `<button class="btn btn-sm btn-primary" data-sp-preset="bocha">填入博查默认配置</button>
              <button class="btn btn-sm" data-sp-preset="deepseek_search">填入 DeepSeek Search 备用</button>
              <button class="btn btn-sm" data-sp-new>新增搜索服务</button>`,
    body: table({
      rows: sp.providers || [],
      pageSize: 10,
      columns: [
        { key: 'name', label: '名称', render: (r) => `<a class="link" data-sp="${esc(r.id)}">${esc(r.name)}</a>` },
        { key: 'kind_label', label: '类型' },
        { key: 'base_url', label: '服务地址', render: (r) => `<span class="muted">${esc(`${r.base_url}${r.search_path || ''}`)}</span>` },
        { key: 'provider_name', label: '凭据引用', render: (r) => r.provider_name ? `<span>${esc(r.provider_name)}</span><div class="muted">${esc(r.provider_model || '')}${r.is_fallback ? '｜备用' : '｜主服务'}</div>` : esc(r.credential_ref || '—') },
        { key: 'credential_configured', label: '凭据', render: (r) => (r.credential_configured ? chip('已配置', 'ok') : chip('未配置', 'warn')) },
        { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('已启用', 'ok') : chip('未启用', '')) },
        { key: 'quota', label: '今日用量', align: 'right', render: (r) => `${num(r.calls_today)} / ${num(r.daily_quota)}` },
        { key: 'last_test_result', label: '最近测试', render: (r) => (r.last_test_result ? chip(r.last_test_result === 'ok' || r.last_test_result === 'ok_empty' ? (r.last_test_result === 'ok_empty' ? '可调用（空结果）' : '可调用') : r.last_test_result === 'configured_only' ? '仅已配置' : '不可调用', r.last_test_result === 'ok' || r.last_test_result === 'ok_empty' ? 'ok' : r.last_test_result === 'configured_only' ? 'warn' : 'danger') : '—') },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-sptest="${esc(r.id)}">真实连接测试</button>
            <button class="btn btn-xs" data-sptoggle="${esc(r.id)}" data-on="${r.enabled ? '0' : '1'}">${r.enabled ? '停用' : '启用'}</button>` },
      ],
      emptyText: '未配置搜索服务',
      emptyDetail: '未配置时「研报与行业动态」不会有新内容，采集接口会返回明确的未配置原因。',
      emptyHint: '点击「填入博查默认配置」填入公开参数，用户只需在服务端配置 BOCHA_API_KEY。',
    }),
    note: '调用限额按日计数；凭据只存服务端（环境变量引用名或 AES-256-GCM 加密），任何接口都不返回凭据明文。博查返回的 summary/snippet 只是摘要，正文由抓取连接获取。',
  })}

  ${card({
    title: '网页抓取连接（默认推荐：Firecrawl v2 MCP）',
    subtitle: '用于抓取公开全文并归档；MCP 只调用白名单内的只读工具',
    actions: `<button class="btn btn-sm btn-primary" data-fc-preset="mcp_http">填入 Firecrawl MCP 默认配置</button>
              <button class="btn btn-sm" data-fc-preset="deepseek_fetch">填入 DeepSeek Fetch 备用</button>
              <button class="btn btn-sm" data-fc-new>新增抓取连接</button>`,
    body: table({
      rows: fc.connections || [],
      pageSize: 10,
      columns: [
        { key: 'name', label: '名称', render: (r) => `<a class="link" data-fc="${esc(r.id)}">${esc(r.name)}</a>` },
        { key: 'kind_label', label: '类型' },
        { key: 'base_url', label: '服务地址', render: (r) => `<span class="muted">${esc(`${r.base_url}${r.endpoint_path || ''}`)}</span>` },
        { key: 'provider_name', label: '凭据引用', render: (r) => r.provider_name ? `<span>${esc(r.provider_name)}</span><div class="muted">${esc(r.provider_model || '')}${r.is_fallback ? '｜备用' : '｜主连接'}</div>` : esc(r.credential_ref || '—') },
        { key: 'credential_configured', label: '凭据', render: (r) => (r.credential_configured ? chip('已配置', 'ok') : r.keyless_trial ? chip('未配置（官方 keyless 限额试用）', 'warn') : chip('未配置', 'warn')) },
        { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('已启用', 'ok') : chip('未启用', '')) },
        { key: 'quota', label: '今日用量', align: 'right', render: (r) => `${num(r.calls_today)} / ${num(r.daily_quota)}` },
        { key: 'last_test_result', label: '最近测试', render: (r) => (r.last_test_result ? chip(
          r.last_test_result === 'ok' ? '连接+工具+抓取可用'
            : r.last_test_result === 'tools_ok_scrape_failed' ? '连接/工具可用·抓取未授权'
              : r.last_test_result === 'configured_only' ? '仅已配置' : '不可调用',
          r.last_test_result === 'ok' ? 'ok' : r.last_test_result === 'tools_ok_scrape_failed' ? 'warn' : r.last_test_result === 'configured_only' ? 'warn' : 'danger'
        ) : '—') },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-fctest="${esc(r.id)}">真实连接测试</button>
            <button class="btn btn-xs" data-fctoggle="${esc(r.id)}" data-on="${r.enabled ? '0' : '1'}">${r.enabled ? '停用' : '启用'}</button>` },
      ],
      emptyText: '未配置网页抓取连接',
      emptyDetail: '未配置时只能归档搜索摘要，无法获取公开全文，核验会标记为「证据不足」。',
      emptyHint: '点击「填入 Firecrawl MCP 默认配置」填入官方地址与只读工具；生产需配置 FIRECRAWL_API_KEY。',
    }),
    note: 'MCP 连接先做 initialize + tools/list 握手并读取工具 inputSchema，据返回的工具清单填写只读白名单；未在白名单内的工具一律拒绝调用。测试结果区分「连接及工具可用」与「抓取授权/实际调用成功」：官方固定地址允许无密钥限额试用，但抓取可能被拒，此时如实显示需要 API Key，不伪造成功、也不反复重试。',
  })}

  <div class="grid-2">
    ${card({
      title: '关键词与来源计划',
      subtitle: '每日按关键词组合 × 来源类别检索，不只用单一关键词',
      body: `<ul class="list">${(cs.keyword_groups || []).map((g) => `<li><b>${esc(g.label)}</b>：${esc(g.terms.join('、'))}</li>`).join('')}</ul>
        <p class="hint">来源类别：${(cs.source_categories || []).map((c) => esc(c.label)).join('、')}</p>`,
    })}
    ${card({
      title: '种子来源可用性（实测）',
      subtitle: '官网可用性逐一验证后才作为种子来源',
      actions: `<button class="btn btn-sm" id="probe-sources">重新实测全部种子来源</button>`,
      body: `${kv([
        ['种子来源总数', `${num(st.total)} 个（已启用 ${num(st.enabled)} 个）`],
        ['最近实测', esc(st.probed_at ? dateTime(st.probed_at) : '尚未实测')],
        ['实测可用', esc(st.available === null || st.available === undefined ? '—' : `${num(st.available)} 个`)],
        ['结论', esc(st.note || '未实测')],
      ])}
      <div id="probe-result"></div>
      <p class="hint">实测通过 HTTP 真实请求完成；不可用或未验证的来源不会被自动采集。</p>`,
    })}
  </div>`;

  bindConnectorEvents(body, sp, fc);
}

function bindConnectorEvents(body, sp, fc) {
  body.querySelectorAll('[data-sp]').forEach((el) => el.addEventListener('click', () => {
    const p = (sp.providers || []).find((x) => x.id === el.dataset.sp);
    if (p) openSearchForm(p, sp.presets, null, providers);
  }));
  body.querySelector('[data-sp-new]')?.addEventListener('click', () => openSearchForm(null, sp.presets, null, providers));
  // 一键填入公开预设参数（不含任何凭据；凭据由用户在服务端配置）
  body.querySelector('[data-sp-preset]')?.addEventListener('click', () => {
    const kind = body.querySelector('[data-sp-preset]').dataset.spPreset || 'bocha';
    openSearchForm(null, sp.presets, kind, providers);
  });
  body.querySelector('[data-fc-preset]')?.addEventListener('click', () => {
    const kind = body.querySelector('[data-fc-preset]').dataset.fcPreset || 'mcp_http';
    openFetchForm(null, fc.presets, kind, providers);
  });
  body.querySelectorAll('[data-sptest]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true;
    el.textContent = '测试中…';
    try {
      const out = await api(`/api/v2/admin/search-providers/${el.dataset.sptest}/test`, { method: 'POST' });
      toast(out.message, out.ok ? 'ok' : 'warn');
      if (out.sample?.length) toast(`样例：${out.sample.map((s) => s.title || s.url).slice(0, 2).join('｜')}`, 'info');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.body?.message || e.message, 'danger');
      el.disabled = false;
      el.textContent = '真实连接测试';
    }
  }));
  body.querySelectorAll('[data-sptoggle]').forEach((el) => el.addEventListener('click', async () => {
    try {
      await api(`/api/v2/admin/search-providers/${el.dataset.sptoggle}/pause`, { method: 'POST', body: { enabled: el.dataset.on === '1' } });
      toast('已更新启用状态', 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
    }
  }));

  body.querySelectorAll('[data-fc]').forEach((el) => el.addEventListener('click', () => {
    const c = (fc.connections || []).find((x) => x.id === el.dataset.fc);
    if (c) openFetchForm(c, fc.presets, null, providers);
  }));
  body.querySelector('[data-fc-new]')?.addEventListener('click', () => openFetchForm(null, fc.presets, null, providers));
  body.querySelectorAll('[data-fctest]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true;
    el.textContent = '测试中…';
    try {
      const out = await api(`/api/v2/admin/fetch-connections/${el.dataset.fctest}/test`, { method: 'POST' });
      toast(out.message, out.ok ? 'ok' : 'warn');
      if (out.tools?.length) {
        toast(`发现 ${out.tools.length} 个工具，只读 ${out.read_only_tools?.length ?? 0} 个`, 'info');
      }
      if (out.scrape_authorized === false) {
        toast('抓取未获授权：请配置 FIRECRAWL_API_KEY（不会反复无密钥重试）', 'warn');
      }
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.body?.message || e.message, 'danger');
      el.disabled = false;
      el.textContent = '真实连接测试';
    }
  }));
  body.querySelectorAll('[data-fctoggle]').forEach((el) => el.addEventListener('click', async () => {
    try {
      await api(`/api/v2/admin/fetch-connections/${el.dataset.fctoggle}/pause`, { method: 'POST', body: { enabled: el.dataset.on === '1' } });
      toast('已更新启用状态', 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
    }
  }));
  body.querySelector('#probe-sources')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = '实测中…';
    const out = document.getElementById('probe-result');
    out.innerHTML = loading('正在逐个实测种子来源官网…');
    try {
      const r = await api('/api/v2/content/probe-sources', { method: 'POST' });
      out.innerHTML = `<div class="table-wrap"><table class="grid grid-sm">
        <thead><tr><th>来源</th><th>类别</th><th>结果</th><th class="ta-r">字符</th><th class="ta-r">耗时</th></tr></thead>
        <tbody>${r.results.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.source_category)}</td>
          <td>${x.ok ? chip('可用', 'ok') : chip(esc(x.status), 'warn')}</td>
          <td class="ta-r">${num(x.chars)}</td><td class="ta-r">${num(x.latency_ms)} ms</td></tr>`).join('')}</tbody>
      </table></div><p class="hint">实测时间 ${esc(dateTime(r.probed_at))}；可用 ${num(r.available)}/${num(r.total)}。仅可用来源参与自动采集。</p>`;
      toast(`实测完成：${r.available}/${r.total} 可用`, r.available ? 'ok' : 'warn');
    } catch (e) {
      out.innerHTML = errorState(e);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新实测全部种子来源';
    }
  });
}

const AUTH_LABEL = { bearer: 'Bearer 令牌', header: '自定义请求头', query: '查询参数', none: '无需鉴权' };

/** 预设说明（公开参数与注意事项；不含任何凭据） */
function presetNoteHtml(preset) {
  if (!preset || !preset.label) return '';
  return `<h5>预设说明：${esc(preset.label)}</h5>
    <p class="hint">服务地址 <code>${esc(preset.base_url || '')}${esc(preset.search_path || preset.endpoint_path || '')}</code>
    ｜凭据引用 <code>${esc(preset.credential_ref || '（无需凭据）')}</code>
    ｜出站白名单 <code>${esc((preset.allowed_domains || []).join(', ') || '（需自行填写）')}</code></p>
    ${preset.notes ? `<p class="hint">${esc(preset.notes)}</p>` : ''}
    <p class="hint">填好后请点「真实连接测试」区分「已配置」与「可调用」；未配置凭据时如实显示不可用，不会假装成功。</p>`;
}

function openSearchForm(p, presets, presetKind = null, providers = []) {
  const isNew = !p;
  const kinds = Object.entries(presets || {}).map(([k, v]) => ({ key: k, ...v }));
  const initialKind = p?.provider_kind || presetKind || kinds.find((k) => k.recommended)?.key || kinds[0]?.key;
  const preset0 = kinds.find((k) => k.key === initialKind) || {};
  const official = (providers || []).filter((x) => x.official && x.enabled);
  // 新建时用预设的**公开参数**预填（不含任何凭据）；编辑时用库里的现值
  const s = p || {
    provider_kind: initialKind,
    name: preset0.label || '',
    base_url: preset0.base_url || '',
    search_path: preset0.search_path || '/search',
    auth_kind: preset0.auth_kind || 'bearer',
    credential_ref: preset0.credential_ref || '',
    allowed_domains: preset0.allowed_domains || [],
    timeout_ms: 25000,
    retry_max: 2,
    daily_quota: 1000,
    provider_id: '',
    is_fallback: !!preset0.fallback,
    fallback_priority: 100,
    enabled: true,
  };
  document.body.insertAdjacentHTML('beforeend', drawer(isNew ? '新增搜索服务' : `编辑搜索服务：${p.name}`, `
    <form id="sp-form" class="form-grid">
      <input type="hidden" name="id" value="${esc(p?.id || '')}">
      <label class="fld"><span>引用现有官方模型凭据（可选）</span><select name="provider_id">
        <option value="">不使用模型引用（沿用本连接自己的凭据）</option>
        ${official.map((x) => `<option value="${esc(x.id)}" ${s.provider_id === x.id ? 'selected' : ''}>${esc(x.name)} · ${esc(x.model)}${x.credential_configured ? '' : '（凭据未配置）'}</option>`).join('')}
      </select><small>DeepSeek Search 必须引用官方模型；引用后不要再填写 Key，模型 Key 轮换会自动生效。</small></label>
      <label class="fld"><input name="is_fallback" type="checkbox" ${s.is_fallback ? 'checked' : ''}> 作为备用通道（主服务失败/无结果时才尝试）</label>
      <label class="fld"><span>备用顺序（0 优先）</span><input name="fallback_priority" type="number" min="0" max="1000" value="${esc(s.fallback_priority ?? 100)}"></label>
      <label class="fld"><span>供应商类型</span><select name="provider_kind" id="sp-kind">
        ${kinds.map((k) => `<option value="${esc(k.key)}" ${s.provider_kind === k.key ? 'selected' : ''}>${esc(k.label)}${k.recommended ? '（推荐）' : ''}</option>`).join('')}
      </select></label>
      <label class="fld"><span>配置名称</span><input name="name" required value="${esc(s.name || '')}" placeholder="例如 博查 Web Search"></label>
      <label class="fld"><span>服务地址</span><input name="base_url" type="url" required value="${esc(s.base_url || '')}" placeholder="https://api.bocha.cn"></label>
      <label class="fld"><span>请求路径</span><input name="search_path" required value="${esc(s.search_path || '/search')}" placeholder="/v1/web-search"></label>
      <label class="fld"><span>鉴权方式</span><select name="auth_kind">
        ${Object.entries(AUTH_LABEL).map(([k, v]) => `<option value="${k}" ${s.auth_kind === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select></label>
      <label class="fld"><span>鉴权字段名（header/query 时用）</span><input name="auth_header" value="${esc(s.auth_header || '')}" placeholder="x-api-key"></label>
      <label class="fld"><span>环境变量名（选填，不是 API 密钥）</span><input name="credential_ref" value="${esc(s.credential_ref || '')}" placeholder="BOCHA_API_KEY" pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"><small>直接在下方填写 API 密钥即可；此项供服务器环境变量配置使用。</small></label>
      <label class="fld"><span>API 密钥（在此填写实际密钥）</span><input name="secret" type="password" autocomplete="new-password"
        placeholder="${p?.credential_stored_encrypted ? '已加密存储，留空表示不修改' : '留空则只使用环境变量引用名'}"></label>
      <label class="fld"><span>出站域名白名单（逗号分隔）</span><input name="allowed_domains" required value="${esc((s.allowed_domains || []).join(', '))}" placeholder="api.bocha.cn"></label>
      <label class="fld"><span>超时（毫秒）</span><input name="timeout_ms" type="number" min="1000" max="120000" value="${esc(s.timeout_ms || 25000)}"></label>
      <label class="fld"><span>重试次数</span><input name="retry_max" type="number" min="0" max="5" value="${esc(s.retry_max ?? 2)}"></label>
      <label class="fld"><span>每日调用限额</span><input name="daily_quota" type="number" min="1" value="${esc(s.daily_quota || 1000)}"></label>
      <label class="fld"><input name="enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用</label>
      <div class="drawer-actions"><button class="btn btn-primary" type="submit">保存</button>
        <button class="btn" type="button" data-close-drawer>取消</button></div>
    </form>
    <div id="sp-preset-note">${presetNoteHtml(preset0)}</div>
    ${(p?.param_map || p?.response_map) ? `<h5>当前字段映射</h5>
      <p class="hint">请求映射：<code>${esc(JSON.stringify(p.param_map || {}))}</code></p>
      <p class="hint">响应映射：<code>${esc(JSON.stringify(p.response_map || {}))}</code></p>` : ''}
    ${p?.last_test_message ? `<p class="hint">最近测试：${esc(p.last_test_message)}</p>` : ''}
  `, { wide: true }));

  // 切换供应商类型时，用该预设的公开参数刷新表单（不触碰凭据字段）
  document.getElementById('sp-kind')?.addEventListener('change', (e) => {
    const k = kinds.find((x) => x.key === e.target.value);
    if (!k) return;
    const form = document.getElementById('sp-form');
    form.elements.base_url.value = k.base_url || '';
    form.elements.search_path.value = k.search_path || '/search';
    form.elements.auth_kind.value = k.auth_kind || 'bearer';
    form.elements.credential_ref.value = k.credential_ref || '';
    form.elements.allowed_domains.value = (k.allowed_domains || []).join(', ');
    if (isNew) {
      form.elements.is_fallback.checked = !!k.fallback;
      if (k.fallback) form.elements.fallback_priority.value = 100;
      if (k.provider_required) {
        const first = official[0];
        if (first) form.elements.provider_id.value = first.id;
      }
    }
    if (isNew && !form.elements.name.value.trim()) form.elements.name.value = k.label || '';
    const note = document.getElementById('sp-preset-note');
    if (note) note.innerHTML = presetNoteHtml(k);
  });

  const form = document.getElementById('sp-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const payload = {
      id: f.get('id') || undefined,
      provider_kind: f.get('provider_kind'),
      name: f.get('name'),
      base_url: f.get('base_url'),
      search_path: f.get('search_path'),
      auth_kind: f.get('auth_kind'),
      auth_header: f.get('auth_header') || null,
      provider_id: f.get('provider_id') || null,
      is_fallback: f.has('is_fallback'),
      fallback_priority: Number(f.get('fallback_priority')),
      credential_ref: f.get('credential_ref') || null,
      allowed_domains: String(f.get('allowed_domains') || '').split(/[,，;；\s]+/).filter(Boolean),
      timeout_ms: Number(f.get('timeout_ms')),
      retry_max: Number(f.get('retry_max')),
      daily_quota: Number(f.get('daily_quota')),
      enabled: f.has('enabled'),
    };
    if (f.get('secret')) payload.secret = f.get('secret');
    try {
      await api('/api/v2/admin/search-providers', { method: 'POST', body: payload });
      toast('搜索服务已保存', 'ok');
      document.querySelector('.drawer-backdrop')?.remove();
      document.querySelector('.drawer')?.remove();
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.message || err.body?.error || err.message, 'danger');
    }
  });
  document.querySelectorAll('[data-close-drawer]').forEach((el) => el.addEventListener('click', () => {
    document.querySelector('.drawer-backdrop')?.remove();
    document.querySelector('.drawer')?.remove();
  }));
}

function openFetchForm(c, presets, presetKind = null, providers = []) {
  const isNew = !c;
  const kinds = Object.entries(presets || {}).map(([k, v]) => ({ key: k, ...v }));
  const initialKind = c?.conn_kind || presetKind || kinds.find((k) => k.recommended)?.key || kinds[0]?.key;
  const preset0 = kinds.find((k) => k.key === initialKind) || {};
  const official = (providers || []).filter((x) => x.official && x.enabled);
  const s = c || {
    conn_kind: initialKind,
    name: preset0.label || '',
    base_url: preset0.base_url || '',
    endpoint_path: preset0.endpoint_path || '/mcp',
    auth_kind: preset0.auth_kind || 'bearer',
    credential_ref: preset0.credential_ref || '',
    mcp_tool_name: preset0.mcp_tool_name || '',
    mcp_allowed_tools: preset0.mcp_allowed_tools || [],
    allowed_domains: preset0.allowed_domains || [],
    timeout_ms: 30000,
    retry_max: 2,
    daily_quota: 500,
    provider_id: '',
    is_fallback: !!preset0.fallback,
    fallback_priority: 100,
    enabled: true,
  };
  document.body.insertAdjacentHTML('beforeend', drawer(isNew ? '新增抓取连接' : `编辑抓取连接：${c.name}`, `
    <form id="fc-form" class="form-grid">
      <input type="hidden" name="id" value="${esc(c?.id || '')}">
      <label class="fld"><span>引用现有官方模型凭据（可选）</span><select name="provider_id">
        <option value="">不使用模型引用（沿用本连接自己的凭据）</option>
        ${official.map((x) => `<option value="${esc(x.id)}" ${s.provider_id === x.id ? 'selected' : ''}>${esc(x.name)} · ${esc(x.model)}${x.credential_configured ? '' : '（凭据未配置）'}</option>`).join('')}
      </select><small>DeepSeek Fetch 必须引用官方模型；引用后不要再填写 Key，模型 Key 轮换会自动生效。</small></label>
      <label class="fld"><input name="is_fallback" type="checkbox" ${s.is_fallback ? 'checked' : ''}> 作为备用通道（主连接失败/缺正文时才尝试）</label>
      <label class="fld"><span>备用顺序（0 优先）</span><input name="fallback_priority" type="number" min="0" max="1000" value="${esc(s.fallback_priority ?? 100)}"></label>
      <label class="fld"><span>连接类型</span><select name="conn_kind" id="fc-kind">
        ${kinds.map((k) => `<option value="${esc(k.key)}" ${s.conn_kind === k.key ? 'selected' : ''}>${esc(k.label)}${k.recommended ? '（推荐）' : ''}</option>`).join('')}
      </select></label>
      <label class="fld"><span>配置名称</span><input name="name" required value="${esc(s.name || '')}" placeholder="例如 Firecrawl v2 MCP"></label>
      <label class="fld"><span>服务地址</span><input name="base_url" type="url" required value="${esc(s.base_url || '')}" placeholder="https://mcp.firecrawl.dev"></label>
      <label class="fld"><span>端点路径</span><input name="endpoint_path" required value="${esc(s.endpoint_path || '/mcp')}" placeholder="/v2/mcp 或 /v1/scrape"></label>
      <label class="fld"><span>鉴权方式</span><select name="auth_kind">
        ${Object.entries(AUTH_LABEL).map(([k, v]) => `<option value="${k}" ${s.auth_kind === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select></label>
      <label class="fld"><span>鉴权字段名</span><input name="auth_header" value="${esc(s.auth_header || '')}" placeholder="x-api-key"></label>
      <label class="fld"><span>环境变量名（选填，不是 API 密钥）</span><input name="credential_ref" value="${esc(s.credential_ref || '')}" placeholder="FIRECRAWL_API_KEY" pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"><small>实际 API 密钥请填入密钥栏。</small></label>
      <label class="fld"><span>密钥（可选）</span><input name="secret" type="password" autocomplete="new-password"
        placeholder="${c?.credential_stored_encrypted ? '已加密存储，留空表示不修改' : '留空则只用环境变量引用名'}"></label>
      <label class="fld"><span>MCP 抓取工具名</span><input name="mcp_tool_name" value="${esc(s.mcp_tool_name || '')}" placeholder="仅 MCP 连接需要，如 firecrawl_scrape"></label>
      <label class="fld"><span>MCP 只读工具白名单（逗号分隔）</span><input name="mcp_allowed_tools" value="${esc((s.mcp_allowed_tools || []).join(', '))}" placeholder="firecrawl_scrape"></label>
      <label class="fld"><span>出站域名白名单</span><input name="allowed_domains" required value="${esc((s.allowed_domains || []).join(', '))}" placeholder="mcp.firecrawl.dev"></label>
      <label class="fld"><span>超时（毫秒）</span><input name="timeout_ms" type="number" min="1000" max="120000" value="${esc(s.timeout_ms || 30000)}"></label>
      <label class="fld"><span>重试次数</span><input name="retry_max" type="number" min="0" max="5" value="${esc(s.retry_max ?? 2)}"></label>
      <label class="fld"><span>每日限额</span><input name="daily_quota" type="number" min="1" value="${esc(s.daily_quota || 500)}"></label>
      <label class="fld"><input name="enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用</label>
      <div class="drawer-actions"><button class="btn btn-primary" type="submit">保存</button>
        <button class="btn" type="button" data-close-drawer>取消</button></div>
    </form>
    <div id="fc-preset-note">${presetNoteHtml(preset0)}</div>
    ${(c?.discovered_tools || []).length ? `<h5>最近握手发现的工具（${c.discovered_tools.length}）</h5>
      <ul class="list">${c.discovered_tools.map((t) => `<li>${esc(t.name)} ${t.read_only_hint === false ? chip('可能非只读', 'warn') : chip('只读', 'ok')}</li>`).join('')}</ul>
      <p class="hint">把要调用的抓取工具填入上方白名单；未在白名单内的工具会被拒绝调用。</p>` : ''}
    ${(c?.tool_schemas || []).length ? `<h5>已缓存的工具 inputSchema</h5>
      <p class="hint">抓取时会按 inputSchema 映射参数（如 <code>url</code> 与 <code>formats</code>）：<code>${esc(JSON.stringify(c.tool_schemas.map((t) => ({ name: t.name, props: Object.keys(t.input_schema?.properties || {}) }))))}</code></p>` : ''}
    ${c?.last_test_message ? `<p class="hint">最近测试：${esc(c.last_test_message)}</p>` : ''}
  `, { wide: true }));

  document.getElementById('fc-kind')?.addEventListener('change', (e) => {
    const k = kinds.find((x) => x.key === e.target.value);
    if (!k) return;
    const form = document.getElementById('fc-form');
    form.elements.base_url.value = k.base_url || '';
    form.elements.endpoint_path.value = k.endpoint_path || '';
    form.elements.auth_kind.value = k.auth_kind || 'bearer';
    form.elements.credential_ref.value = k.credential_ref || '';
    form.elements.mcp_tool_name.value = k.mcp_tool_name || '';
    form.elements.mcp_allowed_tools.value = (k.mcp_allowed_tools || []).join(', ');
    form.elements.allowed_domains.value = (k.allowed_domains || []).join(', ');
    if (isNew) {
      form.elements.is_fallback.checked = !!k.fallback;
      if (k.fallback) form.elements.fallback_priority.value = 100;
      if (k.provider_required) {
        const first = official[0];
        if (first) form.elements.provider_id.value = first.id;
      }
    }
    if (isNew && !form.elements.name.value.trim()) form.elements.name.value = k.label || '';
    const note = document.getElementById('fc-preset-note');
    if (note) note.innerHTML = presetNoteHtml(k);
  });

  const form = document.getElementById('fc-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const payload = {
      id: f.get('id') || undefined,
      conn_kind: f.get('conn_kind'),
      name: f.get('name'),
      base_url: f.get('base_url'),
      endpoint_path: f.get('endpoint_path'),
      auth_kind: f.get('auth_kind'),
      auth_header: f.get('auth_header') || null,
      provider_id: f.get('provider_id') || null,
      is_fallback: f.has('is_fallback'),
      fallback_priority: Number(f.get('fallback_priority')),
      credential_ref: f.get('credential_ref') || null,
      mcp_tool_name: f.get('mcp_tool_name') || null,
      mcp_allowed_tools: String(f.get('mcp_allowed_tools') || '').split(/[,，;；\s]+/).filter(Boolean),
      allowed_domains: String(f.get('allowed_domains') || '').split(/[,，;；\s]+/).filter(Boolean),
      timeout_ms: Number(f.get('timeout_ms')),
      retry_max: Number(f.get('retry_max')),
      daily_quota: Number(f.get('daily_quota')),
      enabled: f.has('enabled'),
    };
    if (f.get('secret')) payload.secret = f.get('secret');
    try {
      await api('/api/v2/admin/fetch-connections', { method: 'POST', body: payload });
      toast('抓取连接已保存', 'ok');
      document.querySelector('.drawer-backdrop')?.remove();
      document.querySelector('.drawer')?.remove();
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.message || err.body?.error || err.message, 'danger');
    }
  });
  document.querySelectorAll('[data-close-drawer]').forEach((el) => el.addEventListener('click', () => {
    document.querySelector('.drawer-backdrop')?.remove();
    document.querySelector('.drawer')?.remove();
  }));
}

/* ------------------------------ 自动核验策略 ------------------------------ */

async function renderVerify(body) {
  const [d, llm] = await Promise.all([
    api('/api/v2/admin/verify-config'),
    api('/api/v2/admin/llm').catch(() => ({ providers: [] })),
  ]);
  const cfg = d.config || {};
  const stats = d.stats || {};
  const providers = llm.providers || [];
  body.innerHTML = `
  <div class="callout ${stats.model_available ? 'callout-ok' : 'callout-warn'}">
    <b>自动核验：${stats.model_available ? '模型可用' : '模型不可用（条目将标记为「暂未自动核验」）'}</b>
    <p>${esc(stats.note || '')}</p>
    ${stats.provider ? `<p class="hint">当前模型：${esc(stats.provider.name)} · ${esc(stats.provider.model)}
       ｜凭据：${stats.provider.credential_configured ? chip('已配置', 'ok') : chip('未配置', 'warn')}
       ｜今日调用：${num(stats.provider.calls_today)} / ${num(stats.provider.max_calls_per_day)}</p>` : ''}
  </div>

  <div class="metrics metrics-sm">
    ${mini('核验记录总数', stats.total, '条', `最近核验 ${stats.last_verification_at ? dateTime(stats.last_verification_at) : '—'}`)}
    ${mini('自动核验通过', stats.by_result?.verified, '条', '证据一致性通过，不代表独立审计')}
    ${mini('证据不足', stats.by_result?.insufficient, '条', '仅有摘要、正文过短或缺第二来源')}
    ${mini('来源冲突', stats.by_result?.conflict, '条', '冲突不覆盖官方数值')}
    ${mini('暂未自动核验', stats.by_result?.unavailable, '条', '模型或正文不可用')}
  </div>

  <div class="grid-2">
    ${card({
      title: '核验策略参数',
      subtitle: '自动运行参数，不是人工审批开关',
      body: `<form id="verify-form" class="form-grid">
        <label class="fld"><input name="enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> 启用自动核验（每日任务自动执行）</label>
        <label class="fld"><span>核验模型</span><select name="provider_id"><option value="">自动选择（优先「内容核验」用途）</option>
          ${providers.map((p) => `<option value="${esc(p.id)}" ${cfg.provider_id === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.model)}</option>`).join('')}</select></label>
        <label class="fld"><span>单次最多核验条数</span><input name="max_per_run" type="number" min="1" max="200" value="${esc(cfg.max_per_run)}"></label>
        <label class="fld"><span>送入模型的正文上限（字符）</span><input name="max_body_chars" type="number" min="500" max="200000" value="${esc(cfg.max_body_chars)}"></label>
        <label class="fld"><span>正文最短长度（低于判证据不足）</span><input name="min_body_chars" type="number" min="1" max="100000" value="${esc(cfg.min_body_chars)}"></label>
        <label class="fld"><span>数值一致性容差（0—1）</span><input name="numeric_tolerance" type="number" step="0.01" min="0" max="1" value="${esc(cfg.numeric_tolerance)}"></label>
        <label class="fld"><input name="require_full_text" type="checkbox" ${cfg.require_full_text ? 'checked' : ''}> 要求公开全文（仅摘要直接判证据不足）</label>
        <label class="fld"><input name="require_second_source" type="checkbox" ${cfg.require_second_source ? 'checked' : ''}> 要求可核对的第二来源</label>
        <label class="fld"><input name="injection_guard" type="checkbox" ${cfg.injection_guard ? 'checked' : ''}> 提示注入防护（命中即判来源冲突）</label>
        <div class="drawer-actions"><button class="btn btn-primary" type="submit">保存策略</button>
          <button class="btn" type="button" id="verify-run">立即核验未核验条目</button></div>
      </form>
      <div id="verify-result"></div>
      <p class="hint">模型不可用、配额耗尽、JSON 非法、提示注入都有确定性处理；
      核验失败不阻断全站展示，公开原始记录照常可见。</p>`,
    })}
    ${card({
      title: '四态口径',
      subtitle: '不得一律盖「真实可靠」章',
      body: `<ul class="list">${(d.states || []).map((s) => `<li>
        <div class="list-head">${verifyChip(s.result)}<span class="muted right">${esc(s.ui_state)}</span></div>
        <p>${esc(s.definition)}</p><p class="hint">${esc(s.disclaimer)}</p></li>`).join('')}</ul>`,
    })}
  </div>

  ${card({
    title: '核验规则（自动一致性检查，覆盖内容/政策/方法学/公开项目）',
    subtitle: '内置规则不可删除，可停用或调整强度；四态结论对各类公开信息统一适用',
    body: table({
      rows: d.rules || [],
      pageSize: 20,
      columns: [
        { key: 'scope', label: '对象', render: (r) => chip({ content: '研报与动态', policy: '政策', methodology: '方法学', project: '公开项目' }[r.scope] || r.scope, '') },
        { key: 'label', label: '规则' },
        { key: 'rule_key', label: '标识', render: (r) => `<code>${esc(r.rule_key)}</code>` },
        { key: 'rule_type', label: '类型' },
        { key: 'description', label: '说明' },
        { key: 'severity', label: '强度', render: (r) => chip(r.severity === 'fail' ? '判定失败' : '仅提示', r.severity === 'fail' ? 'danger' : 'warn') },
        { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('已启用', 'ok') : chip('已停用', '')) },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-rule="${esc(r.id)}" data-on="${r.enabled ? '0' : '1'}">${r.enabled ? '停用' : '启用'}</button>` },
      ],
    }),
    note: '规则检查先于模型调用；命中提示注入直接判「来源冲突」，不把外部文本当指令。',
  })}`;

  const form = body.querySelector('#verify-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      await api('/api/v2/admin/verify-config', {
        method: 'POST',
        body: {
          enabled: f.has('enabled'),
          provider_id: f.get('provider_id') || null,
          max_per_run: Number(f.get('max_per_run')),
          max_body_chars: Number(f.get('max_body_chars')),
          min_body_chars: Number(f.get('min_body_chars')),
          numeric_tolerance: Number(f.get('numeric_tolerance')),
          require_full_text: f.has('require_full_text'),
          require_second_source: f.has('require_second_source'),
          injection_guard: f.has('injection_guard'),
        },
      });
      toast('自动核验策略已保存', 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.message || err.body?.error || err.message, 'danger');
    }
  });
  body.querySelector('#verify-run')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = '核验中…';
    const out = document.getElementById('verify-result');
    out.innerHTML = loading('正在按策略核验未核验条目…');
    try {
      const r = await api('/api/v2/admin/verify/run', { method: 'POST', body: { limit: 30 } });
      out.innerHTML = `<p>处理 ${num(r.total)} 条：自动核验通过 ${num(r.verified)}｜证据不足 ${num(r.insufficient)}｜来源冲突 ${num(r.conflict)}｜暂未自动核验 ${num(r.unavailable)}｜命中缓存 ${num(r.cached)}。</p>`;
      toast('自动核验完成', 'ok');
    } catch (e) {
      out.innerHTML = errorState(e);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即核验未核验条目';
    }
  });
  body.querySelectorAll('[data-rule]').forEach((el) => el.addEventListener('click', async () => {
    try {
      await api(`/api/v2/admin/verify-rules/${el.dataset.rule}`, { method: 'POST', body: { enabled: el.dataset.on === '1' } });
      toast('规则状态已更新', 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
    }
  }));
}

/* ------------------------------ 系统状态 ------------------------------ */

async function renderStatus(body) {
  const d = await api('/api/v2/admin/status');
  const sync = d.sync || {};
  body.innerHTML = `
  <div class="grid-2">
    ${card({
      title: '运行环境',
      subtitle: '界面与接口都如实标注当前仍是原型机制',
      body: kv([
        ['数据库路径', `<code>${esc(d.database?.path)}</code>`],
        ['是否在用生产库', d.database?.is_production_db ? chip('是（写操作被拒绝）', 'danger') : chip('否（独立库）', 'ok')],
        ['v2 启用', d.v2?.enabled ? chip('已启用', 'ok') : chip('未启用', 'warn')],
        ['v2 表结构', d.v2?.tables_ok ? chip('完整', 'ok') : chip(`缺 ${d.v2?.missing_tables?.length ?? 0} 张`, 'danger')],
        ['身份认证', `${esc(d.identity?.mode)}｜${esc(d.identity?.note)}`],
        ['数据保留期', esc(d.retention)],
        ['备份', esc(d.backup)],
        ['调度', esc(d.scheduler)],
      ]),
    })}
    ${card({
      title: '数据新鲜度与运行状态',
      subtitle: `数据截至 ${esc(sync.data_as_of || '—')}`,
      actions: '<button class="btn btn-sm btn-primary" data-daily>立即执行每日更新</button><button class="btn btn-sm" data-checks>执行全部核对</button>',
      body: `
        <div class="metrics metrics-sm">
          ${mini('公开内容条目', sync.counts?.content_items ?? 0, '条', '不含演示条目与转载副本')}
          ${mini('自动核验通过', sync.counts?.verification_verified ?? 0, '条', `证据不足 ${sync.counts?.verification_insufficient ?? 0}`)}
          ${mini('来源冲突', sync.counts?.verification_conflict ?? 0, '条', '冲突不覆盖官方数值')}
          ${mini('暂未自动核验', sync.counts?.verification_unavailable ?? 0, '条', '模型或正文不可用')}
          ${mini('未结清差异', sync.counts?.open_issues ?? 0, '条', `严重 ${d.reconciliation?.critical ?? 0}`)}
          ${mini('近 2 日失败任务', sync.counts?.failed_jobs_2d ?? 0, '次')}
        </div>
        <p class="hint">以上均为**自动运行状态**：平台没有人审核队列，故障与冲突只作提示与检索，不需要管理员批准内容。</p>
        ${sync.alert ? `<div class="callout callout-warn"><b>告警</b><p>${esc(sync.alert)}</p></div>` : ''}
        ${noteBlock(`最后成功同步（北京时间）：${dateTime(sync.last_success_sync)}｜最近任务：${sync.last_job ? `${sync.last_job.job_key}（${sync.last_job.status}）` : '（无）'}`)}`,
    })}
  </div>
  <div class="grid-2">
    ${card({
      title: '数据集条数',
      body: `<div class="kv-grid">${Object.entries(d.counts || {}).map(([k, v]) => `<div class="kv-line"><span class="kv-k">${esc(k)}</span><span class="kv-v">${v === null ? '（不存在）' : num(v)}</span></div>`).join('')}</div>`,
    })}
    ${card({
      title: 'AI 能力状态',
      subtitle: d.ai?.note,
      body: `<ul class="list">${Object.entries(d.ai?.purposes || {}).map(([k, p]) => `<li>${p.enabled ? chip('已启用', 'ok') : chip('未启用', '')} ${esc(p.label)}</li>`).join('')}</ul>
        <p class="hint">提供方 ${d.ai?.providers ?? 0} 个，其中启用 ${d.ai?.enabled_providers ?? 0} 个。确定性规则先发现差异，大模型每日核对来源证据并单独留痕；缺少原文时保持证据不足。</p>`,
    })}
  </div>
  ${card({
    title: '最近任务',
    body: table({
      rows: d.jobs || [],
      pageSize: 8,
      columns: [
        { key: 'job_key', label: '任务' },
        { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
        { key: 'started_at', label: '开始', render: (r) => esc(dateTime(r.started_at)) },
        { key: 'finished_at', label: '结束', render: (r) => esc(dateTime(r.finished_at)) },
        { key: 'items_found', label: '发现', align: 'right' },
        { key: 'items_parsed', label: '解析', align: 'right' },
        { key: 'items_published', label: '自动发布', align: 'right' },
        { key: 'error_count', label: '问题', align: 'right' },
        { key: 'actions', label: '步骤', render: (r) => `<button class="btn btn-xs" data-job="${esc(r.id)}">查看步骤</button>` },
      ],
      emptyText: '尚无采集任务',
    }),
  })}`;

  body.querySelector('[data-daily]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '执行中…';
    try {
      const out = await api('/api/v2/admin/daily', { method: 'POST', body: { tradeLimit: 20 } });
      toast(
        `每日更新完成：${out.status}（自动发布 ${out.stats?.published ?? 0} 条，核验 ${out.stats?.validated ?? 0} 条）`,
        out.ok ? 'ok' : 'warn'
      );
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.error || err.message, 'danger');
      e.target.disabled = false;
      e.target.textContent = '立即执行每日更新';
    }
  });
  body.querySelector('[data-checks]')?.addEventListener('click', async () => {
    try {
      const out = await api('/api/v2/admin/checks/run', { method: 'POST', body: {} });
      toast(`核对完成：交易 ${out.trade.issues}｜项目 ${out.project.issues}｜政策 ${out.policy.issues}｜因子 ${out.factor.issues}`, 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.error || err.message, 'danger');
    }
  });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-job]');
    if (!b) return;
    const job = await api(`/api/v2/admin/jobs/${b.dataset.job}`);
    document.body.insertAdjacentHTML('beforeend', drawer(`任务步骤：${job.job_key}`, `
      ${kv([['状态', chip(job.status, job.status === 'success' ? 'ok' : job.status === 'failed' ? 'danger' : 'warn')],
        ['触发', esc(job.trigger_kind)], ['触发人', esc(job.triggered_by || '—')],
        ['数据截至', esc(job.data_as_of || '—')], ['错误摘要', esc(job.error_summary || '—')]])}
      <table class="grid grid-sm"><thead><tr><th>#</th><th>阶段</th><th>目标</th><th>状态</th><th>数量</th><th>说明</th></tr></thead>
      <tbody>${(job.steps || []).map((s) => `<tr><td>${s.step_order}</td><td>${esc(s.stage)}</td>
        <td class="muted">${esc(String(s.target || '').slice(0, 70))}</td>
        <td>${chip(s.status, s.status === 'ok' ? 'ok' : s.status === 'failed' ? 'danger' : '')}</td>
        <td class="ta-r">${s.items}</td><td>${esc(s.message || '')}</td></tr>`).join('')}</tbody></table>
      <p class="hint">原始响应保存在快照中（sha256 + 抓取时间），可在「任务与快照」中查看。</p>`, { wide: true }));
  });
}

/* ------------------------------ 数据源 ------------------------------ */

async function renderDatasources(body) {
  const d = await api('/api/v2/admin/datasources');
  body.innerHTML = `
  ${card({
    title: '数据源配置',
    subtitle: '自动采集不得直接修改正式规则或历史报告；出站域名受白名单限制',
    body: table({
      rows: d.datasources || [],
      pageSize: 20,
      columns: [
        { key: 'name', label: '名称', render: (r) => `<a class="link" data-ds="${esc(r.id)}">${esc(r.name)}</a>` },
        { key: 'source_kind_label', label: '来源类型' },
        { key: 'parser_label', label: '解析器' },
        { key: 'frequency', label: '周期' },
        { key: 'status_label', label: '状态', render: (r) => chip(r.status_label, r.paused ? 'warn' : r.enabled ? 'ok' : '') },
        { key: 'last_success_at', label: '最近成功', render: (r) => esc(r.last_success_at ? dateTime(r.last_success_at) : '—') },
        { key: 'consecutive_failures', label: '连续失败', align: 'right' },
        { key: 'data_owner', label: '数据责任人' },
        { key: 'actions', label: '操作', render: (r) => `
          <button class="btn btn-xs" data-test="${esc(r.id)}">连接测试</button>
          <button class="btn btn-xs" data-pause="${esc(r.id)}" data-paused="${r.paused ? '1' : '0'}">${r.paused ? '恢复' : '暂停'}</button>
          <button class="btn btn-xs" data-rb="${esc(r.id)}">回滚点</button>` },
      ],
      emptyText: '尚未配置数据源',
    }),
  })}
  ${card({
    title: '解析器与来源类型',
    body: `<div class="grid-2"><div><h5>来源类型</h5><ul class="list">${Object.entries(d.source_kinds || {}).map(([k, v]) => `<li><code>${esc(k)}</code> ${esc(v)}</li>`).join('')}</ul></div>
      <div><h5>解析器</h5><ul class="list">${Object.entries(d.parsers || {}).map(([k, v]) => `<li><code>${esc(k)}</code> ${esc(v)}</li>`).join('')}</ul></div></div>
      <p class="hint">人工上传/摘录类来源不做自动抓取，走导入模板；管理员配置的地址受白名单限制，无法访问内网。</p>`,
  })}`;

  body.addEventListener('click', async (e) => {
    const test = e.target.closest('[data-test]');
    const pause = e.target.closest('[data-pause]');
    const rb = e.target.closest('[data-rb]');
    const open = e.target.closest('[data-ds]');
    if (test) {
      test.disabled = true;
      try {
        const out = await api(`/api/v2/admin/datasources/${test.dataset.test}/test`, { method: 'POST' });
        toast(out.ok ? `连接正常：${out.parse_note || ''}` : `连接失败：${out.error}`, out.ok ? 'ok' : 'danger');
      } catch (err) {
        toast(err.body?.error || err.message, 'danger');
      }
      test.disabled = false;
      return;
    }
    if (pause) {
      try {
        await api(`/api/v2/admin/datasources/${pause.dataset.pause}/pause`, {
          method: 'POST', body: { paused: pause.dataset.paused !== '1', reason: '后台手动切换' },
        });
        toast('已更新数据源状态', 'ok');
        renderAdmin(document.getElementById('module-root'), state.route);
      } catch (err) {
        toast(err.body?.error || err.message, 'danger');
      }
      return;
    }
    if (rb) {
      const list = await api(`/api/v2/admin/datasources/${rb.dataset.rb}/rollbacks`);
      document.body.insertAdjacentHTML('beforeend', drawer('配置回滚点', (list.rollbacks || []).length
        ? `<table class="grid grid-sm"><thead><tr><th>时间</th><th>操作人</th><th>原因</th><th>状态</th><th></th></tr></thead>
           <tbody>${list.rollbacks.map((r) => `<tr><td>${esc(dateTime(r.created_at))}</td><td>${esc(r.created_by || '')}</td>
           <td>${esc(r.reason || '')}</td><td>${r.restored_at ? chip('已使用', '') : chip('可用', 'ok')}</td>
           <td>${r.restored_at ? '' : `<button class="btn btn-xs" data-restore="${esc(r.id)}">恢复此版本</button>`}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">暂无回滚点（每次修改配置会自动留点）。</p>'));
      return;
    }
    if (open) {
      const ds = (d.datasources || []).find((x) => x.id === open.dataset.ds);
      document.body.insertAdjacentHTML('beforeend', drawer('数据源详情', `
        <h4>${esc(ds.name)}</h4>
        ${kv([
          ['URL', ds.url ? `<a class="link" href="${esc(ds.url)}" target="_blank" rel="noreferrer noopener">${esc(ds.url)}</a>` : '—'],
          ['来源类型', esc(ds.source_kind_label)],
          ['解析器', esc(ds.parser_label)],
          ['抓取周期', esc(ds.frequency)],
          ['限流', `${esc(String(ds.rate_limit_per_min))} 次/分钟`],
          ['超时', `${esc(String(ds.timeout_ms))} ms`],
          ['重试', `${esc(String(ds.retry_max))} 次`],
          ['出站白名单', esc((ds.allowed_domains || []).join('、') || '—')],
          ['许可说明', esc(ds.license_note || '—')],
          ['数据责任人', esc(ds.data_owner || '—')],
          ['最近状态', `${esc(ds.last_status || '')}${ds.last_error ? `｜${esc(ds.last_error)}` : ''}`],
        ])}
        <h5>最近快照</h5>
        ${ds.last_snapshot ? kv([['抓取时间', esc(dateTime(ds.last_snapshot.fetched_at))], ['HTTP', esc(String(ds.last_snapshot.http_status ?? '—'))],
          ['解析质量', esc(ds.last_snapshot.parse_quality || '—')], ['说明', esc(ds.last_snapshot.parse_note || '—')]]) : '<p class="muted">无快照。</p>'}
        <h5>最近错误</h5>
        ${(ds.recent_errors || []).length ? `<ul class="list">${ds.recent_errors.map((x) => `<li>${esc(dateTime(x.fetched_at))}｜${esc(x.error || x.parse_note || '')}</li>`).join('')}</ul>` : '<p class="muted">无</p>'}
      `, { wide: true }));
    }
  });
  document.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-restore]');
    if (!r) return;
    try {
      await api(`/api/v2/admin/rollbacks/${r.dataset.restore}/restore`, { method: 'POST' });
      toast('已回滚数据源配置', 'ok');
      document.querySelector('.drawer-backdrop')?.remove();
      document.querySelector('.drawer')?.remove();
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.error || err.message, 'danger');
    }
  });
}

/* ------------------------------ 模型配置 ------------------------------ */

async function renderLlm(body) {
  const [d, key] = await Promise.all([
    api('/api/v2/admin/llm'),
    api('/api/v2/admin/secret-key').catch(() => ({ secret_key: null })),
  ]);
  const ks = key.secret_key || d.status?.secret_key || {};
  body.innerHTML = `
  <div class="callout ${d.status?.any_ai_available ? 'callout-ok' : 'callout-warn'}">
    <b>模型能力：${d.status?.any_ai_available ? '部分已启用' : '未启用（公开信息采集与展示不受影响）'}</b>
    <p>${esc(d.status?.note || '')}</p>
  </div>

  ${card({
    title: '服务端主密钥',
    subtitle: '用于加密保存凭据；凭据只存服务端，任何接口都不返回明文',
    body: `
      <div class="callout ${ks.available ? 'callout-ok' : 'callout-warn'}">
        <b>主密钥：${ks.available ? `已就绪（来源：${ks.source === 'env' ? '环境变量 CCER_SECRET_KEY' : '本机受限密钥文件'}）` : '尚未初始化'}</b>
        <p>${esc(ks.hint || '')}</p>
      </div>
      ${kv([
        ['密钥文件', `<code>${esc(ks.key_file || '—')}</code>`],
        ['文件是否存在', ks.key_file_exists ? chip('存在', 'ok') : chip('不存在', 'warn')],
        ['文件权限', esc(ks.key_file_mode || (ks.acl_verified === true ? 'Windows ACL 已校验' : '—'))],
        ['权限校验', ks.available === false
          ? chip('未初始化', 'warn')
          : ks.acl_verified === true ? chip('已通过（仅当前用户可访问）', 'ok')
            : ks.acl_verified === false ? chip('未通过', 'danger') : chip('环境变量模式，无需文件权限', '')],
        ['密钥目录隔离', ks.isolated_key_dir ? chip('跟随当前数据库目录（隔离）', 'ok') : chip('仓库 data/keys', '')],
      ])}
      ${ks.can_init_file
        ? `<button class="btn btn-primary" id="init-key">初始化本机主密钥</button>
           <p class="hint">初始化会在**当前数据库目录**下生成 32 字节随机密钥文件：
           POSIX 设为 0600 并校验；Windows 用 icacls 关闭继承、只授予当前用户并**回读 ACL 校验**。
           无法设置或校验时**拒绝初始化并删除刚生成的文件**（不留权限过宽的私钥），
           此时请改用环境变量 CCER_SECRET_KEY（凭据完全不落库）。</p>`
        : `<p class="hint">主密钥已就绪，无需再初始化。</p>`}
      <div id="key-result"></div>`,
  })}

  ${card({
    title: '模型提供方配置',
    subtitle: '用于公开内容的自动核验与摘要抽取；数字计算始终由确定性程序执行',
    body: table({
      rows: d.providers || [],
      pageSize: 10,
      columns: [
        { key: 'name', label: '名称', render: (r) => `<a class="link" data-llmedit="${esc(r.id)}">${esc(r.name)}</a>` },
        { key: 'provider_kind', label: '类型' },
        { key: 'base_url', label: '接口地址', render: (r) => `<span class="muted">${esc(r.base_url)}</span>` },
        { key: 'model', label: '模型' },
        { key: 'credential_ref', label: '凭据引用' },
        { key: 'credential_configured', label: '凭据状态', render: (r) => (r.credential_configured ? chip('已配置', 'ok') : chip('未配置', 'warn')) },
        { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('已启用', 'ok') : chip('未启用', '')) },
        { key: 'purposes', label: '用途开关', render: (r) => Object.entries(r.purposes || {}).filter(([, v]) => v).map(([k]) => chip(PURPOSE_LABEL[k] || k, 'ok')).join(' ') || '<span class="muted">全部关闭</span>' },
        { key: 'last_test_result', label: '真实连接测试', render: (r) => {
          if (!r.last_test_result) return '—';
          const map = { ok: ['已配置且可调用', 'ok'], configured_only: ['仅已配置，未验证调用', 'warn'], failed: ['已配置但不可调用', 'danger'] };
          const [label, tone] = map[r.last_test_result] || [r.last_test_result, ''];
          return chip(label, tone);
        } },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-llmtest="${esc(r.id)}">真实连接测试</button>` },
      ],
      emptyText: '未配置任何模型',
      emptyDetail: '未配置模型时，公开内容仍会被采集与展示，核验状态标记为「暂未自动核验」。',
    }),
  })}

  ${card({title:'新增或编辑模型',subtitle:'接口地址可填到域名或完整路径（系统会自动补 /v1/chat/completions 或 /chat/completions）。',body:`
    <form id="llm-form" class="form-grid">
      <input name="id" type="hidden">
      <label class="fld"><span>配置名称</span><input name="name" required placeholder="例如 DeepSeek 内容核验"></label>
      <label class="fld"><span>类型</span><select name="provider_kind"><option value="openai_compatible">OpenAI 兼容接口</option><option value="anthropic">Anthropic 兼容接口</option><option value="ollama">本机 Ollama</option><option value="custom">其它自定义</option></select></label>
      <label class="fld"><span>接口地址</span><input name="base_url" type="url" required placeholder="https://api.deepseek.com"></label>
      <label class="fld"><span>模型名</span><input name="model" required placeholder="模型 ID"></label>
      <label class="fld"><span>白名单域名</span><input name="allowed_domains" placeholder="api.deepseek.com；本机 Ollama 可留空"></label>
      <label class="fld"><span>环境变量名（选填，不是 API 密钥）</span><input name="credential_ref" placeholder="DEEPSEEK_API_KEY" pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"><small>使用下方 API 密钥栏时，此项可留空；它只用于引用服务器上的环境变量。</small></label>
      <label class="fld"><span>API 密钥（在此填写实际密钥）</span><input name="secret" type="password" autocomplete="new-password" placeholder="填写服务商提供的 API 密钥；保存后加密存储"></label>
      <label class="fld"><span>每日调用上限</span><input name="max_calls_per_day" type="number" min="1" max="10000" value="200"></label>
      <label class="fld"><input name="enabled" type="checkbox" checked> 启用模型</label>
      <label class="fld"><input name="use_content_verify" type="checkbox" checked> 用于公开内容 / 研报自动核验</label>
      <label class="fld"><input name="use_policy_summary" type="checkbox"> 用于政策摘要</label>
      <label class="fld"><input name="use_methodology_extract" type="checkbox"> 用于方法学结构抽取</label>
      <label class="fld"><input name="use_qa_draft" type="checkbox"> 用于问答与报告草稿</label>
      <div><button class="btn btn-primary" type="submit">保存模型</button> <button class="btn" type="reset">清空表单</button></div>
    </form>`})}

  ${card({
    title: '凭据处理规则',
    body: `<ul class="list">
      <li>凭据只存服务端：优先使用环境变量（<code>credential_ref</code> 指向的变量名，或 <code>CCER_LLM_KEY_&lt;引用名&gt;</code>），凭据完全不落库。</li>
      <li>如需在库内保存，须先初始化服务端主密钥（<code>CCER_SECRET_KEY</code> 或本机受限密钥文件），以 AES-256-GCM 加密后入库。</li>
      <li>未初始化主密钥时提交明文密钥会被<b>拒绝</b>，并给出可操作提示，不会静默保存明文。</li>
      <li>接口响应、页面、日志与导出文档中都不会出现凭据明文；只返回「是否已配置」与来源。</li>
      <li>「真实连接测试」会发送一条最短的真实请求，并区分「已配置」与「可调用」两个状态。</li>
    </ul>`,
  })}`;

  body.querySelector('#init-key')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = '初始化中…';
    const out = document.getElementById('key-result');
    try {
      const r = await api('/api/v2/admin/secret-key/init', { method: 'POST' });
      out.innerHTML = `<p>${esc(r.message)}</p>${r.hint ? `<p class="hint">${esc(r.hint)}</p>` : ''}`;
      toast(r.message, r.refused ? 'warn' : 'ok');
      if (r.refused) {
        btn.disabled = false;
        btn.textContent = '初始化本机主密钥';
      } else {
        renderAdmin(document.getElementById('module-root'), state.route);
      }
    } catch (e) {
      out.innerHTML = `${errorState(e)}<p class="hint">可改用环境变量 CCER_SECRET_KEY（凭据完全不落库）。</p>`;
      btn.disabled = false;
      btn.textContent = '初始化本机主密钥';
    }
  });

  const form = body.querySelector('#llm-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const payload = {
      id: f.get('id') || undefined,
      name: f.get('name'),
      provider_kind: f.get('provider_kind'),
      base_url: f.get('base_url'),
      model: f.get('model'),
      credential_ref: f.get('credential_ref') || null,
      allowed_domains: String(f.get('allowed_domains') || '').split(/[,，;；\s]+/).filter(Boolean),
      max_calls_per_day: Number(f.get('max_calls_per_day')),
      enabled: f.has('enabled'),
      use_content_verify: f.has('use_content_verify'),
      use_policy_summary: f.has('use_policy_summary'),
      use_methodology_extract: f.has('use_methodology_extract'),
      use_qa_draft: f.has('use_qa_draft'),
    };
    if (f.get('secret')) payload.secret = f.get('secret');
    try {
      const out = await api('/api/v2/admin/llm', { method: 'POST', body: payload });
      toast(out.credential ? `模型配置已保存：${out.credential}` : '模型配置已保存', 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.message || err.body?.error || err.message, 'danger');
    }
  });
  body.addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-llmedit]');
    if (edit) {
      const p = (d.providers || []).find((x) => x.id === edit.dataset.llmedit);
      if (!p) return;
      for (const k of ['id', 'name', 'provider_kind', 'base_url', 'model', 'credential_ref', 'max_calls_per_day']) {
        form.elements[k].value = p[k] ?? '';
      }
      form.elements.allowed_domains.value = (p.allowed_domains || []).join(', ');
      form.elements.enabled.checked = !!p.enabled;
      form.elements.use_content_verify.checked = !!p.purposes?.use_content_verify;
      form.elements.use_policy_summary.checked = !!p.purposes?.use_policy_summary;
      form.elements.use_methodology_extract.checked = !!p.purposes?.use_methodology_extract;
      form.elements.use_qa_draft.checked = !!p.purposes?.use_qa_draft;
      form.elements.secret.value = '';
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const b = e.target.closest('[data-llmtest]');
    if (!b) return;
    b.disabled = true;
    b.textContent = '测试中…';
    try {
      const out = await api(`/api/v2/admin/llm/${b.dataset.llmtest}/test`, { method: 'POST' });
      toast(out.message, out.ok ? 'ok' : 'warn');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.message || err.body?.error || err.message, 'danger');
      b.disabled = false;
      b.textContent = '真实连接测试';
    }
  });
}

const PURPOSE_LABEL = {
  use_policy_summary: '政策摘要',
  use_methodology_extract: '方法学结构抽取',
  use_content_verify: '公开内容自动核验',
  use_project_extract: '项目字段抽取',
  use_qa_draft: '问答与报告草稿',
};

/* ------------------------------ 用户与团队 ------------------------------ */

const DS_CAP_LABEL = { search: 'Search', fetch: 'Fetch', vision: '视觉补充', chat_tools: '工具问答', json: 'JSON 加固' };

async function renderDeepSeek(body) {
  const [d, vs, vt] = await Promise.all([
    api('/api/v2/admin/deepseek'),
    api('/api/v2/admin/vision/status?limit=10').catch(() => ({ pages: [], totals: {}, files: [] })),
    api('/api/v2/admin/vision/tooling').catch(() => ({ tooling: { available: false, error: '未检测到工具状态' } })),
  ]);
  const caps = d.capabilities || [];
  const officialProviders = (d.providers || []).filter((p) => p.official);
  const pricing = d.pricing_note || '';
  const capLabel = (k) => DS_CAP_LABEL[k] || k;
  const dsTestLabel = (k) => (k === 'search' || k === 'fetch' ? '真实能力测试' : '鉴权与模型连接测试');
  const dsTestScope = (k) => (k === 'search' || k === 'fetch' ? 'capability' : 'auth_and_model_connectivity');
  const searchFallbackKv = kv([
    ['主搜索连接', `${num(d.search?.primary_count || 0)} 个`],
    ['备用搜索连接', `${num(d.search?.fallback_count || 0)} 个`],
    ['备用搜索成功次数', `${num((d.fallback?.search || []).filter((x) => x.is_fallback).reduce((n, x) => n + (x.success || 0), 0))}`],
  ]);
  const fetchFallbackKv = kv([
    ['主抓取连接', `${num(d.fetch?.primary_count || 0)} 个`],
    ['备用抓取连接', `${num(d.fetch?.fallback_count || 0)} 个`],
    ['备用抓取成功次数', `${num((d.fallback?.fetch || []).filter((x) => x.is_fallback).reduce((n, x) => n + (x.success || 0), 0))}`],
  ]);
  const fallbackCard = card({
    title: '备用通道（主服务失败 / 无结果 / 缺正文时才尝试）',
    subtitle: '自动生成的 DeepSeek 连接不会替换用户已有主服务；同一 URL 的多引擎结果只算一条证据',
    body: `<div class="grid-2">
      <div>${searchFallbackKv}
      <button class="btn btn-sm" id="ds-test-search">真实能力测试 DeepSeek Search 备用</button></div>
      <div>${fetchFallbackKv}
      <button class="btn btn-sm" id="ds-test-fetch">真实能力测试 DeepSeek Fetch 备用</button></div>
    </div>
    <p class="hint">Search/Fetch 会真实调用对应官方能力并消耗一次额度；视觉/工具问答/JSON 按钮只做「鉴权与模型连接测试」，连接通过不代表完整功能已验收，不冒充完整验收。测试失败会如实显示 HTTP/超时/鉴权/预算原因，不伪造可调用。</p>`,
  });
  body.innerHTML = `
  <div class="callout ${officialProviders.length ? 'callout-ok' : 'callout-warn'}">
    <b>DeepSeek 能力：${caps.filter((c) => c.enabled).length} 项已启用｜官方模型配置 ${officialProviders.length} 个</b>
    <p>搜索与抓取是两个独立能力；视觉与工具问答默认关闭，需管理员显式启用并绑定官方模型。直接引用已保存的模型凭据，无需重复填写密钥。</p>
    <p class="hint">${esc(pricing)}</p>
  </div>

  ${card({
    title: '能力开关、预算与引用关系',
    subtitle: '按任务控制思考模式、调用额度与最近成功时间；Search/Fetch 仍由采集连接页配置具体连接',
    body: table({
      rows: caps.map((c) => ({
        ...c,
        budget_label: `${num(c.calls_today)} / ${num(c.daily_quota)}（总调用 ${num(c.total_calls)}｜成功 ${num(c.total_success)}）`,
      })),
      id: 'deepseek-capability-table',
      pageSize: 10,
      columns: [
        { key: 'label', label: '能力', render: (r) => `<b>${esc(capLabel(r.kind))}</b><div class="muted">${esc(r.label)}</div>` },
        { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('已启用', 'ok') : chip('未启用', '')) },
        { key: 'provider_name', label: '引用模型', render: (r) => r.provider_name
          ? `<span>${esc(r.provider_name)}</span><div class="muted">${esc(r.provider_model || '')}${r.provider_official ? '' : '｜非官方'}</div>`
          : '<span class="muted">未绑定</span>' },
        { key: 'credential_configured', label: '凭据', render: (r) => (r.credential_configured ? chip('已配置', 'ok') : chip('不可用', 'warn')) },
        { key: 'budget_label', label: '今日 / 额度', align: 'right' },
        { key: 'last_success_at', label: '最近成功', render: (r) => esc(r.last_success_at ? dateTime(r.last_success_at) : '—') },
        { key: 'last_error', label: '最近失败', render: (r) => (r.last_error ? `<span class="muted" title="${esc(r.last_error)}">${esc(truncate(r.last_error, 34))}</span>` : '—') },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-dsedit="${esc(r.kind)}">配置</button>
            <button class="btn btn-xs" data-dstest="${esc(r.kind)}">${esc(dsTestLabel(r.kind))}</button>` },
      ],
      emptyText: '能力配置尚未初始化',
      emptyDetail: '系统会在存在启用的官方 https://api.deepseek.com 模型配置时自动提供一套 fallback 能力配置。',
    }),
    note: '默认值：搜索/抓取/工具问答为 fallback 或关闭；摘要/JSON/视觉显式关闭思考。Search/Fetch 按钮为真实能力测试；视觉/工具问答/JSON 按钮仅为「鉴权与模型连接测试」，连接通过不代表完整功能已验收，不代替完整能力验收。达到限额、402 或 401/403 时不盲目重试。',
  })}

  ${fallbackCard}

  ${card({
    title: '视觉补充与 Files 复用',
    subtitle: '只对指定 PDF 物理页调用 deepseek-flash；页图、页数、字节与时间均有硬上限',
    actions: `<button class="btn btn-sm" id="ds-vision-cleanup">清理过期图片缓存</button>`,
    body: `
      <div class="callout ${vt.tooling?.available ? 'callout-ok' : 'callout-warn'}">
        <b>页图转换工具：${vt.tooling?.available ? '可用' : '不可用'}</b>
        <p>${esc(vt.tooling?.version || vt.tooling?.error || '未检测')}</p>
        <p class="hint">${esc(vt.agent_hint || '')}</p>
      </div>
      ${kv([
        ['视觉结果', `${num(vs.totals?.total)} 页（成功 ${num(vs.totals?.ok)}，已并入正文 ${num(vs.totals?.applied)}）`],
        ['Files 活跃缓存', `${num(d.file_cache?.active)} 条（总 ${num(d.file_cache?.total)}）`],
        ['单文档页数上限', `${num(vs.limits?.max_pages_per_doc)} 页`],
        ['单页图片上限', `${num(Math.round((vs.limits?.max_image_bytes || 0) / 1024 / 1024))} MB`],
        ['Files 复用', vs.limits?.files_reuse ? chip('已启用', 'ok') : chip('关闭（单次 base64）', '')],
      ])}
      ${table({
        rows: vs.pages || [],
        pageSize: 8,
        columns: [
          { key: 'object_id', label: '对象', render: (r) => `<span>${esc(r.object_kind)}</span><div class="muted">${esc(truncate(r.object_id, 26))}</div>` },
          { key: 'page', label: '页', align: 'right' },
          { key: 'model', label: '模型' },
          { key: 'status', label: '状态', render: (r) => chip(r.status === 'ok' ? '已识别' : r.status === 'blocked' ? '工具阻止' : '失败', r.status === 'ok' ? 'ok' : r.status === 'blocked' ? 'warn' : 'danger') },
          { key: 'applied', label: '并入正文', render: (r) => (r.applied ? chip('是', 'ok') : chip('否', '')) },
          { key: 'confidence', label: '置信度', align: 'right', render: (r) => (r.confidence === null || r.confidence === undefined ? '—' : `${Math.round(r.confidence * 100)}%`) },
          { key: 'error', label: '限制/错误', render: (r) => (r.error ? `<span class="muted" title="${esc(r.error)}">${esc(truncate(r.error, 30))}</span>` : '—') },
        ],
        emptyText: '尚无视觉补充记录',
        emptyDetail: '管理员可在「PDF 解析/OCR」页对已有受限文档的指定物理页触发视觉补充。',
      })}
      <p class="hint">视觉输出是模型理解材料，不是官方事实，也不自动改写正式因子；并入正文仍按部分/机器抽取展示。</p>`,
  })}

  ${card({
    title: '调用观测：token / 输入缓存 / 工具次数 / 失败',
    subtitle: '只记录服务端实际 usage；输入缓存是计费观测，不是事实库，也不是输出缓存',
    body: `${kv([
      ['模型调用', `${num(d.usage?.calls)} 次（成功 ${num(d.usage?.ok)}）`],
      ['输入缓存命中 / 未命中 tokens', `${num(d.usage?.cache_hit_tokens)} / ${num(d.usage?.cache_miss_tokens)}`],
      ['工具调用', `${num(d.tool_calls?.calls)} 次（成功 ${num(d.tool_calls?.ok)}）`],
      ['费用估算', d.usage?.cost_estimated_calls ? `约 ¥${Number(d.usage.estimated_cost_cny || 0).toFixed(4)}（按已配置单价估算，非账单）` : '未配置明确 token 单价：不估算、不声称免费'],
    ])}
    ${table({
      rows: d.recent_calls || [],
      pageSize: 6,
      columns: [
        { key: 'at', label: '时间', render: (r) => esc(dateTime(r.at)) },
        { key: 'purpose', label: '用途' },
        { key: 'status', label: '状态', render: (r) => chip(r.status === 'ok' ? '成功' : '失败', r.status === 'ok' ? 'ok' : 'danger') },
        { key: 'latency_ms', label: '延迟', align: 'right', render: (r) => (r.latency_ms == null ? '—' : `${num(r.latency_ms)} ms`) },
        { key: 'tokens', label: '输入 / 输出', align: 'right', render: (r) => `${num(r.prompt_tokens)} / ${num(r.completion_tokens)}` },
        { key: 'cache', label: '缓存命中 / 未命中', align: 'right', render: (r) => `${num(r.cache_hit_tokens)} / ${num(r.cache_miss_tokens)}` },
        { key: 'tool_calls', label: '工具', align: 'right', render: (r) => num(r.tool_calls) },
        { key: 'thinking', label: '思考', render: (r) => (r.thinking ? chip('开启', '') : '关闭') },
      ],
      emptyText: '尚无模型调用记录',
      emptyDetail: '首次真实测试或问答后，这里会显示延迟、token、缓存命中与失败原因（不显示 prompt 内容）。',
    })}
    <p class="hint">固定系统提示与工具定义作为公共前缀；是否命中输入缓存由供应商实际 usage 字段决定，不能保证 100% 命中。思维链不展示、不写入答复或证据。</p>`,
  })}

  ${card({
    title: '官方模型引用对象',
    subtitle: '只有启用的 https://api.deepseek.com 官方配置可被绑定；代理商/自建接口 Key 不会被转发',
    body: table({
      rows: d.providers || [],
      pageSize: 10,
      columns: [
        { key: 'name', label: '模型配置' },
        { key: 'model', label: '模型' },
        { key: 'base_url', label: '接口地址', render: (r) => `<span class="muted">${esc(r.base_url)}</span>` },
        { key: 'official', label: '官方', render: (r) => (r.official ? chip('可引用', 'ok') : chip('不可引用', 'warn')) },
        { key: 'credential_configured', label: '凭据', render: (r) => (r.credential_configured ? chip('已配置', 'ok') : chip('未配置', 'warn')) },
        { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('已启用', 'ok') : chip('未启用', '')) },
      ],
      emptyText: '尚无模型配置',
      emptyDetail: '请先在「模型配置」页添加并启用 https://api.deepseek.com 官方模型；系统会自动生成 fallback 搜索/抓取连接。',
    }),
  })}

  <div id="ds-result"></div>`;

  body.querySelectorAll('[data-dsedit]').forEach((el) => el.addEventListener('click', () => {
    const cap = caps.find((c) => c.kind === el.dataset.dsedit);
    if (cap) openDeepSeekForm(cap, d.providers || []);
  }));
  body.querySelectorAll('[data-dstest]').forEach((el) => el.addEventListener('click', async () => {
    const kind = el.dataset.dstest;
    const label = dsTestLabel(kind);
    const scope = dsTestScope(kind);
    el.disabled = true;
    el.textContent = '测试中…';
    try {
      const out = await api('/api/v2/admin/deepseek/test', { method: 'POST', body: { kind } });
      toast(out.message || (out.ok ? `${label}通过` : `${label}未通过`), out.ok ? 'ok' : 'warn');
      const title = out.ok
        ? (scope === 'capability' ? '真实能力测试通过' : '鉴权与模型连接测试通过')
        : (scope === 'capability' ? '真实能力测试未通过' : '鉴权与模型连接测试未通过');
      const detail = scope === 'capability'
        ? '已真实调用对应 Search/Fetch 能力并验证返回结构。'
        : '仅确认引用凭据与模型端点可调用；不等于视觉页图识别、工具协议调用或 JSON 结构化字段的完整能力验收。';
      document.getElementById('ds-result').innerHTML = `<div class="callout ${out.ok ? 'callout-ok' : 'callout-warn'}"><b>${esc(title)}</b><p>${esc(out.message || '')}</p><p class="hint">${esc(detail)}</p><p class="hint">test_scope=${esc(out.test_scope || scope)}｜capability_verified=${out.capability_verified === true}</p></div>`;
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
    } finally {
      el.disabled = false;
      el.textContent = label;
    }
  }));
  body.querySelector('#ds-test-search')?.addEventListener('click', async (ev) => {
    const row = (d.fallback?.search || []).find((x) => x.kind === 'deepseek_search');
    if (!row) return toast('尚无 DeepSeek Search 备用连接：请先在「采集连接」页引用官方模型创建', 'warn');
    ev.currentTarget.disabled = true;
    ev.currentTarget.textContent = '测试中…';
    try {
      const out = await api(`/api/v2/admin/search-providers/${row.id}/test`, { method: 'POST' });
      toast(out.message, out.ok ? 'ok' : 'warn');
    } catch (e) { toast(e.body?.error || e.message, 'danger'); }
    finally { ev.currentTarget.disabled = false; ev.currentTarget.textContent = '真实能力测试 DeepSeek Search 备用'; }
  });
  body.querySelector('#ds-test-fetch')?.addEventListener('click', async (ev) => {
    const row = (d.fallback?.fetch || []).find((x) => x.kind === 'deepseek_fetch');
    if (!row) return toast('尚无 DeepSeek Fetch 备用连接：请先在「采集连接」页引用官方模型创建', 'warn');
    ev.currentTarget.disabled = true;
    ev.currentTarget.textContent = '测试中…';
    try {
      const out = await api(`/api/v2/admin/fetch-connections/${row.id}/test`, { method: 'POST' });
      toast(out.message, out.ok ? 'ok' : 'warn');
    } catch (e) { toast(e.body?.error || e.message, 'danger'); }
    finally { ev.currentTarget.disabled = false; ev.currentTarget.textContent = '真实能力测试 DeepSeek Fetch 备用'; }
  });
  body.querySelector('#ds-vision-cleanup')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      const out = await api('/api/v2/admin/vision/files/cleanup', { method: 'POST' });
      toast(`已检查 ${out.scanned} 个过期文件，删除成功 ${out.results?.filter((x) => x.deleted).length || 0} 个`, 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
      ev.currentTarget.disabled = false;
    }
  });
}

const DEEPSEEK_THINKING_LABEL = { auto: '自动（复杂分析开启）', enabled: '始终开启', disabled: '始终关闭' };

function openDeepSeekForm(cap, providers) {
  const official = (providers || []).filter((p) => p.official && p.enabled);
  const c = cap.config || {};
  const kind = cap.kind;
  const extraFields = kind === 'vision'
    ? `<label class="fld"><span>视觉模型</span><input name="model" value="deepseek-flash" readonly></label>
       <label class="fld"><span>页图 DPI</span><input name="dpi" type="number" min="72" max="300" value="${esc(c.dpi || 144)}"></label>
       <label class="fld"><span>单文档页数上限</span><input name="max_pages_per_doc" type="number" min="1" max="20" value="${esc(c.max_pages_per_doc || 3)}"></label>
       <label class="fld"><span>单页图片上限（MB）</span><input name="max_image_bytes_mb" type="number" min="1" max="32" value="${esc(Math.round((c.max_image_bytes || 8388608) / 1024 / 1024))}"></label>
       <label class="fld"><span>单次输出上限（tokens）</span><input name="max_output_tokens" type="number" min="400" max="4000" value="${esc(c.max_output_tokens || 1800)}"></label>
       <label class="fld"><input name="files_reuse" type="checkbox" ${c.files_reuse ? 'checked' : ''}> 启用 Files 图片复用（按图片 hash + 凭据归属）</label>
       <label class="fld"><span>Files 有效期（秒）</span><input name="file_ttl_seconds" type="number" min="3600" max="2592000" value="${esc(c.file_ttl_seconds || 86400)}"></label>`
    : kind === 'chat_tools'
      ? `<label class="fld"><span>工具轮次上限</span><input name="max_rounds" type="number" min="1" max="4" value="${esc(c.max_rounds || 4)}"></label>
         <label class="fld"><span>工具调用上限</span><input name="max_tool_calls" type="number" min="1" max="12" value="${esc(c.max_tool_calls || 8)}"></label>
         <label class="fld"><span>整轮时长上限（毫秒）</span><input name="max_total_ms" type="number" min="5000" max="60000" value="${esc(c.max_total_ms || 45000)}"></label>
         <label class="fld"><span>输出上限（tokens）</span><input name="max_output_tokens" type="number" min="400" max="4000" value="${esc(c.max_output_tokens || 2800)}"></label>
         <label class="fld"><span>思考模式</span><select name="thinking">${Object.entries(DEEPSEEK_THINKING_LABEL).map(([k, v]) => `<option value="${k}" ${c.thinking === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
         <label class="fld"><span>思考强度</span><select name="reasoning_effort">${['low', 'high', 'max'].map((x) => `<option value="${x}" ${c.reasoning_effort === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`
      : kind === 'search'
        ? `<label class="fld"><span>默认结果条数</span><input name="count_default" type="number" min="1" max="50" value="${esc(c.count_default || 8)}"></label>
           <label class="fld"><span>单次最大条数</span><input name="max_count" type="number" min="1" max="50" value="${esc(c.max_count || 20)}"></label>
           <label class="fld"><input name="need_content" type="checkbox" ${c.need_content ? 'checked' : ''}> 默认请求正文（need_content=true 才可能返回 content）</label>`
        : kind === 'fetch'
          ? `<label class="fld"><span>正文截取上限（字符）</span><input name="max_content_chars" type="number" min="1000" max="100000" value="${esc(c.max_content_chars || 30000)}"></label>`
          : `<label class="fld"><span>JSON 重试上限（最多 1 次）</span><input name="max_retry" type="number" min="0" max="1" value="${esc(c.max_retry ?? 1)}"></label>
             <label class="fld"><span>修复输出上限（tokens）</span><input name="max_output_tokens" type="number" min="400" max="4000" value="${esc(c.max_output_tokens || 2200)}"></label>`;
  document.body.insertAdjacentHTML('beforeend', drawer(`配置 DeepSeek ${DS_CAP_LABEL[kind] || kind}`, `
    <form id="ds-form" class="form-grid">
      <label class="fld"><span>引用官方模型配置</span><select name="provider_id">
        <option value="">不绑定（仅 Search/Fetch 可沿用连接自身凭据）</option>
        ${official.map((p) => `<option value="${esc(p.id)}" ${cap.provider_id === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.model)}${p.credential_configured ? '' : '（凭据未配置）'}</option>`).join('')}
      </select><small>只有启用、官方的 https://api.deepseek.com 配置可绑定；系统通过 provider_id 解析凭据，不复制 Key。</small></label>
      <label class="fld"><input name="enabled" type="checkbox" ${cap.enabled ? 'checked' : ''}> 启用该能力</label>
      <label class="fld"><span>每日调用额度（0=不额外限制）</span><input name="daily_quota" type="number" min="0" max="100000" value="${esc(cap.daily_quota || 0)}"></label>
      <label class="fld"><span>单轮次数上限</span><input name="max_per_turn" type="number" min="1" max="20" value="${esc(cap.max_per_turn || 4)}"></label>
      <label class="fld"><span>超时（毫秒）</span><input name="timeout_ms" type="number" min="1000" max="180000" value="${esc(cap.timeout_ms || 45000)}"></label>
      ${extraFields}
      <div class="drawer-actions"><button class="btn btn-primary" type="submit">保存配置</button>
        <button class="btn" type="button" data-close-drawer>取消</button></div>
    </form>
    <p class="hint">402（余额不足）会停止当日该能力的后续调用；401/403 不重试。保存配置会清除“当日停止”标记，便于充值后重新测试。</p>
  `, { wide: true }));
  const form = document.getElementById('ds-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const config = { ...c };
    for (const [k, v] of f.entries()) {
      if (['provider_id', 'enabled', 'daily_quota', 'max_per_turn', 'timeout_ms'].includes(k)) continue;
      config[k] = v;
    }
    for (const k of ['dpi', 'max_pages_per_doc', 'max_image_bytes_mb', 'max_output_tokens', 'file_ttl_seconds', 'max_rounds', 'max_tool_calls', 'max_total_ms', 'count_default', 'max_count', 'max_content_chars', 'max_retry']) {
      if (config[k] !== undefined && config[k] !== '') config[k] = Number(config[k]);
    }
    if (config.max_image_bytes_mb !== undefined) {
      config.max_image_bytes = Number(config.max_image_bytes_mb) * 1024 * 1024;
      delete config.max_image_bytes_mb;
    }
    config.files_reuse = f.has('files_reuse');
    config.need_content = f.has('need_content');
    try {
      await api(`/api/v2/admin/deepseek/capabilities/${kind}`, {
        method: 'POST',
        body: {
          provider_id: f.get('provider_id') || null,
          enabled: f.has('enabled'),
          daily_quota: Number(f.get('daily_quota')),
          max_per_turn: Number(f.get('max_per_turn')),
          timeout_ms: Number(f.get('timeout_ms')),
          config,
        },
      });
      toast('DeepSeek 能力配置已保存', 'ok');
      document.querySelector('.drawer-backdrop')?.remove();
      document.querySelector('.drawer')?.remove();
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.error || err.body?.message || err.message, 'danger');
    }
  });
  document.querySelectorAll('[data-close-drawer]').forEach((el) => el.addEventListener('click', () => {
    document.querySelector('.drawer-backdrop')?.remove();
    document.querySelector('.drawer')?.remove();
  }));
}

async function renderUsers(body) {
  const d = await api('/api/v2/admin/users');
  body.innerHTML = `
  ${card({
    title: '账号',
    subtitle: '基础角色：管理员负责服务配置，不承担内容审核职责（平台无内容审核环节）',
    body: table({
      rows: d.users || [],
      pageSize: 15,
      columns: [
        { key: 'id', label: '用户 ID' },
        { key: 'name', label: '姓名' },
        { key: 'role_label', label: '角色' },
        { key: 'team_id', label: '团队' },
        { key: 'active', label: '状态', render: (r) => (r.active ? chip('启用', 'ok') : chip('停用', 'danger')) },
        { key: 'password_set', label: '口令', render: (r) => (r.password_set ? chip('已设服务端口令', 'ok') : chip('使用演示口令', 'warn')) },
        { key: 'must_change_password', label: '首次改密', render: (r) => (r.must_change_password ? chip('要求', 'warn') : '—') },
        { key: 'failed_attempts', label: '失败次数', align: 'right' },
        { key: 'locked_until', label: '锁定至', render: (r) => esc(r.locked_until ? dateTime(r.locked_until) : '—') },
        { key: 'last_login_at', label: '最近登录', render: (r) => esc(r.last_login_at ? dateTime(r.last_login_at) : '—') },
        { key: 'sessions', label: '会话', align: 'right' },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-role="${esc(r.id)}" data-current="${esc(r.role)}" data-active="${r.active ? '1' : '0'}" data-team="${esc(r.team_id || '')}">调整</button>
          <button class="btn btn-xs" data-pwd="${esc(r.id)}">重置口令</button>` },
      ],
      emptyText: '没有账号',
    }),
  })}
  ${card({
    title: '团队（仅用于用户归属分组）',
    subtitle: '平台不管理私有项目，因此不再有项目级授权',
    body: `<table class="grid"><thead><tr><th>团队</th><th>说明</th><th>成员</th></tr></thead>
      <tbody>${(d.teams || []).map((t) => `<tr><td>${esc(t.name)}<br><span class="muted">${esc(t.id)}</span></td>
        <td>${esc(t.description || '')}</td>
        <td>${(t.members || []).map((m) => esc(m.name)).join('、') || '—'}</td></tr>`).join('')}</tbody></table>
      <p class="hint">角色说明：${Object.entries(d.roles || {}).map(([k, v]) => `<code>${esc(k)}</code> ${esc(v)}`).join('｜')}</p>
      <p class="hint">内容审核角色已随人工审核链路一并移除；管理员只配置服务、用户与来源。</p>`,
  })}
  ${card({
    title: '登录记录',
    body: '<div id="login-log">加载中…</div>',
  })}`;

  body.addEventListener('click', async (e) => {
    const role = e.target.closest('[data-role]');
    const pwd = e.target.closest('[data-pwd]');
    if (role) {
      document.body.insertAdjacentHTML('beforeend', drawer('调整账号', `
        <label class="fld"><span>用户 ID</span><input value="${esc(role.dataset.role)}" disabled></label>
        <label class="fld"><span>角色</span><select id="u-role">${Object.entries(d.roles || {}).map(([k, v]) => `<option value="${k}" ${role.dataset.current === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label class="fld"><span>团队</span><select id="u-team">${(d.teams || []).map((t) => `<option value="${esc(t.id)}" ${role.dataset.team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>状态</span><select id="u-active"><option value="1" ${role.dataset.active === '1' ? 'selected' : ''}>启用</option><option value="0" ${role.dataset.active === '0' ? 'selected' : ''}>停用</option></select></label>
        <button class="btn btn-primary" id="u-save">保存</button>
        <p class="hint">停用后该账号无法登录；至少保留一名启用状态的管理员。</p>`));
      document.getElementById('u-save')?.addEventListener('click', async () => {
        try {
          await api('/api/v2/admin/users', {
            method: 'POST',
            body: {
              id: role.dataset.role,
              role: document.getElementById('u-role').value,
              team_id: document.getElementById('u-team').value,
              active: document.getElementById('u-active').value === '1',
            },
          });
          toast('已保存', 'ok');
          document.querySelector('.drawer-backdrop')?.remove();
          document.querySelector('.drawer')?.remove();
          renderAdmin(document.getElementById('module-root'), state.route);
        } catch (err) {
          toast(err.body?.error || err.message, 'danger');
        }
      });
      return;
    }
    if (pwd) {
      document.body.insertAdjacentHTML('beforeend', drawer('重置口令', `
        <p class="muted">口令以 scrypt 哈希存储，重置后立即撤销该账号全部会话。</p>
        <label class="fld"><span>新口令（≥12 位，含大小写字母与数字）</span><input id="p-new" type="password"></label>
        <label class="fld"><span>确认口令</span><input id="p-new2" type="password"></label>
        <button class="btn btn-primary" id="p-save">重置</button>
        <p class="hint">原型限制：本系统尚未接入机构统一身份认证（SSO/OIDC），云端上线前必须替换。</p>`));
      document.getElementById('p-save')?.addEventListener('click', async () => {
        const a = document.getElementById('p-new').value;
        const b = document.getElementById('p-new2').value;
        if (a !== b) {
          toast('两次输入不一致', 'danger');
          return;
        }
        try {
          const out = await api(`/api/v2/admin/users/${pwd.dataset.pwd}/password`, { method: 'POST', body: { password: a, must_change: true } });
          toast(`已重置，撤销会话 ${out.revoked_sessions} 个`, 'ok');
          document.querySelector('.drawer-backdrop')?.remove();
          document.querySelector('.drawer')?.remove();
        } catch (err) {
          toast(err.body?.error || err.message, 'danger');
        }
      });
    }
  });

  try {
    const logs = await api('/api/v2/admin/logins?limit=50');
    document.getElementById('login-log').innerHTML = table({
      rows: logs.logins || [],
      pageSize: 10,
      columns: [
        { key: 'at', label: '时间', render: (r) => esc(dateTime(r.at)) },
        { key: 'user_name', label: '账号' },
        { key: 'result', label: '结果', render: (r) => chip(r.result, r.result === 'ok' ? 'ok' : 'danger') },
        { key: 'method', label: '方式' },
        { key: 'ip', label: 'IP' },
        { key: 'detail', label: '说明', render: (r) => esc(String(r.detail || '').slice(0, 80)) },
      ],
      emptyText: '暂无登录记录',
    });
  } catch (e) {
    document.getElementById('login-log').innerHTML = errorState(e);
  }
}

/* ------------------------------ 核验结果查询（自动运行状态，非待办） ------------------------------ */

// 说明：旧版「审核任务」页签已随人工审核链路一并删除。
// 自动核验结果的查询入口在「自动核验策略」页签（统计 + 规则 + 立即核验），
// 单条内容的核验明细在「研报与行业动态 → 内容详情」中查看。

/* ------------------------------ 核对与缺口 ------------------------------ */

async function renderReconciliation(body, q) {
  const status = q.status || 'open';
  const [rec, gaps, documents] = await Promise.all([
    api(`/api/v2/admin/reconciliations?status=${encodeURIComponent(status)}`),
    api('/api/v2/admin/gaps?status=all'),
    api('/api/v2/admin/document-gaps'),
  ]);
  const s = rec.stats || {};
  const documentRows = [...(documents.policies || []), ...(documents.methodologies || [])];
  body.innerHTML = `
  <div class="metrics metrics-sm">
    ${mini('严重', s.critical, '条')}${mini('警告', s.warning, '条')}${mini('提示', s.info, '条')}${mini('已结清', s.closed, '条')}
  </div>
  <div class="filters">
    <label class="fld"><span>状态</span><select data-f="status">
      ${['open', 'resolved', 'confirmed', 'ignored', 'all'].map((x) => `<option value="${x}" ${status === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
    <span class="fld-actions"><button class="btn btn-sm" data-checks>规则与大模型立即核对</button></span>
  </div>
  ${card({
    title: '数据核对差异',
    subtitle: '每日先重跑规则，再由大模型核对可定位的来源正文；判断留痕，不覆盖官方数值',
    body: (rec.items || []).length
      ? `<table class="grid"><thead><tr><th>数据集</th><th>对象</th><th>检查项</th><th>等级</th><th>说明</th><th>AI 核对</th><th>发现时间</th><th>状态</th></tr></thead>
        <tbody>${rec.items.map((i) => `<tr>
          <td>${esc(i.dataset)}</td><td>${esc(i.object_label || i.object_id || '—')}</td>
          <td>${esc(CHECK_LABEL[i.check_kind] || i.check_kind)}</td>
          <td>${chip(i.severity, i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warn' : '')}</td>
          <td>${esc(i.detail)}${i.expected || i.actual ? `<br><span class="muted">应有：${esc(i.expected || '—')}｜实际：${esc(i.actual || '—')}</span>` : ''}</td>
          <td>${i.ai_review ? `${chip(({ supported: '证据支持差异', not_supported: '证据不支持', insufficient: '证据不足', unavailable: '模型不可用' })[i.ai_review.result] || i.ai_review.result, i.ai_review.result === 'supported' ? 'warn' : i.ai_review.result === 'not_supported' ? 'ok' : '')}<br><span class="muted">${esc(i.ai_review.summary || '')}</span><br><span class="muted">${esc(dateTime(i.ai_review.reviewed_at))}</span>${i.ai_review.citations?.length ? `<details><summary>查看来源引文</summary>${i.ai_review.citations.map((c) => `<p class="hint">${esc(c.quote)}<br>${safeHttpHref(c.source_url) ? `<a href="${safeHttpHref(c.source_url)}" target="_blank" rel="noopener noreferrer">来源</a>` : '来源快照'}</p>`).join('')}</details>` : ''}` : '<span class="muted">待每日校准</span>'}</td>
          <td>${esc(dateTime(i.detected_at))}</td>
          <td>${chip(i.status === 'open' ? '未结清（自动重试中）' : i.status, i.status === 'open' ? 'warn' : 'ok')}</td></tr>`).join('')}</tbody></table>`
      : emptyState('没有符合条件的核对差异', '每日自动核对发现差异时会写入此处，由自动重试与重新采集处理'),
  })}
  ${card({
    title: '原件获取与 PDF 补充',
    subtitle: '平台先用官方来源、搜索、抓取和模型自动核验；自动获取或识别受阻时，管理员可补充 PDF 与 OCR 文字。上传文件若不能与官方 URL 的字节哈希匹配，会保留“来源未独立证实”标记。',
    body: documentRows.length ? table({ rows: documentRows, pageSize: 10, columns: [
      { key: 'kind', label: '类别', render: (r) => r.kind === 'policy' ? '政策' : '方法学' },
      { key: 'title', label: '文件' },
      { key: 'archive_parse', label: '原件解析', render: (r) => esc(r.archive_parse || '未归档') },
      { key: 'upload_status', label: '补充状态', render: (r) => esc(r.upload_status === 'official_hash_match' ? '已与官方文件匹配' : r.upload_status ? '管理员副本·来源未核实' : '待补充') },
      { key: 'upload_ai', label: '模型内容核对', render: (r) => esc(r.upload_ai || '—') },
      { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-document-kind="${esc(r.kind)}" data-document-id="${esc(r.id)}">补充 PDF</button>` },
    ], emptyText: '无待补原件' }) : emptyState('暂无待补原件', '自动归档与正文识别均已完成'),
  })}
  ${card({
    title: '数据缺口台账',
    subtitle: '真实缺口如实登记，不掩饰；每项给出**自动处理方式**（平台无人工待办）',
    body: table({
      rows: gaps.gaps || [],
      pageSize: 10,
      columns: [
        { key: 'title', label: '缺口' },
        { key: 'dataset', label: '数据集' },
        { key: 'severity', label: '等级', render: (r) => chip(r.severity, r.severity === 'critical' ? 'danger' : r.severity === 'high' ? 'warn' : '') },
        { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'open' ? 'warn' : 'ok') },
        { key: 'impact', label: '影响' },
        { key: 'auto_action', label: '自动处理方式' },
        { key: 'legacy_manual_path', label: '历史留痕', render: (r) => (r.legacy_manual_path
          ? `<details><summary class="muted">旧流程文案（仅存档）</summary><span class="hint">${esc(truncate(r.legacy_manual_path, 200))}</span></details>`
          : '<span class="muted">—</span>') },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-gap="${esc(r.id)}" data-status="${esc(r.status)}">更新状态</button>` },
      ],
      emptyText: '没有缺口记录',
    }),
    note: '缺口状态为「自动运行状态」：由每日任务自动重试与补全，管理员只维护状态备注，不审批内容。',
  })}`;

  body.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => setQuery({ tab: 'reconciliation', status: el.value })));
  body.querySelector('[data-checks]')?.addEventListener('click', async () => {
    try {
      const out = await api('/api/v2/admin/checks/run', { method: 'POST', body: {} });
      toast(`核对完成：交易 ${out.trade.issues}｜项目 ${out.project.issues}｜政策 ${out.policy.issues}｜因子 ${out.factor.issues}；AI 本次 ${out.ai?.checked ?? 0} 条`, 'ok');
      renderAdmin(document.getElementById('module-root'), state.route);
    } catch (err) {
      toast(err.body?.error || err.message, 'danger');
    }
  });
  body.querySelectorAll('[data-document-kind]').forEach((button) => button.addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', drawer('补充公开 PDF', `
      <p class="hint">请选择已有的公开原件。上传副本会保留 SHA-256、来源与模型核对记录；仅在文件字节与官方链接下载结果完全一致时，才升级为官方原件。</p>
      <label class="fld"><span>PDF 文件（不超过 12 MB）</span><input id="doc-upload-file" type="file" accept=".pdf,application/pdf"></label>
      <label class="fld"><span>可选：扫描 PDF 的 OCR 文字</span><textarea id="doc-upload-text" rows="7" placeholder="只有 PDF 无法提取文字时填写；这段文字会标记为管理员提供，不能替代官方原件证明。"></textarea></label>
      <button class="btn btn-primary" id="doc-upload-submit">上传并自动核对</button>`));
    document.getElementById('doc-upload-submit')?.addEventListener('click', async (event) => {
      const file = document.getElementById('doc-upload-file')?.files?.[0];
      if (!file || file.size > 12 * 1024 * 1024) { toast('请选择不超过 12 MB 的 PDF', 'warn'); return; }
      const submit = event.currentTarget;
      submit.disabled = true;
      try {
        const pdf_base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
          reader.readAsDataURL(file);
        });
        const out = await api('/api/v2/admin/document-upload', { method: 'POST', body: {
          kind: button.dataset.documentKind, id: button.dataset.documentId,
          file_name: file.name, pdf_base64, ocr_text: document.getElementById('doc-upload-text')?.value || '',
        } });
        toast(out.note || '文件已保存并自动核对', out.source_status === 'official_hash_match' ? 'ok' : 'warn');
        document.querySelector('.drawer-backdrop')?.remove();
        document.querySelector('.drawer')?.remove();
        await api('/api/v2/admin/checks/run', { method: 'POST', body: { dataset: button.dataset.documentKind === 'policy' ? 'policy' : 'factor', limit: 10 } });
        renderAdmin(document.getElementById('module-root'), state.route);
      } catch (err) {
        toast(err.body?.error || err.message, 'danger');
      } finally { submit.disabled = false; }
    });
  }));
  body.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-gap]');
    if (g) {
      document.body.insertAdjacentHTML('beforeend', drawer('更新数据缺口状态', `
        <label class="fld"><span>状态</span><select id="gap-status">
          ${['open', 'mitigated', 'closed'].map((x) => `<option value="${x}" ${g.dataset.status === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label class="fld"><span>状态备注（自动补全进展，admin 维护，不审批内容）</span><textarea id="gap-note" rows="4"></textarea></label>
        <button class="btn btn-primary" id="gap-save">保存</button>`));
      document.getElementById('gap-save')?.addEventListener('click', async () => {
        try {
          await api(`/api/v2/admin/gaps/${g.dataset.gap}`, {
            method: 'POST',
            body: { status: document.getElementById('gap-status').value, note: document.getElementById('gap-note').value },
          });
          toast('已更新', 'ok');
          document.querySelector('.drawer-backdrop')?.remove();
          document.querySelector('.drawer')?.remove();
          renderAdmin(document.getElementById('module-root'), state.route);
        } catch (err) {
          toast(err.body?.error || err.message, 'danger');
        }
      });
    }
  });
}

const CHECK_LABEL = {
  amount_relation: '单价/金额关系', cumulative_gap: '累计差分', cumulative_turnover_gap: '累计成交额差分',
  cumulative_monotonic: '累计单调性', missing_trading_day: '交易日行情缺失', stale: '数据陈旧',
  revision_pending: '修订待核', dimension_mismatch: '维度一致性', missing_official_url: '缺官方链接',
  stage_without_event: '阶段缺事件依据', status_regression: '阶段时序倒退', evidence_pending: '证据待核对',
  missing_publish_date: '缺发布日期', missing_attachment: '原件未归档', duplicate: '重复条目',
  placeholder_factor: '占位因子', doc_verification_missing: '缺原文对照台账',
  doc_verification_incomplete: '原文对照未完成，自动测算通道未放行',
  amount_relation_announced: '公示量与登记量关系',
};

/* ------------------------------ 任务与快照 ------------------------------ */

async function renderJobs(body) {
  const [jobs, snaps] = await Promise.all([
    api('/api/v2/admin/jobs?limit=40'),
    api('/api/v2/admin/snapshots?limit=60'),
  ]);
  body.innerHTML = `
  ${card({
    title: '采集任务',
    subtitle: '采集 → 解析 → 规则一致性检查 → 模型自动核验 → 自动发布；失败与部分成功都会留痕',
    body: table({
      rows: jobs.jobs || [],
      pageSize: 10,
      columns: [
        { key: 'job_key', label: '任务' },
        { key: 'title', label: '说明' },
        { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
        { key: 'trigger_kind', label: '触发' },
        { key: 'started_at', label: '开始', render: (r) => esc(dateTime(r.started_at)) },
        { key: 'finished_at', label: '结束', render: (r) => esc(dateTime(r.finished_at)) },
        { key: 'items_found', label: '发现', align: 'right' },
        { key: 'items_published', label: '自动发布', align: 'right' },
        { key: 'error_count', label: '问题', align: 'right' },
        { key: 'data_as_of', label: '数据截至' },
        { key: 'actions', label: '步骤', render: (r) => `<button class="btn btn-xs" data-job="${esc(r.id)}">查看</button>` },
      ],
      emptyText: '尚无任务记录',
    }),
  })}
  ${card({
    title: '各数据集最近成功时间与失败原因',
    subtitle: '增量更新按窗口幂等；每个数据集都记录最近成功时间与失败原因',
    body: table({
      rows: jobs.cursors || [],
      pageSize: 15,
      columns: [
        { key: 'dataset', label: '数据集' },
        { key: 'last_window_from', label: '增量窗口起' },
        { key: 'last_window_to', label: '增量窗口止' },
        { key: 'last_success_at', label: '最近成功', render: (r) => esc(r.last_success_at ? dateTime(r.last_success_at) : '从未成功') },
        { key: 'last_attempt_at', label: '最近尝试', render: (r) => esc(r.last_attempt_at ? dateTime(r.last_attempt_at) : '—') },
        { key: 'last_status', label: '状态', render: (r) => chip(r.last_status || 'never', r.last_status === 'ok' ? 'ok' : r.last_status === 'failed' ? 'danger' : r.last_status === 'partial' ? 'warn' : '') },
        { key: 'items_seen', label: '发现', align: 'right' },
        { key: 'items_new', label: '新增', align: 'right' },
        { key: 'last_error', label: '失败原因', render: (r) => `<span class="muted">${esc(String(r.last_error || '—').slice(0, 90))}</span>` },
      ],
    }),
  })}
  ${card({
    title: '原始快照',
    subtitle: '网页/接口响应按 sha256 留痕，保留抓取时间与解析质量；同 URL 同哈希不重复堆积',
    body: table({
      rows: snaps.snapshots || [],
      pageSize: 15,
      columns: [
        { key: 'fetched_at', label: '抓取时间', render: (r) => esc(dateTime(r.fetched_at)) },
        { key: 'url', label: '地址', render: (r) => `<span class="muted">${esc(String(r.url).slice(0, 70))}</span>` },
        { key: 'http_status', label: 'HTTP', align: 'right' },
        { key: 'content_bytes', label: '字节', align: 'right', render: (r) => num(r.content_bytes) },
        { key: 'content_hash', label: '哈希', render: (r) => `<code>${esc(String(r.content_hash || '').slice(0, 12))}</code>` },
        { key: 'parse_quality', label: '解析', render: (r) => chip(r.parse_quality || '—', r.parse_quality === 'good' ? 'ok' : r.parse_quality === 'failed' ? 'danger' : 'warn') },
        { key: 'error', label: '错误' },
        { key: 'actions', label: '正文', render: (r) => `<button class="btn btn-xs" data-snap="${esc(r.id)}">查看</button>` },
      ],
      emptyText: '尚无快照',
    }) + noteBlock(snaps.note),
  })}`;
  body.addEventListener('click', async (e) => {
    const j = e.target.closest('[data-job]');
    const s = e.target.closest('[data-snap]');
    if (j) {
      const job = await api(`/api/v2/admin/jobs/${j.dataset.job}`);
      document.body.insertAdjacentHTML('beforeend', drawer(`任务步骤：${job.job_key}`, `
        <table class="grid grid-sm"><thead><tr><th>#</th><th>阶段</th><th>目标</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>${(job.steps || []).map((x) => `<tr><td>${x.step_order}</td><td>${esc(x.stage)}</td>
          <td class="muted">${esc(String(x.target || '').slice(0, 60))}</td>
          <td>${chip(x.status, x.status === 'ok' ? 'ok' : x.status === 'failed' ? 'danger' : '')}</td>
          <td>${esc(x.message || '')}</td></tr>`).join('')}</tbody></table>`, { wide: true }));
      return;
    }
    if (s) {
      try {
        const d = await api(`/api/v2/admin/snapshots/${s.dataset.snap}`);
        const snap = d.snapshot;
        document.body.insertAdjacentHTML('beforeend', drawer('原始快照内容', `
          ${kv([['URL', `<a class="link" href="${esc(snap.url)}" target="_blank" rel="noreferrer noopener">${esc(snap.url)}</a>`],
            ['抓取时间', esc(dateTime(snap.fetched_at))], ['HTTP', esc(String(snap.http_status ?? '—'))],
            ['内容类型', esc(snap.content_type || '—')], ['字节', num(snap.content_bytes)],
            ['sha256', `<code>${esc(snap.content_hash || '')}</code>`], ['解析器版本', esc(snap.parser_version || '')],
            ['解析质量', esc(snap.parse_quality || '')], ['错误', esc(snap.error || '—')]])}
          <h5>响应正文（截断显示）</h5>
          <pre class="code">${esc(String(snap.body_text || '（未保存正文）').slice(0, 8000))}</pre>`, { wide: true }));
      } catch (err) {
        toast(err.body?.error || err.message, 'danger');
      }
    }
  });
}

/* ------------------------------ 审计 ------------------------------ */

async function renderAudit(body) {
  const [audit, exports] = await Promise.all([
    api('/api/v2/admin/audit?limit=150'),
    api('/api/v2/admin/exports?limit=100'),
  ]);
  body.innerHTML = `
  ${card({
    title: '操作审计',
    subtitle: '所有会改变判断结果或导出数据的动作都写入审计日志',
    body: table({
      rows: audit.audit || [],
      pageSize: 15,
      columns: [
        { key: 'at', label: '时间', render: (r) => esc(dateTime(r.at)) },
        { key: 'actor', label: '操作人' },
        { key: 'actor_role', label: '角色' },
        { key: 'action', label: '动作' },
        { key: 'object_type', label: '对象' },
        { key: 'object_id', label: '对象 ID', render: (r) => `<span class="muted">${esc(String(r.object_id || '').slice(0, 30))}</span>` },
        { key: 'result', label: '结果', render: (r) => chip(r.result, r.result === 'ok' ? 'ok' : 'danger') },
        { key: 'detail', label: '详情', render: (r) => `<span class="muted">${esc(String(r.detail || '').slice(0, 90))}</span>` },
      ],
      emptyText: '暂无审计记录',
    }),
  })}
  ${card({
    title: '导出审计',
    subtitle: '谁、何时、以什么筛选条件导出了多少行（导出文件含数据截点与口径）',
    body: table({
      rows: exports.exports || [],
      pageSize: 10,
      columns: [
        { key: 'at', label: '时间', render: (r) => esc(dateTime(r.at)) },
        { key: 'actor', label: '导出人' },
        { key: 'actor_role', label: '角色' },
        { key: 'dataset', label: '数据集' },
        { key: 'format', label: '格式' },
        { key: 'row_count', label: '行数', align: 'right' },
        { key: 'filters_json', label: '筛选条件', render: (r) => `<span class="muted">${esc(String(r.filters_json || '').slice(0, 80))}</span>` },
      ],
      emptyText: '暂无导出记录',
    }),
  })}`;
}

function mini(label, value, unit, sub) {
  return `<article class="metric metric-sm">
    <div class="metric-head"><span class="metric-label">${esc(label)}</span></div>
    <div class="metric-value">${typeof value === 'number' ? num(value) : esc(value ?? '—')}<span class="metric-unit">${esc(unit || '')}</span></div>
    <div class="metric-sub">${esc(sub || '')}</div>
  </article>`;
}

/* ==================================================================== */
/*  CEA 配额市场管理                                                    */
/* ==================================================================== */

const CEA_TARGETS = [
  { key: 'json', label: '公开 JSON 通道（行情 / 概览 / 历史价格）', hint: 'querySubStat 精确量额 + queryMarketByDate 综合行情 + dailyov 概览 + hiskline 历史价格' },
  { key: 'daily', label: '日报 HTML 通道', hint: '官方日报页面；目录页动态加载时失败会如实留缺口，不拼接 URL' },
  { key: 'documents', label: '政策与配额文件', hint: '配额分配方案、年度管理工作通知、结转规定、行情编制方案等' },
  { key: 'entities', label: '重点排放单位名录', hint: '省级官方名录；扫描件解析不出行时留缺口，不添加假企业' },
  { key: 'intentions', label: '公开交易意向', hint: 'tradeIntent JSON；意向不计入成交量/成交额' },
  { key: 'research', label: '研报与行业动态', hint: '有界定向发现，取得全文后才入库并核验' },
  { key: 'all', label: '全部（共享同一时间预算依次执行）', hint: '共用 batch_budget_ms，超出预算的步骤留待下一批' },
];

const CEA_AI_LABEL = { verified: '核验通过', insufficient: '证据不足', conflict: '来源冲突', unavailable: '模型不可用', unverified: '未核验' };

/**
 * 收盘后增量的**真实**调度状态行（docs/35 第 7 条）：
 * next_run_at 由服务端实际定时器计算；未排程时明确说明原因，不假装已排程。
 */
function ceaAfterCloseLine(afterClose) {
  if (!afterClose) return '收盘后增量调度状态：未知（服务端未返回）';
  const parts = [];
  if (afterClose.scheduled && afterClose.next_run_beijing) {
    parts.push(`下一次收盘后增量：<b>${esc(afterClose.next_run_beijing)}</b>${afterClose.running ? '（当前正在运行）' : ''}`);
  } else {
    parts.push(`<b>当前未排程</b>${afterClose.env_switch_note ? `：${esc(afterClose.env_switch_note)}` : ''}${afterClose.env_kill_switch ? `：${esc(afterClose.env_kill_switch)}` : ''}`);
  }
  if (afterClose.last_run) {
    const lr = afterClose.last_run;
    parts.push(`上次运行：${esc(dateTime(lr.at))}（${esc(lr.trigger || '')}${lr.error ? `｜失败：${esc(lr.error)}` : ''}）`);
  }
  return parts.join('｜');
}

/**
 * 按 task_id 轮询异步采集任务（docs/35 第 6 条）。
 * 用真实 task_id 查询后端 jobs.tasks；只有拿到真实结果才显示「完成」，
 * 失败必须展示失败原因（error / result_summary.note）。
 */
async function pollCeaTask(box, taskId, target, { intervalMs = 1500, timeoutMs = 180000 } = {}) {
  if (!box) return null;
  const started = Date.now();
  let last = null;
  for (;;) {
    try {
      const data = await api(`/api/v2/admin/cea/jobs?task_id=${encodeURIComponent(taskId)}&limit=5`);
      last = data.task || (data.tasks || []).find((t) => t.task_id === taskId) || null;
      if (last) {
        const s = last.result_summary || {};
        const running = last.status === 'queued' || last.status === 'running';
        box.innerHTML = `
          <div class="callout ${last.status === 'success' ? 'callout-ok' : last.status === 'failed' ? 'callout-danger' : 'callout-warn'}">
            <b>任务 ${esc(last.status)}</b>
            <p>task_id <code>${esc(taskId)}</code>｜目标 <code>${esc(target)}</code>｜已用时 ${num(last.elapsed_ms || (Date.now() - started))} 毫秒${last.job_id ? `｜ingestion_job <code>${esc(last.job_id)}</code>` : ''}</p>
            <p>${running ? '采集仍在后台执行…（进度以真实任务状态为准）' : esc(s.note || last.error || '任务已结束')}</p>
            ${last.error ? `<p class="hint">失败原因：${esc(last.error)}</p>` : ''}
          </div>`;
        if (!running) {
          toast(`CEA 采集：${last.status}`, last.status === 'success' ? 'ok' : last.status === 'failed' ? 'danger' : 'warn');
          return last;
        }
      } else {
        box.innerHTML = loading(`任务 ${esc(taskId)} 尚未出现在服务端任务列表（可能是服务重启）…`);
      }
    } catch (err) {
      box.innerHTML = `${errorState(err)}<p class="hint">轮询失败；任务可能仍在后台运行，可稍后在任务列表查看。</p>`;
      return null;
    }
    if (Date.now() - started > timeoutMs) {
      box.insertAdjacentHTML('beforeend', '<p class="hint">轮询超时：任务仍在后台运行，请稍后查看任务列表。</p>');
      return null;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function ceaResultSummary(out) {
  const scalars = [];
  const lists = [];
  for (const [k, v] of Object.entries(out || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) lists.push(`<li><code>${esc(k)}</code>：${num(v.length)} 项</li>`);
    else if (typeof v === 'object') lists.push(`<li><code>${esc(k)}</code>：对象（见下方原始返回）</li>`);
    else scalars.push([k, String(v)]);
  }
  const failed = Array.isArray(out?.failed) ? out.failed : [];
  return `
    ${scalars.length ? `<div class="kv-grid">${scalars.map(([k, v]) => `<div class="kv-line"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`).join('')}</div>` : ''}
    ${lists.length ? `<ul class="bullets">${lists.join('')}</ul>` : ''}
    ${failed.length ? `<h5>失败明细（${failed.length} 条，真实原因）</h5><ul class="bullets">${failed.slice(0, 12).map((f) => `<li>${esc(f.url || f.date || f.source || f.reason || '—')}：${esc(f.reason || '')} ${esc(f.message || '')}</li>`).join('')}</ul>` : ''}
    ${out?.reused ? `<p class="hint">服务端返回 reused：已有运行中的同类任务，本次请求被合并（未重复外发请求）。</p>` : ''}
    ${out?.truncated ? '<p class="hint">本轮受服务端时间/条数上限截断，剩余条目留待下一批（不是失败）。</p>' : ''}
    ${out?.quota_after ? `<p class="hint">当日抓取配额：已用 ${num(out.quota_after.used)} / ${num(out.quota_after.limit)}，剩余 ${num(out.quota_after.remaining)} 次。</p>` : ''}
    ${out?.ai_verification ? `<p class="hint">自动核验：${out.ai_verification.requested ? (out.ai_verification.provider_configured ? '已调用模型' : '未配置可用模型（条目保持未核验）') : '本轮未开启'}${out.ai_verification.provider_note ? `｜${esc(out.ai_verification.provider_note)}` : ''}</p>` : ''}
    <details><summary>接口原始返回（留痕，未改写）</summary>${ceaJsonBlock(out)}</details>`;
}

function ceaJsonBlock(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  const body = String(text ?? '');
  return `<pre class="code">${esc(body.length > 6000 ? `${body.slice(0, 6000)}\n…（已截断）` : body)}</pre>`;
}

async function renderCeaAdmin(body) {
  const [cfgOut, jobsOut, gapsOut, formOptions, candidateOut] = await Promise.all([
    api('/api/v2/admin/cea/config'),
    api('/api/v2/admin/cea/jobs?limit=20'),
    api('/api/v2/admin/cea/document-gaps'),
    loadFormOptions(api).catch(() => fallbackFormOptions()),
    api('/api/v2/admin/market-candidates?limit=10').catch((e) => ({ __error: e, imports: [], rows: [] })),
  ]);
  const cfg = cfgOut.config || {};
  const defaults = cfgOut.defaults || {};
  const quota = cfgOut.quota || {};
  const sync = cfgOut.sync || {};
  const ai = sync.ai || {};
  const afterClose = cfgOut.after_close || null;
  const gaps = gapsOut.cea || [];
  const adminProvinces = (formOptions.cea.provinces || []).filter((p) => p.value !== '全国');
  const adminYears = formOptions.cea.years.entities.length ? formOptions.cea.years.entities : formOptions.cea.years.all;

  body.innerHTML = `
  <div class="grid-2">
    ${card({
      title: 'CEA 采集配置（实际生效值）',
      subtitle: '保存后立即生效于每日任务与手动采集；所有字段由服务端校验，越界返回 400',
      body: `
        <form id="cea-cfg-form" class="form-grid">
          <div class="quick-adv-grid">
            <label class="fld"><span>CEA 采集总开关</span>
              <select data-cfg="enabled"><option value="true" ${cfg.enabled ? 'selected' : ''}>启用</option><option value="false" ${!cfg.enabled ? 'selected' : ''}>停用</option></select></label>
            <label class="fld"><span>采集后自动核验</span>
              <select data-cfg="auto_verify"><option value="true" ${cfg.auto_verify ? 'selected' : ''}>开启</option><option value="false" ${!cfg.auto_verify ? 'selected' : ''}>关闭</option></select></label>
            <label class="fld"><span>收盘后采集开关</span>
              <select data-cfg="after_close_enabled"><option value="true" ${cfg.after_close_enabled ? 'selected' : ''}>开启</option><option value="false" ${!cfg.after_close_enabled ? 'selected' : ''}>关闭</option></select></label>
            <label class="fld"><span>收盘后采集时刻（HH:MM）</span>
              <input type="time" data-cfg="after_close_time" value="${esc(cfg.after_close_time || '')}"></label>
            <label class="fld"><span>单批时间上限（毫秒）</span>
              <span class="input-unit"><input type="number" data-cfg="batch_budget_ms" value="${esc(String(cfg.batch_budget_ms ?? ''))}" min="5000" max="600000"><i>毫秒</i></span></label>
            <label class="fld"><span>每轮最多新增（条）</span>
              <input type="number" data-cfg="max_items_per_round" value="${esc(String(cfg.max_items_per_round ?? ''))}" min="1" max="8"></label>
            <label class="fld"><span>最多补证轮数</span>
              <input type="number" data-cfg="max_evidence_rounds" value="${esc(String(cfg.max_evidence_rounds ?? ''))}" min="0" max="2"></label>
            <label class="fld"><span>单条请求超时（毫秒）</span>
              <input type="number" data-cfg="request_timeout_ms" value="${esc(String(cfg.request_timeout_ms ?? ''))}" min="3000" max="120000"></label>
            <label class="fld"><span>当日抓取上限（次）</span>
              <input type="number" data-cfg="daily_fetch_limit" value="${esc(String(cfg.daily_fetch_limit ?? ''))}" min="1" max="500"></label>
          </div>
          <p class="form-static">搜索服务 ID：<code>${esc(cfg.search_provider_id || '（自动挑选已启用的服务）')}</code>｜抓取连接 ID：<code>${esc(cfg.fetch_connection_id || '（自动挑选已启用的连接）')}</code>（在「采集连接」页签维护，本页不显示任何凭据）</p>
          <p class="form-static" id="cea-after-close-status">${ceaAfterCloseLine(afterClose)}</p>
          <div class="quick-actions">
            <button class="btn btn-primary" type="submit">保存配置</button>
            <button class="btn" type="button" data-cfg-reset>恢复为服务端默认值</button>
          </div>
          <div id="cea-cfg-msg"></div>
        </form>`,
      note: cfgOut.limits_note || '',
    })}
    ${card({
      title: '服务端硬上限（不可越过）',
      subtitle: `默认值：单批 ${num(defaults.batch_budget_ms)} 毫秒｜每轮 ${num(defaults.max_items_per_round)} 条｜补证 ${num(defaults.max_evidence_rounds)} 轮｜超时 ${num(defaults.request_timeout_ms)} 毫秒｜当日 ${num(defaults.daily_fetch_limit)} 次`,
      body: `
        <ul class="bullets">
          <li>单批时间上限 5000—600000 毫秒（首期建议 ≤120000）</li>
          <li>每轮最多新增 1—8 条；最多补证 0—2 轮（不能用循环次数替代证据）</li>
          <li>单条请求超时 3000—120000 毫秒；当日抓取上限 1—500 次</li>
          <li>来源级开关（enabled_sources）不在本配置内：来源启停由服务端来源登记维护，见「官方数据源」页签</li>
        </ul>
        <div class="metrics metrics-sm">
          ${mini('当日已用抓取', quota.used ?? 0, '次', `上限 ${quota.limit ?? '—'}｜剩余 ${quota.remaining ?? '—'}｜统计日 ${quota.date || '—'}`)}
          ${mini('可用模型', ai.provider_configured ? '可用' : '不可用', '', ai.provider_configured ? `模型 ${ai.model || '已配置'}（不显示凭据）` : (ai.note || '未配置可用模型：条目保持未核验'))}
          ${mini('搜索服务', sync.search?.configured ? '已配置' : '未配置', '', sync.search?.configured ? `${sync.search.name || ''}${sync.search.enabled ? '' : '（已停用）'}` : '未配置搜索服务时研报发现不可用')}
          ${mini('抓取连接', sync.fetch?.configured ? '已配置' : '未配置', '', sync.fetch?.configured ? `${sync.fetch.name || ''}（${sync.fetch.conn_kind || ''}）` : '未配置抓取连接时无法取得全文')}
        </div>`,
    })}
  </div>

  ${card({
    title: '第三方行情候选（独立表，不改官方行情）',
    subtitle: 'CSV/JSON 候选导入 → missing/conflict/match/unsupported 差异报告；保留来源、截至日期与 stale 标志',
    body: `
      <form id="market-candidate-form" class="form-grid">
        <label class="fld"><span>格式</span><select name="format"><option value="csv">CSV</option><option value="json">JSON</option></select></label>
        <label class="fld"><span>来源名称（必填，或填来源链接）</span><input name="source_name" maxlength="120" placeholder="例如 china-ets-mcp 公开数据包"></label>
        <label class="fld"><span>来源链接</span><input name="source_url" maxlength="500" placeholder="https://..."></label>
        <label class="fld"><span>来源截至日期</span><input name="as_of" type="date"></label>
        <label class="fld"><span>文件名（可选）</span><input name="file_name" maxlength="200"></label>
        <label class="fld fld-inline"><span>标记 stale</span><input name="stale" type="checkbox"></label>
        <label class="fld fld-wide"><span>CSV/JSON 内容（≤2MB、≤5000 行）</span><textarea name="text" rows="7" placeholder="trade_date,instrument,unit,volume,turnover,avg_price&#10;2026-03-05,CEA,tCO2e,1000,80000,80"></textarea></label>
        <div class="quick-actions"><button class="btn btn-primary" type="submit">导入候选并生成差异</button>
          <a class="btn btn-sm" href="/api/v2/admin/market-candidates/export?format=csv" download>导出当前候选 CSV</a></div>
        <div id="market-candidate-msg">${candidateOut.__error ? errorState(candidateOut.__error) : '<p class="hint">导入只写候选表；不会修改 cea_trade_daily。</p>'}</div>
      </form>
      <h5>最近导入批次</h5>
      ${(candidateOut.imports || []).length ? table({
        rows: candidateOut.imports,
        pageSize: 8,
        columns: [
          { key: 'source_name', label: '来源' },
          { key: 'format', label: '格式' },
          { key: 'as_of', label: '截至' },
          { key: 'row_count', label: '行数', align: 'right' },
          { key: 'stale', label: 'stale', render: (r) => (r.stale ? chip('stale', 'warn') : '—') },
          { key: 'counts_json', label: '差异', render: (r) => esc(r.counts_json || '—') },
          { key: 'created_at', label: '导入时间', render: (r) => esc(dateTime(r.created_at)) },
          { key: 'actions', label: '导出', render: (r) => `<a class="link" href="/api/v2/admin/market-candidates/export?import_id=${encodeURIComponent(r.id)}&format=csv" download>CSV</a>` },
        ],
      }) : '<p class="muted">暂无候选批次。</p>'}
      <h5>最近候选行（差异逐行保留）</h5>
      ${(candidateOut.rows || []).length ? table({
        rows: candidateOut.rows,
        pageSize: 8,
        columns: [
          { key: 'trade_date', label: '日期' },
          { key: 'instrument', label: '标的' },
          { key: 'volume', label: '成交量', align: 'right' },
          { key: 'turnover', label: '成交额', align: 'right' },
          { key: 'avg_price', label: '均价', align: 'right' },
          { key: 'unit', label: '来源单位' },
          { key: 'diff_status', label: '差异', render: (r) => chip(r.diff_status, r.diff_status === 'match' ? 'ok' : r.diff_status === 'conflict' ? 'danger' : r.diff_status === 'missing' ? 'warn' : 'muted') },
          { key: 'stale', label: 'stale', render: (r) => (r.stale ? chip('stale', 'warn') : '—') },
          { key: 'notes', label: '说明', render: (r) => esc(truncate(r.notes || '—', 70)) },
        ],
      }) : '<p class="muted">暂无候选行。</p>'}
    `,
    note: '官方行情只读比对：候选 match 也不等于官方确认；不以均价补收盘价，不修改官方表。',
  })}

  ${card({
    title: '采集（点击后立即返回，不阻塞界面）',
    subtitle: '采集在服务端执行；返回 task/job_id、结果摘要与失败原因，本页其他操作不受影响',
    body: `
      <div class="filters">
        <label class="fld fld-wide"><span>采集目标</span><select id="cea-target">
          ${CEA_TARGETS.map((t) => `<option value="${t.key}" title="${esc(t.hint)}">${esc(t.label)}</option>`).join('')}
        </select></label>
        <label class="fld"><span>指定交易日（可选，逗号分隔）</span><input type="text" id="cea-dates" placeholder="2026-10-13,2026-10-14"></label>
        <label class="fld"><span>条数上限（可选）</span><input type="number" id="cea-limit" min="1" max="50" placeholder="留空用服务端默认"></label>
        <label class="fld"><span>名录年度（entities 可选）</span><input id="cea-list-year" type="number" min="2000" max="2100" list="cea-collect-year-options" placeholder="选择或输入新年度；留空不限定">${datalistHtml('cea-collect-year-options', adminYears)}</label>
        <label class="fld"><span>省份（entities 可选）</span><select id="cea-province">${selectOptionsHtml(adminProvinces, '', { allLabel: '全部省份' })}</select></label>
        <span class="fld-actions"><button class="btn btn-primary" id="cea-collect-btn">执行采集</button></span>
      </div>
      <p class="hint" id="cea-target-hint">${esc(CEA_TARGETS[0].hint)}</p>
      <div id="cea-collect-out">${emptyState('尚未执行采集', '选择目标后点击「执行采集」；返回结果与失败原因会显示在这里。')}</div>`,
  })}

  ${card({
    title: '任务与日志',
    subtitle: `${(jobsOut.jobs || []).length} 个最近任务｜状态、进度、失败原因与数据集游标`,
    actions: `<button class="btn btn-sm" data-cea-jobs-refresh>刷新</button>
      <span class="muted">僵死任务（>30 分钟未收尾）由服务端在下次开启任务时自动收尾；后台未提供单独的 HTTP 接口，故本页不放置「收尾僵死任务」按钮。</span>`,
    body: `${table({
      rows: jobsOut.jobs || [],
      pageSize: 10,
      columns: [
        { key: 'job_key', label: '任务' },
        { key: 'title', label: '说明', render: (r) => esc(r.title || '—') },
        { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
        { key: 'trigger_kind', label: '触发' },
        { key: 'triggered_by', label: '触发人', render: (r) => esc(r.triggered_by || '—') },
        { key: 'started_at', label: '开始', render: (r) => esc(dateTime(r.started_at)) },
        { key: 'finished_at', label: '结束', render: (r) => esc(dateTime(r.finished_at)) },
        { key: 'items_found', label: '发现', align: 'right' },
        { key: 'items_parsed', label: '解析', align: 'right' },
        { key: 'items_published', label: '入库', align: 'right' },
        { key: 'error_count', label: '问题', align: 'right' },
        { key: 'data_as_of', label: '数据截至' },
        { key: 'actions', label: '进度', render: (r) => `<button class="btn btn-xs" data-cea-job="${esc(r.id)}">查看步骤</button>` },
      ],
      emptyText: '尚无 CEA 任务记录',
      emptyDetail: '执行一次采集后在此显示真实任务、步骤与错误摘要。',
    })}
    <h5>数据集游标（dataset_cursor）</h5>
    ${(jobsOut.cursors || []).length ? table({
      rows: jobsOut.cursors,
      pageSize: 8,
      columns: [
        { key: 'dataset', label: '数据集' },
        { key: 'last_status', label: '最后状态', render: (r) => chip(r.last_status || '—', r.last_status === 'success' ? 'ok' : r.last_status === 'failed' ? 'danger' : 'warn') },
        { key: 'last_attempt_at', label: '最后尝试', render: (r) => esc(dateTime(r.last_attempt_at)) },
        { key: 'last_success_at', label: '最后成功', render: (r) => esc(dateTime(r.last_success_at)) },
        { key: 'items_seen', label: '发现', align: 'right' },
        { key: 'items_new', label: '新增', align: 'right' },
        { key: 'last_error', label: '失败原因', render: (r) => esc(String(r.last_error || '—').slice(0, 80)) },
      ],
    }) : '<p class="muted">暂无游标记录。</p>'}
    <h5>缺口台账（未结清）</h5>
    ${(jobsOut.gaps || []).length ? table({
      rows: jobsOut.gaps,
      pageSize: 8,
      columns: [
        { key: 'gap_key', label: '缺口键', render: (r) => `<code>${esc(String(r.gap_key).slice(0, 44))}</code>` },
        { key: 'title', label: '标题', render: (r) => esc(String(r.title).slice(0, 50)) },
        { key: 'dataset', label: '数据集' },
        { key: 'severity', label: '级别', render: (r) => chip(r.severity || 'normal', r.severity === 'critical' ? 'danger' : r.severity === 'warning' ? 'warn' : 'muted') },
        { key: 'impact', label: '影响', render: (r) => esc(String(r.impact || '—').slice(0, 70)) },
      ],
    }) : '<p class="muted">没有未结清缺口。</p>'}`,
  })}

  ${card({
    title: 'PDF 原件补充（扫描件 / 缺原件）',
    subtitle: `${gaps.length} 个 CEA 文件需要补充可读原件或 OCR 文字`,
    body: `${gaps.length ? table({
      rows: gaps,
      pageSize: 8,
      columns: [
        { key: 'title', label: '文件', render: (r) => esc(String(r.title).slice(0, 46)) },
        { key: 'doc_number', label: '文号', render: (r) => esc(r.doc_number || '—') },
        { key: 'evidence_level', label: '证据等级', render: (r) => chip(r.evidence_level, r.evidence_level === 'full_text' ? 'ok' : 'warn') },
        { key: 'upload_status', label: '上传层级', render: (r) => (r.upload_status === 'official_hash_match' ? chip('与官方字节一致', 'ok') : r.upload_status === 'admin_supplied_unverified' ? chip('仅管理员副本', 'warn') : '<span class="muted">未上传</span>') },
        { key: 'upload_parse', label: '解析质量', render: (r) => esc(r.upload_parse || '—') },
        { key: 'upload_ai', label: '模型结论', render: (r) => esc(CEA_AI_LABEL[r.upload_ai] || r.upload_ai || '—') },
        { key: 'reason', label: '为什么需要补充', render: (r) => esc(String(r.reason || '').slice(0, 80)) },
      ],
      emptyText: '当前没有需要补充原件的 CEA 文件',
    }) : '<p class="muted">当前没有需要补充原件的 CEA 文件。</p>'}
    <form id="cea-upload-form" class="form-grid">
      <div class="quick-adv-grid">
        <label class="fld fld-wide"><span>目标 CEA 文件</span><select id="cea-upload-id">
          ${gaps.length ? gaps.map((g) => `<option value="${esc(g.id)}">${esc(String(g.title).slice(0, 40))}${g.doc_number ? `（${esc(g.doc_number)}）` : ''}</option>`).join('') : '<option value="">（暂无可补充的文件）</option>'}
        </select></label>
        <label class="fld"><span>文件（PDF，≤12 MB）</span><input type="file" id="cea-upload-file" accept="application/pdf,.pdf"></label>
        <label class="fld"><span>文件名（自动填充，可修改）</span><input type="text" id="cea-upload-name" placeholder="document.pdf"></label>
        <label class="fld fld-wide"><span>OCR 文字（可选，扫描件无文本层时使用）</span><textarea id="cea-upload-ocr" rows="4" placeholder="粘贴与 PDF 一致的正文文字；没有正文时会如实记为解析失败，不凭元数据伪造正文"></textarea></label>
      </div>
      <div class="quick-actions">
        <button class="btn btn-primary" type="submit" ${gaps.length ? '' : 'disabled'}>上传并核验</button>
        <button class="btn" type="button" id="cea-retry-uploads">重试未核验的补充文件</button>
        <span class="hint">前端限制文件 ≤12MB；上传后服务端会下载官方 URL 比对字节，只有完全一致才提升为 official_hash_match。</span>
      </div>
      <div id="cea-upload-msg"></div>
    </form>`,
    note: gapsOut.note || '',
  })}

  ${card({
    title: '手动核验（真实调用已配置模型）',
    subtitle: '未配置可用模型时结果为 unavailable，不会伪造 verified',
    body: `
      <div class="filters">
        <label class="fld"><span>对象类型</span><select id="cea-verify-type">
          <option value="cea_trade_daily">CEA 行情（cea_trade_daily）</option>
          <option value="cea_document">CEA 文件（cea_document）</option>
        </select></label>
        <label class="fld fld-wide"><span>对象 ID</span><input type="search" id="cea-verify-id" placeholder="如 CEATD... / CEADOC..."></label>
        <label class="fld"><span>强制重新核验</span><select id="cea-verify-force"><option value="false">否（已有结论则跳过）</option><option value="true">是（force）</option></select></label>
        <span class="fld-actions">
          <button class="btn btn-sm" id="cea-verify-one">核验指定条目</button>
          <button class="btn btn-sm" id="cea-verify-docs">核验待核验文件（documents）</button>
        </span>
      </div>
      <div id="cea-verify-out">${emptyState('尚未执行核验', '选择对象后点击按钮；返回结果与不可用原因会显示在这里。')}</div>`,
    note: '核验只标注证据一致性，不改写官方数值，也不代表主管部门确认。',
  })}`;

  /* ---------------- 配置表单 ---------------- */
  const cfgForm = body.querySelector('#cea-cfg-form');
  cfgForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = body.querySelector('#cea-cfg-msg');
    const payload = {};
    cfgForm.querySelectorAll('[data-cfg]').forEach((el) => {
      const key = el.dataset.cfg;
      if (key === 'enabled') payload[key] = el.value === 'true';
      else if (el.tagName === 'SELECT') payload[key] = el.value;
      else if (['batch_budget_ms', 'max_items_per_round', 'max_evidence_rounds', 'request_timeout_ms', 'daily_fetch_limit'].includes(key)) payload[key] = Number(el.value);
      else payload[key] = el.value;
    });
    msg.innerHTML = loading('正在保存…');
    try {
      const out = await api('/api/v2/admin/cea/config', { method: 'POST', body: payload });
      msg.innerHTML = `<div class="callout callout-ok"><b>已保存</b><p>服务端返回的实际生效值：单批 ${num(out.config?.batch_budget_ms)} 毫秒｜每轮 ${num(out.config?.max_items_per_round)} 条｜补证 ${num(out.config?.max_evidence_rounds)} 轮｜当日抓取 ${num(out.config?.daily_fetch_limit)} 次｜开关 ${out.config?.enabled ? '启用' : '停用'}。</p></div>`;
      // 开关/时间改动后，用服务端返回的**真实**下一次运行时间刷新（不是配置回显）
      const statusEl = body.querySelector('#cea-after-close-status');
      if (statusEl && out.after_close) statusEl.innerHTML = ceaAfterCloseLine(out.after_close);
      toast('CEA 采集配置已保存', 'ok');
    } catch (err) {
      // 显示后端 400 的中文校验文案，不自行改写
      msg.innerHTML = errorState(err);
    }
  });
  body.querySelector('[data-cfg-reset]')?.addEventListener('click', () => {
    cfgForm.querySelectorAll('[data-cfg]').forEach((el) => {
      const key = el.dataset.cfg;
      if (defaults[key] === undefined) return;
      if (el.tagName === 'SELECT') el.value = defaults[key] ? 'true' : 'false';
      else el.value = String(defaults[key]);
    });
    toast('已填入服务端默认值，点击「保存配置」后才会生效', 'info');
  });

  /* ---------------- 采集 ---------------- */
  const targetSel = body.querySelector('#cea-target');
  targetSel?.addEventListener('change', () => {
    const t = CEA_TARGETS.find((x) => x.key === targetSel.value);
    body.querySelector('#cea-target-hint').textContent = t?.hint || '';
  });
  body.querySelector('#cea-collect-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const outBox = body.querySelector('#cea-collect-out');
    const target = targetSel.value;
    const datesRaw = body.querySelector('#cea-dates').value.trim();
    const limitRaw = body.querySelector('#cea-limit').value.trim();
    const listYearRaw = body.querySelector('#cea-list-year').value.trim();
    const province = body.querySelector('#cea-province').value.trim();
    const payload = { target };
    if (datesRaw) payload.dates = datesRaw.split(/[,，\s]+/).filter(Boolean);
    if (limitRaw) payload.limit = Number(limitRaw);
    if (listYearRaw) payload.list_year = Number(listYearRaw);
    if (province) payload.province = province;
    btn.disabled = true;
    btn.textContent = '采集中…';
    outBox.innerHTML = loading(`已提交采集请求（target=${target}）…`);
    try {
      // 202 立即返回 task_id；随后按**实际 task_id** 轮询真实进度（不再等 120 秒被反代超时）
      const accepted = await api('/api/v2/admin/cea/collect', { method: 'POST', body: payload });
      const taskId = accepted.task_id;
      outBox.innerHTML = `
        <div class="callout ${accepted.merged ? 'callout-warn' : 'callout-ok'}"><b>${accepted.merged ? '已合并到运行中的任务' : '已受理（HTTP 202）'}</b>
          <p>目标 <code>${esc(target)}</code>｜task_id <code>${esc(taskId)}</code>｜状态 <b>${esc(accepted.status || 'queued')}</b>${accepted.message ? `<br>${esc(accepted.message)}` : ''}</p>
          <p class="hint">采集在服务端后台有界执行（受批次时间上限与当日配额约束），本页轮询真实进度；期间可继续操作其他页面。</p></div>
        <div id="cea-task-live">${loading('等待任务开始…')}</div>`;
      await pollCeaTask(outBox.querySelector('#cea-task-live'), taskId, target);
    } catch (err) {
      outBox.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '执行采集';
    }
  });

  body.querySelector('[data-cea-jobs-refresh]')?.addEventListener('click', () => renderCeaAdmin(body));

  /* ---------------- 任务步骤 ---------------- */
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cea-job]');
    if (!b) return;
    try {
      const d = await api(`/api/v2/admin/cea/jobs/${b.dataset.ceaJob}`);
      const job = d.job || {};
      document.body.insertAdjacentHTML('beforeend', drawer(`CEA 任务：${job.job_key || ''}`, `
        ${kv([
          ['状态', chip(job.status, job.status === 'success' ? 'ok' : job.status === 'failed' ? 'danger' : 'warn')],
          ['触发', esc(job.trigger_kind || '—')],
          ['触发人', esc(job.triggered_by || '—')],
          ['开始 / 结束', `${esc(dateTime(job.started_at))} / ${esc(dateTime(job.finished_at))}`],
          ['发现 / 解析 / 入库', `${num(job.items_found)} / ${num(job.items_parsed)} / ${num(job.items_published)}`],
          ['问题数', num(job.error_count)],
          ['数据截至', esc(job.data_as_of || '—')],
          ['错误摘要', esc(job.error_summary || '—')],
        ])}
        <h5>步骤</h5>
        <table class="grid grid-sm"><thead><tr><th>#</th><th>阶段</th><th>目标</th><th>状态</th><th>数量</th><th>说明</th><th>时间</th></tr></thead>
        <tbody>${(d.steps || []).map((s) => `<tr><td>${s.step_order}</td><td>${esc(s.stage)}</td>
          <td class="muted">${esc(String(s.target || '').slice(0, 60))}</td>
          <td>${chip(s.status, s.status === 'ok' ? 'ok' : s.status === 'failed' ? 'danger' : '')}</td>
          <td class="ta-r">${num(s.items)}</td><td>${esc(s.message || '')}</td>
          <td class="muted">${esc(dateTime(s.finished_at || s.started_at))}</td></tr>`).join('')}</tbody></table>
        <h5>任务详情（detail_json，含缺口与截断原因）</h5>
        ${ceaJsonBlock(d.detail)}`, { wide: true }));
    } catch (err) {
      toast(err.body?.error || err.message, 'danger');
    }
  });

  /* ---------------- PDF 上传 ---------------- */
  const fileInput = body.querySelector('#cea-upload-file');
  fileInput?.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    body.querySelector('#cea-upload-name').value = f.name;
    const msg = body.querySelector('#cea-upload-msg');
    if (f.size > 12 * 1024 * 1024) {
      msg.innerHTML = `<div class="callout callout-danger"><b>文件过大</b><p>所选文件 ${num(f.size)} 字节，超过前端 12 MB 限制。请先压缩或拆分后再上传。</p></div>`;
    } else {
      msg.innerHTML = `<p class="hint">已选择 ${esc(f.name)}（${num(f.size)} 字节）。</p>`;
    }
  });
  body.querySelector('#cea-upload-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = body.querySelector('#cea-upload-msg');
    const id = body.querySelector('#cea-upload-id').value;
    const file = fileInput.files?.[0];
    const fileName = body.querySelector('#cea-upload-name').value.trim() || file?.name || 'document.pdf';
    const ocrText = body.querySelector('#cea-upload-ocr').value.trim();
    if (!id) { msg.innerHTML = errorState({ status: 400, body: { error: '请选择需要补充原件的 CEA 文件（当前列表为空）' } }); return; }
    if (!file) { msg.innerHTML = errorState({ status: 400, body: { error: '请选择 PDF 文件' } }); return; }
    if (file.size > 12 * 1024 * 1024) { msg.innerHTML = errorState({ status: 400, body: { error: `文件超过 12 MB 上限（${num(file.size)} 字节），请在本地压缩后再上传` } }); return; }
    msg.innerHTML = loading('正在读取文件并上传…（大文件需要一点时间）');
    try {
      const pdfBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('文件读取失败，请重试'));
        reader.readAsDataURL(file);
      });
      const out = await api('/api/v2/admin/cea/upload', {
        method: 'POST',
        body: { id, file_name: fileName, pdf_base64: pdfBase64, ocr_text: ocrText || undefined },
      });
      const srcLabel = out.source_status === 'official_hash_match'
        ? '与官方 URL 下载字节完全一致（official_hash_match）'
        : '仅管理员副本，来源未独立证实（admin_supplied_unverified）';
      msg.innerHTML = `
        <div class="callout ${out.source_status === 'official_hash_match' ? 'callout-ok' : 'callout-warn'}">
          <b>上传结果</b>
          <p>来源层级：${esc(srcLabel)}</p>
          <p>解析质量：${esc(out.parse_quality || '—')}｜正文来源：${esc(out.text_source === 'pdf_extract' ? 'PDF 文本提取' : out.text_source === 'admin_transcript' ? '管理员提供的 OCR 文字' : '无可用正文')}</p>
          <p>模型结论：${esc(CEA_AI_LABEL[out.ai_result] || out.ai_result || '—')}${out.ai_summary ? `｜${esc(out.ai_summary)}` : ''}</p>
          <p class="hint">文件哈希：<code>${esc(String(out.file_hash || '').slice(0, 24))}…</code>｜上传 ID：<code>${esc(out.id || '')}</code></p>
          <p class="hint">${esc(out.note || '')}</p>
        </div>`;
      toast('上传完成，已在服务端核验', out.source_status === 'official_hash_match' ? 'ok' : 'warn');
    } catch (err) {
      msg.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    }
  });
  body.querySelector('#cea-retry-uploads')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const msg = body.querySelector('#cea-upload-msg');
    btn.disabled = true;
    btn.textContent = '重试中…';
    try {
      const out = await api('/api/v2/admin/cea/retry-uploads', { method: 'POST', body: { limit: 20 } });
      msg.innerHTML = `<div class="callout"><b>重试完成</b><p>已检查 ${num(out.checked)} 个补充文件，其中仍不可用 ${num(out.unavailable)} 个。</p><p class="hint">${esc(out.note || '')}</p></div>`;
      toast(`重试完成：检查 ${out.checked ?? 0} 个，仍不可用 ${out.unavailable ?? 0} 个`, out.unavailable ? 'warn' : 'ok');
    } catch (err) {
      msg.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '重试未核验的补充文件';
    }
  });

  /* ---------------- 手动核验 ---------------- */
  const verifyOut = body.querySelector('#cea-verify-out');
  body.querySelector('#cea-verify-one')?.addEventListener('click', async () => {
    const objectType = body.querySelector('#cea-verify-type').value;
    const objectId = body.querySelector('#cea-verify-id').value.trim();
    const force = body.querySelector('#cea-verify-force').value === 'true';
    if (!objectId) { verifyOut.innerHTML = errorState({ status: 400, body: { error: '请填写要核验的对象 ID' } }); return; }
    verifyOut.innerHTML = loading('正在核验…（调用已配置模型，可能耗时数秒）');
    try {
      const out = await api('/api/v2/admin/cea/verify', { method: 'POST', body: { object_type: objectType, object_id: objectId, force } });
      verifyOut.innerHTML = `<div class="callout ${out.result === 'verified' ? 'callout-ok' : out.result === 'conflict' ? 'callout-danger' : 'callout-warn'}">
        <b>核验结果：${esc(CEA_AI_LABEL[out.result] || out.result || '—')}</b>
        <p>${esc(out.summary || out.message || '')}</p>
        <p class="hint">对象 ${esc(objectType)}｜${esc(objectId)}｜模型 ${esc(out.model || out.model_used || '—')}｜引文 ${num((out.citations || []).length)} 条</p>
        ${(out.citations || []).length ? `<ul class="bullets">${out.citations.slice(0, 6).map((c) => `<li>〔${esc(c.kind || '')}〕${esc(String(c.quote || '').slice(0, 140))}</li>`).join('')}</ul>` : '<p class="hint">没有可在原文中定位的引文：不据此判定为已核验。</p>'}
        <details><summary>接口原始返回</summary>${ceaJsonBlock(out)}</details></div>`;
    } catch (err) {
      verifyOut.innerHTML = errorState(err);
    }
  });
  body.querySelector('#cea-verify-docs')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '核验中…';
    verifyOut.innerHTML = loading('正在核验待核验的 CEA 文件…');
    try {
      const out = await api('/api/v2/admin/cea/verify', { method: 'POST', body: { target: 'documents', limit: 8 } });
      verifyOut.innerHTML = `<div class="callout"><b>批量核验返回</b>
        <p>已核验 ${num(out.verified ?? out.checked ?? 0)} 条${out.unavailable !== undefined ? `｜模型不可用 ${num(out.unavailable)} 条` : ''}</p>
        <details><summary>接口原始返回</summary>${ceaJsonBlock(out)}</details></div>`;
      toast('批量核验完成', 'ok');
    } catch (err) {
      verifyOut.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '核验待核验文件（documents）';
    }
  });

  /* ---------------- 第三方行情候选 ---------------- */
  body.querySelector('#market-candidate-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const msg = body.querySelector('#market-candidate-msg');
    const f = new FormData(form);
    const payload = {
      format: f.get('format') || 'csv',
      text: f.get('text') || '',
      source_name: f.get('source_name') || null,
      source_url: f.get('source_url') || null,
      as_of: f.get('as_of') || null,
      file_name: f.get('file_name') || null,
      stale: f.get('stale') === 'on',
    };
    if (!String(payload.text).trim()) { msg.innerHTML = errorState({ status: 400, body: { error: '请粘贴 CSV/JSON 内容' } }); return; }
    msg.innerHTML = loading('正在校验并生成差异报告…（不修改官方行情）');
    try {
      const out = await api('/api/v2/admin/market-candidates/import', { method: 'POST', body: payload });
      const c = out.counts || {};
      msg.innerHTML = `<div class="callout ${c.conflict ? 'callout-warn' : 'callout-ok'}">
        <b>导入完成：${num(out.row_count)} 行</b>
        <p>match ${num(c.match)}｜conflict ${num(c.conflict)}｜missing ${num(c.missing)}｜unsupported ${num(c.unsupported)}｜stale ${num(c.stale)}</p>
        <p class="hint">${esc(out.note || '')}</p>
        <a class="link" href="/api/v2/admin/market-candidates/export?import_id=${encodeURIComponent(out.import_id)}&format=csv" download>下载本次差异 CSV</a>
      </div>`;
      toast('候选已导入，官方行情未修改', c.conflict ? 'warn' : 'ok');
    } catch (err) {
      msg.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    }
  });
}

/* ==================================================================== */
/*  PDF 解析 / OCR                                                      */
/* ==================================================================== */

/** OCR 错误分类的中文标签（与服务端 ERROR_CATEGORY_LABEL 保持同一语义） */
const OCR_CATEGORY_LABEL = {
  auth: '鉴权失败', quota: '额度/配额不足', permission: '无接口权限', param: '参数或文件不合法',
  busy: '并发超限', server: '服务端错误', network: '网络失败', timeout: '超时',
  not_configured: '未配置凭据', limit: '超出接口限制', unsupported: '该模式未支持', unknown: '未知错误',
};

const OCR_CANDIDATE_LABEL = {
  policy_attachment: '政策附件', policy_document: '政策原件',
  methodology_version: '方法学原件', cea_document: 'CEA 文件',
};

function ocrCategoryChip(category) {
  if (!category) return '<span class="muted">—</span>';
  const kind = category === 'auth' || category === 'permission' ? 'danger'
    : category === 'quota' || category === 'timeout' || category === 'limit' ? 'warn' : '';
  return chip(OCR_CATEGORY_LABEL[category] || category, kind);
}

async function renderOcrAdmin(body) {
  const [cfgOut, gapsOut, statusOut, vs, vt] = await Promise.all([
    api('/api/v2/admin/ocr/config'),
    api('/api/v2/admin/ocr/gaps?limit=100'),
    api('/api/v2/admin/ocr/status'),
    api('/api/v2/admin/vision/status?limit=10').catch(() => ({ pages: [], totals: {}, limits: {} })),
    api('/api/v2/admin/vision/tooling').catch(() => ({ tooling: {} })),
  ]);
  const cfg = cfgOut.backfill || {};
  const quota = cfgOut.quota || {};
  const stats = cfgOut.stats || {};
  const candidates = gapsOut.candidates || [];
  const rejected = gapsOut.rejected || [];
  const tasks = statusOut.tasks || [];
  const cursor = statusOut.cursor || {};
  const ready = gapsOut.ocr_ready || {};

  body.innerHTML = `
  <div class="callout ${cfgOut.credential_configured ? 'callout-ok' : 'callout-warn'}">
    <b>百度 OCR：${cfgOut.credential_configured ? '凭据已配置' : '凭据未配置'}｜生效模式：${esc((cfgOut.modes || []).find((m) => m.key === cfgOut.mode)?.label || cfgOut.mode || '—')}</b>
    <p>${cfgOut.credential_configured
      ? `凭据来源：${esc(cfgOut.credential_source || '—')}（接口只返回「是否已配置」，绝不返回密钥或密文）。`
      : esc(cfgOut.credential_hint || '尚未配置凭据：补跑只能解析文本层，缺文字页保持缺口。')}</p>
    <p class="hint">${esc(cfgOut.endpoint?.note || '')}${ready.ready === false ? `<br>当前不可自动补跑：${esc(ready.reason || '')}` : ''}</p>
  </div>

  <div class="grid-2">
    ${card({
      title: 'OCR 配置（实际生效值）',
      subtitle: '保存后立即生效；所有字段由服务端校验，越界返回 400。留空密钥表示保留原凭据，只有勾选「清除凭据」才会删除。',
      body: `
        <form id="ocr-cfg-form" class="form-grid">
          <div class="quick-adv-grid">
            <label class="fld"><span>OCR 总开关</span>
              <select data-ocr="enabled"><option value="true" ${cfgOut.enabled ? 'selected' : ''}>启用</option><option value="false" ${!cfgOut.enabled ? 'selected' : ''}>停用</option></select></label>
            <label class="fld"><span>接口模式</span>
              <select data-ocr="mode">
                ${(cfgOut.modes || []).map((m) => `<option value="${esc(m.key)}" ${cfgOut.mode === m.key ? 'selected' : ''} ${m.available ? '' : 'disabled'}>${esc(m.label)}${m.available ? '' : '（不可用）'}</option>`).join('')}
              </select></label>
            <label class="fld"><span>单条请求超时（毫秒）</span>
              <span class="input-unit"><input type="number" data-ocr="request_timeout_ms" value="${esc(String(cfgOut.request_timeout_ms ?? ''))}" min="3000" max="120000"><i>毫秒</i></span></label>
            <label class="fld"><span>单批时间上限（毫秒）</span>
              <span class="input-unit"><input type="number" data-ocr="batch_budget_ms" value="${esc(String(cfgOut.batch_budget_ms ?? ''))}" min="5000" max="600000"><i>毫秒</i></span></label>
            <label class="fld"><span>当日页数配额（按实际尝试计数）</span>
              <input type="number" data-ocr="daily_page_limit" value="${esc(String(cfgOut.daily_page_limit ?? ''))}" min="1" max="20000"></label>
            <label class="fld"><span>当日文档数配额</span>
              <input type="number" data-ocr="daily_doc_limit" value="${esc(String(cfgOut.daily_doc_limit ?? ''))}" min="1" max="2000"></label>
            <label class="fld"><span>单文档最多解析页数</span>
              <input type="number" data-ocr="max_pages_per_doc" value="${esc(String(cfgOut.max_pages_per_doc ?? ''))}" min="1" max="500"></label>
            <label class="fld"><span>单页视为「缺文字」的字数下限</span>
              <input type="number" data-ocr="ocr_min_chars" value="${esc(String(cfgOut.ocr_min_chars ?? ''))}" min="1" max="200"></label>
            <label class="fld"><span>API Key（留空=保留原值）</span>
              <input type="password" data-ocr="api_key" autocomplete="new-password" placeholder="不显示、不回填，保存后接口只返回「已配置」"></label>
            <label class="fld"><span>Secret Key（留空=保留原值）</span>
              <input type="password" data-ocr="secret_key" autocomplete="new-password" placeholder="两个字段须同时填写才覆盖"></label>
            <label class="fld"><span>清除已存凭据</span>
              <select id="ocr-clear-credentials"><option value="false">否（保留原凭据）</option><option value="true">是（删除已存凭据，不可恢复）</option></select></label>
          </div>
          <p class="form-static">解析器记录版本：<code>${esc(cfgOut.parser_version || '—')}</code>｜OCR 结果目录：<code>${esc(statusOut.ocr_root || '')}</code></p>
          <p class="form-static">受限根（只允许这两个目录下的 PDF）：<code>${esc((statusOut.roots || []).join('  |  '))}</code></p>
          <div class="quick-actions">
            <button class="btn btn-primary" type="submit">保存配置</button>
            <button class="btn" type="button" id="ocr-test">测试真实连接（1 页，会计费）</button>
            <button class="btn" type="button" id="ocr-probe">探测文档解析权限</button>
          </div>
          <div id="ocr-cfg-msg"></div>
        </form>`,
      note: cfgOut.limits_note || '',
    })}
    ${card({
      title: '配额与统计',
      subtitle: '配额按**实际发出的 HTTP 尝试**计数（重试与失败同样计数）；缓存命中不重复计费。',
      body: `
        <div class="metrics metrics-sm">
          ${mini('当日已用页数', quota.pages_attempted ?? 0, '页', `上限 ${quota.pages_limit ?? '—'}｜剩余 ${quota.pages_remaining ?? '—'}｜统计日 ${quota.date || '—'}`)}
          ${mini('当日已用文档', quota.docs_attempted ?? 0, '个', `上限 ${quota.docs_limit ?? '—'}｜剩余 ${quota.docs_remaining ?? '—'}`)}
          ${mini('累计成功页 / 失败页', `${num(stats.pages_ok)} / ${num(stats.pages_failed)}`, '', `鉴权请求 ${num(quota.token_requests)} 次｜token 刷新 ${num(stats.token_refreshes)} 次｜110/111 重试 ${num(stats.auth_retry_once)} 次`)}
          ${mini('缓存命中页', stats.cache_hits ?? 0, '页', `最近成功 ${dateTime(stats.last_success_at)}`)}
        </div>
        ${stats.last_error
          ? `<div class="callout callout-warn"><b>最近一次失败：${esc(OCR_CATEGORY_LABEL[stats.last_category] || stats.last_category || '—')}</b><p>${esc(stats.last_error)}</p><p class="hint">${esc(dateTime(stats.last_error_at))}</p></div>`
          : '<p class="hint">本次统计周期内没有失败记录。</p>'}`,
    })}
  </div>

  ${card({
    title: 'DeepSeek Flash 视觉补充（指定页）',
    subtitle: '文本层与百度 OCR 优先；视觉补充只作为模型理解材料，不伪造“已解析”，也不改写正式因子',
    body: `
      <div class="callout ${vt.tooling?.available && vs.capability?.enabled ? 'callout-ok' : 'callout-warn'}">
        <b>能力：${vs.capability?.enabled ? '已启用' : '未启用'}｜页图工具：${vt.tooling?.available ? '可用' : '不可用'}</b>
        <p>${esc(vt.tooling?.version || vt.tooling?.error || '未检测到 pdftoppm')}</p>
        <p class="hint">${esc(vs.capability?.binding_hint || vt.agent_hint || '请在「DeepSeek 能力」页绑定官方模型并启用视觉补充。')}</p>
      </div>
      <form id="vision-form" class="form-grid">
        <label class="fld"><span>受限根内已有 PDF 的对象</span><select name="target" required>
          ${candidates.map((c) => `<option value="${esc(c.kind)}|${esc(c.id)}">${esc(OCR_CANDIDATE_LABEL[c.kind] || c.kind)}｜${esc(String(c.title || c.id).slice(0, 34))}</option>`).join('')}
        </select><small>只允许「PDF 解析/OCR」候选中列出的受限根对象；也可对已有正文的对象在后台补跑后再试。</small></label>
        <label class="fld"><span>物理页码（从 1 起）</span><input name="page" type="number" min="1" max="500" value="1" required></label>
        <label class="fld"><input name="apply" type="checkbox" checked> 识别成功后将本页并入逐页正文（仍标为视觉补充/部分）</label>
        <div class="quick-actions"><button class="btn btn-primary" type="submit" ${candidates.length ? '' : 'disabled'}>识别指定页</button>
          <span class="hint">会真实调用 deepseek-flash，按能力预算计费；同文档默认最多 ${num(vs.limits?.max_pages_per_doc || 3)} 页。</span></div>
      </form>
      <div id="vision-out">${(vs.pages || []).length ? `<p class="hint">最近视觉结果：${vs.pages.slice(0, 3).map((p) => `${esc(p.object_kind)} 第 ${num(p.page)} 页（${esc(p.status)}）`).join('；')}</p>` : emptyState('尚无视觉补充记录', '识别结果会保留原件 hash、物理页码、图像 hash、模型与限制说明。')}</div>`,
  })}

  ${card({
    title: '文档解析（异步接口）能力状态',
    subtitle: '未通过真实能力探测前不允许作为生效模式；不自动切换付费服务，也不伪实现。',
    body: `
      <div class="metrics metrics-sm">
        ${mini('能力状态', cfgOut.doc_parser_state || 'unsupported', '', cfgOut.doc_parser_note || '')}
        ${mini('最近探测时间', cfgOut.doc_parser_checked_at ? dateTime(cfgOut.doc_parser_checked_at) : '未探测', '', '点击上方「探测文档解析权限」发起一次真实提交')}
      </div>
      <ul class="bullets">
        <li>提交 <code>POST /rest/2.0/brain/online/v2/parser/task</code>（表单 <code>file_data</code> / <code>file_name</code> / <code>page_filter</code>，页码从 <b>0</b> 起）</li>
        <li>查询 <code>/task/query</code>（<code>task_id</code>）：pending / running 按 5 秒轮询，成功后取 <code>parse_result_url</code> 的 <code>pages[].page_num</code>（同样从 0 起）与 <code>text</code> / <code>tables</code></li>
        <li>返回链接必须是 HTTPS 的百度官方对象存储域名，并经过私网/重定向保护；<b>签名 URL 不原样输出</b>，页面只显示脱敏域名</li>
      </ul>`,
    note: '经典高精度接口（accurate_basic）与本接口的页码约定不同（1 起 / 0 起），实现中不混用响应字段。',
  })}

  ${card({
    title: '历史补跑：真实缺正文的本地 PDF',
    subtitle: `${candidates.length} 个对象落在受限根内且确实缺正文${rejected.length ? `｜${rejected.length} 个越界/不合格条目已拒绝` : ''}`,
    actions: `<button class="btn btn-sm" id="ocr-refresh">刷新</button>`,
    body: `${candidates.length ? table({
      rows: candidates,
      pageSize: 8,
      columns: [
        { key: 'kind', label: '类型', render: (r) => chip(OCR_CANDIDATE_LABEL[r.kind] || r.kind, 'muted') },
        { key: 'title', label: '对象', render: (r) => esc(String(r.title || '').slice(0, 40)) },
        { key: 'id', label: '对象 ID', render: (r) => `<code>${esc(String(r.id).slice(0, 22))}</code>` },
        { key: 'reason', label: '为什么缺正文', render: (r) => esc(String(r.reason || '').slice(0, 70)) },
        { key: 'local_path', label: '受限根内原件', render: (r) => `<span class="muted">${esc(String(r.local_path || '').slice(-46))}</span>` },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-ocr-reparse="${esc(r.kind)}|${esc(r.id)}">重解析</button>` },
      ],
      emptyText: '当前没有需要补跑的 PDF 原件',
    }) : '<p class="muted">受限根内没有「本地有 PDF 原件但缺正文」的对象。网页已有可核对正文（HTML full_text）的对象不会出现在这里。</p>'}
    ${rejected.length ? `<details><summary>被拒绝的条目（${rejected.length}）——路径越界/非 PDF 原件一律不处理</summary>
      <table class="grid grid-sm"><thead><tr><th>类型</th><th>对象 ID</th><th>拒绝原因</th></tr></thead>
      <tbody>${rejected.slice(0, 20).map((r) => `<tr><td>${esc(OCR_CANDIDATE_LABEL[r.kind] || r.kind)}</td><td><code>${esc(String(r.id).slice(0, 22))}</code></td><td>${esc(r.reject_reason || '')}</td></tr>`).join('')}</tbody></table></details>` : ''}
    <div class="quick-actions" style="margin-top:10px">
      <button class="btn btn-primary" id="ocr-backfill">开始补跑（单并发，202 受理）</button>
      <button class="btn" id="ocr-daily">执行一次每日有界补跑</button>
      <span class="hint">补跑只读取受限根内的 PDF；解析结果（含页码 JSON）写入 <code>official-originals/ocr</code>，记录 hash、解析器、版本、成功页与失败原因。</span>
    </div>
    <div id="ocr-task-out">${emptyState('尚未触发补跑', '点击「开始补跑」后按真实 task_id 轮询进度；单并发，重复请求会合并到运行中的任务。')}</div>`,
  })}

  ${card({
    title: '补跑任务与游标',
    subtitle: `${tasks.length} 个最近任务｜未完成游标 ${(cursor.pending_ids || []).length} 项`,
    body: `${tasks.length ? table({
      rows: tasks,
      pageSize: 6,
      columns: [
        { key: 'task_id', label: 'task_id', render: (r) => `<code>${esc(String(r.task_id).slice(0, 24))}</code>` },
        { key: 'mode', label: '模式', render: (r) => chip(r.mode === 'single' ? '按对象' : '扫描批次', 'muted') },
        { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
        { key: 'queued_at', label: '受理', render: (r) => esc(dateTime(r.queued_at)) },
        { key: 'elapsed_ms', label: '耗时', align: 'right', render: (r) => (r.elapsed_ms == null ? '—' : `${num(Math.round(r.elapsed_ms / 1000))} s`) },
        { key: 'error', label: '失败原因', render: (r) => esc(String(r.error || '—').slice(0, 70)) },
        { key: 'actions', label: '详情', render: (r) => `<button class="btn btn-xs" data-ocr-task="${esc(r.task_id)}">查看结果</button>` },
      ],
      emptyText: '本进程尚未受理补跑任务',
    }) : '<p class="muted">本进程尚未受理补跑任务。</p>'}
    <p class="form-static">游标：<code>${esc(cursor.dataset || 'ocr_backfill')}</code>｜状态 ${esc(cursor.last_status || 'never')}｜上次尝试 ${esc(dateTime(cursor.last_attempt_at))}｜待处理 ${(cursor.pending_ids || []).length} 项${cursor.last_error ? `｜上次错误：${esc(cursor.last_error)}` : ''}</p>`,
    note: '每日任务按 daily_docs 有界补跑并保留未完成游标；配额、单文档页上限与整批限时三重约束，quota/timeout 中止时不写入任何结果。',
  })}`;

  /* ---------------- 配置保存 ---------------- */
  const cfgForm = body.querySelector('#ocr-cfg-form');
  cfgForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = body.querySelector('#ocr-cfg-msg');
    const payload = {};
    cfgForm.querySelectorAll('[data-ocr]').forEach((el) => {
      const key = el.dataset.ocr;
      if (key === 'enabled') payload[key] = el.value === 'true';
      else if (el.tagName === 'SELECT') payload[key] = el.value;
      else if (['request_timeout_ms', 'batch_budget_ms', 'daily_page_limit', 'daily_doc_limit', 'max_pages_per_doc', 'ocr_min_chars'].includes(key)) {
        if (el.value !== '') payload[key] = Number(el.value);
      } else if (el.value.trim() !== '') payload[key] = el.value.trim();
    });
    if (body.querySelector('#ocr-clear-credentials')?.value === 'true') payload.clear_credentials = true;
    if (payload.api_key || payload.secret_key) {
      if (!payload.api_key || !payload.secret_key) {
        msg.innerHTML = errorState({ status: 400, body: { error: 'API Key 与 Secret Key 需同时填写（留空表示保留原凭据）' } });
        return;
      }
    }
    msg.innerHTML = loading('正在保存…');
    try {
      const out = await api('/api/v2/admin/ocr/config', { method: 'POST', body: payload });
      const action = { kept: '凭据保持不变', updated: '凭据已更新（服务端加密存储）', cleared: '凭据已清除' }[out.credential_action] || '';
      msg.innerHTML = `<div class="callout callout-ok"><b>已保存</b>
        <p>开关 ${out.config?.enabled ? '启用' : '停用'}｜模式 ${esc(out.config?.mode || '')}｜${esc(action)}</p>
        <p class="hint">接口返回中只有「是否已配置」，没有密钥与密文。</p></div>`;
      // 清空密钥输入框，避免浏览器把明文留在 DOM 里
      cfgForm.querySelectorAll('[data-ocr="api_key"],[data-ocr="secret_key"]').forEach((el) => { el.value = ''; });
      toast('OCR 配置已保存', 'ok');
    } catch (err) {
      msg.innerHTML = errorState(err);
    }
  });

  body.querySelector('#ocr-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const msg = body.querySelector('#ocr-cfg-msg');
    btn.disabled = true;
    btn.textContent = '测试中…';
    msg.innerHTML = loading('正在真实调用鉴权接口与经典高精度接口（1 页）…');
    try {
      const out = await api('/api/v2/admin/ocr/test', { method: 'POST', body: {} });
      msg.innerHTML = `<div class="callout ${out.ok ? 'callout-ok' : 'callout-warn'}">
        <b>连接测试：${out.ok ? '通过' : esc(OCR_CATEGORY_LABEL[out.error_category] || out.status || '未通过')}</b>
        <p>${esc(out.message || '')}</p>
        <p>鉴权阶段：${out.token?.ok ? `成功（有效期至 ${esc(dateTime(out.token.expires_at))}）` : ocrCategoryChip(out.token?.error_category)}${out.token?.error ? `｜${esc(out.token.error)}` : ''}</p>
        <p>OCR 阶段：${out.ocr?.ok ? `成功（识别 ${num(out.ocr.chars)} 字，${num(out.ocr.attempts)} 次尝试）` : out.ocr?.skipped ? esc(out.ocr.error || '未发起') : ocrCategoryChip(out.ocr?.error_category)}${out.ocr?.error ? `｜${esc(out.ocr.error)}` : ''}</p>
        <p class="hint">${esc(out.note || '')}</p></div>`;
      toast(out.ok ? 'OCR 连接测试通过' : 'OCR 连接测试未通过', out.ok ? 'ok' : 'warn');
    } catch (err) {
      msg.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试真实连接（1 页，会计费）';
    }
  });

  body.querySelector('#ocr-probe')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const msg = body.querySelector('#ocr-cfg-msg');
    btn.disabled = true;
    btn.textContent = '探测中…';
    msg.innerHTML = loading('正在真实提交一次文档解析探测任务…');
    try {
      const out = await api('/api/v2/admin/ocr/probe-parser', { method: 'POST', body: {} });
      msg.innerHTML = `<div class="callout ${out.ok ? 'callout-ok' : 'callout-warn'}">
        <b>文档解析能力：${esc(out.state || 'unknown')}</b>
        <p>${esc(out.message || '')}</p>
        <p class="hint">无权限时保持 unsupported，不自动切换付费服务，也不伪实现。</p></div>`;
      toast(`文档解析能力：${out.state}`, out.ok ? 'ok' : 'warn');
    } catch (err) {
      msg.innerHTML = errorState(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '探测文档解析权限';
    }
  });

  /* ---------------- 补跑 ---------------- */
  const taskOut = body.querySelector('#ocr-task-out');
  body.querySelector('#ocr-refresh')?.addEventListener('click', () => renderOcrAdmin(body));

  // DeepSeek 视觉补充：只对受限根内候选对象执行指定物理页；结果异步返回后刷新。
  const visionForm = body.querySelector('#vision-form');
  visionForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(visionForm);
    const [kind, id] = String(f.get('target') || '').split('|');
    const out = body.querySelector('#vision-out');
    const btn = visionForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '识别中…';
    out.innerHTML = loading('正在转换指定页并调用 deepseek-flash；不会把整个 PDF 上传…');
    try {
      const r = await api('/api/v2/admin/vision/supplement', {
        method: 'POST',
        body: { kind, id, page: Number(f.get('page')), apply: f.has('apply') },
      });
      out.innerHTML = r.ok
        ? `<div class="callout callout-ok"><b>第 ${num(r.page)} 页视觉识别完成</b>
            <p>图像 hash ${esc(r.image_hash?.slice(0, 16) || '—')}…｜${num(r.page_chars)} 字符｜尝试 ${num(r.attempts)} 次｜${num(r.latency_ms)} ms</p>
            <p>${r.applied?.ok ? `已并入正文（${esc(r.applied.status)}，${num(r.applied.body_chars)} 字符；仍按机器抽取/部分展示）` : `未并入正文：${esc(r.applied?.reason || '未请求')}`}</p>
            <p class="hint">${esc(r.note || '')}</p></div>`
        : `<div class="callout callout-warn"><b>视觉补充未完成</b><p>${esc(r.message || r.reason || '')}</p></div>`;
      toast(r.ok ? '视觉补充完成' : '视觉补充未完成', r.ok ? 'ok' : 'warn');
    } catch (err) {
      out.innerHTML = errorState(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '识别指定页';
    }
  });

  body.querySelector('#ocr-backfill')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '受理中…';
    taskOut.innerHTML = loading('正在提交补跑请求…');
    try {
      const accepted = await api('/api/v2/admin/ocr/backfill', { method: 'POST', body: {} });
      const taskId = accepted.task_id;
      taskOut.innerHTML = `
        <div class="callout ${accepted.merged ? 'callout-warn' : 'callout-ok'}"><b>${accepted.merged ? '已合并到运行中的任务' : '已受理（HTTP 202）'}</b>
          <p>task_id <code>${esc(taskId)}</code>｜状态 <b>${esc(accepted.status || 'queued')}</b>${accepted.message ? `<br>${esc(accepted.message)}` : ''}</p>
          <p class="hint">单并发：同一时刻只有一个补跑任务在跑，重复触发会合并，不重复解析。</p></div>
        <div id="ocr-task-live">${loading('等待任务开始…')}</div>`;
      await pollOcrTask(taskOut.querySelector('#ocr-task-live'), taskId);
    } catch (err) {
      taskOut.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '开始补跑（单并发，202 受理）';
    }
  });

  body.querySelector('#ocr-daily')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '执行中…';
    taskOut.innerHTML = loading('正在执行有界每日补跑…');
    try {
      const out = await api('/api/v2/admin/ocr/daily', { method: 'POST', body: {} });
      taskOut.innerHTML = `<div class="callout ${out.ok_count > 0 ? 'callout-ok' : 'callout-warn'}">
        <b>每日有界补跑完成</b>
        <p>处理 ${num(out.selected)} / ${num(out.candidates)} 个对象｜取得正文 ${num(out.ok_count)} 个｜失败 ${num(out.fail_count)} 个</p>
        <p>未完成游标：${(out.cursor?.pending_ids || []).length} 项</p>
        <p class="hint">${esc(out.note || '')}</p></div>`;
      toast(`每日补跑：成功 ${out.ok_count ?? 0} 个`, out.ok_count > 0 ? 'ok' : 'warn');
    } catch (err) {
      taskOut.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '执行一次每日有界补跑';
    }
  });

  body.addEventListener('click', async (e) => {
    const rb = e.target.closest('[data-ocr-reparse]');
    if (rb) {
      const [kind, id] = String(rb.dataset.ocrReparse).split('|');
      rb.disabled = true;
      rb.textContent = '解析中…';
      taskOut.innerHTML = loading(`正在重解析 ${kind} / ${id}…`);
      try {
        const out = await api('/api/v2/admin/ocr/reparse', { method: 'POST', body: { kind, id, force: true } });
        taskOut.innerHTML = `<div class="callout ${out.ok ? 'callout-ok' : 'callout-warn'}">
          <b>重解析：${out.ok ? '取得正文' : '未取得正文'}</b>
          <p>状态 ${esc(out.status || '—')}｜共 ${num(out.pages_total)} 页：文本层 ${num(out.pages_text)} 页 + OCR ${num(out.pages_ocr)} 页，失败 ${num(out.pages_failed)} 页</p>
          ${out.failed_pages?.length ? `<p class="hint">失败页：${esc(JSON.stringify(out.failed_pages).slice(0, 300))}</p>` : ''}
          <p class="hint">${esc(out.message || out.reason || '')}${out.verify_eligible ? '｜已取得正文，可进入既有自动核验（OCR 成功本身不等于模型已核验）。' : ''}</p></div>`;
        toast(out.ok ? '重解析取得正文' : '重解析未取得正文', out.ok ? 'ok' : 'warn');
      } catch (err) {
        taskOut.innerHTML = errorState(err);
      } finally {
        rb.disabled = false;
        rb.textContent = '重解析';
      }
      return;
    }
    const tb = e.target.closest('[data-ocr-task]');
    if (tb) {
      try {
        const d = await api(`/api/v2/admin/ocr/jobs?task_id=${encodeURIComponent(tb.dataset.ocrTask)}`);
        document.body.insertAdjacentHTML('beforeend', drawer(`OCR 补跑任务：${tb.dataset.ocrTask}`, `
          ${kv([
            ['状态', chip(d.task?.status, d.task?.status === 'success' ? 'ok' : d.task?.status === 'failed' ? 'danger' : 'warn')],
            ['模式', esc(d.task?.mode === 'single' ? '按对象' : '扫描批次')],
            ['受理 / 开始 / 结束', `${esc(dateTime(d.task?.queued_at))} / ${esc(dateTime(d.task?.started_at))} / ${esc(dateTime(d.task?.finished_at))}`],
            ['耗时', d.task?.elapsed_ms == null ? '—' : `${num(Math.round(d.task.elapsed_ms / 1000))} s`],
            ['失败原因', esc(d.task?.error || '—')],
          ])}
          <h5>结果（含逐对象状态与失败原因）</h5>
          ${ceaJsonBlock(d.task?.result)}`, { wide: true }));
      } catch (err) {
        toast(err.body?.error || err.message, 'danger');
      }
    }
  });
}

/** 按 task_id 轮询 OCR 补跑任务（服务端真实状态，不乐观收尾） */
async function pollOcrTask(box, taskId, tries = 0) {
  if (!box) return;
  if (tries > 120) { box.innerHTML = '<p class="muted">轮询已达上限，请稍后手动刷新查看任务状态。</p>'; }
  else {
    try {
      const d = await api(`/api/v2/admin/ocr/jobs?task_id=${encodeURIComponent(taskId)}`);
      const t = d.task;
      if (!t) { box.innerHTML = `<p class="muted">服务端未返回该 task_id（可能已超出进程内保留数量）。</p>`; return; }
      const done = ['success', 'partial', 'failed'].includes(t.status);
      const r = t.result || {};
      box.innerHTML = `<div class="callout ${t.status === 'success' ? 'callout-ok' : t.status === 'failed' ? 'callout-danger' : 'callout-warn'}">
        <b>任务状态：${esc(t.status)}</b>
        <p>已处理 ${num(r.selected)} / ${num(r.candidates)} 个对象｜取得正文 ${num(r.ok_count)} 个｜失败 ${num(r.fail_count)} 个</p>
        ${r.ocr_ready === false ? `<p class="hint">OCR 当前不可用：${esc(r.ocr_note || '')}（缺文字页保持缺口，不影响已有可读页）</p>` : ''}
        ${t.error ? `<p>${esc(t.error)}</p>` : ''}
        ${r.note ? `<p class="hint">${esc(r.note)}</p>` : ''}
        ${(r.docs || []).length ? `<ul class="bullets">${r.docs.slice(0, 8).map((x) => `<li>${esc(OCR_CANDIDATE_LABEL[x.kind] || x.kind)} ${esc(String(x.title || x.id).slice(0, 30))}：${x.ok ? `取得正文（${esc(x.status)}，${num(x.pages_total)} 页）` : `未取得正文（${esc(x.reason || '')}）`}</li>`).join('')}</ul>` : ''}
        <p class="hint">${done ? '任务已结束。' : '任务仍在执行，本页每 3 秒轮询一次真实进度。'}</p></div>`;
      if (!done) setTimeout(() => pollOcrTask(box, taskId, tries + 1), 3000);
    } catch (err) {
      box.innerHTML = errorState(err);
    }
  }
}

/* ==================================================================== */
/*  碳核算资料管理（公开碳核算资料采集 / 配置 / 核验 / 上传正文）        */
/* ==================================================================== */

const ACCOUNTING_TARGETS = [
  { key: 'crc_daily', label: '中碳登清结算日报', hint: '抓取日报列表与详情；自愿注销公示量不计入成交量，量额不与 CEA 相加' },
  { key: 'standards', label: '标准规范', hint: '发现并归档核算/核查规范原文；抓到却解析 0 行按失败处理' },
  { key: 'factor_pdf', label: '电力因子原件 PDF', hint: '下载并解析官方电力 CO₂ 因子原件；原件哈希变化时不覆盖已核实值' },
  { key: 'cets_public', label: '全国碳市场信息网·政策与问答', hint: '只采公开门户的政策/标准列表与第一页问答；栏目导航不当正文，宣称条数不当作已入库数' },
  { key: 'portals', label: '受阻门户探测', hint: '只做真实探测：HTTP 412 等反爬挑战如实登记为缺口，不伪造成功' },
  { key: 'all', label: '全部（共享同一时间预算依次执行）', hint: '共用 batch_budget_ms；超出预算的步骤留待下一批' },
];
const ACCOUNTING_TARGET_LABEL = Object.fromEntries(ACCOUNTING_TARGETS.map((t) => [t.key, t.label]));

const ACC_TASK_LABEL = { queued: '排队中', running: '执行中', success: '成功', partial: '部分成功', failed: '失败' };
function accTaskChip(status) {
  const kind = status === 'success' ? 'ok' : status === 'partial' ? 'warn' : status === 'failed' ? 'danger' : 'muted';
  return chip(ACC_TASK_LABEL[status] || status || '—', kind);
}

const ACC_VERIFY_LABEL = {
  verified: '自动核验通过（引用可定位）', insufficient: '证据不足（引用缺失或无法定位）',
  conflict: '来源冲突（正文与著录不一致）', unavailable: '不可用（无模型 / 超时 / 无正文）',
};

/** 轮询定时器：切换页签或重新渲染时必须清掉，避免后台空转 */
let accountingPollTimer = null;
function stopAccountingPoll() {
  if (accountingPollTimer) { clearInterval(accountingPollTimer); accountingPollTimer = null; }
}

function accountingTaskHtml(t, polls = 0) {
  const r = t.result || {};
  const stats = r.stats || {};
  const prog = t.progress || {};
  const sum = prog.summary || null;
  const done = ['success', 'partial', 'failed'].includes(t.status);
  return `<div class="callout ${t.status === 'success' ? 'callout-ok' : t.status === 'failed' ? 'callout-danger' : 'callout-warn'}">
    <b>任务 ${esc(t.task_id || '—')}｜状态 ${esc(ACC_TASK_LABEL[t.status] || t.status || '—')}</b>
    <p>目标 ${esc(ACCOUNTING_TARGET_LABEL[t.target] || t.target || '—')}
      ｜用时 ${t.elapsed_ms === null || t.elapsed_ms === undefined ? '—' : `${num(Math.round(Number(t.elapsed_ms) / 1000))} s`}
      （预算 ${num(t.budget_ms)} ms）｜阶段 ${esc(prog.stage || '—')}</p>
    <p>发现 ${num(stats.found)}｜解析 ${num(stats.parsed)}｜校验 ${num(stats.validated)}｜问题 ${num(stats.errors)}
      ${r.empty_scan ? chip('空扫描（无待处理对象，不等于采集成功）', 'muted') : ''}
      ${r.merged ? chip(`已合并到运行中的任务（job=${r.merged_into_job_id || '—'}）`, 'warn') : ''}</p>
    ${sum && sum.note ? `<p class="hint">${esc(sum.note)}</p>` : ''}
    ${t.error ? `<p>${esc(t.error)}</p>` : ''}
    ${r.job_id ? `<p class="hint">job <code>${esc(r.job_id)}</code>${
      r.detail?.crc_daily?.data_as_of ? `｜数据截止 ${esc(r.detail.crc_daily.data_as_of)}` : ''}</p>` : ''}
    <p class="hint">${done
      ? '任务已结束（success / partial / failed 均为真实结果）。'
      : `任务仍在执行：本页每 2.5 秒轮询一次真实进度（已轮询 ${num(polls)} 次，上限 60 次）。`}</p>
  </div>`;
}

/** 按 task_id 轮询采集任务：2.5 秒一次，最多 60 次；节点被替换（切页签/重渲染）即停止 */
function startAccountingPoll(box, taskId) {
  stopAccountingPoll();
  let polls = 0;
  const tick = async () => {
    if (!box.isConnected) { stopAccountingPoll(); return; }
    polls += 1;
    if (polls > 60) {
      stopAccountingPoll();
      box.insertAdjacentHTML('beforeend', '<p class="hint">轮询已达上限（约 2.5 分钟）：请点「刷新」查看最新任务状态，任务仍在服务端继续执行。</p>');
      return;
    }
    try {
      const d = await api(`/api/v2/accounting/admin/jobs?task_id=${encodeURIComponent(taskId)}`);
      const t = d.task;
      if (!t) {
        stopAccountingPoll();
        box.innerHTML = '<p class="muted">服务端未返回该 task_id（可能已超出进程内保留数量），请点「刷新」查看最近任务列表。</p>';
        return;
      }
      box.innerHTML = accountingTaskHtml(t, polls);
      if (['success', 'partial', 'failed'].includes(t.status)) stopAccountingPoll();
    } catch (err) {
      stopAccountingPoll();
      box.innerHTML = errorState(err);
    }
  };
  tick();
  accountingPollTimer = setInterval(tick, 2500);
}

async function renderAccountingAdmin(body, q = {}) {
  // 切页签/重渲染：先清掉上一轮轮询，避免定时器在已卸载的节点上继续跑
  stopAccountingPoll();

  const [cfgOut, statusOut, srcOut] = await Promise.all([
    api('/api/v2/accounting/admin/config'),
    api('/api/v2/accounting/status'),
    api('/api/v2/accounting/sources?limit=300'),
  ]);
  const cfg = cfgOut.config || {};
  const defaults = cfgOut.defaults || {};
  const collect = cfgOut.collect || {};
  const status = statusOut || {};
  const counts = status.counts || {};
  const gaps = status.gaps || [];
  const sources = srcOut.sources || [];
  const tasks = collect.tasks || [];
  const lastJob = collect.last_job || null;
  const cursor = collect.cursor || {};

  const numField = (key, label, min, max, hint) => `
    <label class="fld"><span>${esc(label)}</span>
      <input type="number" data-acccfg="${esc(key)}" value="${esc(cfg[key] === undefined || cfg[key] === null ? '' : String(cfg[key]))}"
             min="${min}" max="${max}" placeholder="${esc(defaults[key] === undefined ? '' : String(defaults[key]))}">
      <small class="hint">${esc(hint)}｜服务端默认 ${esc(defaults[key] === undefined ? '—' : String(defaults[key]))}</small></label>`;

  body.innerHTML = `
  <div class="callout callout-warn">
    <b>202 只表示已受理，不代表采集成功</b>
    <p>POST /admin/collect 返回的 202 只是「请求已进入后台执行」；真实结果由「任务进度」与「最近任务」给出。
    「无待处理对象」是空扫描；<b>抓到了却解析 0 行按失败处理</b>。</p>
    <p class="hint">${esc(cfgOut.limits_note || '')}</p>
  </div>

  <div class="grid-2">
    ${card({
      title: '碳核算资料采集配置（实际生效值）',
      subtitle: '留空表示不修改该字段；服务端逐项校验范围，越界返回 400（原文展示）',
      actions: '<button class="btn btn-sm" type="button" data-acccfg-reset>填入默认值</button>',
      body: `
        <form id="acc-cfg-form" class="form-grid">
          <div class="quick-adv-grid">
            ${numField('batch_budget_ms', '单批时间预算（毫秒）', 5000, 120000, '上限 120000（需求：单批 ≤120 秒），超过会被服务端拒绝')}
            ${numField('max_details_per_source', '单源最多详情页数', 1, 50, '每个来源单次最多发现的详情页')}
            ${numField('max_pdfs_per_run', '单次最多下载 PDF 数', 0, 50, '0 表示本批不下载 PDF')}
            ${numField('max_pages_per_pdf', '单个 PDF 最多解析页数', 1, 500, '超出页数的部分不解析')}
            ${numField('daily_details', '每日自动采集详情页上限', 0, 100, '每日任务的有界上限')}
            <label class="fld"><input type="checkbox" data-acccfg="verify_with_model" ${cfg.verify_with_model ? 'checked' : ''}> 新增正文后做模型一致性核验（未配置可用模型时结果为 unavailable，不会伪造 verified）</label>
          </div>
          <div class="quick-actions">
            <button class="btn btn-primary" type="submit">保存配置</button>
            <span class="hint">配置只影响采集调度与预算，不改变任何已入库原值。</span>
          </div>
          <div id="acc-cfg-msg"></div>
        </form>`,
      note: '硬约束由服务端执行：单批预算上限、单并发、重入合并、单次文件数与单文档页数上限、来源未变命中缓存。',
    })}
    ${card({
      title: '资料库状态',
      subtitle: `${status.seeded ? '公开资料库已就绪' : '公开资料库未就绪'}｜数量均为本平台实际入库，不代表上游门户宣称的总量`,
      body: `
        <div class="metrics metrics-sm">
          ${mini('来源登记', Number(counts.sources || 0), '个', `被拦截 ${num(counts.blocked_sources)} 个`)}
          ${mini('排放因子（现行 / 全部）', `${num(counts.factors)} / ${num(counts.factors_total)}`, '条', '含历史版本；不可计算因子照实标注')}
          ${mini('标准规范', Number(counts.standards || 0), '条', `已取得正文 ${num(counts.standards_full ?? counts.standards_with_body)} 条`)}
          ${mini('政策与问答', Number(counts.public_documents || 0), '条', `含问答 ${num(counts.public_qa)} 条；栏目页不是全文`)}
          ${mini('清结算日报', Number(counts.crc_daily || 0), '期', `最新数据日期 ${counts.crc_latest_date || '—'}`)}
        </div>
        ${kv([
          ['正在运行的采集作业', collect.running_job ? `${esc(collect.running_job.id)}（${esc(collect.running_job.trigger || '—')}，${esc(dateTime(collect.running_job.started_at))} 起）` : '无'],
          ['上次采集运行', esc(dateTime(cursor.last_run_at))],
          ['日报最新数据日期', esc(cursor.crc_last_trade_date || '—')],
          ['待补正文的规范', cursor.standards_body_pending === null || cursor.standards_body_pending === undefined ? '—' : esc(String(cursor.standards_body_pending))],
        ])}
        ${techDetails([
          `原件存放位置（受限）：<code>${esc((collect.roots?.accounting_originals) || (status.roots?.accounting_originals) || '—')}</code>`,
          `数据版本：${esc(status.schema_version || '—')}`,
        ].join('<br>'), '技术细节（运行留痕）')}
        ${cursor.note ? noteBlock(cursor.note) : ''}`,
    })}
  </div>

  ${card({
    title: '触发采集（202 受理 → 轮询真实进度）',
    subtitle: '同一目标已有排队/运行中的任务时会合并，不重复抓取；单并发执行',
    actions: '<button class="btn btn-sm" id="acc-refresh">刷新</button>',
    body: `
      <div class="filters">
        <label class="fld"><span>采集目标</span>
          <select id="acc-target">
            ${ACCOUNTING_TARGETS.map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('')}
          </select></label>
        <span class="fld-actions"><button class="btn btn-sm btn-primary" id="acc-collect-btn">触发采集</button></span>
      </div>
      <p class="hint" id="acc-target-hint">${esc(ACCOUNTING_TARGETS[0].hint)}</p>
      <div id="acc-collect-out">${emptyState('尚未触发采集', '选择目标后点「触发采集」：受理后按真实 task_id 每 2.5 秒轮询进度（最多 60 次）。')}</div>`,
    note: '受理（202）≠ 成功；「无待处理对象」是空扫描，抓到却解析 0 行按失败处理。',
  })}

  ${card({
    title: '最近一次采集作业与任务列表',
    subtitle: lastJob ? `最近作业 ${esc(lastJob.id)}｜状态 ${esc(lastJob.status || '—')}` : '本进程尚无已结束的碳核算采集作业',
    body: `
      ${lastJob ? kv([
        ['作业 ID', `<code>${esc(lastJob.id)}</code>`],
        ['状态', accTaskChip(lastJob.status)],
        ['开始 / 结束', `${esc(dateTime(lastJob.started_at))} / ${esc(dateTime(lastJob.finished_at))}`],
        ['发现 / 解析 / 校验', `${num(lastJob.items_found)} / ${num(lastJob.items_parsed)} / ${num(lastJob.items_validated)}`],
        ['错误数 / 错误摘要', `${num(lastJob.error_count)}${lastJob.error_summary ? `｜${esc(lastJob.error_summary)}` : ''}`],
        ['数据截止', esc(lastJob.data_as_of || '—')],
      ]) + (lastJob.detail ? `<details><summary>作业明细（逐目标结果，留痕未改写）</summary>${ceaJsonBlock(lastJob.detail)}</details>` : '')
        : '<p class="muted">还没有已结束的作业：触发采集后在此显示真实的发现/解析/错误统计。</p>'}
      <h5>任务列表（本进程保留的最近任务）</h5>
      ${tasks.length ? table({
        rows: tasks,
        pageSize: 8,
        columns: [
          { key: 'task_id', label: '任务', render: (r) => `<code>${esc(truncate(String(r.task_id || ''), 24))}</code>` },
          { key: 'target', label: '目标', render: (r) => esc(ACCOUNTING_TARGET_LABEL[r.target] || r.target || '—') },
          { key: 'status', label: '状态', render: (r) => accTaskChip(r.status) },
          { key: 'queued_at', label: '排队时间', render: (r) => esc(dateTime(r.queued_at)) },
          { key: 'elapsed_ms', label: '用时', align: 'right', render: (r) => (r.elapsed_ms === null || r.elapsed_ms === undefined ? '—' : `${num(Math.round(Number(r.elapsed_ms) / 1000))} s`) },
          { key: 'job_id', label: 'job', render: (r) => (r.job_id ? `<code>${esc(truncate(String(r.job_id), 20))}</code>` : '—') },
          { key: 'error', label: '错误', render: (r) => (r.error ? `<span class="muted">${esc(truncate(r.error, 70))}</span>` : '—') },
        ],
        emptyText: '本进程尚未受理采集任务',
      }) : '<p class="muted">本进程尚未受理采集任务。</p>'}`,
  })}

  ${card({
    title: '来源状态与缺口',
    subtitle: `${sources.length} 个来源｜最近成功时间为空表示「未抓取（仅登记）」`,
    body: renderAccountingGaps(gaps) + renderAccountingSourceTable(sources, { pageSize: 12 }) + noteBlock(srcOut.note || ''),
  })}

  <div class="grid-2">
    ${card({
      title: '重跑模型核验（标准正文 × 著录）',
      subtitle: '只对已取得正文的标准执行；核验结论不改变编号、日期等确定性元数据',
      body: `
        <div class="filters">
          <label class="fld fld-wide"><span>标准编号或 ID</span><input type="search" id="acc-verify-id" placeholder="如 环办气候函〔2024〕xx号 或标准 ID"></label>
          <span class="fld-actions"><button class="btn btn-sm" id="acc-verify-btn">重跑模型核验</button></span>
        </div>
        <div id="acc-verify-out">${emptyState('尚未执行核验', '输入标准编号/ID 后点击按钮；不可用原因会原样显示。')}</div>`,
      note: '无模型 / 超时 / 引用无法在正文中定位时，结果为 unavailable 或 insufficient，绝不显示为「已核验」。',
    })}
    ${card({
      title: '上传标准 PDF（补正文）',
      subtitle: '默认从本机选择 PDF 文件；保存后自动逐页解析并交已配置模型核对',
      body: `
        <div class="filters">
          <label class="fld"><span>标准编号或 ID</span><input type="search" id="acc-upload-id" placeholder="标准 ID 或编号"></label>
          <label class="fld fld-wide"><span>PDF 文件（不超过 20 MiB）</span><input type="file" id="acc-upload-file" accept="application/pdf"></label>
          <span class="fld-actions"><button class="btn btn-sm" id="acc-upload-btn">上传并解析</button></span>
        </div>
        <div id="acc-upload-out">${emptyState('尚未上传', '选择本机 PDF 后点「上传并解析」；成功后显示正文状态、页数、原件哈希与模型核验结果。')}</div>
        <p class="hint">文件在浏览器内读取为 base64 后提交（单文件不超过 20 MiB，前端先校验、服务端再校验文件头与大小）。
        上传的 PDF 若与公告官方原件哈希不一致，只记为「管理员补充文件」，<b>不会</b>写成已验证官方原件。</p>
        ${techDetails(`
          <div class="filters">
            <label class="fld fld-wide"><span>服务器受限目录内的文件路径（本机已存在的原件）</span><input type="search" id="acc-upload-path" placeholder="official-originals/… 或 registry-files/…"></label>
            <span class="fld-actions"><button class="btn btn-sm" id="acc-upload-path-btn">按路径解析</button></span>
          </div>
          <p class="hint">仅供服务器本机已存在的原件使用：只接受受限目录内的路径，任意服务器路径与任意 URL 都会被服务端拒绝（原因原样显示）。
          PDF 无可用文本层时保留原件但<b>不</b>写入空正文，也不标记「已取得全文」。</p>`, '高级设置：按服务器受限目录解析（默认无需使用）')}`,
    })}
  </div>`;

  // 从治理详情跳转：预选标准实体，仍使用本页现有 PDF 上传/解析入口。
  if (q.upload_type === 'accounting_standard' && q.upload_id) {
    const idEl = body.querySelector('#acc-upload-id');
    if (idEl) {
      idEl.value = q.upload_id;
      idEl.scrollIntoView({ block: 'center' });
      const fileEl = body.querySelector('#acc-upload-file');
      if (fileEl) fileEl.focus();
    }
  }

  /* ---------------- 配置保存 ---------------- */
  const cfgForm = body.querySelector('#acc-cfg-form');
  cfgForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = body.querySelector('#acc-cfg-msg');
    const payload = {};
    cfgForm.querySelectorAll('[data-acccfg]').forEach((el) => {
      const key = el.dataset.acccfg;
      if (key === 'verify_with_model') { payload[key] = el.checked; return; }
      if (el.value.trim() === '') return; // 留空 = 不修改
      payload[key] = Number(el.value);
    });
    msg.innerHTML = loading('正在保存…');
    try {
      const out = await api('/api/v2/accounting/admin/config', { method: 'POST', body: payload });
      msg.innerHTML = `<div class="callout callout-ok"><b>已保存</b>
        <p>单批预算 ${num(out.config?.batch_budget_ms)} 毫秒｜单源详情 ${num(out.config?.max_details_per_source)} 页｜单次 PDF ${num(out.config?.max_pdfs_per_run)} 个
        ｜单 PDF ${num(out.config?.max_pages_per_pdf)} 页｜每日详情 ${num(out.config?.daily_details)} 页｜模型核验 ${out.config?.verify_with_model ? '开启' : '关闭'}。</p>
        <p class="hint">以上为服务端返回的实际生效值。</p></div>`;
      toast('碳核算资料配置已保存', 'ok');
    } catch (err) {
      msg.innerHTML = errorState(err);
    }
  });
  body.querySelector('[data-acccfg-reset]')?.addEventListener('click', () => {
    cfgForm.querySelectorAll('[data-acccfg]').forEach((el) => {
      const key = el.dataset.acccfg;
      if (defaults[key] === undefined) return;
      if (key === 'verify_with_model') el.checked = defaults[key] === true;
      else el.value = String(defaults[key]);
    });
    toast('已填入服务端默认值，点击「保存配置」后才会生效', 'info');
  });

  /* ---------------- 采集触发与轮询 ---------------- */
  const targetSel = body.querySelector('#acc-target');
  targetSel?.addEventListener('change', () => {
    const t = ACCOUNTING_TARGETS.find((x) => x.key === targetSel.value);
    body.querySelector('#acc-target-hint').textContent = t?.hint || '';
  });
  body.querySelector('#acc-collect-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const outBox = body.querySelector('#acc-collect-out');
    const target = targetSel.value;
    btn.disabled = true;
    btn.textContent = '受理中…';
    outBox.innerHTML = loading(`正在提交采集请求（target=${target}）…`);
    try {
      const accepted = await api('/api/v2/accounting/admin/collect', { method: 'POST', body: { target } });
      const taskId = accepted.task_id;
      outBox.innerHTML = `
        <div class="callout ${accepted.merged ? 'callout-warn' : 'callout-ok'}"><b>${accepted.merged ? '已合并到运行中的任务' : '已受理（HTTP 202，不代表采集成功）'}</b>
          <p>目标 <code>${esc(ACCOUNTING_TARGET_LABEL[target] || target)}</code>｜task_id <code>${esc(taskId || '—')}</code>｜状态 ${esc(ACC_TASK_LABEL[accepted.status] || accepted.status || 'queued')}${accepted.message ? `<br>${esc(accepted.message)}` : ''}</p>
          <p class="hint">${accepted.accepted === false ? '服务端未标记 accepted，请以任务进度为准。' : '受理只是进入后台执行：真实进度见下方轮询结果。'}</p></div>
        <div id="acc-task-live">${loading('等待任务开始…')}</div>`;
      if (taskId) startAccountingPoll(outBox.querySelector('#acc-task-live'), taskId);
      else outBox.querySelector('#acc-task-live').innerHTML = '<p class="muted">服务端未返回 task_id：无法轮询进度，请点「刷新」查看任务列表。</p>';
    } catch (err) {
      outBox.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '触发采集';
    }
  });
  body.querySelector('#acc-refresh')?.addEventListener('click', () => renderAccountingAdmin(body));

  /* ---------------- 模型核验 ---------------- */
  body.querySelector('#acc-verify-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = body.querySelector('#acc-verify-out');
    const id = body.querySelector('#acc-verify-id').value.trim();
    if (!id) { toast('请填写标准编号或 ID', 'warn'); return; }
    btn.disabled = true;
    btn.textContent = '核验中…';
    out.innerHTML = loading('正在调用已配置模型做带引用核验…');
    try {
      const r = await api('/api/v2/accounting/admin/verify', { method: 'POST', body: { standard_id: id } });
      const result = String(r.result || 'unknown');
      const cls = result === 'verified' ? 'callout-ok' : result === 'conflict' ? 'callout-danger' : 'callout-warn';
      out.innerHTML = `<div class="callout ${cls}">
        <b>核验结论：${esc(ACC_VERIFY_LABEL[result] || result)}</b>
        <p>${esc(r.summary || r.note || '（服务端未返回说明）')}</p>
        ${r.reason ? `<p>不可用原因：<code>${esc(r.reason)}</code>${r.detail ? `｜${esc(truncate(String(r.detail), 200))}` : ''}</p>` : ''}
        <p>可定位引用 ${num(r.citations_validated)} 条｜被拒引用 ${num(r.citations_rejected)} 条
          ｜模型 ${esc(r.provider || '—')}｜耗时 ${r.latency_ms === null || r.latency_ms === undefined ? '—' : `${num(r.latency_ms)} ms`}</p>
        <p class="hint">无模型 / 超时 / 引用无法在正文中定位时，结果为 unavailable 或 insufficient，不会显示为已核验。</p>
      </div>`;
      toast(`核验结论：${ACC_VERIFY_LABEL[result] || result}`, result === 'verified' ? 'ok' : 'warn');
    } catch (err) {
      out.innerHTML = errorState(err);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '重跑模型核验';
    }
  });

  /* ---------------- 上传标准 PDF ---------------- */

  const ACC_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

  /** 本机文件 → base64（去掉 data URL 前缀）；只读文件，不做任何改写 */
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取本地文件失败'));
      reader.onload = () => {
        const s = String(reader.result || '');
        resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
      };
      reader.readAsDataURL(file);
    });
  }

  function uploadResultHtml(r, standardId) {
    const matched = r.matches_original;
    const v = r.verify || null;
    const originChip = matched === true
      ? chip('与已登记官方原件哈希一致', 'ok')
      : matched === false
        ? chip('管理员补充文件（与官方原件哈希不一致）', 'warn')
        : chip('未与官方原件比对（缺少可比对的官方哈希）', 'muted');
    return `<div class="callout ${matched === false ? 'callout-warn' : 'callout-ok'}">
      <b>已保存并完成解析流程${matched === false ? '：管理员补充文件' : ''}</b>
      <p>标准 ${esc(r.standard_id || standardId)}｜正文状态 ${esc(r.body_status || '—')}｜${num(r.chars)} 字符｜${num(r.pages_total)} 页</p>
      <div class="chip-row">${originChip}${r.source_status ? chip(`来源状态：${r.source_status}`, matched === false ? 'warn' : 'muted') : ''}</div>
      <p>原件 SHA-256：<code>${esc(r.sha256 || '—')}</code>${r.upload_id ? `｜上传记录 ${esc(truncate(String(r.upload_id), 24))}` : ''}</p>
      ${matched === false ? '<p class="hint">该 PDF 与公告官方原件的哈希不一致：只按「管理员补充文件」记录来源，<b>不</b>写作已验证官方原件，公告里的官方地址也不会被覆盖。</p>' : ''}
      ${v ? `<p>模型核验：${esc(ACC_VERIFY_LABEL[v.result] || v.result || '—')}
        ${v.reason ? `（原因 ${esc(v.reason)}）` : ''}${v.summary ? `｜${esc(v.summary)}` : ''}
        ｜可定位引用 ${num(v.citations_validated)} 条｜被拒 ${num(v.citations_rejected)} 条</p>` : '<p class="hint">服务端未返回核验结果。</p>'}
      <p class="hint">${esc(r.note || '')}</p></div>`;
  }

  function uploadErrorHtml(err, standardId) {
    const b = err.body || {};
    return `<div class="callout callout-danger"><b>上传未成功（HTTP ${num(err.status)}）</b>
      <p>${esc(b.error || err.message || '未知错误')}</p>
      ${b.needs_ocr ? '<p class="hint">该 PDF 无可用文本层（可能是扫描件）：原件已保留，但<b>未</b>写入空正文，也<b>未</b>标记「已取得全文」。需先做 OCR 补跑（后台「PDF 解析/OCR」页）。</p>' : ''}
      ${b.sha256 ? `<p class="hint">原件 SHA-256：<code>${esc(b.sha256)}</code>｜页数 ${num(b.pages_total)}</p>` : ''}
      <p class="hint">标准 ${esc(standardId)}｜大小超限、文件头不是 PDF、路径越界或任意 URL 都会被服务端拒绝：这里不会做前端「绕过」。</p></div>`;
  }

  body.querySelector('#acc-upload-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = body.querySelector('#acc-upload-out');
    const standardId = body.querySelector('#acc-upload-id').value.trim();
    const fileInput = body.querySelector('#acc-upload-file');
    const file = fileInput?.files && fileInput.files[0] ? fileInput.files[0] : null;
    if (!standardId) { toast('请填写标准编号或 ID', 'warn'); return; }
    if (!file) { toast('请先选择本机 PDF 文件（不超过 20 MiB）', 'warn'); return; }
    if (Number(file.size) > ACC_UPLOAD_MAX_BYTES) {
      out.innerHTML = `<div class="callout callout-danger"><b>文件过大，未提交</b>
        <p>所选文件 ${num(Math.round(Number(file.size) / 1024 / 1024 * 10) / 10)} MiB，超过 20 MiB 上限。</p>
        <p class="hint">请上传单份标准原件；服务端同样会拒绝超限文件，前端不做截断或压缩。</p></div>`;
      toast('文件超过 20 MiB，未提交', 'warn');
      return;
    }
    btn.disabled = true;
    btn.textContent = '上传中…';
    out.innerHTML = loading('正在上传 PDF 并交模型核对（可能需要数十秒）…');
    try {
      const fileBase64 = await readFileAsBase64(file);
      const r = await api('/api/v2/accounting/admin/upload-body', {
        method: 'POST',
        body: { standard_id: standardId, file_name: file.name, file_base64: fileBase64 },
      });
      out.innerHTML = uploadResultHtml(r, standardId);
      toast(r.matches_original === false ? 'PDF 已入库（管理员补充文件）' : 'PDF 已解析入库', r.matches_original === false ? 'warn' : 'ok');
    } catch (err) {
      out.innerHTML = uploadErrorHtml(err, standardId);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '上传并解析';
    }
  });

  body.querySelector('#acc-upload-path-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = body.querySelector('#acc-upload-out');
    const standardId = body.querySelector('#acc-upload-id').value.trim();
    const filePath = body.querySelector('#acc-upload-path').value.trim();
    if (!standardId) { toast('请填写标准编号或 ID', 'warn'); return; }
    if (!filePath) { toast('请填写受限目录内的文件路径', 'warn'); return; }
    btn.disabled = true;
    btn.textContent = '解析中…';
    out.innerHTML = loading('正在解析服务器上已存在的 PDF（可能需要数十秒）…');
    try {
      const r = await api('/api/v2/accounting/admin/upload-body', { method: 'POST', body: { standard_id: standardId, file_path: filePath } });
      out.innerHTML = uploadResultHtml(r, standardId);
      toast('PDF 已解析入库', 'ok');
    } catch (err) {
      out.innerHTML = uploadErrorHtml(err, standardId);
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '按路径解析';
    }
  });
}

/* ------------------------------ 公开信息智能化（docs/86） ------------------------------ */

function bindPdfJobButtons(body) {
  body.querySelectorAll('[data-pdf-job]').forEach((el) => {
    if (el.dataset.pdfJobBound === '1') return;
    el.dataset.pdfJobBound = '1';
    el.addEventListener('click', async () => {
      el.disabled = true;
      try {
        const d = await api(`/api/v2/admin/pdf-tables/jobs/${el.dataset.pdfJob}?limit=200`);
        const job = d.job || {};
        const pages = (d.pages || []).map((p) => `<tr>
          <td>${num(p.page)}</td><td>${p.has_text_layer ? '有' : '无'}</td>
          <td>${num(p.table_count)}</td><td>${num(p.row_count)}</td>
          <td>${esc(p.status)}${p.error ? `<div class="muted">${esc(p.error)}</div>` : ''}</td>
        </tr>`).join('');
        const tableBlocks = (d.tables || []).slice(0, 5).map((t) => `<details>
          <summary>第 ${num(t.page)} 页 · 表 ${num(t.table_index)} · ${num(t.rows)} 行 × ${num(t.cols)} 列</summary>
          <pre class="body-snapshot">${esc((t.data || []).map((r) => (r || []).join(' | ')).join('\n'))}</pre>
          <p class="hint">单元格行列均为 0 起；共 ${num((t.cells || []).length)} 个非空单元格。</p>
        </details>`).join('');
        document.body.insertAdjacentHTML('beforeend', drawer(`PDF 表格任务 ${truncate(job.file_name || job.id, 30)}`, `
          <div class="drawer-section">
            <p><b>状态：${esc(job.status)}</b>｜页 ${num(job.pages_processed)}/${num(job.pages_total)}｜页处理率 ${esc(job.coverage_label || '')}｜
            表格 ${num(job.table_count)}｜行 ${num(job.row_count)}｜失败页 ${num(job.pages_failed)}</p>
            ${job.partial_reason ? `<p class="hint">partial/失败原因：${esc(job.partial_reason)}；扫描空页不等于零家企业。</p>` : ''}
            ${job.error ? `<div class="callout callout-warn">${esc(job.error)}</div>` : ''}
            <h4>逐页结果</h4>
            <div class="table-wrap"><table class="grid compact">
              <thead><tr><th>页码</th><th>文本层</th><th>表格</th><th>行</th><th>状态</th></tr></thead>
              <tbody>${pages || '<tr><td colspan="5" class="muted">无页记录</td></tr>'}</tbody>
            </table></div>
            <h4>表格预览（最多 5 张）</h4>
            ${tableBlocks || '<p class="muted">没有提取到表格；这不等于“零家企业”。</p>'}
            <p class="hint">${esc(d.note || '')}</p>
          </div>`, { wide: true }));
        document.querySelectorAll('[data-close-drawer]').forEach((x) => x.addEventListener('click', () => {
          document.querySelector('.drawer-backdrop')?.remove();
          document.querySelector('.drawer')?.remove();
        }));
      } catch (err) {
        toast(err.body?.error || err.message, 'error');
      } finally {
        el.disabled = false;
      }
    });
  });
}

async function renderIntelligence(body, q = {}) {
  const [d, idx, pdf] = await Promise.all([
    api('/api/v2/admin/rss-sources?limit=100'),
    api('/api/v2/admin/search-index').catch((e) => ({ __error: e })),
    api('/api/v2/admin/pdf-tables?limit=20').catch((e) => ({ __error: e })),
  ]);
  const sources = d.sources || [];
  const candidates = d.candidates || [];
  const limits = d.limits || {};
  const idxStatus = idx.status || {};
  const pdfWorker = pdf.worker || {};
  const pdfJobs = pdf.jobs || [];
  const pdfCandidates = pdf.__error ? [] : (await api('/api/v2/admin/pdf-tables/candidates?limit=100').catch(() => ({ candidates: [] }))).candidates || [];
  body.innerHTML = `
    <div class="callout callout-info">
      <b>第一阶段：正文清洗 · 实质变化与版本 · 字段引句证据 · RSS 候选发现</b>
      <p class="hint">RSS/Atom 只提供候选标题、链接、日期和订阅摘要；订阅摘要不是全文，正文仍走既有抓取/清洗/摘要流程。
      地址保存前拒绝内网、本机、字面 IP 与带凭据 URL；解析器拒绝 DOCTYPE/ENTITY，禁止外部实体。</p>
      <p class="hint">每日任务默认最多 ${esc(limits.max_sources_per_run || 5)} 个来源、每源 ${esc(limits.max_items_per_source || 20)} 条、
      正文抓取 ${esc(limits.max_fetch_bodies || 3)} 条、总预算 ${Math.round(Number(limits.budget_ms || 60000) / 1000)} 秒。</p>
    </div>

    ${card({
      title: '中文全文索引（FTS5）',
      subtitle: idx.__error
        ? '索引状态不可用'
        : `${idxStatus.ready ? '可用' : '未就绪'}｜文档 ${num(idxStatus.doc_count)}｜索引 ${num(idxStatus.fts_count)}｜待刷新 ${num(idxStatus.dirty_count)}｜版本 ${esc(idxStatus.version || '—')}`,
      body: idx.__error
        ? errorState(idx.__error)
        : `<p>${esc(idxStatus.note || '')}</p>
          <p class="form-static">最近构建：${esc(idxStatus.last_build_at ? dateTime(idxStatus.last_build_at) : '—')}
          ｜最近完整构建：${esc(idxStatus.last_full_build_at ? dateTime(idxStatus.last_full_build_at) : '—')}
          ｜状态：${esc(idxStatus.last_full_status || '未构建')}</p>
          <form id="fts-rebuild-form" class="form-grid">
            <label class="fld"><span>本批最多处理（每种类型）</span>
              <input name="max_docs" type="number" min="1" max="${esc(String(idx.limits?.max_batch || 20000))}" value="2000"></label>
            <div class="fld"><button class="btn btn-primary" type="submit">重建/增量刷新索引</button></div>
          </form>
          <p class="hint">查询不会触发全库重建；后台按有限批次构建。未完整构建时统一检索如实回退既有检索并显示 mode=legacy_fallback。
          中文双字、英文编号（含 CCER-10-001）、真实总数分页均由索引提供。</p>`,
      note: '普通用户不能写索引；索引只覆盖公开实体，不包含用户、凭据、审计或配置。',
    })}

    ${card({
      title: 'PDF 表格解析（pdfplumber 独立 worker）',
      subtitle: pdf.__error
        ? 'worker 状态不可用'
        : `${esc(pdfWorker.parser || 'pdfplumber')}｜${pdfWorker.availability === 'not_probed' ? '可用性尚未探测' : pdfWorker.available ? '最近真实任务可用' : '最近真实任务不可用'}｜任务 ${num(pdfWorker.counts?.total)}｜完成 ${num(pdfWorker.counts?.done)}｜部分 ${num(pdfWorker.counts?.partial)}｜失败 ${num(pdfWorker.counts?.failed)}`,
      body: pdf.__error ? errorState(pdf.__error) : `
        <p class="hint">${esc(pdfWorker.note || '')}</p>
        <form id="pdf-run-form" class="form-grid">
          <label class="fld fld-wide"><span>受限原件（已归档）</span><select name="target">
            <option value="">— 选择已归档原件 —</option>
            ${pdfCandidates.map((c) => `<option value="${esc(c.kind)}|${esc(c.id)}">${esc(c.kind)}｜${esc(truncate(c.title || c.file_name, 52))}（${esc(c.size_label || '')}）</option>`).join('')}
          </select><small>只列受限根内真实存在的 PDF；管理员上传/OCR 治理归档的原件也可选。</small></label>
          <label class="fld fld-wide"><span>或受限根内路径（可选，用于验收样本）</span><input name="path" placeholder="data/backups/.../samples/hunan-steel-2026.pdf"></label>
          <label class="fld"><span>最多页数</span><input name="max_pages" type="number" min="1" max="${esc(String(pdfWorker.limits?.max_pages || 500))}" value="20"></label>
          <div class="fld"><button class="btn btn-primary" type="submit">执行表格解析</button></div>
        </form>
        <p class="hint">单并发；文件 ≤ ${Math.round(Number(pdfWorker.limits?.max_bytes || 0) / 1024 / 1024)} MB、页数 ≤ ${esc(String(pdfWorker.limits?.max_pages || 500))}、
        超时 ${Math.round(Number(pdfWorker.limits?.timeout_ms || 0) / 1000)} 秒。只接受受限根内 .pdf，拒绝 ../ 与符号链接越界。
        扫描/空白页只记为“无文本层/表格”，不会推断零家企业。</p>
        <div id="pdf-run-out"></div>
        ${pdfJobs.length ? table({
          pageSize: 10,
          emptyText: '尚无 PDF 表格任务',
          columns: [
            { key: 'file_name', label: '文件', render: (r) => `<b>${esc(truncate(r.file_name || r.file_path, 48))}</b><div class="muted">${esc(r.file_hash?.slice(0, 12) || '')}</div>` },
            { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'done' ? 'ok' : r.status === 'partial' ? 'warn' : r.status === 'failed' ? 'danger' : '') },
            { key: 'pages', label: '页处理率', render: (r) => `${num(r.pages_processed)}/${num(r.pages_total)}｜${esc(r.coverage_label || '')}` },
            { key: 'tables', label: '表格/行', render: (r) => `${num(r.table_count)} 表 / ${num(r.row_count)} 行` },
            { key: 'partial_reason', label: '说明', render: (r) => esc(r.partial_reason || r.error || '—') },
            { key: 'actions', label: '详情', render: (r) => `<button class="btn btn-xs" data-pdf-job="${esc(r.id)}">查看页码/行列</button>` },
          ],
          rows: pdfJobs,
        }) : '<p class="muted">尚无 PDF 表格任务；成功/失败都会如实记录页码、覆盖率和原因。</p>'}
        <p class="hint">结果包含物理页码（1 起）、表序号、行列与单元格文本；partial 表示页数上限/失败页/无文本层，不是“全文完成”。</p>`,
      note: '普通用户不能触发解析写动作；worker 不安装/调用重型模型，失败保留原件与既有正文。',
    })}

    ${card({
      title: 'RSS / Atom 来源',
      subtitle: `已配置 ${sources.length} 个来源；启用后进入每日有界发现，不启动常驻采集 worker`,
      body: `
        <form id="rss-source-form" class="form-grid">
          <label class="fld"><span>名称</span><input name="name" required maxlength="200" placeholder="例如 生态环境部新闻"></label>
          <label class="fld"><span>RSS / Atom 地址</span><input name="url" required type="url" placeholder="https://example.gov.cn/rss.xml"></label>
          <label class="fld"><input name="enabled" type="checkbox" checked> 启用</label>
          <div class="fld"><button class="btn btn-primary" type="submit">保存来源</button></div>
        </form>
        ${table({
          pageSize: 20,
          emptyText: '尚未配置 RSS 来源',
          emptyDetail: '添加公开 RSS/Atom 地址后，可在每日任务或本页手动执行有界发现。',
          columns: [
            { key: 'name', label: '名称', render: (r) => `<b>${esc(r.name)}</b><div class="muted">${esc(truncate(r.url, 60))}</div>` },
            { key: 'enabled', label: '状态', render: (r) => (r.enabled ? chip('已启用', 'ok') : chip('已停用', '')) },
            { key: 'status', label: '最近结果', render: (r) => chip(r.status || 'never', r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
            { key: 'last_success_at', label: '最近成功', render: (r) => esc(r.last_success_at ? dateTime(r.last_success_at) : '—') },
            { key: 'items', label: '累计', align: 'right', render: (r) => `${num(r.items_seen)} 条 / 新增 ${num(r.items_new)}` },
            { key: 'last_error', label: '最近失败', render: (r) => (r.last_error ? `<span class="muted" title="${esc(r.last_error)}">${esc(truncate(r.last_error, 42))}</span>` : '—') },
            { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-rss-test="${esc(r.id)}">真实解析测试</button>
              <button class="btn btn-xs" data-rss-discover="${esc(r.id)}">有界发现</button>
              <button class="btn btn-xs" data-rss-toggle="${esc(r.id)}" data-on="${r.enabled ? '0' : '1'}">${r.enabled ? '停用' : '启用'}</button>` },
          ],
          rows: sources,
        })}
        <p class="hint">「真实解析测试」会请求该地址一次并显示真实条目数；「有界发现」只处理有限条目，默认不抓正文。</p>`,
      note: 'RSS 来源地址与条目链接都会做内网/协议校验；失败如实显示，不用空结果假装成功。',
    })}

    ${card({
      title: 'RSS 候选',
      subtitle: `最近 ${candidates.length} 条候选；订阅摘要不作为全文`,
      body: table({
        pageSize: 25,
        emptyText: '尚无 RSS 候选',
        columns: [
          { key: 'published_at', label: '发布日', render: (r) => esc(r.published_at || '未披露') },
          { key: 'title', label: '标题', render: (r) => `${esc(truncate(r.title || '(无标题)', 64))}<div class="muted">${esc(truncate(r.url, 72))}</div>` },
          { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'inserted' ? 'ok' : r.status === 'failed' ? 'danger' : '') },
          { key: 'content_item_id', label: '入库条目', render: (r) => (r.content_item_id ? `<code>${esc(r.content_item_id)}</code>` : '—') },
          { key: 'discovered_at', label: '发现时间', render: (r) => esc(dateTime(r.discovered_at)) },
        ],
        rows: candidates,
      }),
      note: '候选按 URL 幂等；同一 URL 重复出现不会重复入库。摘要只来自订阅源，不声称已读全文。',
    })}
  `;

  body.querySelector('#fts-rebuild-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const maxDocs = Math.max(1, Number(fd.get('max_docs')) || 2000);
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '构建中…'; }
    try {
      const out = await api('/api/v2/admin/search-index/rebuild', {
        method: 'POST', body: { max_docs: maxDocs },
      });
      toast(`索引批次：处理 ${out.indexed || 0}，新增 ${out.inserted || 0}，更新 ${out.updated || 0}，跳过 ${out.skipped || 0}`, out.truncated ? 'warn' : 'ok');
      await renderIntelligence(body, q);
    } catch (err) {
      toast(err.body?.error || err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '重建/增量刷新索引'; }
    }
  });

  body.querySelector('#pdf-run-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const target = String(fd.get('target') || '');
    const path = String(fd.get('path') || '').trim();
    const payload = {
      max_pages: Math.max(1, Number(fd.get('max_pages')) || 20),
    };
    if (path) payload.path = path;
    else if (target.includes('|')) {
      const [kind, id] = target.split('|');
      payload.target_kind = kind;
      payload.target_id = id;
    } else {
      toast('请选择受限原件或填写受限根内路径', 'warn');
      return;
    }
    const outBox = body.querySelector('#pdf-run-out');
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '解析中…'; }
    if (outBox) outBox.innerHTML = loading('正在启动独立 pdfplumber worker；只读取受限原件，不联网、不调用模型…');
    try {
      const out = await api('/api/v2/admin/pdf-tables/run', { method: 'POST', body: payload });
      const job = out.job || out.body?.job;
      if (outBox) {
        outBox.innerHTML = `<div class="callout ${job?.status === 'done' ? 'callout-info' : 'callout-warn'}">
          <b>任务 ${esc(job?.id || '')}：${esc(job?.status || 'unknown')}</b>
          <p>页 ${num(job?.pages_processed)}/${num(job?.pages_total)}｜页处理率 ${esc(job?.coverage_label || '')}｜表格 ${num(job?.table_count)}｜行 ${num(job?.row_count)}｜失败页 ${num(job?.pages_failed)}</p>
          <p>${esc(out.note || job?.error || '')}</p>
          ${job?.partial_reason ? `<p class="hint">partial/失败原因：${esc(job.partial_reason)}。扫描空页不等于零家企业。</p>` : ''}
          ${job?.id ? `<button class="btn btn-sm" data-pdf-job="${esc(job.id)}">查看页码/行列</button>` : ''}
        </div>`;
      }
      toast(out.ok ? `PDF 表格任务：${job?.status || '完成'}` : (out.error || job?.error || '解析失败'), out.ok ? 'ok' : 'warn');
      bindPdfJobButtons(body);
    } catch (err) {
      const msg = err.body?.error || err.body?.job?.error || err.message;
      if (outBox) outBox.innerHTML = errorState(err);
      toast(msg, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '执行表格解析'; }
    }
  });

  bindPdfJobButtons(body);

  body.querySelector('#rss-source-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = { name: fd.get('name'), url: fd.get('url'), enabled: fd.get('enabled') === 'on' };
    try {
      await api('/api/v2/admin/rss-sources', { method: 'POST', body: payload });
      toast('RSS 来源已保存', 'ok');
      await renderIntelligence(body, q);
    } catch (err) {
      toast(err.body?.error || err.message, 'error');
    }
  });
  body.querySelectorAll('[data-rss-test]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true; el.textContent = '解析中…';
    try {
      const out = await api(`/api/v2/admin/rss-sources/${el.dataset.rssTest}/test`, { method: 'POST', body: {} });
      toast(out.ok ? `解析成功：${out.items} 条（${out.format}）` : `解析失败：${out.message || out.reason}`, out.ok ? 'ok' : 'warn');
      await renderIntelligence(body, q);
    } catch (err) {
      toast(err.body?.error || err.message, 'error');
      el.disabled = false; el.textContent = '真实解析测试';
    }
  }));
  body.querySelectorAll('[data-rss-discover]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true; el.textContent = '发现中…';
    try {
      const out = await api(`/api/v2/admin/rss-sources/${el.dataset.rssDiscover}/discover`, {
        method: 'POST', body: { max_items: 20, fetch_bodies: false, budget_ms: 60000 },
      });
      toast(out.ok ? `有界发现完成：候选 ${out.items}，新增 ${out.inserted}` : `发现失败：${out.message || out.reason}`, out.ok ? 'ok' : 'warn');
      await renderIntelligence(body, q);
    } catch (err) {
      toast(err.body?.error || err.message, 'error');
      el.disabled = false; el.textContent = '有界发现';
    }
  }));
  body.querySelectorAll('[data-rss-toggle]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true;
    try {
      await api(`/api/v2/admin/rss-sources/${el.dataset.rssToggle}/pause`, {
        method: 'POST', body: { enabled: el.dataset.on === '1' },
      });
      toast(el.dataset.on === '1' ? 'RSS 来源已启用' : 'RSS 来源已停用', 'ok');
      await renderIntelligence(body, q);
    } catch (err) {
      toast(err.body?.error || err.message, 'error');
      el.disabled = false;
    }
  }));
}

