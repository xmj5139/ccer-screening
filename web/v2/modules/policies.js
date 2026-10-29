/**
 * 模块二：政策和方法学
 * ============================================================================
 * 需求（docs/19 第 21 条）：
 *   - 全国 CCER 规则、配套技术文件和相关部委政策；正式、征求意见、修订、废止**分开**；
 *   - 方法学含原文、适用范围、关键条件、参数、自动解读和版本变化；
 *   - **不得因为取消人工审核就把草案当现行正式方法学**；
 *   - AI 解读标「自动生成」，展示证据引用和核验结果；缺正文时不声称已读原文。
 *
 * 【本轮升级】删除全部人工确认入口：政策确认、变更待确认、领域复核签字。
 * 采集到的官方原文变化作为**自动运行状态**展示，不产生待办。
 */
import { api, setQuery, state } from '../app.js';
import {
  card, table, loading, emptyState, errorState, noteBlock, esc, shortDate, dateTime, chip,
  drawer, kv, toast, num, truncate,
} from '../ui.js';
import { verifyChip } from './verify-labels.js';
import { summaryBlock, summaryCoverageHint, sourceBlock, sourceLinkBlock } from '../platform.js';

const TABS = [
  { key: 'policies', label: '政策库' },
  { key: 'methodologies', label: '方法学库' },
  { key: 'changes', label: '原文变化（自动检测）' },
  { key: 'completeness', label: '目录完整性' },
];

const CATEGORY_FALLBACK = [
  ['management', '管理办法'], ['registration', '注册登记规则'], ['validation', '审定核查规则'],
  ['trading', '交易结算规则'], ['design_guide', '项目设计实施指南'], ['factor_doc', '监测与排放因子文件'],
  ['ministry_policy', '相关部委政策'], ['consultation', '征求意见文件'],
];

export async function renderPolicies(root, route) {
  const q = route.query || {};
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'policies';
  root.innerHTML = `
    <div class="tabs">${TABS.map((t) => `<a class="tab ${t.key === tab ? 'active' : ''}" href="#/policies?tab=${t.key}">${esc(t.label)}</a>`).join('')}</div>
    <div id="tab-body">${loading()}</div>`;
  const body = document.getElementById('tab-body');
  try {
    if (tab === 'policies') await renderPolicyTab(body, q);
    else if (tab === 'methodologies') await renderMethodologyTab(body, q);
    else if (tab === 'changes') await renderChangesTab(body);
    else await renderCompletenessTab(body);
  } catch (e) {
    body.innerHTML = errorState(e);
  }
}

/* ------------------------------ 政策库 ------------------------------ */

async function renderPolicyTab(body, q) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([k, v]) => v && k !== 'tab'))).toString();
  const data = await api(`/api/v2/policies${qs ? `?${qs}` : ''}`);
  // CEA 入口：失败不阻塞 CCER 政策库，如实显示不可用
  const ceaDocs = await api('/api/v2/cea/documents?doc_status=formal&limit=6').catch((e) => ({ __error: e }));
  const stats = data.stats || {};
  body.innerHTML = `
  <div class="filters">
    <label class="fld"><span>关键词（标题/文号/机关/摘要）</span><input type="search" data-f="keyword" value="${esc(q.keyword || '')}" placeholder="例如：方法学、注册登记"></label>
    <label class="fld"><span>分类</span><select data-f="category"><option value="">全部</option>
      ${(stats.categories || CATEGORY_FALLBACK.map(([key, label]) => ({ key, label }))).map((c) => `<option value="${esc(c.key)}" ${q.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
    <label class="fld"><span>状态</span><select data-f="doc_status"><option value="">全部</option>
      ${(stats.by_status || []).map((s) => `<option value="${esc(s.key)}" ${q.doc_status === s.key ? 'selected' : ''}>${esc(s.label)}（${s.count}）</option>`).join('')}</select></label>
    <label class="fld"><span>发布日期从</span><input type="date" data-f="publish_from" value="${esc(q.publish_from || '')}"></label>
    <label class="fld"><span>至</span><input type="date" data-f="publish_to" value="${esc(q.publish_to || '')}"></label>
    <span class="fld-actions">
      <a class="btn btn-sm" href="/api/v2/policies/export?format=csv${qs ? `&${qs}` : ''}" download>导出 CSV</a>
      <a class="btn btn-sm" href="/api/v2/policies/export?format=xlsx${qs ? `&${qs}` : ''}" download>导出 Excel</a>
    </span>
  </div>

  <div class="metrics metrics-sm">
    ${miniMetric('政策条目', stats.total, '条', '官方原文自动采集，无人工确认环节')}
    ${miniMetric('原件已归档', stats.archived_originals, '条', '归档原件才可引用页码')}
    ${miniMetric('自动核验通过', stats.auto_verified ?? 0, '条', '规则与模型一致性检查结论')}
    ${miniMetric('最近发布', shortDate(stats.latest_publish_date), '', '按发布日期的最大值')}
  </div>

  <div class="card">
    <div class="card-head"><div><h3>政策清单</h3><p class="muted">点击行查看原文链接、附件、原文变化与影响面</p></div></div>
    <div class="card-body">
      ${table({
        rows: data.policies || [],
        pageSize: 20,
        columns: [
          { key: 'title', label: '标题与核心摘要', render: (r) => `<a class="link title-cell" data-policy="${esc(r.id)}">${esc(truncate(r.title, 60))}</a>${summaryBlock(r, { compact: true })}` },
          { key: 'category_label', label: '分类' },
          { key: 'status_label', label: '状态', definition: '现行有效/已被替代/已废止/征求意见中/公告 —— 正式与征求意见分开，草案不得当作正式方法学' },
          { key: 'doc_number', label: '文号' },
          { key: 'issuing_authority', label: '发布机关' },
          { key: 'publish_date', label: '发布日期', render: (r) => esc(shortDate(r.publish_date)) },
          { key: 'effective_date', label: '生效日期', render: (r) => esc(shortDate(r.effective_date)) },
          { key: 'source_display', label: '来源', definition: '官方信息 / 第三方实际发布机构 / 来源未标注（按 hostname 精确或受控子域匹配）', render: (r) => sourceBlock(r) },
          { key: 'archived_count', label: '已归档', align: 'right' },
          { key: 'detected_changes', label: '原文变化', align: 'right', render: (r) => (r.detected_changes ? chip(String(r.detected_changes), 'warn') : '—') },
        ],
        emptyText: '没有符合条件的政策',
        emptyHint: '可放宽关键词或日期范围',
      })}
      ${summaryCoverageHint(data.policies || [])}
      ${noteBlock('政策条款以官方原文为准；未归档原件时只能引用到文件与章节层级。全部条目均为自动采集；核验状态属内部数据，仅在后台展示。')}
    </div>
  </div>

  ${ceaEntryCard(ceaDocs)}`;

  wireFilters(body, ['keyword', 'category', 'doc_status', 'publish_from', 'publish_to'], { keyword: 400 });
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-policy]');
    if (!a) return;
    const id = a.dataset.policy;
    try {
      const d = await api(`/api/v2/policies/${id}`);
      showPolicyDrawer(d);
    } catch (err) {
      toast(err.message, 'danger');
    }
  });
}

/**
 * CEA 政策与配额入口区块（全国碳排放配额）。
 * 只展示已采集的现行正式文件；CEA 与 CCER 规则分属两个市场，不在同一清单里混排。
 */
function ceaEntryCard(ceaDocs) {
  if (ceaDocs?.__error) {
    return card({
      title: 'CEA 政策与配额（全国碳排放配额）',
      subtitle: '配额分配方案、年度管理工作通知、结转规定、行情编制方案等',
      actions: '<a class="btn btn-sm" href="#/cea?tab=policy">进入 CEA 政策配额</a>',
      body: `${errorState(ceaDocs.__error)}<p class="hint">CEA 接口不可用时本区块不显示替代内容（HTTP ${esc(String(ceaDocs.__error.status || '—'))}）。</p>`,
    });
  }
  const rows = ceaDocs?.rows || [];
  return card({
    title: 'CEA 政策与配额（全国碳排放配额）',
    subtitle: `现行正式文件 ${rows.length} 条（按发布日倒序，最多展示 6 条）｜CEA 是配额与履约市场，规则与 CCER 分开`,
    actions: '<a class="btn btn-sm" href="#/cea?tab=policy">进入 CEA 政策配额</a>',
    body: rows.length
      ? `<ul class="list">${rows.map((d) => `<li>
          <div class="list-head"><b>${esc(truncate(d.title, 60))}</b><span class="muted right">${esc(shortDate(d.publish_date))}</span></div>
          ${summaryBlock(d, { compact: true })}
          <div class="list-foot">
            <span class="chip chip-muted">${esc(d.doc_number || '文号未标注')}</span>
            ${sourceBlock(d)}
            ${sourceLinkBlock(d, { label: '官方原文' })}
            <a class="link" href="#/cea?tab=policy&doc=${encodeURIComponent(d.id)}">查看详情</a>
          </div></li>`).join('')}</ul>${summaryCoverageHint(rows)}`
      : emptyState('尚未采集到 CEA 现行正式文件', 'CEA 文件采集完成后在此显示；不用占位条目填充。', '可在后台「CEA 配额市场 → 采集」触发 documents 采集'),
    note:
      'CEA 文件的适用性按「行业×年度」配对判定，不能由覆盖行业清单 × 适用年度清单推导。' +
      '来源以官方信息 / 实际发布机构为主展示；核验状态属内部数据，仅在后台展示。',
  });
}

function showPolicyDrawer(d) {
  const p = d.policy;
  const changes = (d.changes || []).map((c) => `
    <li><div class="list-head"><b>${esc(c.change_kind)}</b><span class="muted right">${esc(dateTime(c.detected_at))}</span></div>
    <p class="muted">${esc(c.diff_summary || '')}</p>
    <div class="list-foot"><span class="chip chip-muted">自动检测，无需人工处理</span></div></li>`).join('');
  const atts = (d.attachments || []).map((a) => `<tr><td>${esc(a.file_name)}</td><td>${esc(a.file_type || '—')}</td>
    <td>${esc(a.parse_quality || '—')}</td><td>${esc(a.file_hash ? a.file_hash.slice(0, 12) : '—')}</td>
    <td>${a.url ? `<a class="link" href="${esc(a.url)}" target="_blank" rel="noreferrer noopener">打开</a>` : '—'}</td></tr>`).join('');
  const impact = d.impact_preview;
  document.body.insertAdjacentHTML('beforeend', drawer('政策详情', `
    <h4>${esc(p.title)}</h4>
    ${summaryBlock(p)}
    ${kv([
      ['分类', esc(p.category_label)],
      ['状态', esc(p.status_label)],
      ['文号', esc(p.doc_number || '—')],
      ['发布机关', esc(p.issuing_authority || '—')],
      ['发布日期', esc(shortDate(p.publish_date))],
      ['生效日期', esc(shortDate(p.effective_date))],
      ['采集时间', esc(dateTime(p.collected_at))],
      ['来源', sourceBlock(p)],
      ['官方原文', p.official_url ? `<a class="link src-link" href="${esc(p.official_url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(p.official_url, 60))}</a>` : '<span class="muted">来源未标注</span>'],
      ...(state.user?.role === 'admin' ? [['内部核验（仅管理员）', verifyChip(p.auto_verify_status)]] : []),
    ])}
    ${p.manual_revision ? `<p class="hint">本条目含**管理员修订**字段：${esc((p.manual_fields || []).join('、'))}；原始采集值保存在覆盖层，可在后台查看历史并恢复。</p>` : ''}
    <p>${esc(p.summary || '')}</p>
    <h5>附件与原件归档</h5>
    ${atts ? `<table class="grid grid-sm"><thead><tr><th>文件</th><th>类型</th><th>解析质量</th><th>哈希</th><th>链接</th></tr></thead><tbody>${atts}</tbody></table>` : '<p class="muted">尚未归档原件。</p>'}
    ${(d.supplemental_documents || []).length ? `<h5>管理员补充资料（模型已核对内容身份）</h5>${d.supplemental_documents.map((u) => `<details><summary>${esc(u.file_name)}</summary><p class="hint">${esc(u.ai_summary || '')} · ${u.source_status === 'official_hash_match' ? '文件与官方原件一致' : '来源未独立证实'} · ${u.text_source === 'admin_transcript' ? '管理员提供 OCR 文字' : 'PDF 提取正文'}</p><pre style="white-space:pre-wrap;word-break:break-word">${esc(u.extracted_text || '')}</pre></details>`).join('')}` : ''}
    <h5>原文变化（自动检测，${(d.changes || []).length}）</h5>
    ${changes ? `<ul class="list">${changes}</ul>` : '<p class="muted">暂未检测到官方原文变化。</p>'}
    <h5>影响面（自动列出，仅作提示）</h5>
    ${impact ? `<p class="muted">受影响方法学 ${impact.affected_methodologies.length} 项｜相关项目 ${impact.affected_projects.length} 个</p>
      ${impact.affected_methodologies.length ? `<ul class="list">${impact.affected_methodologies.map((m) => `<li>${esc(m.code_display || m.methodology_id)} ${esc(m.version)}｜${esc(m.name)}</li>`).join('')}</ul>` : ''}
      <p class="hint">${esc(impact.note)}</p>` : ''}
    <p class="hint">${esc(d.note || '')}</p>
  `, { wide: true }));
}

/* ------------------------------ 方法学库 ------------------------------ */

async function renderMethodologyTab(body, q) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([k, v]) => v && k !== 'tab'))).toString();
  const data = await api(`/api/v2/methodologies${qs ? `?${qs}` : ''}`);
  const counts = data.counts || {};
  body.innerHTML = `
  <div class="filters">
    <label class="fld"><span>关键词</span><input type="search" data-f="keyword" value="${esc(q.keyword || '')}" placeholder="编号 / 名称"></label>
    <label class="fld"><span>领域</span><select data-f="domain"><option value="">全部</option>
      ${(data.domains || []).map((d) => `<option value="${esc(d)}" ${q.domain === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
    <span class="fld-actions"><span class="chip">正式 ${counts.formal ?? 0}</span><span class="chip">草案 ${counts.draft ?? 0}</span>
      <span class="chip chip-warn">编号待核实 ${counts.code_pending ?? 0}</span>
      <span class="chip chip-ok">已对照原文 ${counts.doc_verified ?? 0}</span>
      <span class="chip ${counts.calculable ? 'chip-ok' : 'chip-danger'}">可出数 ${counts.calculable ?? 0}</span></span>
  </div>
  ${methodologyTable('正式发布方法学', data.formal || [])}
  ${methodologyTable('征求意见 / 草案（不参与资格判断与测算）', data.draft || [])}
  ${noteBlock(data.note)}`;

  wireFilters(body, ['keyword', 'domain'], { keyword: 400 });
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-mv]');
    if (!a) return;
    try {
      const d = await api(`/api/v2/methodologies/${a.dataset.mv}`);
      await showMethodologyDrawer(d);
    } catch (err) {
      toast(err.message, 'danger');
    }
  });
}

function methodologyTable(title, rows) {
  return card({
    title,
    subtitle: `${rows.length} 项`,
    body: table({
      rows,
      pageSize: 15,
      columns: [
        { key: 'code_display', label: '编号', render: (r) => `<a class="link" data-mv="${esc(r.id)}">${esc(r.code_display || '（编号待核实）')}</a>` },
        { key: 'name', label: '名称与核心摘要', render: (r) => `<span class="title-cell">${esc(r.name)}</span>${summaryBlock(r, { compact: true })}` },
        { key: 'version', label: '版本' },
        { key: 'domain', label: '领域' },
        { key: 'release_date', label: '发布日期', render: (r) => esc(shortDate(r.release_date)) },
        { key: 'catalog_confidence', label: '编号来源', render: (r) => (r.catalog_confidence === 'verified_from_official_notice' ? chip('已逐字核实', 'ok') : chip('待核实', 'warn')) },
        { key: 'gate', label: '原文对照', render: (r) => chip(r.gate?.evidence_short || '—', r.gate?.evidence_level === 'official_original_verified' ? 'ok' : 'warn') },
        { key: 'source_display', label: '来源', definition: '官方信息 / 第三方实际发布机构 / 来源未标注', render: (r) => sourceBlock(r) },
        { key: 'calc', label: '测算可用性', render: (r) => chip(r.gate?.can_calculate ? '可出数' : '暂不支持自动测算', r.gate?.can_calculate ? 'ok' : 'danger') },
        { key: 'public_projects', label: '系统内公开项目', align: 'right' },
      ],
      emptyText: '没有符合条件的方法学',
    }) + summaryCoverageHint(rows),
  });
}

async function showMethodologyDrawer(d) {
  const v = d.version;
  let lineage = null;
  try {
    lineage = await api(`/api/v2/methodology-versions/${encodeURIComponent(v.id)}/timeline`);
  } catch {
    lineage = null;
  }
  const gate = d.gate || {};
  const ver = d.verification;
  const rules = (d.rules || []).map((r) => `<tr><td>${esc(r.rule_key)}</td><td>${esc(r.title)}</td><td>${esc(r.layer || '')}</td>
     <td>${chip(r.severity === 'blocking' ? '硬性' : '一般', r.severity === 'blocking' ? 'danger' : '')}</td>
     <td>${esc(r.clause_ref || '—')}</td></tr>`).join('');
  const formulas = (d.formulas || []).map((f) => `<tr><td>${esc(f.formula_key || f.key || '')}</td><td>${esc(f.expression || f.expr || '')}</td>
     <td>${esc(f.clause_ref || '—')}</td><td>${esc(f.description || '')}</td></tr>`).join('');
  const factors = (d.factors || []).map((f) => `<tr><td>${esc(f.factor_key)}</td><td>${esc(f.name || '')}</td>
     <td class="ta-r">${esc(f.value_num ?? f.value_text ?? '—')}</td><td>${esc(f.unit || '')}</td>
     <td>${esc(f.year || f.applicable_year || '—')}</td><td>${esc(f.source_note || '')}</td>
     <td>${f.value_status === 'placeholder' ? chip('占位/未确认', 'danger') : chip(f.value_status || 'ok', 'ok')}</td></tr>`).join('');
  const interp = (d.interpretations || []).map((i) => `
    <div class="interp">
      <div class="list-head"><b>${esc(SECTION_LABEL[i.section] || i.section)}</b>
        ${i.origin === 'llm_draft' ? chip('自动生成', 'warn') : chip('人工录入', '')}</div>
      <p>${esc(i.content)}</p>
      <div class="list-foot"><span class="muted">${(i.citations || []).length ? `证据引用 ${(i.citations || []).length} 条` : '无证据引用'}</span></div>
    </div>`).join('');
  const blockers = (gate.blockers || []).map((b) => `<li>${esc(b)}</li>`).join('');
  const remaining = (ver?.remaining_blockers || []).map((b) => `<li>${esc(b)}</li>`).join('');

  const lineageEvents = lineage
    ? lineage.timeline.flatMap((x) => (x.events || []).map((e) => ({
        ...e,
        version_label: `${x.code_display || x.version}｜${x.version}`,
        version_status: x.status_label,
      }))).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    : [];
  const allRelations = lineage
    ? lineage.timeline.flatMap((x) => (x.relations || []).map((r) => ({ ...r, version_label: x.version })))
    : [];
  const lineageHtml = lineage
    ? `<div class="version-lineage">
        <div class="chip-row">
          <span class="chip chip-ok">正式 ${lineage.formal.length}</span>
          <span class="chip chip-muted">征求意见/草案 ${lineage.draft.length}</span>
          <span class="chip chip-muted">当前版本 ${esc(v.version)}</span>
        </div>
        ${lineageEvents.length ? `<ol class="version-events">${lineageEvents.map((e) => `<li class="version-event version-event-${esc(e.status)}">
          <div class="list-head"><b>${esc(e.label)}</b><span class="muted right">${esc(shortDate(e.date))}</span></div>
          <div class="list-foot"><span class="chip ${e.status === 'confirmed' ? 'chip-ok' : 'chip-muted'}">${esc(e.status_label || (e.status === 'confirmed' ? '已确认' : '记录值'))}</span>
            <span class="muted">${esc(e.version_label)}</span></div>
          <p class="muted">原文：${e.official_url ? `<a class="link" href="${esc(e.official_url)}" target="_blank" rel="noopener noreferrer">打开</a>` : '未登记'}｜文件哈希：${esc(e.file_hash || '未登记')}｜日期：${esc(shortDate(e.date))}</p>
          ${e.evidence_locator ? `<p class="muted">证据定位：${esc(e.evidence_locator)}${e.evidence_quote ? `｜引文：${esc(truncate(e.evidence_quote, 120))}` : ''}</p>` : '<p class="hint">该事件来自结构化日期/状态；未附原文定位，不据此推断其它版本关系。</p>'}
          ${e.note ? `<p class="muted">${esc(e.note)}</p>` : ''}
        </li>`).join('')}</ol>` : '<p class="muted">暂无可展示的版本事件。</p>'}
        ${allRelations.length ? `<h5>版本关系（有证据才确认）</h5><ul class="bullets">${allRelations.slice(0, 12).map((r) => `<li>${esc(r.relation_type_label || r.relation_type)}：${esc(r.from?.code_display || r.from_version_id)} → ${esc(r.to?.code_display || r.to_version_id)}
          ${r.status === 'confirmed' ? chip('已确认', 'ok') : chip('候选/待核实', 'warn')}
          ${r.evidence_locator ? `<span class="muted">（${esc(r.evidence_locator)}）</span>` : ''}</li>`).join('')}</ul>` : '<p class="hint">尚无版本关系记录；不按编号相邻推断继承关系。</p>'}
        <h5>版本差异（来源定位）</h5>
        <div class="version-diff-controls">
          <label class="fld"><span>对比版本</span><select id="mv-compare-to">
            ${lineage.timeline.filter((x) => x.id !== v.id).map((x) => `<option value="${esc(x.id)}">${esc(x.code_display || x.version)}｜${esc(x.status_label)}</option>`).join('') || '<option value="">无可对比版本</option>'}
          </select></label>
          <button class="btn btn-sm" id="mv-diff-run" type="button" ${lineage.timeline.length < 2 ? 'disabled' : ''}>比较差异</button>
        </div>
        <div id="mv-diff-result" class="version-diff-result"></div>
        <p class="hint">${esc(lineage.note || '')}</p>
        ${lineage.timeline.filter((x) => x.calculation_runs > 0).map((x) => `<p class="muted">${esc(x.code_display || x.version)}：${esc(x.calculation_runs_note)}</p>`).join('')}
      </div>`
    : '<p class="muted">版本跟踪数据暂不可用；本页仍展示当前版本原文与规则卡，不推测版本关系。</p>';

  document.body.insertAdjacentHTML('beforeend', drawer('方法学详情', `
    <h4>${esc(v.code_display || '（编号待核实）')} ${esc(v.version)}｜${esc(v.name)}</h4>
    ${kv([
      ['状态', v.document_status === 'formal' ? '正式发布' : '草案 / 征求意见（不得当作现行正式方法学）'],
      ['领域', esc(v.domain || '—')],
      ['适用项目类型', esc((v.project_types || []).join('、') || '—')],
      ['技术路线', esc((v.tech_routes || []).join('、') || '—')],
      ['发布日期', esc(shortDate(v.release_date))],
      ['官方原文', gate.official_url ? `<a class="link" href="${esc(gate.official_url)}" target="_blank" rel="noreferrer noopener">PDF / 通知原文</a>` : '未登记（缺正文时不声称已读原文）'],
      ['文号', esc(gate.doc_number || '—')],
      ['自动核验', verifyChip(v.auto_verify_status)],
      ['规则卡状态', esc(v.rulecard_status || '—')],
      ['插件审批状态', esc(v.calculator_status || '—')],
    ])}
    <div class="callout ${gate.can_calculate ? 'callout-ok' : 'callout-warn'}">
      <b>${gate.can_calculate ? '可出数（业务通道）' : '暂不支持自动测算'}</b>
      ${blockers ? `<ul>${blockers}</ul>` : '<p>全部门禁已满足。</p>'}
      <p class="hint">文档解析、自动测试与原文对照都不等于主管部门确认；缺正文时不出数、不声称已读原文。</p>
    </div>
    ${ver ? `<h5>原文对照台账</h5>
      ${kv([
        ['证据等级', esc(gate.evidence_label || ver.evidence_level)],
        ['已核对章节', esc((ver.sections_verified || []).join('、') || '—')],
        ['逐条对照文档', esc(ver.traceability_doc || '—')],
        ['独立复算实现', esc(ver.independent_impl || '—')],
        ['独立复算脚本', esc(ver.independent_runner || '—')],
        ['最近复算结论', esc(ver.independent_result || '—')],
      ])}
      ${ver.coverage ? `<p class="muted">覆盖统计：规则 ${ver.coverage.rules ?? '—'}｜硬性规则 ${ver.coverage.blocking_rules ?? '—'}｜公式 ${ver.coverage.formulas ?? '—'}｜参数 ${ver.coverage.parameters ?? '—'}｜自检样例 ${ver.coverage.self_check_samples ?? '—'}</p>` : ''}
      ${remaining ? `<p><b>仍未结清的阻断项：</b></p><ul>${remaining}</ul>` : ''}` : '<p class="muted">尚未建立原文对照台账。</p>'}
    <h5>解读层（面向投资团队）</h5>
    ${interp || '<p class="muted">暂无解读。</p>'}
    <h5>规则卡（${(d.rules || []).length} 条）</h5>
    ${rules ? `<table class="grid grid-sm"><thead><tr><th>规则</th><th>标题</th><th>层级</th><th>强度</th><th>条款</th></tr></thead><tbody>${rules}</tbody></table>` : '<p class="muted">无规则卡。</p>'}
    <h5>公式（${(d.formulas || []).length} 条）</h5>
    ${formulas ? `<table class="grid grid-sm"><thead><tr><th>编号</th><th>表达式</th><th>条款</th><th>说明</th></tr></thead><tbody>${formulas}</tbody></table>` : '<p class="muted">无公式。</p>'}
    <h5>因子与参数（${(d.factors || []).length} 条）</h5>
    ${factors ? `<table class="grid grid-sm"><thead><tr><th>键</th><th>名称</th><th>值</th><th>单位</th><th>年份</th><th>来源</th><th>状态</th></tr></thead><tbody>${factors}</tbody></table>` : '<p class="muted">无因子。</p>'}
    <h5>方法学版本跟踪</h5>
    ${lineageHtml}
    <p class="hint">${esc(d.note || '')}</p>
  `, { wide: true }));

  document.getElementById('mv-diff-run')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const target = document.getElementById('mv-compare-to')?.value;
    const box = document.getElementById('mv-diff-result');
    if (!target || !box) return;
    btn.disabled = true;
    btn.textContent = '比较中…';
    try {
      const out = await api(`/api/v2/methodology-versions/${encodeURIComponent(v.id)}/diff?compare_to=${encodeURIComponent(target)}`);
      box.innerHTML = `<div class="version-diff">
        ${out.insufficient_aspects?.length ? `<p class="callout callout-warn">无法比较：${esc(out.insufficient_aspects.join('、'))}。未用标题或相邻编号编造差异。</p>` : ''}
        <div class="table-wrap"><table class="grid grid-sm"><thead><tr><th>维度</th><th>结论</th><th>差异摘要</th><th>来源定位</th></tr></thead><tbody>
          ${(out.diffs || []).map((x) => `<tr>
            <td>${esc(x.aspect_label || x.aspect)}</td>
            <td>${x.change_kind === 'changed' ? chip('有差异', 'warn') : x.change_kind === 'same' ? chip('一致', 'ok') : chip('无法比较', 'muted')}</td>
            <td>${esc(x.summary)}</td>
            <td class="muted">${(x.evidence || []).map((ev) => `<div>${esc(ev.code_display || ev.version || '')}｜${esc(ev.locator)}<br><span class="muted">${esc(truncate(ev.quote, 90))}</span></div>`).join('') || '—'}</td>
          </tr>`).join('')}
        </tbody></table></div>
        <p class="hint">${esc(out.note || '')}</p>
      </div>`;
    } catch (err) {
      box.innerHTML = `<p class="callout callout-warn">${esc(err.body?.error || err.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '比较差异';
    }
  });
}

const SECTION_LABEL = {
  applicability: '项目类型怎么判断',
  exclusions: '常见不适用原因',
  required_data: '需要向业主索取哪些数据',
  carbon_impact: '对碳收益的影响',
};

/* ------------------------------ 原文变化（自动检测，无待办） ------------------------------ */

async function renderChangesTab(body) {
  const data = await api('/api/v2/policy-changes?status=all');
  const rows = data.changes || [];
  const pending = rows.filter((c) => c.review_status === 'pending');
  body.innerHTML = `
  <div class="callout"><b>自动检测的官方原文变化</b>
    <p>每日巡检会比对官方页面内容；发现变化即记录差异摘要与影响面，<b>不会生成人工待办</b>。
    政策效力以官方原文为准，自动检测结果仅用于提示复核优先级。</p></div>
  ${card({
    title: `原文变化记录（${rows.length} 条，其中未处理 ${pending.length} 条）`,
    subtitle: '未处理表示自动流程尚未合并到结构化字段，不影响官方原文的展示',
    body: rows.length
      ? table({
          pageSize: 20,
          columns: [
            { key: 'policy_title', label: '政策 / 方法学' },
            { key: 'change_kind', label: '变化类型', render: (r) => chip(r.change_kind, 'warn') },
            { key: 'diff_summary', label: '差异摘要', render: (r) => esc(truncate(r.diff_summary || '', 80)) },
            { key: 'detected_at', label: '检测时间', render: (r) => esc(dateTime(r.detected_at)) },
            { key: 'impact', label: '影响面', render: (r) => `方法学 ${r.impact?.affected_methodologies?.length ?? 0}｜项目 ${r.impact?.affected_projects?.length ?? 0}` },
            { key: 'auto_state', label: '自动处理状态', render: (r) => (r.review_status === 'pending' ? chip('待自动合并', 'warn') : chip('已合并到结构化字段', 'ok')) },
            { key: 'official_url', label: '官方原文', render: (r) => (r.official_url ? `<a class="link" href="${esc(r.official_url)}" target="_blank" rel="noreferrer noopener">打开</a>` : '—') },
          ],
          rows,
          emptyText: '暂未检测到官方原文变化',
          emptyHint: '每日巡检发现变化时会自动记录到此处',
        })
      : emptyState('暂未检测到官方原文变化', '每日巡检发现变化时会自动记录到此处，无需人工确认'),
    note: '本页为自动运行状态，不是审批待办；平台不提供「确认已核对」按钮。',
  })}`;
}

/* ------------------------------ 目录完整性 ------------------------------ */

async function renderCompletenessTab(body) {
  const d = await api('/api/v2/catalog/completeness');
  const c = d.counts || {};
  body.innerHTML = `
  <div class="metrics metrics-sm">
    ${miniMetric('已收录（编号已核实）', c.included, '项', `目录条目合计 ${c.total} 项`)}
    ${miniMetric('待核实', c.pending_verification, '项', '编号或名称未从发布通知正文逐条核实')}
    ${miniMetric('草案', c.drafts, '项', '不参与资格判断与测算')}
    ${miniMetric('已失效', c.repealed, '项', '保留历史版本')}
    ${miniMetric('采集失败/待补', c.fetch_failures, '条', '缺官方链接或原件未归档')}
  </div>
  ${card({
    title: '首轮检查问题修复对照',
    subtitle: '需求规格 1.2 明确要求修复的错号与漏项',
    body: `<ul class="list">${(d.fix_notes || []).map((f) => `<li><div class="list-head"><b>${esc(f.item)}</b>${chip(f.status === 'fixed' ? '已修复' : '已收录', 'ok')}</div><p class="muted">${esc(f.detail)}</p></li>`).join('')}</ul>`,
  })}
  <div class="grid-2">
    ${card({ title: '已收录（编号已逐字核实）', subtitle: `${(d.included || []).length} 项`, body: itemList(d.included, (i) => `${esc(i.code_display || '')}｜${esc(i.name)}`) })}
    ${card({ title: '待核实（可检索，不参与候选与测算）', subtitle: `${(d.pending_verification || []).length} 项`, body: itemList(d.pending_verification, (i) => `${esc(i.name)}${i.code_display ? `｜${esc(i.code_display)}` : '｜编号待核实'}`) })}
  </div>
  <div class="grid-2">
    ${card({ title: '采集失败 / 待补充', subtitle: `${(d.fetch_failures || []).length} 条`, body: itemList(d.fetch_failures, (i) => `${esc(i.object_label || '')}：${esc(i.detail || '')}`) })}
    ${card({ title: '官方目录基线对照', subtitle: '手工录入数量不作为长期真值', body: `<p>${esc(d.baseline?.note || '')}</p>
      ${kv([['设计文档记载条目数', esc(d.baseline?.design_doc_count ?? '—')], ['本库已录入', esc(d.baseline?.seeded_methodology_ids ?? '—')], ['编号已核实', esc(d.baseline?.verified_code_count ?? '—')], ['编号待核实', esc(d.baseline?.pending_code_count ?? '—')]])}` })}
  </div>
  ${card({ title: '未结清数据缺口', subtitle: `${(d.data_gaps || []).length} 项`, body: itemList(d.data_gaps, (g) => `<b>${esc(g.title)}</b><br><span class="muted">${esc(g.impact || '')}</span>`) })}
  ${noteBlock(d.note)}`;

  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-mv-id]');
    if (!a) return;
    try {
      const det = await api(`/api/v2/methodologies/${a.dataset.mvId}`);
      showMethodologyDrawer(det);
    } catch (err) {
      toast(err.message, 'danger');
    }
  });
}

function itemList(items, render) {
  const list = items || [];
  if (!list.length) return emptyState('列表为空');
  return `<ul class="list">${list.map((i) => `<li>${i.id ? `<a class="link" data-mv-id="${esc(i.id)}">` : ''}${render(i)}${i.id ? '</a>' : ''}</li>`).join('')}</ul>`;
}

/* ------------------------------ 公共 ------------------------------ */

function miniMetric(label, value, unit, sub) {
  return `<article class="metric metric-sm">
    <div class="metric-head"><span class="metric-label">${esc(label)}</span></div>
    <div class="metric-value">${typeof value === 'number' ? num(value) : esc(value ?? '—')}<span class="metric-unit">${esc(unit || '')}</span></div>
    <div class="metric-sub">${esc(sub || '')}</div>
  </article>`;
}

let debounceTimer = null;
function wireFilters(root, keys, debounce = {}) {
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
