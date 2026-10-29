/**
 * 统一检索页（docs/74 D）
 * ============================================================================
 * 入口在顶栏；不新增一级导航（保持既有 8 个主模块）。结果全部为纯文本，
 * 高亮函数先按关键词切分，再对每段分别转义，避免把摘要/标题当 HTML 注入。
 */
import { api, goto, setQuery } from '../app.js';
import {
  card, esc, shortDate, loading, errorState, emptyState,
} from '../ui.js';
import { sourceBlock, sourceLinkBlock } from '../platform.js';
import {
  datalistHtml, fallbackFormOptions, loadFormOptions,
} from '../form-selects.js';

const TYPE_TONES = {
  policy: 'chip-accent',
  methodology: 'chip-plain',
  project: 'chip-plain',
  content: 'chip-plain',
  cea_document: 'chip-plain',
  factor: 'chip-plain',
  entity: 'chip-muted',
};

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 安全高亮：先转义原文，再按关键词切分；匹配段也通过 esc()。 */
export function highlightText(text, q) {
  const terms = [...new Set(String(q || '').split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);
  if (!terms.length) return esc(text);
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  const lower = new Set(terms.map((t) => t.toLowerCase()));
  return String(text ?? '').split(re).map((part) => (
    lower.has(String(part).toLowerCase()) ? `<mark>${esc(part)}</mark>` : esc(part)
  )).join('');
}

function safeHttp(url) {
  return /^https?:\/\//i.test(String(url || '')) ? esc(url) : null;
}

export async function renderSearch(root, route) {
  const q = route.query || {};
  const params = new URLSearchParams();
  for (const k of ['q', 'types', 'source', 'source_category', 'region', 'from', 'to', 'sort', 'page', 'page_size']) {
    if (q[k]) params.set(k, q[k]);
  }
  params.set('page_size', q.page_size || '10');
  let data;
  let meta;
  let options;
  try {
    [data, meta, options] = await Promise.all([
      api(`/api/v2/search?${params.toString()}`),
      api('/api/v2/search/meta'),
      loadFormOptions(api).catch(() => fallbackFormOptions()),
    ]);
  } catch (e) {
    root.innerHTML = errorState(e);
    return;
  }

  return paintSearch(root, q, data, meta, options, null);
}

function paintSearch(root, q, data, meta, options, semantic) {
  const results = data.results || [];
  const filterNotes = data.filter_notes || [];
  const searchValue = q.q || '';
  const semanticTerms = Array.isArray(data.expansion_terms) ? data.expansion_terms : [];
  const highlightQuery = [searchValue, ...semanticTerms].filter(Boolean).join(' ');
  const typeOptions = meta.types || [];
  const currentType = q.types || '';
  const activeType = typeOptions.find((t) => t.key === currentType);
  const totalPages = data.total_pages || 1;
  const page = data.page || 1;

  root.innerHTML = `
    <section class="search-hero">
      <form class="search-form" id="unified-search-form" role="search" aria-label="统一检索">
        <label class="sr-only" for="search-q">检索公开资料</label>
        <input id="search-q" name="q" type="search" maxlength="100" value="${esc(searchValue)}"
          placeholder="搜索政策、方法学、公开项目、研报、CEA 文件、排放因子、企业名录" autocomplete="off">
        <button class="btn btn-primary" type="submit">检索</button>
        <button class="btn" type="button" id="semantic-search-btn" ${searchValue ? '' : 'disabled'}
          title="显式调用一次已配置模型生成最多 4 个相关检索词；精确编号不扩展；失败自动回退关键词">智能扩展检索</button>
      </form>
      <p class="search-scope">只检索公开实体；标题/摘要/正文匹配，演示条目、转载副本与来源归档自动排除。摘要不等于原文。
        「智能扩展检索」是显式付费动作，每次只调用一次模型；不改动类型/地区/年度筛选。</p>
    </section>

    ${semantic ? `<div class="callout ${semantic.semantic_mode === 'semantic_expansion' ? 'callout-ok' : 'callout-warn'}">
      <b>${semantic.semantic_mode === 'semantic_expansion' ? '语义扩展检索' : semantic.semantic_mode === 'keyword' ? '关键词检索（未扩展）' : '已回退关键词检索'}</b>
      <p>${esc(semantic.semantic_message || '')}</p>
      ${semanticTerms.length ? `<p>扩展词：${semanticTerms.map((t) => `<span class="chip chip-muted">${esc(t)}</span>`).join(' ')}</p>` : ''}
      <p class="hint">扩展词来自模型，不是官方同义词；原查询必保留，筛选未改变。${semantic.model ? `模型：${esc(semantic.model)}` : ''}</p>
    </div>` : ''}

    <div class="search-layout">
      <aside class="search-side" aria-label="检索筛选">
        ${card({
          title: '资料类型',
          body: `<div class="search-types">${typeOptions.map((t) => `
            <button class="search-type ${currentType === t.key ? 'active' : ''}" data-search-type="${esc(t.key)}"
              title="${esc(t.note || '')}" aria-pressed="${currentType === t.key ? 'true' : 'false'}">
              <span>${esc(t.label)}</span><b>${t.count}</b>
            </button>`).join('')}
            <button class="search-type ${!currentType ? 'active' : ''}" data-search-type="" aria-pressed="${!currentType ? 'true' : 'false'}">
              <span>全部</span><b>${typeOptions.reduce((s, t) => s + (t.count || 0), 0)}</b>
            </button>
          </div>`,
          note: activeType?.note || '类型白名单固定，不包含用户、账号、审计、配置或密钥。',
        })}
        ${card({
          title: '筛选',
          body: `
            <div class="form-grid form-grid-compact">
              <label class="fld"><span>来源 / 发布机构</span><input data-search-filter="source" value="${esc(q.source || '')}" maxlength="60" placeholder="例如：生态环境部" list="search-source-options">
                ${datalistHtml('search-source-options', options.sources, q.source || '')}</label>
              <label class="fld"><span>来源类别（研报动态）</span>
                <select data-search-filter="source_category">
                  <option value="">全部</option>
                  ${[['official', '政府/主管机构'], ['institution', '证券/研究机构'], ['association', '行业协会'], ['exchange', '交易机构'], ['media', '专业媒体'], ['enterprise', '企业公告']]
                    .map(([v, l]) => `<option value="${v}" ${q.source_category === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </label>
              <label class="fld"><span>地区（项目/因子/企业）</span>
                <input data-search-filter="region" value="${esc(q.region || '')}" maxlength="30" placeholder="输入或选择省份 / 城市 / 电网区域" list="search-region-options">
                ${datalistHtml('search-region-options', options.search.regions, q.region || '')}
              </label>
              <label class="fld"><span>起始日期</span><input type="date" data-search-filter="from" value="${esc(q.from || '')}"></label>
              <label class="fld"><span>截止日期</span><input type="date" data-search-filter="to" value="${esc(q.to || '')}"></label>
              <label class="fld"><span>排序</span>
                <select data-search-filter="sort">
                  <option value="relevance" ${data.filters?.sort !== 'date' ? 'selected' : ''}>相关度优先</option>
                  <option value="date" ${data.filters?.sort === 'date' ? 'selected' : ''}>日期（新→旧）</option>
                </select>
              </label>
            </div>
            <div class="search-filter-actions">
              <button class="btn btn-sm" data-search-reset type="button">重置筛选</button>
            </div>
            <p class="hint">不适用的筛选只跳过对应类型，并在此明确说明，不会把其它类型结果静默清空。</p>
          `,
        })}
        ${filterNotes.length ? `<div class="callout callout-warn"><b>检索说明</b><ul>${filterNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      </aside>

      <div class="search-main" aria-live="polite">
        <div class="search-result-head">
          <div>
            <h3>${data.empty_query ? '最近公开资料' : `检索结果`}</h3>
            <p class="muted">${data.empty_query ? '未输入关键词：按最近发布日期浏览。' : `关键词「${esc(searchValue)}」`}｜共 <b>${data.total}</b> 条
              ${data.truncated ? '（达到扫描上限，请缩小筛选范围）' : ''}
              ${data.matched_total > data.total ? `｜库内匹配 ${data.matched_total} 条，本页可核对 ${data.total} 条` : ''}
            </p>
          </div>
          <span class="chip">${esc(activeType?.label || '全部类型')}</span>
          <span class="chip chip-muted">${esc(data.semantic_mode === 'semantic_expansion' ? '语义扩展' : data.semantic_mode === 'keyword' ? '关键词' : data.semantic_mode === 'fallback' ? '回退关键词' : (data.mode === 'fts5' ? 'FTS5 索引' : '回退检索'))}</span>
        </div>
        ${results.length ? `<ol class="search-results">${results.map((r) => searchHit(r, highlightQuery)).join('')}</ol>` : emptyState(
          data.empty_query ? '暂无公开记录' : '没有找到匹配的公开资料',
          data.empty_query ? '库内尚无可以展示的公开条目。' : '可以缩短关键词、取消部分筛选，或换一个资料类型。',
          '未命中不代表全网没有公开信息，只表示本库当前未收录；不会用演示数据填充。'
        )}
        ${totalPages > 1 ? `<nav class="search-pager" aria-label="检索结果分页">
          <button class="btn btn-sm" data-search-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${page} / ${totalPages} 页</span>
          <button class="btn btn-sm" data-search-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
        </nav>` : ''}
        <p class="hint search-disclaimer">${esc(data.disclaimer || '')}</p>
      </div>
    </div>
  `;

  bindSearch(root, q, currentType, { meta, options, semantic });
}

function searchHit(r, q) {
  const typeTone = TYPE_TONES[r.type] || 'chip-plain';
  const dateLabel = r.date_label || '发布日期';
  const date = r.date ? `${dateLabel} ${shortDate(r.date)}` : `${dateLabel}未记录`;
  const original = safeHttp(r.original_url);
  return `<li class="search-hit">
    <div class="search-hit-body">
      <div class="search-hit-top">
        <span class="chip ${typeTone}">${esc(r.type_label)}</span>
        <span class="muted">${esc(date)}</span>
        ${r.status ? `<span class="chip chip-muted">${esc(String(r.status))}</span>` : ''}
        ${r.body_available ? `<span class="chip chip-muted">${esc(r.body_available === 'full_text' ? '公开全文已归档' : r.body_available === 'abstract_only' ? '仅公开摘要' : r.body_available)}</span>` : ''}
      </div>
      <h4 class="search-hit-title">${highlightText(r.title, q)}</h4>
      ${r.subtitle ? `<p class="search-hit-sub">${highlightText(r.subtitle, q)}</p>` : ''}
      <p class="search-hit-snippet">${highlightText(r.snippet || '—', q)}</p>
      <div class="search-hit-meta">
        <span>${sourceBlock(r)}</span>
        <span class="muted">定位：${esc(r.locator || '公开字段')}</span>
        ${r.page_number ? `<span class="muted">第 ${esc(String(r.page_number))} 页</span>` : ''}
        ${r.type === 'content' ? `<button class="link" data-search-content="${esc(r.entity_id)}">查看详情</button>`
          : `<a class="link" href="${esc(r.detail_url)}" data-search-detail="${esc(r.detail_url)}">详情</a>`}
        ${original ? `<a class="link" href="${original}" target="_blank" rel="noopener noreferrer">原文</a>` : sourceLinkBlock(r)}
      </div>
    </div>
  </li>`;
}

function bindSearch(root, q, currentType, { meta, options } = {}) {
  const form = document.getElementById('unified-search-form');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = document.getElementById('search-q')?.value.trim() || '';
    setQuery({ q: value, page: null });
  });
  // 语义扩展必须是显式点击 → POST；GET 列表不会调用模型。
  root.querySelector('#semantic-search-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const value = document.getElementById('search-q')?.value.trim() || '';
    if (!value) return;
    const post = {
      q: value,
      types: q.types || undefined,
      source: q.source || undefined,
      source_category: q.source_category || undefined,
      region: q.region || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      sort: q.sort || undefined,
      page: q.page || 1,
      page_size: q.page_size || 10,
    };
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '模型扩展中…';
    try {
      const data = await api('/api/v2/search/semantic', { method: 'POST', body: post });
      paintSearch(root, { ...q, q: value }, data, meta, options, data);
      if (data.semantic_mode === 'fallback') {
        import('../ui.js').then((ui) => ui.toast(data.semantic_message || '已回退关键词检索', 'warn'));
      }
    } catch (err) {
      import('../ui.js').then((ui) => ui.toast(err.message || '语义扩展检索失败', 'danger'));
      btn.disabled = false;
      btn.textContent = old;
    }
  });
  root.querySelectorAll('[data-search-type]').forEach((el) => {
    el.addEventListener('click', () => setQuery({ types: el.dataset.searchType || null, page: null }));
  });
  root.querySelectorAll('[data-search-filter]').forEach((el) => {
    el.addEventListener('change', () => {
      setQuery({ [el.dataset.searchFilter]: el.value || null, page: null });
    });
    if (el.tagName === 'INPUT') {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setQuery({ [el.dataset.searchFilter]: el.value || null, page: null });
      });
    }
  });
  root.querySelector('[data-search-reset]')?.addEventListener('click', () => {
    goto('search', { q: q.q || '' });
  });
  root.querySelectorAll('[data-search-page]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = Number(el.dataset.searchPage);
      if (p >= 1) setQuery({ page: String(p) });
    });
  });
  root.querySelectorAll('[data-search-content]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        const mod = await import('./content.js');
        await mod.openContentDrawer(el.dataset.searchContent);
      } catch (e) {
        import('../ui.js').then((ui) => ui.toast(e.message, 'error'));
      }
    });
  });
}
