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
import { fallbackFormOptions, loadFormOptions, selectOptionsHtml } from '../form-selects.js';
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
  let options;
  let followFeed;
  try {
    [data, stats, ceaResearch, options, followFeed] = await Promise.all([
      api(`/api/v2/content?${params.toString()}`),
      api('/api/v2/content/stats'),
      // CEA 研报与行业动态：失败不阻塞 CCER 内容库，如实显示不可用
      api('/api/v2/cea/research?limit=5').catch((e) => ({ __error: e })),
      loadFormOptions(api).catch(() => fallbackFormOptions()),
      // 我的关注：失败不阻塞内容库；未登录/不可用时如实说明
      api('/api/v2/follow/feed?limit=30').catch((e) => ({ __error: e })),
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

    ${followCard(followFeed, options)}

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
          { key: 'publisher', label: '发布机构', type: 'datalist', options: options.sources, placeholder: '可自由输入机构名' },
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
  bindFollowEvents(root, route);
}

function bindFollowEvents(root, route) {
  const splitList = (value) => String(value || '').split(/[,，、;；\n]+/).map((x) => x.trim()).filter(Boolean);
  root.querySelector('#follow-rule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload = {
      name: form.get('name') || '我的关注',
      keywords: splitList(form.get('keywords')),
      regions: splitList(form.get('regions')),
      industries: splitList(form.get('industries')),
      methodologies: splitList(form.get('methodologies')),
    };
    if (!payload.keywords.length && !payload.regions.length && !payload.industries.length && !payload.methodologies.length) {
      toast('至少填写一个关键词、地区、行业或方法学编号', 'warn');
      return;
    }
    try {
      await api('/api/v2/follow/rules', { method: 'POST', body: payload });
      toast('关注规则已保存', 'ok');
      await renderContent(root, route);
    } catch (err) {
      toast(err.body?.error || err.message, 'error');
    }
  });
  root.querySelectorAll('[data-follow-read]').forEach((el) => {
    el.addEventListener('click', async () => {
      el.disabled = true;
      try {
        await api('/api/v2/follow/read', { method: 'POST', body: { content_id: el.dataset.followRead } });
        await renderContent(root, route);
      } catch (err) {
        toast(err.body?.error || err.message, 'error');
        el.disabled = false;
      }
    });
  });
  root.querySelector('#follow-read-all')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const out = await api('/api/v2/follow/read-all', { method: 'POST', body: { limit: 200 } });
      toast(`已标记 ${out.marked || 0} 条为已读`, 'ok');
      await renderContent(root, route);
    } catch (err) {
      toast(err.body?.error || err.message, 'error');
      e.currentTarget.disabled = false;
    }
  });
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

/**
 * “我的关注”站内更新（docs/86 第二阶段第 2 节）。
 * 不新增一级导航：直接放在研报与行业动态页内；规则与已读均按当前登录用户隔离。
 */
function followCard(feed, formOptions = null) {
  if (feed?.__error) {
    return card({
      title: '我的关注（站内更新）',
      subtitle: '按关键词/地区/行业/方法学订阅公开内容，只在本页展示',
      body: `${errorState(feed.__error)}<p class="hint">关注规则与已读游标只属于当前登录用户；未登录时不可用。</p>`,
      note: '关注命中只表示正文/元数据提及，不代表官方适用范围或项目合格。',
    });
  }
  const items = feed?.items || [];
  const rules = feed?.rules_count || 0;
  const unread = feed?.unread_count || 0;
  const row = (item) => `<li>
    <div class="list-head">
      <b>${esc(truncate(item.title || '(无标题)', 76))}</b>
      <span class="muted right">${item.unread ? chip('未读', 'warn') : chip('已读', '')}
        ${item.date ? esc(shortDate(item.date)) : '日期未披露'}</span>
    </div>
    <div class="list-foot">
      ${typeChip(item.content_type, item.content_type === 'industry_news' ? '行业动态' : item.content_type)}
      <span class="muted">${esc(item.publisher || '来源未标注')}</span>
      <span class="chip chip-plain">${esc(item.update_label || '首次收录')}</span>
      <span class="muted">来源 ${num(item.source_count || 1)} 条（转载合并、逐条保留）</span>
      ${(item.matched_rules || []).flatMap((r) => r.reasons || []).slice(0, 3).map((r) => `<span class="muted">命中：${esc(r)}</span>`).join('')}
      ${sourceLinkBlock({ url: item.source_url }, { label: '原文' })}
      ${item.unread ? `<button class="btn btn-xs" data-follow-read="${esc(item.content_item_id)}">标为已读</button>` : ''}
    </div>
    ${item.update_summary ? `<div class="muted">${esc(truncate(item.update_summary, 160))}</div>` : ''}
  </li>`;
  return card({
    title: '我的关注（站内更新）',
    subtitle: `${rules} 条关注规则｜未读 ${unread} 条｜同文转载按事件组合并，来源仍逐条保留`,
    actions: items.length
      ? `<button class="btn btn-sm" id="follow-read-all">全部标为已读</button>`
      : '',
    body: `
      <form id="follow-rule-form" class="form-grid">
        <label class="fld"><span>规则名称</span><input name="name" maxlength="80" placeholder="例如 内蒙古瓦斯项目"></label>
        <label class="fld"><span>关键词（逗号分隔）</span><input name="keywords" maxlength="600" placeholder="瓦斯,甲烷回收"></label>
        <label class="fld"><span>地区提及</span>
          <select name="regions">
            ${selectOptionsHtml(formOptions?.cea?.provinces || [], '', { allLabel: '全部地区' })}
          </select>
          <small>使用平台已收录省份；多地区可按“关键词”另行组合，避免手工拼写省名。</small>
        </label>
        <label class="fld"><span>行业提及</span><input name="industries" maxlength="300" placeholder="钢铁,煤矿瓦斯"></label>
        <label class="fld"><span>方法学编号</span><input name="methodologies" maxlength="300" placeholder="CCER-10-001-V01"></label>
        <div class="fld"><button class="btn btn-primary" type="submit">保存关注</button></div>
      </form>
      ${items.length
        ? `<ul class="list">${items.map(row).join('')}</ul>`
        : emptyState('暂无关注更新', '保存一条关注规则后，这里展示本库内相关公开内容及实质修订。', '关注规则只属于当前用户；不会默认发送邮件或第三方消息')}
      <p class="hint">${esc(feed?.note || '关注命中只表示正文/元数据提及，不代表官方适用范围或项目合格。')}
      已读游标记录读取时的正文版本；正文实质变化后会重新显示为未读。</p>
    `,
    note: '站内关注不新增导航：规则、信息流与已读都在本页；普通用户只能操作自己的记录。',
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

/* ------------------------------ 字段证据与原文高亮 ------------------------------ */

function safeHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch { return null; }
}

function highlightFieldQuote(body, field) {
  const chars = Array.from(String(body || ''));
  const start = Number.isInteger(field.char_start) ? field.char_start : null;
  const end = Number.isInteger(field.char_end) ? field.char_end : null;
  if (start === null || end === null || start < 0 || end <= start || end > chars.length) {
    return `<blockquote class="quote-block">${esc(field.quote || '')}</blockquote>`;
  }
  const before = chars.slice(Math.max(0, start - 100), start).join('');
  const quote = chars.slice(start, end).join('');
  const after = chars.slice(end, Math.min(chars.length, end + 140)).join('');
  return `<pre class="body-snapshot field-highlight">${start > 100 ? '…' : ''}${esc(before)}<mark>${esc(quote)}</mark>${esc(after)}${end + 140 < chars.length ? '…' : ''}</pre>`;
}

function renderFieldEvidence(it, d) {
  const fields = d.fields || [];
  const meta = d.field_meta || {};
  const stale = Number(meta.stale || 0);
  const invalid = Number(meta.invalid || 0);
  return `<div class="drawer-section">
    <h4>结构字段与原文依据（${fields.length} 项）</h4>
    ${fields.length ? `<div class="table-wrap"><table class="grid compact">
      <thead><tr><th scope="col">字段</th><th scope="col">值</th><th scope="col">抽取方式</th><th scope="col">原文引句</th></tr></thead>
      <tbody>${fields.map((f) => `<tr>
        <td>${esc(f.label || f.field)}${f.mention_only ? '<div><span class="chip chip-warn">仅正文提及</span></div>' : ''}</td>
        <td><b>${esc(f.value)}</b>${f.scope_warning ? `<div class="muted">${esc(f.scope_warning)}</div>` : ''}</td>
        <td>${f.method === 'model'
          ? `<span class="chip chip-warn">模型抽取（候选）</span><div class="muted">${esc(f.model || '模型未记录')}</div>`
          : `<span class="chip">规则抽取</span><div class="muted">可复现规则</div>`}</td>
        <td>${highlightFieldQuote(it.body_snapshot || '', f)}<div class="muted">Unicode 码点 ${f.char_start}–${f.char_end}｜${esc(f.method)}</div></td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<p class="muted">尚未抽取到可定位字段。确定性字段在正文入库时自动生成；模型抽取需管理员在后台显式触发。</p>`}
    ${stale || invalid ? `<p class="hint">已失效 ${stale} 条、定位失败 ${invalid} 条（保留审计，不作为当前证据）。</p>` : ''}
    <p class="hint">引句是正文中的真实连续片段；无法定位的引句被拒绝。地区/行业仅表示正文提及，不代表官方适用范围；
      发布/生效日期必须带明确标签，阈值必须同时核对方向与单位。模型抽取仅表示候选证据，不是官方事实。</p>
  </div>`;
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

    ${renderFieldEvidence(it, d)}

    ${(state.user?.role === 'admin')
      ? `<div class="drawer-section">
      <h4>内部核验数据</h4>
      <p class="hint">核验明细属内部一致性检查数据，已统一放在「后台管理 → 自动核验策略 / 核验记录」中查看；公开研报正文不再展示核验结论。</p>
      <a class="btn btn-sm" href="#/admin?tab=verify&object_type=content_item&object_id=${encodeURIComponent(id)}">在后台查看核验记录</a>
    </div>`
      : ''}

    ${(d.event_group?.members || []).length > 1 || (d.other_sources || []).length || (d.reprints || []).length ? `<div class="drawer-section">
      <h4>事件组、相关来源与转载</h4>
      ${(d.event_group?.members || []).length > 1 ? `<p class="hint">事件组依据：${esc(d.event_group.match_basis)}。同文不同 URL 保留独立来源记录，不按相似标题合并。</p>
        <ul class="bullets">${d.event_group.members.map((m) => {
          const url = safeHttpUrl(m.source_url);
          return `<li>${m.relation === 'representative' ? '代表条目' : '转载来源'}：${url
            ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(truncate(m.title || m.source_url, 56))}</a>`
            : esc(truncate(m.title || '来源未标注', 56))}
            ${m.publisher ? `（${esc(m.publisher)}）` : ''}
            <span class="muted">发布 ${esc(m.published_at || '未披露')}｜发现 ${esc(dateTime(m.discovered_at))}｜采集 ${esc(dateTime(m.collected_at))}</span></li>`;
        }).join('')}</ul>` : ''}
      ${(d.other_sources || []).length ? `<ul class="bullets">
        ${(d.other_sources || []).map((o) => `<li>${esc(o.relation === 'reprint' ? '转载' : '参考')}：<a class="link" href="${esc(safeHttpUrl(o.url) || '#')}" target="_blank" rel="noopener noreferrer">${esc(truncate(o.url, 60))}</a>${o.publisher ? `（${esc(o.publisher)}）` : ''}${o.published_at ? `<span class="muted">｜发布 ${esc(o.published_at)}</span>` : ''}</li>`).join('')}
      </ul>` : ''}
      ${(d.reprints || []).length ? `<ul class="bullets">${d.reprints.map((o) => `<li>本站另收录同内容条目：<button class="link" data-content-id="${esc(o.id)}">${esc(truncate(o.title, 40))}</button><span class="muted">｜发布 ${esc(o.published_at || '未披露')}</span></li>`).join('')}</ul>` : ''}
      <p class="hint">多站转载只保留每条来源记录与合并依据，不重复统计。</p>
    </div>` : ''}

    ${(d.attachments || []).length ? `<div class="drawer-section">
      <h4>正文附件（${d.attachments.length}）</h4>
      <ul class="bullets">${d.attachments.map((a) => {
        const url = safeHttpUrl(a.url);
        return `<li>${url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(a.file_name || a.url)}</a>` : esc(a.file_name || a.url)}
          <span class="muted">${esc(a.file_type || '文件')}｜${esc(a.status)}｜指纹 ${esc(String(a.fingerprint || '').slice(0, 12))}</span></li>`;
      }).join('')}</ul>
      <p class="hint">附件指纹按 URL 与已知文件哈希计算；同一 URL 的附件清单变化会保存为「附件变化」版本，不重生成正文摘要。</p>
    </div>` : ''}

    ${(d.versions || []).length ? `<div class="drawer-section">
      <h4>内容版本（${d.versions.length} 个版本）</h4>
      <ul class="bullets">${d.versions.map((v) => `<li>v${v.version_no}｜${esc(v.change_kind_label || v.change_kind)}｜${esc(dateTime(v.fetched_at))}｜${num(v.body_chars)} 字符
        <div class="muted">${esc(v.change_summary || '无变化摘要')}${v.extractor ? `｜提取器 ${esc(v.extractor)}${v.extractor_version ? ` ${esc(v.extractor_version)}` : ''}` : ''}${v.body_fingerprint ? `｜正文指纹 ${esc(String(v.body_fingerprint).slice(0, 12))}` : ''}</div></li>`).join('')}</ul>
      <p class="hint">日期页脚/版权行变化不产生新版本、不重生成摘要；只有实质正文或附件变化才保存版本。</p>
    </div>` : ''}

    <div class="drawer-section">
      <h4>正文快照</h4>
      ${it.body_snapshot
        ? `<pre class="body-snapshot">${esc(truncate(it.body_snapshot, 6000))}</pre>
           <p class="hint">以上为已归档的公开正文快照片段；完整正文与哈希见「后台管理 → 快照」。</p>`
        : `<p class="muted">未归档正文。本条仅保留元数据与公开摘要（${esc(AVAILABILITY_LABEL[it.body_availability] || it.body_availability)}），平台不会声称已读全文。</p>`}
    </div>

    <div class="drawer-section">
      ${state.user?.role === 'admin' ? `<div class="chip-row">
        <button class="btn btn-sm" data-refetch="${esc(id)}">重取原文</button>
        <button class="btn btn-sm" data-reprocess="${esc(id)}">离线重处理</button>
        <button class="btn btn-sm" data-extract-fields="${esc(id)}">模型抽取字段</button>
      </div>
      <p class="hint">重取复用受控抓取与 collection 租约；模型抽取只由管理员显式触发，会调用已配置模型，无法定位的引句会被拒绝。</p>` : ''}
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

  const bindAdminAction = (selector, path, label, payload = {}) => {
    document.querySelector(`.drawer [${selector}]`)?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = `${label}中…`;
      try {
        const out = await api(`/api/v2/admin/content/${id}/${path}`, { method: 'POST', body: payload });
        const msg = path === 'extract-fields'
          ? (out.ok ? `模型字段：接受 ${out.accepted ?? 0}、拒绝 ${out.rejected ?? 0}` : (out.message || '未取得可定位字段'))
          : (out.message || `${label}完成`);
        toast(msg, path === 'extract-fields' && !out.ok ? 'warn' : 'ok');
        document.querySelector('.drawer-backdrop')?.remove();
        document.querySelector('.drawer')?.remove();
        await openContentDrawer(id);
      } catch (e) {
        toast(e.body?.error || e.body?.message || e.message, 'error');
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  };
  bindAdminAction('data-refetch', 'refetch', '重取', { timeout_ms: 30000 });
  bindAdminAction('data-reprocess', 'reprocess', '重处理');
  bindAdminAction('data-extract-fields', 'extract-fields', '模型抽取', { mode: 'model', force: true });
}
