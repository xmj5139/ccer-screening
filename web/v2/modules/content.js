/**
 * 研报与行业动态模块
 * ============================================================================
 * 需求（docs/44 第 2、3 条，取代 docs/19 的核验标签展示）：
 *   - **不再以「证据充足/不足/自动核验」等标签呈现，以来源为主**：
 *     官方网站显示「官方信息」，第三方显示实际发布机构 / 网站名，
 *     来源未知显示域名或「来源未标注」；
 *   - 每条标题下展示模型生成的**核心摘要**（未生成时如实空态）；
 *   - 内部核验数据保留后台（「自动核验策略 / 核验记录」），公开列表与详情
 *     不再以核验标签呈现；管理员在详情中仍可查看核验明细。
 *   - 仍保留：发布时间、作者/发布机构、来源 URL、文件链接、
 *     事实 / 观点 / 预测分离、「不声称已读全文」。
 */
import { api, goto, setQuery, state } from '../app.js';
import {
  card, table, metricCard, chip, esc, kv, drawer, toast, filtersBar,
  loading, emptyState, errorState, num, shortDate, dateTime, truncate, barChart,
} from '../ui.js';
import { sourceBlock, sourceLinkBlock, summaryBlock, summaryCoverageHint } from '../platform.js';

const TABS = [
  { key: '', label: '全部', hint: '研报与行业动态合并视图' },
  { key: 'research_report', label: '公开研报', hint: '证券与研究机构的公开研究报告' },
  { key: 'industry_news', label: '行业动态', hint: '行业协会、交易机构与专业媒体的动态' },
  { key: 'institution_view', label: '机构观点', hint: '机构分析与观点（含预测，不等同事实）' },
  { key: 'enterprise_news', label: '企业公告', hint: '企业公告与项目主体新闻（企业主张，非政府确认）' },
];

/**
 * 核验四态文案与内部核验数据**不在公开内容模块出现**：
 * 核验是内部一致性检查，其明细只在后台「自动核验策略 / 核验记录」与
 * 管理员可见的后台页面中展示（docs/44 第 2 条、docs/46 第 10 条）。
 * 公开列表以来源为主（sourceBlock）并展示核心摘要（summaryBlock）。
 */

const AVAILABILITY_LABEL = {
  full_text: '公开全文已归档',
  partial: '部分正文',
  abstract_only: '仅有公开摘要',
  metadata_only: '仅元数据（未获取正文）',
};

const CATEGORY_LABEL = {
  official: '政府/主管机构',
  institution: '证券/研究机构',
  association: '行业协会',
  exchange: '交易机构',
  media: '碳市场专业媒体',
  enterprise: '企业公告与自述',
  unknown: '未判定来源',
};

function typeChip(t, label) {
  const tone = {
    research_report: 'chip-accent', industry_news: 'chip-plain',
    institution_view: 'chip-plain', enterprise_news: 'chip-warn', policy_notice: 'chip-plain',
  }[t] || 'chip-plain';
  return `<span class="chip ${tone}">${esc(label || t)}</span>`;
}

/* ------------------------------ 列表 ------------------------------ */

/**
 * 列表行：**不再用采集时间冒充发布日期**（docs/22 第 10 条）。
 * 来源页面未声明发布日期时显示「未披露」，采集时间单独成列。
 */
function itemRow(r) {
  return {
    ...r,
    _published: r.published_at || null,
    _published_label: r.published_at ? shortDate(r.published_at) : '未披露',
    _collected_label: (r.collected_at || '').slice(0, 10) || '—',
  };
}

export async function renderContent(root, route) {
  const q = route.query || {};
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab || '' : '';
  const params = new URLSearchParams({ limit: '80' });
  if (tab) params.set('content_type', tab);
  for (const k of ['q', 'publisher', 'verification_status', 'source_category', 'from', 'to', 'industry']) {
    if (q[k]) params.set(k, q[k]);
  }

  let data;
  let stats;
  let ceaResearch;
  try {
    [data, stats, ceaResearch] = await Promise.all([
      api(`/api/v2/content?${params.toString()}`),
      api('/api/v2/content/stats'),
      // CEA 研报与行业动态：失败不阻塞 CCER 内容库，如实显示不可用
      api('/api/v2/cea/research?limit=5').catch((e) => ({ __error: e })),
    ]);
  } catch (e) {
    root.innerHTML = errorState(e);
    return;
  }

  const items = (data.items || []).map(itemRow);
  const s = stats.stats || {};

  // 来源分布（以来源为主；不再按核验四态分组展示）
  const srcKind = { official: 0, third_party: 0, unknown: 0 };
  for (const it of items) {
    const k = it.source_display?.kind || 'unknown';
    srcKind[k] = (srcKind[k] || 0) + 1;
  }
  const coverage = [
    { label: '官方信息', count: srcKind.official || 0 },
    { label: '第三方发布机构 / 网站', count: srcKind.third_party || 0 },
    { label: '来源未标注', count: srcKind.unknown || 0 },
  ].filter((x) => x.count > 0);

  const typeBars = (stats.content_types || [])
    .map((t) => ({ label: t.label, count: (s.by_type || {})[t.key] || 0 }))
    .filter((x) => x.count > 0);

  root.innerHTML = `
    ${renderStatusBanner(stats)}
    <div class="metrics metrics-sm">
      ${metricCard({
        label: '公开研报与动态条目', value: s.total ?? 0, unit: '条',
        sub: `发布日期未披露 ${s.published_date_missing ?? 0} 条｜来源归档 ${s.archive_records ?? 0} 条（不计入文章）`,
        source: '博查搜索 + 网页抓取自动采集',
        caliber_key: 'content_total',
      })}
      ${metricCard({
        label: '来源已标注条目', value: (srcKind.official || 0) + (srcKind.third_party || 0) + (srcKind.unknown || 0), unit: '条',
        sub: `其中官方信息 ${srcKind.official || 0} 条｜第三方 ${srcKind.third_party || 0} 条｜来源未标注 ${srcKind.unknown || 0} 条（按本页 ${items.length} 条统计）`,
        source: '来源展示口径（hostname 精确 / 受控子域匹配）',
        caliber_key: 'content_source',
      })}
      ${metricCard({
        label: '仅摘要/仅元数据', value: (s.by_availability?.abstract_only || 0) + (s.by_availability?.metadata_only || 0), unit: '条',
        sub: '未获取公开全文，摘要只能依据已有范围生成',
        source: '网页抓取连接返回结果',
        caliber_key: 'content_abstract_only',
      })}
      ${metricCard({
        label: '已关联转载副本', value: s.reprints_linked ?? 0, unit: '条',
        sub: '同内容多站转载建立关联，不重复统计',
        source: 'URL / 内容哈希去重',
        caliber_key: 'content_reprints',
      })}
    </div>

    <div class="grid-2">
      ${card({
        title: '来源分布',
        subtitle: '以来源为主：官方信息 / 第三方实际发布机构 / 来源未标注（按本页命中条目统计）',
        body: coverage.length ? barChart({ items: coverage, unit: ' 条' }) : emptyState('本页没有可统计来源的条目'),
        note: '官方判定只看 hostname 是否精确命中或属于受控子域；第三方转载官方内容不会被认定为官网。核验状态属内部数据，仅在后台展示。',
      })}
      ${card({
        title: '内容类型分布',
        subtitle: '按收录类型统计（不含演示条目与转载副本）',
        body: typeBars.length ? barChart({ items: typeBars, unit: ' 条' }) : emptyState('暂无内容', '在后台「采集连接」配置搜索 API 后执行采集'),
      })}
    </div>

    ${card({
      title: '内容库',
      subtitle: '公开研报、行业动态、机构观点与企业公告；标题下为核心摘要，来源以发布方为主',
      actions: `<a class="btn btn-sm" href="/api/v2/content/export?format=csv&${params.toString()}" download>下载 CSV</a>
                <a class="btn btn-sm" href="/api/v2/content/export?format=xlsx&${params.toString()}" download>下载 Excel</a>`,
      body: `
        <div class="tabs">${TABS.map((t) => `
          <button class="tab ${tab === t.key ? 'active' : ''}" data-content-tab="${esc(t.key)}" title="${esc(t.hint)}">${esc(t.label)}</button>`).join('')}
        </div>
        ${filtersBar([
          { key: 'q', label: '关键词', placeholder: '标题 / 摘要 / 机构 / 主题' },
          { key: 'publisher', label: '发布机构' },
          { key: 'source_category', label: '来源类别', type: 'select', options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })) },
          { key: 'from', label: '起始日期', type: 'date' },
          { key: 'to', label: '截止日期', type: 'date' },
        ], { ...q, tab })}
        ${table({
          pageSize: 25,
          emptyText: '没有符合条件的内容',
          emptyDetail: '可调整筛选条件，或在后台「采集连接」配置搜索 API 与网页抓取连接后执行自动采集。',
          columns: [
            { key: '_published_label', label: '发布日', render: (r) => (r.published_at
              ? esc(r._published_label)
              : '<span class="muted" title="来源页面未声明发布日期，未用采集时间代替">未披露</span>') },
            { key: '_collected_label', label: '采集时间', render: (r) => `<span class="muted">${esc(r._collected_label)}</span>` },
            { key: 'content_type', label: '类型', render: (r) => typeChip(r.content_type, r.content_type_label) },
            { key: 'title', label: '标题与核心摘要', render: (r) => `<button class="link title-cell" data-content-id="${esc(r.id)}">${esc(truncate(r.title, 60))}</button>${summaryBlock(r, { compact: true })}` },
            { key: 'source_display', label: '来源', definition: '官方信息 / 第三方实际发布机构 / 来源未标注', render: (r) => sourceBlock(r) },
            { key: 'source_category', label: '来源类别', render: (r) => esc(CATEGORY_LABEL[r.source_category] || r.source_category) },
            { key: 'body_availability', label: '正文', render: (r) => esc(AVAILABILITY_LABEL[r.body_availability] || r.body_availability) },
            { key: 'source_url', label: '原文', render: (r) => sourceLinkBlock(r, { label: '原文' }) },
          ],
          rows: items,
        })}
        ${summaryCoverageHint(items)}
      `,
      note:
        '公开全文会归档为正文快照；只有摘要或付费链接时保留元数据与公开摘要并明确标注，不声称已读全文。' +
        '来源标签只表示发布方，不构成独立审计、真实性担保或投资建议；' +        '核验状态属内部一致性检查数据，不在公开列表呈现（后台「自动核验策略 / 核验记录」可查）。',
    })}

    ${ceaResearchCard(ceaResearch)}
  `;

  bindContentEvents(root, items, tab);
}

/**
 * CEA 研报与行业动态入口区块（全国碳排放配额视角）。
 * 每条展示机构、发布日期、数据截止日、观点标记、证据等级、AI 核验与来源类型；
 * 聚合/转载站显式标注为非公开第一来源；未标注机构显示「未标注」而不是空白。
 */
function ceaResearchCard(cea) {
  const err = cea?.__error;
  if (err) {
    return card({
      title: 'CEA 研报与行业动态',
      subtitle: '全国碳排放配额（CEA）视角的公开研报与行业动态',
      actions: '<a class="btn btn-sm" href="#/cea?tab=research">进入 CEA 研报动态</a>',
      body: `${errorState(err)}<p class="hint">CEA 接口不可用时本区块不显示替代内容（HTTP ${esc(String(err.status || '—'))}）。</p>`,
    });
  }
  const rows = cea?.rows || [];
  const VIEW = { research_opinion: ['chip-warn', '研究观点'], market_news: ['chip-accent', '行业动态'], institution_view: ['chip-plain', '机构观点'], official_fact: ['chip-plain', '官方事实'] };
  return card({
    title: 'CEA 研报与行业动态',
    subtitle: `全国碳排放配额（CEA）视角｜已收录 ${cea?.total ?? 0} 条（最多展示 5 条）｜只收录已取得正文（full_text）的条目`,
    actions: '<a class="btn btn-sm" href="#/cea?tab=research">进入 CEA 研报动态</a>',
    body: rows.length
      ? `<ul class="list">${rows.map((r) => {
          const [cls, label] = VIEW[r.viewpoint] || ['chip-muted', r.viewpoint || '未标注'];
          const isRepost = String(r.discovery?.source_kind || '') === 'media_repost';
          return `<li>
            <div class="list-head"><b>${esc(truncate(r.title, 60))}</b>
              <span class="muted right">${r.publish_date ? `发布 ${esc(shortDate(r.publish_date))}` : '发布日期未标注'}</span></div>
            ${summaryBlock(r, { compact: true })}
            <div class="list-foot">
              <span class="chip ${cls}">${esc(label)}</span>
              ${sourceBlock(r)}
              <span class="muted">数据截止日：${r.data_cutoff_date ? esc(shortDate(r.data_cutoff_date)) : '未标注'}</span>
              ${isRepost ? '<span class="chip chip-warn">聚合/转载站（非公开第一来源）</span>' : ''}
              ${sourceLinkBlock({ url: r.first_source || r.official_url || r.page_url }, { label: '公开来源' })}
            </div></li>`;
        }).join('')}</ul>${summaryCoverageHint(rows)}`
      : emptyState('尚未采集到 CEA 研报与行业动态', '需要有界定向发现并取得全文后入库；搜索摘要不写入列表。', '可在后台「CEA 配额市场 → 采集」触发 research 采集'),
    note:
      '观点类内容（研究观点）不作为现行规则或履约义务依据；来源为聚合/转载站时显式标注为「非公开第一来源」，不显示为官方信息。' +
      '核验状态属内部一致性检查数据，仅在后台展示。',
  });
}

function renderStatusBanner(stats) {
  const d = stats.last_discovery;
  const seed = stats.last_seed_fetch;
  const probe = stats.seed_sources || {};
  const probeBit = probe.probed_at
    ? `种子来源可用性实测：${probe.available ?? '—'}/${probe.total ?? '—'} 可用（${shortDate(probe.probed_at)}）`
    : '';
  // 没有搜索服务时，如实说明「检索发现未配置」，并展示种子来源抓取的最近成功时间
  if (!d) {
    const bits = ['检索发现（搜索 API）尚未运行：未配置可用的搜索服务（可用博查 Web Search）。'];
    if (seed) {
      bits.push(
        `来源页自动采集：${seed.status === 'ok' ? '成功' : seed.status === 'partial' ? '部分成功' : '失败'}`
        + `｜最近成功 ${dateTime(seed.success_at)}${seed.note ? `｜${truncate(seed.note, 140)}` : ''}`
      );
      if (seed.error) bits.push(`失败原因：${truncate(seed.error, 120)}`);
    }
    if (probeBit) bits.push(probeBit);
    bits.push('未配置时本模块如实显示不可用，不会用空结果假装已采集。');
    return `<div class="banner banner-warn">${esc(bits.join('｜'))}</div>`;
  }
  const bits = [
    `最近一次采集：${dateTime(d.at)}（${d.status === 'ok' ? '成功' : d.status === 'partial' ? '部分成功' : '失败'}）`,
    `最近成功：${dateTime(d.success_at)}`,
    `发现 ${d.seen ?? 0} 条 / 新增 ${d.new ?? 0} 条`,
  ];
  if (d.error) bits.push(`失败原因：${truncate(d.error, 120)}`);
  if (seed) {
    bits.push(`来源页自动采集：最近成功 ${dateTime(seed.success_at)}${seed.note ? `（${truncate(seed.note, 120)}）` : ''}`);
  }
  if (probeBit) bits.push(probeBit);
  return `<div class="banner ${d.status === 'failed' ? 'banner-warn' : 'banner-info'}">${esc(bits.join('｜'))}</div>`;
}

function bindContentEvents(root, items, tab) {
  root.querySelectorAll('[data-content-tab]').forEach((el) => {
    el.addEventListener('click', () => setQuery({ tab: el.dataset.contentTab || null, offset: null }));
  });
  root.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('change', () => setQuery({ [el.dataset.filter]: el.value || null, offset: null }));
    if (el.tagName === 'INPUT') {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setQuery({ [el.dataset.filter]: el.value || null, offset: null });
      });
    }
  });
  root.querySelectorAll('[data-content-id]').forEach((el) => {
    el.addEventListener('click', () => openContentDrawer(el.dataset.contentId));
  });
}

/* ------------------------------ 详情抽屉 ------------------------------ */

export async function openContentDrawer(id) {
  let d;
  try {
    d = await api(`/api/v2/content/${id}`);
  } catch (e) {
    toast(e.body?.error || e.message, 'error');
    return;
  }
  const it = d.item;
  const lastV = (d.verifications || [])[0];
  const claims = it.claims || [];
  const facts = claims.filter((c) => c.kind === 'fact');
  const opinions = claims.filter((c) => c.kind === 'opinion');
  const forecasts = claims.filter((c) => c.kind === 'forecast');

  document.body.insertAdjacentHTML('beforeend', drawer(`${it.content_type_label}｜${truncate(it.title, 40)}`, `
    <div class="drawer-section">
      <div class="chip-row">
        ${typeChip(it.content_type, it.content_type_label)}
        ${sourceBlock(it)}
        ${chip(CATEGORY_LABEL[it.source_category] || it.source_category)}
        ${chip(AVAILABILITY_LABEL[it.body_availability] || it.body_availability)}
      </div>
      ${summaryBlock(it)}
      ${kv([
        ['标题', esc(it.title)],
        ['发布机构', esc(it.publisher || '来源未标注')],
        ['作者', esc(it.author || '—')],
        ['发布日期', it.published_at
          ? esc(shortDate(it.published_at))
          : '<span class="muted">未披露（来源页面未声明，未用采集时间代替）</span>'],
        ['采集时间', esc(dateTime(it.collected_at))],
        ['正文长度', `${num(it.body_chars)} 字符`],
        ['来源链接', (it.source_url && /^https?:\/\//i.test(it.source_url))
          ? `<a class="link src-link" href="${esc(it.source_url)}" target="_blank" rel="noopener noreferrer">${esc(truncate(it.source_url, 60))}</a>`
          : '<span class="muted">来源未标注（未提供可解析的原文链接）</span>'],
        ['主题标签', esc((it.topics || []).join('、') || '—')],
        ['关联方法学', esc((it.methodology_ids || []).join('、') || '—')],
      ])}
      ${it.manual_revision ? `<p class="hint">本条目含**管理员修订**字段：${esc((it.manual_fields || []).join('、'))}；原始采集值与官方数值保存在覆盖层，可在后台查看历史并恢复。</p>` : ''}
      ${it.summary ? `<h4>来源公开摘要</h4><p class="prose">${esc(it.summary)}</p>` : ''}
    </div>

    ${(it.key_points || []).length ? `<div class="drawer-section">
      <h4>要点（自动抽取）</h4>
      <ul class="bullets">${it.key_points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <p class="hint">要点由正文确定性抽取，未经改写；请以上方原文链接为准。</p>
    </div>` : ''}

    ${claims.length ? `<div class="drawer-section">
      <h4>事实 / 观点 / 预测分离</h4>
      ${facts.length ? `<h5>已发生事实</h5><ul class="bullets">${facts.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>` : ''}
      ${opinions.length ? `<h5>观点（不代表事实）</h5><ul class="bullets">${opinions.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>` : ''}
      ${forecasts.length ? `<h5>预测（不构成承诺）</h5><ul class="bullets">${forecasts.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>` : ''}
    </div>` : ''}

    ${(state.user?.role === 'admin')
      ? `<div class="drawer-section">
      <h4>内部核验数据</h4>
      <p class="hint">核验明细属内部一致性检查数据，已统一放在「后台管理 → 自动核验策略 / 核验记录」中查看；公开研报正文不再展示核验结论。</p>
      <a class="btn btn-sm" href="#/admin?tab=verify&object_type=content_item&object_id=${encodeURIComponent(id)}">在后台查看核验记录</a>
    </div>`
      : ''}

    ${(d.other_sources || []).length || (d.reprints || []).length ? `<div class="drawer-section">
      <h4>其它来源与转载</h4>
      <ul class="bullets">
        ${(d.other_sources || []).map((o) => `<li>${esc(o.relation === 'reprint' ? '转载' : '参考')}：<a class="link" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(truncate(o.url, 60))}</a>${o.publisher ? `（${esc(o.publisher)}）` : ''}</li>`).join('')}
        ${(d.reprints || []).map((o) => `<li>本站另收录同内容条目：<button class="link" data-content-id="${esc(o.id)}">${esc(truncate(o.title, 40))}</button></li>`).join('')}
      </ul>
      <p class="hint">同一篇内容多站转载只保留一条代表条目，其它建关联，不重复统计。</p>
    </div>` : ''}

    ${(d.versions || []).length > 1 ? `<div class="drawer-section">
      <h4>版本变化（${d.versions.length} 个版本）</h4>
      <ul class="bullets">${d.versions.map((v) => `<li>v${v.version_no}｜${esc(dateTime(v.fetched_at))}｜${esc(v.change_summary || v.change_kind)}（${num(v.body_chars)} 字符）</li>`).join('')}</ul>
    </div>` : ''}

    <div class="drawer-section">
      <h4>正文快照</h4>
      ${it.body_snapshot
        ? `<pre class="body-snapshot">${esc(truncate(it.body_snapshot, 6000))}</pre>
           <p class="hint">以上为已归档的公开正文快照片段；完整正文与哈希见「后台管理 → 快照」。</p>`
        : `<p class="muted">未归档正文。本条仅保留元数据与公开摘要（${esc(AVAILABILITY_LABEL[it.body_availability] || it.body_availability)}），平台不会声称已读全文。</p>`}
    </div>

    <div class="drawer-section">
      ${(state.user?.role === 'admin' || state.user?.role === 'researcher')
        ? `<button class="btn btn-primary" data-verify-now="${esc(id)}">立即自动核验</button>`
        : ''}
      <p class="hint">${esc(d.disclosure || '')}</p>
    </div>
  `));

  document.querySelectorAll('[data-close-drawer]').forEach((el) => el.addEventListener('click', () => {
    document.querySelector('.drawer-backdrop')?.remove();
    document.querySelector('.drawer')?.remove();
  }));
  document.querySelectorAll('.drawer [data-content-id]').forEach((el) => el.addEventListener('click', () => {
    document.querySelector('.drawer-backdrop')?.remove();
    document.querySelector('.drawer')?.remove();
    openContentDrawer(el.dataset.contentId);
  }));
  document.querySelector('.drawer [data-verify-now]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = '核验中…';
    try {
      const out = await api(`/api/v2/content/${id}/verify`, { method: 'POST', body: { force: true } });
      toast(`核验完成：${out.label || out.result}`, out.result === 'verified' ? 'ok' : 'warn');
      document.querySelector('.drawer-backdrop')?.remove();
      document.querySelector('.drawer')?.remove();
      await openContentDrawer(id);
    } catch (e) {
      toast(e.body?.error || e.message, 'error');
      btn.disabled = false;
      btn.textContent = '立即自动核验';
    }
  });
}
